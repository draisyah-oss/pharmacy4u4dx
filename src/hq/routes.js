// HQ input (Alia, Hanin – Mondays) and the HQ scoreboard. HQ and admin only.

const express = require('express');
const calc = require('../calc');
const fmt = require('../scoreboard/format');
const { weekChoices, lastFinishedWeek, pickWeek } = require('../lib/weeks');
const hq = require('./data');

const isHqOrAdmin = (user) => user.role === 'hq' || user.role === 'admin';

function hqRoutes(db, { now, trackerStart }) {
  const router = express.Router();

  async function context(req) {
    const today = calc.todayInMalaysia(now());
    const start = await trackerStart();
    const weeks = weekChoices(start, today);
    const week = pickWeek(req.query.week || req.body?.week, weeks, lastFinishedWeek(start, today));
    return { today, start, weeks, week };
  }
  const pills = (ctx, base) => ctx.weeks.map((w) => ({
    href: `${base}?week=${w}`, current: w === ctx.week,
    label: w === ctx.weeks[ctx.weeks.length - 1] ? 'This week' : fmt.weekLabel(w, calc.addDays(w, 6)),
  }));
  const deny = (res) => res.status(403).render('message', { title: 'HQ only', message: 'HQ numbers are for HQ (Alia, Hanin) and admin.' });

  async function renderInput(req, res, ctx, extra = {}) {
    const rows = await hq.loadHqWeek(db, { week: ctx.week, user: req.user });
    res.status(extra.status || 200).render('hq-input', {
      title: 'HQ input', ...ctx, rows, hq, fmt, pills: pills(ctx, '/hq'), weekEnd: calc.addDays(ctx.week, 6),
      blocked: hq.weekDenied(req.user, ctx.week, ctx.today), typed: extra.typed || null,
      errors: extra.errors || {}, ok: req.query.ok || null, err: extra.err || null,
    });
  }

  router.get('/hq', async (req, res, next) => {
    try {
      if (!isHqOrAdmin(req.user)) return deny(res);
      await renderInput(req, res, await context(req));
    } catch (err) { next(err); }
  });

  router.post('/hq', async (req, res, next) => {
    try {
      if (!isHqOrAdmin(req.user)) return deny(res);
      const ctx = await context(req);
      if (!ctx.weeks.includes(req.body.week)) return res.status(400).render('message', { title: 'Can’t save', message: 'That week isn’t one that can be changed.' });
      const blocked = hq.weekDenied(req.user, ctx.week, ctx.today);
      if (blocked) return res.status(403).render('message', { title: 'Can’t save', message: blocked });
      const r = await hq.saveHqWeek(db, req.user, ctx.week, req.body);
      if (r.errors) return renderInput(req, res, ctx, { status: 400, errors: r.errors, typed: req.body, err: 'Nothing saved – fix the boxes in red.' });
      res.redirect(`/hq?week=${ctx.week}&ok=${encodeURIComponent(r.saved ? 'HQ numbers saved.' : 'No changes to save.')}`);
    } catch (err) { next(err); }
  });

  router.get('/hq/scoreboard', async (req, res, next) => {
    try {
      if (!isHqOrAdmin(req.user)) return deny(res);
      const ctx = await context(req);
      const board = await hq.buildHqScoreboard(db, { week: ctx.week, trackerStart: ctx.start });
      res.render('hq-scoreboard', { title: 'HQ scoreboard', ...ctx, board, hq, fmt, pills: pills(ctx, '/hq/scoreboard') });
    } catch (err) { next(err); }
  });

  return router;
}

module.exports = { hqRoutes };
