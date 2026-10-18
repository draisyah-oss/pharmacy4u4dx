// The weekly WIG rhythm (18 Oct, from the approved mockup):
//   1. Monday 10 am  HQ WIG – each HQ person's focus (set by the CEO, or proposed and approved
//                    by the CEO) and commitment; last week's HQ actions for branches reviewed.
//   2. Monday 4 pm   Weekly update – each manager's update (mostly automatic) with "what I need
//                    from HQ"; CEO, Alia and Hanin agree an owner and date → HQ actions.
//   3. Tuesday       Branch WIG – scoreboard, what HQ will do for us, account for last week's
//                    commitments (Done / Partly / Not done), this week's commitments (typed by
//                    the staff on their phone or by the manager), who attended.
//
// Weeks are named by their Monday. The update is for the week that just ended (W); the actions
// agreed there are raised "for" W and land in the branch WIG of week W + 1.

const calc = require('../calc');
const { audit } = require('../admin/common');
const { cleanText } = require('../weekly/access');
const { isRealDate } = require('../lib/dates');

const ACTION_STATUSES = ['Open', 'Done', 'Not done', 'Dropped'];
const RESULTS = ['yes', 'partly', 'no'];
const RESULT_TEXT = { yes: 'Done', partly: 'Partly', no: 'Not done' };
const MAX_ASKS = 3;

// ─────────────── HQ people ───────────────

async function hqPeople(db) {
  return (await db.query('SELECT id, name, role FROM people WHERE branch_id IS NULL AND active ORDER BY sort_order, id')).rows;
}

// ─────────────── HQ actions ───────────────

const ACTION_SELECT = `
  SELECT a.*, b.code AS branch_code, b.name AS branch_name, p.name AS owner_name, u.display_name AS raised_by_name
  FROM hq_actions a LEFT JOIN branches b ON b.id = a.branch_id LEFT JOIN people p ON p.id = a.owner_person_id
  LEFT JOIN users u ON u.id = a.raised_by`;

async function loadActions(db, { week, branchId = null }) {
  const args = [week];
  let where = 'a.week_start = $1';
  if (branchId) { args.push(branchId); where += ' AND a.branch_id = $2'; }
  return (await db.query(`${ACTION_SELECT} WHERE ${where} ORDER BY b.sort_order NULLS LAST, a.id`, args)).rows;
}

// What HQ will do for a branch, shown at its WIG: actions from the update before this week's
// session, plus anything older still open.
async function actionsForBranchWig(db, { branchId, week }) {
  const raisedFor = calc.addDays(week, -7);
  return (await db.query(
    `${ACTION_SELECT} WHERE a.branch_id = $1 AND (a.week_start = $2 OR (a.week_start < $2 AND a.status = 'Open'))
     ORDER BY a.week_start DESC, a.id`, [branchId, raisedFor])).rows;
}

async function openActionsFor(db, personId) {
  return (await db.query(
    `${ACTION_SELECT} WHERE a.owner_person_id = $1 AND a.status = 'Open' ORDER BY a.due_date NULLS LAST, a.id`, [personId])).rows;
}

function actionSummary(list) {
  const counted = list.filter((a) => a.status !== 'Dropped');
  const done = counted.filter((a) => a.status === 'Done').length;
  return { total: counted.length, done, open: counted.filter((a) => a.status === 'Open').length, pct: counted.length ? done / counted.length : null };
}

