-- 006_weekly.sql – weekly check-in, OOS list, commitments and HQ input are now built.
-- The salary guard (migration 005) also covers the free-text boxes on these screens, and
-- each person makes one commitment per week.

ALTER TABLE weekly_checkins ADD CONSTRAINT weekly_checkins_no_salary
  CHECK (NOT p4u_mentions_salary(win_this_week) AND NOT p4u_mentions_salary(issue_needing_hq_help));

ALTER TABLE oos_items ADD CONSTRAINT oos_items_no_salary
  CHECK (NOT p4u_mentions_salary(item) AND NOT p4u_mentions_salary(customers_asking)
         AND NOT p4u_mentions_salary(reason_for_delay));

ALTER TABLE commitments ADD CONSTRAINT commitments_no_salary
  CHECK (NOT p4u_mentions_salary(commitment) AND NOT p4u_mentions_salary(lead_measure));

CREATE UNIQUE INDEX IF NOT EXISTS commitments_one_per_person ON commitments (branch_id, week_start, person_id);

ALTER TABLE oos_items ADD COLUMN IF NOT EXISTS updated_by integer REFERENCES users(id);
