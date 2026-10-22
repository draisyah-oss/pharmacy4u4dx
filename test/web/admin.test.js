// Admin screens: targets, people & logins, measures & fields, audit log, Excel export.
// Every change must land in the audit log; nothing half-saves.

const test = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
const ExcelJS = require('exceljs');

const { createDb } = require('../../src/db');
const { migrate } = require('../../src/db/migrate');
const { readSeed, loadSeed } = require('../../src/db/seed');
const { createApp } = require('../../src/app');
const { loadBranch } = require('../../src/daily/data');
const { buildScoreboard } = require('../../src/scoreboard/data');
const { WM_WEEK, WEEK_DATES } = require('../fixtures/sample-weeks');

const TODAY = '2026-10-20';
let db; let server; let base;

test.before(async () => {
  db = await createDb({ url: '', localDir: 'memory' });
  await migrate(db);
  await loadSeed(db, readSeed(), { adminPassword: 'admin-pass-1' });
  const wm = await loadBranch(db, 'WM');
  for (const [field, values] of Object.entries(WM_WEEK)) {
    for (let i = 0; i < 7; i++) {
      await db.query('INSERT INTO daily_entries (branch_id, entry_date, field_key, value) VALUES ($1,$2,$3,$4)', [wm.id, WEEK_DATES[i], field, values[i]]);
    }
  }
  await db.query("UPDATE users SET password_hash = $1 WHERE username = 'hafizah'", [bcrypt.hashSync('manager-pass-1', 4)]);
  server = createApp(db, { now: () => new Date(`${TODAY}T21:00:00+08:00`) }).listen(0);
  base = `http://localhost:${server.address().port}`;
});
test.after(async () => { server.close(); await db.close(); });

async function session(path, form) {
  const res = await fetch(base + path, {
    method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(form).toString() });
  if (res.status !== 302) return null;
  const cookie = res.headers.get('set-cookie').split(';')[0];
  const req = async (method, p, body) => {
    const r = await fetch(base + p, {
      method, redirect: 'manual',
      headers: { cookie, ...(body ? { 'content-type': 'application/x-www-form-urlencoded' } : {}) },
      body: body ? new URLSearchParams(body).toString() : undefined,
    });
    return { status: r.status, location: r.headers.get('location'), res: r };
  };
  let csrf = null;
  return {
    get: async (p) => { const r = await req('GET', p); r.html = await r.res.text(); return r; },
    raw: (p) => req('GET', p),
    post: async (p, body) => {
      if (!csrf) csrf = (await (await req('GET', '/admin')).res.text()).match(/name="_csrf" value="([^"]+)"/)?.[1]
        || (await (await req('GET', '/daily')).res.text()).match(/name="_csrf" value="([^"]+)"/)[1];
      const r = await req('POST', p, { _csrf: csrf, ...body });
      r.html = await r.res.text();
      return r;
    },
  };
}
const admin = () => session('/login/password', { username: 'admin', password: 'admin-pass-1' });
const id = async (sql, params) => (await db.query(sql, params)).rows[0].id;
const measureId = (branch, code) => id('SELECT m.id FROM measures m JOIN branches b ON b.id = m.branch_id WHERE b.code = $1 AND m.code = $2', [branch, code]);
const target = async (branch, code, month) => (await db.query(
  `SELECT t.target, t.weekend_target FROM measure_targets t JOIN measures m ON m.id = t.measure_id JOIN branches b ON b.id = m.branch_id
   WHERE b.code = $1 AND m.code = $2 AND t.month = $3`, [branch, code, month])).rows[0];
const lastAudit = async (like) => (await db.query(
  'SELECT a.action, a.record_key, a.old_value, a.new_value, u.username FROM audit_log a LEFT JOIN users u ON u.id = a.user_id WHERE a.record_key LIKE $1 ORDER BY a.id DESC LIMIT 1', [like])).rows[0];

// ───────────── Access ─────────────

test('only admin can open or change anything under /admin', async () => {
  const mgr = await session('/login/password', { username: 'hafizah', password: 'manager-pass-1' });
  assert.equal((await mgr.get('/admin')).status, 403);
  assert.equal((await mgr.get('/admin/export/WM.xlsx')).status, 403);
  const t1 = await measureId('WM', 'T1');
  assert.equal((await mgr.post('/admin/targets', { branch: 'WM', [`t[m${t1}][2026-11]`]: '1' })).status, 403);
  assert.equal((await target('WM', 'T1', '2026-11')).target, 1980);
});

// ───────────── Targets ─────────────

