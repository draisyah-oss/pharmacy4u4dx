// Out-of-stock flow (16 Oct): report → answer → transfer/order → back in stock.
//
//  1. Branch staff or the manager report an item any time (how many left, customers asking,
//     urgent for a chronic patient). It lands in Inventory's inbox at once.
//  2. Inventory (HQ: Alia; admin too) answers by 11 am the next working day with one of four
//     answers: transfer from another branch, order from the supplier, offer a substitute,
//     discontinue – with a quantity and the date it should arrive.
//  3. A transfer becomes a job for Fariz (HQ staff): picked → sent, within 24 hours.
//  4. The branch sees the answer on Daily entry and taps "Received – back in stock".
// 25 Oct (second round): a fifth answer, **HQ delivers** (from the HQ warehouse) – the usual one, so
// it comes first; like a transfer it goes picked → sent, and the branch sees each step (answered →
// picked → on the way → received) and taps "Accept – received". Inventory can also close any open
// item itself ("Done – delivered") when it was fulfilled outside these steps (closed_by_hq).
// Targets come from app_settings 'oos_targets' (seed.json company.oos_targets).

const calc = require('../calc');
const { cleanText } = require('../weekly/access');
const { readSeed } = require('../db/seed');
const { isRealDate } = require('../lib/dates');
const chat = require('./chat');

const OPEN = ['Open', 'Ordered', 'On the way', 'Substitute offered'];
const ANSWERS = {
  hq_deliver: { status: 'On the way', label: 'HQ delivers' },
  transfer: { status: 'On the way', label: 'Transfer from a branch' },
  order: { status: 'Ordered', label: 'Order from the supplier' },
  substitute: { status: 'Substitute offered', label: 'Offer a substitute' },
  // 30 Oct: "we don't stock this brand – offer X instead": saved as a substitute answer and closed at
  // once, so it doesn't sit open (and LATE) in the branch's list.
  not_stocked: { status: 'Discontinued / use substitute', label: 'Not stocked – offer substitute' },
  discontinue: { status: 'Discontinued', label: 'Discontinue' },
};

// Answers that are a delivery job for the inventory team (picked → sent → branch accepts).
const DELIVERS = ['hq_deliver', 'transfer'];
const isDelivery = (it) => DELIVERS.includes(it.answer);

const canReport = (user, branch) => user.role === 'admin'
  || (['branch_staff', 'branch_manager'].includes(user.role) && user.branch_id === branch.id);
// 19 Oct: the out-of-stock inbox and transfers are for the inventory team only (app_settings inventory_team:
// Alia, Syarafana, Fariz) and admin – req.user.inventory is set in src/app.js.
const canAnswer = (user) => user.role === 'admin' || Boolean(user.inventory);
const canSend = (user) => user.role === 'admin' || Boolean(user.inventory);
const canSeeBoard = (user) => ['hq', 'hq_staff', 'admin', 'branch_manager'].includes(user.role);

async function targets(db) {
  const row = (await db.query("SELECT value FROM app_settings WHERE key = 'oos_targets'")).rows[0];
  if (row) { try { return JSON.parse(row.value); } catch { /* fall through */ } }
  return readSeed().company.oos_targets;
}

// Malaysia wall-clock helpers (UTC+8, no daylight saving).
const MYT = 8 * 3600 * 1000;
const mytDate = (d) => calc.todayInMalaysia(d);
const atMyt = (date, hour) => new Date(Date.parse(`${date}T00:00:00Z`) + hour * 3600 * 1000 - MYT);

// 11 am on the next working day (Mon–Fri) after the report.
function answerDueFor(reportedAt, hour) {
  let d = calc.addDays(mytDate(reportedAt), 1);
  while (calc.isWeekend(d)) d = calc.addDays(d, 1);
  return atMyt(d, hour);
}

