-- 019 – super admin (19 Oct): Dr Aisyah's admin login is the super admin (everything, incl. admin
-- logins and approving HQ focuses). Iman and Hanin get their own extra admin logins (iman.admin,
-- hanin.admin) to check and fix things for everyone; they keep their own logins for their KPIs.
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_super boolean NOT NULL DEFAULT false;
UPDATE users SET is_super = true WHERE role = 'admin';
