-- 1 Nov 2026 (CEO): Monthly Performance Review – first Monday of each month replaces that week's
-- HQ WIG and the managers' Monday update. HQ (10 am) and branch managers (4 pm) review the month
-- separately and sign off one shared conclusion for the next month.
CREATE TABLE monthly_reviews (
  id            serial PRIMARY KEY,
  scope         text NOT NULL CHECK (scope IN ('branch', 'hq')),
  branch_id     integer REFERENCES branches(id),
  person_id     integer REFERENCES people(id),
  month         char(7) NOT NULL CHECK (month ~ '^\d{4}-\d{2}$'),       -- the month reviewed (2026-10)
  can_hit       text CHECK (can_hit IS NULL OR can_hit IN ('Yes', 'At risk', 'No')),
  plan          text CHECK (plan IS NULL OR NOT p4u_mentions_salary(plan)),
  stop          text CHECK (stop IS NULL OR NOT p4u_mentions_salary(stop)),
  start         text CHECK (start IS NULL OR NOT p4u_mentions_salary(start)),
  keep          text CHECK (keep IS NULL OR NOT p4u_mentions_salary(keep)),
  needs         text CHECK (needs IS NULL OR NOT p4u_mentions_salary(needs)),
  focus         text CHECK (focus IS NULL OR NOT p4u_mentions_salary(focus)),
  submitted_at  timestamptz,
  submitted_by  integer REFERENCES users(id),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  updated_by    integer REFERENCES users(id),
  CHECK ((scope = 'branch' AND branch_id IS NOT NULL) OR (scope = 'hq' AND person_id IS NOT NULL))
);
CREATE UNIQUE INDEX monthly_reviews_branch ON monthly_reviews (branch_id, month) WHERE scope = 'branch';
CREATE UNIQUE INDEX monthly_reviews_hq ON monthly_reviews (person_id, month) WHERE scope = 'hq';

-- One line per measure reviewed: the status is worked out by the app; the improvement is typed.
CREATE TABLE monthly_review_items (
  review_id    integer NOT NULL REFERENCES monthly_reviews(id) ON DELETE CASCADE,
  measure_ref  text NOT NULL,                 -- 'm:<measure id>' (branch) / 'h:<hq measure id>' / 'zakat' / 'oos'
  improvement  text CHECK (improvement IS NULL OR NOT p4u_mentions_salary(improvement)),
  PRIMARY KEY (review_id, measure_ref)
);

-- The shared conclusion: the company's goals for a month, agreed by both sessions, locked by the CEO.
CREATE TABLE month_goals (
  id            serial PRIMARY KEY,
  month         char(7) NOT NULL CHECK (month ~ '^\d{4}-\d{2}$'),       -- the month the goals are FOR (2026-11)
  slot          integer NOT NULL,
  title         text NOT NULL CHECK (NOT p4u_mentions_salary(title)),
  detail        text CHECK (detail IS NULL OR NOT p4u_mentions_salary(detail)),
  owner         text CHECK (owner IS NULL OR NOT p4u_mentions_salary(owner)),
  due           text CHECK (due IS NULL OR NOT p4u_mentions_salary(due)),
  how_measured  text CHECK (how_measured IS NULL OR NOT p4u_mentions_salary(how_measured)),
  hq_agreed_at  timestamptz, hq_agreed_by integer REFERENCES users(id),
  mgr_agreed_at timestamptz, mgr_agreed_by integer REFERENCES users(id),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (month, slot)
);
CREATE TABLE month_conclusions (
  month       char(7) PRIMARY KEY CHECK (month ~ '^\d{4}-\d{2}$'),
  notes       text CHECK (notes IS NULL OR NOT p4u_mentions_salary(notes)),
  locked_at   timestamptz,
  locked_by   integer REFERENCES users(id)
);
