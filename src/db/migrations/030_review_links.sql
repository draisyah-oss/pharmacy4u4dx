-- 3 Nov 2026 (CEO): "connect the monthly review to the weekly WIG so they don't do it twice".
-- The branch review's "what we need from HQ" becomes the HQ action of that Monday's update.
ALTER TABLE monthly_reviews ADD COLUMN IF NOT EXISTS hq_action_id integer REFERENCES hq_actions(id) ON DELETE SET NULL;
