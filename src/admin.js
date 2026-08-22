import { Router } from 'express';
import { pool } from './db.js';
import { countCommits } from './github.js';

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
            (SELECT count(*) FROM members m WHERE m.team_id = t.id) AS member_count,
            (SELECT count(*) FROM members m WHERE m.team_id = t.id AND m.activated_at IS NOT NULL) AS connected_count
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

// Manually credit laps to a team (attributed to the active runner if any).
router.post('/events/:slug/teams/:teamId/laps', async (req, res) => {
  const ev = await pool.query('SELECT id FROM events WHERE slug = $1', [req.params.slug]);
  if (!ev.rows[0]) return res.status(404).json({ error: 'no such event' });
  const team = await pool.query(
    'SELECT id, active_member_id FROM teams WHERE id = $1 AND event_id = $2',
    [req.params.teamId, ev.rows[0].id]
  );
  if (!team.rows[0]) return res.status(404).json({ error: 'no such team' });
  const count = Math.min(50, Math.max(1, Math.round(Number(req.body.count) || 1)));
  const seconds = Number(req.body.seconds) || 0;
  const inserted = [];
  for (let i = 0; i < count; i++) {
    const { rows } = await pool.query(
      `INSERT INTO laps (event_id, team_id, member_id, seconds, counted, manual)
       VALUES ($1, $2, $3, $4, true, true) RETURNING id`,
      [ev.rows[0].id, team.rows[0].id, team.rows[0].active_member_id, seconds]
    );
    inserted.push(rows[0].id);
  }
  res.json({ ok: true, inserted });
});

// Edit a lap: flip valid/invalid and/or correct its time.
router.patch('/laps/:lapId', async (req, res) => {
  const sets = [];
  const vals = [];
  if ('counted' in req.body) {
    vals.push(!!req.body.counted);
    sets.push(`counted = $${vals.length}`,
      `reject_reason = CASE WHEN $${vals.length} THEN NULL ELSE 'admin_removed' END`);
  }
  if ('seconds' in req.body) {
    vals.push(Math.max(0, Number(req.body.seconds) || 0));
    sets.push(`seconds = $${vals.length}`);
  }
  if (!sets.length) return res.status(400).json({ error: 'nothing to update' });
  vals.push(req.params.lapId);
  const { rows } = await pool.query(
    `UPDATE laps SET ${sets.join(', ')} WHERE id = $${vals.length} RETURNING *`,
    vals
  );
  if (!rows[0]) return res.status(404).json({ error: 'no such lap' });
  res.json(rows[0]);
});

