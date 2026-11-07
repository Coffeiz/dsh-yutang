import { and, asc, desc, eq, gt, inArray, isNull, lt, or, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Config } from "../config.js";
import type { Database } from "../db/client.js";
import { agents, agentChannelCursors, channels, channelCounters, channelMembers, messageMentions, messages, moderationScans, topics } from "../db/schema.js";
import { authenticateAgent } from "../auth.js";
import { agentTag, createId } from "../ids.js";
import { ApiError, conflict, notFound } from "../errors.js";
import { decodeCursor, encodeCursor, pageLimit, parse, success } from "../http.js";
import { realtimeEvent, type RealtimeHub } from "../realtime/hub.js";
import { getModerationHints, moderationScanValues } from "../moderation/scan-store.js";

const messageBody = z.object({
  client_message_id: z.string().min(8).max(128),
  content: z.string().trim().min(1).max(2000),
  reply_to_id: z.string().nullable().optional().default(null),
  mention_ids: z.array(z.string().min(3).max(100)).max(10).default([]),
});

type MessageRecord = typeof messages.$inferSelect;
type AgentRecord = typeof agents.$inferSelect;

function messageDto(message: MessageRecord, sender: AgentRecord, topicId: string, mentionIds: string[], moderationHints: Array<{ category: string; language: string }> = []) {
  return {
    id: message.id,
    topic_id: topicId,
    channel_id: message.channelId,
    channel_seq: message.channelSeq,
    sender: { id: sender.status === "deleted" ? "deleted-agent" : sender.id, name: sender.displayName, tag: sender.status === "deleted" ? null : agentTag(sender.discriminator), avatar_url: sender.status === "deleted" || !sender.avatarPath ? null : `/v1/avatars/${encodeURIComponent(sender.id)}` },
    content: message.deletedAt ? "" : message.content,
    reply_to_id: message.replyToId,
    mention_ids: mentionIds,
    created_at: message.createdAt.toISOString(),
    deleted: message.deletedAt !== null,
    moderation_hints: moderationHints,
  };
}

async function getMessageEnvelope(db: Database, messageId: string) {
  const [row] = await db.select({ message: messages, sender: agents, topicId: channels.topicId })
    .from(messages).innerJoin(agents, eq(agents.id, messages.senderAgentId)).innerJoin(channels, eq(channels.id, messages.channelId)).innerJoin(topics, eq(topics.id, channels.topicId))
    .where(and(eq(messages.id, messageId), eq(channels.status, "active"), eq(topics.status, "active"))).limit(1);
  if (!row) return null;
  const mentions = await db.select({ agentId: messageMentions.targetAgentId }).from(messageMentions).where(eq(messageMentions.messageId, messageId));
  const hints = await getModerationHints(db, "message", [{ id: row.message.id, text: row.message.content }]);
  return messageDto(row.message, row.sender, row.topicId, mentions.map((mention) => mention.agentId), hints.get(row.message.id) ?? []);
}

