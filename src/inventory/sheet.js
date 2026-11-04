// 4 Nov (CEO: "whatever we tick in 4DX will connect to your system … so we don't need to update"):
// 4DX writes its payment lines back into the Payment_Approvals Google Sheet, so Mr Eve (who reads the
// sheet from Drive) and anyone who opens the sheet see the same approvals and Paid marks as 4DX.
// 4DX is the master: the sheet's rows are rewritten from 4DX a few seconds after every change in 4DX,
// and every 30 minutes. Typing in the sheet is overwritten – change payments in 4DX.
//
// Needs: the service account (same key as the Drive sync) as **Editor** on the Payment_Approvals sheet,
// and the Google Sheets API on in its Cloud project (already on for the sales sheet).
// Sheet: app_settings inventory_payments_sheet {sheet_id, tab}; default the Payment_Approvals sheet,
// first tab.

const { getAccessToken } = require('../sheets/google');
const { loadAccount } = require('./drive');

const SCOPE = 'https://www.googleapis.com/auth/spreadsheets';
const API = 'https://sheets.googleapis.com/v4/spreadsheets';
const DEFAULTS = { sheet_id: '1-TaTjY8vhSl0IioJTht2m9vnXmqKHMDTxeN1O8Cm9Ks', tab: null };
const HEADER = ['Week', 'Pay date (planned)', 'Supplier', 'Proposed amount (RM)', 'Approved? (Yes / No / Partial)', 'Approved amount (RM)',
  'Paid? (Yes / No)', 'Date paid', 'Notes', 'Paid via', 'Payment ref (Swipey / PV)', 'Last change in 4DX'];
const EXAMPLE = ['EXAMPLE 2-8 Nov', '05/11/2026', 'EXAMPLE SUPPLIER', 1000, 'Yes', 1000, 'Yes', '05/11/2026',
  'Kept in step by 4DX (Inventory → Ordering & payments): Dr Aisyah approves and Azwani marks Paid there – changes typed here are overwritten.', 'Swipey', '', ''];

const dmy = (iso) => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || '')); return m ? `${m[3]}/${m[2]}/${m[1]}` : ''; };
const myt = (t) => {
  if (!t) return '';
  const d = new Date(t); if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString('en-GB', { timeZone: 'Asia/Kuala_Lumpur', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false });
};
const n = (v) => (v === null || v === undefined || v === '' ? '' : Number(v));

// 4DX payment lines → sheet rows (header, the explaining EXAMPLE row, then every line by pay date).
async function sheetRows(db) {
  const { rows } = await db.query(`SELECT week, pay_date::text AS pay_date, supplier, proposed, approved, approved_amount, paid,
      date_paid::text AS date_paid, notes, paid_via, pv_no, greatest(created_at, approved_at, paid_at) AS changed
    FROM inv_payments ORDER BY pay_date NULLS LAST, id`);
  return [HEADER, EXAMPLE, ...rows.map((p) => [p.week || '', dmy(p.pay_date), p.supplier, n(p.proposed), p.approved || '', n(p.approved_amount),
    p.paid ? 'Yes' : '', dmy(p.date_paid), p.notes || '', p.paid ? (p.paid_via || '') : '', p.pv_no || '', myt(p.changed)])];
}

