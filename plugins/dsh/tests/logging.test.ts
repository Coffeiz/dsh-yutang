import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { YutangLogger } from '../src/shared/logging.js';

test('plugin log buffer is bounded, records levels, and redacts credential-like values', () => {
  const logger = new YutangLogger({ info() {}, warn() {}, error() {}, debug() {} }, 4);
  logger.debug('starting');
  logger.info('authorization', 'Bearer eyJhbGciOiJub25lIn0.secret-token');
  logger.warn('url', 'https://example.test/?signature=signature-secret&token=token-secret');
  logger.error('key', '-----BEGIN PRIVATE KEY-----\nsecret-key\n-----END PRIVATE KEY-----');
  logger.error('response', { nested: { authorization: 'Bearer nested-secret', registration_code: 'code-secret' }, detail: 'token: inline-secret' });

  const logs = logger.list(500);
  assert.equal(logs.length, 4);
  assert.deepEqual(logs.map(entry => entry.level), ['info', 'warn', 'error', 'error']);
  assert.doesNotMatch(logs.map(entry => entry.message).join('\n'), /secret-token|signature-secret|token-secret|secret-key|nested-secret|code-secret|inline-secret/u);
  assert.match(logs[0]!.message, /Bearer \[REDACTED\]/u);
  assert.match(logs[1]!.message, /signature=\[REDACTED\].*token=\[REDACTED\]/u);
  assert.match(logs[2]!.message, /\[REDACTED PRIVATE KEY\]/u);
  assert.match(logs[3]!.message, /"authorization":"\[REDACTED\]".*token:\s*\[REDACTED\]/u);
  assert.equal(logger.list(1)[0]!.id, logs.at(-1)!.id);
});

test('plugin logs persist as redacted JSONL entries and reload after restart', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'yutang-logs-'));
  const path = join(dir, 'plugin.log');
  try {
    const first = new YutangLogger({ info() {} }, 500, path);
    await first.initialize();
    first.info('token=private-token');
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.doesNotMatch(await readFile(path, 'utf8'), /private-token/u);
    const restored = new YutangLogger({ info() {} }, 500, path);
    await restored.initialize();
    assert.match(restored.list()[0]!.message, /token=\[REDACTED\]/u);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
