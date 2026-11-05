// 3 Nov 2026: Ordering & payments (/inventory) – the Mr Eve board in the app.
const test = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');

const { createDb } = require('../../src/db');
const { migrate } = require('../../src/db/migrate');
const { readSeed, loadSeed } = require('../../src/db/seed');
const { createApp } = require('../../src/app');
const inv = require('../../src/inventory/data');

let db; let server; let base;
const clock = new Date('2026-11-03T15:00:00+08:00');
const now = () => clock;

test.before(async () => {
  db = await createDb({ url: '', localDir: 'memory' });
  await migrate(db);
  await loadSeed(db, readSeed(), { adminPassword: 'admin-pass-1' });
  await inv.loadBundledOnce(db);
  const pw = (u, v) => db.query('UPDATE users SET password_hash = $1 WHERE username = $2', [bcrypt.hashSync(v, 4), u]);
  const pin = (u, v) => db.query('UPDATE users SET pin_hash = $1 WHERE username = $2', [bcrypt.hashSync(v, 4), u]);
  await pw('alia', 'alia-pass-1'); await pw('admin', 'admin-pass-1');
  await pin('azwani', '4242'); await pin('hazera', '1111');
  await pw('hanin', 'hanin-pass-1'); await pw('hafizah', 'hafizah-pass1');
  await db.query("UPDATE users SET is_super = true WHERE username = 'admin'");
  server = createApp(db, { now }).listen(0);
  base = `http://localhost:${server.address().port}`;
});
test.after(async () => { server.close(); await db.close(); });
const msg = (r) => { const u = new URL('http://x' + r.location); return u.searchParams.get('err') || u.searchParams.get('ok') || ''; };

async function login(kind, username, secret) {
  let cookie = '';
  const req = async (method, p, body) => {
    const r = await fetch(base + p, {
      method, redirect: 'manual',
      headers: { ...(cookie ? { cookie } : {}), ...(body ? { 'content-type': 'application/x-www-form-urlencoded' } : {}) },
      body: body ? new URLSearchParams(body).toString() : undefined,
    });
    const set = r.headers.get('set-cookie'); if (set) cookie = set.split(';')[0];
    return { status: r.status, location: r.headers.get('location'), html: await r.text() };
  };
  const r = await req('POST', kind === 'pin' ? '/login/pin' : '/login/password', kind === 'pin' ? { username, pin: secret } : { username, password: secret });
  assert.equal(r.status, 302, `${username} logs in`);
  let csrf = null;
  return {
    get: (p) => req('GET', p),
    post: async (p, body) => {
      if (!csrf) csrf = ((await req('GET', '/inventory')).html.match(/name="_csrf" value="([^"]+)"/) || (await req('GET', '/daily')).html.match(/name="_csrf" value="([^"]+)"/) || [])[1];
      return req('POST', p, { _csrf: csrf, ...body });
    },
  };
}

test('the board data loads once: PO budget RM200k, 5 weeks, 9 payment lines, the 3 Nov plan', async () => {
  const d = await inv.loadPage(db, { today: '2026-11-03' });
  assert.equal(d.month, '2026-11');
  assert.equal(d.S.po_budget_total, 200000);
  assert.equal(d.cash.length, 5);
  assert.equal(d.pay.length, 9, 'the EXAMPLE row is left out');
  assert.equal(d.plan.plan_date, '2026-11-03');
  assert.ok(d.todo.length > 140);
  assert.ok(d.todo.every((t) => !/^(SECTION|NOTE|TOTALS)/i.test(t.action)));
  assert.match(d.plan.note, /stockbalance 2.11/);
  // Same rules as the board
  const aa = d.pay.find((p) => p.supplier === 'AA Alive');
  assert.equal(aa.state, 'Not marked paid', 'approved, pay date 30 Oct passed, not marked paid');
  assert.equal(d.S.late_lines, 3, 'AA Alive, Teepham and YSP (partial) – approved, 30 Oct passed');
  assert.equal(d.S.next.supplier, 'Zuellig Pharma');
  assert.equal(d.suppliers.find((s) => s.key === 'APEX').gate, 'open');
  assert.equal(d.suppliers.find((s) => s.key === 'AA ALIVE').gate, 'after_payment');
  assert.ok(d.S.counts.recount === 7 && d.S.counts.asking === 10);
  await inv.loadBundledOnce(db);
  assert.equal((await inv.loadPage(db, { today: '2026-11-03' })).pay.length, 9, 'only once');
});

