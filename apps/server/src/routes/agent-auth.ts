import { createHash, randomBytes } from "node:crypto";
import { and, desc, eq, gt, isNull, lt, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Config } from "../config.js";
import type { Database } from "../db/client.js";
import { agentAuthChallenges, agentCredentials, agentIdentityKeys, agentRegistrationCodes, agentChannelCursors, agentSuspensions, agents, channelMembers, messageMentions, realtimeTickets, users } from "../db/schema.js";
import { ApiError } from "../errors.js";
import { agentTag, createId } from "../ids.js";
import { assertAgentNotBanned, createBearerToken, hashSecret } from "../auth.js";
import { parse, success } from "../http.js";
import { parseEd25519PublicKey, verifyEd25519Signature } from "../identity.js";

const challengeBody = z.object({ agent_id: z.string().min(3).max(100) });
const verifyBody = z.object({
  agent_id: z.string().min(3).max(100),
  challenge_id: z.string().min(8).max(100),
  signature: z.string().regex(/^[A-Za-z0-9_-]{86}$/),
});
const challengeTtlMs = 60_000;
const accessTokenTtlMs = 15 * 60_000;
const registerBody = z.object({
  display_name: z.string().trim().min(2).max(40).default("DSH Agent"),
  public_key: z.string().min(80).max(512),
});
const legacyRegisterBody = z.object({
  owner_id: z.string().min(3).max(100),
  registration_code: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  display_name: z.string().trim().min(2).max(40),
  public_key: z.string().min(80).max(512),
});
const unregisterBody = z.object({ signature: z.string().regex(/^[A-Za-z0-9_-]{86}$/) });

const unregisterChallenge = (agentId: string) => `dsh-yutang-agent-unregister:v1\n${agentId}`;

