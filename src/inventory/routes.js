// /inventory – Ordering & payments (3 Nov, CEO). See src/inventory/data.js.
//   GET  /inventory?view=&q=&date=            the board (view: all / urgent / transfer / order_now / check / wait / asking / recount / done)
//   POST /inventory/lines/:id                 tick a daily plan line done / not done {done}   – inventory team + admin
//   POST /inventory/payments/:id/approve      {approved: Yes / Partial / No / '', amount}      – the CEO (admin)
//   POST /inventory/payments/:id/paid         {date_paid, pv_no} or {undo: 1}                  – payments team (Azwani) + admin
//   POST /inventory/payments                  add a payment line {week, pay_date, supplier, proposed, notes} – payments team + admin
// Agent API (Mr Eve, bearer token – src/requests/routes.js agentApi): GET /api/agent/inventory,
//   POST /api/agent/inventory/plan, /api/agent/inventory/payments, /api/agent/inventory/month.

const express = require('express');
const calc = require('../calc');
const inv = require('./data');

function inventoryRoutes(db, { now }) {
  const router = express.Router();
  const deny = (res) => res.status(403).render('message', { title: 'Not available', message: 'Ordering & payments is for the inventory team, Azwani and Dr Aisyah.' });
  const back = (req, res, msg, kind = 'ok') => {
    const q = new URLSearchParams();
    for (const k of ['view', 'q', 'date']) if (req.body && req.body[k]) q.set(k, req.body[k]);
    q.set(kind, msg);
    res.redirect(303, `/inventory?${q.toString()}${req.body && req.body.at ? '#' + encodeURIComponent(req.body.at) : ''}`);
  };

  router.get('/inventory', async (req, res, next) => {
    try {
      if (!inv.canSee(req.user)) return deny(res);
      const today = calc.todayInMalaysia(now());
      const date = /^\d{4}-\d{2}-\d{2}$/.test(req.query.date || '') ? req.query.date : null;
      const data = await inv.loadPage(db, { today, date, view: String(req.query.view || 'all'), q: req.query.q });
      res.render('inventory', { title: 'Ordering & payments', d: data, today, navActive: 'inventory',
        can: { approve: inv.canApprove(req.user), pay: inv.canPay(req.user), tick: inv.canTick(req.user) },
        ok: req.query.ok || null, err: req.query.err || null });
    } catch (err) { next(err); }
  });

  router.post('/inventory/lines/:id', async (req, res, next) => {
    try {
      if (!inv.canTick(req.user)) return deny(res);
      const r = await inv.tick(db, req.user, Number(req.params.id) || 0, req.body.done === '1', { now });
      back(req, res, r.error || (req.body.done === '1' ? 'Ticked done.' : 'Back on the list.'), r.error ? 'err' : 'ok');
    } catch (err) { next(err); }
  });

  router.post('/inventory/payments/:id/approve', async (req, res, next) => {
    try {
      if (!inv.canApprove(req.user)) return deny(res);
      const r = await inv.approve(db, req.user, Number(req.params.id) || 0, req.body, { now });
      back(req, res, r.error || 'Approval saved.', r.error ? 'err' : 'ok');
    } catch (err) { next(err); }
  });

  router.post('/inventory/payments/:id/paid', async (req, res, next) => {
    try {
      if (!inv.canPay(req.user)) return deny(res);
      const r = await inv.markPaid(db, req.user, Number(req.params.id) || 0, req.body, { now });
      back(req, res, r.error || (req.body.undo === '1' ? 'Marked not paid.' : 'Marked paid – write PAID and the PV number in the supplier’s SOA file too.'), r.error ? 'err' : 'ok');
    } catch (err) { next(err); }
  });

  router.post('/inventory/payments', async (req, res, next) => {
    try {
      if (!inv.canPay(req.user)) return deny(res);
      const r = await inv.addPayments(db, req.user.id, [req.body]);
      back(req, res, r.added ? 'Payment line added – waiting for Dr Aisyah’s approval.' : 'Type the supplier and the amount.', r.added ? 'ok' : 'err');
    } catch (err) { next(err); }
  });

  return router;
}

// For the agent API router (already behind the bearer token).
function inventoryAgent(router, db, { now }) {
  router.get('/inventory', async (req, res, next) => {
    try {
      const today = calc.todayInMalaysia(now());
      const d = await inv.loadPage(db, { today });
      res.json({ today, month: d.month, summary: d.S, suppliers: d.suppliers, cash: d.cash,
        payments: d.pay.map(({ approved_by: a, paid_by: b, ...p }) => p), plan: d.plan, lines: d.todo });
    } catch (err) { next(err); }
  });
  router.post('/inventory/plan', async (req, res, next) => {
    try {
      const b = req.body || {};
      const r = await inv.savePlan(db, { date: b.date, title: b.title, rows: b.rows, source: b.source || 'Mr Eve' });
      if (r.error) return res.status(400).json(r);
      res.json(r);
    } catch (err) { next(err); }
  });
  router.post('/inventory/payments', async (req, res, next) => {
    try {
      res.json(await inv.addPayments(db, null, (req.body || {}).rows));
    } catch (err) { next(err); }
  });
  router.post('/inventory/month', async (req, res, next) => {
    try {
      const r = await inv.saveMonthPlan(db, req.body || {});
      if (r.error) return res.status(400).json(r);
      res.json(r);
    } catch (err) { next(err); }
  });
}

module.exports = { inventoryRoutes, inventoryAgent };
