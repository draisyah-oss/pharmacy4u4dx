-- 017 – HQ WIG (19 Oct): each HQ person can have up to 2 focuses and 2 commitments a week (slot 1, 2).
ALTER TABLE hq_commitments ADD COLUMN IF NOT EXISTS slot smallint NOT NULL DEFAULT 1 CHECK (slot IN (1, 2));
ALTER TABLE hq_commitments DROP CONSTRAINT IF EXISTS hq_commitments_week_start_person_id_key;
CREATE UNIQUE INDEX IF NOT EXISTS hq_commitments_one_per_slot ON hq_commitments (week_start, person_id, slot);

ALTER TABLE hq_focus ADD COLUMN IF NOT EXISTS slot smallint NOT NULL DEFAULT 1 CHECK (slot IN (1, 2));
ALTER TABLE hq_focus DROP CONSTRAINT IF EXISTS hq_focus_pkey;
ALTER TABLE hq_focus ADD PRIMARY KEY (week_start, person_id, slot);
