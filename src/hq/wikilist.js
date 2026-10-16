// Company wiki checklist (16 Oct, framework doc phase 1): the 64 pages the wiki must hold,
// tracked by Iman and Hanin. Each page: area, owner, priority (P1 by 15 Nov, P2 by 31 Dec,
// P3 Q1 2027), status Not started → Drafting → Checking → Approved, and who is writing it.
// Feeds Iman's and Hanin's weekly measures ("wiki", "wikisop"), their daily tasks and the
// HQ scoreboard.

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

// Who may change a page's status: its owner, Iman (fills in for everyone) and admin.
function canChange(user, item) {
  if (user.role === 'admin') return true;
  if (user.role === 'hq' && user.enters_all_hq) return true;
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

async function update(db, user, id, body) {
  const item = (await db.query('SELECT * FROM hq_wiki_items WHERE id = $1', [id])).rows[0];
  if (!item) return { error: 'That page isn’t on the checklist.' };
  if (!canChange(user, item)) return { error: 'Only the owner (or Iman) can change this page.' };
  const status = STATUSES.includes(body.status) ? body.status : item.status;
  const writer = String(body.writer ?? item.writer ?? '').trim().slice(0, 80) || null;
  if (writer && mentionsSalary(writer)) return { error: SALARY_MESSAGE };
  if (status === item.status && writer === (item.writer || null)) return { saved: 0 };
  await db.transaction(async (tx) => {
    await tx.query(
      `UPDATE hq_wiki_items SET status = $2, writer = $3, updated_by = $4, updated_at = now(),
         approved_at = CASE WHEN $2 = 'Approved' THEN COALESCE(approved_at, now()) ELSE NULL END
       WHERE id = $1`, [item.id, status, writer, user.id]);
    await tx.query(
      `INSERT INTO audit_log (user_id, action, table_name, record_key, old_value, new_value) VALUES ($1, 'update', 'hq_wiki_items', $2, $3, $4)`,
      [user.id, `${item.area}: ${item.title}`, JSON.stringify({ status: item.status, writer: item.writer }), JSON.stringify({ status, writer })]);
  });
  return { saved: 1, item, status };
}

// Pages approved in a week (Mon–Sun, Malaysia time) for one owner – their weekly measure.
async function approvedInWeek(db, { week, personId }) {
  const from = new Date(Date.parse(`${week}T00:00:00+08:00`));
  const to = new Date(Date.parse(`${calc.addDays(week, 7)}T00:00:00+08:00`));
  return (await db.query(
    'SELECT count(*)::int AS n FROM hq_wiki_items WHERE person_id = $1 AND approved_at >= $2 AND approved_at < $3', [personId, from, to])).rows[0].n;
}

module.exports = { STATUSES, insertChecklist, canChange, load, summarise, update, approvedInWeek };
