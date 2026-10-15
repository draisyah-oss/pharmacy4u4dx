// Monday screens: weekly check-in + OOS list, commitments, group scoreboard, HQ input and
// HQ scoreboard. Who may see and change what, numbers, audit log, salary guard.
// "Today" is Tue 20 Oct, so last week = 12–18 Oct (the sample WM week) and this week = 19 Oct.

const test = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');

const { createDb } = require('../../src/db');
const { migrate } = require('../../src/db/migrate');
const { readSeed, loadSeed } = require('../../src/db/seed');
const { createApp } = require('../../src/app');
const { loadBranch } = require('../../src/daily/data');
const { buildScoreboard } = require('../../src/scoreboard/data');
const { buildGroup } = require('../../src/group/data');
const { numbersFor } = require('../../src/weekly/data');
const hqData = require('../../src/hq/data');
const weeks = require('../../src/lib/weeks');
const { WM_WEEK, WEEK_DATES } = require('../fixtures/sample-weeks');

const TODAY = '2026-10-20';
const START = '2026-10-12';
const LAST = '2026-10-12';
const THIS = '2026-10-19';
let db; let server; let base; let wm;
const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-6, `${msg || ''} expected ${b}, got ${a}`);

test.before(async () => {
  db = await createDb({ url: '', localDir: 'memory' });
  await migrate(db);
  await loadSeed(db, readSeed(), { adminPassword: 'admin-pass-1' });
  wm = await loadBranch(db, 'WM');
  for (const [field, values] of Object.entries(WM_WEEK)) {
    for (let i = 0; i < 7; i++) {
      await db.query('INSERT INTO daily_entries (branch_id, entry_date, field_key, value) VALUES ($1,$2,$3,$4)', [wm.id, WEEK_DATES[i], field, values[i]]);
    }
  }
  const set = (u, col, v) => db.query(`UPDATE users SET ${col} = $1 WHERE username = $2`, [bcrypt.hashSync(v, 4), u]);
  await set('hafizah', 'password_hash', 'manager-pass-1');
  await set('afifah', 'password_hash', 'manager-pass-2');
  await set('alia', 'password_hash', 'hq-pass-123');
  await set('hanin', 'password_hash', 'hq-pass-456');
  await set('hazera', 'pin_hash', '1111');
  server = createApp(db, { now: () => new Date(`${TODAY}T21:00:00+08:00`) }).listen(0);
  base = `http://localhost:${server.address().port}`;
});
test.after(async () => { server.close(); await db.close(); });

async function session(path, form) {
  const res = await fetch(base + path, {
    method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(form).toString() });
  assert.equal(res.status, 302, 'login works');
  const cookie = res.headers.get('set-cookie').split(';')[0];
  const req = async (method, p, body) => {
    const r = await fetch(base + p, {
      method, redirect: 'manual',
      headers: { cookie, ...(body ? { 'content-type': 'application/x-www-form-urlencoded' } : {}) },
      body: body ? new URLSearchParams(body).toString() : undefined,
    });
    return { status: r.status, location: r.headers.get('location'), html: await r.text() };
  };
  let csrf = null;
  return {
    get: (p) => req('GET', p),
    post: async (p, body) => {
      if (!csrf) csrf = (await req('GET', '/group')).html.match(/name="_csrf" value="([^"]+)"/)[1];
      return req('POST', p, { _csrf: csrf, ...body });
    },
  };
}
const manager = () => session('/login/password', { username: 'hafizah', password: 'manager-pass-1' });
const jhManager = () => session('/login/password', { username: 'afifah', password: 'manager-pass-2' });
const alia = () => session('/login/password', { username: 'alia', password: 'hq-pass-123' });
const hanin = () => session('/login/password', { username: 'hanin', password: 'hq-pass-456' });
const admin = () => session('/login/password', { username: 'admin', password: 'admin-pass-1' });
const staff = () => session('/login/pin', { username: 'hazera', pin: '1111' });
const lastAudit = async (table) => (await db.query(
  'SELECT a.*, u.username FROM audit_log a LEFT JOIN users u ON u.id = a.user_id WHERE a.table_name = $1 ORDER BY a.id DESC LIMIT 1', [table])).rows[0];