function int(v, { min = 0, max = 100000 } = {}) {
  const s = String(v ?? '').trim();
  if (!s) return { value: null };
  if (!/^\d+$/.test(s)) return { error: 'Type a whole number.' };
  const n = Number(s);
  if (n < min || n > max) return { error: `Between ${min} and ${max}.` };
  return { value: n };
}

async function audit(tx, user, action, key, oldV, newV) {
  await tx.query(
    `INSERT INTO audit_log (user_id, action, table_name, record_key, old_value, new_value) VALUES ($1, $2, 'oos_items', $3, $4, $5)`,
    [user ? user.id : null, action, key, oldV == null ? null : JSON.stringify(oldV), newV == null ? null : JSON.stringify(newV)]);
}

// ─────────────── 1. Report ───────────────

async function report(db, user, branch, body, { now }) {
  const errors = {};
  const item = cleanText(body.item, { max: 120, label: 'Item' });
  if (item.error) errors.item = item.error; else if (!item.value) errors.item = 'Type the item.';
  let left = { value: null };
  if (body.left === 'none') left = { value: 0 };
  else if (body.left === 'low') { left = int(body.left_qty, { min: 1, max: 999 }); if (left.value === null && !left.error) left = { error: 'How many are left?' }; }
  else errors.left = 'Pick none or low.';
  if (left.error) errors.left = left.error;
  const asking = ({ 0: 0, '1-2': 2, '3+': 3 })[body.asking];
  const note = cleanText(body.note, { max: 200, label: 'Note' });
  if (note.error) errors.note = note.error;
  const photo = chat.parsePhoto(body.photo);
  if (photo.error) errors.photo = photo.error;
  if (Object.keys(errors).length) return { errors };

  const t = await targets(db);
  const at = now();
  const today = mytDate(at);
  return db.transaction(async (tx) => {
    const photoId = await chat.savePhoto(tx, user, branch.id, photo.value);
    const { rows } = await tx.query(
      `INSERT INTO oos_items (branch_id, week_start, item, out_of_stock_since, customers_asking, created_by, updated_by,
         reported_at, left_qty, customers_count, urgent, note, answer_due, updated_at, photo_id)
       VALUES ($1, $2, $3, $4, $5, $6, $6, $7, $8, $9, $10, $11, $12, $7, $13) RETURNING id`,
      [branch.id, calc.weekStart(today), item.value, today, asking ? `${body.asking} customers asking` : null, user.id,
        at, left.value, asking ?? null, body.urgent === 'on' || body.urgent === '1', note.value, answerDueFor(at, t.answer_by_hour), photoId]);
    await audit(tx, user, 'insert', `${branch.code} #${rows[0].id}`, null,
      { item: item.value, left: left.value, customers: asking ?? null, urgent: body.urgent === 'on' || body.urgent === '1' });
    return { id: rows[0].id };
  });
}

// 28 Oct: a B2B out-of-stock item, added by the inventory team (no branch; the customer's name).
async function reportB2b(db, user, body, { now }) {
  const item = cleanText(body.item, { max: 120, label: 'Item' });
  if (item.error) return { error: item.error };
  if (!item.value) return { error: 'Type the item.' };
  const customer = cleanText(body.customer, { max: 80, label: 'Customer' });
  if (customer.error) return { error: customer.error };
  if (!customer.value) return { error: 'Type the B2B customer.' };
  const note = cleanText(body.note, { max: 200, label: 'Note' });
  if (note.error) return { error: note.error };
  const t = await targets(db);
  const at = now(); const today = mytDate(at);
  return db.transaction(async (tx) => {
    const { rows } = await tx.query(
      `INSERT INTO oos_items (branch_id, b2b_customer, week_start, item, out_of_stock_since, created_by, updated_by,
         reported_at, urgent, note, answer_due, updated_at, seen_at, seen_by)
       VALUES (NULL, $1, $2, $3, $4, $5, $5, $6, $7, $8, $9, $6, $6, $5) RETURNING id`,
      [customer.value, calc.weekStart(today), item.value, today, user.id, at, body.urgent === 'on' || body.urgent === '1', note.value, answerDueFor(at, t.answer_by_hour)]);
    await audit(tx, user, 'insert', `B2B #${rows[0].id}`, null, { item: item.value, customer: customer.value });
    return { id: rows[0].id };
  });
}

