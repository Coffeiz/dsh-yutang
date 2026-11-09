import { and, eq, isNull, lt, or, sql } from "drizzle-orm";
import { randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Config } from "../config.js";
import type { Database } from "../db/client.js";
import { agents, channels, messageMentions, messages, topics } from "../db/schema.js";
import { authenticateAgent, hashSecret } from "../auth.js";
import { ApiError, conflict, notFound } from "../errors.js";
import { agentTag, createId } from "../ids.js";
import { parse, success } from "../http.js";

const claimBody = z.object({ max_events: z.number().int().min(1).max(20).default(5), lease_seconds: z.number().int().min(30).max(1800).default(600) });
const leaseBody = z.object({ lease_token: z.string().min(16).max(256), lease_seconds: z.number().int().min(30).max(1800).optional() });
const completeBody = z.object({ lease_token: z.string().min(16).max(256), result: z.enum(["replied", "skipped", "failed"]), reply_message_id: z.string().optional() })
  .refine((body) => body.result !== "replied" || Boolean(body.reply_message_id), "reply_message_id is required when result is replied");

export async function registerInboxRoutes(app: FastifyInstance, db: Database, config: Config) {
  app.post("/v1/agent/inbox/claim", async (request) => {
    const principal = await authenticateAgent(request, db, config, true);
    const body = parse(claimBody, request.body);
    const now = new Date();
    const records = await db.transaction(async (tx) => {
      const available = await tx.select({ mention: messageMentions, message: messages, channel: channels, sender: agents })
        .from(messageMentions).innerJoin(messages, eq(messages.id, messageMentions.messageId))
        .innerJoin(channels, eq(channels.id, messages.channelId)).innerJoin(topics, eq(topics.id, channels.topicId))
        .innerJoin(agents, eq(agents.id, messages.senderAgentId))
        .where(and(
          eq(messageMentions.targetAgentId, principal.agentId),
          eq(channels.visibility, "public"),
          eq(channels.status, "active"),
          eq(topics.visibility, "public"),
          eq(topics.status, "active"),
          or(
            and(eq(messageMentions.status, "pending"), or(isNull(messageMentions.nextAttemptAt), lt(messageMentions.nextAttemptAt, now))),
            and(eq(messageMentions.status, "processing"), lt(messageMentions.leaseExpiresAt, now)),
          ),
        ))
        .orderBy(messageMentions.createdAt).limit(body.max_events).for("update", { of: messageMentions, skipLocked: true });
      const claimed = [];
      for (const item of available) {
        const leaseToken = randomBytes(32).toString("base64url");
        const leaseExpiresAt = new Date(Date.now() + body.lease_seconds * 1000);
        const [updated] = await tx.update(messageMentions).set({
          status: "processing",
          leaseTokenHash: hashSecret(leaseToken, config.TOKEN_HMAC_PEPPER),
          leaseExpiresAt,
          nextAttemptAt: null,
          attemptCount: sql`${messageMentions.attemptCount} + 1`,
        }).where(eq(messageMentions.id, item.mention.id)).returning();
        claimed.push({
          id: updated!.id,
          type: "message.mentioned",
          channel_id: item.message.channelId,
          topic_id: item.channel.topicId,
          message: {
            id: item.message.id,
            channel_seq: item.message.channelSeq,
            content: item.message.deletedAt ? "" : item.message.content,
            sender: { id: item.sender.id, name: item.sender.displayName, tag: agentTag(item.sender.discriminator), avatar_url: item.sender.avatarPath ? `/v1/avatars/${encodeURIComponent(item.sender.id)}` : null },
            created_at: item.message.createdAt.toISOString(),
          },
          lease_token: leaseToken,
          lease_expires_at: leaseExpiresAt.toISOString(),
          attempt: updated!.attemptCount,
        });
      }
      return claimed;
    });
    return success(records);
  });

  app.post<{ Params: { eventId: string } }>("/v1/agent/inbox/:eventId/renew", async (request) => {
    const principal = await authenticateAgent(request, db, config, true);
    const body = parse(leaseBody, request.body);
    const leaseSeconds = body.lease_seconds ?? 600;
    const leaseExpiresAt = new Date(Date.now() + leaseSeconds * 1000);
    const id = await db.transaction(async (tx) => {
      const [row] = await tx.select().from(messageMentions).where(and(eq(messageMentions.id, request.params.eventId), eq(messageMentions.targetAgentId, principal.agentId))).for("update").limit(1);
      if (!row) throw notFound("INBOX_EVENT_NOT_FOUND");
      if (row.status !== "processing" || !row.leaseExpiresAt || row.leaseExpiresAt <= new Date() || row.leaseTokenHash !== hashSecret(body.lease_token, config.TOKEN_HMAC_PEPPER)) {
        throw conflict("INBOX_LEASE_INVALID", "Lease is expired or no longer owned by this Agent");
      }
      await tx.update(messageMentions).set({ leaseExpiresAt }).where(eq(messageMentions.id, row.id));
      return row.id;
    });
    return success({ event_id: id, lease_expires_at: leaseExpiresAt.toISOString() });
  });

  app.post<{ Params: { eventId: string } }>("/v1/agent/inbox/:eventId/complete", async (request) => {
    const principal = await authenticateAgent(request, db, config, true);
    const body = parse(completeBody, request.body);
    const result = await db.transaction(async (tx) => {
      const [row] = await tx.select().from(messageMentions).where(and(eq(messageMentions.id, request.params.eventId), eq(messageMentions.targetAgentId, principal.agentId))).for("update").limit(1);
      if (!row) throw notFound("INBOX_EVENT_NOT_FOUND");
      const submittedHash = hashSecret(body.lease_token, config.TOKEN_HMAC_PEPPER);
      if (row.status === "completed" && row.leaseTokenHash === submittedHash && row.result === body.result) {
        return { eventId: row.id, status: row.status, result: row.result, retryAfter: null };
      }
      if ((row.status === "pending" || row.status === "failed") && row.leaseTokenHash === submittedHash && row.result === "failed" && body.result === "failed") {
        const retryAfter = row.status === "pending" && row.nextAttemptAt
          ? Math.max(0, Math.ceil((row.nextAttemptAt.getTime() - Date.now()) / 1000))
          : null;
        return { eventId: row.id, status: row.status, result: row.result, retryAfter };
      }
      if (row.status !== "processing" || !row.leaseExpiresAt || row.leaseExpiresAt <= new Date() || row.leaseTokenHash !== submittedHash) {
        throw conflict("INBOX_LEASE_INVALID", "Lease is expired or no longer owned by this Agent");
      }
      if (body.reply_message_id) {
        const [source] = await tx.select({ channelId: messages.channelId }).from(messageMentions)
          .innerJoin(messages, eq(messages.id, messageMentions.messageId)).where(eq(messageMentions.id, row.id)).limit(1);
        const [reply] = source ? await tx.select({ id: messages.id }).from(messages)
          .where(and(eq(messages.id, body.reply_message_id), eq(messages.channelId, source.channelId), eq(messages.senderAgentId, principal.agentId))).limit(1) : [];
        if (!reply) throw notFound("REPLY_MESSAGE_NOT_FOUND");
      }
      const completed = body.result !== "failed";
      const exhausted = body.result === "failed" && row.attemptCount >= 5;
      const backoffSeconds = Math.min(3600, 30 * 2 ** Math.max(0, row.attemptCount - 1));
      await tx.update(messageMentions).set({
        status: completed ? "completed" : exhausted ? "failed" : "pending",
        result: body.result,
        replyMessageId: body.reply_message_id ?? null,
        processedAt: completed || exhausted ? new Date() : null,
        nextAttemptAt: completed || exhausted ? null : new Date(Date.now() + backoffSeconds * 1000),
      }).where(eq(messageMentions.id, row.id));
      return { eventId: row.id, status: completed ? "completed" : exhausted ? "failed" : "pending", result: body.result, retryAfter: completed || exhausted ? null : backoffSeconds };
    });
    return success({ event_id: result.eventId, status: result.status, result: result.result, retry_after_seconds: result.retryAfter });
  });
}
