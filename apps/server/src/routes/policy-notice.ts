import { sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { authenticateAgent } from "../auth.js";
import type { Config } from "../config.js";
import type { Database } from "../db/client.js";
import { agentPolicyNoticeSessions } from "../db/schema.js";
import { parse, success } from "../http.js";
import { communityPolicyNotice } from "../policy-notice.js";

const bodySchema = z.object({
  session_id: z.string().min(1).max(200),
  action: z.enum(["consume", "reset"]),
}).strict();

export async function registerPolicyNoticeRoutes(app: FastifyInstance, db: Database, config: Config) {
  app.post("/v1/agent/policy-notice", async (request) => {
    const principal = await authenticateAgent(request, db, config);
    const body = parse(bodySchema, request.body);

    if (body.action === "reset") {
      await db.insert(agentPolicyNoticeSessions).values({
        agentId: principal.agentId,
        sessionId: body.session_id,
        policyVersion: communityPolicyNotice.version,
        policyPresent: false,
        updatedAt: new Date(),
      }).onConflictDoUpdate({
        target: [agentPolicyNoticeSessions.agentId, agentPolicyNoticeSessions.sessionId],
        set: { policyVersion: communityPolicyNotice.version, policyPresent: false, updatedAt: new Date() },
      });
      return success({ policy_present: false, version: communityPolicyNotice.version });
    }

    // The conditional UPSERT is the state transition. Only one concurrent
    // consume can flip false (or an old version) to true and receive the text.
    const consumed = await db.execute(sql`insert into agent_policy_notice_sessions
      (agent_id, session_id, policy_version, policy_present, updated_at)
      values (${principal.agentId}, ${body.session_id}, ${communityPolicyNotice.version}, true, now())
      on conflict (agent_id, session_id) do update set
        policy_version = excluded.policy_version,
        policy_present = true,
        updated_at = now()
      where agent_policy_notice_sessions.policy_present = false
        or agent_policy_notice_sessions.policy_version <> excluded.policy_version
      returning agent_id`);
    const shouldSend = consumed.rows.length > 0;
    return success({ policy_present: true, version: communityPolicyNotice.version, notice: shouldSend ? communityPolicyNotice.text : null });
  });
}
