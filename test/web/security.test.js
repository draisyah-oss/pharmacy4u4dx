// Review fixes (14 Oct): login and redirect safety, sessions, headers, bad dates, who sees
// what, and the privacy rule that salaries can never be stored or shown.

const test = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
const ExcelJS = require('exceljs');

const { createDb } = require('../../src/db');
const { migrate } = require('../../src/db/migrate');
const { readSeed, loadSeed, validateSeed } = require('../../src/db/seed');
const { createApp } = require('../../src/app');
const { safeNext } = require('../../src/auth/routes');
const { clearExpiredSessions } = require('../../src/auth/sessions');
const { mentionsSalary } = require('../../src/privacy');
const { syncSalesSheet } = require('../../src/sheets/sync');

const TODAY = '2026-10-20';
let db; let server; let base;

test.before(async () => {
  db = await createDb({ url: '', localDir: 'memory' });
  await migrate(db);
  await loadSeed(db, readSeed(), { adminPassword: 'admin-pass-1' });
  const set = (u, col, v) => db.query(`UPDATE users SET ${col} = $1 WHERE username = $2`, [bcrypt.hashSync(v, 4), u]);
  await set('hazera', 'pin_hash', '1111');
  await set('zawiyah', 'pin_hash', '2222');
  await set('hafizah', 'password_hash', 'manager-pass-1');
  await set('alia', 'password_hash', 'hq-pass-123');
  server = createApp(db, { now: () => new Date(`${TODAY}T21:00:00+08:00`) }).listen(0);
  base = `http://localhost:${server.address().port}`;
});
test.after(async () => { server.close(); await db.close(); });

async function login(path, form) {
  const res = await fetch(base + path, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(form).toString() });
  if (res.status !== 302) return { status: res.status, html: await res.text() };
  const cookie = res.headers.get('set-cookie').split(';')[0];
  const call = async (method, p, body) => {
    const r = await fetch(base + p, { method, redirect: 'manual', headers: { cookie, ...(body ? { 'content-type': 'application/x-www-form-urlencoded' } : {}) }, body: body ? new URLSearchParams(body).toString() : undefined });
    return { status: r.status, location: r.headers.get('location'), headers: r.headers, res: r, html: method === 'GET' || r.status !== 302 ? await r.text() : '' };
  };
  const s = { status: 302, cookie, get: (p) => call('GET', p) };
  s.post = async (p, body) => {
    const page = await call('GET', p.startsWith('/admin') ? '/admin' : '/daily');
    const csrf = page.html.match(/name="_csrf" value="([^"]+)"/)[1];
    return call('POST', p, { _csrf: csrf, ...body });
  };
  return s;
}
const asAdmin = () => login('/login/password', { username: 'admin', password: 'admin-pass-1' });

// ───────────── Redirects, headers, health ─────────────

test('after login, only pages on this site – not //evil, /\\evil or full addresses', () => {
  assert.equal(safeNext('/scoreboard?week=2026-10-12'), '/scoreboard?week=2026-10-12');
  for (const bad of ['//evil.com', '/\\evil.com', 'https://evil.com', '/\\/evil.com', ' /x', '/x y', 'javascript:alert(1)']) {
    assert.equal(safeNext(bad), '/', bad);
  }
});

test('"check the sheet now" also only goes back to pages on this site', async () => {
  const s = await login('/login/pin', { username: 'hazera', pin: '1111' });
  const r = await s.post('/sales-sheet/sync', { back: '/\\evil.com' });
  assert.equal(r.location.startsWith('/?'), true);
});

test('every page sends security headers; /health gives no details', async () => {
  const r = await fetch(`${base}/login`);
  const csp = r.headers.get('content-security-policy');
  assert.match(csp, /script-src 'self'/);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.equal(r.headers.get('x-frame-options'), 'DENY');
  assert.equal(r.headers.get('x-powered-by'), null);
  const h = await (await fetch(`${base}/health`)).json();
  assert.deepEqual(Object.keys(h).sort(), ['database', 'ok']);
});

// ───────────── Logins and sessions ─────────────

