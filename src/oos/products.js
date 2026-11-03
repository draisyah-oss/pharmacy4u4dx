// 3 Nov 2026 (CEO / Alia): out-of-stock items are picked from the Dynamod product masterlist
// (stock ID, barcode, description, UOM) so Inventory orders exactly what the branch means.
// The list ships with the app (src/db/imports/products-*.json, loaded once) and Inventory can
// upload a newer Dynamod export (.xlsx) on /oos/products – rows are matched by barcode.

const path = require('path');
const { mentionsSalary } = require('../privacy');

const searchText = (p) => [p.description, p.generic, p.brand, p.stock_id, p.barcode].filter(Boolean).join(' ').toLowerCase();

// rows: [{ active, stock_id, barcode, description, uom, generic, brand, group_desc, category }]
async function upsertProducts(db, rows, { deactivateMissing = false } = {}) {
  let added = 0; let updated = 0;
  const seen = new Set();
  await db.transaction(async (tx) => {
    const existing = new Map((await tx.query('SELECT id, barcode, description, uom, active, cost, price1, price2 FROM products')).rows.map((r) => [r.barcode, r]));
    // 3 Nov: Cost / Price 1 / Price 2 from the Dynamod export (blank = keep what we have).
    const money = (v) => { if (v === undefined || v === null || String(v).trim() === '') return null; const n = Number(String(v).replace(/[^0-9.\-]/g, '')); return Number.isFinite(n) ? n : null; };
    const same = (a, b) => (a === null || a === undefined ? null : Number(a)) === b;
    for (const r of rows) {
      if (!r.barcode || !r.description || seen.has(r.barcode)) continue;
      if (mentionsSalary(r.description, r.generic || '')) continue;
      seen.add(r.barcode);
      const active = r.active !== 'N';
      const ex = existing.get(r.barcode);
      const cost = money(r.cost); const p1 = money(r.price1); const p2 = money(r.price2);
      const vals = [r.barcode, r.stock_id, r.description, r.uom || null, r.generic || null, r.brand || null, r.group_desc || null, r.category || null, active, searchText(r), cost, p1, p2];
      if (!ex) {
        await tx.query(`INSERT INTO products (barcode, stock_id, description, uom, generic, brand, group_desc, category, active, search, cost, price1, price2) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`, vals);
        added++;
      } else if (ex.description !== r.description || ex.uom !== (r.uom || null) || ex.active !== active
        || (cost !== null && !same(ex.cost, cost)) || (p1 !== null && !same(ex.price1, p1)) || (p2 !== null && !same(ex.price2, p2))) {
        await tx.query(`UPDATE products SET stock_id = $2, description = $3, uom = $4, generic = $5, brand = $6, group_desc = $7, category = $8, active = $9, search = $10,
          cost = COALESCE($11, cost), price1 = COALESCE($12, price1), price2 = COALESCE($13, price2), updated_at = now() WHERE barcode = $1`, vals);
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
  ws.eachRow((row, n) => {
    if (n === 1) return;
    rows.push({ active: val(row, 'Active') || 'Y', stock_id: val(row, 'Stock ID'), barcode: val(row, 'Barcode'), description: val(row, 'Description 1'),
      uom: val(row, 'UOM ID'), generic: val(row, 'Description 2'), brand: val(row, 'Brand Description') || val(row, 'Brand ID'),
      group_desc: val(row, 'Group Description'), category: val(row, 'Category Description') || val(row, 'Category ID'),
      cost: val(row, 'Cost'), price1: val(row, 'Price 1'), price2: val(row, 'Price 2') });
  });
  return { rows };
}

module.exports = { upsertProducts, loadBundledOnce, search, byId, resolve, count, parseXlsx, searchText };
