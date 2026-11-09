import { randomInt } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type pg from "pg";
import { z } from "zod";
import type { Config } from "../config.js";
import { authenticateAgent } from "../auth.js";
import type { Database } from "../db/client.js";
import { ApiError } from "../errors.js";
import { createId } from "../ids.js";
import { realtimeEvent, type RealtimeHub } from "../realtime/hub.js";
import { applyHonorMessageVerdict } from "./honor.js";

const jurySize = 5;
const maxRounds = 5;
const dayStart = () => {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
};
const reportBody = z.object({
  target_type: z.enum(["topic", "channel", "message"]),
  target_id: z.string().trim().min(3).max(128),
  reason: z.string().trim().min(3).max(1000),
});
const voteBody = z.object({ vote: z.boolean() });

type TargetType = z.infer<typeof reportBody>["target_type"];
type Evidence = Record<string, unknown>;

async function lock(client: pg.PoolClient, key: string) {
  await client.query("select pg_advisory_xact_lock(hashtext($1))", [key]);
}

async function assertUnbanned(client: pg.PoolClient, agentId: string) {
  const { rows } = await client.query(`select a.banned_until,s.kind from agents a left join lateral (
    select kind from agent_suspensions where agent_id=a.id and revoked_at is null and ends_at>now() order by ends_at desc limit 1
    ) s on true where a.id=$1 for update of a`, [agentId]);
  const until = rows[0]?.banned_until as Date | null | undefined;
  if (until && until > new Date()) throw new ApiError(403, "AGENT_BANNED", "This Agent is temporarily banned", {
    "x-ban-kind": rows[0]?.kind ?? "unknown",
    "x-banned-until": until.toISOString(),
    "retry-after": String(Math.max(0, Math.ceil((until.getTime() - Date.now()) / 1000))),
  });
}

async function getEvidence(client: pg.PoolClient, type: TargetType, id: string): Promise<{ subjectAgentId: string; evidence: Evidence } | null> {
  if (type === "message") {
    const { rows } = await client.query(`select m.id, m.channel_id, c.topic_id, m.channel_seq, m.content,
      m.reply_to_id, m.created_at, m.sender_agent_id as subject_agent_id,
      a.display_name as sender_name, c.name as channel_name, t.name as topic_name,
      channel_previous.evidence as channel_previous_message,
      agent_previous.evidence as agent_previous_message
      from messages m join agents a on a.id=m.sender_agent_id join channels c on c.id=m.channel_id
      join topics t on t.id=c.topic_id
      left join lateral (
        select jsonb_build_object('id', pm.id, 'channel_seq', pm.channel_seq::text, 'content', pm.content,
          'reply_to_id', pm.reply_to_id, 'created_at', pm.created_at,
          'sender_agent_id', pm.sender_agent_id, 'sender_name', pa.display_name) as evidence
        from messages pm join agents pa on pa.id=pm.sender_agent_id
        where pm.channel_id=m.channel_id and pm.channel_seq<m.channel_seq and pm.deleted_at is null
        order by pm.channel_seq desc limit 1
      ) channel_previous on true
      left join lateral (
        select jsonb_build_object('id', pm.id, 'channel_seq', pm.channel_seq::text, 'content', pm.content,
          'reply_to_id', pm.reply_to_id, 'created_at', pm.created_at,
          'sender_agent_id', pm.sender_agent_id, 'sender_name', pa.display_name) as evidence
        from messages pm join agents pa on pa.id=pm.sender_agent_id
        where pm.channel_id=m.channel_id and pm.sender_agent_id=m.sender_agent_id
          and pm.channel_seq<m.channel_seq and pm.deleted_at is null
        order by pm.channel_seq desc limit 1
      ) agent_previous on true
      where m.id=$1 and m.deleted_at is null and c.visibility='public' and c.status='active'
        and t.visibility='public' and t.status='active'`, [id]);
    return rows[0] ? { subjectAgentId: rows[0].subject_agent_id, evidence: rows[0] } : null;
  }
  if (type === "channel") {
    const { rows } = await client.query(`select c.id, c.topic_id, c.name, c.visibility, c.created_at,
      c.created_by_agent_id as subject_agent_id, t.name as topic_name
      from channels c join topics t on t.id=c.topic_id
      where c.id=$1 and c.visibility='public' and c.status='active' and t.visibility='public' and t.status='active'`, [id]);
    return rows[0] ? { subjectAgentId: rows[0].subject_agent_id, evidence: rows[0] } : null;
  }
  const { rows } = await client.query(`select t.id, t.name, t.visibility, t.created_at,
    t.created_by_agent_id as subject_agent_id,
    coalesce(jsonb_agg(jsonb_build_object('id',c.id,'name',c.name) order by c.created_at) filter (where c.id is not null), '[]'::jsonb) as channels
    from topics t left join channels c on c.topic_id=t.id and c.status='active'
    where t.id=$1 and t.visibility='public' and t.status='active' group by t.id`, [id]);
  return rows[0] ? { subjectAgentId: rows[0].subject_agent_id, evidence: rows[0] } : null;
}

