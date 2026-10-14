-- 004_sales_sheet.sql – link to the 2026 Sales Dashboard Google Sheet.
-- branches.sales_sheet: { "tab": "Daily sales WM", "columns": { "walkin": "Total", ... } }
-- daily_entries.source: 'app' (typed in the app) or 'sheet' (synced from the sales sheet).
ALTER TABLE branches ADD COLUMN sales_sheet jsonb;
ALTER TABLE daily_entries ADD COLUMN source text NOT NULL DEFAULT 'app' CHECK (source IN ('app', 'sheet'));
