// Weekly check-in (+ OOS list) and Commitments.

const express = require('express');
const calc = require('../calc');
const fmt = require('../scoreboard/format');
const { loadBranch } = require('../daily/data');
const { weekChoices, lastFinishedWeek, pickWeek } = require('../lib/weeks');
const { viewDenied, editDenied, canAnswerOos } = require('./access');
const data = require('./data');
const { loadCommitmentsPage, saveCommitments } = require('./commitments');

function weeklyRoutes(db, { now, trackerStart }) {
  const router = express.Router();

  // Managers always get their own branch; HQ/admin choose (?branch=WM), default the first.
  async function context(req, defaultWeek) {
    const u = req.user;
    const pickAny = u.role === 'admin' || u.role === 'hq';
    const branches = (await db.query('SELECT code, name FROM branches WHERE active ORDER BY sort_order')).rows;
    const code = pickAny ? (req.query.branch || req.body?.branch || branches[0]?.code) : u.branch_code;
    const branch = code ? await loadBranch(db, code) : null;
    const today = calc.todayInMalaysia(now());
    const start = await trackerStart();
    const weeks = weekChoices(start, today);
    const fallback = defaultWeek === 'current' ? weeks[weeks.length - 1] : lastFinishedWeek(start, today);
    const week = pickWeek(req.query.week || req.body?.week, weeks, fallback);
    const branchQs = pickAny && branch ? `&branch=${encodeURIComponent(branch.code)}` : '';
    return { branch, branches, today, start, weeks, week, pickAny, branchQs };
  }

  const weekPills = (ctx, base) => ctx.weeks.map((w) => ({
    href: `${base}?week=${w}${ctx.branchQs}`, current: w === ctx.week,
    label: w === ctx.weeks[ctx.weeks.length - 1] ? 'This week' : fmt.weekLabel(w, calc.addDays(w, 6)),
  }));

  function guard(req, res, ctx) {
    if (!ctx.branch) { res.redirect('/'); return false; }
    // A save for a week that isn't on the list is refused – never quietly saved to another week.
    if (req.method === 'POST' && req.body.week !== undefined && !ctx.weeks.includes(req.body.week)) {
      res.status(400).render('message', { title: 'Can’t save', message: 'That week isn’t one that can be changed.' });
      return false;
    }
    const denied = viewDenied(req.user, ctx.branch);
    if (denied) { res.status(403).render('message', { title: 'Not for this login', message: denied }); return false; }
    return true;
  }

  // ─────────────── Weekly check-in ───────────────

  async function renderCheckin(req, res, ctx, extra = {}) {
    const page = await data.loadCheckinPage(db, { branch: ctx.branch, week: ctx.week, today: ctx.today, trackerStart: ctx.start });
    const values = { ...(page.checkin || {}), ...(extra.typed || {}) };
    for (const o of page.oos) {
      o.branchEdit = !editDenied(req.user, ctx.branch, o.week_start, ctx.today)
        || (req.user.role === 'branch_manager' && req.user.branch_id === o.branch_id && data.OOS_OPEN.includes(o.status));
    }
    res.status(extra.status || 200).render('weekly', {
      title: `${ctx.branch.name} – weekly check-in`, ...ctx, ...page, fmt, values,
      weekEnd: calc.addDays(ctx.week, 6), pills: weekPills(ctx, '/weekly'),
      blocked: editDenied(req.user, ctx.branch, ctx.week, ctx.today),
      canAnswer: canAnswerOos(req.user), statuses: data.OOS_STATUSES, openStatuses: data.OOS_OPEN,
      errors: extra.errors || {}, ok: req.query.ok || null, err: extra.err || req.query.err || null,
    });
  }

  router.get('/weekly', async (req, res, next) => {
    try {
      const ctx = await context(req);
      if (guard(req, res, ctx)) await renderCheckin(req, res, ctx);
    } catch (err) { next(err); }
  });

  router.post('/weekly', async (req, res, next) => {
    try {
      const ctx = await context(req);
      if (!guard(req, res, ctx)) return;
      const blocked = editDenied(req.user, ctx.branch, ctx.week, ctx.today);
      if (blocked) return res.status(403).render('message', { title: 'Can’t save', message: blocked });
      const result = await data.saveCheckin(db, req.user, ctx.branch, ctx.week, req.body);
      if (result.errors) return renderCheckin(req, res, ctx, { status: 400, errors: result.errors, typed: req.body, err: 'Nothing saved – fix the boxes in red.' });
      res.redirect(`/weekly?week=${ctx.week}${ctx.branchQs}&ok=${encodeURIComponent(result.saved ? 'Check-in saved.' : 'No changes to save.')}`);
    } catch (err) { next(err); }
  });

  router.post('/weekly/oos', async (req, res, next) => {
    try {
      const ctx = await context(req);
      if (!guard(req, res, ctx)) return;
      const blocked = editDenied(req.user, ctx.branch, ctx.week, ctx.today);
      if (blocked) return res.status(403).render('message', { title: 'Can’t save', message: blocked });
      const r = await data.addOos(db, req.user, ctx.branch, ctx.week, req.body, ctx.today);
      const msg = r.error ? `err=${encodeURIComponent(r.error)}` : `ok=${encodeURIComponent('Added to the out-of-stock list.')}`;
      res.redirect(`/weekly?week=${ctx.week}${ctx.branchQs}&${msg}#oos`);
    } catch (err) { next(err); }
  });

  router.post('/weekly/oos/:id', async (req, res, next) => {
    try {
      const item = await data.loadOosItem(db, req.params.id);
      if (!item) return res.status(404).render('message', { title: 'Not found', message: 'That item isn’t on the list.' });
      req.body.branch = item.branch_code; // the item decides the branch, not the form
      const ctx = await context(req);
      if (!guard(req, res, ctx)) return;
      if (ctx.branch.id !== item.branch_id) return res.status(403).render('message', { title: 'Not for this login', message: 'You can only open your own branch.' });
      const branchEdit = !editDenied(req.user, ctx.branch, item.week_start, ctx.today)
        || (req.user.role === 'branch_manager' && req.user.branch_id === item.branch_id && data.OOS_OPEN.includes(item.status));
      const answer = canAnswerOos(req.user);
      if (!branchEdit && !answer) return res.status(403).render('message', { title: 'Can’t save', message: 'Only the branch manager, HQ or admin can change this item.' });
      const r = await data.updateOos(db, req.user, item, req.body, { branchEdit, answer, today: ctx.today });
      const msg = r.error ? `err=${encodeURIComponent(r.error)}` : `ok=${encodeURIComponent(r.saved ? `${item.item}: saved.` : 'No changes to save.')}`;
      res.redirect(`/weekly?week=${ctx.week}${ctx.branchQs}&${msg}#oos-${item.id}`);
    } catch (err) { next(err); }
  });

  // ─────────────── Commitments ───────────────

  async function renderCommitments(req, res, ctx, extra = {}) {
    const page = await loadCommitmentsPage(db, { branch: ctx.branch, week: ctx.week, today: ctx.today, trackerStart: ctx.start });
    res.status(extra.status || 200).render('commitments', {
      title: `${ctx.branch.name} – commitments`, ...ctx, ...page, fmt,
      weekEnd: calc.addDays(ctx.week, 6), pills: weekPills(ctx, '/commitments'),
      blocked: editDenied(req.user, ctx.branch, ctx.week, ctx.today),
      typed: extra.typed || null, errors: extra.errors || {}, ok: req.query.ok || null, err: extra.err || null,
    });
  }

  router.get('/commitments', async (req, res, next) => {
    try {
      const ctx = await context(req, 'current');
      if (guard(req, res, ctx)) await renderCommitments(req, res, ctx);
    } catch (err) { next(err); }
  });

  router.post('/commitments', async (req, res, next) => {
    try {
      const ctx = await context(req, 'current');
      if (!guard(req, res, ctx)) return;
      const blocked = editDenied(req.user, ctx.branch, ctx.week, ctx.today);
      if (blocked) return res.status(403).render('message', { title: 'Can’t save', message: blocked });
      const r = await saveCommitments(db, req.user, ctx.branch, ctx.week, req.body);
      if (r.errors) return renderCommitments(req, res, ctx, { status: 400, errors: r.errors, typed: req.body, err: 'Nothing saved – fix the boxes in red.' });
      res.redirect(`/commitments?week=${ctx.week}${ctx.branchQs}&ok=${encodeURIComponent(r.saved ? 'Commitments saved.' : 'No changes to save.')}`);
    } catch (err) { next(err); }
  });

  return router;
}

module.exports = { weeklyRoutes };
