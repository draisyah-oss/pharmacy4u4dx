-- 002_login.sql – lock a login for a while after repeated wrong PINs/passwords.
ALTER TABLE users ADD COLUMN failed_attempts integer NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN locked_until timestamptz;
