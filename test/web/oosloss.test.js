// 3 Nov 2026: estimated sales lost to out of stock (selling price × customers turned away).
const test = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');

const { createDb } = require('../../src/db');
const { migrate } = require('../../src/db/migrate');
const { readSeed, loadSeed } = require('../../src/db/seed');
const { createApp } = require('../../src/app');
const oos = require('../../src/oos/data');
const loss = require('../../src/oos/loss');

let db; let server; let base;
const now = () => new Date('2026-11-03T15:00:00+08:00');

test.before(async () => {
  db = await createDb({ url: '', localDir: 'memory' });
  await migrate(db);
  await loadSeed(db, readSeed(), { adminPassword: 'admin-pass-1' });
  await db.query('UPDATE users SET pin_hash = $1 WHERE username = $2', [bcrypt.hashSync('1111', 4), 'hazera']);
  await db.query(`INSERT INTO products (barcode, stock_id, description, uom, active, search, cost, price1, price2) VALUES
    ('111', '1', 'PANADOL REGULAR 10S', 'STP', true, 'panadol regular 10s', 2.1, 3.5, 3.2),
    ('222', '2', 'XEPA TUSSIDEX 120ML', 'BOT', true, 'xepa tussidex 120ml', 9, 14.9, 14)`);
  server = createApp(db, { now }).listen(0);
  base = `http://localhost:${server.address().port}`;
});
test.after(async () => { server.close(); await db.close(); });

test('estimate = Price 1 × customers asking (at least 1); typed items matched by description; cancelled left out', async () => {
  const wm = (await db.query("SELECT * FROM branches WHERE code = 'WM'")).rows[0];
  const jh = (await db.query("SELECT * FROM branches WHERE code = 'JH'")).rows[0];
  const user = (await db.query("SELECT * FROM users WHERE role = 'admin' LIMIT 1")).rows[0];
  const pan = (await db.query("SELECT id FROM products WHERE barcode = '111'")).rows[0];
  let r = await oos.report(db, user, wm, { product_id: String(pan.id), left: 'none', asking: '3+' }, { now });
  assert.ok(r.id, JSON.stringify(r.errors));
  r = await oos.report(db, user, jh, { item: 'xepa tussidex 120ml', left: 'none', asking: '0' }, { now });
  assert.ok(r.id);
  const c = await oos.report(db, user, jh, { item: 'xepa tussidex 120ml', left: 'none', asking: '1-2' }, { now });
  await oos.cancelItem(db, user, await oos.loadItem(db, c.id), {}, { now });
  const L = await loss.lossBetween(db, { from: '2026-11-01', to: '2026-12-01' });
  assert.equal(L.total, Math.round(3.5 * 3 + 14.9 * 1));
  assert.equal(L.items, 2, 'cancelled not counted');
  assert.deepEqual(L.branches.map((b) => [b.code, b.total]), [['JH', 15], ['WM', 11]]);
  assert.equal(L.top[0].item, 'XEPA TUSSIDEX 120ML');
  const it = await oos.loadItem(db, r.id);
  assert.equal(loss.lossFor(it), 14.9);
});

test('everyone in charge sees it: front page and the branch’s out-of-stock page', async () => {
  let cookie = '';
  const req = async (method, p, body) => {
    const r = await fetch(base + p, { method, redirect: 'manual', headers: { ...(cookie ? { cookie } : {}), ...(body ? { 'content-type': 'application/x-www-form-urlencoded' } : {}) },
      body: body ? new URLSearchParams(body).toString() : undefined });
    const set = r.headers.get('set-cookie'); if (set) cookie = set.split(';')[0];
    return { status: r.status, html: await r.text() };
  };
  await req('POST', '/login/pin', { username: 'hazera', pin: '1111' });
  const home = (await req('GET', '/')).html;
  assert.match(home, /Sales lost to out of stock – November/);
  assert.match(home, /RM 11<\/b> lost at WM/);
  const page = (await req('GET', '/oos')).html;
  assert.match(page, /≈ RM 11 sales lost/);
});
