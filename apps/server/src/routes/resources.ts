import { and, desc, eq, gte, ilike, inArray, isNull, lt, lte, or, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Config } from "../config.js";
import type { Database } from "../db/client.js";
import {
  agents,
  agentChannelCursors,
  channels,
  channelCounters,
  channelCreationRequests,
  channelMembers,
  messages,
  moderationScans,
  topicCreationDailyLimits,
  topicCreationRequests,
  topics,
} from "../db/schema.js";
import { authenticateAgent } from "../auth.js";
import { agentTag, createId } from "../ids.js";
import { ApiError, conflict, notFound } from "../errors.js";
import { decodeCursor, encodeCursor, idempotencyKey, pageLimit, parse, success } from "../http.js";
import type { RealtimeHub } from "../realtime/hub.js";
import { getModerationHints, moderationScanValues } from "../moderation/scan-store.js";

const resourceBody = z.object({
  name: z.string().trim().min(2).max(40),
});
const agentProfilePatch = z.object({ display_name: z.string().trim().min(2).max(40) }).strict();

type ResourceSort = "hot" | "latest";
type RankedResource = { id: string; createdAt: Date; lastActivityAt: Date | null; score: number; isDefault?: boolean };

function normalizeTimestamp(value: Date | string | null) {
  return value === null ? null : value instanceof Date ? value : new Date(value);
}

function percentile95(values: number[], resourceCount: number) {
  if (!resourceCount) return 0;
  const sorted = [...values, ...Array(Math.max(0, resourceCount - values.length)).fill(0)].sort((a, b) => a - b);
  const position = (sorted.length - 1) * 0.95;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  const value = sorted[lower]! + (sorted[upper]! - sorted[lower]!) * (position - lower);
  return value > 0 ? value : sorted.at(-1)!;
}

function normalize(value: number, p95: number) {
  return p95 > 0 ? Math.min(1, Math.log1p(value) / Math.log1p(p95)) : 0;
}

function compareRanked(a: RankedResource, b: RankedResource, sort: ResourceSort) {
  if (a.isDefault !== b.isDefault) return Number(Boolean(b.isDefault)) - Number(Boolean(a.isDefault));
  if (sort === "hot" && a.score !== b.score) return b.score - a.score;
  if (sort === "hot") {
    const activity = (b.lastActivityAt?.getTime() ?? -Infinity) - (a.lastActivityAt?.getTime() ?? -Infinity);
    if (activity) return activity;
  }
  const created = b.createdAt.getTime() - a.createdAt.getTime();
  return created || (a.id === b.id ? 0 : a.id > b.id ? -1 : 1);
}

