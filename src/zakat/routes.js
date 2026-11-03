// /zakat – Zakat claims tracker for BR, WM, JH (3 Nov, CEO). See ./data.js.
//   GET  /zakat?branch=&month=YYYY-MM&tab=overview|weekly|bids|suppliers&week=YYYY-MM-DD
//   POST /zakat/week            {week, claimed, paid, bids, won}       – that branch's people, HQ, admin
//   POST /zakat/week/delete     {week}
//   POST /zakat/target          {month, target}                        – that branch's manager, HQ, admin
//   POST /zakat/suppliers       {name1..10, n1..10}

const express = require('express');
const calc = require('../calc');
const { loadBranch } = require('../daily/data');
const zk = require('./data');

const TABS = ['overview', 'weekly', 'bids', 'suppliers'];

function zakatRoutes(db, { now }) {
  const router = express.Router();
  const msg = (res, status, text) => res.status(status).render('message', { title: 'Zakat claims', message: text });

  async function ctx(req) {
    const u = req.user;
    const src = { ...(req.query || {}), ...(req.body || {}) };
    const many = u.role === 'admin' || u.role === 'hq';
    const code = many ? (zk.isZakatBranch(src.branch) ? src.branch : zk.BRANCHES[0]) : u.branch_code;
    const branch = await loadBranch(db, code);
    if (!zk.canSee(u, branch)) return { denied: 'The zakat claims tracker is for BR, WM and JH (their own branch), HQ and admin.' };
    const today = calc.todayInMalaysia(now());
    const month = /^\d{4}-(0[1-9]|1[0-2])$/.test(src.month || '') ? src.month : today.slice(0, 7);
    return { branch, today, month, many };
  }
  const back = (res, c, { tab, week, month }, r, anchor = '') => {
    const q = new URLSearchParams({ branch: c.branch.code, month: month || c.month, tab: tab || 'overview' });
    if (week) q.set('week', week);
    q.set(r.error ? 'err' : 'ok', r.error || r.ok);
    res.redirect(303, `/zakat?${q.toString()}${anchor}`);
  };

  router.get('/zakat', async (req, res, next) => {
    try {
      const c = await ctx(req);
      if (c.denied) return msg(res, 403, c.denied);
      const t = await zk.loadTracker(db, c.branch, { month: c.month, today: c.today });
      const chk = await zk.checkin(db, c.branch, c.today);
      // Until last week is checked in, the Weekly form opens on last week.
      const week = calc.weekStart(/^\d{4}-\d{2}-\d{2}$/.test(req.query.week || '') && req.query.week <= c.today ? req.query.week : (chk.done ? c.today : chk.lastWeek));
      res.render('zakat', { title: `${c.branch.code} zakat claims`, ...c, t, chk, tab: TABS.includes(req.query.tab) ? req.query.tab : 'overview',
        week, weekVals: t.weeks[week] || null, prevMonth: zk.addMonth(c.month, -1), nextMonth: zk.addMonth(c.month, 1),
        canTarget: zk.canTarget(req.user, c.branch), anyWeek: zk.anyWeek(req.user), backWeeks: zk.BACK_WEEKS, addDays: calc.addDays,
        branches: c.many ? zk.BRANCHES : [], ok: req.query.ok || null, err: req.query.err || null, navActive: 'zakat' });
    } catch (err) { next(err); }
  });

  router.post('/zakat/week', async (req, res, next) => {
    try {
      const c = await ctx(req);
      if (c.denied) return msg(res, 403, c.denied);
      const r = await zk.saveWeek(db, req.user, c.branch, req.body, { today: c.today });
      const week = r.monday || req.body.week;
      back(res, c, { tab: 'weekly', week, month: r.monday ? r.monday.slice(0, 7) : c.month }, r, '#weekly');
    } catch (err) { next(err); }
  });

  router.post('/zakat/week/delete', async (req, res, next) => {
    try {
      const c = await ctx(req);
      if (c.denied) return msg(res, 403, c.denied);
      const r = await zk.deleteWeek(db, req.user, c.branch, req.body.week, { today: c.today });
      back(res, c, { tab: 'weekly' }, r, '#weekly');
    } catch (err) { next(err); }
  });

  router.post('/zakat/target', async (req, res, next) => {
    try {
      const c = await ctx(req);
      if (c.denied) return msg(res, 403, c.denied);
      if (!zk.canTarget(req.user, c.branch)) return msg(res, 403, 'The branch manager, HQ or admin sets the amount to claim.');
      const r = await zk.saveTarget(db, req.user, c.branch, c.month, req.body.target);
      back(res, c, { tab: 'overview' }, r);
    } catch (err) { next(err); }
  });

  router.post('/zakat/suppliers', async (req, res, next) => {
    try {
      const c = await ctx(req);
      if (c.denied) return msg(res, 403, c.denied);
      const r = await zk.saveSuppliers(db, req.user, c.branch, req.body);
      back(res, c, { tab: 'suppliers' }, r);
    } catch (err) { next(err); }
  });

  return router;
}

module.exports = { zakatRoutes };