test('targets: change a month, a % target and a weekend target – scoreboard uses them, each change logged', async () => {
  const a = await admin();
  const t1 = await measureId('WM', 'T1');
  const l3 = await measureId('WM', 'L3');
  const page = await a.get('/admin/targets?branch=WM');
  assert.match(page.html, new RegExp(`name="t\\[m${l3}\\]\\[2026-10\\]" value="45"`)); // shown as percent
  const r = await a.post('/admin/targets', {
    branch: 'WM', [`t[m${t1}][2026-10]`]: '1,800', [`w[m${t1}][2026-10]`]: '2200', [`t[m${l3}][2026-10]`]: '50',
  });
  assert.equal(r.status, 302);
  assert.match(decodeURIComponent(r.location), /Saved 3 targets/);
  assert.deepEqual(await target('WM', 'T1', '2026-10'), { target: 1800, weekend_target: 2200 });
  assert.equal((await target('WM', 'L3', '2026-10')).target, 0.5);
  assert.deepEqual(await lastAudit('WM T1 2026-10 target'), { action: 'update', record_key: 'WM T1 2026-10 target', old_value: 1795, new_value: 1800, username: 'admin' });

  // the scoreboard picks it up: 12–18 Oct = 5 × 1,800 + 2 × 2,200
  const board = await buildScoreboard(db, { branch: await loadBranch(db, 'WM'), weekStart: '2026-10-12', today: TODAY, trackerStart: '2026-10-12' });
  assert.equal(board.top.find((x) => x.code === 'T1').week.target, 13400);
});

test('targets: a blank box means track only; one bad box saves nothing at all', async () => {
  const a = await admin();
  const z0 = await measureId('WM', 'Z0');
  const t2 = await measureId('WM', 'T2');
  await a.post('/admin/targets', { branch: 'WM', [`t[m${z0}][2026-12]`]: '' });
  assert.equal((await target('WM', 'Z0', '2026-12')).target, null);
  const r = await a.post('/admin/targets', { branch: 'WM', [`t[m${t2}][2026-11]`]: '6', [`t[m${z0}][2026-11]`]: 'abc' });
  assert.equal(r.status, 422);
  assert.match(r.html, /Nothing was saved/);
  assert.equal((await target('WM', 'T2', '2026-11')).target, 5);
});

test('targets: branch month totals, running-total start values and HQ targets', async () => {
  const a = await admin();
  const cr = await id("SELECT r.id FROM running_totals r JOIN branches b ON b.id = r.branch_id WHERE b.code = 'WM' AND r.code = 'CR'");
  await a.post('/admin/targets', { branch: 'WM', 'bt[2026-11][total]': '75000', 'bt[2026-11][ytd]': '775000', [`rt[r${cr}][start]`]: '12', [`rt[r${cr}][end]`]: '200' });
  const bt = (await db.query("SELECT total_sales_target, ytd_target_month_end FROM branch_month_targets t JOIN branches b ON b.id = t.branch_id WHERE b.code = 'WM' AND month = '2026-11'")).rows[0];
  assert.deepEqual(bt, { total_sales_target: 75000, ytd_target_month_end: 775000 });
  assert.equal((await lastAudit('WM CR start value')).new_value, 12);

  const po = await id("SELECT id FROM hq_measures WHERE code = 'po'");
  await a.post('/admin/targets', { branch: 'HQ', [`h[m${po}][2026-11]`]: '90' });
  assert.equal((await db.query("SELECT target FROM hq_measure_targets WHERE hq_measure_id = $1 AND month = '2026-11'", [po])).rows[0].target, 0.9);
  assert.equal((await lastAudit('HQ po 2026-11 target')).old_value, 1);
});

// ───────────── People & logins ─────────────

test('add a staff member, give them a PIN, and they can log in; the PIN is never logged', async () => {
  const a = await admin();
  const r = await a.post('/admin/people', { branch: 'WM', name: 'Siti', job: 'Sales Assistant', login_role: 'branch_staff' });
  assert.match(decodeURIComponent(r.location), /Added Siti \(username siti\)/);
  const uid = await id("SELECT id FROM users WHERE username = 'siti'");
  assert.match(decodeURIComponent((await a.post(`/admin/users/${uid}/secret`, { branch: 'WM', secret: '1234' })).location), /harder to guess/);
  await a.post(`/admin/users/${uid}/secret`, { branch: 'WM', secret: '5826' });
  assert.ok(await session('/login/pin', { username: 'siti', pin: '5826' }), 'Siti can log in with her PIN');
  const log = (await db.query("SELECT action, old_value, new_value FROM audit_log WHERE record_key = 'siti' AND action = 'set_pin'")).rows[0];
  assert.ok(log, 'setting the PIN is logged');
  assert.equal(log.new_value, null);
  assert.doesNotMatch(JSON.stringify((await db.query('SELECT * FROM audit_log')).rows), /5826/);
});

