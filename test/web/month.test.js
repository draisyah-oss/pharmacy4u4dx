// 2 Nov 2026 (CEO): monthly scoreboard – the month at company, HQ department, branch and person level,
// week by week, with notes brought forward to the next month until done.
const test = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');

const { createDb } = require('../../src/db');
const { migrate } = require('../../src/db/migrate');
const { readSeed, loadSeed } = require('../../src/db/seed');
const { createApp } = require('../../src/app');
const md = require('../../src/month/data');

let db; let server; let base;
let clock = new Date('2026-11-02T10:00:00+08:00');
const now = () => clock;

test.before(async () => {
  db = await createDb({ url: '', localDir: 'memory' });
  await migrate(db);
  await loadSeed(db, readSeed(), { adminPassword: 'admin-pass-1' });
  const pw = (u, v) => db.query('UPDATE users SET password_hash = $1 WHERE username = $2', [bcrypt.hashSync(v, 4), u]);
  await pw('hafizah', 'manager-pass-1'); await pw('alia', 'alia-pass-1');
  await db.query('UPDATE users SET pin_hash = $1 WHERE username = $2', [bcrypt.hashSync('2468', 4), 'azwani']);
  await db.query('UPDATE users SET pin_hash = $1 WHERE username = $2', [bcrypt.hashSync('1111', 4), 'hazera']);
  const wm = (await db.query("SELECT id FROM branches WHERE code = 'WM'")).rows[0].id;
  // WM walk-in: weak first week, strong last week.
  for (const d of ['2026-10-12', '2026-10-13', '2026-10-14', '2026-10-15', '2026-10-16', '2026-10-17', '2026-10-18']) {
    await db.query("INSERT INTO daily_entries (branch_id, entry_date, field_key, value) VALUES ($1, $2, 'walkin', 1000)", [wm, d]);
  }
  for (const d of ['2026-10-26', '2026-10-27', '2026-10-28', '2026-10-29', '2026-10-30', '2026-10-31']) {
    await db.query("INSERT INTO daily_entries (branch_id, entry_date, field_key, value) VALUES ($1, $2, 'walkin', 2500)", [wm, d]);
  }
  server = createApp(db, { now }).listen(0);
  base = `http://localhost:${server.address().port}`;
});
test.after(async () => { server.close(); await db.close(); });

async function login(kind, username, secret) {
  let cookie = '';
  const req = async (method, p, body) => {
    const r = await fetch(base + p, { method, redirect: 'manual',
      headers: { ...(cookie ? { cookie } : {}), ...(body ? { 'content-type': 'application/x-www-form-urlencoded' } : {}) },
      body: body ? new URLSearchParams(body).toString() : undefined });
    const set = r.headers.get('set-cookie'); if (set) cookie = set.split(';')[0];
    return { status: r.status, location: r.headers.get('location'), html: await r.text() };
  };
  const r = await req('POST', kind === 'pin' ? '/login/pin' : '/login/password', kind === 'pin' ? { username, pin: secret } : { username, password: secret });
  assert.equal(r.status, 302);
  let csrf = null;
  return { get: (p) => req('GET', p), post: async (p, body) => {
    if (!csrf) csrf = ((await req('GET', '/month')).html.match(/name="_csrf" value="([^"]+)"/) || (await req('GET', '/my-week')).html.match(/name="_csrf" value="([^"]+)"/) || [])[1];
    return req('POST', p, { _csrf: csrf, ...body });
  } };
}

test('weeks of the month and the trend arrow', () => {
  assert.deepEqual(md.monthWeeks('2026-10', '2026-11-02', '2026-10-12'), ['2026-10-12', '2026-10-19', '2026-10-26']);
  assert.deepEqual(md.monthWeeks('2026-11', '2026-11-20', '2026-10-12'), ['2026-11-02', '2026-11-09', '2026-11-16']);
  assert.equal(md.trend([0.5, null, 0.9]), 'up');
  assert.equal(md.trend([0.9, 0.5]), 'down');
  assert.equal(md.trend([1, 1.02]), 'same');
  assert.equal(md.trend([1]), null);
});

