// The Sales page and "year so far" strips: the sales sheet's own "Overall Daily Sales" and
// "Total Sales" tabs, read on each sync and shown as HQ sees them in Google.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const bcrypt = require('bcryptjs');

const { createDb } = require('../../src/db');
const { migrate } = require('../../src/db/migrate');
const { readSeed, loadSeed } = require('../../src/db/seed');
const { createApp } = require('../../src/app');
const { syncSummaryTabs } = require('../../src/sheets/sync');
const { parseOverallDaily, parseTotalSales } = require('../../src/sheets/summary');
const { sheetYearCard } = require('../../src/sales/data');
const { readSheetExport } = require('../helpers/csv');

const tabs = readSheetExport(fs.readFileSync(`${__dirname}/../fixtures/sales-sheet-summary.txt`, 'utf8'));
const CODES = ['WM', 'BR', 'JH', 'Bangi', 'Ampang'];
const TODAY = '2026-10-15';
const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 0.005, `${msg || ''} expected ${b}, got ${a}`);
let db; let server; let base;

test.before(async () => {
  db = await createDb({ url: '', localDir: 'memory' });
  await migrate(db);
  await loadSeed(db, readSeed(), { adminPassword: 'admin-pass-1' });
  const pw = (u, v) => db.query('UPDATE users SET password_hash = $1 WHERE username = $2', [bcrypt.hashSync(v, 4), u]);
  const pin = (u, v) => db.query('UPDATE users SET pin_hash = $1 WHERE username = $2', [bcrypt.hashSync(v, 4), u]);
  await pw('hafizah', 'manager-pass-1'); await pin('syarafana', '2468'); await pin('hazera', '1111');
  server = createApp(db, { now: () => new Date(`${TODAY}T21:00:00+08:00`) }).listen(0);
  base = `http://localhost:${server.address().port}`;
});
test.after(async () => { server.close(); await db.close(); });

async function as(path, body) {
  let cookie = '';
  const r = await fetch(base + path, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body).toString() });
  cookie = (r.headers.get('set-cookie') || '').split(';')[0];
  assert.equal(r.status, 302, `${body.username} logs in`);
  return async (p) => { const x = await fetch(base + p, { headers: { cookie }, redirect: 'manual' }); return { status: x.status, html: await x.text() }; };
}

test('reads the daily tab: one row per day, template rows skipped', () => {
  const days = parseOverallDaily(tabs['Overall Daily Sales'], CODES);
  assert.equal(days[0].date, '2026-01-01');
  assert.equal(days[days.length - 1].date, '2026-10-14');
  const d = days.find((x) => x.date === '2026-10-14');
  near(d.branches.WM, 2175.46); near(d.branches.JH, 1417.1); near(d.branches.Ampang, 759.8);
  near(d.total, 8043.07);
});

test('reads the year table: months, B2B and total', () => {
  const y = parseTotalSales(tabs['Total Sales'], CODES, 2026);
  assert.equal(y.year, 2026);
  assert.equal(y.months[0].month, '2026-01');
  assert.equal(y.months.length, 10);
  near(y.months.reduce((a, m) => a + m.total, 0), 1815396.12, 'YTD total as the sheet shows it');
});

test('a sync stores both tabs; the year card sums them', async () => {
  const r = await syncSummaryTabs(db, { readRows: async (names) => Object.fromEntries(names.map((n) => [n, tabs[n]])), today: TODAY });
  assert.equal(r.months, 10);
  assert.ok(r.days > 280);
  const company = await sheetYearCard(db, { today: TODAY });
  near(company.ytd, 1815396.12);
  assert.equal(company.latest.date, '2026-10-14');
  near(company.latest.amount, 8043.07);
  assert.ok(company.b2b > 0, 'B2B counted in the company year');
  const wm = await sheetYearCard(db, { today: TODAY, code: 'WM' });
  near(wm.latest.amount, 2175.46);
  assert.ok(wm.ytd > 0 && wm.ytd < company.ytd);
});

test('Sales page: managers and HQ staff see it, branch staff do not', async () => {
  const mgr = await as('/login/password', { username: 'hafizah', password: 'manager-pass-1' });
  const page = await mgr('/sales');
  assert.equal(page.status, 200);
  assert.match(page.html, /Month by month/);
  assert.match(page.html, /RM 1,815,396/);
  assert.match(page.html, /1,815,396/);
  assert.match(page.html, /RM 8,043/, 'latest day total');
  const sept = await mgr('/sales?month=2026-09');
  assert.match(sept.html, /Day by day – September/);
  assert.match((await mgr('/scoreboard')).html, /class="sheet-year"/);
  assert.match((await mgr('/group')).html, /Company 2026 so far/);

  const staff = await as('/login/pin', { username: 'syarafana', pin: '2468' });
  assert.equal((await staff('/sales')).status, 200);
  const shop = await as('/login/pin', { username: 'hazera', pin: '1111' });
  assert.equal((await shop('/sales')).status, 403);
});

test('YTD target to date: last month-end target plus this month by days', async () => {
  const { ytdTargetsAt } = require('../../src/sales/data');
  const r = (await db.query("SELECT t.ytd_target_month_end AS y, t.total_sales_target AS mt FROM branch_month_targets t JOIN branches b ON b.id = t.branch_id WHERE b.code = 'WM' AND t.month = '2026-10'")).rows[0];
  const end = Number(r.y); const month = Number(r.mt);
  // No September row in the seed: end of September = end-of-October YTD target less October's target
  assert.equal((await ytdTargetsAt(db, '2026-10-14')).WM, Math.round(end - month + month * 14 / 31));
  assert.equal((await ytdTargetsAt(db, '2026-10-31')).WM, end);
});
