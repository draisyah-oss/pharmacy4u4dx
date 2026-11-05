// 5 Nov 2026 (CEO): Mr Eve now builds a "Supplier_Status (from SOA) <date>" sheet in the Inventory
// Agent Inputs folder – per supplier a suggested status (OPEN / AFTER PAYMENT / ON HOLD / CHECK),
// can-order, unpaid / overdue RM, the Payment_Approvals line and a note. The app fetches the newest
// one (every 30 minutes with Mr Eve's plan, and on "Check Drive now") and shows it next to each
// supplier in "Can I order from this supplier?". It is Mr Eve's recommendation only: it never changes
// the gate that opens a supplier (that stays payment lines + our own SOA reading).
//
// Kept in app_settings 'inventory_supplier_status' (a few dozen rows – no migration needed).
// Same service account and folder as Mr Eve's plan (inventory_drive.folder_id).

const { getAccessToken } = require('../sheets/google');
const { loadAccount, csvToRows, DRIVE_SCOPE, DEFAULTS } = require('./drive');
const { keyOf } = require('./data');

const DRIVE = 'https://www.googleapis.com/drive/v3/files';
const PREFIX = 'Supplier_Status (from SOA)';
const SETTING = 'inventory_supplier_status';

const num = (v) => { const s = String(v ?? '').replace(/[^0-9.\-]/g, ''); if (!s || s === '-' || s === '.') return null; const n = Number(s); return Number.isFinite(n) ? n : null; };

