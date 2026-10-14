// Admin → Measures & daily fields. A measure reads one daily field (and a second one for
// ratios); daily fields are the boxes staff fill in. Changes are checked so a scoreboard can
// never point at a field that doesn't exist.

const { audit, slug } = require('./common');
const { mentionsSalary, SALARY_MESSAGE } = require('../privacy');

const KINDS = ['WIG', 'Lead', 'Routine', 'Stream', 'Result'];
const TARGET_PER = ['day', 'week', 'month'];
const CALCS = ['sum', 'ratio_percent', 'ratio_per_day'];
const FIELD_TYPES = ['money', 'count', 'yes_no'];
const MEASURE_COLS = ['label', 'owner_name', 'kind', 'unit', 'target_per', 'calc', 'numerator_field', 'denominator_field', 'note'];

async function loadMeasuresAdmin(db, branch) {
  const [measures, fields, people] = await Promise.all([
    db.query('SELECT * FROM measures WHERE branch_id = $1 ORDER BY active DESC, sort_order', [branch.id]),
    db.query('SELECT * FROM daily_fields WHERE branch_id = $1 ORDER BY active DESC, sort_order', [branch.id]),
    db.query('SELECT name FROM people WHERE branch_id = $1 AND active ORDER BY sort_order', [branch.id]),
  ]);
  // Owners to choose from: Team, everyone active, plus any current owner who has since been
  // removed – otherwise saving a measure would quietly move it to "Team".
  const owners = ['Team', ...people.rows.map((p) => p.name)];
  for (const r of [...measures.rows, ...fields.rows]) if (!owners.includes(r.owner_name)) owners.push(r.owner_name);
  return { measures: measures.rows, fields: fields.rows, owners };
}

function readMeasureForm(body, fieldKeys, owners) {
  const m = {
    label: String(body.label || '').trim(),
    owner_name: String(body.owner_name || 'Team'),
    kind: String(body.kind || ''),
    unit: String(body.unit || '').trim(),
    target_per: String(body.target_per || ''),
    calc: String(body.calc || ''),
    numerator_field: String(body.numerator_field || ''),
    denominator_field: body.denominator_field ? String(body.denominator_field) : null,
    note: String(body.note || '').trim(),
  };
  const errors = [];
  if (!m.label) errors.push('Type a name for the measure.');
  if (mentionsSalary(m.label, m.unit, m.note)) errors.push(SALARY_MESSAGE);
  if (!owners.includes(m.owner_name)) errors.push('Pick an owner from the list.');
  if (!KINDS.includes(m.kind)) errors.push('Pick a kind.');
  if (!TARGET_PER.includes(m.target_per)) errors.push('Pick whether the target is per day, week or month.');
  if (!CALCS.includes(m.calc)) errors.push('Pick how it is worked out.');
  if (!fieldKeys.includes(m.numerator_field)) errors.push('Pick the daily field it counts.');
  if (m.calc === 'sum') m.denominator_field = null;
  else if (!m.denominator_field || !fieldKeys.includes(m.denominator_field)) errors.push('A % or per-day measure needs a second field to divide by.');
  else if (m.denominator_field === m.numerator_field) errors.push('The two fields must be different.');
  return { m, errors };
}

async function updateMeasure(db, { branch, measureId, body, user }) {
  const ctx = await loadMeasuresAdmin(db, branch);
  const before = ctx.measures.find((x) => x.id === Number(measureId));
  if (!before) return { error: 'That measure doesn’t exist.' };
  const { m, errors } = readMeasureForm(body, ctx.fields.filter((f) => f.active).map((f) => f.key), ctx.owners);
  if (errors.length) return { error: errors.join(' ') };
  const changed = MEASURE_COLS.filter((c) => String(before[c] ?? '') !== String(m[c] ?? ''));
  if (!changed.length) return { ok: 'No changes.' };
  await db.transaction(async (tx) => {
    if ((m.target_per !== 'day' || m.calc !== 'sum') && (before.target_per === 'day' && before.calc === 'sum')) {
      // Weekend targets only apply to daily measures that add up.
      const had = (await tx.query('SELECT count(*)::int AS n FROM measure_targets WHERE measure_id = $1 AND weekend_target IS NOT NULL', [before.id])).rows[0].n;
      if (had) {
        await tx.query('UPDATE measure_targets SET weekend_target = NULL WHERE measure_id = $1', [before.id]);
        await audit(tx, user, 'update', 'measure_targets', `${branch.code} ${before.code} weekend targets cleared`, had, null);
      }
    }
    await tx.query(
      `UPDATE measures SET label=$2, owner_name=$3, kind=$4, unit=$5, target_per=$6, calc=$7, numerator_field=$8, denominator_field=$9, note=$10,
         person_id = (SELECT id FROM people WHERE branch_id = $11 AND name = $3 LIMIT 1)
       WHERE id = $1`,
      [before.id, m.label, m.owner_name, m.kind, m.unit, m.target_per, m.calc, m.numerator_field, m.denominator_field, m.note, branch.id]);
    for (const c of changed) await audit(tx, user, 'update', 'measures', `${branch.code} ${before.code} ${c}`, before[c], m[c]);
  });
  return { ok: `Saved ${m.label}.` };
}

