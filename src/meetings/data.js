// Meetings module (8 Nov 2026): groups, meetings, agenda, updates, my notes, actions, decisions.
// Every function that reads or writes group data checks access through ./access (server-side);
// a group the login isn't in behaves as if it didn't exist. Every change is audited.

const calc = require('../calc');
const { isRealDate } = require('../lib/dates');
const { mentionsSalary, SALARY_MESSAGE } = require('../privacy');
const A = require('./access');
const F = require('./flags');
const E = require('./events');

const today = (now) => calc.todayInMalaysia(now());

async function audit(q, user, action, table, key, oldValue, newValue) {
  await q.query(
    'INSERT INTO audit_log (user_id, action, table_name, record_key, old_value, new_value) VALUES ($1, $2, $3, $4, $5, $6)',
    [user ? user.id : null, action, table, String(key), oldValue == null ? null : JSON.stringify(oldValue), newValue == null ? null : JSON.stringify(newValue)]);
}

// Free text from a form: trimmed, length-limited, never salary/pay details.
function clean(value, { max = 500, label = 'This box', required = false } = {}) {
  const s = String(value ?? '').replace(/\r\n/g, '\n').trim();
  if (!s) return required ? { error: `${label} is empty.` } : { value: null };
  if (s.length > max) return { error: `${label} is too long (${max} characters at most).` };
  if (mentionsSalary(s)) return { error: SALARY_MESSAGE };
  return { value: s };
}
const oneOf = (v, list, dflt) => (list.includes(v) ? v : dflt);
const dateOrNull = (v) => (isRealDate(String(v || '')) ? String(v) : null);

// ───────────────────────── Groups ─────────────────────────

async function groupsFor(db, user) {
  const [where, args] = await A.groupFilter(db, user, 'g.id');
  return (await db.query(
    `SELECT g.*, (SELECT count(*)::int FROM meeting_group_members m WHERE m.group_id = g.id) AS members
     FROM meeting_groups g WHERE g.active AND ${where} ORDER BY g.sort_order, g.id`, args)).rows;
}

// Members of a group, plus the CEO (who attends every group).
async function members(db, groupId) {
  return (await db.query(
    `SELECT u.id, u.username, COALESCE(p.name, u.display_name) AS name, u.role, u.is_super, b.code AS branch_code, p.role AS job
     FROM users u LEFT JOIN people p ON p.id = u.person_id LEFT JOIN branches b ON b.id = u.branch_id
     WHERE u.active AND (u.id IN (SELECT user_id FROM meeting_group_members WHERE group_id = $1) OR (u.role = 'admin' AND u.is_super))
     ORDER BY u.is_super DESC, p.sort_order NULLS LAST, u.display_name`, [groupId])).rows
    .map((m) => ({ ...m, name: m.is_super && m.name === 'Admin' ? 'Dr Aisyah' : m.name }));
}

const isMember = async (db, groupId, userId) => (await members(db, groupId)).some((m) => m.id === Number(userId));

