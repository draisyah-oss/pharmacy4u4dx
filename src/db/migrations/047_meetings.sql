-- 047 – Meetings module (8 Nov 2026, CEO brief "4dx-meetings-module-brief"): every management
-- meeting – agenda, updates, minutes, actions, decisions – runs inside 4DX with the existing logins.
-- Who sees what is decided by group membership (meeting_group_members); only the super admin
-- (users.is_super, Dr Aisyah) sees every group. Existing tables (hq_actions, commitments…) are untouched.
-- Every free-text column goes through the salary guard (migration 005).

CREATE TABLE meeting_groups (
  id              serial PRIMARY KEY,
  code            text NOT NULL UNIQUE,
  name            text NOT NULL CHECK (NOT p4u_mentions_salary(name)),
  kind            text NOT NULL DEFAULT 'team' CHECK (kind IN ('team', 'one_to_one')),
  default_day     text,                 -- 'Mon' … 'Sun', shown as the rhythm
  default_time    text,                 -- '11:00'
  agenda_template text NOT NULL DEFAULT 'simple' CHECK (agenda_template IN ('council', 'branch', 'simple')),
  sort_order      integer NOT NULL DEFAULT 0,
  active          boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE meeting_group_members (
  group_id integer NOT NULL REFERENCES meeting_groups(id) ON DELETE CASCADE,
  user_id  integer NOT NULL REFERENCES users(id),
  PRIMARY KEY (group_id, user_id)
);
CREATE INDEX meeting_group_members_user ON meeting_group_members (user_id);

CREATE TABLE meetings (
  id           serial PRIMARY KEY,
  group_id     integer NOT NULL REFERENCES meeting_groups(id),
  title        text CHECK (NOT p4u_mentions_salary(title)),
  held_on      date NOT NULL,
  start_time   text,
  status       text NOT NULL DEFAULT 'planned' CHECK (status IN ('planned', 'draft', 'approved')),
  raw_notes    text CHECK (NOT p4u_mentions_salary(raw_notes)),
  summary      text CHECK (NOT p4u_mentions_salary(summary)),
  parked       jsonb NOT NULL DEFAULT '[]' CHECK (NOT p4u_mentions_salary(parked::text)),
  next_meeting text CHECK (NOT p4u_mentions_salary(next_meeting)),
  draft        jsonb CHECK (draft IS NULL OR NOT p4u_mentions_salary(draft::text)),  -- minutes waiting for review
  minutes_updates jsonb NOT NULL DEFAULT '[]' CHECK (NOT p4u_mentions_salary(minutes_updates::text)), -- follow-ups on existing actions
  created_by   integer REFERENCES users(id),
  approved_by  integer REFERENCES users(id),
  approved_at  timestamptz,
  import_key   text UNIQUE,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX meetings_group ON meetings (group_id, held_on DESC);

CREATE TABLE meeting_attendees (
  meeting_id integer NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  user_id    integer NOT NULL REFERENCES users(id),
  present    boolean,
  PRIMARY KEY (meeting_id, user_id)
);

CREATE TABLE actions (
  id                serial PRIMARY KEY,
  group_id          integer NOT NULL REFERENCES meeting_groups(id),
  title             text NOT NULL CHECK (NOT p4u_mentions_salary(title)),
  owner_user_id     integer REFERENCES users(id),
  due               date,
  area              text NOT NULL DEFAULT 'mgmt' CHECK (area IN ('mgmt', 'sales', 'inv', 'fin', 'hr', 'prod', 'b2b')),
  branch            text NOT NULL DEFAULT 'HQ' CHECK (branch IN ('HQ', 'WM', 'BR', 'JH', 'BGI', 'AMP', 'ALL')),
  status            text NOT NULL DEFAULT 'ns' CHECK (status IN ('ns', 'ip', 'bl', 'dn')),
  priority          text NOT NULL DEFAULT 'Normal' CHECK (priority IN ('High', 'Normal', 'Low')),
  needs_ceo         boolean NOT NULL DEFAULT false,
  raised_count      integer NOT NULL DEFAULT 1,
  first_raised      date,
  source_meeting_id integer REFERENCES meetings(id),
  source            text CHECK (NOT p4u_mentions_salary(source)),
  last_update_at    timestamptz,
  created_by        integer REFERENCES users(id),
  import_key        text UNIQUE,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX actions_group ON actions (group_id, status);
CREATE INDEX actions_owner ON actions (owner_user_id, status);

CREATE TABLE action_updates (
  id        serial PRIMARY KEY,
  action_id integer NOT NULL REFERENCES actions(id) ON DELETE CASCADE,
  at        timestamptz NOT NULL DEFAULT now(),
  by_user   integer REFERENCES users(id),
  text      text NOT NULL CHECK (NOT p4u_mentions_salary(text))
);
CREATE INDEX action_updates_action ON action_updates (action_id, at);

CREATE TABLE decisions (
  id         serial PRIMARY KEY,
  group_id   integer NOT NULL REFERENCES meeting_groups(id),
  meeting_id integer REFERENCES meetings(id),
  decided_on date NOT NULL,
  text       text NOT NULL CHECK (NOT p4u_mentions_salary(text)),
  context    text CHECK (NOT p4u_mentions_salary(context)),
  area       text NOT NULL DEFAULT 'mgmt' CHECK (area IN ('mgmt', 'sales', 'inv', 'fin', 'hr', 'prod', 'b2b')),
  branch     text NOT NULL DEFAULT 'ALL' CHECK (branch IN ('HQ', 'WM', 'BR', 'JH', 'BGI', 'AMP', 'ALL')),
  decided_by integer REFERENCES users(id),
  created_by integer REFERENCES users(id),
  import_key text UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX decisions_group ON decisions (group_id, decided_on DESC);

-- Items to discuss. meeting_id NULL = waiting for the group's next meeting.
CREATE TABLE agenda_items (
  id          serial PRIMARY KEY,
  group_id    integer NOT NULL REFERENCES meeting_groups(id),
  meeting_id  integer REFERENCES meetings(id) ON DELETE SET NULL,
  text        text NOT NULL CHECK (NOT p4u_mentions_salary(text)),
  need        text NOT NULL DEFAULT 'discuss' CHECK (need IN ('decision', 'update', 'discuss')),
  raised_by   integer REFERENCES users(id),
  source      text NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'update', 'note', 'import')),
  source_id   integer,
  outcome     text CHECK (outcome IN ('decision', 'action', 'parked')),
  outcome_ref integer,
  import_key  text UNIQUE,
  removed_at  timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX agenda_items_group ON agenda_items (group_id, meeting_id);

-- Each attendee's update for a meeting: 1 win, 2 issues, help needed.
CREATE TABLE meeting_updates (
  meeting_id  integer NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  user_id     integer NOT NULL REFERENCES users(id),
  win         text CHECK (NOT p4u_mentions_salary(win)),
  issue1      text CHECK (NOT p4u_mentions_salary(issue1)),
  issue2      text CHECK (NOT p4u_mentions_salary(issue2)),
  help_needed text CHECK (NOT p4u_mentions_salary(help_needed)),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (meeting_id, user_id)
);

-- My notes: private to the person who wrote them (no role can read another person's notes).
CREATE TABLE private_notes (
  id             serial PRIMARY KEY,
  user_id        integer NOT NULL REFERENCES users(id),
  text           text NOT NULL CHECK (NOT p4u_mentions_salary(text)),
  need           text NOT NULL DEFAULT 'discuss' CHECK (need IN ('decision', 'update', 'discuss')),
  meeting_id     integer REFERENCES meetings(id) ON DELETE SET NULL,
  agenda_item_id integer REFERENCES agenda_items(id) ON DELETE SET NULL,
  done_at        timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX private_notes_user ON private_notes (user_id, created_at DESC);
