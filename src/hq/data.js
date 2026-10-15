// HQ measures (seed.json → hq): Alia's inventory WIG and leads, Hanin's operations and
// training measures. Entered once a week (Mondays, for the week just ended), either as one
// number or as "done of total" (18 of 20 POs checked = 90%). Inventory turnover days are
// better low. A week's target is its month's target (the month its Thursday falls in).

const calc = require('../calc');
const { audit, parseOptional } = require('../admin/common');
const { weekMonth, trendWeeks } = require('../lib/weeks');

const obj = (v) => (typeof v === 'string' ? JSON.parse(v) : v);
const isPercent = (m) => m.unit === '%';

async function loadHqMeasures(db) {
  const { rows } = await db.query(
    `SELECT m.*, COALESCE(json_object_agg(t.month, t.target) FILTER (WHERE t.month IS NOT NULL), '{}') AS targets
     FROM hq_measures m LEFT JOIN hq_measure_targets t ON t.hq_measure_id = m.id
     WHERE m.active GROUP BY m.id ORDER BY m.sort_order, m.id`);
  return rows.map((m) => ({ ...m, targets: obj(m.targets) }));
}

async function loadHqEntries(db, from, to) {
  const { rows } = await db.query(
    `SELECT e.*, u.display_name AS entered_by_name FROM hq_entries e LEFT JOIN users u ON u.id = e.entered_by
     WHERE e.week_start BETWEEN $1 AND $2`, [from, to]);
  return new Map(rows.map((r) => [`${r.week_start}|${r.hq_measure_id}`, r]));
}

function targetFor(m, week) {
  const t = m.targets[weekMonth(week)];
  return t === null || t === undefined ? null : Number(t);
}

// Each HQ person enters their own measures; Iman (enters_all_hq) fills in for everyone,
// as on the HQ KPIs tab; admin can enter any.
function canEditMeasure(user, m) {
  if (user.role === 'admin') return true;
  if (user.role !== 'hq' && user.role !== 'hq_staff') return false;
  if (user.role === 'hq' && user.enters_all_hq) return true;
  if (m.person_id && user.person_id) return m.person_id === user.person_id;
  return m.owner_name.toLowerCase() === String(user.display_name).toLowerCase();
}

// HQ may change this week and last week; admin any week up to this one.
function weekDenied(user, week, today) {
  const thisWeek = calc.weekStart(today);
  if (week > thisWeek) return 'That week hasn’t started yet.';
  if (user.role === 'admin') return null;
  if (user.role !== 'hq' && user.role !== 'hq_staff') return 'Only HQ and admin enter HQ numbers.';
  if (week < calc.addDays(thisWeek, -7)) return 'Only this week and last week can be changed. Ask admin to fix older weeks.';
  return null;
}

function evaluate(m, entry, week) {
  const e = entry ? { value: entry.value === null ? null : Number(entry.value), total: entry.total === null ? null : Number(entry.total) } : null;
  return calc.evaluateHq({ measure: m, entry: e, target: targetFor(m, week) });
}

// The input page: every measure with this week's entry and target.
async function loadHqWeek(db, { week, user }) {
  const [measures, entries] = await Promise.all([loadHqMeasures(db), loadHqEntries(db, week, week)]);
  return measures.map((m) => {
    const entry = entries.get(`${week}|${m.id}`) || null;
    return { ...m, entry, target: targetFor(m, week), result: evaluate(m, entry, week), canEdit: canEditMeasure(user, m) };
  });
}

// What a person typed → { value, total } in stored units, or { error }.
function parseEntry(m, valueText, totalText) {
  if (m.input === 'yes_no') {
    const v = String(valueText ?? '').trim().toLowerCase();
    if (v === '') return { value: null, total: null };
    if (v === 'yes' || v === '1') return { value: 1, total: null };
    if (v === 'no' || v === '0') return { value: 0, total: null };
    return { error: 'Choose Yes or No.' };
  }
  if (m.input === 'done_and_total') {
    const done = parseOptional(valueText, { min: 0 });
    const total = parseOptional(totalText, { min: 0 });
    if (done.error) return { error: `Done: ${done.error}` };
    if (total.error) return { error: `Total: ${total.error}` };
    if (done.value === null && total.value === null) return { value: null, total: null };
    if (done.value === null || total.value === null) return { error: 'Fill in both: how many were done, out of how many.' };
    if (total.value === 0) return { error: 'The total can’t be 0 – leave both empty if there were none.' };
    if (done.value > total.value) return { error: 'Done can’t be more than the total.' };
    return { value: done.value, total: total.value };
  }
  const r = parseOptional(valueText, { min: 0 });
  if (r.error) return { error: r.error };
  if (r.value !== null && isPercent(m)) {
    if (r.value > 100) return { error: 'A percentage can’t be over 100.' };
    return { value: r.value / 100, total: null };
  }
  return { value: r.value, total: null };
}