test('3 Nov evening: November PO budget as Dr Aisyah updated it (RM200,628.03), applied once', async () => {
  await inv.loadBudgetUpdateOnce(db);
  const d = await inv.loadPage(db, { today: '2026-11-03' });
  assert.equal(Math.round(d.S.po_budget_total * 100) / 100, 200628.03);
  const b = (k) => d.suppliers.find((s) => s.key === k);
  assert.equal(b('ZUELLIG').po_budget, 115961.58);
  assert.equal(b('DKSH').po_budget, 55023.25);
  assert.equal(b('DKSH 103').po_budget, 1000);
  for (const [k, v] of [['TONGEE', 10237.62], ['AISH', 4588.85], ['DUOPHARMA', 3911.96], ['NOVA', 3340.8], ['BEN', 2864.35], ['DCH', 2100], ['MUN', 1599.62]]) assert.equal(b(k).po_budget, v, k);
  assert.equal(b('APEX').po_budget, 0, 'suppliers not in her list stay, with no budget');
  assert.equal(b('APEX').gate, 'open');
  assert.equal(d.cash.length, 5, 'cash plan untouched');
  assert.equal(d.pay.length, 9, 'payments untouched');
  await db.query("UPDATE inv_suppliers SET po_budget = 1 WHERE key = 'NOVA'");
  await inv.loadBudgetUpdateOnce(db);
  assert.equal((await inv.loadPage(db, { today: '2026-11-03' })).suppliers.find((s) => s.key === 'NOVA').po_budget, 1, 'only once');
  await db.query("UPDATE inv_suppliers SET po_budget = 3340.80 WHERE key = 'NOVA'");
});

test('every section folds; Excel-style filters on the supplier, today and approvals tables', async () => {
  const alia = await login('password', 'alia', 'alia-pass-1');
  const { html } = await alia.get('/inventory');
  for (const id of ['glance', 'suppliers', 'today', 'cash', 'payments']) {
    assert.match(html, new RegExp(`<details class="oo-card inv-sec" id="${id}" open>`), id);
  }
  assert.match(html, /<summary><h2>Today at a glance<\/h2><\/summary>/);
  assert.match(html, /data-fold="close">Fold all<\/button>/);
  assert.equal((html.match(/data-xfilter aria-label=/g) || []).length, 3);
  assert.match(html, /<th data-xfilter-off>Done<\/th>/);
  assert.match(html, /<script src="\/js\/inventory\.js\?v=2" defer><\/script>/);
  assert.match(html, /<script src="\/js\/table-filter\.js\?v=2" defer><\/script>/);
  assert.match(html, /as Dr Aisyah updated it on 3 Nov/);
});

test('who sees it: inventory team, Azwani and admin – not branch staff', async () => {
  const staff = await login('pin', 'hazera', '1111');
  assert.equal((await staff.get('/inventory')).status, 403);
  const alia = await login('password', 'alia', 'alia-pass-1');
  const page = await alia.get('/inventory');
  assert.equal(page.status, 200);
  assert.match(page.html, /Can I order from this supplier\?/);
  assert.match(page.html, /Ordering &amp; payments/);
  assert.doesNotMatch(page.html, /name="approved"/, 'only the CEO approves');
  const az = await login('pin', 'azwani', '4242');
  const azp = await az.get('/inventory');
  assert.equal(azp.status, 200);
  assert.match(azp.html, /href="\/inventory"/, 'Inventory menu → Ordering & payments');
  assert.doesNotMatch(azp.html, /\/oos\/inbox/, 'payments team sees the board only');
});

