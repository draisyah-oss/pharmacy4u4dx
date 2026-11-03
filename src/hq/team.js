// HQ team tracking beyond the Monday KPIs (15 Oct):
//   - daily tasks: a short checklist per HQ person, ticked each working day (HQ Tracker →
//     HR Admin Daily for Iman; others add their own)
//   - weekly commitments: one per HQ person, marked Done / Partly / No the next week
//   - projects: building-to-scale milestones with owner, start, due and status
//
// Who can do what:
//   admin, and HQ who fill in for everyone (Iman): any HQ person
//   other full HQ (Alia, Hanin): see everyone, change their own
//   HQ staff (Syarafana, Fariz, Azwani): see and change only their own

const calc = require('../calc');
const { audit } = require('../admin/common');
const { cleanText } = require('../weekly/access');
const { isRealDate } = require('../lib/dates');

const PROJECT_STATUSES = ['Not started', 'In progress', 'Done', 'Blocked'];
const DONE_VALUES = ['yes', 'partly', 'no'];
const EDIT_DAYS = 7;

// ─────────────── Access ───────────────

const actsForAll = (user) => user.role === 'admin' || (user.role === 'hq' && user.enters_all_hq);
const canActFor = (user, personId) => actsForAll(user) || (Boolean(user.person_id) && user.person_id === personId);
const seesEveryone = (user) => user.role === 'admin' || user.role === 'hq';

async function hqPeople(db) {
  return (await db.query(
    `SELECT p.id, p.name, p.role, u.role AS login_role
     FROM people p LEFT JOIN users u ON u.person_id = p.id
     WHERE p.branch_id IS NULL AND p.active ORDER BY p.sort_order, p.id`)).rows;
}

// The people this login may look at (everyone for HQ/admin, only themselves for HQ staff).
async function visiblePeople(db, user) {
  const all = await hqPeople(db);
  return seesEveryone(user) ? all : all.filter((p) => p.id === user.person_id);
}

// ─────────────── Daily tasks ───────────────

async function loadTasks(db, personId, { includeRetired = false } = {}) {
  return (await db.query(
    `SELECT * FROM hq_daily_tasks WHERE person_id = $1 ${includeRetired ? '' : 'AND active'} ORDER BY sort_order, id`, [personId])).rows;
}

async function loadTicks(db, taskIds, from, to) {
  if (!taskIds.length) return new Map();
  const { rows } = await db.query(
    `SELECT t.task_id, t.entry_date, t.done, t.na, u.display_name AS entered_by FROM hq_daily_ticks t
     LEFT JOIN users u ON u.id = t.entered_by WHERE t.task_id = ANY($1) AND t.entry_date BETWEEN $2 AND $3`,
    [taskIds, from, to]);
  return new Map(rows.map((r) => [`${r.task_id}|${r.entry_date}`, r]));
}

const isWeekday = (date) => !calc.isWeekend(date);

// A tick as 'yes' | 'no' | 'na' (null when not ticked).
const tickState = (r) => (!r ? null : r.na ? 'na' : r.done ? 'yes' : 'no');

// Working days (Mon–Fri) of a week up to `through`; a day counts as fully done when every
// task is ticked Yes or N/A (doesn't apply that day). Pure. (Daily ticks – before 3 Nov.)
function dailyWeekSummary({ tasks, ticks, weekStart, through }) {
  const days = [];
  for (let i = 0; i < 7; i++) {
    const d = calc.addDays(weekStart, i);
    if (d > through || !isWeekday(d)) continue;
    const states = tasks.map((t) => tickState(ticks.get(`${t.id}|${d}`)));
    const done = states.filter((x) => x === 'yes').length;
    const na = states.filter((x) => x === 'na').length;
    const ticked = states.filter((x) => x !== null).length;
    days.push({ date: d, done, na, ticked, total: tasks.length, full: tasks.length > 0 && done + na === tasks.length });
  }
  const full = days.filter((d) => d.full).length;
  return { days, fullDays: full, workingDays: days.length, pct: days.length && tasks.length ? full / days.length : null };
}

