// The Express app: login, daily entry, and a setup status page for admin.

const path = require('path');
const express = require('express');
const { loadUser, requireLogin, checkCsrf } = require('./auth/sessions');
const { loginRoutes } = require('./auth/routes');
const { dailyRoutes } = require('./daily/routes');
const { scoreboardRoutes } = require('./scoreboard/routes');
const { adminRoutes } = require('./admin/routes');
const calc = require('./calc');

// options.now lets tests pretend it's a particular day.
function createApp(db, { now = () => new Date(), salesSheet = null } = {}) {
  const app = express();
  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, 'views'));
  app.set('trust proxy', 1); // Railway sits in front of the app
  app.disable('x-powered-by');

  app.use(express.static(path.join(__dirname, '..', 'public'), { maxAge: '1h' }));
  app.use(express.urlencoded({ extended: true, limit: '100kb' }));
  app.use((req, res, next) => {
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.locals.fmtDate = fmtDate;
    next();
  });

  let startCache;
  const trackerStart = async () => {
    if (!startCache) {
      const { rows } = await db.query("SELECT value FROM app_settings WHERE key = 'tracker_start_date'");
      startCache = rows[0]?.value || '2026-10-12';
    }
    return startCache;
  };

  app.get('/health', async (req, res) => {
    try {
      await db.query('SELECT 1');
      res.json({ ok: true, database: db.kind });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  app.use(loadUser(db));
  app.use((req, res, next) => (req.method === 'POST' ? checkCsrf(req, res, next) : next()));
  app.use(loginRoutes(db));

  app.use(requireLogin);

  // Home: staff and managers go straight to their branch; HQ and admin pick a branch.
  app.get('/', async (req, res, next) => {
    try {
      if (req.user.role === 'branch_staff' || req.user.role === 'branch_manager') return res.redirect('/daily');
      const today = calc.todayInMalaysia(now());
      const branches = (await db.query(
        `SELECT b.code, b.name,
           (SELECT count(*)::int FROM daily_entries e WHERE e.branch_id = b.id AND e.entry_date = $1) AS today_entries,
           (SELECT count(*)::int FROM daily_fields f WHERE f.branch_id = b.id AND f.active) AS fields
         FROM branches b WHERE b.active ORDER BY b.sort_order`, [today])).rows;
      res.render('home', { title: 'Branches', branches, today });
    } catch (err) { next(err); }
  });

  app.use(dailyRoutes(db, { now, trackerStart, salesSheet }));
  app.use(scoreboardRoutes(db, { now, trackerStart }));
  app.use(adminRoutes(db, { now, salesSheet }));

  // Setup status page (admin).
  app.get('/status', async (req, res, next) => {
    if (req.user.role !== 'admin') return res.status(403).render('message', { title: 'Admin only', message: 'This page is for admin.' });
    try {
      const settings = Object.fromEntries((await db.query('SELECT key, value FROM app_settings')).rows.map((r) => [r.key, r.value]));
      const branches = (await db.query(`
        SELECT b.code, b.name, b.wig, b.zakat_field IS NOT NULL AS has_zakat,
          (SELECT count(*)::int FROM people p WHERE p.branch_id = b.id AND p.active) AS people,
          (SELECT string_agg(p.name, ', ' ORDER BY p.sort_order) FROM people p WHERE p.branch_id = b.id AND p.active) AS names,
          (SELECT count(*)::int FROM daily_fields f WHERE f.branch_id = b.id AND f.active) AS fields,
          (SELECT count(*)::int FROM measures m WHERE m.branch_id = b.id AND m.active) AS measures,
          (SELECT count(*)::int FROM daily_entries e WHERE e.branch_id = b.id) AS entries
        FROM branches b WHERE b.active ORDER BY b.sort_order`)).rows;
      const totals = (await db.query(`
        SELECT (SELECT count(*)::int FROM hq_measures WHERE active) AS hq_measures,
               (SELECT count(*)::int FROM users WHERE active) AS users,
               (SELECT count(*)::int FROM users WHERE active AND (password_hash IS NOT NULL OR pin_hash IS NOT NULL)) AS users_ready`)).rows[0];
      const sheet = salesSheet ? await salesSheet.status() : null;
      res.render('status', { title: 'Setup', settings, branches, totals, dbKind: db.kind, sheet });
    } catch (err) { next(err); }
  });

  app.use((req, res) => res.status(404).render('message', { title: 'Page not found', message: 'That page doesn’t exist.' }));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    console.error(err);
    res.status(500).render('message', { title: 'Something went wrong', message: 'The server hit an error. Your last save may not have gone through – check the numbers and try again.' });
  });

  return app;
}

// "Wed 14 Oct"
function fmtDate(iso, opts = {}) {
  const d = new Date(`${iso}T00:00:00Z`);
  return d.toLocaleDateString('en-GB', { timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short', ...opts });
}

module.exports = { createApp };
