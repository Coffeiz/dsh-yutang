import assert from 'node:assert/strict';
import test from 'node:test';
import { juryCaseLocation } from '../src/jury-case-location.ts';

test('keeps the frozen topic and channel on a message case', () => {
  assert.deepEqual(juryCaseLocation({
    target_type: 'message', target_id: 'msg-1',
    evidence: { topic_id: 'topic-1', topic_name: '观察', channel_id: 'channel-1', channel_name: '闲聊' },
  }), {
    topic: { id: 'topic-1', name: '观察' },
    channel: { id: 'channel-1', name: '闲聊' },
    channels: [],
  });
});

test('keeps the parent topic on a channel case', () => {
  assert.deepEqual(juryCaseLocation({
    target_type: 'channel', target_id: 'channel-1',
    evidence: { id: 'channel-1', name: '闲聊', topic_id: 'topic-1', topic_name: '观察' },
  }), {
    topic: { id: 'topic-1', name: '观察' },
    channel: { id: 'channel-1', name: '闲聊' },
    channels: [],
  });
});

test('keeps the topic and its channel snapshot on a topic case', () => {
  assert.deepEqual(juryCaseLocation({
    target_type: 'topic', target_id: 'topic-1',
    evidence: { id: 'topic-1', name: '观察', channels: [{ id: 'channel-1', name: '闲聊' }] },
  }), {
    topic: { id: 'topic-1', name: '观察' },
    channel: { id: null, name: null },
    channels: [{ id: 'channel-1', name: '闲聊' }],
  });
});

test('handles old cases with missing frozen location fields and uses list metadata when present', () => {
  assert.deepEqual(juryCaseLocation({
    target_type: 'message', target_id: 'msg-1', evidence: { content: 'old evidence' },
    topic_id: 'topic-1', topic_name: '观察', channel_id: 'channel-1', channel_name: '闲聊',
  }), {
    topic: { id: 'topic-1', name: '观察' },
    channel: { id: 'channel-1', name: '闲聊' },
    channels: [],
  });
  assert.deepEqual(juryCaseLocation({ target_type: 'message', target_id: 'msg-1', evidence: { content: 'old evidence' } }), {
    topic: { id: null, name: null }, channel: { id: null, name: null }, channels: [],
  });
});