const checkin = async (code, week) => (await db.query(
  'SELECT c.* FROM weekly_checkins c JOIN branches b ON b.id = c.branch_id WHERE b.code = $1 AND c.week_start = $2', [code, week])).rows[0];

// ───────────── Weeks ─────────────

test('weeks: Monday check-in reports the week that just ended; HQ targets use the Thursday\'s month', () => {
  assert.equal(weeks.lastFinishedWeek(START, TODAY), LAST);
  assert.equal(weeks.lastFinishedWeek(START, '2026-10-14'), LAST, 'first tracker week: no finished week yet');
  assert.equal(weeks.weekMonth('2026-10-26'), '2026-10'); // 26 Oct – 1 Nov: Thursday 29 Oct
  assert.equal(weeks.weekMonth('2026-11-30'), '2026-12'); // 30 Nov – 6 Dec: Thursday 3 Dec
  assert.deepEqual(weeks.trendWeeks(START, THIS), [LAST, THIS]);
  assert.equal(weeks.trendWeeks(START, '2027-03-01').length, 12);
});

// ───────────── Weekly check-in ─────────────

test('who can open the check-in: managers their own branch, HQ/admin all, staff none', async () => {
  const m = await manager();
  const page = await m.get('/weekly');
  assert.equal(page.status, 200);
  assert.match(page.html, /Weekly check-in/);
  assert.match(page.html, /12–18 Oct/, 'defaults to last week');
  assert.equal((await m.get('/weekly?branch=JH')).status, 200, 'branch in the URL is ignored for managers');
  assert.match((await m.get('/weekly?branch=JH')).html, /Wangsa Maju|WM/);
  assert.equal((await (await staff()).get('/weekly')).status, 403);
  assert.equal((await (await staff()).get('/commitments')).status, 403);
  assert.equal((await (await alia()).get('/weekly?branch=BR')).status, 200);
});

test('manager saves the check-in; stock turnover is worked out; the change is audited', async () => {
  const m = await manager();
  const r = await m.post('/weekly', {
    week: LAST, opening_stock_value: '100,000', closing_stock_value: '80000', weekly_cogs: '23400',
    sku_qty_on_hand: '1500', skus_sold_mtd: '420', zakat_claims_disbursed: '3', zakat_claims_pending: '5',
    win_this_week: 'Hit walk-in target 5 days running', issue_needing_hq_help: 'Need more Panadol stock',
  });
  assert.equal(r.status, 302);
  const c = await checkin('WM', LAST);
  assert.equal(Number(c.opening_stock_value), 100000);
  assert.equal(Number(c.zakat_claims_pending), 5);
  assert.equal(c.win_this_week, 'Hit walk-in target 5 days running');
  const a = await lastAudit('weekly_checkins');
  assert.equal(a.username, 'hafizah');
  assert.equal(a.record_key, `WM ${LAST}`);

  const page = await m.get(`/weekly?week=${LAST}`);
  // 23,400 ÷ ((100,000 + 80,000) ÷ 2) = 0.26 – above the 0.23 target
  assert.match(page.html, /0\.26 ✔/);
  assert.match(page.html, /Need more Panadol stock/);

  // Saving the same again changes nothing and logs nothing
  const before = (await db.query('SELECT count(*)::int AS n FROM audit_log')).rows[0].n;
  await m.post('/weekly', {
    week: LAST, opening_stock_value: '100000', closing_stock_value: '80000', weekly_cogs: '23400',
    sku_qty_on_hand: '1500', skus_sold_mtd: '420', zakat_claims_disbursed: '3', zakat_claims_pending: '5',
    win_this_week: 'Hit walk-in target 5 days running', issue_needing_hq_help: 'Need more Panadol stock',
  });
  assert.equal((await db.query('SELECT count(*)::int AS n FROM audit_log')).rows[0].n, before);
});

test('check-in: bad numbers save nothing and keep what was typed', async () => {
  const m = await manager();
  const r = await m.post('/weekly', { week: THIS, opening_stock_value: 'abc', win_this_week: 'Kept text' });
  assert.equal(r.status, 400);
  assert.match(r.html, /numbers only/);
  assert.match(r.html, /Kept text/);
  assert.equal(await checkin('WM', THIS), undefined);
});

