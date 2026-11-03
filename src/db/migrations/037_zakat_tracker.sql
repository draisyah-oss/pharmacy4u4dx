-- 3 Nov 2026 (CEO): Zakat claims tracker for BR, WM and JH – replaces the old zakat lead measures
-- (orders within 2 weeks / claims within 7 days). Weekly numbers (claimed, payment received, contracts
-- bid on / won) are kept as daily_entries on the week's Monday (fields zclaim, zpaid, zbid, zwon, hidden
-- from Daily entry) and the month's "amount to claim" is measure ZC1's target – so every number on the
-- scoreboard traces back. Only the suppliers holding up supply need their own table.
CREATE TABLE zakat_suppliers (
  branch_id  integer NOT NULL REFERENCES branches(id),
  slot       integer NOT NULL CHECK (slot BETWEEN 1 AND 10),
  name       text NOT NULL DEFAULT '',
  contracts  integer NOT NULL DEFAULT 0 CHECK (contracts >= 0),
  updated_by integer REFERENCES users(id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (branch_id, slot)
);
