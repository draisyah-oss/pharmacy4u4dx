-- 11 Nov 2026 (CEO): zakat quotations for every branch, each with its own numbers (branch code in the
-- ref, continuing the branch's own count: JH was at QT-2026-0072, BR at QT-2026-033).
INSERT INTO quotation_series (series, year, next_no) VALUES
  ('QT-JH', 2026, 73), ('QT-BR', 2026, 34), ('QT-BGI', 2026, 1), ('QT-AMP', 2026, 1)
ON CONFLICT (series, year) DO NOTHING;

-- (every branch uses the WM quotation layout – CEO 11 Nov: "use same letterhead with WM")
CREATE INDEX IF NOT EXISTS quotations_outlet ON quotations (outlet, created_at DESC);