// ─────────────── Loading ───────────────

const SELECT = `
  SELECT o.*, COALESCE(b.code, 'B2B') AS branch_code, COALESCE(b.name, 'B2B – ' || o.b2b_customer) AS branch_name, fb.code AS from_code, fb.name AS from_name,
    c.display_name AS reported_by_name, a.display_name AS answered_by_name, s.display_name AS sent_by_name,
    sn.display_name AS seen_by_name, cx.display_name AS cancelled_by_name
  FROM oos_items o LEFT JOIN branches b ON b.id = o.branch_id
  LEFT JOIN users sn ON sn.id = o.seen_by
  LEFT JOIN users cx ON cx.id = o.cancelled_by
  LEFT JOIN branches fb ON fb.id = o.from_branch_id
  LEFT JOIN users c ON c.id = o.created_by LEFT JOIN users a ON a.id = o.answered_by LEFT JOIN users s ON s.id = o.sent_by`;

// 28 Oct: the first time someone in the inventory team opens (or answers / asks about / closes) an
// item, it's stamped "seen" – the branch and the CEO see it was picked up, and when.
async function markSeen(db, user, table, id, at) {
  if (!user || !user.inventory || !['oos_items', 'item_requests'].includes(table)) return false;
  const r = await db.query(`UPDATE ${table} SET seen_at = $2, seen_by = $3 WHERE id = $1 AND seen_at IS NULL RETURNING id`, [id, at, user.id]);
  return r.rows.length > 0;
}

async function loadItem(db, id) {
  if (!/^\d{1,9}$/.test(String(id))) return null;
  const it = (await db.query(`${SELECT} WHERE o.id = $1`, [id])).rows[0] || null;
  return it ? (await chat.attachThreads(db, [it], 'oos'))[0] : null;
}

// How many times the same item (same name, same branch) ran out in the 30 days before.
async function repeats(db, items, at) {
  if (!items.length) return;
  const { rows } = await db.query(
    `SELECT branch_id, lower(item) AS k, count(*)::int AS n FROM oos_items
     WHERE reported_at > $1::timestamptz - interval '30 days' AND reported_at <= $1 GROUP BY 1, 2`, [at]);
  const by = new Map(rows.map((r) => [`${r.branch_id}|${r.k}`, r.n]));
  for (const it of items) it.timesThisMonth = by.get(`${it.branch_id}|${it.item.toLowerCase()}`) || 1;
}

function decorate(it, at, today) {
  it.isOpen = OPEN.includes(it.status);
  it.unanswered = it.isOpen && !it.answer && it.status === 'Open';
  it.dueMs = it.answer_due ? new Date(it.answer_due).getTime() - at.getTime() : null;
  it.overdueAnswer = it.unanswered && it.dueMs !== null && it.dueMs < 0;
  // A substitute's date is when the original might be back – the branch can already offer the
  // substitute, so it's never shown as LATE (30 Oct, Ampang's Clarityne).
  it.late = it.isOpen && it.answer !== 'substitute' && it.expected_back && it.expected_back < today;
  return it;
}

