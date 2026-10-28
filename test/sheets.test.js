// Sales sheet link: reading the real export of the 2026 Sales Dashboard, syncing into daily
// entries, and how the Daily Entry screen treats numbers that come from the sheet.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');

const { parseSalesTab, parseNumber, parseDate } = require('../src/sheets/parse');
const { signJwt } = require('../src/sheets/google');
const { syncSalesSheet } = require('../src/sheets/sync');
const { readSheetExport } = require('./helpers/csv');
const { createDb } = require('../src/db');
const { migrate } = require('../src/db/migrate');
const { readSeed, loadSeed } = require('../src/db/seed');
const { createApp } = require('../src/app');

const tabs = readSheetExport(fs.readFileSync(`${__dirname}/fixtures/sales-sheet-export.txt`, 'utf8'));
const seed = readSeed();
const cfg = (code) => seed.branches.find((b) => b.code === code).sales_sheet;
const day = (code, date) => parseSalesTab(tabs[cfg(code).tab], cfg(code).columns).find((d) => d.date === date);

// ───────────── Reading the sheet ─────────────

test('numbers and dates as the sheet writes them', () => {
  assert.equal(parseNumber('1,146.01'), 1146.01);
  assert.equal(parseNumber(1507.2), 1507.2);
  assert.equal(parseNumber(''), null);
  assert.equal(parseNumber('#DIV/0!'), null);
  assert.equal(parseDate('1/10/2026'), '2026-10-01');
  assert.equal(parseDate('01/10/2026'), '2026-10-01');
  assert.equal(parseDate(46307), '2026-10-12');  // a date cell sent as a serial number
  assert.equal(parseDate('31/02/2026'), null);
  assert.equal(parseDate('Total'), null);
});

test('every branch tab: 12 Oct walk-in (Total minus Grab Pay), Grab Pay as Grab sales, GrabMart as Grab orders', () => {
  // WM: Total 1,565.85 − Grab Pay 18.70 = walk-in 1,547.15; GrabMart column = 1 order
  assert.deepEqual(day('WM', '2026-10-12').values, { walkin: 1547.15, tx: 55, grab: 18.7, graord: 1 });
  assert.deepEqual(day('BR', '2026-10-12').values, { walkin: 1490.95, tx: 59, grab: 16.25, graord: 1 }); // BR: "Grabpay", "Grab Order"
  assert.deepEqual(day('JH', '2026-10-12').values, { walkin: 1403.2, tx: 59, grab: 94.6, graord: 2 });
  assert.deepEqual(day('Bangi', '2026-10-12').values, { walkin: 1525.8, tx: 52, grab: 175.02, graord: 5 });
  assert.deepEqual(day('Ampang', '2026-10-12').values, { walkin: 963.7, tx: 35, grab: 40.6, graord: 1 });
  // Branch total sales are unchanged: walk-in + Grab = the till Total
  const wm = day('WM', '2026-10-12').values;
  assert.ok(Math.abs(wm.walkin + wm.grab - 1565.85) < 0.001);
});

test('column headers match without case or spaces, and "minus" columns may be blank', () => {
  const rows = [['Day', 'Date', 'Transaction', 'Grabpay', 'Total', 'Zakat '], ['Mon', '12/10/2026', '10', '', '100.00', '5']];
  assert.deepEqual(parseSalesTab(rows, { walkin: { column: 'Total', minus: ['GRAB PAY'] }, grab: 'GRAB PAY', zakat: 'Zakat' })[0].values,
    { walkin: 100, zakat: 5 });
});

test('zakat, Shopee and Alpine come through (different columns per branch)', () => {
  assert.equal(day('BR', '2026-10-13').values.zakat, 732.72);
  assert.equal(day('BR', '2026-10-11').values.shopee, 2019.06);
  assert.equal(day('BR', '2026-10-07').values.alpine, 587.7);
  assert.equal(day('JH', '2026-10-02').values.zakat, 10573.46); // header is "Zakat " with a space
  assert.equal(day('WM', '2026-10-02').values.zakat, 5743.86);
});

