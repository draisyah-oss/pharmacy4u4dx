# Pharmacy4U 4DX Dashboard

Replaces the Excel 4DX trackers. Branch staff enter numbers on their phones; managers and the
CEO see scoreboards. The build spec is in `CLAUDE.md`; all targets, people and measures are in
`seed.json`.

**Status:** project skeleton, database tables, seed loader and calculation module are done. Login, daily entry and
the scoreboards come next.

## Run it on your Mac

You need Node.js 20 or newer (`node -v` to check). Nothing else – on your laptop the app uses a
built-in PostgreSQL that stores its files in the `data/` folder.

```bash
cd pharmacy4u-4dx
npm install                 # first time only
cp .env.example .env        # first time only
open -e .env                # set ADMIN_PASSWORD (8+ characters), save, close
npm test                    # should end with: pass 47, fail 0
npm start
```

Then open http://localhost:3000. Stop the app with **Ctrl+C**.

The first `npm start` creates the tables and loads `seed.json`. Every start after that uses the
data already in the database – seed.json is not loaded again, so nothing typed in is lost.

### Useful commands

| Command | What it does |
|---|---|
| `npm start` | Start the app (runs any new migrations first) |
| `npm test` | Run the tests |
| `npm run users` | List every login and whether it has a password/PIN yet |
| `npm run set-password -- hafizah SomePassword1` | Set a password (managers, HQ: 8+ characters) |
| `npm run set-password -- zawiyah 4821` | Set a 4-digit PIN (branch staff) |
| `npm run db:reset-local` | Wipe the **local** database; next `npm start` reloads seed.json |

Stop the app (Ctrl+C) before running `users`, `set-password` or `db:reset-local` – the local
database can only be open in one window at a time (you'll get a clear message if you forget).

Changed `seed.json` and want to see it locally? `npm run db:reset-local`, then `npm start`.

### Testing on your phone

With the app running, find your Mac's address (System Settings → Wi-Fi → Details → IP address,
e.g. `192.168.1.23`) and open `http://192.168.1.23:3000` on a phone on the same Wi-Fi.

## Deploy to Railway

1. Push this folder to a GitHub repo.
2. In Railway: **New project → Deploy from GitHub repo**, then **+ New → Database → PostgreSQL**.
3. In the app service's **Variables**, add `DATABASE_URL` = `${{Postgres.DATABASE_URL}}` and
   `ADMIN_PASSWORD` = a strong password.
4. Railway runs `npm install` and `npm start`. Check `https://<your-app>/health`.

`npm run db:reset-local` refuses to run when `DATABASE_URL` is set, so it can't touch Railway.

## How it's organised

```
seed.json                 targets, people, measures (loaded once into the database)
src/server.js             npm start: migrate → load seed (first run) → start web server
src/app.js                web routes (status page and /health for now)
src/db/index.js           database connection: Postgres if DATABASE_URL is set, else local PGlite
src/db/migrate.js         runs new files in src/db/migrations/ in order
src/db/migrations/        001_init.sql = all tables. Add 002_… for changes; never edit old ones
src/db/seed.js            checks seed.json for mistakes, then loads it
src/calc/                calculation rules (targets, ratios, MTD, required/day, turnover, running totals)
src/views/  public/css/   pages and mobile-first styles
scripts/                  users, set-password, db:reset-local
test/                     node --test
```

## Database tables

- **Setup** (from seed.json, edited in Admin later): `branches`, `people`, `users`,
  `daily_fields`, `measures`, `measure_targets` (one row per measure per month; empty target =
  track only), `branch_month_targets` (total sales + YTD targets), `branch_baselines` (sales
  before the tracker started, 1–11 Oct), `running_totals`, `hq_measures`, `hq_measure_targets`,
  `app_settings`.
- **Entries:** `daily_entries` (one row per branch, day and field), `weekly_checkins`,
  `oos_items`, `commitments`, `hq_entries`.
- **System:** `audit_log`, `sessions`, `schema_migrations`.

No table stores salaries; a test checks this.

## Logins

Everyone has their own login. Usernames are first names in lowercase (`hafizah`, `alia`); `admin`
uses `ADMIN_PASSWORD`. Branch managers, HQ and admin use passwords; branch staff use a 4-digit PIN.
Until the Admin screen exists, set them with `npm run set-password`.
