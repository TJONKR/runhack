import test from 'node:test';
import assert from 'node:assert/strict';
import { teamScore, eventStatus } from '../src/db.js';
import { parseRepo } from '../src/github.js';

test('default score is km x commits', () => {
  assert.equal(teamScore(4.8, 25, {}), 120);
  assert.equal(teamScore(4.8, 0, {}), 0);
});

test('sum formula uses commit weight', () => {
  assert.equal(teamScore(4, 30, { scoreFormula: 'km_plus_commits', commitWeight: 0.5 }), 19);
});

test('parseRepo accepts urls and owner/repo', () => {
  assert.deepEqual(parseRepo('https://github.com/roxfit/runhack-build'), { owner: 'roxfit', repo: 'runhack-build' });
  assert.deepEqual(parseRepo('roxfit/runhack-build.git'), { owner: 'roxfit', repo: 'runhack-build' });
  assert.equal(parseRepo('https://gitlab.com/x/y'), null);
  assert.equal(parseRepo('not a repo'), null);
});

test('event status from window', () => {
  const now = Date.parse('2026-08-29T12:00:00Z');
  const ev = { start_at: '2026-08-29T10:00:00Z', end_at: '2026-08-29T18:00:00Z' };
  assert.equal(eventStatus(ev, now), 'live');
  assert.equal(eventStatus(ev, Date.parse('2026-08-29T09:00:00Z')), 'upcoming');
  assert.equal(eventStatus(ev, Date.parse('2026-08-29T19:00:00Z')), 'finished');
  assert.equal(eventStatus({}, now), 'live');
});
