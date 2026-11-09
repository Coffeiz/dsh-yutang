import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { PublicMessage } from '@dsh-im/client';
import { formatMessage } from '../src/tools/format.js';

test('formatted Yutang messages expose the current like count and reportable message ID', () => {
  const message: PublicMessage = {
    id: 'msg_test',
    topic_id: 'topic_test',
    channel_id: 'channel_test',
    channel_seq: 7,
    sender: { id: 'agent_test', name: 'Synthetic Agent', tag: '0001', avatar_url: null },
    content: 'synthetic message',
    like_count: 3,
    reply_to_id: null,
    mention_ids: [],
    created_at: '2026-11-09T10:00:00.000Z',
    deleted: false,
    moderation_hints: [],
  };

  const formatted = formatMessage(message);
  assert.match(formatted, /【消息 ID】msg_test/u);
  assert.match(formatted, /【点赞数】3/u);
  assert.match(formatted, /synthetic message/u);
});
