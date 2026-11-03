-- 3 Nov 2026 (CEO): branch managers change their branch's activity measures themselves; a change to a
-- lead measure waits here until the CEO approves it; WIG measures can't be changed by managers.
CREATE TABLE measure_changes (
  id           serial PRIMARY KEY,
  measure_id   integer NOT NULL REFERENCES measures(id),
  branch_id    integer NOT NULL REFERENCES branches(id),
  change       jsonb NOT NULL,                 -- { label, field_label, owner, targets: { 'YYYY-MM': { t, w } } } – only what changes
  reason       text CHECK (reason IS NULL OR NOT p4u_mentions_salary(reason)),
  status       text NOT NULL DEFAULT 'Waiting' CHECK (status IN ('Waiting', 'Approved', 'Not approved', 'Withdrawn')),
  proposed_by  integer REFERENCES users(id),
  proposed_at  timestamptz NOT NULL DEFAULT now(),
  decided_by   integer REFERENCES users(id),
  decided_at   timestamptz,
  decision_note text CHECK (decision_note IS NULL OR NOT p4u_mentions_salary(decision_note))
);
CREATE INDEX measure_changes_status ON measure_changes (status, branch_id);
