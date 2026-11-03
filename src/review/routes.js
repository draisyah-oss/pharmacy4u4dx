// Monthly Performance Review screens (1 Nov, CEO):
//   /review               the hub: how it runs, who has filled in, the shared conclusion so far
//   /review/branch        a branch's month (managers: own branch; HQ / admin: any) – numbers,
//                         improvement per measure, can we hit next month, plan, stop/start/keep, needs
//   /review/hq            an HQ person's month – weeks on track per measure, improvement, next focus
//   /review/conclusion    next month's goals: HQ agrees, managers agree, the CEO locks
// month in the query = the month reviewed (YYYY-MM); the goals are for the month after it.

const express = require('express');
const calc = require('../calc');
const fmt = require('../scoreboard/format');
const { loadBranch } = require('../daily/data');
const rv = require('./data');

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const BRANCH_ROLES = ['branch_manager', 'hq', 'admin'];
const HQ_ROLES = ['hq', 'hq_staff', 'admin'];
const ALL_ROLES = ['branch_manager', 'hq', 'hq_staff', 'admin'];

// Tab-separated rows for pasting into Google Sheets (JH keeps a sheet).
const tsv = (rows) => rows.map((r) => r.map((c) => String(c ?? '').replace(/[\t\n\r]+/g, ' ')).join('\t')).join('\n');

