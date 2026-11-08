// Import the Management Council and Branch Manager Meeting prototypes' data into 4DX (Meetings module).
//   npm run import:meetings -- /path/to/meetings-export.json
// Keep the export file OUTSIDE this repo – the repo is public. Safe to run twice (rows already
// imported are skipped). Against Railway: run with DATABASE_URL set to the Railway database.

require('dotenv').config({ quiet: true });
const fs = require('fs');
const { createDb } = require('../src/db');
const { prepareDatabase } = require('../src/db/setup');
const { importExport } = require('../src/meetings/import');

async function main() {
  const file = process.argv[2];
  if (!file || !fs.existsSync(file)) {
    console.log('Usage: npm run import:meetings -- <export.json>');
    process.exit(1);
  }
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  const db = await createDb();
  await prepareDatabase(db, { log: () => {} });
  await importExport(db, data, { log: console.log });
  await db.close();
}

main().catch((err) => { console.error(err.message); process.exit(1); });