// Admin → Meeting groups (CEO only).
async function saveGroup(db, user, body) {
  if (!A.isCeo(user)) return { forbidden: true };
  const name = clean(body.name, { max: 80, label: 'Group name', required: true });
  if (name.error) return { error: name.error };
  const fields = {
    name: name.value,
    kind: oneOf(body.kind, ['team', 'one_to_one', 'branch_1on1'], 'team'),
    default_day: oneOf(body.default_day, A.DAYS, null),
    default_time: /^\d{1,2}:\d{2}$/.test(String(body.default_time || '')) ? String(body.default_time) : null,
    agenda_template: oneOf(body.agenda_template, ['council', 'branch', 'simple'], 'simple'),
  };
  fields.branch = fields.kind === 'branch_1on1' ? oneOf(body.branch, A.BRANCH_LIST, null) : null;
  if (fields.kind === 'branch_1on1' && !fields.branch) return { error: 'A Branch 1:1 needs its branch.' };
  const ids = [].concat(body.members || []).map(Number).filter(Boolean);
  return db.transaction(async (tx) => {
    let id = Number(body.id) || 0;
    if (id) {
      const old = (await tx.query('SELECT * FROM meeting_groups WHERE id = $1', [id])).rows[0];
      if (!old) return { error: 'That group doesn’t exist.' };
      await tx.query(`UPDATE meeting_groups SET name = $2, kind = $3, default_day = $4, default_time = $5, agenda_template = $6,
        active = $7, branch = $8 WHERE id = $1`, [id, fields.name, fields.kind, fields.default_day, fields.default_time, fields.agenda_template, body.active !== 'no', fields.branch]);
      await audit(tx, user, 'update', 'meeting_groups', old.code, old, { ...fields, active: body.active !== 'no' });
    } else {
      const base = fields.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30) || 'group';
      let code = base; let n = 1;
      while ((await tx.query('SELECT 1 FROM meeting_groups WHERE code = $1', [code])).rows.length) code = `${base}-${++n}`;
      const max = (await tx.query('SELECT COALESCE(max(sort_order), 0) + 1 AS n FROM meeting_groups')).rows[0].n;
      id = (await tx.query(`INSERT INTO meeting_groups (code, name, kind, default_day, default_time, agenda_template, sort_order, branch)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`, [code, fields.name, fields.kind, fields.default_day, fields.default_time, fields.agenda_template, max, fields.branch])).rows[0].id;
      await audit(tx, user, 'insert', 'meeting_groups', code, null, fields);
    }
    const valid = (await tx.query("SELECT id FROM users WHERE active AND NOT (role = 'admin' AND is_super) AND id = ANY($1::int[])", [ids])).rows.map((r) => r.id);
    const before = (await tx.query('SELECT user_id FROM meeting_group_members WHERE group_id = $1 ORDER BY user_id', [id])).rows.map((r) => r.user_id);
    await tx.query('DELETE FROM meeting_group_members WHERE group_id = $1', [id]);
    for (const uid of valid) await tx.query('INSERT INTO meeting_group_members (group_id, user_id) VALUES ($1, $2)', [id, uid]);
    if (before.join() !== [...valid].sort((a, b) => a - b).join()) await audit(tx, user, 'update', 'meeting_group_members', id, before, valid);
    return { ok: true, id };
  });
}

async function allGroupsForAdmin(db) {
  const groups = (await db.query('SELECT * FROM meeting_groups ORDER BY active DESC, sort_order, id')).rows;
  const mem = (await db.query('SELECT group_id, user_id FROM meeting_group_members')).rows;
  for (const g of groups) g.member_ids = mem.filter((m) => m.group_id === g.id).map((m) => m.user_id);
  return groups;
}

// Logins that can be put in a group (everyone active except the super admin, who is in all of them).
async function selectableUsers(db) {
  return (await db.query(
    `SELECT u.id, u.username, COALESCE(p.name, u.display_name) AS name, u.role, b.code AS branch_code
     FROM users u LEFT JOIN people p ON p.id = u.person_id LEFT JOIN branches b ON b.id = u.branch_id
     WHERE u.active AND NOT (u.role = 'admin' AND u.is_super)
     ORDER BY (u.branch_id IS NOT NULL), b.sort_order NULLS FIRST, p.sort_order NULLS LAST, u.display_name`)).rows;
}

// ───────────────────────── Actions ─────────────────────────

const ACTION_SELECT = `SELECT a.*, g.code AS group_code, g.name AS group_name,
  COALESCE(op.name, ou.display_name) AS owner_name, ou.is_super AS owner_is_super,
  (SELECT x.text FROM action_updates x WHERE x.action_id = a.id ORDER BY x.at DESC, x.id DESC LIMIT 1) AS last_text,
  (SELECT x.at FROM action_updates x WHERE x.action_id = a.id ORDER BY x.at DESC, x.id DESC LIMIT 1) AS last_text_at
  FROM actions a JOIN meeting_groups g ON g.id = a.group_id
  LEFT JOIN users ou ON ou.id = a.owner_user_id LEFT JOIN people op ON op.id = ou.person_id`;
const ownerName = (a) => (a.owner_is_super && a.owner_name === 'Admin' ? 'Dr Aisyah' : a.owner_name);

// Actions this login may see. Options: groupId, ownerId, open (only open ones).
async function listActions(db, user, { groupId = null, ownerId = null, open = false, now }) {
  const args = [];
  let [where, a2] = await A.groupFilter(db, user, 'a.group_id', args);
  const cond = [where, 'g.active'];
  if (groupId) { a2.push(Number(groupId)); cond.push(`a.group_id = $${a2.length}`); }
  if (ownerId) { a2.push(Number(ownerId)); cond.push(`a.owner_user_id = $${a2.length}`); }
  if (open) cond.push("a.status <> 'dn'");
  const t = today(now);
  const rows = (await db.query(`${ACTION_SELECT} WHERE ${cond.join(' AND ')}`, a2)).rows;
  return F.sortActions(rows, t).map((r) => F.decorate({ ...r, owner_name: ownerName(r) }, t));
}