// Inbox for Inventory: to answer (urgent first, then the oldest), waiting for stock, done lately.
async function loadInbox(db, { now }) {
  const at = now(); const today = mytDate(at);
  const open = (await db.query(`${SELECT} WHERE o.status = ANY($1) ORDER BY o.urgent DESC, o.reported_at`, [OPEN])).rows;
  const done = (await db.query(`${SELECT} WHERE NOT (o.status = ANY($1)) AND o.updated_at > $2::timestamptz - interval '14 days' ORDER BY o.updated_at DESC LIMIT 30`, [OPEN, at])).rows;
  await repeats(db, [...open, ...done], at);
  [...open, ...done].forEach((it) => decorate(it, at, today));
  await chat.attachThreads(db, [...open, ...done], 'oos');
  const toAnswer = open.filter((it) => it.unanswered);
  const waiting = open.filter((it) => !it.unanswered)
    .sort((a, b) => Number(b.late || Boolean(b.late_flagged_at)) - Number(a.late || Boolean(a.late_flagged_at)) || String(a.expected_back || '').localeCompare(String(b.expected_back || '')));
  return { toAnswer, waiting, done, replies: open.filter((it) => it.awaitingHq).length, overdue: open.filter((it) => it.overdueAnswer || it.late).length };
}

async function countToAnswer(db) {
  return (await db.query("SELECT count(*)::int AS n FROM oos_items WHERE status = 'Open' AND answer IS NULL")).rows[0].n;
}

// A branch's items: open ones, plus anything closed in the last 7 days.
async function loadBranchItems(db, branch, { now }) {
  const at = now(); const today = mytDate(at);
  const rows = (await db.query(
    `${SELECT} WHERE o.branch_id = $1 AND (o.status = ANY($2) OR o.updated_at > $3::timestamptz - interval '7 days')
     ORDER BY (o.status = ANY($2)) DESC, o.reported_at DESC`, [branch.id, OPEN, at])).rows;
  await chat.attachThreads(db, rows, 'oos');
  return rows.map((it) => decorate(it, at, today));
}

async function loadTransfers(db, { now }) {
  const at = now(); const today = mytDate(at); const t = await targets(db);
  const rows = (await db.query(
    `${SELECT} WHERE o.answer = ANY($1) AND o.status = 'On the way'
     ORDER BY o.sent_at NULLS FIRST, o.urgent DESC, o.answered_at`, [DELIVERS])).rows;
  for (const it of rows) {
    decorate(it, at, today);
    it.sendBy = new Date(new Date(it.answered_at).getTime() + t.transfer_hours * 3600 * 1000);
    it.sendMs = it.sendBy.getTime() - at.getTime();
  }
  return { toSend: rows.filter((r) => !r.sent_at), sent: rows.filter((r) => r.sent_at), hours: t.transfer_hours };
}

// ─────────────── 2. Answer ───────────────