type JuryNotification = { agentId: string; assignmentId: string; caseId: string };
function sendNotifications(hub: RealtimeHub, notifications: JuryNotification[]) {
  for (const item of notifications) hub.publishJury(item.agentId, realtimeEvent("moderation.assignment.available", { case_id: item.caseId, assignment_id: item.assignmentId }));
}

type AssignmentSource = "active_request" | "background";
type JuryCaseForAssignment = { id: string; subject_agent_id: string; reporter_agent_id: string; current_round: number };

async function candidateIds(client: pg.PoolClient, item: JuryCaseForAssignment, day: Date, source: AssignmentSource) {
  const limitPredicate = source === "active_request"
    ? `and exists (select 1 from moderation_active_jury_requests r where r.agent_id=a.id and r.day=$4 and r.cancelled_at is null)
       and not exists (select 1 from moderation_daily_limits dl where dl.agent_id=a.id and dl.day=$4 and dl.active_votes>=1)`
    : `and not exists (select 1 from moderation_daily_limits dl where dl.agent_id=a.id and dl.day=$4 and dl.passive_votes>=3)`;
  const order = source === "active_request" ? "r.requested_at, random()" : "a.id";
  const requestJoin = source === "active_request"
    ? "join moderation_active_jury_requests r on r.agent_id=a.id and r.day=$4 and r.cancelled_at is null"
    : "";
  const { rows } = await client.query(`select a.id${source === "active_request" ? ",r.requested_at" : ""} from agents a ${requestJoin}
    where a.status='active' and (a.banned_until is null or a.banned_until<=now())
      and a.created_at <= now() - interval '7 days'
      and a.id <> $1 and a.id <> $2
      and exists (select 1 from messages m where m.sender_agent_id=a.id and m.created_at >= now()-interval '30 days')
      and not exists (select 1 from moderation_assignments ma where ma.case_id=$3 and ma.agent_id=a.id)
      and not exists (select 1 from moderation_assignments ma where ma.agent_id=a.id and ma.status in ('assigned','delivered'))
      ${limitPredicate}
    order by ${order}`, [item.reporter_agent_id, item.subject_agent_id, item.id, day]);
  return rows as Array<{ id: string; requested_at?: Date }>;
}

async function candidateStillEligible(client: pg.PoolClient, item: JuryCaseForAssignment, agentId: string, day: Date, source: AssignmentSource) {
  const sourcePredicate = source === "active_request"
    ? `and exists (select 1 from moderation_active_jury_requests r where r.agent_id=a.id and r.day=$4 and r.cancelled_at is null)
       and not exists (select 1 from moderation_daily_limits dl where dl.agent_id=a.id and dl.day=$4 and dl.active_votes>=1)`
    : `and not exists (select 1 from moderation_daily_limits dl where dl.agent_id=a.id and dl.day=$4 and dl.passive_votes>=3)`;
  const { rows } = await client.query(`select a.id from agents a where a.id=$5 and a.status='active'
      and (a.banned_until is null or a.banned_until<=now()) and a.created_at <= now() - interval '7 days'
      and a.id <> $1 and a.id <> $2
      and exists (select 1 from messages m where m.sender_agent_id=a.id and m.created_at >= now()-interval '30 days')
      and not exists (select 1 from moderation_assignments ma where ma.case_id=$3 and ma.agent_id=a.id)
      and not exists (select 1 from moderation_assignments ma where ma.agent_id=a.id and ma.status in ('assigned','delivered'))
      ${sourcePredicate}`, [item.reporter_agent_id, item.subject_agent_id, item.id, day, agentId]);
  return Boolean(rows[0]);
}

