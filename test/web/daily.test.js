// Login and Daily Entry, tested through real HTTP requests against an in-memory database.
// "Today" is pinned to Tue 20 Oct 2026 (Malaysia time), so the edit window is 14–20 Oct.

const test = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');

const { createDb } = require('../../src/db');
const { migrate } = require('../../src/db/migrate');
const { readSeed, loadSeed } = require('../../src/db/seed');
const { createApp } = require('../../src/app');
const { buildHint, loadMeasures } = require('../../src/daily/data');
const calc = require('../../src/calc');

const NOW = () => new Date('2026-10-20T21:30:00+08:00');
let db; let server; let base;

test.before(async () => {
  db = await createDb({ url: '', localDir: 'memory' });
  await migrate(db);
  await loadSeed(db, readSeed(), { adminPassword: 'admin-pass-1' });
  const set = (u, col, v) => db.query(`UPDATE users SET ${col} = $1 WHERE username = $2`, [bcrypt.hashSync(v, 4), u]);
  await set('hazera', 'pin_hash', '1111');
  await set('alya', 'pin_hash', '4444');
  await set('zawiyah', 'pin_hash', '2222');
  await set('hidayah', 'pin_hash', '3333');
  await set('hafizah', 'password_hash', 'manager-pass-1');
  await set('alia', 'password_hash', 'hq-pass-123');
  server = createApp(db, { now: NOW }).listen(0);
  base = `http://localhost:${server.address().port}`;
});
test.after(async () => { server.close(); await db.close(); });

// A tiny browser: keeps the session cookie, doesn't follow redirects.
function browser() {
  let cookie = '';
  async function req(method, path, form, extra = {}) {
    const res = await fetch(base + path, {
      method, redirect: 'manual',
      headers: { cookie, ...(form ? { 'content-type': 'application/x-www-form-urlencoded' } : {}), ...extra },
      body: form ? new URLSearchParams(form).toString() : undefined,
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0].endsWith('=') ? '' : set.split(';')[0];
    return { status: res.status, location: res.headers.get('location'), html: await res.text() };
  }
  return {
    get: (p) => req('GET', p),
    post: (p, f) => req('POST', p, f),
    postJson: async (p, f) => { const r = await req('POST', p, f, { accept: 'application/json' }); return { status: r.status, body: JSON.parse(r.html) }; },
    csrf: async (p = '/daily') => (await req('GET', p)).html.match(/name="_csrf" value="([^"]+)"/)[1],
  };
}

async function pinLogin(username, pin) {
  const b = browser();
  const r = await b.post('/login/pin', { username, pin, next: '/' });
  assert.equal(r.status, 302, `PIN login for ${username} failed`);
  return b;
}
const branchId = async (code) => (await db.query('SELECT id FROM branches WHERE code = $1', [code])).rows[0].id;
const entry = async (code, date, key) => {
  const { rows } = await db.query(
    'SELECT value FROM daily_entries WHERE branch_id = $1 AND entry_date = $2 AND field_key = $3', [await branchId(code), date, key]);
  return rows.length ? rows[0].value : null;
};

// ───────────── Login ─────────────

test('pages need a login', async () => {
  const r = await browser().get('/daily');
  assert.equal(r.status, 302);
  assert.match(r.location, /^\/login\?next=/);
});

test('login page lists branches and an HQ box, then that branch\'s staff and manager', async () => {
  const b = browser();
  const first = (await b.get('/login')).html;
  assert.match(first, /Wangsa Maju[\s\S]*Ampang[\s\S]*branch=HQ/);
  assert.match(first, /Admin login/);
  const names = (await b.get('/login?branch=WM')).html;
  assert.match(names, /Hazera/);
  assert.match(names, /Zawiyah/);
  assert.match(names, /Hafizah[\s\S]*Manager/, 'the manager logs in from her own branch');
  assert.doesNotMatch(names, /Afifah/);            // JH
  assert.doesNotMatch(names, /Alia/);              // HQ
  // The manager gets a password box, not the PIN keypad
  const mgr = (await b.get('/login?branch=WM&user=hafizah')).html;
  assert.match(mgr, /Hi Hafizah, enter your password/);
  assert.doesNotMatch(mgr, /pin-form/);
  // HQ box: HQ people only
  const hq = (await b.get('/login?branch=HQ')).html;
  assert.match(hq, /Alia/);
  assert.match(hq, /Syarafana/);
  assert.doesNotMatch(hq, /Hazera/);
});

