// 5 Nov (CEO: "once I approve, you as Mr 4DX change it without me prompting"): 4DX writes its change
// requests into the Google Sheet "4DX change requests – Mr 4DX queue", which Mr 4DX (Claude, on a
// schedule) reads through Google Drive. 4DX is the master: the tab is rewritten a few seconds after
// every change on /requests and every 30 minutes. Typing in the sheet is overwritten.
//
// Rows: open requests (Approved first – those are Mr 4DX's to build), then the last 30 days' closed
// ones, so Mr 4DX can see what was done. Same service account as the Drive / Payment_Approvals sync,
// as Editor on the sheet. app_settings requests_queue_sheet {sheet_id, tab} overrides the default.

const { getAccessToken } = require('../sheets/google');
const { loadAccount } = require('../inventory/drive');
const rq = require('./data');

const SCOPE = 'https://www.googleapis.com/auth/spreadsheets';
const API = 'https://sheets.googleapis.com/v4/spreadsheets';
const DEFAULTS = { sheet_id: '10Kco328pm7Uk6YlFG5rS5i_GwhUaggCeOehOKj0Zy70', tab: null };
const HEADER = ['Status', '#', 'What to change', 'Part of the app', 'Why / details', 'Asked by', 'Asked', 'Approved', 'Conversation', 'Screenshot (app link)', 'Last change'];

const myt = (t) => {
  if (!t) return '';
  const d = new Date(t); if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString('en-GB', { timeZone: 'Asia/Kuala_Lumpur', day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
};

async function queueRows(db, { now = () => new Date(), appUrl = '' } = {}) {
  const { open, done } = await rq.list(db);
  const since = now().getTime() - 30 * 86400000;
  const order = { Approved: 0, 'Need more info': 1, New: 2 };
  const rows = [...open.sort((a, b) => (order[a.status] ?? 3) - (order[b.status] ?? 3) || a.id - b.id),
    ...done.filter((r) => new Date(r.updated_at).getTime() >= since)];
  const out = [HEADER];
  for (const r0 of rows) {
    const r = await rq.load(db, r0.id);
    const convo = r.notes.map((n) => `${myt(n.created_at)} ${n.who || '–'}: ${n.body}`).join('\n').slice(-4000);
    out.push([r.status, r.id, r.title, r.area, r.details || '', `${r.asked_by_name || '–'}${r.asked_from ? ` (${r.asked_from})` : ''}`,
      myt(r.created_at), r.approved_at ? `${myt(r.approved_at)} ${r.approved_by_name || ''}`.trim() : '', convo,
      r.photo_id ? `${appUrl}/oos/photo/${r.photo_id}` : '', myt(r.updated_at)]);
  }
  return out;
}

function createRequestQueue(db, { env = process.env, fetchImpl = fetch, now = () => new Date(), log = console.log, account, delayMs = 4000 } = {}) {
  let acct = null; let keyError = null;
  try { acct = account !== undefined ? account : loadAccount(env); } catch (err) { keyError = err.message; }
  const appUrl = env.APP_URL || (env.RAILWAY_PUBLIC_DOMAIN ? `https://${env.RAILWAY_PUBLIC_DOMAIN}` : '');
  let timer = null; let running = null; let again = false;

  async function settings() {
    const r = (await db.query("SELECT value FROM app_settings WHERE key = 'requests_queue_sheet'")).rows[0];
    let s = {}; try { s = JSON.parse(r ? r.value : '{}') || {}; } catch { s = {}; }
    return { ...DEFAULTS, ...s };
  }
  async function saveStatus(st) {
    await db.query(`INSERT INTO app_settings (key, value) VALUES ('requests_queue_status', $1)
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [JSON.stringify(st)]);
  }
  async function google(url, token, opts = {}) {
    const res = await fetchImpl(url, { ...opts, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...(opts.headers || {}) } });
    if (res.ok) return res.json().catch(() => ({}));
    const body = await res.json().catch(() => ({}));
    const msg = body.error && body.error.message ? body.error.message : `HTTP ${res.status}`;
    if (res.status === 403 || res.status === 404) throw new Error(`4DX can't update the Mr 4DX queue sheet. Share it with ${acct.email} as Editor. Google said: ${msg}`);
    throw new Error(`Updating the Mr 4DX queue sheet failed: ${msg}`);
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
        if (!tab) throw new Error('The Mr 4DX queue sheet has no tab.');
      }
      const q = `'${String(tab).replace(/'/g, "''")}'`;
      const values = await queueRows(db, { now, appUrl });
      await google(`${API}/${encodeURIComponent(s.sheet_id)}/values:batchClear`, token, { method: 'POST', body: JSON.stringify({ ranges: [`${q}!A1:K1000`] }) });
      // RAW: text is written as text, never run as formulas.
      await google(`${API}/${encodeURIComponent(s.sheet_id)}/values/${encodeURIComponent(`${q}!A1:K${values.length}`)}?valueInputOption=RAW`, token,
        { method: 'PUT', body: JSON.stringify({ range: `${q}!A1:K${values.length}`, majorDimension: 'ROWS', values }) });
      await saveStatus({ updated_at: at, rows: values.length - 1, error: null });
      return { ok: true, rows: values.length - 1 };
    } catch (err) {
      await saveStatus({ error: err.message, failed_at: at });
      throw err;
    }
  }
  async function syncNow() {
    if (!acct) return { error: keyError || 'not set up' };
    if (running) { again = true; return running; }
    running = run().finally(() => {
      running = null;
      if (again) { again = false; syncNow().catch((err) => log(`Mr 4DX queue: ${err.message}`)); }
    });
    return running;
  }
  return {
    configured: () => Boolean(acct),
    syncNow,
    syncSoon() {
      if (!acct) return;
      clearTimeout(timer);
      timer = setTimeout(() => syncNow().catch((err) => log(`Mr 4DX queue: ${err.message}`)), delayMs);
      if (timer.unref) timer.unref();
    },
    schedule(minutes = 30) {
      if (!acct) { log('Requests: Mr 4DX queue sheet off (no service account key).'); return; }
      const go = () => syncNow().catch((err) => log(`Mr 4DX queue: ${err.message}`));
      go();
      setInterval(go, minutes * 60 * 1000).unref();
    },
  };
}

module.exports = { createRequestQueue, queueRows, HEADER, DEFAULTS };
