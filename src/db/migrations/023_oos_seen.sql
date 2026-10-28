-- 28 Oct: "Seen by Inventory" – the first time someone in the inventory team opens an out-of-stock
-- item or a new item request, so the branch and the CEO can see it was picked up.
ALTER TABLE oos_items ADD COLUMN IF NOT EXISTS seen_at timestamptz;
ALTER TABLE oos_items ADD COLUMN IF NOT EXISTS seen_by integer REFERENCES users(id);
ALTER TABLE item_requests ADD COLUMN IF NOT EXISTS seen_at timestamptz;
ALTER TABLE item_requests ADD COLUMN IF NOT EXISTS seen_by integer REFERENCES users(id);
