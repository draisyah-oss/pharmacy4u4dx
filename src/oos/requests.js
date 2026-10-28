// 27 Oct: new item requests – an item a customer wants that isn't listed in Dynamod yet. Kept apart
// from out-of-stock (it isn't a stock problem, and it doesn't count on the OOS scoreboard).
//   Branch: item, size / brand, customers asking, note, photo → status New.
//   Inventory (Alia, Syarafana, Fariz; admin): Need more info · Will list (and order) · Listed – the
//   branch can order it now · Not listing (with a reason). Questions and photos both ways (chat.js).

const { cleanText } = require('../weekly/access');
const chat = require('./chat');

const STATUSES = ['New', 'Need more info', 'Will list', 'Listed', 'Not listing'];
const OPEN = ['New', 'Need more info', 'Will list'];
const ANSWERS = {
  info: { status: 'Need more info', label: 'Need more info', hint: 'ask below what you need' },
  will: { status: 'Will list', label: 'Will list it', hint: 'we’ll add it to Dynamod and order' },
  listed: { status: 'Listed', label: 'Listed', hint: 'it’s in Dynamod – the branch can order' },
  no: { status: 'Not listing', label: 'Not listing', hint: 'say why in the note' },
};

const SELECT = `
  SELECT r.*, b.code AS branch_code, b.name AS branch_name, c.display_name AS asked_by_name, a.display_name AS answered_by_name,
    sn.display_name AS seen_by_name
  FROM item_requests r JOIN branches b ON b.id = r.branch_id
  LEFT JOIN users sn ON sn.id = r.seen_by
  LEFT JOIN users c ON c.id = r.created_by LEFT JOIN users a ON a.id = r.answered_by`;

async function create(db, user, branch, body, { now }) {
  const errors = {};
  const item = cleanText(body.item, { max: 120, label: 'Item' });
  if (item.error) errors.item = item.error; else if (!item.value) errors.item = 'Type the item.';
  const details = cleanText(body.details, { max: 160, label: 'Brand / size' });
  if (details.error) errors.details = details.error;
  const note = cleanText(body.note, { max: 300, label: 'Note' });
  if (note.error) errors.note = note.error;
  const asking = ({ 0: 0, 1: 1, '2-3': 3, '4+': 4 })[body.asking];
  const photo = chat.parsePhoto(body.photo);
  if (photo.error) errors.photo = photo.error;
  if (Object.keys(errors).length) return { errors };
  const at = now();
  return db.transaction(async (tx) => {
    const photoId = await chat.savePhoto(tx, user, branch.id, photo.value);
    const { rows } = await tx.query(
      `INSERT INTO item_requests (branch_id, item, details, customers_count, note, photo_id, created_by, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8) RETURNING id`,
      [branch.id, item.value, details.value, asking ?? null, note.value, photoId, user.id, at]);
    await tx.query(`INSERT INTO audit_log (user_id, action, table_name, record_key, new_value) VALUES ($1, 'insert', 'item_requests', $2, $3)`,
      [user.id, `${branch.code} new item #${rows[0].id}`, JSON.stringify({ item: item.value, details: details.value, photo: Boolean(photoId) })]);
    return { id: rows[0].id };
  });
}

async function load(db, id) {
  if (!/^\d{1,9}$/.test(String(id))) return null;
  const r = (await db.query(`${SELECT} WHERE r.id = $1`, [id])).rows[0];
  return r ? (await chat.attachThreads(db, [r], 'request'))[0] : null;
}

async function loadBranch(db, branch, { now }) {
  const rows = (await db.query(
    `${SELECT} WHERE r.branch_id = $1 AND (r.status = ANY($2) OR r.updated_at > $3::timestamptz - interval '30 days')
     ORDER BY (r.status = ANY($2)) DESC, r.created_at DESC`, [branch.id, OPEN, now()])).rows;
  return chat.attachThreads(db, rows, 'request');
}

async function loadInbox(db, { now }) {
  const open = (await db.query(`${SELECT} WHERE r.status = ANY($1) ORDER BY r.status = 'New' DESC, r.created_at`, [OPEN])).rows;
  const done = (await db.query(`${SELECT} WHERE NOT (r.status = ANY($1)) AND r.updated_at > $2::timestamptz - interval '30 days' ORDER BY r.updated_at DESC LIMIT 30`, [OPEN, now()])).rows;
  await chat.attachThreads(db, [...open, ...done], 'request');
  return { open, done, toAnswer: open.filter((r) => r.status === 'New' || r.awaitingHq).length };
}

async function answer(db, user, req, body, { now }) {
  const a = ANSWERS[String(body.answer || '')];
  if (!a) return { error: 'Pick an answer.' };
  const note = cleanText(body.answer_note, { max: 300, label: 'Note to the branch' });
  if (note.error) return { error: note.error };
  if (a.status === 'Not listing' && !note.value) return { error: 'Say why it won’t be listed – the branch tells the customer.' };
  const at = now();
  await db.transaction(async (tx) => {
    await tx.query(
      `UPDATE item_requests SET status = $2, answer_note = $3, answered_at = $4, answered_by = $5, updated_at = $4,
         seen_at = COALESCE(seen_at, CASE WHEN $6 THEN $4::timestamptz END), seen_by = COALESCE(seen_by, CASE WHEN $6 THEN $5::integer END) WHERE id = $1`,
      [req.id, a.status, note.value, at, user.id, Boolean(user.inventory)]);
    await tx.query(`INSERT INTO audit_log (user_id, action, table_name, record_key, old_value, new_value) VALUES ($1, 'update', 'item_requests', $2, $3, $4)`,
      [user.id, `${req.branch_code} new item #${req.id} answer`, JSON.stringify({ status: req.status }), JSON.stringify({ status: a.status, note: note.value })]);
  });
  return { ok: true };
}

const countNew = async (db) => (await db.query("SELECT count(*)::int AS n FROM item_requests WHERE status = 'New'")).rows[0].n;

module.exports = { STATUSES, OPEN, ANSWERS, create, load, loadBranch, loadInbox, answer, countNew };