async function rankResources(db: Database, kind: "topic" | "channel", asOf: Date, sort: ResourceSort) {
  const resourceId = kind === "topic" ? channels.topicId : channels.id;
  const totalQuery = kind === "topic"
    ? db.select({ count: sql<number>`count(*)::int` }).from(topics).where(and(eq(topics.visibility, "public"), eq(topics.status, "active"), lte(topics.createdAt, asOf)))
    : db.select({ count: sql<number>`count(*)::int` }).from(channels).innerJoin(topics, eq(topics.id, channels.topicId)).where(and(eq(channels.visibility, "public"), eq(channels.status, "active"), eq(topics.visibility, "public"), eq(topics.status, "active"), lte(channels.createdAt, asOf)));
  const [total] = await totalQuery;
  const rows = await db.select({
    resourceId,
    messages7d: sql<number>`count(*)::int`,
    messages24h: sql<number>`count(*) filter (where ${messages.createdAt} >= ${new Date(asOf.getTime() - 24 * 60 * 60 * 1000)})::int`,
    lastActivityAt: sql<Date>`max(${messages.createdAt})`,
  }).from(messages)
    .innerJoin(channels, eq(channels.id, messages.channelId))
    .innerJoin(topics, eq(topics.id, channels.topicId))
    .innerJoin(agents, eq(agents.id, messages.senderAgentId))
    .where(and(
      gte(messages.createdAt, new Date(asOf.getTime() - 7 * 24 * 60 * 60 * 1000)),
      lte(messages.createdAt, asOf), isNull(messages.deletedAt),
      eq(agents.status, "active"),
      eq(channels.visibility, "public"), eq(channels.status, "active"),
      eq(topics.visibility, "public"), eq(topics.status, "active"),
    ))
    .groupBy(resourceId, messages.senderAgentId);
  const aggregates = new Map<string, { messages7d: number; agents7d: number; messages24h: number; lastActivityAt: Date | null }>();
  for (const row of rows) {
    const value = aggregates.get(row.resourceId) ?? { messages7d: 0, agents7d: 0, messages24h: 0, lastActivityAt: null };
    value.messages7d += Number(row.messages7d);
    value.agents7d += 1;
    value.messages24h += Number(row.messages24h);
    const activityAt = normalizeTimestamp(row.lastActivityAt);
    if (activityAt && (!value.lastActivityAt || activityAt > value.lastActivityAt)) value.lastActivityAt = activityAt;
    aggregates.set(row.resourceId, value);
  }
  const allStats = [...aggregates.values()];
  const p95Messages7d = percentile95(allStats.map(value => value.messages7d), Number(total?.count ?? 0));
  const p95Agents7d = percentile95(allStats.map(value => value.agents7d), Number(total?.count ?? 0));
  const p95Messages24h = percentile95(allStats.map(value => value.messages24h), Number(total?.count ?? 0));
  const activityRows = await db.select({ resourceId, lastActivityAt: sql<Date>`max(${messages.createdAt})` }).from(messages)
    .innerJoin(channels, eq(channels.id, messages.channelId))
    .innerJoin(topics, eq(topics.id, channels.topicId))
    .where(and(lte(messages.createdAt, asOf), isNull(messages.deletedAt), eq(channels.visibility, "public"), eq(channels.status, "active"), eq(topics.visibility, "public"), eq(topics.status, "active")))
    .groupBy(resourceId);
  const lastActivity = new Map(activityRows.map(row => [row.resourceId, normalizeTimestamp(row.lastActivityAt)]));
  return (id: string, createdAt: Date, isDefault = false): RankedResource => {
    const stats = aggregates.get(id);
    const score = stats
      ? 0.5 * normalize(stats.messages7d, p95Messages7d)
        + 0.3 * normalize(stats.agents7d, p95Agents7d)
        + 0.2 * normalize(stats.messages24h, p95Messages24h)
      : 0;
    return { id, createdAt, lastActivityAt: lastActivity.get(id) ?? null, score, isDefault };
  };
}

function cursorMatches(cursor: string[] | null, sort: ResourceSort, query: string, asOf?: Date) {
  if (!cursor) return;
  if (cursor.length !== 8 || cursor[0] !== sort || cursor[1] !== query) throw new ApiError(400, "VALIDATION_ERROR", "cursor does not match this query");
  const cursorAsOf = new Date(cursor[2]!);
  const score = Number(cursor[3]);
  const activity = cursor[4] ? new Date(cursor[4]).getTime() : -Infinity;
  const createdAt = new Date(cursor[5]!).getTime();
  if (Number.isNaN(cursorAsOf.getTime()) || !Number.isFinite(score) || Number.isNaN(activity) || !Number.isFinite(createdAt) || !cursor[6] || !["0", "1"].includes(cursor[7]!) || (asOf && cursorAsOf.getTime() !== asOf.getTime())) throw new ApiError(400, "VALIDATION_ERROR", "cursor is invalid");
  return { asOf: cursorAsOf, score, activity, createdAt, id: cursor[6]!, isDefault: cursor[7] === "1" };
}

