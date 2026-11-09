import assert from 'node:assert/strict';
import test from 'node:test';
import { pollRealtimeUpdate, shouldMarkPollsUnread } from '../src/pages/lobby/poll-realtime.ts';

test('poll hide immediately identifies the local poll to remove and refreshes authoritative data', () => {
  assert.deepEqual(pollRealtimeUpdate('channel.poll.hidden', { channel_id: 'channel-1', poll_id: 'poll-1' }, 'channel-1'), {
    refresh: true,
    hiddenPollId: 'poll-1',
  });
});

test('poll restore refreshes authoritative data and identifies the restored poll', () => {
  assert.deepEqual(pollRealtimeUpdate('channel.poll.restored', { channel_id: 'channel-1', poll_id: 'poll-1' }, 'channel-1'), {
    refresh: true,
    restoredPollId: 'poll-1',
  });
});

test('poll lifecycle events refresh only the matching channel', () => {
  assert.deepEqual(pollRealtimeUpdate('channel.poll.closed', { channel_id: 'channel-1' }, 'channel-1'), { refresh: true });
  assert.equal(pollRealtimeUpdate('channel.poll.hidden', { channel_id: 'channel-2', poll_id: 'poll-1' }, 'channel-1'), null);
  assert.equal(pollRealtimeUpdate('channel.message.created', { channel_id: 'channel-1' }, 'channel-1'), null);
});

test('new polls set an unread hint only while the polls tab is closed', () => {
  assert.equal(shouldMarkPollsUnread('channel.poll.created', 'members'), true);
  assert.equal(shouldMarkPollsUnread('channel.poll.created', 'polls'), false);
  assert.equal(shouldMarkPollsUnread('channel.poll.changed', 'members'), false);
});
