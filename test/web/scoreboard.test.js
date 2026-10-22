// Branch Scoreboard: numbers must match the calculation rules, and every number must trace
// back to the daily rows behind it. Uses the sample WM week (12–18 Oct); "today" is 20 Oct.

const test = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');

const { createDb } = require('../../src/db');
const { migrate } = require('../../src/db/migrate');
const { readSeed, loadSeed } = require('../../src/db/seed');
const { createApp } = require('../../src/app');
const { loadBranch } = require('../../src/daily/data');
const sb = require('../../src/scoreboard/data');
const { WM_WEEK, WEEK_DATES } = require('../fixtures/sample-weeks');

const TODAY = '2026-10-20';
const START = '2026-10-12';
let db; let server; let base; let wm;
const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-6, `${msg || ''} expected ${b}, got ${a}`);

test.before(async () => {
  db = await createDb({ url: '', localDir: 'memory' });
  await migrate(db);
  await loadSeed(db, readSeed(), { adminPassword: 'admin-pass-1' });
  wm = await loadBranch(db, 'WM');
  for (const [field, values] of Object.entries(WM_WEEK)) {
    for (let i = 0; i < 7; i++) {
      await db.query('INSERT INTO daily_entries (branch_id, entry_date, field_key, value) VALUES ($1,$2,$3,$4)',
        [wm.id, WEEK_DATES[i], field, values[i]]);
    }
  }
  const set = (u, col, v) => db.query(`UPDATE users SET ${col} = $1 WHERE username = $2`, [bcrypt.hashSync(v, 4), u]);
  await set('hafizah', 'password_hash', 'manager-pass-1');
  await set('afifah', 'password_hash', 'manager-pass-2');
  await set('alia', 'password_hash', 'hq-pass-123');
  await set('hazera', 'pin_hash', '1111');
  server = createApp(db, { now: () => new Date(`${TODAY}T21:00:00+08:00`) }).listen(0);
  base = `http://localhost:${server.address().port}`;
});
test.after(async () => { server.close(); await db.close(); });

async function login(form, path = '/login/password') {
  const res = await fetch(base + path, {
    method: 'POST', redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(form).toString(),
  });
  const cookie = res.headers.get('set-cookie').split(';')[0];
  return async (p) => {
    const r = await fetch(base + p, { headers: { cookie }, redirect: 'manual' });
    return { status: r.status, html: await r.text() };
  };
}
const board = (weekStart = START) => sb.buildScoreboard(db, { branch: wm, weekStart, today: TODAY, trackerStart: START });
const row = (b, code) => [...b.top, ...b.groups.flatMap((g) => g.rows)].find((r) => r.code === code);

// ───────────── Numbers ─────────────

test('weeks to choose from: 12 Oct and 19 Oct (this week)', () => {
  assert.deepEqual(sb.weekList(START, TODAY), ['2026-10-12', '2026-10-19']);
});

test('sample week matches the calculation tests', async () => {
  const b = await board();
  assert.equal(b.asOf, '2026-10-18'); // finished week: Monday to Sunday
  const t1 = row(b, 'T1');
  assert.equal(t1.week.actual, 12365);
  near(t1.week.target, 12110);
  assert.equal(t1.week.status, 'on_track');
  const l3 = row(b, 'L3');
  near(l3.week.actual, 179 / 408);
  assert.equal(l3.week.status, 'watch');
  assert.equal(row(b, 'F1').week.status, 'off_track');
  assert.equal(row(b, 'Z2').week.actual, 18);
  near(row(b, 'W5').week.target, 140000 / 31);
  // October MTD counts from 12 Oct, so it equals the week here
  near(row(b, 'T1').mtd.target, 12110);
});

test('WIG and the branch\'s leads go on top; the rest is grouped by person', async () => {
  const b = await board();
  assert.deepEqual(b.top.map((r) => r.code), ['T1', 'L3', 'F1', 'Z2']);
  assert.deepEqual(b.groups.map((g) => g.owner), ['Team', 'Hazera', 'Zawiyah']);
  const all = [...b.top, ...b.groups.flatMap((g) => g.rows)].map((r) => r.code);
  assert.equal(all.length, new Set(all).size, 'no measure appears twice');
  assert.equal(all.length, readSeed().branches[0].measures.length, 'every measure appears');
});

test('running totals: chronic database 18 of 200, Google reviews 143 of 159', async () => {
  const b = await board();
  const cr = b.running.find((r) => r.code === 'CR');
  assert.equal(cr.total, 18);
  assert.equal(cr.endTarget, 200);
  assert.equal(cr.endDate, '2026-12-31');
  assert.equal(cr.onPace, true);
  assert.equal(b.running.find((r) => r.code === 'GR').total, 143);
});

test('branch sales: week RM 16,365, October so far RM 36,265, RM 1,895 a day needed', async () => {
  const s = (await board()).sales;
  assert.equal(s.weekTotal, 16365);
  assert.equal(s.mtd, 36265);
  near(s.perDay, 24635 / 13);
  near(s.paceTarget, 60900 * 18 / 31);  // RM 35,361 needed by 18 Oct
  assert.equal(s.status, 'on_track');    // ahead of pace even though only 60% of the month
});

