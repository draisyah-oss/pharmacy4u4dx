-- 019 – project steps get a status like the wiki checklist (19 Oct): Not started → In progress → Done.
-- done_at / done_by stay: set when a step moves to Done, cleared when it moves back.
ALTER TABLE hq_project_steps ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'Not started'
  CHECK (status IN ('Not started', 'In progress', 'Done'));
UPDATE hq_project_steps SET status = 'Done' WHERE done_at IS NOT NULL;
