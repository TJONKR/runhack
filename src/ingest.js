import { pool, eventConfig } from './db.js';
import { createState, processFix } from './lapEngine.js';

// Traccar Client speaks the OsmAnd protocol: parameters arrive in the query
// string, a urlencoded body, or JSON, depending on client version/platform.
// Overland and OwnTracks post their own JSON to the same URL, and Overland
// batches several fixes per request — so this returns a list, oldest first.
// The userId in the path is authoritative; the payload's id is ignored.
export function parseFixes(req) {
  const p = { ...req.query, ...(typeof req.body === 'object' ? req.body : {}) };

  // Overland: GeoJSON features, coordinates are [lng, lat], speed in m/s
  if (Array.isArray(p.locations)) {
    return p.locations
      .map((f) => {
        const c = f?.geometry?.coordinates || [];
        const q = f?.properties || {};
        const lat = num(c[1]);
        const lng = num(c[0]);
        if (lat == null || lng == null) return null;
        return {
          lat,
          lng,
          timestampMs: parseTimestamp(q.timestamp),
          accuracyM: num(q.horizontal_accuracy ?? q.accuracy),
          speedMs: num(q.speed),
        };
      })
      .filter(Boolean)
      .sort((a, b) => a.timestampMs - b.timestampMs);
  }

  // Newer Traccar JSON nests under location.coords
  const coords = p.location?.coords || {};

  const lat = num(p.lat ?? p.latitude ?? coords.latitude);
  const lng = num(p.lon ?? p.lng ?? p.longitude ?? coords.longitude);
  if (lat == null || lng == null) return [];

  // OsmAnd speed is in knots; OwnTracks reports vel in km/h
  const speedKn = num(p.speed ?? coords.speed);
  const velKmh = num(p.vel);
  const speedMs = speedKn != null ? speedKn * 0.514444 : velKmh != null ? velKmh / 3.6 : null;

  return [
    {
      lat,
      lng,
      timestampMs: parseTimestamp(p.timestamp ?? p.tst ?? p.location?.timestamp),
      accuracyM: num(p.accuracy ?? p.acc ?? coords.accuracy ?? p.hdop),
      speedMs,
    },
  ];
}

// Epoch seconds, epoch millis or an ISO string; anything unusable means "now".
function parseTimestamp(ts) {
  if (ts == null) return Date.now();
  if (!isNaN(Number(ts))) {
    const n = Number(ts);
    return n > 1e12 ? n : n * 1000;
  }
  const d = new Date(ts);
  return isNaN(d.getTime()) ? Date.now() : d.getTime();
}

function num(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return isNaN(n) ? null : n;
}

// Cheap in-memory rate limit: max ~2 fixes/sec sustained per userId.
const buckets = new Map();
function rateLimited(userId) {
  const now = Date.now();
  let b = buckets.get(userId);
  if (!b || now - b.start > 10_000) {
    b = { start: now, count: 0 };
    buckets.set(userId, b);
  }
  b.count += 1;
  return b.count > 20;
}