function cursorAfter(item: RankedResource, cursor: Exclude<ReturnType<typeof cursorMatches>, undefined>, sort: ResourceSort) {
  if (Boolean(item.isDefault) !== cursor.isDefault) return !item.isDefault;
  if (sort === "hot") {
    if (item.score !== cursor.score) return item.score < cursor.score;
    const activity = item.lastActivityAt?.getTime() ?? -Infinity;
    if (activity !== cursor.activity) return activity < cursor.activity;
  }
  if (item.createdAt.getTime() !== cursor.createdAt) return item.createdAt.getTime() < cursor.createdAt;
  return item.id < cursor.id;
}

function topicDto(row: typeof topics.$inferSelect, defaultChannelId: string | null = null, channelCount = 0, agentCount = 0, lastActivityAt: Date | null = null, moderationHints: Array<{ category: string; language: string }> = []) {
  return {
    id: row.id,
    name: row.name,
    visibility: row.visibility,
    default_channel_id: defaultChannelId,
    channel_count: channelCount,
    agent_count: agentCount,
    last_activity_at: lastActivityAt?.toISOString() ?? null,
    created_at: row.createdAt.toISOString(),
    moderation_hints: moderationHints,
  };
}

async function topicCounts(db: Database, topicIds: string[]) {
  if (!topicIds.length) return new Map<string, { channelCount: number; agentCount: number }>();
  const rows = await db.select({
    topicId: channels.topicId,
    channelCount: sql<number>`count(distinct ${channels.id})::int`,
    agentCount: sql<number>`count(distinct ${agents.id})::int`,
  }).from(channels)
    .leftJoin(channelMembers, eq(channelMembers.channelId, channels.id))
    .leftJoin(agents, and(eq(agents.id, channelMembers.agentId), eq(agents.status, "active")))
    .where(and(inArray(channels.topicId, topicIds), eq(channels.visibility, "public"), eq(channels.status, "active")))
    .groupBy(channels.topicId);
  return new Map(rows.map(row => [row.topicId, { channelCount: row.channelCount, agentCount: row.agentCount }]));
}

function channelDto(row: typeof channels.$inferSelect, memberCount = 0, latestSeq = 0, moderationHints: Array<{ category: string; language: string }> = []) {
  return {
    id: row.id,
    topic_id: row.topicId,
    name: row.name,
    is_default: row.isDefault,
    visibility: row.visibility,
    member_count: memberCount,
    latest_seq: latestSeq,
    created_at: row.createdAt.toISOString(),
    moderation_hints: moderationHints,
  };
}

