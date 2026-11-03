-- 3 Nov 2026 (CEO): the Inventory page – the Mr Eve Ordering & Payment Board moved into the app.
-- November PO budget by supplier, weekly cash plan, supplier payment approvals (CEO approves,
-- Azwani marks paid) and Mr Eve's daily plan (transfers first, then orders). Inventory team,
-- payments team and admin only. Recommendations only: nothing here places an order or pays anyone.
CREATE TABLE inv_suppliers (
  id          serial PRIMARY KEY,
  key         text NOT NULL UNIQUE,        -- first word of the supplier name, upper case (AA ALIVE: two)
  supplier    text NOT NULL,
  terms       text,
  gate        text NOT NULL DEFAULT 'check',  -- open / after_payment / soa / hold / check
  unlock_key  text,                        -- after_payment: open once every payment line for this key is paid
  when_text   text,
  po_budget   numeric(12,2) NOT NULL DEFAULT 0,
  falls_due   text,
  sort        integer NOT NULL DEFAULT 0,
  month       text NOT NULL                -- YYYY-MM
);
CREATE TABLE inv_cash_weeks (
  id           serial PRIMARY KEY,
  month        text NOT NULL,
  sort         integer NOT NULL,
  week         text NOT NULL,
  sales_in     numeric(12,2) NOT NULL DEFAULT 0,
  zakat_in     numeric(12,2) NOT NULL DEFAULT 0,
  fixed_out    numeric(12,2) NOT NULL DEFAULT 0,
  supplier_out numeric(12,2) NOT NULL DEFAULT 0,
  cash_end     numeric(12,2) NOT NULL DEFAULT 0,
  paying       text
);
CREATE TABLE inv_payments (
  id              serial PRIMARY KEY,
  week            text,
  pay_date        date,
  supplier        text NOT NULL,
  proposed        numeric(12,2),
  approved        text CHECK (approved IN ('Yes', 'No', 'Partial')),
  approved_amount numeric(12,2),
  approved_by     integer REFERENCES users(id),
  approved_at     timestamptz,
  paid            boolean NOT NULL DEFAULT false,
  date_paid       date,
  pv_no           text,
  paid_by         integer REFERENCES users(id),
  paid_at         timestamptz,
  notes           text,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE inv_plans (
  id          serial PRIMARY KEY,
  plan_date   date NOT NULL UNIQUE,
  title       text NOT NULL,
  note        text,
  source      text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE inv_plan_lines (
  id            serial PRIMARY KEY,
  plan_id       integer NOT NULL REFERENCES inv_plans(id) ON DELETE CASCADE,
  line          integer NOT NULL,
  section       text NOT NULL,             -- urgent / hq / a_items / asking / recount / other
  action        text NOT NULL,
  item          text NOT NULL,
  short_at      text,
  transfer_from text,
  supplier      text,
  status_text   text,
  qty           text,
  rm            numeric(12,2) NOT NULL DEFAULT 0,
  done_at       timestamptz,
  done_by       integer REFERENCES users(id)
);
CREATE INDEX inv_plan_lines_plan ON inv_plan_lines (plan_id, line);
