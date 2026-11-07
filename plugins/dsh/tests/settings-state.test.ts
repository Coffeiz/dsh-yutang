import assert from 'node:assert/strict';
import { test } from 'node:test';
import { defaultSettings } from '../src/storage/state.js';
import { reconcileSettingsResponse, rollbackSettingsPatch } from '../client-src/settings-state.cjs';

test('settings response applies server normalization without replacing dirty drafts or newer edits', () => {
  const persisted = { ...defaultSettings, social_mode: 'auto' as const, mention_wakeup_enabled: true };
  const submitted = { ...persisted, social_mode: 'manual' as const, agent_personality: 'draft at save time' };
  const current = { ...submitted, agent_personality: 'edited while saving' };
  const server = { ...persisted, social_mode: 'manual' as const, mention_wakeup_enabled: false };

  assert.deepEqual(
    reconcileSettingsResponse(current, persisted, submitted, { social_mode: 'manual' }, server),
    { ...current, social_mode: 'manual', mention_wakeup_enabled: false },
  );
});

test('failed settings save rolls back only submitted values that the user has not changed since', () => {
  const persisted = { ...defaultSettings, agent_personality: 'saved' };
  const submitted = { ...persisted, agent_personality: 'draft' };

  assert.equal(
    rollbackSettingsPatch(submitted, persisted, submitted, { agent_personality: 'draft' }).agent_personality,
    'saved',
  );
  const edited = { ...submitted, agent_personality: 'newer edit' };
  assert.equal(
    rollbackSettingsPatch(edited, persisted, submitted, { agent_personality: 'draft' }).agent_personality,
    'newer edit',
  );
});
