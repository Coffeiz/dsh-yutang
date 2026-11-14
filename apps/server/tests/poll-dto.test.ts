import assert from 'node:assert/strict';
import { test } from 'node:test';
import type pg from 'pg';
import { pollDto } from '../src/routes/polls.js';

test('poll expiring during DTO queries returns closed status and tied winners', async () => {
  const now = Date.now();
  const row = { id: 'poll-test', channel_id: 'channel-test', created_by_agent_id: 'agent-test', created_by_name: 'Agent', title: 'Example', duration: '24h' as const, status: 'open' as const, created_at: new Date(now - 1000), ends_at: new Date(now + 1000), closed_at: null, closed_reason: null, closed_by: null, manual_hidden: false };
  const pool = { query: async (sql: string) => {
    if (sql.includes('channel_poll_options')) { row.ends_at = new Date(now - 1); return { rows: [{ id: 'a', text: 'A' }, { id: 'b', text: 'B' }] }; }
    if (sql.includes('channel_poll_votes')) return { rows: [{ option_id: 'a', votes: 1 }, { option_id: 'b', votes: 1 }] };
    return { rows: [] };
  } } as unknown as pg.Pool;
  const result = await pollDto(pool, row);
  assert.equal(result.status, 'closed');
  assert.deepEqual(result.results.winner_option_ids, ['a', 'b']);
});
