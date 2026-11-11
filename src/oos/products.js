// 3 Nov 2026 (CEO / Alia): out-of-stock items are picked from the Dynamod product masterlist
// (stock ID, barcode, description, UOM) so Inventory orders exactly what the branch means.
// The list ships with the app (src/db/imports/products-*.json, loaded once) and Inventory can
// upload a newer Dynamod export (.xlsx) on /oos/products – rows are matched by barcode.

const path = require('path');
const { mentionsSalary } = require('../privacy');

const searchText = (p) => [p.description, p.generic, p.brand, p.stock_id, p.barcode].filter(Boolean).join(' ').toLowerCase();

// rows: [{ active, stock_id, barcode, description, uom, generic, brand, group_desc, category }]
// 11 Nov: balance = "Balance Quantity (UOM)" from Alia's weekly stock export (zakat quotations:
// Readystock / Pre-order). A file without that column leaves the balances as they are.
async function upsertProducts(db, rows, { deactivateMissing = false } = {}) {
  let added = 0; let updated = 0;
  const seen = new Set();
  await db.transaction(async (tx) => {
    const existing = new Map((await tx.query('SELECT id, barcode, description, uom, active, cost, price1, price2, balance FROM products')).rows.map((r) => [r.barcode, r]));
    // 3 Nov: Cost / Price 1 / Price 2 from the Dynamod export (blank = keep what we have).
    const money = (v) => { if (v === undefined || v === null || String(v).trim() === '') return null; const n = Number(String(v).replace(/[^0-9.\-]/g, '')); return Number.isFinite(n) ? n : null; };
    const same = (a, b) => (a === null || a === undefined ? null : Number(a)) === b;
    for (const r of rows) {
      if (!r.barcode || !r.description || seen.has(r.barcode)) continue;
      if (mentionsSalary(r.description, r.generic || '')) continue;
      seen.add(r.barcode);
      const active = r.active !== 'N';
      const ex = existing.get(r.barcode);
      const cost = money(r.cost); const p1 = money(r.price1); const p2 = money(r.price2); const bal = money(r.balance);
      const vals = [r.barcode, r.stock_id, r.description, r.uom || null, r.generic || null, r.brand || null, r.group_desc || null, r.category || null, active, searchText(r), cost, p1, p2, bal];
      if (!ex) {
        await tx.query(`INSERT INTO products (barcode, stock_id, description, uom, generic, brand, group_desc, category, active, search, cost, price1, price2, balance, balance_at)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14, CASE WHEN $14::numeric IS NULL THEN NULL ELSE now() END)`, vals);
        added++;
      } else if (ex.description !== r.description || ex.uom !== (r.uom || null) || ex.active !== active
        || (cost !== null && !same(ex.cost, cost)) || (p1 !== null && !same(ex.price1, p1)) || (p2 !== null && !same(ex.price2, p2))
        || bal !== null) {
        await tx.query(`UPDATE products SET stock_id = $2, description = $3, uom = $4, generic = $5, brand = $6, group_desc = $7, category = $8, active = $9, search = $10,
          cost = COALESCE($11, cost), price1 = COALESCE($12, price1), price2 = COALESCE($13, price2),
          balance = COALESCE($14, balance), balance_at = CASE WHEN $14::numeric IS NULL THEN balance_at ELSE now() END, updated_at = now() WHERE barcode = $1`, vals);
        updated++;
      }
    }
    if (deactivateMissing && seen.size) {
      const gone = [...existing.keys()].filter((b) => !seen.has(b));
      if (gone.length) await tx.query('UPDATE products SET active = false WHERE barcode = ANY($1)', [gone]);
    }
  });
  return { added, updated, total: seen.size };
}