test('this week counts only closed days: yesterday until today\'s numbers are in', async () => {
  await db.query('INSERT INTO daily_entries (branch_id, entry_date, field_key, value) VALUES ($1, $2, $3, $4)', [wm.id, '2026-10-19', 'walkin', 1900]);
  let b = await board('2026-10-19');
  assert.equal(b.asOf, '2026-10-19');
  near(row(b, 'T1').week.target, 1730); // one day, not seven
  await db.query('INSERT INTO daily_entries (branch_id, entry_date, field_key, value) VALUES ($1, $2, $3, $4)', [wm.id, TODAY, 'walkin', 1600]);
  b = await board('2026-10-19');
  assert.equal(b.asOf, TODAY);
  assert.equal(row(b, 'T1').week.actual, 3500);
  await db.query("DELETE FROM daily_entries WHERE branch_id = $1 AND entry_date >= '2026-10-19'", [wm.id]);
});

// ───────────── Traceability ─────────────

test('every measure\'s week and MTD number equals the total of its daily rows', async () => {
  const b = await board();
  for (const r of [...b.top, ...b.groups.flatMap((g) => g.rows)]) {
    for (const [from, key] of [[b.weekStart, 'week'], [b.mtdFrom, 'mtd']]) {
      const t = await sb.traceMeasure(db, { branch: wm, code: r.code, from, to: b.asOf, trackerStart: START });
      assert.equal(t.result.actual, r[key].actual, `${r.code} ${key}`);
      assert.equal(t.result.target, r[key].target, `${r.code} ${key} target`);
      if (t.calc === 'sum') {
        const sum = t.days.reduce((a, d) => a + (d.numerator || 0), 0);
        assert.equal(sum, r[key].actual, `${r.code} ${key}: rows add up`);
      }
    }
  }
});

test('sales trace: daily totals plus the 1–11 Oct figure add up to the MTD number', async () => {
  const b = await board();
  const t = await sb.traceSales(db, { branch: wm, from: b.mtdFrom, to: b.asOf, trackerStart: START });
  assert.equal(t.before, 19900);
  assert.equal(t.days.reduce((a, d) => a + d.total, 0) + t.before, b.sales.mtd);
  assert.equal(t.days.length, 7); // 12–18 Oct; earlier days are the before-tracker figure
});

test('running total trace starts at the start value and ends at the total', async () => {
  const t = await sb.traceRunning(db, { branch: wm, code: 'GR', to: '2026-10-18' });
  assert.equal(t.start, 140);
  assert.equal(t.days[t.days.length - 1].total, 143);
});

// ───────────── Screen and access ─────────────

test('manager sees the scoreboard with clickable numbers', async () => {
  const get = await login({ username: 'hafizah', password: 'manager-pass-1' });
  const r = await get('/scoreboard?week=2026-10-12');
  assert.equal(r.status, 200);
  assert.match(r.html, /RM 12,365/);
  assert.match(r.html, /of RM 12,110/);
  assert.match(r.html, /102%/);
  assert.match(r.html, /href="\/scoreboard\/trace\?type=measure&amp;code=T1&amp;from=2026-10-12&amp;to=2026-10-18"/);
  assert.match(r.html, /WIG and lead measures/);
  assert.match(r.html, /Chronic database total/);
});

test('clicking a number: the trace comes back as a fragment, or a full page without JavaScript', async () => {
  const get = await login({ username: 'hafizah', password: 'manager-pass-1' });
  const q = '/scoreboard/trace?type=measure&code=L3&from=2026-10-12&to=2026-10-18';
  const frag = await get(`${q}&partial=1`);
  assert.equal(frag.status, 200);
  assert.doesNotMatch(frag.html, /<html/);
  assert.match(frag.html, /179 ÷ 408 = <b>43.9%<\/b>/);
  assert.match(frag.html, /href="\/daily\?date=2026-10-13"/); // jump to that day's entry
  const page = await get(q);
  assert.match(page.html, /<html/);
  assert.match(page.html, /Back to scoreboard/);
  assert.equal((await get('/scoreboard/trace?type=measure&code=NOPE&from=2026-10-12&to=2026-10-18')).status, 404);
  assert.equal((await get('/scoreboard/trace?type=measure&code=T1&from=2026-10-18&to=2026-10-12')).status, 400);
});

test('managers only see their own branch; staff see their own; HQ sees any branch', async () => {
  const jh = await login({ username: 'afifah', password: 'manager-pass-2' });
  const own = await jh('/scoreboard?branch=WM');
  assert.match(own.html, /Jenderam Hilir/);
  assert.doesNotMatch(own.html, /RM 12,365/);
  assert.equal((await jh('/scoreboard/trace?type=measure&code=T1&from=2026-10-12&to=2026-10-18&branch=WM')).html.includes('12,365'), false);

  const staff = await login({ username: 'hazera', pin: '1111' }, '/login/pin');
  // 19 Oct: staff see their own branch's scoreboard (read only), never another branch's
  assert.equal((await staff('/scoreboard')).status, 200);
  assert.doesNotMatch((await staff('/scoreboard?branch=JH')).html, /Jenderam Hilir/);

  const hq = await login({ username: 'alia', password: 'hq-pass-123' });
  const r = await hq('/scoreboard?branch=WM&week=2026-10-12');
  assert.equal(r.status, 200);
  assert.match(r.html, /RM 12,365/);
});
