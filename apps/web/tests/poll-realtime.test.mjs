import assert from 'node:assert/strict';
import test from 'node:test';
import { addHiddenPollMask, pollRealtimeUpdate, reconcileHiddenPollsAfterSync, removeHiddenPollMask, shouldClearPollsUnread, shouldMarkPollsUnread } from '../src/pages/lobby/poll-realtime.ts';

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
  assert.equal(shouldMarkPollsUnread('channel.poll.created', 'members', true), true);
  assert.equal(shouldMarkPollsUnread('channel.poll.created', 'polls', true), false);
  assert.equal(shouldMarkPollsUnread('channel.poll.created', 'polls', false), true);
  assert.equal(shouldMarkPollsUnread('channel.poll.changed', 'members', true), false);
});

test('poll unread clears only when the polls panel is actually visible', () => {
  assert.equal(shouldClearPollsUnread('polls', true), true);
  assert.equal(shouldClearPollsUnread('polls', false), false);
  assert.equal(shouldClearPollsUnread('members', true), false);
});

test('hidden poll masks retain multiple ids per channel until authoritative sync', () => {
  let masks = new Map();
  masks = addHiddenPollMask(masks, 'channel-a', 'poll-a');
  masks = addHiddenPollMask(masks, 'channel-a', 'poll-b');
  masks = addHiddenPollMask(masks, 'channel-b', 'poll-c');

  assert.deepEqual([...masks.get('channel-a')], ['poll-a', 'poll-b']);
  assert.deepEqual([...reconcileHiddenPollsAfterSync(masks, 'channel-b').get('channel-a')], ['poll-a', 'poll-b']);
  assert.equal(reconcileHiddenPollsAfterSync(masks, 'channel-a').has('channel-a'), false);
});

test('restore removes only its matching temporary hidden mask', () => {
  const masks = addHiddenPollMask(addHiddenPollMask(new Map(), 'channel-a', 'poll-a'), 'channel-a', 'poll-b');
  const restored = removeHiddenPollMask(masks, 'channel-a', 'poll-a');
  assert.deepEqual([...restored.get('channel-a')], ['poll-b']);
});
