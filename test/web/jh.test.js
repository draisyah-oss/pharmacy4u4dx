// JH's own tracker notes (15 Oct): PWP pairings, 60 walk-ins, OOS log, zakat scored by month,
// RFQ approved %, RM claimed, TikTok 4 a week / 50 followers a month, LH blasting 15 a day,
// Grab cancelled orders, WhatsApp days to fulfil.

const test = require('node:test');
const assert = require('node:assert/strict');

const { createDb } = require('../../src/db');
const { migrate } = require('../../src/db/migrate');
const { readSeed, loadSeed, validateSeed } = require('../../src/db/seed');
const { loadBranch } = require('../../src/daily/data');
const { buildScoreboard } = require('../../src/scoreboard/data');
const { syncBranchFromSeed, renameBranchPersonOnce } = require('../../src/db/setup');

const START = '2026-10-12';
const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-6, `${msg || ''} expected ${b}, got ${a}`);
let db; let jh;

test.before(async () => {
  db = await createDb({ url: '', localDir: 'memory' });
  await migrate(db);
  await loadSeed(db, readSeed(), { adminPassword: 'admin-pass-1' });
  jh = await loadBranch(db, 'JH');
  const put = (date, field, value) => db.query('INSERT INTO daily_entries (branch_id, entry_date, field_key, value) VALUES ($1,$2,$3,$4)', [jh.id, date, field, value]);
  // A few days of JH numbers in the week of 12 Oct
  for (const [d, tx, zakat] of [['2026-10-12', 59, 0], ['2026-10-13', 50, 732.72], ['2026-10-14', 57, 0]]) {
    await put(d, 'tx', tx); await put(d, 'zakat', zakat);
  }
  await put('2026-10-13', 'zkrfq', 4); await put('2026-10-13', 'zkrfqok', 3);
  await put('2026-10-13', 'waord', 2); await put('2026-10-13', 'wadays', 5);
  await put('2026-10-14', 'waord', 1); await put('2026-10-14', 'wadays', 1);
});
test.after(async () => { await db.close(); });

const row = (b, code) => [...b.top, ...b.groups.flatMap((g) => g.rows)].find((r) => r.code === code);

test('seed.json is still valid and JH has the new measures and fields', async () => {
  assert.deepEqual(validateSeed(readSeed()).errors, []);
  const b = readSeed().branches.find((x) => x.code === 'JH');
  const codes = b.measures.map((m) => m.id);
  for (const c of ['T5', 'T6', 'T7', 'F9', 'N4', 'N5']) assert.ok(codes.includes(c), c);
  assert.match(b.measures.find((m) => m.id === 'P2').label, /gout/i);
  assert.ok(!b.daily_fields.some((f) => f.key === 'zkc7d'), 'the 7-day claim box is gone');
});

test('JH scoreboard: zakat scored month to date only; walk-ins vs 60 a day; RFQ % and days to fulfil', async () => {
  const board = await buildScoreboard(db, { branch: jh, weekStart: START, today: '2026-10-15', trackerStart: START });
  const f5 = row(board, 'F5');
  assert.equal(f5.week.actual, 732.72);
  assert.equal(f5.week.status, 'track_only', 'no weekly zakat target');
  assert.equal(f5.scoreBy, 'month');
  assert.notEqual(f5.mtd.status, 'track_only', 'still scored month to date');
  const t5 = row(board, 'T5');
  assert.equal(t5.week.actual, 59 + 50 + 57);
  near(t5.week.target, 180, '60 a day × 3 days');
  near(row(board, 'F9').week.actual, 0.75);
  near(row(board, 'N5').week.actual, 2, '6 days ÷ 3 orders');
  assert.equal(row(board, 'Y1').monthTarget, 4);
  assert.equal(row(board, 'N1').monthTarget, 15);
  assert.equal(row(board, 'Y0').week.status, 'track_only');
  assert.equal(row(board, 'N2').kind, 'Routine');
  const gr = board.running.find((r) => r.code === 'GR');
  assert.equal(gr.endTarget, 294);
});

