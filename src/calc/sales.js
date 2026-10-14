// Branch sales: totals, month-to-date and the sales needed per day to hit the month.
//
// Branch total sales = sum of the branch's total_sales_fields (e.g. WM: walk-in + zakat +
// WhatsApp + TikTok + Grab). The month the tracker started also adds the sales from before
// it (1–11 Oct), so October MTD is the whole month.

const { dateRange, monthOf, monthStart, monthEnd, diffDays } = require('./dates');

// Total sales per day and for the period. Returns { total, days: [{ date, total, byField }] }.
function branchSales({ entries, fields, from, to }) {
  const days = dateRange(from, to).map((date) => {
    const byField = {};
    let total = 0;
    for (const f of fields) {
      const v = entries.get(date, f);
      byField[f] = v;
      total += v === null ? 0 : v;
    }
    return { date, total, byField };
  });
  return { total: days.reduce((a, d) => a + d.total, 0), days };
}

// Month-to-date total sales up to and including `asOf`.
// baseline: { baseline_end_date: '2026-10-11', sales_before_start: 19900 } or null.
function mtdSales({ entries, fields, asOf, baseline }) {
  const month = monthOf(asOf);
  let from = monthStart(month);
  let before = 0;

  if (baseline && baseline.baseline_end_date && monthOf(baseline.baseline_end_date) === month) {
    // Days up to the baseline date are covered by the before-tracker figure, not entries.
    before = Number(baseline.sales_before_start) || 0;
    const dayAfter = new Date(`${baseline.baseline_end_date}T00:00:00Z`);
    dayAfter.setUTCDate(dayAfter.getUTCDate() + 1);
    from = dayAfter.toISOString().slice(0, 10);
  }

  const tracked = from <= asOf ? branchSales({ entries, fields, from, to: asOf }) : { total: 0, days: [] };
  return { total: before + tracked.total, beforeTracker: before, tracked: tracked.total, days: tracked.days };
}

// Required sales/day = (month target − MTD actual) ÷ days left in the month.
// `asOf` is the last day counted in the MTD actual (normally yesterday, or today once the
// day's numbers are in). Days left = the days AFTER asOf up to month end.
// Returns 0 when the target is already reached, and null on the last day (no days left).
function requiredPerDay({ monthTarget, mtdActual, asOf }) {
  if (monthTarget === null || monthTarget === undefined) return { perDay: null, remaining: null, daysLeft: null };
  const daysLeft = diffDays(asOf, monthEnd(monthOf(asOf)));
  const remaining = monthTarget - mtdActual;
  if (remaining <= 0) return { perDay: 0, remaining, daysLeft };
  return { perDay: daysLeft > 0 ? remaining / daysLeft : null, remaining, daysLeft };
}

module.exports = { branchSales, mtdSales, requiredPerDay };
