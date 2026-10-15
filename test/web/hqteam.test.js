// 15 Oct changes: HQ access levels (full HQ vs HQ staff), login by branch / HQ box, branch
// sales on the front pages, HQ daily tasks, HQ commitments and HQ projects.
// "Today" is Tue 20 Oct.

const test = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');

const { createDb } = require('../../src/db');
const { migrate } = require('../../src/db/migrate');
const { readSeed, loadSeed } = require('../../src/db/seed');
const { createApp } = require('../../src/app');
const { loadBranch } = require('../../src/daily/data');
const team = require('../../src/hq/team');
const { WM_WEEK, WEEK_DATES } = require('../fixtures/sample-weeks');

const TODAY = '2026-10-20';
const THIS = '2026-10-19';
const LAST = '2026-10-12';
let db; let server; let base; let ids;

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
  const pw = (u, v) => db.query('UPDATE users SET password_hash = $1 WHERE username = $2', [bcrypt.hashSync(v, 4), u]);
  const pin = (u, v) => db.query('UPDATE users SET pin_hash = $1 WHERE username = $2', [bcrypt.hashSync(v, 4), u]);
  await pw('alia', 'alia-pass-1'); await pw('hanin', 'hanin-pass-1'); await pw('iman', 'iman-pass-1');
  await pw('hafizah', 'manager-pass-1');
  await pin('syarafana', '2468'); await pin('fariz', '1357'); await pin('hazera', '1111');
  ids = Object.fromEntries((await db.query('SELECT name, id FROM people WHERE branch_id IS NULL')).rows.map((r) => [r.name, r.id]));
  server = createApp(db, { now: () => new Date(`${TODAY}T21:00:00+08:00`) }).listen(0);
  base = `http://localhost:${server.address().port}`;
});
test.after(async () => { server.close(); await db.close(); });

function browser() {
  let cookie = '';
  const req = async (method, p, body) => {
    const r = await fetch(base + p, {
      method, redirect: 'manual',
      headers: { ...(cookie ? { cookie } : {}), ...(body ? { 'content-type': 'application/x-www-form-urlencoded' } : {}) },
      body: body ? new URLSearchParams(body).toString() : undefined,
    });
    const set = r.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    return { status: r.status, location: r.headers.get('location'), html: await r.text() };
  };
  let csrf = null;
  return {
    get: (p) => req('GET', p),
    post: async (p, body) => {
      if (!csrf) csrf = ((await req('GET', '/group')).html.match(/name="_csrf" value="([^"]+)"/) || [])[1];
      return req('POST', p, { _csrf: csrf, ...body });
    },
    login: (p, body) => req('POST', p, body),
  };
}
async function as(kind, username, secret) {
  const b = browser();
  const r = await b.login(kind === 'pin' ? '/login/pin' : '/login/password', kind === 'pin' ? { username, pin: secret } : { username, password: secret });
  assert.equal(r.status, 302, `${username} logs in`);
  return b;
}
const syarafana = () => as('pin', 'syarafana', '2468');
const fariz = () => as('pin', 'fariz', '1357');
const alia = () => as('password', 'alia', 'alia-pass-1');
const iman = () => as('password', 'iman', 'iman-pass-1');
const admin = () => as('password', 'admin', 'admin-pass-1');
const lastAudit = async (table) => (await db.query(
  'SELECT a.*, u.username FROM audit_log a LEFT JOIN users u ON u.id = a.user_id WHERE a.table_name = $1 ORDER BY a.id DESC LIMIT 1', [table])).rows[0];

// ───────────── Access levels and login ─────────────

