// Database connection.
//
// - If DATABASE_URL is set (Railway, or your own Postgres), we use real PostgreSQL via `pg`.
// - If it is not set, we use PGlite: a full PostgreSQL that runs inside Node and stores its
//   files in ./data/pglite. Nothing to install, and it speaks exactly the same SQL, so what
//   works on your laptop works on Railway.
//
// Everything else in the app talks to the small interface returned here:
//   query(sql, params) -> { rows }
//   exec(sql)          -> run a multi-statement script (migrations)
//   transaction(fn)    -> fn receives { query, exec }; commits, or rolls back on error
//   close()

const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_LOCAL_DIR = path.join(ROOT, 'data', 'pglite');

// Postgres type ids
const DATE = 1082;
const NUMERIC = 1700;
const INT8 = 20;

// Dates stay as 'YYYY-MM-DD' strings (no timezone shifting); numbers come back as numbers.
const parseNumber = (v) => (v === null ? null : Number(v));
const parseDate = (v) => v;

async function createPostgres(url) {
  const { Pool, types } = require('pg');
  types.setTypeParser(DATE, parseDate);
  types.setTypeParser(NUMERIC, parseNumber);
  types.setTypeParser(INT8, parseNumber);

  const wantsSsl = process.env.DATABASE_SSL === 'true' || /sslmode=require/.test(url);
  const pool = new Pool({
    connectionString: url,
    ssl: wantsSsl ? { rejectUnauthorized: false } : undefined,
    max: 10,
  });
  await pool.query('select 1');

  const wrap = (client) => ({
    query: (sql, params) => client.query(sql, params),
    exec: (sql) => client.query(sql),
  });

  return {
    kind: 'postgres',
    ...wrap(pool),
    async transaction(fn) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await fn(wrap(client));
        await client.query('COMMIT');
        return result;
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
    },
    close: () => pool.end(),
  };
}

// PGlite's files can only be opened by one program at a time. A small lock file stops a
// second copy (e.g. `npm run users` while `npm start` is running) from damaging them.
function takeLocalLock(dir) {
  const fs = require('fs');
  const lockFile = `${dir}.lock`;
  fs.mkdirSync(path.dirname(lockFile), { recursive: true });
  if (fs.existsSync(lockFile)) {
    const pid = Number(fs.readFileSync(lockFile, 'utf8'));
    let alive = false;
    try { process.kill(pid, 0); alive = pid !== process.pid; } catch { alive = false; }
    if (alive) {
      throw new Error(
        'The local database is already open in another window (probably `npm start`). ' +
          'Stop that first with Ctrl+C, then try again.'
      );
    }
  }
  fs.writeFileSync(lockFile, String(process.pid));
  const release = () => { try { fs.unlinkSync(lockFile); } catch { /* already gone */ } };
  process.once('exit', release);
  return release;
}

async function createPglite(dir) {
  const releaseLock = dir === 'memory' ? () => {} : takeLocalLock(dir);
  const { PGlite, types } = await import('@electric-sql/pglite');
  const parsers = {
    [types.DATE]: parseDate,
    [types.NUMERIC]: parseNumber,
    [types.INT8]: parseNumber,
  };
  const options = { parsers };
  const db = dir === 'memory' ? new PGlite(options) : new PGlite(dir, options);
  await db.waitReady;

  const wrap = (handle) => ({
    query: (sql, params) => handle.query(sql, params),
    exec: (sql) => handle.exec(sql),
  });

  return {
    kind: 'pglite',
    location: dir === 'memory' ? 'in memory' : dir,
    ...wrap(db),
    transaction: (fn) => db.transaction((tx) => fn(wrap(tx))),
    close: async () => { await db.close(); releaseLock(); },
  };
}

// Create a new connection. `options.url` / `options.localDir` override the environment
// (tests use localDir: 'memory').
async function createDb(options = {}) {
  const url = options.url !== undefined ? options.url : process.env.DATABASE_URL;
  if (url) return createPostgres(url);
  const dir = options.localDir || process.env.LOCAL_DB_DIR || DEFAULT_LOCAL_DIR;
  return createPglite(dir);
}

// One shared connection for the running app.
let shared;
async function getDb() {
  if (!shared) shared = await createDb();
  return shared;
}

module.exports = { createDb, getDb, DEFAULT_LOCAL_DIR };
