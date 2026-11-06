// 6 Nov: saves each scanned invoice PDF in the P4U Finance inbox folder on Google Drive (Shared drive),
// in a subfolder per month (YYYY-MM, made when missing), for Mr Eve. Right after the save, and again
// every 15 minutes for any that didn't make it (the PDF waits in the database until then).
// Folder: app_settings invoice_drive {folder_id}; default the Finance inbox below.
// Key: INVENTORY_GOOGLE_SERVICE_ACCOUNT_JSON / _FILE, else GOOGLE_SERVICE_ACCOUNT_JSON / _FILE (the
// service account needs Content manager on the Shared drive or folder).

const { loadServiceAccount, getAccessToken } = require('../sheets/google');

const SCOPE = 'https://www.googleapis.com/auth/drive';
const FILES = 'https://www.googleapis.com/drive/v3/files';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files';
const DEFAULT_FOLDER = '1bAMclSUrp9QGqEHyZS4yktxNQEVuravB';

function loadAccount(env = process.env) {
  return loadServiceAccount({ GOOGLE_SERVICE_ACCOUNT_JSON: env.INVENTORY_GOOGLE_SERVICE_ACCOUNT_JSON, GOOGLE_SERVICE_ACCOUNT_FILE: env.INVENTORY_GOOGLE_SERVICE_ACCOUNT_FILE })
    || loadServiceAccount(env);
}

async function check(res, email) {
  if (res.ok) return res;
  const body = await res.json().catch(() => ({}));
  const msg = body.error && body.error.message ? body.error.message : `HTTP ${res.status}`;
  if (res.status === 403 || res.status === 404) throw new Error(`The app can't write to the Finance inbox folder. Give ${email} Content manager on it. Google said: ${msg}`);
  throw new Error(`Google Drive: ${msg}`);
}

function createInvoiceDrive(db, { env = process.env, fetchImpl = fetch, now = () => new Date(), log = console.log, account } = {}) {
  let acct = null; let keyError = null;
  try { acct = account !== undefined ? account : loadAccount(env); } catch (err) { keyError = err.message; }
  const monthFolders = new Map();

  async function folderId() {
    const r = (await db.query("SELECT value FROM app_settings WHERE key = 'invoice_drive'")).rows[0];
    try { return (JSON.parse(r ? r.value : '{}') || {}).folder_id || DEFAULT_FOLDER; } catch { return DEFAULT_FOLDER; }
  }

  async function monthFolder(token, parent, month) {
    const k = `${parent}/${month}`;
    if (monthFolders.has(k)) return monthFolders.get(k);
    const q = `'${parent}' in parents and name = '${month}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`;
    const qs = new URLSearchParams({ q, fields: 'files(id)', supportsAllDrives: 'true', includeItemsFromAllDrives: 'true', pageSize: '5' });
    const found = ((await (await check(await fetchImpl(`${FILES}?${qs}`, { headers: { authorization: `Bearer ${token}` } }), acct.email)).json()).files || [])[0];
    let id = found && found.id;
    if (!id) {
      const res = await fetchImpl(`${FILES}?supportsAllDrives=true&fields=id`, { method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ name: month, mimeType: 'application/vnd.google-apps.folder', parents: [parent] }) });
      id = (await (await check(res, acct.email)).json()).id;
    }
    monthFolders.set(k, id);
    return id;
  }

  // Uploads one invoice's PDF; on success the PDF is cleared from the database.
  async function upload(id) {
    const inv = (await db.query('SELECT id, file_name, invoice_date, pdf FROM invoices WHERE id = $1', [id])).rows[0];
    if (!inv || !inv.pdf) return { skipped: true };
    try {
      if (!acct) throw new Error(keyError || 'No Google service account key set (GOOGLE_SERVICE_ACCOUNT_JSON).');
      const token = await getAccessToken(acct, fetchImpl, SCOPE);
      const month = String(inv.invoice_date instanceof Date ? inv.invoice_date.toISOString() : inv.invoice_date).slice(0, 7);
      const parent = await monthFolder(token, await folderId(), month);
      const boundary = `p4u${Date.now()}${Math.random().toString(16).slice(2)}`;
      const meta = JSON.stringify({ name: inv.file_name, mimeType: 'application/pdf', parents: [parent] });
      const body = Buffer.concat([
        Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n--${boundary}\r\nContent-Type: application/pdf\r\n\r\n`),
        Buffer.from(inv.pdf), Buffer.from(`\r\n--${boundary}--\r\n`)]);
      const res = await fetchImpl(`${UPLOAD}?uploadType=multipart&supportsAllDrives=true&fields=id,webViewLink`, { method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': `multipart/related; boundary=${boundary}` }, body });
      const f = await (await check(res, acct.email)).json();
      await db.query('UPDATE invoices SET drive_file_id = $2, drive_link = $3, drive_saved_at = $4, drive_error = NULL, pdf = NULL WHERE id = $1',
        [id, f.id, f.webViewLink || `https://drive.google.com/file/d/${f.id}/view`, now().toISOString()]);
      return { ok: true, fileId: f.id };
    } catch (err) {
      await db.query('UPDATE invoices SET drive_error = $2 WHERE id = $1', [id, String(err.message).slice(0, 500)]);
      log(`Invoice ${id} to Drive: ${err.message}`);
      return { error: err.message };
    }
  }

  // The file back from Drive (to view an invoice whose PDF is no longer in the database).
  async function download(fileId) {
    if (!acct) throw new Error('No Google service account key set.');
    const token = await getAccessToken(acct, fetchImpl, SCOPE);
    const res = await check(await fetchImpl(`${FILES}/${encodeURIComponent(fileId)}?alt=media&supportsAllDrives=true`, { headers: { authorization: `Bearer ${token}` } }), acct.email);
    return Buffer.from(await res.arrayBuffer());
  }

  async function retryPending() {
    const ids = (await db.query('SELECT id FROM invoices WHERE pdf IS NOT NULL AND drive_file_id IS NULL ORDER BY id LIMIT 20')).rows.map((r) => r.id);
    for (const id of ids) await upload(id);
    return ids.length;
  }

  function schedule(minutes = 15) {
    const t = setInterval(() => retryPending().catch((err) => log(`Invoices to Drive: ${err.message}`)), minutes * 60 * 1000);
    if (t.unref) t.unref();
    return t;
  }

  return { upload, download, retryPending, schedule, configured: () => Boolean(acct), email: () => (acct ? acct.email : null) };
}

module.exports = { createInvoiceDrive, DEFAULT_FOLDER };
