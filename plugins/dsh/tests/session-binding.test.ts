import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { bindingOf, boundSessions, connectionForSession, StateStore } from '../src/storage/state.js';

const identity = (agentId: string, displayName: string) => ({
  owner_id: 'owner-1',
  agent_id: agentId,
  display_name: displayName,
  public_key: `public-key-${agentId}`,
  scopes: [],
});

const connection = (id: string, agentId: string | null, displayName: string) => ({
  id,
  kind: 'custom' as const,
  name: displayName,
  server_url: 'http://127.0.0.1:9555',
  identity: agentId ? identity(agentId, displayName) : null,
  pending_registration: null,
  worker_session_id: null,
  active_jury_request_day: null,
  read_cursors: {},
  browse_channel_cursor_id: null,
  browse_next_run_at: null,
  last_daily_browse_date: null,
  curiosity_points: 0,
  curiosity_next_roll_at: null,
  curiosity_last_roll_at: null,
  curiosity_last_roll_value: null,
});

const writeState = async (dataDir: string, value: Record<string, unknown>) => {
  await writeFile(join(dataDir, 'state.json'), JSON.stringify(value, null, 2), { mode: 0o600 });
};

test('a v6 profile keeps its single background worker as the first Session binding', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'dsh-yutang-binding-migrate-'));
  try {
    await writeState(dataDir, {
      version: 6,
      active_server_id: 'custom-a',
      servers: [connection('custom-a', 'agent-a', '阿陈')],
      settings: {
        social_mode: 'auto',
        mention_wakeup_enabled: true,
        browse_schedule_mode: 'daily',
        daily_browse_time: '09:30',
        scheduled_session_id: 'session-alpha',
      },
    });
    const store = new StateStore(dataDir, 'http://127.0.0.1:9555');
    const state = await store.load();
    assert.equal(state.version, 7);
    assert.deepEqual(state.session_bindings, {
      'session-alpha': {
        connection_id: 'custom-a',
        mention_wakeup_enabled: true,
        browse_schedule_mode: 'daily',
        daily_browse_time: '09:30',
        loop_interval_seconds: 60,
      },
    });
    const persisted = JSON.parse(await readFile(join(dataDir, 'state.json'), 'utf8')) as Record<string, unknown>;
    assert.equal(persisted.version, 7, 'migration is written back to disk');
    assert.ok(persisted.session_bindings, 'v7 file carries the binding table');
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('each bound Session resolves to its own Connection identity', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'dsh-yutang-binding-resolve-'));
  try {
    await writeState(dataDir, {
      version: 7,
      active_server_id: 'custom-a',
      session_bindings: {},
      servers: [connection('custom-a', 'agent-a', '阿陈'), connection('custom-b', 'agent-b', '阿蛮')],
      settings: { social_mode: 'auto', scheduled_session_id: null },
    });
    const store = new StateStore(dataDir, 'http://127.0.0.1:9555');
    await store.bindSession('session-alpha', 'custom-a', { mention_wakeup_enabled: true });
    await store.bindSession('session-beta', 'custom-b', { browse_schedule_mode: 'hourly' });

    const state = await store.load();
    assert.equal(connectionForSession(state, 'session-alpha').identity?.agent_id, 'agent-a');
    assert.equal(connectionForSession(state, 'session-beta').identity?.agent_id, 'agent-b');
    assert.equal(connectionForSession(state, 'session-unbound').identity?.agent_id, 'agent-a', 'unbound Sessions fall back to the active Connection');
    assert.equal(bindingOf(state, 'session-beta')?.browse_schedule_mode, 'hourly');
    assert.equal(boundSessions(state).length, 2);

    // Binding a Session again only rewrites the fields that were passed.
    await store.bindSession('session-alpha', 'custom-a', { daily_browse_time: '21:15' });
    const rebound = bindingOf(await store.load(), 'session-alpha');
    assert.equal(rebound?.mention_wakeup_enabled, true);
    assert.equal(rebound?.daily_browse_time, '21:15');

    await store.updateSessionBinding('session-beta', { browse_schedule_mode: 'off' });
    assert.equal(bindingOf(await store.load(), 'session-beta')?.browse_schedule_mode, 'off');

    assert.equal(await store.unbindSession('session-beta'), true);
    assert.equal(await store.unbindSession('session-beta'), false);
    assert.equal(bindingOf(await store.load(), 'session-beta'), undefined);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('bindings pointing at unknown Connections or with invalid values are dropped on load', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'dsh-yutang-binding-invalid-'));
  try {
    await writeState(dataDir, {
      version: 7,
      active_server_id: 'custom-a',
      session_bindings: {
        'session-good': { connection_id: 'custom-b', mention_wakeup_enabled: true, browse_schedule_mode: 'curiosity', daily_browse_time: '07:05' },
        'session-ghost': { connection_id: 'custom-ghost', mention_wakeup_enabled: true },
        'session-bad-time': { connection_id: 'custom-a', browse_schedule_mode: 'never', daily_browse_time: '25:61' },
        '': { connection_id: 'custom-a' },
      },
      servers: [connection('custom-a', 'agent-a', '阿陈'), connection('custom-b', 'agent-b', '阿蛮')],
      settings: { social_mode: 'auto', scheduled_session_id: null },
    });
    const store = new StateStore(dataDir, 'http://127.0.0.1:9555');
    const state = await store.load();
    assert.deepEqual(Object.keys(state.session_bindings).sort(), ['session-bad-time', 'session-good']);
    assert.equal(state.session_bindings['session-bad-time']?.browse_schedule_mode, 'off');
    assert.equal(state.session_bindings['session-bad-time']?.daily_browse_time, '09:00');
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('removing a Connection also drops the Sessions bound to it', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'dsh-yutang-binding-drop-'));
  try {
    await writeState(dataDir, {
      version: 7,
      active_server_id: 'custom-a',
      session_bindings: {},
      servers: [connection('custom-a', 'agent-a', '阿陈'), connection('custom-b', null, '待注册服务器')],
      settings: { social_mode: 'auto', scheduled_session_id: null },
    });
    const store = new StateStore(dataDir, 'http://127.0.0.1:9555');
    await store.bindSession('session-alpha', 'custom-a');
    await store.bindSession('session-beta', 'custom-b');
    await store.removeServer('custom-b');
    const state = await store.load();
    assert.deepEqual(Object.keys(state.session_bindings), ['session-alpha']);
    assert.equal(connectionForSession(state, 'session-beta').id, 'custom-a', 'a dropped binding degrades to the active Connection');
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});
