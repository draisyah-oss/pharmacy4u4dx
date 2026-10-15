// What `npm start` does to the database before the server opens:
// 1. run any new migrations, 2. load seed.json if the database is still empty.

const { migrate } = require('./migrate');
const { readSeed, validateSeed, loadSeed, isSeeded } = require('./seed');

async function prepareDatabase(db, { log = console.log } = {}) {
  await migrate(db, { log });

  if (await isSeeded(db)) {
    log('Seed already loaded – using the data in the database.');
    await backfillNewSettings(db, readSeed(), log);
    return { seeded: false };
  }

  const seed = readSeed();
  const { warnings } = validateSeed(seed);
  warnings.forEach((w) => log(`Note: ${w}`));

  const summary = await loadSeed(db, seed, { adminPassword: process.env.ADMIN_PASSWORD });
  log(
    `Loaded seed.json: ${summary.branches} branches, ${summary.people} people, ` +
      `${summary.daily_fields} daily fields, ${summary.measures} measures, ` +
      `${summary.hq_measures} HQ measures, ${summary.users} logins.`
  );
  return { seeded: true, summary };
}

// Settings added to seed.json after a database was first loaded (e.g. the sales sheet link)
// are copied in once – only where the database has nothing yet, so Admin edits are kept.
async function backfillNewSettings(db, seed, log) {
  const has = await db.query("SELECT 1 FROM app_settings WHERE key = 'sales_sheet_id'");
  if (!has.rows.length && seed.company.sales_sheet_id) {
    await db.query("INSERT INTO app_settings (key, value) VALUES ('sales_sheet_id', $1)", [seed.company.sales_sheet_id]);
    log('Added the sales sheet link from seed.json.');
  }
  for (const b of seed.branches) {
    if (!b.sales_sheet) continue;
    const r = await db.query('UPDATE branches SET sales_sheet = $2 WHERE code = $1 AND sales_sheet IS NULL', [b.code, JSON.stringify(b.sales_sheet)]);
    if (r.affectedRows || r.rowCount) log(`Added the sales sheet columns for ${b.code}.`);
  }
  await backfillHqTeam(db, seed, log);
  await backfillHqAccess(db, seed, log);
  await backfillHqTasks(db, seed, log);
  const ct = await db.query('SELECT 1 FROM company_month_targets LIMIT 1');
  if (!ct.rows.length && seed.company.monthly_sales_target) {
    for (const [month, target] of Object.entries(seed.company.monthly_sales_target)) {
      await db.query('INSERT INTO company_month_targets (month, total_sales_target) VALUES ($1, $2)', [month, target]);
    }
    log('Added the company monthly sales targets from seed.json.');
  }
}

