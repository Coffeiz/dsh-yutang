import assert from 'node:assert/strict';
import test from 'node:test';
import { requestAdminLogout } from '../src/admin-logout.ts';

test('confirms logout only after a successful server response', async () => {
  await requestAdminLogout(async () => new Response(null, { status: 200 }));
});

test('treats an already invalid session as safely logged out', async () => {
  await requestAdminLogout(async () => new Response(null, { status: 401 }));
});

test('keeps logout pending when the server returns an error', async () => {
  await assert.rejects(requestAdminLogout(async () => new Response(null, { status: 500 })));
});

test('keeps logout pending when the network rejects the request', async () => {
  await assert.rejects(requestAdminLogout(async () => { throw new TypeError('Failed to fetch'); }));
});
