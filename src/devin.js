import { pool, eventConfig, devinWindow } from './db.js';

// OPTIONAL, BRAGGING RIGHTS ONLY. Devin numbers never touch the score — they
// are a side-stat on the board ("how hard did you drive your agent?"), and a
// team that skips it loses nothing.
//
// Built on the **v1** API, deliberately. The v3 org endpoints
// (/v3/self, /v3/organizations/{org}/sessions[/insights]) return 403 for an
// ordinary key from app.devin.ai/settings/api-keys — they need an enterprise
// service user with org-level permissions. v1 works with the key any
// participant can mint in 30 seconds, and scopes to that key's own sessions,
// which is exactly one team. Verified against the live API on 28 Aug 2026.
//
// What v1 gives us, and what it doesn't:
//   /v1/sessions      -> session_id, status_enum, created_at, updated_at, tags,
//                        pull_request {url}, requesting_user_email.
//                        limit/offset paging; NO date filter, so the event
//                        window is applied client-side.
//   /v1/session/{id}  -> the above + messages[] with type:
//                        initial_user_message | user_message | devin_message
//   acus_consumed     -> NOT in v1. It exists on v3's insights endpoint; if we
//                        ever get enterprise keys, read ACUs from there.

const BASE = process.env.DEVIN_API_BASE || 'https://api.devin.ai';
// status_enum seen in the wild: working, blocked, expired, finished,
// suspended, resumed. "Still going" is anything not finished/expired.
const DONE_STATUSES = new Set(['finished', 'expired']);
const HUMAN_MESSAGE_TYPES = new Set(['initial_user_message', 'user_message']);

async function devinFetch(apiKey, path) {
  const res = await fetch(`${BASE}${path}`, { headers: { Authorization: `Bearer ${apiKey}` } });
  if (!res.ok) {
    throw new Error(`Devin ${path.split('?')[0]} -> ${res.status} ${(await res.text()).slice(0, 160)}`);
  }
  return res.json();
}

/** Validate a key at entry so a typo fails in front of whoever typed it. */
export async function verifyKey(apiKey) {
  await devinFetch(apiKey, '/v1/sessions?limit=1');
  return true;
}

/** Every session this key can see, paged. */
export async function listSessions(apiKey, { pageSize = 100, maxPages = 10 } = {}) {
  const out = [];
  for (let page = 0; page < maxPages; page++) {
    const body = await devinFetch(apiKey, `/v1/sessions?limit=${pageSize}&offset=${page * pageSize}`);
    const batch = body.sessions ?? body.items ?? [];
    out.push(...batch);
    if (batch.length < pageSize) break;
  }
  return out;
}

/** Timestamps come back as ISO strings, but be liberal: some feeds hand back
 *  epoch seconds or millis. Returns ms, or null if it can't be read. */
export function toMs(v) {
  if (v == null) return null;
  if (typeof v === 'number') return v > 1e12 ? v : v * 1000;
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : t;
}

export function within(value, startMs, endMs) {
  const t = toMs(value);
  if (t == null) return false;
  if (startMs && t < startMs) return false;
  if (endMs && t > endMs) return false;
  return true;
}

/** A session is RELEVANT to the race day if it could have been touched during
 *  it: created before the finish and still moving after the gun. Sessions
 *  opened the night before are not excluded here — whether any actual work
 *  happened on the day is decided per-message, below. */
export function overlapsWindow(session, startMs, endMs) {
  const created = toMs(session.created_at);
  const updated = toMs(session.updated_at) ?? created;
  if (created == null) return false;
  if (endMs && created > endMs) return false;
  if (startMs && updated != null && updated < startMs) return false;
  return true;
}

export function isActive(session) {
  return !DONE_STATUSES.has(String(session.status_enum ?? session.status ?? '').toLowerCase());
}

/** Prompts a human typed ON THE DAY — not Devin's replies, and not work done
 *  before the gun or after the finish. Counting the messages rather than the
 *  session is the only way "activity on the 29th" is honest: a session opened
 *  the night before still counts for whatever was typed into it during the
 *  race, and nothing typed after the finish sneaks in. */
