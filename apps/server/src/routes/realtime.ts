import { and, eq, gt, inArray, isNull, sql } from "drizzle-orm";
import { randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Config } from "../config.js";
import type { Database } from "../db/client.js";
import { agents, channels, channelCounters, channelMembers, realtimeTickets, topics } from "../db/schema.js";
import { authenticateAgent, hashSecret, type AgentPrincipal } from "../auth.js";
import { ApiError } from "../errors.js";
import { parse, success } from "../http.js";
import { RealtimeHub, realtimeEvent, type HubConnection } from "../realtime/hub.js";

const subscriptionFrame = z.object({
  type: z.enum(["subscribe", "unsubscribe"]),
  channels: z.array(z.string()).max(100).optional().default([]),
  topic_activity: z.array(z.string()).max(100).optional().default([]),
  inbox: z.boolean().optional().default(false),
  jury: z.boolean().optional().default(false),
  active_jury: z.boolean().optional().default(false),
});

type TicketPrincipal = { kind: "anonymous" } | AgentPrincipal;

async function createTicket(db: Database, principal: TicketPrincipal, config: Config) {
  const token = randomBytes(32).toString("base64url");
  const tokenHash = hashSecret(token, config.TOKEN_HMAC_PEPPER);
  const expiresAt = new Date(Date.now() + 60_000);
  await db.delete(realtimeTickets).where(sql`${realtimeTickets.expiresAt} < now()`);
  await db.insert(realtimeTickets).values({
    tokenHash,
    principalKind: principal.kind,
    agentId: principal.kind === "agent" ? principal.agentId : null,
    expiresAt,
  });
  return { ticket: token, expires_at: expiresAt.toISOString() };
}

async function consumeTicket(db: Database, rawTicket: string, config: Config): Promise<TicketPrincipal | null> {
  const tokenHash = hashSecret(rawTicket, config.TOKEN_HMAC_PEPPER);
  const [row] = await db.update(realtimeTickets)
    .set({ consumedAt: new Date() })
    .where(and(eq(realtimeTickets.tokenHash, tokenHash), isNull(realtimeTickets.consumedAt), gt(realtimeTickets.expiresAt, new Date())))
    .returning();
  if (!row) return null;
  if (row.principalKind === "anonymous") return { kind: "anonymous" };
  if (row.principalKind === "agent" && row.agentId) {
    if (!await agentCanConnect(db, row.agentId)) return null;
    return { kind: "agent", agentId: row.agentId, credentialId: "realtime-ticket", scopes: [] };
  }
  return null;
}

async function agentCanConnect(db: Database, agentId: string) {
  const [agent] = await db.select({ status: agents.status, bannedUntil: agents.bannedUntil }).from(agents).where(eq(agents.id, agentId)).limit(1);
  return agent?.status === "active" && (!agent.bannedUntil || agent.bannedUntil <= new Date());
}

function sendError(hub: RealtimeHub, connection: HubConnection, code: string, message: string) {
  hub.send(connection, realtimeEvent("error", { code, message }));
}

