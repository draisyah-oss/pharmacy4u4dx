// 28 Oct: out-of-stock activity – what happened between the branches and Inventory on a day, so the
// CEO can see items were seen, questions asked and answered (no more WhatsApp-only follow-ups).
// Built from the timestamps on oos_items / item_requests and the oos_messages conversation.

const calc = require('../calc');

const MYT = 8 * 3600 * 1000;
const dayBounds = (date) => {
  const from = new Date(Date.parse(`${date}T00:00:00Z`) - MYT);
  return [from, new Date(from.getTime() + 86400e3)];
};
const ANSWER_TEXT = {
  hq_deliver: 'HQ delivers', transfer: 'Transfer from a branch', order: 'Order from the supplier', substitute: 'Substitute', discontinue: 'Discontinue',
};

async function loadActivity(db, { date, branchCode = null, now }) {
  const [from, to] = dayBounds(date);
  const b = branchCode ? (await db.query('SELECT id FROM branches WHERE code = $1', [branchCode])).rows[0] : null;
  const bf = b ? 'AND x.branch_id = $3' : '';
  const args = b ? [from, to, b.id] : [from, to];
  const users = new Map((await db.query('SELECT id, display_name FROM users')).rows.map((u) => [u.id, u.display_name]));
  const who = (id) => (id ? users.get(id) || '–' : '–');
  const events = [];
  const add = (at, kind, side, by, item, text, href) => { if (at && new Date(at) >= from && new Date(at) < to) events.push({ at, kind, side, by, item, text, href }); };

  const items = (await db.query(
    `SELECT x.*, COALESCE(bb.code, 'B2B') AS branch_code FROM oos_items x LEFT JOIN branches bb ON bb.id = x.branch_id
     WHERE (x.reported_at >= $1 AND x.reported_at < $2 OR x.seen_at >= $1 AND x.seen_at < $2 OR x.answered_at >= $1 AND x.answered_at < $2
       OR x.picked_at >= $1 AND x.picked_at < $2 OR x.sent_at >= $1 AND x.sent_at < $2 OR x.received_at >= $1 AND x.received_at < $2
       OR x.late_flagged_at >= $1 AND x.late_flagged_at < $2) ${bf}`, args)).rows;
  for (const it of items) {
    const label = { item: it.item, branch: it.branch_code, type: 'Out of stock' };
    const href = `/oos/${it.id}`;
    add(it.reported_at, 'reported', 'branch', who(it.created_by), label, `Reported${it.urgent ? ' (urgent)' : ''}`, href);
    add(it.seen_at, 'seen', 'hq', who(it.seen_by), label, 'Seen by Inventory', href);
    add(it.answered_at, 'answered', 'hq', who(it.answered_by), label, `Answered: ${ANSWER_TEXT[it.answer] || it.status}${it.answer_qty ? ` × ${it.answer_qty}` : ''}`, href);
    add(it.picked_at, 'picked', 'hq', '', label, 'Picked', href);
    add(it.sent_at, 'sent', 'hq', who(it.sent_by), label, 'Sent – on the way', href);
    add(it.received_at, it.closed_by_hq ? 'done' : 'accepted', it.closed_by_hq ? 'hq' : 'branch', who(it.received_by), label, it.closed_by_hq ? 'Closed by Inventory – delivered' : 'Accepted by the branch – back in stock', href);
    add(it.late_flagged_at, 'late', 'branch', '', label, 'Branch told Inventory it’s late', href);
  }
  const reqs = (await db.query(
    `SELECT x.*, bb.code AS branch_code FROM item_requests x JOIN branches bb ON bb.id = x.branch_id
     WHERE (x.created_at >= $1 AND x.created_at < $2 OR x.seen_at >= $1 AND x.seen_at < $2 OR x.answered_at >= $1 AND x.answered_at < $2) ${bf}`, args)).rows;
  for (const r of reqs) {
    const label = { item: r.item, branch: r.branch_code, type: 'New item' };
    const href = `/oos/new-items/${r.id}`;
    add(r.created_at, 'reported', 'branch', who(r.created_by), label, 'New item requested', href);
    add(r.seen_at, 'seen', 'hq', who(r.seen_by), label, 'Seen by Inventory', href);
    add(r.answered_at, 'answered', 'hq', who(r.answered_by), label, `Answered: ${r.status}`, href);
  }
  const msgs = (await db.query(
    `SELECT m.*, COALESCE(o.item, r.item) AS item, COALESCE(bb.code, 'B2B') AS branch_code, (m.oos_id IS NOT NULL) AS is_oos
     FROM oos_messages m LEFT JOIN oos_items o ON o.id = m.oos_id LEFT JOIN item_requests r ON r.id = m.request_id
     LEFT JOIN branches bb ON bb.id = COALESCE(o.branch_id, r.branch_id)
     WHERE m.created_at >= $1 AND m.created_at < $2 ${b ? 'AND bb.id = $3' : ''}`, args)).rows;
  for (const m of msgs) {
    add(m.created_at, m.from_branch ? 'reply' : 'question', m.from_branch ? 'branch' : 'hq', who(m.user_id),
      { item: m.item, branch: m.branch_code, type: m.is_oos ? 'Out of stock' : 'New item' },
      `${m.from_branch ? 'Branch wrote' : 'Inventory asked'}: ${m.body || ''}${m.photo_id ? ' 📷' : ''}`.trim(),
      m.is_oos ? `/oos/${m.oos_id}` : `/oos/new-items/${m.request_id}`);
  }
  events.sort((a, b2) => new Date(b2.at) - new Date(a.at));

  // Per inventory person that day: seen, questions, answers, sent, closed.
  const people = new Map();
  for (const e of events.filter((x) => x.side === 'hq' && x.by)) {
    const p = people.get(e.by) || { name: e.by, seen: 0, question: 0, answered: 0, sent: 0, done: 0 };
    if (p[e.kind] !== undefined) p[e.kind] += 1;
    people.set(e.by, p);
  }
  // Open items nobody in Inventory has opened yet (any day), oldest first.
  const at = now();
  const unseen = (await db.query(
    `SELECT x.id, x.item, x.reported_at, x.urgent, COALESCE(bb.code, 'B2B') AS branch_code FROM oos_items x LEFT JOIN branches bb ON bb.id = x.branch_id
     WHERE x.seen_at IS NULL AND x.answer IS NULL AND x.status = 'Open' ${b ? 'AND x.branch_id = $1' : ''} ORDER BY x.reported_at`, b ? [b.id] : [])).rows
    .map((x) => ({ ...x, hours: (at - new Date(x.reported_at)) / 3600e3 }));
  const unseenReq = (await db.query(
    `SELECT x.id, x.item, x.created_at, bb.code AS branch_code FROM item_requests x JOIN branches bb ON bb.id = x.branch_id
     WHERE x.seen_at IS NULL AND x.status = 'New' ${b ? 'AND x.branch_id = $1' : ''} ORDER BY x.created_at`, b ? [b.id] : [])).rows;
  return { events, people: [...people.values()], unseen, unseenReq, today: calc.todayInMalaysia(at) };
}

module.exports = { loadActivity };