test('4 Nov: every HQ login sees the page (read only) – branch managers still don’t', async () => {
  const hanin = await login('password', 'hanin', 'hanin-pass-1');
  const p = await hanin.get('/inventory');
  assert.equal(p.status, 200);
  assert.match(p.html, /href="\/inventory"[^>]*>Ordering &amp; payments/, 'in her menu');
  assert.doesNotMatch(p.html, /\/oos\/inbox/, 'not the out-of-stock inbox');
  assert.doesNotMatch(p.html, /action="\/inventory\/lines\//, 'no ticks');
  assert.doesNotMatch(p.html, /name="approved"/, 'no approving');
  assert.doesNotMatch(p.html, /name="pv_no"/, 'no marking paid');
  const lineId = (await db.query('SELECT id FROM inv_plan_lines LIMIT 1')).rows[0].id;
  assert.equal((await hanin.post(`/inventory/lines/${lineId}`, { done: '1' })).status, 403);
  const bm = await login('password', 'hafizah', 'hafizah-pass1');
  assert.equal((await bm.get('/inventory')).status, 403);
});

test('4 Nov: Mr Eve’s daily plan comes from Google Drive by itself', async () => {
  const fs = require('fs'); const path = require('path'); const crypto = require('crypto');
  const { createInventoryDrive, planDate } = require('../../src/inventory/drive');
  assert.equal(planDate('Mr Eve Daily Plan 05 Nov 2026'), '2026-11-05');
  assert.equal(planDate('Mr Eve Daily Plan', '2026-11-04T23:30:00Z'), '2026-11-05', 'no date in the name → Malaysia day it was saved');
  const csv = fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'inventory', 'daily-plan.csv'), 'utf8').replace('03 Nov daily plan', '05 Nov daily plan');
  const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 1024 });
  const account = { email: 'mr-you@p4u.iam.gserviceaccount.com', privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }) };
  let modified = '2026-11-04T23:56:41Z'; let exports = 0; let listStatus = 200;
  const fetchImpl = async (url, opts = {}) => {
    const u = new URL(url);
    const json = (code, body) => ({ ok: code < 400, status: code, json: async () => body, text: async () => JSON.stringify(body) });
    if (u.host === 'oauth2.googleapis.com') {
      const claims = JSON.parse(Buffer.from(new URLSearchParams(opts.body).get('assertion').split('.')[1], 'base64url').toString());
      assert.equal(claims.scope, 'https://www.googleapis.com/auth/drive.readonly');
      return json(200, { access_token: 't' });
    }
    if (u.pathname === '/drive/v3/files') {
      assert.match(u.searchParams.get('q'), /'1VXbTmy4QE_6aJXueJsIWkJVE-J_5DXZs' in parents/);
      if (listStatus !== 200) return json(listStatus, { error: { message: 'File not found' } });
      return json(200, { files: [{ id: 'OLD', name: 'Mr Eve Daily Plan 04 Nov 2026', modifiedTime: '2026-11-03T23:50:00Z' }, { id: 'NEW', name: 'Mr Eve Daily Plan 05 Nov 2026', modifiedTime: modified }] });
    }
    if (u.pathname === '/drive/v3/files/NEW/export') { exports++; return { ok: true, status: 200, text: async () => csv }; }
    return json(404, { error: { message: 'nope' } });
  };
  const drive = createInventoryDrive(db, { account, fetchImpl, now, log: () => {} });
  const r = await drive.syncNow();
  assert.equal(r.date, '2026-11-05');
  assert.ok(r.lines > 20);
  let d = await inv.loadPage(db, { today: '2026-11-05' });
  assert.equal(d.plan.title, 'Mr Eve Daily Plan 05 Nov 2026');
  assert.equal(d.plan.source, 'Mr Eve (Google Drive)');
  assert.match(d.plan.note, /05 Nov daily plan/);
  assert.ok(d.todo.length > 20);
  // Same sheet, not changed → not loaded again; a newer save → loaded again, ticks kept.
  assert.equal((await drive.syncNow()).unchanged, true);
  assert.equal(exports, 1);
  const first = d.todo[0];
  await db.query('UPDATE inv_plan_lines SET done_at = now() WHERE id = $1', [first.id]);
  modified = '2026-11-05T02:00:00Z';
  await drive.syncNow({ force: true });
  assert.equal(exports, 2);
  d = await inv.loadPage(db, { today: '2026-11-05' });
  assert.ok(d.todo.find((t) => t.item === first.item).done_at, 'tick kept on the re-sent day');
  const st = await drive.status();
  assert.equal(st.file, 'Mr Eve Daily Plan 05 Nov 2026');
  assert.equal(st.error, null);
  // Folder not shared → a clear message, kept for the page; last good plan stays.
  listStatus = 404;
  await assert.rejects(drive.syncNow({ force: true }), /Share the Inventory Agent Inputs folder \(Viewer\) with mr-you@/);
  assert.match((await drive.status()).error, /Share the Inventory Agent Inputs folder/);
  assert.equal((await drive.status()).file, 'Mr Eve Daily Plan 05 Nov 2026');
  // No key → off, nothing called.
  const off = createInventoryDrive(db, { env: {}, fetchImpl: async () => assert.fail('no call'), log: () => {} });
  assert.equal(off.configured(), false);
  assert.ok((await off.syncNow()).error);
  await db.query("DELETE FROM app_settings WHERE key = 'inventory_drive_status'");
  await db.query("DELETE FROM inv_plans WHERE plan_date = '2026-11-05'");
});

