// `npm start` runs this file: prepare the database, then start the web server.

require('dotenv').config({ quiet: true });

// On Railway, behave as production even if NODE_ENV wasn't set (secure cookies, no fake dates).
if (process.env.RAILWAY_ENVIRONMENT && !process.env.NODE_ENV) process.env.NODE_ENV = 'production';

// On Railway the built-in local database would be wiped on every deploy, losing everything
// typed in. Refuse to start until the app is pointed at the Postgres database.
if (process.env.RAILWAY_ENVIRONMENT && !process.env.DATABASE_URL) {
  console.error('DATABASE_URL is not set. In Railway, open the app service → Variables and add');
  console.error('DATABASE_URL = ${{Postgres.DATABASE_URL}} – then redeploy.');
  process.exit(1);
}

const { getDb } = require('./db');
const { prepareDatabase } = require('./db/setup');
const { createApp } = require('./app');
const { createSalesSheetLink } = require('./sheets/sync');
const { clearExpiredSessions } = require('./auth/sessions');

async function main() {
  const db = await getDb();
  console.log(
    db.kind === 'postgres'
      ? 'Database: PostgreSQL (DATABASE_URL)'
      : `Database: local PGlite in ${db.location}`
  );

  await prepareDatabase(db);

  // APP_TODAY=2026-10-20 pretends it's that day – handy for trying things locally.
  // Ignored in production so the live app always uses the real date.
  const fake = process.env.NODE_ENV !== 'production' && /^\d{4}-\d{2}-\d{2}$/.test(process.env.APP_TODAY || '');
  if (fake) console.log(`Pretending today is ${process.env.APP_TODAY} (APP_TODAY).`);
  const now = fake ? () => new Date(`${process.env.APP_TODAY}T20:00:00+08:00`) : () => new Date();
  const salesSheet = createSalesSheetLink(db, { now });
  const app = createApp(db, { now, salesSheet });
  salesSheet.schedule(Number(process.env.SALES_SHEET_SYNC_MINUTES) || 10);

  // Remove expired login sessions now and every hour.
  const tidy = () => clearExpiredSessions(db).catch((err) => console.error('Session clean-up failed:', err.message));
  tidy();
  setInterval(tidy, 60 * 60 * 1000).unref();
  const port = Number(process.env.PORT) || 3000;
  const server = app.listen(port, () => {
    console.log(`Pharmacy4U 4DX is running – open http://localhost:${port}`);
    console.log('Press Ctrl+C to stop.');
  });

  // Close the database cleanly on Ctrl+C (local) or when Railway restarts the app.
  const shutdown = () => {
    server.close();
    db.close().finally(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error(`\nCould not start: ${err.message}\n`);
  process.exit(1);
});
