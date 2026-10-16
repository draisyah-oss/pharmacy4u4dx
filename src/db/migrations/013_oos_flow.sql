-- 16 Oct: out-of-stock as a daily flow. A branch reports any time (Daily entry → Report out of
-- stock), Inventory (Alia) answers by 11 am the next working day with one of four answers,
-- Fariz sends transfers within 24 hours, the branch confirms "back in stock".
-- Same oos_items table, so the Monday check-in list and the group scoreboard keep working.

ALTER TABLE oos_items DROP CONSTRAINT IF EXISTS oos_items_status_check;
ALTER TABLE oos_items ADD CONSTRAINT oos_items_status_check CHECK (status IN (
  'Open', 'Ordered', 'On the way', 'Substitute offered', 'Back in stock', 'Discontinued', 'Discontinued / use substitute'));

ALTER TABLE oos_items ADD COLUMN IF NOT EXISTS reported_at      timestamptz NOT NULL DEFAULT now();
ALTER TABLE oos_items ADD COLUMN IF NOT EXISTS left_qty         integer CHECK (left_qty IS NULL OR left_qty >= 0);
ALTER TABLE oos_items ADD COLUMN IF NOT EXISTS customers_count  integer CHECK (customers_count IS NULL OR customers_count >= 0);
ALTER TABLE oos_items ADD COLUMN IF NOT EXISTS urgent           boolean NOT NULL DEFAULT false;
ALTER TABLE oos_items ADD COLUMN IF NOT EXISTS note             text CHECK (note IS NULL OR NOT p4u_mentions_salary(note));
ALTER TABLE oos_items ADD COLUMN IF NOT EXISTS answer_due       timestamptz;
ALTER TABLE oos_items ADD COLUMN IF NOT EXISTS answer           text CHECK (answer IS NULL OR answer IN ('transfer', 'order', 'substitute', 'discontinue'));
ALTER TABLE oos_items ADD COLUMN IF NOT EXISTS answer_qty       integer CHECK (answer_qty IS NULL OR answer_qty > 0);
ALTER TABLE oos_items ADD COLUMN IF NOT EXISTS from_branch_id   integer REFERENCES branches(id);
ALTER TABLE oos_items ADD COLUMN IF NOT EXISTS substitute       text CHECK (substitute IS NULL OR NOT p4u_mentions_salary(substitute));
ALTER TABLE oos_items ADD COLUMN IF NOT EXISTS answered_at      timestamptz;
ALTER TABLE oos_items ADD COLUMN IF NOT EXISTS answered_by      integer REFERENCES users(id);
ALTER TABLE oos_items ADD COLUMN IF NOT EXISTS picked_at        timestamptz;
ALTER TABLE oos_items ADD COLUMN IF NOT EXISTS sent_at          timestamptz;
ALTER TABLE oos_items ADD COLUMN IF NOT EXISTS sent_by          integer REFERENCES users(id);
ALTER TABLE oos_items ADD COLUMN IF NOT EXISTS received_at      timestamptz;
ALTER TABLE oos_items ADD COLUMN IF NOT EXISTS received_by      integer REFERENCES users(id);
ALTER TABLE oos_items ADD COLUMN IF NOT EXISTS late_flagged_at  timestamptz;

-- Older Monday-list items count as reported on their out-of-stock date (or their week).
UPDATE oos_items SET reported_at = COALESCE(out_of_stock_since, week_start)::timestamp AT TIME ZONE 'Asia/Kuala_Lumpur'
WHERE answer_due IS NULL;

CREATE INDEX IF NOT EXISTS oos_items_open ON oos_items (status, reported_at);
