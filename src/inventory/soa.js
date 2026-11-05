// 5 Nov 2026 (CEO): "update in 4DX the status based on the SOA in this folder" – the suppliers'
// Statement of Account files in Google Drive (one folder per supplier, each with an "SOA …" sheet /
// .xlsx that the team keeps: invoice, amount, due date, PAYMENT STATUS, date paid, PV number).
// The app reads every supplier folder's SOA every 6 hours (and on "Check SOA now"), keeps the invoices
// (inv_soa) and shows per supplier: unpaid, overdue (unpaid past its due date), oldest overdue, next
// due, last paid – on Ordering & payments, next to "Can I order", and it opens a supplier marked
// "After SOA check" once its SOA has nothing overdue.
//
// Reading an SOA (the sheets differ a little): every header row with INVOICE NO. starts a table;
// columns by their header (invoice date, invoice no., amount, CN amount, due date, payment status,
// date paid, PV / payment request; proforma no. / amount for CBD suppliers). A row is
//   • paid    – status PAID, or no status but a date paid or a PV number (CBD orders paid up front);
//   • unpaid  – status UNPAID / PARTIAL / anything else, or no status, date paid or PV;
// credit notes (invoice no. with "CN") count as minus. Due date = the due date, else the invoice date.

const { getAccessToken } = require('../sheets/google');
const { loadAccount } = require('./drive');

const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.readonly';
const DRIVE = 'https://www.googleapis.com/drive/v3/files';
const DEFAULT_FOLDER = '1mu3SKZ9Bdtc6tOr3tDB3ZFk0spW-qTRN';
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const GSHEET = 'application/vnd.google-apps.spreadsheet';

// ---------- reading cells ----------
function cellText(v) {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === 'object') {
    if (v.result !== undefined) return cellText(v.result);
    if (v.richText) return v.richText.map((t) => t.text).join('');
    if (v.text !== undefined) return cellText(v.text);
    if (v.error) return '';
    return '';
  }
  return String(v).trim();
}
const num = (v) => { const s = String(v ?? '').replace(/[^0-9.\-]/g, ''); if (!s || s === '-' || s === '.') return null; const n = Number(s); return Number.isFinite(n) ? n : null; };
// "12/07/2026", "1/3/26", "2026-07-12", Excel serial 46215 → YYYY-MM-DD
function isoDate(v) {
  const s = String(v ?? '').trim();
  if (!s) return null;
  let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = /^(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{2}|\d{4})$/.exec(s);
  if (m) {
    const y = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
    const d = Number(m[1]); const mo = Number(m[2]);
    if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
    return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  }
  if (/^\d{5}(\.\d+)?$/.test(s)) { const n = Number(s); if (n > 40000 && n < 60000) return new Date(Date.UTC(1899, 11, 30) + Math.floor(n) * 86400000).toISOString().slice(0, 10); }
  return null;
}

// ---------- the SOA table ----------
const has = (cells, re) => cells.findIndex((c) => re.test(c));
function headerMap(row, next) {
  const c = row.map((x) => x.toUpperCase().replace(/\s+/g, ' ').trim());
  const n = (next || []).map((x) => x.toUpperCase().replace(/\s+/g, ' ').trim());
  const invNo = has(c, /INVOICE NO/);
  const amounts = c.map((x, i) => (/^AMOUNT\s*(\(RM\))?$/.test(x) ? i : -1)).filter((i) => i >= 0);
  const pick = (re) => { const i = has(c, re); return i >= 0 ? i : has(n, re); };
  return {
    invDate: has(c, /INVOICE DATE/), invNo,
    amount: amounts.find((i) => i > invNo) ?? amounts[0] ?? -1,
    proAmount: amounts.find((i) => i < invNo) ?? -1,
    proNo: has(c, /PROFORMA.*(NO|INVOICE$)|ORDERING NO|^PROFORMA INVOICE$/),
    proDate: has(c, /(PROFORMA|ORDERING).*DATE/),
    cn: pick(/CN AMOUNT/),
    due: has(c, /DUE DATE/), status: has(c, /STATUS/), paidDate: has(c, /DATE PAID/),
    pv: has(c, /PV|PAYMENT REQUEST/),
  };
}
const isHeader = (row) => row.some((x) => /INVOICE NO/i.test(x)) && row.some((x) => /STATUS|DATE PAID|PV/i.test(x));
const isYear = (row) => row.some((x) => /^\s*(\d{4}\s+)?YEAR\s+\d{4}/i.test(x));

