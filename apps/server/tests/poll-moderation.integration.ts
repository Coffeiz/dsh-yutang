import assert from "node:assert/strict";
import test from "node:test";
import pg from "pg";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { createDatabase } from "../src/db/client.js";
import { createBearerToken, hashSecret } from "../src/auth.js";
import { createId } from "../src/ids.js";
import { hideTarget } from "../src/routes/pond-jury.js";
import { closeExpired } from "../src/routes/polls.js";
import type { RealtimeHub } from "../src/realtime/hub.js";

const testDbConfigured = Boolean(process.env.YUTANG_TEST_DB_HOST
  && process.env.YUTANG_TEST_DB_PORT && process.env.YUTANG_TEST_DB_USER && process.env.YUTANG_TEST_DB_NAME);

test("poll reports persist frozen evidence and voting rechecks public channel visibility", { skip: !testDbConfigured }, async () => {
  const pepper = "test-only-poll-moderation-pepper-32-chars";
  const config = loadConfig({
    ...process.env,
    NODE_ENV: "test",
    DB_HOST: process.env.YUTANG_TEST_DB_HOST,
    DB_PORT: process.env.YUTANG_TEST_DB_PORT,
    DB_USER: process.env.YUTANG_TEST_DB_USER,
    DB_PASSWORD: process.env.YUTANG_TEST_DB_PASSWORD ?? "",
    DB_NAME: process.env.YUTANG_TEST_DB_NAME,
    DB_SSL_MODE: "disable",
    TOKEN_HMAC_PEPPER: pepper,
  });
  const seedPool = new pg.Pool({
    host: config.DB_HOST, port: config.DB_PORT, user: config.DB_USER,
    password: config.DB_PASSWORD || undefined, database: config.DB_NAME,
  });
  const userIds = [createId("user"), createId("user")];
  const agentIds = [createId("agent"), createId("agent")];
  const topicId = createId("topic");
  const channelId = createId("channel");
  const pollId = createId("poll");
  const expiredPollId = createId("poll");
  const legacyClosedPollId = createId("poll");
  const expiredOpenPollId = createId("poll");
  const optionIds = [createId("popt"), createId("popt")];
  const token = createBearerToken();
  const credentialId = createId("cred");
  const { app } = await buildApp(config);
  try {
    await seedPool.query("insert into users(id,auth_provider_id) values($1,$2),($3,$4)", [userIds[0], `test:${userIds[0]}`, userIds[1], `test:${userIds[1]}`]);
    await seedPool.query(`insert into agents(id,owner_id,display_name,created_at) values
      ($1,$2,'Poll creator',now()-interval '2 days'),($3,$4,'Poll reporter',now()-interval '2 days')`, [agentIds[0], userIds[0], agentIds[1], userIds[1]]);
    await seedPool.query("insert into agent_credentials(id,agent_id,token_hash,scopes) values($1,$2,$3,'[]'::jsonb)", [credentialId, agentIds[1], hashSecret(token, pepper)]);
    await seedPool.query("insert into topics(id,name,created_by_agent_id) values($1,'Integration poll topic',$2)", [topicId, agentIds[0]]);
    await seedPool.query(`insert into channels(id,topic_id,name,visibility,status,manual_hidden,created_by_agent_id,is_default)
      values($1,$2,'Poll channel','public','active',false,$3,false)`, [channelId, topicId, agentIds[0]]);
    await seedPool.query("insert into channel_members(channel_id,agent_id) values($1,$2),($1,$3)", [channelId, agentIds[0], agentIds[1]]);
    await seedPool.query(`insert into channel_polls(id,channel_id,created_by_agent_id,idempotency_key,request_hash,title,duration,ends_at)
      values($1,$2,$3,$4,'fixture-hash','A reportable poll','24h',now()+interval '1 day')`, [pollId, channelId, agentIds[0], createId("idem")]);
    await seedPool.query("insert into channel_poll_options(id,poll_id,text,position) values($1,$3,'Option A',0),($2,$3,'Option B',1)", [optionIds[0], optionIds[1], pollId]);

    const reportResponse = await app.inject({
      method: "POST",
      url: "/v1/agent/moderation/reports",
      headers: { authorization: `Bearer ${token}` },
      payload: { target_type: "poll", target_id: pollId, reason: "Integration report for a poll" },
    });
    assert.equal(reportResponse.statusCode, 201, reportResponse.body);
    const report = reportResponse.json() as { data: { case_id: string } };
    const { rows: caseRows } = await seedPool.query<{ target_type: string; evidence: Record<string, unknown> }>(
      "select target_type,evidence from moderation_cases where id=$1", [report.data.case_id],
    );
    assert.equal(caseRows[0]?.target_type, "poll");
    assert.equal(caseRows[0]?.evidence.title, "A reportable poll");
    assert.equal((caseRows[0]?.evidence.options as unknown[]).length, 2);

    await seedPool.query("update topics set visibility='private' where id=$1", [topicId]);
    const privateVote = await app.inject({
      method: "PUT", url: `/v1/agent/polls/${pollId}/vote`,
      headers: { authorization: `Bearer ${token}` }, payload: { option_id: optionIds[0] },
    });
    assert.equal(privateVote.statusCode, 403, privateVote.body);
    await seedPool.query("update topics set visibility='public' where id=$1", [topicId]);
    await seedPool.query("update channels set visibility='private' where id=$1", [channelId]);
    const privateChannelVote = await app.inject({
      method: "PUT", url: `/v1/agent/polls/${pollId}/vote`,
      headers: { authorization: `Bearer ${token}` }, payload: { option_id: optionIds[0] },
    });
    assert.equal(privateChannelVote.statusCode, 403, privateChannelVote.body);
    await seedPool.query("update channels set visibility='public' where id=$1", [channelId]);
    const publicVote = await app.inject({
      method: "PUT", url: `/v1/agent/polls/${pollId}/vote`,
      headers: { authorization: `Bearer ${token}` }, payload: { option_id: optionIds[0] },
    });
    assert.equal(publicVote.statusCode, 200, publicVote.body);

    await seedPool.query(`insert into channel_polls(id,channel_id,created_by_agent_id,idempotency_key,request_hash,title,duration,status,manual_hidden,ends_at)
      values($1,$2,$3,$4,'fixture-expired-hash','Expired hidden poll','24h','hidden',true,now()-interval '1 minute')`, [expiredPollId, channelId, agentIds[0], createId("idem")]);
    await seedPool.query(`insert into channel_polls(id,channel_id,created_by_agent_id,idempotency_key,request_hash,title,duration,status,ends_at)
      values($1,$2,$3,$4,'fixture-legacy-closed-hash','Legacy closed poll','24h','closed',now()-interval '2 minutes')`, [legacyClosedPollId, channelId, agentIds[0], createId("idem")]);
    await seedPool.query(`insert into channel_polls(id,channel_id,created_by_agent_id,idempotency_key,request_hash,title,duration,status,ends_at)
      values($1,$2,$3,$4,'fixture-expired-open-hash','Expired open poll','24h','open',now()-interval '3 minutes')`, [expiredOpenPollId, channelId, agentIds[0], createId("idem")]);
    const publishedEvents: unknown[][] = [];
    const testHub = { publishChannel(...args: unknown[]) { publishedEvents.push(args); } } as unknown as RealtimeHub;
    await closeExpired(seedPool, testHub);
    const { rows: expiredRows } = await seedPool.query<{ status: string; closed_at: Date | null; closed_reason: string | null }>(
      "select status,closed_at,closed_reason from channel_polls where id=$1", [expiredPollId],
    );
    assert.equal(expiredRows[0]?.status, "hidden");
    assert.ok(expiredRows[0]?.closed_at);
    assert.equal(expiredRows[0]?.closed_reason, "expired");
    const { rows: legacyRows } = await seedPool.query<{ status: string; closed_at: Date | null; closed_reason: string | null }>(
      "select status,closed_at,closed_reason from channel_polls where id=$1", [legacyClosedPollId],
    );
    assert.equal(legacyRows[0]?.status, "closed");
    assert.ok(legacyRows[0]?.closed_at);
    assert.equal(legacyRows[0]?.closed_reason, "expired");
    const { rows: openRows } = await seedPool.query<{ status: string; closed_at: Date | null; closed_reason: string | null }>(
      "select status,closed_at,closed_reason from channel_polls where id=$1", [expiredOpenPollId],
    );
    assert.equal(openRows[0]?.status, "closed");
    assert.ok(openRows[0]?.closed_at);
    assert.equal(openRows[0]?.closed_reason, "expired");
    assert.equal(publishedEvents.length, 1);

    const client = await seedPool.connect();
    try {
      await client.query("begin");
      await hideTarget(client, "poll", expiredPollId, false, "manual");
      await client.query("commit");
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
    const { rows: restoredRows } = await seedPool.query<{ status: string; closed_at: Date | null; closed_reason: string | null }>(
      "select status,closed_at,closed_reason from channel_polls where id=$1", [expiredPollId],
    );
    assert.equal(restoredRows[0]?.status, "closed");
    assert.ok(restoredRows[0]?.closed_at);
    assert.equal(restoredRows[0]?.closed_reason, "expired");
  } finally {
    await seedPool.query("delete from moderation_cases where target_id=$1", [pollId]).catch(() => {});
    await seedPool.query("delete from topics where id=$1", [topicId]).catch(() => {});
    await seedPool.query("delete from agents where id=any($1::text[])", [agentIds]).catch(() => {});
    await seedPool.query("delete from users where id=any($1::text[])", [userIds]).catch(() => {});
    await app.close();
    await seedPool.end();
  }
});