export function countHumanMessages(sessionDetail, startMs = null, endMs = null) {
  return (sessionDetail.messages ?? []).filter(
    (m) => HUMAN_MESSAGE_TYPES.has(m.type) && (!startMs && !endMs ? true : within(m.timestamp, startMs, endMs))
  ).length;
}

/** Only sessions with prompts on the day are counted — a session that merely
 *  existed through the window but was never touched is not "activity". */
export function aggregate(sessions, msgsBySession) {
  let active = 0;
  let prs = 0;
  let msgs = 0;
  let touched = 0;
  for (const s of sessions) {
    const n = msgsBySession.get(s.session_id) ?? 0;
    if (n === 0) continue;
    touched++;
    if (isActive(s)) active++;
    if (s.pull_request?.url) prs++;
    msgs += n;
  }
  // prsMerged/acus stay 0: v1 exposes only pull_request.url (no state) and no
  // ACUs at all. Columns are kept so a future enterprise key can fill them in
  // from v3 insights without another migration.
  return { sessions: touched, active, msgs, prsOpen: prs, prsMerged: 0, acus: 0 };
}

// Message counts need a detail call per session, so cache them and only
// re-fetch a session whose updated_at moved. A finished session never changes.
const msgCache = new Map(); // session_id -> { updatedAt, count }

export async function fetchTeamMetrics(apiKey, startMs, endMs) {
  const all = await listSessions(apiKey);
  const sessions = all.filter((s) => overlapsWindow(s, startMs, endMs));
  const counts = new Map();
  const CONCURRENCY = 4;
  for (let i = 0; i < sessions.length; i += CONCURRENCY) {
    const batch = sessions.slice(i, i + CONCURRENCY);
    await Promise.all(
      batch.map(async (s) => {
        const cacheKey = `${s.session_id}:${startMs}:${endMs}`;
        const cached = msgCache.get(cacheKey);
        if (cached && cached.updatedAt === s.updated_at) {
          counts.set(s.session_id, cached.count);
          return;
        }
        try {
          const detail = await devinFetch(apiKey, `/v1/session/${encodeURIComponent(s.session_id)}`);
          const count = countHumanMessages(detail, startMs, endMs);
          msgCache.set(cacheKey, { updatedAt: s.updated_at, count });
          counts.set(s.session_id, count);
        } catch {
          // one unreadable session must not sink the team's whole line
          counts.set(s.session_id, cached?.count ?? 0);
        }
      })
    );
  }
  return aggregate(sessions, counts);
}

export async function pollOnce() {
  const { rows } = await pool.query(
    `SELECT t.id, t.devin_api_key, t.created_at AS team_created_at,
            e.start_at, e.end_at, e.created_at AS event_created_at, e.config
       FROM teams t JOIN events e ON e.id = t.event_id
      WHERE t.devin_api_key IS NOT NULL AND t.devin_api_key <> ''
        AND (e.end_at IS NULL OR e.end_at > now() - interval '8 hours')`
  );
  for (const t of rows) {
    try {
      // whole race day by default — see devinWindow() in db.js
      const { startMs, endMs } = devinWindow(
        { start_at: t.start_at, end_at: t.end_at, created_at: t.event_created_at || t.team_created_at },
        eventConfig({ config: t.config })
      );
      const m = await fetchTeamMetrics(t.devin_api_key, startMs, endMs);
      await pool.query(
        `UPDATE teams SET devin_sessions = $1, devin_active = $2, devin_msgs = $3,
                devin_prs_open = $4, devin_prs_merged = $5, devin_acus = $6,
                devin_checked_at = now(), devin_status = 'connected'
          WHERE id = $7`,
        [m.sessions, m.active, m.msgs, m.prsOpen, m.prsMerged, m.acus, t.id]
      );
    } catch (err) {
      console.error('devin poll failed for team', t.id, err.message);
      await pool.query("UPDATE teams SET devin_status = 'error' WHERE id = $1", [t.id]);
    }
  }
}

// 2 minutes: one list call per team plus a detail call per changed session.
// A Devin outage logs and is skipped; it can never take the board down.
export function startDevinPoller() {
  const intervalMs = 120_000;
  const run = () => pollOnce().catch((e) => console.error('devin poll:', e.message));
  setTimeout(run, 15_000);
  setInterval(run, intervalMs);
  console.log(`devin poller every ${intervalMs / 1000}s (v1 API)`);
}