// "DKSH (103)" → "DKSH 103" (its own budget key); everything else like the budget: first word, "AA Alive" two.
function supplierKey(name) {
  const n = String(name || '');
  const dk = /^\s*DKSH\s*\(?\s*(\d+)/i.exec(n);
  return dk && dk[1] === '103' ? 'DKSH 103' : keyOf(n);
}

// Suggested status text → the page's gate colours.
function gateOf(status) {
  const s = String(status || '').toLowerCase();
  if (/^open/.test(s)) return 'open';
  if (/on hold/.test(s)) return 'hold';
  if (/after payment/.test(s)) return 'wait';
  return 'check';
}

// Sheet rows (objects keyed by the header row) → one entry per supplier; the NOTE row and blanks are skipped.
function parseStatusRows(rows) {
  const out = [];
  for (const r of rows) {
    const supplier = String(r.Supplier || '').trim();
    if (!supplier || /^note$/i.test(supplier)) continue;
    const status = String(r['Suggested status'] || '').trim();
    out.push({
      key: supplierKey(supplier), supplier, status, gate: gateOf(status),
      can_order: String(r['Can order now?'] || '').trim(),
      unpaid: num(r['Unpaid RM']), overdue: num(r['Overdue RM']), due_soon: num(r['Due 5-19 Nov RM']), not_due: num(r['Not yet due RM']),
      oldest_overdue: String(r['Oldest overdue due date'] || '').trim() || null,
      plan_line: String(r['Payment_Approvals line'] || '').trim(),
      note: String(r.Note || '').trim(),
      soa_file: String(r['SOA file'] || '').trim() || null,
      read_on: String(r['SOA read on'] || '').trim() || null,
    });
  }
  return out;
}

async function loadSetting(db) {
  const r = (await db.query('SELECT value FROM app_settings WHERE key = $1', [SETTING])).rows[0];
  try { return JSON.parse(r ? r.value : '{}') || {}; } catch { return {}; }
}
async function saveSetting(db, v) {
  await db.query(`INSERT INTO app_settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [SETTING, JSON.stringify(v)]);
}

// What the page needs: { map: key → entry, file, read_on, checked_at, error }.
async function loadMap(db) {
  const s = await loadSetting(db);
  const map = {};
  for (const e of s.rows || []) map[e.key] = e;
  return { map, file: s.file || null, file_id: s.file_id || null, read_on: s.read_on || null, imported_at: s.imported_at || null, checked_at: s.checked_at || null, error: s.error || null };
}

function createSupplierStatusSync(db, { env = process.env, fetchImpl = fetch, now = () => new Date(), log = console.log, account } = {}) {
  let acct = null; let keyError = null;
  try { acct = account !== undefined ? account : loadAccount(env); } catch (err) { keyError = err.message; }
  let running = null; let lastForced = 0;

  async function folderId() {
    const r = (await db.query("SELECT value FROM app_settings WHERE key = 'inventory_drive'")).rows[0];
    let s = {}; try { s = JSON.parse(r ? r.value : '{}') || {}; } catch { s = {}; }
    return s.folder_id || DEFAULTS.folder_id;
  }

  async function get(url, token) {
    const res = await fetchImpl(url, { headers: { authorization: `Bearer ${token}` } });
    if (res.ok) return res;
    const body = await res.json().catch(() => ({}));
    const msg = body.error && body.error.message ? body.error.message : `HTTP ${res.status}`;
    if (res.status === 403 || res.status === 404) throw new Error(`The app can't open the Inputs folder. Share it (Viewer) with ${acct.email}. Google said: ${msg}`);
    throw new Error(`Reading Google Drive failed: ${msg}`);
  }

  async function run() {
    const at = now().toISOString();
    const prev = await loadSetting(db);
    try {
      const token = await getAccessToken(acct, fetchImpl, DRIVE_SCOPE);
      const q = `'${await folderId()}' in parents and name contains 'Supplier_Status' and mimeType = 'application/vnd.google-apps.spreadsheet' and trashed = false`;
      const qs = new URLSearchParams({ q, orderBy: 'modifiedTime desc', pageSize: '20', fields: 'files(id,name,modifiedTime)', supportsAllDrives: 'true', includeItemsFromAllDrives: 'true' });
      const files = ((await (await get(`${DRIVE}?${qs}`, token)).json()).files || [])
        .filter((f) => String(f.name || '').toLowerCase().startsWith(PREFIX.toLowerCase()))
        .sort((a, b) => String(b.modifiedTime).localeCompare(String(a.modifiedTime)));
      if (!files.length) { await saveSetting(db, { ...prev, checked_at: at, error: `No sheet called "${PREFIX} …" in the folder yet.` }); return { ok: true, none: true }; }
      const f = files[0];
      if (prev.file_id === f.id && prev.modified === f.modifiedTime && (prev.rows || []).length) {
        await saveSetting(db, { ...prev, checked_at: at, error: null });
        return { ok: true, unchanged: true, file: f.name };
      }
      const ex = new URLSearchParams({ mimeType: 'text/csv', supportsAllDrives: 'true' });
      const rows = parseStatusRows(csvToRows(await (await get(`${DRIVE}/${encodeURIComponent(f.id)}/export?${ex}`, token)).text()));
      if (!rows.length) throw new Error(`"${f.name}" has no supplier rows.`);
      const readOn = rows.map((r) => r.read_on).filter(Boolean).sort().pop() || null;
      await saveSetting(db, { file_id: f.id, file: f.name, modified: f.modifiedTime, read_on: readOn, imported_at: at, checked_at: at, error: null, rows });
      log(`Inventory: ${f.name} loaded (${rows.length} suppliers).`);
      return { ok: true, file: f.name, suppliers: rows.length };
    } catch (err) {
      await saveSetting(db, { ...prev, checked_at: at, error: err.message });
      throw err;
    }
  }

  return {
    configured: () => Boolean(acct),
    async status() { return { configured: Boolean(acct), keyError, ...(await loadMap(db)) }; },
    async syncNow({ force = false } = {}) {
      if (!acct) return { error: keyError || 'not set up' };
      if (force && Date.now() - lastForced < 20 * 1000 && running) return running;
      if (force) lastForced = Date.now();
      if (!running) running = run().finally(() => { running = null; });
      return running;
    },
    schedule(minutes = 30) {
      if (!acct) return;
      const go = () => this.syncNow().catch((err) => log(`Supplier status sync failed: ${err.message}`));
      setTimeout(go, 30 * 1000).unref();
      setInterval(go, minutes * 60 * 1000).unref();
    },
  };
}

module.exports = { createSupplierStatusSync, parseStatusRows, supplierKey, gateOf, loadMap, PREFIX, SETTING };
