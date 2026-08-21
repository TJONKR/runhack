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
  `);
}

// Per-event lap rules, with defaults for a 400m track and the 7:00/km floor
// (7:00/km over 400m = 168s). Dev events can override everything.
export function eventConfig(event) {
  const c = event.config || {};
  return {
    lapM: c.lapM ?? 400,
    minLapS: c.minLapS ?? 55,
    maxLapS: c.maxLapS ?? 168,
    entryFixes: c.entryFixes ?? 1,
    exitFixes: c.exitFixes ?? 2,
    maxAccuracyM: c.maxAccuracyM ?? 40,
    zones: event.zones || [],
  };
}
