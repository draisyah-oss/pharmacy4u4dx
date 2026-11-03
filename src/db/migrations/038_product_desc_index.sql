-- 3 Nov 2026: estimated sales lost to out of stock looks up an item's selling price by its exact
-- Dynamod description when it was typed before the product picker (no product_id).
CREATE INDEX IF NOT EXISTS products_lower_desc ON products (lower(description));
