import test from 'node:test';
import assert from 'node:assert/strict';
import { teamScore, eventStatus } from '../src/db.js';
import { parseRepo } from '../src/github.js';

test('default score is distance run — commits are ignored', () => {
  assert.equal(teamScore(4.8, 25, {}), 4.8);
  assert.equal(teamScore(4.8, 0, {}), 4.8); // no repo must not mean no score
  assert.equal(teamScore(0, 99, {}), 0);
});

test('the commit formulas still work when an event opts into one', () => {
  assert.equal(teamScore(4.8, 25, { scoreFormula: 'km_x_commits' }), 120);
  assert.equal(teamScore(4.8, 0, { scoreFormula: 'km_x_commits' }), 0);
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
  assert.equal(eventStatus({ ...ev, paused_at: '2026-08-29T11:00:00Z' }, now), 'paused');
  // pause flag is irrelevant once finished
  assert.equal(eventStatus({ ...ev, paused_at: '2026-08-29T11:00:00Z' }, Date.parse('2026-08-29T19:00:00Z')), 'finished');
});

test('teamScore formula variants and commit cap', () => {
  assert.equal(teamScore(10, 25, { scoreFormula: 'km_x_sqrt_commits' }), 50); // 10 * sqrt(25)
  assert.equal(teamScore(10, 100, { scoreFormula: 'km_x_commits', commitCap: 40 }), 400); // capped at 40
  assert.equal(teamScore(10, 100, { scoreFormula: 'km_x_sqrt_commits', commitCap: 25 }), 50);
  assert.equal(teamScore(10, 30, { scoreFormula: 'km_plus_commits', commitWeight: 0.5, commitCap: 20 }), 20);
});
