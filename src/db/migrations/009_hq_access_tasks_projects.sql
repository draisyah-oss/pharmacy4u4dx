-- 009 – HQ access levels, HQ daily tasks, HQ weekly commitments and HQ projects (15 Oct).
--
-- hq_staff: HQ people with a normal (PIN) login who see the group scoreboard, the HQ
-- scoreboard and their own KPIs, tasks, commitments and projects (Syarafana, Fariz, Azwani).
-- hq stays the full HQ access (Alia, Hanin, Iman).
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check
  CHECK (role IN ('branch_staff', 'branch_manager', 'hq', 'hq_staff', 'admin'));

-- A short daily checklist per HQ person (Iman's HR & Admin daily checks to start with).
CREATE TABLE hq_daily_tasks (
  id         serial PRIMARY KEY,
  person_id  integer NOT NULL REFERENCES people(id),
  label      text NOT NULL CHECK (NOT p4u_mentions_salary(label)),
  sort_order integer NOT NULL DEFAULT 0,
  active     boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE hq_daily_ticks (
  task_id    integer NOT NULL REFERENCES hq_daily_tasks(id),
  entry_date date NOT NULL,
  done       boolean NOT NULL,
  entered_by integer REFERENCES users(id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (task_id, entry_date)
);

-- One commitment per HQ person per week, written at the Monday HQ session.
-- done: 'yes' / 'partly' / 'no', marked the following week (HQ Tracker → Commitments).
CREATE TABLE hq_commitments (
  id         serial PRIMARY KEY,
  week_start date NOT NULL CHECK (EXTRACT(ISODOW FROM week_start) = 1),
  person_id  integer NOT NULL REFERENCES people(id),
  commitment text NOT NULL CHECK (NOT p4u_mentions_salary(commitment)),
  moves      text CHECK (NOT p4u_mentions_salary(moves)),
  by_when    date,
  done       text CHECK (done IN ('yes', 'partly', 'no')),
  created_by integer REFERENCES users(id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (week_start, person_id)
);

-- Building-to-scale projects (HQ Tracker → Projects): milestones with owner, start, due, status.
CREATE TABLE hq_projects (
  id         serial PRIMARY KEY,
  project    text NOT NULL,
  milestone  text NOT NULL,
  owner      text NOT NULL,
  start_date date,
  due_date   date,
  status     text NOT NULL DEFAULT 'Not started'
             CHECK (status IN ('Not started', 'In progress', 'Done', 'Blocked')),
  notes      text,
  sort_order integer NOT NULL DEFAULT 0,
  active     boolean NOT NULL DEFAULT true,
  updated_by integer REFERENCES users(id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (NOT p4u_mentions_salary(project) AND NOT p4u_mentions_salary(milestone) AND NOT p4u_mentions_salary(notes))
);
