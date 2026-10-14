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
}

module.exports = { prepareDatabase, backfillNewSettings };
