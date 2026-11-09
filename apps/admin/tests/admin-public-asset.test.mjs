import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { adminPublicAsset } from '../src/admin-public-asset.ts';

const adminRoot = new URL('../', import.meta.url);

test('resolves public images below the Admin mount for standard and prefixed deployments', () => {
  assert.equal(
    adminPublicAsset('icons/pond-jury-title.png', 'https://yutang.example/admin/'),
    'https://yutang.example/admin/icons/pond-jury-title.png',
  );
  assert.equal(
    adminPublicAsset('/favicon.png', 'https://yutang.example/b8a2127baeb2adcde5169ce6ddc0c72c66de0b6d00a65305/'),
    'https://yutang.example/b8a2127baeb2adcde5169ce6ddc0c72c66de0b6d00a65305/favicon.png',
  );
  assert.equal(
    adminPublicAsset('icons/pond-jury-title.png', 'https://yutang.example/admin'),
    'https://yutang.example/admin/icons/pond-jury-title.png',
  );
});

test('all Admin img elements use the mount-aware public asset resolver and point to existing files', () => {
  const source = readFileSync(new URL('../src/main.tsx', import.meta.url), 'utf8');
  const imageTags = [...source.matchAll(/<img\b[^>]*>/gs)].map(([tag]) => tag);

  assert.ok(imageTags.length > 0, 'expected Admin image elements to be covered');
  for (const tag of imageTags) {
    assert.match(tag, /src=\{adminPublicAsset\(/, `image bypasses the mount-aware resolver: ${tag}`);
  }

  for (const asset of ['favicon.png', 'icons/pond-jury-title.png']) {
    assert.ok(existsSync(fileURLToPath(new URL(`public/${asset}`, adminRoot))), `missing public asset: ${asset}`);
  }

  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  assert.match(html, /rel="icon"[^>]+href="\.\/favicon\.png"/, 'favicon must resolve relative to the Admin mount');
});
