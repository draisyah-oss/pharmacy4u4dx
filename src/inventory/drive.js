// 4 Nov (CEO: "I want the update from Mr Eve daily goes to 4DX so the team can access"):
// the app fetches Mr Eve's newest "Mr Eve Daily Plan …" sheet from the Inventory Agent Inputs folder
// in Google Drive and saves it as that day's plan on /inventory (inv_plans / inv_plan_lines) –
// every 30 minutes, and on "Check Drive now". Nothing changes on Mr Eve's side: it keeps writing
// its sheet each morning. Read only (drive.readonly); payments are not read from Drive – approvals
// and Paid are recorded in the app.
//
// Key: INVENTORY_GOOGLE_SERVICE_ACCOUNT_JSON / _FILE, else the sales sheet's GOOGLE_SERVICE_ACCOUNT_JSON /
// _FILE. The service account needs Viewer on the folder and the Google Drive API on in its project.
// Folder: app_settings inventory_drive (JSON {folder_id, prefix}); default the Inputs folder below.

const { loadServiceAccount, getAccessToken } = require('../sheets/google');
const inv = require('./data');

const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.readonly';
const DRIVE = 'https://www.googleapis.com/drive/v3/files';
const DEFAULTS = { folder_id: '1VXbTmy4QE_6aJXueJsIWkJVE-J_5DXZs', prefix: 'Mr Eve Daily Plan' };
const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

function loadAccount(env = process.env) {
  return loadServiceAccount({ GOOGLE_SERVICE_ACCOUNT_JSON: env.INVENTORY_GOOGLE_SERVICE_ACCOUNT_JSON, GOOGLE_SERVICE_ACCOUNT_FILE: env.INVENTORY_GOOGLE_SERVICE_ACCOUNT_FILE })
    || loadServiceAccount(env);
}

// CSV with quoted cells (commas, "" and line breaks inside quotes).
function parseCsv(text) {
  const src = String(text || '').replace(/^﻿/, '');
  const rows = []; let row = []; let cell = ''; let q = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (q) { if (c === '"' && src[i + 1] === '"') { cell += '"'; i++; } else if (c === '"') q = false; else cell += c; }
    else if (c === '"') q = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && src[i + 1] === '\n') i++; row.push(cell); rows.push(row); row = []; cell = ''; }
    else cell += c;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((x) => x.trim() !== ''));
}

// Sheet rows → objects keyed by the header row (what savePlan / parsePlanRows read).
function csvToRows(text) {
  const [head = [], ...body] = parseCsv(text);
  const h = head.map((x) => x.trim());
  return body.map((r) => Object.fromEntries(h.map((k, i) => [k, String(r[i] ?? '').trim()])));
}

// "Mr Eve Daily Plan 03 Nov 2026" → 2026-11-03; else the day Drive last saved it (Malaysia time).
function planDate(name, modifiedTime) {
  const m = /(\d{1,2})\s+([A-Za-z]{3})[a-z]*\s+(\d{4})/.exec(String(name || ''));
  if (m && MONTHS[m[2].toLowerCase()]) {
    const iso = `${m[3]}-${String(MONTHS[m[2].toLowerCase()]).padStart(2, '0')}-${m[1].padStart(2, '0')}`;
    const d = new Date(`${iso}T00:00:00Z`);
    if (!Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === iso) return iso;
  }
  const t = new Date(modifiedTime);
  return Number.isNaN(t.getTime()) ? null : new Date(t.getTime() + 8 * 3600 * 1000).toISOString().slice(0, 10);
}

async function driveJson(url, token, fetchImpl, email) {
  const res = await fetchImpl(url, { headers: { authorization: `Bearer ${token}` } });
  if (res.ok) return res;
  const body = await res.json().catch(() => ({}));
  const msg = body.error && body.error.message ? body.error.message : `HTTP ${res.status}`;
  if (res.status === 403 || res.status === 404) throw new Error(`The app can't open Mr Eve's folder. Share the Inventory Agent Inputs folder (Viewer) with ${email} and turn on the Google Drive API. Google said: ${msg}`);
  throw new Error(`Reading Google Drive failed: ${msg}`);
}

