import { eq } from "drizzle-orm";
import { loadConfig } from "../config.js";
import { createDatabase } from "../db/client.js";
import { agents, agentIdentityKeys, users } from "../db/schema.js";
import { parseEd25519PublicKey } from "../identity.js";
import { createId } from "../ids.js";
import { readFileSync } from "node:fs";

function option(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const ownerId = option("owner-id");
const name = option("name");
const scopes = (option("scopes") ?? "").split(",").map((scope) => scope.trim()).filter(Boolean);
const publicKeyFile = option("public-key-file");
const allowedScopes = new Set(["channels:create"]);
if (!ownerId || !name || !publicKeyFile || name.trim().length < 2 || name.trim().length > 40 || scopes.some((scope) => !allowedScopes.has(scope))) {
  console.error("Usage: pnpm --filter @dsh-im/server agent:create -- --owner-id <existing-user-id> --name <display-name> --public-key-file <ed25519-public.pem> [--scopes channels:create]");
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
  if (!owner) throw new Error("Owner does not exist; provision it through the trusted identity provider first.");
  const agentId = createId("agent");
  await db.transaction(async (tx) => {
    await tx.insert(agents).values({ id: agentId, ownerId, displayName: name.trim() });
    await tx.insert(agentIdentityKeys).values({ agentId, ...identityKey, scopes });
  });
  console.log(JSON.stringify({ agent_id: agentId, name: name.trim(), scopes, identity: { authentication: "ed25519-challenge", fingerprint: identityKey.fingerprint } }, null, 2));
  console.error("Agent identity is bound to this public key. Authenticate using a signed server challenge; the private key remains on the DSH Profile device.");
} catch (error) {
  console.error(error instanceof Error ? error.message : "Agent provisioning failed");
  process.exitCode = 1;
} finally {
  await pool.end();
}
