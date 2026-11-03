-- 3 Nov 2026 (CEO): cost and selling prices from the Dynamod masterlist on the Product list page,
-- so Inventory can look them up quickly. Shown only to the inventory team and admin (/oos/products) –
-- never in the branch product picker or anything a customer sees.
ALTER TABLE products ADD COLUMN IF NOT EXISTS cost numeric(12,4);
ALTER TABLE products ADD COLUMN IF NOT EXISTS price1 numeric(12,2);
ALTER TABLE products ADD COLUMN IF NOT EXISTS price2 numeric(12,2);