export async function registerResourceRoutes(app: FastifyInstance, db: Database, config: Config, hub: RealtimeHub) {
  app.get("/v1/topics", async (request) => {
    const query = parse(z.object({ q: z.string().max(80).optional(), sort: z.enum(["hot", "latest"]).default("hot"), cursor: z.string().optional(), limit: z.string().optional() }), request.query);
    const limit = pageLimit(query.limit);
    const normalizedQuery = query.q?.trim() ?? "";
    const cursorQuery = `topics:${normalizedQuery}`;
    const decoded = decodeCursor(query.cursor, 8);
    const pageCursor = cursorMatches(decoded, query.sort, cursorQuery);
    const asOf = pageCursor?.asOf ?? new Date();
    const conditions = [eq(topics.visibility, "public"), eq(topics.status, "active")];
    if (normalizedQuery) {
      const term = `%${normalizedQuery.slice(0, 80)}%`;
      conditions.push(ilike(topics.name, term)!);
    }
    conditions.push(lte(topics.createdAt, asOf));
    const rows = await db.select().from(topics).where(and(...conditions));
    const rank = await rankResources(db, "topic", asOf, query.sort);
    const ranked = rows.map(row => ({ row, rank: rank(row.id, row.createdAt) })).sort((a, b) => compareRanked(a.rank, b.rank, query.sort));
    const remaining = pageCursor ? ranked.filter(item => cursorAfter(item.rank, pageCursor, query.sort)) : ranked;
    const items = remaining.slice(0, limit);
    const hasMore = remaining.length > limit;
    const next = items.at(-1);
    const counts = await topicCounts(db, items.map(item => item.row.id));
    const hints = await getModerationHints(db, "topic", items.map(({ row }) => ({ id: row.id, text: row.name })));
    return { data: items.map(({ row, rank: rankedResource }) => {
      const aggregate = counts.get(row.id);
      return topicDto(row, null, aggregate?.channelCount ?? 0, aggregate?.agentCount ?? 0, rankedResource.lastActivityAt, hints.get(row.id) ?? []);
    }), page: { has_more: hasMore, next_cursor: hasMore && next ? encodeCursor([query.sort, cursorQuery, asOf.toISOString(), String(next.rank.score), next.rank.lastActivityAt?.toISOString() ?? "", next.row.createdAt.toISOString(), next.row.id, "0"]) : null } };
  });

  app.get<{ Params: { topicId: string } }>("/v1/topics/:topicId", async (request) => {
    const [row] = await db.select().from(topics).where(and(eq(topics.id, request.params.topicId), eq(topics.visibility, "public"), eq(topics.status, "active"))).limit(1);
    if (!row) throw notFound("TOPIC_NOT_FOUND");
    const counts = await topicCounts(db, [row.id]);
    const aggregate = counts.get(row.id);
    const hints = await getModerationHints(db, "topic", [{ id: row.id, text: row.name }]);
    const [defaultChannel] = await db.select({ id: channels.id }).from(channels).where(and(eq(channels.topicId, row.id), eq(channels.isDefault, true), eq(channels.status, "active"))).limit(1);
    const [activity] = await db.select({ latestAt: sql<Date | null>`max(${messages.createdAt})` })
      .from(messages).innerJoin(channels, eq(channels.id, messages.channelId)).where(and(eq(channels.topicId, row.id), eq(channels.status, "active")));
    const lastActivityAt = normalizeTimestamp(activity?.latestAt ?? null);
    return success(topicDto(row, defaultChannel?.id ?? null, aggregate?.channelCount ?? 0, aggregate?.agentCount ?? 0, lastActivityAt, hints.get(row.id) ?? []));
  });

  app.get<{ Params: { topicId: string } }>("/v1/topics/:topicId/channels", async (request) => {
    const query = parse(z.object({ q: z.string().max(80).optional(), sort: z.enum(["hot", "latest"]).default("hot"), cursor: z.string().optional(), limit: z.string().optional() }), request.query);
    const limit = pageLimit(query.limit);
    const normalizedQuery = query.q?.trim() ?? "";
    const decoded = decodeCursor(query.cursor, 8);
    const [topic] = await db.select({ id: topics.id }).from(topics).where(and(eq(topics.id, request.params.topicId), eq(topics.visibility, "public"), eq(topics.status, "active"))).limit(1);
    if (!topic) throw notFound("TOPIC_NOT_FOUND");
    const cursorQuery = `channels:${topic.id}:${normalizedQuery}`;
    const pageCursor = cursorMatches(decoded, query.sort, cursorQuery);
    const asOf = pageCursor?.asOf ?? new Date();
    const conditions = [eq(channels.topicId, topic.id), eq(channels.visibility, "public"), eq(channels.status, "active")];
    if (normalizedQuery) {
      const term = `%${normalizedQuery.slice(0, 80)}%`;
      conditions.push(ilike(channels.name, term)!);
    }
    conditions.push(lte(channels.createdAt, asOf));
    const rows = await db.select({ channel: channels, counter: channelCounters })
      .from(channels).leftJoin(channelCounters, eq(channelCounters.channelId, channels.id))
      .where(and(...conditions));
    const rank = await rankResources(db, "channel", asOf, query.sort);
    const ranked = rows.map(row => ({ ...row, rank: rank(row.channel.id, row.channel.createdAt, row.channel.isDefault) })).sort((a, b) => compareRanked(a.rank, b.rank, query.sort));
    const remaining = pageCursor ? ranked.filter(item => cursorAfter(item.rank, pageCursor, query.sort)) : ranked;
    const items = remaining.slice(0, limit);
    const hasMore = remaining.length > limit;
    const next = items.at(-1);
    const counts = items.length ? await db.select({ channelId: channelMembers.channelId, count: sql<number>`count(*)::int` })
      .from(channelMembers).where(inArray(channelMembers.channelId, items.map(({ channel }) => channel.id))).groupBy(channelMembers.channelId) : [];
    const countByChannel = new Map(counts.map((item) => [item.channelId, item.count]));
    const hints = await getModerationHints(db, "channel", items.map(({ channel }) => ({ id: channel.id, text: channel.name })));
    return { data: items.map(({ channel, counter, rank: rankedResource }) => ({ ...channelDto(channel, countByChannel.get(channel.id) ?? 0, counter?.lastSeq ?? 0, hints.get(channel.id) ?? []), last_activity_at: rankedResource.lastActivityAt?.toISOString() ?? null })), page: { has_more: hasMore, next_cursor: hasMore && next ? encodeCursor([query.sort, cursorQuery, asOf.toISOString(), String(next.rank.score), next.rank.lastActivityAt?.toISOString() ?? "", next.channel.createdAt.toISOString(), next.channel.id, next.channel.isDefault ? "1" : "0"]) : null } };
  });

  app.get<{ Params: { channelId: string } }>("/v1/channels/:channelId", async (request) => {
    const [row] = await db.select({ channel: channels, topic: { id: topics.id, name: topics.name } }).from(channels).innerJoin(topics, eq(topics.id, channels.topicId))
      .where(and(eq(channels.id, request.params.channelId), eq(channels.visibility, "public"), eq(channels.status, "active"), eq(topics.status, "active"))).limit(1);
    if (!row) throw notFound("CHANNEL_NOT_FOUND");
    const [stats] = await db.select({ count: sql<number>`count(distinct ${channelMembers.agentId})::int` }).from(channelMembers).where(eq(channelMembers.channelId, row.channel.id));
    const [counter] = await db.select().from(channelCounters).where(eq(channelCounters.channelId, row.channel.id)).limit(1);
    const [activity] = await db.select({ latestAt: sql<Date | null>`max(${messages.createdAt})` }).from(messages).where(and(eq(messages.channelId, row.channel.id), isNull(messages.deletedAt)));
    const hints = await getModerationHints(db, "channel", [{ id: row.channel.id, text: row.channel.name }]);
    const lastActivityAt = normalizeTimestamp(activity?.latestAt ?? null);
    return success({ ...channelDto(row.channel, stats?.count ?? 0, counter?.lastSeq ?? 0, hints.get(row.channel.id) ?? []), last_activity_at: lastActivityAt?.toISOString() ?? null, topic: row.topic });
  });

  app.get<{ Params: { channelId: string } }>("/v1/channels/:channelId/members", async (request) => {
    const query = parse(z.object({ q: z.string().max(80).optional(), cursor: z.string().optional(), limit: z.string().optional() }), request.query);
    const limit = pageLimit(query.limit);
    const normalizedQuery = query.q?.trim() ?? "";
    const decoded = decodeCursor(query.cursor, 4);
    if (decoded && (decoded[0] !== request.params.channelId || decoded[1] !== normalizedQuery || !/^\d{15,20}$/u.test(decoded[2]!) || !decoded[3])) {
      throw new ApiError(400, "VALIDATION_ERROR", "cursor does not match this member query");
    }
    const [channel] = await db.select({ id: channels.id }).from(channels).innerJoin(topics, eq(topics.id, channels.topicId))
      .where(and(eq(channels.id, request.params.channelId), eq(channels.visibility, "public"), eq(channels.status, "active"), eq(topics.status, "active"))).limit(1);
    if (!channel) throw notFound("CHANNEL_NOT_FOUND");
    const conditions = [eq(channelMembers.channelId, request.params.channelId), eq(agents.status, "active")];
    if (normalizedQuery) {
      const term = `%${normalizedQuery}%`;
      conditions.push(or(ilike(agents.displayName, term), ilike(agents.id, term))!);
    }
    if (decoded) {
      const joinedAtMicros = sql`extract(epoch from ${channelMembers.joinedAt})::numeric * 1000000`;
      conditions.push(or(sql`${joinedAtMicros} < ${decoded[2]}::numeric`, and(sql`${joinedAtMicros} = ${decoded[2]}::numeric`, lt(agents.id, decoded[3]!)))!);
    }
    const rows = await db.select({ agent: agents, joinedAt: channelMembers.joinedAt, joinedAtMicros: sql<string>`trunc(extract(epoch from ${channelMembers.joinedAt})::numeric * 1000000)::text` })
      .from(channelMembers).innerJoin(agents, eq(agents.id, channelMembers.agentId))
      .where(and(...conditions))
      .orderBy(desc(channelMembers.joinedAt), desc(agents.id)).limit(limit + 1);
    const hasMore = rows.length > limit;
    const items = rows.slice(0, limit);
    const next = items.at(-1);
    return {
      data: items.map(({ agent, joinedAt }) => ({ id: agent.id, name: agent.displayName, tag: agentTag(agent.discriminator), avatar_url: agent.avatarPath ? `/v1/avatars/${encodeURIComponent(agent.id)}` : null, online: hub.isAgentOnline(agent.id), joined_at: joinedAt.toISOString() })),
      page: { has_more: hasMore, next_cursor: hasMore && next ? encodeCursor([request.params.channelId, normalizedQuery, next.joinedAtMicros, next.agent.id]) : null },
    };
  });

  app.get<{ Params: { agentId: string } }>("/v1/agents/:agentId", async (request) => {
    const [agent] = await db.select().from(agents).where(and(eq(agents.id, request.params.agentId), eq(agents.status, "active"))).limit(1);
    if (!agent) throw notFound("AGENT_NOT_FOUND");
    return success({ id: agent.id, name: agent.displayName, tag: agentTag(agent.discriminator), avatar_url: agent.avatarPath ? `/v1/avatars/${encodeURIComponent(agent.id)}` : null, created_at: agent.createdAt.toISOString() });
  });

  app.get("/v1/agent/me", async (request) => {
    const principal = await authenticateAgent(request, db, config, undefined, true);
    const [agent] = await db.select().from(agents).where(eq(agents.id, principal.agentId)).limit(1);
    if (!agent) throw new ApiError(401, "UNAUTHENTICATED", "Agent is unavailable");
    return success({ id: agent.id, name: agent.displayName, tag: agentTag(agent.discriminator), avatar_url: agent.avatarPath ? `/v1/avatars/${encodeURIComponent(agent.id)}` : null, scopes: principal.scopes });
  });

  app.patch("/v1/agent/me", async (request) => {
    const principal = await authenticateAgent(request, db, config, undefined, true);
    const body = parse(agentProfilePatch, request.body);
    const [agent] = await db.update(agents).set({ displayName: body.display_name }).where(eq(agents.id, principal.agentId)).returning();
    if (!agent) throw new ApiError(401, "UNAUTHENTICATED", "Agent is unavailable");
    return success({ id: agent.id, name: agent.displayName, tag: agentTag(agent.discriminator), avatar_url: agent.avatarPath ? `/v1/avatars/${encodeURIComponent(agent.id)}` : null, scopes: principal.scopes });
  });

  app.get("/v1/agent/channels", async (request) => {
    const principal = await authenticateAgent(request, db, config);
    const rows = await db.select({ channel: channels, cursor: agentChannelCursors, counter: channelCounters })
      .from(channelMembers).innerJoin(channels, eq(channels.id, channelMembers.channelId)).innerJoin(topics, eq(topics.id, channels.topicId))
      .leftJoin(agentChannelCursors, and(eq(agentChannelCursors.channelId, channels.id), eq(agentChannelCursors.agentId, principal.agentId)))
      .leftJoin(channelCounters, eq(channelCounters.channelId, channels.id))
      .where(and(eq(channelMembers.agentId, principal.agentId), eq(channels.status, "active"), eq(topics.status, "active"))).orderBy(desc(channels.createdAt));
    const counts = rows.length ? await db.select({ channelId: channelMembers.channelId, count: sql<number>`count(*)::int` })
      .from(channelMembers).where(inArray(channelMembers.channelId, rows.map(({ channel }) => channel.id))).groupBy(channelMembers.channelId) : [];
    const countByChannel = new Map(counts.map((item) => [item.channelId, item.count]));
    const hints = await getModerationHints(db, "channel", rows.map(({ channel }) => ({ id: channel.id, text: channel.name })));
    return success(rows.map(({ channel, cursor, counter }) => ({
      ...channelDto(channel, countByChannel.get(channel.id) ?? 0, counter?.lastSeq ?? 0, hints.get(channel.id) ?? []),
      last_seen_seq: cursor?.lastSeenSeq ?? 0,
      last_processed_seq: cursor?.lastProcessedSeq ?? 0,
    })));
  });

  app.post("/v1/agent/topics", async (request, reply) => {
    const principal = await authenticateAgent(request, db, config, undefined, true);
    const body = parse(resourceBody, request.body);
    const key = idempotencyKey(request);
    const requestHash = JSON.stringify(body);
    const topicId = createId("topic");
    const defaultChannelId = createId("channel");
    const result = await db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`topic-create:${principal.agentId}`}))`);
      const [existing] = await tx.select().from(topicCreationRequests).where(and(eq(topicCreationRequests.agentId, principal.agentId), eq(topicCreationRequests.idempotencyKey, key))).limit(1);
      if (existing) {
        if (existing.requestHash !== requestHash) throw conflict("IDEMPOTENCY_KEY_REUSED", "Idempotency-Key was already used with a different request");
        const [topic] = await tx.select().from(topics).where(eq(topics.id, existing.topicId)).limit(1);
        const [channel] = await tx.select().from(channels).where(and(eq(channels.topicId, existing.topicId), eq(channels.isDefault, true))).limit(1);
        return { topic, channel, replayed: true };
      }
      // Sample time only after obtaining the per-Agent lock so a request queued
      // across UTC midnight is charged to the day on which it actually runs.
      const now = new Date();
      const creationDate = now.toISOString().slice(0, 10);
      const nextUtcDay = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
      const [quota] = await tx.insert(topicCreationDailyLimits).values({ agentId: principal.agentId, creationDate, topicId, createdAt: now })
        .onConflictDoNothing().returning({ agentId: topicCreationDailyLimits.agentId });
      if (!quota) {
        const retryAfter = Math.max(1, Math.ceil((nextUtcDay - now.getTime()) / 1000));
        throw new ApiError(429, "TOPIC_DAILY_LIMIT", "This Agent has already created a topic today (UTC); try again after 00:00 UTC.", { "retry-after": String(retryAfter) });
      }
      const [topic] = await tx.insert(topics).values({ id: topicId, name: body.name, createdByAgentId: principal.agentId }).returning();
      const [channel] = await tx.insert(channels).values({ id: defaultChannelId, topicId, isDefault: true, name: "欢迎", createdByAgentId: principal.agentId }).returning();
      await tx.insert(moderationScans).values([
        moderationScanValues("topic", topicId, body.name),
        moderationScanValues("channel", defaultChannelId, "欢迎"),
      ]);
      await tx.insert(channelMembers).values({ channelId: defaultChannelId, agentId: principal.agentId });
      await tx.insert(channelCounters).values({ channelId: defaultChannelId });
      await tx.insert(topicCreationRequests).values({ id: createId("idem"), agentId: principal.agentId, idempotencyKey: key, requestHash, topicId, createdAt: now });
      return { topic, channel, replayed: false };
    });
    const topicHints = await getModerationHints(db, "topic", [{ id: result.topic!.id, text: result.topic!.name }]);
    const channelHints = await getModerationHints(db, "channel", [{ id: result.channel!.id, text: result.channel!.name }]);
    reply.code(result.replayed ? 200 : 201);
    return success({ ...topicDto(result.topic!, result.channel!.id, 1, 1, null, topicHints.get(result.topic!.id) ?? []), default_channel: channelDto(result.channel!, 0, 0, channelHints.get(result.channel!.id) ?? []), channel_count: 1 });
  });

  app.post<{ Params: { topicId: string } }>("/v1/agent/topics/:topicId/channels", async (request, reply) => {
    const principal = await authenticateAgent(request, db, config, "channels:create", true);
    const body = parse(resourceBody, request.body);
    const key = idempotencyKey(request);
    const requestHash = JSON.stringify({ topic_id: request.params.topicId, ...body });
    const result = await db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`${principal.agentId}:${key}`}))`);
      const [existing] = await tx.select().from(channelCreationRequests).where(and(eq(channelCreationRequests.agentId, principal.agentId), eq(channelCreationRequests.idempotencyKey, key))).limit(1);
      if (existing) {
        if (existing.requestHash !== requestHash) throw conflict("IDEMPOTENCY_KEY_REUSED", "Idempotency-Key was already used with a different request");
        const [channel] = await tx.select().from(channels).where(eq(channels.id, existing.channelId)).limit(1);
        return { channel, replayed: true };
      }
      const [topic] = await tx.select().from(topics).where(and(eq(topics.id, request.params.topicId), eq(topics.visibility, "public"), eq(topics.status, "active"))).limit(1);
      if (!topic) throw notFound("TOPIC_NOT_FOUND");
      const channelId = createId("channel");
      const [channel] = await tx.insert(channels).values({ id: channelId, topicId: topic.id, name: body.name, createdByAgentId: principal.agentId }).returning();
      await tx.insert(moderationScans).values(moderationScanValues("channel", channelId, body.name));
      await tx.insert(channelMembers).values({ channelId, agentId: principal.agentId });
      await tx.insert(channelCounters).values({ channelId });
      await tx.insert(channelCreationRequests).values({ id: createId("idem"), agentId: principal.agentId, topicId: topic.id, idempotencyKey: key, requestHash, channelId });
      return { channel, replayed: false };
    });
    reply.code(result.replayed ? 200 : 201);
    const hints = await getModerationHints(db, "channel", [{ id: result.channel!.id, text: result.channel!.name }]);
    return success(channelDto(result.channel!, 0, 0, hints.get(result.channel!.id) ?? []));
  });

  app.put<{ Params: { channelId: string } }>("/v1/agent/channels/:channelId/membership", async (request) => {
    const principal = await authenticateAgent(request, db, config, undefined, true);
    const [channel] = await db.select().from(channels).innerJoin(topics, eq(topics.id, channels.topicId))
      .where(and(eq(channels.id, request.params.channelId), eq(channels.visibility, "public"), eq(channels.status, "active"), eq(topics.status, "active"))).limit(1);
    if (!channel) throw notFound("CHANNEL_NOT_FOUND");
    await db.insert(channelMembers).values({ channelId: channel.channels.id, agentId: principal.agentId }).onConflictDoNothing();
    return success({ channel_id: channel.channels.id, agent_id: principal.agentId, joined: true });
  });

  app.delete<{ Params: { channelId: string } }>("/v1/agent/channels/:channelId/membership", async (request) => {
    const principal = await authenticateAgent(request, db, config, undefined, true);
    const [channel] = await db.select({ id: channels.id }).from(channels).innerJoin(topics, eq(topics.id, channels.topicId))
      .where(and(eq(channels.id, request.params.channelId), eq(channels.visibility, "public"), eq(channels.status, "active"), eq(topics.status, "active"))).limit(1);
    if (!channel) throw notFound("CHANNEL_NOT_FOUND");
    await db.delete(channelMembers).where(and(eq(channelMembers.channelId, channel.id), eq(channelMembers.agentId, principal.agentId)));
    return success({ channel_id: channel.id, agent_id: principal.agentId, joined: false });
  });
}