test('a new PIN logs that person out everywhere; admin changing their own password stays logged in', async () => {
  const hazera = await login('/login/pin', { username: 'hazera', pin: '1111' });
  assert.equal((await hazera.get('/daily')).status, 200);
  const admin = await asAdmin();
  const uid = (await db.query("SELECT id FROM users WHERE username = 'hazera'")).rows[0].id;
  await admin.post(`/admin/users/${uid}/secret`, { branch: 'WM', secret: '3842' });
  assert.equal((await hazera.get('/daily')).status, 302, 'old session ended');
  assert.equal((await login('/login/pin', { username: 'hazera', pin: '3842' })).status, 302);

  const aid = (await db.query("SELECT id FROM users WHERE username = 'admin'")).rows[0].id;
  await admin.post(`/admin/users/${aid}/secret`, { branch: 'HQ', secret: 'new-admin-pass-9' });
  assert.equal((await admin.get('/admin')).status, 200, 'admin keeps the session they changed it from');
  await db.query('UPDATE users SET password_hash = $1 WHERE id = $2', [bcrypt.hashSync('admin-pass-1', 4), aid]);
});

test('expired sessions are cleaned up', async () => {
  await db.query("INSERT INTO sessions (sid, data, expires) VALUES ('old', '{}', now() - interval '1 day')");
  await clearExpiredSessions(db);
  assert.equal((await db.query("SELECT count(*)::int AS n FROM sessions WHERE sid = 'old'")).rows[0].n, 0);
});

// ───────────── Who sees what ─────────────

test('staff: own branch daily entry and scoreboard only – no admin, setup page or export', async () => {
  const s = await login('/login/pin', { username: 'zawiyah', pin: '2222' });
  assert.equal((await s.get('/daily')).status, 200);
  assert.equal((await s.get('/scoreboard')).status, 200);
  for (const p of ['/admin', '/admin/targets', '/status', '/admin/export/WM.xlsx', '/admin/export/group.xlsx']) {
    assert.equal((await s.get(p)).status, 403, p);
  }
  assert.doesNotMatch((await s.get('/daily?branch=JH')).html, /Jenderam Hilir/);
});

test('manager: own branch only, can\'t change targets or people', async () => {
  const s = await login('/login/password', { username: 'hafizah', password: 'manager-pass-1' });
  assert.match((await s.get('/scoreboard?branch=BR')).html, /Wangsa Maju/);
  assert.equal((await s.get('/scoreboard/trace?type=measure&code=T1&from=2026-10-12&to=2026-10-18&branch=BR')).html.includes('Bandar Rinching'), false);
  assert.equal((await s.get('/admin/people')).status, 403);
});

test('HQ: reads every branch, changes nothing', async () => {
  const s = await login('/login/password', { username: 'alia', password: 'hq-pass-123' });
  assert.equal((await s.get('/scoreboard?branch=BR')).status, 200);
  const day = await s.get('/daily?branch=JH');
  assert.match(day.html, /HQ can view daily entries but not change them/);
  assert.equal((await s.get('/admin')).status, 403);
});

// ───────────── Bad input ─────────────

test('an impossible date shows today instead of an error; a trace with one is refused', async () => {
  const s = await login('/login/pin', { username: 'zawiyah', pin: '2222' });
  const r = await s.get('/daily?date=2026-02-31');
  assert.equal(r.status, 200);
  assert.match(r.html, /name="date" value="2026-10-20"/);
  const hq = await login('/login/password', { username: 'alia', password: 'hq-pass-123' });
  assert.equal((await hq.get('/scoreboard/trace?type=measure&code=T1&from=2026-02-31&to=2026-03-02&branch=WM')).status, 400);
});

test('30 wrong logins from one device block that device, even with a right PIN', async () => {
  const { _ipFails } = require('../../src/auth/routes');
  for (let i = 0; i < 30; i++) {
    await fetch(`${base}/login/pin`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: `username=nobody${i}&pin=0000` });
  }
  const r = await login('/login/pin', { username: 'zawiyah', pin: '2222' });
  assert.equal(r.status, 401);
  assert.match(r.html, /Too many wrong tries from this device/);
  _ipFails.clear();
});

// ───────────── Bugs from the review ─────────────

