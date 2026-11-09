import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { Context } from '@deepseek-ai/cordis';
import { normalizeYutangPolicyDecision, yutangApprovalDecision } from '../src/index.js';
import { resolveConfig } from '../src/config.js';
import { activeConnection, defaultSettings, StateStore } from '../src/storage/state.js';
import { YutangRuntime } from '../src/service/runtime.js';
import { collectWaitMessages, registerYutangTools } from '../src/tools/index.js';
import { optionalInteger, optionalString } from '../src/tools/format.js';
import { createYutangRpc } from '../src/transport/rpc.js';
import { asCredentialProvider, MemoryCredentials } from './helpers/credentials.js';
import { ApiError, YutangApi } from '@dsh-im/client';
import { toolError } from '../src/tools/format.js';

test('all public writes require a host approval, while read tools remain available', () => {
  const ask = yutangApprovalDecision({ name: 'yutang_send', arguments: { channel_id: 'channel_test', content: 'synthetic text' } } as never);
  assert.equal(ask?.kind, 'ask');
  assert.match(ask?.reason ?? '', /synthetic text/u);
  assert.match(ask?.reason ?? '', /自动加入/u, 'approval details must disclose the membership change caused by send');

  assert.equal(yutangApprovalDecision({ name: 'yutang_topics', arguments: { action: 'create', name: 'topic' } } as never)?.kind, 'ask');
  assert.equal(yutangApprovalDecision({ name: 'yutang_channels', arguments: { action: 'join', channel_id: 'channel_test' } } as never)?.kind, 'ask');
  assert.equal(yutangApprovalDecision({ name: 'yutang_report', arguments: { target_type: 'message', target_id: 'msg_test' } } as never)?.kind, 'ask');
  assert.equal(yutangApprovalDecision({ name: 'yutang_jury', arguments: { action: 'vote', case_id: 'case_test', vote: false } } as never)?.kind, 'ask');
  assert.equal(yutangApprovalDecision({ name: 'yutang_jury', arguments: { action: 'list' } } as never), null);
  assert.equal(yutangApprovalDecision({ name: 'yutang_read', arguments: { channel_id: 'channel_test' } } as never), null);
});

test('rendered fishpond errors become failed ToolResults and do not consume policy notice', () => {
  const renderedFailure = { isError: false as const, content: [{ type: 'text' as const, text: '【工具结果】失败\n【错误码】AGENT_BANNED' }] };
  const normalized = normalizeYutangPolicyDecision(renderedFailure, { kind: 'accept' });
  assert.equal(normalized.kind, 'block');
  if (normalized.kind === 'block') assert.match(normalized.feedback[0]?.type === 'text' ? normalized.feedback[0].text : '', /AGENT_BANNED/u);
  assert.deepEqual(normalizeYutangPolicyDecision({ isError: true, content: renderedFailure.content }, { kind: 'accept' }), { kind: 'accept' });
  assert.deepEqual(normalizeYutangPolicyDecision({ isError: false, content: [{ type: 'text', text: '【读取结果】没有消息' }] }, { kind: 'accept' }), { kind: 'accept' });
});

test('Server ban headers survive YutangApi errors and format the UTC unban time', async () => {
  const api = new YutangApi('https://synthetic.example', undefined, async () => new Response(JSON.stringify({ error: { code: 'AGENT_BANNED', message: 'banned' } }), {
    status: 403,
    headers: { 'content-type': 'application/json', 'x-ban-kind': 'temporary', 'x-banned-until': '2026-11-07T05:10:00.000Z', 'retry-after': '120' },
  }));
  await assert.rejects(api.getMe(), error => {
    assert.ok(error instanceof ApiError);
    assert.equal(error.code, 'AGENT_BANNED');
    assert.equal(error.responseHeaders['x-banned-until'], '2026-11-07T05:10:00.000Z');
    assert.match(toolError(error), /2026-11-07 05:10:00 UTC/u);
    return true;
  });
});