// Returns { errors } (by measure id) or { saved }.
async function saveHqWeek(db, user, week, body) {
  const measures = (await loadHqMeasures(db)).filter((m) => canEditMeasure(user, m));
  const v = body.v || {};
  const t = body.t || {};
  const errors = {};
  const plans = [];
  for (const m of measures) {
    const key = `m${m.id}`;
    if (v[key] === undefined && t[key] === undefined) continue;
    const r = parseEntry(m, v[key], t[key]);
    if (r.error) errors[m.id] = r.error; else plans.push({ m, ...r });
  }
  if (Object.keys(errors).length) return { errors };

  let saved = 0;
  await db.transaction(async (tx) => {
    const before = await loadHqEntries(tx, week, week);
    for (const p of plans) {
      const old = before.get(`${week}|${p.m.id}`);
      const oldV = old ? { value: old.value === null ? null : Number(old.value), total: old.total === null ? null : Number(old.total) } : null;
      const key = `HQ ${week} ${p.m.code}`;
      if (p.value === null) {
        if (old) {
          await tx.query('DELETE FROM hq_entries WHERE id = $1', [old.id]);
          await audit(tx, user, 'delete', 'hq_entries', key, oldV, null);
          saved++;
        }
        continue;
      }
      if (oldV && Math.abs(oldV.value - p.value) < 1e-9 && (oldV.total ?? null) === (p.total ?? null)) continue;
      await tx.query(
        `INSERT INTO hq_entries (week_start, hq_measure_id, value, total, entered_by, updated_at)
         VALUES ($1, $2, $3, $4, $5, now())
         ON CONFLICT (week_start, hq_measure_id) DO UPDATE SET value = EXCLUDED.value, total = EXCLUDED.total,
           entered_by = EXCLUDED.entered_by, updated_at = now()`,
        [week, p.m.id, p.value, p.total, user.id]);
      await audit(tx, user, old ? 'update' : 'insert', 'hq_entries', key, oldV, { value: p.value, total: p.total });
      saved++;
    }
  });
  return { saved };
}

// HQ scoreboard: the chosen week per measure plus a trend over the last 12 weeks.
async function buildHqScoreboard(db, { week, trackerStart }) {
  const weeks = trendWeeks(trackerStart, week, 12);
  const [measures, entries] = await Promise.all([loadHqMeasures(db), loadHqEntries(db, weeks[0], week)]);
  const rows = measures.map((m) => {
    const entry = entries.get(`${week}|${m.id}`) || null;
    return {
      ...m, entry, target: targetFor(m, week), result: evaluate(m, entry, week),
      trend: weeks.map((w) => {
        const e = entries.get(`${w}|${m.id}`) || null;
        return { week: w, entry: e, result: evaluate(m, e, w) };
      }),
    };
  });
  const owners = [...new Set(measures.map((m) => m.owner_name))];
  return {
    week, weekEnd: calc.addDays(week, 6), month: weekMonth(week), weeks,
    groups: owners.map((o) => ({ owner: o, rows: rows.filter((r) => r.owner_name === o) })),
    entered: rows.filter((r) => r.entry).length, total: rows.length,
  };
}

// "92 days", "90%", "RM 7,000", "18 of 20 (90%)"
function show(m, n) {
  if (n === null || n === undefined || Number.isNaN(n)) return '–';
  const g = (x, d) => Number(x).toLocaleString('en-MY', { maximumFractionDigits: d });
  if (m.input === 'yes_no') return Number(n) >= 1 ? 'Yes' : 'No';
  if (isPercent(m)) return `${g(n * 100, 1)}%`;
  if (m.unit === 'RM') return `RM ${g(n, 0)}`;
  return `${g(n, 1)}${m.unit ? ` ${m.unit}` : ''}`;
}

// Value to put back in the input box.
function inputValue(m, entry, field = 'value') {
  if (!entry || entry[field] === null || entry[field] === undefined) return '';
  const n = Number(entry[field]);
  if (m.input === 'yes_no') return n >= 1 ? 'yes' : 'no';
  return field === 'value' && isPercent(m) && m.input !== 'done_and_total' ? String(Math.round(n * 10000) / 100) : String(n);
}

module.exports = {
  loadHqMeasures, loadHqWeek, saveHqWeek, buildHqScoreboard, canEditMeasure, weekDenied, parseEntry, targetFor, show, inputValue,
};
