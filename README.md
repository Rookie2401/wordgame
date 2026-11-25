# Balderdash companion

A phone-browser companion for playing the dictionary bluffing game in person. It replaces the slips of paper: the
reader gets the card privately, everyone types a definition, the app shuffles them anonymously for the reader to
read aloud, and reveals the answer and the authors when asked. Voting is aloud and scores stay on paper.

"Balderdash" is a working title only. See [docs/BRANDING.md](docs/BRANDING.md) before sharing this publicly.

- No app download, no accounts, no scoring, no voting, no ads, no tracking.
- React + TypeScript + Vite front end on GitHub Pages; Supabase (Postgres, Realtime, anonymous sign-in) behind it.
- All game rules run in the database. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Status

| Part | State |
| --- | --- |
| Game engine (SQL), both card modes | Built; 64 unit and database tests pass |
| Interface, all screens | Built; checked at phone, tablet and desktop sizes |
| Five-browser full game, reconnection, expiry | Passes locally against the real SQL in an in-process Postgres |
| Word list | 3,000 entries from Webster 1913, machine-filtered, **not proofread by a person** |
| Supabase project | **Not created yet** — steps below |
| GitHub Pages deployment | **Not done yet** — steps below |
| Game played against production | **Not done yet** — command below |

The local tests exercise the same migrations that run on Supabase, but through a small stand-in server
(`dev-server/`), not through Supabase's own API, sign-in or Realtime. Those three are only proven by the production
check at the end of this page.

## Run it locally

```
npm install
npm run dev:backend     # in-process Postgres with the real migrations, port 5197
npx vite --mode e2e     # the app, port 5196, talking to that backend
```

Open http://127.0.0.1:5196 in several private windows to play against yourself.

## Tests

```
npm run typecheck
npm test                # unit, engine, security and lifecycle tests (Vitest + PGlite)
npm run test:e2e        # five browsers playing a whole game (Playwright; uses Microsoft Edge)
npm run verify          # all of the above plus a production build
```

On a machine without Edge: `npx playwright install chromium`, then set `PW_CHANNEL=chromium`.

## Deploy

Nothing here needs a secret key in this repository.

### 1. Supabase

1. Create a project at supabase.com.
2. **Authentication → Sign In / Providers → Anonymous sign-ins: on.** Under Rate Limits, check the anonymous
   sign-in limit (it is per IP address per hour, and a whole table of players usually shares one Wi-Fi address);
   raise it if you expect more players than the limit in an hour.
3. **SQL Editor:** run these files in order, each as one query:
   1. `supabase/migrations/20261124000001_schema.sql`
   2. `supabase/migrations/20261124000002_functions.sql`
   3. `supabase/seed/words.sql` (only needed for Digital Card mode)
4. **Database → Publications:** confirm `supabase_realtime` lists the `rooms` table and nothing else from this
   app. (The schema migration adds it.)
5. Optional, for tidy cleanup when nobody is creating rooms: enable the `pg_cron` extension and run
   `select cron.schedule('balderdash-cleanup', '*/15 * * * *', 'select private.cleanup_rooms()');`
6. **Project Settings → API:** note the Project URL and the `anon` / publishable key. Both are public values.
   Do not use the `service_role` key anywhere.

### 2. GitHub Pages

1. Push this repository to GitHub.
2. **Settings → Pages → Source: GitHub Actions.**
3. **Settings → Secrets and variables → Actions → Variables:** add `VITE_SUPABASE_URL` and
   `VITE_SUPABASE_ANON_KEY`.
4. Push to `main` (or run the "Test and deploy" workflow by hand). It type-checks, runs every test, builds and
   publishes. The site is served over HTTPS at `https://<user>.github.io/<repo>/`.

Invitation links have the form `https://<user>.github.io/<repo>/?room=ABCDE`. They load the index page with a query
string, so they cannot 404; `404.html` is a copy of the index as a second line of defence.

### 3. Verify production

A local build passing is not proof. Play the automated five-player game against the live site:

```
# PowerShell
$env:E2E_BASE_URL = 'https://<user>.github.io/<repo>/'; npx playwright test game
```

Then do it once for real: open the site on a phone, create a game, scan the QR code with two other phones and
play two rounds.

## Environment variables

| Name | Where | Meaning |
| --- | --- | --- |
| `VITE_SUPABASE_URL` | build | Supabase project URL |
| `VITE_SUPABASE_ANON_KEY` | build | Supabase anon / publishable key (public) |
| `VITE_LOCAL_BACKEND_URL` | build, dev only | Use the local stand-in backend instead of Supabase |
| `E2E_BASE_URL` | tests | Run the end-to-end game against a deployed site |
| `PW_CHANNEL` | tests | Browser for Playwright (`msedge` by default, `chromium` in CI) |

## Maintenance

- **Settings** live in the `app_config` table: `room_inactivity_hours` (6), `ended_retention_minutes` (30),
  `max_players` (24), `presence_seconds` (15). Change them with an `update` in the SQL editor.
- **Retention:** a room and everything in it (players' names, words, definitions) is deleted 30 minutes after the
  host ends the game, or after 6 hours without activity. Deletion runs whenever anyone creates a room, and on the
  `pg_cron` schedule if you enabled it. Nothing else is stored: no emails, no phone numbers, no profiles, no
  analytics.
- **Word list:** see [docs/WORDS.md](docs/WORDS.md). `npm run words:import` then `npm run words:validate`
  regenerate and check `supabase/seed/words.sql`; rerun that file in the SQL editor to add new words (existing
  ones are skipped).
- **Schema changes:** add a new numbered file under `supabase/migrations/`; the tests load every file in that
  folder in order.

## Layout

```
src/backend/     the one place that talks to Supabase (and the local stand-in)
src/sync/        keeping a room's state current: realtime nudge + poll + versioned snapshots
src/game/        pure helpers: validation, which screen to show, messages
src/ui/          screens
supabase/        migrations (schema, RLS, game functions) and the word seed
dev-server/      in-process Postgres running the migrations, for tests and local play
tools/words/     dictionary import and validation
tests/           unit, database (engine / security / lifecycle), end-to-end
```
