// Loads everything the Daily Entry screen needs, and saves what was typed.

const calc = require('../calc');

const MAX_VALUE = 10_000_000;

// "Grab online all hours? (1/0)" → "Grab online all hours?" – the yes/no buttons say it already.
const cleanLabel = (label) => label.replace(/\s*\(1\/0\)/, '');

// ─────────────── Loading ───────────────

async function loadBranch(db, code) {
  const { rows } = await db.query('SELECT * FROM branches WHERE code = $1 AND active', [code]);
  return rows[0] || null;
}

async function loadMeasures(db, branchId) {
  const { rows } = await db.query(
    `SELECT m.*, COALESCE(json_object_agg(t.month, t.target) FILTER (WHERE t.month IS NOT NULL), '{}') AS targets,
       COALESCE(json_object_agg(t.month, t.weekend_target) FILTER (WHERE t.weekend_target IS NOT NULL), '{}') AS weekend_targets
     FROM measures m LEFT JOIN measure_targets t ON t.measure_id = m.id
     WHERE m.branch_id = $1 AND m.active
     GROUP BY m.id ORDER BY m.sort_order`,
    [branchId]
  );
  const obj = (v) => (typeof v === 'string' ? JSON.parse(v) : v);
  return rows.map((m) => ({ ...m, targets: obj(m.targets), weekend_targets: obj(m.weekend_targets) }));
}

// The hint under each input: what "on target" means for this field on this date.
//   day     – compare today's number with today's target
//   period  – weekly/monthly targets: week (or month) so far + today vs the target up to today
//   ratio   – e.g. 2+ item transactions ÷ transactions vs 45%
//   perday  – Ampang storefront: only counts on days with 2 staff on duty
//   track   – measure has no target this month
function buildHint(field, measures, entries, date, trackerStart) {
  const m = measures.find((x) => x.numerator_field === field.key);
  if (!m) return null;
  const base = { measure: m.label, code: m.code, money: field.type === 'money' };
  const target = calc.monthTarget(m.targets, date);
  if (target === null) return { ...base, kind: 'track' };

  if (m.calc === 'ratio_percent') return { ...base, kind: 'ratio', den: m.denominator_field, target };
  if (m.calc === 'ratio_per_day') return { ...base, kind: 'perday', gate: m.denominator_field, target };

  if (m.target_per === 'day') return { ...base, kind: 'day', target: calc.dailyTarget(m.targets, 'day', date, m.weekend_targets) };

  // Weekly or monthly target: progress so far this week/month, counted from the tracker start.
  const periodStart = m.target_per === 'week' ? calc.weekStart(date) : calc.monthStart(calc.monthOf(date));
  const periodEnd = m.target_per === 'week' ? calc.weekEnd(date) : calc.monthEnd(calc.monthOf(date));
  const from = periodStart < trackerStart ? trackerStart : periodStart;
  let soFar = 0;
  let targetToDate = 0;
  let targetFull = 0;
  for (const d of calc.dateRange(from, periodEnd)) {
    const t = calc.dailyTarget(m.targets, m.target_per, d, m.weekend_targets) || 0;
    targetFull += t;
    if (d <= date) targetToDate += t;
    if (d < date) soFar += entries.get(d, field.key) || 0;
  }
  return { ...base, kind: 'period', period: m.target_per, soFar, targetToDate, targetFull };
}

// For "…of which within 24h" fields: the number can't be bigger than its parent field.
function maxOfMap(measures) {
  const map = {};
  for (const m of measures) if (m.calc === 'ratio_percent') map[m.numerator_field] = m.denominator_field;
  return map;
}

async function loadDailyPage(db, { branch, date, user, trackerStart }) {
  const [fieldsRes, peopleRes, measures] = await Promise.all([
    db.query('SELECT * FROM daily_fields WHERE branch_id = $1 AND active ORDER BY sort_order', [branch.id]),
    db.query('SELECT * FROM people WHERE branch_id = $1 AND active ORDER BY sort_order', [branch.id]),
    loadMeasures(db, branch.id),
  ]);

  const from = [calc.weekStart(date), calc.monthStart(calc.monthOf(date))].sort()[0];
  const entryRows = (await db.query(
    `SELECT entry_date, field_key, value FROM daily_entries
     WHERE branch_id = $1 AND entry_date BETWEEN $2 AND $3`,
    [branch.id, from, date]
  )).rows;
  const entries = calc.indexEntries(entryRows);

  const lastSaved = (await db.query(
    `SELECT e.updated_at, u.display_name FROM daily_entries e LEFT JOIN users u ON u.id = e.entered_by
     WHERE e.branch_id = $1 AND e.entry_date = $2 ORDER BY e.updated_at DESC LIMIT 1`,
    [branch.id, date]
  )).rows[0] || null;

  const maxOf = maxOfMap(measures);
  const fieldView = (f) => ({
    key: f.key, label: cleanLabel(f.label), type: f.type,
    value: entries.get(date, f.key),
    stored: entries.get(date, f.key),
    hint: buildHint(f, measures, entries, date, trackerStart),
    maxOf: maxOf[f.key] || null,
  });

  // One card per owner: Team first, then the person logged in, then everyone else.
  const people = peopleRes.rows;
  const cards = [];
  const teamFields = fieldsRes.rows.filter((f) => f.owner_name === 'Team');
  if (teamFields.length) {
    cards.push({ id: 'team', name: 'Team', role: 'Whoever closes', fields: teamFields.map(fieldView) });
  }
  const ordered = [...people].sort((a, b) =>
    (a.id === user.person_id ? -1 : 0) - (b.id === user.person_id ? -1 : 0) || a.sort_order - b.sort_order);
  for (const p of ordered) {
    const own = fieldsRes.rows.filter((f) => f.owner_name === p.name);
    if (own.length) cards.push({ id: `p${p.id}`, name: p.name, role: p.role, isMe: p.id === user.person_id, fields: own.map(fieldView) });
  }
  const labels = Object.fromEntries(fieldsRes.rows.map((f) => [f.key, cleanLabel(f.label)]));
  for (const c of cards) {
    c.filled = c.fields.filter((f) => f.value !== null).length;
    for (const f of c.fields) {
      if (f.hint && f.hint.den) f.hint.denLabel = labels[f.hint.den];
      if (f.hint && f.hint.gate) f.hint.gateLabel = labels[f.hint.gate];
      if (f.maxOf) f.maxOfLabel = labels[f.maxOf];
    }
  }

  // Which dates in the strip already have numbers.
  const filledDates = new Set(
    (await db.query(
      `SELECT DISTINCT entry_date FROM daily_entries WHERE branch_id = $1 AND entry_date BETWEEN $2 AND $3`,
      [branch.id, calc.addDays(date, -14), calc.addDays(date, 14)]
    )).rows.map((r) => r.entry_date)
  );

  return { cards, lastSaved, filledDates, fieldCount: fieldsRes.rows.length };
}

