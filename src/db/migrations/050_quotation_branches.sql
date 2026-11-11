-- 11 Nov 2026 (CEO): zakat quotations for every branch, each with its own numbers (branch code in the
-- ref, continuing the branch's own count: JH was at QT-2026-0072, BR at QT-2026-033).
INSERT INTO quotation_series (series, year, next_no) VALUES
  ('QT-JH', 2026, 73), ('QT-BR', 2026, 34), ('QT-BGI', 2026, 1), ('QT-AMP', 2026, 1)
ON CONFLICT (series, year) DO NOTHING;

-- BR's template has a FAX box, "From", and Validity / Delivery Term / Payment Term lines.
ALTER TABLE quotations ADD COLUMN IF NOT EXISTS fax text NOT NULL DEFAULT '' CHECK (NOT p4u_mentions_salary(fax));
ALTER TABLE quotations ADD COLUMN IF NOT EXISTS from_name text NOT NULL DEFAULT '' CHECK (NOT p4u_mentions_salary(from_name));
ALTER TABLE quotations ADD COLUMN IF NOT EXISTS validity text NOT NULL DEFAULT '' CHECK (NOT p4u_mentions_salary(validity));
ALTER TABLE quotations ADD COLUMN IF NOT EXISTS delivery_term text NOT NULL DEFAULT '' CHECK (NOT p4u_mentions_salary(delivery_term));
ALTER TABLE quotations ADD COLUMN IF NOT EXISTS payment_term text NOT NULL DEFAULT '' CHECK (NOT p4u_mentions_salary(payment_term));
CREATE INDEX IF NOT EXISTS quotations_outlet ON quotations (outlet, created_at DESC);