function createPaymentsSheet(db, { env = process.env, fetchImpl = fetch, now = () => new Date(), log = console.log, account, delayMs = 4000 } = {}) {
  let acct = null; let keyError = null;
  try { acct = account !== undefined ? account : loadAccount(env); } catch (err) { keyError = err.message; }
  let timer = null; let running = null; let again = false;

  async function settings() {
    const r = (await db.query("SELECT value FROM app_settings WHERE key = 'inventory_payments_sheet'")).rows[0];
    let s = {}; try { s = JSON.parse(r ? r.value : '{}') || {}; } catch { s = {}; }
    return { ...DEFAULTS, ...s };
  }
  async function saveStatus(st) {
    await db.query(`INSERT INTO app_settings (key, value) VALUES ('inventory_sheet_status', $1)
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [JSON.stringify(st)]);
  }
  async function status() {
    const r = (await db.query("SELECT value FROM app_settings WHERE key = 'inventory_sheet_status'")).rows[0];
    let st = {}; try { st = JSON.parse(r ? r.value : '{}') || {}; } catch { st = {}; }
    return { configured: Boolean(acct), email: acct ? acct.email : null, keyError, ...st };
  }
  async function google(url, token, opts = {}) {
    const res = await fetchImpl(url, { ...opts, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...(opts.headers || {}) } });
    if (res.ok) return res.json().catch(() => ({}));
    const body = await res.json().catch(() => ({}));
    const msg = body.error && body.error.message ? body.error.message : `HTTP ${res.status}`;
    if (res.status === 403 || res.status === 404) throw new Error(`4DX can't update the Payment_Approvals sheet. Share it with ${acct.email} as Editor. Google said: ${msg}`);
    throw new Error(`Updating the Payment_Approvals sheet failed: ${msg}`);
  }

  async function run() {
    const s = await settings();
    const at = now().toISOString();
    try {
      const token = await getAccessToken(acct, fetchImpl, SCOPE);
      let tab = s.tab;
      if (!tab) {
        const meta = await google(`${API}/${encodeURIComponent(s.sheet_id)}?fields=sheets.properties.title`, token);
        tab = meta.sheets && meta.sheets[0] && meta.sheets[0].properties.title;
        if (!tab) throw new Error('The Payment_Approvals sheet has no tab.');
      }
      const q = `'${String(tab).replace(/'/g, "''")}'`;
      const values = await sheetRows(db);
      await google(`${API}/${encodeURIComponent(s.sheet_id)}/values:batchClear`, token, { method: 'POST', body: JSON.stringify({ ranges: [`${q}!A1:L2000`] }) });
      // RAW: notes are written as text, never run as formulas.
      await google(`${API}/${encodeURIComponent(s.sheet_id)}/values/${encodeURIComponent(`${q}!A1:L${values.length}`)}?valueInputOption=RAW`, token,
        { method: 'PUT', body: JSON.stringify({ range: `${q}!A1:L${values.length}`, majorDimension: 'ROWS', values }) });
      await saveStatus({ updated_at: at, lines: values.length - 2, error: null });
      return { ok: true, lines: values.length - 2 };
    } catch (err) {
      const prev = await status().catch(() => ({}));
      await saveStatus({ updated_at: prev.updated_at || null, lines: prev.lines, error: err.message, failed_at: at });
      throw err;
    }
  }

  async function syncNow() {
    if (!acct) return { error: keyError || 'not set up' };
    if (running) { again = true; return running; }
    running = run().finally(() => {
      running = null;
      if (again) { again = false; syncNow().catch((err) => log(`Payment_Approvals sheet: ${err.message}`)); }
    });
    return running;
  }

  return {
    configured: () => Boolean(acct),
    status,
    syncNow,
    // A few seconds after a change in 4DX (several quick changes = one write).
    syncSoon() {
      if (!acct) return;
      clearTimeout(timer);
      timer = setTimeout(() => syncNow().catch((err) => log(`Payment_Approvals sheet: ${err.message}`)), delayMs);
      if (timer.unref) timer.unref();
    },
    schedule(minutes = 30) {
      if (!acct) { log('Inventory: Payment_Approvals sheet write-back off (no service account key).'); return; }
      log(`Inventory: Payment_Approvals sheet kept in step with 4DX (every ${minutes} minutes and after each change).`);
      const go = () => syncNow().catch((err) => log(`Payment_Approvals sheet: ${err.message}`));
      go();
      setInterval(go, minutes * 60 * 1000).unref();
    },
  };
}

module.exports = { createPaymentsSheet, sheetRows, HEADER, DEFAULTS };