async function loadAction(db, user, id, { now }) {
  const a = (await db.query(`${ACTION_SELECT} WHERE a.id = $1 AND g.active`, [Number(id) || 0])).rows[0];
  if (!a || !(await A.canSeeGroup(db, user, a.group_id))) return null;
  a.updates = (await db.query(
    `SELECT x.*, COALESCE(p.name, u.display_name) AS by_name, u.is_super FROM action_updates x
     LEFT JOIN users u ON u.id = x.by_user LEFT JOIN people p ON p.id = u.person_id
     WHERE x.action_id = $1 ORDER BY x.at DESC, x.id DESC`, [a.id])).rows
    .map((x) => ({ ...x, by_name: x.is_super && x.by_name === 'Admin' ? 'Dr Aisyah' : x.by_name }));
  return F.decorate({ ...a, owner_name: ownerName(a) }, today(now));
}

function actionFields(body, memberIds) {
  const title = clean(body.title, { max: 300, label: 'What needs to be done', required: true });
  if (title.error) return { error: title.error };
  const owner = Number(body.owner) || null;
  if (owner && !memberIds.includes(owner)) return { error: 'The owner must be in this meeting group.' };
  return {
    fields: {
      title: title.value, owner_user_id: owner, due: dateOrNull(body.due),
      area: oneOf(body.area, Object.keys(A.AREAS), 'mgmt'), branch: oneOf(body.branch, Object.keys(A.BRANCHES), 'HQ'),
      status: oneOf(body.status, Object.keys(A.STATUS), 'ns'), priority: oneOf(body.priority, A.PRIORITY, 'Normal'),
      needs_ceo: body.needs_ceo === '1' || body.needs_ceo === 'on' || body.needs_ceo === true,
    },
  };
}

async function createAction(db, user, group, body, { now, meetingId = null, source = 'Added in 4DX', tx: q = null } = {}) {
  const ids = (await members(q || db, group.id)).map((m) => m.id);
  const r = actionFields(body, ids);
  if (r.error) return r;
  const note = clean(body.note, { max: 500, label: 'Note' });
  if (note.error) return { error: note.error };
  const run = async (tx) => {
    const f = r.fields;
    const id = (await tx.query(
      `INSERT INTO actions (group_id, title, owner_user_id, due, area, branch, status, priority, needs_ceo, first_raised,
         source_meeting_id, source, last_update_at, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,now(),$13) RETURNING id`,
      [group.id, f.title, f.owner_user_id, f.due, f.area, f.branch, f.status, f.priority, f.needs_ceo, today(now), meetingId, source, user.id])).rows[0].id;
    if (note.value) await tx.query('INSERT INTO action_updates (action_id, by_user, text) VALUES ($1, $2, $3)', [id, user.id, note.value]);
    await audit(tx, user, 'insert', 'actions', id, null, f);
    return { ok: true, id };
  };
  return q ? run(q) : db.transaction(run);
}

// Change an action and/or add this week's update. Any member of the group may (as the prototypes).
// quiet: no "What's new" line (minutes and follow-ups write their own).
async function updateAction(db, user, action, body, { now, tx: q = null, raised = false, quiet = false } = {}) {
  const ids = (await members(q || db, action.group_id)).map((m) => m.id);
  const merged = { title: action.title, owner: action.owner_user_id, due: action.due, area: action.area, branch: action.branch,
    status: action.status, priority: action.priority, needs_ceo: action.needs_ceo, ...body };
  if ('needs_ceo' in body || body._full) merged.needs_ceo = body.needs_ceo === '1' || body.needs_ceo === 'on' || body.needs_ceo === true;
  const r = actionFields(merged, ids);
  if (r.error) return r;
  const note = clean(body.note, { max: 500, label: 'Update' });
  if (note.error) return { error: note.error };
  const f = r.fields;
  const changed = Object.keys(f).filter((k) => String(f[k] ?? '') !== String(action[k] ?? ''));
  if (!changed.length && !note.value && !raised) return { ok: true, unchanged: true };
  const run = async (tx) => {
    await tx.query(`UPDATE actions SET title = $2, owner_user_id = $3, due = $4, area = $5, branch = $6, status = $7, priority = $8,
      needs_ceo = $9, last_update_at = now(), updated_at = now(), raised_count = raised_count + $10 WHERE id = $1`,
    [action.id, f.title, f.owner_user_id, f.due, f.area, f.branch, f.status, f.priority, f.needs_ceo, raised ? 1 : 0]);
    const text = note.value || (changed.includes('status') ? `Status → ${A.STATUS[f.status]}` : null);
    if (text) await tx.query('INSERT INTO action_updates (action_id, by_user, text) VALUES ($1, $2, $3)', [action.id, user.id, text]);
    await audit(tx, user, 'update', 'actions', action.id, Object.fromEntries(changed.map((k) => [k, action[k]])), { ...Object.fromEntries(changed.map((k) => [k, f[k]])), note: note.value, raised });
    if (!quiet && (note.value || changed.includes('status'))) {
      const who = await E.nameOf(tx, user.id);
      const st = changed.includes('status');
      const kind = st && f.status === 'dn' ? 'action_done' : st ? 'action_status' : 'action_update';
      const head = kind === 'action_done' ? `${who} closed “${f.title}”` : st ? `${who} set “${f.title}” → ${A.STATUS[f.status]}` : `${who} updated “${f.title}”`;
      await E.log(tx, { kind, actor: user.id, subject: f.owner_user_id, groupId: action.group_id, branch: f.branch, refType: 'action', refId: action.id,
        text: note.value ? `${head}: ${note.value}` : head });
    }
    return { ok: true };
  };
  return q ? run(q) : db.transaction(run);
}

