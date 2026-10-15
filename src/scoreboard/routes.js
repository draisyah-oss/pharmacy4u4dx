// Branch Scoreboard and its click-through ("trace") pages.

const express = require('express');
const calc = require('../calc');
const fmt = require('./format');
const { loadBranch } = require('../daily/data');
const { sheetYearCard } = require('../sales/data');
const { weekList, buildScoreboard, traceMeasure, traceSales, traceRunning } = require('./data');

const { isRealDate } = require('../lib/dates');
const MAX_TRACE_DAYS = 100;

// Managers see their own branch; HQ and admin see every branch.
// Branch staff only do the daily log (CLAUDE.md roles).
function scoreboardAccess(user, branch) {
  if (user.role === 'admin' || user.role === 'hq') return null;
  if (user.role === 'branch_manager' && user.branch_id === branch.id) return null;
  if (user.role === 'branch_manager') return 'You can only open your own branch’s scoreboard.';
  return 'The scoreboard is for branch managers, HQ and admin. Your manager shows it at the Tuesday WIG session.';
}

function scoreboardRoutes(db, { now, trackerStart }) {
  const router = express.Router();

  async function resolveBranch(req) {
    const u = req.user;
    const code = u.role === 'admin' || u.role === 'hq' ? req.query.branch : u.branch_code;
    return code ? loadBranch(db, code) : null;
  }

  router.get('/scoreboard', async (req, res, next) => {
    try {
      const u = req.user;
      const branches = (await db.query('SELECT code, name FROM branches WHERE active ORDER BY sort_order')).rows;
      let branch = await resolveBranch(req);
      if (!branch && (u.role === 'admin' || u.role === 'hq')) branch = await loadBranch(db, branches[0].code);
      if (!branch) return res.redirect('/');
      const denied = scoreboardAccess(u, branch);
      if (denied) return res.status(403).render('message', { title: 'Scoreboard', message: denied });

      const today = calc.todayInMalaysia(now());
      const start = await trackerStart();
      const weeks = weekList(start, today);
      const current = weeks[weeks.length - 1];
      const week = weeks.includes(req.query.week) ? req.query.week : current;

      const board = await buildScoreboard(db, { branch, weekStart: week, today, trackerStart: start });
      const yearCard = await sheetYearCard(db, { today, code: branch.code });
      res.render('scoreboard', {
        title: `${branch.name} scoreboard`, branch, branches, board, fmt, today, yearCard,
        weeks: weeks.map((w) => ({ week: w, label: w === current ? 'This week' : fmt.weekLabel(w, calc.addDays(w, 6)), current: w === week })),
        canPickBranch: u.role === 'admin' || u.role === 'hq',
        branchQs: u.role === 'admin' || u.role === 'hq' ? `&branch=${encodeURIComponent(branch.code)}` : '',
      });
    } catch (err) { next(err); }
  });

  // /scoreboard/trace?type=measure&code=T1&from=2026-10-12&to=2026-10-18[&branch=WM][&partial=1]
  router.get('/scoreboard/trace', async (req, res, next) => {
    try {
      const branch = await resolveBranch(req);
      if (!branch) return res.status(404).render('message', { title: 'Not found', message: 'Pick a branch first.' });
      const denied = scoreboardAccess(req.user, branch);
      if (denied) return res.status(403).render('message', { title: 'Scoreboard', message: denied });

      const { type, code, from, to } = req.query;
      if (!isRealDate(from) || !isRealDate(to) || from > to || calc.diffDays(from, to) > MAX_TRACE_DAYS) {
        return res.status(400).render('message', { title: 'Can’t show that', message: 'That date range isn’t valid.' });
      }
      const start = await trackerStart();
      let trace = null;
      if (type === 'measure') trace = await traceMeasure(db, { branch, code, from, to, trackerStart: start });
      else if (type === 'sales') trace = await traceSales(db, { branch, from, to, trackerStart: start });
      else if (type === 'running') trace = await traceRunning(db, { branch, code, to });
      if (!trace) return res.status(404).render('message', { title: 'Not found', message: 'That measure doesn’t exist for this branch.' });

      const isManagerish = req.user.role !== 'hq';
      const view = { trace, branch, fmt, editLinks: isManagerish, branchQs: req.user.role === 'admin' || req.user.role === 'hq' ? `&branch=${encodeURIComponent(branch.code)}` : '' };
      if (req.query.partial) return res.render('partials/trace', view);
      // "Back" returns to the scoreboard the person came from (path only, never another site).
      let back = '/scoreboard';
      try {
        const ref = new URL(req.get('referer') || '', 'http://x');
        if (ref.pathname === '/scoreboard') back = ref.pathname + ref.search;
      } catch { /* keep default */ }
      res.render('trace', { title: trace.label, ...view, back });
    } catch (err) { next(err); }
  });

  return router;
}

module.exports = { scoreboardRoutes, scoreboardAccess };