// Ops roster: every member with connection freshness, for on-the-day debugging.
router.get('/events/:slug/members', async (req, res) => {
  const { rows } = await pool.query(
    `SELECT m.id, m.name, m.user_id, m.team_id, m.activated_at, m.frozen_at, m.lap_count, m.last_fix,
            t.name AS team, t.active_member_id = m.id AS is_active
       FROM members m JOIN teams t ON t.id = m.team_id
      WHERE m.event_id = (SELECT id FROM events WHERE slug = $1)
      ORDER BY t.name, m.created_at DESC`,
    [req.params.slug]
  );
  res.json(rows.map((m) => ({
    ...m,
    lastPingAgoS: m.last_fix?.at ? Math.round((Date.now() - m.last_fix.at) / 1000) : null,
    lat: m.last_fix?.lat ?? null,
    lng: m.last_fix?.lng ?? null,
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

// Partial team update: rename, repo, commit override (null clears), score adjust.
router.patch('/events/:slug/teams/:teamId', async (req, res) => {
  const sets = [];
  const vals = [];
  const add = (sql, v) => { vals.push(v); sets.push(sql.replace('?', `$${vals.length}`)); };
  if ('name' in req.body) {
    if (!req.body.name?.trim()) return res.status(400).json({ error: 'name cannot be empty' });
    add('name = ?', req.body.name.trim());
  }
  if ('repoUrl' in req.body) {
    add('repo_url = ?', req.body.repoUrl || null);
    add('repo_status = ?', null); // unknown until tested/polled again
    if (!req.body.repoUrl) add('commit_count = ?', 0);
  }
  if ('commitOverride' in req.body) {
    const v = req.body.commitOverride;
    add('commit_override = ?', v === null || v === '' ? null : Math.max(0, Math.round(Number(v))));
  }
  if ('scoreAdjust' in req.body) add('score_adjust = ?', Number(req.body.scoreAdjust) || 0);
  if (!sets.length) return res.status(400).json({ error: 'nothing to update' });
  vals.push(req.params.teamId, req.params.slug);
  const { rows } = await pool.query(
    `UPDATE teams SET ${sets.join(', ')}
      WHERE id = $${vals.length - 1} AND event_id = (SELECT id FROM events WHERE slug = $${vals.length})
      RETURNING *`,
    vals
  );
  if (!rows[0]) return res.status(404).json({ error: 'no such team' });
  res.json(rows[0]);
});

// Test a team's GitHub connection right now: reachable, public, and counts
// commits in the event window. Persists the verdict.
router.post('/events/:slug/teams/:teamId/check-repo', async (req, res) => {
  const { rows } = await pool.query(
    `SELECT t.id, t.repo_url, e.start_at, e.end_at, e.created_at
       FROM teams t JOIN events e ON e.id = t.event_id
      WHERE t.id = $1 AND e.slug = $2`,
    [req.params.teamId, req.params.slug]
  );
  const t = rows[0];
  if (!t) return res.status(404).json({ error: 'no such team' });
  if (!t.repo_url) return res.json({ status: 'not_set' });
  const since = (t.start_at || t.created_at)?.toISOString?.();
  const until = t.end_at?.toISOString?.();
  const count = await countCommits(t.repo_url, since, until).catch(() => null);
  const status = count == null ? 'error' : 'connected';
  await pool.query(
    `UPDATE teams SET repo_status = $1,
            commit_count = COALESCE($2, commit_count),
            commits_checked_at = CASE WHEN $2 IS NULL THEN commits_checked_at ELSE now() END
      WHERE id = $3`,
    [status, count, t.id]
  );
  res.json({ status, commits: count });
});

// ---- Member surgery: everything a marshal might need to fix on the day ----

// Rename or move a member to another team (optionally taking their laps along).
router.patch('/members/:memberId', async (req, res) => {
  const m = await pool.query('SELECT * FROM members WHERE id = $1', [req.params.memberId]);
  const member = m.rows[0];
  if (!member) return res.status(404).json({ error: 'no such member' });
  if ('name' in req.body && req.body.name?.trim()) {
    await pool.query('UPDATE members SET name = $1 WHERE id = $2', [req.body.name.trim(), member.id]);
  }
  if ('teamId' in req.body && Number(req.body.teamId) !== member.team_id) {
    const t = await pool.query('SELECT id FROM teams WHERE id = $1 AND event_id = $2', [
      req.body.teamId, member.event_id,
    ]);
    if (!t.rows[0]) return res.status(404).json({ error: 'no such team in this event' });
    await pool.query('UPDATE teams SET active_member_id = NULL WHERE active_member_id = $1', [member.id]);
    await pool.query('UPDATE members SET team_id = $1 WHERE id = $2', [t.rows[0].id, member.id]);
    if (req.body.moveLaps) {
      await pool.query('UPDATE laps SET team_id = $1 WHERE member_id = $2', [t.rows[0].id, member.id]);
    }
  }
  res.json({ ok: true });
});

// Undo a freeze (or a handoff that shouldn't have happened).
router.post('/members/:memberId/unfreeze', async (req, res) => {
  await pool.query('UPDATE members SET frozen_at = NULL WHERE id = $1', [req.params.memberId]);
  res.json({ ok: true });
});

// Force this member to be the team's active runner (phone died mid-stint and
// the previous runner is resuming, marshal picks who's live).
router.post('/members/:memberId/activate', async (req, res) => {
  const m = await pool.query('SELECT id, team_id FROM members WHERE id = $1', [req.params.memberId]);
  if (!m.rows[0]) return res.status(404).json({ error: 'no such member' });
  const { id, team_id } = m.rows[0];
  await pool.query(
    `UPDATE members SET frozen_at = now() WHERE id = (SELECT active_member_id FROM teams WHERE id = $1) AND id <> $2`,
    [team_id, id]
  );
  await pool.query(
    "UPDATE members SET frozen_at = NULL, activated_at = COALESCE(activated_at, now()) WHERE id = $1",
    [id]
  );
  await pool.query('UPDATE teams SET active_member_id = $1 WHERE id = $2', [id, team_id]);
  res.json({ ok: true });
});

// Clear a member's lap state machine (stuck in a weird phase). Laps survive.
router.post('/members/:memberId/reset-state', async (req, res) => {
  await pool.query("UPDATE members SET state = '{}' WHERE id = $1", [req.params.memberId]);
  res.json({ ok: true });
});

// Remove a member (mis-join, duplicate). Their laps stay with the team,
// unattributed, so the score doesn't silently change.
router.delete('/members/:memberId', async (req, res) => {
  await pool.query('UPDATE laps SET member_id = NULL WHERE member_id = $1', [req.params.memberId]);
  await pool.query('UPDATE teams SET active_member_id = NULL WHERE active_member_id = $1', [req.params.memberId]);
  await pool.query('DELETE FROM points WHERE member_id = $1', [req.params.memberId]);
  await pool.query('DELETE FROM members WHERE id = $1', [req.params.memberId]);
  res.json({ ok: true });
});

// Delete a whole event (old tests, duplicates). Everything under it goes.
router.delete('/events/:slug', async (req, res) => {
  const ev = await pool.query('SELECT id FROM events WHERE slug = $1', [req.params.slug]);
  if (!ev.rows[0]) return res.status(404).json({ error: 'no such event' });
  const id = ev.rows[0].id;
  await pool.query('DELETE FROM points WHERE member_id IN (SELECT id FROM members WHERE event_id = $1)', [id]);
  await pool.query('DELETE FROM laps WHERE event_id = $1', [id]);
  await pool.query('DELETE FROM events WHERE id = $1', [id]); // teams/members cascade
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
