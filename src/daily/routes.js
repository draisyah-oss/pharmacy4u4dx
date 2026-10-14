// Daily Entry screen: GET shows a branch's day, POST saves it.

const express = require('express');
const calc = require('../calc');
const { canViewBranch, editBlockReason, dateStrip } = require('./rules');
const { loadBranch, loadDailyPage, saveDailyEntries } = require('./data');

const ISO = /^\d{4}-\d{2}-\d{2}$/;

const { sheetFieldsFor } = require('../sheets/sync');

function dailyRoutes(db, { now, trackerStart, salesSheet }) {
  const router = express.Router();

  // Which branch: staff and managers always their own; HQ/admin pick one (?branch=WM).
  async function resolve(req) {
    const user = req.user;
    const code = user.role === 'admin' || user.role === 'hq' ? (req.query.branch || req.body?.branch) : user.branch_code;
    const branch = code ? await loadBranch(db, code) : null;
    const today = calc.todayInMalaysia(now());
    const start = await trackerStart();
    let date = req.query.date || req.body?.date || today;
    if (!ISO.test(date)) date = today;
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

    res.status(extra.status || 200).render('daily', {
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
    const back = typeof req.body.back === 'string' && /^\/(?!\/)/.test(req.body.back) ? req.body.back : '/';
    const sep = back.includes('?') ? '&' : '?';
    try {
      if (!salesSheet || !(await salesSheet.enabled())) return res.redirect(`${back}${sep}synced=off`);
      const r = await salesSheet.syncNow();
      res.redirect(`${back}${sep}synced=${r.changed + r.removed}`);
    } catch (err) {
      res.redirect(`${back}${sep}synced=error`);
    }
  });

  return router;
}

module.exports = { dailyRoutes };
