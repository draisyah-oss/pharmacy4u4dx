-- 30 Oct (Alia / Ampang): an out-of-stock report can be CANCELLED (not needed any more, reported by
-- mistake, customer gone) by the branch or Inventory, with an optional reason. Cancelled items are
-- closed but never count as "back in stock" on the scoreboard.
ALTER TABLE oos_items DROP CONSTRAINT IF EXISTS oos_items_status_check;
ALTER TABLE oos_items ADD CONSTRAINT oos_items_status_check CHECK (status IN (
  'Open', 'Ordered', 'On the way', 'Substitute offered', 'Back in stock', 'Discontinued', 'Discontinued / use substitute', 'Cancelled'));
ALTER TABLE oos_items ADD COLUMN IF NOT EXISTS cancelled_at  timestamptz;
ALTER TABLE oos_items ADD COLUMN IF NOT EXISTS cancelled_by  integer REFERENCES users(id);
ALTER TABLE oos_items ADD COLUMN IF NOT EXISTS cancel_reason text CHECK (cancel_reason IS NULL OR NOT p4u_mentions_salary(cancel_reason));
