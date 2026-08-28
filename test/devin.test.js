import test from 'node:test';
import assert from 'node:assert';
import {
  isActive, inWindow, countHumanMessages, aggregate,
} from '../src/devin.js';

// Shapes below are copied from real /v1 responses (probed 28 Aug 2026),
// not from the docs — the docs describe v3, which 403s for ordinary keys.

const session = (over = {}) => ({
  session_id: 'devin-abc', status: 'suspended', status_enum: 'finished',
  created_at: '2026-08-29T11:00:00.000000Z', updated_at: '2026-08-29T12:00:00.000000Z',
  tags: [], pull_request: null, ...over,
});

test('active = anything not finished or expired', () => {
  assert.equal(isActive(session({ status_enum: 'working' })), true);
  assert.equal(isActive(session({ status_enum: 'blocked' })), true);
  assert.equal(isActive(session({ status_enum: 'resumed' })), true);
  assert.equal(isActive(session({ status_enum: 'finished' })), false);
  assert.equal(isActive(session({ status_enum: 'expired' })), false);
});

test('the event window is applied client-side (v1 has no date filter)', () => {
  const start = Date.parse('2026-08-29T09:00:00Z');
  const end = Date.parse('2026-08-29T17:00:00Z');
  assert.equal(inWindow(session(), start, end), true);
  assert.equal(inWindow(session({ created_at: '2026-08-28T23:00:00Z' }), start, end), false, 'before the gun');
  assert.equal(inWindow(session({ created_at: '2026-08-29T18:00:00Z' }), start, end), false, 'after the finish');
  assert.equal(inWindow(session({ created_at: 'nonsense' }), start, end), false, 'unparseable is excluded, not NaN');
});

test('prompts count humans only, not Devin replies', () => {
  const detail = { messages: [
    { type: 'initial_user_message' }, { type: 'devin_message' }, { type: 'user_message' },
    { type: 'devin_message' }, { type: 'user_message' },
  ] };
  assert.equal(countHumanMessages(detail), 3);
  assert.equal(countHumanMessages({}), 0, 'a session with no messages must not throw');
});

test('aggregate totals sessions, active, prompts and PRs', () => {
  const sessions = [
    session({ session_id: 'a', status_enum: 'working', pull_request: { url: 'https://github.com/x/y/pull/1' } }),
    session({ session_id: 'b' }),
    session({ session_id: 'c', pull_request: null }),
  ];
  const counts = new Map([['a', 10], ['b', 4]]); // c never counted
  assert.deepEqual(aggregate(sessions, counts), {
    sessions: 3, active: 1, msgs: 14, prsOpen: 1, prsMerged: 0, acus: 0,
  });
});

test('an empty field aggregates to zeros, not NaN', () => {
  assert.deepEqual(aggregate([], new Map()), {
    sessions: 0, active: 0, msgs: 0, prsOpen: 0, prsMerged: 0, acus: 0,
  });
});

test('a team API key never appears in any admin response shape', () => {
  const withoutDevinKey = (team) => {
    const { devin_api_key, ...safe } = team;
    return { ...safe, has_devin: !!devin_api_key };
  };
  const out = withoutDevinKey({ id: 3, name: 'Prompt Pacers', devin_api_key: 'apk_user_secret' });
  assert.equal(JSON.stringify(out).includes('apk_user_secret'), false);
  assert.equal(out.has_devin, true);
  assert.equal(withoutDevinKey({ id: 4, devin_api_key: null }).has_devin, false);
});

test('opting out of Devin costs a team nothing', async () => {
  const { teamScore } = await import('../src/db.js');
  assert.equal(teamScore(12.4, 0, {}), 12.4);
  assert.equal(teamScore(12.4, 999, {}), 12.4);
});
