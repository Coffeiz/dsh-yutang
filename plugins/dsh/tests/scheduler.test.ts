import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { activeConnection, CURIOSITY_THRESHOLD, StateStore } from '../src/storage/state.js';
import { YutangRuntime } from '../src/service/runtime.js';
import { createYutangRpc } from '../src/transport/rpc.js';
import { asCredentialProvider } from './helpers/credentials.js';

test('schedule settings validate daily local time and persist the selected mode', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'dsh-yutang-schedule-settings-'));
  try {
    const runtime = new YutangRuntime(new StateStore(dataDir, 'http://127.0.0.1:9555'), 'http://127.0.0.1:9555', asCredentialProvider());
    await runtime.updateSettings({ browse_schedule_mode: 'daily', daily_browse_time: '18:30' });
    const settings = (await runtime.state()).settings;
    assert.equal(settings.browse_schedule_mode, 'daily');
    assert.equal(settings.daily_browse_time, '18:30');
    assert.equal(settings.auto_browse_enabled, true, 'legacy toggle stays in sync with the selected mode');
    await assert.rejects(runtime.updateSettings({ daily_browse_time: '25:00' }), /24 小时制/u);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('settings status exposes the current connection curiosity value to the settings client', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'dsh-yutang-curiosity-status-'));
  try {
    const runtime = new YutangRuntime(new StateStore(dataDir, 'http://127.0.0.1:9555'), 'http://127.0.0.1:9555', asCredentialProvider());
    const state = await runtime.state();
    await runtime.store.updateConnection(activeConnection(state).id, {
      curiosity_points: 17,
      curiosity_last_roll_value: 8,
      curiosity_last_roll_at: 1_800_000_000_000,
      curiosity_next_roll_at: 1_800_003_600_000,
    });
    const result = await createYutangRpc(runtime, {} as never)('status', {}, AbortSignal.timeout(1_000), {} as never);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    const value = result.value as { browse_state: { curiosity_points: number; curiosity_threshold: number; curiosity_last_roll_value: number; curiosity_next_roll_at: number; time_zone: string } };
    assert.equal(value.browse_state.curiosity_points, 17);
    assert.equal(value.browse_state.curiosity_threshold, 30);
    assert.equal(value.browse_state.curiosity_last_roll_value, 8);
    assert.equal(value.browse_state.curiosity_next_roll_at, 1_800_003_600_000);
    assert.ok(value.browse_state.time_zone);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('session picker matches DSH titles and omits archived sessions', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'dsh-yutang-session-picker-'));
  try {
    const runtime = new YutangRuntime(new StateStore(dataDir, 'http://127.0.0.1:9555'), 'http://127.0.0.1:9555', asCredentialProvider());
    const id = 'session_picker_live';
    const coldId = 'session_picker_cold';
    const archivedId = 'session_picker_archived';
    const archivedProjectionId = 'session_picker_archived_projection';
    const archivedFlagId = 'session_picker_archived_flag';
    const blankId = 'session_picker_blank';
    const unavailableId = 'session_picker_unavailable';
    const liveAgent = { id, status: 'idle' };
    const records = [
      { sessionId: id, updatedAt: 1_800_000_000_000, blank: false, projections: { values: { title: '缓存的标题' } } },
      { sessionId: coldId, updatedAt: 1_799_999_000_000, blank: false, projections: { values: { title: '导航栏归档前会话名' } } },
      { sessionId: archivedId, updatedAt: 1_799_998_000_000, blank: false },
      { sessionId: archivedProjectionId, updatedAt: 1_799_997_500_000, blank: false, projections: { values: { sessionListMetadata: { archived: true } } } },
      { sessionId: archivedFlagId, updatedAt: 1_799_997_250_000, blank: false, archived: true },
      { sessionId: blankId, updatedAt: 1_799_997_000_000, blank: true },
      { sessionId: unavailableId, updatedAt: 1_799_996_000_000, blank: false, origin: 'subagent' as const },
    ];
    const ctx = {
      sessionPersistence: { stat: async () => undefined },
      sessionController: { list: async () => ({ items: records }) },
      agents: { list: () => [liveAgent] },
      sessions: { get: (sessionId: string) => sessionId === id ? ({ id }) : undefined },
      sessionTitle: { get: () => ({ title: '导航栏实时会话名' }) },
      sessionProjections: { snapshot: () => ({ values: { sessionListMetadata: { blank: false } } }) },
      workspaceRegistry: { archivedSessionIds: [archivedId] },
    } as never;
    const result = await createYutangRpc(runtime, ctx)('sessions/list', {}, AbortSignal.timeout(1_000), {} as never);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    const value = result.value as { sessions: Array<{ id: string; title: string; updated_at: number; running: boolean; workspace?: string }> };
    assert.deepEqual(value.sessions, [
      { id, title: '导航栏实时会话名', updated_at: 1_800_000_000_000, live: true, running: false },
      { id: coldId, title: '导航栏归档前会话名', updated_at: 1_799_999_000_000, live: false, running: false },
    ]);
    assert.equal('workspace' in value.sessions[0]!, false);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('older Profile settings map the legacy auto browse toggle to a schedule mode', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'dsh-yutang-schedule-migration-'));
  try {
    const path = join(dataDir, 'state.json');
    const connection = { id: 'custom-old', kind: 'custom', name: 'Old', server_url: 'http://127.0.0.1:9555' };
    await writeFile(path, JSON.stringify({
      version: 4,
      active_server_id: 'custom-old',
      servers: [connection],
      settings: { social_mode: 'auto', auto_browse_enabled: true, poll_interval_minutes: 10 },
      turn_tool_locks: {},
    }));
    const settings = (await new StateStore(dataDir, 'http://127.0.0.1:9555').load()).settings;
    assert.equal(settings.browse_schedule_mode, 'hourly');
    assert.equal(settings.daily_browse_time, '09:00');
    assert.equal(settings.auto_browse_enabled, true);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('hourly browse is claimed once per due interval and skips missed intervals', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'dsh-yutang-hourly-schedule-'));
  try {
    const store = new StateStore(dataDir, 'http://127.0.0.1:9555');
    const connection = activeConnection(await store.load());
    const start = 1_800_000_000_000;
    assert.equal(await store.claimHourlyBrowse(connection.id, start), false, 'first call establishes the first due time');
    assert.equal(await store.claimHourlyBrowse(connection.id, start + 59 * 60_000), false);
    assert.equal(await store.claimHourlyBrowse(connection.id, start + 60 * 60_000), true);
    assert.equal(await store.claimHourlyBrowse(connection.id, start + 60 * 60_000), false, 'same due hour is claimed once');
    assert.equal(await store.claimHourlyBrowse(connection.id, start + 8 * 60 * 60_000), true, 'downtime produces one run, not a backlog');
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('daily browse honors host local time and runs once per local calendar day', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'dsh-yutang-daily-schedule-'));
  try {
    const store = new StateStore(dataDir, 'http://127.0.0.1:9555');
    const connection = activeConnection(await store.load());
    const before = new Date(2026, 10, 6, 8, 59).getTime();
    const due = new Date(2026, 10, 6, 9, 0).getTime();
    const nextDay = new Date(2026, 10, 7, 9, 0).getTime();
    assert.equal(await store.claimDailyBrowse(connection.id, before, '09:00'), false);
    assert.equal(await store.claimDailyBrowse(connection.id, due, '09:00'), true);
    assert.equal(await store.claimDailyBrowse(connection.id, due + 60_000, '09:00'), false);
    assert.equal(await store.claimDailyBrowse(connection.id, nextDay, '09:00'), true);
    await assert.rejects(store.claimDailyBrowse(connection.id, nextDay, '25:00'), /时间无效/u);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('curiosity rolls a 1d10 once per due time, spends the threshold, and persists its value', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'dsh-yutang-curiosity-'));
  try {
    const store = new StateStore(dataDir, 'http://127.0.0.1:9555');
    const connection = activeConnection(await store.load());
    const other = await store.addCustomServer('Other', 'http://127.0.0.1:9556');
    const now = Date.now();
    await store.updateConnection(connection.id, { curiosity_points: CURIOSITY_THRESHOLD - 5, curiosity_next_roll_at: now });
    const [roll, competingRoll] = await Promise.all([
      store.rollCuriosityIfDue(connection.id, now + 1, 7),
      store.rollCuriosityIfDue(connection.id, now + 1, 7),
    ]);
    const winner = roll.rolled ? roll : competingRoll;
    const loser = roll.rolled ? competingRoll : roll;
    assert.deepEqual(winner, { rolled: true, value: 7, points: 2, triggered: true, nextRollAt: now + 1 + 60 * 60 * 1000 });
    assert.equal(loser.rolled, false, 'concurrent ticks cannot roll twice for one due time');
    await store.updateConnection(other.id, { curiosity_points: 14 });
    const reloaded = new StateStore(dataDir, 'http://127.0.0.1:9555');
    const restoredState = await reloaded.load();
    const restored = activeConnection(restoredState);
    assert.equal(restored.curiosity_points, 2);
    assert.equal(restored.curiosity_last_roll_value, 7);
    assert.equal(restored.curiosity_last_roll_at, now + 1);
    assert.equal(restoredState.servers.find(server => server.id === other.id)?.curiosity_points, 14, 'curiosity is isolated per Server connection');
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});
