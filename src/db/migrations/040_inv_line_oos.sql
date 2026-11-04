-- 4 Nov 2026 (CEO): ticking a line on Today's list answers the matching open out-of-stock reports.
-- The reports answered from a line are kept on it (JSON [{id, branch, item, label}]).
ALTER TABLE inv_plan_lines ADD COLUMN IF NOT EXISTS oos_answered text;
