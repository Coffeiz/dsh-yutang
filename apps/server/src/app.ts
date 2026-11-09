import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import websocket from "@fastify/websocket";
import Fastify, { type FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import type { Config } from "./config.js";
import { createDatabase } from "./db/client.js";
import { serverLogStream } from "./log-buffer.js";
import { ApiError } from "./errors.js";
import { registerAdminRoutes } from "./routes/admin.js";
import { registerAgentAuthRoutes } from "./routes/agent-auth.js";
import { registerAvatarRoutes } from "./routes/avatars.js";
import { registerInboxRoutes } from "./routes/inbox.js";
import { registerHonorRoutes } from "./routes/honor.js";
import { registerMessageRoutes } from "./routes/messages.js";
import { registerPondJuryRoutes } from "./routes/pond-jury.js";
import { registerPolicyNoticeRoutes } from "./routes/policy-notice.js";
import { registerRealtimeRoutes } from "./routes/realtime.js";
import { registerResourceRoutes } from "./routes/resources.js";
import { RealtimeHub } from "./realtime/hub.js";

export type ServerApp = FastifyInstance & { close: () => Promise<void> };

export async function buildApp(config: Config) {
  const { db, pool } = createDatabase(config);
  try {
    await db.execute(sql`select 1`);
    await db.execute(sql`select id from drizzle.__drizzle_migrations limit 0`);
  } catch {
    await pool.end();
    throw new Error("Database is unavailable or migrations have not been applied");
  }
  const hub = new RealtimeHub();
  const app = Fastify({
    logger: {
      level: config.LOG_LEVEL,
      stream: serverLogStream,
      serializers: {
        req(request) {
          return { method: request.method, url: request.url.split("?")[0] ?? "", requestId: request.id };
        },
      },
    },
    requestIdHeader: false,
    genReqId: () => randomUUID(),
    bodyLimit: 5 * 1024 * 1024,
    trustProxy: config.TRUST_PROXY_CIDRS ? config.TRUST_PROXY_CIDRS.split(",").map(value => value.trim()).filter(Boolean) : false,
  });

  await app.register(cors, {
    origin: config.WEB_ORIGIN,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Authorization", "Content-Type", "Idempotency-Key", "X-Request-Id"],
    maxAge: 600,
  });
  app.addContentTypeParser(["application/octet-stream", "image/jpeg", "image/png", "image/webp"], { parseAs: "buffer", bodyLimit: 5 * 1024 * 1024 }, (_request, body, done) => done(null, body));
  await app.register(rateLimit, {
    max: config.NODE_ENV === "test" ? 1_000 : 120,
    timeWindow: "1 minute",
    errorResponseBuilder: (request) => ({ error: { code: "RATE_LIMITED", message: "Too many requests", request_id: request.id } }),
  });
  await app.register(websocket, { options: { maxPayload: 16 * 1024, perMessageDeflate: false } });

  app.get("/health/live", async () => ({ status: "ok" }));
  app.get("/health/ready", async (_request, reply) => {
    try {
      await db.execute(sql`select 1`);
      await db.execute(sql`select id from drizzle.__drizzle_migrations limit 0`);
      return { status: "ready" };
    } catch {
      reply.code(503);
      return { status: "not_ready" };
    }
  });

  registerAdminRoutes(app, pool, config, hub);
  await registerAgentAuthRoutes(app, db, config, hub);
  await registerAvatarRoutes(app, db, config);
  await registerResourceRoutes(app, db, config, hub);
  await registerPolicyNoticeRoutes(app, db, config);
  await registerMessageRoutes(app, db, config, hub);
  registerPondJuryRoutes(app, db, pool, config, hub);
  registerHonorRoutes(app, db, pool, config, hub);
  await registerInboxRoutes(app, db, config);
  await registerRealtimeRoutes(app, db, config, hub);

  app.setNotFoundHandler((request, reply) => {
    reply.code(404).send({ error: { code: "NOT_FOUND", message: "Route not found", request_id: request.id } });
  });
  app.addHook("onSend", async (request, reply, payload) => {
    reply.header("x-request-id", request.id);
    return payload;
  });
  app.setErrorHandler((error, request, reply) => {
    const normalized = error as Error & { validation?: unknown };
    if (normalized instanceof ApiError) {
      for (const [name, value] of Object.entries(normalized.headers)) reply.header(name, value);
      reply.code(normalized.statusCode).send({ error: { code: normalized.code, message: normalized.message, request_id: request.id } });
      return;
    }
    if (normalized.validation) {
      reply.code(400).send({ error: { code: "VALIDATION_ERROR", message: "Request validation failed", request_id: request.id } });
      return;
    }
    request.log.error({ requestId: request.id, errName: normalized.name }, "Unhandled request error");
    reply.code(500).send({ error: { code: "INTERNAL_ERROR", message: "Internal server error", request_id: request.id } });
  });

  app.addHook("onClose", async () => {
    hub.closeAll();
    await pool.end();
  });

  return { app, hub, pool };
}
