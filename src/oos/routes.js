// Out-of-stock flow pages: /oos (branch), /oos/inbox + /oos/:id (Inventory answers),
// /oos/transfers (Fariz), /oos/scoreboard. See src/oos/data.js for the flow.

const express = require('express');
const calc = require('../calc');
const fmt = require('../scoreboard/format');
const { loadBranch } = require('../daily/data');
const { weekChoices, pickWeek } = require('../lib/weeks');
const oos = require('./data');
const of = require('./format');

function oosRoutes(db, { now, trackerStart }) {
  const router = express.Router();
  const many = (u) => u.role === 'admin' || u.role === 'hq';
  const forbid = (res, message) => res.status(403).render('message', { title: 'Out of stock', message });
  const back = (res, path, msg, kind = 'ok') => res.redirect(`${path}${path.includes('?') ? '&' : '?'}${kind}=${encodeURIComponent(msg)}`);

  async function branchFor(req) {
    const u = req.user;
    const code = many(u) ? (req.query.branch || req.body?.branch) : u.branch_code;
    if (code) return loadBranch(db, code);
    if (many(u)) {
      const first = (await db.query('SELECT code FROM branches WHERE active ORDER BY sort_order LIMIT 1')).rows[0];
      return first ? loadBranch(db, first.code) : null;
    }
    return null;
  }

  // ─────────────── Branch: report + our items ───────────────
  async function renderBranch(req, res, branch, extra = {}) {
    const items = await oos.loadBranchItems(db, branch, { now });
    const branches = many(req.user) ? (await db.query('SELECT code, name FROM branches WHERE active ORDER BY sort_order')).rows : [];
    res.status(extra.status || 200).render('oos-branch', {
      title: `${branch.name} – out of stock`, branch, branches, items, fmt, of, at: now(),
      canReport: oos.canReport(req.user, branch), canClose: oos.canReport(req.user, branch),
      bq: many(req.user) ? `?branch=${encodeURIComponent(branch.code)}` : '',
      typed: extra.typed || {}, errors: extra.errors || {}, ok: req.query.ok || null, err: extra.err || req.query.err || null,
      targets: await oos.targets(db),
    });
  }

  router.get('/oos', async (req, res, next) => {
    try {
      if (req.user.role === 'hq_staff') return res.redirect('/oos/transfers');
      const branch = await branchFor(req);
      if (!branch) return res.redirect('/');
      if (!many(req.user) && req.user.branch_id !== branch.id) return forbid(res, 'You can only open your own branch.');
      await renderBranch(req, res, branch);
    } catch (err) { next(err); }
  });

  router.post('/oos', async (req, res, next) => {
    try {
      const branch = await branchFor(req);
      if (!branch || !oos.canReport(req.user, branch)) return forbid(res, 'Only this branch’s staff can report its out-of-stock items.');
      const r = await oos.report(db, req.user, branch, req.body, { now });
      if (r.errors) return renderBranch(req, res, branch, { status: 400, errors: r.errors, typed: req.body, err: 'Not sent – check the boxes in red.' });
      back(res, `/oos${many(req.user) ? `?branch=${encodeURIComponent(branch.code)}` : ''}`, `Sent to Inventory: ${String(req.body.item).trim()}.`);
    } catch (err) { next(err); }
  });

  async function itemOr404(req, res) {
    const item = await oos.loadItem(db, req.params.id);
    if (!item) res.status(404).render('message', { title: 'Not found', message: 'That item isn’t on the list.' });
    return item;
  }

  router.post('/oos/:id/received', async (req, res, next) => {
    try {
      const item = await itemOr404(req, res); if (!item) return;
      if (!oos.canReport(req.user, { id: item.branch_id })) return forbid(res, 'Only the branch that reported it can close it.');
      await oos.markReceived(db, req.user, item, { now });
      back(res, `/oos${many(req.user) ? `?branch=${encodeURIComponent(item.branch_code)}` : ''}`, `${item.item}: back in stock.`);
    } catch (err) { next(err); }
  });

  router.post('/oos/:id/late', async (req, res, next) => {
    try {
      const item = await itemOr404(req, res); if (!item) return;
      if (!oos.canReport(req.user, { id: item.branch_id })) return forbid(res, 'Only the branch that reported it can do this.');
      await oos.flagLate(db, req.user, item, { now });
      back(res, `/oos${many(req.user) ? `?branch=${encodeURIComponent(item.branch_code)}` : ''}`, `Inventory has been told ${item.item} is late.`);
    } catch (err) { next(err); }
  });

  // ─────────────── Inventory: inbox + answer ───────────────
  router.get('/oos/inbox', async (req, res, next) => {
    try {
      if (!oos.canAnswer(req.user)) return forbid(res, 'The out-of-stock inbox is for the inventory team (Alia, Syarafana, Fariz) and admin.');
      const inbox = await oos.loadInbox(db, { now });
      res.render('oos-inbox', { title: 'Out of stock – inbox', ...inbox, fmt, of, tab: ['waiting', 'done'].includes(req.query.tab) ? req.query.tab : 'answer', ok: req.query.ok || null, at: now() });
    } catch (err) { next(err); }
  });

  async function renderAnswer(req, res, item, extra = {}) {
    const branches = (await db.query('SELECT code, name FROM branches WHERE active AND id <> $1 ORDER BY sort_order', [item.branch_id])).rows;
    const today = calc.todayInMalaysia(now());
    const history = (await db.query(
      `SELECT reported_at, status, answer FROM oos_items WHERE branch_id = $1 AND lower(item) = lower($2) AND id <> $3 ORDER BY reported_at DESC LIMIT 3`,
      [item.branch_id, item.item, item.id])).rows;
    res.status(extra.status || 200).render('oos-answer', {
      title: `Answer – ${item.item}`, item, branches, history, fmt, of, today,
      tomorrow: calc.addDays(today, 1), typed: extra.typed || {}, err: extra.err || null, at: now(),
    });
  }

  router.get('/oos/:id', async (req, res, next) => {
    try {
      if (!/^\d{1,9}$/.test(req.params.id)) return next();
      if (!oos.canAnswer(req.user)) return forbid(res, 'Answering out-of-stock items is for the inventory team and admin.');
      const item = await itemOr404(req, res); if (!item) return;
      await renderAnswer(req, res, item);
    } catch (err) { next(err); }
  });

  router.post('/oos/:id/answer', async (req, res, next) => {
    try {
      if (!oos.canAnswer(req.user)) return forbid(res, 'Answering out-of-stock items is for the inventory team and admin.');
      const item = await itemOr404(req, res); if (!item) return;
      const r = await oos.answerItem(db, req.user, item, req.body, { now });
      if (r.error) return renderAnswer(req, res, item, { status: 400, typed: req.body, err: r.error });
      back(res, '/oos/inbox', `${item.item} (${item.branch_code}): answered.`);
    } catch (err) { next(err); }
  });

  // ─────────────── Transfers (Fariz) ───────────────
  router.get('/oos/transfers', async (req, res, next) => {
    try {
      if (!oos.canSend(req.user)) return forbid(res, 'Transfers are for the inventory team (Alia, Syarafana, Fariz).');
      const t = await oos.loadTransfers(db, { now });
      res.render('oos-transfers', { title: 'Transfers to send', ...t, fmt, of, ok: req.query.ok || null, at: now() });
    } catch (err) { next(err); }
  });

  router.post('/oos/:id/:step', async (req, res, next) => {
    try {
      if (!['picked', 'sent'].includes(req.params.step)) return next();
      if (!oos.canSend(req.user)) return forbid(res, 'Transfers are for the inventory team (Alia, Syarafana, Fariz).');
      const item = await itemOr404(req, res); if (!item) return;
      const r = await oos.markTransfer(db, req.user, item, req.params.step, { now });
      if (r.error) return back(res, '/oos/transfers', r.error, 'err');
      back(res, '/oos/transfers', `${item.item} → ${item.branch_code}: ${req.params.step}.`);
    } catch (err) { next(err); }
  });

  // ─────────────── Scoreboard ───────────────
  router.get('/oos/scoreboard', async (req, res, next) => {
    try {
      if (!oos.canSeeBoard(req.user)) return forbid(res, 'The out-of-stock scoreboard is for managers and HQ.');
      const today = calc.todayInMalaysia(now());
      const weeks = weekChoices(await trackerStart(), today);
      const current = weeks[weeks.length - 1];
      const week = pickWeek(req.query.week, weeks, current);
      const board = await oos.buildBoard(db, { week, now });
      res.render('oos-board', {
        title: 'Out-of-stock scoreboard', board, week, weekEnd: calc.addDays(week, 6), fmt, of,
        pills: weeks.map((w) => ({ href: `/oos/scoreboard?week=${w}`, current: w === week, label: w === current ? 'This week' : fmt.weekLabel(w, calc.addDays(w, 6)) })),
      });
    } catch (err) { next(err); }
  });

  return router;
}

module.exports = { oosRoutes };
