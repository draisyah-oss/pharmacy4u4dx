// Company total sales = every branch's month-to-date sales + B2B sales, against the company's
// monthly target (company_month_targets; HQ Tracker: Oct 266,800 · Nov 313,600 · Dec 360,500).
//
// B2B is entered once a week by Alia (HQ measure "b2b", RM for that week). A week's B2B counts
// in the month its Thursday falls in – the same rule as HQ targets – so no week is counted twice.

const calc = require('../calc');
const { weekMonth } = require('../lib/weeks');

// Pure: works the numbers out from what the screens already have.
// branches: [{ code, name, mtd, monthTarget, asOf, started }]
// b2bWeeks: [{ week, value }] – only the weeks that belong to `month`
function companySales({ month, target, branches, b2bWeeks }) {
  const started = branches.filter((b) => b.started);
  const asOf = started.length ? started.map((b) => b.asOf).sort().pop() : null;
  const branchTotal = branches.reduce((a, b) => a + (b.mtd || 0), 0);
  const b2b = b2bWeeks.reduce((a, w) => a + (w.value || 0), 0);
  const total = branchTotal + b2b;
  const hasTarget = target !== null && target !== undefined;
  const dayOfMonth = asOf && calc.monthOf(asOf) === month ? Number(asOf.slice(8)) : null;
  const paceTarget = hasTarget && dayOfMonth ? target * (dayOfMonth / calc.daysInMonth(month)) : null;
  const pacePct = calc.percentOf(total, paceTarget);
  const need = hasTarget && asOf ? calc.requiredPerDay({ monthTarget: target, mtdActual: total, asOf }) : { perDay: null, daysLeft: null };
  return {
    month, asOf, target: hasTarget ? target : null, total, branchTotal, b2b, b2bWeeks,
    pct: calc.percentOf(total, hasTarget ? target : null), paceTarget, pacePct,
    status: asOf ? calc.statusFor(pacePct, { hasTarget }) : 'no_data',
    perDay: need.perDay, daysLeft: need.daysLeft,
    branches: branches.map((b) => ({ code: b.code, name: b.name, mtd: b.mtd, share: total > 0 ? b.mtd / total : null })),
  };
}

// The B2B weeks of a month (weeks whose Thursday is in it) up to the week holding `asOf`.
async function b2bWeeksFor(db, month, asOf) {
  const { rows } = await db.query(
    `SELECT e.week_start, e.value, u.display_name AS entered_by
     FROM hq_entries e JOIN hq_measures m ON m.id = e.hq_measure_id LEFT JOIN users u ON u.id = e.entered_by
     WHERE m.code = 'b2b' AND e.value IS NOT NULL ORDER BY e.week_start`);
  const last = asOf ? calc.weekStart(asOf) : null;
  return rows
    .filter((r) => weekMonth(r.week_start) === month && (!last || r.week_start <= last))
    .map((r) => ({ week: r.week_start, value: Number(r.value), enteredBy: r.entered_by }));
}

async function companyTarget(db, month) {
  const { rows } = await db.query('SELECT total_sales_target FROM company_month_targets WHERE month = $1', [month]);
  return rows[0] && rows[0].total_sales_target !== null ? Number(rows[0].total_sales_target) : null;
}

// From the group scoreboard's branch rows.
async function buildCompanySales(db, groupRows) {
  const month = groupRows.length ? groupRows[0].sales.month : null;
  if (!month) return null;
  const branches = groupRows.map((r) => ({
    code: r.code, name: r.name, mtd: r.sales.mtd, asOf: r.asOf, started: r.started,
  }));
  const asOf = branches.filter((b) => b.started).map((b) => b.asOf).sort().pop() || null;
  const [target, b2bWeeks] = await Promise.all([companyTarget(db, month), b2bWeeksFor(db, month, asOf)]);
  return companySales({ month, target, branches, b2bWeeks });
}

module.exports = { companySales, buildCompanySales, b2bWeeksFor, companyTarget };

// Company sales for a week without the rest of the group scoreboard (HQ scoreboard, home).
async function companySalesForWeek(db, { week, today, trackerStart }) {
  const { buildScoreboard } = require('../scoreboard/data');
  const branches = (await db.query('SELECT * FROM branches WHERE active ORDER BY sort_order')).rows;
  const rows = [];
  for (const branch of branches) {
    const b = await buildScoreboard(db, { branch, weekStart: week, today, trackerStart });
    rows.push({ code: branch.code, name: branch.name, sales: b.sales, asOf: b.asOf, started: b.started });
  }
  const company = await buildCompanySales(db, rows);
  if (company) company.rows = rows; // each branch's sales card (home page)
  return company;
}

module.exports.companySalesForWeek = companySalesForWeek;