// 3 Nov (CEO): HQ checks in once a WEEK, not every day. A week's tick is stored on its Monday.
// pct = Done ÷ (tasks − N/A). Pure.
function weekCheck({ tasks, ticks, week }) {
  const states = tasks.map((t) => tickState(ticks.get(`${t.id}|${week}`)));
  const done = states.filter((x) => x === 'yes').length;
  const na = states.filter((x) => x === 'na').length;
  const notDone = states.filter((x) => x === 'no').length;
  const ticked = states.filter((x) => x !== null).length;
  const counted = tasks.length - na;
  return { week, done, na, notDone, ticked, total: tasks.length, counted, pct: ticked && counted > 0 ? done / counted : null,
    complete: tasks.length > 0 && ticked === tasks.length };
}

// The check-in for `week` can be changed this week and last week (admin: any week since the tracker).
function weekEditDenied(user, personId, week, today, trackerStart) {
  if (!canActFor(user, personId)) return 'You can only tick your own check-in.';
  const thisWeek = calc.weekStart(today);
  if (week > thisWeek) return 'This week hasn’t started yet.';
  if (week < calc.weekStart(trackerStart)) return 'The tracker starts on ' + trackerStart + '.';
  if (user.role !== 'admin' && week < calc.addDays(thisWeek, -7)) return 'Only this week and last week can be changed. Ask admin to fix older weeks.';
  return null;
}

function dayEditDenied(user, personId, date, today, trackerStart) {
  if (!canActFor(user, personId)) return 'You can only tick your own tasks.';
  if (date > today) return 'This date is in the future.';
  if (date < trackerStart) return 'The tracker starts on ' + trackerStart + '.';
  if (user.role !== 'admin' && date < calc.addDays(today, -(EDIT_DAYS - 1))) return 'Only the last 7 days can be changed. Ask admin to fix older days.';
  return null;
}

async function saveTicks(db, user, { person, date, body }) {
  const tasks = await loadTasks(db, person.id);
  const typed = body.t || {};
  const before = await loadTicks(db, tasks.map((t) => t.id), date, date);
  let saved = 0;
  await db.transaction(async (tx) => {
    for (const t of tasks) {
      const v = typed[`k${t.id}`];
      if (v === undefined) continue;
      const next = ['yes', 'no', 'na'].includes(v) ? v : null;
      const oldV = tickState(before.get(`${t.id}|${date}`));
      if (next === oldV) continue;
      if (next === null) await tx.query('DELETE FROM hq_daily_ticks WHERE task_id = $1 AND entry_date = $2', [t.id, date]);
      else {
        await tx.query(
          `INSERT INTO hq_daily_ticks (task_id, entry_date, done, na, entered_by) VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (task_id, entry_date) DO UPDATE SET done = EXCLUDED.done, na = EXCLUDED.na, entered_by = EXCLUDED.entered_by, updated_at = now()`,
          [t.id, date, next === 'yes', next === 'na', user.id]);
      }
      await audit(tx, user, oldV === null ? 'insert' : next === null ? 'delete' : 'update', 'hq_daily_ticks', `${person.name} week ${date} ${t.label}`, oldV, next);
      saved++;
    }
  });
  return { saved };
}

async function addTask(db, user, { person, label }) {
  const l = cleanText(label, { max: 120, label: 'Task' });
  if (l.error) return { error: l.error };
  if (!l.value) return { error: 'Type the task.' };
  const count = (await db.query('SELECT count(*)::int AS n FROM hq_daily_tasks WHERE person_id = $1 AND active', [person.id])).rows[0].n;
  if (count >= 10) return { error: 'Keep it to 10 check-in items at most – remove one first.' };
  await db.transaction(async (tx) => {
    await tx.query('INSERT INTO hq_daily_tasks (person_id, label, sort_order) VALUES ($1, $2, $3)', [person.id, l.value, count + 1]);
    await audit(tx, user, 'insert', 'hq_daily_tasks', `${person.name} task`, null, l.value);
  });
  return { ok: 'Task added.' };
}

