// /branch/measures – the branch's measures for its manager (3 Nov, CEO). See ./data.js.
const express = require('express');
const calc = require('../calc');
const fmt = require('../scoreboard/format');
const { loadBranch } = require('../daily/data');
const bm = require('./data');

function branchMeasureRoutes(db, { now }) {
  const router = express.Router();
  const msg = (res, status, text) => res.status(status).render('message', { title: 'Branch measures', message: text });

  async function ctx(req) {
    const u = req.user;
    if (!['branch_manager', 'hq', 'admin'].includes(u.role)) return { denied: 'This page is for branch managers, HQ and admin.' };
    const branches = (await db.query('SELECT code, name FROM branches WHERE active ORDER BY sort_order')).rows;
    const code = u.role === 'branch_manager' ? u.branch_code : (req.query.branch || req.body?.branch || branches[0].code);
    const branch = await loadBranch(db, code);
    if (!branch) return { denied: 'Branch not found.' };
    return { branch, branches, today: calc.todayInMalaysia(now()) };
  }
  const back = (res, c, q, anchor = '') => res.redirect(`/branch/measures?branch=${encodeURIComponent(c.branch.code)}&${q}${anchor}`);
  const q = (r) => (r.error ? `err=${encodeURIComponent(r.error)}` : `ok=${encodeURIComponent(r.ok)}`);

  router.get('/branch/measures', async (req, res, next) => {
    try {
      const c = await ctx(req);
      if (c.denied) return msg(res, 403, c.denied);
      const [page, waiting, recent] = await Promise.all([
        bm.loadPage(db, { branch: c.branch, today: c.today }),
        bm.isCeo(req.user) ? bm.loadWaiting(db) : [], bm.recentDecisions(db, c.branch.id),
      ]);
      res.render('branch-measures', {
        title: `${c.branch.code} branch measures`, ...c, ...page, waiting, recent, fmt, canEdit: bm.canEdit(req.user, c.branch), ceo: bm.isCeo(req.user),
        ok: req.query.ok || null, err: req.query.err || null, navActive: 'branchmeasures',
      });
    } catch (err) { next(err); }
  });

  router.post('/branch/measures/new', async (req, res, next) => {
    try {
      const c = await ctx(req);
      if (c.denied) return msg(res, 403, c.denied);
      const r = await bm.addMeasure(db, req.user, { branch: c.branch, body: req.body, today: c.today });
      back(res, c, q(r), req.body.tier === 'lead' ? '#add-lead' : '#add-activity');
    } catch (err) { next(err); }
  });

  router.post('/branch/measures/:id', async (req, res, next) => {
    try {
      const c = await ctx(req);
      if (c.denied) return msg(res, 403, c.denied);
      if (!bm.canEdit(req.user, c.branch)) return msg(res, 403, 'Only the branch manager or admin can change measures.');
      const r = req.body.retire === '1'
        ? await bm.retireActivity(db, req.user, { branch: c.branch, measureId: req.params.id, today: c.today })
        : await bm.saveMeasure(db, req.user, { branch: c.branch, measureId: req.params.id, body: req.body, today: c.today });
      back(res, c, q(r), `#m${Number(req.params.id) || ''}`);
    } catch (err) { next(err); }
  });

  router.post('/branch/measures/changes/:id', async (req, res, next) => {
    try {
      if (!bm.isCeo(req.user)) return msg(res, 403, 'Only Dr Aisyah approves lead measure changes.');
      const r = await bm.decide(db, req.user, { id: Number(req.params.id) || 0, approve: req.body.decision === 'approve', note: req.body.note });
      res.redirect(`/branch/measures?branch=${encodeURIComponent(req.body.branch || '')}&${q(r)}#waiting`);
    } catch (err) { next(err); }
  });

  return router;
}

module.exports = { branchMeasureRoutes };
