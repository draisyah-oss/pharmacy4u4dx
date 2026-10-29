-- 29 Oct (CEO, BR): a daily measure's second target ("weekend target") can apply on days other than
-- Saturday and Sunday. BR's walk-in WIG is RM 1,250 Tuesday–Saturday and RM 1,650 on its busy days,
-- Sunday and Monday. NULL = Saturday and Sunday, as before.
ALTER TABLE measures ADD COLUMN IF NOT EXISTS high_days text
  CHECK (high_days IS NULL OR high_days ~ '^(Sun|Mon|Tue|Wed|Thu|Fri|Sat)(,(Sun|Mon|Tue|Wed|Thu|Fri|Sat))*$');
