import test from 'node:test';
import assert from 'node:assert';
import http from 'node:http';

// The Devin side-stat poller, exercised against a stub that speaks the shapes
// documented for /v3/organizations/{org}/members and .../sessions/insights.
// No Devin account required to run this.

function stubDevin(handler) {
  const server = http.createServer((req, res) => {
    const body = handler(req);
    res.writeHead(body ? 200 : 404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body ?? { error: 'not found' }));
  });
  return new Promise((resolve) => server.listen(0, () => resolve(server)));
}

test('devin: unconfigured is inert', async () => {
  delete process.env.DEVIN_API_KEY;
  delete process.env.DEVIN_ORG_ID;
  const { devinConfigured } = await import('../src/devin.js?fresh=1');
  assert.equal(devinConfigured(), false);
});

test('devin: members map + session aggregation by user', async () => {
  const server = await stubDevin((req) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname.endsWith('/members')) {
      return { items: [
        { user_id: 'u-ada', email: 'Ada@Team.com' },
        { user_id: 'u-lin', email: 'lin@team.com' },
      ] };
    }
    if (url.pathname.endsWith('/sessions/insights')) {
      const qs = JSON.parse(url.searchParams.get('qs'));
      assert.ok(qs.created_after, 'window start is sent');
      // one page, deliberately mixed users + a session with no user
      return { items: [
        { session_id: 's1', user_id: 'u-ada', num_user_messages: 12, num_devin_messages: 30, acus_consumed: 4.5 },
        { session_id: 's2', user_id: 'u-ada', num_user_messages: 8, num_devin_messages: 20, acus_consumed: 2.25 },
        { session_id: 's3', user_id: 'u-lin', num_user_messages: 3, num_devin_messages: 9, acus_consumed: 1 },
        { session_id: 's4', user_id: null, service_user_id: null, num_user_messages: 99, acus_consumed: 99 },
      ], has_next_page: false, end_cursor: null };
    }
    return null;
  });
  const port = server.address().port;
  process.env.DEVIN_API_KEY = 'test-key';
  process.env.DEVIN_ORG_ID = 'org-test';
  process.env.DEVIN_API_BASE = `http://127.0.0.1:${port}`;

  const devin = await import('../src/devin.js?fresh=2');
  assert.equal(devin.devinConfigured(), true);

  const members = await devin.orgMembers();
  // emails are matched case-insensitively — people type them by hand
  assert.equal(members.get('ada@team.com'), 'u-ada');

  const sessions = await devin.sessionsInWindow(Date.parse('2026-08-29T09:00:00Z'), Date.parse('2026-08-29T17:00:00Z'));
  assert.equal(sessions.length, 4);

  // the fold the poller does: prompts sent BY humans, per user
  const byUser = new Map();
  for (const s of sessions) {
    const key = s.user_id || s.service_user_id;
    if (!key) continue;
    const t = byUser.get(key) || { sessions: 0, messages: 0, acus: 0 };
    t.sessions += 1;
    t.messages += Number(s.num_user_messages) || 0;
    t.acus += Number(s.acus_consumed) || 0;
    byUser.set(key, t);
  }
  assert.deepEqual(byUser.get('u-ada'), { sessions: 2, messages: 20, acus: 6.75 });
  assert.deepEqual(byUser.get('u-lin'), { sessions: 1, messages: 3, acus: 1 });
  assert.equal(byUser.has(null), false, 'sessions with no owner are dropped, not credited');

  server.close();
});

test('devin: an API failure yields nothing rather than throwing', async () => {
  const server = await stubDevin(() => null); // everything 404s
  const port = server.address().port;
  process.env.DEVIN_API_KEY = 'test-key';
  process.env.DEVIN_ORG_ID = 'org-test';
  process.env.DEVIN_API_BASE = `http://127.0.0.1:${port}`;
  const devin = await import('../src/devin.js?fresh=3');
  assert.deepEqual(await devin.sessionsInWindow(Date.now() - 1000, null), []);
  server.close();
});
