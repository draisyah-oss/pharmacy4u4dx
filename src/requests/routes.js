// 28 Oct: "Request a change" pages (/requests) and the agent API Mr 4DX uses (/api/agent/…).
const crypto = require('crypto');
const express = require('express');
const rq = require('./data');
const of = require('../oos/format');

function requestRoutes(db, { now }) {
  const router = express.Router();
  const back = (res, path, msg, kind = 'ok') => res.redirect(`${path}${path.includes('?') ? '&' : '?'}${kind}=${encodeURIComponent(msg)}`);

  async function renderList(req, res, extra = {}) {
    const { open, done } = await rq.list(db);
    res.status(extra.status || 200).render('requests', {
      title: 'Request a change', open, done, areas: rq.AREAS, of, at: now(),
      typed: extra.typed || {}, errors: extra.errors || {}, ok: req.query.ok || null, err: extra.err || req.query.err || null,
    });
  }

  router.get('/requests', async (req, res, next) => { try { await renderList(req, res); } catch (err) { next(err); } });

  router.post('/requests', async (req, res, next) => {
    try {
      const r = await rq.create(db, req.user, req.body, { now });
      if (r.errors) return renderList(req, res, { status: 400, errors: r.errors, typed: req.body, err: 'Not sent – check the boxes in red.' });
      back(res, `/requests/${r.id}`, 'Sent. Mr 4DX will plan it; you’ll check a preview before anything changes, and Dr Aisyah approves it.');
    } catch (err) { next(err); }
  });

  router.get('/requests/:id', async (req, res, next) => {
    try {
      const r = await rq.load(db, req.params.id);
      if (!r) return res.status(404).render('message', { title: 'Not found', message: 'That request isn’t on the list.' });
      res.render('request', { title: `Change #${r.id}`, r, can: rq.actionsFor(req.user, r), statuses: rq.STATUSES, of, at: now(), ok: req.query.ok || null, err: req.query.err || null });
    } catch (err) { next(err); }
  });

  router.post('/requests/:id/note', async (req, res, next) => {
    try {
      const r = await rq.load(db, req.params.id);
      if (!r) return res.status(404).render('message', { title: 'Not found', message: 'That request isn’t on the list.' });
      const out = await rq.addNote(db, req.user, r, req.body.message);
      if (out.error) return back(res, `/requests/${r.id}`, out.error, 'err');
      back(res, `/requests/${r.id}`, 'Message added.');
    } catch (err) { next(err); }
  });

  router.post('/requests/:id/act', async (req, res, next) => {
    try {
      const r = await rq.load(db, req.params.id);
      if (!r) return res.status(404).render('message', { title: 'Not found', message: 'That request isn’t on the list.' });
      const out = await rq.act(db, req.user, r, String(req.body.action || ''), req.body.message, { now });
      if (out.forbidden) return res.status(403).render('message', { title: 'Not allowed', message: 'Only the person who asked checks the preview, and only Dr Aisyah approves.' });
      if (out.error) return back(res, `/requests/${r.id}`, out.error, 'err');
      back(res, `/requests/${r.id}`, 'Saved.');
    } catch (err) { next(err); }
  });

  router.post('/requests/:id/status', async (req, res, next) => {
    try {
      if (req.user.role !== 'admin') return res.status(403).render('message', { title: 'Not allowed', message: 'Only admin changes a request’s status.' });
      const r = await rq.load(db, req.params.id);
      if (!r) return res.status(404).render('message', { title: 'Not found', message: 'That request isn’t on the list.' });
      // Approving is the CEO's: other admins can't set Approved / Live from here.
      if (['Approved', 'Live'].includes(req.body.status) && !rq.isCeo(req.user) && r.status !== req.body.status) {
        return back(res, `/requests/${r.id}`, 'Only Dr Aisyah approves – use the Approve button on her login.', 'err');
      }
      const out = await rq.setStatus(db, req.user, r, { status: req.body.status, plan: req.body.plan, preview_url: req.body.preview_url, message: req.body.message }, { now });
      if (out.error) return back(res, `/requests/${r.id}`, out.error, 'err');
      back(res, `/requests/${r.id}`, 'Saved.');
    } catch (err) { next(err); }
  });

  return router;
}

// Agent API for Mr 4DX (Claude working on the code): read the list, post notes, move the status.
// Needs AGENT_API_TOKEN set on Railway; without it the API doesn't exist (404). It can't approve:
// "Approved" is only ever set by the CEO's login.
function agentApi(db, { now }) {
  const router = express.Router();
  router.use(express.json({ limit: '100kb' }));
  router.use((req, res, next) => {
    const token = process.env.AGENT_API_TOKEN;
    if (!token || token.length < 24) return res.status(404).json({ error: 'not found' });
    const got = String(req.get('authorization') || '').replace(/^Bearer\s+/i, '');
    const a = Buffer.from(got); const b = Buffer.from(token);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return res.status(401).json({ error: 'unauthorised' });
    next();
  });
  const AUTHOR = 'Mr 4DX';
  router.get('/requests', async (req, res, next) => {
    try {
      const { open, done } = await rq.list(db);
      const full = await Promise.all(open.map((r) => rq.load(db, r.id)));
      res.json({ open: full.map(({ photo_id: p, ...r }) => ({ ...r, photo: p ? `/oos/photo/${p}` : null })), recentlyClosed: done.slice(0, 20).map((r) => ({ id: r.id, title: r.title, status: r.status })) });
    } catch (err) { next(err); }
  });
  router.post('/requests/:id', async (req, res, next) => {
    try {
      const r = await rq.load(db, req.params.id);
      if (!r) return res.status(404).json({ error: 'not found' });
      const body = req.body || {};
      if (body.status) {
        if (body.status === 'Approved') return res.status(403).json({ error: 'only the CEO approves' });
        if (body.status === 'Live' && r.status !== 'Approved') return res.status(409).json({ error: 'not approved yet' });
        const out = await rq.setStatus(db, null, r, { status: body.status, plan: body.plan, preview_url: body.preview_url, message: body.message }, { now, author: AUTHOR });
        if (out.error) return res.status(400).json(out);
        return res.json({ ok: true });
      }
      const out = await rq.addNote(db, null, r, body.message, AUTHOR);
      if (out.error) return res.status(400).json(out);
      res.json({ ok: true });
    } catch (err) { next(err); }
  });
  router.post('/requests', async (req, res, next) => {
    try {
      // Requests that arrive by WhatsApp later: the bot passes the person's username.
      const u = (await db.query('SELECT * FROM users WHERE username = $1 AND active', [String((req.body || {}).username || '')])).rows[0];
      if (!u) return res.status(400).json({ error: 'unknown username' });
      const out = await rq.create(db, u, req.body, { now, source: 'whatsapp' });
      if (out.errors) return res.status(400).json(out);
      res.json({ ok: true, id: out.id });
    } catch (err) { next(err); }
  });
  return router;
}

module.exports = { requestRoutes, agentApi };