async function answerItem(db, user, item, body, { now }) {
  const at = now();
  // 28 Oct: "From" can be HQ (= HQ delivers) or the branch's own stock (e.g. the store room).
  const kind = String(body.answer || '') === 'transfer' && String(body.from || '') === 'HQ' ? 'hq_deliver' : String(body.answer || '');
  if (!ANSWERS[kind]) return { error: 'Pick one of the answers.' };
  if (!OPEN.includes(item.status)) return { error: 'This item is already closed.' };
  const today = mytDate(now());
  const next = { answer: kind === 'not_stocked' ? 'substitute' : kind, status: ANSWERS[kind].status, answer_qty: null, from_branch_id: null, substitute: null, expected_back: null };
  if (DELIVERS.includes(kind) || kind === 'order') {
    const q = int(body.qty, { min: 1, max: 9999 });
    if (q.error || q.value === null) return { error: q.error || 'How many?' };
    next.answer_qty = q.value;
    const by = String(body.expected_back || '').trim();
    if (!isRealDate(by)) return { error: 'Pick the date it should arrive.' };
    if (by < today) return { error: 'The arrival date is in the past.' };
    next.expected_back = by;
  }
  if (kind === 'transfer') {
    const from = (await db.query('SELECT id FROM branches WHERE code = $1 AND active', [String(body.from || '')])).rows[0];
    if (!from) return { error: 'Pick the branch it comes from.' };
    next.from_branch_id = from.id;
  }
  if (kind === 'substitute' || kind === 'not_stocked') {
    const sub = cleanText(body.substitute, { max: 160, label: 'Substitute' });
    if (sub.error) return { error: sub.error };
    if (!sub.value) return { error: 'Type what the branch should offer instead.' };
    next.substitute = sub.value;
    const by = String(body.expected_back || '').trim();
    if (by && kind === 'substitute') { if (!isRealDate(by) || by < today) return { error: 'Pick a real date from today on.' }; next.expected_back = by; }
  }
  const note = cleanText(body.reason, { max: 300, label: 'Note to the branch' });
  if (note.error) return { error: note.error };
  next.reason_for_delay = note.value;
  await markSeen(db, user, 'oos_items', item.id, at);
  await db.transaction(async (tx) => {
    const cols = Object.keys(next);
    await tx.query(
      `UPDATE oos_items SET ${cols.map((c, i) => `${c} = $${i + 2}`).join(', ')},
         answered_at = COALESCE(answered_at, $${cols.length + 4}), answered_by = $${cols.length + 2}, updated_by = $${cols.length + 2},
         picked_at = CASE WHEN $${cols.length + 3} THEN picked_at END, sent_at = CASE WHEN $${cols.length + 3} THEN sent_at END,
         late_flagged_at = NULL, updated_at = $${cols.length + 4}
       WHERE id = $1`,
      [item.id, ...cols.map((c) => next[c]), user.id, DELIVERS.includes(kind) && item.answer === kind, at]);
    await audit(tx, user, 'update', `${item.branch_code} #${item.id} answer`,
      item.answer ? { answer: item.answer, status: item.status } : null, next);
  });
  return { ok: true };
}

// 28 Oct: answer many items at once from the inbox table (like Alia's OOS spreadsheet).
// body.r = { i<id>: { answer, qty, from, by, note } }. answer '' = leave the row alone; 'done' =
// Done – delivered. For a substitute the note is what to offer; otherwise it's the note to the branch.
// Rows that haven't changed are skipped; each changed row is saved on its own (same checks as the
// item page) and rows with a problem come back with their message, the rest are saved.
async function saveTable(db, user, body, { now }) {
  const rows = body && typeof body.r === 'object' && body.r ? body.r : {};
  const errors = {}; let saved = 0;
  for (const [key, row] of Object.entries(rows)) {
    const id = /^i(\d{1,9})$/.exec(key); if (!id || !row || typeof row !== 'object') continue;
    const answer = String(row.answer || '');
    if (!answer) continue;
    const item = (await db.query(`${SELECT} WHERE o.id = $1`, [id[1]])).rows[0];
    if (!item || !OPEN.includes(item.status)) continue;
    if (answer === 'done') { await markDone(db, user, item, { now }); saved++; continue; }
    if (answer === 'clarify') {
      // 28 Oct: ask the branch to clarify – the note goes to the item's conversation; the person who
      // reported it gets it in Needs you and on Daily entry. The answer itself doesn't change.
      const q = String(row.note ?? '').trim();
      if (!q) { errors[item.id] = 'Type your question for the branch in the note box.'; continue; }
      const r = await chat.addMessage(db, user, { kind: 'oos', id: item.id, branch_id: item.branch_id, branch_code: item.branch_code }, { message: q }, { now });
      if (r.error || r.forbidden) errors[item.id] = r.error || 'Not allowed.'; else saved++;
      continue;
    }
    const qty = String(row.qty ?? '').trim(); const from = String(row.from ?? ''); const by = String(row.by ?? '').trim();
    const note = String(row.note ?? '').replace(/\s+/g, ' ').trim();
    const curNote = item.answer === 'substitute' ? (item.substitute || '') : (item.reason_for_delay || '');
    const same = item.answer === answer && String(item.answer_qty ?? '') === qty && (answer !== 'transfer' || (item.from_code || '') === from)
      && (item.expected_back || '') === by && curNote === note;
    if (same) continue;
    const r = await answerItem(db, user, item, {
      answer, qty, from, expected_back: by,
      substitute: ['substitute', 'not_stocked'].includes(answer) ? note : '', reason: ['substitute', 'not_stocked'].includes(answer) ? '' : note,
    }, { now });
    if (r.error) errors[item.id] = r.error; else saved++;
  }
  return { saved, errors };
}