async function retireTask(db, user, { person, taskId }) {
  const t = (await db.query('SELECT * FROM hq_daily_tasks WHERE id = $1 AND person_id = $2 AND active', [taskId, person.id])).rows[0];
  if (!t) return { error: 'That task isn’t on the list.' };
  await db.transaction(async (tx) => {
    await tx.query('UPDATE hq_daily_tasks SET active = false WHERE id = $1', [t.id]);
    await audit(tx, user, 'delete', 'hq_daily_tasks', `${person.name} task`, t.label, null);
  });
  return { ok: `Removed “${t.label}”. Past ticks are kept.` };
}

async function loadWeekPage(db, { person, week }) {
  const tasks = await loadTasks(db, person.id);
  const ticks = await loadTicks(db, tasks.map((t) => t.id), calc.addDays(week, -35), week);
  const weeks = [];
  for (let i = 5; i >= 0; i--) weeks.push(calc.addDays(week, -7 * i));
  return {
    tasks: tasks.map((t) => ({ ...t, tick: ticks.get(`${t.id}|${week}`) || null })),
    check: weekCheck({ tasks, ticks, week }),
    history: weeks.map((w) => weekCheck({ tasks, ticks, week: w })),
  };
}

// ─────────────── Weekly commitments ───────────────

async function loadCommitmentWeek(db, week) {
  return (await db.query(
    `SELECT c.*, p.name AS person_name, u.display_name AS written_by FROM hq_commitments c
     JOIN people p ON p.id = c.person_id LEFT JOIN users u ON u.id = c.created_by
     WHERE c.week_start = $1 ORDER BY p.sort_order, p.id, c.slot`, [week])).rows;
}

// Form keys per slot (19 Oct: up to 2 commitments a person a week): c[p<id>] = slot 1, c2[p<id>] = slot 2.
const SLOT_KEYS = { 1: 'c', 2: 'c2' };

// What a commitment can move: the person's HQ measures, the project milestones they own, and any
// extra aims for that person (app_settings hq_extra_moves, seed hq.extra_moves – e.g. the CEO's
// "Remove bottlenecks for staff").
async function movesFor(db, person) {
  const measures = (await db.query('SELECT label FROM hq_measures WHERE active AND (person_id = $1 OR owner_name = $2) ORDER BY sort_order', [person.id, person.name])).rows.map((r) => r.label);
  const projects = (await loadProjects(db)).filter((p) => ownsProject(p, person.name)).map((p) => `${p.project}: ${p.milestone}`);
  let extra = [];
  const row = (await db.query("SELECT value FROM app_settings WHERE key = 'hq_extra_moves'")).rows[0];
  if (row) { try { extra = JSON.parse(row.value)[person.name] || []; } catch { extra = []; } }
  return [...extra, ...measures, ...projects];
}

function keptSummary(list) {
  const marked = list.filter((c) => c.done);
  const yes = marked.filter((c) => c.done === 'yes').length;
  return { made: list.length, marked: marked.length, kept: yes, partly: marked.filter((c) => c.done === 'partly').length, pct: list.length ? yes / list.length : null };
}

