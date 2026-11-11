// /quotations – Zakat quotation (WM), Phase 1 (11 Nov 2026). See ./data.js (who), ./logic.js (rules), ./pdf.js.
//   GET  /quotations                     list of quotes + step 1 (paste a new RFQ)
//   POST /quotations                     new draft from the pasted RFQ → /quotations/:id
//   GET  /quotations/:id                 the 4 steps (RFQ, match, price & stock, output)
//   POST /quotations/:id                 save steps 1–3
//   POST /quotations/:id/generate        take the next QT-WM-YYYY-#### and make the PDF
//   GET  /quotations/:id/pdf             the PDF as issued
//   POST /quotations/:id/copy            new draft from this one
//   POST /quotations/:id/delete          delete a draft
//   GET  /quotations/settings, POST /quotations/settings (+ /signature, /series)  admin & Alia

const express = require('express');
const D = require('./data');
const L = require('./logic');
const { quotationPdf } = require('./pdf');

function quotationRoutes(db, { now }) {
  const router = express.Router();
  const msg = (res, status, text) => res.status(status).render('message', { title: 'Zakat quotation', message: text });
  const back = (res, to, text, kind = 'ok') => res.redirect(303, `${to}${to.includes('?') ? '&' : '?'}${kind}=${encodeURIComponent(text)}`);
  const gate = (req, res, next) => (D.canMake(req.user) ? next() : msg(res, 403, 'Zakat quotations are made by the branch managers and HQ.'));
  const id = (req) => Number(req.params.id) || 0;

  router.get('/quotations', gate, async (req, res, next) => {
    try {
      const outlets = D.outletsFor(req.user);
      const branch = outlets.includes(req.query.branch) ? req.query.branch : '';
      const configs = await D.branchConfigs(db);
      res.render('quotations', { title: 'Zakat quotation', rows: await D.list(db, { outlets: branch ? [branch] : outlets }), master: await D.itemMasterInfo(db),
        outlets, branch, configs,
        settings: await D.settings(db), canSettings: D.canSettings(req.user), canProducts: req.user.role === 'admin' || Boolean(req.user.inventory),
        ok: req.query.ok || null, err: req.query.err || null, navActive: 'quotations' });
    } catch (err) { next(err); }
  });

  router.post('/quotations', gate, async (req, res, next) => {
    try {
      const r = await D.createDraft(db, req.user, req.body, { now });
      if (r.error) return back(res, '/quotations', r.error, 'err');
      res.redirect(303, `/quotations/${r.id}`);
    } catch (err) { next(err); }
  });

  // ---------- settings (before /:id) ----------
  const settingsGate = (req, res, next) => (D.canSettings(req.user) ? next() : msg(res, 403, 'Quotation settings are for admin and Alia.'));
  router.get('/quotations/settings', gate, settingsGate, async (req, res, next) => {
    try {
      res.render('quotation-settings', { title: 'Quotation settings', settings: await D.settings(db), series: await D.seriesRows(db),
        thisYear: Number(require('../calc').todayInMalaysia(now()).slice(0, 4)), formatRef: L.formatRef, configs: await D.branchConfigs(db), seriesList: D.SERIES_LIST,
        ok: req.query.ok || null, err: req.query.err || null, navActive: 'quotations' });
    } catch (err) { next(err); }
  });
  router.post('/quotations/settings', gate, settingsGate, async (req, res, next) => {
    try { const r = await D.saveSettings(db, req.user, req.body); back(res, '/quotations/settings', r.error || r.ok, r.error ? 'err' : 'ok'); } catch (err) { next(err); }
  });
  router.post('/quotations/settings/signature', gate, settingsGate, async (req, res, next) => {
    try { const r = await D.saveSignature(db, req.user, req.body.file); back(res, '/quotations/settings', r.error || r.ok, r.error ? 'err' : 'ok'); } catch (err) { next(err); }
  });
  router.post('/quotations/settings/branch/:code', gate, settingsGate, async (req, res, next) => {
    try { const r = await D.saveBranch(db, req.user, req.params.code, req.body); back(res, '/quotations/settings', r.error || r.ok, r.error ? 'err' : 'ok'); } catch (err) { next(err); }
  });
  router.post('/quotations/settings/image/:code/:kind', gate, settingsGate, async (req, res, next) => {
    try { const r = await D.saveImage(db, req.user, req.params.code, req.params.kind, req.body.file); back(res, '/quotations/settings', r.error || r.ok, r.error ? 'err' : 'ok'); } catch (err) { next(err); }
  });
  router.get('/quotations/settings/image/:code/:kind', gate, settingsGate, async (req, res, next) => {
    try {
      const pic = D.IMAGE_KINDS.includes(req.params.kind) && D.BRANCHES[req.params.code] ? await D.image(db, req.params.code, req.params.kind) : null;
      if (!pic) return msg(res, 404, 'No picture uploaded yet.');
      res.setHeader('Content-Type', pic[0] === 0xff ? 'image/jpeg' : 'image/png');
      res.setHeader('Cache-Control', 'private, no-store');
      res.send(pic);
    } catch (err) { next(err); }
  });
  router.get('/quotations/settings/signature', gate, settingsGate, async (req, res, next) => {
    try {
      const sig = await D.signature(db);
      if (!sig) return msg(res, 404, 'No signature uploaded yet.');
      res.setHeader('Content-Type', sig[0] === 0xff ? 'image/jpeg' : 'image/png');
      res.setHeader('Cache-Control', 'private, no-store');
      res.send(sig);
    } catch (err) { next(err); }
  });
  router.post('/quotations/settings/series', gate, settingsGate, async (req, res, next) => {
    try { const r = await D.setNextNo(db, req.user, req.body); back(res, '/quotations/settings', r.error || r.ok, r.error ? 'err' : 'ok'); } catch (err) { next(err); }
  });

  // ---------- one quotation ----------
  router.get('/quotations/:id', gate, async (req, res, next) => {
    try {
      const q = await D.loadOne(db, id(req));
      if (!D.canOpen(req.user, q)) return msg(res, 404, 'That quotation isn’t in the list.');
      const s = await D.settings(db);
      const branchCfg = await D.branchConfig(db, q.outlet);
      if (q.status === 'draft') {
        for (const l of q.lines) l.matches = await D.candidates(db, l.search_text || l.portal_text);
      }
      const seeCost = D.canSeeCost(req.user);
      // Badges and auto prices are worked out here, then cost is taken off for people who don't see it.
      for (const l of q.lines) {
        l.badge = l.unit_price > 0 ? L.badge(l.unit_price, l.cost_at_quote, s.markup_floor) : null;
        l.markupPct = L.markupOf(l.unit_price, l.cost_at_quote);
        for (const m of l.matches || []) { m.price = L.autoPrice(m.cost, s.markup_default); }
        if (!seeCost) { l.cost_at_quote = null; l.product_cost = null; l.markupPct = null; for (const m of l.matches || []) m.cost = null; }
      }
      res.render('quotation', { title: q.ref || 'New zakat quotation', q, s, seeCost, L, branchCfg, missing: q.status === 'draft' ? D.missing(q) : [],
        lineTotal: D.lineTotal, total: D.totalOf(q.lines), canDelete: q.status === 'draft' && (req.user.role === 'admin' || q.created_by === req.user.id),
        ok: req.query.ok || null, err: req.query.err || null, navActive: 'quotations' });
    } catch (err) { next(err); }
  });

  router.post('/quotations/:id', gate, async (req, res, next) => {
    try {
      const r = await D.saveDraft(db, req.user, id(req), req.body, { now });
      const to = `/quotations/${id(req)}`;
      if (r.error) return back(res, to, r.error, 'err');
      res.redirect(303, `${to}?${r.problems && r.problems.length ? 'err' : 'ok'}=${encodeURIComponent(r.ok)}${req.body.goto ? `#${String(req.body.goto).replace(/[^a-z0-9-]/gi, '')}` : ''}`);
    } catch (err) { next(err); }
  });

  router.post('/quotations/:id/generate', gate, async (req, res, next) => {
    try {
      const to = `/quotations/${id(req)}`;
      // The form carries steps 1–3 too: save what's on screen first.
      if (req.body.l || req.body.recipient !== undefined) {
        const s = await D.saveDraft(db, req.user, id(req), req.body, { now });
        if (s.error) return back(res, to, s.error, 'err');
        if (s.problems && s.problems.length) return back(res, to, s.ok, 'err');
      }
      const r = await D.issue(db, req.user, id(req), { now, makePdf: quotationPdf });
      if (r.error) return back(res, `${to}`, r.error, 'err');
      back(res, to, `${r.ref} is ready – download the PDF below.`);
    } catch (err) { next(err); }
  });

  router.get('/quotations/:id/pdf', gate, async (req, res, next) => {
    try {
      if (!D.canOpen(req.user, await D.loadOne(db, id(req)))) return msg(res, 404, 'That quotation isn’t in the list.');
      const p = await D.pdfOf(db, id(req));
      if (!p) return msg(res, 404, 'This quotation has no PDF yet – generate it first.');
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `${req.query.download ? 'attachment' : 'inline'}; filename="${p.ref}.pdf"`);
      res.setHeader('Cache-Control', 'private, no-store');
      res.send(Buffer.from(p.pdf));
    } catch (err) { next(err); }
  });

  router.post('/quotations/:id/copy', gate, async (req, res, next) => {
    try {
      const r = await D.copy(db, req.user, id(req), { now });
      if (r.error) return back(res, '/quotations', r.error, 'err');
      back(res, `/quotations/${r.id}`, 'A new draft with the same items – it gets a new number when you generate it.');
    } catch (err) { next(err); }
  });

  router.post('/quotations/:id/delete', gate, async (req, res, next) => {
    try {
      const r = await D.removeDraft(db, req.user, id(req));
      back(res, r.error ? `/quotations/${id(req)}` : '/quotations', r.error || r.ok, r.error ? 'err' : 'ok');
    } catch (err) { next(err); }
  });

  return router;
}

module.exports = { quotationRoutes };
