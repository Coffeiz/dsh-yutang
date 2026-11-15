import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { LOOP_BROWSE_DEFAULT_SECONDS, StateStore } from '../src/storage/state.js';

const identity = (agentId: string) => ({
  owner_id: 'owner-1',
  agent_id: agentId,
  display_name: agentId,
  public_key: `public-key-${agentId}`,
  scopes: [],
});

const connection = (id: string, agentId: string) => ({
  id,
  kind: 'custom' as const,
  name: agentId,
  server_url: 'http://127.0.0.1:9555',
  identity: identity(agentId),
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

const setup = async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'dsh-yutang-loop-'));
  await writeFile(join(dataDir, 'state.json'), JSON.stringify({
    version: 7,
    active_server_id: 'lane-a',
    session_bindings: {},
    servers: [connection('lane-a', 'agent-a'), connection('lane-b', 'agent-b')],
    settings: { social_mode: 'auto', scheduled_session_id: null },
  }, null, 2), { mode: 0o600 });
  return { dataDir, store: new StateStore(dataDir, 'http://127.0.0.1:9555') };
};

test('loop browse seeds a phase offset before the first round fires', async () => {
  const { dataDir, store } = await setup();
  try {
    const now = 1_700_000_000_000;
    assert.equal(await store.claimLoopBrowse('lane-a', 'session-a', now, 30, 12_000), false, 'first call only schedules');
    const seeded = (await store.load()).servers.find(server => server.id === 'lane-a')!;
    assert.equal(seeded.loop_browse_next_run_at?.['session-a'], now + 12_000);
    assert.equal(await store.claimLoopBrowse('lane-a', 'session-a', now + 11_000, 30, 12_000), false, 'still before the phase offset');
    assert.equal(await store.claimLoopBrowse('lane-a', 'session-a', now + 12_000, 30, 12_000), true, 'fires once the offset is reached');
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('an interval later is refused until the next interval elapses', async () => {
  const { dataDir, store } = await setup();
  try {
    const now = 1_700_000_000_000;
    await store.claimLoopBrowse('lane-a', 'session-a', now, 25, 0);
    assert.equal(await store.claimLoopBrowse('lane-a', 'session-a', now + 1, 25, 0), true);
    assert.equal(await store.claimLoopBrowse('lane-a', 'session-a', now + 20_000, 25, 0), false, 'inside the same interval');
    assert.equal(await store.claimLoopBrowse('lane-a', 'session-a', now + 26_000, 25, 0), true, 'next interval is due');
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('lanes keep separate loop schedules and out-of-range intervals fall back to the default', async () => {
  const { dataDir, store } = await setup();
  try {
    const now = 1_700_000_000_000;
    await store.claimLoopBrowse('lane-a', 'session-a', now, 5, 0);
    assert.equal(await store.claimLoopBrowse('lane-a', 'session-a', now + 1, 5, 0), true, 'an interval below the floor becomes the default');
    await store.claimLoopBrowse('lane-a', 'session-b', now, 60, 0);
    assert.equal(await store.claimLoopBrowse('lane-a', 'session-b', now + 1, 60, 0), true, 'another lane on the same connection has an independent schedule');
    const laneA = (await store.load()).servers.find(server => server.id === 'lane-a')!;
    assert.equal(laneA.loop_browse_next_run_at?.['session-a'], now + 1 + LOOP_BROWSE_DEFAULT_SECONDS * 1000);
    assert.equal(laneA.loop_browse_next_run_at?.['session-b'], now + 1 + 60_000);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('loop intervals are normalised when a Session binding is written', async () => {
  const { dataDir, store } = await setup();
  try {
    await store.bindSession('session-a', 'lane-a', { browse_schedule_mode: 'loop', loop_interval_seconds: 45 });
    await store.bindSession('session-b', 'lane-b', { browse_schedule_mode: 'loop', loop_interval_seconds: 2 });
    const state = await store.load();
    assert.equal(state.session_bindings['session-a']?.loop_interval_seconds, 45);
    assert.equal(state.session_bindings['session-b']?.loop_interval_seconds, LOOP_BROWSE_DEFAULT_SECONDS, 'too small is clamped to the default');
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('loop lane deadlines survive StateStore restart', async () => {
  const { dataDir, store } = await setup();
  try {
    const now = 1_700_000_000_000;
    await store.claimLoopBrowse('lane-a', 'session-a', now, 60, 0);
    const restarted = new StateStore(dataDir, 'http://127.0.0.1:9555');
    assert.equal(await restarted.claimLoopBrowse('lane-a', 'session-a', now + 30_000, 60, 0), false);
    assert.equal(await restarted.claimLoopBrowse('lane-a', 'session-a', now + 60_000, 60, 0), true);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});
