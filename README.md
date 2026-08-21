# runhack

RoxFit's live clock + board + public API for RUN/HACK. Standalone service —
deliberately **not** part of the RoxFit backend, so event-week deploys never
touch the production app.

Runners install [Traccar Client](https://www.traccar.org/client/) (free, App
Store + Play). The join page mints an unguessable `userId` per stint and hands
Traccar a config deep link pointing at `/ingest/:userId`. All lap logic runs
server-side: geofence sequence, dwell, pace window, leaderboard.

## Layout

- `src/lapEngine.js` — pure lap state machine (zones in order, dwell, min/max lap window). Tested.
- `src/ingest.js` — OsmAnd-protocol ingest (query, form, or JSON), activation/freeze of runners, rate limit.
- `src/api.js` — public: event info, member registration, join-page status poll, board.
- `src/admin.js` — admin API, `Authorization: Bearer $ADMIN_KEY`.
- `public/admin.html` — event setup: Leaflet map, draw geofence zones in lap order, teams, links.
- `public/join.html` — runner flow: pick team → name → Traccar deep link → "waiting for GPS" → live.
- `public/board.html` — big-screen leaderboard, polls every 3s.

## URLs

| URL | What |
| --- | --- |
| `/admin` | event setup (needs admin key) |
| `/:slug/join` | runner signup — this is the printed QR |
| `/:slug/board` | venue big-screen board |
| `/api/:slug/board` | public JSON board (poll 2–5s) |
| `/ingest/:userId` | Traccar ingest (GET or POST) |

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