// ─────────────── 3. Transfers (Fariz) ───────────────

async function markTransfer(db, user, item, step, { now }) {
  const at = now();
  if (!isDelivery(item)) return { error: 'That item isn’t a delivery or transfer.' };
  if (!OPEN.includes(item.status)) return { error: 'That item is already closed.' };
  if (step === 'picked' && !item.picked_at) {
    await db.transaction(async (tx) => {
      await tx.query('UPDATE oos_items SET picked_at = $3, updated_by = $2, updated_at = $3 WHERE id = $1', [item.id, user.id, at]);
      await audit(tx, user, 'update', `${item.branch_code} #${item.id} picked`, null, true);
    });
  } else if (step === 'sent' && !item.sent_at) {
    await db.transaction(async (tx) => {
      await tx.query('UPDATE oos_items SET sent_at = $3, picked_at = COALESCE(picked_at, $3), sent_by = $2, updated_by = $2, updated_at = $3 WHERE id = $1', [item.id, user.id, at]);
      await audit(tx, user, 'update', `${item.branch_code} #${item.id} sent`, null, true);
    });
  }
  return { ok: true };
}

// ─────────────── 4. Branch closes it ───────────────

async function markReceived(db, user, item, { now }) {
  const at = now();
  if (!OPEN.includes(item.status)) return { ok: true };
  await db.transaction(async (tx) => {
    await tx.query(
      "UPDATE oos_items SET status = 'Back in stock', received_at = $3, received_by = $2, updated_by = $2, updated_at = $3 WHERE id = $1",
      [item.id, user.id, at]);
    await audit(tx, user, 'update', `${item.branch_code} #${item.id} received`, item.status, 'Back in stock');
  });
  return { ok: true };
}

// Inventory closes an item itself: it was delivered / fulfilled (e.g. Alia sent it with the van and
// the branch hasn't tapped Accept yet). An item never answered counts as "HQ delivers", answered now.
async function markDone(db, user, item, { now }) {
  const at = now();
  if (!OPEN.includes(item.status)) return { ok: true, already: true };
  await markSeen(db, user, 'oos_items', item.id, at);
  // 30 Oct: a substitute item that Inventory closes is "use the substitute", not "back in stock".
  if (item.answer === 'substitute') {
    await db.transaction(async (tx) => {
      await tx.query(`UPDATE oos_items SET status = 'Discontinued / use substitute', closed_by_hq = true, expected_back = NULL,
         updated_by = $2, updated_at = $3 WHERE id = $1`, [item.id, user.id, at]);
      await audit(tx, user, 'update', `${item.branch_code} #${item.id} done by inventory`, item.status, 'Discontinued / use substitute');
    });
    return { ok: true };
  }
  await db.transaction(async (tx) => {
    await tx.query(
      `UPDATE oos_items SET status = 'Back in stock', closed_by_hq = true, received_at = $3, received_by = $2,
         answer = COALESCE(answer, 'hq_deliver'), answered_at = COALESCE(answered_at, $3), answered_by = COALESCE(answered_by, $2),
         sent_at = CASE WHEN COALESCE(answer, 'hq_deliver') = ANY($4) THEN COALESCE(sent_at, $3) ELSE sent_at END,
         sent_by = CASE WHEN COALESCE(answer, 'hq_deliver') = ANY($4) THEN COALESCE(sent_by, $2) ELSE sent_by END,
         updated_by = $2, updated_at = $3 WHERE id = $1`,
      [item.id, user.id, at, DELIVERS]);
    await audit(tx, user, 'update', `${item.branch_code} #${item.id} done by inventory`, item.status, 'Back in stock');
  });
  return { ok: true };
}

