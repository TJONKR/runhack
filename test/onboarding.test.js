import test from 'node:test';
import assert from 'node:assert/strict';
import { canCreatePublicTeam } from '../src/api.js';

const openEvent = {
  published: true,
  config: { selfServiceTeams: true },
  start_at: '2026-08-29T10:00:00Z',
  end_at: '2026-08-29T18:00:00Z',
};

test('public team creation requires an enabled, published, open event', () => {
  const live = Date.parse('2026-08-29T12:00:00Z');
  assert.equal(canCreatePublicTeam(openEvent, live), true);
  assert.equal(canCreatePublicTeam({ ...openEvent, published: false }, live), false);
  assert.equal(canCreatePublicTeam({ ...openEvent, config: {} }, live), false);
  assert.equal(
    canCreatePublicTeam({ ...openEvent, paused_at: '2026-08-29T11:00:00Z' }, live),
    false
  );
});

test('public team creation is allowed before the start but not after the end', () => {
  assert.equal(canCreatePublicTeam(openEvent, Date.parse('2026-08-29T09:00:00Z')), true);
  assert.equal(canCreatePublicTeam(openEvent, Date.parse('2026-08-29T19:00:00Z')), false);
});
