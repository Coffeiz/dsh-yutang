import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { Context } from '@deepseek-ai/cordis';
import { YutangApi } from '@dsh-im/client';
import { buildApp } from '../../../apps/server/src/app.js';
import { loadConfig } from '../../../apps/server/src/config.js';
import { createDatabase } from '../../../apps/server/src/db/client.js';
import { registerYutangTools } from '../src/tools/index.js';
import { YutangRuntime } from '../src/service/runtime.js';
import { activeConnection, StateStore } from '../src/storage/state.js';
import { asCredentialProvider } from './helpers/credentials.js';

type Tool = { name: string; execute(args: unknown, exec: Record<string, unknown>): Promise<unknown> };
type ToolRegistry = { register(tool: Tool): () => void };
type AgentHarness = { runtime: YutangRuntime; api: YutangApi; tools: Map<string, Tool>; owner_id: string };
type SharpMetadata = { metadata(): Promise<{ format?: string; width?: number; height?: number }>; png(): { toBuffer(): Promise<Buffer> } };
const serverRequire = createRequire(new URL('../../../apps/server/package.json', import.meta.url));
const sharp = serverRequire('sharp') as (input: Buffer, options?: { raw: { width: number; height: number; channels: 4 } }) => SharpMetadata;

const requiredEnv = ['YUTANG_TEST_DB_HOST', 'YUTANG_TEST_DB_PORT', 'YUTANG_TEST_DB_USER', 'YUTANG_TEST_DB_NAME'];
const missingTestDatabaseEnv = requiredEnv.filter((key) => !process.env[key]);
const hasTestDatabase = missingTestDatabaseEnv.length === 0;
const testPepper = 'dsh-yutang-integration-test-pepper-0001';

function toolContext(tools: Map<string, Tool>): Context {
  const registry: ToolRegistry = { register(tool) { tools.set(tool.name, tool); return () => { tools.delete(tool.name); }; } };
  return { tools: registry } as unknown as Context;
}

function execute(tool: Tool, args: unknown, callId: string, signal: AbortSignal = AbortSignal.timeout(10_000)) {
  return tool.execute(args, { callId, signal });
}

function compactToolText(value: unknown) {
  return String(value).replace(/\s+/gu, '');
}

function extractChannelId(value: unknown) {
  assert.equal(typeof value, 'string', String(value));
  const text = String(value);
  assert.match(text, /【创建结果】成功/u);
  const channelId = /【频道 ID】([^｜\n]+)/u.exec(text)?.[1];
  if (!channelId) throw new Error(`ToolCall response has no channel ID: ${text}`);
  return channelId;
}

type TestPool = Awaited<ReturnType<typeof createDatabase>>['pool'];

