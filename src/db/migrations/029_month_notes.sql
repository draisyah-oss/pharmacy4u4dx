-- 2 Nov 2026 (CEO): monthly scoreboard notes – written on a month's summary (company, an HQ
-- department, a branch or a person) and, when bring_forward, shown on the next month's page
-- until someone marks them done.
CREATE TABLE month_notes (
  id             serial PRIMARY KEY,
  month          char(7) NOT NULL CHECK (month ~ '^\d{4}-\d{2}$'),        -- the month it was written on
  scope          text NOT NULL CHECK (scope IN ('company', 'dept', 'branch', 'person')),
  ref            text NOT NULL,                                           -- '' / department name / branch code / person id
  note           text NOT NULL CHECK (NOT p4u_mentions_salary(note)),
  bring_forward  boolean NOT NULL DEFAULT true,
  done_at        timestamptz,
  done_by        integer REFERENCES users(id),
  created_at     timestamptz NOT NULL DEFAULT now(),
  created_by     integer REFERENCES users(id)
);
CREATE INDEX month_notes_month ON month_notes (month, scope, ref);
