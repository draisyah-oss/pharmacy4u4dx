-- 003_weekend_targets.sql – a different daily target for Saturdays and Sundays
-- (BR October: walk-in RM 1,250 on weekdays, RM 1,650 at weekends). Empty = same every day.
ALTER TABLE measure_targets ADD COLUMN weekend_target numeric;
