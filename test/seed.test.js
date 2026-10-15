// Tests for the database tables and the seed loader.
// Each test uses a fresh in-memory database, so nothing on disk is touched.

const test = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');

const { createDb } = require('../src/db');
const { migrate } = require('../src/db/migrate');
const { readSeed, validateSeed, loadSeed, isSeeded, makeUsernames } = require('../src/db/seed');

const ADMIN_PASSWORD = 'test-admin-pw';
const clone = (x) => JSON.parse(JSON.stringify(x));

async function freshDb() {
  const db = await createDb({ url: '', localDir: 'memory' });
  await migrate(db);
  return db;
}

test('seed.json passes validation', () => {
  const { errors } = validateSeed(readSeed());
  assert.deepEqual(errors, []);
});

test('validation catches a measure pointing at a field that does not exist', () => {
  const seed = clone(readSeed());
  seed.branches[0].measures[0].numerator_field = 'walkn';
  const { errors } = validateSeed(seed);
  assert.ok(errors.some((e) => e.includes('"walkn"')), errors.join('\n'));
});

test('validation: weekend targets only on daily sum measures', () => {
  const seed = clone(readSeed());
  seed.branches[0].measures.find((m) => m.target_per === 'week').weekend_targets = { '2026-10': 5 };
  assert.ok(validateSeed(seed).errors.some((e) => e.includes('weekend_targets only work')));
});

test('validation catches a ratio measure with no denominator', () => {
  const seed = clone(readSeed());
  const ratio = seed.branches[0].measures.find((m) => m.calc === 'ratio_percent');
  ratio.denominator_field = null;
  assert.ok(validateSeed(seed).errors.some((e) => e.includes('needs a denominator_field')));
});

test('validation rejects anything about salaries', () => {
  const seed = clone(readSeed());
  seed.branches[0].people[0].salary = 3000;
  assert.ok(validateSeed(seed).errors.some((e) => e.includes('salaries')));
});

test('people answers from 14 Oct are in seed.json', () => {
  const seed = readSeed();
  const byCode = Object.fromEntries(seed.branches.map((b) => [b.code, b]));
  const names = (code) => byCode[code].people.map((p) => p.name);

  assert.ok(names('Ampang').includes('Hidayah'));
  assert.ok(!names('Ampang').includes('Yaya'));
  assert.ok(!names('Ampang').includes('Ayuni'));
  assert.ok(names('JH').includes('Yaya'));
  assert.ok(names('Bangi').includes('Ayuni'));

  const rt = (code, id) => byCode[code].running_totals.find((r) => r.id === id);
  assert.equal(rt('WM', 'CR').start_value, 0);
  assert.equal(rt('JH', 'TF').start_value, 762);
});

test('usernames are unique and use the first name', () => {
  const map = makeUsernames(readSeed());
  const all = [...map.values()];
  assert.equal(new Set(all).size, all.length);
  assert.equal(map.get('WM|Hafizah'), 'hafizah');
  assert.equal(map.get('hq|Alia'), 'alia');
});

