# Pharmacy4U 4DX Dashboard – build spec

This project is a small web app that replaces the Excel 4DX trackers. Branch staff enter numbers on their phones; managers and the CEO see scoreboards. All targets, people and measures are in `seed.json` – read it before building anything, and load it into the database on first run. Never hard-code a target in the code.

## Who uses it
- **Branch staff** (5 branches: WM, JH, BR, Bangi, Ampang): enter the daily log at closing, mostly on a phone.
- **Branch managers**: weekly check-in, OOS list and commitments every Monday; run the Tuesday WIG session from the branch scoreboard.
- **HQ (Alia, Hanin)**: enter HQ measures every Monday.
- **CEO / admin**: sees everything; edits targets, people and measures.

## Stack (keep it simple)
- Node.js + Express, server-rendered pages (EJS). No front-end build step.
- PostgreSQL via the `DATABASE_URL` environment variable (Railway provides it). When `DATABASE_URL` is not set (local laptop), the app uses PGlite – embedded PostgreSQL stored in `./data/pglite` – so the same SQL runs locally and on Railway.
- Plain CSS that works well on a phone. No paid services.
- One repo, deployable to Railway with no manual build steps (`npm start` starts the server and runs migrations).
- Tests: `node --test` (files in `test/`).

## Login
- Everyone has their own login (decided 14 Oct – replaces the shared branch PIN). Usernames are first names in lowercase.
- Branch staff log in with a 4-digit PIN; managers, HQ and admin with a password (8+ characters). All stored hashed (bcrypt).
- Roles: `branch_staff` (own branch, daily log only), `branch_manager` (own branch, everything for that branch), `hq` (HQ input + read all), `admin` (everything, including targets).
- Editing: staff and managers can edit the last 7 days of entries. Anything older: admin only.
- Admin password comes from the `ADMIN_PASSWORD` environment variable on first run.

## Data model (as built – see src/db/migrations/001_init.sql)
- Setup, seeded from `seed.json` once: `branches`, `people`, `users`, `daily_fields`, `measures`, `measure_targets` (measure × month), `branch_month_targets`, `branch_baselines` (sales 1–11 Oct), `running_totals`, `hq_measures`, `hq_measure_targets`, `app_settings`.
- `daily_entries` (branch, date, field_key, value) – one row per field per day, so new fields need no schema change.
- `weekly_checkins`, `oos_items`, `commitments`, `hq_entries`.
- `audit_log` (who changed what, when), `sessions`.
- Schema changes go in a new migration file (002_…); never edit an applied one. seed.json is never re-applied after the first load – the database is the source of truth.

## Screens
1. **Daily entry** (per branch): today's date, one card per person with only their fields, big number inputs, yes/no toggles. Shows green/red against today's target as they type (weekly/monthly targets: week-to-date progress). Can edit the last 7 days.
2. **Branch scoreboard** (per branch, per week): grouped by person, week actual vs target, % achieved, status (✔ ≥100%, ▲ 90–99%, ✕ <90%), month-to-date. WIG and lead measures in bold at the top. Running totals (e.g. chronic database, Google reviews, TikTok followers) as progress bars.
3. **Weekly check-in** (per branch, Mondays): MTD sales vs target, required sales/day, stock turnover, OOS list, one win, one issue needing HQ help. Zakat fields hidden for branches with no `zakat_field` (Bangi, Ampang).
4. **Commitments**: last week's commitments with Done Y/N, then one new commitment per person.
5. **Group scoreboard** (managers' Monday session): one row per branch – MTD %, required sales/day, walk-in % of target, Lead 1 %, Lead 2 %, stock turnover, OOS count, zakat pending (– for branches without zakat) – plus company total, wins/issues, and 12-week trend grids.
6. **HQ scoreboard + HQ input**: Alia's inventory WIG and leads, Hanin's ops and training measures (see `seed.json` → `hq`). Turnover days: lower is better.
7. **Admin**: edit targets, people, measures, logins (passwords/PINs); export everything to Excel/CSV.

## Calculation rules (must match the Excel trackers)
- Monthly targets spread evenly per day; weekly targets per day ÷ 7. Weeks run Monday–Sunday.
- `calc = sum`: week actual = sum of the field; week target = sum of daily targets for days in the week.
- `calc = ratio_percent`: actual = sum(numerator) ÷ sum(denominator); target is a % (e.g. 45% of transactions with 2+ items, 100% zakat on time).
- `calc = ratio_per_day`: same as ratio, shown as a number, not % (Ampang storefront: checks per day with 2 staff on duty). The numerator only counts on days where the denominator is > 0 (checks on a 1-staff day don't count).
- Ratio targets are rates, not added up; a week spanning two months uses the average of its days' targets.
- If only some days in a period have a target (track-only month next to a month with a target), actual and target both use only the days with a target.
- A blank target means "track only" – show the actual, no status.
- Branch total sales = sum of `total_sales_fields`. October also adds `before_tracker.sales_1_to_11_oct`.
- The tracker starts 12 Oct (`company.tracker_start_date`). Week and MTD measure targets in October count only from 12 Oct; MTD sales vs the month total and required sales/day use the whole month (including the 1–11 Oct sales).
- Required sales/day = (month target − MTD actual) ÷ days left in the month. Days left = days after the last day included in MTD (MTD to 18 Oct → 13 days left). 0 once the target is hit; none on the last day.
- The calculation code lives in `src/calc/` (pure functions, no database); tests in `test/calc/` use a sample week (`test/fixtures/sample-weeks.js`).
- Stock turnover = weekly COGS ÷ ((Monday stock + Sunday stock) ÷ 2); days of stock = 7 ÷ turnover. Target 0.23 a week.
- Running totals = start value + sum of the field to date, against the end target.
- "Today" is Malaysia time (Asia/Kuala_Lumpur), not the server's clock.

## Rules
- Never store or display salaries.
- Every number on a scoreboard must be traceable to the entries behind it (click through to the daily rows).
- Mobile first: daily entry must be usable one-handed on a phone.
- Write tests for the calculation rules before building the screens.

## Open items
- Ampang storefront fields and measures (2 staff on duty, storefront hours, health checks/promos = Lead 1, outreach) are owned by "Team" until an owner is named (Ayuni is Bangi only).
