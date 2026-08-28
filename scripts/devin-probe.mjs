// Probes the real Devin API with a key from ~/runhack/.devin-key (gitignored).
// Verifies the exact shapes src/devin.js depends on. Prints NO secrets.
import fs from 'node:fs';
const KEY = (fs.readFileSync(new URL('../.devin-key', import.meta.url), 'utf8') || '').trim();
const BASE = process.env.DEVIN_API_BASE || 'https://api.devin.ai';
if (!KEY) { console.error('no key in .devin-key'); process.exit(1); }
console.log(`key: ${KEY.slice(0, 4)}…${KEY.slice(-3)} (${KEY.length} chars)\n`);

async function call(path) {
  const res = await fetch(`${BASE}${path}`, { headers: { Authorization: `Bearer ${KEY}` } });
  const text = await res.text();
  let body; try { body = JSON.parse(text); } catch { body = text.slice(0, 300); }
  return { status: res.status, ok: res.ok, body };
}
const keys = (o) => (o && typeof o === 'object' ? Object.keys(o).join(', ') : typeof o);

// 1. who am I / which org
const self = await call('/v3/self');
console.log(`1. GET /v3/self -> ${self.status}`);
if (!self.ok) { console.log('   body:', JSON.stringify(self.body).slice(0, 300)); process.exit(1); }
console.log('   fields:', keys(self.body));
const org = self.body.org_id ?? self.body.organization_id ?? self.body.organization?.id;
console.log('   org_id resolved:', org ? 'YES' : `NO  <-- src/devin.js expects self.org_id`);
if (!org) process.exit(1);

// 2. org sessions (what the poller lists)
const since = Math.floor((Date.now() - 30 * 864e5) / 1000);
const s = await call(`/v3/organizations/${encodeURIComponent(org)}/sessions?first=5&created_after=${since}`);
console.log(`\n2. GET /v3/organizations/{org}/sessions -> ${s.status}`);
if (!s.ok) {
  console.log('   body:', JSON.stringify(s.body).slice(0, 300));
  console.log('   ^ 403 here = key lacks ViewOrgSessions');
} else {
  console.log('   top-level:', keys(s.body));
  const items = s.body.items ?? [];
  console.log(`   items: ${items.length} | has_next_page: ${s.body.has_next_page} | end_cursor: ${s.body.end_cursor ? 'present' : 'null'}`);
  if (items[0]) {
    console.log('   session fields:', keys(items[0]));
    for (const f of ['session_id', 'status', 'acus_consumed', 'pull_requests', 'created_at']) {
      console.log(`     ${f}: ${f in items[0] ? 'present' : 'MISSING <-- code expects this'}`);
    }
    // 3. messages for one session
    const m = await call(`/v3/organizations/${encodeURIComponent(org)}/sessions/${encodeURIComponent(items[0].session_id)}/messages?first=5`);
    console.log(`\n3. GET .../sessions/{id}/messages -> ${m.status}`);
    if (m.ok) {
      console.log('   top-level:', keys(m.body));
      console.log(`   total: ${m.body.total ?? 'ABSENT (falls back to counting pages)'}`);
    } else console.log('   body:', JSON.stringify(m.body).slice(0, 200));
  } else {
    console.log('   (no sessions in the last 30 days — shapes for items unverified)');
  }
}

// 4. the insights endpoint (richer: message counts without N calls)
const i = await call(`/v3/organizations/${encodeURIComponent(org)}/sessions/insights?qs=${encodeURIComponent(JSON.stringify({ first: 5, created_after: since }))}`);
console.log(`\n4. GET .../sessions/insights -> ${i.status}`);
if (i.ok) {
  const it = (i.body.items ?? [])[0];
  console.log('   items:', (i.body.items ?? []).length);
  if (it) console.log('   fields:', keys(it));
} else console.log('   body:', JSON.stringify(i.body).slice(0, 200));
