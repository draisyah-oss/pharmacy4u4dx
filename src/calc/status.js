// Status rule from seed.json: ✔ on track ≥ 100%, ▲ watch 90–99%, ✕ off track < 90%.

const STATUS = {
  on_track: { symbol: '✔', label: 'On track' },
  watch: { symbol: '▲', label: 'Watch' },
  off_track: { symbol: '✕', label: 'Off track' },
  track_only: { symbol: '', label: 'Track only' }, // no target set
  no_data: { symbol: '–', label: 'No data' },       // e.g. 0 orders shipped, so no % yet
};

// pct is actual ÷ target (1 = 100%). Rounded first so 0.8999999999 from floating point
// counts as 90%, the way Excel shows it.
function statusFor(pct, { hasTarget = true } = {}) {
  if (!hasTarget) return 'track_only';
  if (pct === null || pct === undefined || Number.isNaN(pct)) return 'no_data';
  const p = Math.round(pct * 1e6) / 1e6;
  if (p >= 1) return 'on_track';
  if (p >= 0.9) return 'watch';
  return 'off_track';
}

// % achieved. `better: 'low'` (e.g. inventory days) flips it: target ÷ actual.
function percentOf(actual, target, better = 'high') {
  if (actual === null || target === null || actual === undefined || target === undefined) return null;
  if (better === 'low') return actual === 0 ? null : target / actual;
  return target === 0 ? null : actual / target;
}

module.exports = { STATUS, statusFor, percentOf };
