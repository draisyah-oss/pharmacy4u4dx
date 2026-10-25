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

// 25 Oct: the steps an item goes through, for the branch to see where it is. Each step:
// { label, at (timestamp or null), done, current }. Deliveries (HQ delivers / transfer):
// reported → answered → picked → on the way → received. Order: reported → ordered → received.
// Substitute: reported → substitute offered → done.
function steps(it) {
  const from = it.answer === 'transfer' ? (it.from_code || 'branch') : 'HQ';
  const closed = Boolean(it.received_at) || ['Back in stock', 'Discontinued', 'Discontinued / use substitute'].includes(it.status);
  let list;
  if (!it.answer) list = [['Reported', it.reported_at], ['Inventory answers', null], ['Back in stock', it.received_at]];
  else if (it.answer === 'hq_deliver' || it.answer === 'transfer') {
    list = [['Reported', it.reported_at], [`${from} will send ${it.answer_qty || ''}`.trim(), it.answered_at],
      [`Picked at ${from}`, it.picked_at || it.sent_at], ['On the way', it.sent_at], ['Received', it.received_at]];
  } else if (it.answer === 'order') list = [['Reported', it.reported_at], ['Ordered from the supplier', it.answered_at], ['Received', it.received_at]];
  else if (it.answer === 'substitute') list = [['Reported', it.reported_at], ['Substitute offered', it.answered_at], ['Done', it.received_at]];
  else list = [['Reported', it.reported_at], ['Discontinued', it.answered_at]];
  const out = list.map(([label, at]) => ({ label, at: at || null, done: Boolean(at) || closed }));
  const next = out.findIndex((x) => !x.done);
  if (next >= 0) out[next].current = true;
  return out;
}

module.exports = { when, left, span, dateLabel, days, time, steps };