test('check-in: managers can change this week and last week only; HQ reads but can’t change', async () => {
  const m = await manager();
  // A week that isn't on the list (before the tracker, or a typo) is refused outright.
  const r = await m.post('/weekly', { week: '2026-10-05', weekly_cogs: '1' });
  assert.equal(r.status, 400);
  assert.equal(await checkin('WM', '2026-10-05'), undefined);
  assert.equal(Number((await checkin('WM', LAST)).weekly_cogs), 23400, 'never saved to another week');
  // Two weeks back is too old for a manager (pretend today is 3 Nov)
  const { editDenied } = require('../../src/weekly/access');
  const user = { role: 'branch_manager', branch_id: wm.id };
  assert.match(editDenied(user, wm, LAST, '2026-11-03'), /this week and last week/);
  assert.equal(editDenied(user, wm, '2026-10-26', '2026-11-03'), null);
  assert.equal(editDenied({ role: 'admin' }, wm, LAST, '2026-11-03'), null);
  const hq = await alia();
  assert.equal((await hq.post('/weekly', { branch: 'WM', week: LAST, weekly_cogs: '1' })).status, 403);
  assert.equal(Number((await checkin('WM', LAST)).weekly_cogs), 23400);
  // JH's manager can't change WM (their own branch is used instead)
  const jh = await jhManager();
  await jh.post('/weekly', { branch: 'WM', week: LAST, weekly_cogs: '999' });
  assert.equal(Number((await checkin('WM', LAST)).weekly_cogs), 23400);
  assert.equal(Number((await checkin('JH', LAST)).weekly_cogs), 999);
});

test('zakat boxes only for branches with zakat', async () => {
  const keys = (b) => numbersFor(b).map((n) => n.key);
  assert.ok(keys({ zakat_field: 'zakat' }).includes('zakat_claims_pending'));
  assert.ok(!keys({ zakat_field: null }).includes('zakat_claims_pending'));
  const html = (await (await admin()).get('/weekly?branch=Bangi')).html;
  assert.doesNotMatch(html, /zakat_claims_pending/);
  assert.match(html, /No zakat at this branch/);
});

// ───────────── OOS list ─────────────

test('OOS: manager adds an item, HQ answers it, other branches can’t touch it', async () => {
  const m = await manager();
  const r = await m.post('/weekly/oos', { week: LAST, item: 'Panadol Actifast 20s', out_of_stock_since: '2026-10-15', customers_asking: '4 asked' });
  assert.equal(r.status, 302);
  const item = (await db.query("SELECT * FROM oos_items WHERE item = 'Panadol Actifast 20s'")).rows[0];
  assert.equal(item.status, 'Open');
  assert.equal((await lastAudit('oos_items')).action, 'insert');

  const hq = await alia();
  await hq.post(`/weekly/oos/${item.id}`, { week: LAST, reason_for_delay: 'Supplier short', expected_back: '2026-10-25', status: 'Ordered' });
  const after = (await db.query('SELECT * FROM oos_items WHERE id = $1', [item.id])).rows[0];
  assert.equal(after.reason_for_delay, 'Supplier short');
  assert.equal(after.expected_back, '2026-10-25');
  assert.equal(after.status, 'Ordered');
  assert.equal(after.item, 'Panadol Actifast 20s', 'HQ answers; the branch’s words stay');
  assert.equal((await lastAudit('oos_items')).username, 'alia');

  // Still open, so it shows on this week's check-in too
  assert.match((await m.get(`/weekly?week=${THIS}`)).html, /Panadol Actifast 20s/);

  const jh = await jhManager();
  assert.equal((await jh.post(`/weekly/oos/${item.id}`, { week: LAST, item: 'Hacked', status: 'Back in stock' })).status, 403);
  assert.equal((await db.query('SELECT item FROM oos_items WHERE id = $1', [item.id])).rows[0].item, 'Panadol Actifast 20s');
  assert.equal((await (await staff()).post(`/weekly/oos/${item.id}`, { status: 'Back in stock' })).status, 403);
});

// ───────────── Commitments ─────────────

