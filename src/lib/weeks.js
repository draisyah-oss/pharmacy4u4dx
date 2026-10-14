// Weeks for the Monday screens (check-in, commitments, group and HQ scoreboards).
// Weeks run Monday–Sunday and are named by their Monday.

const calc = require('../calc');

// Every week from the tracker's first week to the current one.
function weekChoices(trackerStart, today) {
  const weeks = [];
  for (let w = calc.weekStart(trackerStart); w <= calc.weekStart(today); w = calc.addDays(w, 7)) weeks.push(w);
  return weeks;
}

// On Monday the check-in reports the week that just ended. In the tracker's first week
// there is no finished week yet, so it's that week.
function lastFinishedWeek(trackerStart, today) {
  const first = calc.weekStart(trackerStart);
  const w = calc.addDays(calc.weekStart(today), -7);
  return w < first ? first : w;
}

const pickWeek = (asked, weeks, fallback) => (weeks.includes(asked) ? asked : fallback);

// The month a week belongs to (for monthly targets on weekly numbers): the month its
// Thursday falls in, i.e. the month that holds most of the week.
const weekMonth = (week) => calc.monthOf(calc.addDays(week, 3));

// The last `n` weeks up to and including `week`, never before the tracker's first week.
function trendWeeks(trackerStart, week, n = 12) {
  const first = calc.weekStart(trackerStart);
  const out = [];
  for (let w = week, i = 0; i < n && w >= first; i++, w = calc.addDays(w, -7)) out.unshift(w);
  return out;
}

module.exports = { weekChoices, lastFinishedWeek, pickWeek, weekMonth, trendWeeks };