test('an already-loaded database gets JH’s update once; other branches untouched', async () => {
  const old = await createDb({ url: '', localDir: 'memory' });
  await migrate(old);
  const before = JSON.parse(require('fs').readFileSync(`${__dirname}/../fixtures/seed-before-jh-15oct.json`, 'utf8'));
  await loadSeed(old, before, { adminPassword: 'admin-pass-1' });
  await old.query("DELETE FROM app_settings WHERE key = 'jh_update_v1'");
  const wmBefore = (await old.query("SELECT count(*)::int AS n FROM measures m JOIN branches b ON b.id = m.branch_id WHERE b.code = 'WM' AND m.active")).rows[0].n;
  const logs = [];
  await syncBranchFromSeed(old, readSeed(), 'JH', 'jh_update_v1', (m) => logs.push(m));
  assert.match(logs.join(' '), /JH/);
  const q = async (sql) => (await old.query(sql)).rows;
  const jhm = await q("SELECT m.code, m.label, m.score_by, m.active FROM measures m JOIN branches b ON b.id = m.branch_id WHERE b.code = 'JH'");
  const by = Object.fromEntries(jhm.map((m) => [m.code, m]));
  assert.equal(by.F5.score_by, 'month');
  assert.ok(by.T5 && by.T5.active);
  assert.match(by.P1.label, /cough/i);
  assert.equal((await q("SELECT f.active FROM daily_fields f JOIN branches b ON b.id = f.branch_id WHERE b.code = 'JH' AND f.key = 'zkc7d'"))[0].active, false, 'retired, history kept');
  const y1 = await q("SELECT t.target FROM measure_targets t JOIN measures m ON m.id = t.measure_id JOIN branches b ON b.id = m.branch_id WHERE b.code = 'JH' AND m.code = 'Y1' AND t.month = '2026-11'");
  assert.equal(Number(y1[0].target), 4);
  assert.equal((await q("SELECT end_target FROM running_totals r JOIN branches b ON b.id = r.branch_id WHERE b.code = 'JH' AND r.code = 'GR'"))[0].end_target, 294);
  assert.equal((await old.query("SELECT count(*)::int AS n FROM measures m JOIN branches b ON b.id = m.branch_id WHERE b.code = 'WM' AND m.active")).rows[0].n, wmBefore);
  // Runs once: an admin change afterwards is kept
  await old.query("UPDATE measures SET label = 'Changed in Admin' WHERE code = 'T5' AND branch_id = (SELECT id FROM branches WHERE code = 'JH')");
  await syncBranchFromSeed(old, readSeed(), 'JH', 'jh_update_v1', () => {});
  assert.equal((await q("SELECT label FROM measures WHERE code = 'T5' AND branch_id = (SELECT id FROM branches WHERE code = 'JH')"))[0].label, 'Changed in Admin');
  // Ampang's Aisyah is Aishah: name, login, owned measures/fields, labels mentioning her
  await old.query("DELETE FROM app_settings WHERE key = 'ampang_aishah_v1'");
  await renameBranchPersonOnce(old, 'Ampang', 'Aisyah', 'Aishah', 'ampang_aishah_v1', () => {});
  const amp = "(SELECT id FROM branches WHERE code = 'Ampang')";
  assert.equal((await old.query(`SELECT count(*)::int AS n FROM people WHERE branch_id = ${amp} AND name = 'Aishah'`)).rows[0].n, 1);
  assert.equal((await old.query("SELECT display_name FROM users WHERE username = 'aishah'")).rows[0].display_name, 'Aishah');
  assert.equal((await old.query(`SELECT count(*)::int AS n FROM measures WHERE branch_id = ${amp} AND (owner_name = 'Aisyah' OR label LIKE '%Aisyah%')`)).rows[0].n, 0);
  assert.equal((await old.query(`SELECT count(*)::int AS n FROM daily_fields WHERE branch_id = ${amp} AND (owner_name = 'Aisyah' OR label LIKE '%Aisyah%')`)).rows[0].n, 0);
  assert.equal((await old.query("SELECT count(*)::int AS n FROM people WHERE name = 'Dr Aisyah'")).rows[0].n, 1, 'the CEO is untouched');
  await old.close();
});

