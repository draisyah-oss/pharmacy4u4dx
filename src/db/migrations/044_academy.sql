-- Pharmacy4U Academy (trial): modules, what each person has done, and challenge logs.
-- Module content is loaded from src/academy/content.js the first time a module is missing;
-- after that the database is the source of truth (HQ edits go here, not in code).

CREATE TABLE academy_modules (
  id         serial PRIMARY KEY,
  code       text NOT NULL UNIQUE,            -- e.g. '1.5'
  title      text NOT NULL,
  track      text NOT NULL,
  minutes    integer NOT NULL DEFAULT 4,
  source     text,
  sort_order integer NOT NULL DEFAULT 0,
  published  boolean NOT NULL DEFAULT true,   -- false hides a module from everyone
  cards      jsonb NOT NULL DEFAULT '[]',
  questions  jsonb NOT NULL DEFAULT '[]',
  roleplay   jsonb NOT NULL DEFAULT '{}',
  challenge  jsonb NOT NULL DEFAULT '{}'
);

-- One row each time someone finishes the cards, takes the quiz or finishes the role-play.
CREATE TABLE academy_progress (
  id         serial PRIMARY KEY,
  user_id    integer NOT NULL REFERENCES users(id),
  module_id  integer NOT NULL REFERENCES academy_modules(id),
  event      text NOT NULL CHECK (event IN ('cards', 'quiz', 'roleplay')),
  score      integer,
  total      integer,
  passed     boolean,
  day        text NOT NULL,                   -- Malaysia date (YYYY-MM-DD) of the attempt
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX academy_progress_user ON academy_progress (user_id, module_id);

-- The Counter Challenge log. Verified by the branch manager.
CREATE TABLE academy_challenges (
  id          serial PRIMARY KEY,
  user_id     integer NOT NULL REFERENCES users(id),
  module_id   integer NOT NULL REFERENCES academy_modules(id),
  entry       jsonb NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  verified    boolean,                        -- null = waiting for the manager
  checks      jsonb,
  verified_by integer REFERENCES users(id),
  verified_at timestamptz
);
CREATE INDEX academy_challenges_user ON academy_challenges (user_id, module_id);