test('renaming someone carries over to the measures and daily fields they own', async () => {
  const a = await admin();
  const pid = await id("SELECT p.id FROM people p JOIN branches b ON b.id = p.branch_id WHERE b.code = 'WM' AND p.name = 'Zawiyah'");
  await a.post(`/admin/people/${pid}`, { branch: 'WM', name: 'Zawiyah R', job: 'Senior Sales Assistant', username: 'zawiyah' });
  const owned = (await db.query("SELECT count(*)::int AS n FROM measures m JOIN branches b ON b.id = m.branch_id WHERE b.code = 'WM' AND owner_name = 'Zawiyah R'")).rows[0].n;
  assert.equal(owned, 4); // W5, W7, W3, W0 (W6 zakat ordering and W2 Grab online removed 16 Oct)
  const fields = (await db.query("SELECT count(*)::int AS n FROM daily_fields f JOIN branches b ON b.id = f.branch_id WHERE b.code = 'WM' AND owner_name = 'Zawiyah'")).rows[0].n;
  assert.equal(fields, 0);
  assert.equal((await lastAudit('WM Zawiyah name')).new_value, 'Zawiyah R');
});

test('removing someone stops their login and ends their session; bringing them back works', async () => {
  const a = await admin();
  const pid = await id("SELECT p.id FROM people p WHERE p.name = 'Siti'");
  const siti = await session('/login/pin', { username: 'siti', pin: '5826' });
  await a.post(`/admin/people/${pid}/active`, { branch: 'WM', active: 'false' });
  assert.equal((await siti.get('/daily')).status, 302);                          // logged out
  assert.equal(await session('/login/pin', { username: 'siti', pin: '5826' }), null);
  await a.post(`/admin/people/${pid}/active`, { branch: 'WM', active: 'true' });
  assert.ok(await session('/login/pin', { username: 'siti', pin: '5826' }));
});

test('making a staff member a manager clears the PIN so they need a password; unlock resets wrong tries', async () => {
  const a = await admin();
  const pid = await id("SELECT id FROM people WHERE name = 'Siti'");
  await a.post(`/admin/people/${pid}`, { branch: 'WM', name: 'Siti', job: 'Supervisor', username: 'siti', login_role: 'branch_manager' });
  const u = (await db.query("SELECT role, pin_hash, password_hash FROM users WHERE username = 'siti'")).rows[0];
  assert.deepEqual(u, { role: 'branch_manager', pin_hash: null, password_hash: null });
  await db.query("UPDATE users SET locked_until = now() + interval '10 minutes' WHERE username = 'hafizah'");
  const hid = await id("SELECT id FROM users WHERE username = 'hafizah'");
  await a.post(`/admin/users/${hid}/unlock`, { branch: 'WM' });
  assert.ok(await session('/login/password', { username: 'hafizah', password: 'manager-pass-1' }));
});

// ───────────── Measures & fields ─────────────

test('measures: change owner, refuse a % measure with nothing to divide by, add a new one', async () => {
  const a = await admin();
  const z0 = await measureId('WM', 'Z0');
  const m = (await db.query('SELECT * FROM measures WHERE id = $1', [z0])).rows[0];
  await a.post(`/admin/measures/${z0}`, { branch: 'WM', ...m, owner_name: 'Hafizah', note: m.note || '', unit: m.unit, denominator_field: '' });
  assert.equal((await db.query('SELECT owner_name FROM measures WHERE id = $1', [z0])).rows[0].owner_name, 'Hafizah');
  assert.equal((await lastAudit('WM Z0 owner_name')).old_value, 'Hazera');

  const bad = await a.post('/admin/measures', { branch: 'WM', code: 'X1', label: 'Leaflet hit rate', owner_name: 'Team', kind: 'Lead', target_per: 'week', calc: 'ratio_percent', numerator_field: 'two', denominator_field: '' });
  assert.match(decodeURIComponent(bad.location), /needs a second field/);

  const ok = await a.post('/admin/measures', { branch: 'WM', code: 'X1', label: 'Reviews asked', owner_name: 'Hazera', kind: 'Lead', target_per: 'week', calc: 'sum', numerator_field: 'reviews', denominator_field: '' });
  assert.match(decodeURIComponent(ok.location), /Added X1/);
  assert.equal((await target('WM', 'X1', '2026-11')).target, null); // track only until a target is set
});

