import { Router } from 'express';
import { pool } from './db.js';

const router = Router();

router.use((req, res, next) => {
  const key = req.headers.authorization?.replace(/^Bearer /, '') || req.query.key;
  if (!process.env.ADMIN_KEY || key !== process.env.ADMIN_KEY) {
    return res.status(401).json({ error: 'bad admin key' });
  }
  next();
});

router.get('/events', async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM events ORDER BY created_at DESC');
  res.json(rows);
});

router.post('/events', async (req, res) => {
  const { slug, name, zones = [], config = {}, startAt = null, endAt = null } = req.body;
  if (!slug || !name) return res.status(400).json({ error: 'slug and name required' });
  if (!/^[a-z0-9-]+$/.test(slug)) return res.status(400).json({ error: 'slug: lowercase, digits, dashes' });
  const { rows } = await pool.query(
    `INSERT INTO events (slug, name, zones, config, start_at, end_at) VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (slug) DO UPDATE SET name = $2, zones = $3, config = $4, start_at = $5, end_at = $6
     RETURNING *`,
    [slug, name, JSON.stringify(zones), JSON.stringify(config), startAt, endAt]
  );
  res.json(rows[0]);
});

router.get('/events/:slug', async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM events WHERE slug = $1', [req.params.slug]);
  if (!rows[0]) return res.status(404).json({ error: 'no such event' });
  const teams = await pool.query(
    `SELECT t.*,
            (SELECT count(*) FROM members m WHERE m.team_id = t.id) AS member_count
       FROM teams t WHERE t.event_id = $1 ORDER BY t.name`,
    [rows[0].id]
  );
  res.json({ ...rows[0], teams: teams.rows });
});

router.post('/events/:slug/teams', async (req, res) => {
  const { rows } = await pool.query('SELECT id FROM events WHERE slug = $1', [req.params.slug]);
  if (!rows[0]) return res.status(404).json({ error: 'no such event' });
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: 'name required' });
  const team = await pool.query(
    `INSERT INTO teams (event_id, name) VALUES ($1, $2)
     ON CONFLICT (event_id, name) DO UPDATE SET name = $2 RETURNING *`,
    [rows[0].id, name]
  );
  res.json(team.rows[0]);
});

// Event lifecycle: start_now / end_now / pause / resume.
router.post('/events/:slug/control', async (req, res) => {
  const { action } = req.body;
  const sql = {
    start_now: 'UPDATE events SET start_at = now(), paused_at = NULL WHERE slug = $1 RETURNING *',
    end_now: 'UPDATE events SET end_at = now(), paused_at = NULL WHERE slug = $1 RETURNING *',
    pause: 'UPDATE events SET paused_at = now() WHERE slug = $1 RETURNING *',
    resume: 'UPDATE events SET paused_at = NULL WHERE slug = $1 RETURNING *',
  }[action];
  if (!sql) return res.status(400).json({ error: 'action: start_now | end_now | pause | resume' });
  const { rows } = await pool.query(sql, [req.params.slug]);
  if (!rows[0]) return res.status(404).json({ error: 'no such event' });
  res.json(rows[0]);
});

// Recent laps for a team — for the valid/invalid review panel.
router.get('/events/:slug/teams/:teamId/laps', async (req, res) => {
  const { rows } = await pool.query(
    `SELECT l.id, l.seconds, l.counted, l.reject_reason, l.manual, l.finished_at, m.name AS runner
       FROM laps l LEFT JOIN members m ON m.id = l.member_id
      WHERE l.team_id = $1 AND l.event_id = (SELECT id FROM events WHERE slug = $2)
      ORDER BY l.finished_at DESC LIMIT 50`,
    [req.params.teamId, req.params.slug]
  );
  res.json(rows);
});

