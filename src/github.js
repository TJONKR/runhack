import { pool } from './db.js';

// Counts commits on each team's public repo (default branch) within the event
// window and caches the count on the team row. One request per team per poll
// using per_page=1 + the Link header's last-page number.
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

async function countCommits(repoUrl, sinceIso, untilIso) {
  const parsed = parseRepo(repoUrl);
  if (!parsed) return null;
  const params = new URLSearchParams({ per_page: '1' });
  if (sinceIso) params.set('since', sinceIso);
  if (untilIso) params.set('until', untilIso);
  const headers = { 'User-Agent': 'runhack-board', Accept: 'application/vnd.github+json' };
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;

  const res = await fetch(
    `https://api.github.com/repos/${parsed.owner}/${parsed.repo}/commits?${params}`,
    { headers }
  );
  if (res.status === 409) return 0; // empty repo
  if (!res.ok) {
    console.error(`github ${parsed.owner}/${parsed.repo}: ${res.status}`);
    return null;
  }
  const link = res.headers.get('link');
  if (!link) return (await res.json()).length; // 0 or 1, no pagination
  const last = link.match(/[?&]page=(\d+)>; rel="last"/);
  return last ? Number(last[1]) : (await res.json()).length;
}

async function pollOnce() {
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
      const count = await countCommits(t.repo_url, since, until);
      if (count != null) {
        await pool.query(
          'UPDATE teams SET commit_count = $1, commits_checked_at = now() WHERE id = $2',
          [count, t.id]
        );
      }
    } catch (err) {
      console.error('github poll failed for team', t.id, err.message);
    }
  }
}

export function startGithubPoller() {
  const intervalMs = process.env.GITHUB_TOKEN ? 60_000 : 300_000;
  pollOnce().catch((e) => console.error('github poll', e.message));
  setInterval(() => pollOnce().catch((e) => console.error('github poll', e.message)), intervalMs);
  console.log(`github poller every ${intervalMs / 1000}s (${process.env.GITHUB_TOKEN ? 'token' : 'no token, add GITHUB_TOKEN for 60s polling'})`);
}
