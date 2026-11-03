// 3 Nov 2026 (CEO): "allow managers to make edits on activity. Not WIG. Lead measures can change
// after approval." The branch's measures, in three tiers:
//   WIG       – locked for managers (admin changes them in Admin → Measures / Targets)
//   Lead      – the manager proposes a change; it applies when the CEO (super admin) approves it
//   Activity  – everything else; the manager changes it straight away
// What can change: the measure's name, the box name on Daily entry, the owner (Team or a person of
// the branch), and the target for this month and next (daily measures that add up also have the
// busy-day target). Activities can also be taken off the scoreboard (history kept).

const calc = require('../calc');
const { loadMeasures } = require('../daily/data');
const { isTopMeasure } = require('../scoreboard/data');
const { audit, parseOptional } = require('../admin/common');
const { cleanText } = require('../weekly/access');

const tierOf = (m, branch) => (m.kind === 'WIG' ? 'wig' : isTopMeasure(m, branch) || m.kind === 'Lead' ? 'lead' : 'activity');
const isPct = (m) => m.calc === 'ratio_percent' || m.calc === 'average_percent';
const hasBusyDay = (m) => m.target_per === 'day' && m.calc === 'sum';
const months = (today) => [calc.monthOf(today), calc.monthOf(calc.addDays(calc.monthEnd(calc.monthOf(today)), 1))];
const num = (v) => (v === null || v === undefined ? null : Number(v));
const same = (a, b) => (a === null && b === null) || (a !== null && b !== null && Math.abs(a - b) < 1e-9);

const canEdit = (user, branch) => user.role === 'admin' || (user.role === 'branch_manager' && user.branch_id === branch.id);
const isCeo = (user) => user.role === 'admin' && Boolean(user.is_super);

async function loadPage(db, { branch, today }) {
  const ms = months(today);
  const [measures, fields, people, pending] = await Promise.all([
    loadMeasures(db, branch.id),
    db.query('SELECT key, label FROM daily_fields WHERE branch_id = $1 AND active', [branch.id]),
    db.query('SELECT id, name FROM people WHERE branch_id = $1 AND active ORDER BY sort_order', [branch.id]),
    db.query(`SELECT c.*, u.display_name AS proposed_by_name FROM measure_changes c LEFT JOIN users u ON u.id = c.proposed_by
              WHERE c.branch_id = $1 AND c.status = 'Waiting' ORDER BY c.id`, [branch.id]),
  ]);
  const fieldLabel = new Map(fields.rows.map((f) => [f.key, f.label]));
  const rows = measures.map((m) => ({
    id: m.id, code: m.code, label: m.label, owner: m.owner_name, kind: m.kind, unit: m.unit, calc: m.calc, targetPer: m.target_per,
    fieldKey: m.numerator_field, fieldLabel: fieldLabel.get(m.numerator_field) || '', tier: tierOf(m, branch),
    pct: isPct(m), busy: hasBusyDay(m), highDays: calc.highDaysLabel(m.high_days),
    targets: Object.fromEntries(ms.map((mo) => [mo, { t: num(m.targets[mo]), w: num((m.weekend_targets || {})[mo]) }])),
    pending: pending.rows.filter((c) => c.measure_id === m.id),
  }));
  return { months: ms, rows, owners: ['Team', ...people.rows.map((p) => p.name)], pendingCount: pending.rows.length };
}

// Form for one measure → { change } (only what differs) or { error }.
function readChange(row, body, owners, ms) {
  const change = {};
  const label = cleanText(body.label, { max: 120, label: 'Name' });
  if (label.error) return { error: label.error };
  if (label.value && label.value !== row.label) change.label = label.value;
  if (body.field_label !== undefined) {
    const fl = cleanText(body.field_label, { max: 120, label: 'Box name' });
    if (fl.error) return { error: fl.error };
    if (fl.value && fl.value !== row.fieldLabel) change.field_label = fl.value;
  }
  if (body.owner !== undefined) {
    if (!owners.includes(body.owner)) return { error: 'Pick the owner from the list.' };
    if (body.owner !== row.owner) change.owner = body.owner;
  }
  const t = {};
  for (const mo of ms) {
    const typed = body.t && body.t[`m${mo.replace('-', '')}`];
    if (!typed || typeof typed !== 'object') continue;
    const pt = parseOptional(typed.t, { max: row.pct ? 100 : 10_000_000 });
    if (pt.error) return { error: `Target ${mo}: ${pt.error}` };
    const newT = pt.value === null ? null : row.pct ? pt.value / 100 : pt.value;
    let newW = row.targets[mo].w;
    if (row.busy && typed.w !== undefined) {
      const pw = parseOptional(typed.w, { max: 10_000_000 });
      if (pw.error) return { error: `Busy-day target ${mo}: ${pw.error}` };
      newW = pw.value;
    }
    if (!same(newT, row.targets[mo].t) || !same(newW, row.targets[mo].w)) t[mo] = { t: newT, w: newW };
  }
  if (Object.keys(t).length) change.targets = t;
  return { change };
}