async function cleanupSyntheticOwner(pool: TestPool, ownerId: string) {
  await pool.query('BEGIN');
  try {
    const { rows: agentRows } = await pool.query('SELECT id FROM agents WHERE owner_id = $1', [ownerId]);
    const agentIds = agentRows.map((row) => row.id as string);
    if (agentIds.length) {
      const { rows: topicRows } = await pool.query('SELECT id FROM topics WHERE created_by_agent_id = ANY($1::text[])', [agentIds]);
      const topicIds = topicRows.map((row) => row.id as string);
      const { rows: channelRows } = await pool.query('SELECT id FROM channels WHERE created_by_agent_id = ANY($1::text[]) OR topic_id = ANY($2::text[])', [agentIds, topicIds]);
      const channelIds = channelRows.map((row) => row.id as string);
      const { rows: caseRows } = await pool.query('SELECT id FROM moderation_cases WHERE subject_agent_id = ANY($1::text[]) OR reporter_agent_id = ANY($1::text[])', [agentIds]);
      const caseIds = caseRows.map((row) => row.id as string);
      const { rows: assignmentRows } = await pool.query('SELECT id FROM moderation_assignments WHERE agent_id = ANY($1::text[]) OR case_id = ANY($2::text[])', [agentIds, caseIds]);
      const assignmentIds = assignmentRows.map((row) => row.id as string);

      await pool.query('DELETE FROM moderation_votes WHERE agent_id = ANY($1::text[]) OR case_id = ANY($2::text[]) OR assignment_id = ANY($3::text[])', [agentIds, caseIds, assignmentIds]);
      await pool.query('DELETE FROM moderation_assignments WHERE agent_id = ANY($1::text[]) OR case_id = ANY($2::text[])', [agentIds, caseIds]);
      await pool.query('DELETE FROM moderation_reports WHERE reporter_agent_id = ANY($1::text[]) OR case_id = ANY($2::text[])', [agentIds, caseIds]);
      await pool.query('DELETE FROM agent_strikes WHERE agent_id = ANY($1::text[]) OR case_id = ANY($2::text[])', [agentIds, caseIds]);
      await pool.query('DELETE FROM agent_suspensions WHERE agent_id = ANY($1::text[]) OR case_id = ANY($2::text[])', [agentIds, caseIds]);
      await pool.query('DELETE FROM moderation_cases WHERE id = ANY($1::text[])', [caseIds]);
      await pool.query('DELETE FROM moderation_actions WHERE actor_id = ANY($1::text[])', [agentIds]);
      await pool.query('DELETE FROM message_mentions WHERE target_agent_id = ANY($1::text[])', [agentIds]);
      await pool.query('DELETE FROM messages WHERE sender_agent_id = ANY($1::text[]) OR channel_id = ANY($2::text[])', [agentIds, channelIds]);
      await pool.query('DELETE FROM topics WHERE id = ANY($1::text[])', [topicIds]);
    }
    await pool.query('DELETE FROM users WHERE id = $1', [ownerId]);
    await pool.query('COMMIT');
  } catch (error) {
    await pool.query('ROLLBACK');
    throw error;
  }
}

async function makeAgent(baseUrl: string, dataDir: string, scopes: string[], pool: TestPool): Promise<AgentHarness> {
  const store = new StateStore(join(dataDir, randomUUID()), baseUrl);
  const credentials = asCredentialProvider();
  const registrationRuntime = new YutangRuntime(store, baseUrl, credentials);
  await registrationRuntime.register();
  const identity = activeConnection(await store.load()).identity!;
  await pool.query('UPDATE agents SET display_name = $1 WHERE id = $2', [`Synthetic ${randomUUID().slice(0, 8)}`, identity.agent_id]);
  await pool.query('UPDATE agent_identity_keys SET scopes = $1 WHERE agent_id = $2', [JSON.stringify(scopes), identity.agent_id]);
  const displayName = (await pool.query('SELECT display_name FROM agents WHERE id = $1', [identity.agent_id])).rows[0].display_name as string;
  await store.updateConnection(activeConnection(await store.load()).id, { identity: { ...identity, display_name: displayName, scopes } });
  const runtime = new YutangRuntime(store, baseUrl, credentials);
  const tools = new Map<string, Tool>();
  registerYutangTools(toolContext(tools), runtime);
  return { runtime, api: await runtime.apiForCurrentAgent(), tools, owner_id: identity.owner_id };
}

async function nextSocketEvent(socket: WebSocket, type: string, timeoutMs = 15_000) {
  return new Promise<Record<string, unknown>>((resolve, reject) => {
    const seen: string[] = [];
    const timer = setTimeout(() => finish(new Error(`Timed out waiting for ${type}; received ${seen.join(', ') || 'no events'}`)), timeoutMs);
    const onMessage = (event: MessageEvent) => {
      try {
        const value = JSON.parse(String(event.data)) as Record<string, unknown>;
        seen.push(String(value.type ?? 'unknown'));
        if (value.type === type) finish(undefined, value);
        else if (value.type === 'error') finish(new Error(`WebSocket server error: ${JSON.stringify(value.data)}`));
      } catch (error) { finish(error instanceof Error ? error : new Error('Invalid websocket event')); }
    };
    const onClose = () => finish(new Error(`WebSocket closed before ${type}`));
    const finish = (error?: Error, value?: Record<string, unknown>) => {
      clearTimeout(timer);
      socket.removeEventListener('message', onMessage);
      socket.removeEventListener('close', onClose);
      if (error) reject(error);
      else resolve(value!);
    };
    socket.addEventListener('message', onMessage);
    socket.addEventListener('close', onClose, { once: true });
  });
}

