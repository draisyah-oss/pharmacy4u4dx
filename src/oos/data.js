// Out-of-stock flow (16 Oct): report → answer → transfer/order → back in stock.
//
//  1. Branch staff or the manager report an item any time (how many left, customers asking,
//     urgent for a chronic patient). It lands in Inventory's inbox at once.
//  2. Inventory (HQ: Alia; admin too) answers by 11 am the next working day with one of four
//     answers: transfer from another branch, order from the supplier, offer a substitute,
//     discontinue – with a quantity and the date it should arrive.
//  3. A transfer becomes a job for Fariz (HQ staff): picked → sent, within 24 hours.
//  4. The branch sees the answer on Daily entry and taps "Received – back in stock".
// Targets come from app_settings 'oos_targets' (seed.json company.oos_targets).

const calc = require('../calc');
const { cleanText } = require('../weekly/access');
const { readSeed } = require('../db/seed');
const { isRealDate } = require('../lib/dates');

const OPEN = ['Open', 'Ordered', 'On the way', 'Substitute offered'];
const ANSWERS = {
  transfer: { status: 'On the way', label: 'Transfer from a branch' },
  order: { status: 'Ordered', label: 'Order from the supplier' },
  substitute: { status: 'Substitute offered', label: 'Offer a substitute' },
  discontinue: { status: 'Discontinued', label: 'Discontinue' },
};

const canReport = (user, branch) => user.role === 'admin'
  || (['branch_staff', 'branch_manager'].includes(user.role) && user.branch_id === branch.id);
const canAnswer = (user) => user.role === 'hq' || user.role === 'admin';
const canSend = (user) => ['hq', 'hq_staff', 'admin'].includes(user.role);
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
  if (Object.keys(errors).length) return { errors };

  const t = await targets(db);
  const at = now();
  const today = mytDate(at);
  return db.transaction(async (tx) => {
    const { rows } = await tx.query(
      `INSERT INTO oos_items (branch_id, week_start, item, out_of_stock_since, customers_asking, created_by, updated_by,
         reported_at, left_qty, customers_count, urgent, note, answer_due, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $6, $7, $8, $9, $10, $11, $12, $7) RETURNING id`,
      [branch.id, calc.weekStart(today), item.value, today, asking ? `${body.asking} customers asking` : null, user.id,
        at, left.value, asking ?? null, body.urgent === 'on' || body.urgent === '1', note.value, answerDueFor(at, t.answer_by_hour)]);
    await audit(tx, user, 'insert', `${branch.code} #${rows[0].id}`, null,
      { item: item.value, left: left.value, customers: asking ?? null, urgent: body.urgent === 'on' || body.urgent === '1' });
    return { id: rows[0].id };
  });
}

// ─────────────── Loading ───────────────

const SELECT = `
  SELECT o.*, b.code AS branch_code, b.name AS branch_name, fb.code AS from_code, fb.name AS from_name,
    c.display_name AS reported_by_name, a.display_name AS answered_by_name, s.display_name AS sent_by_name
  FROM oos_items o JOIN branches b ON b.id = o.branch_id
  LEFT JOIN branches fb ON fb.id = o.from_branch_id
  LEFT JOIN users c ON c.id = o.created_by LEFT JOIN users a ON a.id = o.answered_by LEFT JOIN users s ON s.id = o.sent_by`;

async function loadItem(db, id) {
  if (!/^\d{1,9}$/.test(String(id))) return null;
  return (await db.query(`${SELECT} WHERE o.id = $1`, [id])).rows[0] || null;
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
  it.late = it.isOpen && it.expected_back && it.expected_back < today;
  return it;
}

