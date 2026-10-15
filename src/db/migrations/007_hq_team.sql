-- 007_hq_team.sql – the whole HQ team from the Q4 4DX HQ Tracker (Syarafana, Fariz, Azwani,
-- Iman, and the CEO's own measure), Yes/No HQ measures, and Iman entering for everyone.

ALTER TABLE hq_measures DROP CONSTRAINT IF EXISTS hq_measures_input_check;
ALTER TABLE hq_measures ADD CONSTRAINT hq_measures_input_check
  CHECK (input IN ('single_value', 'done_and_total', 'yes_no'));

-- HQ logins that may enter every HQ number (Iman fills the HQ KPIs for the Monday session).
ALTER TABLE users ADD COLUMN IF NOT EXISTS enters_all_hq boolean NOT NULL DEFAULT false;
