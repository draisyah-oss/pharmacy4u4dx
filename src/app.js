// The Express app: login, daily entry, and a setup status page for admin.

const path = require('path');
const express = require('express');
const { loadUser, requireLogin, checkCsrf } = require('./auth/sessions');
const { loginRoutes } = require('./auth/routes');
const { dailyRoutes } = require('./daily/routes');
const { scoreboardRoutes } = require('./scoreboard/routes');
const { adminRoutes } = require('./admin/routes');
const { weeklyRoutes } = require('./weekly/routes');
const { groupRoutes } = require('./group/routes');
const { hqRoutes } = require('./hq/routes');
const { hqTeamRoutes } = require('./hq/team-routes');
const { salesRoutes } = require('./sales/routes');
const { oosRoutes } = require('./oos/routes');
const { inventoryRoutes } = require('./inventory/routes');
const { wigRoutes } = require('./wig/routes');
const { requestRoutes, agentApi } = require('./requests/routes');
const { policyRoutes } = require('./policies/routes');
const { reviewRoutes } = require('./review/routes');
const { monthRoutes } = require('./month/routes');
const { branchMeasureRoutes } = require('./branchmeasures/routes');
const { buildNeeds } = require('./lib/needs');
const oosData = require('./oos/data');
const calc = require('./calc');
const fmt = require('./scoreboard/format');
const { companySalesForWeek } = require('./group/company');

