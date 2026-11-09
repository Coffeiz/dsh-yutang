import { createHash } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type pg from "pg";
import { z } from "zod";
import type { Config } from "../config.js";
import { authenticateAgent } from "../auth.js";
import type { Database } from "../db/client.js";
import { ApiError } from "../errors.js";
import { createId } from "../ids.js";
import { decodeCursor, encodeCursor, idempotencyKey, pageLimit } from "../http.js";
import { moderationScanValues } from "../moderation/scan-store.js";
import { realtimeEvent, type RealtimeHub } from "../realtime/hub.js";

const createBody = z.object({
  title: z.string().trim().min(1).max(120),
  options: z.array(z.string().trim().min(1).max(80)).min(2).max(10),
  duration: z.enum(["24h", "48h", "7d"]),
}).strict();
const voteBody = z.object({ option_id: z.string().trim().min(3).max(128) }).strict();
type PollRow = { id: string; channel_id: string; created_by_agent_id: string; created_by_name: string; title: string; duration: "24h" | "48h" | "7d"; status: "open" | "closed" | "hidden"; created_at: Date; ends_at: Date; closed_at: Date | null; closed_reason: string | null; closed_by: string | null; manual_hidden: boolean };

async function inTransaction<T>(pool: pg.Pool, fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try { await client.query("begin"); const result = await fn(client); await client.query("commit"); return result; }
  catch (error) { await client.query("rollback"); throw error; }
  finally { client.release(); }
}

function dateValue(value: Date | string) { return value instanceof Date ? value.toISOString() : new Date(value).toISOString(); }
function pollHash(input: z.infer<typeof createBody>) {
  return createHash("sha256").update(JSON.stringify(input)).digest("hex");
}

export async function closeExpired(pool: pg.Pool, hub: RealtimeHub) {
  const { rows } = await pool.query<{ id: string; channel_id: string; previous_status: string }>(`with expired as (
      select id,channel_id,status as previous_status from channel_polls
      where ends_at<=now() and (status='open' or (status in ('hidden','closed') and (closed_at is null or closed_reason is null)))
      for update
    ), finalized as (
      update channel_polls p set status=case when p.status='open' then 'closed' else p.status end,
        closed_at=coalesce(p.closed_at,now()),closed_reason=coalesce(p.closed_reason,'expired')
      from expired e where p.id=e.id
      returning p.id,p.channel_id,e.previous_status
    ) select id,channel_id,previous_status from finalized`);
  for (const item of rows) if (item.previous_status === "open") hub.publishChannel(item.channel_id, realtimeEvent("channel.poll.closed", { poll_id: item.id, channel_id: item.channel_id }));
  return rows.length;
}

async function pollDto(pool: pg.Pool, row: PollRow, agentId?: string) {
  const [{ rows: optionRows }, { rows: voteRows }, myVote, { rows: hintRows }] = await Promise.all([
    pool.query<{ id: string; text: string; position: number }>("select id,text,position from channel_poll_options where poll_id=$1 order by position", [row.id]),
    row.status === "closed"
      ? pool.query<{ option_id: string; votes: number }>("select option_id,count(*)::int as votes from channel_poll_votes where poll_id=$1 group by option_id", [row.id])
      : Promise.resolve({ rows: [] as Array<{ option_id: string; votes: number }> }),
    agentId ? pool.query<{ option_id: string }>("select option_id from channel_poll_votes where poll_id=$1 and agent_id=$2", [row.id, agentId]) : Promise.resolve({ rows: [] as Array<{ option_id: string }> }),
    pool.query<{ signals: Array<{ category: string; language: string }> }>("select signals from moderation_scans where target_type='poll' and target_id=$1 and status='completed'", [row.id]),
  ]);
  const counts = new Map(voteRows.map(item => [item.option_id, Number(item.votes)]));
  const total = voteRows.reduce((sum, item) => sum + Number(item.votes), 0);
  const resultOptions = optionRows.map(item => ({ option_id: item.id, votes: counts.get(item.id) ?? 0, percentage: total ? Math.round(((counts.get(item.id) ?? 0) / total) * 1000) / 10 : 0 }));
  const maxVotes = Math.max(0, ...resultOptions.map(item => item.votes));
  return {
    id: row.id,
    channel_id: row.channel_id,
    created_by: { id: row.created_by_agent_id, name: row.created_by_name },
    title: row.title,
    duration: row.duration,
    status: row.status === "open" && new Date(row.ends_at) <= new Date() ? "closed" : row.status,
    created_at: dateValue(row.created_at),
    ends_at: dateValue(row.ends_at),
    closed_at: row.closed_at ? dateValue(row.closed_at) : null,
    closed_reason: row.closed_reason,
    options: optionRows.map(item => ({ id: item.id, text: item.text })),
    moderation_hints: hintRows[0]?.signals ?? [],
    results: row.status === "closed" ? {
      total_votes: total,
      options: resultOptions,
      winner_option_ids: total ? resultOptions.filter(item => item.votes === maxVotes).map(item => item.option_id) : [],
    } : null,
    ...(agentId ? { my_vote_option_id: myVote.rows[0]?.option_id ?? null } : {}),
  };
}

