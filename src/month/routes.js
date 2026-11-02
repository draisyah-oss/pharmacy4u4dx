// /month – the monthly scoreboard (2 Nov, CEO). See src/month/data.js.
//   GET  /month?month=YYYY-MM          the summary (default: last month)
//   POST /month/notes                  add a note to a section {month, scope, ref, note, forward}
//   POST /month/notes/:id              mark a brought-forward note done / not done {month, done}
// Who sees what:
//   admin, hq        everything
//   hq_staff         company, HQ departments and HQ people
//   branch_manager   company, their branch and its people
//   branch_staff     their branch and its people (read only)

const express = require('express');
const calc = require('../calc');
const fmt = require('../scoreboard/format');
const rv = require('../review/data');
const md = require('./data');

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

function monthRoutes(db, { now, trackerStart }) {
  const router = express.Router();

  const showFor = (u) => {
    if (u.role === 'admin' || u.role === 'hq') return { company: true, depts: true, hqPeople: true, branches: 'all' };
    if (u.role === 'hq_staff') return { company: true, depts: true, hqPeople: true, branches: [] };
    if (u.role === 'branch_manager') return { company: true, depts: false, hqPeople: false, branches: [u.branch_code] };
    return { company: false, depts: false, hqPeople: false, branches: [u.branch_code] };
  };

  async function ctx(req, monthIn) {
    const ts = await trackerStart();
    const today = calc.todayInMalaysia(now());
    const months = rv.reviewMonths(today, ts);
    const month = MONTH_RE.test(monthIn || '') && months.includes(monthIn) ? monthIn : rv.defaultMonth(today, ts);
    return { ts, today, months, month };
  }

  // Helpers for canNote: which department a person is in, which branch a person works at.
  async function lookups() {
    const depts = await md.departments(db);
    const people = (await db.query('SELECT p.id, p.name, b.code FROM people p LEFT JOIN branches b ON b.id = p.branch_id')).rows;
    const byId = new Map(people.map((p) => [String(p.id), p]));
    return {
      deptOf: (pid) => { const p = byId.get(String(pid)); return p ? (depts.find((d) => d.people.includes(p.name)) || {}).name || null : null; },
      branchOfPerson: (pid) => (byId.get(String(pid)) || {}).code || null,
    };
  }

  router.get('/month', async (req, res, next) => {
    try {
      const c = await ctx(req, req.query.month);
      const show = showFor(req.user);
      const [data, notes, look] = await Promise.all([
        md.buildMonth(db, { month: c.month, today: c.today, trackerStart: c.ts, show }), md.loadNotes(db, c.month), lookups(),
      ]);
      res.render('month', {
        title: `${data.short} scoreboard`, ...c, data, notes, show, fmt, arrow: md.ARROW, canNote: (scope, ref) => md.canNote(req.user, scope, ref, look),
        ok: req.query.ok || null, err: req.query.err || null, navActive: 'month',
      });
    } catch (err) { next(err); }
  });

  router.post('/month/notes', async (req, res, next) => {
    try {
      const c = await ctx(req, req.body.month);
      const { scope } = req.body; const ref = String(req.body.ref || '');
      const back = (q, anchor) => res.redirect(`/month?month=${c.month}&${q}#${anchor}`);
      if (!md.canNote(req.user, scope, ref, await lookups())) return res.status(403).render('message', { title: 'Monthly scoreboard', message: 'You can’t add notes here.' });
      const r = await md.addNote(db, req.user, { month: c.month, scope, ref, note: req.body.note, bringForward: req.body.forward === '1', now });
      back(r.error ? `err=${encodeURIComponent(r.error)}` : 'ok=note', `${scope}-${ref}`.replace(/[^\w-]/g, '_'));
    } catch (err) { next(err); }
  });

  router.post('/month/notes/:id', async (req, res, next) => {
    try {
      const c = await ctx(req, req.body.month);
      const n = (await db.query('SELECT * FROM month_notes WHERE id = $1', [Number(req.params.id) || 0])).rows[0];
      if (!n) return res.status(404).render('message', { title: 'Monthly scoreboard', message: 'Note not found.' });
      if (!md.canNote(req.user, n.scope, n.ref, await lookups())) return res.status(403).render('message', { title: 'Monthly scoreboard', message: 'You can’t change this note.' });
      await md.tickNote(db, req.user, n.id, { done: req.body.done === '1', now });
      res.redirect(`/month?month=${c.month}&ok=done#${`${n.scope}-${n.ref}`.replace(/[^\w-]/g, '_')}`);
    } catch (err) { next(err); }
  });

  return router;
}

module.exports = { monthRoutes };
