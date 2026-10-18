// Branch WIG session (Tuesday, 18 Oct – was "Commitments"): scoreboard, what HQ will do for the
// branch, each person accounts for last week's commitment (Done / Partly / Not done + why), then
// one new commitment each for this week – ideally on a measure that was off track (✕) last week.
// A commitment can be typed by the staff on their phone (/my-week) or by the manager here.
// Finish: who attended and "session held".

const calc = require('../calc');
const { audit } = require('../admin/common');
const { buildScoreboard } = require('../scoreboard/data');
const { cleanText } = require('./access');
const { isRealDate } = require('../lib/dates');
const wig = require('../wig/data');

async function loadPeople(db, branchId) {
  return (await db.query(
    'SELECT id, name, role FROM people WHERE branch_id = $1 AND active ORDER BY sort_order, id', [branchId])).rows;
}

async function loadWeek(db, branchId, week) {
  return (await db.query(
    `SELECT c.*, p.name AS person_name, u.display_name AS updated_by_name, u.role AS created_by_role,
       (u.person_id = c.person_id) AS typed_by_self
     FROM commitments c JOIN people p ON p.id = c.person_id LEFT JOIN users u ON u.id = c.created_by
     WHERE c.branch_id = $1 AND c.week_start = $2 ORDER BY p.sort_order, p.id`, [branchId, week])).rows;
}

async function loadCommitmentsPage(db, { branch, week, today, trackerStart }) {
  const prev = calc.addDays(week, -7);
  const first = calc.weekStart(trackerStart);
  // Off-track measures from last week; in the tracker's first week, this week so far.
  const reviewWeek = prev >= first ? prev : week;
  const [people, last, current, board, session, actions] = await Promise.all([
    loadPeople(db, branch.id), loadWeek(db, branch.id, prev), loadWeek(db, branch.id, week),
    buildScoreboard(db, { branch, weekStart: reviewWeek, today, trackerStart }),
    wig.loadSession(db, branch.id, week), wig.actionsForBranchWig(db, { branchId: branch.id, week }),
  ]);
  const rows = [...board.top, ...board.groups.flatMap((g) => g.rows)];
  const offTrack = rows.filter((r) => r.week.status === 'off_track')
    .map((r) => ({ code: r.code, label: r.label, owner: r.owner, pct: r.week.pct, top: r.top }));
  return {
    session, actions, board: { top: board.top, sales: board.sales }, lastSummary: wig.resultSummary(last),
    prev, reviewWeek, reviewAsOf: board.asOf, reviewIsThisWeek: reviewWeek === week, people, last, offTrack,
    current: new Map(current.map((c) => [c.person_id, c])),
    measures: rows.map((r) => ({ code: r.code, label: r.label, offTrack: r.week.status === 'off_track' })),
  };
}

// Returns { errors } or { saved }.
async function saveCommitments(db, user, branch, week, body, { today } = {}) {
  const prev = calc.addDays(week, -7);
  const people = await loadPeople(db, branch.id);
  const lastWeek = await loadWeek(db, branch.id, prev);
  const measures = await buildMeasureLabels(db, branch.id);
  const errors = {};
  const plans = [];

  const done = body.done || {};
  const why = body.why || {};
  for (const c of lastWeek) {
    const v = done[`k${c.id}`];
    const w = why[`k${c.id}`];
    if (v === undefined && w === undefined) continue;
    const next = v === undefined ? (c.result || null) : (wig.RESULTS.includes(v) ? v : null);
    const reason = w === undefined ? { value: c.why || null } : cleanText(w, { max: 200, label: 'Why' });
    if (reason.error) { errors[`k${c.id}`] = reason.error; continue; }
    if (next !== (c.result || null) || reason.value !== (c.why || null)) plans.push({ type: 'done', c, next, why: reason.value });
  }

  const typed = body.c || {};
  for (const p of people) {
    const t = typed[`p${p.id}`];
    if (!t || typeof t !== 'object') continue;
    const text = cleanText(t.text, { max: 300, label: 'Commitment' });
    if (text.error) { errors[p.id] = text.error; continue; }
    const lead = String(t.lead ?? '').trim() || null;
    if (lead && !measures.includes(lead)) { errors[p.id] = 'Pick the measure from the list.'; continue; }
    const by = String(t.by ?? '').trim() || null;
    if (by && !isRealDate(by)) { errors[p.id] = 'By when: pick a real date.'; continue; }
    if (by && by < week) { errors[p.id] = 'By when can’t be before the week starts.'; continue; }
    plans.push({ type: 'commit', person: p, text: text.value, lead, by });
  }
  if (Object.keys(errors).length) return { errors };

  let saved = 0;
  await db.transaction(async (tx) => {
    for (const plan of plans) {
      if (plan.type === 'done') {
        await tx.query('UPDATE commitments SET result = $2, done = $3, why = $4, updated_at = now() WHERE id = $1',
          [plan.c.id, plan.next, plan.next === null ? null : plan.next === 'yes', plan.why]);
        await audit(tx, user, 'update', 'commitments', `${branch.code} ${prev} ${plan.c.person_name}`,
          { result: plan.c.result || null, why: plan.c.why || null }, { result: plan.next, why: plan.why });
        saved++;
        continue;
      }
      const key = `${branch.code} ${week} ${plan.person.name}`;
      const { rows } = await tx.query(
        'SELECT * FROM commitments WHERE branch_id = $1 AND week_start = $2 AND person_id = $3', [branch.id, week, plan.person.id]);
      const before = rows[0];
      if (!plan.text) {
        if (before) {
          await tx.query('DELETE FROM commitments WHERE id = $1', [before.id]);
          await audit(tx, user, 'delete', 'commitments', key, { commitment: before.commitment }, null);
          saved++;
        }
        continue;
      }
      const next = { commitment: plan.text, lead_measure: plan.lead, by_when: plan.by };
      if (before && before.commitment === next.commitment && (before.lead_measure ?? null) === next.lead_measure
          && (before.by_when ?? null) === next.by_when) continue;
      await tx.query(
        `INSERT INTO commitments (branch_id, week_start, person_id, commitment, lead_measure, by_when, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (branch_id, week_start, person_id) DO UPDATE SET
           commitment = EXCLUDED.commitment, lead_measure = EXCLUDED.lead_measure, by_when = EXCLUDED.by_when,
           created_by = EXCLUDED.created_by, updated_at = now()`,
        [branch.id, week, plan.person.id, next.commitment, next.lead_measure, next.by_when, user.id]);
      await audit(tx, user, before ? 'update' : 'insert', 'commitments', key,
        before ? { commitment: before.commitment, lead_measure: before.lead_measure, by_when: before.by_when } : null, next);
      saved++;
    }
  });
  const s = await wig.saveSession(db, user, branch, week, body, { today, people });
  if (s.error) return { errors: { session: s.error } };
  return { saved: saved + s.saved };
}

async function buildMeasureLabels(db, branchId) {
  return (await db.query('SELECT label FROM measures WHERE branch_id = $1 AND active', [branchId])).rows.map((r) => r.label);
}

module.exports = { loadCommitmentsPage, saveCommitments, loadWeek, loadPeople, buildMeasureLabels };
