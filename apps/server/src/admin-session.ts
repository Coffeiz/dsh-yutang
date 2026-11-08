import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type pg from "pg";
import type { Config } from "./config.js";

export const adminSessionMaxAge = 8 * 60 * 60;

type AdminSession = { expiresAt: number; nonce: string };

function adminSessionKey(config: Config): Buffer | null {
  if (!config.ADMIN_USERNAME || !config.ADMIN_PASSWORD) return null;
  return createHash("sha256")
    .update("dsh-yutang-admin-session:v1\0")
    .update(config.ADMIN_USERNAME)
    .update("\0")
    .update(config.ADMIN_PASSWORD)
    .digest();
}

function parseAdminSession(token: string, config: Config): AdminSession | null {
  const [expiresAtText, nonce, signature, ...extra] = token.split(".");
  const expiresAt = Number(expiresAtText);
  if (extra.length || !Number.isSafeInteger(expiresAt) || expiresAt <= Math.floor(Date.now() / 1000)
    || !nonce || !/^[A-Za-z0-9_-]{32}$/.test(nonce)
    || !signature || !/^[A-Za-z0-9_-]{43}$/.test(signature)) return null;
  const key = adminSessionKey(config);
  if (!key) return null;
  const payload = `${expiresAtText}.${nonce}`;
  const expected = createHmac("sha256", key).update(payload).digest();
  const actual = Buffer.from(signature, "base64url");
  return actual.length === expected.length && timingSafeEqual(actual, expected) ? { expiresAt, nonce } : null;
}

export function createAdminSession(config: Config): string | null {
  const key = adminSessionKey(config);
  if (!key) return null;
  const expiresAt = Math.floor(Date.now() / 1000) + adminSessionMaxAge;
  const payload = `${expiresAt}.${randomBytes(24).toString("base64url")}`;
  const signature = createHmac("sha256", key).update(payload).digest("base64url");
  return `${payload}.${signature}`;
}

export async function validAdminSession(token: string, config: Config, pool: pg.Pool): Promise<boolean> {
  const session = parseAdminSession(token, config);
  if (!session) return false;
  const { rows } = await pool.query("select 1 from admin_session_revocations where nonce=$1 limit 1", [session.nonce]);
  return rows.length === 0;
}

export async function revokeAdminSession(token: string, config: Config, pool: pg.Pool): Promise<void> {
  const session = parseAdminSession(token, config);
  if (!session) return;
  await pool.query("delete from admin_session_revocations where expires_at<=now()");
  await pool.query(`insert into admin_session_revocations(nonce,expires_at)
    values($1,to_timestamp($2)) on conflict(nonce) do nothing`, [session.nonce, session.expiresAt]);
}