test('commitments: one per person this week, last week marked done, off-track measures listed', async () => {
  const m = await manager();
  const page = await m.get('/commitments');
  assert.equal(page.status, 200);
  assert.match(page.html, /19–25 Oct/, 'defaults to this week');
  // F1 (follow-ups) was off track in the sample week
  assert.match(page.html, /Follow-up messages to existing customers/);
  const people = (await db.query('SELECT id, name FROM people WHERE branch_id = $1 AND active ORDER BY sort_order', [wm.id])).rows;
  const hazera = people.find((p) => p.name === 'Hazera');
  const lead = (await db.query("SELECT label FROM measures WHERE branch_id = $1 AND code = 'F1'", [wm.id])).rows[0].label;

  // Last week's (made at the 12 Oct session) – inserted directly, then marked done.
  await db.query('INSERT INTO commitments (branch_id, week_start, person_id, commitment) VALUES ($1, $2, $3, $4)', [wm.id, LAST, hazera.id, 'Call 20 customers']);
  const old = (await db.query('SELECT id FROM commitments WHERE week_start = $1', [LAST])).rows[0];

  const r = await m.post('/commitments', {
    week: THIS, [`done[k${old.id}]`]: 'yes',
    [`c[p${hazera.id}][text]`]: 'Send 15 follow-ups a day', [`c[p${hazera.id}][lead]`]: lead, [`c[p${hazera.id}][by]`]: '2026-10-25',
  });
  assert.equal(r.status, 302);
  assert.equal((await db.query('SELECT done FROM commitments WHERE id = $1', [old.id])).rows[0].done, true);
  const now = (await db.query('SELECT * FROM commitments WHERE week_start = $1', [THIS])).rows;
  assert.equal(now.length, 1);
  assert.equal(now[0].lead_measure, lead);
  assert.equal(now[0].by_when, '2026-10-25');

  // Saving again with new words updates the same row (one per person)
  await m.post('/commitments', { week: THIS, [`c[p${hazera.id}][text]`]: 'Send 20 follow-ups a day', [`c[p${hazera.id}][lead]`]: lead });
  const again = (await db.query('SELECT * FROM commitments WHERE week_start = $1', [THIS])).rows;
  assert.equal(again.length, 1);
  assert.equal(again[0].commitment, 'Send 20 follow-ups a day');
  assert.equal((await lastAudit('commitments')).action, 'update');

  // A measure that isn't on the list is refused
  const bad = await m.post('/commitments', { week: THIS, [`c[p${hazera.id}][text]`]: 'x', [`c[p${hazera.id}][lead]`]: 'Made up' });
  assert.equal(bad.status, 400);
  assert.match(bad.html, /Pick the measure from the list/);

  // Emptying the box removes the commitment
  await m.post('/commitments', { week: THIS, [`c[p${hazera.id}][text]`]: '' });
  assert.equal((await db.query('SELECT count(*)::int AS n FROM commitments WHERE week_start = $1', [THIS])).rows[0].n, 0);
  assert.equal((await lastAudit('commitments')).action, 'delete');
});

// ───────────── Salary guard ─────────────

test('salary words are refused in every free-text box, and by the database', async () => {
  const m = await manager();
  const r = await m.post('/weekly', { week: THIS, issue_needing_hq_help: 'Staff gaji late this month' });
  assert.equal(r.status, 400);
  assert.match(r.html, /can’t be stored/);
  const o = await m.post('/weekly/oos', { week: THIS, item: 'Payroll printer paper' });
  assert.match(decodeURIComponent(o.location), /can’t be stored/);
  const people = (await db.query('SELECT id FROM people WHERE branch_id = $1 AND active', [wm.id])).rows;
  const c = await m.post('/commitments', { week: THIS, [`c[p${people[0].id}][text]`]: 'Check salary slips' });
  assert.equal(c.status, 400);

  await assert.rejects(db.query('INSERT INTO commitments (branch_id, week_start, person_id, commitment) VALUES ($1, $2, $3, $4)',
    [wm.id, THIS, people[0].id, 'Sort out EPF']));
  await assert.rejects(db.query("INSERT INTO weekly_checkins (branch_id, week_start, win_this_week) VALUES ($1, $2, 'Wages paid early')", [wm.id, THIS]));
  await assert.rejects(db.query("INSERT INTO oos_items (branch_id, week_start, item) VALUES ($1, $2, 'Slip gaji')", [wm.id, THIS]));
});

