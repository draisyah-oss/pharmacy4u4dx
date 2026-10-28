-- 28 Oct: "Request a change" – anyone asks for an improvement to the 4DX app; Claude (Mr 4DX)
-- plans it, builds a preview, the person who asked checks it, the CEO approves, then it goes live.
-- The same list will be fed from WhatsApp later.
CREATE TABLE change_requests (
  id            serial PRIMARY KEY,
  title         text NOT NULL CHECK (NOT p4u_mentions_salary(title)),
  details       text CHECK (details IS NULL OR NOT p4u_mentions_salary(details)),
  area          text NOT NULL DEFAULT 'Other',
  photo_id      integer REFERENCES photos(id),
  status        text NOT NULL DEFAULT 'New' CHECK (status IN
                  ('New', 'Need more info', 'Planned', 'Ready to check', 'Waiting for approval', 'Approved', 'Live', 'Not doing')),
  plan          text CHECK (plan IS NULL OR NOT p4u_mentions_salary(plan)),
  preview_url   text,
  approved_at   timestamptz,
  approved_by   integer REFERENCES users(id),
  live_at       timestamptz,
  source        text NOT NULL DEFAULT 'app' CHECK (source IN ('app', 'whatsapp', 'claude')),
  created_by    integer REFERENCES users(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX change_requests_status ON change_requests (status, created_at);

CREATE TABLE change_request_notes (
  id          serial PRIMARY KEY,
  request_id  integer NOT NULL REFERENCES change_requests(id) ON DELETE CASCADE,
  user_id     integer REFERENCES users(id),
  author      text,                 -- 'Mr 4DX' when written through the agent API
  body        text NOT NULL CHECK (NOT p4u_mentions_salary(body)),
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX change_request_notes_req ON change_request_notes (request_id, created_at);