test('staff PIN: wrong PIN is refused, right PIN logs in', async () => {
  const b = browser();
  const bad = await b.post('/login/pin', { username: 'hazera', pin: '9999' });
  assert.equal(bad.status, 401);
  assert.match(bad.html, /PIN is not right/);
  const ok = await b.post('/login/pin', { username: 'hazera', pin: '1111', next: '/' });
  assert.equal(ok.status, 302);
  assert.equal((await b.get('/')).status, 200); // 1 Nov: branch logins land on their own page
});

test('5 wrong PINs lock the login for 15 minutes, even with the right PIN', async () => {
  const b = browser();
  for (let i = 0; i < 5; i++) await b.post('/login/pin', { username: 'zawiyah', pin: '0000' });
  const r = await b.post('/login/pin', { username: 'zawiyah', pin: '2222' });
  assert.equal(r.status, 401);
  assert.match(r.html, /Too many wrong tries/);
  await db.query("UPDATE users SET locked_until = NULL, failed_attempts = 0 WHERE username = 'zawiyah'");
});

test('managers, HQ and admin log in with a password; staff can\'t use the password form', async () => {
  assert.equal((await browser().post('/login/password', { username: 'hafizah', password: 'manager-pass-1' })).status, 302);
  assert.equal((await browser().post('/login/password', { username: 'admin', password: 'admin-pass-1' })).status, 302);
  assert.equal((await browser().post('/login/password', { username: 'hafizah', password: 'wrong-pass' })).status, 401);
  assert.equal((await browser().post('/login/password', { username: 'hazera', password: '1111' })).status, 401);
});

test('log out ends the session', async () => {
  const b = await pinLogin('hazera', '1111');
  const csrf = await b.csrf();
  await b.post('/logout', { _csrf: csrf });
  assert.equal((await b.get('/daily')).status, 302);
});

test('login redirects only to pages on this site', async () => {
  const b = browser();
  const r = await b.post('/login/pin', { username: 'hazera', pin: '1111', next: 'https://evil.example' });
  assert.equal(r.location, '/');
});

// ───────────── Daily entry page ─────────────

test('daily page: one card per person, Team first, then the person logged in', async () => {
  const b = await pinLogin('hazera', '1111');
  const html = (await b.get('/daily')).html;
  const order = [...html.matchAll(/<section class="person" id="([^"]+)"[\s\S]*?<h2>([^<]+)/g)].map((m) => m[2].trim());
  assert.deepEqual(order, ['Team', 'Hazera', 'Hafizah', 'Zawiyah']);
  // Hazera's card only has Hazera's fields
  const hazeraCard = html.split('<section class="person"')[2];
  assert.match(hazeraCard, /New chronic customers/);
  assert.doesNotMatch(hazeraCard, /Zakat sales/);
  // yes/no shown as buttons, "(1/0)" removed from the label
  assert.match(html, /WA group health message sent\?<\/label>/);
});

test('date strip shows the last 7 days (14–20 Oct)', async () => {
  const b = await pinLogin('hazera', '1111');
  const page = (await b.get('/daily')).html;
  const dates = [...page.slice(page.indexOf('aria-label="Choose a day"'), page.indexOf('</nav>', page.indexOf('aria-label="Choose a day"'))).matchAll(/class="strip-day[^"]*" href|href="\/daily\?date=(\d{4}-\d{2}-\d{2})/g)]
    .map((m) => m[1]).filter(Boolean);
  assert.deepEqual(dates, ['2026-10-14', '2026-10-15', '2026-10-16', '2026-10-17', '2026-10-18', '2026-10-19', '2026-10-20']);
});

test('staff only ever see their own branch', async () => {
  const b = await pinLogin('hazera', '1111');
  const html = (await b.get('/daily?branch=JH')).html;
  assert.match(html, /Wangsa Maju/);
  assert.doesNotMatch(html, /TikTok affiliate commission/); // a JH field
});

// ───────────── Saving ─────────────

test('saving needs the page\'s form token', async () => {
  const b = await pinLogin('hazera', '1111');
  const r = await b.post('/daily', { date: '2026-10-20', 'f[walkin]': '1500' });
  assert.equal(r.status, 403);
  assert.equal(await entry('WM', '2026-10-20', 'walkin'), null);
});