// onPlanLoaded(date): called after a new or changed plan is saved (4 Nov: Telegram message).
function createInventoryDrive(db, { env = process.env, fetchImpl = fetch, now = () => new Date(), log = console.log, account, onPlanLoaded = null } = {}) {
  let acct = null; let keyError = null;
  try { acct = account !== undefined ? account : loadAccount(env); } catch (err) { keyError = err.message; }
  let running = null; let lastForced = 0;

  async function settings() {
    const r = (await db.query("SELECT value FROM app_settings WHERE key = 'inventory_drive'")).rows[0];
    let s = {}; try { s = JSON.parse(r ? r.value : '{}') || {}; } catch { s = {}; }
    return { ...DEFAULTS, ...s };
  }
  async function saveStatus(st) {
    const v = JSON.stringify(st);
    await db.query(`INSERT INTO app_settings (key, value) VALUES ('inventory_drive_status', $1)
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [v]);
  }
  async function status() {
    const r = (await db.query("SELECT value FROM app_settings WHERE key = 'inventory_drive_status'")).rows[0];
    let st = {}; try { st = JSON.parse(r ? r.value : '{}') || {}; } catch { st = {}; }
    return { configured: Boolean(acct), email: acct ? acct.email : null, keyError, ...st };
  }

  // Fetch the newest plan sheet; save it when it's new or changed since the last import.
  async function run() {
    const s = await settings();
    const at = now().toISOString();
    try {
      const token = await getAccessToken(acct, fetchImpl, DRIVE_SCOPE);
      const q = `'${s.folder_id}' in parents and name contains '${String(s.prefix).replace(/'/g, "\\'")}' and mimeType = 'application/vnd.google-apps.spreadsheet' and trashed = false`;
      const qs = new URLSearchParams({ q, orderBy: 'modifiedTime desc', pageSize: '20', fields: 'files(id,name,modifiedTime)', supportsAllDrives: 'true', includeItemsFromAllDrives: 'true' });
      const files = ((await (await driveJson(`${DRIVE}?${qs}`, token, fetchImpl, acct.email)).json()).files || [])
        .filter((f) => String(f.name || '').toLowerCase().startsWith(String(s.prefix).toLowerCase()))
        .sort((a, b) => String(b.modifiedTime).localeCompare(String(a.modifiedTime)));
      if (!files.length) { await saveStatus({ checked_at: at, error: `No sheet called "${s.prefix} …" in the folder yet.` }); return { error: 'no plan sheet' }; }
      const f = files[0];
      const prev = await status();
      const date = planDate(f.name, f.modifiedTime);
      const have = (await db.query('SELECT source FROM inv_plans WHERE plan_date = $1', [date])).rows[0];
      if (prev.file_id === f.id && prev.modified === f.modifiedTime && have) {
        await saveStatus({ ...prev, checked_at: at, error: null, keyError: undefined, configured: undefined, email: undefined });
        return { ok: true, unchanged: true, date };
      }
      const ex = new URLSearchParams({ mimeType: 'text/csv', supportsAllDrives: 'true' });
      const csv = await (await driveJson(`${DRIVE}/${encodeURIComponent(f.id)}/export?${ex}`, token, fetchImpl, acct.email)).text();
      const r = await inv.savePlan(db, { date, title: f.name, rows: csvToRows(csv), source: 'Mr Eve (Google Drive)' });
      if (r.error) throw new Error(`"${f.name}": ${r.error}`);
      await saveStatus({ checked_at: at, imported_at: at, file_id: f.id, file: f.name, modified: f.modifiedTime, date, lines: r.lines, error: null });
      log(`Inventory: ${f.name} loaded from Google Drive (${r.lines} lines).`);
      if (onPlanLoaded) Promise.resolve(onPlanLoaded(date)).catch((err) => log(`After plan load: ${err.message}`));
      return { ok: true, date, lines: r.lines };
    } catch (err) {
      const prev = await status().catch(() => ({}));
      await saveStatus({ file_id: prev.file_id, file: prev.file, modified: prev.modified, date: prev.date, lines: prev.lines, imported_at: prev.imported_at, checked_at: at, error: err.message });
      throw err;
    }
  }

  return {
    configured: () => Boolean(acct),
    status,
    // force: "Check Drive now" (at most every 20 s). Concurrent calls share one run.
    async syncNow({ force = false } = {}) {
      if (!acct) return { error: keyError || 'not set up' };
      if (force && Date.now() - lastForced < 20 * 1000 && running) return running;
      if (force) lastForced = Date.now();
      if (!running) running = run().finally(() => { running = null; });
      return running;
    },
    schedule(minutes = 30) {
      if (!acct) { log('Inventory: Mr Eve Drive sync off (no service account key).'); return; }
      log(`Inventory: Mr Eve's daily plan synced from Google Drive every ${minutes} minutes as ${acct.email}.`);
      const go = () => this.syncNow().catch((err) => log(`Inventory Drive sync failed: ${err.message}`));
      go();
      setInterval(go, minutes * 60 * 1000).unref();
    },
  };
}

module.exports = { createInventoryDrive, loadAccount, csvToRows, parseCsv, planDate, DRIVE_SCOPE, DEFAULTS };