// rows: arrays of cell values (one sheet after another) → invoices
function parseSoa(rows) {
  const out = []; const seen = new Set();
  let map = null;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i].map(cellText);
    if (isHeader(row)) { map = headerMap(row, rows[i + 1] ? rows[i + 1].map(cellText) : []); continue; }
    if (isYear(row)) { map = null; continue; }
    if (!map) continue;
    const at = (k) => (map[k] >= 0 ? row[map[k]] || '' : '');
    let ref = at('invNo') || at('proNo');
    if (!ref || /^(CN DATE|CN NO|INVOICE|TOTAL)/i.test(ref)) continue;
    let amount = num(at('amount'));
    if (amount === null) amount = num(at('proAmount'));
    if (amount === null || amount === 0) continue;
    const cn = num(at('cn')) || 0;
    const isCn = /(^|\W|\))CN\d|CREDIT/i.test(ref);
    amount = isCn ? -Math.abs(amount) : amount - Math.abs(cn);
    const st = at('status').toUpperCase();
    const paidDate = isoDate(at('paidDate'));
    const pv = at('pv');
    let state;
    if (/^PAID/.test(st)) state = 'paid';
    else if (st) state = 'unpaid';
    else state = paidDate || /PV|\d{4}-\d/i.test(pv) ? 'paid' : 'unpaid';
    const key = `${ref}|${amount}`;
    if (seen.has(key)) continue; seen.add(key);
    out.push({ ref: ref.slice(0, 60), date: isoDate(at('invDate')) || isoDate(at('proDate')), due: isoDate(at('due')) || isoDate(at('invDate')) || isoDate(at('proDate')),
      amount: Math.round(amount * 100) / 100, state, status: st || null, paid_date: paidDate, pv: pv.slice(0, 40) || null });
  }
  return out;
}

// Invoices + today → the supplier's position.
function summarise(invoices, today) {
  const unpaid = invoices.filter((x) => x.state === 'unpaid');
  const overdue = unpaid.filter((x) => x.due && x.due < today);
  const upcoming = unpaid.filter((x) => !x.due || x.due >= today).map((x) => x.due).filter(Boolean).sort();
  const paidDates = invoices.map((x) => x.paid_date).filter(Boolean).sort();
  const sum = (a) => Math.round(a.reduce((s, x) => s + x.amount, 0) * 100) / 100;
  return {
    invoices: invoices.length, unpaid_n: unpaid.length, unpaid: sum(unpaid), overdue_n: overdue.length, overdue: sum(overdue),
    oldest_due: overdue.map((x) => x.due).sort()[0] || null, next_due: upcoming[0] || null, last_paid: paidDates[paidDates.length - 1] || null,
  };
}

// "(CONSIGNMENT) MOMMYHANA" → { name: 'MOMMYHANA', consignment: true }
function folderName(n) {
  const consignment = /consignment/i.test(n);
  return { name: String(n || '').replace(/\(\s*consignment\s*\)/i, '').trim(), consignment };
}