test('save today: numbers stored, who/when recorded, audit log written', async () => {
  const b = await pinLogin('hazera', '1111');
  const csrf = await b.csrf();
  const r = await b.post('/daily', {
    _csrf: csrf, date: '2026-10-20', 'f[walkin]': '1,880', 'f[tx]': '62', 'f[two]': '25', 'f[wagrp]': '1', 'f[chronic]': '5', 'f[zkc]': '5', 'f[zkc7d]': '5',
  });
  assert.equal(r.status, 302);
  assert.equal(r.location, '/daily?date=2026-10-20&saved=7');
  assert.equal(await entry('WM', '2026-10-20', 'walkin'), 1880); // comma removed
  assert.equal(await entry('WM', '2026-10-20', 'wagrp'), 1);

  const page = (await b.get(r.location)).html;
  assert.match(page, /Saved 7 numbers/);
  assert.match(page, /Last updated by Hazera/);

  const audit = (await db.query("SELECT action, old_value, new_value FROM audit_log WHERE record_key = 'WM 2026-10-20 walkin'")).rows;
  assert.deepEqual(audit, [{ action: 'insert', old_value: null, new_value: 1880 }]);
});

test('saving again without changes saves nothing; a cleared box deletes the number', async () => {
  const b = await pinLogin('hazera', '1111');
  let csrf = await b.csrf();
  await b.post('/daily', { _csrf: csrf, date: '2026-10-19', 'f[walkin]': '1700', 'f[pwp]': '4' });
  csrf = await b.csrf();
  const same = await b.post('/daily', { _csrf: csrf, date: '2026-10-19', 'f[walkin]': '1700', 'f[pwp]': '4' });
  assert.match(same.location, /saved=0/);
  const cleared = await b.post('/daily', { _csrf: csrf, date: '2026-10-19', 'f[walkin]': '1700', 'f[pwp]': '' });
  assert.match(cleared.location, /saved=1/);
  assert.equal(await entry('WM', '2026-10-19', 'pwp'), null);
  const del = (await db.query("SELECT action, old_value FROM audit_log WHERE record_key = 'WM 2026-10-19 pwp' ORDER BY id DESC LIMIT 1")).rows[0];
  assert.deepEqual(del, { action: 'delete', old_value: 4 });
});

test('"…within 7 days" bigger than its total is refused, and nothing on the page is saved', async () => {
  const b = await pinLogin('hazera', '1111');
  const csrf = await b.csrf();
  const r = await b.post('/daily', { _csrf: csrf, date: '2026-10-18', 'f[walkin]': '999', 'f[zkc]': '5', 'f[zkc7d]': '6' });
  assert.equal(r.status, 422);
  assert.match(r.html, /1 number needs fixing/);
  assert.match(r.html, /Can’t be more than “Zakat claims submitted” \(5\)/);
  assert.match(r.html, /value="999"/);                    // what was typed stays on screen
  assert.equal(await entry('WM', '2026-10-18', 'walkin'), null);
});

test('text, negative numbers and bad yes/no values are refused', async () => {
  const b = await pinLogin('hazera', '1111');
  const csrf = await b.csrf();
  const r = await b.post('/daily', { _csrf: csrf, date: '2026-10-18', 'f[walkin]': 'abc', 'f[tx]': '-3', 'f[wagrp]': '2' });
  assert.equal(r.status, 422);
  assert.match(r.html, /3 numbers need fixing/);
});

test('edit window: staff can change the last 7 days only, never the future or before 12 Oct', async () => {
  const b = await pinLogin('hazera', '1111');
  const csrf = await b.csrf();
  const tryDate = (date) => b.post('/daily', { _csrf: csrf, date, 'f[pwp]': '3' });
  assert.equal((await tryDate('2026-10-14')).status, 302);   // 7th day back: allowed
  const old = await tryDate('2026-10-13');
  assert.equal(old.status, 403);
  assert.match(old.html, /Only the last 7 days/);
  assert.equal((await tryDate('2026-10-21')).status, 403);    // future
  // and the page for an old day is read-only
  assert.match((await b.get('/daily?date=2026-10-13')).html, /Only the last 7 days can be changed/);
});

test('admin can fix older days for any branch', async () => {
  const b = browser();
  await b.post('/login/password', { username: 'admin', password: 'admin-pass-1' });
  const csrf = await b.csrf('/daily?branch=JH');
  const r = await b.post('/daily', { _csrf: csrf, branch: 'JH', date: '2026-10-12', 'f[walkin]': '1400' });
  assert.equal(r.status, 302);
  assert.equal(await entry('JH', '2026-10-12', 'walkin'), 1400);
  const tooEarly = await b.post('/daily', { _csrf: csrf, branch: 'JH', date: '2026-10-11', 'f[walkin]': '1400' });
  assert.equal(tooEarly.status, 403);                          // before the tracker started
});