test('HQ staff log in with a PIN from the HQ box; full HQ with a password', async () => {
  const b = browser();
  const hq = (await b.get('/login?branch=HQ')).html;
  assert.match(hq, /Alia[\s\S]*HQ/);
  assert.match((await b.get('/login?branch=HQ&user=syarafana')).html, /enter your PIN/);
  assert.match((await b.get('/login?branch=HQ&user=alia')).html, /enter your password/);
  // A PIN login can't be used with the password form, and the other way round
  assert.equal((await browser().login('/login/password', { username: 'syarafana', password: '2468' })).status, 401);
  assert.equal((await browser().login('/login/pin', { username: 'alia', pin: '1234' })).status, 401);
});

test('HQ staff see the group and HQ scoreboards and their own KPIs – nothing else', async () => {
  const s = await syarafana();
  assert.equal((await s.get('/')).location, '/hq/today');
  assert.equal((await s.get('/group')).status, 200);
  assert.doesNotMatch((await s.get('/group')).html, /href="\/scoreboard/, 'no links into branches');
  assert.equal((await s.get('/hq/scoreboard')).status, 200);
  const kpis = (await s.get('/hq')).html;
  assert.match(kpis, /My KPIs/);
  assert.match(kpis, /Slow movers reviewed/);
  assert.match(kpis, /Branch orders placed by HQ/);
  assert.doesNotMatch(kpis, /Inventory turnover/, 'not Alia’s KPIs');
  assert.doesNotMatch(kpis, /Cash balance/, 'not Azwani’s KPIs');
  for (const p of ['/daily?branch=WM', '/scoreboard?branch=WM', '/weekly?branch=WM', '/commitments?branch=WM']) {
    const r = await s.get(p);
    assert.ok(r.status === 403 || r.status === 302, `${p} is closed (${r.status})`);
    assert.doesNotMatch(r.html, /Walk-in sales/, p);
  }
  assert.equal((await s.get('/admin')).status, 403);
  // Full HQ still reads every branch
  assert.equal((await (await alia()).get('/daily?branch=WM')).status, 200);
});

test('admin can move someone between HQ staff and full HQ (new PIN or password needed)', async () => {
  const a = await admin();
  const r = await a.post(`/admin/people/${ids.Fariz}`, { branch: 'HQ', name: 'Fariz', job: 'Warehouse intern', username: 'fariz', login_role: 'hq' });
  assert.equal(r.status, 302);
  const u = (await db.query("SELECT role, pin_hash FROM users WHERE username = 'fariz'")).rows[0];
  assert.equal(u.role, 'hq');
  assert.equal(u.pin_hash, null);
  await a.post(`/admin/people/${ids.Fariz}`, { branch: 'HQ', name: 'Fariz', job: 'Warehouse intern', username: 'fariz', login_role: 'hq_staff' });
  await db.query("UPDATE users SET pin_hash = $1 WHERE username = 'fariz'", [bcrypt.hashSync('1357', 4)]);
  assert.equal((await db.query("SELECT role FROM users WHERE username = 'fariz'")).rows[0].role, 'hq_staff');
});

// ───────────── Branch sales up front ─────────────

test('branch month sales are on the HQ/admin home page and on each branch’s daily entry', async () => {
  const home = (await (await admin()).get('/')).html;
  assert.match(home, /Wangsa Maju[\s\S]*October sales so far[\s\S]*RM 36,615/);
  assert.match(home, /Needed per day/);
  const staffDaily = (await (await as('pin', 'hazera', '1111')).get('/daily')).html;
  assert.match(staffDaily, /October sales so far/);
  assert.match(staffDaily, /RM 36,615/);
  assert.doesNotMatch(staffDaily, /href="\/scoreboard\/trace/, 'staff get the number, not the scoreboard link');
  const mgrDaily = (await (await as('password', 'hafizah', 'manager-pass-1')).get('/daily')).html;
  assert.match(mgrDaily, /href="\/scoreboard\/trace\?type=sales/);
});

// ───────────── HQ daily tasks ─────────────

test('daily tasks: a day counts when every task is done (Mon–Fri only)', () => {
  const tasks = [{ id: 1 }, { id: 2 }];
  const ticks = new Map([['1|2026-10-19', { done: true }], ['2|2026-10-19', { done: true }], ['1|2026-10-20', { done: true }], ['2|2026-10-20', { done: false }]]);
  const w = team.dailyWeekSummary({ tasks, ticks, weekStart: THIS, through: '2026-10-25' });
  assert.equal(w.workingDays, 5, 'Saturday and Sunday don’t count');
  assert.equal(w.fullDays, 1);
  assert.equal(w.pct, 0.2);
});

test('Iman ticks her HR daily checks; HQ staff only their own; changes are audited', async () => {
  const im = await iman();
  const page = (await im.get('/hq/today')).html;
  assert.match(page, /Attendance &amp; roster checked by 10 am/);
  const tasks = (await db.query('SELECT id FROM hq_daily_tasks WHERE person_id = $1 AND active ORDER BY sort_order', [ids.Iman])).rows;
  assert.equal(tasks.length, 6);
  const body = { person: String(ids.Iman), date: THIS };
  tasks.forEach((t) => { body[`t[k${t.id}]`] = 'yes'; });
  assert.equal((await im.post('/hq/today', body)).status, 302);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM hq_daily_ticks WHERE entry_date = $1 AND done', [THIS])).rows[0].n, 6);
  assert.equal((await lastAudit('hq_daily_ticks')).username, 'iman');
  assert.match((await im.get(`/hq/today?date=${THIS}`)).html, /1 of 2/, 'Mon fully done, Tue not yet');

  // Syarafana can't tick Iman's tasks, but can build her own list
  const s = await syarafana();
  assert.equal((await s.post('/hq/today', { person: String(ids.Iman), date: TODAY, [`t[k${tasks[0].id}]`]: 'no' })).status, 403);
  assert.doesNotMatch((await s.get(`/hq/today?person=${ids.Iman}`)).html, /Attendance/, 'she only sees her own day');
  // Her starting list (from her KPIs), and she can change it
  const start = (await db.query('SELECT label FROM hq_daily_tasks WHERE person_id = $1 AND active ORDER BY sort_order', [ids.Syarafana])).rows.map((t) => t.label);
  assert.equal(start.length, 5);
  assert.match(start.join(' | '), /checked against the last 30 days' sales/);
  await s.post('/hq/today/tasks', { person: String(ids.Syarafana), date: TODAY, label: 'Branch daily requests turned into POs' });
  const added = (await db.query("SELECT id FROM hq_daily_tasks WHERE person_id = $1 AND active AND label = 'Branch daily requests turned into POs'", [ids.Syarafana])).rows[0];
  assert.ok(added);
  await s.post('/hq/today/tasks', { person: String(ids.Syarafana), date: TODAY, retire: String(added.id) });
  assert.equal((await db.query('SELECT count(*)::int AS n FROM hq_daily_tasks WHERE person_id = $1 AND active', [ids.Syarafana])).rows[0].n, 5);
  // Salary words are refused here too
  const bad = await s.post('/hq/today/tasks', { person: String(ids.Syarafana), date: TODAY, label: 'Send payroll inputs' });
  assert.match(decodeURIComponent(bad.location), /can’t be stored/);
});

// ───────────── HQ commitments ─────────────

test('HQ commitments: one per person, own only (Iman for everyone), Done / Partly / No next week', async () => {
  const al = await alia();
  const r = await al.post('/hq/commitments', {
    week: LAST, [`c[p${ids.Alia}][text]`]: 'Review 25 slow movers at WM and JH', [`c[p${ids.Hanin}][text]`]: 'Not Alia’s to write',
  });
  assert.equal(r.status, 302);
  const lastWeek = (await db.query('SELECT person_id, commitment FROM hq_commitments WHERE week_start = $1', [LAST])).rows;
  assert.deepEqual(lastWeek.map((c) => c.person_id), [ids.Alia], 'Alia only writes her own');

  const im = await iman();
  await im.post('/hq/commitments', { week: LAST, [`c[p${ids.Fariz}][text]`]: 'Check every delivery against its PO' });
  assert.equal((await db.query('SELECT count(*)::int AS n FROM hq_commitments WHERE week_start = $1', [LAST])).rows[0].n, 2);

  // This week: mark last week's
  const c = (await db.query('SELECT id FROM hq_commitments WHERE week_start = $1 AND person_id = $2', [LAST, ids.Alia])).rows[0];
  await al.post('/hq/commitments', { week: THIS, [`done[k${c.id}]`]: 'partly' });
  assert.equal((await db.query('SELECT done FROM hq_commitments WHERE id = $1', [c.id])).rows[0].done, 'partly');
  const kept = team.keptSummary(await team.loadCommitmentWeek(db, LAST));
  assert.deepEqual([kept.made, kept.kept, kept.partly], [2, 0, 1]);

  // HQ staff see only their own row
  const f = await fariz();
  const html = (await f.get(`/hq/commitments?week=${THIS}`)).html;
  assert.match(html, /Check every delivery against its PO/);
  assert.doesNotMatch(html, /slow movers at WM/);
  // "To move" must be one of their measures or project milestones
  const bad = await f.post('/hq/commitments', { week: THIS, [`c[p${ids.Fariz}][text]`]: 'x', [`c[p${ids.Fariz}][moves]`]: 'Inventory turnover, end-to-end (days) – INVENTORY WIG' });
  assert.equal(bad.status, 400);
  const ok = await f.post('/hq/commitments', { week: THIS, [`c[p${ids.Fariz}][text]`]: 'All POs done within the hour', [`c[p${ids.Fariz}][moves]`]: '1 PO per branch completed within 1 hour' });
  assert.equal(ok.status, 302);
});

// ───────────── HQ projects ─────────────

test('projects: seeded from the HQ Tracker; owners update their own; HQ adds milestones', async () => {
  assert.equal((await db.query('SELECT count(*)::int AS n FROM hq_projects')).rows[0].n, readSeed().hq.projects.length);
  const s = await syarafana();
  const page = (await s.get('/hq/projects')).html;
  assert.match(page, /Central ordering/);
  assert.doesNotMatch(page, /Company wiki/, 'only the milestones she owns');
  const mine = (await db.query("SELECT id FROM hq_projects WHERE owner LIKE 'Syarafana%' ORDER BY id LIMIT 1")).rows[0];
  await s.post(`/hq/projects/${mine.id}`, { status: 'In progress', start_date: '2026-10-15', due_date: '2027-01-31' });
  const p = (await db.query('SELECT status, start_date, due_date FROM hq_projects WHERE id = $1', [mine.id])).rows[0];
  assert.equal(p.status, 'In progress');
  assert.equal(p.start_date, '2026-10-15');
  assert.equal(p.due_date, '2026-10-31', 'HQ staff can’t move the due date');
  assert.equal((await lastAudit('hq_projects')).username, 'syarafana');
  const notMine = (await db.query("SELECT id FROM hq_projects WHERE owner = 'Alia'")).rows[0];
  assert.equal((await s.post(`/hq/projects/${notMine.id}`, { status: 'Done' })).status, 403);
  assert.equal((await s.post('/hq/projects', { project: 'X', milestone: 'Y', owner: 'Z' })).status, 403);

  const al = await alia();
  await al.post('/hq/projects', { project: 'Stock', milestone: 'Dead stock list sent to every branch', owner: 'Alia', start_date: '2026-10-20', due_date: '2026-10-31' });
  assert.match((await al.get('/hq/projects')).html, /Dead stock list sent to every branch/);
});

test('HQ scoreboard shows the team: daily tasks, commitments, projects', async () => {
  const html = (await (await alia()).get(`/hq/scoreboard?week=${THIS}`)).html;
  assert.match(html, /Team this week/);
  assert.match(html, /Iman[\s\S]*1 of 2 days/);
  assert.match(html, /Partly/);
  assert.match(html, /milestones done/);
});

test('an older database gets the HQ access levels, tasks and projects once', async () => {
  const { backfillHqAccess } = require('../../src/db/setup');
  const old = await createDb({ url: '', localDir: 'memory' });
  await migrate(old);
  const seed = readSeed();
  const before = { ...seed, hq: { ...seed.hq, owners: seed.hq.owners.map(({ access, ...o }) => o), daily_tasks: {}, projects: [] } };
  await loadSeed(old, before, { adminPassword: 'admin-pass-1' });
  await old.query("DELETE FROM app_settings WHERE key = 'hq_access_v1'");
  await old.query("UPDATE users SET password_hash = 'x' WHERE username = 'fariz'");
  assert.equal((await old.query("SELECT role FROM users WHERE username = 'fariz'")).rows[0].role, 'hq');
  await backfillHqAccess(old, seed, () => {});
  const fz = (await old.query("SELECT role, password_hash FROM users WHERE username = 'fariz'")).rows[0];
  assert.equal(fz.role, 'hq_staff');
  assert.equal(fz.password_hash, null, 'needs a PIN now');
  assert.equal((await old.query("SELECT role FROM users WHERE username = 'alia'")).rows[0].role, 'hq');
  assert.equal((await old.query('SELECT count(*)::int AS n FROM hq_projects')).rows[0].n, seed.hq.projects.length);
  // Admin changes Fariz back to full HQ; a restart doesn't undo it
  await old.query("UPDATE users SET role = 'hq' WHERE username = 'fariz'");
  await backfillHqAccess(old, seed, () => {});
  assert.equal((await old.query("SELECT role FROM users WHERE username = 'fariz'")).rows[0].role, 'hq');
  await old.close();
});

test('every HQ person starts with daily tasks; an older database gets them once, without touching existing lists', async () => {
  const seed = readSeed();
  for (const name of ['Alia', 'Syarafana', 'Fariz', 'Azwani', 'Hanin', 'Iman']) {
    const n = (await db.query('SELECT count(*)::int AS n FROM hq_daily_tasks WHERE person_id = $1', [ids[name]])).rows[0].n;
    assert.ok(n >= 4, `${name} has daily tasks`);
  }
  const { backfillHqTasks } = require('../../src/db/setup');
  const old = await createDb({ url: '', localDir: 'memory' });
  await migrate(old);
  await loadSeed(old, { ...seed, hq: { ...seed.hq, daily_tasks: { Iman: seed.hq.daily_tasks.Iman } } }, { adminPassword: 'admin-pass-1' });
  await old.query("DELETE FROM app_settings WHERE key = 'hq_daily_tasks_v2'");
  const imanId = (await old.query("SELECT id FROM people WHERE name = 'Iman' AND branch_id IS NULL")).rows[0].id;
  await old.query("UPDATE hq_daily_tasks SET active = false WHERE person_id = $1 AND sort_order > 3", [imanId]); // Iman trimmed her list
  await backfillHqTasks(old, seed, () => {});
  const count = async (name) => (await old.query('SELECT count(*)::int AS n FROM hq_daily_tasks t JOIN people p ON p.id = t.person_id WHERE p.name = $1 AND t.active', [name])).rows[0].n;
  assert.equal(await count('Azwani'), seed.hq.daily_tasks.Azwani.length);
  assert.equal(await count('Iman'), 3, 'Iman’s own changes are kept');
  await old.query("UPDATE hq_daily_tasks SET active = false WHERE person_id = (SELECT id FROM people WHERE name = 'Azwani' AND branch_id IS NULL)");
  await backfillHqTasks(old, seed, () => {});
  assert.equal(await count('Azwani'), 0, 'runs once – removed tasks stay removed');
  await old.close();
});
