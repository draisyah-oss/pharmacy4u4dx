// 3 Nov: Inventory page (/inventory) – Dr Aisyah (admin), Alia and Azwani only; read only; works
// from the two Drive sheets (a fake source here) and shows a clear note when Drive isn't set up.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
// 3 Nov 2026: Ordering & payments (/inventory) – the Mr Eve board in the app.
const test = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');

const { createDb } = require('../../src/db');
const { migrate } = require('../../src/db/migrate');
const { readSeed, loadSeed } = require('../../src/db/seed');
const { createApp } = require('../../src/app');
const { mentionsSalary } = require('../../src/privacy');

const fx = (f) => fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'inventory', f), 'utf8');

let db; const servers = []; let base; let bareBase; let brokenBase;
let loads = 0; let forced = 0;
const fakeSource = {
  configured: () => true,
  status: () => ({ configured: true, email: 'mr-you@p4u.iam.gserviceaccount.com' }),
  async load(settings, { force = false } = {}) {
    loads++; if (force) forced++;
    assert.equal(settings.inputs_folder_id, '1VXbTmy4QE_6aJXueJsIWkJVE-J_5DXZs', 'folder id comes from app_settings inventory_board');
    return {
      planFile: { id: 'p', name: 'Mr Eve Daily Plan 03 Nov 2026', modifiedTime: '2026-11-02T23:56:41Z' },
      planCsv: fx('daily-plan.csv'), paymentsCsv: fx('payment-approvals.csv'), fetchedAt: new Date('2026-11-03T01:00:00Z'), cached: false,
    };
  },
};
const brokenSource = { configured: () => true, status: () => ({ configured: true }), load: async () => { throw new Error('The app can\'t open the Inputs folder. Share it.'); } };
const inv = require('../../src/inventory/data');

let db; let server; let base;
const clock = new Date('2026-11-03T15:00:00+08:00');
const now = () => clock;

test.before(async () => {
  db = await createDb({ url: '', localDir: 'memory' });
  await migrate(db);
  await loadSeed(db, readSeed(), { adminPassword: 'admin-pass-1' });
  const pw = (u, v) => db.query('UPDATE users SET password_hash = $1 WHERE username = $2', [bcrypt.hashSync(v, 4), u]);
  const pin = (u, v) => db.query('UPDATE users SET pin_hash = $1 WHERE username = $2', [bcrypt.hashSync(v, 4), u]);
  await pw('alia', 'alia-pass-1'); await pw('hanin', 'hanin-pass-1'); await pw('hafizah', 'hafizah-pass1');
  await pin('azwani', '2222'); await pin('syarafana', '3333'); await pin('hazera', '1111');
  const now = () => new Date('2026-11-03T15:00:00+08:00');
  const listen = (opts) => { const s = createApp(db, { now, ...opts }).listen(0); servers.push(s); return `http://localhost:${s.address().port}`; };
  base = listen({ inventorySource: fakeSource });
  bareBase = listen({});
  brokenBase = listen({ inventorySource: brokenSource });
});
test.after(async () => { servers.forEach((s) => s.close()); await db.close(); });

async function login(b, p, form) {
  const r = await fetch(b + p, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(form).toString() });
  assert.equal(r.status, 302, `login ${form.username}`);
  const cookie = r.headers.get('set-cookie').split(';')[0];
  const get = (u) => fetch(b + u, { redirect: 'manual', headers: { cookie } });
  const post = async (u, body = {}) => {
    const html = await (await get('/inventory')).text();
    const csrf = (/name="_csrf" value="([^"]+)"/.exec(html) || [])[1];
    return fetch(b + u, { method: 'POST', redirect: 'manual', headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ _csrf: csrf, ...body }).toString() });
  };
  return { get, post };
}
const as = {
  admin: (b = base) => login(b, '/login/password', { username: 'admin', password: 'admin-pass-1' }),
  alia: (b = base) => login(b, '/login/password', { username: 'alia', password: 'alia-pass-1' }),
  azwani: (b = base) => login(b, '/login/pin', { username: 'azwani', pin: '2222' }),
  syarafana: (b = base) => login(b, '/login/pin', { username: 'syarafana', pin: '3333' }),
  hanin: (b = base) => login(b, '/login/password', { username: 'hanin', password: 'hanin-pass-1' }),
  hafizah: (b = base) => login(b, '/login/password', { username: 'hafizah', password: 'hafizah-pass1' }),
  hazera: (b = base) => login(b, '/login/pin', { username: 'hazera', pin: '1111' }),
};

