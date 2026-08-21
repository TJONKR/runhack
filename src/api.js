import { Router } from 'express';
import crypto from 'node:crypto';
import { pool, eventConfig, eventStatus, teamScore } from './db.js';
import { parseRepo } from './github.js';

const router = Router();

// Public event info for the join page: teams to pick from, no member data.
router.get('/:slug/info', async (req, res) => {
  const { rows } = await pool.query(
    'SELECT id, slug, name FROM events WHERE slug = $1',
    [req.params.slug]
  );
  if (!rows[0]) return res.status(404).json({ error: 'no such event' });
  const teams = await pool.query(
    "SELECT id, name, (repo_url IS NOT NULL AND repo_url <> '') AS has_repo FROM teams WHERE event_id = $1 ORDER BY name",
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

  // First runner to supply a repo sets the team's; after that it's admin-only.
  const { repoUrl } = req.body;
  if (repoUrl) {
    if (!parseRepo(repoUrl)) return res.status(400).json({ error: 'repoUrl must be a github.com repo' });
    await pool.query(
      "UPDATE teams SET repo_url = $1 WHERE id = $2 AND (repo_url IS NULL OR repo_url = '')",
      [repoUrl.trim(), teamId]
    );
  }

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
    `SELECT t.id, t.name, t.repo_url, t.commit_count,
            am.name AS runner_name, am.last_fix AS runner_last_fix,
            ll.seconds AS last_lap_s, ll.counted AS last_lap_valid, ll.reject_reason AS last_lap_reason,
            COALESCE(l.valid, 0) AS valid_laps, COALESCE(l.invalid, 0) AS invalid_laps
       FROM teams t
       LEFT JOIN members am ON am.id = t.active_member_id
       LEFT JOIN (
         SELECT team_id,
                count(*) FILTER (WHERE counted) AS valid,
                count(*) FILTER (WHERE NOT counted) AS invalid
           FROM laps WHERE event_id = $1 GROUP BY team_id
       ) l ON l.team_id = t.id
       LEFT JOIN LATERAL (
         SELECT seconds, counted, reject_reason FROM laps
          WHERE team_id = t.id ORDER BY finished_at DESC LIMIT 1
       ) ll ON true
      WHERE t.event_id = $1`,
    [event.id]
  );

  const board = teams.rows
    .map((t) => {
      const laps = Number(t.valid_laps);
      const km = +((laps * config.lapM) / 1000).toFixed(2);
      const commits = Number(t.commit_count) || 0;
      const lastFixAgoS = t.runner_last_fix?.at
        ? Math.round((Date.now() - t.runner_last_fix.at) / 1000)
        : null;
      let status = 'idle';
      if (t.runner_name) status = lastFixAgoS != null && lastFixAgoS <= 30 ? 'running' : 'stopped';
      return {
        teamId: t.id,
        team: t.name,
        runner: t.runner_name || null,
        status,
        laps,
        invalidLaps: Number(t.invalid_laps),
        km,
        commits,
        repo: t.repo_url || null,
        score: teamScore(km, commits, config),
        lastLap: t.last_lap_s != null
          ? { seconds: Math.round(t.last_lap_s), valid: t.last_lap_valid, reason: t.last_lap_reason }
          : null,
        paceSPerKm:
          t.last_lap_s != null && t.last_lap_valid
            ? Math.round(t.last_lap_s / (config.lapM / 1000))
            : null,
        lastPingAgoS: lastFixAgoS,
      };
    })
    .sort((a, b) => b.score - a.score || b.km - a.km || a.team.localeCompare(b.team));

  res.json({
    event: event.name,
    slug: event.slug,
    lapM: config.lapM,
    scoreFormula: config.scoreFormula,
    status: eventStatus(event),
    startAt: event.start_at,
    endAt: event.end_at,
    serverNow: new Date().toISOString(),
    teams: board,
  });
});

export default router;
