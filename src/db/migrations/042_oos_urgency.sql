-- 5 Nov 2026 (change request #3, approved by the CEO): three levels of urgency on an out-of-stock
-- report – Urgent (chronic patient waiting), Soon (within a few days), Routine. oos_items.urgent stays
-- (= urgency 'urgent') so everything that sorts / counts urgent items keeps working.
ALTER TABLE oos_items ADD COLUMN IF NOT EXISTS urgency text NOT NULL DEFAULT 'routine' CHECK (urgency IN ('urgent', 'soon', 'routine'));
UPDATE oos_items SET urgency = 'urgent' WHERE urgent;