test('Dr Aisyah (admin), Alia and Azwani open the page; it is in their Inventory menu', async () => {
  for (const who of ['admin', 'alia', 'azwani']) {
    const u = await as[who]();
    const r = await u.get('/inventory');
    assert.equal(r.status, 200, who);
    const html = await r.text();
    assert.match(html, /<h1>Inventory – ordering &amp; payments<\/h1>/, who);
    assert.match(html, /href="\/inventory"[^>]*>Ordering &amp; payments/, `${who}: menu item`);
    const home = await (await u.get('/')).text();
    assert.match(home, /href="\/inventory"/, `${who}: menu item on other pages too`);
  }
});

test('everyone else is turned away and has no menu item; nothing without logging in', async () => {
  for (const who of ['syarafana', 'hanin', 'hafizah', 'hazera']) {
    const u = await as[who]();
    assert.equal((await u.get('/inventory')).status, 403, who);
    assert.doesNotMatch(await (await u.get('/')).text(), /href="\/inventory"/, who);
    assert.equal((await u.post('/inventory/refresh')).status, 403, `${who}: refresh`);
  }
  assert.equal((await fetch(`${base}/inventory`, { redirect: 'manual' })).status, 302);
});

test('the four sections, worked out from the sheets', async () => {
  const html = await (await (await as.alia()).get('/inventory')).text();
  assert.match(html, /Today’s list is <b>Mr Eve Daily Plan 03 Nov 2026<\/b>/);
  // 1 takeaway + tiles
  assert.match(html, /Today: <b>4<\/b> items to order now from open suppliers \(about <b>RM186<\/b>\), and <b>13<\/b> transfers/);
  assert.match(html, /Next supplier payment: <b>Zuellig Pharma RM41,000<\/b> on <b>05\/11\/2026<\/b>/);
  assert.match(html, /Approved, not marked paid<\/span><span class="inv-big">RM30,655<\/span>/);
  assert.match(html, /inv-tile is-warn/);
  // 2 suppliers
  assert.match(html, /Can I order from this supplier\?/);
  assert.match(html, /<th scope="row">Redwood Pharma<\/th><td><span class="inv-pill g-hold">On hold<\/span>/);
  assert.match(html, /Total November PO budget: <b>RM200,628<\/b>/);
  // 3 today's list – all 27 lines and the filter pills with counts
  assert.equal((html.match(/<tr class="sec-/g) || []).length, 27);
  assert.match(html, /href="\/inventory\?show=urgent#today">Urgent <span class="chip-count">12<\/span>/);
  assert.match(html, /<th scope="row">Tongee<\/th>/);
  assert.match(html, /<td class="mo-c">115,962<\/td>/);
  // every section folds (plain <details>, open by default) + Fold all / Open all
  for (const id of ['glance', 'suppliers', 'today', 'payments', 'approvals']) {
    assert.match(html, new RegExp(`<details class="oo-card inv-sec" (open id="${id}"|id="${id}" open)>`), id);
  }
  assert.match(html, /data-fold="close">Fold all<\/button>/);
  assert.match(html, /<script src="\/js\/inventory\.js\?v=1" defer><\/script>/);
  // Excel-style filters on the supplier table, today's list and approvals (public/js/table-filter.js)
  assert.equal((html.match(/<table class="mo-t inv-t" data-xfilter/g) || []).length, 3);
  assert.match(html, /<script src="\/js\/table-filter\.js\?v=1" defer><\/script>/);
  // 4 payment plan
  assert.match(html, /November payment plan/);
  assert.match(html, /<svg class="inv-chart"/);
  assert.match(html, /Tightest week: <b>1–8 Nov<\/b>, RM10,849 left/);
  assert.match(html, /<span class="inv-pill g-late">Not marked paid<\/span>/);
  assert.match(html, /Waiting for Dr Aisyah’s approval: <b>RM45,000<\/b>/);
  // Read only: the only form posts to the refresh.
  const actions = [...html.matchAll(/<form method="post" action="([^"]+)"/g)].map((m) => m[1]).filter((a) => a !== '/logout');
  assert.deepEqual([...new Set(actions)], ['/inventory/refresh']);
  assert.ok(!mentionsSalary(html.replace(/<script[\s\S]*?<\/script>/g, '')), 'no salaries on the page');
});

test('filters and search narrow today\'s list', async () => {
  const u = await as.azwani();
  const urgent = await (await u.get('/inventory?show=urgent')).text();
  assert.equal((urgent.match(/<tr class="sec-/g) || []).length, 12);
  assert.match(urgent, /href="\/inventory\?show=urgent#today" aria-current="page"/);
  const recount = await (await u.get('/inventory?show=recount&q=swab')).text();
  assert.equal((recount.match(/<tr class="sec-/g) || []).length, 1);
  assert.match(recount, /NUR CARE ALCOHOL SWAB 1S/);
  const none = await (await u.get('/inventory?q=%3Cscript%3E')).text();
  assert.match(none, /Nothing here for “&lt;script&gt;”/);
  assert.equal((await u.get('/inventory?show=../../etc')).status, 200);
});

test('"Check Drive now" asks the source to skip its wait', async () => {
  const u = await as.admin();
  const before = forced;
  const r = await u.post('/inventory/refresh');
  assert.equal(r.status, 302);
  assert.equal(r.headers.get('location'), '/inventory?ok=refreshed');
  assert.equal(forced, before + 1);
  assert.ok(loads > 0);
  const noToken = await fetch(`${base}/inventory/refresh`, { method: 'POST', redirect: 'manual' });
  assert.notEqual(noToken.status, 200);
});

test('Drive not set up: admin sees the setup steps, Alia a short note; the payment plan still shows', async () => {
  const admin = await (await (await as.admin(bareBase)).get('/inventory')).text();
  assert.match(admin, /Not connected to Google Drive yet/);
  assert.match(admin, /INVENTORY_GOOGLE_SERVICE_ACCOUNT_JSON/);
  assert.match(admin, /November payment plan/);
  assert.doesNotMatch(admin, /Today’s list/);
  const alia = await (await (await as.alia(bareBase)).get('/inventory')).text();
  assert.match(alia, /Dr Aisyah is setting up the link to Google Drive/);
  assert.doesNotMatch(alia, /INVENTORY_GOOGLE_SERVICE_ACCOUNT_JSON/);
});

test('Drive error: the message and a Try again button, no crash', async () => {
  const html = await (await (await as.alia(brokenBase)).get('/inventory')).text();
  assert.match(html, /Couldn’t read Google Drive just now: The app can&#39;t open the Inputs folder\. Share it\./);
  assert.match(html, /Try again/);
  assert.match(html, /November payment plan/);
});

test('viewers come from app_settings inventory_board (Admin can add someone)', async () => {
  const r = (await db.query("SELECT value FROM app_settings WHERE key = 'inventory_board'")).rows[0];
  const v = JSON.parse(r.value);
  assert.deepEqual(v.viewers, ['Alia', 'Azwani']);
  await db.query("UPDATE app_settings SET value = $1 WHERE key = 'inventory_board'", [JSON.stringify({ ...v, viewers: ['Alia', 'Azwani', 'Syarafana'] })]);
  try {
    assert.equal((await (await as.syarafana()).get('/inventory')).status, 200);
  } finally {
    await db.query("UPDATE app_settings SET value = $1 WHERE key = 'inventory_board'", [r.value]);
  }
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
