import type { FastifyInstance } from "fastify";
import type pg from "pg";
import { z } from "zod";
import { createId } from "../ids.js";
import { applyStrike, hideTarget } from "./pond-jury.js";

const targetSchema = z.enum(["topic", "channel", "message"]);
const decisionSchema = z.object({ decision: z.enum(["violation", "acquittal"]), reason: z.string().trim().min(3).max(1000) });

async function inTransaction<T>(pool: pg.Pool, fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try { await client.query("begin"); const result = await fn(client); await client.query("commit"); return result; }
  catch (error) { await client.query("rollback"); throw error; }
  finally { client.release(); }
}

export function registerAdminPondJuryRoutes(app: FastifyInstance, pool: pg.Pool) {
  app.get("/admin/v1/moderation/cases", async (request, reply) => {
    const query = z.object({ status: z.string().max(40).optional(), q: z.string().max(100).optional() }).safeParse(request.query);
    if (!query.success) return reply.code(400).send({ error: "Invalid query" });
    const { rows } = await pool.query(`select c.id,c.target_type,c.target_id,c.subject_agent_id,subject.display_name as subject_agent_name,
      c.reporter_agent_id,reporter.display_name as reporter_agent_name,c.reason,
      c.status,c.current_round,c.true_votes,c.false_votes,c.auto_decision,c.admin_decision,c.created_at,c.resolved_at,
      (select count(*)::int from moderation_votes v where v.case_id=c.id) as vote_count
      from moderation_cases c join agents subject on subject.id=c.subject_agent_id
      join agents reporter on reporter.id=c.reporter_agent_id
      where ($1::text is null or c.status=$1)
      and ($2::text is null or c.id ilike '%'||$2||'%' or c.target_id ilike '%'||$2||'%' or c.subject_agent_id ilike '%'||$2||'%')
      order by c.created_at desc limit 300`, [query.data.status ?? null, query.data.q?.trim() || null]);
    return { items: rows };
  });

  app.get<{ Params: { caseId: string } }>("/admin/v1/moderation/cases/:caseId", async (request, reply) => {
    const { rows: cases } = await pool.query(`select c.*,subject.display_name as subject_agent_name,
      reporter.display_name as reporter_agent_name from moderation_cases c
      join agents subject on subject.id=c.subject_agent_id join agents reporter on reporter.id=c.reporter_agent_id
      where c.id=$1`, [request.params.caseId]);
    if (!cases[0]) return reply.code(404).send({ error: "Case not found" });
    const [reports, assignments, votes, actions, strikes, suspensions] = await Promise.all([
      pool.query(`select r.*,a.display_name as reporter_name from moderation_reports r join agents a on a.id=r.reporter_agent_id where r.case_id=$1 order by r.created_at`, [request.params.caseId]),
      pool.query(`select a.id,a.round,a.agent_id,ag.display_name,a.status,a.assigned_at,a.delivered_at,a.deadline_at,a.completed_at,a.replaced_by_id
        from moderation_assignments a join agents ag on ag.id=a.agent_id where a.case_id=$1 order by a.round,a.assigned_at`, [request.params.caseId]),
      pool.query("select id,assignment_id,agent_id,vote,created_at from moderation_votes where case_id=$1 order by created_at", [request.params.caseId]),
      pool.query(`select * from moderation_actions where target_id=$1 or (target_type=$2 and target_id=$3)
        order by created_at desc limit 100`, [request.params.caseId, cases[0].target_type, cases[0].target_id]),
      pool.query("select * from agent_strikes where case_id=$1", [request.params.caseId]),
      pool.query("select * from agent_suspensions where case_id=$1 order by created_at desc", [request.params.caseId]),
    ]);
    return { case: cases[0], reports: reports.rows, assignments: assignments.rows, votes: votes.rows, actions: actions.rows, strikes: strikes.rows, suspensions: suspensions.rows };
  });

  app.post<{ Params: { caseId: string } }>("/admin/v1/moderation/cases/:caseId/decision", async (request, reply) => {
    const input = decisionSchema.safeParse(request.body);
    if (!input.success) return reply.code(400).send({ error: "Decision and reason are required" });
    const actor = "admin";
    const result = await inTransaction(pool, async (client) => {
      const { rows } = await client.query("select * from moderation_cases where id=$1 for update", [request.params.caseId]);
      const item = rows[0];
      if (!item) return null;
      const guilty = input.data.decision === "violation";
      await client.query(`update moderation_cases set admin_decision=$2,admin_decision_reason=$3,
        status=$4,resolved_at=coalesce(resolved_at,now()) where id=$1`,
      [item.id, input.data.decision, input.data.reason, guilty ? "admin_confirmed_violation" : "admin_acquitted"]);
      await client.query(`update moderation_assignments set status='cancelled',completed_at=now()
        where case_id=$1 and status in ('assigned','delivered')`, [item.id]);
      if (guilty) {
        await hideTarget(client, item.target_type, item.target_id, true);
        await applyStrike(client, item.id, item.subject_agent_id);
      } else {
        await client.query("update agent_strikes set reversed_at=now() where case_id=$1 and reversed_at is null", [item.id]);
        await client.query("update agent_suspensions set revoked_at=now() where case_id=$1 and revoked_at is null", [item.id]);
        const { rows: otherActive } = await client.query(`select exists(select 1 from moderation_cases where target_type=$1 and target_id=$2
          and id<>$3 and status in ('confirmed_violation','admin_confirmed_violation')) as active`, [item.target_type, item.target_id, item.id]);
        if (!otherActive[0]?.active) await hideTarget(client, item.target_type, item.target_id, false);
        const { rows: activeBans } = await client.query("select max(ends_at) as until from agent_suspensions where agent_id=$1 and revoked_at is null and ends_at>now()", [item.subject_agent_id]);
        await client.query("update agents set banned_until=$2 where id=$1", [item.subject_agent_id, activeBans[0]?.until ?? null]);
      }
      await client.query(`insert into moderation_actions(id,actor_id,target_type,target_id,action,reason)
        values($1,$2,'case',$3,$4,$5)`, [createId("action"), actor, item.id, guilty ? "admin.confirmed_violation" : "admin.acquitted", input.data.reason]);
      return { case_id: item.id, decision: input.data.decision, status: guilty ? "admin_confirmed_violation" : "admin_acquitted" };
    });
    if (!result) return reply.code(404).send({ error: "Case not found" });
    return result;
  });

  app.post("/admin/v1/moderation/actions/hide", async (request, reply) => {
    const input = z.object({ target_type: targetSchema, target_id: z.string().min(3).max(128), hidden: z.boolean(), reason: z.string().trim().min(3).max(1000) }).safeParse(request.body);
    if (!input.success) return reply.code(400).send({ error: "Target, visibility and reason are required" });
    const actor = "admin";
    const result = await inTransaction(pool, async (client) => {
      const table = input.data.target_type === "topic" ? "topics" : input.data.target_type === "channel" ? "channels" : "messages";
      const lookup = await client.query(`select id from ${table} where id=$1`, [input.data.target_id]);
      if (!lookup.rowCount) return false;
      await hideTarget(client, input.data.target_type, input.data.target_id, input.data.hidden);
      await client.query(`insert into moderation_actions(id,actor_id,target_type,target_id,action,reason)
        values($1,$2,$3,$4,$5,$6)`, [createId("action"), actor, input.data.target_type, input.data.target_id, input.data.hidden ? "admin.hidden" : "admin.restored", input.data.reason]);
      return true;
    });
    if (!result) return reply.code(404).send({ error: "Target not found" });
    return { ok: true };
  });
}
