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

// Every year table in the "Total Sales" tab ("Bulan … TOTAL M" header with a year just above it):
// 2026 (Retail per branch, B2B), 2025 (Retail WM/BR/JH, Shopee, Tiktok, Zakat, Distribution …),
// 2024, 2023 ("Retail" = WM, the only branch then). Tables without a year above them (the 2026
// targets table, "Pure walk in") are skipped.
// → [{ year, months: [{ month: '2025-01', branches: { WM: … }, b2b, other, total }] }], newest first.
function parseTotalSalesYears(rows, branchCodes) {
  const out = [];
  const seen = new Set();
  for (let i = 0; i < (rows || []).length; i++) {
    const cells = (rows[i] || []).map(norm);
    const bulan = cells.indexOf('bulan');
    const total = cells.indexOf('totalm');
    if (bulan < 0 || total < bulan) continue;
    let year = null;
    for (let j = i - 1; j >= 0 && j >= i - 2; j--) {
      const y = (rows[j] || []).map((c) => String(c ?? '').trim()).find((c) => /^20\d\d$/.test(c));
      if (y) { year = Number(y); break; }
    }
    if (!year || seen.has(year)) continue;
    seen.add(year);
    // Data columns sit between "Bulan" and "TOTAL M" (2026's header repeats branches further right).
    const cols = [];
    for (let c = bulan + 1; c < total; c++) {
      const h = String(rows[i][c] ?? '').trim();
      if (!h) continue;
      const n = norm(h);
      let code = null;
      if (n === 'retail') code = branchCodes.includes('WM') ? 'WM' : null; // 2023: WM only
      else if (/^retail/.test(n) || branchCodes.some((b) => norm(b) === n)) code = matchBranch(h, branchCodes);
      if (code) cols.push([c, code]);
      else if (n === 'b2b' || n === 'distribution') cols.push([c, 'B2B']);
      else cols.push([c, 'OTHER']); // Shopee, TikTok, zakat, Alpine, e-commerce …
    }
    const months = [];
    for (let r = i + 1; r < rows.length; r++) {
      const row = rows[r] || [];
      const m = MONTHS.indexOf(norm(row[bulan]).slice(0, 3));
      if (m < 0) { if (months.length || norm(row[0]) === 'total') break; continue; }
      const branches = {};
      let b2b = null; let other = null;
      for (const [c, code] of cols) {
        const v = parseNumber(row[c]);
        if (v === null) continue;
        if (code === 'B2B') b2b = (b2b || 0) + v;
        else if (code === 'OTHER') other = (other || 0) + v;
        else branches[code] = (branches[code] || 0) + v;
      }
      const t = parseNumber(row[total]);
      if (!Object.keys(branches).length && b2b === null && other === null && !t) continue; // months not reached
      months.push({ month: `${year}-${String(m + 1).padStart(2, '0')}`, branches, b2b, other, total: t });
    }
    if (months.length) out.push({ year, months });
  }
  return out;
}

// → { year, months } – the first (current) year's table, as the Sales page has always read it.
function parseTotalSales(rows, branchCodes, fallbackYear) {
  const years = parseTotalSalesYears(rows, branchCodes);
  return years[0] || { year: fallbackYear, months: [] };
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
      const all = monthly.years || [monthly];
      for (const m of all.flatMap((y) => y.months)) {
        const put = (code, amount) => tx.query(
          "INSERT INTO sheet_sales_summary (kind, period, code, amount) VALUES ('monthly', $1, $2, $3)", [m.month, code, amount]);
        for (const [code, amount] of Object.entries(m.branches)) await put(code, amount);
        if (m.b2b !== null) await put('B2B', m.b2b);
        if (m.other !== null && m.other !== undefined) await put('OTHER', m.other);
        const t = m.total !== null ? m.total
          : Object.values(m.branches).reduce((a, n) => a + n, 0) + (m.b2b || 0) + (m.other || 0);
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

// Year-on-year progress: every year in the sheet, month totals and year totals per code.
// → { years: [2023, …], byYear: { 2025: { months: { '01': { TOTAL, WM, … } }, total: { TOTAL, WM, … }, lastMonth } } }
async function loadYears(db) {
  const rows = (await db.query("SELECT period, code, amount FROM sheet_sales_summary WHERE kind = 'monthly' ORDER BY period")).rows;
  const byYear = {};
  for (const r of rows) {
    const [y, m] = r.period.split('-');
    const Y = (byYear[y] ||= { months: {}, total: {}, lastMonth: null });
    const v = r.amount === null ? null : Number(r.amount);
    (Y.months[m] ||= {})[r.code] = v;
    if (v !== null) Y.total[r.code] = (Y.total[r.code] || 0) + v;
    if (r.code === 'TOTAL' && v) Y.lastMonth = m;
  }
  return { years: Object.keys(byYear).map(Number).sort(), byYear };
}

module.exports = { parseOverallDaily, parseTotalSales, parseTotalSalesYears, storeSummary, loadSummary, loadYears, matchBranch };