test('the sheet agrees with the app\'s starting figure: WM 1–11 Oct = RM 19,900', () => {
  const rows = parseSalesTab(tabs[cfg('WM').tab], cfg('WM').columns).filter((d) => d.date <= '2026-10-11' && d.date >= '2026-10-01');
  const total = rows.reduce((a, d) => a + (d.values.walkin || 0) + (d.values.grab || 0) + (d.values.zakat || 0), 0);
  assert.ok(Math.abs(total - seed.branches[0].before_tracker.sales_1_to_11_oct) < 1, `got ${total}`);
});

test('every month block is read, January to October', () => {
  const wm = parseSalesTab(tabs[cfg('WM').tab], cfg('WM').columns);
  assert.equal(wm.filter((d) => d.date.startsWith('2026-01')).length, 31);
  assert.equal(wm.filter((d) => d.date.startsWith('2026-09')).length, 30);
});

test('a repeated date is merged – the stray empty 01/09 row in the WM tab doesn\'t hide the real one', () => {
  const sep1 = parseSalesTab(tabs[cfg('WM').tab], cfg('WM').columns).find((d) => d.date === '2026-09-01');
  assert.equal(sep1.values.walkin, 2473.35); // Total 2,562.03 − Grab Pay 88.68
  assert.equal(sep1.duplicate, true);
  const flipped = parseSalesTab([['Day', 'Date', 'Transaction', 'Total'], ['Tue', '01/09/2026', '66', '2,562.03'], ['Tue', '01/09/2026', '', '']], { walkin: 'Total' });
  assert.deepEqual(flipped[0].values, { walkin: 2562.03 });
});

// ───────────── Google sign-in ─────────────

test('service account sign-in token is signed with the private key', () => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwt = signJwt({ email: 'app@p4u.iam.gserviceaccount.com', privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }) }, 1_800_000_000);
  const [h, c, sig] = jwt.split('.');
  assert.ok(crypto.verify('RSA-SHA256', Buffer.from(`${h}.${c}`), publicKey, Buffer.from(sig, 'base64url')));
  const claims = JSON.parse(Buffer.from(c, 'base64url'));
  assert.equal(claims.scope, 'https://www.googleapis.com/auth/spreadsheets.readonly'); // read only
  assert.equal(claims.exp - claims.iat, 3600);
});

// ───────────── Sync and the Daily Entry screen ─────────────

let db; let server; let base;
const TODAY = '2026-10-14';
const fakeLink = (enabled = true) => ({
  enabled: async () => enabled,
  status: async () => ({ enabled, lastSync: '2026-10-14T08:30:00Z', lastError: null }),
  syncNow: async () => syncSalesSheet(db, { readRows: async (names) => Object.fromEntries(names.map((n) => [n, tabs[n]])), today: TODAY, trackerStart: '2026-10-12' }),
});

test.before(async () => {
  db = await createDb({ url: '', localDir: 'memory' });
  await migrate(db);
  await loadSeed(db, seed, { adminPassword: 'admin-pass-1' });
  await db.query("UPDATE users SET pin_hash = $1 WHERE username = 'hazera'", [bcrypt.hashSync('1111', 4)]);
  server = createApp(db, { now: () => new Date(`${TODAY}T21:00:00+08:00`), salesSheet: fakeLink() }).listen(0);
  base = `http://localhost:${server.address().port}`;
});
test.after(async () => { server.close(); await db.close(); });

const entry = async (code, date, field) => (await db.query(
  `SELECT e.value, e.source FROM daily_entries e JOIN branches b ON b.id = e.branch_id
   WHERE b.code = $1 AND e.entry_date = $2 AND e.field_key = $3`, [code, date, field])).rows[0] || null;

