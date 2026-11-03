// Inventory page (3 Nov): reads Mr Eve's newest daily plan sheet and the Payment_Approvals sheet
// from Google Drive with a service account – read only, no extra packages (same signed-JWT sign-in
// as the sales sheet, src/sheets/google.js, but with the read-only Drive scope so it can find the
// newest sheet in the Inputs folder and export it as CSV).
//
// Key: INVENTORY_GOOGLE_SERVICE_ACCOUNT_JSON (Railway – the whole key file's text) or
// INVENTORY_GOOGLE_SERVICE_ACCOUNT_FILE (laptop). When neither is set, the sales sheet's key
// (GOOGLE_SERVICE_ACCOUNT_JSON / _FILE) is used, so one key can do both.
// The service account needs Viewer on the Inventory Agent Inputs folder (shared drive).
//
// Answers are kept for 5 minutes, so opening the page often doesn't call Google each time;
// "Check Drive now" on the page skips the wait (at most every 20 seconds).

const { loadServiceAccount, getAccessToken } = require('../sheets/google');

const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.readonly';
const DRIVE = 'https://www.googleapis.com/drive/v3/files';
const SHEET_MIME = 'application/vnd.google-apps.spreadsheet';

function loadInventoryAccount(env = process.env) {
  const own = loadServiceAccount({
    GOOGLE_SERVICE_ACCOUNT_JSON: env.INVENTORY_GOOGLE_SERVICE_ACCOUNT_JSON,
    GOOGLE_SERVICE_ACCOUNT_FILE: env.INVENTORY_GOOGLE_SERVICE_ACCOUNT_FILE,
  });
  return own || loadServiceAccount(env);
}

const idOk = (id) => /^[A-Za-z0-9_-]{10,100}$/.test(String(id || ''));

async function driveGet(url, token, fetchImpl, what, email) {
  const res = await fetchImpl(url, { headers: { authorization: `Bearer ${token}` } });
  if (res.ok) return res;
  const body = await res.json().catch(() => ({}));
  const msg = body.error && body.error.message ? body.error.message : `HTTP ${res.status}`;
  if (res.status === 403 || res.status === 404) {
    throw new Error(`The app can't open ${what}. Share the Inventory Agent Inputs folder (Viewer) with ${email}. Google said: ${msg}`);
  }
  throw new Error(`Reading ${what} from Google Drive failed: ${msg}`);
}

// Newest sheet in the folder whose name starts with the prefix ("Mr Eve Daily Plan").
async function newestPlan({ token, folderId, prefix, fetchImpl, email }) {
  const q = `'${folderId}' in parents and name contains '${prefix.replace(/'/g, "\\'")}' and mimeType = '${SHEET_MIME}' and trashed = false`;
  const qs = new URLSearchParams({
    q, orderBy: 'modifiedTime desc', pageSize: '20', fields: 'files(id,name,modifiedTime)',
    supportsAllDrives: 'true', includeItemsFromAllDrives: 'true',
  });
  const res = await driveGet(`${DRIVE}?${qs}`, token, fetchImpl, 'the Inputs folder', email);
  const files = ((await res.json()).files || [])
    .filter((f) => String(f.name || '').toLowerCase().startsWith(prefix.toLowerCase()))
    .sort((a, b) => String(b.modifiedTime).localeCompare(String(a.modifiedTime)));
  if (!files.length) throw new Error(`No sheet called "${prefix} …" in the Inventory Agent Inputs folder yet.`);
  return files[0];
}

async function exportCsv({ token, id, fetchImpl, what, email }) {
  const qs = new URLSearchParams({ mimeType: 'text/csv', supportsAllDrives: 'true' });
  const res = await driveGet(`${DRIVE}/${encodeURIComponent(id)}/export?${qs}`, token, fetchImpl, what, email);
  return res.text();
}

// settings: { inputs_folder_id, payment_approvals_id, plan_title_prefix } (app_settings inventory_board).
function createInventorySource({ env = process.env, fetchImpl = fetch, now = () => new Date(), ttlMs = 5 * 60 * 1000, account } = {}) {
  let acct; let acctError = null;
  try { acct = account !== undefined ? account : loadInventoryAccount(env); } catch (err) { acct = null; acctError = err.message; }
  let cache = null; // { key, at, value }
  let inflight = null;

  async function fetchAll(settings) {
    const folderId = settings.inputs_folder_id; const payId = settings.payment_approvals_id;
    const prefix = settings.plan_title_prefix || 'Mr Eve Daily Plan';
    if (!idOk(folderId) || !idOk(payId)) throw new Error('The Inputs folder or the Payment_Approvals sheet id is missing in app_settings inventory_board.');
    const token = await getAccessToken(acct, fetchImpl, DRIVE_SCOPE);
    const file = await newestPlan({ token, folderId, prefix, fetchImpl, email: acct.email });
    const [planCsv, paymentsCsv] = await Promise.all([
      exportCsv({ token, id: file.id, fetchImpl, what: `the sheet "${file.name}"`, email: acct.email }),
      exportCsv({ token, id: payId, fetchImpl, what: 'the Payment_Approvals sheet', email: acct.email }),
    ]);
    return { planFile: { id: file.id, name: file.name, modifiedTime: file.modifiedTime }, planCsv, paymentsCsv };
  }

  return {
    configured: () => Boolean(acct),
    status: () => ({ configured: Boolean(acct), email: acct ? acct.email : null, keyError: acctError }),
    // → { planFile, planCsv, paymentsCsv, fetchedAt, cached } – throws with a message to show on the page.
    async load(settings, { force = false } = {}) {
      if (!acct) throw new Error(acctError || 'No Google service account key is set up for the Inventory page yet.');
      const key = JSON.stringify([settings.inputs_folder_id, settings.payment_approvals_id, settings.plan_title_prefix]);
      const t = now().getTime();
      const fresh = cache && cache.key === key && (t - cache.at < (force ? 20 * 1000 : ttlMs));
      if (fresh) return { ...cache.value, fetchedAt: new Date(cache.at), cached: true };
      if (!inflight) {
        inflight = fetchAll(settings)
          .then((value) => { cache = { key, at: now().getTime(), value }; return cache; })
          .finally(() => { inflight = null; });
      }
      const c = await inflight;
      return { ...c.value, fetchedAt: new Date(c.at), cached: false };
    },
  };
}

module.exports = { createInventorySource, loadInventoryAccount, DRIVE_SCOPE };