async function saveCommitments(db, user, { week, body, people }) {
  const prev = calc.addDays(week, -7);
  const lastWeek = await loadCommitmentWeek(db, prev);
  const errors = {};
  const plans = [];

  const done = body.done || {};
  for (const c of lastWeek) {
    const v = done[`k${c.id}`];
    if (v === undefined || !canActFor(user, c.person_id)) continue;
    const next = DONE_VALUES.includes(v) ? v : null;
    if (next !== (c.done || null)) plans.push({ type: 'done', c, next });
  }

  for (const [slot, key] of Object.entries(SLOT_KEYS)) {
    const typed = body[key] || {};
    for (const p of people) {
      const t = typed[`p${p.id}`];
      if (!t || typeof t !== 'object' || !canActFor(user, p.id)) continue;
      const ek = slot === '1' ? p.id : `${p.id}s2`;
      const text = cleanText(t.text, { max: 300, label: 'Commitment' });
      if (text.error) { errors[ek] = text.error; continue; }
      const moves = String(t.moves ?? '').trim() || null;
      if (moves && !(await movesFor(db, p)).includes(moves)) { errors[ek] = 'Pick what it moves from the list.'; continue; }
      const by = String(t.by ?? '').trim() || null;
      if (by && !isRealDate(by)) { errors[ek] = 'By when: pick a real date.'; continue; }
      plans.push({ type: 'commit', person: p, slot: Number(slot), text: text.value, moves, by });
    }
  }
  if (Object.keys(errors).length) return { errors };

  let saved = 0;
  await db.transaction(async (tx) => {
    for (const plan of plans) {
      if (plan.type === 'done') {
        await tx.query('UPDATE hq_commitments SET done = $2, updated_at = now() WHERE id = $1', [plan.c.id, plan.next]);
        await audit(tx, user, 'update', 'hq_commitments', `HQ ${prev} ${plan.c.person_name} done`, plan.c.done, plan.next);
        saved++;
        continue;
      }
      const key = `HQ ${week} ${plan.person.name}${plan.slot === 2 ? ' (2)' : ''}`;
      const before = (await tx.query('SELECT * FROM hq_commitments WHERE week_start = $1 AND person_id = $2 AND slot = $3', [week, plan.person.id, plan.slot])).rows[0];
      if (!plan.text) {
        if (before) {
          await tx.query('DELETE FROM hq_commitments WHERE id = $1', [before.id]);
          await audit(tx, user, 'delete', 'hq_commitments', key, { commitment: before.commitment }, null);
          saved++;
        }
        continue;
      }
      const next = { commitment: plan.text, moves: plan.moves, by_when: plan.by };
      if (before && before.commitment === next.commitment && (before.moves ?? null) === next.moves && (before.by_when ?? null) === next.by_when) continue;
      await tx.query(
        `INSERT INTO hq_commitments (week_start, person_id, slot, commitment, moves, by_when, created_by) VALUES ($1, $2, $7, $3, $4, $5, $6)
         ON CONFLICT (week_start, person_id, slot) DO UPDATE SET commitment = EXCLUDED.commitment, moves = EXCLUDED.moves,
           by_when = EXCLUDED.by_when, created_by = EXCLUDED.created_by, updated_at = now()`,
        [week, plan.person.id, next.commitment, next.moves, next.by_when, user.id, plan.slot]);
      await audit(tx, user, before ? 'update' : 'insert', 'hq_commitments', key,
        before ? { commitment: before.commitment, moves: before.moves, by_when: before.by_when } : null, next);
      saved++;
    }
  });
  return { saved };
}

// ─────────────── Projects ───────────────

async function loadProjects(db) {
  return (await db.query(
    `SELECT p.*, u.display_name AS updated_by_name FROM hq_projects p LEFT JOIN users u ON u.id = p.updated_by
     WHERE p.active ORDER BY p.sort_order, p.id`)).rows;
}

