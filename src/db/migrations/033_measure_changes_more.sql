-- 3 Nov 2026 (CEO): managers can also ADD measures (lead → CEO approves; activity → straight away),
-- and every manager change counts towards a limit of 4 a month per branch.
ALTER TABLE measure_changes ALTER COLUMN measure_id DROP NOT NULL;
ALTER TABLE measure_changes ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'edit' CHECK (kind IN ('edit', 'add', 'remove'));
ALTER TABLE measure_changes ADD COLUMN IF NOT EXISTS tier text CHECK (tier IS NULL OR tier IN ('lead', 'activity'));
ALTER TABLE measure_changes DROP CONSTRAINT IF EXISTS measure_changes_status_check;
ALTER TABLE measure_changes ADD CONSTRAINT measure_changes_status_check CHECK (status IN ('Waiting', 'Approved', 'Not approved', 'Withdrawn', 'Applied'));
