// Actual vs target for one measure over a period (a week, month-to-date, …).
//
//   calc = sum            actual = sum of the field; target = sum of each day's target
//   calc = ratio_percent  actual = sum(numerator) ÷ sum(denominator); target is a % (0.45)
//   calc = average_percent  actual = average of the days typed (a % typed as 45) ÷ 100; days left
//                         blank don't count. Target is a % (0.5). Grab active inventory (22 Oct).
//   calc = ratio_per_day  actual = sum(numerator on storefront days) ÷ number of storefront
//                         days; shown as a number (5.0 checks a day), not a %
//
// Days before the tracker started (12 Oct) are ignored – both actual and target – so
// October week and MTD targets only count from 12 Oct.
//
// Every result carries `days`: the daily rows behind the number, so a scoreboard can
// click through to them.

const { dateRange } = require('./dates');
const { dailyTarget, monthTarget } = require('./targets');
const { statusFor, percentOf } = require('./status');

const sum = (xs) => xs.reduce((a, b) => a + b, 0);
const valueOr0 = (v) => (v === null ? 0 : v);

function countedDays(from, to, trackerStart) {
  const start = trackerStart && trackerStart > from ? trackerStart : from;
  return start > to ? [] : dateRange(start, to);
}

// measure: { calc, target_per, numerator_field, denominator_field, targets, weekend_targets?, high_days? }
// entries: result of indexEntries(rows)
function evaluateMeasure({ measure, entries, from, to, trackerStart }) {
  const { calc, target_per: targetPer, numerator_field: num, denominator_field: den } = measure;
  const targets = measure.targets || {};
  const allDays = countedDays(from, to, trackerStart);

  // A blank target means "track only". If only SOME days have a target (e.g. a week that
  // runs from a track-only month into a month with a target), both actual and target are
  // taken from the days that have one, so the % compares like with like.
  const withTarget = allDays.filter((d) => monthTarget(targets, d) !== null);
  const hasTarget = withTarget.length > 0;
  const days = hasTarget ? withTarget : allDays;

  const trace = days.map((date) => ({
    date,
    numerator: entries.get(date, num),
    denominator: den ? entries.get(date, den) : null,
  }));
  const daysEntered = trace.filter((t) => t.numerator !== null).length;

  let actual;
  let target = null;
  let numerator;
  let denominator = null;

  if (calc === 'sum') {
    numerator = sum(trace.map((t) => valueOr0(t.numerator)));
    actual = numerator;
    if (hasTarget) target = sum(days.map((d) => dailyTarget(targets, targetPer, d, measure.weekend_targets, measure.high_days)));
  } else if (calc === 'ratio_percent' || calc === 'ratio_per_day') {
    // ratio_per_day: the numerator only counts on days where the denominator is > 0
    // (health checks are only counted on storefront days, 2 staff on duty).
    const used = calc === 'ratio_per_day' ? trace.filter((t) => valueOr0(t.denominator) > 0) : trace;
    numerator = sum(used.map((t) => valueOr0(t.numerator)));
    denominator = sum(used.map((t) => valueOr0(t.denominator)));
    actual = denominator > 0 ? numerator / denominator : null;
    // Ratio targets aren't added up – they're a rate. Average of the days' targets
    // (identical unless the period spans two months with different rates).
    if (hasTarget) target = sum(days.map((d) => monthTarget(targets, d))) / days.length;
  } else if (calc === 'average_percent') {
    const typed = trace.filter((t) => t.numerator !== null);
    numerator = sum(typed.map((t) => t.numerator));
    denominator = typed.length;
    actual = typed.length ? numerator / typed.length / 100 : null;
    if (hasTarget) target = sum(days.map((d) => monthTarget(targets, d))) / days.length;
  } else {
    throw new Error(`Unknown calc "${calc}"`);
  }

  const pct = percentOf(actual, target);
  return {
    actual,
    target,
    pct,
    status: statusFor(pct, { hasTarget }),
    numerator,
    denominator,
    daysCounted: days.length,
    daysEntered,
    partialTarget: hasTarget && withTarget.length < allDays.length,
    days: trace,
  };
}

module.exports = { evaluateMeasure, countedDays };