test('HQ can view a branch\'s day but not change it', async () => {
  const b = browser();
  await b.post('/login/password', { username: 'alia', password: 'hq-pass-123' });
  const page = (await b.get('/daily?branch=WM')).html;
  assert.match(page, /HQ can view daily entries but not change them/);
  assert.doesNotMatch(page, /class="savebar"/);
  const csrf = page.match(/name="_csrf" value="([^"]+)"/)[1];
  assert.equal((await b.post('/daily', { _csrf: csrf, branch: 'WM', date: '2026-10-20', 'f[walkin]': '1' })).status, 403);
});

// ───────────── Target hints under each box ─────────────

test('hints: daily target, week so far, month so far, ratio, storefront day, track only', async () => {
  const wm = await loadMeasures(db, await branchId('WM'));
  const entries = calc.indexEntries(calc.rowsFromDays({
    '2026-10-19': { reviews: 1, zakat: 1200 },
    '2026-10-14': { zakat: 800 },
  }));
  const hint = (key, type = 'count') => buildHint({ key, type }, wm, entries, '2026-10-20', '2026-10-12');

  assert.deepEqual(
    { kind: hint('walkin', 'money').kind, target: hint('walkin', 'money').target }, { kind: 'day', target: 1795 });

  const reviews = hint('reviews');                 // 2 a week, week of Mon 19 Oct
  assert.equal(reviews.kind, 'period');
  assert.equal(reviews.soFar, 1);                  // Monday's review
  assert.ok(Math.abs(reviews.targetToDate - 4 / 7) < 1e-9); // 2 days × 2/7
  assert.ok(Math.abs(reviews.targetFull - 2) < 1e-9);

  const zakat = hint('zakat', 'money');            // RM 20,000 a month, counted from 12 Oct
  assert.equal(zakat.soFar, 2000);
  assert.ok(Math.abs(zakat.targetToDate - 9 * 20000 / 31) < 1e-6);   // 12–20 Oct
  assert.ok(Math.abs(zakat.targetFull - 20 * 20000 / 31) < 1e-6);    // 12–31 Oct

  assert.deepEqual([hint('two').kind, hint('two').den, hint('two').target], ['ratio', 'tx', 0.45]);
  assert.equal(hint('waord'), null);               // no measure for WA order count

  const ampang = await loadMeasures(db, await branchId('Ampang'));
  const hc = buildHint({ key: 'hc', type: 'count' }, ampang, entries, '2026-10-20', '2026-10-12');
  assert.deepEqual([hc.kind, hc.gate, hc.target], ['perday', 'twostaff', 5]);

  const bangi = await loadMeasures(db, await branchId('Bangi'));
  assert.equal(buildHint({ key: 'biop', type: 'count' }, bangi, entries, '2026-10-20', '2026-10-12').kind, 'track');
});

// ───────────── 28 Oct: JH week sheet + "my boxes" ─────────────

