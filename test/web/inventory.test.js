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
  p = (await db.query('SELECT paid, pv_no, date_paid::text AS d FROM inv_payments WHERE id = $1', [dksh.id])).rows[0];
  assert.deepEqual([p.paid, p.pv_no, p.d], [true, 'PV-881', '2026-11-03']);
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
  assert.equal(j.lines.length, 2); assert.equal(j.lines[0].section, 'urgent'); assert.equal(j.lines[1].section, 'hq');
  assert.equal(j.summary.order_now_lines, 1);
  assert.ok(j.payments.every((p) => p.approved_by === undefined));
  r = await api('POST', '/inventory/plan', { date: 'x', rows });
  assert.equal(r.status, 400);
  delete process.env.AGENT_API_TOKEN;
});