// ---------- database ----------
async function loadAll(db, today) {
  const { rows } = await db.query('SELECT * FROM inv_soa ORDER BY supplier');
  const keyOf = require('./data').keyOf;
  return rows.map((r) => {
    let inv = []; try { inv = JSON.parse(r.invoices || '[]'); } catch { inv = []; }
    return { ...r, key: keyOf(r.supplier), ...summarise(inv, today), rows: inv };
  }).sort((a, b) => b.overdue - a.overdue || b.unpaid - a.unpaid || a.supplier.localeCompare(b.supplier));
}

// ---------- the Drive sync ----------
function createSoaSync(db, { env = process.env, fetchImpl = fetch, now = () => new Date(), log = console.log, account } = {}) {
  let acct = null; let keyError = null;
  try { acct = account !== undefined ? account : loadAccount(env); } catch (err) { keyError = err.message; }
  let running = null; let lastForced = 0;

  async function folderId() {
    const r = (await db.query("SELECT value FROM app_settings WHERE key = 'inventory_soa'")).rows[0];
    try { return (JSON.parse(r ? r.value : '{}') || {}).folder_id || DEFAULT_FOLDER; } catch { return DEFAULT_FOLDER; }
  }
  async function saveStatus(st) {
    await db.query(`INSERT INTO app_settings (key, value) VALUES ('inventory_soa_status', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [JSON.stringify(st)]);
  }
  async function status() {
    const r = (await db.query("SELECT value FROM app_settings WHERE key = 'inventory_soa_status'")).rows[0];
    let st = {}; try { st = JSON.parse(r ? r.value : '{}') || {}; } catch { st = {}; }
    return { configured: Boolean(acct), email: acct ? acct.email : null, keyError, folder_id: await folderId(), ...st };
  }
  async function get(url, token) {
    const res = await fetchImpl(url, { headers: { authorization: `Bearer ${token}` } });
    if (res.ok) return res;
    const body = await res.json().catch(() => ({}));
    const msg = body.error && body.error.message ? body.error.message : `HTTP ${res.status}`;
    if (res.status === 403 || res.status === 404) throw new Error(`The app can't open the SOA folder. Share it (Viewer) with ${acct.email}. Google said: ${msg}`);
    throw new Error(`Reading Google Drive failed: ${msg}`);
  }
  async function list(token, q) {
    const out = []; let pageToken = '';
    do {
      const qs = new URLSearchParams({ q, pageSize: '1000', fields: 'nextPageToken,files(id,name,mimeType,modifiedTime)', supportsAllDrives: 'true', includeItemsFromAllDrives: 'true' });
      if (pageToken) qs.set('pageToken', pageToken);
      const j = await (await get(`${DRIVE}?${qs}`, token)).json();
      out.push(...(j.files || [])); pageToken = j.nextPageToken || '';
    } while (pageToken);
    return out;
  }
  async function readRows(token, f) {
    const url = f.mimeType === GSHEET ? `${DRIVE}/${encodeURIComponent(f.id)}/export?${new URLSearchParams({ mimeType: XLSX, supportsAllDrives: 'true' })}`
      : `${DRIVE}/${encodeURIComponent(f.id)}?alt=media&supportsAllDrives=true`;
    const buf = Buffer.from(await (await get(url, token)).arrayBuffer());
    const ExcelJS = require('exceljs');
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf);
    const rows = [];
    for (const ws of wb.worksheets) {
      ws.eachRow({ includeEmpty: false }, (row) => { const r = []; row.eachCell({ includeEmpty: true }, (c, i) => { r[i - 1] = c.value; }); rows.push(Array.from(r, (x) => x ?? '')); });
    }
    return rows;
  }

  async function run() {
    const at = now().toISOString();
    try {
      const token = await getAccessToken(acct, fetchImpl, DRIVE_SCOPE);
      const root = await folderId();
      const folders = await list(token, `'${root}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`);
      // Drive answers an empty list (not an error) when the folder isn't shared with the app.
      if (!folders.length) throw new Error(`No supplier folders visible. Share the SOA folder (Viewer) with ${acct.email}.`);
      const known = new Map((await db.query('SELECT folder_id, file_id, file_modified FROM inv_soa')).rows.map((r) => [r.folder_id, r]));
      let read = 0; let same = 0; let none = 0; const problems = [];
      for (const fo of folders) {
        const { name, consignment } = folderName(fo.name);
        try {
          const files = (await list(token, `'${fo.id}' in parents and trashed = false and (mimeType = '${XLSX}' or mimeType = '${GSHEET}')`))
            .sort((a, b) => Number(/soa/i.test(b.name)) - Number(/soa/i.test(a.name)) || String(b.modifiedTime).localeCompare(String(a.modifiedTime)));
          const f = files[0];
          if (!f) { none++; await db.query(`INSERT INTO inv_soa (folder_id, supplier, consignment, file_id, file_name, file_modified, invoices, checked_at, error) VALUES ($1,$2,$3,NULL,NULL,NULL,'[]',$4,'No SOA sheet in the folder')
            ON CONFLICT (folder_id) DO UPDATE SET supplier = EXCLUDED.supplier, consignment = EXCLUDED.consignment, checked_at = EXCLUDED.checked_at, error = EXCLUDED.error`, [fo.id, name, consignment, at]); continue; }
          const k = known.get(fo.id);
          if (k && k.file_id === f.id && k.file_modified === f.modifiedTime) { same++; await db.query('UPDATE inv_soa SET checked_at = $2, supplier = $3 WHERE folder_id = $1', [fo.id, at, name]); continue; }
          const invoices = parseSoa(await readRows(token, f));
          await db.query(`INSERT INTO inv_soa (folder_id, supplier, consignment, file_id, file_name, file_modified, invoices, checked_at, error) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
            ON CONFLICT (folder_id) DO UPDATE SET supplier = EXCLUDED.supplier, consignment = EXCLUDED.consignment, file_id = EXCLUDED.file_id, file_name = EXCLUDED.file_name,
            file_modified = EXCLUDED.file_modified, invoices = EXCLUDED.invoices, checked_at = EXCLUDED.checked_at, error = EXCLUDED.error`,
          [fo.id, name, consignment, f.id, f.name, f.modifiedTime, JSON.stringify(invoices), at, invoices.length ? null : 'No invoice rows found – check the SOA layout']);
          read++;
        } catch (err) { problems.push(`${name}: ${err.message}`); }
      }
      // Folders that are gone from Drive drop off.
      const ids = folders.map((f) => f.id);
      if (ids.length) await db.query('DELETE FROM inv_soa WHERE NOT (folder_id = ANY($1))', [ids]);
      await saveStatus({ checked_at: at, folders: folders.length, read, same, none, problems: problems.slice(0, 10), error: null });
      log(`Inventory SOA: ${folders.length} supplier folders (${read} read, ${same} unchanged).`);
      return { ok: true, folders: folders.length, read, same, problems };
    } catch (err) {
      const prev = await status().catch(() => ({}));
      await saveStatus({ checked_at: at, folders: prev.folders, read: 0, error: err.message });
      throw err;
    }
  }

  return {
    configured: () => Boolean(acct),
    status,
    async syncNow({ force = false } = {}) {
      if (!acct) return { error: keyError || 'not set up' };
      if (force && Date.now() - lastForced < 20 * 1000 && running) return running;
      if (force) lastForced = Date.now();
      if (!running) running = run().finally(() => { running = null; });
      return running;
    },
    schedule(minutes = 360) {
      if (!acct) { log('Inventory: SOA sync off (no service account key).'); return; }
      const go = () => this.syncNow().catch((err) => log(`Inventory SOA sync failed: ${err.message}`));
      setTimeout(go, 60 * 1000).unref();
      setInterval(go, minutes * 60 * 1000).unref();
    },
  };
}

module.exports = { parseSoa, summarise, isoDate, cellText, folderName, loadAll, createSoaSync, DEFAULT_FOLDER };
