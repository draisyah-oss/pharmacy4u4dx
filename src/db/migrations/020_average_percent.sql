-- 22 Oct: Grab active inventory % – a percent read off the Grab merchant app and typed as it
-- shows (45 = 45%). New daily field type 'percent' and measure calc 'average_percent'
-- (actual = average of the days it was typed, ÷ 100). No second field to divide by.
ALTER TABLE daily_fields DROP CONSTRAINT IF EXISTS daily_fields_type_check;
ALTER TABLE daily_fields ADD CONSTRAINT daily_fields_type_check
  CHECK (type IN ('money', 'count', 'yes_no', 'percent'));
ALTER TABLE measures DROP CONSTRAINT IF EXISTS measures_calc_check;
ALTER TABLE measures ADD CONSTRAINT measures_calc_check
  CHECK (calc IN ('sum', 'ratio_percent', 'ratio_per_day', 'average_percent'));
ALTER TABLE measures DROP CONSTRAINT IF EXISTS measures_check;
ALTER TABLE measures ADD CONSTRAINT measures_check
  CHECK (calc IN ('sum', 'average_percent') OR denominator_field IS NOT NULL);
