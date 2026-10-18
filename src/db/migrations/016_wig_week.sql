-- 016 – the weekly WIG rhythm (18 Oct, from the approved mockup):
--   Monday 10 am HQ WIG → Monday 4 pm managers' update with CEO, Alia, Hanin → Tuesday branch WIG.
--
-- Branch commitments: Done / Partly / Not done (was Done Y/N) with a short "why", typed by the
-- staff on their phone or by the manager at the session.
ALTER TABLE commitments ADD COLUMN IF NOT EXISTS result text CHECK (result IN ('yes', 'partly', 'no'));
ALTER TABLE commitments ADD COLUMN IF NOT EXISTS why text CHECK (why IS NULL OR NOT p4u_mentions_salary(why));
UPDATE commitments SET result = CASE WHEN done THEN 'yes' ELSE 'no' END WHERE done IS NOT NULL AND result IS NULL;

-- The branch WIG session itself: held on which day, and who was there.
CREATE TABLE branch_wig_sessions (
  branch_id  integer NOT NULL REFERENCES branches(id),
  week_start date NOT NULL CHECK (EXTRACT(ISODOW FROM week_start) = 1),
  held_on    date,
  attended   integer[] NOT NULL DEFAULT '{}',
  saved_by   integer REFERENCES users(id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (branch_id, week_start)
);

-- What a branch needs from HQ (raised in the manager's weekly update) and what HQ agrees to do
-- in the Monday 4 pm meeting: owner, due date, status. week_start = the check-in week it was raised for.
CREATE TABLE hq_actions (
  id              serial PRIMARY KEY,
  branch_id       integer REFERENCES branches(id),
  week_start      date NOT NULL CHECK (EXTRACT(ISODOW FROM week_start) = 1),
  issue           text NOT NULL CHECK (NOT p4u_mentions_salary(issue)),
  owner_person_id integer REFERENCES people(id),
  due_date        date,
  status          text NOT NULL DEFAULT 'Open' CHECK (status IN ('Open', 'Done', 'Not done', 'Dropped')),
  agreed          boolean NOT NULL DEFAULT false,
  raised_by       integer REFERENCES users(id),
  updated_by      integer REFERENCES users(id),
  done_at         timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX hq_actions_week ON hq_actions (week_start);

-- Each HQ person's focus for the week: set by the CEO, or proposed by the person and approved by the CEO.
CREATE TABLE hq_focus (
  week_start  date NOT NULL CHECK (EXTRACT(ISODOW FROM week_start) = 1),
  person_id   integer NOT NULL REFERENCES people(id),
  focus       text NOT NULL CHECK (NOT p4u_mentions_salary(focus)),
  status      text NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed', 'approved')),
  proposed_by integer REFERENCES users(id),
  approved_by integer REFERENCES users(id),
  approved_at timestamptz,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (week_start, person_id)
);

-- Wiki checklist: Iman writes every page and sends it to Hanin (Checking); Hanin approves.
ALTER TABLE hq_wiki_items ADD COLUMN IF NOT EXISTS checking_at timestamptz;
