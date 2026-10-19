// HQ day (daily tasks), HQ commitments and HQ projects.

const express = require('express');
const calc = require('../calc');
const fmt = require('../scoreboard/format');
const team = require('./team');
const wikilist = require('./wikilist');
const wig = require('../wig/data');
const { dateStrip } = require('../daily/rules');
const { isRealDate } = require('../lib/dates');
const { weekChoices, pickWeek } = require('../lib/weeks');

const isHqUser = (user) => ['hq', 'hq_staff', 'admin'].includes(user.role);

function hqTeamRoutes(db, { now, trackerStart }) {
  const router = express.Router();
  const deny = (res) => res.status(403).render('message', { title: 'HQ only', message: 'This page is for the HQ team and admin.' });
  const flash = (req) => ({ ok: req.query.ok || null, err: req.query.err || null });
  const msg = (r, okText) => (r.error ? `err=${encodeURIComponent(r.error)}` : `ok=${encodeURIComponent(r.ok || okText)}`);

  async function whoAndWhen(req) {
    const user = req.user;
    const today = calc.todayInMalaysia(now());
    const start = await trackerStart();
    const people = await team.visiblePeople(db, user);
    const askedId = Number(req.query.person || req.body?.person);
    let person = people.find((p) => p.id === askedId)
      || people.find((p) => p.id === user.person_id)
      || null;
    if (!person && user.role === 'admin') {
      // Admin has no HQ person of their own: start with someone who has daily tasks.
      const withTasks = (await db.query('SELECT DISTINCT person_id FROM hq_daily_tasks WHERE active')).rows.map((r) => r.person_id);
      person = people.find((p) => withTasks.includes(p.id)) || people[0] || null;
    }
    let date = req.query.date || req.body?.date || today;
    if (!isRealDate(date) || date > today) date = today;
    return { user, today, start, people, person, date };
  }

  // ─────────────── My day / HQ day ───────────────

  async function renderDay(req, res, ctx) {
    const page = await team.loadDayPage(db, { person: ctx.person, date: ctx.date, today: ctx.today });
    const focus = await wig.loadFocus(db, calc.weekStart(ctx.date), ctx.person.id);
    const actions = (await wig.openActionsFor(db, ctx.person.id)).map((a) => ({ ...a, canClose: wig.canCloseAction(req.user, a) }));
    res.render('hq-today', {
      title: ctx.person.id === req.user.person_id ? 'My day' : `${ctx.person.name} – daily tasks`, ...ctx, ...page, fmt, focus, actions,
      strip: dateStrip(ctx.today, ctx.start).map((d) => ({ date: d, filled: page.filled.has(d) })),
      blocked: team.dayEditDenied(req.user, ctx.person.id, ctx.date, ctx.today, ctx.start),
      canManage: team.canActFor(req.user, ctx.person.id), ...flash(req),
    });
  }

  router.get('/hq/today', async (req, res, next) => {
    try {
      if (!isHqUser(req.user)) return deny(res);
      const ctx = await whoAndWhen(req);
      if (!ctx.person) return res.render('message', { title: 'My day', message: 'Your login isn’t linked to an HQ person yet – ask admin.' });
      await renderDay(req, res, ctx);
    } catch (err) { next(err); }
  });

  router.post('/hq/today', async (req, res, next) => {
    try {
      if (!isHqUser(req.user)) return deny(res);
      const ctx = await whoAndWhen(req);
      if (!ctx.person || Number(req.body.person) !== ctx.person.id) return deny(res);
      const blocked = team.dayEditDenied(req.user, ctx.person.id, ctx.date, ctx.today, ctx.start);
      if (blocked) return res.status(403).render('message', { title: 'Can’t save', message: blocked });
      const r = await team.saveTicks(db, req.user, { person: ctx.person, date: ctx.date, body: req.body });
      res.redirect(`/hq/today?person=${ctx.person.id}&date=${ctx.date}&ok=${encodeURIComponent(r.saved ? 'Saved.' : 'No changes to save.')}`);
    } catch (err) { next(err); }
  });

  router.post('/hq/today/tasks', async (req, res, next) => {
    try {
      if (!isHqUser(req.user)) return deny(res);
      const ctx = await whoAndWhen(req);
      if (!ctx.person || Number(req.body.person) !== ctx.person.id || !team.canActFor(req.user, ctx.person.id)) return deny(res);
      const r = req.body.retire
        ? await team.retireTask(db, req.user, { person: ctx.person, taskId: Number(req.body.retire) })
        : await team.addTask(db, req.user, { person: ctx.person, label: req.body.label });
      res.redirect(`/hq/today?person=${ctx.person.id}&date=${ctx.date}&${msg(r, 'Saved.')}#tasks`);
    } catch (err) { next(err); }
  });

  // ─────────────── HQ commitments ───────────────

  async function commitContext(req) {
    const today = calc.todayInMalaysia(now());
    const start = await trackerStart();
    const weeks = weekChoices(start, today);
    const week = pickWeek(req.query.week || req.body?.week, weeks, weeks[weeks.length - 1]);
    return { today, start, weeks, week };
  }

  async function renderCommitments(req, res, ctx, extra = {}) {
    const people = await team.visiblePeople(db, req.user);
    const prev = calc.addDays(ctx.week, -7);
    const ids = new Set(people.map((p) => p.id));
    const last = (await team.loadCommitmentWeek(db, prev)).filter((c) => ids.has(c.person_id));
    // Up to 2 commitments a person (slot 1, 2): key `${person}|${slot}`.
    const current = new Map((await team.loadCommitmentWeek(db, ctx.week)).filter((c) => ids.has(c.person_id)).map((c) => [`${c.person_id}|${c.slot || 1}`, c]));
    const moves = new Map();
    for (const p of people) moves.set(p.id, await team.movesFor(db, p));
    const thisWeek = calc.weekStart(ctx.today);
    const tooOld = req.user.role !== 'admin' && ctx.week < calc.addDays(thisWeek, -7);
    const [focus, lastFocus, branchActions] = await Promise.all([
      wig.loadFocusWeek(db, ctx.week), wig.loadFocusWeek(db, prev), wig.loadActions(db, { week: calc.addDays(ctx.week, -14) }),
    ]);
    const openActions = new Map();
    for (const p of people) openActions.set(p.id, await wig.openActionsFor(db, p.id));
    res.status(extra.status || 200).render('hq-commitments', {
      title: 'HQ WIG session', ...ctx, prev, people, last, current, moves, fmt, kept: team.keptSummary(last),
      focus, lastFocus, openActions, branchActionSummary: wig.actionSummary(branchActions), ceo: wig.canApproveFocus(req.user),
      canActFor: (id) => !tooOld && team.canActFor(req.user, id), tooOld,
      pills: ctx.weeks.map((w) => ({ href: `/hq/commitments?week=${w}`, current: w === ctx.week, label: w === thisWeek ? 'This week' : fmt.weekLabel(w, calc.addDays(w, 6)) })),
      weekEnd: calc.addDays(ctx.week, 6), typed: extra.typed || null, errors: extra.errors || {},
      ok: req.query.ok || null, err: extra.err || null,
    });
  }

  router.get('/hq/commitments', async (req, res, next) => {
    try {
      if (!isHqUser(req.user)) return deny(res);
      await renderCommitments(req, res, await commitContext(req));
    } catch (err) { next(err); }
  });

  router.post('/hq/commitments', async (req, res, next) => {
    try {
      if (!isHqUser(req.user)) return deny(res);
      const ctx = await commitContext(req);
      if (!ctx.weeks.includes(req.body.week)) return res.status(400).render('message', { title: 'Can’t save', message: 'That week isn’t one that can be changed.' });
      if (req.user.role !== 'admin' && ctx.week < calc.addDays(calc.weekStart(ctx.today), -7)) {
        return res.status(403).render('message', { title: 'Can’t save', message: 'Only this week and last week can be changed. Ask admin to fix older weeks.' });
      }
      const people = await team.visiblePeople(db, req.user);
      const f = await wig.saveFocus(db, req.user, { week: ctx.week, body: req.body, people, canActFor: (id) => team.canActFor(req.user, id) });
      if (f.errors) {
        const errors = Object.fromEntries(Object.entries(f.errors).map(([k, v]) => [`f${k}`, v]));
        return renderCommitments(req, res, ctx, { status: 400, errors, typed: req.body, err: 'Nothing saved – fix the boxes in red.' });
      }
      const r = await team.saveCommitments(db, req.user, { week: ctx.week, body: req.body, people });
      if (r.errors) return renderCommitments(req, res, ctx, { status: 400, errors: r.errors, typed: req.body, err: 'Focus saved – fix the commitments in red.' });
      res.redirect(`/hq/commitments?week=${ctx.week}&ok=${encodeURIComponent(r.saved || f.saved ? 'Saved.' : 'No changes to save.')}`);
    } catch (err) { next(err); }
  });

  // ─────────────── Projects ───────────────

  // ─────────────── Company wiki checklist ───────────────
  router.get('/hq/wiki', async (req, res, next) => {
    try {
      if (req.user.role !== 'hq' && req.user.role !== 'admin') return deny(res);
      const today = calc.todayInMalaysia(now());
      const items = await wikilist.load(db, { today });
      const show = ['mine', 'open', 'all'].includes(req.query.show) ? req.query.show : 'all';
      const visible = items.filter((it) => show === 'all' || (show === 'mine' ? it.person_id === req.user.person_id : it.status !== 'Approved'));
      const approver = await wikilist.approverId(db);
      for (const it of visible) it.canChange = wikilist.canChange(req.user, it, approver);
      res.render('hq-wiki', {
        title: 'Company wiki checklist', summary: wikilist.summarise(items), sum2: wikilist.summarise(visible), items: visible, show,
        statuses: wikilist.STATUSES, today, fmt, ...flash(req),
        canApprove: req.user.role === 'admin' || wikilist.isApprover(req.user, approver),
      });
    } catch (err) { next(err); }
  });

  router.post('/hq/wiki/:id', async (req, res, next) => {
    try {
      if (req.user.role !== 'hq' && req.user.role !== 'admin') return deny(res);
      if (!/^\d{1,9}$/.test(req.params.id)) return deny(res);
      const r = await wikilist.update(db, req.user, Number(req.params.id), req.body, { at: now() });
      const back = `/hq/wiki${req.body.show ? `?show=${encodeURIComponent(req.body.show)}&` : '?'}`;
      if (r.error) return res.redirect(`${back}err=${encodeURIComponent(r.error)}`);
      res.redirect(`${back}ok=${encodeURIComponent(r.saved ? `${r.item.title}: ${r.status}.` : 'No change.')}#w-${req.params.id}`);
    } catch (err) { next(err); }
  });

  router.get('/hq/projects', async (req, res, next) => {
    try {
      if (!isHqUser(req.user)) return deny(res);
      const today = calc.todayInMalaysia(now());
      let projects = await team.loadProjects(db);
      // HQ staff see the milestones they own; full HQ and admin see all.
      if (req.user.role === 'hq_staff') projects = projects.filter((p) => team.ownsProject(p, req.user.display_name));
      const groups = [];
      for (const p of projects) {
        let g = groups.find((x) => x.project === p.project);
        if (!g) groups.push(g = { project: p.project, rows: [] });
        g.rows.push({ ...p, state: team.projectState(p, today), canEdit: team.canEditProject(req.user, p) });
      }
      res.render('hq-projects', {
        title: 'Projects', groups, today, statuses: team.PROJECT_STATUSES, fmt,
        canAdd: req.user.role === 'admin' || req.user.role === 'hq', staff: req.user.role === 'hq_staff', ...flash(req),
      });
    } catch (err) { next(err); }
  });

  router.post('/hq/projects', async (req, res, next) => {
    try {
      if (req.user.role !== 'admin' && req.user.role !== 'hq') return deny(res);
      const r = await team.addProject(db, req.user, req.body);
      res.redirect(`/hq/projects?${msg(r, 'Added.')}`);
    } catch (err) { next(err); }
  });

  router.post('/hq/projects/:id', async (req, res, next) => {
    try {
      if (!isHqUser(req.user)) return deny(res);
      const project = /^\d{1,9}$/.test(req.params.id)
        ? (await db.query('SELECT * FROM hq_projects WHERE id = $1 AND active', [req.params.id])).rows[0] : null;
      if (!project) return res.status(404).render('message', { title: 'Not found', message: 'That milestone doesn’t exist.' });
      if (!team.canEditProject(req.user, project)) return res.status(403).render('message', { title: 'Can’t save', message: 'You can only update the milestones you own.' });
      const r = await team.updateProject(db, req.user, project, req.body);
      res.redirect(`/hq/projects?${r.error ? `err=${encodeURIComponent(r.error)}` : `ok=${encodeURIComponent(r.saved ? 'Saved.' : 'No changes to save.')}`}#p-${project.id}`);
    } catch (err) { next(err); }
  });

  // Project steps (19 Oct): each milestone's checklist on its own page, opened from the side menu.
  router.get('/hq/projects/:id/steps', async (req, res, next) => {
    try {
      if (!isHqUser(req.user)) return deny(res);
      const today = calc.todayInMalaysia(now());
      const project = /^\d{1,9}$/.test(req.params.id)
        ? (await db.query('SELECT * FROM hq_projects WHERE id = $1 AND active', [req.params.id])).rows[0] : null;
      if (!project) return res.status(404).render('message', { title: 'Not found', message: 'That milestone doesn’t exist.' });
      const rows = await team.loadSteps(db, [project.id]);
      if (req.user.role === 'hq_staff' && !team.ownsProject(project, req.user.display_name)
        && !rows.some((s) => team.ownsStep(s, req.user.display_name))) {
        return res.status(403).render('message', { title: 'Not yours', message: 'You can see the checklists of the milestones you own.' });
      }
      const canEdit = team.canEditProject(req.user, project);
      const steps = team.stepSummary(rows, today);
      for (const ph of steps.phases) for (const st of ph.steps) st.canTick = team.canTickStep(req.user, project, st);
      res.render('hq-steps', { title: project.milestone, p: { ...project, canEdit, steps }, ...flash(req) });
    } catch (err) { next(err); }
  });

  // Project steps (19 Oct): add a step to a milestone; tick / untick / remove one.
  router.post('/hq/projects/:id/steps', async (req, res, next) => {
    try {
      if (!isHqUser(req.user)) return deny(res);
      const project = /^\d{1,9}$/.test(req.params.id)
        ? (await db.query('SELECT * FROM hq_projects WHERE id = $1 AND active', [req.params.id])).rows[0] : null;
      if (!project) return res.status(404).render('message', { title: 'Not found', message: 'That milestone doesn’t exist.' });
      if (!team.canEditProject(req.user, project)) return res.status(403).render('message', { title: 'Can’t save', message: 'You can only add steps to the milestones you own.' });
      const r = await team.addStep(db, req.user, project, req.body);
      res.redirect(`/hq/projects/${project.id}/steps?${msg(r, 'Step added.')}`);
    } catch (err) { next(err); }
  });

  router.post('/hq/projects/steps/:sid', async (req, res, next) => {
    try {
      if (!isHqUser(req.user)) return deny(res);
      const step = /^\d{1,9}$/.test(req.params.sid)
        ? (await db.query('SELECT * FROM hq_project_steps WHERE id = $1 AND active', [req.params.sid])).rows[0] : null;
      const project = step ? (await db.query('SELECT * FROM hq_projects WHERE id = $1 AND active', [step.project_id])).rows[0] : null;
      if (!step || !project) return res.status(404).render('message', { title: 'Not found', message: 'That step doesn’t exist.' });
      const back = (q) => res.redirect(`/hq/projects/${project.id}/steps?${q}#s-${step.id}`);
      if (req.body.action === 'remove') {
        if (!team.canEditProject(req.user, project)) return res.status(403).render('message', { title: 'Can’t save', message: 'Only the milestone’s owners can remove a step.' });
        return back(msg(await team.removeStep(db, req.user, step), 'Step removed.'));
      }
      if (!['done', 'undo'].includes(req.body.action)) return back(`err=${encodeURIComponent('Pick Done or Undo.')}`);
      if (!team.canTickStep(req.user, project, step)) return res.status(403).render('message', { title: 'Can’t save', message: 'You can only tick your own steps.' });
      const r = await team.tickStep(db, req.user, step, req.body.action === 'done', now());
      back(`ok=${encodeURIComponent(r.saved ? (r.done ? 'Step done.' : 'Step reopened.') : 'No change.')}`);
    } catch (err) { next(err); }
  });

  return router;
}

module.exports = { hqTeamRoutes };
