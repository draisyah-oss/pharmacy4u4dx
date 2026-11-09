// 6 Nov (CEO): Phone / Desktop view chosen by each person on their device.
const test = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
const { createDb } = require('../../src/db');
const { migrate } = require('../../src/db/migrate');
const { readSeed, loadSeed } = require('../../src/db/seed');
const { createApp } = require('../../src/app');

let db; let server; let base;
test.before(async () => {
  db = await createDb({ url: '', localDir: 'memory' });
  await migrate(db);
  await loadSeed(db, readSeed(), { adminPassword: 'admin-pass-1' });
  await db.query('UPDATE users SET pin_hash = $1 WHERE username = $2', [bcrypt.hashSync('1111', 4), 'hazera']);
  server = createApp(db, { now: () => new Date('2026-11-06T10:00:00+08:00') }).listen(0);
  base = `http://localhost:${server.address().port}`;
});
test.after(async () => { server.close(); await db.close(); });

test('switch to Desktop view and back; remembered by a cookie; the back link stays on this site', async () => {
  const login = await fetch(base + '/login/pin', { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'username=hazera&pin=1111' });
  const session = login.headers.get('set-cookie').split(';')[0];
  const page = async (extra = '') => (await fetch(base + '/daily', { headers: { cookie: session + extra } })).text();
  let html = await page();
  assert.match(html, /content="width=device-width/);
  assert.match(html, /href="\/view\?mode=desktop&amp;back=%2Fdaily"[^>]*>🖥 <span>Desktop view/);
  const sw = await fetch(base + '/view?mode=desktop&back=%2Fdaily', { redirect: 'manual', headers: { cookie: session } });
  assert.equal(sw.status, 302); assert.equal(sw.headers.get('location'), '/daily');
  const ck = sw.headers.get('set-cookie');
  assert.match(ck, /^p4u_view=desktop;.*Max-Age=31536000/);
  html = await page('; p4u_view=desktop');
  assert.match(html, /content="width=1280"/);
  assert.match(html, /class="[^"]*view-desktop"/);
  assert.match(html, /📱 <span>Phone view/);
  html = await page('; p4u_view=phone');
  assert.match(html, /view-phone/);
  const back = await fetch(base + '/view?mode=auto&back=//evil.com', { redirect: 'manual' });
  assert.equal(back.headers.get('location'), '/');
  assert.match(back.headers.get('set-cookie'), /p4u_view=;.*Max-Age=0/);
});

test('9 Nov: News page (with November’s achievers) and the phone tab bar render', async () => {
  const login = await fetch(base + '/login/pin', { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'username=hazera&pin=1111' });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const news = await fetch(base + '/news', { headers: { cookie } });
  assert.equal(news.status, 200);
  const html = await news.text();
  assert.match(html, /Monthly achievers/);
  assert.match(html, /class="tabbar"[\s\S]*href="\/daily"[\s\S]*Log today[\s\S]*for="nav-open"/);
  const home = await (await fetch(base + '/', { headers: { cookie } })).text();
  assert.match(home, /class="tab is-current" aria-current="page"><svg[^]*?<span>Home<\/span>/);
});

test('9 Nov: "needed per day" is worked out on a Monday before today’s numbers are in', () => {
  const { fillNeedPerDay } = require('../../src/home/highlights');
  const c = { rows: [
    { code: 'WM', asOf: '2026-11-08', sales: { month: '2026-11', mtd: 13134, monthTarget: 73000, perDay: null } },
    { code: 'X', asOf: '2026-10-31', sales: { month: '2026-11', mtd: 0, monthTarget: 1000, perDay: null } }, // last month's day: left alone
  ] };
  fillNeedPerDay(c);
  assert.equal(Math.round(c.rows[0].sales.perDay), 2721);
  assert.equal(c.rows[0].sales.daysLeft, 22);
  assert.equal(c.rows[1].sales.perDay, null);
});
