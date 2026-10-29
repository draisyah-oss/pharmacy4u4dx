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
});
test.after(async () => { await db.close(); });

const row = (b, code) => [...b.top, ...b.groups.flatMap((g) => g.rows)].find((r) => r.code === code);

test('seed.json is still valid and JH has the new measures and fields', async () => {
  assert.deepEqual(validateSeed(readSeed()).errors, []);
  const b = readSeed().branches.find((x) => x.code === 'JH');
  const codes = b.measures.map((m) => m.id);
  assert.ok(codes.includes('T5'));
  for (const c of ['T6', 'T7', 'F7', 'F9', 'Y0', 'N4']) assert.ok(!codes.includes(c), `${c} removed 28 Oct (no target)`);
  assert.ok(!codes.includes('N5'), '22 Oct: WhatsApp days to fulfil removed');
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
  assert.equal(row(board, 'Y1').monthTarget, 4);
  assert.equal(row(board, 'N1').monthTarget, 15);
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
  assert.ok(wmFields.includes('chronic'));
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
  // 18 Oct: the branch WIG moved back to Tuesday (HQ WIG and the managers' update stay on Monday) – see wig.test.js.
  assert.match(JSON.stringify(readSeed()), /branch Tuesday/);
  await old.close();
});

test('22 Oct: JH tracker numbers (12–21 Oct) imported once – empty boxes only, sheet fields left alone', async () => {
  const { importDailyOnce } = require('../../src/db/setup');
  const db2 = await createDb({ url: '', localDir: 'memory' });
  await migrate(db2);
  await loadSeed(db2, readSeed(), { adminPassword: 'admin-pass-1' });
  const jh = (await db2.query("SELECT id FROM branches WHERE code = 'JH'")).rows[0].id;
  // Something already typed in the app is kept
  await db2.query("INSERT INTO daily_entries (branch_id, entry_date, field_key, value) VALUES ($1, '2026-10-13', 'reviews', 9)", [jh]);
  const logs = [];
  await importDailyOnce(db2, 'jh-tracker-2026-10-21.json', 'import_jh_tracker_20261021', (m) => logs.push(m));
  const v = async (d, k) => { const r = (await db2.query('SELECT value FROM daily_entries WHERE branch_id = $1 AND entry_date = $2 AND field_key = $3', [jh, d, k])).rows[0]; return r ? Number(r.value) : null; };
  assert.equal(await v('2026-10-12', 'two'), 27, '59 transactions × 46.43% with 3+ items');
  assert.equal(await v('2026-10-18', 'ttfol'), 8);
  assert.equal(await v('2026-10-13', 'zkrm'), null, '28 Oct: the zakat claims RM box is gone, so it isn’t imported');
  assert.equal(await v('2026-10-13', 'reviews'), 9, 'the app’s number is kept');
  assert.equal(await v('2026-10-12', 'walkin'), null, 'walk-in comes from the sales sheet, not the tracker');
  assert.match(logs.join(' '), /differ/);
  const again = [];
  await importDailyOnce(db2, 'jh-tracker-2026-10-21.json', 'import_jh_tracker_20261021', (m) => again.push(m));
  assert.equal(again.length, 0, 'only once');
  await db2.close();
});

test('22 Oct: WM TikTok retired once on older databases; TikTok no longer in WM sales', async () => {
  const { wmTiktokOffOnce } = require('../../src/db/setup');
  const old = await createDb({ url: '', localDir: 'memory' });
  await migrate(old);
  await loadSeed(old, require('../fixtures/seed-before-wm-16oct.json'), { adminPassword: 'admin-pass-1' });
  await old.query("DELETE FROM app_settings WHERE key = 'wm_tiktok_off_v1'");
  await wmTiktokOffOnce(old, () => {});
  const q = async (sql) => (await old.query(sql)).rows;
  assert.deepEqual(await q("SELECT m.code FROM measures m JOIN branches b ON b.id = m.branch_id WHERE b.code = 'WM' AND m.active AND m.code IN ('Z3', 'Z7')"), []);
  assert.deepEqual(await q("SELECT f.key FROM daily_fields f JOIN branches b ON b.id = f.branch_id WHERE b.code = 'WM' AND f.active AND f.key IN ('tt', 'ttship')"), []);
  const b = (await q("SELECT total_sales_fields, online_sales_fields FROM branches WHERE code = 'WM'"))[0];
  assert.ok(!b.total_sales_fields.includes('tt') && !b.online_sales_fields.includes('tt'));
  assert.ok((await q("SELECT 1 FROM measures m JOIN branches b ON b.id = m.branch_id WHERE b.code = 'JH' AND m.active AND m.label ILIKE '%tiktok%'")).length > 0, 'JH keeps TikTok');
  await old.close();
});

