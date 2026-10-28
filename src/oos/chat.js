// 27 Oct: questions & photos on out-of-stock items and new item requests.
// Inventory asks the branch ("what item is this? send a photo"), the branch replies, both can add a
// photo. Photos are shrunk on the phone (public/js/photo.js) to a JPEG and sent as a data URL in a
// hidden form box; they're stored in `photos` and shown through /oos/photo/:id to people who can
// see that branch's items (the branch itself, the inventory team, HQ and admin).

const { cleanText } = require('../weekly/access');

const MAX_PHOTO = 1900000; // bytes after decoding
const SIGNATURES = {
  'image/jpeg': (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  'image/png': (b) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47,
  'image/webp': (b) => b.slice(0, 4).toString('ascii') === 'RIFF' && b.slice(8, 12).toString('ascii') === 'WEBP',
};

// A data URL from the form → { value: null } (no photo), { mime, data } or { error }.
function parsePhoto(text) {
  const s = String(text || '').trim();
  if (!s) return { value: null };
  const m = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=\s]+)$/.exec(s);
  if (!m) return { error: 'That photo couldn’t be read – take it again.' };
  const data = Buffer.from(m[2], 'base64');
  if (!data.length || data.length > MAX_PHOTO) return { error: 'That photo is too big – take it again.' };
  if (!SIGNATURES[m[1]](data)) return { error: 'That file isn’t a photo.' };
  return { value: { mime: m[1], data } };
}

async function savePhoto(tx, user, branchId, photo) {
  if (!photo) return null;
  return (await tx.query('INSERT INTO photos (mime, data, branch_id, created_by) VALUES ($1, $2, $3, $4) RETURNING id',
    [photo.mime, photo.data, branchId, user.id])).rows[0].id;
}

const isBranchUser = (user) => ['branch_staff', 'branch_manager'].includes(user.role);
// Who may see a branch's photos and conversation: that branch, the inventory team, HQ, admin.
const canSeeBranch = (user, branchId) => user.role === 'admin' || user.role === 'hq' || Boolean(user.inventory)
  || (isBranchUser(user) && user.branch_id === branchId);
// Who may write in it: that branch, the inventory team, admin.
const canTalk = (user, branchId) => user.role === 'admin' || Boolean(user.inventory)
  || (isBranchUser(user) && user.branch_id === branchId);

async function loadPhoto(db, id) {
  if (!/^\d{1,9}$/.test(String(id))) return null;
  return (await db.query('SELECT id, mime, data, branch_id FROM photos WHERE id = $1', [id])).rows[0] || null;
}

// Messages for a list of items (kind 'oos' or 'request'): sets it.messages, it.awaitingBranch
// (Inventory asked last – the branch should answer) and it.awaitingHq (the branch replied last).
async function attachThreads(db, items, kind) {
  if (!items.length) return items;
  const col = kind === 'oos' ? 'oos_id' : 'request_id';
  const rows = (await db.query(
    `SELECT m.*, u.display_name FROM oos_messages m LEFT JOIN users u ON u.id = m.user_id
     WHERE m.${col} = ANY($1) ORDER BY m.created_at, m.id`, [items.map((it) => it.id)])).rows;
  const by = new Map();
  for (const r of rows) { const k = r[col]; if (!by.has(k)) by.set(k, []); by.get(k).push(r); }
  for (const it of items) {
    it.messages = by.get(it.id) || [];
    const last = it.messages[it.messages.length - 1];
    it.awaitingBranch = Boolean(last && !last.from_branch);
    it.awaitingHq = Boolean(last && last.from_branch);
  }
  return items;
}

// target: { kind: 'oos' | 'request', id, branch_id, branch_code }
async function addMessage(db, user, target, body, { now }) {
  if (!canTalk(user, target.branch_id)) return { forbidden: true };
  const text = cleanText(body.message, { max: 500, label: 'Message' });
  if (text.error) return { error: text.error };
  const photo = parsePhoto(body.photo);
  if (photo.error) return { error: photo.error };
  if (!text.value && !photo.value) return { error: 'Type a message or add a photo.' };
  const at = now();
  await db.transaction(async (tx) => {
    const photoId = await savePhoto(tx, user, target.branch_id, photo.value);
    await tx.query(
      `INSERT INTO oos_messages (oos_id, request_id, user_id, from_branch, body, photo_id, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [target.kind === 'oos' ? target.id : null, target.kind === 'request' ? target.id : null, user.id, isBranchUser(user), text.value, photoId, at]);
    const table = target.kind === 'oos' ? 'oos_items' : 'item_requests';
    await tx.query(`UPDATE ${table} SET updated_at = $2 WHERE id = $1`, [target.id, at]);
    // Asking the branch counts as Inventory having seen it (28 Oct).
    if (user.inventory) await tx.query(`UPDATE ${table} SET seen_at = $2, seen_by = $3 WHERE id = $1 AND seen_at IS NULL`, [target.id, at, user.id]);
    await tx.query(
      `INSERT INTO audit_log (user_id, action, table_name, record_key, new_value) VALUES ($1, 'insert', 'oos_messages', $2, $3)`,
      [user.id, `${target.branch_code} ${target.kind === 'oos' ? '#' : 'new item #'}${target.id} message`, JSON.stringify({ text: text.value, photo: Boolean(photo.value) })]);
  });
  return { ok: true };
}

// For "Needs you": open items / requests where the other side spoke last.
async function waitingCounts(db, { branchId = null, forHq = false }) {
  const fromBranch = forHq;
  const where = branchId ? 'AND x.branch_id = $2' : '';
  const args = branchId ? [fromBranch, branchId] : [fromBranch];
  const q = (table, col, open) => db.query(
    `SELECT count(*)::int AS n FROM ${table} x WHERE ${open} ${where} AND (
       SELECT m.from_branch FROM oos_messages m WHERE m.${col} = x.id ORDER BY m.created_at DESC, m.id DESC LIMIT 1) = $1`, args);
  const oos = (await q('oos_items', 'oos_id', "x.status IN ('Open', 'Ordered', 'On the way', 'Substitute offered')")).rows[0].n;
  const req = (await q('item_requests', 'request_id', "x.status IN ('New', 'Need more info', 'Will list')")).rows[0].n;
  return { oos, req };
}

module.exports = { parsePhoto, savePhoto, loadPhoto, attachThreads, addMessage, canSeeBranch, canTalk, isBranchUser, waitingCounts };