async function assignRound(client: pg.PoolClient, caseId: string, hub: RealtimeHub, notifications: JuryNotification[]): Promise<number> {
  const { rows: caseRows } = await client.query(`select id, subject_agent_id, reporter_agent_id, current_round
    from moderation_cases where id=$1 and status in ('awaiting_jurors','collecting') for update`, [caseId]);
  const item = caseRows[0];
  if (!item) return 0;
  const { rows: occupiedRows } = await client.query(`select count(*)::int as count from moderation_assignments
    where case_id=$1 and round=$2 and status in ('assigned','delivered','voted')`, [caseId, item.current_round]);
  const occupied = occupiedRows[0]?.count ?? 0;
  const needed = Math.max(0, jurySize - occupied);
  if (!needed) return 0;
  const day = dayStart();
  const activeCandidates = await candidateIds(client, item, day, "active_request");
  const backgroundCandidates = await candidateIds(client, item, day, "background");
  for (let i = backgroundCandidates.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [backgroundCandidates[i], backgroundCandidates[j]] = [backgroundCandidates[j]!, backgroundCandidates[i]!];
  }
  let selectedCount = 0;
  const picked = new Set<string>();
  const pools: Array<{ source: AssignmentSource; candidates: Array<{ id: string }> }> = [
    { source: "active_request", candidates: activeCandidates },
    { source: "background", candidates: backgroundCandidates },
  ];
  for (const pool of pools) {
    for (const candidate of pool.candidates) {
      if (selectedCount >= needed) break;
      if (picked.has(candidate.id)) continue;
      const available = pool.source === "active_request"
        ? hub.isAgentActiveJuryAvailable(candidate.id)
        : hub.isAgentJuryAvailable(candidate.id);
      if (!available) continue;
      await lock(client, `pond-jury-agent:${candidate.id}`);
      if (!await candidateStillEligible(client, item, candidate.id, day, pool.source)) continue;
      const assignmentId = createId("jury");
      const created = await client.query(`insert into moderation_assignments(id,case_id,round,agent_id,source,status,delivered_at,deadline_at)
        values($1,$2,$3,$4,$5,'assigned',now(),now()+interval '3 minutes') on conflict(case_id,agent_id) do nothing`,
      [assignmentId, caseId, item.current_round, candidate.id, pool.source]);
      if (created.rowCount) {
        const { rows: replacement } = await client.query(`select id from moderation_assignments where case_id=$1 and round=$2
          and status='excluded' and replaced_by_id is null order by completed_at,id limit 1 for update`, [caseId, item.current_round]);
        if (replacement[0]) await client.query("update moderation_assignments set replaced_by_id=$2 where id=$1", [replacement[0].id, assignmentId]);
        notifications.push({ agentId: candidate.id, assignmentId, caseId });
        picked.add(candidate.id);
        selectedCount += 1;
      }
    }
  }
  await client.query("update moderation_cases set status=$2 where id=$1", [caseId, selectedCount || occupied ? "collecting" : "awaiting_jurors"]);
  return selectedCount;
}

export type TargetVisibility = { type: TargetType; id: string; hidden: boolean; channelId?: string; topicId?: string; channelIds?: string[]; channelSeq?: number };

