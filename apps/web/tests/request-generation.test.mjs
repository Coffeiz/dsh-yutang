import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequestGeneration } from '../src/components/request-generation.ts';

test('only the latest first-page request generation can commit', () => {
  const requests = createRequestGeneration();
  const initial = requests.begin();
  const refresh = requests.begin();

  assert.equal(requests.isCurrent(initial), false);
  assert.equal(requests.isCurrent(refresh), true);
  assert.equal(requests.current(), refresh);
});
