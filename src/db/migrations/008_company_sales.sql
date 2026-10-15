-- 008_company_sales.sql – company total sales (all branches + B2B) against the company's
-- monthly target (HQ Tracker: Oct 266,800 · Nov 313,600 · Dec 360,500). From seed.json
-- company.monthly_sales_target; edited in Admin → Targets → HQ.
CREATE TABLE IF NOT EXISTS company_month_targets (
  month              char(7) PRIMARY KEY CHECK (month ~ '^\d{4}-\d{2}$'),
  total_sales_target numeric
);
