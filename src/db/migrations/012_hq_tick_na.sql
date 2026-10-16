-- HQ daily tasks: "N/A" for days a task doesn't apply (e.g. no B2B quote requested that day).
-- N/A rows have done = false, na = true and don't count against a fully done day.
ALTER TABLE hq_daily_ticks ADD COLUMN IF NOT EXISTS na boolean NOT NULL DEFAULT false;