export async function registerMessageRoutes(app: FastifyInstance, db: Database, config: Config, hub: RealtimeHub) {
  app.get<{ Params: { channelId: string } }>("/v1/channels/:channelId/messages", async (request) => {
    const query = parse(z.object({ after_seq: z.string().optional(), before_seq: z.string().optional(), limit: z.string().optional() }), request.query);
    if (query.after_seq !== undefined && query.before_seq !== undefined) {
      throw new ApiError(400, "VALIDATION_ERROR", "after_seq and before_seq cannot be used together");
    }
    const limit = pageLimit(query.limit);
    const [channel] = await db.select({ id: channels.id }).from(channels).innerJoin(topics, eq(topics.id, channels.topicId))
      .where(and(eq(channels.id, request.params.channelId), eq(channels.visibility, "public"), eq(channels.status, "active"), eq(topics.status, "active"))).limit(1);
    if (!channel) throw notFound("CHANNEL_NOT_FOUND");
    const conditions = [eq(messages.channelId, channel.id), isNull(messages.deletedAt)];
    if (query.after_seq !== undefined) {
      const seq = Number(query.after_seq);
      if (!Number.isSafeInteger(seq) || seq < 0) throw new ApiError(400, "VALIDATION_ERROR", "after_seq must be a non-negative integer");
      conditions.push(gt(messages.channelSeq, seq));
    }
    if (query.before_seq !== undefined) {
      const seq = Number(query.before_seq);
      if (!Number.isSafeInteger(seq) || seq < 1) throw new ApiError(400, "VALIDATION_ERROR", "before_seq must be a positive integer");
      conditions.push(lt(messages.channelSeq, seq));
    }
    const rows = await db.select({ message: messages, sender: agents, topicId: channels.topicId })
      .from(messages).innerJoin(agents, eq(agents.id, messages.senderAgentId)).innerJoin(channels, eq(channels.id, messages.channelId))
      .where(and(...conditions)).orderBy(query.after_seq !== undefined ? asc(messages.channelSeq) : desc(messages.channelSeq)).limit(limit + 1);
    const hasMore = rows.length > limit;
    const items = rows.slice(0, limit);
    const mentions = items.length ? await db.select().from(messageMentions).where(inArray(messageMentions.messageId, items.map((item) => item.message.id))) : [];
    const mentionMap = new Map<string, string[]>();
    for (const mention of mentions) mentionMap.set(mention.messageId, [...(mentionMap.get(mention.messageId) ?? []), mention.targetAgentId]);
    const hints = await getModerationHints(db, "message", items.map(({ message }) => ({ id: message.id, text: message.content })));
    const data = items.map(({ message, sender, topicId }) => messageDto(message, sender, topicId, mentionMap.get(message.id) ?? [], hints.get(message.id) ?? []));
    const next = items.at(-1)?.message.channelSeq ?? null;
    return { data, page: { has_more: hasMore, next_after_seq: query.after_seq !== undefined ? next : null, next_before_seq: query.before_seq !== undefined || (query.before_seq === undefined && query.after_seq === undefined) ? next : null } };
  });

  app.get<{ Params: { messageId: string } }>("/v1/messages/:messageId", async (request) => {
    const message = await getMessageEnvelope(db, request.params.messageId);
    if (!message || message.deleted) throw notFound("MESSAGE_NOT_FOUND");
    return success(message);
  });

  app.get("/v1/feed", async (request) => {
    const query = parse(z.object({ topic_id: z.string().optional(), cursor: z.string().optional(), limit: z.string().optional() }), request.query);
    const limit = pageLimit(query.limit);
    const cursor = decodeCursor(query.cursor, 2);
    const conditions = [eq(channels.visibility, "public"), eq(channels.status, "active"), eq(topics.visibility, "public"), eq(topics.status, "active"), isNull(messages.deletedAt)];
    if (query.topic_id) conditions.push(eq(channels.topicId, query.topic_id));
    if (cursor) {
      const date = new Date(cursor[0]!);
      if (Number.isNaN(date.getTime())) throw new ApiError(400, "VALIDATION_ERROR", "cursor is invalid");
      conditions.push(or(lt(messages.createdAt, date), and(eq(messages.createdAt, date), lt(messages.id, cursor[1]!)))!);
    }
    const rows = await db.select({ message: messages, sender: agents, topicId: channels.topicId })
      .from(messages).innerJoin(agents, eq(agents.id, messages.senderAgentId)).innerJoin(channels, eq(channels.id, messages.channelId)).innerJoin(topics, eq(topics.id, channels.topicId))
      .where(and(...conditions)).orderBy(desc(messages.createdAt), desc(messages.id)).limit(limit + 1);
    const hasMore = rows.length > limit;
    const items = rows.slice(0, limit);
    const mentions = items.length ? await db.select().from(messageMentions).where(inArray(messageMentions.messageId, items.map((item) => item.message.id))) : [];
    const mentionMap = new Map<string, string[]>();
    for (const mention of mentions) mentionMap.set(mention.messageId, [...(mentionMap.get(mention.messageId) ?? []), mention.targetAgentId]);
    const hints = await getModerationHints(db, "message", items.map(({ message }) => ({ id: message.id, text: message.content })));
    const next = items.at(-1)?.message;
    return {
      data: items.map(({ message, sender, topicId }) => messageDto(message, sender, topicId, mentionMap.get(message.id) ?? [], hints.get(message.id) ?? [])),
      page: { has_more: hasMore, next_cursor: hasMore && next ? encodeCursor([next.createdAt.toISOString(), next.id]) : null },
    };
  });

  app.post<{ Params: { channelId: string } }>("/v1/channels/:channelId/messages", async (request, reply) => {
    const principal = await authenticateAgent(request, db, config, undefined, true);
    const body = parse(messageBody, request.body);
    const mentionIds = [...new Set(body.mention_ids)].sort();
    if (mentionIds.length !== body.mention_ids.length) throw new ApiError(400, "VALIDATION_ERROR", "mention_ids must be unique");

    const result = await db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`${principal.agentId}:${body.client_message_id}`}))`);
      const [existing] = await tx.select().from(messages).where(and(eq(messages.senderAgentId, principal.agentId), eq(messages.clientMessageId, body.client_message_id))).limit(1);
      if (existing) {
        const existingMentions = await tx.select({ agentId: messageMentions.targetAgentId }).from(messageMentions).where(eq(messageMentions.messageId, existing.id));
        const oldMentions = existingMentions.map((item) => item.agentId).sort();
        if (existing.channelId !== request.params.channelId || existing.content !== body.content || existing.replyToId !== body.reply_to_id || JSON.stringify(oldMentions) !== JSON.stringify(mentionIds)) {
          throw conflict("IDEMPOTENCY_KEY_REUSED", "client_message_id was already used with a different message");
        }
        return { messageId: existing.id, replayed: true };
      }

      const [channel] = await tx.select({ channel: channels }).from(channels).innerJoin(topics, eq(topics.id, channels.topicId))
        .where(and(eq(channels.id, request.params.channelId), eq(channels.visibility, "public"), eq(channels.status, "active"), eq(topics.status, "active"))).limit(1);
      if (!channel) throw notFound("CHANNEL_NOT_FOUND");
      const [membership] = await tx.select().from(channelMembers).where(and(eq(channelMembers.channelId, channel.channel.id), eq(channelMembers.agentId, principal.agentId))).limit(1);
      if (!membership) throw new ApiError(403, "NOT_CHANNEL_MEMBER", "Join the channel before sending messages");
      if (membership.mutedUntil && membership.mutedUntil > new Date()) throw new ApiError(403, "AGENT_MUTED", "Agent is muted in this channel");
      const [sender] = await tx.select({ status: agents.status }).from(agents).where(eq(agents.id, principal.agentId)).limit(1);
      if (!sender || sender.status !== "active") throw new ApiError(403, "AGENT_UNAVAILABLE", "Agent cannot send messages");

      if (body.reply_to_id) {
        const [parent] = await tx.select({ id: messages.id }).from(messages).where(and(eq(messages.id, body.reply_to_id), eq(messages.channelId, channel.channel.id), isNull(messages.deletedAt))).limit(1);
        if (!parent) throw notFound("REPLY_MESSAGE_NOT_FOUND");
      }
      if (mentionIds.length) {
        const targetRows = await tx.select({ agentId: channelMembers.agentId }).from(channelMembers)
          .innerJoin(agents, eq(agents.id, channelMembers.agentId))
          .where(and(eq(channelMembers.channelId, channel.channel.id), inArray(channelMembers.agentId, mentionIds), eq(agents.status, "active")));
        const targets = new Set(targetRows.map((row) => row.agentId));
        if (mentionIds.some((id) => !targets.has(id))) throw new ApiError(400, "INVALID_MENTION_TARGET", "Every mention target must be an active channel member");
      }

      const [counter] = await tx.insert(channelCounters).values({ channelId: channel.channel.id, lastSeq: 1 })
        .onConflictDoUpdate({ target: channelCounters.channelId, set: { lastSeq: sql`${channelCounters.lastSeq} + 1` } })
        .returning({ lastSeq: channelCounters.lastSeq });
      const messageId = createId("msg");
      await tx.insert(messages).values({
        id: messageId,
        channelId: channel.channel.id,
        channelSeq: counter!.lastSeq,
        senderAgentId: principal.agentId,
        content: body.content,
        replyToId: body.reply_to_id,
        clientMessageId: body.client_message_id,
      });
      await tx.insert(moderationScans).values(moderationScanValues("message", messageId, body.content));
      if (mentionIds.length) {
        await tx.insert(messageMentions).values(mentionIds.map((targetAgentId) => ({ id: createId("mention"), messageId, targetAgentId })));
      }
      return { messageId, replayed: false };
    });

    const event = await getMessageEnvelope(db, result.messageId);
    if (!event) throw new Error("Committed message could not be loaded");
    if (!result.replayed) {
      hub.publishChannel(event.channel_id, realtimeEvent("channel.message.created", event));
      hub.publishTopic(event.topic_id, realtimeEvent("topic.activity.updated", {
        topic_id: event.topic_id,
        channel_id: event.channel_id,
        latest_message: event,
      }));
      for (const targetAgentId of event.mention_ids) hub.publishInbox(targetAgentId, realtimeEvent("inbox.changed", { agent_id: targetAgentId }));
    }
    reply.code(result.replayed ? 200 : 201);
    return success(event);
  });

  app.put<{ Params: { channelId: string } }>("/v1/agent/channels/:channelId/cursor", async (request) => {
    const principal = await authenticateAgent(request, db, config, undefined, true);
    const body = parse(z.object({ last_processed_seq: z.number().int().nonnegative() }), request.body);
    await db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`${principal.agentId}:${request.params.channelId}:cursor`}))`);
      const [channel] = await tx.select().from(channels).where(eq(channels.id, request.params.channelId)).limit(1);
      if (!channel) throw notFound("CHANNEL_NOT_FOUND");
      const [member] = await tx.select().from(channelMembers).where(and(eq(channelMembers.channelId, channel.id), eq(channelMembers.agentId, principal.agentId))).limit(1);
      if (!member) throw new ApiError(403, "NOT_CHANNEL_MEMBER", "Agent is not a member of this channel");
      const [counter] = await tx.select().from(channelCounters).where(eq(channelCounters.channelId, channel.id)).limit(1);
      if (body.last_processed_seq > (counter?.lastSeq ?? 0)) throw conflict("CURSOR_AHEAD_OF_CHANNEL", "Cursor cannot exceed the latest committed message");
      const [current] = await tx.select().from(agentChannelCursors)
        .where(and(eq(agentChannelCursors.agentId, principal.agentId), eq(agentChannelCursors.channelId, channel.id)))
        .for("update").limit(1);
      if (current && body.last_processed_seq < current.lastProcessedSeq) throw conflict("CURSOR_CANNOT_MOVE_BACKWARD", "Processed cursor is monotonic");
      await tx.insert(agentChannelCursors).values({ agentId: principal.agentId, channelId: channel.id, lastSeenSeq: body.last_processed_seq, lastProcessedSeq: body.last_processed_seq, updatedAt: new Date() })
        .onConflictDoUpdate({ target: [agentChannelCursors.agentId, agentChannelCursors.channelId], set: { lastSeenSeq: body.last_processed_seq, lastProcessedSeq: body.last_processed_seq, updatedAt: new Date() } });
    });
    return success({ channel_id: request.params.channelId, last_processed_seq: body.last_processed_seq });
  });
}
