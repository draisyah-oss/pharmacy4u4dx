// Sales sheet → daily entries.
//
// For each branch with a `sales_sheet` setting ({ tab, columns }), read its daily tab and
// write the mapped numbers (walk-in, transactions, zakat, Shopee, Alpine, Grab orders…) into
// daily_entries with source = 'sheet'. Only days from the tracker start up to today are
// taken – earlier days are in the before-tracker figure, and future rows in the sheet are
// templates. Every change is written to the audit log. Staff can't type these fields while
// the link is on; the sheet is the one place to fix them.

const calc = require('../calc');
const { parseSalesTab } = require('./parse');
const { loadServiceAccount, readTabs } = require('./google');
const { mentionsSalary } = require('../privacy');
const summary = require('./summary');

// The sheet's own summary tabs (daily totals, year table). Names can be changed in app_settings.
const SUMMARY_TABS = { daily: 'Overall Daily Sales', monthly: 'Total Sales' };

async function syncSummaryTabs(db, { readRows, today }) {
  const s = await sheetSettings(db);
  const tabs = { daily: s.sales_summary_daily_tab || SUMMARY_TABS.daily, monthly: s.sales_summary_monthly_tab || SUMMARY_TABS.monthly };
  if (mentionsSalary(tabs.daily, tabs.monthly)) throw new Error('Summary tab names mention salaries – not read (privacy rule).');
  const data = await readRows([tabs.daily, tabs.monthly]);
  const codes = (await db.query('SELECT code FROM branches ORDER BY sort_order')).rows.map((r) => r.code);
  const daily = data[tabs.daily] ? summary.parseOverallDaily(data[tabs.daily], codes) : null;
  const monthly = data[tabs.monthly] ? summary.parseTotalSales(data[tabs.monthly], codes, Number(today.slice(0, 4))) : null;
  await summary.storeSummary(db, { daily, monthly, today });
  return { days: daily ? daily.length : 0, months: monthly ? monthly.months.length : 0 };
}

async function sheetSettings(db) {
  const { rows } = await db.query("SELECT key, value FROM app_settings WHERE key LIKE 'sales_sheet_%'");
  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
}

