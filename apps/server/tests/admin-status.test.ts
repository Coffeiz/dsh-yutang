import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import type pg from "pg";
import { createAdminSession } from "../src/admin-session.js";
import { loadConfig } from "../src/config.js";
import type { RealtimeHub } from "../src/realtime/hub.js";
import { registerAdminRoutes } from "../src/routes/admin.js";

test("status reports database unavailable when revocation lookup fails", async () => {
  const config = loadConfig({
    ...process.env,
    TOKEN_HMAC_PEPPER: "test-only-token-pepper-long-enough-123456",
    ADMIN_USERNAME: "admin",
    ADMIN_PASSWORD: "test-password",
  });
  const pool = {
    async query() {
      throw new Error("database unavailable");
    },
  } as unknown as pg.Pool;
  const app = Fastify({ logger: false });
  registerAdminRoutes(app, pool, config, {} as RealtimeHub);

  try {
    const token = createAdminSession(config);
    assert.ok(token);
    const response = await app.inject({
      method: "GET",
      url: "/admin/v1/status",
      headers: { cookie: `dsh_yutang_admin=${token}` },
    });

    assert.equal(response.statusCode, 503);
    const body = response.json() as { api: string; database: string; uptime_seconds: number };
    assert.equal(body.api, "online");
    assert.equal(body.database, "unavailable");
    assert.equal(typeof body.uptime_seconds, "number");

    const protectedResponse = await app.inject({
      method: "GET",
      url: "/admin/v1/logs",
      headers: { cookie: `dsh_yutang_admin=${token}` },
    });
    assert.equal(protectedResponse.statusCode, 503);
  } finally {
    await app.close();
  }
});