async function loadBundledOnce(db, log = () => {}) {
  const flag = 'products_20261102_v1';
  if ((await db.query('SELECT 1 FROM app_settings WHERE key = $1', [flag])).rows.length) return;
  const data = require(path.join(__dirname, '..', 'db', 'imports', 'products-2026-11-02.json'));
  const rows = data.rows.map((r) => Object.fromEntries(data.columns.map((c, i) => [c, r[i]])));
  const res = await upsertProducts(db, rows);
  await db.query('INSERT INTO app_settings (key, value) VALUES ($1, $2)', [flag, JSON.stringify({ source: data.source, at: new Date().toISOString(), ...res })]);
  log(`Products masterlist: ${res.added} added (${data.source}).`);
}

// 3 Nov (CEO): cost / Price 1 / Price 2 for the bundled list. They sit in git only encrypted
// (AES-256-GCM, key from the server's AGENT_API_TOKEN) so cost is never readable in the repo.
// Applied once when the token is there; without it (or if the token changed) nothing happens and the
// prices come with the next Dynamod upload instead.
async function loadPricesOnce(db, log = () => {}, env = process.env) {
  const flag = 'product_prices_20261103_v1';
  if ((await db.query('SELECT 1 FROM app_settings WHERE key = $1', [flag])).rows.length) return { skipped: 'done' };
  const token = env.AGENT_API_TOKEN;
  if (!token || token.length < 24) return { skipped: 'no token' };
  const crypto = require('crypto'); const zlib = require('zlib');
  const box = require(path.join(__dirname, '..', 'db', 'imports', 'product-prices-2026-11-03.enc.json'));
  let prices;
  try {
    const key = crypto.createHash('sha256').update(`${token}:product-prices`).digest();
    const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(box.iv, 'base64'));
    d.setAuthTag(Buffer.from(box.tag, 'base64'));
    prices = JSON.parse(zlib.gunzipSync(Buffer.concat([d.update(Buffer.from(box.data, 'base64')), d.final()])).toString('utf8'));
  } catch (err) { log('Product prices not loaded (the key does not match).'); return { skipped: 'key' }; }
  let updated = 0;
  await db.transaction(async (tx) => {
    for (const [barcode, [cost, p1, p2]] of Object.entries(prices)) {
      const r = await tx.query(`UPDATE products SET cost = COALESCE(cost, $2), price1 = COALESCE(price1, $3), price2 = COALESCE(price2, $4)
        WHERE barcode = $1 AND (cost IS NULL OR price1 IS NULL OR price2 IS NULL)`, [barcode, cost, p1, p2]);
      updated += r.rowCount || r.affectedRows || 0;
    }
    await tx.query('INSERT INTO app_settings (key, value) VALUES ($1, $2)', [flag, JSON.stringify({ at: new Date().toISOString(), updated })]);
  });
  log(`Product prices: ${updated} products (2.11 masterlist).`);
  return { updated };
}

// Every word must appear (description, generic, brand, stock ID or barcode); best first:
// description starting with the first word, then shorter descriptions.
// prices: true adds cost / Price 1 / Price 2 – only for the Product list page (inventory team + admin).
async function search(db, q, { limit = 20, prices = false } = {}) {
  const words = String(q || '').toLowerCase().replace(/[%_\\]/g, ' ').split(/\s+/).filter(Boolean).slice(0, 6);
  if (!words.length || words.join('').length < 2) return [];
  const conds = words.map((_, i) => `search LIKE $${i + 1}`);
  const args = words.map((w) => `%${w}%`);
  const { rows } = await db.query(
    `SELECT id, stock_id, barcode, description, uom, generic, brand${prices ? ', cost, price1, price2' : ''} FROM products
     WHERE active AND ${conds.join(' AND ')}
     ORDER BY (lower(description) LIKE $${words.length + 1}) DESC, length(description), description LIMIT ${Number(limit) || 20}`,
    [...args, `${words[0]}%`]);
  return rows;
}

async function byId(db, id) {
  return (await db.query('SELECT * FROM products WHERE id = $1', [id])).rows[0] || null;
}

