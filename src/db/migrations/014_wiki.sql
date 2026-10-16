-- 16 Oct: company wiki + Pharmacy4U Classroom, inside the app. Everyone logged in reads it;
-- HQ and admin add and change pages. Branch staff send educational posters (JH: one a day),
-- Hanin (HQ) approves them into the Classroom and the Meta post queue.

CREATE TABLE wiki_files (
  id          serial PRIMARY KEY,
  filename    text NOT NULL CHECK (NOT p4u_mentions_salary(filename)),
  mime        text NOT NULL,
  size        integer NOT NULL CHECK (size > 0 AND size <= 15728640),
  data        bytea NOT NULL,
  created_by  integer REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE wiki_pages (
  id            serial PRIMARY KEY,
  section       text NOT NULL CHECK (section IN ('company', 'jd', 'sop', 'classroom', 'poster')),
  title         text NOT NULL CHECK (length(title) BETWEEN 1 AND 160 AND NOT p4u_mentions_salary(title)),
  body          text CHECK (body IS NULL OR NOT p4u_mentions_salary(body)),
  tags          text CHECK (tags IS NULL OR NOT p4u_mentions_salary(tags)),
  file_id       integer REFERENCES wiki_files(id),
  branch_id     integer REFERENCES branches(id),           -- posters: the branch that made it
  status        text NOT NULL DEFAULT 'published' CHECK (status IN ('published', 'pending', 'needs_fix')),
  review_note   text CHECK (review_note IS NULL OR NOT p4u_mentions_salary(review_note)),
  approved_by   integer REFERENCES users(id),
  approved_at   timestamptz,
  meta_posted_at timestamptz,                              -- posters used on Facebook / Instagram
  active        boolean NOT NULL DEFAULT true,
  created_by    integer REFERENCES users(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_by    integer REFERENCES users(id),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX wiki_pages_section ON wiki_pages (section, status, active);

-- Who has opened what (first time only): "staff who have opened the wiki", "read by 12 of 30".
CREATE TABLE wiki_reads (
  page_id  integer NOT NULL REFERENCES wiki_pages(id),
  user_id  integer NOT NULL REFERENCES users(id),
  read_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (page_id, user_id)
);
CREATE TABLE wiki_visits (
  user_id     integer PRIMARY KEY REFERENCES users(id),
  first_at    timestamptz NOT NULL DEFAULT now(),
  last_at     timestamptz NOT NULL DEFAULT now()
);
