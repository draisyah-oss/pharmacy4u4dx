-- 4 Nov 2026 (CEO pays suppliers through Swipey): how a supplier payment was made. pv_no stays as the
-- payment reference – the Swipey transaction ID (or the PV number when accounts issue one).
ALTER TABLE inv_payments ADD COLUMN paid_via text CHECK (paid_via IN ('Swipey', 'Bank transfer', 'Cheque', 'Cash'));
