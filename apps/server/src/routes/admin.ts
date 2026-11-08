import { createHash, timingSafeEqual } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type pg from "pg";
import { z } from "zod";
import { adminSessionMaxAge, createAdminSession, revokeAdminSession, validAdminSession } from "../admin-session.js";
import type { Config } from "../config.js";
import { ApiError } from "../errors.js";
import { listServerLogs } from "../log-buffer.js";
import { realtimeEvent, type RealtimeHub } from "../realtime/hub.js";
import { registerAdminPondJuryRoutes } from "./admin-pond-jury.js";

type Entry = { source: "api"; time: string; request_id: string; level: "info" | "warn" | "error"; method: string; route: string; status: number; duration_ms: number; error_type: string | null; error_code: string | null; error_message: string | null; message: null };
type RequestError = { type: string; code: string | null; message: string | null };
const adminSessionCookie = "dsh_yutang_admin";

function sessionCookie(token: string, secure: boolean, clear = false): string {
  return `${adminSessionCookie}=${token}; Path=/admin/v1; HttpOnly; SameSite=Strict; Max-Age=${clear ? 0 : adminSessionMaxAge}${secure ? "; Secure" : ""}`;
}

function cookieSession(header: string | undefined): string {
  const value = header?.split(";").map(part => part.trim()).find(part => part.startsWith(`${adminSessionCookie}=`));
  return value?.slice(adminSessionCookie.length + 1) ?? "";
}

type RuntimeSample = { time: number; duration_ms: number; status: number; route: string; error_type: string | null; active_at_start: number };
const runtimeWindowMs = 15 * 60 * 1000;
const maxRuntimeSamples = 20_000;

function percentile(values: number[], proportion: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return Math.ceil(proportion * sorted.length) ? sorted[Math.ceil(proportion * sorted.length) - 1]! : sorted[0]!;
}