// ───────────────────────── Decisions ─────────────────────────

async function listDecisions(db, user, { groupId = null, q = '', area = '', branch = '', from = '', to = '' } = {}) {
  let [where, args] = await A.groupFilter(db, user, 'd.group_id');
  const cond = [where, 'g.active'];
  if (groupId) { args.push(Number(groupId)); cond.push(`d.group_id = $${args.length}`); }
  if (q) { args.push(`%${String(q).toLowerCase()}%`); cond.push(`(lower(d.text) LIKE $${args.length} OR lower(COALESCE(d.context, '')) LIKE $${args.length})`); }
  if (A.AREAS[area]) { args.push(area); cond.push(`d.area = $${args.length}`); }
  if (A.BRANCHES[branch]) { args.push(branch); cond.push(`d.branch = $${args.length}`); }
  if (isRealDate(from)) { args.push(from); cond.push(`d.decided_on >= $${args.length}`); }
  if (isRealDate(to)) { args.push(to); cond.push(`d.decided_on <= $${args.length}`); }
  return (await db.query(
    `SELECT d.*, g.code AS group_code, g.name AS group_name, m.held_on AS meeting_date, m.title AS meeting_title,
       COALESCE(p.name, u.display_name) AS decided_by_name, u.is_super
     FROM decisions d JOIN meeting_groups g ON g.id = d.group_id LEFT JOIN meetings m ON m.id = d.meeting_id
     LEFT JOIN users u ON u.id = d.decided_by LEFT JOIN people p ON p.id = u.person_id
     WHERE ${cond.join(' AND ')} ORDER BY d.decided_on DESC, d.id DESC LIMIT 500`, args)).rows
    .map((d) => ({ ...d, decided_by_name: d.is_super && d.decided_by_name === 'Admin' ? 'Dr Aisyah' : d.decided_by_name }));
}

