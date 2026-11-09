import { createHmac, randomBytes } from "node:crypto";
import type { FastifyRequest } from "fastify";
import { and, desc, eq, gt, isNull } from "drizzle-orm";
import type { Config } from "./config.js";
import type { Database } from "./db/client.js";
import { agentCredentials, agents, agentSuspensions } from "./db/schema.js";
import { ApiError } from "./errors.js";

export type AgentPrincipal = {
  kind: "agent";
  agentId: string;
  credentialId: string;
  scopes: string[];
};

export function hashSecret(secret: string, pepper: string): string {
  return createHmac("sha256", pepper).update(secret).digest("hex");
}

export function createBearerToken(): string {
  return `dsh_yut_${randomBytes(32).toString("base64url")}`;
}

export function assertAgentNotBanned(
  bannedUntil: Date | null,
  suspension?: { kind: string; endsAt: Date },
  status?: string,
): void {
  const now = new Date();
  if (status === "banned") {
    throw new ApiError(403, "AGENT_BANNED", "This Agent is banned", { "x-ban-kind": "admin" });
  }
  if (!bannedUntil || bannedUntil <= now) return;
  const until = suspension?.endsAt ?? bannedUntil;
  throw new ApiError(403, "AGENT_BANNED", "This Agent is temporarily banned", {
    "x-ban-kind": suspension?.kind ?? "unknown",
    "x-banned-until": until.toISOString(),
    "retry-after": String(Math.max(0, Math.ceil((until.getTime() - now.getTime()) / 1000))),
  });
}

export async function authenticateAgent(
  request: FastifyRequest,
  db: Database,
  config: Config,
  requireUnbanned = false,
): Promise<AgentPrincipal> {
  const header = request.headers.authorization;
  const token = header?.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (!token.startsWith("dsh_yut_") || token.length < 32) {
    const diagnosticCode = header ? "AGENT_TOKEN_FORMAT_INVALID" : "AGENT_TOKEN_MISSING";
    throw new ApiError(401, "UNAUTHENTICATED", "A valid Agent token is required", {}, diagnosticCode);
  }

  const tokenHash = hashSecret(token, config.TOKEN_HMAC_PEPPER);
  const [record] = await db
    .select({ credential: agentCredentials, agentStatus: agents.status, bannedUntil: agents.bannedUntil })
    .from(agentCredentials)
    .innerJoin(agents, eq(agents.id, agentCredentials.agentId))
    .where(eq(agentCredentials.tokenHash, tokenHash))
    .limit(1);

  if (!record) {
    throw new ApiError(401, "UNAUTHENTICATED", "A valid Agent token is required", {}, "AGENT_TOKEN_NOT_FOUND");
  }
  if (record.agentStatus === "banned") assertAgentNotBanned(null, undefined, record.agentStatus);
  if (record.agentStatus !== "active") throw new ApiError(401, "UNAUTHENTICATED", "A valid Agent token is required", {}, "AGENT_INACTIVE");
  if (record.credential.revokedAt) throw new ApiError(401, "UNAUTHENTICATED", "A valid Agent token is required", {}, "AGENT_CREDENTIAL_REVOKED");
  if (record.credential.expiresAt && record.credential.expiresAt <= new Date()) {
    throw new ApiError(401, "UNAUTHENTICATED", "A valid Agent token is required", {}, "AGENT_CREDENTIAL_EXPIRED");
  }
  if (requireUnbanned && record.bannedUntil && record.bannedUntil > new Date()) {
    const now = new Date();
    const [suspension] = await db.select({ kind: agentSuspensions.kind, endsAt: agentSuspensions.endsAt })
      .from(agentSuspensions).where(and(eq(agentSuspensions.agentId, record.credential.agentId), isNull(agentSuspensions.revokedAt), gt(agentSuspensions.endsAt, now)))
      .orderBy(desc(agentSuspensions.endsAt)).limit(1);
    assertAgentNotBanned(record.bannedUntil, suspension);
  }
  const principal: AgentPrincipal = {
    kind: "agent",
    agentId: record.credential.agentId,
    credentialId: record.credential.id,
    scopes: record.credential.scopes,
  };
  return principal;
}