test('28 Oct: JH week sheet – type a week in one Save; staff see their own boxes; other branches unchanged', async () => {
  const set = (u, col, v) => db.query(`UPDATE users SET ${col} = $1 WHERE username = $2`, [bcrypt.hashSync(v, 4), u]);
  await set('nabihah', 'pin_hash', '4444');
  const nab = await pinLogin('nabihah', '4444');
  // Phone view: Nabihah sees Team + her own boxes, not Afifah's / Yaya's
  const day = (await nab.get('/daily')).html;
  assert.match(day, /My boxes \+ Team/);
  assert.match(day, /Week sheet view/);
  assert.match(day, /WhatsApp customer follow-ups/);
  assert.doesNotMatch(day, /Zakat orders completed/);
  assert.doesNotMatch(day, /TikTok affiliate commission|Grab cancelled orders|Out-of-stock items logged/, 'the 7 no-target boxes are gone');
  assert.match((await nab.get('/daily?show=all')).html, /Zakat orders completed/);
  // Someone else's number survives Nabihah saving her filtered page
  const jh = await branchId('JH');
  await db.query("INSERT INTO daily_entries (branch_id, entry_date, field_key, value) VALUES ($1, '2026-10-20', 'zko', 2)", [jh]);
  const csrf = await nab.csrf();
  const r = await nab.post('/daily', { _csrf: csrf, date: '2026-10-20', show: 'mine', 'f[fu]': '16' });
  assert.equal(r.status, 302);
  assert.equal(Number(await entry('JH', '2026-10-20', 'fu')), 16);
  assert.equal(Number(await entry('JH', '2026-10-20', 'zko')), 2, 'hidden box kept');
  // Week sheet: Mon 19 – Sun 25 Oct (today Tue 20): Mon and Tue editable, the rest not
  const wk = (await nab.get('/daily/week')).html;
  assert.match(wk, /Week of/);
  assert.match(wk, /name="c\[2026-10-19\]\[fu\]"/);
  assert.match(wk, /name="c\[2026-10-20\]\[fu\]" value="16"/);
  assert.doesNotMatch(wk, /name="c\[2026-10-21\]\[fu\]"/, 'tomorrow is read-only');
  const save = await nab.post('/daily/week', { _csrf: csrf, week: '2026-10-19', show: 'mine',
    'c[2026-10-19][fu]': '14', 'c[2026-10-19][grabinv]': '45', 'c[2026-10-20][fu]': '16', 'c[2026-10-20][grabon]': '1' });
  assert.equal(save.status, 302);
  assert.match(save.location, /saved=3/);
  assert.equal(Number(await entry('JH', '2026-10-19', 'grabinv')), 45);
  assert.equal(Number(await entry('JH', '2026-10-20', 'zko')), 2, 'hidden box still kept');
  // A bad cell: that day isn't saved, the other day is, typed values come back
  const bad = await nab.post('/daily/week', { _csrf: csrf, week: '2026-10-19', 'c[2026-10-19][grabinv]': '140', 'c[2026-10-20][fu]': '18' });
  assert.equal(bad.status, 422);
  assert.match(bad.html, /1 day has a number to fix/);
  assert.match(bad.html, /name="c\[2026-10-19\]\[grabinv\]" value="140"/);
  assert.equal(Number(await entry('JH', '2026-10-19', 'grabinv')), 45);
  assert.equal(Number(await entry('JH', '2026-10-20', 'fu')), 18);
  // WM doesn't have it yet
  const hz = await pinLogin('hazera', '1111');
  assert.doesNotMatch((await hz.get('/daily')).html, /Week sheet view/);
  assert.equal((await hz.get('/daily/week')).status, 302);
});

