-- 11 Nov 2026 (CEO, "4dx-zakat-handoff" Phase 1): Zakat quotation (WM). Hafizah / HQ paste a Medkad
-- RFQ, match each line to the Dynamod item master, the app prices it (cost × (1 + markup), rounded up
-- to the next 10 sen), shows the "Fill in the zakat form" table and makes the quotation PDF with the
-- next QT-WM-2026-#### number.

-- Stock balance from Alia's weekly stock export ("Balance Quantity (UOM)"), for Readystock / Pre-order.
ALTER TABLE products ADD COLUMN IF NOT EXISTS balance numeric(14,4);
ALTER TABLE products ADD COLUMN IF NOT EXISTS balance_at timestamptz;

-- Ref counters: one row per series and year (QT-WM 2026 → next 0403). Later series (QT-UOC …) are
-- new rows. A number is taken in the same transaction that issues the quote, and never reused.
CREATE TABLE quotation_series (
  series     text NOT NULL CHECK (series ~ '^QT-[A-Z]{2,5}$'),
  year       integer NOT NULL CHECK (year BETWEEN 2020 AND 2100),
  next_no    integer NOT NULL CHECK (next_no BETWEEN 1 AND 9999),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (series, year)
);
INSERT INTO quotation_series (series, year, next_no) VALUES ('QT-WM', 2026, 403);

CREATE TABLE quotations (
  id              serial PRIMARY KEY,
  series          text NOT NULL DEFAULT 'QT-WM',
  outlet          text NOT NULL DEFAULT 'WM',            -- later phases: other outlets
  customer_kind   text NOT NULL DEFAULT 'zakat',         -- later phases: university / other customers
  status          text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'issued', 'cancelled')),
  ref             text UNIQUE,                           -- QT-WM-2026-0403, set when the PDF is made
  ref_year        integer,
  ref_no          integer,
  quote_date      date,                                  -- the date on the PDF (Malaysia time)
  recipient       text NOT NULL CHECK (NOT p4u_mentions_salary(recipient)),
  tel             text NOT NULL DEFAULT '' CHECK (NOT p4u_mentions_salary(tel)),
  cc              text NOT NULL DEFAULT '' CHECK (NOT p4u_mentions_salary(cc)),
  rfq_description text NOT NULL DEFAULT '' CHECK (NOT p4u_mentions_salary(rfq_description)),
  markup          numeric(6,4) NOT NULL,                 -- the markup used for the auto prices
  total           numeric(14,2),
  pdf             bytea,                                 -- the PDF as issued, so a re-download is the same file
  approved_by     integer REFERENCES users(id),          -- Phase 2: Alia's approval adds her signature
  approved_at     timestamptz,
  created_by      integer REFERENCES users(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  issued_by       integer REFERENCES users(id),
  issued_at       timestamptz,
  UNIQUE (series, ref_year, ref_no)
);
CREATE INDEX quotations_created ON quotations (created_at DESC);

CREATE TABLE quotation_lines (
  id               serial PRIMARY KEY,
  quotation_id     integer NOT NULL REFERENCES quotations(id) ON DELETE CASCADE,
  line_no          integer NOT NULL,
  portal_text      text NOT NULL CHECK (NOT p4u_mentions_salary(portal_text)),  -- as typed on the zakat portal
  search_text      text NOT NULL DEFAULT '' CHECK (NOT p4u_mentions_salary(search_text)), -- words used to find matches
  product_id       integer REFERENCES products(id),
  stock_id         text,
  barcode          text,
  description      text NOT NULL DEFAULT '' CHECK (NOT p4u_mentions_salary(description)), -- printed (upper case)
  uom              text,
  qty              integer CHECK (qty IS NULL OR qty > 0),
  unit_price       numeric(12,2) CHECK (unit_price IS NULL OR unit_price >= 0),
  auto_price       numeric(12,2),
  cost_at_quote    numeric(12,4),
  balance_at_quote numeric(14,4),
  price_source     text CHECK (price_source IS NULL OR price_source IN ('auto', 'override', 'manual')),
  need_cost        boolean NOT NULL DEFAULT false,        -- "Need cost – ask Alia"
  stock_option     text CHECK (stock_option IS NULL OR stock_option IN ('readystock', 'preorder')),
  note             text NOT NULL DEFAULT '' CHECK (NOT p4u_mentions_salary(note)),
  UNIQUE (quotation_id, line_no)
);
