import assert from 'node:assert/strict';
import test from 'node:test';
import { channelHeaderTitle, latestRecentChannels, normalizeRecentChannels } from '../src/navigation-history.ts';

test('restores the latest six visited channels in first-visit order', () => {
  const history = 'ABCDEFG'.split('').map((channelId, index) => ({
    topicId: 'topic',
    channelId,
    visitedAt: new Date(Date.UTC(2026, 0, index + 1)).toISOString(),
  }));

  const normalized = normalizeRecentChannels(history, 20);

  assert.deepEqual(latestRecentChannels(normalized, 6).map(item => item.channelId), ['B', 'C', 'D', 'E', 'F', 'G']);
});

test('normalizes oversized stored history before selecting the latest window', () => {
  const history = Array.from({ length: 25 }, (_, index) => ({
    topicId: 'topic',
    channelId: String.fromCharCode(65 + index),
    visitedAt: new Date(Date.UTC(2026, 0, index + 1)).toISOString(),
  }));

  const normalized = normalizeRecentChannels(history, 20);

  assert.equal(normalized.length, 20);
  assert.deepEqual(latestRecentChannels(normalized, 6).map(item => item.channelId), ['T', 'U', 'V', 'W', 'X', 'Y']);
});

test('uses the selected channel in the header while old messages are still displayed', () => {
  assert.equal(channelHeaderTitle('channel', 'Channel B', 'Topic B', false), 'Channel B');
  assert.equal(channelHeaderTitle('topic', undefined, 'Topic B', true), '正在加载频道…');
});