test('measures: taking one off the scoreboard keeps it out of the scoreboard', async () => {
  const a = await admin();
  const x1 = await measureId('WM', 'X1');
  await a.post(`/admin/measures/${x1}/active`, { branch: 'WM', active: 'false' });
  const board = await buildScoreboard(db, { branch: await loadBranch(db, 'WM'), weekStart: '2026-10-12', today: TODAY, trackerStart: '2026-10-12' });
  assert.ok(![...board.top, ...board.groups.flatMap((g) => g.rows)].some((r) => r.code === 'X1'));
});

test('daily fields: add one; a field still used by a measure or the sales sheet can\'t be removed', async () => {
  const a = await admin();
  const r = await a.post('/admin/fields', { branch: 'WM', key: 'Leaflets', label: 'Leaflets handed out', owner_name: 'Hazera', type: 'count' });
  assert.match(decodeURIComponent(r.location), /Added “Leaflets handed out” to Hazera’s card/);
  const walkin = await id("SELECT f.id FROM daily_fields f JOIN branches b ON b.id = f.branch_id WHERE b.code = 'WM' AND f.key = 'walkin'");
  const blocked = await a.post(`/admin/fields/${walkin}/active`, { branch: 'WM', active: 'false' });
  assert.match(decodeURIComponent(blocked.location), /still used by measure T1, total branch sales/);
  const leaflets = await id("SELECT f.id FROM daily_fields f JOIN branches b ON b.id = f.branch_id WHERE b.code = 'WM' AND f.key = 'leaflets'");
  await a.post(`/admin/fields/${leaflets}/active`, { branch: 'WM', active: 'false' });
  assert.equal((await db.query('SELECT active FROM daily_fields WHERE id = $1', [leaflets])).rows[0].active, false);
});

// ───────────── Audit log page ─────────────

test('audit log page lists changes and filters them', async () => {
  const a = await admin();
  const all = await a.get('/admin/audit');
  assert.match(all.html, /WM T1 2026-10 target/);
  const f = await a.get('/admin/audit?q=set_pin');
  assert.match(f.html, /set pin/);
  assert.doesNotMatch(f.html, /WM T1 2026-10 target/);
});

// ───────────── Export ─────────────

async function workbook(a, path) {
  const r = await a.raw(path);
  assert.equal(r.status, 200);
  assert.match(r.res.headers.get('content-type'), /spreadsheetml/);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(Buffer.from(await r.res.arrayBuffer()));
  return wb;
}

test('branch export: scoreboard by week, sales, daily entries, entry log, targets, people', async () => {
  const a = await admin();
  const wb = await workbook(a, '/admin/export/WM.xlsx');
  assert.deepEqual(wb.worksheets.map((w) => w.name), ['Scoreboard', 'Sales', 'Daily entries', 'Entry log', 'Targets', 'People']);
  const sb = wb.getWorksheet('Scoreboard');
  const t1 = sb.getSheetValues().find((r) => r && r[3] === 'T1' && r[1] === '12–18 Oct');
  assert.equal(t1[8], 12365);           // week actual
  assert.equal(t1[9], 13400);           // week target (after the Admin change above)
  const daily = wb.getWorksheet('Daily entries');
  const header = daily.getRow(3).values;
  const col = header.indexOf('Walk-in sales (RM)');
  assert.equal(daily.getRow(4).getCell(col).value, 1650); // 12 Oct
  assert.ok(!JSON.stringify(wb.getWorksheet('People').getSheetValues()).includes('$2'), 'no password hashes in the export');
  assert.equal((await lastAudit('Pharmacy4U-WM-4DX-%')).action, 'export');
});

test('group export: summary per branch with a company total, weekly sheet, every branch\'s daily entries, audit log', async () => {
  const a = await admin();
  const wb = await workbook(a, '/admin/export/group.xlsx');
  const names = wb.worksheets.map((w) => w.name);
  assert.deepEqual(names.slice(0, 2), ['Group summary', 'Weekly by branch']);
  for (const c of ['WM', 'JH', 'BR', 'Bangi', 'Ampang']) assert.ok(names.includes(`${c} daily`));
  assert.ok(names.includes('HQ targets') && names.includes('Audit log'));
  const rows = wb.getWorksheet('Group summary').getSheetValues().filter(Boolean).slice(2);
  assert.equal(rows.length, 6);
  assert.equal(rows[5][1], 'Company total');
  assert.equal(rows[0][4], 36265);       // WM October sales so far (12–18 Oct entries + 1–11 Oct figure)
});