// options.now lets tests pretend it's a particular day.
function createApp(db, { now = () => new Date(), salesSheet = null } = {}) {
  const app = express();
  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, 'views'));
  app.set('trust proxy', 1); // Railway sits in front of the app
  app.disable('x-powered-by');

  app.use(express.static(path.join(__dirname, '..', 'public'), { maxAge: '1h' }));
  // 27 Oct: out-of-stock forms can carry a photo (shrunk on the phone, sent as a data URL).
  app.use('/oos/products', express.urlencoded({ extended: true, limit: '15mb' })); // 3 Nov: Dynamod masterlist upload
  app.use('/oos', express.urlencoded({ extended: true, limit: '3mb' }));
  app.use(express.urlencoded({ extended: true, limit: '100kb' }));
  app.use((req, res, next) => {
    res.setHeader('X-Frame-Options', 'DENY');
    // Only our own scripts; styles may be inline (progress bars); fonts from Google.
    res.setHeader('Content-Security-Policy', [
      "default-src 'self'", "script-src 'self'", "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
      "font-src 'self' https://fonts.gstatic.com", "img-src 'self' data:", "connect-src 'self'",
      "form-action 'self'", "frame-ancestors 'none'", "base-uri 'none'", "object-src 'none'",
    ].join('; '));
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    if (req.secure) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
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
      console.error('Health check failed:', err.message);
      res.status(500).json({ ok: false }); // no details for the outside world
    }
  });

  // 28 Oct: Mr 4DX's API (token in AGENT_API_TOKEN) – before the session / CSRF checks.
  app.use('/api/agent', agentApi(db, { now }));

  app.use(loadUser(db));
  app.use((req, res, next) => (req.method === 'POST' ? checkCsrf(req, res, next) : next()));
  app.use(loginRoutes(db));

  app.use(requireLogin);

  // The inventory team (app_settings inventory_team: Alia, Syarafana, Fariz) sees the Inventory
  // menu – out-of-stock inbox and transfers – plus its red count badge.
  app.use(async (req, res, next) => {
    try {
      if (req.user.person_id && ['hq', 'hq_staff'].includes(req.user.role)) {
        const r = (await db.query(
          `SELECT p.name, s.value, q.value AS quiet, t.value AS pay FROM people p LEFT JOIN app_settings s ON s.key = 'inventory_team'
           LEFT JOIN app_settings q ON q.key = 'oos_needs_off' LEFT JOIN app_settings t ON t.key = 'payments_team' WHERE p.id = $1`, [req.user.person_id])).rows[0];
        const list = (v) => { try { return JSON.parse(v || '[]'); } catch { return []; } };
        req.user.inventory = Boolean(r && list(r.value).includes(r.name));
        // 22 Oct: Alia sees and answers out-of-stock items from the Inventory menu, but they don't go
        // in her "Needs you" list (app_settings oos_needs_off = seed hq.oos_needs_off).
        req.user.oosQuiet = Boolean(r && list(r.quiet).includes(r.name));
        // 3 Nov: the payments team (app_settings payments_team, default Azwani) marks supplier payments paid on /inventory.
        req.user.payments = Boolean(r && list(r.pay || '["Azwani"]').includes(r.name));
      }
    } catch (err) { console.error('Inventory team:', err.message); }
    // "Needs you" list at the top of the side menu (src/lib/needs.js).
    try {
      if (req.method === 'GET') res.locals.needs = await buildNeeds(db, req.user, { at: now() });
    } catch (err) { console.error('Needs you:', err.message); }
    // Side menu (19 Oct): milestones with a step checklist, as sub-items under Projects.
    try {
      if (req.method === 'GET' && ['admin', 'hq', 'hq_staff'].includes(req.user.role)) {
        res.locals.stepMenu = await require('./hq/team').stepMenu(db, req.user);
      }
    } catch (err) { console.error('Menu steps:', err.message); }
    try {
      if (req.method === 'GET' && oosData.canAnswer(req.user)) {
        res.locals.oosCount = await oosData.countToAnswer(db);
      }
    } catch (err) { console.error('Menu counts:', err.message); }
    next();
  });

  // Home (3 Nov, CEO): the first page for everyone is the highlights (src/home/highlights.js) – then
  // branch staff and managers get their own week, HQ staff quick links, HQ / admin the branches.
  app.get('/', async (req, res, next) => {
    try {
      const hlMod = require('./home/highlights');
      const hl = await hlMod.buildHighlights(db, { user: req.user, now, trackerStart: await trackerStart() });
      const { greeting } = require('./home/mypage');
      if ((req.user.role === 'branch_staff' || req.user.role === 'branch_manager') && req.user.branch_code) {
        const { loadBranch } = require('./daily/data');
        const branch = await loadBranch(db, req.user.branch_code);
        const page = await require('./home/mypage').buildMyPage(db, { user: req.user, branch, now, trackerStart: await trackerStart() });
        return res.render('my-home', { title: 'Highlights', ...page, hl, fmt, navActive: 'home', ok: req.query.ok || null, err: req.query.err || null });
      }
      const person = req.user.person_id ? (await db.query('SELECT name FROM people WHERE id = $1', [req.user.person_id])).rows[0] : null;
      const hi = { greeting: greeting(now()), name: person ? person.name : (req.user.is_super ? 'Dr Aisyah' : req.user.display_name) };
      if (req.user.role === 'hq_staff') return res.render('highlights', { title: 'Highlights', hl, hi, fmt, navActive: 'home', ok: req.query.ok || null, err: req.query.err || null });
      const today = calc.todayInMalaysia(now());
      const branches = (await db.query(
        `SELECT b.code, b.name,
           (SELECT count(*)::int FROM daily_entries e WHERE e.branch_id = b.id AND e.entry_date = $1) AS today_entries,
           (SELECT count(*)::int FROM daily_fields f WHERE f.branch_id = b.id AND f.active) AS fields
         FROM branches b WHERE b.active ORDER BY b.sort_order`, [today])).rows;
      const company = hl.wins.company;
      res.render('home', { title: 'Highlights', branches, today, company, fmt, hl, hi, ok: req.query.ok || null, err: req.query.err || null });
    } catch (err) { next(err); }
  });

  app.post('/news', async (req, res, next) => {
    try {
      const h = require('./home/highlights');
      const r = await h.postNews(db, req.user, req.body, { now });
      res.redirect(`/?${r.error ? 'err' : 'ok'}=${encodeURIComponent(r.error || r.ok)}#hl-news`);
    } catch (err) { next(err); }
  });
  app.post('/news/:id/remove', async (req, res, next) => {
    try {
      const r = await require('./home/highlights').removeNews(db, req.user, Number(req.params.id) || 0, { now });
      res.redirect(`/?${r.error ? 'err' : 'ok'}=${encodeURIComponent(r.error || r.ok)}#hl-news`);
    } catch (err) { next(err); }
  });
  app.post('/goals/:id/progress', async (req, res, next) => {
    try {
      const h = require('./home/highlights');
      const r = await h.saveGoalStatus(db, req.user, { id: Number(req.params.id) || 0, status: req.body.gp_status ?? req.body.status, progress: req.body.gp_progress ?? req.body.progress, now });
      h.clearCache();
      res.redirect(`/review/conclusion?month=${encodeURIComponent(req.body.month || '')}&${r.error ? 'err' : 'ok'}=${encodeURIComponent(r.error || r.ok)}`);
    } catch (err) { next(err); }
  });
  app.use(dailyRoutes(db, { now, trackerStart, salesSheet }));
  app.use(scoreboardRoutes(db, { now, trackerStart }));
  app.use(weeklyRoutes(db, { now, trackerStart }));
  app.use(groupRoutes(db, { now, trackerStart }));
  app.use(hqRoutes(db, { now, trackerStart }));
  app.use(hqTeamRoutes(db, { now, trackerStart }));
  app.use(salesRoutes(db, { now, salesSheet }));
  app.use(oosRoutes(db, { now, trackerStart }));
  app.use(inventoryRoutes(db, { now }));
  app.use(wigRoutes(db, { now, trackerStart }));
  app.use(requestRoutes(db, { now }));
  app.use(policyRoutes());
  app.use(reviewRoutes(db, { now, trackerStart }));
  app.use(monthRoutes(db, { now, trackerStart }));
  app.use(branchMeasureRoutes(db, { now }));
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
