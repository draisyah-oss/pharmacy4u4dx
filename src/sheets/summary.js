// The sales sheet's own summary tabs (2026 Sales Dashboard):
//
//   "Overall Daily Sales" – one row per day: WM, BR, JH, Bangi, Ampang, Total (till sales,
//                           the same as each branch tab's "Total" column).
//   "Total Sales"          – the yearly table: per month Retail WM / BR / JH / Bangi / Ampang
//                           (branch sales incl. zakat, Shopee, Alpine), B2B and TOTAL M.
//
// Both are read as the sheet shows them and kept in sheet_sales_summary, so the Sales view and
// the scoreboards show the same daily and year-to-date numbers HQ already uses.

const { parseNumber, parseDate } = require('./parse');

const norm = (s) => String(s ?? '').toLowerCase().replace(/\s+/g, '');
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

// branchCodes: ['WM', 'BR', 'JH', 'Bangi', 'Ampang'] – matched to headers without case/spaces;
// "Ampang" also matches "AMP".
function matchBranch(header, branchCodes) {
  const h = norm(header).replace(/^retail/, '');
  if (!h) return null;
  return branchCodes.find((c) => norm(c) === h || (h.length >= 3 && norm(c).startsWith(h))) || null;
}

// → [{ date, branches: { WM: 1146.01, … }, total }]
function parseOverallDaily(rows, branchCodes) {
  let cols = null; // { WM: idx, …, total: idx }
  const out = new Map();
  for (const row of rows || []) {
    if (!Array.isArray(row)) continue;
    const cells = row.map(norm);
    if (!cols && cells.includes('total')) {
      const found = {};
      row.forEach((c, i) => { const b = matchBranch(c, branchCodes); if (b && found[b] === undefined) found[b] = i; });
      if (Object.keys(found).length >= 2) cols = { ...found, total: cells.indexOf('total') };
      continue;
    }
    if (!cols) continue;
    const date = parseDate(row[0]);
    if (!date) continue;
    const branches = {};
    let any = false;
    for (const code of branchCodes) {
      if (cols[code] === undefined) continue;
      const n = parseNumber(row[cols[code]]);
      if (n !== null) { branches[code] = n; any = true; }
    }
    if (!any) continue; // template rows for days not reached yet
    const sum = Object.values(branches).reduce((a, n) => a + n, 0);
    const total = parseNumber(row[cols.total]);
    out.set(date, { date, branches, total: total === null ? Math.round(sum * 100) / 100 : total });
  }
  return [...out.values()].sort((a, b) => (a.date < b.date ? -1 : 1));
}

// → { year, months: [{ month: '2026-01', branches: { WM: …, … }, b2b, total }] }
// The first "Bulan … TOTAL M" table is the current year's.
function parseTotalSales(rows, branchCodes, fallbackYear) {
  let header = -1;
  for (let i = 0; i < (rows || []).length; i++) {
    const cells = (rows[i] || []).map(norm);
    if (cells.includes('bulan') && cells.includes('totalm')) { header = i; break; }
  }
  if (header < 0) return { year: fallbackYear, months: [] };
  let year = fallbackYear;
  for (let i = header - 1; i >= 0 && i >= header - 3; i--) {
    const y = (rows[i] || []).map((c) => String(c ?? '').trim()).find((c) => /^20\d\d$/.test(c));
    if (y) { year = Number(y); break; }
  }
  const h = rows[header].map(norm);
  const bulan = h.indexOf('bulan');
  const b2b = h.indexOf('b2b');
  const total = h.indexOf('totalm');
  const cols = {};
  rows[header].forEach((c, i) => {
    if (!/^retail/i.test(String(c ?? '').trim())) return;
    const b = matchBranch(c, branchCodes);
    if (b && cols[b] === undefined) cols[b] = i;
  });
  const months = [];
  for (let i = header + 1; i < rows.length; i++) {
    const row = rows[i] || [];
    const m = MONTHS.indexOf(norm(row[bulan]).slice(0, 3));
    if (m < 0) { if (months.length) break; continue; }
    const branches = {};
    for (const [code, idx] of Object.entries(cols)) {
      const n = parseNumber(row[idx]);
      if (n !== null) branches[code] = n;
    }
    const t = parseNumber(row[total]);
    if (!Object.keys(branches).length && t === null) continue; // months not reached yet
    months.push({
      month: `${year}-${String(m + 1).padStart(2, '0')}`, branches,
      b2b: b2b >= 0 ? parseNumber(row[b2b]) : null,
      total: t,
    });
  }
  return { year, months };
}

// Replace the stored copy with what the sheet shows now. today: daily rows after it are ignored.
async function storeSummary(db, { daily, monthly, today }) {
  await db.transaction(async (tx) => {
    if (daily) {
      await tx.query("DELETE FROM sheet_sales_summary WHERE kind = 'daily'");
      for (const d of daily) {
        if (d.date > today) continue;
        for (const [code, amount] of Object.entries(d.branches)) {
          await tx.query("INSERT INTO sheet_sales_summary (kind, period, code, amount) VALUES ('daily', $1, $2, $3)", [d.date, code, amount]);
        }
        await tx.query("INSERT INTO sheet_sales_summary (kind, period, code, amount) VALUES ('daily', $1, 'TOTAL', $2)", [d.date, d.total]);
      }
    }
    if (monthly) {
      await tx.query("DELETE FROM sheet_sales_summary WHERE kind = 'monthly'");
      for (const m of monthly.months) {
        const put = (code, amount) => tx.query(
          "INSERT INTO sheet_sales_summary (kind, period, code, amount) VALUES ('monthly', $1, $2, $3)", [m.month, code, amount]);
        for (const [code, amount] of Object.entries(m.branches)) await put(code, amount);
        if (m.b2b !== null) await put('B2B', m.b2b);
        const t = m.total !== null ? m.total
          : Object.values(m.branches).reduce((a, n) => a + n, 0) + (m.b2b || 0);
        await put('TOTAL', t);
      }
    }
  });
}

// For the Sales view and the scoreboards.
async function loadSummary(db, { year, month }) {
  const rows = (await db.query(
    "SELECT kind, period, code, amount FROM sheet_sales_summary WHERE (kind = 'monthly' AND period LIKE $1) OR (kind = 'daily' AND period LIKE $2)",
    [`${year}-%`, `${month}-%`])).rows;
  const monthly = new Map();
  const daily = new Map();
  for (const r of rows) {
    const target = r.kind === 'monthly' ? monthly : daily;
    if (!target.has(r.period)) target.set(r.period, {});
    target.get(r.period)[r.code] = r.amount === null ? null : Number(r.amount);
  }
  const months = [...monthly.entries()].sort().map(([m, v]) => ({ month: m, ...v }));
  let running = 0;
  for (const m of months) { running += m.TOTAL || 0; m.cumulative = running; }
  const ytd = {};
  for (const m of months) for (const [k, v] of Object.entries(m)) if (k !== 'month' && k !== 'cumulative' && v !== null) ytd[k] = (ytd[k] || 0) + v;
  const days = [...daily.entries()].sort().map(([d, v]) => ({ date: d, ...v }));
  const monthTotals = {};
  for (const d of days) for (const [k, v] of Object.entries(d)) if (k !== 'date' && v !== null) monthTotals[k] = (monthTotals[k] || 0) + v;
  return { months, ytd, days, monthTotals, hasData: months.length > 0 || days.length > 0 };
}

module.exports = { parseOverallDaily, parseTotalSales, storeSummary, loadSummary, matchBranch };
