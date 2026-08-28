import test from 'node:test';
import assert from 'node:assert';
import {
  isActive, overlapsWindow, within, toMs, countHumanMessages, aggregate,
} from '../src/devin.js';

const RACE_START = Date.parse('2026-08-29T09:00:00Z');
const RACE_END = Date.parse('2026-08-29T17:00:00Z');

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

test('a session opened the night before is still a candidate if it ran on the day', () => {
  // the case that made created_at filtering wrong: prep session, worked in all day
  assert.equal(
    overlapsWindow(session({ created_at: '2026-08-28T22:00:00Z', updated_at: '2026-08-29T14:00:00Z' }), RACE_START, RACE_END),
    true
  );
  // genuinely old and untouched since: excluded
  assert.equal(
    overlapsWindow(session({ created_at: '2026-07-01T10:00:00Z', updated_at: '2026-07-01T11:00:00Z' }), RACE_START, RACE_END),
    false
  );
  // created after the finish: excluded
  assert.equal(
    overlapsWindow(session({ created_at: '2026-08-30T09:00:00Z', updated_at: '2026-08-30T10:00:00Z' }), RACE_START, RACE_END),
    false
  );
  assert.equal(overlapsWindow(session({ created_at: 'nonsense' }), RACE_START, RACE_END), false);
});

test('timestamps parse as ISO, epoch seconds or epoch millis', () => {
  const iso = Date.parse('2026-08-29T12:00:00Z');
  assert.equal(toMs('2026-08-29T12:00:00Z'), iso);
  assert.equal(toMs(iso / 1000), iso, 'epoch seconds');
  assert.equal(toMs(iso), iso, 'epoch millis');
  assert.equal(toMs(null), null);
  assert.equal(toMs('not a date'), null);
  assert.equal(within('2026-08-29T12:00:00Z', RACE_START, RACE_END), true);
  assert.equal(within('2026-08-29T08:59:00Z', RACE_START, RACE_END), false);
});

test('only prompts sent ON THE DAY count', () => {
  const detail = { messages: [
    { type: 'initial_user_message', timestamp: '2026-08-28T22:30:00Z' }, // night before: no
    { type: 'user_message', timestamp: '2026-08-29T10:15:00Z' },         // during: yes
    { type: 'devin_message', timestamp: '2026-08-29T10:16:00Z' },        // not a human
    { type: 'user_message', timestamp: '2026-08-29T16:59:00Z' },         // during: yes
    { type: 'user_message', timestamp: '2026-08-29T17:30:00Z' },         // after the finish: no
  ] };
  assert.equal(countHumanMessages(detail, RACE_START, RACE_END), 2);
  assert.equal(countHumanMessages(detail), 4, 'unbounded still counts every human message');
});

test('prompts count humans only, not Devin replies', () => {
  const detail = { messages: [
    { type: 'initial_user_message' }, { type: 'devin_message' }, { type: 'user_message' },
    { type: 'devin_message' }, { type: 'user_message' },
  ] };
  assert.equal(countHumanMessages(detail), 3);
  assert.equal(countHumanMessages({}), 0, 'a session with no messages must not throw');
});

test('a session with no prompts on the day is not counted at all', () => {
  const sessions = [
    session({ session_id: 'a', status_enum: 'working', pull_request: { url: 'https://github.com/x/y/pull/1' } }),
    session({ session_id: 'b' }),
    // existed through the window but nobody typed into it on the day:
    session({ session_id: 'c', pull_request: { url: 'https://github.com/x/y/pull/9' } }),
  ];
  const counts = new Map([['a', 10], ['b', 4], ['c', 0]]);
  assert.deepEqual(aggregate(sessions, counts), {
    sessions: 2, active: 1, msgs: 14, prsOpen: 1, prsMerged: 0, acus: 0,
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