// The product picked on a form: product_id (from the list), or the typed text when it is exactly
// one product's description. → { product } | { error } | { none: true } (nothing typed)
async function resolve(db, body) {
  const id = Number(body.product_id);
  if (id) {
    const p = await byId(db, id);
    if (p && p.active) return { product: p };
  }
  const typed = String(body.item || '').trim();
  if (!typed) return { none: true };
  const exact = (await db.query('SELECT * FROM products WHERE active AND lower(description) = lower($1)', [typed])).rows;
  if (exact.length === 1) return { product: exact[0] };
  return { error: 'Pick the item from the Dynamod list (type a few letters, then tap it). Not in the list? Use New item request.' };
}

async function count(db) {
  return Number((await db.query('SELECT count(*)::int AS n FROM products WHERE active')).rows[0].n);
}

// A Dynamod export (.xlsx) → rows. Header names as in the masterlist.
async function parseXlsx(buffer) {
  const ExcelJS = require('exceljs');
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  const ws = wb.worksheets[0];
  const head = {};
  ws.getRow(1).eachCell((c, i) => { head[String(c.value || '').trim().toLowerCase()] = i; });
  const col = (name) => head[name.toLowerCase()];
  const need = ['Stock ID', 'Barcode', 'Description 1'];
  const missing = need.filter((n) => !col(n));
  if (missing.length) return { error: `The file has no column ${missing.join(', ')} – export the Dynamod stock masterlist.` };
  const val = (row, name) => { const i = col(name); if (!i) return ''; const v = row.getCell(i).value; return v === null || v === undefined ? '' : String(v.text || v.result || v).trim(); };
  const rows = [];
  ws.eachRow((row, n) => { if (n > 1) rows.push(masterRow((name) => val(row, name))); });
  return { rows };
}

// One masterlist row from a cell reader (header name → text). Same columns for .xlsx and .csv.
// No "Active" column (e.g. the weekly stock export) = every row is active; Active = N rows are kept off.
function masterRow(val) {
  return { active: (val('Active') || 'Y').toUpperCase() === 'N' ? 'N' : 'Y', stock_id: val('Stock ID'), barcode: val('Barcode'), description: val('Description 1'),
    uom: val('UOM ID'), generic: val('Description 2'), brand: val('Brand Description') || val('Brand ID'),
    group_desc: val('Group Description'), category: val('Category Description') || val('Category ID'),
    cost: val('Cost'), price1: val('Price 1'), price2: val('Price 2'), balance: val('Balance Quantity (UOM)') || val('Balance Quantity') };
}

// 11 Nov: the same export as .csv (quoted fields with commas / "" allowed).
function csvRows(text) {
  const out = []; let row = []; let cell = ''; let q = false;
  const t = String(text).replace(/^\uFEFF/, '');
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (q) {
      if (c === '"' && t[i + 1] === '"') { cell += '"'; i++; } else if (c === '"') q = false; else cell += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && t[i + 1] === '\n') i++; row.push(cell); cell = ''; if (row.some((x) => x !== '')) out.push(row); row = []; }
    else cell += c;
  }
  row.push(cell); if (row.some((x) => x !== '')) out.push(row);
  return out;
}

function parseCsv(text) {
  const all = csvRows(text);
  if (!all.length) return { error: 'The file is empty.' };
  const head = {}; all[0].forEach((h, i) => { head[String(h).trim().toLowerCase()] = i; });
  const missing = ['Stock ID', 'Barcode', 'Description 1'].filter((n) => head[n.toLowerCase()] === undefined);
  if (missing.length) return { error: `The file has no column ${missing.join(', ')} – export the Dynamod stock masterlist.` };
  const rows = all.slice(1).map((r) => masterRow((name) => { const i = head[name.toLowerCase()]; return i === undefined ? '' : String(r[i] || '').trim(); }));
  return { rows };
}

module.exports = { upsertProducts, loadBundledOnce, loadPricesOnce, search, byId, resolve, count, parseXlsx, parseCsv, searchText };