test('sync writes the sheet\'s numbers from 12 Oct to today only, marked as from the sheet', async () => {
  const r = await fakeLink().syncNow();
  assert.ok(r.changed > 0);
  assert.deepEqual(await entry('WM', '2026-10-12', 'walkin'), { value: 1547.15, source: 'sheet' });
  assert.deepEqual(await entry('WM', '2026-10-12', 'grab'), { value: 18.7, source: 'sheet' });
  assert.deepEqual(await entry('BR', '2026-10-13', 'zakat'), { value: 732.72, source: 'sheet' });
  assert.equal(await entry('WM', '2026-10-11', 'walkin'), null);  // before the tracker: in the starting figure
  assert.equal(await entry('JH', '2026-11-01', 'walkin'), null);  // template row in the future
  const audit = (await db.query("SELECT action, new_value FROM audit_log WHERE record_key = 'WM 2026-10-12 walkin'")).rows;
  assert.deepEqual(audit, [{ action: 'sheet_sync', new_value: 1547.15 }]);
});

test('syncing again changes nothing; a changed cell is updated and logged', async () => {
  assert.equal((await fakeLink().syncNow()).changed, 0);
  const wm = tabs[cfg('WM').tab];
  const row = wm.findIndex((r) => r[1] === '12/10/2026');
  const saved = wm[row][8];
  wm[row][8] = '1,600.00';
  try {
    const r = await fakeLink().syncNow();
    assert.equal(r.changed, 1);
    assert.equal((await entry('WM', '2026-10-12', 'walkin')).value, 1581.3); // 1,600 − Grab Pay 18.70
    const last = (await db.query("SELECT old_value, new_value FROM audit_log WHERE record_key = 'WM 2026-10-12 walkin' ORDER BY id DESC LIMIT 1")).rows[0];
    assert.deepEqual(last, { old_value: 1547.15, new_value: 1581.3 });
  } finally {
    wm[row][8] = saved;
    await fakeLink().syncNow();
  }
});

async function staffSession() {
  const res = await fetch(`${base}/login/pin`, {
    method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: 'username=hazera&pin=1111',
  });
  const cookie = res.headers.get('set-cookie').split(';')[0];
  const get = async (p) => (await fetch(base + p, { headers: { cookie } })).text();
  const post = async (p, form) => fetch(base + p, {
    method: 'POST', redirect: 'manual', headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(form).toString(),
  });
  return { get, post };
}

test('daily entry shows sheet numbers read-only and saving never overwrites them', async () => {
  const s = await staffSession();
  const html = await s.get('/daily?date=2026-10-13');
  assert.match(html, /Walk-in sales \(RM\) <span class="sheet-tag">Sales sheet<\/span>/);
  assert.match(html, /name="f\[walkin\]"[^>]*value="1042.3"[^>]*disabled/);
  assert.match(html, /fill in from the 2026 Sales Dashboard/);
  const csrf = html.match(/name="_csrf" value="([^"]+)"/)[1];
  // a browser doesn't send disabled boxes; even a forged value must be ignored
  const r = await s.post('/daily', { _csrf: csrf, date: '2026-10-13', 'f[walkin]': '1', 'f[two]': '20', 'f[pwp]': '3' });
  assert.equal(r.status, 302);
  assert.deepEqual(await entry('WM', '2026-10-13', 'walkin'), { value: 1042.3, source: 'sheet' });
  assert.equal((await entry('WM', '2026-10-13', 'pwp')).value, 3);
});

test('"2+ items" is still checked against the sheet\'s transaction count', async () => {
  const s = await staffSession();
  const csrf = (await s.get('/daily?date=2026-10-13')).match(/name="_csrf" value="([^"]+)"/)[1];
  const r = await s.post('/daily', { _csrf: csrf, date: '2026-10-13', 'f[two]': '99' }); // sheet says 58 transactions
  assert.equal(r.status, 422);
  assert.match(await r.text(), /Can’t be more than “Transactions \(POS\)” \(58\)/);
});

test('with the link off, the same boxes are typed as before', async () => {
  const off = createApp(db, { now: () => new Date(`${TODAY}T21:00:00+08:00`), salesSheet: fakeLink(false) }).listen(0);
  try {
    const res = await fetch(`http://localhost:${off.address().port}/login/pin`, {
      method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'username=hazera&pin=1111' });
    const cookie = res.headers.get('set-cookie').split(';')[0];
    const html = await (await fetch(`http://localhost:${off.address().port}/daily`, { headers: { cookie } })).text();
    assert.doesNotMatch(html, /sheet-tag/);
    assert.match(html, /name="f\[walkin\]"(?![^>]*disabled)[^>]*>/);
  } finally { off.close(); }
});

