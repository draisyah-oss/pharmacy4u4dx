// Year-to-date and daily sales as the Google sales sheet shows them ("Total Sales" and
// "Overall Daily Sales" tabs), for the Sales page and the scoreboards.

const { loadSummary, loadYears } = require('../sheets/summary');

const monthOf = (iso) => iso.slice(0, 7);
const prevMonth = (m) => { const [y, mo] = m.split('-').map(Number); return mo === 1 ? `${y - 1}-12` : `${y}-${String(mo - 1).padStart(2, '0')}`; };
const daysIn = (m) => new Date(Date.UTC(Number(m.slice(0, 4)), Number(m.slice(5)), 0)).getUTCDate();

// YTD target per branch up to `asOf`: last month-end's YTD target plus this month's share by days
// (Admin → Targets "YTD target at month end"). { WM: 652000, … }
async function ytdTargetsAt(db, asOf) {
  const m = monthOf(asOf);
  const rows = (await db.query(
    `SELECT b.code, trim(t.month) AS month, t.ytd_target_month_end AS ytd, t.total_sales_target AS mt FROM branch_month_targets t
     JOIN branches b ON b.id = t.branch_id WHERE trim(t.month) IN ($1, $2)`, [m, prevMonth(m)])).rows;
  const by = {};
  for (const r of rows) {
    const t = (by[r.code] ||= {});
    if (r.ytd !== null) t[r.month === m ? 'now' : 'prev'] = Number(r.ytd);
    if (r.month === m && r.mt !== null) t.month = Number(r.mt);
  }
  const share = Number(asOf.slice(8)) / daysIn(m);
  const out = {};
  for (const [code, t] of Object.entries(by)) {
    if (t.now === undefined) continue;
    // Last month-end: its own YTD target, else this month-end's less this month's sales target.
    const prev = t.prev ?? (m.endsWith('-01') ? 0 : t.month !== undefined ? t.now - t.month : null);
    out[code] = prev === null ? t.now : Math.round(prev + (t.now - prev) * share);
  }
  return out;
}

// Everything the Sales page needs for one year and one chosen month.
async function buildSalesView(db, { today, month }) {
  const year = month.slice(0, 4);
  const branches = (await db.query('SELECT id, code, name FROM branches WHERE active ORDER BY sort_order')).rows;
  const sum = await loadSummary(db, { year, month });

  // YTD target to the latest day in the sheet, so a half-done month isn't judged on the full month.
  const latest = await latestDay(db, today);
  const ytdAsOf = latest ? latest.date : today;
  const ytdTarget = await ytdTargetsAt(db, ytdAsOf);
  const ytdTargetBranches = Object.keys(ytdTarget).length ? Object.values(ytdTarget).reduce((a, n) => a + n, 0) : null;

  const syncedAt = (await db.query('SELECT max(synced_at) AS at FROM sheet_sales_summary')).rows[0].at;
  const history = await yearOnYear(db, today);
  return { ...sum, year, month, branches, ytdTarget, ytdTargetBranches, ytdAsOf, latest, syncedAt, history };
}

// The newest day in the daily tab up to today: { date, WM: …, TOTAL: … } or null.
async function latestDay(db, today) {
  const { rows } = await db.query(
    `SELECT period, code, amount FROM sheet_sales_summary
     WHERE kind = 'daily' AND period = (SELECT max(period) FROM sheet_sales_summary WHERE kind = 'daily' AND period <= $1)`, [today]);
  if (!rows.length) return null;
  const day = { date: rows[0].period };
  for (const r of rows) day[r.code] = r.amount === null ? null : Number(r.amount);
  return day;
}

// A small "year so far" summary for a scoreboard. code: a branch code, or null for the company.
async function sheetYearCard(db, { today, code = null }) {
  const year = today.slice(0, 4);
  const sum = await loadSummary(db, { year, month: monthOf(today) });
  if (!sum.hasData) return null;
  const key = code || 'TOTAL';
  const latest = await latestDay(db, today);
  const target = code ? ((await ytdTargetsAt(db, latest ? latest.date : today))[code] ?? null) : null;
  const ytd = sum.ytd[key] ?? null;
  return {
    year, code, ytd, target, pct: target && ytd !== null ? ytd / target : null,
    month: sum.monthTotals[key] ?? null,
    latest: latest ? { date: latest.date, amount: latest[key] ?? null } : null,
    b2b: code ? null : (sum.ytd.B2B ?? null),
  };
}

// Progress since the first year in the sheet: year totals, growth on the year before, and a fair
// like-for-like for this year (the same full months last year, e.g. Jan–Sep 2026 vs Jan–Sep 2025).
async function yearOnYear(db, today) {
  const { years, byYear } = await loadYears(db);
  if (!years.length) return null;
  const thisYear = Number(today.slice(0, 4));
  const fullMonths = Number(today.slice(5, 7)) - 1; // months finished this year
  const sumMonths = (y, upTo, code = 'TOTAL') => {
    const Y = byYear[y]; if (!Y) return null;
    let t = 0; let any = false;
    for (let m = 1; m <= upTo; m++) { const v = Y.months[String(m).padStart(2, '0')]?.[code]; if (v !== null && v !== undefined) { t += v; any = true; } }
    return any ? t : null;
  };
  const rows = years.map((y, i) => {
    const total = byYear[y].total;
    const prev = i ? byYear[years[i - 1]].total.TOTAL : null;
    const partial = y === thisYear;
    return {
      year: y, total, partial, lastMonth: byYear[y].lastMonth,
      growth: !partial && prev ? total.TOTAL / prev - 1 : null,
    };
  });
  let likeForLike = null;
  if (byYear[thisYear] && byYear[thisYear - 1] && fullMonths >= 1) {
    const now = sumMonths(thisYear, fullMonths); const before = sumMonths(thisYear - 1, fullMonths);
    if (now !== null && before) likeForLike = { months: fullMonths, year: thisYear, now, before, growth: now / before - 1 };
  }
  // Month totals per year for the chart: { 2025: [Jan…Dec or null] }
  const lines = Object.fromEntries(years.map((y) => [y, Array.from({ length: 12 }, (_, m) => {
    const v = byYear[y].months[String(m + 1).padStart(2, '0')]?.TOTAL;
    return v === undefined || v === null || (y === thisYear && m + 1 > Number(today.slice(5, 7))) ? null : v;
  })]));
  return { years, rows, likeForLike, lines, thisYear, currentMonth: Number(today.slice(5, 7)) };
}

module.exports = { yearOnYear, buildSalesView, sheetYearCard, latestDay, ytdTargetsAt };
