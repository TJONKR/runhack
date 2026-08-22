import { pool, eventConfig } from './db.js';
import { createState, processFix } from './lapEngine.js';

// Traccar Client speaks the OsmAnd protocol: parameters arrive in the query
// string, a urlencoded body, or JSON, depending on client version/platform.
// The userId in the path is authoritative; the payload's id is ignored.
function parseFix(req) {
  const p = { ...req.query, ...(typeof req.body === 'object' ? req.body : {}) };
  // Newer Traccar JSON nests under location.coords
  const coords = p.location?.coords || {};

  const lat = num(p.lat ?? p.latitude ?? coords.latitude);
  const lng = num(p.lon ?? p.lng ?? p.longitude ?? coords.longitude);
  if (lat == null || lng == null) return null;

  let ts = p.timestamp ?? p.location?.timestamp;
  let timestampMs;
  if (ts == null) timestampMs = Date.now();
  else if (!isNaN(Number(ts))) {
    ts = Number(ts);
    timestampMs = ts > 1e12 ? ts : ts * 1000; // seconds vs ms epoch
  } else {
    const d = new Date(ts);
    timestampMs = isNaN(d.getTime()) ? Date.now() : d.getTime();
  }

  // OsmAnd speed is in knots
  const speedKn = num(p.speed ?? coords.speed);
  return {
    lat,
    lng,
    timestampMs,
    accuracyM: num(p.accuracy ?? p.acc ?? coords.accuracy ?? p.hdop),
    speedMs: speedKn == null ? null : speedKn * 0.514444,
  };
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

export async function ingestHandler(req, res) {
  const { userId } = req.params;
  if (rateLimited(userId)) return res.status(429).send('slow down');

  const fix = parseFix(req);
  if (!fix) return res.status(400).send('no coordinates');

  const { rows } = await pool.query(
    `SELECT m.*, e.zones, e.config AS event_config, e.start_at, e.end_at, e.paused_at
       FROM members m JOIN events e ON e.id = m.event_id
      WHERE m.user_id = $1`,
    [userId]
  );
  const member = rows[0];
  if (!member) return res.status(404).send('unknown id');

  // Frozen ids (previous stints) are dropped quietly — 200 so Traccar
  // doesn't queue and retry forever.
  if (member.frozen_at) return res.status(200).send('frozen');

  // First-ever ingest activates this member and freezes the team's previous
  // active runner. Each stint is a fresh registration, so this fires once.
  if (!member.activated_at) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const t = await client.query(
        'SELECT active_member_id FROM teams WHERE id = $1 FOR UPDATE',
        [member.team_id]
      );
      const prev = t.rows[0]?.active_member_id;
      if (prev && prev !== member.id) {
        await client.query('UPDATE members SET frozen_at = now() WHERE id = $1', [prev]);
      }
      await client.query('UPDATE teams SET active_member_id = $1 WHERE id = $2', [
        member.id,
        member.team_id,
      ]);
      await client.query('UPDATE members SET activated_at = now() WHERE id = $1', [member.id]);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  const config = eventConfig({ zones: member.zones, config: member.event_config });
  const state = member.state && member.state.nextZone !== undefined ? member.state : createState();
  const { state: newState, events } = processFix(state, fix, config);

  // Laps finished outside the event window are recorded but invalid — useful
  // for pre-start warmups and system checks without polluting the board.
  const startMs = member.start_at ? new Date(member.start_at).getTime() : null;
  const endMs = member.end_at ? new Date(member.end_at).getTime() : null;
  for (const ev of events) {
    if (ev.type === 'lap' && ev.counted) {
      if ((startMs && fix.timestampMs < startMs) || (endMs && fix.timestampMs > endMs)) {
        ev.counted = false;
        ev.reason = 'outside_window';
        newState.lapCount -= 1;
      } else if (member.paused_at) {
        ev.counted = false;
        ev.reason = 'paused';
        newState.lapCount -= 1;
      }
    }
  }

  // Laps first, gate attachments second: a gate crossing can arrive in the
  // same batch as (or just after) the lap it refines.
  for (const ev of events) {
    if (ev.type === 'lap') {
      await pool.query(
        `INSERT INTO laps (event_id, team_id, member_id, seconds, counted, reject_reason, entry_seconds)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [member.event_id, member.team_id, member.id, ev.seconds, ev.counted, ev.reason, ev.entrySeconds]
      );
    }
  }
  for (const ev of events) {
    if (ev.type === 'gate_lap') {
      await pool.query(
        `UPDATE laps SET gate_seconds = $1
          WHERE id = (SELECT id FROM laps WHERE member_id = $2
                       AND finished_at > now() - interval '45 seconds'
                      ORDER BY finished_at DESC LIMIT 1)`,
        [ev.seconds, member.id]
      );
    }
  }

  await pool.query(
    `UPDATE members SET state = $1, lap_count = $2, last_lap_s = $3, last_fix = $4 WHERE id = $5`,
    [
      newState,
      newState.lapCount,
      newState.lastLapS,
      { lat: fix.lat, lng: fix.lng, accuracyM: fix.accuracyM, speedMs: fix.speedMs, at: fix.timestampMs },
      member.id,
    ]
  );
  await pool.query(
    `INSERT INTO points (member_id, lat, lng, accuracy_m, speed_ms, fixed_at)
     VALUES ($1, $2, $3, $4, $5, to_timestamp($6 / 1000.0))`,
    [member.id, fix.lat, fix.lng, fix.accuracyM, fix.speedMs, fix.timestampMs]
  );

  res.status(200).send('ok');
}
