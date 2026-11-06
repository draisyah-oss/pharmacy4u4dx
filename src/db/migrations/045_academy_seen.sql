-- Academy celebrations already shown to a person (level-up, badge, streak bonus, module complete, verified).
CREATE TABLE IF NOT EXISTS academy_seen (
  user_id integer NOT NULL,
  kind text NOT NULL,
  key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, kind, key)
);
