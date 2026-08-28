import pg from 'pg';

export const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('render.com')
    ? { rejectUnauthorized: false }
    : undefined,
});

export async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS events (
      id          serial PRIMARY KEY,
      slug        text UNIQUE NOT NULL,
      name        text NOT NULL,
      zones       jsonb NOT NULL DEFAULT '[]',
      config      jsonb NOT NULL DEFAULT '{}',
      created_at  timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS teams (
      id          serial PRIMARY KEY,
      event_id    integer NOT NULL REFERENCES events(id) ON DELETE CASCADE,
      name        text NOT NULL,
      active_member_id integer,
      created_at  timestamptz NOT NULL DEFAULT now(),
      UNIQUE (event_id, name)
    );

    CREATE TABLE IF NOT EXISTS members (
      id          serial PRIMARY KEY,
      event_id    integer NOT NULL REFERENCES events(id) ON DELETE CASCADE,
      team_id     integer NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
      user_id     text UNIQUE NOT NULL,
      name        text NOT NULL,
      activated_at timestamptz,
      frozen_at   timestamptz,
      state       jsonb NOT NULL DEFAULT '{}',
      lap_count   integer NOT NULL DEFAULT 0,
      last_lap_s  real,
      last_fix    jsonb,
      created_at  timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS laps (
      id          serial PRIMARY KEY,
      event_id    integer NOT NULL,
      team_id     integer NOT NULL,
      member_id   integer NOT NULL,
      seconds     real NOT NULL,
      counted     boolean NOT NULL,
      reject_reason text,
      finished_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS points (
      id          bigserial PRIMARY KEY,
      member_id   integer NOT NULL,
      lat         double precision NOT NULL,
      lng         double precision NOT NULL,
      accuracy_m  real,
      speed_ms    real,
      fixed_at    timestamptz NOT NULL,
      received_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS points_member_time ON points (member_id, fixed_at);

    CREATE TABLE IF NOT EXISTS devices (
      id          serial PRIMARY KEY,
      event_id    integer NOT NULL REFERENCES events(id) ON DELETE CASCADE,
      team_id     integer NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
      member_id   integer REFERENCES members(id) ON DELETE SET NULL,
      token       text UNIQUE NOT NULL,
      name        text,
      activated_at timestamptz,
      state       jsonb NOT NULL DEFAULT '{}',
      lap_count   integer NOT NULL DEFAULT 0,
      last_lap_s  real,
      last_fix    jsonb,
      created_at  timestamptz NOT NULL DEFAULT now()
    );

    ALTER TABLE events ADD COLUMN IF NOT EXISTS start_at timestamptz;
    ALTER TABLE events ADD COLUMN IF NOT EXISTS end_at timestamptz;
    ALTER TABLE events ADD COLUMN IF NOT EXISTS paused_at timestamptz;
    ALTER TABLE events ADD COLUMN IF NOT EXISTS published boolean NOT NULL DEFAULT false;
    ALTER TABLE teams ADD COLUMN IF NOT EXISTS repo_url text;
    ALTER TABLE teams ADD COLUMN IF NOT EXISTS commit_count integer NOT NULL DEFAULT 0;
    ALTER TABLE teams ADD COLUMN IF NOT EXISTS commits_checked_at timestamptz;
    ALTER TABLE teams ADD COLUMN IF NOT EXISTS commit_override integer;
    ALTER TABLE teams ADD COLUMN IF NOT EXISTS score_adjust real NOT NULL DEFAULT 0;
    ALTER TABLE teams ADD COLUMN IF NOT EXISTS repo_status text;
    ALTER TABLE teams ADD COLUMN IF NOT EXISTS last_commit_at timestamptz;
    ALTER TABLE teams ADD COLUMN IF NOT EXISTS last_commit_msg text;
    ALTER TABLE teams ADD COLUMN IF NOT EXISTS last_commit_author text;
    ALTER TABLE teams ADD COLUMN IF NOT EXISTS committers integer;
    ALTER TABLE laps ADD COLUMN IF NOT EXISTS manual boolean NOT NULL DEFAULT false;
    ALTER TABLE laps ALTER COLUMN member_id DROP NOT NULL;
    ALTER TABLE laps ADD COLUMN IF NOT EXISTS entry_seconds real;
    ALTER TABLE laps ADD COLUMN IF NOT EXISTS gate_seconds real;
    ALTER TABLE laps ADD COLUMN IF NOT EXISTS device_id integer;
    ALTER TABLE teams ADD COLUMN IF NOT EXISTS active_device_id integer;
    ALTER TABLE members ALTER COLUMN user_id DROP NOT NULL;
    ALTER TABLE points ALTER COLUMN member_id DROP NOT NULL;
    ALTER TABLE points ADD COLUMN IF NOT EXISTS device_id integer;
    -- Devin: optional per-team stats, never part of the score. The key is an
    -- event-day service-user key the team supplies; it dies with the event.
    ALTER TABLE teams ADD COLUMN IF NOT EXISTS devin_org_id text;
    ALTER TABLE teams ADD COLUMN IF NOT EXISTS devin_api_key text;
    ALTER TABLE teams ADD COLUMN IF NOT EXISTS devin_sessions integer NOT NULL DEFAULT 0;
    ALTER TABLE teams ADD COLUMN IF NOT EXISTS devin_active integer NOT NULL DEFAULT 0;
    ALTER TABLE teams ADD COLUMN IF NOT EXISTS devin_msgs integer NOT NULL DEFAULT 0;
    ALTER TABLE teams ADD COLUMN IF NOT EXISTS devin_prs_open integer NOT NULL DEFAULT 0;
    ALTER TABLE teams ADD COLUMN IF NOT EXISTS devin_prs_merged integer NOT NULL DEFAULT 0;
    ALTER TABLE teams ADD COLUMN IF NOT EXISTS devin_acus real NOT NULL DEFAULT 0;
    ALTER TABLE teams ADD COLUMN IF NOT EXISTS devin_checked_at timestamptz;
    ALTER TABLE teams ADD COLUMN IF NOT EXISTS devin_status text;
    -- after the ALTERs: on a fresh db device_id only exists from this point
    CREATE INDEX IF NOT EXISTS points_device_time ON points (device_id, fixed_at);
  `);

  // One-time migration from the old per-stint model: members that carried a
  // Traccar token become devices linked to that person, so already-configured
  // phones keep working.
  const { rows } = await pool.query('SELECT count(*)::int AS n FROM devices');
  if (rows[0].n === 0) {
    await pool.query(`
      INSERT INTO devices (event_id, team_id, member_id, token, name, activated_at,
                           state, lap_count, last_lap_s, last_fix, created_at)
      SELECT m.event_id, m.team_id, m.id, m.user_id, m.name, m.activated_at,
             m.state, m.lap_count, m.last_lap_s, m.last_fix, m.created_at
        FROM members m
       WHERE m.user_id IS NOT NULL AND m.activated_at IS NOT NULL AND m.frozen_at IS NULL
    `);
    await pool.query(`
      UPDATE teams t SET active_device_id = d.id
        FROM devices d
       WHERE d.member_id = t.active_member_id AND d.team_id = t.id
         AND t.active_member_id IS NOT NULL
    `);
    await pool.query(`
      UPDATE laps l SET device_id = d.id
        FROM devices d WHERE d.member_id = l.member_id AND l.device_id IS NULL
    `);
  }
}

// Midnight-to-midnight around `at`, in an IANA timezone, DST included.
// Intl gives us the wall-clock reading in that zone; the difference against
// the same reading as UTC is the offset at that instant.
export function tzOffsetMs(at, tz) {
  const f = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const p = Object.fromEntries(
    f.formatToParts(at).filter((x) => x.type !== 'literal').map((x) => [x.type, Number(x.value)])
  );
  return Date.UTC(p.year, p.month - 1, p.day, p.hour % 24, p.minute, p.second) - at.getTime();
}

export function localDayBounds(at, tz) {
  const date = at instanceof Date ? at : new Date(at);
  const f = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' });
  const [y, m, d] = f.format(date).split('-').map(Number);
  // First guess assumes the offset at `at` holds at midnight, then correct
  // once — enough for every real zone, including a DST switch inside the day.
  const guess = Date.UTC(y, m - 1, d) - tzOffsetMs(date, tz);
  const startMs = Date.UTC(y, m - 1, d) - tzOffsetMs(new Date(guess), tz);
  const guessEnd = Date.UTC(y, m - 1, d + 1) - tzOffsetMs(date, tz);
  const endMs = Date.UTC(y, m - 1, d + 1) - tzOffsetMs(new Date(guessEnd), tz);
  return { startMs, endMs };
}

/** The window Devin activity is measured over: the calendar day of the race
 *  by default, the event window itself when devinWholeDay is off. */
export function devinWindow(event, config) {
  const anchor = event.start_at ? new Date(event.start_at) : new Date(event.created_at ?? Date.now());
  if (config.devinWholeDay) return localDayBounds(anchor, config.devinTz);
  return {
    startMs: event.start_at ? new Date(event.start_at).getTime() : null,
    endMs: event.end_at ? new Date(event.end_at).getTime() : null,
  };
}

export function eventStatus(event, now = Date.now()) {
  const start = event.start_at ? new Date(event.start_at).getTime() : null;
  const end = event.end_at ? new Date(event.end_at).getTime() : null;
  if (start && now < start) return 'upcoming';
  if (end && now > end) return 'finished';
  if (event.paused_at) return 'paused';
  return 'live';
}

// Rank score. Formula lives in event config so it can change without code:
//   scoreFormula: 'km'                (default) distance run, nothing else
//                 'km_x_commits'      the old "built x ran"
//                 'km_x_sqrt_commits' (diminishing returns on commit spam)
//                 'km_plus_commits'   (score = km + commits * commitWeight)
// commitCap (optional) caps how many commits can score at all.
//
// Default is plain km: GitHub is no longer part of signup, so a commit-based
// formula would score every team zero. What teams built is judged off-board.
export function teamScore(km, commits, config) {
  const c = config.commitCap ? Math.min(commits, config.commitCap) : commits;
  switch (config.scoreFormula ?? 'km') {
    case 'km_plus_commits':
      return +(km + c * (config.commitWeight ?? 0.1)).toFixed(2);
    case 'km_x_sqrt_commits':
      return +(km * Math.sqrt(c)).toFixed(2);
    case 'km_x_commits':
      return +(km * c).toFixed(2);
    default:
      return +km.toFixed(2);
  }
}

// Per-event lap rules. Laps are TIMED from exiting the start box to
// re-entering it, so the timed segment is (lap - start-box crossing) —
// default 350m of a 400m track. minLapS/maxLapS and pace are calibrated to
// that segment: 7:00/km over 350m = 147s. Board km stays laps x lapM.
export function eventConfig(event) {
  const c = event.config || {};
  const lapM = c.lapM ?? 400;
  return {
    lapM,
    timedSegmentM: c.timedSegmentM ?? Math.max(100, lapM - 50),
    minLapS: c.minLapS ?? 48,
    maxLapS: c.maxLapS ?? 147,
    entryFixes: c.entryFixes ?? 1,
    exitFixes: c.exitFixes ?? 2,
    maxAccuracyM: c.maxAccuracyM ?? 40,
    scoreFormula: c.scoreFormula ?? 'km',
    commitWeight: c.commitWeight ?? 0.1,
    commitCap: c.commitCap ?? null,
    minTeamSize: c.minTeamSize ?? 3, // event rule: teams of 3/4
    maxTeamSize: c.maxTeamSize ?? 4,
    // Devin stats span the whole calendar day of the race, not just the
    // race window — teams prep before the gun and keep going after it, and
    // this is a side-stat, not a scored one. Deliberately NOT the event
    // window: those times govern lap validity and the countdown clock.
    devinWholeDay: c.devinWholeDay ?? true,
    devinTz: c.devinTz ?? 'Europe/London',
    gate: c.gate ?? null, // [[lat,lng],[lat,lng]] timing line inside the start box
    // Which timing scores laps: 'exit_entry' (box timing, window over the
    // timed segment), 'gate' or 'entry_entry' (full lap, window over lapM).
    // All three are recorded regardless; this only picks the official one.
    officialTiming: c.officialTiming ?? 'exit_entry',
    zones: event.zones || [],
  };
}
