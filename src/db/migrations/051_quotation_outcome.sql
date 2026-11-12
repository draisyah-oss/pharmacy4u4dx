-- 12 Nov 2026 (CEO): a quotation's outcome – Won (counts in the zakat claims tracker as a contract won)
-- or Cancelled (only a cancelled quotation, or a draft, can then be deleted).
ALTER TABLE quotations DROP CONSTRAINT IF EXISTS quotations_status_check;
ALTER TABLE quotations ADD CONSTRAINT quotations_status_check CHECK (status IN ('draft', 'issued', 'won', 'cancelled'));
ALTER TABLE quotations ADD COLUMN IF NOT EXISTS outcome_at timestamptz;
ALTER TABLE quotations ADD COLUMN IF NOT EXISTS outcome_by integer REFERENCES users(id);
CREATE INDEX IF NOT EXISTS quotations_outlet_date ON quotations (outlet, quote_date);
