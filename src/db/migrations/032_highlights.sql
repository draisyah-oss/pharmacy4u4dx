-- 3 Nov 2026 (CEO): the front page is the highlights – company news, wins, and the month's goals
-- with their progress.
ALTER TABLE month_goals ADD COLUMN IF NOT EXISTS metric text;            -- 'company_sales' | 'oos_over3' | NULL (status typed)
ALTER TABLE month_goals ADD COLUMN IF NOT EXISTS status text CHECK (status IS NULL OR status IN ('On track', 'At risk', 'Off track', 'Done'));
ALTER TABLE month_goals ADD COLUMN IF NOT EXISTS progress text CHECK (progress IS NULL OR NOT p4u_mentions_salary(progress));
ALTER TABLE month_goals ADD COLUMN IF NOT EXISTS status_by integer REFERENCES users(id);
ALTER TABLE month_goals ADD COLUMN IF NOT EXISTS status_at timestamptz;

CREATE TABLE news (
  id          serial PRIMARY KEY,
  emoji       text,
  title       text NOT NULL CHECK (NOT p4u_mentions_salary(title)),
  body        text CHECK (body IS NULL OR NOT p4u_mentions_salary(body)),
  pinned      boolean NOT NULL DEFAULT false,
  show_until  date,
  created_by  integer REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  removed_at  timestamptz
);