export async function registerAgentAuthRoutes(app: FastifyInstance, db: Database, config: Config, hub: import("../realtime/hub.js").RealtimeHub) {
  // Integration tests create a small jury of synthetic Agents in one process;
  // keep the production abuse limit while allowing that isolated fixture.
  const registrationLimit = config.NODE_ENV === "test" ? 100 : 5;
  const authenticationLimit = config.NODE_ENV === "test" ? 100 : 10;
  app.post("/v1/agents/register", { config: { rateLimit: { max: registrationLimit, timeWindow: "1 hour" } } }, async (request, reply) => {
    const body = parse(registerBody, request.body);
    let identityKey: ReturnType<typeof parseEd25519PublicKey>;
    try { identityKey = parseEd25519PublicKey(body.public_key); }
    catch { throw new ApiError(400, "INVALID_AGENT_PUBLIC_KEY", "Agent public key must be a valid Ed25519 SubjectPublicKeyInfo PEM key"); }
    const result = await db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${identityKey.fingerprint}, 0))`);
      const [existing] = await tx.select({ agentId: agents.id, ownerId: agents.ownerId, name: agents.displayName, discriminator: agents.discriminator, scopes: agentIdentityKeys.scopes, status: agents.status })
        .from(agents).innerJoin(agentIdentityKeys, eq(agentIdentityKeys.agentId, agents.id))
        .where(eq(agentIdentityKeys.fingerprint, identityKey.fingerprint)).limit(1);
      if (existing) {
        if (existing.status !== "active") throw new ApiError(409, "AGENT_IDENTITY_UNAVAILABLE", "This DSH identity has been unregistered; add the Server again to create a new identity");
        return { agent_id: existing.agentId, owner_id: existing.ownerId, name: existing.name, tag: agentTag(existing.discriminator), scopes: existing.scopes, replayed: true };
      }
      const ownerId = createId("user");
      const agentId = createId("agent");
      await tx.insert(users).values({ id: ownerId, authProviderId: `dsh-agent:${identityKey.fingerprint}` });
      const [agent] = await tx.insert(agents).values({ id: agentId, ownerId, displayName: body.display_name }).returning({ discriminator: agents.discriminator });
      await tx.insert(agentIdentityKeys).values({ agentId, ...identityKey, scopes: [] });
      return { agent_id: agentId, owner_id: ownerId, name: body.display_name, tag: agentTag(agent!.discriminator), scopes: [], replayed: false };
    });
    reply.code(result.replayed ? 200 : 201);
    const { replayed: _replayed, ...registration } = result;
    return success(registration);
  });

  app.post("/v1/agents/register/with-code", { config: { rateLimit: { max: registrationLimit, timeWindow: "1 hour" } } }, async (request, reply) => {
    const body = parse(legacyRegisterBody, request.body);
    let identityKey: ReturnType<typeof parseEd25519PublicKey>;
    try { identityKey = parseEd25519PublicKey(body.public_key); }
    catch { throw new ApiError(400, "INVALID_AGENT_PUBLIC_KEY", "Agent public key must be a valid Ed25519 SubjectPublicKeyInfo PEM key"); }
    const codeHash = createHash("sha256").update(body.registration_code).digest("hex");
    const agentId = createId("agent");
    const result = await db.transaction(async (tx) => {
      const [code] = await tx.select().from(agentRegistrationCodes).where(eq(agentRegistrationCodes.codeHash, codeHash)).for("update").limit(1);
      const now = new Date();
      if (!code || code.ownerId !== body.owner_id || code.consumedAt || code.expiresAt <= now) {
        throw new ApiError(401, "INVALID_AGENT_REGISTRATION_CODE", "Registration code is invalid, expired, or already used");
      }
      const [owner] = await tx.select({ id: users.id }).from(users).where(eq(users.id, body.owner_id)).limit(1);
      if (!owner) throw new ApiError(404, "AGENT_OWNER_NOT_FOUND", "Owner account is unavailable");
      const [agent] = await tx.insert(agents).values({ id: agentId, ownerId: owner.id, displayName: body.display_name }).returning({ discriminator: agents.discriminator });
      await tx.insert(agentIdentityKeys).values({ agentId, ...identityKey, scopes: code.scopes });
      await tx.update(agentRegistrationCodes).set({ consumedAt: now, consumedAgentId: agentId }).where(eq(agentRegistrationCodes.id, code.id));
      return { agent_id: agentId, owner_id: body.owner_id, name: body.display_name, tag: agentTag(agent!.discriminator), scopes: code.scopes };
    });
    reply.code(201);
    return success(result);
  });

  app.delete<{ Params: { agentId: string } }>("/v1/agents/:agentId/registration", { config: { rateLimit: { max: 10, timeWindow: "1 hour" } } }, async (request) => {
    const agentId = z.string().min(3).max(100).parse(request.params.agentId);
    const body = parse(unregisterBody, request.body);
    const result = await db.transaction(async (tx) => {
      const [record] = await tx.select({ agent: agents, key: agentIdentityKeys })
        .from(agents).innerJoin(agentIdentityKeys, eq(agentIdentityKeys.agentId, agents.id))
        .where(eq(agents.id, agentId)).for("update").limit(1);
      if (!record || !verifyEd25519Signature(record.key.publicKey, unregisterChallenge(agentId), body.signature)) {
        throw new ApiError(401, "INVALID_AGENT_SIGNATURE", "Agent identity signature is invalid");
      }
      if (record.agent.status === "deleted") return { avatarPath: null as string | null, alreadyUnregistered: true };
      const now = new Date();
      await tx.update(agents).set({ status: "deleted", displayName: "已注销 Agent", avatarPath: null, bannedUntil: null }).where(eq(agents.id, agentId));
      await tx.update(agentIdentityKeys).set({ scopes: [] }).where(eq(agentIdentityKeys.agentId, agentId));
      await tx.update(agentCredentials).set({ revokedAt: now }).where(and(eq(agentCredentials.agentId, agentId), isNull(agentCredentials.revokedAt)));
      await tx.delete(agentAuthChallenges).where(eq(agentAuthChallenges.agentId, agentId));
      await tx.delete(realtimeTickets).where(eq(realtimeTickets.agentId, agentId));
      await tx.delete(channelMembers).where(eq(channelMembers.agentId, agentId));
      await tx.delete(agentChannelCursors).where(eq(agentChannelCursors.agentId, agentId));
      await tx.delete(messageMentions).where(eq(messageMentions.targetAgentId, agentId));
      return { avatarPath: record.agent.avatarPath, alreadyUnregistered: false };
    });
    hub.closeAgent(agentId);
    if (result.avatarPath) {
      const { unlink } = await import("node:fs/promises");
      const { resolve } = await import("node:path");
      await unlink(resolve(config.AVATAR_DIR, result.avatarPath)).catch(() => {});
    }
    return success({ agent_id: agentId, unregistered: true, history_anonymized: true, already_unregistered: result.alreadyUnregistered });
  });

  app.post("/v1/agent/auth/challenge", { config: { rateLimit: { max: authenticationLimit, timeWindow: "1 minute" } } }, async (request) => {
    const body = parse(challengeBody, request.body);
    const [record] = await db.select({ key: agentIdentityKeys, status: agents.status, bannedUntil: agents.bannedUntil })
      .from(agentIdentityKeys).innerJoin(agents, eq(agents.id, agentIdentityKeys.agentId))
      .where(eq(agentIdentityKeys.agentId, body.agent_id)).limit(1);
    if (!record) throw new ApiError(404, "AGENT_AUTH_UNAVAILABLE", "Agent identity is unavailable");
    if (record.status === "banned") assertAgentNotBanned(null, undefined, record.status);
    if (record.status !== "active") throw new ApiError(404, "AGENT_AUTH_UNAVAILABLE", "Agent identity is unavailable");

    const now = new Date();
    if (record.bannedUntil && record.bannedUntil > now) {
      const [suspension] = await db.select({ kind: agentSuspensions.kind, endsAt: agentSuspensions.endsAt })
        .from(agentSuspensions).where(and(eq(agentSuspensions.agentId, body.agent_id), isNull(agentSuspensions.revokedAt), gt(agentSuspensions.endsAt, now)))
        .orderBy(desc(agentSuspensions.endsAt)).limit(1);
      assertAgentNotBanned(record.bannedUntil, suspension);
    }

    await db.delete(agentAuthChallenges).where(lt(agentAuthChallenges.expiresAt, now));
    const challengeId = createId("challenge");
    const expiresAt = new Date(now.getTime() + challengeTtlMs);
    const nonce = randomBytes(32).toString("base64url");
    const challenge = ["dsh-yutang-agent-auth:v1", body.agent_id, challengeId, nonce, expiresAt.toISOString()].join("\n");
    await db.insert(agentAuthChallenges).values({ id: challengeId, agentId: body.agent_id, challenge, expiresAt });
    return success({ challenge_id: challengeId, challenge, expires_at: expiresAt.toISOString() });
  });

  app.post("/v1/agent/auth/verify", { config: { rateLimit: { max: authenticationLimit, timeWindow: "1 minute" } } }, async (request) => {
    const body = parse(verifyBody, request.body);
    const token = createBearerToken();
    const expiresAt = new Date(Date.now() + accessTokenTtlMs);
    const credentialId = createId("cred");
    const scopes = await db.transaction(async (tx) => {
      const [record] = await tx.select({ challenge: agentAuthChallenges, key: agentIdentityKeys, status: agents.status, bannedUntil: agents.bannedUntil })
        .from(agentAuthChallenges)
        .innerJoin(agentIdentityKeys, eq(agentIdentityKeys.agentId, agentAuthChallenges.agentId))
        .innerJoin(agents, eq(agents.id, agentAuthChallenges.agentId))
        .where(and(eq(agentAuthChallenges.id, body.challenge_id), eq(agentAuthChallenges.agentId, body.agent_id)))
        .for("update").limit(1);
      const now = new Date();
      if (!record) {
        throw new ApiError(401, "INVALID_AGENT_CHALLENGE", "Challenge is invalid, expired, or already used");
      }
      if (record.status === "banned") assertAgentNotBanned(null, undefined, record.status);
      if (record.status !== "active" || record.challenge.consumedAt || record.challenge.expiresAt <= now) {
        throw new ApiError(401, "INVALID_AGENT_CHALLENGE", "Challenge is invalid, expired, or already used");
      }
      if (record.bannedUntil && record.bannedUntil > now) {
        const [suspension] = await tx.select({ kind: agentSuspensions.kind, endsAt: agentSuspensions.endsAt })
          .from(agentSuspensions).where(and(eq(agentSuspensions.agentId, body.agent_id), isNull(agentSuspensions.revokedAt), gt(agentSuspensions.endsAt, now)))
          .orderBy(desc(agentSuspensions.endsAt)).limit(1);
        assertAgentNotBanned(record.bannedUntil, suspension);
      }
      if (!verifyEd25519Signature(record.key.publicKey, record.challenge.challenge, body.signature)) {
        throw new ApiError(401, "INVALID_AGENT_SIGNATURE", "Agent identity signature is invalid");
      }
      await tx.update(agentAuthChallenges).set({ consumedAt: now }).where(eq(agentAuthChallenges.id, record.challenge.id));
      await tx.delete(agentCredentials).where(lt(agentCredentials.expiresAt, now));
      await tx.insert(agentCredentials).values({
        id: credentialId,
        agentId: body.agent_id,
        tokenHash: hashSecret(token, config.TOKEN_HMAC_PEPPER),
        scopes: record.key.scopes,
        expiresAt,
      });
      return record.key.scopes;
    });
    return success({
      access_token: token,
      token_type: "Bearer",
      expires_in: accessTokenTtlMs / 1000,
      expires_at: expiresAt.toISOString(),
      agent: { id: body.agent_id, scopes },
    });
  });
}
