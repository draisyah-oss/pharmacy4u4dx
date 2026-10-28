-- 28 Oct: B2B out-of-stock items in the Inventory table (CEO: "divided by branches + B2B").
-- A B2B item has no branch: the inventory team adds it with the customer's name. It is answered
-- like a branch item but never counts in a branch's numbers.
ALTER TABLE oos_items ALTER COLUMN branch_id DROP NOT NULL;
ALTER TABLE oos_items ADD COLUMN IF NOT EXISTS b2b_customer text CHECK (b2b_customer IS NULL OR NOT p4u_mentions_salary(b2b_customer));
ALTER TABLE oos_items ADD CONSTRAINT oos_items_branch_or_b2b CHECK (branch_id IS NOT NULL OR b2b_customer IS NOT NULL);
