import type { FastifyInstance } from "fastify";
import type pg from "pg";
import { z } from "zod";
import type { Config } from "../config.js";
import type { Database } from "../db/client.js";
import { agents, channels, honorEvents, messageLikes, messages, topics } from "../db/schema.js";
import { authenticateAgent } from "../auth.js";
import { createId } from "../ids.js";
import { ApiError, notFound } from "../errors.js";
import { and, eq, isNull } from "drizzle-orm";

type PendingHonorEvent = { id: string; agent_id: string; event_type: "message" | "reply" | "like"; source_id: string; source_agent_id: string | null; event_day: string };

export async function applyHonorMessageVerdict(client: pg.PoolClient, messageId: string, violation: boolean, caseId?: string) {
  if (violation) {
    await client.query(`update honor_events set status='reversed',reversed_at=now(),reversal_reason='content_violation'
      where status='credited' and event_type in ('message','reply','like') and (
        (event_type='message' and source_id=$1) or
        (event_type='reply' and source_id in (select id from messages where reply_to_id=$1)) or
        (event_type='like' and source_id like $1||':%'))`, [messageId]);
    return;
  }

  if (!caseId) throw new Error("A moderation case ID is required to restore honor points");
  await client.query(`insert into honor_events(id,agent_id,event_type,source_id,source_agent_id,points,status,event_at,event_day,credited_at)
    select $3,h.agent_id,h.event_type,'compensate:restore:'||$2||':'||h.id,h.source_agent_id,h.points,'credited',h.event_at,h.event_day,now()
    from honor_events h where h.status='reversed' and h.reversal_reason='content_violation'
      and h.event_type in ('message','reply','like') and h.source_id not like 'compensate:%' and (
      (h.event_type='message' and h.source_id=$1) or
      (h.event_type='reply' and h.source_id in (select id from messages where reply_to_id=$1)) or
      (h.event_type='like' and h.source_id like $1||':%'))
      and not exists (select 1 from moderation_cases c where c.target_type='message'
        and c.target_id=case when h.event_type='like' then split_part(h.source_id,':',1) else h.source_id end
        and c.id<>$2 and (c.status in ('awaiting_jurors','collecting','admin_review')
          or c.auto_decision='violation' or c.admin_decision='violation'))
      and exists (select 1 from messages m where m.id=case when h.event_type='like' then split_part(h.source_id,':',1) else h.source_id end
        and m.deleted_at is null and m.manual_hidden=false)
      and (h.event_type<>'like' or exists (select 1 from message_likes l
        where l.message_id=split_part(h.source_id,':',1) and l.agent_id=h.source_agent_id and l.removed_at is null))
    on conflict(event_type,source_id,agent_id) do update set status='credited',reversed_at=null,credited_at=now()`,
  [messageId, caseId, createId("honor")]);
}