test('22 Oct: WM walk-in target raised by ~RM 65/day once (old targets only); month totals unchanged', async () => {
  const { wmWalkinUpOnce } = require('../../src/db/setup');
  const old = await createDb({ url: '', localDir: 'memory' });
  await migrate(old);
  await loadSeed(old, require('../fixtures/seed-before-wm-16oct.json'), { adminPassword: 'admin-pass-1' });
  const t1 = (await old.query("SELECT m.id FROM measures m JOIN branches b ON b.id = m.branch_id WHERE b.code = 'WM' AND m.code = 'T1'")).rows[0].id;
  await old.query("UPDATE measure_targets SET target = 1950 WHERE measure_id = $1 AND month = '2026-11'", [t1]); // edited in Admin – kept
  await old.query("DELETE FROM app_settings WHERE key = 'wm_walkin_up_v1'");
  await wmWalkinUpOnce(old, readSeed(), () => {});
  const t = Object.fromEntries((await old.query('SELECT month, target FROM measure_targets WHERE measure_id = $1', [t1])).rows.map((r) => [r.month, Number(r.target)]));
  assert.deepEqual([t['2026-10'], t['2026-11'], t['2026-12']], [1795, 1950, 2165]);
  const m = (await old.query("SELECT month, total_sales_target FROM branch_month_targets bt JOIN branches b ON b.id = bt.branch_id WHERE b.code = 'WM' ORDER BY month")).rows.map((r) => Number(r.total_sales_target));
  assert.deepEqual(m, [60900, 73000, 85000]);
  await old.close();
});

test('22 Oct: JH no longer has "Grab menu items added/fixed" (N3); other branches keep theirs', async () => {
  const { retireBranchItemsOnce } = require('../../src/db/setup');
  const old = await createDb({ url: '', localDir: 'memory' });
  await migrate(old);
  await loadSeed(old, require('../fixtures/seed-before-wm-16oct.json'), { adminPassword: 'admin-pass-1' });
  await old.query("DELETE FROM app_settings WHERE key = 'jh_grabmenu_off_v1'");
  await retireBranchItemsOnce(old, 'JH', { fields: ['grabmenu'], measures: ['N3'] }, 'jh_grabmenu_off_v1', 'test', () => {});
  const active = async (code) => (await old.query("SELECT f.active FROM daily_fields f JOIN branches b ON b.id = f.branch_id WHERE b.code = $1 AND f.key = 'grabmenu'", [code])).rows[0].active;
  assert.equal(await active('JH'), false);
  assert.equal(await active('BR'), true);
  assert.ok(!readSeed().branches.find((b) => b.code === 'JH').daily_fields.some((f) => f.key === 'grabmenu'));
  await old.close();
});

test('22 Oct: Ampang target product Oat → Eldon strip; JH WhatsApp is customer follow-ups only', async () => {
  const s = readSeed();
  const amp = s.branches.find((b) => b.code === 'Ampang');
  assert.ok(!amp.measures.some((m) => m.label === 'Target product: Oat')); // 29 Oct: Eldon strip itself came off Ampang's list too
  assert.ok(s.branches.find((b) => b.code === 'WM').measures.some((m) => m.label === 'Target product: Oat'), 'other branches keep Oat');
  const jh = s.branches.find((b) => b.code === 'JH');
  assert.equal(jh.daily_fields.find((f) => f.key === 'fu').label, 'WhatsApp customer follow-ups');
  assert.ok(!jh.daily_fields.some((f) => f.key === 'waord' || f.key === 'wadays'));
});

