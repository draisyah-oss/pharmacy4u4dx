// 28 Oct: "Request a change" for the 4DX app.
//   1 Anyone logged in asks (what to change, why, which part, optional screenshot) → New.
//   2 Mr 4DX (Claude, through the agent API) or an admin plans it: Need more info / Planned / Not doing.
//   3 A preview is built → Ready to check (preview link). The person who asked taps "Looks right"
//     (→ Waiting for approval) or "Not right yet" with a note (→ Planned).
//   4 The CEO (super admin) Approves (→ Approved) or says Not doing. Nothing goes live without that.
//   5 Mr 4DX / admin marks it Live once deployed.
// Every step leaves a note in the thread and the audit log.

const { cleanText } = require('../weekly/access');
const chat = require('../oos/chat');

const STATUSES = ['New', 'Need more info', 'Planned', 'Ready to check', 'Waiting for approval', 'Approved', 'Live', 'Not doing'];
const OPEN = ['New', 'Need more info', 'Planned', 'Ready to check', 'Waiting for approval', 'Approved'];
const AREAS = ['Daily entry', 'Scoreboard / targets', 'Out of stock', 'Weekly update / WIG', 'HQ pages', 'Login / people', 'Other'];

const isAdmin = (u) => u.role === 'admin';
const isCeo = (u) => u.role === 'admin' && Boolean(u.is_super);

const SELECT = `
  SELECT r.*, u.display_name AS asked_by_name, a.display_name AS approved_by_name,
    COALESCE(b.code, CASE WHEN u.role IN ('hq', 'hq_staff', 'admin') THEN 'HQ' END) AS asked_from
  FROM change_requests r LEFT JOIN users u ON u.id = r.created_by LEFT JOIN users a ON a.id = r.approved_by
  LEFT JOIN branches b ON b.id = u.branch_id`;

async function note(tx, requestId, user, body, author = null) {
  await tx.query('INSERT INTO change_request_notes (request_id, user_id, author, body, created_at) VALUES ($1, $2, $3, $4, $5)',
    [requestId, user ? user.id : null, author, body, new Date()]);
}
async function audit(tx, user, key, oldV, newV) {
  await tx.query(`INSERT INTO audit_log (user_id, action, table_name, record_key, old_value, new_value) VALUES ($1, 'update', 'change_requests', $2, $3, $4)`,
    [user ? user.id : null, key, oldV == null ? null : JSON.stringify(oldV), newV == null ? null : JSON.stringify(newV)]);
}

async function create(db, user, body, { now, source = 'app' } = {}) {
  const errors = {};
  const title = cleanText(body.title, { max: 140, label: 'What to change' });
  if (title.error) errors.title = title.error; else if (!title.value) errors.title = 'Say what you want changed.';
  const details = cleanText(body.details, { max: 1500, label: 'Details' });
  if (details.error) errors.details = details.error;
  const area = AREAS.includes(body.area) ? body.area : 'Other';
  const photo = chat.parsePhoto(body.photo);
  if (photo.error) errors.photo = photo.error;
  if (Object.keys(errors).length) return { errors };
  const at = now();
  return db.transaction(async (tx) => {
    const photoId = await chat.savePhoto(tx, user, user.branch_id || null, photo.value);
    const { rows } = await tx.query(
      `INSERT INTO change_requests (title, details, area, photo_id, source, created_by, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $7) RETURNING id`, [title.value, details.value, area, photoId, source, user.id, at]);
    await audit(tx, user, `#${rows[0].id} new`, null, { title: title.value, area });
    return { id: rows[0].id };
  });
}

async function load(db, id) {
  if (!/^\d{1,9}$/.test(String(id))) return null;
  const r = (await db.query(`${SELECT} WHERE r.id = $1`, [id])).rows[0];
  if (!r) return null;
  r.notes = (await db.query(
    `SELECT n.*, COALESCE(n.author, u.display_name) AS who FROM change_request_notes n LEFT JOIN users u ON u.id = n.user_id
     WHERE n.request_id = $1 ORDER BY n.created_at, n.id`, [id])).rows;
  return r;
}