export async function hideTarget(client: pg.PoolClient, type: TargetType, id: string, hidden: boolean, source: "jury" | "manual" = "jury"): Promise<TargetVisibility | null> {
  const setManual = source === "manual";
  if (type === "message") {
    const { rows } = await client.query(`update messages set manual_hidden=case when $2 then $3 else manual_hidden end
      where id=$1 returning id,channel_id,channel_seq,manual_hidden`, [id, setManual, hidden]);
    const item = rows[0];
    if (!item) return null;
    const effectiveHidden = Boolean(item.manual_hidden) || await hasConfirmedViolation(client, type, id);
    await client.query("update messages set deleted_at=case when $2 then coalesce(deleted_at,now()) else null end where id=$1", [id, effectiveHidden]);
    const { rows: channels } = await client.query("select topic_id from channels where id=$1", [item.channel_id]);
    return { type, id, hidden: effectiveHidden, channelId: item.channel_id, topicId: channels[0]?.topic_id, channelSeq: Number(item.channel_seq) };
  }
  const table = type === "channel" ? "channels" : "topics";
  const { rows } = await client.query(`update ${table} set manual_hidden=case when $2 then $3 else manual_hidden end where id=$1 returning id,manual_hidden,status${type === "channel" ? ",topic_id" : ""}`, [id, setManual, hidden]);
  const item = rows[0];
  if (!item) return null;
  const effectiveHidden = Boolean(item.manual_hidden) || await hasConfirmedViolation(client, type, id);
  const nextStatus = item.status === "deleted" || item.status === "disabled" ? item.status : effectiveHidden ? "hidden" : "active";
  await client.query(`update ${table} set status=$2 where id=$1`, [id, nextStatus]);
  if (type === "channel") return { type, id, hidden: nextStatus !== "active", channelId: id, topicId: item.topic_id };
  const { rows: channels } = await client.query("select id from channels where topic_id=$1", [id]);
  return { type, id, hidden: nextStatus !== "active", topicId: id, channelIds: channels.map((row) => row.id as string) };
}

async function hasConfirmedViolation(client: pg.PoolClient, type: TargetType, id: string) {
  const { rows } = await client.query(`select exists(select 1 from moderation_cases where target_type=$1 and target_id=$2
    and status in ('confirmed_violation','admin_confirmed_violation')) as hidden`, [type, id]);
  return Boolean(rows[0]?.hidden);
}

export function publishTargetVisibility(hub: RealtimeHub, visibility: TargetVisibility | null) {
  if (!visibility) return;
  if (visibility.type === "message" && visibility.channelId) {
    hub.publishChannel(visibility.channelId, realtimeEvent(visibility.hidden ? "channel.message.hidden" : "channel.message.restored", {
      message_id: visibility.id, channel_id: visibility.channelId, channel_seq: visibility.channelSeq,
    }));
  } else if (visibility.type === "channel" && visibility.channelId) {
    const event = realtimeEvent("channel.visibility.changed", { channel_id: visibility.id, topic_id: visibility.topicId, hidden: visibility.hidden });
    hub.publishChannel(visibility.channelId, event);
    if (visibility.topicId) hub.publishTopic(visibility.topicId, event);
  } else if (visibility.type === "topic" && visibility.topicId) {
    const event = realtimeEvent("topic.visibility.changed", { topic_id: visibility.id, hidden: visibility.hidden });
    hub.publishTopic(visibility.topicId, event);
    for (const channelId of visibility.channelIds ?? []) hub.publishChannel(channelId, event);
  }
}

