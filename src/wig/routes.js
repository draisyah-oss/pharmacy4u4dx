// Weekly WIG rhythm screens (18 Oct):
//   /my-week     staff (and managers) on their phone: this week's commitment – type it, tap Done
//   /hq/update   Monday 4 pm: all branches' updates, what they need → HQ actions (owner, date)
//   POST /hq/actions/:id   owner / HQ ticks an action Done or Not done (HQ day, update page)
// The branch WIG session is /commitments (src/weekly), the HQ WIG session /hq/commitments.

const express = require('express');
const calc = require('../calc');
const fmt = require('../scoreboard/format');
const { loadBranch } = require('../daily/data');
const { weekChoices, lastFinishedWeek, pickWeek } = require('../lib/weeks');
const { audit } = require('../admin/common');
const { saveCommitments, loadWeek, buildMeasureLabels } = require('../weekly/commitments');
const { branchWeek } = require('../group/data');
const { loadMeasures } = require('../daily/data');
const oosData = require('../oos/data');
const wig = require('./data');

function wigRoutes(db, { now, trackerStart }) {
  const router = express.Router();
  const message = (res, status, title, text) => res.status(status).render('message', { title, message: text });

  // ─────────────── My week (staff phone) ───────────────

  async function myWeekContext(req) {
    const u = req.user;
    if (!['branch_staff', 'branch_manager'].includes(u.role) || !u.person_id || !u.branch_code) return null;
    const branch = await loadBranch(db, u.branch_code);
    const person = (await db.query('SELECT id, name, role FROM people WHERE id = $1 AND branch_id = $2 AND active', [u.person_id, branch.id])).rows[0];
    if (!person) return null;
    const today = calc.todayInMalaysia(now());
    const week = calc.weekStart(today);
    return { branch, person, today, week, prev: calc.addDays(week, -7) };
  }

  router.get('/my-week', async (req, res, next) => {
    try {
      const ctx = await myWeekContext(req);
      if (!ctx) return message(res, 403, 'My week', 'My week is for branch staff and managers – your login isn’t linked to a branch person.');
      const [current, last, measures, myMeasures] = await Promise.all([
        loadWeek(db, ctx.branch.id, ctx.week), loadWeek(db, ctx.branch.id, ctx.prev), buildMeasureLabels(db, ctx.branch.id),
        db.query('SELECT label FROM measures WHERE branch_id = $1 AND active AND person_id = $2 ORDER BY sort_order', [ctx.branch.id, ctx.person.id]),
      ]);
      const mine = current.find((c) => c.person_id === ctx.person.id) || null;
      res.render('my-week', {
        title: 'My week', ...ctx, fmt, mine, lastMine: last.find((c) => c.person_id === ctx.person.id) || null,
        team: current.filter((c) => c.person_id !== ctx.person.id), measures,
        myMeasures: myMeasures.rows.map((r) => r.label), weekEnd: calc.addDays(ctx.week, 6),
        ok: req.query.ok || null, err: req.query.err || null, resultText: wig.RESULT_TEXT,
      });
    } catch (err) { next(err); }
  });

  router.post('/my-week', async (req, res, next) => {
    try {
      const ctx = await myWeekContext(req);
      if (!ctx) return message(res, 403, 'My week', 'My week is for branch staff and managers.');
      const back = (q) => res.redirect(`/my-week?${q}`);
      if (req.body.mark !== undefined) {
        const c = (await loadWeek(db, ctx.branch.id, ctx.week)).find((x) => x.person_id === ctx.person.id);
        if (!c) return back(`err=${encodeURIComponent('Write your commitment first.')}`);
        const result = req.body.mark === 'yes' ? 'yes' : null;
        if ((c.result || null) !== result) {
          await db.transaction(async (tx) => {
            await tx.query('UPDATE commitments SET result = $2, done = $3, updated_at = now() WHERE id = $1', [c.id, result, result === null ? null : true]);
            await audit(tx, req.user, 'update', 'commitments', `${ctx.branch.code} ${ctx.week} ${ctx.person.name}`, { result: c.result || null }, { result });
          });
        }
        return back(`ok=${encodeURIComponent(result ? 'Well done – marked done. It shows at next Tuesday’s WIG.' : 'Marked not done yet.')}`);
      }
      const r = await saveCommitments(db, req.user, ctx.branch, ctx.week,
        { c: { [`p${ctx.person.id}`]: { text: req.body.text, lead: req.body.lead, by: req.body.by } } }, { today: ctx.today });
      if (r.errors) return back(`err=${encodeURIComponent(Object.values(r.errors)[0])}`);
      back(`ok=${encodeURIComponent(r.saved ? 'Saved – your manager sees it at the WIG session.' : 'No changes to save.')}`);
    } catch (err) { next(err); }
  });

  // ─────────────── Monday 4 pm: weekly update with HQ ───────────────

  const canSeeUpdate = (user) => user.role === 'admin' || user.role === 'hq';

  async function updateContext(req) {
    const today = calc.todayInMalaysia(now());
    const start = await trackerStart();
    const weeks = weekChoices(start, today);
    const week = pickWeek(req.query.week || req.body?.week, weeks, lastFinishedWeek(start, today));
    return { today, start, weeks, week };
  }

  async function renderUpdate(req, res, ctx, extra = {}) {
    const branches = (await db.query('SELECT * FROM branches WHERE active ORDER BY sort_order')).rows;
    const actions = await wig.loadActions(db, { week: ctx.week });
    const lastActions = await wig.loadActions(db, { week: calc.addDays(ctx.week, -7) });
    const rows = [];
    for (const b of branches) {
      const g = await branchWeek(db, { branch: b, measures: await loadMeasures(db, b.id), week: ctx.week, today: ctx.today, trackerStart: ctx.start });
      const session = await wig.loadSession(db, b.id, ctx.week);
      const commits = wig.resultSummary(await loadWeek(db, b.id, ctx.week));
      const oos = await oosData.branchWeekSummary(db, { branchId: b.id, week: ctx.week, now });
      const leads = [g.walk, g.lead1, g.lead2].filter((m) => m && ['on_track', 'watch', 'off_track'].includes(m.status));
      rows.push({
        ...b, g, session, commits, oos,
        leads: { on: leads.filter((m) => m.status === 'on_track').length, total: leads.length },
        asks: actions.filter((a) => a.branch_id === b.id).length,
      });
    }
    const thisWeek = calc.weekStart(ctx.today);
    res.status(extra.status || 200).render('hq-update', {
      title: 'Weekly Branch Manager Meeting', ...ctx, fmt, rows, actions, lastActions,
      lastSummary: wig.actionSummary(lastActions), people: await wig.hqPeople(db), branches,
      statuses: wig.ACTION_STATUSES, weekEnd: calc.addDays(ctx.week, 6),
      canEdit: req.user.role === 'admin' || ctx.week >= calc.addDays(thisWeek, -14),
      pills: ctx.weeks.map((w) => ({ href: `/hq/update?week=${w}`, current: w === ctx.week, label: w === thisWeek ? 'This week' : fmt.weekLabel(w, calc.addDays(w, 6)) })),
      errors: extra.errors || {}, typed: extra.typed || null, ok: req.query.ok || null, err: extra.err || req.query.err || null,
    });
  }

  router.get('/hq/update', async (req, res, next) => {
    try {
      if (!canSeeUpdate(req.user)) return message(res, 403, 'HQ only', 'The Weekly Branch Manager Meeting page is for the CEO, Alia, Hanin, Iman and admin.');
      await renderUpdate(req, res, await updateContext(req));
    } catch (err) { next(err); }
  });

  router.post('/hq/update', async (req, res, next) => {
    try {
      if (!canSeeUpdate(req.user)) return message(res, 403, 'HQ only', 'The Weekly Branch Manager Meeting page is for HQ and admin.');
      const ctx = await updateContext(req);
      if (!ctx.weeks.includes(req.body.week)) return message(res, 400, 'Can’t save', 'That week isn’t one that can be changed.');
      const r = await wig.saveActionsAtMeeting(db, req.user, ctx.week, req.body);
      if (r.errors) return renderUpdate(req, res, ctx, { status: 400, errors: r.errors, typed: req.body, err: 'Nothing saved – fix the rows in red.' });
      res.redirect(`/hq/update?week=${ctx.week}&ok=${encodeURIComponent(r.saved ? 'HQ actions saved – they’re on each owner’s week.' : 'No changes to save.')}`);
    } catch (err) { next(err); }
  });

  router.post('/hq/actions/:id', async (req, res, next) => {
    try {
      const r = await wig.setActionStatus(db, req.user, req.params.id, req.body.status);
      const backTo = ['/hq/today', '/hq/update', '/hq/commitments'].includes(req.body.back) ? req.body.back : '/hq/today';
      const sep = backTo.includes('?') ? '&' : '?';
      const extra = req.body.week && /^\d{4}-\d{2}-\d{2}$/.test(req.body.week) ? `week=${req.body.week}&` : '';
      if (r.error) return res.redirect(`${backTo}${sep}${extra}err=${encodeURIComponent(r.error)}`);
      res.redirect(`${backTo}${sep}${extra}ok=${encodeURIComponent(r.saved ? `${r.action.issue.slice(0, 60)}: ${req.body.status}.` : 'No change.')}`);
    } catch (err) { next(err); }
  });

  return router;
}

module.exports = { wigRoutes };
