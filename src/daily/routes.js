// Daily Entry screen: GET shows a branch's day, POST saves it.

const express = require('express');
const oosData = require('../oos/data');
const oosFormat = require('../oos/format');
const calc = require('../calc');
const { canViewBranch, editBlockReason, dateStrip } = require('./rules');
const { loadBranch, loadDailyPage, saveDailyEntries } = require('./data');
const tally = require('./tally');
const { buildScoreboard } = require('../scoreboard/data');
const { scoreboardAccess } = require('../scoreboard/routes');
const fmt = require('../scoreboard/format');

const { sheetFieldsFor } = require('../sheets/sync');
const { safePath } = require('../lib/safe-path');
const { isRealDate } = require('../lib/dates');
const weekSheet = require('./week');
const { weekChoices } = require('../lib/weeks');

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
    // 28 Oct (JH first): "my boxes" – staff see their own boxes + Team by default, Everyone on request.
    const sheetView = await weekSheet.sheetViewOn(db, branch.code);
    const show = !sheetView ? 'all' : (['mine', 'all'].includes(req.query.show || req.body?.show) ? (req.query.show || req.body.show) : (req.user.role === 'branch_staff' ? 'mine' : 'all'));
    let hiddenBoxes = 0;
    if (show === 'mine') {
      const keep = page.cards.filter((c) => c.id === 'team' || c.isMe);
      hiddenBoxes = page.cards.filter((c) => !keep.includes(c)).reduce((a, c) => a + c.fields.length, 0);
      page.cards = keep;
    }

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
    // My week: the logged-in person's commitment this week (staff and managers).
    let myCommit = null;
    if (['branch_staff', 'branch_manager'].includes(req.user.role) && req.user.person_id && req.user.branch_id === branch.id) {
      myCommit = (await db.query('SELECT commitment, result FROM commitments WHERE branch_id = $1 AND week_start = $2 AND person_id = $3',
        [branch.id, calc.weekStart(today), req.user.person_id])).rows[0] || { none: true };
    }
    const tallyButtons = await tally.tallyOn(db, branch.code);
    res.status(extra.status || 200).render('daily', {
      myCommit, sheetView, show, hiddenBoxes, tallyButtons,
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
      const result = await saveDailyEntries(db, { branch: ctx.branch, date: ctx.date, user: req.user, input, sheetFields, keepMissing: true });
      if (Object.keys(result.errors).length) {
        return render(req, res, ctx, { status: 422, errors: result.errors, typed: input });
      }
      const qs = new URLSearchParams({ date: ctx.date, saved: String(result.changes) });
      if (['mine', 'all'].includes(req.body.show)) qs.set('show', req.body.show);
      if (req.user.role === 'admin') qs.set('branch', ctx.branch.code);
      res.redirect(`/daily?${qs}`);
    } catch (err) { next(err); }
  });

  // ─────────────── 28 Oct: week sheet view (JH first) ───────────────
  // 29 Oct: "+1" / "−1" buttons (tally branches, BR first): each tap saved at once. The page's script
  // sends it in the background and gets JSON back; without JavaScript the button posts the form here
  // and comes back to the same box.
  router.post('/daily/tally', async (req, res, next) => {
    try {
      const ctx = await resolve(req);
      const json = (req.get('accept') || '').includes('application/json');
      const fail = (status, message) => (json ? res.status(status).json({ error: message }) : res.status(status).render('message', { title: 'Can’t count', message }));
      if (!ctx.branch) return fail(404, 'No branch.');
      if (!(await tally.tallyOn(db, ctx.branch.code))) return fail(404, '+1 buttons aren’t switched on for this branch.');
      const blocked = editBlockReason(req.user, ctx.branch.id, ctx.date, { today: ctx.today, trackerStart: ctx.start });
      if (blocked) return fail(403, blocked);
      const sheetFields = await sheetFieldsFor(db, ctx.branch.id, salesSheet);
      const r = await tally.addTally(db, { branch: ctx.branch, date: ctx.date, user: req.user, tap: tally.parseTap(req.body.tally), sheetFields });
      if (r.error) return fail(400, r.error);
      if (json) return res.json({ key: r.key, value: r.value });
      const qs = new URLSearchParams({ date: ctx.date });
      if (['mine', 'all'].includes(req.body.show)) qs.set('show', req.body.show);
      if (req.user.role === 'admin' || req.user.role === 'hq') qs.set('branch', ctx.branch.code);
      res.redirect(`/daily?${qs}#f_${r.key}`);
    } catch (err) { next(err); }
  });

  async function weekCtx(req) {
    const ctx = await resolve(req);
    if (!ctx.branch) return ctx;
    const weeks = weekChoices(ctx.start, ctx.today);
    const asked = req.query.week || req.body?.week;
    ctx.week = weeks.includes(asked) ? asked : calc.weekStart(ctx.today);
    ctx.weeks = weeks;
    const role = req.user.role;
    ctx.show = ['mine', 'all'].includes(req.query.show || req.body?.show) ? (req.query.show || req.body.show) : (role === 'branch_staff' ? 'mine' : 'all');
    return ctx;
  }

  async function renderWeek(req, res, ctx, extra = {}) {
    const sheetFields = await sheetFieldsFor(db, ctx.branch.id, salesSheet);
    const grid = await weekSheet.loadWeekGrid(db, {
      branch: ctx.branch, week: ctx.week, user: req.user, today: ctx.today, trackerStart: ctx.start, sheetFields, show: ctx.show, typed: extra.typed || null,
    });
    const many = req.user.role === 'admin' || req.user.role === 'hq';
    const bq = many ? `&branch=${encodeURIComponent(ctx.branch.code)}` : '';
    res.status(extra.status || 200).render('daily-week', {
      title: `${ctx.branch.name} – week sheet`, branch: ctx.branch, ...grid, week: ctx.week, weekEnd: calc.addDays(ctx.week, 6), today: ctx.today,
      show: ctx.show, bq, many, fmt, errors: extra.errors || {}, err: extra.err || null,
      saved: req.query.saved !== undefined ? Number(req.query.saved) : null,
      pills: ctx.weeks.slice(-4).map((w) => ({ week: w, current: w === ctx.week, label: w === calc.weekStart(ctx.today) ? 'This week' : fmt.weekLabel(w, calc.addDays(w, 6)) })),
      oneDayHref: `/daily?date=${ctx.week <= ctx.today && calc.addDays(ctx.week, 6) >= ctx.today ? ctx.today : calc.addDays(ctx.week, 6)}${bq}`,
    });
  }

  router.get('/daily/week', async (req, res, next) => {
    try {
      const ctx = await weekCtx(req);
      if (!ctx.branch) return res.redirect('/');
      if (!canViewBranch(req.user, ctx.branch.id)) return res.status(403).render('message', { title: 'Not your branch', message: 'You can only open your own branch.' });
      if (!(await weekSheet.sheetViewOn(db, ctx.branch.code))) return res.redirect(`/daily${req.user.role === 'admin' || req.user.role === 'hq' ? `?branch=${encodeURIComponent(ctx.branch.code)}` : ''}`);
      await renderWeek(req, res, ctx);
    } catch (err) { next(err); }
  });

  router.post('/daily/week', async (req, res, next) => {
    try {
      const ctx = await weekCtx(req);
      if (!ctx.branch) return res.redirect('/');
      if (!canViewBranch(req.user, ctx.branch.id)) return res.status(403).render('message', { title: 'Not your branch', message: 'You can only open your own branch.' });
      if (!(await weekSheet.sheetViewOn(db, ctx.branch.code))) return res.status(403).render('message', { title: 'Not yet', message: 'The week sheet is being tried at JH first.' });
      if (req.body.week !== ctx.week) return res.status(400).render('message', { title: 'Can’t save', message: 'That week can’t be changed here.' });
      const sheetFields = await sheetFieldsFor(db, ctx.branch.id, salesSheet);
      const r = await weekSheet.saveWeek(db, { branch: ctx.branch, week: ctx.week, user: req.user, today: ctx.today, trackerStart: ctx.start, sheetFields, body: req.body });
      const bad = Object.keys(r.errors).length;
      if (bad) {
        return renderWeek(req, res, ctx, { status: 422, errors: r.errors, typed: r.typed,
          err: `${r.changes ? `${r.changes} numbers saved. ` : ''}${bad === 1 ? '1 day has' : `${bad} days have`} a number to fix – see the red cells. Those days weren’t saved.` });
      }
      const qs = new URLSearchParams({ week: ctx.week, saved: String(r.changes), show: ctx.show });
      if (req.user.role === 'admin' || req.user.role === 'hq') qs.set('branch', ctx.branch.code);
      res.redirect(`/daily/week?${qs}`);
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