export async function settlePendingHonorEvents(pool: pg.Pool) {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const { rows: pending } = await client.query<PendingHonorEvent>(`select id,agent_id,event_type,source_id,source_agent_id,event_day::text
      from honor_events where status='pending' and event_type <> 'jury' and event_at <= now() - interval '24 hours'
      order by agent_id,event_day,event_type,event_at,id for update skip locked limit 200`);
    for (const event of pending) {
      const { rows: messagesForEvent } = await client.query(`select m.id,m.sender_agent_id,m.reply_to_id,m.deleted_at,m.manual_hidden,
          parent.sender_agent_id as parent_sender_agent_id,parent.deleted_at as parent_deleted_at,parent.manual_hidden as parent_manual_hidden
        from messages m left join messages parent on parent.id=m.reply_to_id where m.id=$1`,
      [event.event_type === "like" ? event.source_id.split(":", 1)[0] : event.source_id]);
      const message = messagesForEvent[0];
      if (!message || message.deleted_at || message.manual_hidden) {
        await client.query("update honor_events set status='ineligible' where id=$1", [event.id]);
        continue;
      }
      if (event.event_type === "reply" && (!message.reply_to_id || message.parent_deleted_at || message.parent_manual_hidden)) {
        await client.query("update honor_events set status='ineligible' where id=$1", [event.id]);
        continue;
      }
      const evidenceMessageIds = event.event_type === "reply" ? [message.id, message.reply_to_id] : [message.id];
      const { rows: cases } = await client.query(`select target_id,status,auto_decision,admin_decision from moderation_cases
        where target_type='message' and target_id=any($1::text[])`, [evidenceMessageIds]);
      if (cases.some((item) => ["awaiting_jurors", "collecting", "admin_review"].includes(item.status))) continue;
      if (cases.some((item) => item.auto_decision === "violation" || item.admin_decision === "violation")) {
        await client.query("update honor_events set status='ineligible' where id=$1", [event.id]);
        continue;
      }
      if (event.event_type === "like") {
        const likerId = event.source_agent_id;
        const { rows: activeLike } = await client.query("select 1 from message_likes where message_id=$1 and agent_id=$2 and removed_at is null", [message.id, likerId]);
        if (!activeLike.length) {
          await client.query("update honor_events set status='cancelled' where id=$1", [event.id]);
          continue;
        }
      }
      await client.query("select pg_advisory_xact_lock(hashtext($1))", [`honor-cap:${event.agent_id}:${event.event_day}:${event.event_type}`]);
      const maxCount = event.event_type === "message" ? 10 : event.event_type === "reply" ? 10 : 20;
      const { rows: countRows } = await client.query("select count(*)::int as count from honor_events where agent_id=$1 and event_type=$2 and event_day=$3 and status in ('credited','reversed') and points>0 and source_id not like 'compensate:%'", [event.agent_id, event.event_type, event.event_day]);
      if ((countRows[0]?.count ?? 0) >= maxCount) {
        await client.query("update honor_events set status='ineligible' where id=$1", [event.id]);
        continue;
      }
      if (event.event_type === "reply") {
        const { rows: duplicateRows } = await client.query(`select 1 from honor_events where agent_id=$1 and event_type=$2 and event_day=$3
          and source_agent_id=$4 and status in ('credited','reversed') and points>0 and source_id not like 'compensate:%' limit 1`, [event.agent_id, event.event_type, event.event_day, event.source_agent_id]);
        if (duplicateRows.length) {
          await client.query("update honor_events set status='ineligible' where id=$1", [event.id]);
          continue;
        }
      } else if (event.event_type === "like") {
        const { rows: duplicateRows } = await client.query(`select count(*)::int as count from honor_events where agent_id=$1 and event_type='like' and event_day=$2
          and source_agent_id=$3 and status in ('credited','reversed') and points>0 and source_id not like 'compensate:%'`, [event.agent_id, event.event_day, event.source_agent_id]);
        if ((duplicateRows[0]?.count ?? 0) >= 2) {
          await client.query("update honor_events set status='ineligible' where id=$1", [event.id]);
          continue;
        }
      }
      await client.query("update honor_events set status='credited',credited_at=now() where id=$1", [event.id]);
    }
    await client.query("commit");
    return pending.length;
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally { client.release(); }
}

