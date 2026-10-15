-- 011 – the sales sheet's own summary tabs, mirrored read-only for the Sales view:
--   kind 'daily'   : "Overall Daily Sales" – each branch's till total per day (period = date)
--   kind 'monthly' : "Total Sales" – each branch's retail month total, B2B and the company
--                    total per month (period = 'YYYY-MM'; code = branch code, 'B2B' or 'TOTAL')
-- Replaced on every sync; nobody types into it.
CREATE TABLE IF NOT EXISTS sheet_sales_summary (
  kind      text NOT NULL CHECK (kind IN ('daily', 'monthly')),
  period    text NOT NULL,
  code      text NOT NULL,
  amount    numeric,
  synced_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (kind, period, code)
);