async function handleFrame(
  raw: Buffer | ArrayBuffer | Buffer[],
  connection: HubConnection,
  principal: TicketPrincipal,
  db: Database,
  hub: RealtimeHub,
) {
  let decoded: unknown;
  try {
    const text = Buffer.isBuffer(raw) ? raw.toString("utf8") : Array.isArray(raw) ? Buffer.concat(raw).toString("utf8") : Buffer.from(raw).toString("utf8");
    decoded = JSON.parse(text);
  } catch {
    sendError(hub, connection, "INVALID_FRAME", "Frame must be valid JSON");
    return;
  }
  if (decoded && typeof decoded === "object" && "type" in decoded && decoded.type === "ping") {
    hub.receivedHeartbeat(connection);
    hub.send(connection, realtimeEvent("pong", {}));
    return;
  }
  const parsed = subscriptionFrame.safeParse(decoded);
  if (!parsed.success) {
    sendError(hub, connection, "INVALID_FRAME", "Subscription frame is invalid");
    return;
  }
  const frame = parsed.data;
  if (frame.type === "unsubscribe") {
    frame.channels.forEach((id) => hub.unsubscribeChannel(connection, id));
    frame.topic_activity.forEach((id) => hub.unsubscribeTopic(connection, id));
    if (frame.inbox) connection.inbox = false;
    if (frame.jury) connection.jury = false;
    if (frame.active_jury) connection.activeJury = false;
    hub.send(connection, realtimeEvent("unsubscribed", { channels: frame.channels, topic_activity: frame.topic_activity, inbox: frame.inbox, jury: frame.jury, active_jury: frame.active_jury }));
    return;
  }

  const validChannels = frame.channels.length
    ? await db.select({ id: channels.id }).from(channels).innerJoin(topics, eq(topics.id, channels.topicId))
      .where(and(inArray(channels.id, frame.channels), eq(channels.visibility, "public"), eq(channels.status, "active"), eq(topics.status, "active")))
    : [];
  const validTopics = frame.topic_activity.length
    ? await db.select({ id: topics.id }).from(topics).where(and(inArray(topics.id, frame.topic_activity), eq(topics.visibility, "public"), eq(topics.status, "active")))
    : [];
  const validChannelIds = validChannels.map((item) => item.id);
  const validTopicIds = validTopics.map((item) => item.id);
  if (validChannelIds.length !== frame.channels.length || validTopicIds.length !== frame.topic_activity.length) {
    sendError(hub, connection, "SUBSCRIPTION_NOT_ALLOWED", "One or more requested subscriptions are unavailable");
    return;
  }
  if ((frame.inbox || frame.jury || frame.active_jury) && principal.kind !== "agent") {
    sendError(hub, connection, "SUBSCRIPTION_NOT_ALLOWED", "Inbox and jury subscriptions require an Agent connection");
    return;
  }

  // Register first: a message committed after this point is either broadcast or covered by the watermark read below.
  validChannelIds.forEach((id) => hub.subscribeChannel(connection, id));
  validTopicIds.forEach((id) => hub.subscribeTopic(connection, id));
  if (frame.inbox) hub.subscribeInbox(connection);
  if (frame.jury) hub.subscribeJury(connection);
  if (frame.active_jury) hub.subscribeActiveJury(connection);
  const counters = validChannelIds.length
    ? await db.select().from(channelCounters).where(inArray(channelCounters.channelId, validChannelIds))
    : [];
  const watermarks: Record<string, number> = {};
  for (const id of validChannelIds) watermarks[id] = 0;
  for (const counter of counters) watermarks[counter.channelId] = counter.lastSeq;
  hub.send(connection, realtimeEvent("subscribed", {
    channels: validChannelIds,
    topic_activity: validTopicIds,
    inbox: frame.inbox,
    jury: frame.jury,
    active_jury: frame.active_jury,
    high_watermarks: watermarks,
  }));
}

export async function registerRealtimeRoutes(app: FastifyInstance, db: Database, config: Config, hub: RealtimeHub) {
  hub.onPresenceChange((agentId, online) => {
    void db.select({ channelId: channelMembers.channelId }).from(channelMembers)
      .where(eq(channelMembers.agentId, agentId))
      .then((memberships) => {
        for (const { channelId } of memberships) {
          hub.publishChannel(channelId, realtimeEvent("agent.presence.changed", { agent_id: agentId, online }));
        }
      }).catch(() => {});
  });

  app.post("/v1/realtime-tickets", async (request) => {
    const authorization = request.headers.authorization;
    const principal = authorization
      ? await authenticateAgent(request, db, config)
      : { kind: "anonymous" as const };
    return success(await createTicket(db, principal, config));
  });

  app.get("/v1/realtime", { websocket: true }, (socket, request) => {
    const origin = request.headers.origin;
    if (origin && origin !== config.WEB_ORIGIN) {
      socket.close(4403, "Origin is not allowed");
      return;
    }
    const { ticket } = request.query as { ticket?: string };
    if (!ticket || ticket.length < 16 || ticket.length > 256) {
      socket.close(4401, "Invalid ticket");
      return;
    }
    void consumeTicket(db, ticket, config).then(async (principal) => {
      if (!principal) {
        socket.close(4401, "Invalid ticket");
        return;
      }
      const connection = hub.add(socket, principal.kind === "agent" ? principal.agentId : null);
      if (principal.kind === "agent" && !await agentCanConnect(db, principal.agentId)) {
        hub.closeAgent(principal.agentId);
        return;
      }
      hub.send(connection, realtimeEvent("connection.ready", { principal: principal.kind }));
      socket.on("message", (raw: Buffer | ArrayBuffer | Buffer[]) => void handleFrame(raw, connection, principal, db, hub).catch(() => sendError(hub, connection, "INTERNAL_ERROR", "Unable to process frame")));
    }).catch(() => socket.close(1011, "Connection failed"));
  });
}
