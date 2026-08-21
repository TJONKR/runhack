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
