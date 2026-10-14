// Wipe the LOCAL test database so the next `npm start` reloads seed.json from scratch.
// Refuses to run when DATABASE_URL is set, so it can never touch Railway.

require('dotenv').config({ quiet: true });
const fs = require('fs');
const { DEFAULT_LOCAL_DIR } = require('../src/db');

if (process.env.DATABASE_URL) {
  console.log('DATABASE_URL is set – refusing to reset. This only clears the local test database.');
  process.exit(1);
}
const dir = process.env.LOCAL_DB_DIR || DEFAULT_LOCAL_DIR;
fs.rmSync(dir, { recursive: true, force: true });
console.log(`Local database cleared (${dir}). Run "npm start" to reload seed.json.`);