test('Alia ticks lines; views and search filter the list', async () => {
  const alia = await login('password', 'alia', 'alia-pass-1');
  const line = (await db.query("SELECT id FROM inv_plan_lines WHERE item LIKE 'Panadol Regular%'")).rows[0];
  const r = await alia.post(`/inventory/lines/${line.id}`, { done: '1', view: 'urgent' });
  assert.equal(r.status, 303); assert.match(r.location, /view=urgent/);
  const done = await alia.get('/inventory?view=done');
  assert.match(done.html, /Panadol Regular Coated/);
  const s = await alia.get('/inventory?view=transfer&q=xepa');
  assert.match(s.html, /XEPA TUSSIDEX/);
  assert.doesNotMatch(s.html, /UPHAMOL SUSPENSION/);
});

test('CEO approves, Azwani marks paid – the supplier opens', async () => {
  const az = await login('pin', 'azwani', '4242');
  const ceo = await login('password', 'admin', 'admin-pass-1');
  const dksh = (await db.query("SELECT id FROM inv_payments WHERE supplier LIKE 'DKSH%'")).rows[0];
  // Not approved yet → Azwani can't mark it paid
  let r = await az.post(`/inventory/payments/${dksh.id}/paid`, { pv_no: 'PV1' });
  assert.match(msg(r), /Not approved by Dr Aisyah yet/);
  // Azwani can't approve
  assert.equal((await az.post(`/inventory/payments/${dksh.id}/approve`, { approved: 'Yes' })).status, 403);
  // Nothing due within a week waits for approval yet (DKSH is 19 Nov)
  assert.doesNotMatch((await ceo.get('/inventory')).html, /Supplier payments to approve/);
  r = await ceo.post(`/inventory/payments/${dksh.id}/approve`, { approved: 'Partial', amount: '' });
  assert.match(msg(r), /type the amount/);
  r = await ceo.post(`/inventory/payments/${dksh.id}/approve`, { approved: 'Yes' });
  assert.equal(r.status, 303);
  let p = (await db.query('SELECT * FROM inv_payments WHERE id = $1', [dksh.id])).rows[0];
  assert.equal(p.approved, 'Yes'); assert.equal(Number(p.approved_amount), 35677);
  r = await az.post(`/inventory/payments/${dksh.id}/paid`, { date_paid: '2026-11-03', pv_no: 'PV-881' });
  assert.equal(r.status, 303);
  p = (await db.query('SELECT paid, pv_no, paid_via, date_paid::text AS d FROM inv_payments WHERE id = $1', [dksh.id])).rows[0];
  assert.deepEqual([p.paid, p.pv_no, p.d, p.paid_via], [true, 'PV-881', '2026-11-03', 'Swipey'], '4 Nov: paid via Swipey unless chosen otherwise');
  const page = (await az.get('/inventory')).html;
  assert.match(page, /Swipey · ref PV-881/);
  assert.match(page, /placeholder="Swipey ref \(optional\)"/);
  assert.match(page, /<option selected>Swipey<\/option><option>Bank transfer<\/option>/);
  const d = await inv.loadPage(db, { today: '2026-11-03' });
  assert.equal(d.suppliers.find((s) => s.key === 'DKSH').gate, 'paid', 'every DKSH line paid → open');
  assert.ok(d.todo.filter((t) => t.supplier_key === 'DKSH' && t.gate === 'wait').length === 0);
  const audit = (await db.query("SELECT count(*)::int AS n FROM audit_log WHERE table_name = 'inventory' AND record_key LIKE 'payment%'")).rows[0].n;
  assert.ok(audit >= 2);
  // Azwani adds a line
  r = await az.post('/inventory/payments', { supplier: 'Delfi Marketing', proposed: '2,500', pay_date: '2026-11-26', week: '23–30 Nov' });
  assert.equal(r.status, 303);
  assert.equal((await db.query("SELECT count(*)::int AS n FROM inv_payments WHERE supplier = 'Delfi Marketing' AND approved IS NULL")).rows[0].n, 1);
  await az.post('/inventory/payments', { supplier: 'Eldon Healthcare', proposed: '900', pay_date: '2026-11-06' });
  assert.match((await ceo.get('/inventory')).html, /Supplier payments to approve/, 'due within a week → Needs you');
});

