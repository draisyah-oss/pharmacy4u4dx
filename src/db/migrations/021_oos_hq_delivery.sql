-- 25 Oct: out-of-stock flow, second round.
--  * New answer 'hq_deliver': HQ (warehouse) sends the stock to the branch – picked → sent → the
--    branch accepts it. Transfers between branches stay 'transfer'.
--  * Inventory can close an item itself ("Done – delivered") when it was fulfilled outside the
--    app's steps; closed_by_hq marks those so the branch sees who closed it.
ALTER TABLE oos_items DROP CONSTRAINT IF EXISTS oos_items_answer_check;
ALTER TABLE oos_items ADD CONSTRAINT oos_items_answer_check
  CHECK (answer IS NULL OR answer IN ('hq_deliver', 'transfer', 'order', 'substitute', 'discontinue'));
ALTER TABLE oos_items ADD COLUMN IF NOT EXISTS closed_by_hq boolean NOT NULL DEFAULT false;
