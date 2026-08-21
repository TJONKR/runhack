# runhack

RoxFit's live clock + board + public API for RUN/HACK. Standalone service —
deliberately **not** part of the RoxFit backend, so event-week deploys never
touch the production app.

Runners install [Traccar Client](https://www.traccar.org/client/) (free, App
Store + Play). The join page mints an unguessable `userId` per stint and hands
Traccar a config deep link pointing at `/ingest/:userId`. All lap logic runs
server-side: geofence sequence, dwell, pace window, leaderboard.

Every event has its own leaderboard at `/:slug/board`. Rank = score, where the
formula lives in event config (default `km x commits`, matching the event's
"what you built × how far you ran"; `km_plus_commits` with a weight is also
supported — change it without code). Commits come from each team's public
GitHub repo (set at first join or by an admin), counted on the default branch
within the event window, polled every 60s with `GITHUB_TOKEN` set (5 min
without). Laps are recorded valid or invalid — invalid when too fast (GPS
bounce), too slow (the 7:00/km walk rule), or outside the event window — and
the board shows the last lap's verdict with its reason.

## Layout

- `src/lapEngine.js` — pure lap state machine (zones in order, dwell, min/max lap window). Tested.
- `src/ingest.js` — OsmAnd-protocol ingest (query, form, or JSON), activation/freeze of runners,
  event-window enforcement, rate limit.
- `src/github.js` — public-repo commit poller (one request per team per poll).
- `src/api.js` — public: event info, member registration, join-page status poll, board.
- `src/admin.js` — admin API, `Authorization: Bearer $ADMIN_KEY`.
- `public/admin.html` — race control: login (password = `ADMIN_KEY` env var), event setup with
  start/end times, Leaflet zone editor, teams + repos, and a simulator that loops a fake runner
  through the drawn zones via the real /ingest pipeline.
- `public/join.html` — runner flow: pick team → name (+ team repo if unset) → Traccar deep link →
  "waiting for GPS" → live.
- `public/board.html` — big-screen leaderboard in the RUN/HACK look: countdown/starting gun,
  laps/km/commits/score, last-lap validity, sponsor logo marquee from `public/brands/`.

## URLs

| URL | What |
| --- | --- |
| `/admin` | race control (password = `ADMIN_KEY`) |
| `/:slug/join` | runner signup |
| `/:slug/join?team=ID` | signup with team preselected (what team QRs encode) |
| `/:slug/team/:teamId` | per-team page: join QR, live roster, stats — print or pin at base |
| `/:slug/board` | venue big-screen board |
| `/api/:slug/board` | public JSON board (poll 2–5s) |
| `/api/:slug/team/:teamId` | public team JSON |
| `/ingest/:userId` | Traccar ingest (GET or POST) |

## Race management (in `/admin`)

- **Lifecycle**: start now / pause / resume / end now, plus editable start & end
  times. Paused and out-of-window laps are recorded but invalid; the board
  shows PAUSED / starting gun / FINAL states accordingly.
- **Laps**: `+lap` manually credits a lap to a team; the `laps` panel lists the
  last 50 with verdicts and lets you flip any lap valid ↔ invalid (rescue a
  GPS-robbed lap, or strike a bogus one). Board totals recompute instantly.
- **Runners**: live roster with connection freshness per member; `freeze`
  force-stops a runner's tracking (lost phone, wrong device streaming).
- **Reset race data**: wipes laps/members/points after a rehearsal; teams,
  repos, and event config survive.
- **Team QR pages**: every team row links to its `/team/:id` page whose QR
  encodes the pre-filled join URL. Runner scans → enters name → Traccar deep
  link configures the app with their per-stint `userId` (the id Traccar then
  reports back on every GPS ping, which is how fixes map to the member).

## Events = environments

Dev and prod share one deployment. Create a `dev` event with geofences around
somewhere you can walk and a walkable lap window (min lap ~10s, max ~1200s),
and the real event with the real boxes and the 55–168s window
(168s = 7:00/km over 400m).

## Deploy (Render)

1. Push this repo to GitHub.
2. Render → New → Blueprint → pick the repo. `render.yaml` creates the web
   service + Postgres. Schema auto-creates on boot.
3. Set `ADMIN_KEY` in the service's environment.
4. Add custom domain `runhack.roxfit.app` (CNAME per Render's instructions).
5. Open `/admin`, create the event, draw the zones, add teams.

## Local dev

Needs a Postgres. Quickest:

```bash
docker run -d --name runhack-pg -e POSTGRES_PASSWORD=dev -p 5432:5432 postgres:16
```

```bash
DATABASE_URL=postgres://postgres:dev@localhost:5432/postgres ADMIN_KEY=dev npm run dev
```

Fake a runner without a phone:

```bash
curl "http://localhost:3000/ingest/<userId>?lat=51.5388&lon=-0.0175&timestamp=$(date +%s)&accuracy=8"
```

## Tests

```bash
npm test
```

## Before the event

- Walk the venue and pin the two boxes in `/admin` on-site.
- Rehearse with 2–3 real phones actually running laps — this is where
  interval/dwell issues show up, treat it as mandatory.
- Verify the `org.traccar.client://config?...` deep link on a real iPhone and
  a real Android; the join page has a manual-setup fallback if it misbehaves.
