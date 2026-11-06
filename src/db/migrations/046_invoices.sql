-- 6 Nov 2026 (CEO): invoice scan. Staff photograph a supplier invoice on their phone; the app makes one
-- PDF of the pages and saves it in the P4U Finance inbox folder on Google Drive (a subfolder per month)
-- for Mr Eve. Finance ticks "Entered in Dynamod". The PDF is kept here until it is in Drive.
CREATE TABLE invoices (
  id             serial PRIMARY KEY,
  branch_id      integer REFERENCES branches(id),        -- NULL = HQ
  supplier       text NOT NULL CHECK (NOT p4u_mentions_salary(supplier)),
  supplier_key   text NOT NULL,                          -- lower case, spaces squeezed (duplicate check)
  invoice_no     text NOT NULL CHECK (NOT p4u_mentions_salary(invoice_no)),
  invoice_key    text NOT NULL,                          -- upper case letters and digits only
  invoice_date   date NOT NULL,
  amount         numeric(12,2) NOT NULL CHECK (amount > 0),
  po_ref         text CHECK (po_ref IS NULL OR NOT p4u_mentions_salary(po_ref)),
  pages          integer NOT NULL DEFAULT 1,
  file_name      text NOT NULL,
  pdf            bytea,                                   -- cleared once the file is in Drive
  drive_file_id  text,
  drive_link     text,
  drive_saved_at timestamptz,
  drive_error    text,
  status         text NOT NULL DEFAULT 'Received' CHECK (status IN ('Received', 'Entered in Dynamod')),
  entered_at     timestamptz,
  entered_by     integer REFERENCES users(id),
  created_by     integer REFERENCES users(id),
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX invoices_dup ON invoices (supplier_key, invoice_key);
CREATE INDEX invoices_status ON invoices (status);
