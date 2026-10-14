// Turning monthly / weekly / daily targets into a target for each day.
//
// Rule (CLAUDE.md): monthly targets spread evenly over the days of that month; weekly targets
// are ÷ 7 per day; daily targets as they are. Each day uses the target of ITS OWN month, so a
// week running 26 Oct – 1 Nov gets six October days and one November day.
//
// `targets` is the measure's month map, e.g. { '2026-10': 1730, '2026-11': 1910 }.
// A missing or null month target means "track only" for that day.

const { monthOf, daysInMonth } = require('./dates');

function monthTarget(targets, date) {
  const t = targets ? targets[monthOf(date)] : undefined;
  return t === undefined || t === null ? null : Number(t);
}

// Target for one day of a SUM measure.
function dailyTarget(targets, targetPer, date) {
  const t = monthTarget(targets, date);
  if (t === null) return null;
  if (targetPer === 'day') return t;
  if (targetPer === 'week') return t / 7;
  if (targetPer === 'month') return t / daysInMonth(monthOf(date));
  throw new Error(`Unknown target_per "${targetPer}"`);
}

module.exports = { monthTarget, dailyTarget };