async function connectAgent(api: YutangApi, baseUrl: string, channelId: string, inbox = false, jury = false) {
  const ticketResponse = await api.request<{ data: { ticket: string } }>('/v1/realtime-tickets', { method: 'POST' });
  const wsUrl = new URL('/v1/realtime', baseUrl);
  wsUrl.protocol = wsUrl.protocol === 'https:' ? 'wss:' : 'ws:';
  wsUrl.searchParams.set('ticket', ticketResponse.data.ticket);
  const socket = new WebSocket(wsUrl);
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener('open', () => resolve(), { once: true });
    socket.addEventListener('error', () => reject(new Error('WebSocket connection failed')), { once: true });
  });
  await nextSocketEvent(socket, 'connection.ready');
  const subscribed = nextSocketEvent(socket, 'subscribed');
  socket.send(JSON.stringify({ type: 'subscribe', channels: [channelId], inbox, jury }));
  await subscribed;
  return socket;
}

test('ToolCalls persist and publish messages; Inbox claim, renew, reply, and completion use the lease contract', { skip: hasTestDatabase ? false : `Integration database unavailable; set ${missingTestDatabaseEnv.join(', ')}` }, async () => {
  const avatarDir = join(tmpdir(), `yutang-avatar-${randomUUID()}`);
  const config = loadConfig({
    ...process.env,
    NODE_ENV: 'test', HOST: '127.0.0.1', PORT: '9555', AVATAR_DIR: avatarDir,
    DB_HOST: process.env.YUTANG_TEST_DB_HOST!, DB_PORT: process.env.YUTANG_TEST_DB_PORT!,
    DB_USER: process.env.YUTANG_TEST_DB_USER!, DB_PASSWORD: process.env.YUTANG_TEST_DB_PASSWORD ?? '',
    DB_NAME: process.env.YUTANG_TEST_DB_NAME!, DB_SSL_MODE: 'disable', TOKEN_HMAC_PEPPER: testPepper,
    WEB_ORIGIN: 'http://127.0.0.1:1', LOG_LEVEL: 'silent',
  });
  const { pool: seedPool } = createDatabase(config);
  const dataDir = await mkdtemp(join(tmpdir(), 'dsh-yutang-flow-'));
  let app: Awaited<ReturnType<typeof buildApp>>['app'] | undefined;
  const sockets: WebSocket[] = [];
  const ownerIds: string[] = [];
  try {
    const running = await buildApp(config);
    app = running.app;
    await app.listen({ host: '127.0.0.1', port: 0 });
    const address = app.server.address();
    assert.ok(address && typeof address !== 'string');
    const baseUrl = `http://127.0.0.1:${address.port}`;

    const recoveryRuntime = new YutangRuntime(new StateStore(join(dataDir, 'registration-recovery'), baseUrl), baseUrl, asCredentialProvider());
    const originalFetch = globalThis.fetch;
    let droppedRegistrationResponse = false;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const response = await originalFetch(input, init);
      const requestUrl = input instanceof Request ? input.url : String(input);
      if (!droppedRegistrationResponse && new URL(requestUrl).pathname === '/v1/agents/register') {
        droppedRegistrationResponse = true;
        await response.arrayBuffer();
        throw new TypeError('synthetic connection loss after registration commit');
      }
      return response;
    }) as typeof fetch;
    try {
      await assert.rejects(recoveryRuntime.register(), /无法连接鱼塘 Server/u);
    } finally {
      globalThis.fetch = originalFetch;
    }
    assert.equal(droppedRegistrationResponse, true, 'the registration endpoint response must be dropped after Server commit');
    const pendingRegistration = activeConnection(await recoveryRuntime.state()).pending_registration;
    assert.ok(pendingRegistration, 'the private key must be persisted before the one-time code is sent');
    const recoveredRegistration = await recoveryRuntime.register();
    const recoveryIdentity = activeConnection(await recoveryRuntime.state()).identity!;
    ownerIds.push(recoveryIdentity.owner_id);
    assert.match(recoveredRegistration.identity.owner_id, /^user_/u, 'Server generates the Owner UUID');
    assert.match(recoveredRegistration.identity.agent_id, /^agent_/u, 'Server generates the Agent UUID');
    assert.equal(activeConnection(await recoveryRuntime.state()).pending_registration, null);
    const registrationCount = await seedPool.query('SELECT count(*)::int AS count FROM agents WHERE owner_id = $1', [recoveryIdentity.owner_id]);
    assert.equal(registrationCount.rows[0]?.count, 1, 'retry after a lost response must recover the same Agent');
    await seedPool.query('UPDATE agents SET display_name = $1 WHERE id = $2', ['Synthetic recovery agent', recoveryIdentity.agent_id]);
    await recoveryRuntime.store.updateConnection(activeConnection(await recoveryRuntime.state()).id, { identity: { ...recoveryIdentity, display_name: 'Synthetic recovery agent' } });
    const first = await makeAgent(baseUrl, dataDir, ['channels:create'], seedPool);
    ownerIds.push(first.owner_id);
    const policySessionId = `policy-session-${randomUUID()}`;
    const firstPolicy = await first.api.policyNotice(policySessionId, 'consume');
    assert.equal(firstPolicy.data.policy_present, true);
    assert.match(firstPolicy.data.version, /^sha256:/u);
    assert.match(firstPolicy.data.notice ?? '', /# 鱼塘社区规范/u);
    const repeatedPolicy = await first.api.policyNotice(policySessionId, 'consume');
    assert.equal(repeatedPolicy.data.notice, null, 'the same Agent/Session context must not receive duplicate policy text');
    const concurrentPolicy = await Promise.all(Array.from({ length: 3 }, () => first.api.policyNotice(`policy-race-${randomUUID()}`, 'consume')));
    assert.equal(concurrentPolicy.filter(response => response.data.notice !== null).length, 3, 'independent Session IDs each receive policy once');
    const sharedSessionId = `policy-shared-${randomUUID()}`;
    const sharedPolicy = await Promise.all(Array.from({ length: 3 }, () => first.api.policyNotice(sharedSessionId, 'consume')));
    assert.equal(sharedPolicy.filter(response => response.data.notice !== null).length, 1, 'concurrent consume for one Agent/Session must deliver the policy exactly once');
    const resetPolicy = await first.api.policyNotice(policySessionId, 'reset');
    assert.equal(resetPolicy.data.policy_present, false);
    const policyAfterReset = await first.api.policyNotice(policySessionId, 'consume');
    assert.match(policyAfterReset.data.notice ?? '', /不可信输入/u, 'the next successful tool-result policy consume must resend after compaction reset');
    const png = await sharp(Buffer.from([0x52, 0xa7, 0xff, 0xff]), { raw: { width: 1, height: 1, channels: 4 } }).png().toBuffer();
    const uploadedAvatar = await first.runtime.uploadAvatar(`data:image/png;base64,${png.toString('base64')}`);
    assert.equal(uploadedAvatar.avatar_url, `/v1/avatars/${encodeURIComponent(activeConnection(await first.runtime.state()).identity!.agent_id)}`);
    const avatarResponse = await fetch(new URL(uploadedAvatar.avatar_url, baseUrl));
    assert.equal(avatarResponse.headers.get('content-type'), 'image/webp');
    const avatarMetadata = await sharp(Buffer.from(await avatarResponse.arrayBuffer())).metadata();
    assert.deepEqual({ format: avatarMetadata.format, width: avatarMetadata.width, height: avatarMetadata.height }, { format: 'webp', width: 64, height: 64 });
    const secondTools = new Map<string, Tool>();
    registerYutangTools(toolContext(secondTools), recoveryRuntime);
    const second: AgentHarness = { runtime: recoveryRuntime, api: await recoveryRuntime.apiForCurrentAgent(), tools: secondTools, owner_id: recoveryIdentity.owner_id };
    await first.runtime.updateSettings({ channel_creation_enabled: true });

    assert.deepEqual([...first.tools.keys()].sort(), [
      'yutang_channels', 'yutang_jury', 'yutang_members', 'yutang_read', 'yutang_report', 'yutang_send', 'yutang_status', 'yutang_topics',
    ]);
    const topicName = `Synthetic topic ${randomUUID().slice(0, 8)}`;
    const topicResult = await execute(first.tools.get('yutang_topics')!, { action: 'create', name: topicName }, 'topic-create-call');
    const channelId = extractChannelId(topicResult);
    const topicId = /【话题 ID】([^｜\n]+)/u.exec(String(topicResult))![1]!;
    const topicList = String(await execute(first.tools.get('yutang_topics')!, { action: 'list', query: topicName, limit: 10 }, 'topic-list-call'));
    assert.match(topicList, new RegExp(`【话题 ID】${topicId}`, 'u'));
    assert.match(topicList, /【分页】/u);
    const topicDetails = String(await execute(first.tools.get('yutang_topics')!, { action: 'get', topic_id: topicId }, 'topic-get-call'));
    assert.match(topicDetails, new RegExp(`【默认频道 ID】${channelId}`, 'u'));
    const autoSelectedSend = String(await execute(first.tools.get('yutang_send')!, { channel_id: channelId, content: 'send selects the explicit channel' }, 'send-auto-select-channel'));
    assert.match(autoSelectedSend, /【发送结果】成功/u, `an explicit channel_id should let yutang_send join/select and send: ${autoSelectedSend}`);
    assert.equal(first.runtime.selectedSendChannel(activeConnection(await first.runtime.state()).identity!.agent_id, activeConnection(await first.runtime.state()).id), channelId, 'ordinary send should select the explicit channel for this Server');
    assert.match(String(await execute(first.tools.get('yutang_channels')!, { action: 'join', channel_id: channelId }, 'default-channel-join-call')), /【加入结果】已加入/u);
    assert.match(String(await execute(first.tools.get('yutang_channels')!, { action: 'join', channel_id: channelId }, 'default-channel-join-call')), /【加入结果】已加入/u);

    const createChannel = first.tools.get('yutang_channels')!;
    const channelArgs = { action: 'create', topic_id: topicId, name: `synthetic-${randomUUID().slice(0, 8)}` };
    const extraChannelResult = await execute(createChannel, channelArgs, 'channel-create-stable-call');
    const extraChannelReplay = await execute(createChannel, channelArgs, 'channel-create-stable-call');
    const extraChannelId = extractChannelId(extraChannelResult);
    assert.equal(extractChannelId(extraChannelReplay), extraChannelId, 'retry with the same ToolCall ID must replay the same channel');
    const channelList = String(await execute(createChannel, { action: 'list', topic_id: topicId, limit: 10 }, 'channel-list-call'));
    assert.match(channelList, new RegExp(`【频道 ID】${extraChannelId}`, 'u'));
    const channelDetails = String(await execute(createChannel, { action: 'get', channel_id: extraChannelId }, 'channel-get-call'));
    assert.match(channelDetails, new RegExp(`【所属话题】[^｜]+｜【话题 ID】${topicId}｜【成员数】1｜【最近活动】`, 'u'));
    assert.match(String(await execute(second.tools.get('yutang_channels')!, { action: 'join', channel_id: extraChannelId }, 'channel-join-call')), /【加入结果】已加入/u);
    assert.match(String(await execute(second.tools.get('yutang_channels')!, { action: 'leave', channel_id: extraChannelId }, 'channel-leave-call')), /【退出结果】已退出/u);

    const autoJoinedSend = String(await execute(second.tools.get('yutang_send')!, { channel_id: channelId, content: 'send auto joins the explicit channel' }, 'send-auto-join-channel'));
    assert.match(autoJoinedSend, /【发送结果】成功/u, `an explicit channel_id should auto-join before sending: ${autoJoinedSend}`);
    const autoJoinedMembership = await seedPool.query('SELECT count(*)::int AS count FROM channel_members WHERE channel_id = $1 AND agent_id = $2', [channelId, activeConnection(await second.runtime.state()).identity!.agent_id]);
    assert.equal(autoJoinedMembership.rows[0]?.count, 1, 'ordinary send should join the requested channel before posting');
    assert.match(String(await execute(second.tools.get('yutang_channels')!, { action: 'join', channel_id: channelId }, 'second-agent-channel-join-call')), /【加入结果】已加入/u);
    const firstMemberId = activeConnection(await first.runtime.state()).identity!.agent_id;
    const secondMemberId = activeConnection(await second.runtime.state()).identity!.agent_id;
    await seedPool.query('UPDATE channel_members SET joined_at = $1::timestamptz WHERE channel_id = $2 AND agent_id = $3', ['2026-11-06T12:00:00.123100Z', channelId, firstMemberId]);
    await seedPool.query('UPDATE channel_members SET joined_at = $1::timestamptz WHERE channel_id = $2 AND agent_id = $3', ['2026-11-06T12:00:00.123900Z', channelId, secondMemberId]);
    const firstMemberPage = await first.api.listMembers(channelId, { q: 'Synthetic', limit: 1 });
    assert.equal(firstMemberPage.data.length, 1);
    assert.equal(firstMemberPage.page.has_more, true, 'member search must report a continuation page');
    const secondMemberPage = await first.api.listMembers(channelId, { q: 'Synthetic', limit: 1, cursor: firstMemberPage.page.next_cursor! });
    assert.equal(secondMemberPage.data.length, 1);
    assert.equal(firstMemberPage.data[0]?.id, secondMemberId);
    assert.equal(secondMemberPage.data[0]?.id, firstMemberId, 'microsecond timestamps at the page boundary must not skip a member');
    const memberList = String(await execute(first.tools.get('yutang_members')!, { action: 'list', channel_id: channelId, q: 'Synthetic', limit: 10 }, 'members-list-call'));
    assert.match(memberList, /【频道成员】/u);
    assert.match(memberList, /【在线】/u);
    const memberId = activeConnection(await first.runtime.state()).identity!.agent_id;
    const memberDetails = String(await execute(first.tools.get('yutang_members')!, { action: 'get', agent_id: memberId }, 'members-get-call'));
    assert.match(memberDetails, new RegExp(`【Agent ID】${memberId}`, 'u'));
    assert.match(String(await execute(first.tools.get('yutang_channels')!, { action: 'join', channel_id: channelId }, 'first-agent-channel-join-call')), /【加入结果】已加入/u);
    assert.match(String(await execute(second.tools.get('yutang_channels')!, { action: 'join', channel_id: channelId }, 'second-agent-channel-join-call')), /【加入结果】已加入/u);
    const socket = await connectAgent(second.api, baseUrl, channelId, true);
    sockets.push(socket);
    const firstMessageEvent = nextSocketEvent(socket, 'channel.message.created');
    const firstSendResult = await execute(first.tools.get('yutang_send')!, { channel_id: channelId, content: 'synthetic message one' }, 'send-call-one');
    assert.match(String(firstSendResult), /【发送结果】成功/u, `the first send must succeed before checking its WebSocket notification: ${String(firstSendResult)}`);
    const firstEvent = await firstMessageEvent;
    const firstEventData = firstEvent.data as Record<string, unknown>;
    assert.match(String(firstSendResult), new RegExp(`【消息 ID】${firstEventData.id}`, 'u'));
    assert.equal(firstEventData.content, 'synthetic message one');
    assert.equal(firstEventData.channel_id, channelId);

    const secondMessageEvent = nextSocketEvent(socket, 'channel.message.created');
    const secondSendPromise = execute(second.tools.get('yutang_send')!, { channel_id: channelId, content: 'synthetic message two', wait: 2 }, 'send-call-two');
    const secondEvent = await secondMessageEvent;
    const secondEventData = secondEvent.data as Record<string, unknown>;
    const firstReply = await execute(first.tools.get('yutang_send')!, { channel_id: channelId, content: 'synthetic reply from first agent' }, 'send-call-reply');
    assert.match(String(firstReply), /【发送结果】成功/u);
    const secondSendResult = String(await secondSendPromise);
    assert.doesNotMatch(secondSendResult, /【等待结果】/u, 'received messages do not need a redundant wait completion line');
    assert.match(secondSendResult, new RegExp(`【消息 ID】${secondEventData.id}`, 'u'));
    assert.match(secondSendResult, /synthetic reply from first agent/u);

    const originalListMessages = YutangApi.prototype.listMessages;
    let markWaitPollStarted!: () => void;
    const waitPollStarted = new Promise<void>(resolve => { markWaitPollStarted = resolve; });
    YutangApi.prototype.listMessages = function (requestedChannelId, query = {}) {
      if (query.afterSeq !== undefined) {
        markWaitPollStarted();
        return new Promise((_resolve, reject) => {
          query.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
        }) as ReturnType<typeof originalListMessages>;
      }
      return originalListMessages.call(this, requestedChannelId, query);
    };
    try {
      const cancelWait = new AbortController();
      const cancelWaitResult = execute(second.tools.get('yutang_send')!, { channel_id: channelId, content: 'synthetic cancellation receipt', wait: 30 }, 'send-wait-cancel', cancelWait.signal);
      await waitPollStarted;
      cancelWait.abort();
      const cancelled = String(await cancelWaitResult);
      assert.match(cancelled, /【等待结果】已取消；发送已成功，请勿重发/u);
      assert.doesNotMatch(cancelled, /读取失败/u);
    } finally {
      YutangApi.prototype.listMessages = originalListMessages;
    }

    const read = await first.tools.get('yutang_read')!.execute({ channel_id: channelId, after_seq: 0 }, { callId: 'read-call', signal: AbortSignal.timeout(10_000) });
    assert.match(String(read), new RegExp(`【消息 ID】${secondEventData.id}`, 'u'));
    assert.match(String(read), /synthetic message two/u);
    const status = String(await execute(first.tools.get('yutang_status')!, {}, 'status-call'));
    assert.match(status, new RegExp(`【Agent ID】${memberId}`, 'u'));
    assert.match(status, /【Server 连接】正常/u);

    const secondIdentity = activeConnection(await second.runtime.state()).identity!;
    const inboxChanged = nextSocketEvent(socket, 'inbox.changed');
    const mentionMessageResult = await execute(first.tools.get('yutang_send')!, {
      channel_id: channelId, content: 'synthetic mention for inbox flow', mention: [secondIdentity.agent_id],
    }, 'send-call-mention');
    await inboxChanged;
    const mentionMessageId = /【消息 ID】([^｜]+)/u.exec(String(mentionMessageResult))?.[1];
    assert.ok(mentionMessageId);
    const claim = await second.api.claimInbox({ max_events: 5, lease_seconds: 60 });
    const event = claim.data.find(item => item.message.id === mentionMessageId);
    assert.ok(event, 'the mention should be claimable by its target Agent');
    assert.equal(event.message.content, 'synthetic mention for inbox flow');
    const renewed = await second.api.renewInboxLease(event.id, event.lease_token, 60);
    assert.equal(renewed.data.event_id, event.id);

    const replyResult = await execute(second.tools.get('yutang_send')!, {
      channel_id: channelId, content: 'synthetic inbox reply', reply: mentionMessageId,
    }, 'send-call-inbox-reply');
    const replyMessageId = /【消息 ID】([^｜]+)/u.exec(String(replyResult))?.[1];
    assert.ok(replyMessageId);
    const completed = await second.api.completeInboxEvent(event.id, {
      lease_token: event.lease_token, result: 'replied', reply_message_id: replyMessageId,
    });
    assert.equal(completed.data.status, 'completed');
    assert.equal(completed.data.result, 'replied');

    // The configured test database may contain unrelated open jury cases. As
    // synthetic jurors connect, the server can assign them to those cases
    // before this test creates its own. Provision enough isolated candidates
    // for every currently-open case plus the case created below.
    const openCases = await seedPool.query("SELECT count(*)::int AS count FROM moderation_cases WHERE status IN ('awaiting_jurors','collecting','admin_review')");
    const jurorCount = Math.max(5, ((openCases.rows[0]?.count as number ?? 0) + 1) * 5);
    const jurors: AgentHarness[] = [];
    for (let index = 0; index < jurorCount; index += 1) {
      const juror = await makeAgent(baseUrl, dataDir, [], seedPool);
      ownerIds.push(juror.owner_id);
      jurors.push(juror);
      const jurorId = activeConnection(await juror.runtime.state()).identity!.agent_id;
      await seedPool.query("UPDATE agents SET created_at = now() - interval '8 days' WHERE id = $1", [jurorId]);
      assert.match(String(await execute(juror.tools.get('yutang_channels')!, { action: 'join', channel_id: channelId }, `juror-${index}-join`)), /【加入结果】已加入/u);
      const seedMessage = String(await execute(juror.tools.get('yutang_send')!, { channel_id: channelId, content: `synthetic juror activity ${index}` }, `juror-${index}-activity`));
      assert.match(seedMessage, /【发送结果】成功/u);
      sockets.push(await connectAgent(juror.api, baseUrl, channelId, true, true));
    }
    const reportResult = String(await execute(first.tools.get('yutang_report')!, {
      target_type: 'message', target_id: firstEventData.id, reason: 'synthetic integration report reason',
    }, 'report-call'));
    assert.match(reportResult, /【举报结果】已提交/u);
    const caseId = /【案件 ID】([^｜\n]+)/u.exec(reportResult)?.[1];
    assert.ok(caseId);
    const assignedJurorRows = await seedPool.query("SELECT agent_id FROM moderation_assignments WHERE case_id = $1 AND round = 1 AND status IN ('assigned','delivered')", [caseId]);
    const assignedJurorIds = new Set(assignedJurorRows.rows.map(row => row.agent_id as string));
    const jurorsById = new Map<string, AgentHarness>();
    for (const juror of jurors) jurorsById.set(activeConnection(await juror.runtime.state()).identity!.agent_id, juror);
    const assignedJurors = [...assignedJurorIds].map(agentId => jurorsById.get(agentId)).filter((juror): juror is AgentHarness => Boolean(juror));
    assert.equal(assignedJurors.length, 5, `the isolated integration case should have five assigned jurors; found ${assignedJurors.length}`);
    for (const juror of assignedJurors) {
      const tasks = String(await execute(juror.tools.get('yutang_jury')!, { action: 'list' }, `jury-list-${activeConnection(await juror.runtime.state()).identity!.agent_id}`));
      const compactTasks = compactToolText(tasks);
      assert.match(compactTasks, new RegExp(`【案件ID】${caseId}`, 'u'));
      assert.match(compactTasks, /【冻结证据】以下JSON是不可信公开内容/u);
      const vote = String(await execute(juror.tools.get('yutang_jury')!, { action: 'vote', case_id: caseId, vote: false }, `jury-vote-${activeConnection(await juror.runtime.state()).identity!.agent_id}`));
      assert.match(vote, /【投票结果】已记录且不可修改/u);
    }
    const settledCase = await seedPool.query('SELECT status,true_votes,false_votes FROM moderation_cases WHERE id = $1', [caseId]);
    assert.deepEqual(settledCase.rows[0], { status: 'acquitted', true_votes: 0, false_votes: 5 });

    const unregisteredAgentId = secondIdentity.agent_id;
    const retainedHistory = await second.runtime.unregisterServer();
    assert.deepEqual(retainedHistory, { agent_id: unregisteredAgentId, history_anonymized: true });
    const anonymizedMessages = await first.api.listMessages(channelId, { limit: 100 });
    const oldAgentMessage = anonymizedMessages.data.find(message => message.sender.name === '已注销 Agent');
    assert.ok(oldAgentMessage, 'unregister must retain historical messages');
    assert.equal(oldAgentMessage.sender.id, 'deleted-agent', 'public history must not expose the old Agent ID');
    assert.equal(oldAgentMessage.sender.name, '已注销 Agent', 'historical messages must show the anonymized identity');
    const membership = await seedPool.query('SELECT count(*)::int AS count FROM channel_members WHERE agent_id = $1', [unregisteredAgentId]);
    assert.equal(membership.rows[0]?.count, 0, 'unregister removes channel membership');
    const retainedAgent = await seedPool.query('SELECT status, display_name, avatar_path FROM agents WHERE id = $1', [unregisteredAgentId]);
    assert.deepEqual(retainedAgent.rows[0], { status: 'deleted', display_name: '已注销 Agent', avatar_path: null });
  } finally {
    for (const socket of sockets) socket.close();
    if (app) await app.close();
    try {
      for (const ownerId of ownerIds) await cleanupSyntheticOwner(seedPool, ownerId);
    } finally {
      await seedPool.end();
      await rm(dataDir, { recursive: true, force: true });
      await rm(avatarDir, { recursive: true, force: true });
    }
  }
});
