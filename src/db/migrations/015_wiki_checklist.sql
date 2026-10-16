-- 16 Oct: the company wiki checklist (framework doc, phase 1) as a tracker for Iman and Hanin.
-- 64 pages in 8 areas, each with an owner, a priority (P1 by 15 Nov, P2 by 31 Dec, P3 Q1 2027)
-- and a status. The wiki itself comes later; this tracks writing its pages.
CREATE TABLE hq_wiki_items (
  id          serial PRIMARY KEY,
  area        text NOT NULL,
  title       text NOT NULL CHECK (NOT p4u_mentions_salary(title)),
  owner       text NOT NULL,
  person_id   integer REFERENCES people(id),
  priority    text NOT NULL CHECK (priority IN ('P1', 'P2', 'P3')),
  due_date    date,
  status      text NOT NULL DEFAULT 'Not started' CHECK (status IN ('Not started', 'Drafting', 'Checking', 'Approved')),
  writer      text CHECK (writer IS NULL OR NOT p4u_mentions_salary(writer)),
  approved_at timestamptz,
  sort_order  integer NOT NULL DEFAULT 0,
  updated_by  integer REFERENCES users(id),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