// Manually credit a lap to a team (attributed to the active runner if any).
router.post('/events/:slug/teams/:teamId/laps', async (req, res) => {
  const ev = await pool.query('SELECT id FROM events WHERE slug = $1', [req.params.slug]);
  if (!ev.rows[0]) return res.status(404).json({ error: 'no such event' });
  const team = await pool.query(
    'SELECT id, active_member_id FROM teams WHERE id = $1 AND event_id = $2',
    [req.params.teamId, ev.rows[0].id]
  );
  if (!team.rows[0]) return res.status(404).json({ error: 'no such team' });
  const { rows } = await pool.query(
    `INSERT INTO laps (event_id, team_id, member_id, seconds, counted, manual)
     VALUES ($1, $2, $3, $4, true, true) RETURNING *`,
    [ev.rows[0].id, team.rows[0].id, team.rows[0].active_member_id, Number(req.body.seconds) || 0]
  );
  res.json(rows[0]);
});

// Flip a lap between valid and invalid (move failed laps to real, or strike one).
router.patch('/laps/:lapId', async (req, res) => {
  const counted = !!req.body.counted;
  const { rows } = await pool.query(
    `UPDATE laps SET counted = $1,
            reject_reason = CASE WHEN $1 THEN NULL ELSE 'admin_removed' END
      WHERE id = $2 RETURNING *`,
    [counted, req.params.lapId]
  );
  if (!rows[0]) return res.status(404).json({ error: 'no such lap' });
  res.json(rows[0]);
});

// Ops roster: every member with connection freshness, for on-the-day debugging.
router.get('/events/:slug/members', async (req, res) => {
  const { rows } = await pool.query(
    `SELECT m.id, m.name, m.user_id, m.activated_at, m.frozen_at, m.lap_count, m.last_fix,
            t.name AS team, t.active_member_id = m.id AS is_active
       FROM members m JOIN teams t ON t.id = m.team_id
      WHERE m.event_id = (SELECT id FROM events WHERE slug = $1)
      ORDER BY t.name, m.created_at DESC`,
    [req.params.slug]
  );
  res.json(rows.map((m) => ({
    ...m,
    lastPingAgoS: m.last_fix?.at ? Math.round((Date.now() - m.last_fix.at) / 1000) : null,
    last_fix: undefined,
  })));
});

// Force-stop a runner's tracking (lost phone, wrong person streaming, etc).
router.post('/members/:memberId/freeze', async (req, res) => {
  await pool.query('UPDATE members SET frozen_at = now() WHERE id = $1', [req.params.memberId]);
  await pool.query('UPDATE teams SET active_member_id = NULL WHERE active_member_id = $1', [
    req.params.memberId,
  ]);
  res.json({ ok: true });
});

// Wipe race data (laps, members, points) after a rehearsal. Teams, repos, and
// event config survive.
router.post('/events/:slug/reset', async (req, res) => {
  const ev = await pool.query('SELECT id FROM events WHERE slug = $1', [req.params.slug]);
  if (!ev.rows[0]) return res.status(404).json({ error: 'no such event' });
  const id = ev.rows[0].id;
  await pool.query('DELETE FROM points WHERE member_id IN (SELECT id FROM members WHERE event_id = $1)', [id]);
  await pool.query('DELETE FROM laps WHERE event_id = $1', [id]);
  await pool.query('UPDATE teams SET active_member_id = NULL WHERE event_id = $1', [id]);
  await pool.query('DELETE FROM members WHERE event_id = $1', [id]);
  res.json({ ok: true });
});

router.patch('/events/:slug/teams/:teamId', async (req, res) => {
  const { repoUrl } = req.body;
  await pool.query(
    `UPDATE teams SET repo_url = $1, commit_count = CASE WHEN $1 IS NULL OR $1 = '' THEN 0 ELSE commit_count END
      WHERE id = $2 AND event_id = (SELECT id FROM events WHERE slug = $3)`,
    [repoUrl ?? null, req.params.teamId, req.params.slug]
  );
  res.json({ ok: true });
});

router.delete('/events/:slug/teams/:teamId', async (req, res) => {
  await pool.query(
    `DELETE FROM teams WHERE id = $1
       AND event_id = (SELECT id FROM events WHERE slug = $2)`,
    [req.params.teamId, req.params.slug]
  );
  res.json({ ok: true });
});

export default router;