async function createDecision(db, user, group, body, { now, meetingId = null, tx: q = null } = {}) {
  const text = clean(body.text, { max: 500, label: 'Decision', required: true });
  if (text.error) return text;
  const context = clean(body.context, { max: 500, label: 'Context' });
  if (context.error) return context;
  const ids = (await members(q || db, group.id)).map((m) => m.id);
  const by = Number(body.decided_by) || null;
  const f = {
    text: text.value, context: context.value, decided_on: dateOrNull(body.date) || today(now),
    area: oneOf(body.area, Object.keys(A.AREAS), 'mgmt'), branch: oneOf(body.branch, Object.keys(A.BRANCHES), 'ALL'),
    decided_by: by && ids.includes(by) ? by : null,
  };
  const run = async (tx) => {
    const id = (await tx.query(`INSERT INTO decisions (group_id, meeting_id, decided_on, text, context, area, branch, decided_by, created_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
    [group.id, meetingId, f.decided_on, f.text, f.context, f.area, f.branch, f.decided_by, user.id])).rows[0].id;
    await audit(tx, user, 'insert', 'decisions', id, null, f);
    return { ok: true, id };
  };
  return q ? run(q) : db.transaction(run);
}

// ───────────────────────── Meetings ─────────────────────────

async function listMeetings(db, user, { groupId = null, from = null } = {}) {
  let [where, args] = await A.groupFilter(db, user, 'm.group_id');
  const cond = [where, 'g.active'];
  if (groupId) { args.push(Number(groupId)); cond.push(`m.group_id = $${args.length}`); }
  if (from) { args.push(from); cond.push(`m.held_on >= $${args.length}`); }
  return (await db.query(
    `SELECT m.id, m.group_id, m.title, m.held_on, m.start_time, m.status, g.name AS group_name, g.code AS group_code, g.kind, g.branch AS group_branch,
       m.led_by, (SELECT COALESCE(p.name, u.display_name) FROM users u LEFT JOIN people p ON p.id = u.person_id WHERE u.id = m.led_by) AS led_by_name,
       (SELECT count(*)::int FROM meeting_attendees x WHERE x.meeting_id = m.id) AS attendees
     FROM meetings m JOIN meeting_groups g ON g.id = m.group_id WHERE ${cond.join(' AND ')}
     ORDER BY m.held_on DESC, m.id DESC LIMIT 200`, args)).rows.map((m) => ({ ...m, led_by_name: m.led_by_name === 'Admin' ? 'Dr Aisyah' : m.led_by_name }));
}

async function loadMeeting(db, user, id) {
  const m = (await db.query(
    `SELECT m.*, g.name AS group_name, g.code AS group_code, g.kind, g.branch AS group_branch, g.agenda_template, g.default_time,
       (SELECT COALESCE(p.name, u.display_name) FROM users u LEFT JOIN people p ON p.id = u.person_id WHERE u.id = m.led_by) AS led_by_name
     FROM meetings m JOIN meeting_groups g ON g.id = m.group_id WHERE m.id = $1 AND g.active`, [Number(id) || 0])).rows[0];
  if (!m || !(await A.canSeeGroup(db, user, m.group_id))) return null;
  if (m.led_by_name === 'Admin') m.led_by_name = 'Dr Aisyah';
  m.attendee_list = (await db.query(
    `SELECT u.id, COALESCE(p.name, u.display_name) AS name, u.is_super, x.present FROM meeting_attendees x JOIN users u ON u.id = x.user_id
     LEFT JOIN people p ON p.id = u.person_id WHERE x.meeting_id = $1 ORDER BY u.is_super DESC, p.sort_order NULLS LAST, u.display_name`, [m.id])).rows
    .map((a) => ({ ...a, name: a.is_super && a.name === 'Admin' ? 'Dr Aisyah' : a.name }));
  return m;
}

const locked = (m) => m.status === 'approved';

async function createMeeting(db, user, group, body, { now }) {
  const held = dateOrNull(body.date) || today(now);
  const time = /^\d{1,2}:\d{2}$/.test(String(body.time || '')) ? String(body.time) : group.default_time || null;
  const title = clean(body.title, { max: 120, label: 'Title' });
  if (title.error) return title;
  const mem = await members(db, group.id);
  const chosen = [].concat(body.att || []).map(Number).filter((id) => mem.some((m) => m.id === id));
  const att = chosen.length ? chosen : mem.map((m) => m.id);
  // 9 Nov: Branch 1:1s say who led them – the CEO or Hanin (any member who isn't the branch manager).
  let ledBy = null;
  if (group.kind === 'branch_1on1') {
    const can = leaders(mem);
    ledBy = can.some((l) => l.id === Number(body.led_by)) ? Number(body.led_by) : defaultLeader(can, user);
  }
  return db.transaction(async (tx) => {
    const id = (await tx.query(`INSERT INTO meetings (group_id, title, held_on, start_time, created_by, led_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      [group.id, title.value, held, time, user.id, ledBy])).rows[0].id;
    for (const uid of att) await tx.query('INSERT INTO meeting_attendees (meeting_id, user_id) VALUES ($1, $2)', [id, uid]);
    await audit(tx, user, 'insert', 'meetings', id, null, { group: group.code, held_on: held, time, attendees: att, led_by: ledBy });
    return { ok: true, id };
  });
}

// Who can lead a Branch 1:1: the CEO and members who aren't branch managers (Hanin). Default: the person
// creating it when they can lead, else the first non-CEO leader (a branch manager creating it → Hanin).
function leaders(mem) {
  return mem.filter((m) => m.role !== 'branch_manager' && m.role !== 'branch_staff');
}
function defaultLeader(can, user) {
  if (can.some((l) => l.id === user.id)) return user.id;
  const notCeo = can.find((l) => !l.is_super);
  return (notCeo || can[0] || { id: null }).id;
}

