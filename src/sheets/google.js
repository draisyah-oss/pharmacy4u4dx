// Reading Google Sheets with a service account – no extra packages.
// 1. Sign a short-lived JWT with the service account's private key (RS256).
// 2. Swap it for an access token at Google's token endpoint.
// 3. Ask the Sheets API for the tabs' values.
// Only read access is requested (spreadsheets.readonly).

const crypto = require('crypto');
const fs = require('fs');

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SCOPE = 'https://www.googleapis.com/auth/spreadsheets.readonly';

// From GOOGLE_SERVICE_ACCOUNT_JSON (the whole key file's text – used on Railway) or
// GOOGLE_SERVICE_ACCOUNT_FILE (a path – handy on your laptop). Returns null if neither is set.
function loadServiceAccount(env = process.env) {
  let raw = env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!raw && env.GOOGLE_SERVICE_ACCOUNT_FILE) raw = fs.readFileSync(env.GOOGLE_SERVICE_ACCOUNT_FILE, 'utf8');
  if (!raw) return null;
  const key = JSON.parse(raw);
  if (!key.client_email || !key.private_key) throw new Error('The Google service account key is missing client_email or private_key.');
  return { email: key.client_email, privateKey: key.private_key.replace(/\\n/g, '\n') };
}

const b64url = (buf) => Buffer.from(buf).toString('base64url');

function signJwt({ email, privateKey }, nowSeconds = Math.floor(Date.now() / 1000), scope = SCOPE) {
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = b64url(JSON.stringify({ iss: email, scope, aud: TOKEN_URL, iat: nowSeconds, exp: nowSeconds + 3600 }));
  const signature = crypto.sign('RSA-SHA256', Buffer.from(`${header}.${claims}`), privateKey);
  return `${header}.${claims}.${b64url(signature)}`;
}

// scope: read-only Sheets by default; the Inventory page's Drive sync (4 Nov) asks for read-only Drive.
async function getAccessToken(account, fetchImpl = fetch, scope = SCOPE) {
  const res = await fetchImpl(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: signJwt(account, undefined, scope) }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.access_token) {
    throw new Error(`Google sign-in for the sales sheet failed: ${body.error_description || body.error || res.status}`);
  }
  return body.access_token;
}

// Returns { 'Daily sales WM': [[...], ...], ... }. Numbers come back as numbers, dates as the
// text shown in the sheet (e.g. "12/10/2026").
async function readTabs({ account, sheetId, tabs, fetchImpl = fetch }) {
  const token = await getAccessToken(account, fetchImpl);
  const qs = new URLSearchParams({ valueRenderOption: 'UNFORMATTED_VALUE', dateTimeRenderOption: 'FORMATTED_STRING' });
  for (const tab of tabs) qs.append('ranges', `'${tab.replace(/'/g, "''")}'`);
  const res = await fetchImpl(`https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(sheetId)}/values:batchGet?${qs}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = body.error && body.error.message ? body.error.message : `HTTP ${res.status}`;
    if (res.status === 403) {
      throw new Error(`The app can't open the sales sheet. Share it (Viewer) with ${account.email}. Google said: ${msg}`);
    }
    throw new Error(`Reading the sales sheet failed: ${msg}`);
  }
  const out = {};
  (body.valueRanges || []).forEach((vr, i) => { out[tabs[i]] = vr.values || []; });
  return out;
}

module.exports = { loadServiceAccount, signJwt, getAccessToken, readTabs, SCOPE, TOKEN_URL };
