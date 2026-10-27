-- 27 Oct: out-of-stock questions & photos, and new item requests (items not listed in Dynamod).
--  * photos: a picture taken on the phone (shrunk in the browser to a JPEG before upload).
--  * oos_items.photo_id: optional photo with the report.
--  * item_requests: a branch asks for an item that isn't in Dynamod yet; Inventory answers
--    (will list and order / need more info / not listing / listed – branch can order now).
--  * oos_messages: a short conversation on an out-of-stock item or a new item request
--    ("what item is this?" → reply + photo), between the branch and the inventory team.
CREATE TABLE photos (
  id          serial PRIMARY KEY,
  mime        text NOT NULL CHECK (mime IN ('image/jpeg', 'image/png', 'image/webp')),
  data        bytea NOT NULL CHECK (octet_length(data) <= 2000000),
  branch_id   integer REFERENCES branches(id),
  created_by  integer REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE oos_items ADD COLUMN IF NOT EXISTS photo_id integer REFERENCES photos(id);

CREATE TABLE item_requests (
  id               serial PRIMARY KEY,
  branch_id        integer NOT NULL REFERENCES branches(id),
  item             text NOT NULL CHECK (NOT p4u_mentions_salary(item)),
  details          text CHECK (details IS NULL OR NOT p4u_mentions_salary(details)),
  customers_count  integer CHECK (customers_count IS NULL OR customers_count >= 0),
  note             text CHECK (note IS NULL OR NOT p4u_mentions_salary(note)),
  photo_id         integer REFERENCES photos(id),
  status           text NOT NULL DEFAULT 'New' CHECK (status IN ('New', 'Need more info', 'Will list', 'Listed', 'Not listing')),
  answer_note      text CHECK (answer_note IS NULL OR NOT p4u_mentions_salary(answer_note)),
  answered_at      timestamptz,
  answered_by      integer REFERENCES users(id),
  created_by       integer REFERENCES users(id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX item_requests_open ON item_requests (status, created_at);

CREATE TABLE oos_messages (
  id          serial PRIMARY KEY,
  oos_id      integer REFERENCES oos_items(id) ON DELETE CASCADE,
  request_id  integer REFERENCES item_requests(id) ON DELETE CASCADE,
  user_id     integer REFERENCES users(id),
  from_branch boolean NOT NULL,
  body        text CHECK (body IS NULL OR NOT p4u_mentions_salary(body)),
  photo_id    integer REFERENCES photos(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  CHECK ((oos_id IS NULL) <> (request_id IS NULL)),
  CHECK (body IS NOT NULL OR photo_id IS NOT NULL)
);
CREATE INDEX oos_messages_oos ON oos_messages (oos_id, created_at);
CREATE INDEX oos_messages_req ON oos_messages (request_id, created_at);
