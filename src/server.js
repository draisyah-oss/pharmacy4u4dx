// `npm start` runs this file: prepare the database, then start the web server.

require('dotenv').config({ quiet: true });

// On Railway, behave as production even if NODE_ENV wasn't set (secure cookies, no fake dates).
if (process.env.RAILWAY_ENVIRONMENT && !process.env.NODE_ENV) process.env.NODE_ENV = 'production';

// On Railway the built-in local database would be wiped on every deploy, losing everything
// typed in. Refuse to start until the app is pointed at the Postgres database.
if (process.env.RAILWAY_ENVIRONMENT && !process.env.DATABASE_URL) {
  console.error('DATABASE_URL is not set (or is empty). In Railway: open the Postgres service → Variables,');
  console.error('copy the value of DATABASE_URL (postgresql://…@postgres.railway.internal:5432/railway),');
  console.error('paste it into this app service → Variables → DATABASE_URL, then click Deploy.');
  // Names only (never values), to spot a typo such as "DATABASE URL" or a variable left empty.
  const near = Object.keys(process.env).filter((k) => /data|pg|postgres|url/i.test(k) && !/^RAILWAY_/.test(k));
  console.error(`Variables this app can see that look related: ${near.length ? near.join(', ') : 'none'}.`);
  if ('DATABASE_URL' in process.env) console.error('DATABASE_URL exists but is EMPTY – a ${{...}} reference that pointed nowhere. Paste the full postgresql://… address instead.');
  process.exit(1);
}

const { getDb } = require('./db');
const { prepareDatabase } = require('./db/setup');
const { createApp } = require('./app');
const { createSalesSheetLink } = require('./sheets/sync');
const { createInventoryDrive } = require('./inventory/drive');
const { createPaymentsSheet } = require('./inventory/sheet');
const { createInventoryEvents } = require('./inventory/events');
const { createTelegram } = require('./lib/telegram');
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
  // 4 Nov: Mr Eve's daily plan from Google Drive into /inventory every 30 minutes.
  // 4 Nov: changes on /inventory → Telegram group + the Payment_Approvals sheet (what Mr Eve reads).
  const telegram = createTelegram();
  console.log(telegram.configured() ? 'Telegram messages: on' : 'Telegram messages: off (TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID not set)');
  const inventorySheet = createPaymentsSheet(db, { now });
  const inventoryEvents = createInventoryEvents(db, { telegram, sheet: inventorySheet, now });
  const inventoryDrive = createInventoryDrive(db, { now, onPlanLoaded: (date) => inventoryEvents.planLoaded(date, require('./inventory/data').loadPage) });
  // 5 Nov: supplier SOA status from the SOA folder in Drive, every 6 hours.
  const inventorySoa = require('./inventory/soa').createSoaSync(db, { now });
  // 5 Nov: change requests – Mr 4DX's log marks finished ones Live; the queue sheet tells Mr 4DX what's approved.
  await require('./requests/mr4dx').applyMr4dx(db, { now }).catch((err) => console.error('Mr 4DX log:', err.message));
  const requestQueue = require('./requests/queue').createRequestQueue(db, { now });
  // 6 Nov: scanned invoices → the P4U Finance inbox on Google Drive (retried every 15 minutes).
  const invoiceDrive = require('./invoices/drive').createInvoiceDrive(db, { now });
  const app = createApp(db, { now, salesSheet, inventoryDrive, inventoryEvents, inventorySheet, telegram, inventorySoa, requestQueue, invoiceDrive });
  invoiceDrive.schedule(15);
  requestQueue.schedule(30);
  inventorySoa.schedule(360);
  inventoryDrive.schedule(30);
  inventorySheet.schedule(30);
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