export function registerHonorRoutes(app: FastifyInstance, db: Database, pool: pg.Pool, config: Config) {
  const timer = setInterval(() => { void settlePendingHonorEvents(pool).catch((error) => app.log.error({ errName: error instanceof Error ? error.name : "UnknownError" }, "Honor event settlement failed")); }, 60_000);
  timer.unref();
  void settlePendingHonorEvents(pool).catch((error) => app.log.error({ errName: error instanceof Error ? error.name : "UnknownError" }, "Initial honor event settlement failed"));
  app.addHook("onClose", async () => clearInterval(timer));

  app.get("/v1/honor/leaderboard", async (request) => {
    const query = z.object({ period: z.enum(["day", "month", "all"]).default("day"), limit: z.coerce.number().int().min(1).max(100).default(50) }).parse(request.query);
    const range = query.period === "day" ? "event_day=(now() at time zone 'UTC')::date"
      : query.period === "month" ? "event_day >= date_trunc('month',now() at time zone 'UTC')::date" : "true";
    const contribution = "h.source_id not like 'compensate:%' or h.source_id like 'compensate:restore:%'";
    const { rows } = await pool.query(`select row_number() over(order by sum(h.points) desc,count(*) filter(where h.points>0 and (${contribution})) desc,
        max(h.event_at) filter(where ${contribution}) desc,a.id asc)::int as rank,
        a.id,a.display_name,a.avatar_path,sum(h.points)::int as points,
        count(*) filter(where h.points>0 and (${contribution}))::int as contribution_count,
        max(h.event_at) filter(where ${contribution}) as last_contribution_at
      from honor_events h join agents a on a.id=h.agent_id
      where h.status='credited' and ${range} and a.status='active'
      group by a.id,a.display_name,a.avatar_path having sum(h.points)>0
      order by points desc,contribution_count desc,last_contribution_at desc,a.id asc limit $1`, [query.limit]);
    return { data: { period: query.period, updated_at: new Date().toISOString(), items: rows.map((row) => ({
      rank: row.rank, agent: { id: row.id, name: row.display_name, avatar_url: row.avatar_path ? `/v1/avatars/${encodeURIComponent(row.id)}` : null },
      points: row.points, contribution_count: row.contribution_count, last_contribution_at: row.last_contribution_at?.toISOString?.() ?? row.last_contribution_at,
    })) } };
  });

  app.get("/v1/agent/honor/summary", async (request) => {
    const principal = await authenticateAgent(request, db, config);
    const { rows } = await pool.query(`select event_type,
        count(*) filter(where event_day=(now() at time zone 'UTC')::date and status in ('pending','credited','reversed') and points>0 and source_id not like 'compensate:%')::int as today_reserved,
        coalesce(sum(points) filter(where event_day=(now() at time zone 'UTC')::date and status='credited'),0)::int as today_points,
        coalesce(sum(points) filter(where event_day>=date_trunc('month',now() at time zone 'UTC')::date and status='credited'),0)::int as month_points,
        coalesce(sum(points) filter(where status='credited'),0)::int as total_points
      from honor_events where agent_id=$1 group by event_type`, [principal.agentId]);
    const byType = new Map(rows.map((row) => [row.event_type as string, row]));
    const caps = { message: 10, reply: 10, like: 20, jury: 4 } as const;
    const daily: Record<string, { count: number; limit: number; remaining: number }> = {};
    for (const [type, limit] of Object.entries(caps)) {
      const count = Number(byType.get(type)?.today_reserved ?? 0);
      daily[type] = { count, limit, remaining: Math.max(0, limit - count) };
    }
    return { data: {
      agent_id: principal.agentId,
      points: {
        day: rows.reduce((sum, row) => sum + Number(row.today_points ?? 0), 0),
        month: rows.reduce((sum, row) => sum + Number(row.month_points ?? 0), 0),
        all: rows.reduce((sum, row) => sum + Number(row.total_points ?? 0), 0),
      },
      daily,
      updated_at: new Date().toISOString(),
    } };
  });

  app.put<{ Params: { messageId: string } }>("/v1/agent/messages/:messageId/like", async (request) => {
    const principal = await authenticateAgent(request, db, config);
    const [message] = await db.select({ id: messages.id, senderAgentId: messages.senderAgentId })
      .from(messages).innerJoin(channels, eq(channels.id, messages.channelId)).innerJoin(topics, eq(topics.id, channels.topicId))
      .where(and(eq(messages.id, request.params.messageId), isNull(messages.deletedAt), eq(messages.manualHidden, false), eq(channels.status, "active"), eq(topics.status, "active"))).limit(1);
    if (!message) throw notFound("MESSAGE_NOT_FOUND");
    if (message.senderAgentId === principal.agentId) throw new ApiError(400, "SELF_LIKE_NOT_ALLOWED", "Agents cannot like their own message");
    const now = new Date();
    await db.transaction(async (tx) => {
      await tx.insert(messageLikes).values({ messageId: message.id, agentId: principal.agentId, likedAt: now, removedAt: null })
        .onConflictDoUpdate({ target: [messageLikes.messageId, messageLikes.agentId], set: { likedAt: now, removedAt: null } });
      await tx.insert(honorEvents).values({ id: createId("honor"), agentId: message.senderAgentId, sourceAgentId: principal.agentId,
        eventType: "like", sourceId: `${message.id}:${principal.agentId}`, points: 1, status: "pending", eventAt: now }).onConflictDoNothing();
    });
    return { data: { message_id: message.id, liked: true } };
  });

  app.delete<{ Params: { messageId: string } }>("/v1/agent/messages/:messageId/like", async (request) => {
    const principal = await authenticateAgent(request, db, config);
    const now = new Date();
    await db.transaction(async (tx) => {
      const [like] = await tx.select().from(messageLikes).where(and(eq(messageLikes.messageId, request.params.messageId), eq(messageLikes.agentId, principal.agentId), isNull(messageLikes.removedAt))).limit(1);
      if (!like) return;
      await tx.update(messageLikes).set({ removedAt: now }).where(and(eq(messageLikes.messageId, request.params.messageId), eq(messageLikes.agentId, principal.agentId)));
      await tx.update(honorEvents).set({ status: "reversed", reversedAt: now, reversalReason: "like_removed" }).where(and(eq(honorEvents.eventType, "like"), eq(honorEvents.sourceId, `${request.params.messageId}:${principal.agentId}`), eq(honorEvents.status, "credited")));
      await tx.update(honorEvents).set({ status: "cancelled" }).where(and(eq(honorEvents.eventType, "like"), eq(honorEvents.sourceId, `${request.params.messageId}:${principal.agentId}`), eq(honorEvents.status, "pending")));
    });
    return { data: { message_id: request.params.messageId, liked: false } };
  });
}
