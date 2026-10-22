# Pharmacy4U 4DX – build spec

This project is a small web app that replaces the Excel 4DX trackers. Branch staff enter numbers on their phones; managers and the CEO see scoreboards. All targets, people and measures are in `seed.json` – read it before building anything, and load it into the database on first run. Never hard-code a target in the code.

## Who uses it
- **Branch staff** (5 branches: WM, JH, BR, Bangi, Ampang): enter the daily log at closing, mostly on a phone.
- **Branch managers**: weekly update to HQ (Monday 4 pm meeting) and the branch WIG session with their team on **Tuesday** (18 Oct: HQ WIG Monday 10 am → managers' update Monday 4 pm → branch WIG Tuesday; see "Weekly WIG rhythm").
- **HQ – full access (Alia, Hanin, Iman)**: read every branch, HQ input; Iman fills in for everyone. Password login. The out-of-stock inbox and transfers are for the inventory team only (Alia, Syarafana, Fariz).
- **HQ staff (Syarafana, Fariz, Azwani)**: group scoreboard, HQ scoreboard, their own KPIs, daily tasks, commitments and project milestones; since 19 Oct they see **the whole HQ team's WIG** (everyone's focus and commitments on /hq/commitments, everyone's numbers on /hq via "See everyone's numbers") – read only, they change only their own. PIN login.
- Dr Aisyah (CEO) has her own HQ measure but logs in as admin.
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
- Roles (src/auth/roles.js): `branch_staff` (own branch, daily log only, PIN), `branch_manager` (own branch, everything for that branch + group scoreboard, password), `hq_staff` (group + HQ scoreboard, own KPIs/tasks/commitments/projects, PIN), `hq` (HQ input + read all, password), `admin` (everything, including targets). Migration 009 adds hq_staff.
- Login screen (15 Oct): "Where do you work?" – the branches plus an **HQ** box. A branch lists its staff and its manager (tagged Manager); staff get the PIN keypad, the manager a password box. The HQ box lists HQ people the same way. "Admin login" is a small link (username + password). PIN roles can't use the password form and the other way round.
- Editing: staff and managers can edit the last 7 days of entries. Anything older: admin only.
- Admin password comes from the `ADMIN_PASSWORD` environment variable on first run.
- Login is BUILT (src/auth): branch → name → PIN keypad for staff; password form for others. 5 wrong tries = locked 15 min. Sessions in the `sessions` table (staff 14 h, others 7 days). Every logged-in POST needs the session's `_csrf` token. HQ can view daily entry read-only.

## Data model (as built – see src/db/migrations/001_init.sql)
- Setup, seeded from `seed.json` once: `branches`, `people`, `users`, `daily_fields`, `measures`, `measure_targets` (measure × month), `branch_month_targets`, `branch_baselines` (sales 1–11 Oct), `running_totals`, `hq_measures`, `hq_measure_targets`, `app_settings`.
- `daily_entries` (branch, date, field_key, value) – one row per field per day, so new fields need no schema change.
- `weekly_checkins`, `oos_items`, `commitments`, `hq_entries`.
- `audit_log` (who changed what, when), `sessions`.
- Schema changes go in a new migration file (002_…); never edit an applied one. seed.json is never re-applied after the first load – the database is the source of truth.

## Screens
1. **Daily entry** (per branch) – BUILT (src/daily, views/daily.ejs, public/js/daily.js): today's date, one card per person with only their fields, big number inputs, yes/no toggles. Shows green/red against today's target as they type (weekly/monthly targets: week-to-date progress). Can edit the last 7 days.
2. **Branch scoreboard** (per branch, per week) – BUILT (src/scoreboard, /scoreboard, /scoreboard/trace): grouped by person, week actual vs target, % achieved, status (✔ ≥100%, ▲ 90–99%, ✕ <90%), month-to-date. WIG and lead measures in bold at the top. Running totals (e.g. chronic database, Google reviews, TikTok followers) as progress bars.
3. **Weekly check-in** – BUILT (src/weekly, /weekly, views/weekly.ejs): per branch, for the week that just ended (default). MTD sales vs target and needed/day (from the branch scoreboard, traceable), stock values Mon/Sun + COGS → stock turnover and days of stock, SKUs on hand, SKUs sold MTD, zakat claims paid/pending, one win, one issue needing HQ help. Zakat boxes hidden for branches with no `zakat_field` (Bangi, Ampang). OOS list on the same page (/weekly/oos): the branch adds items; Inventory (HQ) fills in reason, expected back and status; open items carry into later weeks.
4. **Commitments** – BUILT (/commitments, src/weekly/commitments.js): defaults to this week. Off-track (✕) measures from last week (linked to their trace), last week's commitments with Done / Not done, then one commitment per person (unique per branch × week × person, migration 006) with the measure it moves and a by-when date. Empty box = remove.
5. **Group scoreboard** – BUILT (src/group, /group): one row per branch for a week – MTD sales and % (coloured by pace), needed/day, walk-in % of week target, Lead 1 %, Lead 2 % (measures on lead1_field / lead2_field), stock turnover, open OOS items, zakat pending (– without zakat) – plus company total (sums; turnover = total COGS ÷ total average stock), wins/issues, and 12-week trend grids (walk-in, Lead 1, Lead 2, turnover). Managers, HQ, admin; managers only get links into their own branch.
6. **HQ input + HQ scoreboard** – BUILT (src/hq, /hq, /hq/scoreboard): the whole HQ team from the Q4 4DX HQ Tracker (15 Oct) – Dr Aisyah (CEO: both WIG sessions held), Alia, Syarafana (slow movers, branch orders by HQ), Fariz (1 PO per branch in 1 h, deliveries checked), Azwani (AP/AR/cash update Yes/No, cash, AP, AR tracked; AR over 30 days and unpaid zakat over 30 days target 0; zakat follow-up), Hanin, Iman (HR daily checks 95%, scoreboard ready Yes/No). Each enters their own (by person_id); users.enters_all_hq (Iman) and admin enter any. Inputs: single_value, done_and_total, yes_no (migration 007). Lower-is-better with target 0: 0 = on track. New HQ people/measures in seed.json are added to existing databases on start (by name/code; edits kept). Percent typed as percent (95 → 0.95); done_and_total as "done of total". Scoreboard per week with status and a 12-week trend; turnover days lower is better. A week uses the target of the month its Thursday falls in.
9. **HQ day, HQ commitments, projects** – BUILT (src/hq/team.js, team-routes.js; /hq/today, /hq/commitments, /hq/projects; migration 009): each HQ person has a short daily task list (seed hq.daily_tasks: Iman's six HR & Admin checks from the tracker; starting lists for Alia, Syarafana, Fariz, Azwani and Hanin drawn from their KPIs and projects – added once to older databases for anyone with no tasks; each person edits their own, max 10, salary guard) ticked Done / Not done / N/A per day (N/A = doesn't apply that day, e.g. no B2B quote requested; migration 012 hq_daily_ticks.na) – a working day (Mon–Fri) counts when every task is Done or N/A, target 95%. Weekly commitments: one per HQ person (“This week I will ___ by ___ to move ___”), "to move" = their HQ measures or project milestones they own, marked Done / Partly / No the next week; kept % (Done only) vs 80%. Projects: the HQ Tracker's 19 milestones (seed hq.projects) with owner, start, due, status (Not started / In progress / Done / Blocked), notes; overdue/due soon flagged. Access: admin and Iman act for everyone; Alia/Hanin see everyone, change their own; HQ staff see and change only their own (projects: status, start, notes – not the due date). The HQ scoreboard has a "Team this week" table (daily tasks days done, last week's commitment, this week's) and a projects line.
10. **Branch sales up front** – the HQ/admin home page shows every branch's month sales (so far, % of target, pace, needed/day, linked to the rows); Daily Entry shows the branch's month sales at the top for staff and managers (managers/HQ get the link to the rows, staff just the numbers). partials/branch-sales.ejs.
8. **Company sales** – BUILT (src/group/company.js, partials/company-sales.ejs; on /group, /hq/scoreboard and the HQ/admin home page): all branches' MTD sales + B2B sales against the company month target (company_month_targets, migration 008; seed company.monthly_sales_target: Oct 266,800 · Nov 313,600 · Dec 360,500; edited in Admin → Targets → HQ). B2B = Alia's weekly HQ entry "b2b"; a week counts in the month its Thursday falls in, up to the week shown. Coloured by pace (target × days gone ÷ days in month – matches the HQ Tracker's 154,916 to 18 Oct), needed/day = (target − total) ÷ days left. Managers see it on /group without links into HQ input.
7. **Admin** – BUILT (src/admin, /admin): targets per month (+ weekend, branch totals, running totals, HQ), people & logins (add/rename/remove, PIN/password, unlock), measures & daily fields (edit/add/retire, checked against field use), audit log viewer, Excel export per branch and group (exceljs). Every change audited; PINs/passwords never logged. Form keys use a letter before ids (t[m12][2026-10]) because the form parser turns small numeric keys into arrays.

## Calculation rules (must match the Excel trackers)
- Monthly targets spread evenly per day; weekly targets per day ÷ 7. Weeks run Monday–Sunday.
- A daily measure can have `weekend_targets` (same month map): Saturdays and Sundays use that number instead. BR October walk-in: RM 1,250 weekdays, RM 1,650 weekends. BR POCT lead: 0 weekdays, 3 each weekend day (weekday tests are top-up). Stored in measure_targets.weekend_target (migration 003).
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
- Never store or display salaries. Enforced in three places: src/privacy.js (seed validation, Admin fields/measures, sales-sheet columns and tabs) and database CHECK constraints (migration 005, p4u_mentions_salary: salary, gaji, wages, payroll, upah, pay slip, EPF/KWSP, SOCSO/PERKESO). "Commission" is allowed (sales income). Tests check no page or export mentions salaries.
- Every number on a scoreboard must be traceable to the entries behind it (click through to the daily rows).
- Mobile first: daily entry must be usable one-handed on a phone.
- Write tests for the calculation rules before building the screens.

## Scoreboard decisions (14 Oct)
- Week chooser lists every week from the tracker's first week to this week. The current week counts days to today once any of today's numbers are in, otherwise to yesterday.
- Top section = measures of kind WIG, labels with "LEAD n", or Lead measures on the branch's lead1/lead2 fields. Everything else grouped by owner (Team, then people).
- Month sales are coloured by pace (MTD vs month target × days gone ÷ days in month), with the full-month % shown.
- Staff and managers see their own branch's scoreboard (staff since 19 Oct); HQ/admin all.
- Every number links to /scoreboard/trace (inline with JS, full page without).

## BR update (14 Oct, core JD revision sheet)
- October total RM 60k = retail + Grabmart RM 42k (walk-in 1,250 weekdays / 1,650 weekends), Shopee RM 7.5k (BR plan, Ainur leads; CEO target 12k), Alpine RM 0.5k (new, Alya), zakat RM 10k (BR aim, Amirah leads the value, Alya the fulfilment; CEO target 5k). YTD targets moved up by RM 5.8k.
- 8 BR target products (p1–p8) with margins in the notes; Qushairi leads the tracking. Grabmart added (Qushairi: items, orders, sales – no target yet).
- Intraday checkpoints (weekday 1pm RM 300 / 6pm RM 600; weekend 1pm RM 450 / 6pm RM 850) are in wig_detail only – not tracked, the daily log is at closing.
- Nov/Dec (confirmed 14 Oct): BR's split continues – Shopee 7.5k, zakat 10k, Alpine 0.5k a month. Month totals stay 61.6k / 69k (4DX), so walk-in fills the rest: Nov RM 1,330 weekdays / 1,750 weekends, Dec RM 1,520 / 2,000.
- Grabmart (confirmed 14 Oct): same proposed ramp as the other branches – sales RM 1k / 2.5k / 4.5k, items 15 / 10 / 5 a week.

## JH update (15 Oct, JH's own tracker notes)
- P1–P5 are now JH's measured PWP pairings (2/day each kept – confirm): cough & cold (Androchi / Digezmune), gout (Loyuric / Stella / RM2-off uric acid test), body pain (Biorelief spray), wound care (Dermacyn / Hydrocyn), kids (Shine). PWP matched to customer purchasing power and trends.
- New: T5 walk-in customers 60/day (POS transactions); T6 sales lost to out-of-stock (est. RM, track only); T7 OOS items logged (track only).
- T4 new Google reviews 50/month (GR 162 → 294 by 31 Dec). Y3 new TikTok followers 50/month – note: reaches ~894 by 31 Dec, short of the 1,000 WIG target (kept). Y1 TikTok content 4/week (2 per staff). Y2 lives = variety of products, BN not the focus. Y0 affiliate commission track only until 1,000 followers.
- Zakat: F5 scored month to date only (measures.score_by = 'month', migration 010 – week column shows the actual, no target/status); F7 now Zakat claims submitted (RM), track only (JH never claims late); new F9 RFQ invitations approved % (track only).
- N1 WhatsApp blasting & follow-ups to LH customers 15/day; N2/N3 are Routine (daily tasks, don't move the result); new N4 Grab cancelled orders, N5 WhatsApp orders average days to fulfil (wadays ÷ waord), both track only.
- Older databases get this once (syncBranchFromSeed, flag jh_update_v1): fields/measures upserted from seed.json, ones no longer listed retired (history kept).

## Sales sheet link (14 Oct)
- Source: 2026 Sales Dashboard (Google Sheet id in seed.json → company.sales_sheet_id), the five branch daily tabs. Column → field mapping per branch in branch.sales_sheet.
- Columns (confirmed 15 Oct): Grab sales (RM) = **GRAB PAY** (BR: "Grabpay"); Grab orders (#) = **GrabMart** (BR: "Grab Order"); walk-in = **Total minus GRAB PAY** (Total includes Grab Pay, so Grab isn't counted twice – walk-in + Grab = the till Total); Zakat = "Zakat" (WM, JH, BR); BR also Shopee Sales, Alpine. A column setting can be a header, a list of possible headers (first found wins), or { column, minus: [...] }; headers match without case, spaces or punctuation. 16 Oct: WM renamed GRAB PAY to **"Grab sales (RM)"** – every branch now accepts GRAB PAY / Grabpay / Grab sales (RM) / Grab sales, and GrabMart / Grab Order / Grab orders (sales_sheet_v3). Each sync lists mapped columns missing from a tab's newest month on Admin → Setup check (app_settings sales_sheet_missing). Older databases get the new columns once (app_settings sales_sheet_v2) and the next sync rewrites the sheet numbers.
- Synced every 10 min + "Check the sheet now" into daily_entries with source = 'sheet' (migration 004), only 12 Oct → today. Audit actions sheet_sync / sheet_delete. Repeated dates in the sheet are merged (empty never wipes a number).
- While the link is on, those fields are read-only in Daily Entry (fix in the sheet); with no service account they're typed as before.
- Auth: Google service account, read-only scope, signed JWT with Node crypto (no googleapis package). GOOGLE_SERVICE_ACCOUNT_JSON (Railway) or GOOGLE_SERVICE_ACCOUNT_FILE (local).

## Sales page – sheet's own summary tabs (15 Oct)
- Each sync also reads the sheet's **"Overall Daily Sales"** (one row per day, till sales per branch + Total) and **"Total Sales"** (first "Bulan … TOTAL M" table: Retail per branch incl. zakat/Shopee/Alpine, B2B, TOTAL M) tabs into sheet_sales_summary (migration 011). Read separately, so a renamed summary tab never stops the daily numbers; problem shown on Setup as summaryError. Tab names can be overridden in app_settings sales_summary_daily_tab / sales_summary_monthly_tab.
- **/sales** (managers, HQ, HQ staff, admin; not branch staff): company year so far incl. B2B, latest day per branch, month-by-month table with cumulative "year so far", day-by-day table for a chosen month. Numbers are mirrored exactly as the sheet shows them (YTD 1,815,396 at 14 Oct).
- "Year so far" strip on the branch scoreboard (branch YTD vs YTD target to date) and the group scoreboard (company YTD incl. B2B, latest daily total).
- **Progress since 2023** (16 Oct): the "Total Sales" tab's year tables (2026, 2025, 2024, 2023 – each a "Bulan … TOTAL M" header with the year just above; tables without a year, like the 2026 targets and "Pure walk in", are skipped) are all stored (parseTotalSalesYears). Columns between Bulan and TOTAL M: Retail <branch> → branch (2023's plain "Retail" = WM, the only branch then), B2B/Distribution → B2B, anything else (Shopee, TikTok, zakat, Alpine, e-commerce) → OTHER. The Sales page shows a like-for-like line (Jan–last full month this year vs the same months last year), a line chart of month totals per year (this year's unfinished month dashed; colours fixed per year, validated), and a year table with growth on the year before. The chart has Company / branch pills (?chart=WM): years a branch had no sales are left off its chart, months before it opened aren't drawn, and its like-for-like starts from the first month it had sales last year (JH: May–Sep). Totals match the sheet (2025 1,299,221 · 2024 710,139 · 2023 329,490 – 2023 reads 329,492 from rounded cells).
- YTD target to date = last month-end YTD target + this month's share by days; when last month has no row, last month-end = this month-end YTD target − this month's sales target.

## Side menu (16 Oct)
- partials/nav.ejs is a left side menu (managers, HQ, HQ staff, admin; branch staff have none): title + role/branch, 2 quick tiles (branch roles: Daily entry, Scoreboard; HQ: Group, Sales; HQ staff: My day, My KPIs; admin adds Admin), a search box (filters by name/keywords, Enter opens the first hit), collapsible groups Branch / Company / HQ / Admin (admin pages and Setup check are in the menu; admin-nav.ejs now only renders the menu + flash messages).
- Wide screens (≥960px): always shown, « hides it (remembered per device in localStorage), Menu brings it back. Phones: slides in from the Menu button in the top bar; works without JavaScript (checkbox + labels). public/js/nav.js.

## 16 Oct changes
- All branches: the add-on measure is now **3+ items** a transaction (field key stays `two`; target % unchanged). Older databases: labels renamed once (three_items_v1).
- WM: Hazera's TikTok lives (Z6, ttlive) removed; TikTok shipping no longer has a 24-hour target – Z3 is now "TikTok orders shipped", track only (ttship24 removed). Zawiyah's zakat ordering (W6, zko/zko2w) and Grab online all hours (W2, grabon) removed. Older databases: syncBranchFromSeed WM (wm_update_16oct); history kept.
- Ampang: staff Aisyah is spelled **Aishah** (login aishah); older databases renamed once like Admin → People (ampang_aishah_v1), incl. labels "with Aishah". Dr Aisyah (CEO) unchanged.
- Alia: new daily task "Zakat orders from the branches placed today" (zakat ordering moved from WM to HQ); added once to older databases (alia_zakat_task_v1).

## Out-of-stock flow (16 Oct, from the approved mockup)
- src/oos (data.js, routes.js, format.js), migration 013 (oos_items gains reported_at, left_qty, customers_count, urgent, note, answer_due, answer, answer_qty, from_branch_id, substitute, answered_at/by, picked_at, sent_at/by, received_at/by, late_flagged_at; statuses + 'On the way', 'Substitute offered', 'Discontinued'). Same table as the Monday OOS list, so check-in and the group scoreboard's open count keep working (OOS_OPEN = Open, Ordered, On the way, Substitute offered).
- 1 Report (/oos, branch staff + manager of that branch, admin; Daily entry has an "Out of stock" box with the open items, Inventory's answers and the Report button): item, none/low (+how many), customers asking (0 / 1–2 / 3+), urgent (chronic patient), note. Salary guard on text.
- 2 Answer (/oos/inbox + /oos/:id, HQ role + admin): to answer (urgent first, oldest first, time left to the deadline), waiting for stock (late / branch-flagged first), done lately. Deadline = 11 am the next working day (Mon–Fri; Fri/Sat/Sun → Monday). Four answers: transfer (from branch, qty, arrives by), order (qty, expected), substitute (what to offer, optional date), discontinue; optional note to the branch. Red count badge on the side menu, quick tile and HQ home.
- 3 Transfers (/oos/transfers, HQ + HQ staff + admin – Fariz): Picked / Sent, send within 24 h of the answer.
- 4 Close (/oos): branch taps "Received – back in stock"; past its date shows LATE and the branch can "Tell Inventory it's late".
- Scoreboard (/oos/scoreboard, managers, HQ, HQ staff, admin; per week): answered on time (deadline in the week), transfers sent on time, average days reported → back in stock (transfer / order), open now, per branch (reported, open, avg days, customers turned away), items that ran out 2+ times in 30 days. Targets in app_settings oos_targets (seed company.oos_targets: 11 am, 90%, 24 h, 95%, 3 days). Every step audited; all times come from the app clock (tests move it).

## HQ input made easier (16 Oct)
- /hq for full-HQ people who only enter their own (Alia, Hanin) shows **only their measures** ("My HQ numbers"), with "See everyone's numbers"; Iman (enters_all_hq) and admin still see all.
- Boxes with no entry are pre-filled from what the app knows, tagged Suggested with the source (src/hq/suggest.js): Alia's quotes and PO-check measures from her daily task ticks (Done ÷ Done + Not done, N/A left out), B2B calls from days a call/visit was ticked (to correct), inter-store transfers from the OOS transfers (sent within 48 h of the answer), Iman's HR daily checks from her days fully done. Nothing saves until Save. Each box shows last week's number; the "how it's counted" note folds away. A progress line shows "x of y saved".

## Look (16 Oct)
- Brand blue from the Pharmacy4U logo: --brand #004aad, --brand-light #308eff, --brand-deep #003a88; cool greys for page/lines/ink. Green and red stay only for on-track / off-track. Logo files in public/img (logo, logo-white, wordmark, wordmark-white, mark-white, icon-192 favicon), made from the logo the CEO sent: white mark + wordmark in the top bar (wordmark hidden on narrow phones with the Menu button), blue wordmark in the side menu, white full logo on the login page.
- Sales progress chart: tap / hover / Tab to a dot shows the month, amount and change on the same month last year (public/js/chart.js).

## Wiki & Classroom – on hold (16 Oct)
- A first version was built and then taken out at the CEO's request: the framework (structure, owners, approval rules, what goes in first) is to be agreed before it goes into the app. Migration 014_wiki.sql stays (its tables are unused; never edit an applied migration). Older databases that got JH's poster measure E1 have it retired (retireJhPoster).

## Company wiki checklist in 4DX (17 Oct)
- The framework doc's checklist (64 pages, 8 areas; 28 P1 by 15 Nov, P2 by 31 Dec, P3 Q1 2027) is a tracker in the app: seed hq.wiki_checklist + wiki_checklist_due, migration 015 hq_wiki_items, src/hq/wikilist.js, /hq/wiki (HQ + admin; statuses Not started → Drafting → Checking → Approved, "who writes it"; owners change their own, Iman and admin any; audited). Menu: HQ → Wiki checklist. The wiki itself stays on hold.
- Daily check-in: Iman "Company wiki: one checklist page moved forward today", Hanin "Company wiki: SOPs waiting for my check answered today" (seed daily_tasks; older databases once via addHqTaskOnce).
- Weekly check-in / 4DX: HQ measures `wiki` (Iman: 4/4/2 pages a week Oct/Nov/Dec) and `wikisop` (Hanin: 3/3/4) – pages approved that week, pre-filled on /hq from the checklist; they can be chosen as "to move" in HQ commitments. HQ scoreboard shows "Company wiki: x of 28 must-have pages approved, y of 64 in all, z late".

## Weekly WIG rhythm (18 Oct, from the approved mockup)
- Order: **HQ WIG Monday 10 am** → **managers' weekly update with CEO, Alia, Hanin Monday 4 pm** → **branch WIG Tuesday**. Code: src/wig (data.js, routes.js), migration 016_wig_week.sql, seed company.meeting_rhythm (monday/tuesday).
- **HQ WIG** (/hq/commitments, menu "HQ WIG session"): per person a weekly **focus** (hq_focus) – the CEO (admin login) sets it, or the person (Iman for anyone) proposes it and the CEO approves (Approve tick); changing an approved focus sends it back to "proposed". Then the HQ commitment as before. Shows open branch actions per person and last Monday's actions done. The focus sits at the top of /hq/today ("My day").
- **Managers' update** (/weekly, menu "Weekly update to HQ"; was the weekly check-in): "From the app" – branch WIG held, commitments kept, lead measures on track, and an **automatic out-of-stock week** (src/oos/data.js branchWeekSummary: reported, back in stock, avg days to fix, still open, late items) – no OOS list to type any more (/weekly/oos still works, not on the page). The manager types stock, SKUs, zakat, one win and **up to 3 "what I need from HQ"**, each for an HQ person → hq_actions (issue_needing_hq_help mirrors them). Shows last week's HQ actions for the branch.
- **Update meeting** (/hq/update, HQ + admin, menu "Weekly update meeting"): branch table (sales vs pace, WIG held, commitments kept, leads on track, days of stock, OOS open/late, zakat pending, update sent), wins, late OOS items; the branches' needs → owner + due date + status (owner and date = agreed → on the owner's /hq/today and the branch's WIG); add an action; last week's actions Done / Not done. Owners tick their actions on /hq/today (POST /hq/actions/:id: owner, full HQ, admin).
- **Branch WIG** (/commitments, /wig redirects; menu "Branch WIG session"; Tuesday): 1 scoreboard (top measures, off-track list, month sales, commitments kept) + "what HQ will do for us" (actions raised at the update before this week); 2 account – Done / Partly / Not done + why (commitments.result, why; done kept = result 'yes'); 3 plan – one commitment each, tagged "typed on their phone" or "typed by <manager>"; 4 finish – who was there + session held (branch_wig_sessions).
- **My week** (/my-week, branch staff and managers, phone): write this week's commitment, tap Done; last week's result; team this week. Daily entry shows a "My week" strip.
- Wording: CEO measure "Both WIG sessions held (HQ Monday 10 am, branch Tuesday)", Hanin's training measure at the Tuesday branch sessions. Older databases once via wigWeekOnce (flag wig_week_v1).

## Wiki: Iman writes, Hanin approves (18 Oct)
- All 64 checklist pages owned by Iman (seed + older databases via wigWeekOnce). Iman marks a page Checking ("send to Hanin", hq_wiki_items.checking_at); only the approver (app_settings wiki_approver = seed hq.wiki_approver "Hanin") or admin can mark Approved or take a page out of Approved. Wiki timestamps use the app clock.
- Measures: `wiki` (Iman) = pages sent to Hanin that week; `wikisop` (Hanin) = pages approved that week (all pages). Targets 7 / 6 / 5 a week Oct / Nov / Dec (28 P1 by 15 Nov, 30 P2 by 31 Dec) – applied to older databases only where the old 4/4/2 and 3/3/4 were unchanged. Hanin's daily task: "Company wiki: pages waiting for my approval checked today".
- **Classroom** starts in November: HQ measure `classroom` (Iman, lessons published a week, 1 from Nov, Oct none). The Classroom content itself is still to be built.

## 19 Oct changes
- **Menu groups** (partials/nav.ejs): **Inventory** – Out-of-stock inbox + Transfers to send – only for the inventory team (app_settings inventory_team = seed hq.inventory_team: Alia, Syarafana, Fariz) and admin; the pages and the answer/transfer actions are limited the same way (req.user.inventory set in src/app.js; oos canAnswer/canSend). Hanin and Iman no longer get the inbox. **Projects** – Projects, with Wiki checklist as a sub-item – HQ team only (HQ staff see Projects; the wiki checklist stays full HQ + admin).
- **HQ WIG session = HQ input + focus & commitments**: one menu item (/hq); both pages carry the steps "1 · Numbers for last week (HQ input)" → "2 · Focus & commitments this week" (partials/hq-wig-steps.ejs).
- **Up to 2 focuses and 2 commitments** per HQ person a week (migration 017: hq_focus / hq_commitments slot 1–2; form keys f/f2, c/c2). Both show on HQ day and the HQ scoreboard.
- Dr Aisyah's commitments can move **"Remove bottlenecks for staff"** (app_settings hq_extra_moves = seed hq.extra_moves; only offered to her).
- Menu name: **Weekly Branch Manager Meeting** (/hq/update, the Monday 4 pm meeting).
- **Top of the side menu** (replaces the shortcut tiles): **Needs you** (src/lib/needs.js, res.locals.needs on every GET) – up to 5 lines with a count, most urgent first: late (red), due today (amber), to do (blue); each opens its page; nothing to do → "All clear". Inventory team: OOS reports overdue / to answer, transfers late / to send. HQ people: branch actions overdue / due today / open, daily tasks not ticked (weekdays), Hanin: wiki pages waiting for approval, owner's wiki pages past their date. CEO (admin): focuses waiting for approval, branch actions overdue (by owner), branch updates not sent (Mon/Tue). Managers: yesterday's numbers missing, weekly update (Mon due 4 pm / Tue late), late OOS items, branch WIG today (Tue) / not marked held (Wed–Sun), staff without a commitment (Mon–Wed). Staff: yesterday's numbers missing, my commitment not written. Then **fixed tiles**: Daily entry + own branch scoreboard (branch logins) and **Group scoreboard for everyone**.
- Access widened: **branch staff can open the group scoreboard and their own branch's scoreboard** (read only; links only into their own branch).
- Ampang: **Anis (Intern)** added with a staff login (username anis – set her PIN in Admin → People); older databases once (ampang_anis_v1). Ayuni stays at Bangi.

## Project steps (19 Oct)
- A milestone on /hq/projects can carry a checklist of **steps** (migration 018 hq_project_steps: phase heading, step, owner, due date, done_at/done_by; salary guard). Each checklist has its **own page** (/hq/projects/:id/steps, views/hq-steps.ejs) laid out like the Company wiki checklist: tiles (steps done, each phase x of y with its last due date, per owner, in progress / due in 7 days, past their date), pills All steps / Mine / Not done yet (?show=mine|open), one card per phase, each row a status select (Not started / In progress / Done – migration 019 hq_project_steps.status; Done stamps done_at/done_by) + owner box (milestone owners, full HQ, admin) + Save, × removes – and is a **sub-item under Projects in the side menu** (like Wiki checklist) with a done/total count (res.locals.stepMenu, team.stepMenu: milestones not Done that have steps; HQ staff only their own). The Projects page itself shows only the milestones (19 Oct: kept clean at the CEO's request). src/hq/team.js (loadSteps, stepSummary, tickStep, addStep, removeStep), routes GET/POST /hq/projects/:id/steps and POST /hq/projects/steps/:sid (action save / remove; done / undo still accepted).
- Who: anyone who can update the milestone ticks, adds and removes steps; HQ staff named on a step can also tick it (and see that milestone). Every change audited.
- First list: **"Min/max stock levels set for top 300 items"** (Syarafana, with Alia) – 17 steps in seed hq.projects[].steps: 1 · Agree the rules (Alia, by 20 Oct), 2 · Pull the data (Syarafana, by 23 Oct), 3 · Set, check and load (27–30 Oct). Older databases once via projectStepsOnce (flag project_steps_v1), only for milestones with no steps yet.
- Needs you: steps not done that are past their date / due today, for the step's owner (or the milestone's owners when the step has none).

## Projects → Company wiki from the checklist (19 Oct)
- /hq/projects shows "Company wiki" as one line per wiki checklist heading (About Pharmacy4U, People and roles, HR policies, Branch operations SOPs, HQ SOPs, …), worked out from its pages: Not started / In progress / Done, x of y approved, waiting for Hanin, drafting, late, next due date, progress bar; heading links into /hq/wiki (full HQ + admin). Shown to the whole HQ team (HQ staff included) so everyone sees what's moving. The two typed "Company wiki" milestones are no longer in seed.json and are hidden from the page on older databases.

## Super admin and admin logins (19 Oct)
- Migration 019 users.is_super. Dr Aisyah's login (username admin) is the **super admin**: everything, plus changing admin logins and setting / approving HQ focuses, and her CEO lines in Needs you. The side menu says "Super admin".
- **Extra admin logins** for Iman and Hanin (seed hq.admin_logins: iman.admin "Iman (admin)", hanin.admin "Hanin (admin)"; added once via addAdminLoginsOnce, flag admin_logins_v1) – role admin, not super: see and fix everything for everyone (all branches, admin pages, targets, people), but can't change another admin login's password or unlock it, and can't approve HQ focuses (they can propose). They keep their own logins (iman, hanin) for their own KPIs, day and commitments. No password at first – the super admin sets it in Admin → People & logins → HQ → Admin logins (any admin can change their own).

## JH tracker import (22 Oct)
- JH kept filling its own Excel tracker (Drive: JH_4DX_Tracker_Q4_2026.xlsx, "Daily Log"). Its 12–21 Oct numbers are in src/db/imports/jh-tracker-2026-10-21.json and copied into daily_entries once on start (importDailyOnce, flag import_jh_tracker_20261021): only empty boxes are filled, numbers already in the app are kept and differences are listed in the audit log (action import). Mapping: 3+ items % × POS transactions → two (count); PWP units → pwp; Androchi/Digezmune p1, Loyuric/Stella p2, Biorelief p3, Hydrocyn/Dermacyn p4, Shine p5; Google reviews; New TikTok followers (whole-team column, else Yaya's) → ttfol; zakat RFQ (first number of "bid / total") → zkrfq, approved → zkrfqok, claims # → zkc, claims RM → zkrm; TikTok content, lives, affiliate commission; WhatsApp follow-ups → fu; Grab cancelled orders → grabcx. Not imported: walk-in, transactions, zakat sales, Grab orders/sales (the sales sheet fills them), Grab active inventory %, cancelled RM, "against approved quotation" columns (no field in the app).

## WM: no TikTok (22 Oct)
- WM can't go ahead with a TikTok seller account. Hazera's TikTok orders shipped (Z3, ttship) and TikTok sales (Z7, tt) are removed from seed.json and retired on older databases (wmTiktokOffOnce, flag wm_tiktok_off_v1; history kept). TikTok sales no longer count in WM's total or online sales (total_sales_fields walkin, zakat, wa, grab). WM's month total targets (60.9k / 73k / 85k) are unchanged; instead the **walk-in WIG (T1) goes up by about RM 65 a day (RM 2,000 a month)**: Oct 1,795 · Nov 1,980 · Dec 2,165 a day (was 1,730 / 1,910 / 2,100; WIG now "RM 1,542 → 2,165/day by 31 Dec"). Older databases once via wmWalkinUpOnce (flag wm_walkin_up_v1), only months still at the old target. JH's TikTok (WIG 2) is not affected.

## JH: no Grab menu items (22 Oct)
- JH's "Grab menu items added/fixed" (Nabihah, N3, field grabmenu, 15/10/5 a week) removed from seed.json and retired on older databases (retireBranchItemsOnce, flag jh_grabmenu_off_v1; history kept). WM, BR, Bangi and Ampang keep theirs.

## JH WhatsApp, Ampang Eldon strip (22 Oct)
- JH: Nabihah's WhatsApp box is **"WhatsApp customer follow-ups"** (field fu; measure N1 "WhatsApp customer follow-ups (LEAD 2)", 15 a day). "WhatsApp orders fulfilled today" / "…total days those orders took" (waord, wadays) and N5 (average days to fulfil) removed (retireBranchItemsOnce flag jh_waorders_off_v1; labels via relabelOnce jh_fu_label_v1).
- Ampang: target product P3 is **Eldon strip** (was Oat) – "Eldon strip units sold" / "Target product: Eldon strip", same field p3 and target 2 a day (relabelOnce ampang_eldon_v1). WM and Bangi keep Oat.

## Name and menu (16 Oct)
- The app's name is **Pharmacy4U 4DX** (top bar "4DX" tag, side menu, login, page titles, web-app manifest: short name "P4U 4DX").

## Security (review 14 Oct)
- Redirects only to same-site paths (src/lib/safe-path.js; blocks //, /\, spaces).
- Login: 5 wrong tries lock a login 15 min; 30 wrong tries from one device (IP) in 15 min block that device. Sessions: staff 14 h, admin 12 h, others 7 days; expired ones cleared hourly; a new PIN/password ends that person's other sessions.
- Headers: CSP (scripts from self only), X-Frame-Options DENY, nosniff, Referrer-Policy, Permissions-Policy, HSTS over https. /health gives no error details.
- Roles verified by tests: staff = own branch daily entry only; manager = own branch daily, scoreboard, check-in, OOS, commitments + the group scoreboard; HQ staff = group + HQ scoreboards and their own KPIs/tasks/commitments/projects, no branch pages; HQ = read all branches, enter HQ numbers, answer OOS items, change nothing else in branches; admin = everything.
- Dates in URLs must be real calendar days. Removed people's fields stay visible on an "Others" card until reassigned.
- Login page lists staff names per branch (needed for the PIN flow) – no other data before login.

## Monday screens decisions (14 Oct)
- Weeks are named by their Monday. Check-in and HQ input default to last week (the one just ended); commitments and the group scoreboard default to this week.
- Managers and HQ can change this week and last week; older weeks admin only. A save for a week that isn't on the week list is refused (never saved to another week). Boxes missing from a form are left unchanged.
- Free text (win, issue, OOS, commitments) goes through the salary guard; migration 006 adds the same CHECKs in the database.
- Group Excel export includes check-ins, OOS list, commitments and HQ entries.

## Deploy (Railway)
- railway.json: `npm start`, health check /health. Variables: DATABASE_URL = ${{Postgres.DATABASE_URL}}, ADMIN_PASSWORD (first start only), optional GOOGLE_SERVICE_ACCOUNT_JSON. RAILWAY_ENVIRONMENT makes the app run as production (secure cookies, APP_TODAY ignored), and the app refuses to start there without DATABASE_URL (PGlite on Railway is wiped on every deploy).

## Open items
- From the HQ Tracker, not in the app yet: Inventory 4DX inputs (turnover worked out from stock 30 days ago/now and 30-day COGS, with the weekly target path 98 → 75 days – today turnover days is typed as one number with month targets 92/83/75), BN units/sales; the HR Admin weekly/monthly checklist (the daily checks are in /hq/today). B2B sales from 1–11 Oct (before the tracker) aren't in the company total – there is no B2B before-tracker figure yet. The HR weekly item "payroll inputs by 20th" is left out on purpose (salary rule).
- Ampang storefront fields and measures (2 staff on duty, storefront hours, health checks/promos = Lead 1, outreach) are owned by "Team" until an owner is named (Ayuni is Bangi only).
