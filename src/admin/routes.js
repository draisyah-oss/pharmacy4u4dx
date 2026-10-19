// Admin screens: /admin, /admin/targets, /admin/people, /admin/measures, /admin/audit,
// /admin/export/<branch|group>.xlsx. Admin only; every change goes to the audit log.

const express = require('express');
const { requireAdmin, back } = require('./common');
const { loadBranch } = require('../daily/data');
const T = require('./targets');
const P = require('./people');
const M = require('./measures');
const { branchWorkbook, groupWorkbook } = require('./export');

function adminRoutes(db, { now, salesSheet }) {
  const router = express.Router();
  router.use('/admin', requireAdmin);

  const branches = async () => (await db.query('SELECT id, code, name FROM branches WHERE active ORDER BY sort_order')).rows;
  const flash = (req) => ({ ok: req.query.ok || null, err: req.query.err || null });
  // ?branch=WM, or HQ where the page has an HQ view; defaults to the first branch.
  async function pick(req, { allowHq = false } = {}) {
    const list = await branches();
    if (allowHq && req.query.branch === 'HQ') return { list, branch: null, hq: true };
    const branch = (req.query.branch && (await loadBranch(db, req.query.branch))) || (await loadBranch(db, list[0].code));
    return { list, branch, hq: false };
  }
  const wrap = (fn) => (req, res, next) => fn(req, res).catch(next);

  router.get('/admin', wrap(async (req, res) => {
    const counts = (await db.query(`
      SELECT (SELECT count(*)::int FROM users WHERE active) AS logins,
             (SELECT count(*)::int FROM users WHERE active AND pin_hash IS NULL AND password_hash IS NULL) AS no_login,
             (SELECT count(*)::int FROM users WHERE locked_until > now()) AS locked,
             (SELECT count(*)::int FROM measures WHERE active) AS measures,
             (SELECT count(*)::int FROM audit_log WHERE at > now() - interval '7 days') AS changes_week`)).rows[0];
    const sheet = salesSheet ? await salesSheet.status() : null;
    res.render('admin/hub', { title: 'Admin', branches: await branches(), counts, sheet, ...flash(req) });
  }));

  // ── Targets ──
  router.get('/admin/targets', wrap(async (req, res) => {
    const { list, branch, hq } = await pick(req, { allowHq: true });
    const data = hq ? await T.loadHqTargets(db) : await T.loadBranchTargets(db, branch);
    res.render('admin/targets', { title: 'Targets', list, branch, hq, data, ...flash(req), errors: [] });
  }));
  router.post('/admin/targets', wrap(async (req, res) => {
    const hq = req.body.branch === 'HQ';
    const branch = hq ? null : await loadBranch(db, req.body.branch);
    if (!hq && !branch) return back(res, '/admin/targets', { err: 'Pick a branch.' });
    const result = hq ? await T.saveHqTargets(db, { body: req.body, user: req.user })
      : await T.saveBranchTargets(db, { branch, body: req.body, user: req.user });
    const path = `/admin/targets?branch=${hq ? 'HQ' : encodeURIComponent(branch.code)}`;
    if (result.errors.length) {
      const data = hq ? await T.loadHqTargets(db) : await T.loadBranchTargets(db, branch);
      // Show what was typed, not what's stored, so nothing has to be typed twice.
      for (const m of data.measures) {
        for (const mo of data.months) {
          const t = req.body[hq ? 'h' : 't']?.[`m${m.id}`]?.[mo];
          const w = req.body.w?.[`m${m.id}`]?.[mo];
          if (t !== undefined) m.cells[mo].target = t;
          if (w !== undefined) m.cells[mo].weekend = w;
        }
      }
      return res.status(422).render('admin/targets', { title: 'Targets', list: await branches(), branch, hq, data, ok: null, err: null, errors: result.errors });
    }
    back(res, path, { ok: result.changes ? `Saved ${result.changes} target${result.changes === 1 ? '' : 's'}. Scoreboards use them straight away.` : 'No changes.' });
  }));

  // ── People & logins ──
  router.get('/admin/people', wrap(async (req, res) => {
    const { list, branch, hq } = await pick(req, { allowHq: true });
    res.render('admin/people', {
      title: 'People & logins', list, branch, hq, people: await P.loadPeople(db, branch),
      admin: hq ? await P.adminUser(db) : null, admins: hq ? await P.adminUsers(db) : [], ...flash(req),
    });
  }));
  const peoplePath = (req) => `/admin/people?branch=${encodeURIComponent(req.body.branch || '')}`;
  router.post('/admin/people', wrap(async (req, res) => {
    const branch = req.body.branch === 'HQ' ? null : await loadBranch(db, req.body.branch);
    back(res, peoplePath(req), await P.addPerson(db, { branch, body: req.body, user: req.user }));
  }));
  router.post('/admin/people/:id', wrap(async (req, res) => {
    back(res, peoplePath(req), await P.updatePerson(db, { personId: Number(req.params.id), body: req.body, user: req.user }));
  }));
  router.post('/admin/people/:id/active', wrap(async (req, res) => {
    back(res, peoplePath(req), await P.setActive(db, { personId: Number(req.params.id), active: req.body.active === 'true', user: req.user }));
  }));
  router.post('/admin/users/:id/secret', wrap(async (req, res) => {
    back(res, peoplePath(req), await P.setSecret(db, { userId: Number(req.params.id), secret: req.body.secret, user: req.user, currentSessionId: req.sessionId }));
  }));
  router.post('/admin/users/:id/unlock', wrap(async (req, res) => {
    back(res, peoplePath(req), await P.unlock(db, { userId: Number(req.params.id), user: req.user }));
  }));

  // ── Measures & daily fields ──
  router.get('/admin/measures', wrap(async (req, res) => {
    const { list, branch } = await pick(req);
    res.render('admin/measures', {
      title: 'Measures & daily fields', list, branch, data: await M.loadMeasuresAdmin(db, branch),
      KINDS: M.KINDS, TARGET_PER: M.TARGET_PER, CALCS: M.CALCS, FIELD_TYPES: M.FIELD_TYPES, ...flash(req),
    });
  }));
  async function withBranch(req, res, fn) {
    const branch = await loadBranch(db, req.body.branch);
    if (!branch) return back(res, '/admin/measures', { err: 'Pick a branch.' });
    const result = await fn(branch);
    back(res, `/admin/measures?branch=${encodeURIComponent(branch.code)}${req.body.anchor ? `#${req.body.anchor}` : ''}`, result);
  }
  router.post('/admin/measures', wrap((req, res) => withBranch(req, res, (branch) => M.addMeasure(db, { branch, body: req.body, user: req.user }))));
  router.post('/admin/measures/:id', wrap((req, res) => withBranch(req, res, (branch) => M.updateMeasure(db, { branch, measureId: req.params.id, body: req.body, user: req.user }))));
  router.post('/admin/measures/:id/active', wrap((req, res) => withBranch(req, res, (branch) => M.setMeasureActive(db, { branch, measureId: Number(req.params.id), active: req.body.active === 'true', user: req.user }))));
  router.post('/admin/fields', wrap((req, res) => withBranch(req, res, (branch) => M.addField(db, { branch, body: req.body, user: req.user }))));
  router.post('/admin/fields/:id', wrap((req, res) => withBranch(req, res, (branch) => M.updateField(db, { branch, fieldId: req.params.id, body: req.body, user: req.user }))));
  router.post('/admin/fields/:id/active', wrap((req, res) => withBranch(req, res, (branch) => M.setFieldActive(db, { branch, fieldId: Number(req.params.id), active: req.body.active === 'true', user: req.user }))));

  // ── Audit log ──
  router.get('/admin/audit', wrap(async (req, res) => {
    const PAGE = 100;
    const page = Math.max(1, Number(req.query.page) || 1);
    const filters = [];
    const params = [];
    if (req.query.q) { params.push(`%${req.query.q}%`); filters.push(`(a.record_key ILIKE $${params.length} OR a.action ILIKE $${params.length})`); }
    if (req.query.who) { params.push(req.query.who); filters.push(`u.username = $${params.length}`); }
    const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
    const rows = (await db.query(
      `SELECT a.id, a.at, a.action, a.table_name, a.record_key, a.old_value::text AS old_value, a.new_value::text AS new_value,
              COALESCE(u.display_name, CASE WHEN a.action LIKE 'sheet%' THEN 'Sales sheet' ELSE 'System' END) AS who
       FROM audit_log a LEFT JOIN users u ON u.id = a.user_id ${where}
       ORDER BY a.id DESC LIMIT ${PAGE + 1} OFFSET ${(page - 1) * PAGE}`, params)).rows;
    const users = (await db.query('SELECT username, display_name FROM users ORDER BY display_name')).rows;
    res.render('admin/audit', { title: 'Audit log', rows: rows.slice(0, PAGE), more: rows.length > PAGE, page, q: req.query.q || '', who: req.query.who || '', users });
  }));

  // ── Export to Excel ──
  router.get('/admin/export/:name.xlsx', wrap(async (req, res) => {
    const out = req.params.name === 'group' ? await groupWorkbook(db, { now }) : await branchWorkbook(db, req.params.name, { now });
    if (!out) return res.status(404).render('message', { title: 'Not found', message: 'No branch with that code.' });
    await db.query(
      `INSERT INTO audit_log (user_id, action, table_name, record_key) VALUES ($1, 'export', NULL, $2)`, [req.user.id, out.filename]);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${out.filename}"`);
    await out.wb.xlsx.write(res);
    res.end();
  }));

  return router;
}

module.exports = { adminRoutes };