// The manager's "what I need from HQ" rows in the weekly update: a[k<id>] edits a row not yet
// agreed by HQ (empty text removes it); a[n1..n3] adds new ones. Returns { errors } or { saved }.
async function saveAsks(db, user, branch, week, body) {
  const typed = body.a || {};
  const people = new Map((await hqPeople(db)).map((p) => [String(p.id), p]));
  const existing = (await loadActions(db, { week, branchId: branch.id }));
  const errors = {};
  const plans = [];
  const ownerOf = (v) => {
    const s = String(v ?? '').trim();
    if (!s) return { value: null };
    return people.has(s) ? { value: Number(s) } : { error: 'Pick who at HQ from the list.' };
  };
  for (const a of existing) {
    const t = typed[`k${a.id}`];
    if (!t || typeof t !== 'object' || a.agreed) continue;
    const text = cleanText(t.text, { max: 300, label: 'What you need' });
    const owner = ownerOf(t.owner);
    if (text.error || owner.error) { errors[`k${a.id}`] = text.error || owner.error; continue; }
    if (!text.value) { plans.push({ type: 'delete', a }); continue; }
    if (text.value !== a.issue || owner.value !== (a.owner_person_id ?? null)) plans.push({ type: 'update', a, issue: text.value, owner: owner.value });
  }
  let room = MAX_ASKS - existing.length;
  for (let i = 1; i <= MAX_ASKS; i++) {
    const t = typed[`n${i}`];
    if (!t || typeof t !== 'object') continue;
    const text = cleanText(t.text, { max: 300, label: 'What you need' });
    const owner = ownerOf(t.owner);
    if (text.error || owner.error) { errors[`n${i}`] = text.error || owner.error; continue; }
    if (!text.value) continue;
    if (room <= 0) { errors[`n${i}`] = `Up to ${MAX_ASKS} a week – put the most important first.`; continue; }
    room--;
    plans.push({ type: 'insert', issue: text.value, owner: owner.value });
  }
  if (Object.keys(errors).length) return { errors };
  if (!plans.length) return { saved: 0 };
  await db.transaction(async (tx) => {
    for (const p of plans) {
      const key = `${branch.code} ${week}`;
      if (p.type === 'delete') {
        await tx.query('DELETE FROM hq_actions WHERE id = $1 AND NOT agreed', [p.a.id]);
        await audit(tx, user, 'delete', 'hq_actions', key, { issue: p.a.issue }, null);
      } else if (p.type === 'update') {
        await tx.query('UPDATE hq_actions SET issue = $2, owner_person_id = $3, updated_by = $4, updated_at = now() WHERE id = $1', [p.a.id, p.issue, p.owner, user.id]);
        await audit(tx, user, 'update', 'hq_actions', key, { issue: p.a.issue, owner: p.a.owner_person_id }, { issue: p.issue, owner: p.owner });
      } else {
        await tx.query(
          'INSERT INTO hq_actions (branch_id, week_start, issue, owner_person_id, raised_by, updated_by) VALUES ($1,$2,$3,$4,$5,$5)',
          [branch.id, week, p.issue, p.owner, user.id]);
        await audit(tx, user, 'insert', 'hq_actions', key, null, { issue: p.issue, owner: p.owner });
      }
    }
    // The check-in's one-line "issue needing HQ help" mirrors the asks, so older pages and the export still show it.
    const asks = (await tx.query('SELECT issue FROM hq_actions WHERE branch_id = $1 AND week_start = $2 ORDER BY id', [branch.id, week])).rows.map((r) => r.issue);
    await tx.query(
      `INSERT INTO weekly_checkins (branch_id, week_start, issue_needing_hq_help, submitted_by) VALUES ($1, $2, $3, $4)
       ON CONFLICT (branch_id, week_start) DO UPDATE SET issue_needing_hq_help = EXCLUDED.issue_needing_hq_help, updated_at = now()`,
      [branch.id, week, asks.join(' · ').slice(0, 500) || null, user.id]);
  });
  return { saved: plans.length };
}

// HQ in the Monday 4 pm meeting (and HQ any time after): owner, due date, status per action,
// x[k<id>][owner|due|status]; plus one new action (x[new]) for any branch.
async function saveActionsAtMeeting(db, user, week, body) {
  const people = new Map((await hqPeople(db)).map((p) => [String(p.id), p]));
  const branches = new Map((await db.query('SELECT id, code FROM branches WHERE active')).rows.map((b) => [b.code, b]));
  const ids = Object.keys(body.x || {}).filter((k) => /^k\d{1,9}$/.test(k)).map((k) => Number(k.slice(1)));
  const actions = ids.length ? (await db.query(`${ACTION_SELECT} WHERE a.id = ANY($1)`, [ids])).rows : [];
  const errors = {};
  const plans = [];
  for (const a of actions) {
    const t = body.x[`k${a.id}`];
    const owner = String(t.owner ?? '').trim();
    if (owner && !people.has(owner)) { errors[a.id] = 'Pick the owner from the list.'; continue; }
    const due = String(t.due ?? '').trim();
    if (due && !isRealDate(due)) { errors[a.id] = 'Due: pick a real date.'; continue; }
    const status = t.status === undefined ? a.status : t.status;
    if (!ACTION_STATUSES.includes(status)) { errors[a.id] = 'Pick a status from the list.'; continue; }
    const next = { owner_person_id: owner ? Number(owner) : null, due_date: due || null, status };
    // Giving it an owner and a date in the meeting = agreed; it then goes on the owner's week.
    const agreed = a.agreed || Boolean(next.owner_person_id && next.due_date);
    if (next.owner_person_id === (a.owner_person_id ?? null) && next.due_date === (a.due_date ?? null) && next.status === a.status && agreed === a.agreed) continue;
    plans.push({ a, next, agreed });
  }
  const n = body.x && body.x.new;
  let added = null;
  if (n && typeof n === 'object' && String(n.text ?? '').trim()) {
    const text = cleanText(n.text, { max: 300, label: 'Action' });
    const owner = String(n.owner ?? '').trim();
    const due = String(n.due ?? '').trim();
    const branch = n.branch ? branches.get(String(n.branch)) : null;
    if (text.error) errors.new = text.error;
    else if (n.branch && !branch) errors.new = 'Pick the branch from the list.';
    else if (owner && !people.has(owner)) errors.new = 'Pick the owner from the list.';
    else if (due && !isRealDate(due)) errors.new = 'Due: pick a real date.';
    else added = { branch_id: branch ? branch.id : null, issue: text.value, owner_person_id: owner ? Number(owner) : null, due_date: due || null };
  }
  if (Object.keys(errors).length) return { errors };
  if (!plans.length && !added) return { saved: 0 };
  await db.transaction(async (tx) => {
    for (const p of plans) {
      await tx.query(
        `UPDATE hq_actions SET owner_person_id = $2, due_date = $3, status = $4, agreed = $5, updated_by = $6, updated_at = now(),
           done_at = CASE WHEN $4 = 'Done' THEN COALESCE(done_at, now()) ELSE NULL END WHERE id = $1`,
        [p.a.id, p.next.owner_person_id, p.next.due_date, p.next.status, p.agreed, user.id]);
      await audit(tx, user, 'update', 'hq_actions', `${p.a.branch_code || 'HQ'} ${p.a.week_start} #${p.a.id}`,
        { owner: p.a.owner_person_id, due: p.a.due_date, status: p.a.status }, { owner: p.next.owner_person_id, due: p.next.due_date, status: p.next.status });
    }
    if (added) {
      await tx.query(
        `INSERT INTO hq_actions (branch_id, week_start, issue, owner_person_id, due_date, agreed, raised_by, updated_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$7)`,
        [added.branch_id, week, added.issue, added.owner_person_id, added.due_date, Boolean(added.owner_person_id && added.due_date), user.id]);
      await audit(tx, user, 'insert', 'hq_actions', `HQ ${week}`, null, added);
    }
  });
  return { saved: plans.length + (added ? 1 : 0) };
}

