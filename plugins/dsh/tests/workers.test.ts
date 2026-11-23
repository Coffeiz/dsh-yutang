import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { Context } from '@deepseek-ai/cordis';
import { YutangRuntime } from '../src/service/runtime.js';
import { StateStore, activeConnection } from '../src/storage/state.js';
import { YutangWorkers } from '../src/worker/workers.js';
import { asCredentialProvider } from './helpers/credentials.js';

const fakeContext = () => ({
  logger: { info() {}, debug() {}, warn() {} },
  interval: () => () => {},
  on: () => () => {},
  agents: { get: () => undefined, create: async () => { throw new Error('no agent in this test'); } },
  sessionPersistence: { stat: async () => undefined },
  sessions: { flush: async () => true },
} as unknown as Context);

test('supervisor runs one lane per bound Session and drops lanes that are unbound', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'dsh-yutang-lanes-'));
  const runtime = new YutangRuntime(new StateStore(dataDir, 'http://127.0.0.1:9555'), 'http://127.0.0.1:9555', asCredentialProvider());
  await runtime.store.load();
  await runtime.updateSettings({ social_mode: 'manual' });
  const connectionId = activeConnection(await runtime.state()).id;
  await runtime.store.bindSession('session-alpha', connectionId);
  await runtime.store.bindSession('session-beta', connectionId);

  const asked: Array<string | undefined> = [];
  Object.defineProperty(runtime, 'apiForSession', {
    configurable: true,
    value: async (sessionId?: string) => {
      asked.push(sessionId);
      return {
        baseUrl: 'http://127.0.0.1:9555',
        createRealtimeTicket: async () => { throw new Error('realtime disabled in this test'); },
      };
    },
  });

  const workers = new YutangWorkers(fakeContext(), runtime);
  try {
    await workers.start();
    const lanes = workers.statuses();
    assert.deepEqual(lanes.map(lane => lane.session_id).sort(), ['session-alpha', 'session-beta']);
    assert.ok(lanes.every(lane => lane.server_id === connectionId), 'every lane points at its own binding connection');

    await runtime.store.unbindSession('session-beta');
    await workers.reconcile();
    assert.deepEqual(workers.statuses().map(lane => lane.session_id), ['session-alpha']);
  } finally {
    await workers.dispose();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('a Session added to the binding table starts its own lane without disturbing the others', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'dsh-yutang-lanes-add-'));
  const runtime = new YutangRuntime(new StateStore(dataDir, 'http://127.0.0.1:9555'), 'http://127.0.0.1:9555', asCredentialProvider());
  await runtime.store.load();
  await runtime.updateSettings({ social_mode: 'manual' });
  const connectionId = activeConnection(await runtime.state()).id;
  await runtime.store.bindSession('session-first', connectionId);
  Object.defineProperty(runtime, 'apiForSession', {
    configurable: true,
    value: async () => ({ baseUrl: 'http://127.0.0.1:9555', createRealtimeTicket: async () => { throw new Error('realtime disabled in this test'); } }),
  });

  const workers = new YutangWorkers(fakeContext(), runtime);
  try {
    await workers.start();
    assert.deepEqual(workers.statuses().map(lane => lane.session_id), ['session-first']);

    await runtime.store.bindSession('session-second', connectionId);
    await runtime.refreshWorkerSettings();
    assert.deepEqual(workers.statuses().map(lane => lane.session_id).sort(), ['session-first', 'session-second']);
  } finally {
    await workers.dispose();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('disposal stops every lane and leaves no worker registered', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'dsh-yutang-lanes-dispose-'));
  const runtime = new YutangRuntime(new StateStore(dataDir, 'http://127.0.0.1:9555'), 'http://127.0.0.1:9555', asCredentialProvider());
  await runtime.store.load();
  await runtime.updateSettings({ social_mode: 'manual' });
  const connectionId = activeConnection(await runtime.state()).id;
  await runtime.store.bindSession('session-gone', connectionId);
  Object.defineProperty(runtime, 'apiForSession', {
    configurable: true,
    value: async () => ({ baseUrl: 'http://127.0.0.1:9555', createRealtimeTicket: async () => { throw new Error('realtime disabled in this test'); } }),
  });

  const workers = new YutangWorkers(fakeContext(), runtime);
  await workers.start();
  assert.equal(workers.statuses().length, 1);
  await workers.dispose();
  assert.equal(workers.statuses().length, 0);
  assert.equal(runtime.workerStatus().worker, 'stopped');
  await rm(dataDir, { recursive: true, force: true });
});
