// Year-to-date and daily sales as the Google sales sheet shows them ("Total Sales" and
// "Overall Daily Sales" tabs), for the Sales page and the scoreboards.

const { loadSummary } = require('../sheets/summary');

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
  return { ...sum, year, month, branches, ytdTarget, ytdTargetBranches, ytdAsOf, latest, syncedAt };
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

module.exports = { buildSalesView, sheetYearCard, latestDay, ytdTargetsAt };
