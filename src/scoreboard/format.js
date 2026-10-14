// How numbers are shown on the scoreboard. Used by the views.

const { STATUS } = require('../calc');

const grouped = (n, digits) => Number(n).toLocaleString('en-MY', { maximumFractionDigits: digits });

// A measure's actual or target in its own unit.
function value(row, n) {
  if (n === null || n === undefined || Number.isNaN(n)) return '–';
  if (row.calc === 'ratio_percent') return `${grouped(n * 100, 1)}%`;
  if (row.calc === 'ratio_per_day') return grouped(n, 1);
  if (row.money) return `RM ${grouped(n, 0)}`;
  return grouped(n, 1);
}

const money = (n) => (n === null || n === undefined ? '–' : `RM ${grouped(n, 0)}`);
const number = (n, digits = 1) => (n === null || n === undefined ? '–' : grouped(n, digits));

// % achieved, rounded down so 99.6% never shows as "100%" next to a ▲.
function pct(p) {
  if (p === null || p === undefined || Number.isNaN(p)) return '';
  return `${Math.floor(Math.round(p * 1e6) / 1e4)}%`;
}

// "1,730 a day", "2 a week", "RM 20,000 a month", "45%", "5 per storefront day"
function targetBasis(row) {
  const t = row.monthTarget;
  if (t === null || t === undefined) return 'No target – tracked only';
  if (row.calc === 'ratio_percent') return `Target ${grouped(t * 100, 1)}%`;
  if (row.calc === 'ratio_per_day') return `${grouped(t, 1)} per storefront day`;
  const show = (n) => (row.money ? `RM ${grouped(n, 0)}` : grouped(n, 1));
  if (row.targetPer === 'day' && row.weekendTarget !== null && row.weekendTarget !== undefined) {
    if (t === 0) return `${show(row.weekendTarget)} each Sat and Sun`;
    return `${show(t)} a weekday, ${show(row.weekendTarget)} Sat–Sun`;
  }
  return `${show(t)} a ${row.targetPer}`;
}

const symbol = (status) => (STATUS[status] ? STATUS[status].symbol : '');
const statusLabel = (status) => (STATUS[status] ? STATUS[status].label : '');

// "12–18 Oct" / "26 Oct – 1 Nov"
function weekLabel(weekStart, weekEnd) {
  const d = (iso, opts) => new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-GB', { timeZone: 'UTC', ...opts });
  if (weekStart.slice(5, 7) === weekEnd.slice(5, 7)) return `${Number(weekStart.slice(8))}–${d(weekEnd, { day: 'numeric', month: 'short' })}`;
  return `${d(weekStart, { day: 'numeric', month: 'short' })} – ${d(weekEnd, { day: 'numeric', month: 'short' })}`;
}

module.exports = { value, money, number, pct, targetBasis, symbol, statusLabel, weekLabel };
