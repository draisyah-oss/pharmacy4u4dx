// /invoices – invoice scan (6 Nov, CEO). See ./data.js.
//   GET  /invoices?supplier=&from=&month=YYYY-MM&status=   the list (+ "Scan an invoice" form at /invoices/new)
//   GET  /invoices/new                                     the scan form
//   POST /invoices                                         save (pages = data URLs in "page"; confirm_dup=1 saves a repeat)
//   GET  /invoices/check?supplier=&invoice_no=             JSON { duplicates: n } – warns while typing
//   GET  /invoices/:id/pdf                                 the PDF (from the database, else from Drive)
//   POST /invoices/:id/entered  {undo}                     Finance: Entered in Dynamod
//   POST /invoices/:id/drive                               try saving to Drive again (Finance)

const express = require('express');
const calc = require('../calc');
const iv = require('./data');

function invoiceRoutes(db, { now, drive = null }) {
  const router = express.Router();
  const msg = (res, status, text) => res.status(status).render('message', { title: 'Invoices', message: text });

  async function renderForm(req, res, { values = {}, err = null, duplicate = null, status = 200 } = {}) {
    const all = await iv.branches(db);
    const own = all.find((b) => b.id === req.user.branch_id);
    res.status(status).render('invoice-new', { title: 'Scan an invoice', branches: all, suppliers: await iv.suppliers(db),
      values: { from: own ? own.code : 'HQ', invoice_date: calc.todayInMalaysia(now()), ...values },
      pages: [].concat(values.page || []).filter(Boolean), err, duplicate, maxPages: iv.MAX_PAGES, navActive: 'invoices' });
  }

  router.get('/invoices/new', async (req, res, next) => { try { await renderForm(req, res); } catch (err) { next(err); } });

  router.get('/invoices/check', async (req, res, next) => {
    try {
      const d = await iv.findDuplicates(db, req.query.supplier, req.query.invoice_no);
      res.json({ duplicates: d.length, first: d[0] ? { from: d[0].from_code, by: d[0].by_name, file: d[0].file_name } : null });
    } catch (err) { next(err); }
  });

  router.post('/invoices', async (req, res, next) => {
    try {
      const r = await iv.saveInvoice(db, req.user, req.body, { now });
      if (r.error || r.duplicate) {
        return renderForm(req, res, { values: req.body, err: r.error || null, duplicate: r.duplicate || null, status: r.error ? 400 : 200 });
      }
      let note = '';
      if (drive) {
        const up = await drive.upload(r.id);
        note = up.ok ? ' Saved in the Finance inbox on Google Drive.' : ' Not in Google Drive yet – the app keeps it and tries again every 15 minutes.';
      }
      res.redirect(303, `/invoices?ok=${encodeURIComponent(`${r.fileName} saved.${note}`)}`);
    } catch (err) { next(err); }
  });

  router.get('/invoices', async (req, res, next) => {
    try {
      const f = { supplier: req.query.supplier || '', from: req.query.from || '', month: req.query.month || '', status: req.query.status || '' };
      const rows = await iv.list(db, req.user, f);
      res.render('invoices', { title: 'Invoices', rows, f, branches: await iv.branches(db), suppliers: await iv.suppliers(db), months: await iv.months(db),
        statuses: iv.STATUSES, finance: iv.isFinance(req.user), seesAll: iv.seesAll(req.user), driveOn: drive ? drive.configured() : false,
        notEntered: iv.isFinance(req.user) ? await iv.countNotEntered(db) : 0,
        ok: req.query.ok || null, err: req.query.err || null, navActive: 'invoices' });
    } catch (err) { next(err); }
  });

  router.get('/invoices/:id/pdf', async (req, res, next) => {
    try {
      const inv = await iv.loadOne(db, Number(req.params.id) || 0);
      if (!inv || !iv.canSee(req.user, inv)) return msg(res, 404, 'That invoice isn’t in the list.');
      let data = inv.pdf;
      if (!data && inv.drive_file_id && drive) {
        try { data = await drive.download(inv.drive_file_id); } catch (err) { return msg(res, 502, `Google Drive didn’t send the file: ${err.message}`); }
      }
      if (!data) return msg(res, 404, 'The PDF isn’t available.');
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(inv.file_name)}`);
      res.setHeader('Cache-Control', 'private, no-store');
      res.send(Buffer.from(data));
    } catch (err) { next(err); }
  });

  const back = (req, res, r) => {
    const q = new URLSearchParams();
    for (const k of ['supplier', 'from', 'month', 'status']) if (req.body[`f_${k}`]) q.set(k, req.body[`f_${k}`]);
    q.set(r.error ? 'err' : 'ok', r.error || r.ok);
    res.redirect(303, `/invoices?${q.toString()}#i${req.params.id}`);
  };

  router.post('/invoices/:id/entered', async (req, res, next) => {
    try { back(req, res, await iv.setEntered(db, req.user, Number(req.params.id) || 0, { undo: Boolean(req.body.undo), now })); } catch (err) { next(err); }
  });

  router.post('/invoices/:id/drive', async (req, res, next) => {
    try {
      if (!iv.isFinance(req.user)) return msg(res, 403, 'Only Finance can do that.');
      if (!drive) return back(req, res, { error: 'Google Drive isn’t set up.' });
      const up = await drive.upload(Number(req.params.id) || 0);
      back(req, res, up.ok ? { ok: 'Saved in Google Drive.' } : up.skipped ? { ok: 'Already in Google Drive.' } : { error: up.error });
    } catch (err) { next(err); }
  });

  return router;
}

module.exports = { invoiceRoutes };
