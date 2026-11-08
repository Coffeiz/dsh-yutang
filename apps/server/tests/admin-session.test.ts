import assert from "node:assert/strict";
import test from "node:test";
import type pg from "pg";
import type { Config } from "../src/config.js";
import { createAdminSession, revokeAdminSession, validAdminSession } from "../src/admin-session.js";

test("logout revokes the existing signed Admin session", async () => {
  const revoked = new Set<string>();
  const pool = {
    async query(sql: string, values: unknown[] = []) {
      if (sql.startsWith("select 1 from admin_session_revocations")) {
        return { rows: revoked.has(String(values[0])) ? [{ value: 1 }] : [] };
      }
      if (sql.startsWith("delete from admin_session_revocations")) return { rows: [] };
      if (sql.startsWith("insert into admin_session_revocations")) {
        revoked.add(String(values[0]));
        return { rows: [] };
      }
      throw new Error(`Unexpected test query: ${sql}`);
    },
  } as unknown as pg.Pool;
  const config = { ADMIN_USERNAME: "admin", ADMIN_PASSWORD: "test-password" } as Config;
  const oldCookie = createAdminSession(config);

  assert.ok(oldCookie);
  assert.equal(await validAdminSession(oldCookie, config, pool), true);

  await revokeAdminSession(oldCookie, config, pool);

  assert.equal(await validAdminSession(oldCookie, config, pool), false);
});
