import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ApiError, YutangApi } from '@dsh-im/client';

const message = {
  id: 'msg_test',
  topic_id: 'topic_test',
  channel_id: 'channel_test',
  channel_seq: 1,
  sender: { id: 'agent_test', name: 'Test Agent', tag: null, avatar_url: null },
  content: 'synthetic test message',
  reply_to_id: null,
  mention_ids: [],
  created_at: new Date(0).toISOString(),
  deleted: false,
  moderation_hints: [],
};

test('message send retries a transient transport failure once with the same idempotency key', async () => {
  let calls = 0;
  const bodies: Array<{ client_message_id: string; content: string }> = [];
  const fetcher: typeof fetch = async (_input, init) => {
    calls += 1;
    bodies.push(JSON.parse(String(init?.body)) as { client_message_id: string; content: string });
    if (calls === 1) {
      const cause = Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
      throw Object.assign(new TypeError('fetch failed'), { cause });
    }
    return new Response(JSON.stringify({ data: message }), { status: 201, headers: { 'content-type': 'application/json' } });
  };
  const api = new YutangApi('https://example.invalid', 'synthetic-token', fetcher);

  const result = await api.sendMessage('channel_test', {
    client_message_id: 'message_stable_id', content: 'synthetic test message', reply_to_id: null, mention_ids: [],
  });

  assert.equal(result.data.id, message.id);
  assert.equal(calls, 2);
  assert.deepEqual(bodies, [
    { client_message_id: 'message_stable_id', content: 'synthetic test message', reply_to_id: null, mention_ids: [] },
    { client_message_id: 'message_stable_id', content: 'synthetic test message', reply_to_id: null, mention_ids: [] },
  ]);
});

test('message send preserves transport cause details and does not retry non-transient failures', async () => {
  let calls = 0;
  const cause = Object.assign(new Error('certificate expired'), { code: 'CERT_HAS_EXPIRED' });
  const fetcher: typeof fetch = async () => {
    calls += 1;
    throw Object.assign(new TypeError('fetch failed'), { cause });
  };
  const api = new YutangApi('https://example.invalid', undefined, fetcher);

  await assert.rejects(api.sendMessage('channel_test', {
    client_message_id: 'message_stable_id', content: 'synthetic test message', reply_to_id: null, mention_ids: [],
  }), (error: unknown) => {
    assert.ok(error instanceof ApiError);
    assert.equal(error.code, 'CERT_HAS_EXPIRED');
    assert.match(error.message, /CERT_HAS_EXPIRED: certificate expired/u);
    return true;
  });
  assert.equal(calls, 1);
});

test('message send reports an unknown delivery state if the idempotent retry also fails', async () => {
  let calls = 0;
  const fetcher: typeof fetch = async () => {
    calls += 1;
    const cause = Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
    throw Object.assign(new TypeError('fetch failed'), { cause });
  };
  const api = new YutangApi('https://example.invalid', undefined, fetcher);

  await assert.rejects(api.sendMessage('channel_test', {
    client_message_id: 'message_stable_id', content: 'synthetic test message', reply_to_id: null, mention_ids: [],
  }), (error: unknown) => {
    assert.ok(error instanceof ApiError);
    assert.equal(error.code, 'MESSAGE_DELIVERY_UNKNOWN');
    assert.match(error.message, /先读取目标频道确认是否已发送/u);
    assert.match(error.message, /ECONNRESET/u);
    return true;
  });
  assert.equal(calls, 2);
});

test('message send does not retry HTTP errors', async () => {
  let calls = 0;
  const fetcher: typeof fetch = async () => {
    calls += 1;
    return new Response(JSON.stringify({ error: { code: 'VALIDATION_ERROR', message: 'Request validation failed' } }), {
      status: 400, headers: { 'content-type': 'application/json' },
    });
  };
  const api = new YutangApi('https://example.invalid', undefined, fetcher);

  await assert.rejects(api.sendMessage('channel_test', {
    client_message_id: 'message_stable_id', content: 'synthetic test message', reply_to_id: null, mention_ids: [],
  }), /VALIDATION_ERROR: Request validation failed/u);
  assert.equal(calls, 1);
});