async function applyChange(tx, user, branch, measureId, change) {
  const m = (await tx.query('SELECT * FROM measures WHERE id = $1 AND branch_id = $2', [measureId, branch.id])).rows[0];
  if (!m) return;
  const key = `${branch.code} ${m.code}`;
  if (change.label) {
    await tx.query('UPDATE measures SET label = $2 WHERE id = $1', [m.id, change.label]);
    await audit(tx, user, 'update', 'measures', `${key} label`, m.label, change.label);
  }
  if (change.owner) {
    await tx.query(`UPDATE measures SET owner_name = $2, person_id = (SELECT id FROM people WHERE branch_id = $3 AND name = $2 AND active LIMIT 1) WHERE id = $1`,
      [m.id, change.owner, branch.id]);
    // The box moves to the new owner's card on Daily entry too.
    await tx.query(`UPDATE daily_fields SET owner_name = $3, person_id = (SELECT id FROM people WHERE branch_id = $1 AND name = $3 AND active LIMIT 1)
      WHERE branch_id = $1 AND key = $2`, [branch.id, m.numerator_field, change.owner]);
    await audit(tx, user, 'update', 'measures', `${key} owner`, m.owner_name, change.owner);
  }
  if (change.field_label) {
    const f = (await tx.query('SELECT label FROM daily_fields WHERE branch_id = $1 AND key = $2', [branch.id, m.numerator_field])).rows[0];
    await tx.query('UPDATE daily_fields SET label = $3 WHERE branch_id = $1 AND key = $2', [branch.id, m.numerator_field, change.field_label]);
    await audit(tx, user, 'update', 'daily_fields', `${branch.code} ${m.numerator_field} label`, f ? f.label : null, change.field_label);
  }
  for (const [mo, v] of Object.entries(change.targets || {})) {
    const before = (await tx.query('SELECT target, weekend_target FROM measure_targets WHERE measure_id = $1 AND month = $2', [m.id, mo])).rows[0];
    await tx.query(`INSERT INTO measure_targets (measure_id, month, target, weekend_target) VALUES ($1, $2, $3, $4)
      ON CONFLICT (measure_id, month) DO UPDATE SET target = EXCLUDED.target, weekend_target = EXCLUDED.weekend_target`, [m.id, mo, v.t, v.w]);
    await audit(tx, user, 'update', 'measure_targets', `${key} ${mo}`, before ? { t: num(before.target), w: num(before.weekend_target) } : null, v);
  }
}

// Save one measure from the manager's page. Activity → applied; lead → waiting for the CEO
// (the CEO's own edits apply at once); WIG → refused unless admin.
async function saveMeasure(db, user, { branch, measureId, body, today }) {
  const page = await loadPage(db, { branch, today });
  const row = page.rows.find((r) => r.id === Number(measureId));
  if (!row) return { error: 'That measure isn’t on this branch.' };
  if (!canEdit(user, branch)) return { error: 'Only the branch manager or admin can change measures.' };
  if (row.tier === 'wig' && user.role !== 'admin') return { error: 'The WIG can’t be changed here – ask Dr Aisyah.' };
  const r = readChange(row, body, page.owners, page.months);
  if (r.error) return { error: r.error };
  if (!Object.keys(r.change).length) return { ok: 'No changes.' };
  const reason = cleanText(body.reason, { max: 300, label: 'Why' });
  if (reason.error) return { error: reason.error };
  if (row.tier === 'lead' && !isCeo(user)) {
    await db.transaction(async (tx) => {
      await tx.query("UPDATE measure_changes SET status = 'Withdrawn', decided_by = $2, decided_at = now() WHERE measure_id = $1 AND status = 'Waiting'", [row.id, user.id]);
      await tx.query('INSERT INTO measure_changes (measure_id, branch_id, change, reason, proposed_by) VALUES ($1, $2, $3, $4, $5)',
        [row.id, branch.id, JSON.stringify(r.change), reason.value, user.id]);
      await audit(tx, user, 'insert', 'measure_changes', `${branch.code} ${row.code}`, null, r.change);
    });
    return { ok: `Sent to Dr Aisyah for approval – “${row.label}” changes when she approves.`, waiting: true };
  }
  await db.transaction(async (tx) => applyChange(tx, user, branch, row.id, r.change));
  return { ok: `Saved “${r.change.label || row.label}”.` };
}

