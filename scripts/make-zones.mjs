#!/usr/bin/env node
// Generate the two geofence boxes for an event from two pins on the loop.
//
//   node scripts/make-zones.mjs <startLat,startLng> <farLat,farLng> [--width 30] [--depth 25] [--apply <slug>]
//
// startPin = the start/finish line (where the runners set off and return)
// farPin   = a point on the OPPOSITE side of the loop, the checkpoint that
//            proves they went all the way round instead of doubling back
//
// Boxes are drawn ACROSS the running line (perpendicular to the direction of
// travel) so a runner cannot miss one by drifting a few metres wide. Defaults
// are deliberately fat: 30m across the path, 25m deep. GPS on a phone under
// trees is worth ~10-20m, and a missed zone means a missed lap.

const R = 6378137; // earth radius, metres

const parse = (s, label) => {
  const [lat, lng] = String(s).split(',').map(Number);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    console.error(`bad ${label}: expected "lat,lng", got "${s}"`);
    process.exit(1);
  }
  return [lat, lng];
};

// metres -> degrees at a given latitude
const dLat = (m) => (m / R) * (180 / Math.PI);
const dLng = (m, lat) => (m / (R * Math.cos((lat * Math.PI) / 180))) * (180 / Math.PI);

/** A rectangle centred on `pin`, `width` across the direction of travel and
 *  `depth` along it. `bearing` is the direction of travel in radians. */
function box(pin, bearingRad, width, depth) {
  const [lat, lng] = pin;
  // unit vectors in metres: along travel, and across it
  const ax = Math.sin(bearingRad), ay = Math.cos(bearingRad);
  const cx = Math.cos(bearingRad), cy = -Math.sin(bearingRad);
  const corners = [
    [+depth / 2, +width / 2],
    [+depth / 2, -width / 2],
    [-depth / 2, -width / 2],
    [-depth / 2, +width / 2],
  ];
  return corners.map(([alongM, acrossM]) => {
    const eastM = alongM * ax + acrossM * cx;
    const northM = alongM * ay + acrossM * cy;
    return [+(lat + dLat(northM)).toFixed(7), +(lng + dLng(eastM, lat)).toFixed(7)];
  });
}

function bearing(a, b) {
  const [lat1, lng1] = a.map((v) => (v * Math.PI) / 180);
  const [lat2, lng2] = b.map((v) => (v * Math.PI) / 180);
  const y = Math.sin(lng2 - lng1) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(lng2 - lng1);
  return Math.atan2(y, x);
}

function distanceM(a, b) {
  const [lat1, lng1] = a.map((v) => (v * Math.PI) / 180);
  const [lat2, lng2] = b.map((v) => (v * Math.PI) / 180);
  const h = Math.sin((lat2 - lat1) / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin((lng2 - lng1) / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

const args = process.argv.slice(2);
const flag = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? dflt : args[i + 1];
};
if (args.length < 2 || args[0].startsWith('--')) {
  console.error('usage: make-zones.mjs <startLat,startLng> <farLat,farLng> [--width 30] [--depth 25] [--apply <slug>] [--url <base>]');
  process.exit(1);
}

const start = parse(args[0], 'start pin');
const far = parse(args[1], 'far pin');
const width = Number(flag('width', 30));
const depth = Number(flag('depth', 25));

const brg = bearing(start, far);
const straightM = distanceM(start, far);
const loopM = Math.round(straightM * 2); // there and back; a real loop is longer
const gapM = Math.round(straightM);

const zones = [
  { name: 'start', polygon: box(start, brg, width, depth) },
  { name: 'checkpoint', polygon: box(far, brg, width, depth) },
];

// Timing: laps run from LEAVING the start box to RE-ENTERING it, so the timed
// segment is the loop minus the depth of the start box.
const timedSegmentM = Math.max(100, loopM - depth);
const paceCeil = 7 * 60; // the event's 7:00/km rule, in seconds per km
const maxLapS = Math.round((timedSegmentM / 1000) * paceCeil);
const minLapS = Math.round((timedSegmentM / 1000) * 140); // 2:20/km — beyond human, so it's GPS bounce

console.log(`start -> far: ${Math.round(straightM)}m straight line`);
console.log(`assumed loop: ~${loopM}m  (MEASURE THE REAL LOOP — this assumes out-and-back)`);
console.log(`box gap:      ${gapM}m ${gapM >= 30 ? 'OK' : '** TOO CLOSE — boxes must be >=30m apart **'}`);
console.log(`boxes:        ${width}m across the path x ${depth}m deep\n`);

const config = { lapM: loopM, timedSegmentM, minLapS, maxLapS };
console.log('suggested config:', JSON.stringify(config));
console.log(`  a lap slower than ${maxLapS}s is rejected (that IS the 7:00/km rule over ${timedSegmentM}m)`);
console.log(`  a lap faster than ${minLapS}s is rejected as GPS bounce\n`);
console.log(JSON.stringify({ zones, config }, null, 2));

const slug = flag('apply', null);
if (slug) {
  const base = flag('url', 'http://localhost:3000');
  const key = process.env.ADMIN_KEY;
  if (!key) { console.error('\nset ADMIN_KEY to apply'); process.exit(1); }
  const cur = await (await fetch(`${base}/api/admin/events/${slug}`, {
    headers: { Authorization: `Bearer ${key}` },
  })).json();
  const res = await fetch(`${base}/api/admin/events`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      slug, name: cur.name, zones,
      config: { ...cur.config, ...config },
      startAt: cur.start_at, endAt: cur.end_at,
    }),
  });
  console.log(`\napplied to "${slug}": ${res.status === 200 ? 'OK' : await res.text()}`);
  console.log('Now open /admin -> Map and drag the corners onto the real path.');
}