// 30 Oct: cancel a report – the branch (or Inventory) says it isn't needed any more. Closed, never
// counted as back in stock; the reason (optional) shows to both sides and goes to the audit log.
async function cancelItem(db, user, item, body, { now }) {
  const at = now();
  if (!OPEN.includes(item.status)) return { ok: true, already: true };
  const reason = cleanText(body && body.reason, { max: 200, label: 'Reason' });
  if (reason.error) return { error: reason.error };
  await db.transaction(async (tx) => {
    await tx.query(`UPDATE oos_items SET status = 'Cancelled', cancelled_at = $3, cancelled_by = $2, cancel_reason = $4,
       updated_by = $2, updated_at = $3 WHERE id = $1`, [item.id, user.id, at, reason.value]);
    await audit(tx, user, 'update', `${item.branch_code} #${item.id} cancelled`, item.status, { status: 'Cancelled', reason: reason.value });
  });
  return { ok: true };
}

async function flagLate(db, user, item, { now }) {
  const at = now();
  await db.transaction(async (tx) => {
    await tx.query('UPDATE oos_items SET late_flagged_at = $3, updated_by = $2, updated_at = $3 WHERE id = $1', [item.id, user.id, at]);
    await audit(tx, user, 'update', `${item.branch_code} #${item.id} late`, null, true);
  });
  return { ok: true };
}

// ─────────────── Scoreboard ───────────────

// For a week (Mon–Sun, Malaysia time): answered on time, transfers sent on time, days to back in
// stock, open now, per branch, and items that ran out more than once in 30 days.
async function buildBoard(db, { week, now }) {
  const at = now(); const today = mytDate(at); const t = await targets(db);
  const from = atMyt(week, 0); const to = atMyt(calc.addDays(week, 7), 0);
  const all = (await db.query(`${SELECT} WHERE o.answer_due IS NOT NULL`)).rows;
  const inWeek = (ts) => ts && new Date(ts) >= from && new Date(ts) < to;

  // Answered on time: reports whose deadline fell in this week and has passed (or was answered).
  const dueHere = all.filter((it) => inWeek(it.answer_due) && (it.answered_at || new Date(it.answer_due) <= at));
  const answeredOnTime = dueHere.filter((it) => it.answered_at && new Date(it.answered_at) <= new Date(it.answer_due)).length;
  // Transfers sent on time: transfers answered this week whose 24 h has passed (or were sent).
  const xfers = all.filter((it) => isDelivery(it) && inWeek(it.answered_at));
  const xferDue = xfers.filter((it) => it.sent_at || new Date(it.answered_at).getTime() + t.transfer_hours * 3600e3 <= at.getTime());
  const xferOnTime = xferDue.filter((it) => it.sent_at && new Date(it.sent_at).getTime() <= new Date(it.answered_at).getTime() + t.transfer_hours * 3600e3).length;
  // Days to back in stock: items received this week.
  const back = all.filter((it) => inWeek(it.received_at));
  const days = (it) => (new Date(it.received_at) - new Date(it.reported_at)) / 86400e3;
  const avg = (xs) => (xs.length ? xs.reduce((a, it) => a + days(it), 0) / xs.length : null);
  const open = all.filter((it) => OPEN.includes(it.status)).map((it) => decorate(it, at, today));

  const branches = (await db.query('SELECT id, code, name FROM branches WHERE active ORDER BY sort_order')).rows.map((b) => {
    const mine = (xs) => xs.filter((it) => it.branch_id === b.id);
    return {
      ...b,
      reported: mine(all.filter((it) => inWeek(it.reported_at))).length,
      open: mine(open).length,
      avgDays: avg(mine(back)),
      customers: mine(all.filter((it) => inWeek(it.reported_at))).reduce((a, it) => a + (it.customers_count || 0), 0),
    };
  });
  const rep = (await db.query(
    `SELECT b.code, min(o.item) AS item, count(*)::int AS n FROM oos_items o JOIN branches b ON b.id = o.branch_id
     WHERE o.reported_at > $1::timestamptz - interval '30 days' AND o.reported_at < $1::timestamptz
     GROUP BY b.code, lower(o.item) HAVING count(*) > 1 ORDER BY 3 DESC, 2`, [to])).rows;
  const repeatsByItem = new Map();
  for (const r of rep) {
    const k = r.item.toLowerCase();
    const e = repeatsByItem.get(k) || { item: r.item, n: 0, branches: [] };
    e.n += r.n; e.branches.push(r.code); repeatsByItem.set(k, e);
  }
  const ratio = (n, d) => (d ? n / d : null);
  return {
    targets: t,
    answered: { done: answeredOnTime, total: dueHere.length, pct: ratio(answeredOnTime, dueHere.length) },
    transfers: { done: xferOnTime, total: xferDue.length, pct: ratio(xferOnTime, xferDue.length) },
    restock: {
      all: avg(back), count: back.length,
      transfer: avg(back.filter((it) => isDelivery(it))), order: avg(back.filter((it) => it.answer === 'order')),
    },
    open: { total: open.length, toAnswer: open.filter((it) => it.unanswered).length, late: open.filter((it) => it.late || it.overdueAnswer).length },
    branches,
    repeats: [...repeatsByItem.values()].sort((a, b) => b.n - a.n).slice(0, 10),
  };
}