async function addMeasure(db, { branch, body, user }) {
  const ctx = await loadMeasuresAdmin(db, branch);
  const { m, errors } = readMeasureForm(body, ctx.fields.filter((f) => f.active).map((f) => f.key), ctx.owners);
  const code = String(body.code || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!code) errors.push('Type a short code (e.g. W8).');
  else if (ctx.measures.some((x) => x.code === code)) errors.push(`${branch.code} already has a measure ${code}.`);
  if (errors.length) return { error: errors.join(' ') };
  await db.transaction(async (tx) => {
    const order = (await tx.query('SELECT COALESCE(MAX(sort_order), 0) + 1 AS n FROM measures WHERE branch_id = $1', [branch.id])).rows[0].n;
    const row = (await tx.query(
      `INSERT INTO measures (branch_id, code, owner_name, person_id, label, kind, unit, target_per, calc, numerator_field, denominator_field, note, sort_order)
       VALUES ($1,$2,$3,(SELECT id FROM people WHERE branch_id = $1 AND name = $3 LIMIT 1),$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
      [branch.id, code, m.owner_name, m.label, m.kind, m.unit, m.target_per, m.calc, m.numerator_field, m.denominator_field, m.note, order])).rows[0];
    // Same months as the branch, no target yet (track only) – set them under Targets.
    await tx.query(
      `INSERT INTO measure_targets (measure_id, month, target)
       SELECT $1, month, NULL FROM branch_month_targets WHERE branch_id = $2`, [row.id, branch.id]);
    await audit(tx, user, 'insert', 'measures', `${branch.code} ${code}`, null, { code, ...m });
  });
  return { ok: `Added ${code} ${m.label}. It has no target yet – set it under Targets.` };
}

async function setMeasureActive(db, { branch, measureId, active, user }) {
  const m = (await db.query('SELECT * FROM measures WHERE id = $1 AND branch_id = $2', [measureId, branch.id])).rows[0];
  if (!m) return { error: 'That measure doesn’t exist.' };
  await db.query('UPDATE measures SET active = $2 WHERE id = $1', [m.id, active]);
  await audit(db, user, active ? 'reactivate' : 'deactivate', 'measures', `${branch.code} ${m.code}`, !active, active);
  return { ok: active ? `${m.code} is back on the scoreboard.` : `${m.code} is off the scoreboard. Its history is kept.` };
}

// ── Daily fields ──

async function fieldUsage(db, branch, key) {
  const uses = [];
  const ms = (await db.query(
    'SELECT code FROM measures WHERE branch_id = $1 AND active AND (numerator_field = $2 OR denominator_field = $2)', [branch.id, key])).rows;
  if (ms.length) uses.push(`measure ${ms.map((r) => r.code).join(', ')}`);
  const b = (await db.query('SELECT * FROM branches WHERE id = $1', [branch.id])).rows[0];
  const arr = (v) => (typeof v === 'string' ? JSON.parse(v) : v) || [];
  if (arr(b.total_sales_fields).includes(key)) uses.push('total branch sales');
  if ([b.lead1_field, b.lead2_field, b.zakat_field].includes(key)) uses.push('the branch lead/zakat settings');
  const rt = (await db.query('SELECT code FROM running_totals WHERE branch_id = $1 AND field_key = $2', [branch.id, key])).rows;
  if (rt.length) uses.push('a running total');
  const sheet = typeof b.sales_sheet === 'string' ? JSON.parse(b.sales_sheet) : b.sales_sheet;
  if (sheet && sheet.columns && sheet.columns[key]) uses.push('the sales sheet link');
  return uses;
}

async function updateField(db, { branch, fieldId, body, user }) {
  const ctx = await loadMeasuresAdmin(db, branch);
  const f = ctx.fields.find((x) => x.id === Number(fieldId));
  if (!f) return { error: 'That field doesn’t exist.' };
  const next = {
    label: String(body.label || '').trim() || f.label,
    owner_name: ctx.owners.includes(body.owner_name) ? body.owner_name : f.owner_name,
    type: FIELD_TYPES.includes(body.type) ? body.type : f.type,
  };
  if (mentionsSalary(next.label)) return { error: SALARY_MESSAGE };
  const changed = Object.keys(next).filter((k) => next[k] !== f[k]);
  if (!changed.length) return { ok: 'No changes.' };
  await db.transaction(async (tx) => {
    await tx.query(
      `UPDATE daily_fields SET label = $2, owner_name = $3, type = $4,
         person_id = (SELECT id FROM people WHERE branch_id = $5 AND name = $3 LIMIT 1) WHERE id = $1`,
      [f.id, next.label, next.owner_name, next.type, branch.id]);
    for (const k of changed) await audit(tx, user, 'update', 'daily_fields', `${branch.code} ${f.key} ${k}`, f[k], next[k]);
  });
  return { ok: `Saved “${next.label}”.` };
}

async function addField(db, { branch, body, user }) {
  const ctx = await loadMeasuresAdmin(db, branch);
  const key = slug(body.key);
  const label = String(body.label || '').trim();
  const owner = String(body.owner_name || 'Team');
  const type = String(body.type || 'count');
  if (!key) return { error: 'Type a short key (letters and numbers, e.g. pwp2).' };
  if (mentionsSalary(key, label)) return { error: SALARY_MESSAGE };
  if (ctx.fields.some((f) => f.key === key)) return { error: `${branch.code} already has a field “${key}”.` };
  if (!label) return { error: 'Type what staff will see (e.g. “Leaflets handed out”).' };
  if (!ctx.owners.includes(owner)) return { error: 'Pick an owner from the list.' };
  if (!FIELD_TYPES.includes(type)) return { error: 'Pick money, count or yes/no.' };
  await db.transaction(async (tx) => {
    const order = (await tx.query('SELECT COALESCE(MAX(sort_order), 0) + 1 AS n FROM daily_fields WHERE branch_id = $1', [branch.id])).rows[0].n;
    await tx.query(
      `INSERT INTO daily_fields (branch_id, key, label, owner_name, person_id, type, sort_order)
       VALUES ($1, $2, $3, $4, (SELECT id FROM people WHERE branch_id = $1 AND name = $4 LIMIT 1), $5, $6)`,
      [branch.id, key, label, owner, type, order]);
    await audit(tx, user, 'insert', 'daily_fields', `${branch.code} ${key}`, null, { key, label, owner, type });
  });
  return { ok: `Added “${label}” to ${owner === 'Team' ? 'the Team card' : `${owner}’s card`}. Add a measure if it needs a target.` };
}

async function setFieldActive(db, { branch, fieldId, active, user }) {
  const f = (await db.query('SELECT * FROM daily_fields WHERE id = $1 AND branch_id = $2', [fieldId, branch.id])).rows[0];
  if (!f) return { error: 'That field doesn’t exist.' };
  if (!active) {
    const uses = await fieldUsage(db, branch, f.key);
    if (uses.length) return { error: `“${f.label}” is still used by ${uses.join(', ')}. Change those first.` };
  }
  await db.query('UPDATE daily_fields SET active = $2 WHERE id = $1', [f.id, active]);
  await audit(db, user, active ? 'reactivate' : 'deactivate', 'daily_fields', `${branch.code} ${f.key}`, !active, active);
  return { ok: active ? `“${f.label}” is back on the daily entry.` : `“${f.label}” is off the daily entry. Past numbers are kept.` };
}

module.exports = {
  KINDS, TARGET_PER, CALCS, FIELD_TYPES,
  loadMeasuresAdmin, updateMeasure, addMeasure, setMeasureActive, updateField, addField, setFieldActive, fieldUsage,
};
