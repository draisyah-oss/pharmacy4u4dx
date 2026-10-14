// Date helpers. All dates are 'YYYY-MM-DD' strings and all arithmetic is done in UTC,
// so a server running in another timezone (Railway runs on UTC) never shifts a day.

const TIMEZONE = 'Asia/Kuala_Lumpur';

const toUtc = (iso) => new Date(`${iso}T00:00:00Z`);
const fromUtc = (d) => d.toISOString().slice(0, 10);

function addDays(iso, n) {
  const d = toUtc(iso);
  d.setUTCDate(d.getUTCDate() + n);
  return fromUtc(d);
}

// Number of days from a to b (b − a). Same day = 0.
function diffDays(a, b) {
  return Math.round((toUtc(b) - toUtc(a)) / 86400000);
}

// Every date from `from` to `to`, both included.
function dateRange(from, to) {
  const out = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
}

const monthOf = (iso) => iso.slice(0, 7);

function daysInMonth(month) {
  const [y, m] = month.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

const monthStart = (month) => `${month}-01`;
const monthEnd = (month) => `${month}-${String(daysInMonth(month)).padStart(2, '0')}`;

// Weeks run Monday–Sunday.
function weekStart(iso) {
  const dow = toUtc(iso).getUTCDay(); // 0 = Sunday
  return addDays(iso, dow === 0 ? -6 : 1 - dow);
}
const weekEnd = (iso) => addDays(weekStart(iso), 6);

// Today's date in Malaysia, whatever the server's own clock says.
function todayInMalaysia(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(now);
  return parts; // en-CA formats as YYYY-MM-DD
}

module.exports = {
  TIMEZONE, addDays, diffDays, dateRange, monthOf, daysInMonth, monthStart, monthEnd,
  weekStart, weekEnd, todayInMalaysia,
};
