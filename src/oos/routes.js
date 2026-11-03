// Out-of-stock flow pages: /oos (branch), /oos/inbox + /oos/:id (Inventory answers),
// /oos/transfers (Fariz), /oos/scoreboard. See src/oos/data.js for the flow.

const express = require('express');
const calc = require('../calc');
const fmt = require('../scoreboard/format');
const { loadBranch } = require('../daily/data');
const { weekChoices, pickWeek } = require('../lib/weeks');
const oos = require('./data');
const of = require('./format');
const chat = require('./chat');
const requests = require('./requests');
const { safePath } = require('../lib/safe-path');

// Where a message / answer form may send the person back to: an out-of-stock page or Daily entry.
const backTo = (p, fallback) => {
  const s = safePath(p, fallback);
  return /^\/(oos|daily)(\/|\?|#|$)/.test(s) ? s : fallback;
};

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
      canReport: oos.canReport(req.user, branch), canClose: oos.canReport(req.user, branch), canTalk: chat.canTalk(req.user, branch.id),
      newCount: (await db.query("SELECT count(*)::int AS n FROM item_requests WHERE branch_id = $1 AND status = ANY($2)", [branch.id, requests.OPEN])).rows[0].n,
      bq: many(req.user) ? `?branch=${encodeURIComponent(branch.code)}` : '',
      typed: extra.typed || {}, errors: extra.errors || {}, ok: req.query.ok || null, err: extra.err || req.query.err || null,
      targets: await oos.targets(db), productList: (await require('./products').count(db)) > 0,
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
      if (req.body.back === '/daily') return back(res, '/daily', `${item.item}: accepted – back in stock.`);
      back(res, `/oos${many(req.user) ? `?branch=${encodeURIComponent(item.branch_code)}` : ''}`, `${item.item}: accepted – back in stock.`);
    } catch (err) { next(err); }
  });

  // 30 Oct: cancel a report (branch that reported it, or Inventory) – optional reason.
  router.post('/oos/:id/cancel', async (req, res, next) => {
    try {
      const item = await itemOr404(req, res); if (!item) return;
      const mine = item.branch_id && oos.canReport(req.user, { id: item.branch_id });
      if (!mine && !oos.canAnswer(req.user)) return forbid(res, 'Only the branch that reported it or the inventory team can cancel it.');
      const r = await oos.cancelItem(db, req.user, item, req.body, { now });
      const to = mine ? `/oos${many(req.user) ? `?branch=${encodeURIComponent(item.branch_code)}` : ''}` : '/oos/inbox';
      if (r.error) return back(res, to, r.error, 'err');
      back(res, to, `${item.item}: cancelled.`);
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
      await renderInbox(req, res, { tab: ['answer', 'waiting', 'done', 'new'].includes(req.query.tab) ? req.query.tab : 'table' });
    } catch (err) { next(err); }
  });

  // 28 Oct: "Download Excel" – the open items (by branch + B2B), done lately and new item requests,
  // with an empty "Inventory notes" column. One-way: answers are still saved in the app.
  router.get('/oos/inbox.xlsx', async (req, res, next) => {
    try {
      if (!oos.canAnswer(req.user)) return forbid(res, 'The out-of-stock list is for the inventory team (Alia, Syarafana, Fariz) and admin.');
      const out = await require('./export').oosWorkbook(db, { now, base: `${req.protocol}://${req.get('host')}` });
      await db.query(`INSERT INTO audit_log (user_id, action, table_name, record_key) VALUES ($1, 'export', 'oos_items', $2)`, [req.user.id, out.filename]);
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename="${out.filename}"`);
      await out.wb.xlsx.write(res);
      res.end();
    } catch (err) { next(err); }
  });

  // 28 Oct: the inbox as a table – every open item on one screen, answered in one Save.
  async function renderInbox(req, res, extra) {
    const inbox = await oos.loadInbox(db, { now });
    const newItems = await requests.loadInbox(db, { now });
    const today = calc.todayInMalaysia(now());
    const branchCodes = (await db.query('SELECT code FROM branches WHERE active ORDER BY sort_order')).rows.map((b) => b.code);
    res.status(extra.status || 200).render('oos-inbox', {
      title: 'Out of stock – inbox', ...inbox, newItems, fmt, of, branchCodes, today, tomorrow: calc.addDays(today, 1),
      tab: extra.tab, typed: extra.typed || {}, rowErrors: extra.rowErrors || {},
      ok: req.query.ok || null, err: extra.err || req.query.err || null, at: now(),
    });
  }

  // ─────────────── 3 Nov: Dynamod product list (search + upload) ───────────────
  const products = require('./products');
  const canReport = (u) => ['branch_staff', 'branch_manager', 'admin', 'hq', 'hq_staff'].includes(u.role);

  router.get('/oos/products/search', async (req, res, next) => {
    try {
      if (!canReport(req.user)) return res.status(403).json({ error: 'forbidden' });
      res.set('Cache-Control', 'private, max-age=60');
      res.json({ items: await products.search(db, req.query.q) });
    } catch (err) { next(err); }
  });

  router.get('/oos/products', async (req, res, next) => {
    try {
      if (!oos.canAnswer(req.user)) return forbid(res, 'The product list is kept by the inventory team (Alia, Syarafana, Fariz) and admin.');
      const info = (await db.query("SELECT key, value FROM app_settings WHERE key IN ('products_20261102_v1', 'products_last_upload')")).rows;
      const last = info.find((r) => r.key === 'products_last_upload') || info.find((r) => r.key === 'products_20261102_v1');
      const stats = (await db.query('SELECT count(*) FILTER (WHERE active)::int AS active, count(*)::int AS total FROM products')).rows[0];
      const found = req.query.q ? await products.search(db, req.query.q, { limit: 50, prices: true }) : [];
      const priced = (await db.query('SELECT count(*)::int AS n FROM products WHERE active AND price1 IS NOT NULL')).rows[0].n;
      res.render('oos-products', { title: 'Product list', stats, priced, last: last ? JSON.parse(last.value) : null, q: req.query.q || '', found,
        ok: req.query.ok || null, err: req.query.err || null, navActive: 'oosproducts' });
    } catch (err) { next(err); }
  });

  router.post('/oos/products', async (req, res, next) => {
    try {
      if (!oos.canAnswer(req.user)) return forbid(res, 'The product list is kept by the inventory team and admin.');
      const m = /^data:[^;]*;base64,([A-Za-z0-9+/=]+)$/.exec(String(req.body.file || ''));
      if (!m) return back(res, '/oos/products', 'Choose the Dynamod masterlist (.xlsx) first.', 'err');
      const buf = Buffer.from(m[1], 'base64');
      if (buf.subarray(0, 2).toString() !== 'PK') return back(res, '/oos/products', 'That isn’t an Excel (.xlsx) file.', 'err');
      const parsed = await products.parseXlsx(buf);
      if (parsed.error) return back(res, '/oos/products', parsed.error, 'err');
      const r = await products.upsertProducts(db, parsed.rows, { deactivateMissing: req.body.replace === '1' });
      const info = { source: String(req.body.name || 'upload').slice(0, 120), at: now().toISOString(), by: req.user.display_name, ...r };
      await db.query(`INSERT INTO app_settings (key, value) VALUES ('products_last_upload', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [JSON.stringify(info)]);
      await db.query(`INSERT INTO audit_log (user_id, action, table_name, record_key, new_value) VALUES ($1, 'import', 'products', $2, $3)`, [req.user.id, info.source, JSON.stringify(r)]);
      back(res, '/oos/products', `Product list updated: ${r.total} rows read, ${r.added} new, ${r.updated} changed.`);
    } catch (err) { next(err); }
  });

  router.post('/oos/inbox/b2b', async (req, res, next) => {
    try {
      if (!oos.canAnswer(req.user)) return forbid(res, 'B2B items are added by the inventory team and admin.');
      const r = await oos.reportB2b(db, req.user, req.body, { now });
      if (r.error) return back(res, '/oos/inbox#b2b', r.error, 'err');
      back(res, '/oos/inbox#b2b', `B2B item added: ${String(req.body.item).trim()}.`);
    } catch (err) { next(err); }
  });

  router.post('/oos/inbox/table', async (req, res, next) => {
    try {
      if (!oos.canAnswer(req.user)) return forbid(res, 'Answering out-of-stock items is for the inventory team and admin.');
      const r = await oos.saveTable(db, req.user, req.body, { now });
      const n = Object.keys(r.errors).length;
      if (n) {
        return renderInbox(req, res, { tab: 'table', status: 400, typed: req.body.r || {}, rowErrors: r.errors,
          err: `${r.saved ? `${r.saved} saved. ` : ''}${n} row${n === 1 ? '' : 's'} not saved – see the red message${n === 1 ? '' : 's'}.` });
      }
      back(res, '/oos/inbox', r.saved ? `${r.saved} item${r.saved === 1 ? '' : 's'} saved – the branches see your answers now.` : 'No changes to save.');
    } catch (err) { next(err); }
  });

  async function renderAnswer(req, res, item, extra = {}) {
    const branches = (await db.query('SELECT code, name FROM branches WHERE active ORDER BY sort_order')).rows;
    const today = calc.todayInMalaysia(now());
    const history = (await db.query(
      `SELECT reported_at, status, answer FROM oos_items WHERE branch_id = $1 AND lower(item) = lower($2) AND id <> $3 ORDER BY reported_at DESC LIMIT 3`,
      [item.branch_id, item.item, item.id])).rows;
    item.forHq = true;
    res.status(extra.status || 200).render('oos-answer', {
      title: `Answer – ${item.item}`, item, ok: req.query.ok || null, qerr: req.query.err || null, branches, history, fmt, of, today,
      tomorrow: calc.addDays(today, 1), typed: extra.typed || {}, err: extra.err || null, at: now(),
    });
  }

  router.get('/oos/:id', async (req, res, next) => {
    try {
      if (!/^\d{1,9}$/.test(req.params.id)) return next();
      if (!oos.canAnswer(req.user)) return forbid(res, 'Answering out-of-stock items is for the inventory team and admin.');
      const item = await itemOr404(req, res); if (!item) return;
      if (await oos.markSeen(db, req.user, 'oos_items', item.id, now())) Object.assign(item, await oos.loadItem(db, item.id));
      await renderAnswer(req, res, item);
    } catch (err) { next(err); }
  });

  router.post('/oos/:id/answer', async (req, res, next) => {
    try {
      if (!oos.canAnswer(req.user)) return forbid(res, 'Answering out-of-stock items is for the inventory team and admin.');
      const item = await itemOr404(req, res); if (!item) return;
      const r = await oos.answerItem(db, req.user, item, req.body, { now });
      if (r.error) return renderAnswer(req, res, item, { status: 400, typed: req.body, err: r.error });
      back(res, '/oos/inbox', `${item.item} (${item.branch_code}): answered${oos.DELIVERS.includes(req.body.answer) ? ' – it’s on Deliveries to send' : ''}.`);
    } catch (err) { next(err); }
  });

  // ─────────────── Transfers (Fariz) ───────────────
  router.get('/oos/transfers', async (req, res, next) => {
    try {
      if (!oos.canSend(req.user)) return forbid(res, 'Transfers are for the inventory team (Alia, Syarafana, Fariz).');
      const t = await oos.loadTransfers(db, { now });
      res.render('oos-transfers', { title: 'Deliveries to send', ...t, fmt, of, ok: req.query.ok || null, err: req.query.err || null, at: now() });
    } catch (err) { next(err); }
  });

  // 25 Oct: Inventory closes an item itself – delivered / fulfilled.
  router.post('/oos/:id/done', async (req, res, next) => {
    try {
      if (!oos.canAnswer(req.user)) return forbid(res, 'Only the inventory team (Alia, Syarafana, Fariz) and admin can close an item for the branch.');
      const item = await itemOr404(req, res); if (!item) return;
      await oos.markDone(db, req.user, item, { now });
      const to = ['/oos/transfers', '/oos/inbox', '/oos/inbox?tab=waiting', `/oos/${item.id}`].includes(req.body.back) ? req.body.back : '/oos/inbox';
      back(res, to, `${item.item} (${item.branch_code}): done – delivered.`);
    } catch (err) { next(err); }
  });

  // ─────────────── 27 Oct: questions & photos, new item requests ───────────────
  router.get('/oos/photo/:id', async (req, res, next) => {
    try {
      const p = await chat.loadPhoto(db, req.params.id);
      if (!p || !chat.canSeeBranch(req.user, p.branch_id)) return res.status(404).render('message', { title: 'Not found', message: 'That photo isn’t available.' });
      res.setHeader('Content-Type', p.mime);
      res.setHeader('Cache-Control', 'private, max-age=86400');
      res.setHeader('Content-Disposition', 'inline');
      res.end(p.data);
    } catch (err) { next(err); }
  });

  router.post('/oos/:id/message', async (req, res, next) => {
    try {
      if (!/^\d{1,9}$/.test(req.params.id)) return next();
      const item = await itemOr404(req, res); if (!item) return;
      const fallback = oos.canAnswer(req.user) ? `/oos/${item.id}` : `/oos${many(req.user) ? `?branch=${encodeURIComponent(item.branch_code)}` : ''}`;
      const to = backTo(req.body.back, fallback);
      const r = await chat.addMessage(db, req.user, { kind: 'oos', id: item.id, branch_id: item.branch_id, branch_code: item.branch_code }, req.body, { now });
      if (r.forbidden) return forbid(res, 'Only this branch and the inventory team can write here.');
      if (r.error) return back(res, to, r.error, 'err');
      back(res, to, `Sent – ${item.item}.`);
    } catch (err) { next(err); }
  });

  async function renderNewItems(req, res, branch, extra = {}) {
    const list = await requests.loadBranch(db, branch, { now });
    const branches = many(req.user) ? (await db.query('SELECT code, name FROM branches WHERE active ORDER BY sort_order')).rows : [];
    res.status(extra.status || 200).render('oos-new-items', {
      title: `${branch.name} – new item requests`, branch, branches, list, fmt, of, at: now(),
      canReport: oos.canReport(req.user, branch), canTalk: chat.canTalk(req.user, branch.id),
      bq: many(req.user) ? `?branch=${encodeURIComponent(branch.code)}` : '',
      typed: extra.typed || {}, errors: extra.errors || {}, ok: req.query.ok || null, err: extra.err || req.query.err || null,
    });
  }

  router.get('/oos/new-items', async (req, res, next) => {
    try {
      if (req.user.role === 'hq_staff' && req.user.inventory) return res.redirect('/oos/inbox?tab=new');
      if (oos.canAnswer(req.user) && !req.query.branch) return res.redirect('/oos/inbox?tab=new');
      const branch = await branchFor(req);
      if (!branch) return res.redirect('/');
      if (!many(req.user) && req.user.branch_id !== branch.id) return forbid(res, 'You can only open your own branch.');
      await renderNewItems(req, res, branch);
    } catch (err) { next(err); }
  });

  router.post('/oos/new-items', async (req, res, next) => {
    try {
      const branch = await branchFor(req);
      if (!branch || !oos.canReport(req.user, branch)) return forbid(res, 'Only this branch’s staff can ask for a new item.');
      const r = await requests.create(db, req.user, branch, req.body, { now });
      if (r.errors) return renderNewItems(req, res, branch, { status: 400, errors: r.errors, typed: req.body, err: 'Not sent – check the boxes in red.' });
      back(res, `/oos/new-items${many(req.user) ? `?branch=${encodeURIComponent(branch.code)}` : ''}`, `Sent to Inventory: ${String(req.body.item).trim()}.`);
    } catch (err) { next(err); }
  });

  async function requestOr404(req, res) {
    const r = await requests.load(db, req.params.rid);
    if (!r) res.status(404).render('message', { title: 'Not found', message: 'That request isn’t on the list.' });
    return r;
  }

  router.get('/oos/new-items/:rid', async (req, res, next) => {
    try {
      const r = await requestOr404(req, res); if (!r) return;
      if (!oos.canAnswer(req.user)) {
        if (!chat.canSeeBranch(req.user, r.branch_id)) return forbid(res, 'You can only open your own branch.');
        return res.redirect(`/oos/new-items${many(req.user) ? `?branch=${encodeURIComponent(r.branch_code)}` : ''}#req-${r.id}`);
      }
      if (await oos.markSeen(db, req.user, 'item_requests', r.id, now())) Object.assign(r, await requests.load(db, r.id));
      r.forHq = true; r.kindKey = 'r';
      res.render('oos-new-item', { title: `New item – ${r.item}`, r, of, fmt, answers: requests.ANSWERS, at: now(), ok: req.query.ok || null, err: req.query.err || null });
    } catch (err) { next(err); }
  });

  router.post('/oos/new-items/:rid/answer', async (req, res, next) => {
    try {
      if (!oos.canAnswer(req.user)) return forbid(res, 'Answering new item requests is for the inventory team and admin.');
      const r = await requestOr404(req, res); if (!r) return;
      const out = await requests.answer(db, req.user, r, req.body, { now });
      if (out.error) return back(res, `/oos/new-items/${r.id}`, out.error, 'err');
      back(res, '/oos/inbox?tab=new', `${r.item} (${r.branch_code}): ${requests.ANSWERS[req.body.answer].status}.`);
    } catch (err) { next(err); }
  });

  router.post('/oos/new-items/:rid/message', async (req, res, next) => {
    try {
      const r = await requestOr404(req, res); if (!r) return;
      const fallback = oos.canAnswer(req.user) ? `/oos/new-items/${r.id}` : `/oos/new-items${many(req.user) ? `?branch=${encodeURIComponent(r.branch_code)}` : ''}`;
      const to = backTo(req.body.back, fallback);
      const out = await chat.addMessage(db, req.user, { kind: 'request', id: r.id, branch_id: r.branch_id, branch_code: r.branch_code }, req.body, { now });
      if (out.forbidden) return forbid(res, 'Only this branch and the inventory team can write here.');
      if (out.error) return back(res, to, out.error, 'err');
      back(res, to, `Sent – ${r.item}.`);
    } catch (err) { next(err); }
  });

  router.post('/oos/:id/:step', async (req, res, next) => {
    try {
      if (!['picked', 'sent'].includes(req.params.step)) return next();
      if (!oos.canSend(req.user)) return forbid(res, 'Transfers are for the inventory team (Alia, Syarafana, Fariz).');
      const item = await itemOr404(req, res); if (!item) return;
      const r = await oos.markTransfer(db, req.user, item, req.params.step, { now });
      if (r.error) return back(res, '/oos/transfers', r.error, 'err');
      back(res, '/oos/transfers', `${item.item} → ${item.branch_code}: ${req.params.step === 'sent' ? 'on the way – the branch sees it' : 'picked – the branch sees it'}.`);
    } catch (err) { next(err); }
  });

  // ─────────────── 28 Oct: activity log (CEO can see Inventory's follow-up) ───────────────
  router.get('/oos/activity', async (req, res, next) => {
    try {
      if (!(req.user.role === 'admin' || req.user.role === 'hq' || req.user.inventory)) return forbid(res, 'The out-of-stock activity log is for HQ, the inventory team and admin.');
      const today = calc.todayInMalaysia(now());
      const start = await trackerStart();
      const date = /^\d{4}-\d{2}-\d{2}$/.test(req.query.date || '') && req.query.date >= start && req.query.date <= today ? req.query.date : today;
      const branches = (await db.query('SELECT code FROM branches WHERE active ORDER BY sort_order')).rows.map((b) => b.code);
      const branch = branches.includes(req.query.branch) ? req.query.branch : null;
      const a = await require('./activity').loadActivity(db, { date, branchCode: branch, now });
      const days = []; for (let d = today; d >= start && days.length < 14; d = calc.addDays(d, -1)) days.push(d);
      res.render('oos-activity', { title: 'Out-of-stock activity', ...a, date, days, branch, branches, of, at: now() });
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