// ───────────── Group scoreboard ─────────────

test('group scoreboard: one row per branch, numbers match the branch scoreboard, company total adds up', async () => {
  const g = await buildGroup(db, { week: LAST, today: TODAY, trackerStart: START });
  const active = (await db.query('SELECT code FROM branches WHERE active ORDER BY sort_order')).rows.map((b) => b.code);
  assert.deepEqual(g.rows.map((r) => r.code), active);

  const row = g.rows.find((r) => r.code === 'WM');
  const board = await buildScoreboard(db, { branch: wm, weekStart: LAST, today: TODAY, trackerStart: START });
  const t1 = board.top.find((r) => r.code === 'T1');
  near(row.walk.pct, t1.week.pct, 'walk-in %');
  assert.equal(row.lead1.code, 'F1');
  assert.equal(row.lead1.status, 'off_track');
  assert.equal(row.lead2.code, 'Z2');
  assert.equal(row.sales.mtd, board.sales.mtd);
  near(row.turnover.turnover, 0.26, 'turnover from the check-in');
  assert.equal(row.oos, 1);
  assert.equal(row.zakatPending, 5);
  assert.equal(g.rows.find((r) => r.code === 'Bangi').hasZakat, false);

  near(g.total.mtd, g.rows.reduce((a, r) => a + r.sales.mtd, 0), 'company MTD');
  near(g.total.monthTarget, g.rows.reduce((a, r) => a + (r.sales.monthTarget || 0), 0), 'company month target');
  // Only branches with stock numbers count: WM 0.26 and JH (COGS 999, no stock values → none)
  assert.equal(g.total.turnoverBranches, 1);
  assert.deepEqual(g.wins.map((w) => w.code), ['WM']);
  assert.equal(g.trend[0].cells.length, 1);
});

test('group scoreboard: managers, HQ and admin; managers only get links into their own branch', async () => {
  assert.equal((await (await staff()).get('/group')).status, 403);
  const m = await manager();
  const page = await m.get(`/group?week=${LAST}`);
  assert.equal(page.status, 200);
  assert.match(page.html, /href="\/scoreboard\?week=2026-10-12"/, 'own branch links');
  assert.doesNotMatch(page.html, /branch=JH/, 'no links into other branches');
  assert.match(page.html, /Hit walk-in target 5 days running/);
  const a = await admin();
  assert.match((await a.get(`/group?week=${LAST}`)).html, /branch=JH/);
});

// ───────────── HQ ─────────────

test('HQ input: Alia enters her measures; percent typed as percent; done of total; audited', async () => {
  const a = await alia();
  const page = await a.get('/hq');
  assert.equal(page.status, 200);
  const ids = Object.fromEntries((await db.query('SELECT code, id FROM hq_measures')).rows.map((r) => [r.code, r.id]));
  const r = await a.post('/hq', {
    week: LAST, [`v[m${ids.turn}]`]: '100', [`v[m${ids.po}]`]: '18', [`t[m${ids.po}]`]: '20',
    [`v[m${ids.top100}]`]: '97.5%', [`v[m${ids.staff}]`]: '50', // staff is Hanin's – ignored
  });
  assert.equal(r.status, 302);
  const e = Object.fromEntries((await db.query(
    'SELECT m.code, e.value, e.total FROM hq_entries e JOIN hq_measures m ON m.id = e.hq_measure_id WHERE e.week_start = $1', [LAST])).rows.map((x) => [x.code, x]));
  assert.equal(Number(e.turn.value), 100);
  assert.equal(Number(e.po.value), 18);
  assert.equal(Number(e.po.total), 20);
  near(Number(e.top100.value), 0.975);
  assert.equal(e.staff, undefined, 'Alia can’t enter Hanin’s numbers');
  assert.equal((await lastAudit('hq_entries')).username, 'alia');

  const h = await hanin();
  await h.post('/hq', { week: LAST, [`v[m${ids.staff}]`]: '96' });
  near(Number((await db.query('SELECT value FROM hq_entries WHERE hq_measure_id = $1', [ids.staff])).rows[0].value), 0.96);
});

