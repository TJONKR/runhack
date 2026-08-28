import { pool } from './db.js';

// OPTIONAL, BRAGGING RIGHTS ONLY. Devin numbers never touch the score — they
// are a side-stat on the board ("how hard did you drive your agent?").
//
// Wiring, once Cognition provisions an org for the event:
//   DEVIN_API_KEY  service-user key with the ViewOrgSessions permission
//                  (a personal access token works too, but then you only see
//                  your own sessions — useless for a field of teams)
//   DEVIN_ORG_ID   the org- prefixed id; your Devin admin has it
// Without both, this module does nothing at all: no requests, no columns
// populated, nothing rendered. The race does not depend on it.
//
// Mapping sessions to teams: a team optionally registers the email of the
// Devin account it works in. We resolve email -> user_id once against the org
// member list, then group the org's sessions in the event window by user_id.
// That is ONE sessions request per poll for the whole field, not one per team.

// DEVIN_API_BASE exists so the poller can be pointed at a stub in tests.
const BASE = process.env.DEVIN_API_BASE || 'https://api.devin.ai';

export function devinConfigured() {
  return !!(process.env.DEVIN_API_KEY && process.env.DEVIN_ORG_ID);
}

function headers() {
  return {
    Authorization: `Bearer ${process.env.DEVIN_API_KEY}`,
    'Content-Type': 'application/json',
  };
}

async function get(path, params) {
  const url = new URL(path, BASE);
  for (const [k, v] of Object.entries(params || {})) {
    if (v !== undefined && v !== null) url.searchParams.set(k, v);
  }
  const res = await fetch(url, { headers: headers() });
  if (!res.ok) {
    console.error(`devin ${path}: ${res.status} ${(await res.text()).slice(0, 160)}`);
    return null;
  }
  return res.json();
}

// email -> user_id for the org's members. Cached for the process: people are
// added to the org before the race, not during it.
let memberCache = null;
export async function orgMembers() {
  if (memberCache) return memberCache;
  const org = process.env.DEVIN_ORG_ID;
  const body = await get(`/v3/organizations/${org}/members`);
  const rows = body?.items || body?.members || (Array.isArray(body) ? body : []);
  const map = new Map();
  for (const m of rows) {
    const email = (m.email || m.user_email || '').trim().toLowerCase();
    const id = m.user_id || m.id;
    if (email && id) map.set(email, id);
  }
  if (map.size) memberCache = map;
  return map;
}

// Every session in the org created inside the event window, paginated.
// created_after/created_before are seconds-epoch per the insights schema.
export async function sessionsInWindow(startMs, endMs) {
  const org = process.env.DEVIN_ORG_ID;
  const out = [];
  let after = null;
  for (let page = 0; page < 20; page++) {
    // `qs` is the SessionsQueryParams object; send it JSON-encoded.
    const qs = {
      first: 100,
      created_after: Math.floor(startMs / 1000),
      ...(endMs ? { created_before: Math.floor(endMs / 1000) } : {}),
      ...(after ? { after } : {}),
    };
    const body = await get(`/v3/organizations/${org}/sessions/insights`, { qs: JSON.stringify(qs) });
    if (!body) return out; // network/auth failure: keep whatever we have
    out.push(...(body.items || []));
    if (!body.has_next_page || !body.end_cursor) break;
    after = body.end_cursor;
  }
  return out;
}

// Fold the org's sessions onto the teams that registered a Devin email.
export async function pollDevinOnce() {
  if (!devinConfigured()) return;
  const { rows: events } = await pool.query(
    `SELECT id, start_at, end_at FROM events
      WHERE start_at IS NOT NULL AND (end_at IS NULL OR end_at > now() - interval '2 hours')`
  );
  if (!events.length) return;

  for (const event of events) {
    const teams = await pool.query(
      "SELECT id, devin_email FROM teams WHERE event_id = $1 AND devin_email IS NOT NULL AND devin_email <> ''",
      [event.id]
    );
    if (!teams.rows.length) continue;

    const members = await orgMembers();
    const sessions = await sessionsInWindow(
      new Date(event.start_at).getTime(),
      event.end_at ? new Date(event.end_at).getTime() : null
    );
    if (!sessions.length) continue;

    // user_id -> totals
    const byUser = new Map();
    for (const s of sessions) {
      const key = s.user_id || s.service_user_id;
      if (!key) continue;
      const t = byUser.get(key) || { sessions: 0, messages: 0, acus: 0 };
      t.sessions += 1;
      // "chats sent" = what the humans typed at it
      t.messages += Number(s.num_user_messages) || 0;
      t.acus += Number(s.acus_consumed) || 0;
      byUser.set(key, t);
    }

    for (const team of teams.rows) {
      const userId = members.get(team.devin_email.trim().toLowerCase());
      const t = (userId && byUser.get(userId)) || { sessions: 0, messages: 0, acus: 0 };
      await pool.query(
        `UPDATE teams SET devin_sessions = $1, devin_messages = $2, devin_acus = $3,
                          devin_checked_at = now()
          WHERE id = $4`,
        [t.sessions, t.messages, +t.acus.toFixed(2), team.id]
      );
    }
  }
}

// Same 5-minute cadence as the GitHub poller. Failures are logged and skipped;
// a Devin outage must never take the board down.
export function startDevinPoller() {
  if (!devinConfigured()) {
    console.log('devin: not configured (set DEVIN_API_KEY + DEVIN_ORG_ID to enable) — skipping');
    return;
  }
  const tick = () => pollDevinOnce().catch((err) => console.error('devin poll failed:', err.message));
  setTimeout(tick, 10_000);
  setInterval(tick, 5 * 60_000);
}