test('Google requests: read-only token, the five tabs in one call, and a clear message if not shared', async () => {
  const { readTabs } = require('../src/sheets/google');
  const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const account = { email: 'p4u-dashboard@p4u.iam.gserviceaccount.com', privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }) };
  const calls = [];
  const fakeGoogle = (status) => async (url, opts) => {
    calls.push({ url: String(url), opts });
    if (String(url).includes('oauth2')) return new Response(JSON.stringify({ access_token: 'tok' }), { status: 200 });
    if (status !== 200) return new Response(JSON.stringify({ error: { message: 'The caller does not have permission' } }), { status });
    return new Response(JSON.stringify({ valueRanges: [{ values: [['Day', 'Date']] }, {}] }), { status: 200 });
  };
  const out = await readTabs({ account, sheetId: 'SHEET', tabs: ['Daily sales WM', 'Daily sales BR'], fetchImpl: fakeGoogle(200) });
  assert.deepEqual(out, { 'Daily sales WM': [['Day', 'Date']], 'Daily sales BR': [] });
  const get = new URL(calls[1].url);
  assert.deepEqual(get.searchParams.getAll('ranges'), ["'Daily sales WM'", "'Daily sales BR'"]);
  assert.equal(calls[1].opts.headers.authorization, 'Bearer tok');

  await assert.rejects(
    readTabs({ account, sheetId: 'SHEET', tabs: ['Daily sales WM'], fetchImpl: fakeGoogle(403) }),
    /Share it \(Viewer\) with p4u-dashboard@p4u\.iam\.gserviceaccount\.com/);
});

test('16 Oct: the Grab Pay column renamed "Grab sales (RM)" is still read; a missing column is reported', () => {
  const { missingColumns } = require('../src/sheets/parse');
  const cols = seed.branches.find((b) => b.code === 'WM').sales_sheet.columns;
  const rows = [
    ['OCTOBER'],
    ['Day', 'Date', 'Zakat', 'GrabMart', 'Transaction', 'Cash', 'QR/Online', 'Card', 'Grab sales (RM)', 'Total'],
    ['Thu', '1/10/2026', '', 3, 50, '320.00', '169.30', '486.55', '170.16', '1,146.01'],
    ['Fri', '16/10/2026', '', 0, 55, '282.40', '657.60', '414.30', '0.00', '1,354.30'],
  ];
  const days = parseSalesTab(rows, cols);
  assert.deepEqual(days[0].values, { walkin: 975.85, tx: 50, grab: 170.16, graord: 3 });
  assert.equal(days[1].values.grab, 0);
  assert.deepEqual(missingColumns(rows, cols), []);
  const noGrab = rows.map((r, i) => (i === 1 ? r.map((c) => (c === 'Grab sales (RM)' ? 'Grab' : c)) : r));
  assert.deepEqual(missingColumns(noGrab, cols), ['walkin: no column “GrabMart Sales (RM)” to take off', 'grab: no column “GrabMart Sales (RM)”']);
});

test('28 Oct: a "GrabMart Sales (RM)" column is read as Grab sales and kept out of walk-in, every branch', () => {
  const { readSeed } = require('../src/db/seed');
  for (const b of readSeed().branches) {
    const rows = [
      ['', 'Date', 'Transaction', 'Cash', 'GrabMart Sales (RM)', 'Total', 'GrabMart', 'Zakat', 'Shopee Sales', 'Alpine'],
      ['MONDAY', '26/10/2026', '50', '900', '45.50', '1,245.50', '2', '', '', ''],
    ];
    const [day] = parseSalesTab(rows, b.sales_sheet.columns);
    assert.equal(day.values.grab, 45.5, b.code);
    assert.equal(day.values.walkin, 1200, `${b.code}: walk-in = Total minus GrabMart sales`);
    assert.equal(day.values.graord, 2, `${b.code}: GrabMart (orders) still the order count`);
  }
});
