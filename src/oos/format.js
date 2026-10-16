// Times on the out-of-stock pages, in Malaysia time.
const calc = require('../calc');

const day = (ts) => calc.todayInMalaysia(new Date(ts));
const time = (ts) => new Date(ts).toLocaleTimeString('en-MY', { timeZone: 'Asia/Kuala_Lumpur', hour: 'numeric', minute: '2-digit' }).replace(/\s?(am|pm)$/i, (m) => ` ${m.trim().toLowerCase()}`);
const dateLabel = (iso) => new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-GB', { timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short' });

// "today 9:42 pm", "yesterday 9:42 pm", "Wed 14 Oct 9:42 pm"
function when(ts, at) {
  if (!ts) return '';
  const d = day(ts); const today = day(at);
  const label = d === today ? 'today' : d === calc.addDays(today, -1) ? 'yesterday' : dateLabel(d);
  return `${label} ${time(ts)}`;
}

// 80 minutes → "1 h 20 m"; days for long spans
function span(ms) {
  const m = Math.max(0, Math.round(Math.abs(ms) / 60000));
  if (m >= 48 * 60) return `${Math.round(m / 1440)} days`;
  if (m >= 60) return `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} m` : ''}`;
  return `${m} m`;
}
const left = (ms) => (ms >= 0 ? `${span(ms)} left` : `${span(ms)} late`);

const days = (from, to) => ((new Date(to) - new Date(from)) / 86400e3);

module.exports = { when, left, span, dateLabel, days, time };