// Next meeting of a group (the soonest from today, else the latest not approved).
async function nextMeeting(db, groupId, { now }) {
  const t = today(now);
  return (await db.query(`SELECT * FROM meetings WHERE group_id = $1 AND status <> 'approved'
    ORDER BY (held_on >= $2) DESC, CASE WHEN held_on >= $2 THEN held_on END ASC, held_on DESC LIMIT 1`, [groupId, t])).rows[0] || null;
}

// ───────────────────────── Agenda: items to discuss ─────────────────────────
// Items with meeting_id NULL wait for the group's next meeting and show on every open meeting.

async function agendaItems(db, meeting) {
  return (await db.query(
    `SELECT i.*, COALESCE(p.name, u.display_name) AS raised_by_name, u.is_super FROM agenda_items i
     LEFT JOIN users u ON u.id = i.raised_by LEFT JOIN people p ON p.id = u.person_id
     WHERE i.group_id = $1 AND i.removed_at IS NULL
       AND (i.meeting_id = $2 OR (i.meeting_id IS NULL AND i.outcome IS NULL AND $3 <> 'approved'))
     ORDER BY i.created_at, i.id`, [meeting.group_id, meeting.id, meeting.status])).rows
    .map((i) => ({ ...i, raised_by_name: i.is_super && i.raised_by_name === 'Admin' ? 'Dr Aisyah' : i.raised_by_name }));
}

async function openItemsForGroup(db, groupId) {
  return (await db.query(`SELECT i.*, COALESCE(p.name, u.display_name) AS raised_by_name FROM agenda_items i
    LEFT JOIN users u ON u.id = i.raised_by LEFT JOIN people p ON p.id = u.person_id
    WHERE i.group_id = $1 AND i.removed_at IS NULL AND i.outcome IS NULL ORDER BY i.created_at`, [groupId])).rows;
}

async function addItem(db, user, group, body, { meeting = null, source = 'manual', sourceId = null, tx: q = null } = {}) {
  if (meeting && locked(meeting)) return { error: 'The minutes are approved – this meeting is locked.' };
  const text = clean(body.text, { max: 500, label: 'Item', required: true });
  if (text.error) return text;
  const need = oneOf(body.need, Object.keys(A.NEEDS), 'discuss');
  const run = async (tx) => {
    const id = (await tx.query(`INSERT INTO agenda_items (group_id, meeting_id, text, need, raised_by, source, source_id)
      VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`, [group.id, meeting ? meeting.id : null, text.value, need, user.id, source, sourceId])).rows[0].id;
    await audit(tx, user, 'insert', 'agenda_items', id, null, { group: group.code, meeting: meeting && meeting.id, text: text.value, need, source });
    const gname = group.name || (await tx.query('SELECT name FROM meeting_groups WHERE id = $1', [group.id])).rows[0].name;
    await E.log(tx, { kind: 'item', actor: user.id, groupId: group.id, branch: group.branch || null, refType: 'item', refId: id, linkId: meeting ? meeting.id : null,
      text: `${await E.nameOf(tx, user.id)} added an item to discuss (${gname}, ${A.NEEDS[need].toLowerCase()}): ${text.value}` });
    return { ok: true, id };
  };
  return q ? run(q) : db.transaction(run);
}

// The person who raised it, or the CEO, can remove an item (not once its meeting's minutes are approved).
async function removeItem(db, user, id) {
  const it = (await db.query('SELECT i.*, m.status AS meeting_status FROM agenda_items i LEFT JOIN meetings m ON m.id = i.meeting_id WHERE i.id = $1 AND i.removed_at IS NULL', [Number(id) || 0])).rows[0];
  if (!it || !(await A.canSeeGroup(db, user, it.group_id))) return { notFound: true };
  if (it.raised_by !== user.id && !A.isCeo(user)) return { forbidden: true, error: 'Only the person who raised it, or Dr Aisyah, can remove it.' };
  if (it.meeting_status === 'approved') return { error: 'The minutes are approved – this meeting is locked.' };
  if (it.source === 'update') return { error: 'This item comes from a meeting update – clear “help needed” in that update instead.' };
  await db.transaction(async (tx) => {
    await tx.query('UPDATE agenda_items SET removed_at = now() WHERE id = $1', [it.id]);
    if (it.source === 'note') await tx.query('UPDATE private_notes SET agenda_item_id = NULL WHERE agenda_item_id = $1', [it.id]);
    await audit(tx, user, 'delete', 'agenda_items', it.id, { text: it.text }, null);
  });
  return { ok: true, groupId: it.group_id, meetingId: it.meeting_id };
}

// ───────────────────────── Meeting updates ─────────────────────────

