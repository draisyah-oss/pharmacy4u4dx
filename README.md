# Pharmacy4U 4DX Dashboard

Replaces the Excel 4DX trackers. Branch staff enter numbers on their phones; managers and the
CEO see scoreboards. The build spec is in `CLAUDE.md`; all targets, people and measures are in
`seed.json`.

**Status:** login, Daily Entry, Branch Scoreboard, sales sheet link and Admin are done.
Weekly check-in, commitments, group and HQ scoreboards come next.

## Run it on your Mac

You need Node.js 20 or newer (`node -v` to check). Nothing else – on your laptop the app uses a
built-in PostgreSQL that stores its files in the `data/` folder.

```bash
cd pharmacy4u-4dx
npm install                 # first time only
cp .env.example .env        # first time only
open -e .env                # set ADMIN_PASSWORD (8+ characters), save, close
npm test                    # should end with: pass 110, fail 0
npm start
```

Then open http://localhost:3000. Stop the app with **Ctrl+C**.

Before anyone can log in, give them a password or PIN: log in as `admin` and use
**Admin → People & logins**. (From the terminal, with the app stopped, this also works:)

```bash
npm run set-password -- hazera 1234            # branch staff: 4-digit PIN
npm run set-password -- hafizah ManagerPass1   # managers / HQ: password, 8+ characters
```

Staff log in by tapping their branch, their name, then their PIN. Managers, HQ and admin use
"Log in with your password" (admin's username is `admin`). After 5 wrong tries a login is
locked for 15 minutes.

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

### Trying a different day

`APP_TODAY=2026-10-20 npm start` makes the app behave as if it's that day (ignored on Railway).

### Testing on your phone

With the app running, find your Mac's address (System Settings → Wi-Fi → Details → IP address,
e.g. `192.168.1.23`) and open `http://192.168.1.23:3000` on a phone on the same Wi-Fi.

## Admin

Log in as `admin` → **Admin** tab:

- **Targets** – every measure per month (percent targets typed as percent), Sat–Sun targets for
  daily measures, branch month totals, running-total start values, HQ targets. Empty box = track only.
- **People & logins** – add, rename (carries over to their measures and fields), remove, set PINs
  and passwords, unlock, change the admin password.
- **Measures** – owner, kind, what field it counts, per day/week/month, add or retire; daily fields too.
- **Audit log** – every change, who and when, searchable. PINs and passwords are never logged.
- **Export to Excel** – the whole group or one branch: scoreboard by week, sales, every daily
  entry with who entered it (or the sales sheet), targets, people.

## Sales sheet (2026 Sales Dashboard)

The app reads each branch's daily tab in the **2026 Sales Dashboard** Google Sheet and fills in
walk-in sales, transactions, zakat, Shopee, Alpine and Grab orders automatically (which columns
go where is in `seed.json` → each branch's `sales_sheet`). It checks every 10 minutes, and
there's a "Check the sheet now" button on the daily entry page. Those boxes become read-only
and are tagged *Sales sheet* – to change a number, fix it in the sheet. Until the link is set
up, they're typed in the app as before.

Set it up once (free, about 10 minutes):

1. Go to https://console.cloud.google.com, sign in as draisyah@imanwellnessandhealth.com and
   create a project (e.g. "Pharmacy4U 4DX").
2. **APIs & Services → Library**: search **Google Sheets API** and click **Enable**.
3. **IAM & Admin → Service accounts → Create service account**: name it `p4u-dashboard`,
   skip the optional steps. Open it → **Keys → Add key → Create new key → JSON**. A file
   downloads – keep it private.
4. Open the 2026 Sales Dashboard → **Share** → paste the service account's email (it looks
   like `p4u-dashboard@your-project.iam.gserviceaccount.com`) → **Viewer** → untick "Notify" → Share.
5. On your Mac: move the key file into this folder, rename it `google-service-account.json`,
   and add `GOOGLE_SERVICE_ACCOUNT_FILE=google-service-account.json` to `.env`.
   On Railway: add a variable `GOOGLE_SERVICE_ACCOUNT_JSON` and paste the whole file's text.
6. Restart the app. The terminal says "Sales sheet link: on". Admin → Setup check shows the
   last sync or what went wrong.

The key is never committed (`.gitignore`), and the app only asks for read-only access.

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
src/app.js                web app: login, home, daily entry, /status (admin), /health
src/auth/                 login, logout, sessions, form tokens
src/daily/                Daily Entry: who can edit what, target hints, saving
src/admin/                Admin: targets, people & logins, measures & fields, audit log, Excel export
src/sheets/               Sales sheet link: Google sign-in, reading the tabs, syncing into daily entries
src/scoreboard/           Branch Scoreboard: week + month-to-date per measure, running totals, click-through
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