test('HQ input: done can’t exceed total; percent over 100 refused; managers can’t open it', async () => {
  const a = await alia();
  const ids = Object.fromEntries((await db.query('SELECT code, id FROM hq_measures')).rows.map((r) => [r.code, r.id]));
  const r = await a.post('/hq', { week: THIS, [`v[m${ids.po}]`]: '21', [`t[m${ids.po}]`]: '20' });
  assert.equal(r.status, 400);
  assert.match(r.html, /more than the total/);
  const r2 = await a.post('/hq', { week: THIS, [`v[m${ids.top100}]`]: '120' });
  assert.equal(r2.status, 400);
  assert.equal((await (await manager()).get('/hq')).status, 403);
  assert.equal((await (await manager()).get('/hq/scoreboard')).status, 403);
});

test('HQ scoreboard: turnover days lower is better; done-of-total shown as %', async () => {
  const board = await hqData.buildHqScoreboard(db, { week: LAST, trackerStart: START });
  const rows = board.groups.flatMap((g) => g.rows);
  const turn = rows.find((r) => r.code === 'turn');
  assert.equal(turn.target, 92); // October
  near(turn.result.pct, 0.92); // 92 ÷ 100 days
  assert.equal(turn.result.status, 'watch');
  const po = rows.find((r) => r.code === 'po');
  near(po.result.actual, 0.9);
  assert.equal(po.result.status, 'watch');
  assert.deepEqual(board.groups.map((g) => g.owner), ['Dr Aisyah', 'Alia', 'Syarafana', 'Fariz', 'Azwani', 'Hanin', 'Iman']);

  const html = (await (await hanin()).get(`/hq/scoreboard?week=${LAST}`)).html;
  assert.match(html, /100 days/);
  assert.match(html, /18 of 20/);
  assert.match(html, /href="\/hq\?week=2026-10-12#hq-turn"/, 'numbers link to the entry');
});

test('no Monday page mentions salaries', async () => {
  const a = await admin();
  for (const p of ['/weekly?branch=WM', '/commitments?branch=WM', '/group', '/hq', '/hq/scoreboard']) {
    const html = (await a.get(p)).html;
    assert.doesNotMatch(html.replace(/<[^>]+>/g, ' '), /salar|gaji|payroll|\bwages?\b/i, p);
  }
});

test('group Excel export includes the Monday screens', async () => {
  const { groupWorkbook } = require('../../src/admin/export');
  const { wb } = await groupWorkbook(db, { now: () => new Date(`${TODAY}T21:00:00+08:00`) });
  const names = wb.worksheets.map((w) => w.name);
  for (const n of ['Weekly check-ins', 'Out of stock', 'Commitments', 'HQ entries']) assert.ok(names.includes(n), n);
  const ws = wb.getWorksheet('Weekly check-ins');
  const values = ws.getSheetValues().flat().filter((v) => v !== undefined && v !== null).map(String);
  assert.ok(values.includes('Hit walk-in target 5 days running'));
});

// ───────────── The whole HQ team (Q4 4DX HQ Tracker) ─────────────

test('HQ team: Syarafana, Fariz, Azwani and Iman have logins; the CEO has measures but logs in as admin', async () => {
  const users = (await db.query("SELECT username, role, enters_all_hq FROM users WHERE role = 'hq' ORDER BY username")).rows;
  assert.deepEqual(users.map((u) => u.username), ['alia', 'azwani', 'fariz', 'hanin', 'iman', 'syarafana']);
  assert.deepEqual(users.filter((u) => u.enters_all_hq).map((u) => u.username), ['iman']);
  assert.equal((await db.query("SELECT count(*)::int AS n FROM users WHERE display_name = 'Dr Aisyah'")).rows[0].n, 0);
  const owners = (await db.query('SELECT DISTINCT owner_name FROM hq_measures')).rows.map((r) => r.owner_name).sort();
  assert.deepEqual(owners, ['Alia', 'Azwani', 'Dr Aisyah', 'Fariz', 'Hanin', 'Iman', 'Syarafana']);
});