test('October: company, departments, branches and people; walk-in improved through the month', async () => {
  const m = await md.buildMonth(db, { month: '2026-10', today: '2026-11-02', trackerStart: '2026-10-12', show: { company: true, depts: true, hqPeople: true, branches: 'all' } });
  assert.equal(m.weeks.length, 3);
  assert.equal(m.to, '2026-10-31');
  const wm = m.branches.find((b) => b.code === 'WM');
  assert.equal(wm.sales.weeks[0].total, 7000);
  assert.equal(wm.sales.weeks[1].total, 0);
  assert.equal(wm.sales.weeks[2].total, 15000);
  assert.equal(wm.sales.trend, 'up');
  const t1 = wm.rows.find((r) => r.code === 'T1');
  assert.equal(t1.trend, 'up');
  assert.match(t1.perWeek[0].href, /from=2026-10-12&to=2026-10-18/);
  assert.match(t1.perWeek[2].href, /from=2026-10-26&to=2026-10-31/);
  assert.ok(m.company.total >= 22000);
  assert.deepEqual(m.depts.map((d) => d.name), ['Leadership', 'Inventory, products & B2B', 'Accounts', 'Operations, HR & admin']);
  assert.ok(m.hqPersons.some((p) => p.name === 'Alia'));
  assert.ok(wm.persons.some((p) => p.name === 'Hafizah'));
});

test('who sees what; notes are brought forward to the next month until done', async () => {
  const mgr = await login('password', 'hafizah', 'manager-pass-1');
  let page = await mgr.get('/month');
  assert.equal(page.status, 200);
  assert.match(page.html, /October 2026 scoreboard/);
  assert.match(page.html, /id="branch-WM"/);
  assert.doesNotMatch(page.html, /id="branch-JH"/, 'manager: own branch only');
  assert.doesNotMatch(page.html, /id="depts"/);
  // Manager can note on own branch, not on another or the company.
  let r = await mgr.post('/month/notes', { month: '2026-10', scope: 'branch', ref: 'WM', note: 'Walk-in picked up after the PWP push – keep it', forward: '1' });
  assert.match(r.location, /ok=note/);
  r = await mgr.post('/month/notes', { month: '2026-10', scope: 'branch', ref: 'JH', note: 'x' });
  assert.equal(r.status, 403);
  r = await mgr.post('/month/notes', { month: '2026-10', scope: 'company', ref: '', note: 'x' });
  assert.equal(r.status, 403);
  r = await mgr.post('/month/notes', { month: '2026-10', scope: 'branch', ref: 'WM', note: 'Naik gaji', forward: '1' });
  assert.match(r.location, /err=/, 'salary guard');
  // HQ staff: departments, no branch detail; own department note only.
  const az = await login('pin', 'azwani', '2468');
  page = await az.get('/month');
  assert.match(page.html, /id="depts"/);
  assert.doesNotMatch(page.html, /id="branch-WM"/);
  r = await az.post('/month/notes', { month: '2026-10', scope: 'dept', ref: 'Accounts', note: 'Payment list every Monday', forward: '1' });
  assert.match(r.location, /ok=note/);
  r = await az.post('/month/notes', { month: '2026-10', scope: 'dept', ref: 'Leadership', note: 'x' });
  assert.equal(r.status, 403);
  // Staff: read only.
  const st = await login('pin', 'hazera', '1111');
  page = await st.get('/month');
  assert.equal(page.status, 200);
  assert.match(page.html, /Walk-in picked up after the PWP push/);
  assert.doesNotMatch(page.html, /name="note"/);
  // November: brought forward, tick done.
  clock = new Date('2026-11-20T10:00:00+08:00');
  page = await mgr.get('/month?month=2026-11');
  assert.match(page.html, /Brought forward[\s\S]*Walk-in picked up after the PWP push/);
  const id = (await db.query("SELECT id FROM month_notes WHERE scope = 'branch' AND ref = 'WM'")).rows[0].id;
  r = await mgr.post(`/month/notes/${id}`, { month: '2026-11', done: '1' });
  assert.equal(r.status, 302);
  assert.ok((await db.query('SELECT done_at FROM month_notes WHERE id = $1', [id])).rows[0].done_at);
  // December: done before December → no longer carried.
  clock = new Date('2026-12-08T10:00:00+08:00');
  page = await mgr.get('/month?month=2026-12');
  assert.doesNotMatch(page.html, /Walk-in picked up after the PWP push/);
  const admin = await login('password', 'admin', 'admin-pass-1');
  page = await admin.get('/month?month=2026-12');
  assert.match(page.html, /Payment list every Monday/, 'not done → still carried in December');
});