test('fields of someone who was removed still show (on an "Others" card) and keep their owner in Admin', async () => {
  const admin = await asAdmin();
  const pid = (await db.query("SELECT p.id FROM people p JOIN branches b ON b.id = p.branch_id WHERE b.code = 'BR' AND p.name = 'Qushairi'")).rows[0].id;
  await admin.post(`/admin/people/${pid}/active`, { branch: 'BR', active: 'false' });
  const page = await admin.get('/daily?branch=BR');
  assert.match(page.html, /<h2>Others/);
  assert.match(page.html, /New loyalty members/);
  const m = await admin.get('/admin/measures?branch=BR');
  assert.match(m.html, /<option selected>Qushairi<\/option>/); // stays Qushairi, not quietly "Team"
  await admin.post(`/admin/people/${pid}/active`, { branch: 'BR', active: 'true' });
});

test('a failed target save keeps what was typed on screen', async () => {
  const admin = await asAdmin();
  const t1 = (await db.query("SELECT m.id FROM measures m JOIN branches b ON b.id = m.branch_id WHERE b.code = 'WM' AND m.code = 'T1'")).rows[0].id;
  const t2 = (await db.query("SELECT m.id FROM measures m JOIN branches b ON b.id = m.branch_id WHERE b.code = 'WM' AND m.code = 'T2'")).rows[0].id;
  const r = await admin.post('/admin/targets', { branch: 'WM', [`t[m${t1}][2026-11]`]: '1999', [`t[m${t2}][2026-11]`]: 'oops' });
  assert.equal(r.status, 422);
  assert.match(r.html, new RegExp(`name="t\\[m${t1}\\]\\[2026-11\\]" value="1999"`));
  assert.match(r.html, new RegExp(`name="t\\[m${t2}\\]\\[2026-11\\]" value="oops"`));
});

