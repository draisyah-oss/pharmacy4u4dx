-- 3 Nov 2026 (CEO / Alia): the Dynamod product masterlist, so out-of-stock reports name the exact
-- product (same description, stock ID and UOM as in Dynamod) – easier to order.
CREATE TABLE products (
  id           serial PRIMARY KEY,
  barcode      text NOT NULL UNIQUE,           -- one row per Dynamod UOM line (barcode is unique)
  stock_id     text NOT NULL,
  description  text NOT NULL,
  uom          text,
  generic      text,
  brand        text,
  group_desc   text,
  category     text,
  active       boolean NOT NULL DEFAULT true,
  search       text NOT NULL,                  -- lower-case description + generic + brand + stock id + barcode
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX products_stock ON products (stock_id);
ALTER TABLE oos_items ADD COLUMN IF NOT EXISTS product_id integer REFERENCES products(id);