async function retireActivity(db, user, { branch, measureId, today }) {
  const page = await loadPage(db, { branch, today });
  const row = page.rows.find((r) => r.id === Number(measureId));
  if (!row || !canEdit(user, branch)) return { error: 'Not allowed.' };
  if (row.tier !== 'activity' && user.role !== 'admin') return { error: 'Only activities can be taken off here.' };
  await db.transaction(async (tx) => {
    await tx.query('UPDATE measures SET active = false WHERE id = $1', [row.id]);
    const others = (await tx.query('SELECT count(*)::int AS n FROM measures WHERE branch_id = $1 AND active AND (numerator_field = $2 OR denominator_field = $2)', [branch.id, row.fieldKey])).rows[0].n;
    if (!others) await tx.query('UPDATE daily_fields SET active = false WHERE branch_id = $1 AND key = $2', [branch.id, row.fieldKey]);
    await audit(tx, user, 'deactivate', 'measures', `${branch.code} ${row.code}`, true, false);
  });
  return { ok: `“${row.label}” is off the scoreboard and Daily entry. Its history is kept.` };
}

// The CEO's list of lead changes waiting, every branch.
async function loadWaiting(db) {
  const { rows } = await db.query(
    `SELECT c.*, b.code AS branch_code, b.name AS branch_name, m.label, m.code, m.owner_name, m.calc, m.numerator_field, u.display_name AS proposed_by_name
     FROM measure_changes c JOIN branches b ON b.id = c.branch_id JOIN measures m ON m.id = c.measure_id LEFT JOIN users u ON u.id = c.proposed_by
     WHERE c.status = 'Waiting' ORDER BY c.proposed_at`);
  return rows.map((r) => ({ ...r, change: typeof r.change === 'string' ? JSON.parse(r.change) : r.change }));
}

async function decide(db, user, { id, approve, note }) {
  if (!isCeo(user)) return { error: 'Only Dr Aisyah approves lead measure changes.' };
  const c = (await db.query("SELECT * FROM measure_changes WHERE id = $1 AND status = 'Waiting'", [id])).rows[0];
  if (!c) return { error: 'That change isn’t waiting any more.' };
  const n = cleanText(note, { max: 300, label: 'Note' });
  if (n.error) return { error: n.error };
  const branch = (await db.query('SELECT * FROM branches WHERE id = $1', [c.branch_id])).rows[0];
  await db.transaction(async (tx) => {
    await tx.query('UPDATE measure_changes SET status = $2, decided_by = $3, decided_at = now(), decision_note = $4 WHERE id = $1',
      [c.id, approve ? 'Approved' : 'Not approved', user.id, n.value]);
    if (approve) await applyChange(tx, user, branch, c.measure_id, typeof c.change === 'string' ? JSON.parse(c.change) : c.change);
    await audit(tx, user, 'update', 'measure_changes', `${branch.code} #${c.id}`, 'Waiting', approve ? 'Approved' : 'Not approved');
  });
  return { ok: approve ? 'Approved – the change is live.' : 'Not approved – the branch keeps the current measure.' };
}

// Recent decisions for the branch page (last 30 days).
async function recentDecisions(db, branchId) {
  const { rows } = await db.query(
    `SELECT c.*, m.label, u.display_name AS decided_by_name FROM measure_changes c JOIN measures m ON m.id = c.measure_id LEFT JOIN users u ON u.id = c.decided_by
     WHERE c.branch_id = $1 AND c.status IN ('Approved', 'Not approved') AND c.decided_at > now() - interval '30 days' ORDER BY c.decided_at DESC LIMIT 10`, [branchId]);
  return rows;
}

module.exports = { tierOf, loadPage, readChange, saveMeasure, retireActivity, loadWaiting, decide, recentDecisions, canEdit, isCeo, months };
