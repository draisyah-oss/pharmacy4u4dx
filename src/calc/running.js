// Running totals (chronic database, Google reviews, TikTok followers):
//   total = start value + sum of the field from the start date to `asOf`, against the end target.
// Also works out where the total should be by now if it grew evenly to the end date, so the
// progress bar can say "ahead" or "behind".

const { dateRange, diffDays } = require('./dates');

function runningTotal({ entries, field, startValue, startDate, endTarget, endDate, asOf }) {
  const to = asOf < endDate ? asOf : endDate;
  const days = startDate <= to
    ? dateRange(startDate, to).map((date) => ({ date, value: entries.get(date, field) }))
    : [];
  const added = days.reduce((a, d) => a + (d.value === null ? 0 : d.value), 0);

  const startMissing = startValue === null || startValue === undefined;
  const start = startMissing ? 0 : Number(startValue);
  const total = start + added;

  const result = {
    total, added, start, startMissing, endTarget,
    pctOfTarget: endTarget ? total / endTarget : null,
    remaining: endTarget !== null && endTarget !== undefined ? Math.max(endTarget - total, 0) : null,
    expectedByNow: null, onPace: null, perDayNeeded: null, days,
  };
  if (startMissing || endTarget === null || endTarget === undefined) return result;

  const totalDays = diffDays(startDate, endDate) + 1;   // 12 Oct – 31 Dec = 81 days
  const elapsed = Math.min(Math.max(diffDays(startDate, to) + 1, 0), totalDays);
  const daysLeft = totalDays - elapsed;
  result.expectedByNow = start + (endTarget - start) * (elapsed / totalDays);
  result.onPace = total >= result.expectedByNow - 1e-9;
  result.perDayNeeded = daysLeft > 0 ? result.remaining / daysLeft : null;
  return result;
}

module.exports = { runningTotal };