async function list(db) {
  const rows = (await db.query(`${SELECT} ORDER BY (r.status = ANY($1)) DESC, array_position($2::text[], r.status), r.created_at DESC LIMIT 200`, [OPEN, STATUSES])).rows;
  return { open: rows.filter((r) => OPEN.includes(r.status)), done: rows.filter((r) => !OPEN.includes(r.status)) };
}

// Who may do what on a request (UI buttons and server checks use the same rules).
function actionsFor(user, r) {
  const mine = r.created_by === user.id;
  return {
    comment: true,
    manage: isAdmin(user), // status, plan, preview link
    check: (mine || isAdmin(user)) && r.status === 'Ready to check',
    approve: isCeo(user) && ['Waiting for approval', 'Ready to check', 'Planned'].includes(r.status),
    reject: isCeo(user) && OPEN.includes(r.status),
  };
}

async function addNote(db, user, r, body, author = null) {
  const text = cleanText(body, { max: 1500, label: 'Message' });
  if (text.error) return { error: text.error };
  if (!text.value) return { error: 'Type a message.' };
  await db.transaction(async (tx) => {
    await note(tx, r.id, user, text.value, author);
    await tx.query('UPDATE change_requests SET updated_at = now() WHERE id = $1', [r.id]);
  });
  return { ok: true };
}

// Change the status (and optionally the plan / preview link), with a note saying what happened.
async function setStatus(db, user, r, { status, plan, preview_url: previewUrl, message }, { now, author = null } = {}) {
  if (!STATUSES.includes(status)) return { error: 'Unknown status.' };
  const p = plan === undefined ? { value: r.plan } : cleanText(plan, { max: 3000, label: 'Plan' });
  if (p.error) return { error: p.error };
  let url = previewUrl === undefined ? r.preview_url : String(previewUrl || '').trim() || null;
  if (url && !/^https:\/\/[^\s"'<>]+$/.test(url)) return { error: 'The preview link must start with https://.' };
  const m = cleanText(message, { max: 1500, label: 'Message' });
  if (m.error) return { error: m.error };
  const at = now();
  await db.transaction(async (tx) => {
    await tx.query(
      `UPDATE change_requests SET status = $2, plan = $3, preview_url = $4, updated_at = $5,
         approved_at = CASE WHEN $2 = 'Approved' THEN $5 ELSE approved_at END,
         approved_by = CASE WHEN $2 = 'Approved' THEN $6::integer ELSE approved_by END,
         live_at = CASE WHEN $2 = 'Live' THEN $5 ELSE live_at END
       WHERE id = $1`, [r.id, status, p.value, url, at, user ? user.id : null]);
    const who = author || (user ? user.display_name : 'Someone');
    await note(tx, r.id, user, `${status === r.status ? 'Updated' : `${r.status} → ${status}`}${m.value ? ` – ${m.value}` : ''}`, author);
    await audit(tx, user, `#${r.id} ${author ? 'agent ' : ''}status`, { status: r.status }, { status, by: who });
  });
  return { ok: true };
}

// CEO decisions and the requester's check, with the rules above.
async function act(db, user, r, action, message, { now }) {
  const can = actionsFor(user, r);
  if (action === 'looks_right' && can.check) return setStatus(db, user, r, { status: 'Waiting for approval', message: message || 'Checked the preview – looks right.' }, { now });
  if (action === 'not_right' && can.check) {
    if (!String(message || '').trim()) return { error: 'Say what isn’t right yet.' };
    return setStatus(db, user, r, { status: 'Planned', message }, { now });
  }
  if (action === 'approve' && can.approve) return setStatus(db, user, r, { status: 'Approved', message: message || 'Approved – go live.' }, { now });
  if (action === 'reject' && can.reject) return setStatus(db, user, r, { status: 'Not doing', message: message || 'Not doing this.' }, { now });
  return { forbidden: true };
}

const counts = async (db) => (await db.query(
  `SELECT count(*) FILTER (WHERE status = 'New')::int AS fresh, count(*) FILTER (WHERE status = 'Waiting for approval')::int AS approval,
     count(*) FILTER (WHERE status = 'Ready to check')::int AS check FROM change_requests`)).rows[0];

module.exports = { STATUSES, OPEN, AREAS, create, load, list, actionsFor, addNote, setStatus, act, counts, isCeo };