async function updatesFor(db, meeting) {
  return (await db.query(`SELECT x.*, COALESCE(p.name, u.display_name) AS name, u.is_super FROM meeting_updates x JOIN users u ON u.id = x.user_id
    LEFT JOIN people p ON p.id = u.person_id WHERE x.meeting_id = $1 ORDER BY x.updated_at`, [meeting.id])).rows
    .map((x) => ({ ...x, name: x.is_super && x.name === 'Admin' ? 'Dr Aisyah' : x.name }));
}

// Save my update (attendees of the meeting, or the CEO). "Help needed" becomes an item to discuss,
// kept in sync: changed → item text changes; cleared → item removed.
async function saveUpdate(db, user, meeting, body) {
  if (locked(meeting)) return { error: 'The minutes are approved – updates are locked.' };
  const isAttendee = meeting.attendee_list.some((a) => a.id === user.id);
  if (!isAttendee && !A.isCeo(user)) return { forbidden: true, error: 'Only people in this meeting send an update.' };
  const f = {};
  for (const [k, label] of [['win', '1 win'], ['issue1', 'Issue 1'], ['issue2', 'Issue 2'], ['help_needed', 'Help needed']]) {
    const c = clean(body[k], { max: 500, label });
    if (c.error) return { error: c.error };
    f[k] = c.value;
  }
  if (!f.win && !f.issue1 && !f.issue2 && !f.help_needed) return { error: 'Write at least one box.' };
  await db.transaction(async (tx) => {
    const old = (await tx.query('SELECT * FROM meeting_updates WHERE meeting_id = $1 AND user_id = $2', [meeting.id, user.id])).rows[0];
    await tx.query(`INSERT INTO meeting_updates (meeting_id, user_id, win, issue1, issue2, help_needed) VALUES ($1,$2,$3,$4,$5,$6)
      ON CONFLICT (meeting_id, user_id) DO UPDATE SET win = $3, issue1 = $4, issue2 = $5, help_needed = $6, updated_at = now()`,
    [meeting.id, user.id, f.win, f.issue1, f.issue2, f.help_needed]);
    await syncHelpItem(tx, user, meeting, user.id, f.help_needed);
    await audit(tx, user, old ? 'update' : 'insert', 'meeting_updates', `${meeting.id}/${user.id}`, old ? { win: old.win, issue1: old.issue1, issue2: old.issue2, help_needed: old.help_needed } : null, f);
  });
  return { ok: true };
}

async function syncHelpItem(tx, actor, meeting, ownerId, help) {
  const item = (await tx.query(`SELECT * FROM agenda_items WHERE meeting_id = $1 AND source = 'update' AND raised_by = $2 AND removed_at IS NULL`,
    [meeting.id, ownerId])).rows[0];
  if (help && item) { if (item.text !== help) await tx.query('UPDATE agenda_items SET text = $2 WHERE id = $1', [item.id, help]); }
  else if (help) {
    const id = (await tx.query(`INSERT INTO agenda_items (group_id, meeting_id, text, need, raised_by, source, source_id) VALUES ($1,$2,$3,'decision',$4,'update',$5) RETURNING id`,
      [meeting.group_id, meeting.id, help, ownerId, meeting.id])).rows[0].id;
    await E.log(tx, { kind: 'item', actor: ownerId, groupId: meeting.group_id, branch: meeting.group_branch || null, refType: 'item', refId: id, linkId: meeting.id,
      text: `${await E.nameOf(tx, ownerId)} needs help (${meeting.group_name}): ${help}` });
  } else if (item) await tx.query('UPDATE agenda_items SET removed_at = now() WHERE id = $1', [item.id]);
}

// Delete an update: the owner, or the CEO (anyone's).
async function deleteUpdate(db, user, meeting, ownerId) {
  if (locked(meeting)) return { error: 'The minutes are approved – updates are locked.' };
  const uid = Number(ownerId) || 0;
  if (uid !== user.id && !A.isCeo(user)) return { forbidden: true, error: 'You can only delete your own update.' };
  const old = (await db.query('SELECT * FROM meeting_updates WHERE meeting_id = $1 AND user_id = $2', [meeting.id, uid])).rows[0];
  if (!old) return { ok: true };
  await db.transaction(async (tx) => {
    await tx.query('DELETE FROM meeting_updates WHERE meeting_id = $1 AND user_id = $2', [meeting.id, uid]);
    await syncHelpItem(tx, user, meeting, uid, null);
    await audit(tx, user, 'delete', 'meeting_updates', `${meeting.id}/${uid}`, old, null);
  });
  return { ok: true };
}