test('22 Oct: every branch tracks Grab active inventory % (above 50%) instead of Grab menu items', async () => {
  const s = readSeed();
  const owners = { WM: 'Zawiyah', JH: 'Nabihah', BR: 'Aqilah', Bangi: 'Siti', Ampang: 'Aishah' }; // 27 Oct: Siti took Bangi's Grab
  for (const b of s.branches) {
    const f = b.daily_fields.find((x) => x.key === 'grabinv');
    const m = b.measures.find((x) => x.id === 'GI');
    assert.equal(f.type, 'percent', b.code);
    assert.equal(m.calc, 'average_percent');
    assert.equal(m.owner, owners[b.code]);
    assert.deepEqual(Object.values(m.targets), [0.5, 0.5, 0.5]);
    assert.ok(!b.daily_fields.some((x) => x.key === 'grabmenu'), b.code);
  }
  // Average of the days typed (45, 55, 62 → 54%), blank days don't count; shown as a %.
  const put = (date, value) => db.query('INSERT INTO daily_entries (branch_id, entry_date, field_key, value) VALUES ($1,$2,$3,$4)', [jh.id, date, 'grabinv', value]);
  await put('2026-10-12', 45); await put('2026-10-14', 55); await put('2026-10-16', 62);
  const board = await buildScoreboard(db, { branch: jh, weekStart: START, today: '2026-10-19', trackerStart: START });
  const gi = row(board, 'GI');
  near(gi.week.actual, 0.54); near(gi.week.target, 0.5);
  assert.equal(gi.week.status, 'on_track');
  const fmt = require('../../src/scoreboard/format');
  assert.equal(fmt.value(gi, gi.week.actual), '54%');
});

test('22 Oct: a % box refuses more than 100', async () => {
  const { saveDailyEntries } = require('../../src/daily/data');
  const user = (await db.query("SELECT u.*, p.name FROM users u LEFT JOIN people p ON p.id = u.person_id WHERE u.role = 'admin' LIMIT 1")).rows[0];
  const r = await saveDailyEntries(db, { branch: jh, date: '2026-10-20', user, input: { grabinv: '140' } });
  assert.ok(r.errors && r.errors.grabinv, 'over 100 refused');
});

test('22 Oct: older databases swap Grab menu items for Grab active inventory % once', async () => {
  const { grabInventoryOnce } = require('../../src/db/setup');
  const old = await createDb({ url: '', localDir: 'memory' });
  await migrate(old);
  await loadSeed(old, require('../fixtures/seed-before-wm-16oct.json'), { adminPassword: 'admin-pass-1' });
  await old.query("DELETE FROM app_settings WHERE key = 'ampang_aishah_v1'");
  await renameBranchPersonOnce(old, 'Ampang', 'Aisyah', 'Aishah', 'ampang_aishah_v1', () => {}); // runs earlier on start
  await grabInventoryOnce(old, readSeed(), () => {});
  await grabInventoryOnce(old, readSeed(), () => {}); // second run does nothing
  const q = async (sql) => (await old.query(sql)).rows;
  const gi = await q("SELECT b.code, m.calc, m.active, m.person_id FROM measures m JOIN branches b ON b.id = m.branch_id WHERE m.code = 'GI' ORDER BY b.code");
  assert.deepEqual(gi.map((r) => r.code), ['Ampang', 'BR', 'Bangi', 'JH', 'WM']);
  assert.ok(gi.every((r) => r.active && r.calc === 'average_percent' && (r.person_id || ['Bangi', 'BR'].includes(r.code))), 'Bangi’s Siti and BR’s Aqilah are added later (bangiOct27Once, brOct29Once)');
  const oldOn = await q("SELECT count(*)::int AS n FROM measures WHERE numerator_field = 'grabmenu' AND active");
  assert.equal(oldOn[0].n, 0);
  const t = await q("SELECT t.month, t.target FROM measure_targets t JOIN measures m ON m.id = t.measure_id JOIN branches b ON b.id = m.branch_id WHERE b.code = 'WM' AND m.code = 'GI' AND t.month = '2026-10'");
  assert.equal(Number(t[0].target), 0.5);
  await old.close();
});

