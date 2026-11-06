import { and, desc, eq, isNull } from "drizzle-orm";
import { readFileSync } from "node:fs";
import { loadConfig } from "../config.js";
import { createDatabase } from "../db/client.js";
import { agentAuthChallenges, agentCredentials, agentIdentityKeys, agents, users } from "../db/schema.js";
import { parseEd25519PublicKey } from "../identity.js";

function option(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const ownerId = option("owner-id");
const agentId = option("agent-id");
const publicKeyFile = option("public-key-file");
const scopesArgument = option("scopes");
const allowedScopes = new Set(["channels:create"]);
const scopes = scopesArgument?.split(",").map((scope) => scope.trim()).filter(Boolean);
if (!ownerId || !agentId || !publicKeyFile || scopes?.some((scope) => !allowedScopes.has(scope))) {
  console.error("Usage: pnpm --filter @dsh-im/server agent:key:bind -- --owner-id <owner-id> --agent-id <agent-id> --public-key-file <ed25519-public.pem> [--scopes channels:create]");
  process.exit(2);
}

let identityKey: ReturnType<typeof parseEd25519PublicKey>;
try {
  identityKey = parseEd25519PublicKey(readFileSync(publicKeyFile, "utf8"));
} catch {
  console.error("Public key file must contain a valid Ed25519 SubjectPublicKeyInfo PEM key.");
  process.exit(2);
}

const config = loadConfig();
const { db, pool } = createDatabase(config);
try {
  const [owner] = await db.select({ id: users.id }).from(users).where(eq(users.id, ownerId)).limit(1);
  const [agent] = await db.select({ id: agents.id }).from(agents).where(and(eq(agents.id, agentId), eq(agents.ownerId, ownerId))).limit(1);
  if (!owner || !agent) throw new Error("Owner or Agent does not exist, or the Agent belongs to another owner.");
  const [existingKey] = await db.select({ agentId: agentIdentityKeys.agentId }).from(agentIdentityKeys).where(eq(agentIdentityKeys.fingerprint, identityKey.fingerprint)).limit(1);
  if (existingKey && existingKey.agentId !== agentId) throw new Error("This public key is already bound to another Agent.");

  await db.transaction(async (tx) => {
    const [latestCredential] = scopes === undefined
      ? await tx.select({ scopes: agentCredentials.scopes }).from(agentCredentials)
          .where(and(eq(agentCredentials.agentId, agentId), isNull(agentCredentials.revokedAt)))
          .orderBy(desc(agentCredentials.createdAt)).limit(1)
      : [];
    const keyScopes = scopes ?? latestCredential?.scopes ?? [];
    const now = new Date();
    await tx.insert(agentIdentityKeys).values({ agentId, ...identityKey, scopes: keyScopes })
      .onConflictDoUpdate({ target: agentIdentityKeys.agentId, set: { ...identityKey, scopes: keyScopes, rotatedAt: now } });
    await tx.update(agentCredentials).set({ revokedAt: now })
      .where(and(eq(agentCredentials.agentId, agentId), isNull(agentCredentials.revokedAt)));
    await tx.delete(agentAuthChallenges).where(eq(agentAuthChallenges.agentId, agentId));
  });
  console.log(JSON.stringify({ agent_id: agentId, fingerprint: identityKey.fingerprint, scopes: scopes ?? "preserved", authentication: "ed25519-challenge" }, null, 2));
  console.error("All existing Agent tokens were revoked. Authenticate this DSH Profile using a signed server challenge.");
} catch (error) {
  console.error(error instanceof Error ? error.message : "Agent key binding failed");
  process.exitCode = 1;
} finally {
  await pool.end();
}