// Who may tick an action Done / Not done: its owner, full HQ, admin.
const canCloseAction = (user, action) => user.role === 'admin' || user.role === 'hq'
  || (Boolean(user.person_id) && user.person_id === action.owner_person_id);

async function setActionStatus(db, user, id, status) {
  if (!/^\d{1,9}$/.test(String(id))) return { error: 'That action doesn’t exist.' };
  const a = (await db.query(`${ACTION_SELECT} WHERE a.id = $1`, [id])).rows[0];
  if (!a) return { error: 'That action doesn’t exist.' };
  if (!canCloseAction(user, a)) return { error: 'Only the owner or full HQ can change this action.' };
  if (!ACTION_STATUSES.includes(status)) return { error: 'Pick a status from the list.' };
  if (status === a.status) return { saved: 0, action: a };
  await db.transaction(async (tx) => {
    await tx.query(
      `UPDATE hq_actions SET status = $2, updated_by = $3, updated_at = now(),
         done_at = CASE WHEN $2 = 'Done' THEN COALESCE(done_at, now()) ELSE NULL END WHERE id = $1`, [a.id, status, user.id]);
    await audit(tx, user, 'update', 'hq_actions', `${a.branch_code || 'HQ'} ${a.week_start} #${a.id}`, { status: a.status }, { status });
  });
  return { saved: 1, action: a };
}

// ─────────────── Branch WIG session ───────────────

async function loadSession(db, branchId, week) {
  return (await db.query(
    `SELECT s.*, u.display_name AS saved_by_name FROM branch_wig_sessions s LEFT JOIN users u ON u.id = s.saved_by
     WHERE s.branch_id = $1 AND s.week_start = $2`, [branchId, week])).rows[0] || null;
}

// body.held = '1' marks the session held (today, or the day given); body.att[p<id>] = who was there.
async function saveSession(db, user, branch, week, body, { today, people }) {
  if (body.finish === undefined) return { saved: 0 };
  const held = body.held === '1' || body.held === 'on';
  const inWeek = today && today >= week && today <= calc.addDays(week, 6);
  let heldOn = String(body.held_on ?? '').trim() || (held ? (inWeek ? today : calc.addDays(week, 1)) : null);
  if (heldOn && !isRealDate(heldOn)) return { error: 'Held on: pick a real date.' };
  if (heldOn && (heldOn < week || heldOn > calc.addDays(week, 6))) return { error: 'Held on: pick a day in this week.' };
  if (!held) heldOn = null;
  const att = body.att || {};
  const attended = people.filter((p) => att[`p${p.id}`] === '1' || att[`p${p.id}`] === 'on').map((p) => p.id);
  const before = await loadSession(db, branch.id, week);
  const same = before && (before.held_on ?? null) === heldOn && JSON.stringify([...(before.attended || [])].sort()) === JSON.stringify([...attended].sort());
  if (same || (!before && !heldOn && !attended.length)) return { saved: 0 };
  await db.transaction(async (tx) => {
    await tx.query(
      `INSERT INTO branch_wig_sessions (branch_id, week_start, held_on, attended, saved_by) VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (branch_id, week_start) DO UPDATE SET held_on = EXCLUDED.held_on, attended = EXCLUDED.attended,
         saved_by = EXCLUDED.saved_by, updated_at = now()`, [branch.id, week, heldOn, attended, user.id]);
    await audit(tx, user, before ? 'update' : 'insert', 'branch_wig_sessions', `${branch.code} ${week}`,
      before ? { held_on: before.held_on, attended: before.attended } : null, { held_on: heldOn, attended });
  });
  return { saved: 1 };
}

