import { pool } from './db.js';

// Pulls each team's public repo (default branch) within the event window:
// commit count + the newest commit's message/author/time (same request),
// and — token only — the distinct committer count (one extra request).
//
// Unauthenticated GitHub allows 60 req/hr/IP, so we poll every 5 min without a
// token and every 60s with GITHUB_TOKEN set.

export function parseRepo(input) {
  if (!input) return null;
  const m = String(input)
    .trim()
    .match(/^(?:https?:\/\/github\.com\/)?([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/);
  return m ? { owner: m[1], repo: m[2] } : null;
}

function ghHeaders() {
  const headers = { 'User-Agent': 'runhack-board', Accept: 'application/vnd.github+json' };
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  return headers;
}

// One request: commit count in window (per_page=1 + Link header's last page)
// plus the newest commit's details from the response body.
export async function fetchRepoActivity(repoUrl, sinceIso, untilIso) {
  const parsed = parseRepo(repoUrl);
  if (!parsed) return null;
  const params = new URLSearchParams({ per_page: '1' });
  if (sinceIso) params.set('since', sinceIso);
  if (untilIso) params.set('until', untilIso);

  const res = await fetch(
    `https://api.github.com/repos/${parsed.owner}/${parsed.repo}/commits?${params}`,
    { headers: ghHeaders() }
  );
  if (res.status === 409) return { count: 0, latest: null }; // empty repo
  if (!res.ok) {
    console.error(`github ${parsed.owner}/${parsed.repo}: ${res.status}`);
    return null;
  }
  const body = await res.json();
  const link = res.headers.get('link');
  const last = link?.match(/[?&]page=(\d+)>; rel="last"/);
  const count = last ? Number(last[1]) : body.length;
  const newest = body[0];
  const latest = newest
    ? {
        message: (newest.commit?.message || '').split('\n')[0].slice(0, 120),
        author: newest.author?.login || newest.commit?.author?.name || null,
        at: newest.commit?.author?.date || null,
      }
    : null;
  return { count, latest };
}

// Back-compat helper used by the admin check-repo endpoint.
export async function countCommits(repoUrl, sinceIso, untilIso) {
  const r = await fetchRepoActivity(repoUrl, sinceIso, untilIso);
  return r ? r.count : null;
}

// Token only (extra request per team): distinct committers in the window.
async function fetchCommitters(repoUrl, sinceIso, untilIso) {
  if (!process.env.GITHUB_TOKEN) return null;
  const parsed = parseRepo(repoUrl);
  if (!parsed) return null;
  const params = new URLSearchParams({ per_page: '100' });
  if (sinceIso) params.set('since', sinceIso);
  if (untilIso) params.set('until', untilIso);
  const res = await fetch(
    `https://api.github.com/repos/${parsed.owner}/${parsed.repo}/commits?${params}`,
    { headers: ghHeaders() }
  );
  if (!res.ok) return null;
  const commits = await res.json();
  const who = new Set(
    commits.map((c) => c.author?.login || c.commit?.author?.email || c.commit?.author?.name).filter(Boolean)
  );
  return who.size;
}

export async function pollOnce() {
  const { rows } = await pool.query(
    `SELECT t.id, t.repo_url, e.start_at, e.end_at, e.created_at
       FROM teams t JOIN events e ON e.id = t.event_id
      WHERE t.repo_url IS NOT NULL AND t.repo_url <> ''
        AND (e.end_at IS NULL OR e.end_at > now() - interval '1 hour')`
  );
  for (const t of rows) {
    try {
      const since = (t.start_at || t.created_at)?.toISOString?.();
      const until = t.end_at?.toISOString?.();
      const activity = await fetchRepoActivity(t.repo_url, since, until);
      if (activity) {
        const committers = await fetchCommitters(t.repo_url, since, until).catch(() => null);
        await pool.query(
          `UPDATE teams SET commit_count = $1, commits_checked_at = now(), repo_status = 'connected',
                  last_commit_msg = $2, last_commit_author = $3, last_commit_at = $4,
                  committers = COALESCE($5, committers)
            WHERE id = $6`,
          [
            activity.count,
            activity.latest?.message ?? null,
            activity.latest?.author ?? null,
            activity.latest?.at ?? null,
            committers,
            t.id,
          ]
        );
      } else {
        await pool.query("UPDATE teams SET repo_status = 'error' WHERE id = $1", [t.id]);
      }
    } catch (err) {
      console.error('github poll failed for team', t.id, err.message);
    }
  }
}

export function startGithubPoller() {
  // 5-minute cadence: teams commit every 10-30 min at best, so fresher data
  // buys nothing, and 30 repos x 2 calls x 12 polls/hr = 720/hr leaves 86%
  // headroom on the 5000/hr token limit (the admin "test" button gives an
  // instant refresh when someone needs one).
  const intervalMs = 300_000;
  pollOnce().catch((e) => console.error('github poll', e.message));
  setInterval(() => pollOnce().catch((e) => console.error('github poll', e.message)), intervalMs);
  console.log(`github poller every ${intervalMs / 1000}s (${process.env.GITHUB_TOKEN ? 'token' : 'NO TOKEN — 60 req/hr cap, set GITHUB_TOKEN'})`);
}
