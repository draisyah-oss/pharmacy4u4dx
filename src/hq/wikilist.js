// Company wiki checklist (16 Oct, framework doc phase 1): the 64 pages the wiki must hold.
// Each page: area, owner, priority (P1 by 15 Nov, P2 by 31 Dec, P3 Q1 2027), status
// Not started → Drafting → Checking → Approved, and who is writing it.
// 18 Oct: Iman owns every page; she sends each to Hanin (Checking) and Hanin approves
// (the approver is app_settings wiki_approver, seed hq.wiki_approver). Only the approver
// and admin can mark a page Approved or take it back out of Approved.
// Feeds Iman's weekly measure "wiki" (pages sent for approval), Hanin's "wikisop" (pages
// approved), their daily tasks and the HQ scoreboard.

const calc = require('../calc');
const { mentionsSalary, SALARY_MESSAGE } = require('../privacy');

const STATUSES = ['Not started', 'Drafting', 'Checking', 'Approved'];

async function insertChecklist(tx, seed) {
  const items = (seed.hq && seed.hq.wiki_checklist) || [];
  const due = (seed.hq && seed.hq.wiki_checklist_due) || {};
  const people = new Map((await tx.query('SELECT id, name FROM people WHERE branch_id IS NULL')).rows.map((p) => [p.name, p.id]));
  for (const [i, it] of items.entries()) {
    await tx.query(
      `INSERT INTO hq_wiki_items (area, title, owner, person_id, priority, due_date, sort_order) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [it.area, it.title, it.owner, people.get(it.owner) || null, it.priority, due[it.priority] || null, i + 1]);
  }
  return items.length;
}

async function approverId(db) {
  const row = (await db.query("SELECT value FROM app_settings WHERE key = 'wiki_approver'")).rows[0];
  let name = 'Hanin';
  if (row) { try { name = JSON.parse(row.value); } catch { name = row.value; } }
  const p = (await db.query('SELECT id FROM people WHERE branch_id IS NULL AND active AND name = $1', [name])).rows[0];
  return p ? p.id : null;
}

const isApprover = (user, approver) => Boolean(approver && user.person_id === approver);

// Who may change a page: its owner, Iman (fills in for everyone), the approver (Hanin) and admin.
function canChange(user, item, approver = null) {
  if (user.role === 'admin') return true;
  if (user.role === 'hq' && user.enters_all_hq) return true;
  if (isApprover(user, approver)) return true;
  return Boolean(user.person_id && item.person_id === user.person_id);
}

async function load(db, { today }) {
  const items = (await db.query(
    `SELECT w.*, u.display_name AS updated_by_name FROM hq_wiki_items w LEFT JOIN users u ON u.id = w.updated_by ORDER BY w.sort_order, w.id`)).rows;
  for (const it of items) it.overdue = it.status !== 'Approved' && it.due_date && it.due_date < today;
  return items;
}

function summarise(items) {
  const count = (xs) => ({ total: xs.length, approved: xs.filter((i) => i.status === 'Approved').length });
  const areas = [];
  for (const it of items) {
    let a = areas.find((x) => x.area === it.area);
    if (!a) { a = { area: it.area, owner: it.owner, items: [] }; areas.push(a); }
    a.items.push(it);
  }
  for (const a of areas) Object.assign(a, count(a.items), { p1: count(a.items.filter((i) => i.priority === 'P1')) });
  const owners = [...new Set(items.map((i) => i.owner))].map((o) => ({ owner: o, ...count(items.filter((i) => i.owner === o)), p1: count(items.filter((i) => i.owner === o && i.priority === 'P1')) }));
  return { all: count(items), p1: count(items.filter((i) => i.priority === 'P1')), overdue: items.filter((i) => i.overdue).length, areas, owners };
}

async function update(db, user, id, body, { at = new Date() } = {}) {
  const item = (await db.query('SELECT * FROM hq_wiki_items WHERE id = $1', [id])).rows[0];
  if (!item) return { error: 'That page isn’t on the checklist.' };
  const approver = await approverId(db);
  if (!canChange(user, item, approver)) return { error: 'Only the owner (or Iman) can change this page.' };
  const status = STATUSES.includes(body.status) ? body.status : item.status;
  const approving = status !== item.status && (status === 'Approved' || item.status === 'Approved');
  if (approving && user.role !== 'admin' && !isApprover(user, approver)) {
    return { error: 'Hanin approves the wiki pages – mark it Checking and she’ll approve it.' };
  }
  const writer = String(body.writer ?? item.writer ?? '').trim().slice(0, 80) || null;
  if (writer && mentionsSalary(writer)) return { error: SALARY_MESSAGE };
  if (status === item.status && writer === (item.writer || null)) return { saved: 0 };
  await db.transaction(async (tx) => {
    await tx.query(
      `UPDATE hq_wiki_items SET status = $2, writer = $3, updated_by = $4, updated_at = $5,
         approved_at = CASE WHEN $2 = 'Approved' THEN COALESCE(approved_at, $5) ELSE NULL END,
         checking_at = CASE WHEN $2 = 'Checking' AND status <> 'Checking' THEN $5
                            WHEN $2 = 'Approved' THEN COALESCE(checking_at, $5)
                            WHEN $2 IN ('Not started', 'Drafting') THEN NULL ELSE checking_at END
       WHERE id = $1`, [item.id, status, writer, user.id, at]);
    await tx.query(
      `INSERT INTO audit_log (user_id, action, table_name, record_key, old_value, new_value) VALUES ($1, 'update', 'hq_wiki_items', $2, $3, $4)`,
      [user.id, `${item.area}: ${item.title}`, JSON.stringify({ status: item.status, writer: item.writer }), JSON.stringify({ status, writer })]);
  });
  return { saved: 1, item, status };
}

const weekRange = (week) => [new Date(Date.parse(`${week}T00:00:00+08:00`)), new Date(Date.parse(`${calc.addDays(week, 7)}T00:00:00+08:00`))];

// Pages approved in a week (Mon–Sun, Malaysia time) – the approver's weekly measure (all pages),
// or one owner's when personId is given.
async function approvedInWeek(db, { week, personId = null }) {
  const [from, to] = weekRange(week);
  return (await db.query(
    `SELECT count(*)::int AS n FROM hq_wiki_items WHERE approved_at >= $1 AND approved_at < $2 ${personId ? 'AND person_id = $3' : ''}`,
    personId ? [from, to, personId] : [from, to])).rows[0].n;
}

// Pages the owner sent for approval (moved to Checking) in a week – Iman's weekly measure.
async function sentInWeek(db, { week, personId }) {
  const [from, to] = weekRange(week);
  return (await db.query(
    'SELECT count(*)::int AS n FROM hq_wiki_items WHERE person_id = $1 AND checking_at >= $2 AND checking_at < $3', [personId, from, to])).rows[0].n;
}

module.exports = { STATUSES, insertChecklist, approverId, isApprover, canChange, load, summarise, update, approvedInWeek, sentInWeek };