async function setSetting(db, key, value) {
  await db.query(
    `INSERT INTO app_settings (key, value, updated_at) VALUES ($1, $2, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [key, value]
  );
}

async function linkedBranches(db) {
  const { rows } = await db.query(
    "SELECT id, code, name, sales_sheet FROM branches WHERE active AND sales_sheet IS NOT NULL ORDER BY sort_order");
  return rows
    .map((b) => ({ ...b, sales_sheet: typeof b.sales_sheet === 'string' ? JSON.parse(b.sales_sheet) : b.sales_sheet }))
    .filter((b) => b.sales_sheet && b.sales_sheet.tab && b.sales_sheet.columns)
    .filter((b) => !mentionsSalary(b.sales_sheet.tab))
    // Privacy rule: never read a salary/pay column, even if one were mapped by mistake.
    .map((b) => ({
      ...b,
      sales_sheet: {
        ...b.sales_sheet,
        columns: Object.fromEntries(Object.entries(b.sales_sheet.columns).filter(([k, h]) => !mentionsSalary(k, JSON.stringify(h)))),
      },
    }));
}

// readRows(tabs) → { tabName: rows }. Injected so tests don't need Google.
async function syncSalesSheet(db, { readRows, today, trackerStart }) {
  const branches = await linkedBranches(db);
  const tabs = [...new Set(branches.map((b) => b.sales_sheet.tab))];
  const data = await readRows(tabs);
  const summary = { changed: 0, unchanged: 0, removed: 0, days: 0, branches: {} };

  await db.transaction(async (tx) => {
    for (const b of branches) {
      const rows = data[b.sales_sheet.tab];
      if (!rows) throw new Error(`The sales sheet has no tab called “${b.sales_sheet.tab}”.`);
      const fields = Object.keys(b.sales_sheet.columns);
      const parsed = parseSalesTab(rows, b.sales_sheet.columns).filter((d) => d.date >= trackerStart && d.date <= today);
      const stats = { changed: 0, days: parsed.length };

      const existing = new Map(
        (await tx.query(
          `SELECT entry_date, field_key, value, source FROM daily_entries
           WHERE branch_id = $1 AND field_key = ANY($2) AND entry_date BETWEEN $3 AND $4`,
          [b.id, fields, trackerStart, today]
        )).rows.map((r) => [`${r.entry_date}|${r.field_key}`, r])
      );

      for (const day of parsed) {
        for (const field of fields) {
          const key = `${day.date}|${field}`;
          const before = existing.get(key);
          const value = day.values[field];
          const recordKey = `${b.code} ${day.date} ${field}`;
          if (value === undefined) {
            // Cleared in the sheet: remove a number that came from the sheet earlier.
            if (before && before.source === 'sheet') {
              await tx.query('DELETE FROM daily_entries WHERE branch_id = $1 AND entry_date = $2 AND field_key = $3', [b.id, day.date, field]);
              await tx.query(
                `INSERT INTO audit_log (action, table_name, record_key, old_value, new_value)
                 VALUES ('sheet_delete', 'daily_entries', $1, $2, NULL)`, [recordKey, JSON.stringify(Number(before.value))]);
              summary.removed++;
            }
            continue;
          }
          if (before && Number(before.value) === value && before.source === 'sheet') { summary.unchanged++; continue; }
          await tx.query(
            `INSERT INTO daily_entries (branch_id, entry_date, field_key, value, entered_by, source, updated_at)
             VALUES ($1, $2, $3, $4, NULL, 'sheet', now())
             ON CONFLICT (branch_id, entry_date, field_key)
             DO UPDATE SET value = EXCLUDED.value, entered_by = NULL, source = 'sheet', updated_at = now()`,
            [b.id, day.date, field, value]
          );
          await tx.query(
            `INSERT INTO audit_log (action, table_name, record_key, old_value, new_value)
             VALUES ('sheet_sync', 'daily_entries', $1, $2, $3)`,
            [recordKey, before ? JSON.stringify(Number(before.value)) : null, JSON.stringify(value)]
          );
          summary.changed++;
          stats.changed++;
        }
      }
      summary.days += parsed.length;
      summary.branches[b.code] = stats;
    }
  });
  return summary;
}

// The live connection: is it set up, and a function that syncs now.
function createSalesSheetLink(db, { env = process.env, now = () => new Date(), fetchImpl = fetch, log = console.log } = {}) {
  let account = null;
  let configError = null;
  try { account = loadServiceAccount(env); } catch (err) { configError = err.message; }
  let running = null;

  async function sheetId() {
    if (env.GOOGLE_SALES_SHEET_ID) return env.GOOGLE_SALES_SHEET_ID;
    return (await sheetSettings(db)).sales_sheet_id || null;
  }

  async function enabled() {
    return Boolean(account && (await sheetId()));
  }

  async function syncNow() {
    if (running) return running; // one sync at a time
    running = (async () => {
      const id = await sheetId();
      if (!account || !id) throw new Error(configError || 'The sales sheet link is not set up yet (see README → Sales sheet).');
      const today = calc.todayInMalaysia(now());
      const start = (await db.query("SELECT value FROM app_settings WHERE key = 'tracker_start_date'")).rows[0].value;
      try {
        const summary = await syncSalesSheet(db, {
          readRows: (tabs) => readTabs({ account, sheetId: id, tabs, fetchImpl }), today, trackerStart: start,
        });
        await setSetting(db, 'sales_sheet_last_sync', new Date().toISOString());
        await setSetting(db, 'sales_sheet_last_error', '');
        // Summary tabs separately: a renamed summary tab mustn't stop the daily numbers.
        try {
          await syncSummaryTabs(db, { readRows: (tabs) => readTabs({ account, sheetId: id, tabs, fetchImpl }), today });
          await setSetting(db, 'sales_summary_last_error', '');
        } catch (err) {
          await setSetting(db, 'sales_summary_last_error', err.message);
          log(`Sales sheet summary tabs not read: ${err.message}`);
        }
        if (summary.changed || summary.removed) log(`Sales sheet: ${summary.changed} numbers updated, ${summary.removed} removed.`);
        return summary;
      } catch (err) {
        await setSetting(db, 'sales_sheet_last_error', err.message);
        throw err;
      }
    })().finally(() => { running = null; });
    return running;
  }

  async function status() {
    const s = await sheetSettings(db);
    return {
      enabled: await enabled(),
      serviceAccountEmail: account ? account.email : null,
      configError,
      sheetId: await sheetId(),
      lastSync: s.sales_sheet_last_sync || null,
      lastError: s.sales_sheet_last_error || null,
      summaryError: s.sales_summary_last_error || null,
    };
  }

  // Sync on start and every `minutes` after that. Errors are logged, not fatal.
  function schedule(minutes = 10) {
    const run = () => syncNow().catch((err) => log(`Sales sheet sync failed: ${err.message}`));
    enabled().then((on) => {
      if (!on) { log('Sales sheet link: not set up (walk-in, transactions etc. are typed in the app).'); return; }
      log(`Sales sheet link: on – syncing every ${minutes} minutes as ${account.email}.`);
      run();
      setInterval(run, minutes * 60 * 1000).unref();
    });
  }

  return { enabled, syncNow, status, schedule };
}

// Which fields of a branch come from the sheet (empty when the link is off).
async function sheetFieldsFor(db, branchId, link) {
  if (!link || !(await link.enabled())) return new Set();
  const { rows } = await db.query('SELECT sales_sheet FROM branches WHERE id = $1', [branchId]);
  const cfg = rows[0] && rows[0].sales_sheet;
  const obj = typeof cfg === 'string' ? JSON.parse(cfg) : cfg;
  return new Set(obj && obj.columns ? Object.keys(obj.columns) : []);
}

module.exports = { syncSalesSheet, syncSummaryTabs, createSalesSheetLink, sheetFieldsFor, linkedBranches, SUMMARY_TABS };
