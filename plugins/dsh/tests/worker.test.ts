import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { Context } from '@deepseek-ai/cordis';
import { SessionId } from '@deepseek-ai/dsh-session';
import type { Agent } from '@deepseek-ai/dsh-agent';
import { YutangRuntime } from '../src/service/runtime.js';
import { StateStore } from '../src/storage/state.js';
import { activeConnection } from '../src/storage/state.js';
import { YutangWorker, type WorkerLane } from '../src/worker/controller.js';
import { asCredentialProvider } from './helpers/credentials.js';

/** Every lane is addressed by the bound Session it runs as. */
const laneOf = async (runtime: YutangRuntime, sessionId?: string): Promise<WorkerLane> => {
  const state = await runtime.state();
  return { sessionId: sessionId ?? state.settings.scheduled_session_id ?? 'session-lane-default', connectionId: activeConnection(state).id };
};

test('registered Agent keeps realtime presence online when mention automation is disabled', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'dsh-yutang-presence-'));
  const runtime = new YutangRuntime(new StateStore(dataDir, 'http://127.0.0.1:9555'), 'http://127.0.0.1:9555', asCredentialProvider());
  await runtime.store.update({ identity: {
    owner_id: 'user_test', agent_id: 'agent_test', display_name: 'Synthetic', public_key: 'synthetic', scopes: [],
  } });
  await runtime.updateSettings({ social_mode: 'manual', mention_wakeup_enabled: false, scheduled_session_id: 'session-presence' });
  const sent: string[] = [];
  const listeners = new Map<string, (event: unknown) => void>();
  class FakeWebSocket {
    static OPEN = 1;
    readyState = 1;
    addEventListener(type: string, listener: (event: unknown) => void) { listeners.set(type, listener); }
    send(data: string) { sent.push(data); }
    close() { this.readyState = 3; }
  }
  const originalWebSocket = globalThis.WebSocket;
  Object.defineProperty(globalThis, 'WebSocket', { configurable: true, value: FakeWebSocket });
  Object.defineProperty(runtime, 'apiForSession', { configurable: true, value: async () => ({
    baseUrl: 'http://127.0.0.1:9555', createRealtimeTicket: async () => ({ data: { ticket: 'synthetic-ticket' } }),
  }) });
  const fakeCtx = {
    logger: { info() {}, debug() {}, warn() {} },
    interval: () => () => {},
    on: () => () => {},
    agents: {},
  } as unknown as Context;
  const worker = new YutangWorker(fakeCtx, runtime, await laneOf(runtime));
  (worker as unknown as { lastWorkerError?: string }).lastWorkerError = 'connect ECONNREFUSED 127.0.0.1:9555';
  try {
    await worker.start();
    listeners.get('open')?.({});
    assert.deepEqual(sent.map(value => JSON.parse(value)), [{ type: 'subscribe', inbox: false, jury: false, active_jury: false }]);
    assert.equal(worker.status().realtime, 'connected');
    assert.equal(worker.status().last_error, undefined, 'a recovered realtime connection clears the stale transport error');
  } finally {
    await worker.dispose();
    Object.defineProperty(globalThis, 'WebSocket', { configurable: true, value: originalWebSocket });
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('Worker runs scheduled tasks in a fresh session linked to the selected DSH session', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'dsh-yutang-worker-'));
  const runtime = new YutangRuntime(new StateStore(dataDir, 'http://127.0.0.1:9555'), 'http://127.0.0.1:9555', asCredentialProvider());
  await runtime.store.load();
  await runtime.updateSettings({ social_mode: 'auto', browse_schedule_mode: 'hourly', scheduled_session_id: 'session-user-selected' });

  const selectedSession = { id: SessionId('session-user-selected') };
  const workerSession = { id: SessionId('yutang-worker-isolated-test') };
  const listeners = new Set<(sourceSession: typeof workerSession, event: { type: string; data: { turn: number; reason: { kind: string } } }) => void>();
  const observed: { flushes: number; disposed: number; followups: number; summaries: number; parentSession?: string } = { flushes: 0, disposed: 0, followups: 0, summaries: 0 };
  const selectedHistory = {
    id: selectedSession.id,
    append(type: string, message: { content?: Array<{ type: string; text?: string }> }) {
      assert.equal(type, 'user/message');
      assert.match(message.content?.[0]?.text ?? '', /任务上下文已与此会话历史隔离/u);
      observed.summaries += 1;
    },
  };
  const selectedAgent = { id: selectedSession.id, session: selectedHistory, status: 'idle' } as unknown as Agent;
  let agentStatus = 'idle';
  const agent = {
    get id() { return workerSession.id; },
    get session() { return workerSession; },
    get status() { return agentStatus; },
    followup() {
      observed.followups += 1;
      assert.equal(runtime.workerTaskId(String(workerSession.id)), 'browse:channel-1:1:3');
      assert.notEqual(String(workerSession.id), String(selectedSession.id), 'the worker must never run in the selected session');
      assert.equal(runtime.workerSendAllowed(String(workerSession.id), 'channel-1'), true);
      assert.equal(runtime.consumeWorkerSend(String(workerSession.id), 'channel-1', 'pending'), true);
      assert.equal(runtime.consumeWorkerSend(String(workerSession.id), 'channel-1', 'pending'), false);
      runtime.setWorkerReply(String(workerSession.id), 'message-reply-1');
      queueMicrotask(() => {
        for (const listener of listeners) listener(workerSession, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } });
      });
    },
    cancel() { agentStatus = 'idle'; },
    whenIdle: async () => {},
  } as unknown as Agent;
  const fakeCtx = {
    logger: { warn() {} },
    interval: () => () => {},
    on(name: string, listener: (sourceSession: typeof workerSession, event: { type: string; data: { turn: number; reason: { kind: string } } }) => void) {
      assert.equal(name, 'session/event');
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    sessionPersistence: { stat: async () => ({ header: { id: selectedSession.id, origin: undefined } }) },
    sessions: { flush: async () => { observed.flushes += 1; return true; } },
    agents: {
      get: (id: string) => id === String(selectedSession.id) ? selectedAgent : undefined,
      create: async ({ meta }: { meta?: { parentSession?: string } }) => {
        observed.parentSession = String(meta?.parentSession);
        return { agent, dispose: async () => { observed.disposed += 1; } };
      },
      turnBoundaryOf: () => ({ lastTurn: 0 }),
    },
  } as unknown as Context;

  const worker = new YutangWorker(fakeCtx, runtime, await laneOf(runtime));
  try {
    const runTask = (worker as unknown as { runTask(taskId: string, channelId: string, source: 'browse', prompt: string): Promise<{ processed: boolean; replyMessageId?: string }> }).runTask.bind(worker);
    const outcome = await runTask('browse:channel-1:1:3', 'channel-1', 'browse', 'synthetic public messages');
    assert.deepEqual(outcome, { processed: true, replyMessageId: 'message-reply-1' });
    assert.equal(observed.flushes, 2, 'flush the isolated task session and the selected-session summary');
    assert.equal(observed.followups, 1);
    assert.equal((await runtime.state()).settings.scheduled_session_id, selectedSession.id);
    assert.equal(runtime.workerTaskId(String(workerSession.id)), undefined);
    assert.equal(observed.parentSession, String(selectedSession.id));
    assert.equal(observed.disposed, 1);
    assert.equal(observed.summaries, 1);
  } finally {
    await worker.dispose();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('Worker validates a stored selected session without resuming its private history', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'dsh-yutang-worker-resume-'));
  const runtime = new YutangRuntime(new StateStore(dataDir, 'http://127.0.0.1:9555'), 'http://127.0.0.1:9555', asCredentialProvider());
  await runtime.updateSettings({ scheduled_session_id: 'session-persisted' });
  const session = { id: SessionId('session-persisted') };
  const fakeCtx = {
    logger: { warn() {} },
    interval: () => () => {},
    on: () => () => {},
    sessionPersistence: { stat: async () => ({ header: { id: session.id, origin: undefined } }) },
    agents: {
      get: () => undefined,
      resume: async () => { throw new Error('the selected private session must never be resumed'); },
    },
  } as unknown as Context;

  const worker = new YutangWorker(fakeCtx, runtime, await laneOf(runtime));
  try {
    const ensureBoundSession = (worker as unknown as { ensureBoundSession(): Promise<string> }).ensureBoundSession.bind(worker);
    assert.equal(await ensureBoundSession(), 'session-persisted');
  } finally {
    await worker.dispose();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('turning off mention automation aborts lease renewal and completes the claimed event as skipped', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'dsh-yutang-worker-off-'));
  const runtime = new YutangRuntime(new StateStore(dataDir, 'http://127.0.0.1:9555'), 'http://127.0.0.1:9555', asCredentialProvider());
  await runtime.store.update({ identity: {
    owner_id: 'user_test', agent_id: 'agent_test', display_name: 'Synthetic', public_key: 'synthetic', scopes: [],
  } });
  await runtime.updateSettings({ social_mode: 'auto', mention_wakeup_enabled: true, scheduled_session_id: 'session-mention' });
  let listener: ((sourceSession: { id: ReturnType<typeof SessionId> }, event: { type: string; data: { turn: number; reason: { kind: string } } }) => void) | undefined;
  const fakeCtx = {
    logger: { warn() {} },
    interval: () => () => {},
    on(_name: string, next: typeof listener) { listener = next; return () => { listener = undefined; }; },
    sessionPersistence: { stat: async () => undefined },
    sessions: { flush: async () => true },
    agents: {},
  } as unknown as Context;
  const worker = new YutangWorker(fakeCtx, runtime, await laneOf(runtime));
  let rejectTask!: (error: Error) => void;
  const session = { id: SessionId('worker-mention-test') };
  const agent = {
    id: session.id,
    session,
    status: 'running',
    cancel() { rejectTask(new Error('canceled by settings')); },
    whenIdle: async () => {},
  } as unknown as Agent;
  const internal = worker as unknown as {
    taskAgent?: Agent;
    processMention(api: unknown, event: unknown): Promise<void>;
    runTask(...args: unknown[]): Promise<{ replyMessageId?: string }>;
    stopActiveMentionLease?: () => void;
  };
  internal.taskAgent = agent;
  internal.runTask = () => new Promise((_resolve, reject) => { rejectTask = reject; });
  let completedResult: string | undefined;
  let renewalSignal: AbortSignal | undefined;
  let renewalTick: (() => void) | undefined;
  const originalSetInterval = globalThis.setInterval;
  globalThis.setInterval = ((callback: TimerHandler, delay?: number, ...args: unknown[]) => {
    if (delay === 120_000) {
      renewalTick = callback as () => void;
      return originalSetInterval(() => {}, delay);
    }
    return originalSetInterval(callback, delay, ...args);
  }) as typeof setInterval;
  const api = {
    renewInboxLease: async (_id: string, _token: string, _seconds: number, options: { signal: AbortSignal }) => { renewalSignal = options.signal; },
    completeInboxEvent: async (_id: string, input: { result: string }) => { completedResult = input.result; },
  };
  const event = {
    id: 'inbox-test', type: 'message.mentioned', channel_id: 'channel-test', topic_id: 'topic-test',
    message: { id: 'message-test', content: 'synthetic', sender: { id: 'agent-sender', name: 'Synthetic' } },
    lease_token: 'synthetic-lease', lease_expires_at: new Date(Date.now() + 60_000).toISOString(), attempt: 1,
  };
  try {
    const processing = internal.processMention(api, event);
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(typeof internal.stopActiveMentionLease, 'function');
    renewalTick?.();
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.ok(renewalSignal);
    await runtime.updateSettings({ social_mode: 'off' });
    await processing;
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(completedResult, 'skipped', 'policy cancellation must close the lease instead of scheduling a retry');
    assert.equal(renewalSignal!.aborted, true, 'mode changes abort any in-flight renewal request');
  } finally {
    globalThis.setInterval = originalSetInterval;
    await worker.dispose();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('Worker disposal stops lease renewal and keeps terminal event listener active through Agent disposal', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'dsh-yutang-worker-dispose-'));
  const runtime = new YutangRuntime(new StateStore(dataDir, 'http://127.0.0.1:9555'), 'http://127.0.0.1:9555', asCredentialProvider());
  await runtime.store.load();
  let listenerActive = false;
  let cancelCalled = false;
  let renewalStopped = false;
  const session = { id: SessionId('worker-dispose-test') };
  let listener: ((sourceSession: typeof session, event: { type: string; data: { turn: number; reason: { kind: string } } }) => void) | undefined;
  const fakeCtx = {
    logger: { warn() {} },
    interval: () => () => {},
    on() { listenerActive = true; listener = () => {}; return () => { listenerActive = false; }; },
  } as unknown as Context;
  const worker = new YutangWorker(fakeCtx, runtime, await laneOf(runtime));
  const agent = {
    id: session.id,
    session,
    status: 'running',
    cancel() { cancelCalled = true; },
    whenIdle: async () => {},
  } as unknown as Agent;
  const internal = worker as unknown as {
    taskAgent?: Agent;
    stopActiveMentionLease?: () => void;
  };
  internal.taskAgent = agent;
  internal.stopActiveMentionLease = () => { renewalStopped = true; };
  try {
    await worker.dispose();
    assert.equal(renewalStopped, true);
    assert.equal(cancelCalled, true);
    assert.equal(listenerActive, false);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});
