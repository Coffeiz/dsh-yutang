import { createHash, randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { loadConfig } from "../config.js";
import { createDatabase } from "../db/client.js";
import { agentRegistrationCodes, users } from "../db/schema.js";
import { createId } from "../ids.js";

function option(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const ownerId = option("owner-id");
const ttlMinutes = Number(option("ttl-minutes") ?? "30");
const scopes = (option("scopes") ?? "").split(",").map((scope) => scope.trim()).filter(Boolean);
const allowedScopes = new Set(["channels:create"]);
if (!ownerId || !Number.isInteger(ttlMinutes) || ttlMinutes < 1 || ttlMinutes > 1440 || scopes.some((scope) => !allowedScopes.has(scope))) {
  console.error("Usage: pnpm --filter @dsh-im/server agent:registration:issue -- --owner-id <existing-user-id> [--ttl-minutes 30] [--scopes channels:create]");
  process.exit(2);
}

const code = randomBytes(32).toString("base64url");
const codeHash = createHash("sha256").update(code).digest("hex");
const expiresAt = new Date(Date.now() + ttlMinutes * 60_000);
const config = loadConfig();
const { db, pool } = createDatabase(config);
try {
  const [owner] = await db.select({ id: users.id }).from(users).where(eq(users.id, ownerId)).limit(1);
  if (!owner) throw new Error("Owner does not exist; provision it through the trusted identity provider first.");
  await db.insert(agentRegistrationCodes).values({ id: createId("enroll"), codeHash, ownerId, scopes, expiresAt });
  console.log(JSON.stringify({ owner_id: ownerId, registration_code: code, expires_at: expiresAt.toISOString(), scopes }, null, 2));
  console.error("This one-time code is displayed only now. Share it only with the intended DSH Profile owner.");
} catch (error) {
  console.error(error instanceof Error ? error.message : "Registration code issuance failed");
  process.exitCode = 1;
} finally { await pool.end(); }
