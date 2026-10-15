-- 010 – a measure can be scored month to date only (JH zakat sales, 15 Oct: stock arrives
-- unevenly, so a weekly target isn't workable). The week column then shows the actual with
-- no target or status.
ALTER TABLE measures ADD COLUMN IF NOT EXISTS score_by text NOT NULL DEFAULT 'week'
  CHECK (score_by IN ('week', 'month'));
