-- 018 – project steps (19 Oct): a milestone can carry a short checklist of steps, each with a
-- phase heading, an owner, a due date and Done. First used for "Min/max stock levels set for
-- top 300 items" (Syarafana, with Alia).
CREATE TABLE hq_project_steps (
  id         serial PRIMARY KEY,
  project_id integer NOT NULL REFERENCES hq_projects(id),
  phase      text,
  step       text NOT NULL,
  owner      text,
  due_date   date,
  done_at    timestamptz,
  done_by    integer REFERENCES users(id),
  sort_order integer NOT NULL DEFAULT 0,
  active     boolean NOT NULL DEFAULT true,
  updated_by integer REFERENCES users(id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (NOT p4u_mentions_salary(step) AND NOT p4u_mentions_salary(phase) AND NOT p4u_mentions_salary(owner))
);
CREATE INDEX hq_project_steps_project ON hq_project_steps (project_id, sort_order);