test('27 Oct: Bangi – Siti on Grab, Androchi / Canberra, neuropathy lead moved to BR (Amirah)', async () => {
  const s = readSeed();
  const bangi = s.branches.find((b) => b.code === 'Bangi');
  const br = s.branches.find((b) => b.code === 'BR');
  assert.ok(bangi.people.some((p) => p.name === 'Siti'));
  assert.ok(bangi.measures.some((m) => m.label === 'Target product: Androchi'));
  assert.ok(bangi.measures.some((m) => m.label === 'Target product: Canberra'));
  assert.ok(!bangi.measures.some((m) => m.numerator_field === 'neuro'));
  assert.equal(br.measures.find((m) => m.id === 'NP').owner, 'Amirah');
  // An older database gets it once
  const { bangiOct27Once } = require('../../src/db/setup');
  const old = await createDb({ url: '', localDir: 'memory' });
  await migrate(old);
  await loadSeed(old, require('../fixtures/seed-before-wm-16oct.json'), { adminPassword: 'admin-pass-1' });
  await old.query("UPDATE daily_fields SET owner_name = 'Ayuni' WHERE key IN ('grabon', 'grab', 'graord') AND branch_id = (SELECT id FROM branches WHERE code = 'Bangi')");
  await bangiOct27Once(old, s, () => {});
  await bangiOct27Once(old, s, () => {});
  const q = async (sql) => (await old.query(sql)).rows;
  const siti = await q("SELECT p.id FROM people p JOIN branches b ON b.id = p.branch_id WHERE b.code = 'Bangi' AND p.name = 'Siti'");
  assert.equal(siti.length, 1);
  assert.ok((await q("SELECT username FROM users WHERE person_id = " + siti[0].id)).length, 'Siti has a login');
  const grab = await q("SELECT f.owner_name, f.person_id FROM daily_fields f JOIN branches b ON b.id = f.branch_id WHERE b.code = 'Bangi' AND f.key = 'grabon'");
  assert.equal(grab[0].owner_name, 'Siti'); assert.equal(grab[0].person_id, siti[0].id);
  const labels = (await q("SELECT m.label FROM measures m JOIN branches b ON b.id = m.branch_id WHERE b.code = 'Bangi' AND m.active")).map((r) => r.label);
  assert.ok(labels.includes('Target product: Androchi') && labels.includes('Target product: Canberra'));
  assert.ok(!labels.includes('New neuropathy customers'));
  const np = await q("SELECT m.owner_name, m.person_id, t.target FROM measures m JOIN branches b ON b.id = m.branch_id JOIN measure_targets t ON t.measure_id = m.id WHERE b.code = 'BR' AND m.code = 'NP' AND t.month = '2026-11'");
  assert.equal(np[0].owner_name, 'Amirah'); assert.ok(np[0].person_id); assert.equal(Number(np[0].target), 1);
  assert.equal((await q("SELECT count(*)::int AS n FROM daily_fields f JOIN branches b ON b.id = f.branch_id WHERE b.code = 'BR' AND f.key = 'neuro' AND f.active"))[0].n, 1);
  await old.close();
});

