// 3 Nov 2026 (CEO): estimated sales lost to out of stock – "so it becomes visible to everyone in
// charge and they push to get the products".
//
// Estimate per report = the item's selling price (Dynamod Price 1) × customers turned away, where
// customers = the "customers asking" the branch ticked (1–2 counts as 2, 3+ as 3) and at least 1 –
// a report means someone needed it. Cancelled reports don't count; B2B items aren't in a branch's
// number. The price comes from the picked product, else a product with exactly the same description;
// items with no price are counted as "no price" (the RM total leaves them out).

const PRICE_SQL = `COALESCE(pr.price1, (SELECT x.price1 FROM products x WHERE lower(x.description) = lower(o.item) AND x.price1 IS NOT NULL LIMIT 1))`;
const customersFor = (it) => Math.max(Number(it.customers_count) || 0, 1);
const lossFor = (it) => (it.status === 'Cancelled' || it.product_price === null || it.product_price === undefined ? null
  : Math.round(Number(it.product_price) * customersFor(it) * 100) / 100);

const OPEN = ['Open', 'Ordered', 'On the way', 'Substitute offered'];

// Reports made from `from` to `to` (YYYY-MM-DD, Malaysia days, to exclusive) – per branch and in all.
async function lossBetween(db, { from, to, branchCode = null }) {
  const { rows } = await db.query(`SELECT o.id, o.item, o.status, o.customers_count, o.reported_at, b.code AS branch_code, ${PRICE_SQL} AS product_price
    FROM oos_items o JOIN branches b ON b.id = o.branch_id LEFT JOIN products pr ON pr.id = o.product_id
    WHERE o.status <> 'Cancelled' AND o.reported_at >= ($1::date)::timestamp AT TIME ZONE 'Asia/Kuala_Lumpur'
      AND o.reported_at < ($2::date)::timestamp AT TIME ZONE 'Asia/Kuala_Lumpur' ${branchCode ? 'AND b.code = $3' : ''}`,
  branchCode ? [from, to, branchCode] : [from, to]);
  const branches = {};
  const all = { total: 0, items: rows.length, priced: 0, unpriced: 0, open: 0, openTotal: 0 };
  const items = [];
  for (const r of rows) {
    const b = branches[r.branch_code] || (branches[r.branch_code] = { code: r.branch_code, total: 0, items: 0, priced: 0, unpriced: 0, open: 0, openTotal: 0 });
    const loss = lossFor(r); const open = OPEN.includes(r.status);
    for (const x of [b, all]) {
      if (x !== all) x.items++;
      if (loss === null) x.unpriced++; else { x.priced++; x.total += loss; }
      if (open) { x.open++; if (loss) x.openTotal += loss; }
    }
    if (loss) items.push({ id: r.id, item: r.item, branch: r.branch_code, loss, customers: customersFor(r), open });
  }
  const round = (x) => { x.total = Math.round(x.total); x.openTotal = Math.round(x.openTotal); return x; };
  // Same item in several reports → one line (biggest first).
  const byItem = new Map();
  for (const it of items) {
    const k = it.item.toLowerCase();
    const e = byItem.get(k) || { item: it.item, loss: 0, reports: 0, branches: new Set(), open: false, id: it.id };
    e.loss += it.loss; e.reports++; e.branches.add(it.branch); e.open = e.open || it.open; byItem.set(k, e);
  }
  const top = [...byItem.values()].sort((a, b) => b.loss - a.loss).slice(0, 5).map((e) => ({ ...e, loss: Math.round(e.loss), branches: [...e.branches] }));
  return { ...round(all), branches: Object.values(branches).map(round).sort((a, b) => b.total - a.total), top };
}

function monthRange(today) {
  const month = today.slice(0, 7);
  const [y, m] = month.split('-').map(Number);
  const next = new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 10);
  return { from: `${month}-01`, to: next, month, monthName: new Date(`${month}-01T00:00:00Z`).toLocaleDateString('en-GB', { timeZone: 'UTC', month: 'long' }) };
}

module.exports = { PRICE_SQL, lossFor, customersFor, lossBetween, monthRange };