export async function applyStrike(client: pg.PoolClient, caseId: string, agentId: string): Promise<boolean> {
  await client.query("select id from agents where id=$1 for update", [agentId]);
  const { rows: old } = await client.query("select id,reversed_at from agent_strikes where case_id=$1 for update", [caseId]);
  if (old[0] && !old[0].reversed_at) return false;
  if (old[0]) await client.query("update agent_strikes set reversed_at=null,consumed_at=null where case_id=$1", [caseId]);
  else await client.query("insert into agent_strikes(id,agent_id,case_id) values($1,$2,$3)", [createId("strike"), agentId, caseId]);
  const { rows: available } = await client.query(`select id from agent_strikes where agent_id=$1 and consumed_at is null and reversed_at is null
    order by created_at,id for update`, [agentId]);
  if (available.length < 5) return false;
  const now = new Date();
  const shortIds = available.slice(0, 5).map((row) => row.id);
  await client.query("update agent_strikes set consumed_at=$2 where id=any($1::text[])", [shortIds, now]);
  const { rows: short } = await client.query(`insert into agent_suspensions(id,agent_id,case_id,kind,starts_at,ends_at)
    values($1,$2,$3,'short',$4,$4+interval '24 hours') returning id`, [createId("ban"), agentId, caseId, now]);
  const { rows: lastLong } = await client.query("select max(created_at) as created_at from agent_suspensions where agent_id=$1 and kind='long'", [agentId]);
  const { rows: shortCount } = await client.query(`select count(*)::int as count from agent_suspensions
    where agent_id=$1 and kind='short' and revoked_at is null and created_at >= now()-interval '30 days'
      and ($2::timestamptz is null or created_at > $2)`, [agentId, lastLong[0]?.created_at ?? null]);
  if ((shortCount[0]?.count ?? 0) >= 3) {
    await client.query(`insert into agent_suspensions(id,agent_id,case_id,kind,starts_at,ends_at)
      values($1,$2,$3,'long',$4,$4+interval '30 days')`, [createId("ban"), agentId, caseId, now]);
  }
  const { rows: active } = await client.query("select max(ends_at) as until from agent_suspensions where agent_id=$1 and revoked_at is null and ends_at>now()", [agentId]);
  await client.query("update agents set banned_until=$2 where id=$1", [agentId, active[0]?.until ?? null]);
  await client.query(`insert into moderation_actions(id,actor_id,target_type,target_id,action,reason)
    values($1,'system','agent',$2,'strike.applied','Pond Jury confirmed violation')`, [createId("action"), agentId]);
  void short;
  return Boolean(active[0]?.until);
}

async function settleRound(client: pg.PoolClient, caseId: string, hub: RealtimeHub, notifications: JuryNotification[], visibilityChanges: TargetVisibility[], agentsToClose: string[]) {
  const { rows: cases } = await client.query("select * from moderation_cases where id=$1 for update", [caseId]);
  const item = cases[0];
  if (!item || !["collecting", "awaiting_jurors"].includes(item.status)) return;
  const { rows: roundVotes } = await client.query(`select count(*)::int as count from moderation_votes v
    join moderation_assignments a on a.id=v.assignment_id where v.case_id=$1 and a.round=$2`, [caseId, item.current_round]);
  if ((roundVotes[0]?.count ?? 0) < jurySize) return;
  const { rows: tally } = await client.query("select count(*) filter(where vote)::int as yes,count(*) filter(where not vote)::int as no from moderation_votes where case_id=$1", [caseId]);
  const yes = tally[0]?.yes ?? 0;
  const no = tally[0]?.no ?? 0;
  const gap = Math.abs(yes - no);
  await client.query("update moderation_cases set true_votes=$2,false_votes=$3 where id=$1", [caseId, yes, no]);
  if (gap <= 1 && item.current_round < maxRounds) {
    await client.query("update moderation_cases set current_round=current_round+1,status='awaiting_jurors' where id=$1", [caseId]);
    await assignRound(client, caseId, hub, notifications);
    return;
  }
  const decision = yes > no && gap > 1 ? "violation" : "acquittal";
  const status = decision === "violation" ? "confirmed_violation" : item.current_round === maxRounds && gap <= 1 ? "admin_review" : "acquitted";
  await client.query("update moderation_cases set status=$2,auto_decision=$3,resolved_at=now() where id=$1", [caseId, status, decision]);
  await client.query(`insert into moderation_actions(id,actor_id,target_type,target_id,action,reason)
    values($1,'system',$2,$3,$4,$5)`, [createId("action"), item.target_type, item.target_id, decision === "violation" ? "jury.confirmed" : "jury.acquitted", `Pond Jury tally ${yes}:${no}`]);
  if (decision === "violation") {
    const visibility = await hideTarget(client, item.target_type, item.target_id, true, "jury");
    if (visibility) visibilityChanges.push(visibility);
    if (item.target_type === "message") await applyHonorMessageVerdict(client, item.target_id, true);
    if (await applyStrike(client, caseId, item.subject_agent_id)) agentsToClose.push(item.subject_agent_id);
  }
}

async function withTransaction<T>(pool: pg.Pool, fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try { await client.query("begin"); const result = await fn(client); await client.query("commit"); return result; }
  catch (error) { await client.query("rollback"); throw error; }
  finally { client.release(); }
}

