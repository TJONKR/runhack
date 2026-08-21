import { Router } from 'express';
import crypto from 'node:crypto';
import { pool, eventConfig } from './db.js';

const router = Router();

// Public event info for the join page: teams to pick from, no member data.
router.get('/:slug/info', async (req, res) => {
  const { rows } = await pool.query(
    'SELECT id, slug, name FROM events WHERE slug = $1',
    [req.params.slug]
  );
  if (!rows[0]) return res.status(404).json({ error: 'no such event' });
  const teams = await pool.query(
    'SELECT id, name FROM teams WHERE event_id = $1 ORDER BY name',
    [rows[0].id]
  );
  res.json({ slug: rows[0].slug, name: rows[0].name, teams: teams.rows });
});

// Register a member (one per stint). Returns the capability userId that goes
// into the Traccar config deep link.
router.post('/:slug/members', async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM events WHERE slug = $1', [req.params.slug]);
  const event = rows[0];
  if (!event) return res.status(404).json({ error: 'no such event' });

  const { teamId, name } = req.body;
  if (!teamId || !name?.trim()) return res.status(400).json({ error: 'teamId and name required' });

  const team = await pool.query('SELECT id FROM teams WHERE id = $1 AND event_id = $2', [
    teamId,
    event.id,
  ]);
  if (!team.rows[0]) return res.status(404).json({ error: 'no such team in this event' });

  const userId = crypto.randomBytes(12).toString('base64url');
  await pool.query(
    'INSERT INTO members (event_id, team_id, user_id, name) VALUES ($1, $2, $3, $4)',
    [event.id, teamId, userId, name.trim()]
  );
  res.json({ userId });
});

// Join-page poll: has the first Traccar fix landed yet?
router.get('/member/:userId/status', async (req, res) => {
  const { rows } = await pool.query(
    'SELECT activated_at, frozen_at, lap_count, last_fix FROM members WHERE user_id = $1',
    [req.params.userId]
  );
  const m = rows[0];
  if (!m) return res.status(404).json({ error: 'unknown id' });
  res.json({
    activated: !!m.activated_at,
    frozen: !!m.frozen_at,
    laps: m.lap_count,
    lastFixAgoS: m.last_fix?.at ? Math.round((Date.now() - m.last_fix.at) / 1000) : null,
  });
});

// Public leaderboard. Poll every 2-5s.
router.get('/:slug/board', async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM events WHERE slug = $1', [req.params.slug]);
  const event = rows[0];
  if (!event) return res.status(404).json({ error: 'no such event' });
  const config = eventConfig(event);

  const teams = await pool.query(
    `SELECT t.id, t.name,
            am.name AS runner_name, am.last_lap_s AS runner_last_lap_s, am.last_fix AS runner_last_fix,
            COALESCE(l.laps, 0) AS laps
       FROM teams t
       LEFT JOIN members am ON am.id = t.active_member_id
       LEFT JOIN (
         SELECT team_id, count(*) AS laps FROM laps
          WHERE event_id = $1 AND counted GROUP BY team_id
       ) l ON l.team_id = t.id
      WHERE t.event_id = $1`,
    [event.id]
  );

  const board = teams.rows
    .map((t) => {
      const laps = Number(t.laps);
      const lastFixAgoS = t.runner_last_fix?.at
        ? Math.round((Date.now() - t.runner_last_fix.at) / 1000)
        : null;
      let status = 'idle';
      if (t.runner_name) {
        if (lastFixAgoS != null && lastFixAgoS <= 30) status = 'running';
        else status = 'stopped';
      }
      const lastLapS = t.runner_last_lap_s;
      return {
        teamId: t.id,
        team: t.name,
        runner: t.runner_name || null,
        status,
        laps,
        km: +((laps * config.lapM) / 1000).toFixed(2),
        lastLapS: lastLapS != null ? Math.round(lastLapS) : null,
        paceSPerKm: lastLapS != null ? Math.round(lastLapS / (config.lapM / 1000)) : null,
        lastPingAgoS: lastFixAgoS,
      };
    })
    .sort((a, b) => b.laps - a.laps || a.team.localeCompare(b.team));

  res.json({ event: event.name, slug: event.slug, lapM: config.lapM, teams: board });
});

export default router;