// Inbox for Inventory: to answer (urgent first, then the oldest), waiting for stock, done lately.
async function loadInbox(db, { now }) {
  const at = now(); const today = mytDate(at);
  const open = (await db.query(`${SELECT} WHERE o.status = ANY($1) ORDER BY o.urgent DESC, o.reported_at`, [OPEN])).rows;
  const done = (await db.query(`${SELECT} WHERE NOT (o.status = ANY($1)) AND o.updated_at > $2::timestamptz - interval '14 days' ORDER BY o.updated_at DESC LIMIT 30`, [OPEN, at])).rows;
  await repeats(db, [...open, ...done], at);
  [...open, ...done].forEach((it) => decorate(it, at, today));
  const toAnswer = open.filter((it) => it.unanswered);
  const waiting = open.filter((it) => !it.unanswered)
    .sort((a, b) => Number(b.late || Boolean(b.late_flagged_at)) - Number(a.late || Boolean(a.late_flagged_at)) || String(a.expected_back || '').localeCompare(String(b.expected_back || '')));
  return { toAnswer, waiting, done, overdue: open.filter((it) => it.overdueAnswer || it.late).length };
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
  return rows.map((it) => decorate(it, at, today));
}

async function loadTransfers(db, { now }) {
  const at = now(); const today = mytDate(at); const t = await targets(db);
  const rows = (await db.query(
    `${SELECT} WHERE o.answer = 'transfer' AND (o.sent_at IS NULL OR (o.received_at IS NULL AND o.status = 'On the way'))
     ORDER BY o.sent_at NULLS FIRST, o.urgent DESC, o.answered_at`)).rows;
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
  const kind = String(body.answer || '');
  if (!ANSWERS[kind]) return { error: 'Pick one of the four answers.' };
  const today = mytDate(now());
  const next = { answer: kind, status: ANSWERS[kind].status, answer_qty: null, from_branch_id: null, substitute: null, expected_back: null };
  if (kind === 'transfer' || kind === 'order') {
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
    if (from.id === item.branch_id) return { error: 'It can’t come from the same branch.' };
    next.from_branch_id = from.id;
  }
  if (kind === 'substitute') {
    const sub = cleanText(body.substitute, { max: 160, label: 'Substitute' });
    if (sub.error) return { error: sub.error };
    if (!sub.value) return { error: 'Type what the branch should offer instead.' };
    next.substitute = sub.value;
    const by = String(body.expected_back || '').trim();
    if (by) { if (!isRealDate(by) || by < today) return { error: 'Pick a real date from today on.' }; next.expected_back = by; }
  }
  const note = cleanText(body.reason, { max: 300, label: 'Note to the branch' });
  if (note.error) return { error: note.error };
  next.reason_for_delay = note.value;
  await db.transaction(async (tx) => {
    const cols = Object.keys(next);
    await tx.query(
      `UPDATE oos_items SET ${cols.map((c, i) => `${c} = $${i + 2}`).join(', ')},
         answered_at = COALESCE(answered_at, $${cols.length + 4}), answered_by = $${cols.length + 2}, updated_by = $${cols.length + 2},
         picked_at = CASE WHEN $${cols.length + 3} THEN picked_at END, sent_at = CASE WHEN $${cols.length + 3} THEN sent_at END,
         late_flagged_at = NULL, updated_at = $${cols.length + 4}
       WHERE id = $1`,
      [item.id, ...cols.map((c) => next[c]), user.id, kind === 'transfer' && item.answer === 'transfer', at]);
    await audit(tx, user, 'update', `${item.branch_code} #${item.id} answer`,
      item.answer ? { answer: item.answer, status: item.status } : null, next);
  });
  return { ok: true };
}

// ─────────────── 3. Transfers (Fariz) ───────────────

async function markTransfer(db, user, item, step, { now }) {
  const at = now();
  if (item.answer !== 'transfer') return { error: 'That item isn’t a transfer.' };
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
  const xfers = all.filter((it) => it.answer === 'transfer' && inWeek(it.answered_at));
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
      transfer: avg(back.filter((it) => it.answer === 'transfer')), order: avg(back.filter((it) => it.answer === 'order')),
    },
    open: { total: open.length, toAnswer: open.filter((it) => it.unanswered).length, late: open.filter((it) => it.late || it.overdueAnswer).length },
    branches,
    repeats: [...repeatsByItem.values()].sort((a, b) => b.n - a.n).slice(0, 10),
  };
}

module.exports = {
  OPEN, ANSWERS, canReport, canAnswer, canSend, canSeeBoard, targets, answerDueFor,
  report, loadItem, loadInbox, countToAnswer, loadBranchItems, loadTransfers, answerItem, markTransfer, markReceived, flagLate, buildBoard,
};
