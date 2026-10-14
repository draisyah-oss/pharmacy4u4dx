// The Express app. For now: a status page showing what was loaded, and /health for Railway.
// The real screens (login, daily entry, scoreboards…) get added as routes here.

const path = require('path');
const express = require('express');

function createApp(db) {
  const app = express();
  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, 'views'));
  app.use(express.static(path.join(__dirname, '..', 'public')));

  app.get('/health', async (req, res) => {
    try {
      await db.query('SELECT 1');
      res.json({ ok: true, database: db.kind });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  app.get('/', async (req, res, next) => {
    try {
      const settings = Object.fromEntries(
        (await db.query('SELECT key, value FROM app_settings')).rows.map((r) => [r.key, r.value])
      );
      const branches = (
        await db.query(`
          SELECT b.code, b.name, b.wig, b.zakat_field IS NOT NULL AS has_zakat,
            (SELECT count(*)::int FROM people p WHERE p.branch_id = b.id AND p.active) AS people,
            (SELECT string_agg(p.name, ', ' ORDER BY p.sort_order) FROM people p WHERE p.branch_id = b.id AND p.active) AS names,
            (SELECT count(*)::int FROM daily_fields f WHERE f.branch_id = b.id AND f.active) AS fields,
            (SELECT count(*)::int FROM measures m WHERE m.branch_id = b.id AND m.active) AS measures,
            (SELECT count(*)::int FROM daily_entries e WHERE e.branch_id = b.id) AS entries
          FROM branches b WHERE b.active ORDER BY b.sort_order`)
      ).rows;
      const totals = (
        await db.query(`
          SELECT (SELECT count(*)::int FROM hq_measures WHERE active) AS hq_measures,
                 (SELECT count(*)::int FROM users WHERE active) AS users,
                 (SELECT count(*)::int FROM users WHERE active AND (password_hash IS NOT NULL OR pin_hash IS NOT NULL)) AS users_ready`)
      ).rows[0];
      res.render('status', { settings, branches, totals, dbKind: db.kind });
    } catch (err) {
      next(err);
    }
  });

  return app;
}

module.exports = { createApp };