export function registerAdminRoutes(app: FastifyInstance, pool: pg.Pool, config: Config, hub: RealtimeHub) {
  const entries: Entry[] = [];
  const requestErrors = new WeakMap<object, RequestError>();
  const requestConcurrency = new WeakMap<object, number>();
  const countedRequests = new WeakSet<object>();
  const runtimeSamples: RuntimeSample[] = [];
  let activeRequests = 0;
  const finishRequest = (request: object) => {
    if (!countedRequests.has(request)) return;
    countedRequests.delete(request);
    activeRequests = Math.max(0, activeRequests - 1);
  };
  app.addHook("onError", async (request, _reply, error) => {
    requestErrors.set(request, {
      type: error.name,
      code: error instanceof ApiError ? error.diagnosticCode ?? error.code : null,
      // API errors have deliberately curated public messages. Never copy arbitrary
      // exception text into the Admin log, where database/client internals may leak.
      message: error instanceof ApiError ? error.message : null,
    });
  });
  const pending = new Map<string, { requests: number; bytesIn: number; bytesOut: number }>();
  let inFlight: Promise<void> | undefined;
  async function flush(): Promise<void> {
    if (inFlight) await inFlight;
    if (!pending.size) return;
    const batch = [...pending.entries()]; pending.clear();
    const write = async () => {
      for (const [bucket, value] of batch) {
        try {
          await pool.query(`insert into traffic_buckets (bucket, requests, bytes_in, bytes_out) values ($1, $2, $3, $4)
            on conflict (bucket) do update set requests = traffic_buckets.requests + excluded.requests,
            bytes_in = traffic_buckets.bytes_in + excluded.bytes_in, bytes_out = traffic_buckets.bytes_out + excluded.bytes_out`,
          [bucket, value.requests, value.bytesIn, value.bytesOut]);
        } catch (error) {
          const old = pending.get(bucket) ?? { requests: 0, bytesIn: 0, bytesOut: 0 };
          pending.set(bucket, { requests: old.requests + value.requests, bytesIn: old.bytesIn + value.bytesIn, bytesOut: old.bytesOut + value.bytesOut });
          app.log.error({ errName: error instanceof Error ? error.name : "UnknownError" }, "Failed to persist traffic bucket");
        }
      }
    };
    inFlight = write();
    try { await inFlight; } finally { inFlight = undefined; }
  }
  const timer = setInterval(() => { void flush(); }, 10000); timer.unref();
  app.addHook("preClose", async () => { clearInterval(timer); await flush(); });
  app.addHook("onSend", async (request, reply, payload) => {
    if (!request.url.startsWith("/admin/") && !request.url.startsWith("/health/")) {
      const bucket = new Date(Math.floor(Date.now() / 3600000) * 3600000).toISOString();
      const item = pending.get(bucket) ?? { requests: 0, bytesIn: 0, bytesOut: 0 };
      const length = Number(request.headers["content-length"] ?? 0);
      item.requests++; item.bytesIn += Number.isSafeInteger(length) && length > 0 ? length : 0;
      item.bytesOut += typeof payload === "string" ? Buffer.byteLength(payload) : Buffer.isBuffer(payload) ? payload.length : 0;
      pending.set(bucket, item);
    }
    return payload;
  });
  app.addHook("onResponse", async (request, reply) => {
    if (request.url.startsWith("/admin/") || request.url.startsWith("/health/")) return;
    const startedConcurrency = requestConcurrency.get(request) ?? 0;
    finishRequest(request);
    const requestError = requestErrors.get(request) ?? null;
    runtimeSamples.push({ time: Date.now(), duration_ms: Math.max(0, reply.elapsedTime), status: reply.statusCode, route: request.routeOptions.url ?? request.url.split("?")[0] ?? "unknown", error_type: requestError?.type ?? null, active_at_start: startedConcurrency });
    const cutoff = Date.now() - runtimeWindowMs;
    while (runtimeSamples.length && (runtimeSamples.length > maxRuntimeSamples || runtimeSamples[0]!.time < cutoff)) runtimeSamples.shift();
    entries.push({ source: "api", time: new Date().toISOString(), request_id: request.id, level: reply.statusCode >= 500 ? "error" : reply.statusCode >= 400 ? "warn" : "info", method: request.method, route: request.routeOptions.url ?? "unknown", status: reply.statusCode, duration_ms: Math.round(reply.elapsedTime), error_type: requestError?.type ?? null, error_code: requestError?.code ?? null, error_message: requestError?.message ?? null, message: null });
    if (entries.length > 500) entries.shift();
  });
  const equal = (a: string, b: string) => timingSafeEqual(createHash("sha256").update(a).digest(), createHash("sha256").update(b).digest());
  const sessionTokens = (header: string | undefined, cookie: string | undefined) => [
    cookieSession(cookie),
    header?.startsWith("Bearer ") ? header.slice(7) : "",
  ].filter(Boolean);
  const sessionToken = (header: string | undefined, cookie: string | undefined) => sessionTokens(header, cookie)[0] ?? "";
  app.post("/admin/v1/login", { config: { rateLimit: { max: 5, timeWindow: "1 minute" } } }, async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    const data = z.object({ username: z.string().max(256), password: z.string().max(1024) }).safeParse(request.body);
    if (!config.ADMIN_USERNAME || !config.ADMIN_PASSWORD || !data.success || !equal(data.data.username, config.ADMIN_USERNAME) || !equal(data.data.password, config.ADMIN_PASSWORD)) return reply.code(401).send({ error: "Invalid credentials" });
    const token = createAdminSession(config);
    if (!token) return reply.code(401).send({ error: "Invalid credentials" });
    const secureCookie = config.ADMIN_COOKIE_SECURE || request.protocol === "https" || request.headers["x-forwarded-proto"] === "https";
    reply.header("Set-Cookie", sessionCookie(token, secureCookie));
    return { ok: true, expires_in: adminSessionMaxAge };
  });
  app.addHook("onRequest", async (request, reply) => {
    if (!request.url.startsWith("/admin/") && !request.url.startsWith("/health/")) {
      activeRequests += 1;
      countedRequests.add(request);
      requestConcurrency.set(request, activeRequests);
      request.raw.once("aborted", () => finishRequest(request));
    }
    if (request.url.startsWith("/admin/v1/") && request.url.split("?")[0] !== "/admin/v1/login") {
      reply.header("Cache-Control", "no-store");
      if (!await validAdminSession(sessionToken(request.headers.authorization, request.headers.cookie), config, pool)) return reply.code(401).send({ error: "Unauthorized" });
    }
  });
  app.post("/admin/v1/logout", async (request, reply) => {
    for (const token of sessionTokens(request.headers.authorization, request.headers.cookie)) {
      await revokeAdminSession(token, config, pool);
    }
    const secureCookie = config.ADMIN_COOKIE_SECURE || request.protocol === "https" || request.headers["x-forwarded-proto"] === "https";
    reply.header("Set-Cookie", sessionCookie("", secureCookie, true));
    return { ok: true };
  });
  app.get("/admin/v1/status", async (_request, reply) => {
    try { await pool.query("select 1"); return { api: "online", database: "online", uptime_seconds: Math.floor(process.uptime()) }; }
    catch { reply.code(503); return { api: "online", database: "unavailable", uptime_seconds: Math.floor(process.uptime()) }; }
  });
  app.get("/admin/v1/health", async (_request, reply) => {
    const now = Date.now();
    const cutoff = now - runtimeWindowMs;
    while (runtimeSamples.length && runtimeSamples[0]!.time < cutoff) runtimeSamples.shift();
    const samples = runtimeSamples;
    const durations = samples.map((sample) => sample.duration_ms);
    const messageSamples = samples.filter((sample) => sample.route.includes("messages"));
    const messageDurations = messageSamples.map((sample) => sample.duration_ms);
    let database = "online";
    try { await pool.query("select 1"); } catch { database = "unavailable"; }
    return {
      sampled_at: new Date(now).toISOString(),
      window_seconds: Math.floor(runtimeWindowMs / 1000),
      scope: "当前 Server 进程内存采样，重启后清空；不包含 Admin 与 health 请求",
      api: {
        sampled_requests: samples.length,
        requests_per_minute: Math.round(samples.length / (runtimeWindowMs / 60_000) * 10) / 10,
        p50_ms: percentile(durations, 0.50),
        p95_ms: percentile(durations, 0.95),
        p99_ms: percentile(durations, 0.99),
        active_requests: activeRequests,
        peak_concurrency: Math.max(activeRequests, ...samples.map((sample) => sample.active_at_start), 0),
        success_responses: samples.filter((sample) => sample.status >= 200 && sample.status < 400).length,
        client_error_responses: samples.filter((sample) => sample.status >= 400 && sample.status < 500).length,
        server_error_responses: samples.filter((sample) => sample.status >= 500).length,
        timeouts: samples.filter((sample) => sample.status === 408 || sample.status === 504 || /timeout|abort/i.test(sample.error_type ?? "")).length,
      },
      messages: {
        sampled_requests: messageSamples.length,
        p95_ms: percentile(messageDurations, 0.95),
        p99_ms: percentile(messageDurations, 0.99),
        timeouts: messageSamples.filter((sample) => sample.status === 408 || sample.status === 504 || /timeout|abort/i.test(sample.error_type ?? "")).length,
        latency_definition: "匹配消息 API 路由的 HTTP 请求处理耗时，不代表 WebSocket 端到端送达延迟",
      },
      realtime: hub.metrics(),
      database: { status: database, pool_total: pool.totalCount, pool_idle: pool.idleCount, pool_waiting: pool.waitingCount },
      process: { uptime_seconds: Math.floor(process.uptime()), memory_rss_bytes: process.memoryUsage().rss, heap_used_bytes: process.memoryUsage().heapUsed },
    };
  });
  app.get("/admin/v1/logs", async () => ({ entries: [...entries, ...listServerLogs()].sort((a, b) => b.time.localeCompare(a.time)).slice(0, 500) }));
  app.get("/admin/v1/accounts", async (request, reply) => {
    const query = z.object({ q: z.string().max(80).optional() }).safeParse(request.query);
    if (!query.success) return reply.code(400).send({ error: "Invalid query" });
    const term = `%${query.data.q?.trim() ?? ""}%`;
    const result = await pool.query(`select a.id, a.display_name, a.status, a.created_at, u.id as owner_id,
      (select count(*)::int from agent_credentials c where c.agent_id = a.id and c.revoked_at is null) as credentials
      from agents a join users u on u.id = a.owner_id where a.status <> 'system' and ($1 = '%%' or a.id ilike $1 or a.display_name ilike $1) order by a.created_at desc limit 200`, [term]);
    return { items: result.rows };
  });
  app.get("/admin/v1/topics", async (request, reply) => {
    const query = z.object({ q: z.string().max(80).optional() }).safeParse(request.query);
    if (!query.success) return reply.code(400).send({ error: "Invalid query" });
    const term = `%${query.data.q?.trim() ?? ""}%`;
    const result = await pool.query(`select t.id, t.name, t.visibility, t.status, t.created_at,
      (select count(*)::int from channels c where c.topic_id = t.id) as channel_count
      from topics t where $1 = '%%' or t.id ilike $1 or t.name ilike $1 order by t.created_at desc limit 200`, [term]);
    return { items: result.rows };
  });
  app.patch<{ Params: { id: string } }>("/admin/v1/accounts/:id", async (request, reply) => {
    const body = z.object({ status: z.enum(["active", "banned"]) }).safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: "Invalid status" });
    const result = await pool.query("update agents set status = $2 where id = $1 and status <> 'system' returning id, status", [request.params.id, body.data.status]);
    if (!result.rowCount) return reply.code(404).send({ error: "Not found" });
    if (body.data.status === "banned") await pool.query("update agent_credentials set revoked_at = now() where agent_id = $1 and revoked_at is null", [request.params.id]);
    if (body.data.status === "banned") hub.closeAgent(request.params.id);
    return result.rows[0];
  });
  app.patch<{ Params: { id: string } }>("/admin/v1/topics/:id", async (request, reply) => {
    const body = z.object({ status: z.enum(["active", "disabled"]) }).safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: "Invalid status" });
    const result = await pool.query(`update topics set status = case
      when $2 = 'active' and (manual_hidden or exists(select 1 from moderation_cases c where c.target_type='topic' and c.target_id=topics.id and c.status in ('confirmed_violation','admin_confirmed_violation'))) then 'hidden'
      else $2 end where id = $1 returning id, status`, [request.params.id, body.data.status]);
    if (!result.rowCount) return reply.code(404).send({ error: "Not found" });
    const event = realtimeEvent("topic.visibility.changed", { topic_id: request.params.id, hidden: result.rows[0].status !== "active" });
    hub.publishTopic(request.params.id, event);
    const { rows: channels } = await pool.query("select id from channels where topic_id=$1", [request.params.id]);
    for (const channel of channels) hub.publishChannel(channel.id as string, event);
    return result.rows[0];
  });
  app.delete<{ Params: { id: string } }>("/admin/v1/accounts/:id", async (request, reply) => {
    const result = await pool.query("update agents set status = 'deleted' where id = $1 and status <> 'system' returning id, status", [request.params.id]);
    if (!result.rowCount) return reply.code(404).send({ error: "Not found" });
    await pool.query("update agent_credentials set revoked_at = now() where agent_id = $1 and revoked_at is null", [request.params.id]);
    hub.closeAgent(request.params.id);
    return { ok: true };
  });
  app.delete<{ Params: { id: string } }>("/admin/v1/topics/:id", async (request, reply) => {
    const result = await pool.query("update topics set status = 'deleted' where id = $1 returning id", [request.params.id]);
    if (!result.rowCount) return reply.code(404).send({ error: "Not found" });
    const event = realtimeEvent("topic.visibility.changed", { topic_id: request.params.id, hidden: true });
    hub.publishTopic(request.params.id, event);
    const { rows: channels } = await pool.query("select id from channels where topic_id=$1", [request.params.id]);
    for (const channel of channels) hub.publishChannel(channel.id as string, event);
    return { ok: true };
  });
  app.get("/admin/v1/stats", async (request, reply) => {
    const query = z.object({ range: z.enum(["day", "week", "month"]).default("day") }).safeParse(request.query);
    if (!query.success) return reply.code(400).send({ error: "Invalid range" });
    const days = query.data.range === "day" ? 1 : query.data.range === "week" ? 7 : 30;
    const unit = days === 1 ? "hour" : "day";
    const buckets = days === 1 ? 24 : days;
    const totals = await pool.query("select (select count(*)::int from topics) topics, (select count(*)::int from channels) channels, (select count(*)::int from messages where deleted_at is null) messages, (select count(*)::int from agents where status <> 'system') agents");
    const series = await pool.query(`select slots.bucket,
      (select count(*)::int from topics t where t.created_at >= slots.bucket and t.created_at < slots.bucket + case when $1 = 'hour' then interval '1 hour' else interval '1 day' end) as topics,
      (select count(*)::int from channels c where c.created_at >= slots.bucket and c.created_at < slots.bucket + case when $1 = 'hour' then interval '1 hour' else interval '1 day' end) as channels,
      count(m.id)::int as messages
      from generate_series(date_trunc($1, now()) - (($2 - 1) * case when $1 = 'hour' then interval '1 hour' else interval '1 day' end),
        date_trunc($1, now()), case when $1 = 'hour' then interval '1 hour' else interval '1 day' end) slots(bucket)
      left join messages m on m.created_at >= slots.bucket and m.created_at < slots.bucket + case when $1 = 'hour' then interval '1 hour' else interval '1 day' end and m.deleted_at is null
      group by slots.bucket order by slots.bucket`, [unit, buckets]);
    await flush();
    const traffic = await pool.query(`select slots.bucket, coalesce(sum(t.requests), 0)::text as requests,
      coalesce(sum(t.bytes_in), 0)::text as bytes_in, coalesce(sum(t.bytes_out), 0)::text as bytes_out
      from generate_series(date_trunc($1, now()) - (($2 - 1) * case when $1 = 'hour' then interval '1 hour' else interval '1 day' end),
        date_trunc($1, now()), case when $1 = 'hour' then interval '1 hour' else interval '1 day' end) slots(bucket)
      left join traffic_buckets t on t.bucket >= slots.bucket and t.bucket < slots.bucket + case when $1 = 'hour' then interval '1 hour' else interval '1 day' end
      group by slots.bucket order by slots.bucket`, [unit, buckets]);
    return { range: query.data.range, totals: totals.rows[0], series: series.rows, traffic: traffic.rows, traffic_pending: pending.size > 0 };
  });
  registerAdminPondJuryRoutes(app, pool, hub);
}
