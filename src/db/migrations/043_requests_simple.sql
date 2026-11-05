-- 5 Nov: change requests are simpler – asked → Dr Aisyah approves → Mr 4DX builds it → Live.
-- The plan / preview / "looks right" steps are gone, so requests waiting in them go back to New
-- for the CEO to approve.
UPDATE change_requests SET status = 'New', updated_at = now()
 WHERE status IN ('Planned', 'Ready to check', 'Waiting for approval');