test('29 Oct: +1 buttons at BR – each tap saved at once, −1 never below 0, count boxes only', async () => {
  const b = await pinLogin('alya', '4444');
  const page = (await b.get('/daily')).html;
  assert.match(page, /name="tally" value="p9:\+1"/, 'Nurvi has a +1 button');
  assert.match(page, /name="tally" value="poct:-1"/);
  assert.doesNotMatch(page, /name="tally" value="walkin:/, 'money boxes have none');
  const csrf = await b.csrf();
  const tap = (v, date = '2026-10-20') => b.postJson('/daily/tally', { _csrf: csrf, date, tally: v });
  assert.deepEqual((await tap('p9:+1')).body, { key: 'p9', value: 1 });
  assert.deepEqual((await tap('p9:+1')).body, { key: 'p9', value: 2 });
  assert.deepEqual((await tap('p9:-1')).body, { key: 'p9', value: 1 });
  assert.equal(Number(await entry('BR', '2026-10-20', 'p9')), 1);
  await tap('loyal:-1');
  assert.equal(Number(await entry('BR', '2026-10-20', 'loyal')), 0, 'never below 0');
  // Not a count box, a made-up key, or a day older than 7 days → refused, nothing saved
  assert.equal((await tap('walkin:+1')).status, 400);
  assert.equal((await tap('nope:+1')).status, 400);
  assert.equal((await tap('p9:+5')).status, 400);
  assert.equal((await tap('p9:+1', '2026-10-01')).status, 403);
  // Each tap is in the audit log under the person who tapped
  const log = (await db.query("SELECT u.username FROM audit_log a JOIN users u ON u.id = a.user_id WHERE a.record_key = 'BR 2026-10-20 p9' ORDER BY a.id")).rows;
  assert.ok(log.length >= 3 && log.every((r) => r.username === 'alya'));
  // Without JavaScript the button posts the form and comes back to the same box
  const plain = await b.post('/daily/tally', { _csrf: csrf, date: '2026-10-20', tally: 'p1:+1', 'f[p1]': '99' });
  assert.equal(plain.status, 302);
  assert.match(plain.location, /#f_p1$/);
  assert.equal(Number(await entry('BR', '2026-10-20', 'p1')), 1, 'adds 1 to the saved number, not to what was typed');
  // 2 Nov: every branch has the +1 buttons now
  const wm = await pinLogin('hazera', '1111');
  assert.match((await wm.get('/daily')).html, /name="tally"/);
  const r = await wm.postJson('/daily/tally', { _csrf: await wm.csrf(), date: '2026-10-20', tally: 'pwp:+1' });
  assert.equal(r.status, 200);
  assert.equal(r.body.key, 'pwp');
  // A branch not in tally_branches: none on the page, and the route refuses
  await db.query("UPDATE app_settings SET value = '[\"BR\"]' WHERE key = 'tally_branches'");
  assert.doesNotMatch((await wm.get('/daily')).html, /name="tally"/);
  assert.equal((await wm.postJson('/daily/tally', { _csrf: await wm.csrf(), date: '2026-10-20', tally: 'pwp:+1' })).status, 404);
  await db.query("UPDATE app_settings SET value = '[\"WM\",\"JH\",\"BR\",\"Bangi\",\"Ampang\"]' WHERE key = 'tally_branches'");
});

test('1 Nov: the front page for branch staff – wins, shout-outs and focus from their own numbers', async () => {
  const set = (u, col, v) => db.query(`UPDATE users SET ${col} = $1 WHERE username = $2`, [bcrypt.hashSync(v, 4), u]);
  await set('nabihah', 'pin_hash', '4444');
  const jh = await branchId('JH');
  // Nabihah's WhatsApp follow-ups (15 a day): 3 days in a row on target, then a best day yesterday
  const put = (d, k, v) => db.query(`INSERT INTO daily_entries (branch_id, entry_date, field_key, value) VALUES ($1, $2, $3, $4)
    ON CONFLICT (branch_id, entry_date, field_key) DO UPDATE SET value = EXCLUDED.value`, [jh, d, k, v]);
  for (const [d, v] of [['2026-10-12', 15], ['2026-10-13', 16], ['2026-10-14', 15], ['2026-10-15', 17], ['2026-10-16', 15], ['2026-10-17', 18], ['2026-10-18', 16], ['2026-10-19', 22], ['2026-10-20', 25]]) await put(d, 'fu', v); // today (20 Oct) is a best day
  const b = await pinLogin('nabihah', '4444');
  const html = (await b.get('/')).html;
  assert.match(html, /Selamat (pagi|tengah hari|petang|malam), Nabihah/);
  assert.match(html, /Wins to celebrate/);
  assert.match(html, /You hit “WhatsApp customer follow-ups/);
  assert.match(html, /\d+ days in a row on “WhatsApp customer follow-ups/);
  assert.match(html, /New personal best: 25/);
  assert.match(html, /Focus this week/);
  assert.match(html, /Grab active inventory/, 'a target that is behind shows in Focus');
  assert.match(html, /Write my commitment/);
  assert.match(html, /href="\/scoreboard\/trace\?type=measure&amp;code=/);
  // HQ and admin keep their own home pages
  assert.equal((await pinLogin('hazera', '1111').then((x) => x.get('/'))).status, 200);
});

test('3 Nov: front page – a branch sees its own WIG / lead targets, and one tazkirah a day', async () => {
  const tz = require('../../src/home/tazkirah');
  assert.ok(tz.LIST.length >= 30 && tz.LIST.every((t) => t.text && t.src));
  assert.notDeepEqual(tz.forDate('2026-11-03'), tz.forDate('2026-11-04'));
  assert.deepEqual(tz.forDate('2026-11-03'), tz.forDate('2026-11-03'));
  const hz = await pinLogin('hazera', '1111');
  const html = (await hz.get('/')).html;
  assert.match(html, /WM – \w+ lead measures/);
  assert.doesNotMatch(html, /🏁 Walk-in sales/, 'the WIG is not repeated – leads only');
  assert.match(html, /hl-tazkirah/);
  assert.match(html, /Tip hari ini/);
  assert.ok(tz.TIPS.length >= 30 && tz.TIPS.every((t) => t.title && t.text));
  assert.doesNotMatch(html, /id="hl-goals"/, 'branch people see their own targets, not the company goals');
});
