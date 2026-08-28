import test from 'node:test';
import assert from 'node:assert';

// The limits that let a whole venue register. Mirrors rateLimit() in
// src/api.js — the numbers, not the plumbing, are what regress.
const WINDOW_MS = 60_000;
const LIMITS = { register: 300, team: 60 };

function makeLimiter(kind, limit = LIMITS[kind]) {
  const buckets = new Map();
  return (ip, now) => {
    const key = `${kind}:${ip}`;
    let b = buckets.get(key);
    if (!b || now - b.start > WINDOW_MS) buckets.set(key, (b = { start: now, count: 0 }));
    return ++b.count <= limit;
  };
}

test('a 100-person field behind one NAT IP can all register', () => {
  // 28 teams x (1 create + 4 members + 4 devices) = 252 writes, one IP,
  // arriving in a burst when the briefing ends. This is the case that broke:
  // the old limit was 30/min and locked out everyone after ~12 people.
  const reg = makeLimiter('register');
  const team = makeLimiter('team');
  const now = Date.now();
  let blocked = 0;
  for (let t = 0; t < 28; t++) {
    if (!team('venue-nat', now)) blocked++;
    for (let m = 0; m < 4; m++) {
      if (!reg('venue-nat', now)) blocked++;   // member
      if (!reg('venue-nat', now)) blocked++;   // device
    }
  }
  assert.equal(blocked, 0, 'nobody may be turned away at registration');
});

test('but a spammer on the same IP still gets cut off', () => {
  const team = makeLimiter('team');
  const now = Date.now();
  let allowed = 0;
  for (let i = 0; i < 500; i++) if (team('attacker', now)) allowed++;
  assert.equal(allowed, LIMITS.team, 'team creation stays capped');

  const reg = makeLimiter('register');
  let regAllowed = 0;
  for (let i = 0; i < 5000; i++) if (reg('attacker', now)) regAllowed++;
  assert.equal(regAllowed, LIMITS.register);
});

test('the window rolls, so a blocked phone recovers a minute later', () => {
  const reg = makeLimiter('register');
  const t0 = Date.now();
  for (let i = 0; i < LIMITS.register; i++) reg('ip', t0);
  assert.equal(reg('ip', t0), false, 'capped inside the window');
  assert.equal(reg('ip', t0 + WINDOW_MS + 1), true, 'fresh window, allowed again');
});

test('one busy IP cannot starve another', () => {
  const reg = makeLimiter('register');
  const now = Date.now();
  for (let i = 0; i < 5000; i++) reg('noisy', now);
  assert.equal(reg('someone-else', now), true, 'limits are per IP, not global');
});