test('HQ team: each enters their own; Iman can fill in for everyone; Yes/No and zero targets work', async () => {
  const set = (u, v) => db.query('UPDATE users SET password_hash = $1 WHERE username = $2', [bcrypt.hashSync(v, 4), u]);
  await set('syarafana', 'syarafana-1'); await set('iman', 'iman-pass-1'); await set('azwani', 'azwani-pass1');
  const ids = Object.fromEntries((await db.query('SELECT code, id FROM hq_measures')).rows.map((r) => [r.code, r.id]));
  const entry = async (code, week = THIS) => (await db.query('SELECT value, total FROM hq_entries WHERE hq_measure_id = $1 AND week_start = $2', [ids[code], week])).rows[0];

  const sy = await session('/login/password', { username: 'syarafana', password: 'syarafana-1' });
  await sy.post('/hq', { week: THIS, [`v[m${ids.slow}]`]: '50', [`v[m${ids.turn}]`]: '80' });
  assert.equal(Number((await entry('slow')).value), 50);
  assert.equal(await entry('turn'), undefined, 'Syarafana can’t enter Alia’s turnover');

  const im = await session('/login/password', { username: 'iman', password: 'iman-pass-1' });
  await im.post('/hq', { week: THIS, [`v[m${ids.po1h}]`]: '4', [`t[m${ids.po1h}]`]: '5', [`v[m${ids.ready}]`]: 'yes', [`v[m${ids.sessions}]`]: '2' });
  assert.equal(Number((await entry('po1h')).total), 5, 'Iman fills in Fariz’s numbers');
  assert.equal(Number((await entry('ready')).value), 1);
  assert.equal(Number((await entry('sessions')).value), 2);

  const az = await session('/login/password', { username: 'azwani', password: 'azwani-pass1' });
  await az.post('/hq', { week: THIS, [`v[m${ids.update}]`]: 'no', [`v[m${ids.ar30}]`]: '0', [`v[m${ids.cash}]`]: '45,000' });
  const board = await hqData.buildHqScoreboard(db, { week: THIS, trackerStart: START });
  const rows = Object.fromEntries(board.groups.flatMap((g) => g.rows).map((r) => [r.code, r]));
  assert.equal(rows.update.result.status, 'off_track', 'No = off track');
  assert.equal(rows.ready.result.status, 'on_track', 'Yes = on track');
  assert.equal(rows.ar30.result.status, 'on_track', 'RM 0 over 30 days is on target');
  assert.equal(rows.cash.result.status, 'track_only');
  assert.equal(hqData.show(rows.update, 0), 'No');
  const html = (await im.get(`/hq/scoreboard?week=${THIS}`)).html;
  assert.match(html, /Syarafana/);
  assert.match(html, /Fariz/);
  assert.match(html, /4 of 5/);
});

test('an older database gets the new HQ people and measures on start, without touching edits', async () => {
  const { backfillHqTeam } = require('../../src/db/setup');
  const old = await createDb({ url: '', localDir: 'memory' });
  await migrate(old);
  const seed = readSeed();
  // Load the seed as it was before 15 Oct: Alia and Hanin only.
  const before = { ...seed, hq: { owners: seed.hq.owners.filter((o) => ['Alia', 'Hanin'].includes(o.name)), measures: seed.hq.measures.filter((m) => ['Alia', 'Hanin'].includes(m.owner)) } };
  await loadSeed(old, before, { adminPassword: 'admin-pass-1' });
  await old.query("UPDATE hq_measure_targets SET target = 90 WHERE month = '2026-10' AND hq_measure_id = (SELECT id FROM hq_measures WHERE code = 'turn')");
  const logs = [];
  await backfillHqTeam(old, seed, (m) => logs.push(m));
  assert.match(logs.join(' '), /Syarafana/);
  assert.equal((await old.query('SELECT count(*)::int AS n FROM hq_measures')).rows[0].n, seed.hq.measures.length);
  assert.equal(Number((await old.query("SELECT target FROM hq_measure_targets t JOIN hq_measures m ON m.id = t.hq_measure_id WHERE m.code = 'turn' AND month = '2026-10'")).rows[0].target), 90);
  assert.equal((await old.query("SELECT enters_all_hq FROM users WHERE username = 'iman'")).rows[0].enters_all_hq, true);
  await backfillHqTeam(old, seed, (m) => logs.push(m));
  assert.equal((await old.query("SELECT count(*)::int AS n FROM people WHERE name = 'Fariz'")).rows[0].n, 1, 'runs once');
  await old.close();
});
