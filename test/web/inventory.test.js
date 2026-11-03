// 3 Nov: Inventory page (/inventory) – Dr Aisyah (admin), Alia and Azwani only; read only; works
// from the two Drive sheets (a fake source here) and shows a clear note when Drive isn't set up.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
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
  assert.match(html, /Total November PO budget: <b>RM200,000<\/b>/);
  // 3 today's list – all 27 lines and the filter pills with counts
  assert.equal((html.match(/<tr class="sec-/g) || []).length, 27);
  assert.match(html, /href="\/inventory\?show=urgent#today">Urgent <span class="chip-count">12<\/span>/);
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
});