// One branch's out-of-stock week for the manager's weekly update (18 Oct) – summed from the
// daily reports, so nobody types an OOS list on Monday: reported that week, back in stock that
// week (and the average days it took), still open now, and which open ones are late.
async function branchWeekSummary(db, { branchId, week, now }) {
  const at = now(); const today = mytDate(at);
  const from = atMyt(week, 0); const to = atMyt(calc.addDays(week, 7), 0);
  const rows = (await db.query(
    `${SELECT} WHERE o.branch_id = $1 AND (o.status = ANY($2) OR (o.reported_at >= $3 AND o.reported_at < $4) OR (o.received_at >= $3 AND o.received_at < $4))
     ORDER BY o.reported_at`, [branchId, OPEN, from, to])).rows.map((it) => decorate(it, at, today));
  const inWeek = (ts) => ts && new Date(ts) >= from && new Date(ts) < to;
  const back = rows.filter((it) => inWeek(it.received_at));
  const days = back.map((it) => (new Date(it.received_at) - new Date(it.reported_at || it.received_at)) / 86400e3);
  const open = rows.filter((it) => it.isOpen);
  const late = open.filter((it) => it.late || it.overdueAnswer || it.late_flagged_at);
  return {
    reported: rows.filter((it) => inWeek(it.reported_at)).length,
    back: back.length,
    avgDays: days.length ? days.reduce((a, d) => a + d, 0) / days.length : null,
    open: open.length,
    late: late.map((it) => ({
      id: it.id, item: it.item, customers: it.customers_count || 0, urgent: it.urgent,
      days: Math.max(0, Math.floor((at - new Date(it.reported_at)) / 86400e3)),
      why: it.overdueAnswer ? 'not answered yet' : null, due: it.expected_back || null,
    })),
  };
}

module.exports = {
  branchWeekSummary,
  OPEN, ANSWERS, DELIVERS, isDelivery, markDone, markSeen, saveTable, reportB2b, canReport, canAnswer, canSend, canSeeBoard, targets, answerDueFor,
  report, loadItem, loadInbox, countToAnswer, loadBranchItems, loadTransfers, answerItem, markTransfer, markReceived, flagLate, cancelItem, buildBoard,
};
