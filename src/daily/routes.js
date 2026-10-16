// Daily Entry screen: GET shows a branch's day, POST saves it.

const express = require('express');
const oosData = require('../oos/data');
const oosFormat = require('../oos/format');
const calc = require('../calc');
const { canViewBranch, editBlockReason, dateStrip } = require('./rules');
const { loadBranch, loadDailyPage, saveDailyEntries } = require('./data');
const { buildScoreboard } = require('../scoreboard/data');
const { scoreboardAccess } = require('../scoreboard/routes');
const fmt = require('../scoreboard/format');

const { sheetFieldsFor } = require('../sheets/sync');
const { safePath } = require('../lib/safe-path');
const { isRealDate } = require('../lib/dates');

function dailyRoutes(db, { now, trackerStart, salesSheet }) {
  const router = express.Router();
  let lastManualSync = 0;

  // Which branch: staff and managers always their own; HQ/admin pick one (?branch=WM).
  async function resolve(req) {
    const user = req.user;
    const code = user.role === 'admin' || user.role === 'hq' ? (req.query.branch || req.body?.branch) : user.branch_code;
    const branch = code ? await loadBranch(db, code) : null;
    const today = calc.todayInMalaysia(now());
    const start = await trackerStart();
    let date = req.query.date || req.body?.date || today;
    if (!isRealDate(date)) date = today; // e.g. 2026-02-31 → today, never an error
    return { branch, today, start, date };
  }

  async function render(req, res, ctx, extra = {}) {
    const { branch, today, start, date } = ctx;
    const sheetFields = await sheetFieldsFor(db, branch.id, salesSheet);
    const page = await loadDailyPage(db, { branch, date, user: req.user, trackerStart: start, sheetFields });
    const sheet = sheetFields.size ? await salesSheet.status() : null;
    const blocked = editBlockReason(req.user, branch.id, date, { today, trackerStart: start });

    // After a failed save, show what was typed rather than what's stored.
    if (extra.typed) {
      for (const card of page.cards) {
        for (const f of card.fields) {
          if (f.fromSheet) continue;
          const t = extra.typed[f.key];
          f.value = t === undefined || t === '' ? null : t;
        }
      }
    }

    // The branch's month sales at the top, so everyone sees how the month is going.
    const board = await buildScoreboard(db, { branch, weekStart: calc.weekStart(today), today, trackerStart: start });
    const salesHref = board.started && !scoreboardAccess(req.user, branch)
      ? `/scoreboard/trace?type=sales&from=${board.mtdFrom}&to=${board.asOf}${req.user.role === 'admin' || req.user.role === 'hq' ? `&branch=${encodeURIComponent(branch.code)}` : ''}`
      : null;
    // The branch's open out-of-stock items, with Inventory's answers, plus the Report button.
    const oosItems = (await oosData.loadBranchItems(db, branch, { now })).filter((it) => it.isOpen);
    res.status(extra.status || 200).render('daily', {
      oosItems, of: oosFormat, oosLink: `/oos${req.user.role === 'admin' || req.user.role === 'hq' ? `?branch=${encodeURIComponent(branch.code)}` : ''}`,
      oosCanReport: oosData.canReport(req.user, branch),
      monthSales: { s: board.sales, started: board.started, asOf: board.asOf, href: salesHref }, fmt,
      title: `${branch.name} – daily entry`,
      branch, date, today, ...page,
      strip: dateStrip(today, start).map((d) => ({ date: d, filled: page.filledDates.has(d) })),
      blocked, sheet,
      synced: req.query.synced !== undefined ? req.query.synced : null,
      errors: extra.errors || {},
      saved: req.query.saved !== undefined ? Number(req.query.saved) : null,
    });
  }

  router.get('/daily', async (req, res, next) => {
    try {
      const ctx = await resolve(req);
      if (!ctx.branch) return res.redirect('/');
      if (!canViewBranch(req.user, ctx.branch.id)) return res.status(403).render('message', { title: 'Not your branch', message: 'You can only open your own branch.' });
      await render(req, res, ctx);
    } catch (err) { next(err); }
  });

  router.post('/daily', async (req, res, next) => {
    try {
      const ctx = await resolve(req);
      if (!ctx.branch) return res.redirect('/');
      const blocked = editBlockReason(req.user, ctx.branch.id, ctx.date, { today: ctx.today, trackerStart: ctx.start });
      if (blocked) return res.status(403).render('message', { title: 'Can’t save', message: blocked });

      const input = req.body.f || {};
      const sheetFields = await sheetFieldsFor(db, ctx.branch.id, salesSheet);
      const result = await saveDailyEntries(db, { branch: ctx.branch, date: ctx.date, user: req.user, input, sheetFields });
      if (Object.keys(result.errors).length) {
        return render(req, res, ctx, { status: 422, errors: result.errors, typed: input });
      }
      const qs = new URLSearchParams({ date: ctx.date, saved: String(result.changes) });
      if (req.user.role === 'admin') qs.set('branch', ctx.branch.code);
      res.redirect(`/daily?${qs}`);
    } catch (err) { next(err); }
  });

  // "Sync now" for the sales sheet. Goes back to the page it came from.
  router.post('/sales-sheet/sync', async (req, res, next) => {
    const back = safePath(req.body.back, '/');
    const sep = back.includes('?') ? '&' : '?';
    try {
      if (!salesSheet || !(await salesSheet.enabled())) return res.redirect(`${back}${sep}synced=off`);
      // Once a minute is plenty – the sheet is checked every 10 minutes anyway.
      if (Date.now() - lastManualSync < 60 * 1000) return res.redirect(`${back}${sep}synced=0`);
      lastManualSync = Date.now();
      const r = await salesSheet.syncNow();
      res.redirect(`${back}${sep}synced=${r.changed + r.removed}`);
    } catch (err) {
      res.redirect(`${back}${sep}synced=error`);
    }
  });

  return router;
}

module.exports = { dailyRoutes };
