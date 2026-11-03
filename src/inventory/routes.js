// Inventory page (3 Nov, CEO): /inventory – the ordering & payment board for HQ (Dr Aisyah, Alia,
// Azwani). Read only: nothing here orders or pays. Data from Google Drive (source.js), rules in
// board.js, the month's fixed plan in plans.js.

const express = require('express');
const calc = require('../calc');
const board = require('./board');
const { planFor } = require('./plans');
const { cashChartSvg } = require('./chart');

const list = (v) => { try { const x = JSON.parse(v || '{}'); return x && typeof x === 'object' ? x : {}; } catch { return {}; } };

// admin always; HQ people named in app_settings inventory_board.viewers.
function canSeeBoard(user, personName, settingValue) {
  if (!user) return false;
  if (user.role === 'admin') return true;
  if (!['hq', 'hq_staff'].includes(user.role) || !personName) return false;
  const viewers = Array.isArray(list(settingValue).viewers) ? list(settingValue).viewers : [];
  return viewers.includes(personName);
}

async function loadSettings(db) {
  const r = (await db.query("SELECT value FROM app_settings WHERE key = 'inventory_board'")).rows[0];
  return list(r && r.value);
}

// "Tue 3 Nov, 7:56 am" in Malaysia time.
function myTime(d) {
  if (!d) return '';
  const t = new Date(d);
  if (Number.isNaN(t.getTime())) return '';
  return t.toLocaleString('en-GB', { timeZone: 'Asia/Kuala_Lumpur', weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', hour12: true })
    .replace(',', '').replace(/\s?(am|pm)$/i, (m) => ` ${m.trim().toLowerCase()}`);
}

function inventoryRoutes(db, { now, source = null }) {
  const router = express.Router();
  const denied = (res) => res.status(403).render('message', { title: 'Inventory', message: 'The Inventory page is for Dr Aisyah, Alia and Azwani.' });

  router.get('/inventory', async (req, res, next) => {
    try {
      if (!(req.user.role === 'admin' || req.user.inventoryBoard)) return denied(res);
      const today = calc.todayInMalaysia(now());
      const plan = planFor(today.slice(0, 7));
      const view = Object.prototype.hasOwnProperty.call(board.VIEWS, req.query.show) ? req.query.show : 'all';
      const q = typeof req.query.q === 'string' ? req.query.q.slice(0, 80) : '';
      const settings = await loadSettings(db);
      let data = null; let error = null; let loaded = null;
      if (!source || !source.configured()) {
        error = 'not_configured';
      } else {
        try {
          loaded = await source.load(settings);
          data = board.buildBoard({ planCsv: loaded.planCsv, paymentsCsv: loaded.paymentsCsv, plan, today });
        } catch (err) {
          console.error('Inventory page:', err.message);
          error = err.message;
        }
      }
      res.render('inventory', {
        title: 'Inventory – ordering & payments', today, plan, data, error, view, q,
        rows: data ? board.filterLines(data.lines, view, q) : [],
        cash: board.cashWeeks(plan), chart: cashChartSvg(board.cashWeeks(plan)),
        views: board.VIEWS, PAY_STATES: board.PAY_STATES,
        planFile: loaded ? { ...loaded.planFile, when: myTime(loaded.planFile.modifiedTime) } : null,
        fetchedAt: loaded ? myTime(loaded.fetchedAt) : '',
        sourceStatus: source ? source.status() : { configured: false, email: null },
        isAdmin: req.user.role === 'admin',
        ok: req.query.ok || null,
      });
    } catch (err) { next(err); }
  });

  // "Check Drive now": skip the 5-minute wait (the source still waits 20 seconds between checks).
  router.post('/inventory/refresh', async (req, res, next) => {
    try {
      if (!(req.user.role === 'admin' || req.user.inventoryBoard)) return denied(res);
      if (source && source.configured()) {
        try { await source.load(await loadSettings(db), { force: true }); } catch (err) { console.error('Inventory refresh:', err.message); }
      }
      res.redirect('/inventory?ok=refreshed');
    } catch (err) { next(err); }
  });

  return router;
}

module.exports = { inventoryRoutes, canSeeBoard };
