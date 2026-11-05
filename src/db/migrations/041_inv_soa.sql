-- 5 Nov 2026 (CEO): supplier SOA (statement of account) status from the SOA folder in Google Drive.
-- One row per supplier folder: the SOA file read and its invoices (JSON) – summaries are worked out
-- on the page (unpaid, overdue, next due, last paid) so they move with the date.
CREATE TABLE inv_soa (
  folder_id     text PRIMARY KEY,
  supplier      text NOT NULL,
  consignment   boolean NOT NULL DEFAULT false,
  file_id       text,
  file_name     text,
  file_modified text,
  invoices      text NOT NULL DEFAULT '[]',
  checked_at    text,
  error         text
);