test('aborting an in-flight wait poll is reported as cancellation, not read failure', async () => {
  const controller = new AbortController();
  let markPollStarted!: () => void;
  const pollStarted = new Promise<void>(resolve => { markPollStarted = resolve; });
  const api = {
    listMessages: async (_channelId: string, options: { signal?: AbortSignal }) => {
      markPollStarted();
      return new Promise((_resolve, reject) => options.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true }));
    },
  } as unknown as Pick<YutangApi, 'listMessages'>;
  const wait = collectWaitMessages(api, 'channel-test', 'sender-test', 12, Date.now() + 60_000, controller.signal);
  await pollStarted;
  controller.abort();
  const result = await wait;
  assert.equal(result.cancelled, true);
  assert.equal(result.failed, false);
  assert.equal(result.cursor, 12);
});

test('optional ToolCall fields reject values outside their documented scalar types', () => {
  assert.equal(optionalString(undefined, 'cursor', true), undefined);
  assert.equal(optionalString(null, 'cursor', true), undefined);
  assert.equal(optionalString(' next ', 'cursor', true), 'next');
  assert.throws(() => optionalString(42, 'reply'), /INVALID_INPUT/u);
  assert.equal(optionalInteger(undefined, 'after_seq', 0, Number.MAX_SAFE_INTEGER), undefined);
  assert.throws(() => optionalInteger(null, 'after_seq', 0, Number.MAX_SAFE_INTEGER), /INVALID_INPUT/u);
});

