-- 001_init.sql – first version of the Pharmacy4U 4DX database.
-- Setup tables are filled once from seed.json and edited in Admin afterwards.
-- Entry tables hold what branches and HQ type in.
-- Privacy rule: no salary columns anywhere, ever.

-- ───────────────────────── Setup ─────────────────────────

CREATE TABLE app_settings (
  key        text PRIMARY KEY,
  value      text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE branches (
  id                             serial PRIMARY KEY,
  code                           text NOT NULL UNIQUE,       -- WM, JH, BR, Bangi, Ampang
  name                           text NOT NULL,
  wig                            text,
  wig_detail                     text,
  total_sales_fields             jsonb NOT NULL DEFAULT '[]', -- field keys added up for branch total sales
  online_sales_fields            jsonb NOT NULL DEFAULT '[]',
  zakat_field                    text,                         -- null = branch has no zakat (fields hidden)
  lead1_field                    text,
  lead2_field                    text,
  lead_measures                  jsonb NOT NULL DEFAULT '[]', -- descriptive text shown on scoreboards
  stock_turnover_target_per_week numeric,
  sku_sold_target_per_month      numeric,
  sort_order                     integer NOT NULL DEFAULT 0,
  active                         boolean NOT NULL DEFAULT true
);

-- People shown on scoreboards. branch_id is null for HQ people (Alia, Hanin).
CREATE TABLE people (
  id         serial PRIMARY KEY,
  branch_id  integer REFERENCES branches(id),
  name       text NOT NULL,
  role       text,
  sort_order integer NOT NULL DEFAULT 0,
  active     boolean NOT NULL DEFAULT true
);
CREATE UNIQUE INDEX people_branch_name ON people (COALESCE(branch_id, 0), name);

-- Logins. Everyone has their own. Staff use a 4-digit PIN, everyone else a password.
CREATE TABLE users (
  id            serial PRIMARY KEY,
  username      text NOT NULL UNIQUE,
  display_name  text NOT NULL,
  role          text NOT NULL CHECK (role IN ('branch_staff', 'branch_manager', 'hq', 'admin')),
  branch_id     integer REFERENCES branches(id),
  person_id     integer REFERENCES people(id),
  password_hash text,
  pin_hash      text,
  active        boolean NOT NULL DEFAULT true,
  last_login_at timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CHECK (role NOT IN ('branch_staff', 'branch_manager') OR branch_id IS NOT NULL)
);

-- The numbers each branch logs at closing. New fields = new rows here, no schema change.
CREATE TABLE daily_fields (
  id         serial PRIMARY KEY,
  branch_id  integer NOT NULL REFERENCES branches(id),
  key        text NOT NULL,
  label      text NOT NULL,
  owner_name text NOT NULL,          -- 'Team' or a person's name (for grouping cards)
  person_id  integer REFERENCES people(id),
  type       text NOT NULL CHECK (type IN ('money', 'count', 'yes_no')),
  sort_order integer NOT NULL DEFAULT 0,
  active     boolean NOT NULL DEFAULT true,
  UNIQUE (branch_id, key)
);

-- Scoreboard measures (WIGs, leads, routines, streams…).
CREATE TABLE measures (
  id                serial PRIMARY KEY,
  branch_id         integer NOT NULL REFERENCES branches(id),
  code              text NOT NULL,   -- the id in seed.json: T1, L3, Z2…
  owner_name        text NOT NULL,
  person_id         integer REFERENCES people(id),
  label             text NOT NULL,
  kind              text NOT NULL,   -- WIG, Lead, Routine, Stream, Result
  unit              text,
  target_per        text NOT NULL CHECK (target_per IN ('day', 'week', 'month')),
  calc              text NOT NULL CHECK (calc IN ('sum', 'ratio_percent', 'ratio_per_day')),
  numerator_field   text NOT NULL,
  denominator_field text,
  note              text,
  sort_order        integer NOT NULL DEFAULT 0,
  active            boolean NOT NULL DEFAULT true,
  UNIQUE (branch_id, code),
  CHECK (calc = 'sum' OR denominator_field IS NOT NULL)
);

-- One target per measure per month. Null target = track only (no status shown).
CREATE TABLE measure_targets (
  measure_id integer NOT NULL REFERENCES measures(id) ON DELETE CASCADE,
  month      char(7) NOT NULL CHECK (month ~ '^\d{4}-\d{2}$'),
  target     numeric,
  PRIMARY KEY (measure_id, month)
);

-- Branch-level monthly numbers: total sales target and YTD target at month end.
CREATE TABLE branch_month_targets (
  branch_id            integer NOT NULL REFERENCES branches(id),
  month                char(7) NOT NULL CHECK (month ~ '^\d{4}-\d{2}$'),
  total_sales_target   numeric,
  ytd_target_month_end numeric,
  PRIMARY KEY (branch_id, month)
);

-- Sales from before the tracker started (1–11 Oct) so MTD and YTD are complete.
CREATE TABLE branch_baselines (
  branch_id           integer PRIMARY KEY REFERENCES branches(id),
  baseline_end_date   date NOT NULL,     -- last day covered by these figures (2026-10-11)
  sales_before_start  numeric,           -- added to that month's MTD sales
  ytd_sales_to_date   numeric
);

-- Running totals: start value + sum of the field since start_date, against end_target.
CREATE TABLE running_totals (
  id          serial PRIMARY KEY,
  branch_id   integer NOT NULL REFERENCES branches(id),
  code        text NOT NULL,
  label       text NOT NULL,
  field_key   text NOT NULL,
  start_value numeric,
  start_date  date NOT NULL,
  end_target  numeric,
  sort_order  integer NOT NULL DEFAULT 0,
  UNIQUE (branch_id, code)
);

CREATE TABLE hq_measures (
  id         serial PRIMARY KEY,
  code       text NOT NULL UNIQUE,     -- turn, po, slow…
  owner_name text NOT NULL,
  person_id  integer REFERENCES people(id),
  label      text NOT NULL,
  unit       text,
  input      text NOT NULL CHECK (input IN ('single_value', 'done_and_total')),
  better     text NOT NULL CHECK (better IN ('high', 'low')),
  kind       text,
  note       text,
  sort_order integer NOT NULL DEFAULT 0,
  active     boolean NOT NULL DEFAULT true
);

CREATE TABLE hq_measure_targets (
  hq_measure_id integer NOT NULL REFERENCES hq_measures(id) ON DELETE CASCADE,
  month         char(7) NOT NULL CHECK (month ~ '^\d{4}-\d{2}$'),
  target        numeric,
  PRIMARY KEY (hq_measure_id, month)
);

-- ───────────────────────── Entries ─────────────────────────

-- One row per field per branch per day.
CREATE TABLE daily_entries (
  id         bigserial PRIMARY KEY,
  branch_id  integer NOT NULL REFERENCES branches(id),
  entry_date date NOT NULL,
  field_key  text NOT NULL,
  value      numeric NOT NULL,
  entered_by integer REFERENCES users(id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (branch_id, entry_date, field_key)
);
CREATE INDEX daily_entries_lookup ON daily_entries (branch_id, field_key, entry_date);

-- Monday check-in. week_start is always a Monday.
CREATE TABLE weekly_checkins (
  id                     serial PRIMARY KEY,
  branch_id              integer NOT NULL REFERENCES branches(id),
  week_start             date NOT NULL CHECK (EXTRACT(ISODOW FROM week_start) = 1),
  opening_stock_value    numeric,   -- Monday stock value (RM)
  closing_stock_value    numeric,   -- Sunday stock value (RM)
  weekly_cogs            numeric,
  sku_qty_on_hand        numeric,
  skus_sold_mtd          numeric,
  zakat_claims_disbursed numeric,   -- left empty for branches without zakat
  zakat_claims_pending   numeric,
  win_this_week          text,
  issue_needing_hq_help  text,
  submitted_by           integer REFERENCES users(id),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  UNIQUE (branch_id, week_start)
);

CREATE TABLE oos_items (
  id                 serial PRIMARY KEY,
  branch_id          integer NOT NULL REFERENCES branches(id),
  week_start         date NOT NULL CHECK (EXTRACT(ISODOW FROM week_start) = 1),
  item               text NOT NULL,
  out_of_stock_since date,
  customers_asking   text,          -- "customers asking / lost sales", free text
  reason_for_delay   text,          -- filled by Inventory (HQ)
  expected_back      date,
  status             text NOT NULL DEFAULT 'Open'
                     CHECK (status IN ('Open', 'Ordered', 'Back in stock', 'Discontinued / use substitute')),
  created_by         integer REFERENCES users(id),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX oos_items_branch_week ON oos_items (branch_id, week_start);

CREATE TABLE commitments (
  id           serial PRIMARY KEY,
  branch_id    integer NOT NULL REFERENCES branches(id),
  week_start   date NOT NULL CHECK (EXTRACT(ISODOW FROM week_start) = 1),
  person_id    integer NOT NULL REFERENCES people(id),
  commitment   text NOT NULL,
  lead_measure text,
  by_when      date,
  done         boolean,             -- null until marked the following week
  created_by   integer REFERENCES users(id),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX commitments_branch_week ON commitments (branch_id, week_start);

-- HQ's Monday numbers. `total` is only used by done_and_total measures (value = done).
CREATE TABLE hq_entries (
  id            serial PRIMARY KEY,
  week_start    date NOT NULL CHECK (EXTRACT(ISODOW FROM week_start) = 1),
  hq_measure_id integer NOT NULL REFERENCES hq_measures(id),
  value         numeric,
  total         numeric,
  entered_by    integer REFERENCES users(id),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (week_start, hq_measure_id)
);

-- ───────────────────────── System ─────────────────────────

CREATE TABLE audit_log (
  id         bigserial PRIMARY KEY,
  at         timestamptz NOT NULL DEFAULT now(),
  user_id    integer REFERENCES users(id),
  action     text NOT NULL,      -- insert / update / delete / login / seed …
  table_name text,
  record_key text,               -- e.g. 'WM 2026-10-14 walkin'
  old_value  jsonb,
  new_value  jsonb
);
CREATE INDEX audit_log_at ON audit_log (at DESC);

-- Login sessions (used when login is built).
CREATE TABLE sessions (
  sid     text PRIMARY KEY,
  data    jsonb NOT NULL,
  expires timestamptz NOT NULL
);
CREATE INDEX sessions_expires ON sessions (expires);
