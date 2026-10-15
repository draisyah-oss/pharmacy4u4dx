// HQ measures are entered weekly as one number, or as "done of total" (e.g. 18 of 20 POs
// checked = 90%). Some are better low (inventory turnover days).

const { statusFor, percentOf } = require('./status');

function evaluateHq({ measure, entry, target }) {
  let actual = null;
  if (entry) {
    if (measure.input === 'done_and_total') {
      actual = entry.total > 0 ? Number(entry.value) / Number(entry.total) : null;
    } else if (entry.value !== null && entry.value !== undefined) {
      actual = Number(entry.value);
    }
  }
  const hasTarget = target !== null && target !== undefined;
  let pct = hasTarget ? percentOf(actual, Number(target), measure.better) : null;
  // "Lower is better" with a target of 0 (AR over 30 days, unpaid zakat over 30 days):
  // 0 is on target, anything above it is off track.
  if (hasTarget && measure.better === 'low' && Number(target) === 0 && actual !== null) pct = actual <= 0 ? 1 : 0;
  return { actual, target: hasTarget ? Number(target) : null, pct, status: statusFor(pct, { hasTarget }) };
}

module.exports = { evaluateHq };
