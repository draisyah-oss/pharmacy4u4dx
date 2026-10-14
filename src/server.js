// `npm start` runs this file: prepare the database, then start the web server.

require('dotenv').config({ quiet: true });

const { getDb } = require('./db');
const { prepareDatabase } = require('./db/setup');
const { createApp } = require('./app');

async function main() {
  const db = await getDb();
  console.log(
    db.kind === 'postgres'
      ? 'Database: PostgreSQL (DATABASE_URL)'
      : `Database: local PGlite in ${db.location}`
  );

  await prepareDatabase(db);

  const app = createApp(db);
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