test('every scoreboard number links to its entries – including "needed per day"', async () => {
  const s = await login('/login/password', { username: 'hafizah', password: 'manager-pass-1' });
  const html = (await s.get('/scoreboard?week=2026-10-12')).html;
  const needed = html.split('Needed per day')[1].split('</dd>')[0];
  assert.match(needed, /href="\/scoreboard\/trace\?type=sales/);
});

// ───────────── Salaries: never stored, never shown ─────────────

test('the salary check knows the words (English and Malay) but allows sales commission', () => {
  for (const t of ['Salary', 'staff salaries', 'Gaji', 'slip gaji', 'Wages', 'payroll', 'EPF', 'KWSP', 'SOCSO', 'upah']) assert.ok(mentionsSalary(t), t);
  for (const t of ['TikTok affiliate commission (RM)', 'Walk-in sales', 'Shopee Sales', 'Pay later']) assert.ok(!mentionsSalary(t), t);
});

test('seed.json with anything about salaries is refused', () => {
  const seed = JSON.parse(JSON.stringify(readSeed()));
  seed.branches[0].daily_fields.push({ key: 'gaji', label: 'Gaji (RM)', owner: 'Team', type: 'money' });
  assert.ok(validateSeed(seed).errors.some((e) => e.includes('salaries')));
});

test('Admin can\'t add a salary field or measure, or rename one into it', async () => {
  const a = await asAdmin();
  const r1 = await a.post('/admin/fields', { branch: 'WM', key: 'gaji', label: 'Gaji staff', owner_name: 'Team', type: 'money' });
  assert.match(decodeURIComponent(r1.location), /Salaries and pay can’t be stored/);
  const r2 = await a.post('/admin/measures', { branch: 'WM', code: 'S9', label: 'Staff salary cost', owner_name: 'Team', kind: 'Routine', target_per: 'month', calc: 'sum', numerator_field: 'walkin' });
  assert.match(decodeURIComponent(r2.location), /Salaries and pay can’t be stored/);
  const fid = (await db.query("SELECT f.id FROM daily_fields f JOIN branches b ON b.id = f.branch_id WHERE b.code = 'WM' AND f.key = 'pwp'")).rows[0].id;
  const r3 = await a.post(`/admin/fields/${fid}`, { branch: 'WM', label: 'Wages paid', owner_name: 'Team', type: 'money' });
  assert.match(decodeURIComponent(r3.location), /Salaries and pay can’t be stored/);
  assert.equal((await db.query("SELECT count(*)::int AS n FROM daily_fields WHERE label ~* 'gaji|salar|wage'")).rows[0].n, 0);
});

test('the database itself refuses salary fields, measures and sheet columns', async () => {
  const wm = (await db.query("SELECT id FROM branches WHERE code = 'WM'")).rows[0].id;
  await assert.rejects(db.query("INSERT INTO daily_fields (branch_id, key, label, owner_name, type) VALUES ($1, 'sal', 'Salary (RM)', 'Team', 'money')", [wm]), /daily_fields_no_salary/);
  await assert.rejects(db.query("INSERT INTO measures (branch_id, code, owner_name, label, kind, target_per, calc, numerator_field) VALUES ($1, 'Z9', 'Team', 'Payroll', 'Routine', 'month', 'sum', 'walkin')", [wm]), /measures_no_salary/);
  await assert.rejects(db.query(`UPDATE branches SET sales_sheet = '{"tab":"Daily sales WM","columns":{"x":"Gaji"}}' WHERE id = $1`, [wm]), /branches_no_salary_sheet_column/);
  const cols = (await db.query("SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND column_name ~* 'salar|gaji|wage|payroll'")).rows;
  assert.deepEqual(cols, []);
});

test('the sales sheet sync never reads a salary column or tab, even if mapped', async () => {
  const wm = (await db.query("SELECT id FROM branches WHERE code = 'WM'")).rows[0].id;
  // bypass the database check to simulate a mistaken mapping
  await db.query('ALTER TABLE branches DROP CONSTRAINT branches_no_salary_sheet_column');
  try {
    await db.query(`UPDATE branches SET sales_sheet = '{"tab":"Daily sales WM","columns":{"walkin":"Total","pwp":"Salary"}}' WHERE id = $1`, [wm]);
    const rows = [['Day', 'Date', 'Transaction', 'Total', 'Salary'], ['Mon', '19/10/2026', '50', '1,500.00', '9,999.00']];
    let asked = [];
    await syncSalesSheet(db, { readRows: async (tabs) => { asked = tabs; return Object.fromEntries(tabs.map((t) => [t, t === 'Daily sales WM' ? rows : []])); }, today: TODAY, trackerStart: '2026-10-12' });
    const pwp = (await db.query("SELECT value FROM daily_entries WHERE branch_id = $1 AND field_key = 'pwp' AND entry_date = '2026-10-19'", [wm])).rows;
    assert.deepEqual(pwp, [], 'the salary column was not read');
    await db.query(`UPDATE branches SET sales_sheet = '{"tab":"Staff Salary","columns":{"walkin":"Total"}}' WHERE id = $1`, [wm]);
    await syncSalesSheet(db, { readRows: async (tabs) => { asked = tabs; return Object.fromEntries(tabs.map((t) => [t, []])); }, today: TODAY, trackerStart: '2026-10-12' });
    assert.ok(!asked.includes('Staff Salary'), 'a salary tab is never requested');
  } finally {
    await db.query(`UPDATE branches SET sales_sheet = $2 WHERE id = $1`, [wm, JSON.stringify(readSeed().branches[0].sales_sheet)]);
    await db.query("DELETE FROM daily_entries WHERE branch_id = $1 AND entry_date = '2026-10-19'", [wm]);
    await db.query("ALTER TABLE branches ADD CONSTRAINT branches_no_salary_sheet_column CHECK (NOT p4u_mentions_salary(sales_sheet::text))");
  }
});

test('no page or export shows anything about salaries', async () => {
  const a = await asAdmin();
  const pages = ['/', '/daily?branch=WM', '/scoreboard?branch=WM', '/admin', '/admin/targets?branch=WM', '/admin/people?branch=WM', '/admin/measures?branch=WM', '/status'];
  for (const p of pages) {
    const text = (await a.get(p)).html.replace(/<[^>]+>/g, ' ');
    assert.ok(!mentionsSalary(text), `${p} mentions salaries`);
  }
  for (const p of ['/admin/export/WM.xlsx', '/admin/export/group.xlsx']) {
    const r = await a.get(p);
    assert.equal(r.status, 200);
  }
  const res = await fetch(`${base}/admin/export/group.xlsx`, { headers: { cookie: a.cookie } });
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(Buffer.from(await res.arrayBuffer()));
  for (const ws of wb.worksheets) {
    if (ws.name === 'Audit log') continue; // the log records refused attempts by name, not values
    assert.ok(!mentionsSalary(JSON.stringify(ws.getSheetValues())), `${ws.name} mentions salaries`);
  }
});