function reviewRoutes(db, { now, trackerStart }) {
  const router = express.Router();
  const message = (res, status, text) => res.status(status).render('message', { title: 'Monthly review', message: text });

  async function base(req) {
    const ts = await trackerStart();
    const today = calc.todayInMalaysia(now());
    const months = rv.reviewMonths(today, ts);
    const month = MONTH_RE.test(req.query.month || '') && months.includes(req.query.month) ? req.query.month : rv.defaultMonth(today, ts);
    const nm = rv.nextMonth(month);
    return { ts, today, months, month, next: nm, monthName: rv.MONTH_NAME(month), nextName: rv.MONTH_NAME(nm), firstMonday: rv.firstMonday(nm) };
  }
  const monthQs = (b) => `month=${b.month}`;

  // ─────────────── Hub ───────────────
  router.get('/review', async (req, res, next) => {
    try {
      if (!ALL_ROLES.includes(req.user.role)) return message(res, 403, 'The monthly review is for branch managers and HQ.');
      const b = await base(req);
      const [status, goals, hqDone] = await Promise.all([
        rv.reviewStatus(db, b.month), rv.loadGoals(db, b.next),
        db.query(`SELECT p.name, r.submitted_at FROM monthly_reviews r JOIN people p ON p.id = r.person_id WHERE r.scope = 'hq' AND r.month = $1`, [b.month]),
      ]);
      res.render('review-home', { title: 'Monthly review', ...b, status, goals, hqDone: hqDone.rows, fmt, navActive: 'review' });
    } catch (err) { next(err); }
  });

  // ─────────────── Branch ───────────────
  async function branchCtx(req) {
    const u = req.user;
    if (!BRANCH_ROLES.includes(u.role)) return { denied: 'The branch review is for branch managers, HQ and admin.' };
    const code = u.role === 'branch_manager' ? u.branch_code : (req.query.branch || req.body?.branch || '');
    const branches = (await db.query('SELECT code, name FROM branches WHERE active ORDER BY sort_order')).rows;
    const branch = await loadBranch(db, code || branches[0].code);
    if (!branch) return { denied: 'Branch not found.' };
    const canEdit = u.role === 'admin' || (u.role === 'branch_manager' && u.branch_code === branch.code);
    return { branch, branches, canEdit };
  }

  async function branchPage(req, res, { errors = {}, typed = null, ok = null } = {}) {
    const ctx = await branchCtx(req);
    if (ctx.denied) return message(res, 403, ctx.denied);
    const b = await base(req);
    const [m, saved, goals] = await Promise.all([
      rv.branchMonth(db, { branch: ctx.branch, month: b.month, today: b.today, trackerStart: b.ts }),
      rv.loadReview(db, { scope: 'branch', branchId: ctx.branch.id, month: b.month }),
      rv.loadGoals(db, b.next),
    ]);
    const vals = typed || { ...(saved.review || {}), imp: Object.fromEntries(Object.entries(saved.items).map(([k, v]) => [k.replace(':', '_'), v])) };
    const sheet = tsv([
      [`${ctx.branch.name} – ${m.name} review`],
      ['Measure', 'Owner', 'Kind', `${m.name}`, 'Target', '%', 'Status', 'Improvement'],
      ...[...m.rows, ...m.zakat].map((r) => [r.label, r.owner, r.kind, r.actual, r.target, r.pct === null ? '' : fmt.pct(r.pct), rv.STATUS_WORD[r.status] || '', (vals.imp || {})[r.ref.replace(':', '_')] || '']),
      ['Month sales', '', '', fmt.money(m.sales.actual), m.sales.target === null ? '' : fmt.money(m.sales.target), m.sales.pct === null ? '' : fmt.pct(m.sales.pct), rv.STATUS_WORD[m.sales.status] || ''],
      ['Out of stock reported', '', '', m.oos.reported, '', m.oos.over3Pct === null ? '' : `${fmt.pct(m.oos.over3Pct)} took over 3 days`],
      [],
      [`${m.next.name} target`, m.next.target === null ? '' : fmt.money(m.next.target), 'a day', m.next.perDay === null ? '' : fmt.money(m.next.perDay)],
      ['Can we hit it?', vals.can_hit || ''], ['Plan', vals.plan || ''], ['Stop', vals.stop || ''], ['Start', vals.start || ''], ['Keep', vals.keep || ''], ['Need from HQ', vals.needs || ''],
    ]);
    const linked = await rv.loadLinkedCheckin(db, ctx.branch, b.month);
    linked.editable = ctx.canEdit && !require('../weekly/access').editDenied(req.user, ctx.branch, linked.week, b.today);
    res.render('review-branch', { linked,
      title: `${ctx.branch.code} monthly review`, ...b, ...ctx, m, saved, vals, errors, ok: ok || req.query.ok || null,
      goals, sheet, fmt, statusWord: rv.STATUS_WORD, navActive: 'review',
    });
  }

  router.get('/review/branch', async (req, res, next) => { try { await branchPage(req, res); } catch (err) { next(err); } });

  router.post('/review/branch', async (req, res, next) => {
    try {
      req.query = { ...req.query, branch: req.body.branch, month: req.body.month };
      const ctx = await branchCtx(req);
      if (ctx.denied) return message(res, 403, ctx.denied);
      if (!ctx.canEdit) return message(res, 403, 'Only the branch manager (or admin) fills in this review.');
      const b = await base(req);
      if (req.body.month !== b.month) return message(res, 400, 'That month isn’t open for review.');
      const m = await rv.branchMonth(db, { branch: ctx.branch, month: b.month, today: b.today, trackerStart: b.ts });
      const refs = [...m.rows, ...m.zakat].map((r) => r.ref).concat(['oos']);
      const r = await rv.saveReview(db, req.user, { scope: 'branch', branchId: ctx.branch.id, month: b.month, refs, body: req.body, now });
      if (r.errors) return branchPage(req, res, { errors: r.errors, typed: req.body });
      // 3 Nov: the same page is that Monday's weekly update – last week's numbers + needs from HQ.
      const link = await rv.linkBranchWeekly(db, req.user, { branch: ctx.branch, month: b.month, body: req.body, today: b.today });
      if (link.errors) return branchPage(req, res, { errors: link.errors, typed: req.body });
      res.redirect(`/review/branch?branch=${encodeURIComponent(ctx.branch.code)}&${monthQs(b)}&ok=${r.submitted ? 'submitted' : 'saved'}`);
    } catch (err) { next(err); }
  });

  // ─────────────── HQ ───────────────
  async function hqPage(req, res, { errors = {}, typed = null } = {}) {
    const u = req.user;
    if (!HQ_ROLES.includes(u.role)) return message(res, 403, 'The HQ review is for the HQ team.');
    const b = await base(req);
    const hq = await rv.hqMonth(db, { month: b.month, today: b.today, trackerStart: b.ts });
    const all = u.role === 'admin' || Boolean(u.enters_all_hq);
    const reviews = {};
    for (const g of hq.groups) reviews[g.person.id] = await rv.loadReview(db, { scope: 'hq', personId: g.person.id, month: b.month });
    const goals = await rv.loadGoals(db, b.next);
    const sheet = tsv([
      [`HQ – ${hq.name} review`], ['Person', 'Measure', 'Target', 'Last week', 'Weeks on track', 'Status', 'Improvement'],
      ...hq.groups.flatMap((g) => g.rows.map((r) => [g.person.name, r.label, r.target, r.last, `${r.weeksOn} of ${r.weeksEntered}`, rv.STATUS_WORD[r.status] || '', (reviews[g.person.id].items || {})[r.ref] || ''])),
    ]);
    res.render('review-hq', {
      title: 'HQ monthly review', ...b, hq, reviews, canEditFor: (pid) => all || u.person_id === pid,
      mine: u.person_id || null, errors, typed, goals, sheet, fmt, statusWord: rv.STATUS_WORD, ok: req.query.ok || null, navActive: 'review',
    });
  }
  router.get('/review/hq', async (req, res, next) => { try { await hqPage(req, res); } catch (err) { next(err); } });

  router.post('/review/hq', async (req, res, next) => {
    try {
      const u = req.user;
      if (!HQ_ROLES.includes(u.role)) return message(res, 403, 'The HQ review is for the HQ team.');
      req.query = { ...req.query, month: req.body.month };
      const b = await base(req);
      if (req.body.month !== b.month) return message(res, 400, 'That month isn’t open for review.');
      const personId = Number(req.body.person);
      const all = u.role === 'admin' || Boolean(u.enters_all_hq);
      if (!all && u.person_id !== personId) return message(res, 403, 'You can fill in your own HQ review only.');
      const hq = await rv.hqMonth(db, { month: b.month, today: b.today, trackerStart: b.ts });
      const g = hq.groups.find((x) => x.person.id === personId);
      if (!g) return message(res, 404, 'That person has no HQ measures.');
      const r = await rv.saveReview(db, u, { scope: 'hq', personId, month: b.month, refs: g.rows.map((x) => x.ref), body: req.body, now });
      if (r.errors) return hqPage(req, res, { errors: { [personId]: r.errors }, typed: { [personId]: req.body } });
      await rv.linkHqFocus(db, u, { personId, month: b.month }); // 3 Nov: also that Monday's HQ WIG focus
      res.redirect(`/review/hq?${monthQs(b)}&ok=${r.submitted ? 'submitted' : 'saved'}#p${personId}`);
    } catch (err) { next(err); }
  });

  // ─────────────── Shared conclusion ───────────────
  router.get('/review/conclusion', async (req, res, next) => {
    try {
      if (!ALL_ROLES.includes(req.user.role)) return message(res, 403, 'The monthly review is for branch managers and HQ.');
      const b = await base(req);
      const goals = await rv.loadGoals(db, b.next);
      const branchReviews = (await db.query(
        `SELECT b.code, b.name, r.can_hit, r.plan, r.needs, r.submitted_at FROM branches b
         LEFT JOIN monthly_reviews r ON r.branch_id = b.id AND r.scope = 'branch' AND r.month = $1 WHERE b.active ORDER BY b.sort_order`, [b.month])).rows;
      const hqReviews = (await db.query(
        `SELECT p.name, r.focus, r.submitted_at FROM monthly_reviews r JOIN people p ON p.id = r.person_id
         WHERE r.scope = 'hq' AND r.month = $1 ORDER BY p.sort_order`, [b.month])).rows;
      const u = req.user;
      res.render('review-conclusion', {
        title: `${b.nextName} goals`, ...b, goals, branchReviews, hqReviews, fmt, ok: req.query.ok || null, err: req.query.err || null,
        can: { edit: rv.canEditGoals(u), hq: rv.canAgreeHq(u), mgr: rv.canAgreeMgr(u), lock: rv.isCeo(u) }, navActive: 'review',
      });
    } catch (err) { next(err); }
  });

  router.post('/review/conclusion', async (req, res, next) => {
    try {
      if (!ALL_ROLES.includes(req.user.role)) return message(res, 403, 'The monthly review is for branch managers and HQ.');
      req.query = { ...req.query, month: req.body.month };
      const b = await base(req);
      if (req.body.month !== b.month) return message(res, 400, 'That month isn’t open for review.');
      const r = await rv.saveGoals(db, req.user, b.next, req.body, { now });
      const q = r.error ? `err=${encodeURIComponent(r.error)}` : `ok=${req.body.lock === '1' ? 'locked' : req.body.lock === '0' ? 'unlocked' : 'saved'}`;
      res.redirect(`/review/conclusion?${monthQs(b)}&${q}`);
    } catch (err) { next(err); }
  });

  return router;
}

module.exports = { reviewRoutes };
