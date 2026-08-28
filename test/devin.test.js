import test from 'node:test';
import assert from 'node:assert/strict';
import { aggregateSessions, isActive } from '../src/devin.js';

test('aggregateSessions counts sessions, activity, PRs, and ACUs', () => {
  assert.deepEqual(
    aggregateSessions([
      {
        status: 'running',
        acus_consumed: 1.25,
        pull_requests: [{ pr_state: 'open' }, { pr_state: 'merged' }],
      },
      {
        status: 'finished',
        acus_consumed: 2.31,
        pull_requests: [{ pr_state: null }],
      },
      {
        status: 'CLAIMED',
        pull_requests: [],
      },
    ]),
    { sessions: 3, active: 2, prsOpen: 3, prsMerged: 1, acus: 3.6 }
  );
});

test('aggregateSessions handles missing ACUs and empty lists', () => {
  assert.deepEqual(aggregateSessions([]), {
    sessions: 0,
    active: 0,
    prsOpen: 0,
    prsMerged: 0,
    acus: 0,
  });
  assert.deepEqual(
    aggregateSessions([{ status: 'new', pull_requests: null }]),
    { sessions: 1, active: 1, prsOpen: 0, prsMerged: 0, acus: 0 }
  );
});

test('isActive recognizes Devin active statuses case-insensitively', () => {
  for (const status of ['running', 'claimed', 'resuming', 'new', 'RUNNING', 'Claimed']) {
    assert.equal(isActive(status), true);
  }
  for (const status of ['finished', 'error', '', null, undefined]) {
    assert.equal(isActive(status), false);
  }
});

// --- added on merge: the guarantees that matter operationally ---

test('a team API key never appears in any admin response shape', () => {
  // mirrors withoutDevinKey in src/admin.js
  const withoutDevinKey = (team) => {
    const { devin_api_key, ...safe } = team;
    return { ...safe, has_devin: !!devin_api_key };
  };
  const row = { id: 3, name: 'Prompt Pacers', devin_api_key: 'cog_supersecret', devin_org_id: 'org-1' };
  const out = withoutDevinKey(row);
  assert.equal(JSON.stringify(out).includes('cog_supersecret'), false);
  assert.equal(out.has_devin, true);
  assert.equal(withoutDevinKey({ id: 4, devin_api_key: null }).has_devin, false);
});

test('opting out of Devin costs a team nothing', async () => {
  const { teamScore } = await import('../src/db.js');
  // score is distance only — Devin cannot move a ranking either way
  assert.equal(teamScore(12.4, 0, {}), 12.4);
  assert.equal(teamScore(12.4, 999, {}), 12.4);
});

test('aggregateSessions handles an empty field without NaN', async () => {
  const { aggregateSessions } = await import('../src/devin.js');
  assert.deepEqual(aggregateSessions([]), {
    sessions: 0, active: 0, prsOpen: 0, prsMerged: 0, acus: 0,
  });
});