// HQ people and HQ measures added to seed.json later (14 Oct: Syarafana, Fariz, Azwani, Iman
// and the CEO's measure, from the Q4 4DX HQ Tracker). Only what's missing is added – people by
// name, measures by code – so anything changed in Admin stays as it is.
async function backfillHqTeam(db, seed, log) {
  const owners = (seed.hq && seed.hq.owners) || [];
  const measures = (seed.hq && seed.hq.measures) || [];
  await db.transaction(async (tx) => {
    const people = new Map((await tx.query('SELECT id, name FROM people WHERE branch_id IS NULL')).rows.map((p) => [p.name, p.id]));
    const added = [];
    for (const [i, o] of owners.entries()) {
      if (people.has(o.name)) continue;
      const { rows } = await tx.query(
        'INSERT INTO people (branch_id, name, role, sort_order) VALUES (NULL, $1, $2, $3) RETURNING id', [o.name, o.role, i + 1]);
      people.set(o.name, rows[0].id);
      added.push(o.name);
      if (o.login === false) continue;
      let username = o.name.toLowerCase().replace(/[^a-z0-9]+/g, '');
      if ((await tx.query('SELECT 1 FROM users WHERE username = $1', [username])).rows.length) username += '.hq';
      await tx.query(
        `INSERT INTO users (username, display_name, role, person_id, enters_all_hq) VALUES ($1, $2, $3, $4, $5)`,
        [username, o.name, o.access === 'staff' ? 'hq_staff' : 'hq', rows[0].id, Boolean(o.enters_all)]);
    }
    const codes = new Set((await tx.query('SELECT code FROM hq_measures')).rows.map((r) => r.code));
    let newMeasures = 0;
    for (const [i, m] of measures.entries()) {
      if (codes.has(m.id)) continue;
      const { rows } = await tx.query(
        `INSERT INTO hq_measures (code, owner_name, person_id, label, unit, input, better, kind, note, sort_order)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
        [m.id, m.owner, people.get(m.owner) || null, m.label, m.unit, m.input, m.better, m.kind, m.note, 100 + i]);
      for (const [month, target] of Object.entries(m.targets || {})) {
        await tx.query('INSERT INTO hq_measure_targets (hq_measure_id, month, target) VALUES ($1,$2,$3)', [rows[0].id, month, target]);
      }
      newMeasures++;
    }
    if (added.length || newMeasures) {
      await tx.query(
        `INSERT INTO audit_log (action, table_name, record_key, new_value) VALUES ('seed', 'hq_measures', 'HQ team from seed.json', $1)`,
        [JSON.stringify({ people: added, measures: newMeasures })]);
      log(`Added from seed.json: HQ people ${added.join(', ') || 'none'}; ${newMeasures} HQ measures.`);
    }
  });
}

// 15 Oct: HQ access levels, daily tasks and projects. Done once (app_settings flag), so later
// changes in Admin – a different login type, a retired task, a project edited – are kept.
async function backfillHqAccess(db, seed, log) {
  const done = await db.query("SELECT 1 FROM app_settings WHERE key = 'hq_access_v1'");
  if (done.rows.length) return;
  await db.transaction(async (tx) => {
    const people = new Map((await tx.query('SELECT id, name FROM people WHERE branch_id IS NULL')).rows.map((p) => [p.name, p.id]));
    for (const o of seed.hq.owners || []) {
      if (o.access !== 'staff' || !people.has(o.name)) continue;
      // A changed login type needs a new PIN; any old password is cleared.
      await tx.query(
        `UPDATE users SET role = 'hq_staff', password_hash = NULL WHERE person_id = $1 AND role = 'hq'`, [people.get(o.name)]);
    }
    if (!(await tx.query('SELECT 1 FROM hq_daily_tasks LIMIT 1')).rows.length) {
      for (const [name, labels] of Object.entries(seed.hq.daily_tasks || {})) {
        if (!people.has(name)) continue;
        for (const [i, label] of labels.entries()) {
          await tx.query('INSERT INTO hq_daily_tasks (person_id, label, sort_order) VALUES ($1,$2,$3)', [people.get(name), label, i + 1]);
        }
      }
    }
    if (!(await tx.query('SELECT 1 FROM hq_projects LIMIT 1')).rows.length) {
      for (const [i, pr] of (seed.hq.projects || []).entries()) {
        await tx.query(
          'INSERT INTO hq_projects (project, milestone, owner, start_date, due_date, sort_order) VALUES ($1,$2,$3,$4,$5,$6)',
          [pr.project, pr.milestone, pr.owner, pr.start || null, pr.due || null, i + 1]);
      }
    }
    await tx.query("INSERT INTO app_settings (key, value) VALUES ('hq_access_v1', $1)", [new Date().toISOString()]);
    await tx.query(
      `INSERT INTO audit_log (action, table_name, record_key, new_value) VALUES ('seed', 'users', 'HQ access levels, daily tasks, projects', NULL)`);
  });
  log('Set HQ access levels and added HQ daily tasks and projects from seed.json.');
}

// 15 Oct (later): starting daily tasks for every HQ person. Once only, and only for people
// who have never had a task – a list someone already made or trimmed is left alone.
async function backfillHqTasks(db, seed, log) {
  if ((await db.query("SELECT 1 FROM app_settings WHERE key = 'hq_daily_tasks_v2'")).rows.length) return;
  const added = [];
  await db.transaction(async (tx) => {
    const people = new Map((await tx.query('SELECT id, name FROM people WHERE branch_id IS NULL')).rows.map((p) => [p.name, p.id]));
    for (const [name, labels] of Object.entries(seed.hq.daily_tasks || {})) {
      const id = people.get(name);
      if (!id || (await tx.query('SELECT 1 FROM hq_daily_tasks WHERE person_id = $1 LIMIT 1', [id])).rows.length) continue;
      for (const [i, label] of labels.entries()) {
        await tx.query('INSERT INTO hq_daily_tasks (person_id, label, sort_order) VALUES ($1,$2,$3)', [id, label, i + 1]);
      }
      added.push(name);
    }
    await tx.query("INSERT INTO app_settings (key, value) VALUES ('hq_daily_tasks_v2', $1)", [new Date().toISOString()]);
    if (added.length) {
      await tx.query(
        `INSERT INTO audit_log (action, table_name, record_key, new_value) VALUES ('seed', 'hq_daily_tasks', 'Starting daily tasks', $1)`,
        [JSON.stringify(added)]);
    }
  });
  if (added.length) log(`Added starting daily tasks for ${added.join(', ')}.`);
}

module.exports = { prepareDatabase, backfillNewSettings, backfillHqTeam, backfillHqAccess, backfillHqTasks };