// "Syarafana, with Alia" is owned by Syarafana and Alia.
const ownsProject = (p, name) => new RegExp(`\\b${String(name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(p.owner);

function canEditProject(user, p) {
  if (user.role === 'admin' || user.role === 'hq') return true;
  return user.role === 'hq_staff' && ownsProject(p, user.display_name);
}

async function updateProject(db, user, project, body) {
  const next = {};
  if (body.status !== undefined) {
    if (!PROJECT_STATUSES.includes(body.status)) return { error: 'Pick a status from the list.' };
    next.status = body.status;
  }
  for (const k of ['start_date', 'due_date']) {
    if (body[k] === undefined) continue;
    if (k === 'due_date' && user.role === 'hq_staff') continue; // the due date is set by HQ / admin
    const v = String(body[k]).trim();
    if (v && !isRealDate(v)) return { error: 'Pick a real date.' };
    next[k] = v || null;
  }
  if (body.notes !== undefined) {
    const n = cleanText(body.notes, { max: 300, label: 'Notes' });
    if (n.error) return { error: n.error };
    next.notes = n.value;
  }
  if (next.start_date && (next.due_date ?? project.due_date) && next.start_date > (next.due_date ?? project.due_date)) {
    return { error: 'The start date is after the due date.' };
  }
  const changed = Object.fromEntries(Object.entries(next).filter(([k, v]) => (project[k] ?? null) !== v));
  if (!Object.keys(changed).length) return { saved: 0 };
  const cols = Object.keys(changed);
  await db.transaction(async (tx) => {
    await tx.query(
      `UPDATE hq_projects SET ${cols.map((c, i) => `${c} = $${i + 2}`).join(', ')}, updated_by = $${cols.length + 2}, updated_at = now() WHERE id = $1`,
      [project.id, ...cols.map((c) => changed[c]), user.id]);
    await audit(tx, user, 'update', 'hq_projects', `${project.project}: ${project.milestone}`,
      Object.fromEntries(cols.map((c) => [c, project[c] ?? null])), changed);
  });
  return { saved: cols.length };
}

async function addProject(db, user, body) {
  const fields = {};
  for (const [k, max, label] of [['project', 80, 'Project'], ['milestone', 200, 'Milestone'], ['owner', 80, 'Owner']]) {
    const v = cleanText(body[k], { max, label });
    if (v.error) return { error: v.error };
    if (!v.value) return { error: `${label} can’t be empty.` };
    fields[k] = v.value;
  }
  for (const k of ['start_date', 'due_date']) {
    const v = String(body[k] ?? '').trim();
    if (v && !isRealDate(v)) return { error: 'Pick a real date.' };
    fields[k] = v || null;
  }
  await db.transaction(async (tx) => {
    const order = (await tx.query('SELECT COALESCE(MAX(sort_order), 0) + 1 AS n FROM hq_projects')).rows[0].n;
    await tx.query(
      'INSERT INTO hq_projects (project, milestone, owner, start_date, due_date, sort_order, updated_by) VALUES ($1,$2,$3,$4,$5,$6,$7)',
      [fields.project, fields.milestone, fields.owner, fields.start_date, fields.due_date, order, user.id]);
    await audit(tx, user, 'insert', 'hq_projects', `${fields.project}: ${fields.milestone}`, null, fields);
  });
  return { ok: 'Milestone added.' };
}

// ─────────────── Project steps (19 Oct) ───────────────
// A milestone can carry a short checklist of steps (phase heading, owner, due date, Done).
// Who can tick a step: anyone who can update the milestone, plus HQ staff named on the step.

const STEP_MAX = 40;

async function loadSteps(db, projectIds) {
  if (!projectIds.length) return [];
  return (await db.query(
    `SELECT s.*, u.display_name AS done_by_name FROM hq_project_steps s LEFT JOIN users u ON u.id = s.done_by
     WHERE s.active AND s.project_id = ANY($1::int[]) ORDER BY s.project_id, s.sort_order, s.id`, [projectIds])).rows;
}

const ownsStep = (s, name) => Boolean(s.owner) && ownsProject({ owner: s.owner }, name);

function canTickStep(user, project, step) {
  return canEditProject(user, project) || (user.role === 'hq_staff' && ownsStep(step, user.display_name));
}

const STEP_STATUSES = ['Not started', 'In progress', 'Done'];
const isStepDone = (s) => s.status === 'Done' || (!s.status && Boolean(s.done_at));
const stepState = (s, today) => (isStepDone(s) ? 'done' : s.due_date && s.due_date < today ? 'overdue' : s.due_date === today ? 'today' : 'open');

// Steps grouped by phase (in order of first appearance), with done / overdue counts, per phase
// (owners, last due date) and per owner – for the checklist page's tiles.
function stepSummary(steps, today) {
  const phases = [];
  for (const s of steps) {
    let ph = phases.find((x) => x.phase === (s.phase || ''));
    if (!ph) phases.push(ph = { phase: s.phase || '', steps: [] });
    ph.steps.push({ ...s, state: stepState(s, today), late: !isStepDone(s) && Boolean(s.due_date) && s.due_date < today });
  }
  for (const ph of phases) {
    ph.total = ph.steps.length;
    ph.done = ph.steps.filter((x) => x.state === 'done').length;
    ph.due = ph.steps.reduce((m, x) => (x.due_date && (!m || x.due_date > m) ? x.due_date : m), null);
    ph.owners = [...new Set(ph.steps.map((x) => x.owner).filter(Boolean))].join(', ');
  }
  const all = phases.flatMap((ph) => ph.steps);
  const owners = [];
  for (const st of all) {
    const name = (st.owner || '').split(/,| with /)[0].trim() || 'Team';
    let o = owners.find((x) => x.owner === name);
    if (!o) owners.push(o = { owner: name, total: 0, done: 0 });
    o.total++; if (st.state === 'done') o.done++;
  }
  return {
    phases, owners, total: all.length, done: all.filter((s) => s.state === 'done').length,
    overdue: all.filter((s) => s.late).length,
    inProgress: all.filter((s) => s.status === 'In progress').length,
    dueSoon: all.filter((s) => s.state !== 'done' && s.due_date && s.due_date >= today && calc.diffDays(today, s.due_date) <= 7).length,
  };
}

async function tickStep(db, user, step, done, at) {
  return updateStep(db, user, step, { status: done ? 'Done' : 'Not started' }, { at, canEditOwner: false });
}

// Save one step from the checklist page: status (anyone who can tick it) and owner (milestone owners,
// full HQ, admin). Moving to Done stamps done_at / done_by; moving back clears them.
async function updateStep(db, user, step, body, { at, canEditOwner }) {
  const next = {};
  if (body.status !== undefined) {
    if (!STEP_STATUSES.includes(body.status)) return { error: 'Pick a status from the list.' };
    next.status = body.status;
  }
  if (canEditOwner && body.owner !== undefined) {
    const o = cleanText(body.owner, { max: 80, label: 'Owner' });
    if (o.error) return { error: o.error };
    next.owner = o.value;
  }
  const was = { status: step.status || (step.done_at ? 'Done' : 'Not started'), owner: step.owner ?? null };
  const changed = Object.fromEntries(Object.entries(next).filter(([k, v]) => was[k] !== v));
  if (!Object.keys(changed).length) return { saved: 0, status: was.status };
  const sets = Object.keys(changed).map((c, i) => `${c} = $${i + 2}`);
  const vals = Object.values(changed);
  if (changed.status !== undefined) {
    const done = changed.status === 'Done';
    sets.push(`done_at = $${vals.length + 2}`, `done_by = $${vals.length + 3}`);
    vals.push(done ? at : null, done ? user.id : null);
  }
  await db.transaction(async (tx) => {
    await tx.query(`UPDATE hq_project_steps SET ${sets.join(', ')}, updated_by = $${vals.length + 2}, updated_at = now() WHERE id = $1`,
      [step.id, ...vals, user.id]);
    await audit(tx, user, 'update', 'hq_project_steps', step.step,
      Object.fromEntries(Object.keys(changed).map((k) => [k, was[k]])), changed);
  });
  return { saved: Object.keys(changed).length, status: changed.status || was.status, done: (changed.status || was.status) === 'Done' };
}

async function addStep(db, user, project, body) {
  const fields = {};
  for (const [k, max, label, required] of [['step', 200, 'Step', true], ['phase', 60, 'Phase', false], ['owner', 80, 'Owner', false]]) {
    const v = cleanText(body[k], { max, label });
    if (v.error) return { error: v.error };
    if (required && !v.value) return { error: `${label} can’t be empty.` };
    fields[k] = v.value;
  }
  const due = String(body.due_date ?? '').trim();
  if (due && !isRealDate(due)) return { error: 'Pick a real date.' };
  fields.due_date = due || null;
  const count = (await db.query('SELECT count(*)::int AS n FROM hq_project_steps WHERE project_id = $1 AND active', [project.id])).rows[0].n;
  if (count >= STEP_MAX) return { error: `A milestone can have ${STEP_MAX} steps at most.` };
  await db.transaction(async (tx) => {
    const order = (await tx.query('SELECT COALESCE(MAX(sort_order), 0) + 1 AS n FROM hq_project_steps WHERE project_id = $1', [project.id])).rows[0].n;
    await tx.query(
      'INSERT INTO hq_project_steps (project_id, phase, step, owner, due_date, sort_order, updated_by) VALUES ($1,$2,$3,$4,$5,$6,$7)',
      [project.id, fields.phase, fields.step, fields.owner, fields.due_date, order, user.id]);
    await audit(tx, user, 'insert', 'hq_project_steps', `${project.milestone}: ${fields.step}`, null, fields);
  });
  return { ok: 'Step added.' };
}

async function removeStep(db, user, step) {
  await db.transaction(async (tx) => {
    await tx.query('UPDATE hq_project_steps SET active = false, updated_by = $2, updated_at = now() WHERE id = $1', [step.id, user.id]);
    await audit(tx, user, 'delete', 'hq_project_steps', step.step, { active: true }, { active: false });
  });
  return { ok: 'Step removed.' };
}

// Side menu: milestones (not Done) that have steps, with done / total – HQ staff only see the
// ones they own or have a step on.
async function stepMenu(db, user) {
  const rows = (await db.query(
    `SELECT p.id, p.milestone, p.owner, count(s.id)::int AS total, count(*) FILTER (WHERE s.status = 'Done')::int AS done,
            array_agg(s.owner) AS step_owners
     FROM hq_projects p JOIN hq_project_steps s ON s.project_id = p.id AND s.active
     WHERE p.active AND p.status <> 'Done' GROUP BY p.id ORDER BY p.sort_order, p.id`)).rows;
  return rows.filter((r) => user.role !== 'hq_staff' || ownsProject(r, user.display_name)
    || (r.step_owners || []).some((o) => o && ownsStep({ owner: o }, user.display_name)))
    .map(({ id, milestone, total, done }) => ({ id, milestone, total, done }));
}

// Seed steps for one milestone (first load and older databases): only when it has none yet.
async function insertSeedSteps(tx, projectId, steps) {
  for (const [i, s] of (steps || []).entries()) {
    await tx.query(
      'INSERT INTO hq_project_steps (project_id, phase, step, owner, due_date, sort_order) VALUES ($1,$2,$3,$4,$5,$6)',
      [projectId, s.phase || null, s.step, s.owner || null, s.due || null, i + 1]);
  }
}

function projectState(p, today) {
  if (p.status === 'Done') return 'done';
  if (p.due_date && p.due_date < today) return 'overdue';
  if (p.status === 'Blocked') return 'blocked';
  if (p.due_date && calc.diffDays(today, p.due_date) <= 7) return 'due_soon';
  return 'open';
}

// For the HQ scoreboard: per person, this week's daily tasks and last week's commitment.
async function teamSummary(db, { week, today }) {
  const people = await hqPeople(db);
  const through = today < calc.addDays(week, 6) ? today : calc.addDays(week, 6);
  const last = await loadCommitmentWeek(db, calc.addDays(week, -7));
  const now = await loadCommitmentWeek(db, week);
  const rows = [];
  for (const p of people) {
    const tasks = await loadTasks(db, p.id);
    const ticks = await loadTicks(db, tasks.map((t) => t.id), week, week);
    rows.push({
      person: p, tasks: tasks.length,
      check: tasks.length ? weekCheck({ tasks, ticks, week }) : null,
      lastCommitment: last.find((c) => c.person_id === p.id) || null,
      thisCommitment: now.find((c) => c.person_id === p.id) || null,
      lastCommitments: last.filter((c) => c.person_id === p.id),
      thisCommitments: now.filter((c) => c.person_id === p.id),
    });
  }
  const projects = await loadProjects(db);
  const states = projects.map((p) => projectState(p, today));
  const wiki = require('./wikilist').summarise(await require('./wikilist').load(db, { today }));
  return {
    rows, kept: keptSummary(last), wiki,
    projects: {
      total: projects.length, done: states.filter((s) => s === 'done').length,
      overdue: states.filter((s) => s === 'overdue').length, inProgress: projects.filter((p) => p.status === 'In progress').length,
    },
  };
}

module.exports = {
  tickState,
  PROJECT_STATUSES, DONE_VALUES, actsForAll, canActFor, seesEveryone, hqPeople, visiblePeople,
  loadTasks, loadTicks, dailyWeekSummary, weekCheck, weekEditDenied, dayEditDenied, saveTicks, addTask, retireTask, loadWeekPage,
  loadCommitmentWeek, movesFor, keptSummary, saveCommitments,
  loadProjects, ownsProject, canEditProject, updateProject, addProject, projectState, teamSummary,
  STEP_STATUSES, loadSteps, ownsStep, canTickStep, stepState, stepSummary, tickStep, updateStep, addStep, removeStep, insertSeedSteps, stepMenu,
};