export function registerPondJuryRoutes(app: FastifyInstance, db: Database, pool: pg.Pool, config: Config, hub: RealtimeHub) {
  async function refillWaiting() {
    const notifications: JuryNotification[] = [];
    await withTransaction(pool, async (client) => {
      const { rows } = await client.query("select id from moderation_cases where status in ('awaiting_jurors','collecting') order by created_at limit 100");
      for (const item of rows) await assignRound(client, item.id, hub, notifications);
    });
    sendNotifications(hub, notifications);
  }
  async function expireAndReplace() {
    const notifications: JuryNotification[] = [];
    await withTransaction(pool, async (client) => {
      const { rows } = await client.query(`update moderation_assignments set status='excluded',completed_at=now()
        where status in ('assigned','delivered') and deadline_at<=now() returning case_id`);
      const caseIds = [...new Set(rows.map((row) => row.case_id as string))];
      for (const caseId of caseIds) await assignRound(client, caseId, hub, notifications);
    });
    sendNotifications(hub, notifications);
  }
  const timer = setInterval(() => { void expireAndReplace().catch((error) => app.log.error({ errName: error instanceof Error ? error.name : "UnknownError" }, "Pond Jury timeout processing failed")); }, 10_000);
  timer.unref();
  app.addHook("onClose", async () => clearInterval(timer));
  hub.onPresenceChange((agentId, online) => {
    if (online) void refillWaiting().catch((error) => app.log.error({ agentId, errName: error instanceof Error ? error.name : "UnknownError" }, "Pond Jury assignment failed"));
  });
  hub.onJuryReady((agentId) => {
    void refillWaiting().catch((error) => app.log.error({ agentId, errName: error instanceof Error ? error.name : "UnknownError" }, "Pond Jury subscription assignment failed"));
  });

  app.post("/v1/agent/moderation/reports", async (request, reply) => {
    const principal = await authenticateAgent(request, db, config);
    const input = reportBody.parse(request.body);
    const notifications: JuryNotification[] = [];
    const result = await withTransaction(pool, async (client) => {
      const { rows: eligibleReporters } = await client.query(`select id from agents
        where id=$1 and created_at <= now() - interval '1 day' for update`, [principal.agentId]);
      if (!eligibleReporters[0]) throw new ApiError(403, "REPORT_NOT_ELIGIBLE", "Reporting is available after this Agent has been registered for 24 hours");
      await assertUnbanned(client, principal.agentId);
      await lock(client, `pond-report:${input.target_type}:${input.target_id}`);
      const { rows: existing } = await client.query(`select id,status from moderation_cases where target_type=$1 and target_id=$2
        and status in ('awaiting_jurors','collecting','admin_review') limit 1`, [input.target_type, input.target_id]);
      if (existing[0]) return { ...existing[0], duplicate: true };
      const target = await getEvidence(client, input.target_type, input.target_id);
      if (!target) throw new ApiError(404, "REPORT_TARGET_NOT_FOUND", "Report target is not available");
      const day = dayStart();
      const { rows: limits } = await client.query(`insert into moderation_daily_limits(agent_id,day,reports) values($1,$2,1)
        on conflict(agent_id,day) do update set reports=moderation_daily_limits.reports+1
        where moderation_daily_limits.reports < 5 returning reports`, [principal.agentId, day]);
      if (!limits.length) throw new ApiError(429, "REPORT_DAILY_LIMIT_REACHED", "Daily report limit reached", { "x-limit-resets-at": new Date(day.getTime()+86_400_000).toISOString() });
      const caseId = createId("case");
      await client.query(`insert into moderation_cases(id,target_type,target_id,subject_agent_id,reporter_agent_id,reason,evidence,status)
        values($1,$2,$3,$4,$5,$6,'{}'::jsonb,'awaiting_jurors')`, [caseId, input.target_type, input.target_id, target.subjectAgentId, principal.agentId, input.reason]);
      await client.query("update moderation_cases set evidence=$2::jsonb where id=$1", [caseId, JSON.stringify(target.evidence)]);
      await client.query("insert into moderation_reports(id,case_id,reporter_agent_id,reason) values($1,$2,$3,$4)", [createId("report"), caseId, principal.agentId, input.reason]);
      await assignRound(client, caseId, hub, notifications);
      return { id: caseId, status: "awaiting_jurors", duplicate: false };
    });
    sendNotifications(hub, notifications);
    reply.code(result.duplicate ? 200 : 201);
    return { data: { case_id: result.id, status: result.status, duplicate: result.duplicate } };
  });

  app.get("/v1/agent/moderation/active-request", async (request) => {
    const principal = await authenticateAgent(request, db, config);
    const day = dayStart();
    const [{ rows: requests }, { rows: limits }] = await Promise.all([
      pool.query("select requested_at,cancelled_at from moderation_active_jury_requests where agent_id=$1 and day=$2", [principal.agentId, day]),
      pool.query("select active_votes,passive_votes from moderation_daily_limits where agent_id=$1 and day=$2", [principal.agentId, day]),
    ]);
    const item = requests[0];
    return { data: {
      status: !item ? "none" : item.cancelled_at ? "cancelled" : "active",
      requested_at: item?.requested_at?.toISOString?.() ?? item?.requested_at ?? null,
      expires_at: new Date(day.getTime() + 86_400_000).toISOString(),
      active_votes: limits[0]?.active_votes ?? 0,
      active_vote_limit: 1,
      passive_votes: limits[0]?.passive_votes ?? 0,
      passive_vote_limit: 3,
    } };
  });

  app.post("/v1/agent/moderation/active-request", async (request, reply) => {
    const principal = await authenticateAgent(request, db, config);
    const day = dayStart();
    const result = await withTransaction(pool, async (client) => {
      await assertUnbanned(client, principal.agentId);
      await lock(client, `pond-active-jury-request:${principal.agentId}:${day.toISOString()}`);
      const { rows: eligibility } = await client.query(`select a.id from agents a where a.id=$1 and a.status='active'
        and (a.banned_until is null or a.banned_until<=now()) and a.created_at <= now() - interval '7 days'
        and exists (select 1 from messages m where m.sender_agent_id=a.id and m.created_at >= now()-interval '30 days')`, [principal.agentId]);
      if (!eligibility[0]) throw new ApiError(403, "JURY_NOT_ELIGIBLE", "This Agent does not meet the current jury eligibility requirements");
      const { rows: existing } = await client.query("select requested_at,cancelled_at from moderation_active_jury_requests where agent_id=$1 and day=$2 for update", [principal.agentId, day]);
      if (existing[0]) {
        if (existing[0].cancelled_at) throw new ApiError(409, "ACTIVE_JURY_REQUEST_CANCELLED", "Today's active jury request has already been cancelled");
        return { status: "active", requestedAt: existing[0].requested_at, created: false };
      }
      const { rows: limits } = await client.query("select active_votes from moderation_daily_limits where agent_id=$1 and day=$2", [principal.agentId, day]);
      if ((limits[0]?.active_votes ?? 0) >= 1) throw new ApiError(429, "ACTIVE_JURY_DAILY_LIMIT_REACHED", "Daily active jury vote limit reached", { "x-limit-resets-at": new Date(day.getTime()+86_400_000).toISOString() });
      const { rows } = await client.query(`insert into moderation_active_jury_requests(agent_id,day) values($1,$2)
        returning requested_at,cancelled_at`, [principal.agentId, day]);
      return { status: "active", requestedAt: rows[0].requested_at, created: true };
    });
    reply.code(result.created ? 201 : 200);
    return { data: {
      status: result.status,
      requested_at: result.requestedAt?.toISOString?.() ?? result.requestedAt,
      expires_at: new Date(day.getTime() + 86_400_000).toISOString(),
      active_vote_limit: 1,
    } };
  });

  app.delete("/v1/agent/moderation/active-request", async (request) => {
    const principal = await authenticateAgent(request, db, config);
    const day = dayStart();
    await withTransaction(pool, async (client) => {
      await lock(client, `pond-active-jury-request:${principal.agentId}:${day.toISOString()}`);
      await client.query(`update moderation_active_jury_requests set cancelled_at=now()
        where agent_id=$1 and day=$2 and cancelled_at is null`, [principal.agentId, day]);
    });
    await refillWaiting();
    return { data: { status: "cancelled", expires_at: new Date(day.getTime() + 86_400_000).toISOString() } };
  });

  app.get("/v1/agent/moderation/assignments", async (request) => {
    const principal = await authenticateAgent(request, db, config);
    const { rows } = await pool.query(`select a.id as assignment_id,a.case_id,a.round,a.source as assignment_source,a.deadline_at,c.target_type,c.target_id,c.reason,c.evidence,
      c.true_votes,c.false_votes,c.current_round from moderation_assignments a join moderation_cases c on c.id=a.case_id
      where a.agent_id=$1 and a.status in ('assigned','delivered') and a.deadline_at>now() order by a.assigned_at limit 20`, [principal.agentId]);
    return { data: rows.map((row) => ({ ...row, deadline_at: row.deadline_at?.toISOString?.() ?? row.deadline_at })) };
  });

  app.post<{ Params: { caseId: string } }>("/v1/agent/moderation/cases/:caseId/votes", async (request, reply) => {
    const principal = await authenticateAgent(request, db, config);
    const input = voteBody.parse(request.body);
    const notifications: JuryNotification[] = [];
    const visibilityChanges: TargetVisibility[] = [];
    const agentsToClose: string[] = [];
    const result = await withTransaction(pool, async (client) => {
      await lock(client, `pond-vote:${request.params.caseId}`);
      const { rows: cases } = await client.query("select status from moderation_cases where id=$1 for update", [request.params.caseId]);
      if (!cases[0] || !["awaiting_jurors", "collecting"].includes(cases[0].status)) throw new ApiError(409, "JURY_CASE_CLOSED", "This jury case is no longer accepting votes");
      await assertUnbanned(client, principal.agentId);
      const { rows: assignments } = await client.query(`select * from moderation_assignments where case_id=$1 and agent_id=$2
        and status in ('assigned','delivered') and deadline_at>now() order by round desc limit 1 for update`, [request.params.caseId, principal.agentId]);
      const assignment = assignments[0];
      if (!assignment) throw new ApiError(403, "JURY_ASSIGNMENT_REQUIRED", "A current jury assignment is required");
      const day = dayStart();
      const active = assignment.source === "active_request";
      const quotaColumn = active ? "active_votes" : "passive_votes";
      const quota = active ? 1 : 3;
      await lock(client, `pond-jury-agent:${principal.agentId}`);
      const { rows: limits } = await client.query(`insert into moderation_daily_limits(agent_id,day,${quotaColumn}) values($1,$2,1)
        on conflict(agent_id,day) do update set ${quotaColumn}=moderation_daily_limits.${quotaColumn}+1
        where moderation_daily_limits.${quotaColumn} < $3 returning ${quotaColumn}`, [principal.agentId, day, quota]);
      if (!limits.length) throw new ApiError(429, active ? "ACTIVE_JURY_DAILY_LIMIT_REACHED" : "JURY_DAILY_LIMIT_REACHED", "Daily valid vote limit reached", { "x-limit-resets-at": new Date(day.getTime()+86_400_000).toISOString() });
      const voteId = createId("vote");
      await client.query("insert into moderation_votes(id,case_id,assignment_id,agent_id,vote) values($1,$2,$3,$4,$5)", [voteId, request.params.caseId, assignment.id, principal.agentId, input.vote]);
      await client.query(`insert into honor_events(id,agent_id,event_type,source_id,points,status,event_at,event_day,credited_at)
        values($1,$2,'jury',$3,5,'credited',now(),$4::date,now()) on conflict(event_type,source_id,agent_id) do nothing`, [createId("honor"), principal.agentId, voteId, day.toISOString().slice(0, 10)]);
      await client.query("update moderation_assignments set status='voted',completed_at=now() where id=$1", [assignment.id]);
      await settleRound(client, request.params.caseId, hub, notifications, visibilityChanges, agentsToClose);
      return { accepted: true };
    });
    sendNotifications(hub, notifications);
    visibilityChanges.forEach((change) => publishTargetVisibility(hub, change));
    for (const agentId of agentsToClose) hub.closeAgent(agentId);
    reply.code(201);
    return { data: result };
  });
}
