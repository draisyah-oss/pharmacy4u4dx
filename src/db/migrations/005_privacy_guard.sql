-- 005_privacy_guard.sql – the database itself refuses salary/pay data (CLAUDE.md privacy rule).
-- Same words as src/privacy.js. "Commission" is allowed (JH TikTok affiliate commission is sales).
CREATE OR REPLACE FUNCTION p4u_mentions_salary(t text) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
  SELECT COALESCE(t, '') ~* '(salar|gaji|\mwages?\M|payroll|\mupah\M|pay\s*slip|\mkwsp\M|\mepf\M|\msocso\M|\mperkeso\M)'
$$;

ALTER TABLE daily_fields ADD CONSTRAINT daily_fields_no_salary
  CHECK (NOT p4u_mentions_salary(key) AND NOT p4u_mentions_salary(label));
ALTER TABLE measures ADD CONSTRAINT measures_no_salary
  CHECK (NOT p4u_mentions_salary(label) AND NOT p4u_mentions_salary(unit) AND NOT p4u_mentions_salary(note));
ALTER TABLE hq_measures ADD CONSTRAINT hq_measures_no_salary
  CHECK (NOT p4u_mentions_salary(label) AND NOT p4u_mentions_salary(unit) AND NOT p4u_mentions_salary(note));
ALTER TABLE branches ADD CONSTRAINT branches_no_salary_sheet_column
  CHECK (NOT p4u_mentions_salary(sales_sheet::text));
