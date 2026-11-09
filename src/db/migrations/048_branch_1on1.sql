-- 048 – Branch 1:1s, quick follow-ups, "What's new" (9 Nov 2026, CEO).
-- Branch 1:1 groups (kind 'branch_1on1', one per branch: branch manager + Hanin; the CEO sees all),
-- "Led by" on meetings, a follow-up log (call / visit / WhatsApp / meeting) that can update an action,
-- an event log behind the CEO's "What's new" feed, and when each person last cleared that feed.
-- Every free-text column goes through the salary guard (migration 005).

ALTER TABLE meeting_groups DROP CONSTRAINT IF EXISTS meeting_groups_kind_check;
ALTER TABLE meeting_groups ADD CONSTRAINT meeting_groups_kind_check CHECK (kind IN ('team', 'one_to_one', 'branch_1on1'));
ALTER TABLE meeting_groups ADD COLUMN branch text CHECK (branch IN ('WM', 'BR', 'JH', 'BGI', 'AMP'));

ALTER TABLE meetings ADD COLUMN led_by integer REFERENCES users(id);

CREATE TABLE followups (
  id            serial PRIMARY KEY,
  group_id      integer NOT NULL REFERENCES meeting_groups(id),
  branch        text NOT NULL DEFAULT 'HQ' CHECK (branch IN ('HQ', 'WM', 'BR', 'JH', 'BGI', 'AMP', 'ALL')),
  done_on       date NOT NULL,
  kind          text NOT NULL CHECK (kind IN ('call', 'visit', 'whatsapp', 'meeting')),
  checked       text NOT NULL CHECK (NOT p4u_mentions_salary(checked)),
  outcome       text CHECK (NOT p4u_mentions_salary(outcome)),
  next_step     text CHECK (NOT p4u_mentions_salary(next_step)),
  action_id     integer REFERENCES actions(id) ON DELETE SET NULL,
  status_from   text,                 -- the linked action's status before / after this follow-up (when it changed)
  status_to     text,
  new_action_id integer REFERENCES actions(id) ON DELETE SET NULL,  -- action made from the next step
  ceo_only      boolean NOT NULL DEFAULT false,                     -- only the CEO and the author see it
  by_user       integer NOT NULL REFERENCES users(id),
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX followups_group ON followups (group_id, done_on DESC);
CREATE INDEX followups_branch ON followups (branch, done_on DESC);

-- What happened, one row per event (minutes saved, follow-up, action update / status / done, item to discuss).
-- Read through the same group access as everything else; ceo_only rows only for the CEO and the actor.
CREATE TABLE meeting_events (
  id           serial PRIMARY KEY,
  at           timestamptz NOT NULL DEFAULT now(),
  kind         text NOT NULL CHECK (kind IN ('minutes', 'approved', 'followup', 'action_update', 'action_status', 'action_done', 'action_new', 'item')),
  actor        integer REFERENCES users(id),
  subject_user integer REFERENCES users(id),   -- who it's about (branch manager of a 1:1, action owner)
  group_id     integer NOT NULL REFERENCES meeting_groups(id),
  branch       text,
  ref_type     text NOT NULL CHECK (ref_type IN ('meeting', 'followup', 'action', 'item')),
  ref_id       integer NOT NULL,
  link_id      integer,                         -- e.g. the meeting an item belongs to
  text         text NOT NULL CHECK (NOT p4u_mentions_salary(text)),
  ceo_only     boolean NOT NULL DEFAULT false
);
CREATE INDEX meeting_events_at ON meeting_events (at DESC);

CREATE TABLE meeting_seen (
  user_id integer PRIMARY KEY REFERENCES users(id),
  seen_at timestamptz NOT NULL
);