// ───────────────────────── My notes (private) ─────────────────────────

async function myNotes(db, user) {
  return (await db.query(`SELECT n.*, m.held_on, m.status AS meeting_status, g.name AS group_name, i.removed_at AS item_removed, i.outcome AS item_outcome
    FROM private_notes n LEFT JOIN meetings m ON m.id = n.meeting_id LEFT JOIN meeting_groups g ON g.id = m.group_id
    LEFT JOIN agenda_items i ON i.id = n.agenda_item_id
    WHERE n.user_id = $1 ORDER BY (n.done_at IS NOT NULL), n.created_at DESC`, [user.id])).rows;
}

const loadNote = async (db, user, id) => (await db.query('SELECT * FROM private_notes WHERE id = $1 AND user_id = $2', [Number(id) || 0, user.id])).rows[0] || null;

async function addNote(db, user, body) {
  const text = clean(body.text, { max: 1000, label: 'Note', required: true });
  if (text.error) return text;
  let meetingId = Number(body.meeting) || null;
  if (meetingId && !(await loadMeeting(db, user, meetingId))) meetingId = null;
  const id = (await db.query('INSERT INTO private_notes (user_id, text, need, meeting_id) VALUES ($1,$2,$3,$4) RETURNING id',
    [user.id, text.value, oneOf(body.need, Object.keys(A.NEEDS), 'discuss'), meetingId])).rows[0].id;
  return { ok: true, id };
}

// Note actions: agenda (add to a meeting's agenda), takeback, done, undone, delete.
async function noteAct(db, user, id, action, { meetingId = null } = {}) {
  const n = await loadNote(db, user, id);
  if (!n) return { notFound: true };
  if (action === 'agenda') {
    if (n.agenda_item_id) return { error: 'Already on an agenda.' };
    const m = await loadMeeting(db, user, meetingId || n.meeting_id);
    if (!m) return { error: 'Choose a meeting you are in.' };
    return db.transaction(async (tx) => {
      const r = await addItem(tx, user, { id: m.group_id, code: m.group_code }, { text: n.text, need: n.need }, { meeting: m, source: 'note', sourceId: n.id, tx });
      if (r.error) return r;
      await tx.query('UPDATE private_notes SET agenda_item_id = $2, meeting_id = $3 WHERE id = $1', [n.id, r.id, m.id]);
      return { ok: true, meetingId: m.id };
    });
  }
  if (action === 'takeback') {
    if (!n.agenda_item_id) return { ok: true };
    const it = (await db.query('SELECT i.*, m.status AS meeting_status FROM agenda_items i LEFT JOIN meetings m ON m.id = i.meeting_id WHERE i.id = $1', [n.agenda_item_id])).rows[0];
    if (it && (it.outcome || it.meeting_status === 'approved')) return { error: 'The meeting already dealt with it – it can’t be taken back.' };
    await db.transaction(async (tx) => {
      if (it) await tx.query('UPDATE agenda_items SET removed_at = now() WHERE id = $1', [it.id]);
      await tx.query('UPDATE private_notes SET agenda_item_id = NULL WHERE id = $1', [n.id]);
      if (it) await audit(tx, user, 'delete', 'agenda_items', it.id, { text: it.text, taken_back: true }, null);
    });
    return { ok: true };
  }
  if (action === 'done' || action === 'undone') {
    await db.query('UPDATE private_notes SET done_at = $2 WHERE id = $1', [n.id, action === 'done' ? new Date().toISOString() : null]);
    return { ok: true };
  }
  if (action === 'delete') {
    if (n.agenda_item_id) {
      const r = await noteAct(db, user, id, 'takeback');
      if (r.error) await db.query('UPDATE private_notes SET agenda_item_id = NULL WHERE id = $1', [n.id]); // item stays with the meeting
    }
    await db.query('DELETE FROM private_notes WHERE id = $1 AND user_id = $2', [n.id, user.id]);
    return { ok: true };
  }
  return { error: 'Unknown action.' };
}

module.exports = {
  clean, audit, today, locked,
  groupsFor, members, isMember, saveGroup, allGroupsForAdmin, selectableUsers,
  listActions, loadAction, createAction, updateAction,
  listDecisions, createDecision,
  listMeetings, loadMeeting, createMeeting, nextMeeting, leaders, defaultLeader,
  agendaItems, openItemsForGroup, addItem, removeItem,
  updatesFor, saveUpdate, deleteUpdate,
  myNotes, addNote, noteAct,
};