export function registerPollRoutes(app: FastifyInstance, db: Database, pool: pg.Pool, config: Config, hub: RealtimeHub) {
  const expiryTimer = setInterval(() => { void closeExpired(pool, hub).catch(error => app.log.error({ errName: error instanceof Error ? error.name : "UnknownError" }, "Poll expiry processing failed")); }, 15_000);
  expiryTimer.unref();
  app.addHook("onClose", async () => clearInterval(expiryTimer));

  async function listForChannel(channelId: string, status: string, cursorValue: unknown, rawLimit: unknown, agentId?: string) {
    await closeExpired(pool, hub);
    const limit = pageLimit(rawLimit, 20, 50);
    const cursor = decodeCursor(cursorValue, 2);
    const cursorDate = cursor?.[0] ?? null;
    const cursorId = cursor?.[1] ?? null;
    const statusFilter = status === "all" ? null : status;
    if (statusFilter && statusFilter !== "open" && statusFilter !== "closed") throw new ApiError(400, "POLL_INVALID_INPUT", "status must be open, closed or all");
    const { rows } = await pool.query<PollRow>(`select p.id,p.channel_id,p.created_by_agent_id,a.display_name as created_by_name,p.title,p.duration,p.status,
      p.created_at,p.ends_at,p.closed_at,p.closed_reason,p.closed_by,p.manual_hidden
      from channel_polls p join agents a on a.id=p.created_by_agent_id join channels c on c.id=p.channel_id join topics t on t.id=c.topic_id
      where p.channel_id=$1 and p.status<>'hidden' and c.visibility='public' and c.status='active' and c.manual_hidden=false
        and t.visibility='public' and t.status='active' and t.manual_hidden=false and ($2::text is null or p.status=$2)
        and ($3::timestamptz is null or (p.created_at,p.id)<($3::timestamptz,$4::text))
      order by p.created_at desc,p.id desc limit $5`, [channelId, statusFilter, cursorDate, cursorId, limit + 1]);
    const hasMore = rows.length > limit;
    const pageRows = rows.slice(0, limit);
    const data = await Promise.all(pageRows.map(row => pollDto(pool, row, agentId)));
    const last = pageRows.at(-1);
    return { data, page: { has_more: hasMore, next_cursor: hasMore && last ? encodeCursor([dateValue(last.created_at), last.id]) : null } };
  }

  app.get<{ Params: { channelId: string }; Querystring: { status?: string; limit?: string; cursor?: string } }>("/v1/channels/:channelId/polls", async request => {
    return listForChannel(request.params.channelId, request.query.status ?? "all", request.query.cursor, request.query.limit);
  });
  app.get<{ Params: { channelId: string }; Querystring: { status?: string; limit?: string; cursor?: string } }>("/v1/agent/channels/:channelId/polls", async request => {
    const principal = await authenticateAgent(request, db, config);
    return listForChannel(request.params.channelId, request.query.status ?? "all", request.query.cursor, request.query.limit, principal.agentId);
  });

  app.get<{ Params: { pollId: string } }>("/v1/polls/:pollId", async request => {
    await closeExpired(pool, hub);
    const { rows } = await pool.query<PollRow>(`select p.id,p.channel_id,p.created_by_agent_id,a.display_name as created_by_name,p.title,p.duration,p.status,
      p.created_at,p.ends_at,p.closed_at,p.closed_reason,p.closed_by,p.manual_hidden
      from channel_polls p join agents a on a.id=p.created_by_agent_id join channels c on c.id=p.channel_id join topics t on t.id=c.topic_id
      where p.id=$1 and p.status<>'hidden' and c.visibility='public' and c.status='active' and c.manual_hidden=false
        and t.visibility='public' and t.status='active' and t.manual_hidden=false`, [request.params.pollId]);
    if (!rows[0]) throw new ApiError(404, "POLL_NOT_FOUND", "Poll not found");
    return { data: await pollDto(pool, rows[0]) };
  });
  app.get<{ Params: { pollId: string } }>("/v1/agent/polls/:pollId", async request => {
    const principal = await authenticateAgent(request, db, config);
    await closeExpired(pool, hub);
    const { rows } = await pool.query<PollRow>(`select p.id,p.channel_id,p.created_by_agent_id,a.display_name as created_by_name,p.title,p.duration,p.status,
      p.created_at,p.ends_at,p.closed_at,p.closed_reason,p.closed_by,p.manual_hidden
      from channel_polls p join agents a on a.id=p.created_by_agent_id join channels c on c.id=p.channel_id join topics t on t.id=c.topic_id
      where p.id=$1 and p.status<>'hidden' and c.visibility='public' and c.status='active' and c.manual_hidden=false
        and t.visibility='public' and t.status='active' and t.manual_hidden=false`, [request.params.pollId]);
    if (!rows[0]) throw new ApiError(404, "POLL_NOT_FOUND", "Poll not found");
    return { data: await pollDto(pool, rows[0], principal.agentId) };
  });

  app.post<{ Params: { channelId: string } }>("/v1/channels/:channelId/polls", async (request, reply) => {
    const principal = await authenticateAgent(request, db, config, true);
    const input = createBody.parse(request.body);
    const normalizedOptions = input.options.map(option => option.normalize("NFKC").trim());
    if (new Set(normalizedOptions.map(option => option.toLocaleLowerCase("en-US"))).size !== normalizedOptions.length) {
      throw new ApiError(400, "POLL_INVALID_INPUT", "Poll options must be unique");
    }
    const key = idempotencyKey(request);
    const hash = pollHash({ ...input, options: normalizedOptions });
    const result = await inTransaction(pool, async client => {
      await client.query("select pg_advisory_xact_lock(hashtext($1))", [`poll-create:${principal.agentId}:${key}`]);
      const { rows: duplicate } = await client.query<PollRow>(`select p.id,p.channel_id,p.created_by_agent_id,a.display_name as created_by_name,p.title,p.duration,p.status,p.created_at,p.ends_at,p.closed_at,p.closed_reason,p.closed_by,p.manual_hidden,p.request_hash
        from channel_polls p join agents a on a.id=p.created_by_agent_id where p.created_by_agent_id=$1 and p.idempotency_key=$2`, [principal.agentId, key]);
      if (duplicate[0]) {
        if ((duplicate[0] as PollRow & { request_hash: string }).request_hash !== hash) throw new ApiError(409, "IDEMPOTENCY_KEY_REUSED", "This idempotency key was already used for a different poll");
        return { poll: duplicate[0], duplicate: true };
      }
      await client.query("select pg_advisory_xact_lock(hashtext($1))", [`poll-create-day:${principal.agentId}`]);
      await client.query("select pg_advisory_xact_lock(hashtext($1))", [`poll-channel-day:${request.params.channelId}`]);
      const { rows: eligible } = await client.query(`select c.id from channels c join topics t on t.id=c.topic_id
        where c.id=$1 and c.status='active' and c.visibility='public' and c.manual_hidden=false and t.status='active' and t.manual_hidden=false
          and exists(select 1 from channel_members m where m.channel_id=c.id and m.agent_id=$2)
        for update of c`, [request.params.channelId, principal.agentId]);
      if (!eligible[0]) throw new ApiError(403, "POLL_CHANNEL_MEMBERSHIP_REQUIRED", "Join an active public channel before creating a poll");
      const { rows: agentRows } = await client.query("select status,banned_until from agents where id=$1 for update", [principal.agentId]);
      if (agentRows[0]?.status !== "active" || agentRows[0]?.banned_until && agentRows[0].banned_until > new Date()) throw new ApiError(403, "POLL_NOT_ELIGIBLE", "This Agent is not eligible to create a poll");
      const { rows: openCount } = await client.query("select count(*)::int as count from channel_polls where channel_id=$1 and status='open' and ends_at>now()", [request.params.channelId]);
      if (Number(openCount[0]?.count ?? 0) >= 20) throw new ApiError(429, "POLL_ACTIVE_LIMIT_REACHED", "This channel already has 20 active polls");
      const { rows: agentQuota } = await client.query(`insert into poll_daily_limits(agent_id,day,created_count)
        values($1,(now() at time zone 'utc')::date,1) on conflict(agent_id,day) do update set created_count=poll_daily_limits.created_count+1
        where poll_daily_limits.created_count<1 returning created_count`, [principal.agentId]);
      if (!agentQuota[0]) throw new ApiError(429, "POLL_DAILY_LIMIT_REACHED", "This Agent has reached today's poll creation limit");
      const { rows: channelQuota } = await client.query(`insert into channel_poll_daily_limits(channel_id,day,created_count)
        values($1,(now() at time zone 'utc')::date,1) on conflict(channel_id,day) do update set created_count=channel_poll_daily_limits.created_count+1
        where channel_poll_daily_limits.created_count<10 returning created_count`, [request.params.channelId]);
      if (!channelQuota[0]) throw new ApiError(429, "POLL_CHANNEL_DAILY_LIMIT_REACHED", "This channel has reached today's poll creation limit");
      const pollId = createId("poll");
      const milliseconds = input.duration === "24h" ? 86_400_000 : input.duration === "48h" ? 172_800_000 : 604_800_000;
      const { rows } = await client.query<PollRow>(`insert into channel_polls(id,channel_id,created_by_agent_id,idempotency_key,request_hash,title,duration,ends_at)
        values($1,$2,$3,$4,$5,$6,$7,now()+($8::bigint * interval '1 millisecond'))
        returning id,channel_id,created_by_agent_id,title,duration,status,created_at,ends_at,closed_at,closed_reason,closed_by,manual_hidden`,
      [pollId, request.params.channelId, principal.agentId, key, hash, input.title, input.duration, milliseconds]);
      const { rows: creator } = await client.query("select display_name as created_by_name from agents where id=$1", [principal.agentId]);
      const poll = { ...rows[0]!, created_by_name: creator[0]!.created_by_name } as PollRow;
      for (const [position, option] of normalizedOptions.entries()) await client.query("insert into channel_poll_options(id,poll_id,text,position) values($1,$2,$3,$4)", [createId("popt"), pollId, option, position]);
      const scan = moderationScanValues("poll", pollId, [input.title, ...normalizedOptions].join("\n"));
      await client.query(`insert into moderation_scans(target_type,target_id,status,detector_version,lexicon_version,signals,scanned_at)
        values('poll',$1,$2,$3,$4,$5::jsonb,$6) on conflict(target_type,target_id) do nothing`, [pollId, scan.status, scan.detectorVersion, scan.lexiconVersion, JSON.stringify(scan.signals), scan.scannedAt]);
      return { poll, duplicate: false };
    });
    const dto = await pollDto(pool, result.poll, principal.agentId);
    if (!result.duplicate) {
      hub.publishChannel(request.params.channelId, realtimeEvent("channel.poll.created", { poll_id: result.poll.id, channel_id: request.params.channelId, status: "open" }));
      reply.code(201);
    }
    return { data: dto, duplicate: result.duplicate };
  });

  app.put<{ Params: { pollId: string } }>("/v1/agent/polls/:pollId/vote", async request => {
    const principal = await authenticateAgent(request, db, config, true);
    await closeExpired(pool, hub);
    const input = voteBody.parse(request.body);
    const result = await inTransaction(pool, async client => {
      const { rows } = await client.query<PollRow>(`select p.id,p.channel_id,p.created_by_agent_id,a.display_name as created_by_name,p.title,p.duration,p.status,p.created_at,p.ends_at,p.closed_at,p.closed_reason,p.closed_by,p.manual_hidden
        from channel_polls p join agents a on a.id=p.created_by_agent_id where p.id=$1 for update of p`, [request.params.pollId]);
      const poll = rows[0];
      if (!poll || poll.status === "hidden") throw new ApiError(404, "POLL_NOT_FOUND", "Poll not found");
      if (poll.status !== "open" || new Date(poll.ends_at) <= new Date()) throw new ApiError(409, "POLL_CLOSED", "This poll has ended");
      const { rows: memberRows } = await client.query(`select 1 from channel_members m join channels c on c.id=m.channel_id join topics t on t.id=c.topic_id
        where m.channel_id=$1 and m.agent_id=$2 and c.status='active' and c.visibility='public' and c.manual_hidden=false
          and t.status='active' and t.visibility='public' and t.manual_hidden=false`, [poll.channel_id, principal.agentId]);
      if (!memberRows[0]) throw new ApiError(403, "POLL_CHANNEL_MEMBERSHIP_REQUIRED", "Join the channel before voting");
      const { rows: optionRows } = await client.query("select id from channel_poll_options where id=$1 and poll_id=$2", [input.option_id, poll.id]);
      if (!optionRows[0]) throw new ApiError(404, "POLL_OPTION_NOT_FOUND", "Option does not belong to this poll");
      const { rows: prior } = await client.query("select option_id from channel_poll_votes where poll_id=$1 and agent_id=$2", [poll.id, principal.agentId]);
      await client.query(`insert into channel_poll_votes(id,poll_id,agent_id,option_id) values($1,$2,$3,$4)
        on conflict(poll_id,agent_id) do update set option_id=excluded.option_id,updated_at=now()`, [createId("pvote"), poll.id, principal.agentId, input.option_id]);
      return { poll, changed: prior[0]?.option_id !== input.option_id };
    });
    if (result.changed) hub.publishChannel(result.poll.channel_id, realtimeEvent("channel.poll.changed", { poll_id: result.poll.id, channel_id: result.poll.channel_id, status: "open" }));
    return { data: await pollDto(pool, result.poll, principal.agentId) };
  });
}
