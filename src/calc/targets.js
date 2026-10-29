// Turning monthly / weekly / daily targets into a target for each day.
//
// Rule (CLAUDE.md): monthly targets spread evenly over the days of that month; weekly targets
// are ÷ 7 per day; daily targets as they are. Each day uses the target of ITS OWN month, so a
// week running 26 Oct – 1 Nov gets six October days and one November day.
//
// `targets` is the measure's month map, e.g. { '2026-10': 1730, '2026-11': 1910 }.
// A missing or null month target means "track only" for that day.
//
// Daily targets can have a separate weekend figure (weekendTargets, same month map): on
// Saturdays and Sundays that number is used instead, e.g. BR walk-in RM 1,250 on weekdays
// and RM 1,650 at weekends. A month with no weekend figure uses the same target every day.
// 29 Oct: a measure can name its own "high days" (measures.high_days, e.g. 'Sun,Mon' – BR's busy
// days are Sunday and Monday); without it the weekend figure applies on Saturday and Sunday.

const { monthOf, daysInMonth } = require('./dates');

function monthTarget(targets, date) {
  const t = targets ? targets[monthOf(date)] : undefined;
  return t === undefined || t === null ? null : Number(t);
}

const isWeekend = (date) => [0, 6].includes(new Date(`${date}T00:00:00Z`).getUTCDay());

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
// 'Sun,Mon' → [0, 1]; empty / null → Saturday and Sunday. Unknown names are ignored.
function highDayNumbers(highDays) {
  const list = String(highDays || '').split(',').map((d) => DAY_NAMES.indexOf(d.trim())).filter((n) => n >= 0);
  return list.length ? list : [6, 0];
}
const isHighDay = (date, highDays) => highDayNumbers(highDays).includes(new Date(`${date}T00:00:00Z`).getUTCDay());
// For people: [6, 0] → "Sat–Sun", [0, 1] → "Sun–Mon", [5, 6, 0] → "Fri, Sat, Sun".
function highDaysLabel(highDays) {
  const names = highDayNumbers(highDays).map((n) => DAY_NAMES.at(n));
  return names.length === 2 ? `${names.at(0)}–${names.at(1)}` : names.join(', ');
}

// Target for one day of a SUM measure.
function dailyTarget(targets, targetPer, date, weekendTargets, highDays) {
  const t = monthTarget(targets, date);
  if (t === null) return null;
  if (targetPer === 'day') {
    const w = isHighDay(date, highDays) ? monthTarget(weekendTargets, date) : null;
    return w === null ? t : w;
  }
  if (targetPer === 'week') return t / 7;
  if (targetPer === 'month') return t / daysInMonth(monthOf(date));
  throw new Error(`Unknown target_per "${targetPer}"`);
}

module.exports = { monthTarget, dailyTarget, isWeekend, isHighDay, highDayNumbers, highDaysLabel, DAY_NAMES };
