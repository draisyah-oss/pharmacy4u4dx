// Runs every .sql file in ./migrations that hasn't been run yet, in name order.
// Each file runs inside a transaction, so a failed migration leaves nothing half-done.
// To change the database later: add a new file (002_..., 003_...) – never edit an old one.

const fs = require('fs');
const path = require('path');

const MIGRATIONS_DIR = path.join(__dirname, 'migrations');

async function migrate(db, { log = () => {} } = {}) {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    );
  `);

  const { rows } = await db.query('SELECT version FROM schema_migrations');
  const done = new Set(rows.map((r) => r.version));

  const files = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  const applied = [];
  for (const file of files) {
    if (done.has(file)) continue;
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
    await db.transaction(async (tx) => {
      await tx.exec(sql);
      await tx.query('INSERT INTO schema_migrations (version) VALUES ($1)', [file]);
    });
    log(`Migration applied: ${file}`);
    applied.push(file);
  }
  return applied;
}

module.exports = { migrate };