test('loads seed.json into an empty database with the right counts', async () => {
  const db = await freshDb();
  const seed = readSeed();
  assert.equal(await isSeeded(db), false);

  await loadSeed(db, seed, { adminPassword: ADMIN_PASSWORD });
  assert.equal(await isSeeded(db), true);

  const count = async (table) => (await db.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n;
  const sum = (fn) => seed.branches.reduce((n, b) => n + fn(b), 0);

  assert.equal(await count('branches'), seed.branches.length);
  assert.equal(await count('daily_fields'), sum((b) => b.daily_fields.length));
  assert.equal(await count('measures'), sum((b) => b.measures.length));
  assert.equal(await count('measure_targets'), sum((b) => b.measures.length * 3));
  assert.equal(await count('running_totals'), sum((b) => b.running_totals.length));
  assert.equal(await count('hq_measures'), seed.hq.measures.length);
  assert.equal(await count('people'), sum((b) => b.people.length) + seed.hq.owners.length);
  // one login per person + admin
  assert.equal(await count('users'), sum((b) => b.people.length) + seed.hq.owners.filter((o) => o.login !== false).length + 1);
  await db.close();
});

test('targets, blanks and branch numbers load exactly as in seed.json', async () => {
  const db = await freshDb();
  await loadSeed(db, readSeed(), { adminPassword: ADMIN_PASSWORD });

  const target = async (branch, code, month) =>
    (await db.query(
      `SELECT t.target FROM measure_targets t JOIN measures m ON m.id = t.measure_id
       JOIN branches b ON b.id = m.branch_id WHERE b.code = $1 AND m.code = $2 AND t.month = $3`,
      [branch, code, month]
    )).rows[0].target;

  assert.equal(await target('WM', 'T1', '2026-12'), 2100);
  assert.equal(await target('WM', 'L3', '2026-10'), 0.45);
  assert.equal(await target('JH', 'Y0', '2026-10'), null); // blank = track only
  assert.equal(await target('JH', 'Y3', '2026-11'), 50); // JH 15 Oct: 50 new followers a month
  const weekend = (await db.query(
    `SELECT t.target, t.weekend_target FROM measure_targets t JOIN measures m ON m.id = t.measure_id
     JOIN branches b ON b.id = m.branch_id WHERE b.code = 'BR' AND m.code = 'T1' AND t.month = '2026-10'`)).rows[0];
  assert.deepEqual(weekend, { target: 1250, weekend_target: 1650 });

  const base = (await db.query(
    `SELECT bl.baseline_end_date, bl.sales_before_start FROM branch_baselines bl
     JOIN branches b ON b.id = bl.branch_id WHERE b.code = 'WM'`
  )).rows[0];
  assert.equal(base.baseline_end_date, '2026-10-11');
  assert.equal(base.sales_before_start, 19900);

  const noZakat = (await db.query(
    "SELECT code FROM branches WHERE zakat_field IS NULL ORDER BY code"
  )).rows.map((r) => r.code);
  assert.deepEqual(noZakat, ['Ampang', 'Bangi']);
  await db.close();
});

test('logins: roles are right, admin password is hashed, staff start with no password', async () => {
  const db = await freshDb();
  await loadSeed(db, readSeed(), { adminPassword: ADMIN_PASSWORD });

  const user = async (u) => (await db.query('SELECT * FROM users WHERE username = $1', [u])).rows[0];

  const admin = await user('admin');
  assert.equal(admin.role, 'admin');
  assert.notEqual(admin.password_hash, ADMIN_PASSWORD);
  assert.ok(bcrypt.compareSync(ADMIN_PASSWORD, admin.password_hash));

  assert.equal((await user('hafizah')).role, 'branch_manager');
  assert.equal((await user('mazlina')).role, 'branch_manager');
  assert.equal((await user('zawiyah')).role, 'branch_staff');
  assert.equal((await user('alia')).role, 'hq');
  assert.equal((await user('zawiyah')).password_hash, null);
  await db.close();
});

test('seed cannot be loaded twice', async () => {
  const db = await freshDb();
  await loadSeed(db, readSeed(), { adminPassword: ADMIN_PASSWORD });
  await assert.rejects(loadSeed(db, readSeed(), { adminPassword: ADMIN_PASSWORD }), /already been loaded/);
  await db.close();
});

test('a bad seed loads nothing at all', async () => {
  const db = await freshDb();
  const seed = clone(readSeed());
  seed.branches[2].measures[0].numerator_field = 'nope';
  await assert.rejects(loadSeed(db, seed, { adminPassword: ADMIN_PASSWORD }), /nothing was loaded/);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM branches')).rows[0].n, 0);
  await db.close();
});

test('first start needs ADMIN_PASSWORD', async () => {
  const db = await freshDb();
  await assert.rejects(loadSeed(db, readSeed(), { adminPassword: undefined }), /ADMIN_PASSWORD/);
  await db.close();
});

test('no table has a salary column', async () => {
  const db = await freshDb();
  const { rows } = await db.query(
    "SELECT table_name, column_name FROM information_schema.columns WHERE column_name ILIKE '%salar%'"
  );
  assert.deepEqual(rows, []);
  await db.close();
});

test('migrations can run again safely', async () => {
  const db = await freshDb();
  const again = await migrate(db);
  assert.deepEqual(again, []);
  await db.close();
});
