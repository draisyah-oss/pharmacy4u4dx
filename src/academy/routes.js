// Academy (trial): home, module pages (cards, quiz, role-play, Counter Challenge) and the
// manager page. Open to every logged-in role. Staff see their own scores only.

const express = require('express');
const calc = require('../calc');
const { audit } = require('../admin/common');
const { mentionsSalary, SALARY_MESSAGE } = require('../privacy');
const { isRealDate } = require('../lib/dates');
const data = require('./data');
const ranks = require('./ranks');
const { safePath } = require('../lib/safe-path');

const learner = (u) => u.role === 'branch_staff' || u.role === 'branch_manager';
const canManage = (u) => u.role === 'branch_manager' || u.role === 'admin';
const canSeeManager = (u) => ['branch_manager', 'hq', 'admin'].includes(u.role);

function academyRoutes(db, { now = () => new Date() } = {}) {
  const router = express.Router();
  let ready;
  const ensure = () => (ready || (ready = data.ensureModules(db).catch((e) => { ready = null; throw e; })));
  const today = () => calc.todayInMalaysia(now());

  router.use('/academy', async (req, res, next) => { try { await ensure(); next(); } catch (e) { next(e); } });

  const notFound = (res) => res.status(404).render('message', { title: 'Module not found', message: 'That module is not available.' });
  const view = (res, name, vars) => res.render(name, { navActive: 'academy', ...vars });

  async function moduleAndProgress(req, res) {
    const mod = await data.getModule(db, req.params.code);
    if (!mod) { notFound(res); return null; }
    const prog = await data.progressFor(db, [req.user.id]);
    return { mod, s: prog.get(req.user.id, mod.id) };
  }

  // ───────── Celebrations (level-up, badge, streak bonus, module complete, verified) ─────────
  async function nextCelebration(userId) {
    const aw = await ranks.awards(db, [userId]);
    const sum = ranks.summary(aw, userId, today());
    const shown = new Set((await db.query('SELECT kind, key FROM academy_seen WHERE user_id = $1', [userId])).rows.map((r) => `${r.kind}:${r.key}`));
    const todo = ranks.celebrations(sum, aw).filter((c) => !shown.has(`${c.kind}:${c.key}`))
      .sort((a, b) => ranks.ORDER[a.kind] - ranks.ORDER[b.kind]);
    return { c: todo[0] || null, count: todo.length, sum };
  }
  // Show what was earned on the next page the person opens (never on a form post, so no step is blocked).
  router.use('/academy', async (req, res, next) => {
    try {
      if (req.method !== 'GET' || req.path === '/celebrate' || !learner(req.user) || req.query.skip) return next();
      const { c } = await nextCelebration(req.user.id);
      return c ? res.redirect(`/academy/celebrate?next=${encodeURIComponent(req.originalUrl)}`) : next();
    } catch (err) { return next(err); }
  });
  router.get('/academy/celebrate', async (req, res, next) => {
    try {
      const { c, count, sum } = await nextCelebration(req.user.id);
      const nextUrl = safePath(req.query.next, '/academy');
      if (!c) return res.redirect(nextUrl);
      view(res, 'academy-celebrate', { title: 'Academy', c, count, sum, nextUrl });
    } catch (err) { next(err); }
  });
  router.post('/academy/celebrate', async (req, res, next) => {
    try {
      const { c } = await nextCelebration(req.user.id);
      if (c) await db.query('INSERT INTO academy_seen (user_id, kind, key) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [req.user.id, c.kind, c.key]);
      const nextUrl = safePath(req.body.next, '/academy');
      res.redirect(nextUrl);
    } catch (err) { next(err); }
  });

  // ───────── Home ─────────
  router.get('/academy', async (req, res, next) => {
    try {
      const modules = await data.listModules(db);
      const prog = await data.progressFor(db, [req.user.id]);
      const rows = modules.map((m) => { const s = prog.get(req.user.id, m.id); return { m, s, done: data.isDone(s), xp: data.xpOf(s) }; });
      const xp = rows.reduce((n, r) => n + r.xp, 0);
      const aw = await ranks.awards(db, [req.user.id]);
      const me = ranks.summary(aw, req.user.id, today());
      view(res, 'academy', { title: 'Academy', rows, xp: me.xp, me, showManager: canSeeManager(req.user) });
    } catch (err) { next(err); }
  });

  // ───────── Ranks ─────────
  router.get('/academy/ranks', async (req, res, next) => {
    try {
      const all = (await db.query('SELECT id, code, name FROM branches WHERE active ORDER BY sort_order')).rows;
      const own = req.user.branch_id != null;
      const branch = (own ? all.find((b) => b.id === req.user.branch_id) : all.find((b) => b.code === req.query.branch)) || all[0];
      const users = (await db.query(
        `SELECT id, display_name FROM users WHERE active AND role IN ('branch_staff','branch_manager') AND branch_id = $1`,
        [branch.id])).rows;
      const ids = users.map((u) => u.id).concat([req.user.id]);
      const aw = await ranks.awards(db, ids);
      const t = today();
      const board = users.map((u) => ({ id: u.id, name: u.display_name, ...ranks.summary(aw, u.id, t) }))
        .sort((a, b) => b.week - a.week || b.xp - a.xp || a.name.localeCompare(b.name))
        .map((p, i) => ({ ...p, rank: i + 1 }));
      const meRow = board.find((p) => p.id === req.user.id);
      const goalRow = (await db.query("SELECT value FROM app_settings WHERE key = 'academy_team_goal'")).rows[0];
      const perModule = Object.values(data.XP).reduce((n, x) => n + x, 0); // 80 XP = one full module
      const goal = Number(goalRow && goalRow.value) || Math.max(1, board.length) * perModule;
      const teamXp = board.reduce((n, p) => n + p.week, 0);
      view(res, 'academy-ranks', {
        title: 'Academy: ranks', navActive: 'academyranks', top: board.filter((p) => p.week > 0).slice(0, 3), meRow,
        me: ranks.summary(aw, req.user.id, t), branch, branches: all, pick: !own, weekFrom: ranks.mondayOf(t), meId: req.user.id,
        goal, teamXp, count: board.length,
      });
    } catch (err) { next(err); }
  });

  // ───────── Manager page ─────────
  router.get('/academy/manager', async (req, res, next) => {
    try {
      if (!canSeeManager(req.user)) {
        return res.status(403).render('message', { title: 'Academy', message: 'The Academy manager page is for branch managers, HQ and admin.' });
      }
      const modules = await data.listModules(db);
      const branches = (await db.query(
        `SELECT id, code, name FROM branches WHERE active ${req.user.role === 'branch_manager' ? 'AND id = $1' : ''} ORDER BY sort_order`,
        req.user.role === 'branch_manager' ? [req.user.branch_id] : [])).rows;
      const users = (await db.query(
        `SELECT id, display_name, role, branch_id FROM users
         WHERE active AND role IN ('branch_staff', 'branch_manager') AND branch_id = ANY($1::int[]) ORDER BY display_name`,
        [branches.map((b) => b.id)])).rows;
      const prog = await data.progressFor(db, users.map((u) => u.id));
      const people = users.map((u) => {
        const per = modules.map((m) => ({ m, s: prog.get(u.id, m.id) }));
        return { ...u, per, xp: per.reduce((n, p) => n + data.xpOf(p.s), 0), done: per.filter((p) => data.isDone(p.s)).length };
      });
      const waiting = people.flatMap((p) => p.per.flatMap(({ m, s }) =>
        s.challenges.filter((c) => c.verified === null).map((c) => ({ person: p, m, c }))));
      view(res, 'academy-manager', {
        title: 'Academy: manager', branches, people, modules, waiting, canVerify: canManage(req.user), flash: req.query.verified || '',
      });
    } catch (err) { next(err); }
  });

  router.post('/academy/verify/:id', async (req, res, next) => {
    try {
      if (!canManage(req.user)) {
        return res.status(403).render('message', { title: 'Academy', message: 'Only the branch manager can verify a challenge.' });
      }
      const row = (await db.query(
        `SELECT c.*, u.branch_id AS owner_branch, m.challenge FROM academy_challenges c
         JOIN users u ON u.id = c.user_id JOIN academy_modules m ON m.id = c.module_id WHERE c.id = $1`, [Number(req.params.id) || 0])).rows[0];
      if (!row || row.verified !== null) return res.redirect('/academy/manager');
      if (req.user.role === 'branch_manager' && row.owner_branch !== req.user.branch_id) {
        return res.status(403).render('message', { title: 'Academy', message: 'You can verify challenges from your own branch only.' });
      }
      const items = row.challenge.checks || [];
      const checks = items.map((_, i) => req.body['k' + i] === 'on');
      const ok = checks.filter(Boolean).length >= (row.challenge.needed || items.length);
      await db.query(
        'UPDATE academy_challenges SET verified = $1, checks = $2, verified_by = $3, verified_at = now() WHERE id = $4',
        [ok, JSON.stringify(checks), req.user.id, row.id]);
      await audit(db, req.user, ok ? 'academy_verify' : 'academy_not_verified', 'academy_challenges', String(row.id), null, { checks });
      res.redirect('/academy/manager?verified=' + (ok ? 'yes' : 'no'));
    } catch (err) { next(err); }
  });

  // ───────── Module page + recap cards ─────────
  router.get('/academy/m/:code', async (req, res, next) => {
    try {
      const r = await moduleAndProgress(req, res); if (!r) return;
      view(res, 'academy-module', { title: r.mod.title, mod: r.mod, s: r.s, done: data.isDone(r.s), xp: data.xpOf(r.s), XP: data.XP });
    } catch (err) { next(err); }
  });

  router.post('/academy/m/:code/cards', async (req, res, next) => {
    try {
      const r = await moduleAndProgress(req, res); if (!r) return;
      if (!r.s.cards) await data.record(db, req.user.id, r.mod.id, 'cards', today());
      res.redirect(`/academy/m/${encodeURIComponent(r.mod.code)}`);
    } catch (err) { next(err); }
  });

  // ───────── Quiz ─────────
  const quizBlock = (s) => {
    if (s.quizPassed) return 'You have already passed this quiz.';
    if (s.lastQuiz && !s.lastQuiz.passed && s.lastQuiz.day === today()) {
      return 'Not passed today. You can try again the next working day.';
    }
    return '';
  };

  router.get('/academy/m/:code/quiz', async (req, res, next) => {
    try {
      const r = await moduleAndProgress(req, res); if (!r) return;
      view(res, 'academy-quiz', { title: r.mod.title + ': quiz', mod: r.mod, blocked: quizBlock(r.s), result: null });
    } catch (err) { next(err); }
  });

  router.post('/academy/m/:code/quiz', async (req, res, next) => {
    try {
      const r = await moduleAndProgress(req, res); if (!r) return;
      const blocked = quizBlock(r.s);
      if (blocked) return view(res, 'academy-quiz', { title: r.mod.title + ': quiz', mod: r.mod, blocked, result: null });
      const results = r.mod.questions.map((q, i) => {
        const raw = req.body['q' + i];
        const picked = (Array.isArray(raw) ? raw : raw === undefined ? [] : [raw]).map(Number).filter((n) => Number.isInteger(n)).sort();
        const want = [...q.correct].sort();
        return { q, picked, right: picked.length === want.length && picked.every((v, k) => v === want[k]) };
      });
      const score = results.filter((x) => x.right).length;
      const total = results.length;
      const passed = score / total >= 0.8;
      await data.record(db, req.user.id, r.mod.id, 'quiz', today(), { score, total, passed });
      view(res, 'academy-quiz', { title: r.mod.title + ': quiz', mod: r.mod, blocked: '', result: { results, score, total, passed } });
    } catch (err) { next(err); }
  });

  // ───────── Role-play ─────────
  router.get('/academy/m/:code/roleplay', async (req, res, next) => {
    try {
      const r = await moduleAndProgress(req, res); if (!r) return;
      view(res, 'academy-roleplay', { title: r.mod.title + ': role-play', mod: r.mod, result: null, missing: false });
    } catch (err) { next(err); }
  });

  router.post('/academy/m/:code/roleplay', async (req, res, next) => {
    try {
      const r = await moduleAndProgress(req, res); if (!r) return;
      const rounds = r.mod.roleplay.rounds || [];
      const picks = rounds.map((rd, i) => {
        const n = Number(req.body['r' + i]);
        return Number.isInteger(n) && rd.options[n] ? n : null;
      });
      if (picks.some((p) => p === null)) {
        return view(res, 'academy-roleplay', { title: r.mod.title + ': role-play', mod: r.mod, result: null, missing: true });
      }
      if (!r.s.roleplay) await data.record(db, req.user.id, r.mod.id, 'roleplay', today());
      const result = rounds.map((rd, i) => ({ rd, chosen: rd.options[picks[i]], best: rd.options.find((o) => o.best) }));
      view(res, 'academy-roleplay', { title: r.mod.title + ': role-play', mod: r.mod, result, missing: false });
    } catch (err) { next(err); }
  });

  // ───────── Counter Challenge ─────────
  function cleanEntry(fields, body, todayFn) {
    const entry = {}; const errors = {};
    for (const f of fields) {
      const v = String(body[f.key] ?? '').trim();
      if (f.type === 'select') {
        if (!f.options.includes(v)) errors[f.key] = 'Choose one';
      } else if (f.type === 'number') {
        if (!/^\d{1,3}$/.test(v)) errors[f.key] = 'A whole number, 0 to 999';
      } else if (f.type === 'date') {
        if (!isRealDate(v) || v > todayFn()) errors[f.key] = 'A real date, not in the future';
      } else if (!v || v.length > 80) errors[f.key] = 'Required, up to 80 characters';
      else if (mentionsSalary(v)) errors[f.key] = SALARY_MESSAGE;
      entry[f.key] = f.type === 'number' ? Number(v) || 0 : v;
    }
    return { entry, errors };
  }

  const challengePage = (res, r, extra = {}) => view(res, 'academy-challenge', {
    title: r.mod.title + ': Counter Challenge', mod: r.mod, s: r.s, today: today(), errors: {}, typed: {}, saved: false, ...extra,
  });

  router.get('/academy/m/:code/challenge', async (req, res, next) => {
    try { const r = await moduleAndProgress(req, res); if (r) challengePage(res, r); } catch (err) { next(err); }
  });

  router.post('/academy/m/:code/challenge', async (req, res, next) => {
    try {
      const r = await moduleAndProgress(req, res); if (!r) return;
      const { entry, errors } = cleanEntry(r.mod.challenge.fields || [], req.body, today);
      if (Object.keys(errors).length) return challengePage(res, r, { errors, typed: req.body });
      await db.query('INSERT INTO academy_challenges (user_id, module_id, entry) VALUES ($1,$2,$3)', [req.user.id, r.mod.id, JSON.stringify(entry)]);
      const fresh = await moduleAndProgress(req, res);
      challengePage(res, fresh, { saved: true });
    } catch (err) { next(err); }
  });

  return router;
}

module.exports = { academyRoutes, learner };