async function applyFix(device, config, state, fix) {
  const { state: newState, events } = processFix(state, fix, config);

  // Official timing selection: 'entry_entry' swaps the scored seconds to the
  // full-lap entry-to-entry measurement before validation. ('gate' is applied
  // when the crossing arrives, below.)
  if (config.officialTiming === 'entry_entry') {
    for (const ev of events) {
      if (ev.type === 'lap' && ev.entrySeconds != null) {
        const wasCounted = ev.counted;
        ev.seconds = ev.entrySeconds;
        ev.counted = ev.seconds >= config.minLapS && ev.seconds <= config.maxLapS;
        ev.reason = ev.counted ? null : ev.seconds < config.minLapS ? 'too_fast' : 'too_slow';
        newState.lapCount += (ev.counted ? 1 : 0) - (wasCounted ? 1 : 0);
        if (ev.counted) newState.lastLapS = ev.seconds;
      }
    }
  }

  // Laps finished outside the event window are recorded but invalid — useful
  // for pre-start warmups and system checks without polluting the board.
  const startMs = device.start_at ? new Date(device.start_at).getTime() : null;
  const endMs = device.end_at ? new Date(device.end_at).getTime() : null;
  for (const ev of events) {
    if (ev.type === 'lap' && ev.counted) {
      if ((startMs && fix.timestampMs < startMs) || (endMs && fix.timestampMs > endMs)) {
        ev.counted = false;
        ev.reason = 'outside_window';
        newState.lapCount -= 1;
      } else if (device.paused_at) {
        ev.counted = false;
        ev.reason = 'paused';
        newState.lapCount -= 1;
      }
    }
  }

  // Cross-device guard: even around a switchover, a team can't record two
  // counted laps closer together than a physically possible lap time.
  for (const ev of events) {
    if (ev.type === 'lap' && ev.counted) {
      const { rows: recentLap } = await pool.query(
        `SELECT 1 FROM laps WHERE team_id = $1 AND counted
          AND finished_at > now() - make_interval(secs => $2) LIMIT 1`,
        [device.team_id, config.minLapS]
      );
      if (recentLap[0]) {
        ev.counted = false;
        ev.reason = 'too_soon';
        newState.lapCount -= 1;
      }
    }
  }

  // Laps first, gate attachments second: a gate crossing can arrive in the
  // same batch as (or just after) the lap it refines. Laps are attributed to
  // the person the device is linked to, if any.
  for (const ev of events) {
    if (ev.type === 'lap') {
      await pool.query(
        `INSERT INTO laps (event_id, team_id, member_id, device_id, seconds, counted, reject_reason, entry_seconds)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [device.event_id, device.team_id, device.member_id, device.id, ev.seconds, ev.counted, ev.reason, ev.entrySeconds]
      );
    }
  }
  for (const ev of events) {
    if (ev.type === 'gate_lap') {
      const { rows: recent } = await pool.query(
        `SELECT id, counted, reject_reason, manual FROM laps
          WHERE device_id = $1 AND finished_at > now() - interval '45 seconds'
          ORDER BY finished_at DESC LIMIT 1`,
        [device.id]
      );
      const lap = recent[0];
      if (!lap) continue;
      await pool.query('UPDATE laps SET gate_seconds = $1 WHERE id = $2', [ev.seconds, lap.id]);
      // Gate as official timing: the crossing time replaces the scored
      // seconds — but never overrides window/pause/admin verdicts.
      if (
        config.officialTiming === 'gate' && !lap.manual &&
        (lap.reject_reason == null || ['too_fast', 'too_slow'].includes(lap.reject_reason))
      ) {
        const counted = ev.seconds >= config.minLapS && ev.seconds <= config.maxLapS;
        const reason = counted ? null : ev.seconds < config.minLapS ? 'too_fast' : 'too_slow';
        await pool.query('UPDATE laps SET seconds = $1, counted = $2, reject_reason = $3 WHERE id = $4', [
          ev.seconds, counted, reason, lap.id,
        ]);
        newState.lapCount += (counted ? 1 : 0) - (lap.counted ? 1 : 0);
        if (counted) newState.lastLapS = ev.seconds;
      }
    }
  }

  return newState;
}

export async function ingestHandler(req, res) {
  const { userId } = req.params;
  if (rateLimited(userId)) return res.status(429).send('slow down');

  const fixes = parseFixes(req);
  if (!fixes.length) return res.status(400).send('no coordinates');

  const { rows } = await pool.query(
    `SELECT d.*, t.active_device_id, e.zones, e.config AS event_config, e.start_at, e.end_at, e.paused_at
       FROM devices d
       JOIN teams t ON t.id = d.team_id
       JOIN events e ON e.id = d.event_id
      WHERE d.token = $1`,
    [userId]
  );
  const device = rows[0];
  if (!device) return res.status(404).send('unknown id');

  if (!device.activated_at) {
    await pool.query('UPDATE devices SET activated_at = now() WHERE id = $1', [device.id]);
  }

  // One scoring device per team. The first device to ping becomes active;
  // a non-active device takes over only if the active one has gone silent
  // (dead battery / closed app) — otherwise its pings are recorded for ops
  // visibility but don't drive the lap engine.
  const lastFix = fixes[fixes.length - 1];
  const fixJson = {
    lat: lastFix.lat,
    lng: lastFix.lng,
    accuracyM: lastFix.accuracyM,
    speedMs: lastFix.speedMs,
    at: lastFix.timestampMs,
  };
  if (device.active_device_id !== device.id) {
    let takeOver = device.active_device_id == null;
    if (!takeOver) {
      const { rows: act } = await pool.query('SELECT last_fix FROM devices WHERE id = $1', [
        device.active_device_id,
      ]);
      const lastAt = act[0]?.last_fix?.at;
      takeOver = lastAt == null || Date.now() - lastAt > 90_000;
    }
    if (takeOver) {
      await pool.query(
        'UPDATE teams SET active_device_id = $1 WHERE id = $2 AND (active_device_id IS NULL OR active_device_id = $3 OR $4)',
        [device.id, device.team_id, device.active_device_id, device.active_device_id == null]
      );
    } else {
      await pool.query('UPDATE devices SET last_fix = $1 WHERE id = $2', [fixJson, device.id]);
      return res.status(200).send('standby');
    }
  }

  const config = eventConfig({ zones: device.zones, config: device.event_config });
  let state = device.state && device.state.nextZone !== undefined ? device.state : createState();
  for (const fix of fixes) {
    state = await applyFix(device, config, state, fix);
  }

  await pool.query(
    `UPDATE devices SET state = $1, lap_count = $2, last_lap_s = $3, last_fix = $4 WHERE id = $5`,
    [state, state.lapCount, state.lastLapS, fixJson, device.id]
  );
  for (const fix of fixes) {
    await pool.query(
      `INSERT INTO points (member_id, device_id, lat, lng, accuracy_m, speed_ms, fixed_at)
       VALUES ($1, $2, $3, $4, $5, $6, to_timestamp($7 / 1000.0))`,
      [device.member_id, device.id, fix.lat, fix.lng, fix.accuracyM, fix.speedMs, fix.timestampMs]
    );
  }

  res.status(200).send('ok');
}