// Done / Partly / Not done for a list of commitments (unmarked ones count as not kept).
function resultSummary(list) {
  const by = (r) => list.filter((c) => c.result === r).length;
  const yes = by('yes');
  return { made: list.length, yes, partly: by('partly'), no: by('no'), unmarked: list.filter((c) => !c.result).length, pct: list.length ? yes / list.length : null };
}

// ─────────────── HQ focus ───────────────

const canApproveFocus = (user) => user.role === 'admin';

async function loadFocusWeek(db, week) {
  return new Map((await db.query(
    `SELECT f.*, pu.display_name AS proposed_by_name, au.display_name AS approved_by_name FROM hq_focus f
     LEFT JOIN users pu ON pu.id = f.proposed_by LEFT JOIN users au ON au.id = f.approved_by WHERE f.week_start = $1`, [week])).rows
    .map((f) => [f.person_id, f]));
}

async function loadFocus(db, week, personId) {
  return (await loadFocusWeek(db, week)).get(personId) || null;
}

// f[p<id>][text] (+ f[p<id>][approve] = '1' for the CEO). The CEO's own text is approved at once;
// anyone else's is a proposal – changing an approved focus sends it back for approval.
async function saveFocus(db, user, { week, body, people, canActFor }) {
  const typed = body.f || {};
  const current = await loadFocusWeek(db, week);
  const errors = {};
  const plans = [];
  for (const p of people) {
    const t = typed[`p${p.id}`];
    if (!t || typeof t !== 'object') continue;
    const ceo = canApproveFocus(user);
    if (!ceo && !canActFor(p.id)) continue;
    const text = cleanText(t.text, { max: 200, label: 'Focus' });
    if (text.error) { errors[p.id] = text.error; continue; }
    const before = current.get(p.id) || null;
    if (!text.value) { if (before) plans.push({ type: 'delete', p, before }); continue; }
    const approve = ceo && (t.approve === '1' || t.approve === 'on' || !before || before.focus !== text.value || before.status === 'approved');
    const status = ceo ? (approve ? 'approved' : 'proposed') : (before && before.focus === text.value ? before.status : 'proposed');
    if (before && before.focus === text.value && before.status === status) continue;
    plans.push({ type: 'set', p, before, text: text.value, status });
  }
  if (Object.keys(errors).length) return { errors };
  if (!plans.length) return { saved: 0 };
  await db.transaction(async (tx) => {
    for (const pl of plans) {
      const key = `HQ ${week} ${pl.p.name} focus`;
      if (pl.type === 'delete') {
        await tx.query('DELETE FROM hq_focus WHERE week_start = $1 AND person_id = $2', [week, pl.p.id]);
        await audit(tx, user, 'delete', 'hq_focus', key, { focus: pl.before.focus }, null);
        continue;
      }
      const textChanged = !pl.before || pl.before.focus !== pl.text;
      await tx.query(
        `INSERT INTO hq_focus (week_start, person_id, focus, status, proposed_by, approved_by, approved_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (week_start, person_id) DO UPDATE SET focus = EXCLUDED.focus, status = EXCLUDED.status,
           proposed_by = CASE WHEN $8 THEN EXCLUDED.proposed_by ELSE hq_focus.proposed_by END,
           approved_by = EXCLUDED.approved_by, approved_at = EXCLUDED.approved_at, updated_at = now()`,
        [week, pl.p.id, pl.text, pl.status, user.id, pl.status === 'approved' ? user.id : null, pl.status === 'approved' ? new Date() : null, textChanged]);
      await audit(tx, user, pl.before ? 'update' : 'insert', 'hq_focus', key,
        pl.before ? { focus: pl.before.focus, status: pl.before.status } : null, { focus: pl.text, status: pl.status });
    }
  });
  return { saved: plans.length };
}

module.exports = {
  ACTION_STATUSES, RESULTS, RESULT_TEXT, MAX_ASKS,
  hqPeople, loadActions, actionsForBranchWig, openActionsFor, actionSummary, saveAsks, saveActionsAtMeeting,
  canCloseAction, setActionStatus, loadSession, saveSession, resultSummary,
  canApproveFocus, loadFocusWeek, loadFocus, saveFocus,
};