test('16 Oct: an older database gets the WM changes, 3+ items everywhere and Alia\'s zakat task once', async () => {
  const { threeItems, addHqTaskOnce } = require('../../src/db/setup');
  const old = await createDb({ url: '', localDir: 'memory' });
  await migrate(old);
  await loadSeed(old, require('../fixtures/seed-before-wm-16oct.json'), { adminPassword: 'admin-pass-1' });
  for (const k of ['wm_update_16oct', 'three_items_v1', 'alia_zakat_task_v1']) await old.query('DELETE FROM app_settings WHERE key = $1', [k]);
  await syncBranchFromSeed(old, readSeed(), 'WM', 'wm_update_16oct', () => {});
  await threeItems(old, () => {});
  await addHqTaskOnce(old, 'Alia', 'Zakat orders from the branches placed today', 'alia_zakat_task_v1', () => {});
  await addHqTaskOnce(old, 'Alia', 'Zakat orders from the branches placed today', 'alia_zakat_task_v1', () => {});
  const active = async (sql) => (await old.query(sql)).rows.map((r) => r.k);
  const wmMeasures = await active("SELECT m.code AS k FROM measures m JOIN branches b ON b.id = m.branch_id WHERE b.code = 'WM' AND m.active");
  for (const c of ['Z6', 'W6', 'W2']) assert.ok(!wmMeasures.includes(c), `${c} retired`);
  const wmFields = await active("SELECT f.key AS k FROM daily_fields f JOIN branches b ON b.id = f.branch_id WHERE b.code = 'WM' AND f.active");
  for (const k of ['ttlive', 'ttship24', 'zko', 'zko2w', 'grabon']) assert.ok(!wmFields.includes(k), `${k} retired`);
  assert.ok(wmFields.includes('ttship'));
  assert.equal((await old.query("SELECT count(*)::int AS n FROM measures WHERE label LIKE '%2+ items%'")).rows[0].n, 0);
  assert.equal((await old.query("SELECT count(*)::int AS n FROM daily_fields WHERE active AND label LIKE '%3+ items%'")).rows[0].n, 5);
  assert.equal((await old.query("SELECT count(*)::int AS n FROM branches WHERE lead_measures::text LIKE '%2+ items%'")).rows[0].n, 0);
  assert.equal((await old.query("SELECT count(*)::int AS n FROM hq_daily_tasks t JOIN people p ON p.id = t.person_id WHERE p.name = 'Alia' AND t.label LIKE 'Zakat orders%'")).rows[0].n, 1);
  await old.close();
});

test('16 Oct: WIG sessions all on Monday – older databases get the new wording once', async () => {
  const { wigOnMonday } = require('../../src/db/setup');
  const old = await createDb({ url: '', localDir: 'memory' });
  await migrate(old);
  await loadSeed(old, require('../fixtures/seed-before-wm-16oct.json'), { adminPassword: 'admin-pass-1' });
  await old.query("DELETE FROM app_settings WHERE key = 'wig_monday_v1'");
  await wigOnMonday(old, () => {});
  const txt = (await old.query("SELECT string_agg(label || ' ' || COALESCE(note, ''), ' | ') AS t FROM hq_measures")).rows[0].t
    + (await old.query("SELECT string_agg(milestone, ' | ') AS t FROM hq_projects")).rows[0].t;
  assert.doesNotMatch(txt, /Tuesday/);
  assert.match(txt, /Both WIG sessions held \(HQ and branch, both on Monday\)/);
  assert.doesNotMatch(JSON.stringify(readSeed()), /Branch WIG session 9:30|Tuesday branch/);
  await old.close();
});