test('Mr Eve sends the daily plan by the agent API', async () => {
  process.env.AGENT_API_TOKEN = 'test-token-0123456789abcdefghij';
  const api = (method, p, body) => fetch(base + '/api/agent' + p, { method,
    headers: { authorization: `Bearer ${process.env.AGENT_API_TOKEN}`, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined });
  const rows = [
    { Action: 'NOTE - 04 Nov daily plan.', Item: '' },
    { Action: 'SECTION 1: URGENT', Item: '' },
    { Action: 'URGENT 1 - ORDER', Item: 'Test item A', 'Branches/short at': 'JH 0', Supplier: 'Apex', 'Supplier status': 'OPEN NOW', 'Order qty': '2 box', 'Approx RM': '50' },
    { Action: 'SECTION 2: TRANSFER FROM HQ WAREHOUSE', Item: '' },
    { Action: 'TRANSFER (HQ)', Item: 'Test item B', 'Branches/short at': 'BR 0', 'Transfer from (qty)': 'HQ 3', Supplier: 'ZUELLIG PHARMA', 'Supplier status': 'AFTER PAYMENT', 'Order qty': '0', 'Approx RM': '0' },
    { Action: 'TOTALS', Item: 'Order now', 'Approx RM': '~50' },
  ];
  let r = await api('POST', '/inventory/plan', { date: '2026-11-04', title: 'Mr Eve Daily Plan 04 Nov 2026', rows });
  assert.equal(r.status, 200); assert.deepEqual(await r.json(), { ok: true, lines: 2 });
  r = await api('GET', '/inventory');
  const j = await r.json();
  assert.equal(j.plan.plan_date, '2026-11-04');
  const own = j.lines.filter((l) => !l.backlog); assert.equal(own.length, 2); assert.equal(own[0].section, 'urgent'); assert.equal(own[1].section, 'hq');
  assert.ok(j.summary.order_now_lines >= 1, 'the new line + backlog from 3 Nov');
  assert.ok(j.payments.every((p) => p.approved_by === undefined));
  r = await api('POST', '/inventory/plan', { date: 'x', rows });
  assert.equal(r.status, 400);
  delete process.env.AGENT_API_TOKEN;
});

test('4 Nov: payment lines follow Dr Aisyah’s 3 Nov plan – paid / approved lines untouched, once', async () => {
  const db2 = await createDb({ url: '', localDir: 'memory' });
  try {
    await migrate(db2);
    await loadSeed(db2, readSeed(), { adminPassword: 'admin-pass-1' });
    await inv.loadBundledOnce(db2);
    // As live on 4 Nov: AA Alive and YSP marked paid, Teepham approved, Zuellig approved.
    await db2.query("UPDATE inv_payments SET paid = true, date_paid = '2026-11-04' WHERE supplier IN ('AA Alive', 'YSP Industries')");
    await inv.paymentsUpdateOnce(db2);
    const rows = (await db2.query('SELECT supplier, proposed::float AS rm, approved, paid, pay_date::text AS d FROM inv_payments ORDER BY id')).rows;
    const of = (s) => rows.filter((r) => r.supplier === s);
    for (const gone of ['Redwood Pharma', 'Pahang Pharmacy', 'Kotra Pharma']) assert.equal(of(gone).length, 0, gone);
    assert.ok(of('AA Alive')[0].paid && of('YSP Industries')[0].paid, 'paid lines stay');
    assert.equal(of('Teepham Medical')[0].approved, 'Yes', 'approved Teepham stays');
    const z = of('Zuellig Pharma');
    assert.deepEqual(z.map((r) => r.rm), [41000, 71000, 3961.58]);
    assert.deepEqual(z.map((r) => r.approved), ['Yes', 'Yes', null], 'the balance waits for approval');
    assert.equal(z[2].d, '2026-11-12');
    assert.equal(of('DKSH (104)')[0].rm, 55023.25);
    assert.equal(of('DKSH (104)')[0].approved, null);
    const added = { Tongee: 10237.62, AISH: 4588.85, Duopharma: 3911.96, Nova: 3340.8, 'Ben Way': 2864.35, DCH: 2100, 'Mun Xin': 1599.62, 'DKSH (103)': 1000 };
    for (const [s, rm] of Object.entries(added)) {
      assert.equal(of(s).length, 1, s); assert.equal(of(s)[0].rm, rm, s); assert.equal(of(s)[0].d, '2026-11-19', s); assert.equal(of(s)[0].approved, null, s);
    }
    // The plan's RM200,628.03 = Zuellig + DKSH (104) + the new suppliers.
    const planTotal = z.reduce((a, r) => a + r.rm, 0) + 55023.25 + Object.values(added).reduce((a, b) => a + b, 0);
    assert.equal(Math.round(planTotal * 100) / 100, 200628.03);
    // Once only
    await db2.query("DELETE FROM inv_payments WHERE supplier = 'Nova'");
    await inv.paymentsUpdateOnce(db2);
    assert.equal((await db2.query("SELECT count(*)::int AS n FROM inv_payments WHERE supplier = 'Nova'")).rows[0].n, 0);
    // The page shows them for approval
    const d = await inv.loadPage(db2, { today: '2026-11-04' });
    assert.equal(Math.round(d.S.pending_rm * 100) / 100, Math.round((3961.58 + 55023.25 + 29643.2 - 3340.8) * 100) / 100);
  } finally { await db2.close(); }
});

test('4 Nov: ticking a line answers the branches’ open out-of-stock reports for that item', async () => {
  const oos = require('../../src/oos/data');
  const om = require('../../src/inventory/oosmatch');
  const admin = (await db.query("SELECT * FROM users WHERE username = 'admin'")).rows[0];
  const br = async (code) => (await db.query('SELECT * FROM branches WHERE code = $1', [code])).rows[0];
  const rep = async (code, item) => (await oos.report(db, admin, await br(code), { item, left: 'none', asking: '1-2' }, { now })).id;
  const jh = await rep('JH', 'PANADOL REGULAR 10S');
  const wm = await rep('WM', 'Panadol Regular 10s');
  const brItem = await rep('BR', 'PANADOL REGULAR 10S');          // BR isn't short – it gives
  const other = await rep('JH', 'PANADOL EXTEND 665MG TABLET 6S'); // a different Panadol
  const answeredAlready = await rep('Bangi', 'PANADOL REGULAR 10S');
  await oos.answerItem(db, admin, await oos.loadItem(db, answeredAlready), { answer: 'order' }, { now });
  const line = (await db.query(`SELECT l.id FROM inv_plan_lines l JOIN inv_plans p ON p.id = l.plan_id
    WHERE p.plan_date = '2026-11-03' AND l.item LIKE 'Panadol Regular Coated%'`)).rows[0];
  const alia = await login('password', 'alia', 'alia-pass-1');
  await alia.post(`/inventory/lines/${line.id}`, { done: '0' });
  const page = (await alia.get('/inventory?date=2026-11-03&q=panadol+regular')).html;
  assert.match(page, /📦 2 OOS reports: /);
  assert.match(page, /">WM<\/a> → transfer from BR/); assert.match(page, /">JH<\/a> → transfer from BR/);
  const r = await alia.post(`/inventory/lines/${line.id}`, { done: '1', date: '2026-11-03' });
  assert.match(msg(r), /Out-of-stock answered: (JH|WM) – transfer from BR, (JH|WM) – transfer from BR\./);
  const got = async (id) => (await db.query('SELECT o.answer, o.answer_qty, o.status, o.reason_for_delay, b.code AS fb FROM oos_items o LEFT JOIN branches b ON b.id = o.from_branch_id WHERE o.id = $1', [id])).rows[0];
  const a = await got(jh);
  assert.equal(a.answer, 'transfer'); assert.equal(a.fb, 'BR'); assert.equal(a.answer_qty, 10);
  assert.match(a.reason_for_delay, /Mr Eve plan 3 Nov: URGENT 1 - TRANSFER \+ ORDER – BR 10 strips/);
  assert.equal((await got(wm)).answer, 'transfer');
  assert.equal((await got(brItem)).answer, null, 'BR not short');
  assert.equal((await got(other)).answer, null, 'Panadol Extend ≠ Panadol Regular');
  assert.equal((await got(answeredAlready)).answer, 'order', 'an answer already given is kept');
  assert.match((await alia.get('/inventory?date=2026-11-03&view=done')).html, /✔ OOS answered: .*">WM<\/a> \(transfer from BR\)/);
  // Pure rules
  assert.deepEqual(om.sourceFor('BR 3 to JH; Ampang 2 to WM (BR 7, Ampang 6)', 'WM'), { from: 'Ampang', qty: 2 });
  assert.deepEqual(om.sourceFor('HQ/Transit 42 (has 252)', 'BR'), { from: 'HQ', qty: 42 });
  assert.equal(om.sourceFor('none', 'JH'), null);
  assert.equal(om.itemMatch('Hydrocyn Aqua 100ml spray (A)', 'HYDROCYN AQUA WOUND GEL 0.05% 15G'), 0);
  assert.ok(om.itemMatch('Xepa Tussidex Forte 120ml + Mucoprom syrup (A)', 'XEPA MUCOPROM 100MG/2.5MG SYRUP 120ML') > 0);
  const order = om.proposals({ action: 'URGENT 2 - ORDER', section: 'urgent', item: 'Hydrocyn Aqua 100ml spray (A)', short_at: '0 at every outlet + HQ', transfer_from: 'none', supplier: 'Teepham' },
    [{ id: 1, item: 'HYDROCYN AQUA SPRAY 100ML', branch_code: 'Ampang' }]);
  assert.equal(order[0].body.answer, 'order');
  assert.equal(om.proposals({ action: 'RECOUNT', section: 'recount', item: 'PANADOL REGULAR 10S', short_at: 'JH -5' }, [{ id: 1, item: 'PANADOL REGULAR 10S', branch_code: 'JH' }]).length, 0);
});