test('29 Oct: BR 4DX adjustment – an older database ends up the same as a fresh one, history kept', async () => {
  const { brOct29Once } = require('../../src/db/setup');
  const s = readSeed();
  const sb = s.branches.find((b) => b.code === 'BR');
  const old = await createDb({ url: '', localDir: 'memory' });
  await migrate(old);
  await loadSeed(old, require('../fixtures/seed-before-br-29oct.json'), { adminPassword: 'admin-pass-1' });
  const q = async (sql, args) => (await old.query(sql, args)).rows;
  const br = (await q("SELECT id FROM branches WHERE code = 'BR'"))[0].id;
  await old.query("INSERT INTO daily_entries (branch_id, entry_date, field_key, value) VALUES ($1, '2026-10-20', 'pwp', 4), ($1, '2026-10-20', 'p3', 2)", [br]);
  await brOct29Once(old, s, () => {});
  await brOct29Once(old, s, () => {}); // second run does nothing
  // People: Qushairi can no longer log in, Aqilah has a staff login (PIN set in Admin → People)
  const people = await q('SELECT p.name, p.active, u.active AS login, u.role FROM people p LEFT JOIN users u ON u.person_id = p.id WHERE p.branch_id = $1 ORDER BY p.name', [br]);
  assert.deepEqual(people.find((p) => p.name === 'Qushairi'), { name: 'Qushairi', active: false, login: false, role: 'branch_staff' });
  assert.deepEqual(people.filter((p) => p.name === 'Aqilah'), [{ name: 'Aqilah', active: true, login: true, role: 'branch_staff' }]);
  // Same boxes and measures as a fresh database, with the same owners
  const fields = await q('SELECT key, label, owner_name, person_id FROM daily_fields WHERE branch_id = $1 AND active', [br]);
  assert.deepEqual(fields.map((f) => f.key).sort(), sb.daily_fields.map((f) => f.key).sort());
  for (const f of sb.daily_fields) {
    const got = fields.find((x) => x.key === f.key);
    assert.equal(got.owner_name, f.owner, f.key);
    if (f.owner !== 'Team') assert.ok(got.person_id, `${f.key} linked to ${f.owner}`);
  }
  const measures = await q('SELECT code, label, owner_name, target_per, high_days FROM measures WHERE branch_id = $1 AND active', [br]);
  assert.deepEqual(measures.map((m) => m.code).sort(), sb.measures.map((m) => m.id).sort());
  for (const m of sb.measures) {
    const got = measures.find((x) => x.code === m.id);
    assert.equal(got.owner_name, m.owner, m.id);
    assert.equal(got.target_per, m.target_per, m.id);
  }
  const target = async (code, month) => (await q(`SELECT t.target::float, t.weekend_target::float FROM measure_targets t JOIN measures m ON m.id = t.measure_id
    WHERE m.branch_id = $1 AND m.code = $2 AND t.month = $3`, [br, code, month]))[0];
  assert.deepEqual(await target('T1', '2026-12'), { target: 1250, weekend_target: 1650 });
  assert.equal(measures.find((m) => m.code === 'T1').high_days, 'Sun,Mon');
  assert.deepEqual((await q("SELECT code FROM measures WHERE branch_id = $1 AND score_by = 'month' ORDER BY code", [br])).map((r) => r.code), ['A5', 'AL', 'G0']);
  assert.deepEqual(await target('N1', '2026-11'), { target: 6, weekend_target: null });
  assert.deepEqual(await target('T4', '2026-11'), { target: 20, weekend_target: null });
  assert.deepEqual(await target('G0', '2026-12'), { target: 1500, weekend_target: null });
  assert.deepEqual(await target('P9', '2026-11'), { target: 0.5, weekend_target: null });
  assert.equal(Number((await q("SELECT end_target FROM running_totals WHERE branch_id = $1 AND code = 'GR'", [br]))[0].end_target), 200);
  // History of the removed boxes is kept
  assert.equal((await q("SELECT 1 FROM daily_entries WHERE branch_id = $1 AND field_key IN ('pwp', 'p3')", [br])).length, 2);
  // The scoreboard uses the new walk-in days: week of 2 Nov = 5 × 1,250 + Sun 8 + Mon 2 Nov at 1,650
  const branch = await loadBranch(old, 'BR');
  const board = await buildScoreboard(old, { branch, weekStart: '2026-11-02', today: '2026-11-09', trackerStart: '2026-10-12' });
  const t1 = [...board.top, ...board.groups.flatMap((g) => g.rows)].find((r) => r.code === 'T1');
  assert.equal(t1.week.target, 9550);
  assert.equal(t1.highDays, 'Sun,Mon');
  await old.close();
});

test('29 Oct: Ampang target products – an older database ends up the same as a fresh one, history kept', async () => {
  const { ampangOct29Once } = require('../../src/db/setup');
  const s = readSeed();
  const sb = s.branches.find((b) => b.code === 'Ampang');
  const products = sb.measures.filter((m) => /^(T2|P\d)$/.test(m.id)).map((m) => [m.label, m.targets['2026-11']]);
  assert.deepEqual(products, [['PWP units sold', 5], ['Target product: Proponeem / Neem facial', 2], ['Target product: Biorelief / Biopropolis', 2],
    ['Target product: Beecrobes', 2], ['Target product: Loose supplements', 2], ['Target product: Short-expiry products', 2]]);
  const old = await createDb({ url: '', localDir: 'memory' });
  await migrate(old);
  await loadSeed(old, require('../fixtures/seed-before-br-29oct.json'), { adminPassword: 'admin-pass-1' });
  const q = async (sql, args) => (await old.query(sql, args)).rows;
  const id = (await q("SELECT id FROM branches WHERE code = 'Ampang'"))[0].id;
  await old.query("INSERT INTO daily_entries (branch_id, entry_date, field_key, value) VALUES ($1, '2026-10-20', 'p3', 1)", [id]);
  await ampangOct29Once(old, s, () => {});
  await ampangOct29Once(old, s, () => {});
  const fields = await q('SELECT key, label FROM daily_fields WHERE branch_id = $1 AND active', [id]);
  assert.deepEqual(fields.map((f) => f.key).sort(), sb.daily_fields.map((f) => f.key).sort());
  const measures = await q('SELECT code, label FROM measures WHERE branch_id = $1 AND active', [id]);
  assert.deepEqual(measures.map((m) => m.code).sort(), sb.measures.map((m) => m.id).sort());
  for (const m of sb.measures) assert.equal(measures.find((x) => x.code === m.id).label, m.label);
  assert.equal((await q("SELECT 1 FROM daily_entries WHERE branch_id = $1 AND field_key = 'p3'", [id])).length, 1, 'Eldon strip history kept');
  await old.close();
});