// ─────────────── Saving ───────────────

// input: { fieldKey: 'typed text' } for every field on the page. Blank = no number.
function parseEntries(fields, input, maxOf) {
  const values = {};
  const errors = {};
  for (const f of fields) {
    const raw = input[f.key];
    const text = raw === undefined || raw === null ? '' : String(raw).trim().replace(/,/g, '');
    if (text === '') { values[f.key] = null; continue; }
    const n = Number(text);
    if (!Number.isFinite(n) || !/^\d*\.?\d*$/.test(text)) { errors[f.key] = 'Numbers only.'; continue; }
    if (n < 0) { errors[f.key] = 'Can’t be below 0.'; continue; }
    if (n > MAX_VALUE) { errors[f.key] = 'That number looks too big.'; continue; }
    if (f.type === 'yes_no' && n !== 0 && n !== 1) { errors[f.key] = 'Choose yes or no.'; continue; }
    if (f.type !== 'money' && Math.round(n * 100) !== n * 100) { errors[f.key] = 'Use up to 2 decimals.'; continue; }
    values[f.key] = f.type === 'money' ? Math.round(n * 100) / 100 : n;
  }
  for (const [num, den] of Object.entries(maxOf)) {
    if (errors[num] || values[num] === null || values[num] === undefined) continue;
    const parent = values[den];
    const parentLabel = fields.find((f) => f.key === den)?.label || den;
    if (parent === null || parent === undefined) errors[num] = `Fill in “${parentLabel}” too.`;
    else if (values[num] > parent) errors[num] = `Can’t be more than “${parentLabel}” (${parent}).`;
  }
  return { values, errors };
}

async function saveDailyEntries(db, { branch, date, user, input }) {
  const fields = (await db.query('SELECT key, label, type FROM daily_fields WHERE branch_id = $1 AND active', [branch.id])).rows;
  const measures = await loadMeasures(db, branch.id);
  const { values, errors } = parseEntries(fields, input, maxOfMap(measures));
  if (Object.keys(errors).length) return { errors, changes: 0 };

  let changes = 0;
  await db.transaction(async (tx) => {
    const existing = new Map(
      (await tx.query('SELECT field_key, value FROM daily_entries WHERE branch_id = $1 AND entry_date = $2', [branch.id, date]))
        .rows.map((r) => [r.field_key, Number(r.value)])
    );
    for (const f of fields) {
      const before = existing.has(f.key) ? existing.get(f.key) : null;
      const after = values[f.key];
      if (before === after) continue;
      const key = `${branch.code} ${date} ${f.key}`;
      if (after === null) {
        await tx.query('DELETE FROM daily_entries WHERE branch_id = $1 AND entry_date = $2 AND field_key = $3', [branch.id, date, f.key]);
      } else {
        await tx.query(
          `INSERT INTO daily_entries (branch_id, entry_date, field_key, value, entered_by, updated_at)
           VALUES ($1, $2, $3, $4, $5, now())
           ON CONFLICT (branch_id, entry_date, field_key)
           DO UPDATE SET value = EXCLUDED.value, entered_by = EXCLUDED.entered_by, updated_at = now()`,
          [branch.id, date, f.key, after, user.id]
        );
      }
      await tx.query(
        `INSERT INTO audit_log (user_id, action, table_name, record_key, old_value, new_value)
         VALUES ($1, $2, 'daily_entries', $3, $4, $5)`,
        [user.id, before === null ? 'insert' : after === null ? 'delete' : 'update', key,
          before === null ? null : JSON.stringify(before), after === null ? null : JSON.stringify(after)]
      );
      changes++;
    }
  });
  return { errors: {}, changes };
}

module.exports = { loadBranch, loadMeasures, buildHint, loadDailyPage, parseEntries, saveDailyEntries };
