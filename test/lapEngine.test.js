import test from 'node:test';
import assert from 'node:assert/strict';
import { createState, processFix, pointInPolygon } from '../src/lapEngine.js';

// Two rectangles roughly like the community track: start box and back-straight box.
const startZone = {
  name: 'start/finish',
  polygon: [[51.5390, -0.0180], [51.5390, -0.0170], [51.5386, -0.0170], [51.5386, -0.0180]],
};
const backZone = {
  name: 'back straight',
  polygon: [[51.5390, -0.0150], [51.5390, -0.0140], [51.5386, -0.0140], [51.5386, -0.0150]],
};
const config = {
  zones: [startZone, backZone],
  minLapS: 55,
  maxLapS: 168,
  entryFixes: 1,
  exitFixes: 2,
  maxAccuracyM: 40,
};

const IN_START = { lat: 51.5388, lng: -0.0175 };
const IN_BACK = { lat: 51.5388, lng: -0.0145 };
const ON_COURSE = { lat: 51.5388, lng: -0.0160 };

function run(fixes, cfg = config) {
  let state = createState();
  const all = [];
  for (const f of fixes) {
    const r = processFix(state, f, cfg);
    state = r.state;
    all.push(...r.events);
  }
  return { state, events: all };
}

// Build a lap's worth of fixes: at start, out on course, at back, on course, back at start.
function lapFixes(t0, lapSeconds) {
  const p = (pos, dt) => ({ ...pos, timestampMs: t0 + dt * 1000, accuracyM: 10 });
  return [
    p(IN_START, 0),
    p(ON_COURSE, lapSeconds * 0.2),
    p(ON_COURSE, lapSeconds * 0.3),
    p(IN_BACK, lapSeconds * 0.5),
    p(ON_COURSE, lapSeconds * 0.7),
    p(ON_COURSE, lapSeconds * 0.8),
    p(IN_START, lapSeconds),
  ];
}

test('point in polygon', () => {
  assert.equal(pointInPolygon(IN_START.lat, IN_START.lng, startZone.polygon), true);
  assert.equal(pointInPolygon(ON_COURSE.lat, ON_COURSE.lng, startZone.polygon), false);
});

test('a clean 100s lap is credited', () => {
  const { state, events } = run(lapFixes(0, 100));
  const laps = events.filter((e) => e.type === 'lap');
  assert.equal(laps.length, 1);
  assert.equal(laps[0].counted, true);
  assert.equal(Math.round(laps[0].seconds), 100);
  assert.equal(state.lapCount, 1);
});

test('three consecutive laps count as three', () => {
  const fixes = [...lapFixes(0, 100), ...lapFixes(100_000, 110).slice(1), ...lapFixes(210_000, 95).slice(1)];
  const { state } = run(fixes);
  assert.equal(state.lapCount, 3);
});

test('a 40s "lap" (GPS bounce) is rejected as too fast', () => {
  const { state, events } = run(lapFixes(0, 40));
  const lap = events.find((e) => e.type === 'lap');
  assert.equal(lap.counted, false);
  assert.equal(lap.reason, 'too_fast');
  assert.equal(state.lapCount, 0);
});

test('a 200s walk lap is rejected as too slow', () => {
  const { events } = run(lapFixes(0, 200));
  const lap = events.find((e) => e.type === 'lap');
  assert.equal(lap.counted, false);
  assert.equal(lap.reason, 'too_slow');
});

test('start -> start without the back straight does not score', () => {
  const t = (pos, dt) => ({ ...pos, timestampMs: dt * 1000, accuracyM: 10 });
  const { state, events } = run([
    t(IN_START, 0),
    t(ON_COURSE, 20),
    t(ON_COURSE, 30),
    t(IN_START, 100), // turned around, never hit the back straight
  ]);
  assert.equal(events.filter((e) => e.type === 'lap').length, 0);
  assert.equal(state.lapCount, 0);
  // ...but the lap re-arms from this entry
  assert.equal(state.lapStartedAt, 100_000);
});

test('rejected lap still re-arms: next full lap counts', () => {
  const fixes = [...lapFixes(0, 40), ...lapFixes(40_000, 100).slice(1)];
  const { state } = run(fixes);
  assert.equal(state.lapCount, 1);
});

test('bad-accuracy fixes are dropped before the state machine', () => {
  const fixes = lapFixes(0, 100).map((f, i) => (i === 3 ? { ...f, accuracyM: 80 } : f));
  // back-straight fix dropped -> sequence never completes -> no lap
  const { state } = run(fixes);
  assert.equal(state.lapCount, 0);
});

test('exit dwell: one stray outside fix does not exit the zone', () => {
  const t = (pos, dt) => ({ ...pos, timestampMs: dt * 1000, accuracyM: 10 });
  const { state } = run([
    t(IN_START, 0),
    t(ON_COURSE, 2), // single bounce out
    t(IN_START, 4),
  ]);
  assert.equal(state.inZone, 0);
});

test('two-fix entry dwell requires two fixes in the zone', () => {
  const cfg = { ...config, entryFixes: 2 };
  const t = (pos, dt) => ({ ...pos, timestampMs: dt * 1000, accuracyM: 10 });
  let { state } = run([t(IN_START, 0)], cfg);
  assert.equal(state.inZone, null);
  ({ state } = run([t(IN_START, 0), t(IN_START, 2)], cfg));
  assert.equal(state.inZone, 0);
});

test('three-zone course requires all checkpoints in order', () => {
  const midZone = {
    name: 'mid',
    polygon: [[51.5395, -0.0166], [51.5395, -0.0156], [51.5392, -0.0156], [51.5392, -0.0166]],
  };
  const cfg = { ...config, zones: [startZone, midZone, backZone] };
  const IN_MID = { lat: 51.5393, lng: -0.0161 };
  const t = (pos, dt) => ({ ...pos, timestampMs: dt * 1000, accuracyM: 10 });

  // Skipping mid: no lap
  let r = run([t(IN_START, 0), t(ON_COURSE, 20), t(ON_COURSE, 25), t(IN_BACK, 50),
               t(ON_COURSE, 70), t(ON_COURSE, 75), t(IN_START, 100)], cfg);
  assert.equal(r.state.lapCount, 0);

  // Hitting start -> mid -> back -> start: lap
  r = run([t(IN_START, 0), t(ON_COURSE, 10), t(ON_COURSE, 15), t(IN_MID, 25),
           t(ON_COURSE, 40), t(ON_COURSE, 45), t(IN_BACK, 55),
           t(ON_COURSE, 75), t(ON_COURSE, 80), t(IN_START, 100)], cfg);
  assert.equal(r.state.lapCount, 1);
});
