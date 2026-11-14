-- 14 Nov 2026 (CEO): zakat quotations are priced at Dynamod Price 1 (the normal price, not the member
-- price). The Price 1 used for a line is kept with it, like the cost.
ALTER TABLE quotation_lines ADD COLUMN IF NOT EXISTS price1_at_quote numeric(12,2);

-- Drafts already started: keep the item's Price 1 with the line, and lines still on the suggested price
-- move to Price 1 (typed prices are left alone). Issued quotations are never changed.
UPDATE quotation_lines l SET price1_at_quote = p.price1
  FROM products p, quotations q
  WHERE l.product_id = p.id AND q.id = l.quotation_id AND q.status = 'draft' AND p.price1 IS NOT NULL;
UPDATE quotation_lines l SET auto_price = l.price1_at_quote, unit_price = l.price1_at_quote
  FROM quotations q
  WHERE q.id = l.quotation_id AND q.status = 'draft' AND l.price_source = 'auto' AND l.price1_at_quote > 0;