test('turn tool lock persists per Agent turn and honors only the configured exact allowlist', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'dsh-yutang-turn-lock-'));
  try {
    const store = new StateStore(dataDir, 'http://127.0.0.1:9555');
    const firstRuntime = new YutangRuntime(store, 'http://127.0.0.1:9555', asCredentialProvider());
    await firstRuntime.initialize();
    await firstRuntime.armTurnToolLock('session-a', 3);

    const restored = new YutangRuntime(new StateStore(dataDir, 'http://127.0.0.1:9555'), 'http://127.0.0.1:9555', asCredentialProvider());
    await restored.initialize();
    assert.equal(restored.checkTurnToolLock('session-a', 3, 'yutang_read'), undefined);
    assert.match(restored.checkTurnToolLock('session-a', 3, 'shell') ?? '', /工具锁已生效/u);
    assert.equal(restored.checkTurnToolLock('session-b', 3, 'shell'), undefined, 'another Session has an independent lock');
    assert.equal(restored.checkTurnToolLock('session-a', 4, 'shell'), undefined, 'a new turn unlocks the Session');

    await restored.updateSettings({ tool_lock_allowed_tools: ['web_search'] });
    await restored.armTurnToolLock('session-a', 5);
    assert.equal(restored.checkTurnToolLock('session-a', 5, 'web_search'), undefined);
    assert.match(restored.checkTurnToolLock('session-a', 5, 'shell') ?? '', /工具锁已生效/u);
    await restored.updateSettings({ tool_lock_allowed_tools: ['web_search', 'web_fetch'] });
    await restored.armTurnToolLock('session-a', 6);
    assert.equal(restored.checkTurnToolLock('session-a', 6, 'web_search'), undefined);
    assert.equal(restored.checkTurnToolLock('session-a', 6, 'web_fetch'), undefined);
    assert.match(restored.checkTurnToolLock('session-a', 6, 'browser') ?? '', /工具锁已生效/u);
    await assert.rejects(restored.updateSettings({ tool_lock_allowed_tools: ['shell'] as never }), /不支持的工具/u);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('Worker send grants are bound to one session, task, channel, and message budget', () => {
  const runtime = new YutangRuntime(new StateStore('/tmp/dsh-yutang-worker-grant-test', 'http://127.0.0.1:9555'), 'http://127.0.0.1:9555', asCredentialProvider());
  assert.equal(runtime.workerToolAllowed('worker-session', 'web_search'), true);
  const release = runtime.beginWorkerTask('worker-session', 'mention:event-1', 'channel-1', 'mention', 'server-a');
  assert.equal(runtime.workerTaskId('worker-session'), 'mention:event-1');
  assert.equal(runtime.workerToolAllowed('worker-session', 'yutang_read'), true);
  assert.equal(runtime.workerToolAllowed('worker-session', 'yutang_send'), true);
  assert.equal(runtime.workerToolAllowed('worker-session', 'web_search'), false);
  assert.equal(runtime.workerToolAllowed('worker-session', 'yutang_topics'), false);
  assert.equal(runtime.workerSendAllowed('another-session', 'channel-1'), false);
  assert.equal(runtime.workerSendAllowed('worker-session', 'channel-2'), false);
  assert.equal(runtime.workerSendAllowed('worker-session', 'channel-1'), true);
  assert.equal(runtime.workerSendAllowed('worker-session', 'channel-1', 'server-b'), false, 'a grant cannot be reused after switching Servers');
  assert.equal(runtime.workerSendAllowed('worker-session', 'channel-1', 'server-a'), true);
  assert.equal(runtime.consumeWorkerSend('worker-session', 'channel-1', 'pending'), true);
  assert.equal(runtime.workerSendAllowed('worker-session', 'channel-1'), false, 'one task cannot send twice');
  release();
  assert.equal(runtime.workerTaskId('worker-session'), undefined);
  assert.equal(runtime.workerToolAllowed('worker-session', 'web_search'), true);
});

test('Worker read and send ToolCalls cannot escape their task channel grant', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'dsh-yutang-worker-read-scope-'));
  const runtime = new YutangRuntime(new StateStore(dataDir, 'http://127.0.0.1:9555'), 'http://127.0.0.1:9555', asCredentialProvider());
  const tools = new Map<string, { name: string; execute(args: unknown, exec: Record<string, unknown>): Promise<unknown> }>();
  const ctx = { tools: { register(tool: { name: string; execute(args: unknown, exec: Record<string, unknown>): Promise<unknown> }) { tools.set(tool.name, tool); return () => { tools.delete(tool.name); }; } } } as unknown as Context;
  try {
    await runtime.store.update({ identity: { owner_id: 'user_test', agent_id: 'agent_test', display_name: 'Synthetic', public_key: 'synthetic', scopes: [] } });
    const release = runtime.beginWorkerTask('worker-session', 'browse:synthetic', 'channel-granted', 'browse', activeConnection(await runtime.state()).id);
    registerYutangTools(ctx, runtime);
    const result = String(await tools.get('yutang_read')!.execute({ channel_id: 'channel-other' }, {
      callId: 'worker-read-other-channel', signal: AbortSignal.timeout(1_000), agent: { id: 'worker-session' },
    }));
    assert.match(result, /【错误码】WORKER_CHANNEL_SCOPE/u);
    const sendResult = String(await tools.get('yutang_send')!.execute({ channel_id: 'channel-other', content: 'synthetic' }, {
      callId: 'worker-send-other-channel', signal: AbortSignal.timeout(1_000), agent: { id: 'worker-session' },
    }));
    assert.match(sendResult, /【错误码】WORKER_CHANNEL_SCOPE/u);
    release();
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('off mode blocks every network tool while status remains local', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'dsh-yutang-off-mode-'));
  const runtime = new YutangRuntime(new StateStore(dataDir, 'http://127.0.0.1:9555'), 'http://127.0.0.1:9555', asCredentialProvider());
  const tools = new Map<string, { name: string; execute(args: unknown, exec: Record<string, unknown>): Promise<unknown> }>();
  const ctx = { tools: { register(tool: { name: string; execute(args: unknown, exec: Record<string, unknown>): Promise<unknown> }) { tools.set(tool.name, tool); return () => { tools.delete(tool.name); }; } } } as unknown as Context;
  try {
    await runtime.store.update({
      identity: { owner_id: 'user_test', agent_id: 'agent_test', display_name: 'Synthetic', public_key: 'synthetic', scopes: [] },
    });
    await runtime.updateSettings({ social_mode: 'off' });
    registerYutangTools(ctx, runtime);
    const cases: Array<[string, unknown]> = [
      ['yutang_topics', { action: 'list' }],
      ['yutang_channels', { action: 'list', topic_id: 'topic_test' }],
      ['yutang_read', { channel_id: 'channel_test' }],
      ['yutang_send', { channel_id: 'channel_test', content: 'synthetic' }],
      ['yutang_report', { target_type: 'message', target_id: 'message_test', reason: 'synthetic reason' }],
      ['yutang_jury', { action: 'list' }],
      ['yutang_members', { action: 'get', agent_id: 'agent_test' }],
    ];
    for (const [name, args] of cases) {
      const result = String(await tools.get(name)!.execute(args, { callId: `off-${name}`, signal: AbortSignal.timeout(1_000) }));
      assert.match(result, /【错误码】SOCIAL_MODE_BLOCKED/u, `${name} must not reach the Server in off mode`);
    }
    const status = String(await tools.get('yutang_status')!.execute({}, { callId: 'off-status', signal: AbortSignal.timeout(1_000) }));
    assert.match(status, /【Server 连接】已暂停检查/u);
    assert.match(status, /【社交模式】off/u);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('social prompt supplement is empty when disabled and includes local fields only when enabled', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'dsh-yutang-prompt-setting-'));
  const runtime = new YutangRuntime(new StateStore(dataDir, 'http://127.0.0.1:9555'), 'http://127.0.0.1:9555', asCredentialProvider());
  try {
    runtime.initializePrompt(defaultSettings);
    assert.equal(runtime.promptText(), '');
    await runtime.updateSettings({ agent_personality: 'Synthetic persona.', knowledge_context: 'Synthetic local knowledge.' });
    assert.equal(runtime.promptText(), '', 'local fields do not enter the prompt while the switch is off');
    await runtime.updateSettings({ system_prompt_enabled: true });
    assert.match(runtime.promptText(), /Synthetic persona\./u);
    assert.match(runtime.promptText(), /Synthetic local knowledge\./u);
    await runtime.updateSettings({ system_prompt_enabled: false });
    assert.equal(runtime.promptText(), '', 'disabling the supplement leaves the host prompt section empty');
    assert.equal((await runtime.state()).settings.agent_personality, 'Synthetic persona.');
    assert.equal((await runtime.state()).settings.knowledge_context, 'Synthetic local knowledge.');
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('@ wakeup can run independently from automatic browsing, but leaving auto mode disables it', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'dsh-yutang-mention-setting-'));
  const runtime = new YutangRuntime(new StateStore(dataDir, 'http://127.0.0.1:9555'), 'http://127.0.0.1:9555', asCredentialProvider());
  try {
    await runtime.updateSettings({ social_mode: 'auto', auto_browse_enabled: false, mention_wakeup_enabled: true });
    assert.equal((await runtime.state()).settings.mention_wakeup_enabled, true);
    await runtime.updateSettings({ social_mode: 'manual' });
    assert.equal((await runtime.state()).settings.mention_wakeup_enabled, false);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('Profile state defaults under the selected profile directory', () => {
  assert.equal(resolveConfig({ serverUrl: 'http://127.0.0.1:9555' }, '/tmp/dsh-home/profiles/agent-a').dataDir, '/tmp/dsh-home/profiles/agent-a/dsh-yutang');
  assert.equal(resolveConfig({ dataDir: '/tmp/explicit-yutang' }, '/tmp/dsh-home/profiles/agent-a').dataDir, '/tmp/explicit-yutang');
  assert.equal(resolveConfig({ officialServerUrl: 'official.example:9555' }).officialServerUrl, 'https://official.example:9555');
  assert.equal(defaultSettings.social_mode, 'auto', 'a new Profile starts in automatic social mode');
});

test('v3 single-Server state migrates connection identity and Worker cursors into v6', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'dsh-yutang-server-state-migration-'));
  const statePath = join(dataDir, 'state.json');
  try {
    await writeFile(statePath, JSON.stringify({
      version: 3, server_url: 'https://old.example',
      identity: { owner_id: 'user_test', agent_id: 'agent_old', display_name: 'Old', public_key: 'synthetic-key', scopes: [] },
      pending_registration: null, settings: { social_mode: 'manual' }, worker_session_id: 'session_old', read_cursors: { channel_old: 17 },
    }));
    const state = await new StateStore(dataDir, 'http://127.0.0.1:9555', 'https://official.example').load();
    const migrated = activeConnection(state);
    assert.equal(state.version, 6);
    assert.equal(migrated.server_url, 'https://old.example');
    assert.equal(migrated.identity?.agent_id, 'agent_old');
    assert.equal(migrated.worker_session_id, 'session_old');
    assert.equal(migrated.read_cursors.channel_old, 17);
    assert.equal(state.settings.social_mode, 'manual', 'migration preserves the saved social mode');
    assert.equal(state.task_session_selection_set, false, 'legacy Profiles with no task session can choose a default from Yutang usage');
    assert.equal(state.servers.find(server => server.id === 'official')?.server_url, 'https://official.example');
    assert.equal(state.servers[0]?.id, 'official', 'the fixed official Server appears first regardless of migration input order');
    const persisted = JSON.parse(await readFile(statePath, 'utf8')) as Record<string, unknown>;
    assert.equal(persisted.version, 6);
    assert.equal('private_key' in (persisted.identity as object ?? {}), false);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('last successful Yutang session becomes the default only until a task-session choice is saved', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'dsh-yutang-last-session-'));
  try {
    const store = new StateStore(dataDir, 'http://127.0.0.1:9555');
    assert.equal((await store.load()).settings.jury_worker_enabled, true, 'new Profiles enable background jury by default');
    const selected = await store.rememberYutangSession('session_yutang_a');
    assert.equal(selected.selectedByDefault, true);
    let state = await store.load();
    assert.equal(state.last_yutang_session_id, 'session_yutang_a');
    assert.equal(state.settings.scheduled_session_id, 'session_yutang_a');

    await store.update({ settings: { scheduled_session_id: null } });
    const notReselected = await store.rememberYutangSession('session_yutang_b');
    state = await store.load();
    assert.equal(notReselected.selectedByDefault, false);
    assert.equal(state.last_yutang_session_id, 'session_yutang_b');
    assert.equal(state.settings.scheduled_session_id, null, 'an explicit empty selection is preserved');
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('an unconfigured official Server does not keep a URL from older plugin configuration', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'dsh-yutang-official-server-config-'));
  try {
    await new StateStore(dataDir, 'http://127.0.0.1:9555', 'https://official.example').load();
    const state = await new StateStore(dataDir, 'http://127.0.0.1:9555').load();
    assert.equal(state.servers.find(server => server.id === 'official')?.server_url, null);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('saved Server connections switch independently and the official option cannot be removed', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'dsh-yutang-server-selection-'));
  const runtime = new YutangRuntime(new StateStore(dataDir, 'http://127.0.0.1:9555'), 'http://127.0.0.1:9555', asCredentialProvider());
  try {
    await runtime.store.update({ identity: {
      owner_id: 'user_test', agent_id: 'agent_test', display_name: 'Synthetic',
      public_key: 'synthetic-public-key', scopes: [],
    } });
    const originalId = activeConnection(await runtime.state()).id;
    const added = await runtime.store.addCustomServer('Remote', 'https://other.example:8443');
    await runtime.selectServer(added.id);
    const secondId = activeConnection(await runtime.state()).id;
    assert.notEqual(secondId, originalId);
    assert.equal(activeConnection(await runtime.state()).server_url, 'https://other.example:8443');
    assert.equal(activeConnection(await runtime.state()).identity, null);
    await runtime.selectServer(originalId);
    assert.equal(activeConnection(await runtime.state()).identity?.agent_id, 'agent_test');
    await assert.rejects(runtime.apiForCurrentAgent(secondId), /Server 连接已切换/u, 'an operation pinned to a different Server must fail instead of retargeting');
    await runtime.selectServer(secondId);
    await assert.rejects(runtime.removeServer(originalId), /已注册 Agent/u);
    await assert.rejects(runtime.removeServer('official'), /找不到可删除/u);
    await runtime.removeServer(secondId);
    assert.equal((await runtime.state()).servers.some(server => server.id === secondId), false);
    assert.equal(activeConnection(await runtime.state()).id, originalId, 'deleting the active unregistered connection selects the remaining configured Server');
    assert.equal((await runtime.state()).servers.some(server => server.id === 'official'), true);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('an unregistered pending Server can be deleted locally and moves the active connection to the official slot', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'dsh-yutang-pending-server-delete-'));
  const store = new StateStore(dataDir, 'http://127.0.0.1:9555');
  const runtime = new YutangRuntime(store, 'http://127.0.0.1:9555', asCredentialProvider());
  try {
    const state = await store.load();
    const active = activeConnection(state);
    assert.equal(state.servers[0]?.id, 'official');
    await store.updateConnection(active.id, { pending_registration: {
      server_url: active.server_url!, display_name: 'Synthetic', public_key: 'synthetic public key',
    } });
    await runtime.removeServer(active.id);
    const after = await runtime.state();
    assert.equal(activeConnection(after).id, 'official');
    assert.equal(after.servers.some(server => server.id === active.id), false);
    assert.equal(after.servers[0]?.id, 'official');
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('settings RPC rejects invalid values before persisting them', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'dsh-yutang-invalid-settings-'));
  const runtime = new YutangRuntime(new StateStore(dataDir, 'http://127.0.0.1:9555'), 'http://127.0.0.1:9555', asCredentialProvider());
  try {
    await runtime.store.load();
    const rpc = createYutangRpc(runtime, {} as never);
    const response = await rpc('settings/update', { settings: { social_mode: ['auto'] } }, AbortSignal.timeout(1_000), {} as never);
    assert.equal(response.ok, false);
    assert.equal((await runtime.state()).settings.social_mode, defaultSettings.social_mode);
    await assert.rejects(runtime.updateSettings({ agent_personality: 42 as unknown as string }), /类型无效/u);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('ToolCall validators reject values outside the documented field schema instead of coercing them', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'dsh-yutang-tool-schema-'));
  const runtime = new YutangRuntime(new StateStore(dataDir, 'http://127.0.0.1:9555'), 'http://127.0.0.1:9555', asCredentialProvider());
  const tools = new Map<string, { name: string; execute(args: unknown, exec: Record<string, unknown>): Promise<unknown> }>();
  const ctx = { tools: { register(tool: { name: string; execute(args: unknown, exec: Record<string, unknown>): Promise<unknown> }) { tools.set(tool.name, tool); return () => { tools.delete(tool.name); }; } } } as unknown as Context;
  const execute = async (name: string, args: unknown) => String(await tools.get(name)!.execute(args, { callId: `schema-${name}`, signal: AbortSignal.timeout(1_000) }));
  try {
    await runtime.store.load();
    registerYutangTools(ctx, runtime);
    await assert.rejects(execute('yutang_send', { content: 'synthetic' }), /invalid arguments/u, 'channel_id is required by the send schema');
    await assert.rejects(execute('yutang_topics', { action: 'list', sort: 'random' }), /invalid arguments/u);
    await assert.rejects(execute('yutang_channels', { action: 'list', topic_id: 'topic_test', sort: false }), /invalid arguments/u);
    await assert.rejects(execute('yutang_send', { channel_id: 'channel_test', content: 'synthetic', wait: '5' }), /invalid arguments/u);
    await assert.rejects(execute('yutang_send', { channel_id: 'channel_test', content: 'synthetic', wait: false }), /invalid arguments/u);
    await assert.rejects(execute('yutang_send', { channel_id: 'channel_test', content: 'synthetic', mention: ['agent_test', 7] }), /invalid arguments/u);
    await assert.rejects(execute('yutang_send', { channel_id: 'channel_test', content: 'synthetic', mention: 'agent_test' }), /invalid arguments/u);

    const invalidInputs: Array<[string, unknown]> = [
      ['yutang_topics', { action: 'list', query: 'q'.repeat(81) }],
      ['yutang_topics', { action: 'list', limit: 101 }],
      ['yutang_topics', { action: 'create', name: 'x' }],
      ['yutang_channels', { action: 'list', topic_id: 'topic_test', query: 'q'.repeat(81) }],
      ['yutang_channels', { action: 'list', topic_id: 'topic_test', limit: 0 }],
      ['yutang_channels', { action: 'create', topic_id: 'topic_test', name: 'x' }],
      ['yutang_read', { channel_id: 'channel_test', after_seq: -1 }],
      ['yutang_read', { channel_id: 'channel_test', before_seq: 0 }],
      ['yutang_read', { channel_id: 'channel_test', limit: 101 }],
      ['yutang_send', { channel_id: 'channel_test', content: ' ' }],
      ['yutang_send', { channel_id: 'channel_test', content: 'x'.repeat(2001) }],
      ['yutang_send', { channel_id: 'channel_test', content: 'synthetic', wait: 301 }],
      ['yutang_report', { target_type: 'message', target_id: 'msg_test', reason: 'no' }],
      ['yutang_members', { action: 'list', channel_id: 'channel_test', q: 'q'.repeat(81) }],
      ['yutang_members', { action: 'list', channel_id: 'channel_test', limit: 101 }],
    ];
    for (const [name, args] of invalidInputs) {
      const result = await execute(name, args);
      assert.match(result, /【错误码】INVALID_INPUT/u, `${name} should enforce its documented bounds before network access`);
    }
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('legacy identity private keys migrate to DSH credentials and are removed from the state file', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'dsh-yutang-credential-migration-'));
  const privateKey = 'synthetic legacy private key';
  const statePath = join(dataDir, 'state.json');
  const credentials = new MemoryCredentials();
  try {
    await writeFile(statePath, JSON.stringify({
      version: 2, server_url: 'http://127.0.0.1:9555',
      identity: { owner_id: 'user_test', agent_id: 'agent_test', display_name: 'Synthetic', public_key: 'synthetic public key', private_key: privateKey, access_token: 'synthetic token', scopes: [] },
      settings: {}, worker_session_id: null, read_cursors: {},
    }));
    const runtime = new YutangRuntime(new StateStore(dataDir, 'http://127.0.0.1:9555'), 'http://127.0.0.1:9555', asCredentialProvider(credentials), console, dataDir);
    await runtime.initialize();
    const persisted = await readFile(statePath, 'utf8');
    assert.doesNotMatch(persisted, /synthetic legacy private key|synthetic token/u);
    assert.equal(activeConnection(await runtime.state()).identity?.agent_id, 'agent_test');
    assert.equal(credentials.allRecords().length, 1);
    const migratedCredential = credentials.allRecords()[0];
    assert.equal(migratedCredential?.kind, 'grant');
    assert.equal(((migratedCredential as { payload: { private_key: string } }).payload).private_key, privateKey);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});
