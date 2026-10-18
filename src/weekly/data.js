// Manager's weekly update to HQ (Monday 4 pm meeting with CEO, Alia, Hanin – was the weekly
// check-in): sales, branch WIG session, commitments kept and the out-of-stock week come from the
// app; the manager adds the stock numbers, SKUs, zakat claims, one win and up to three things
// they need from HQ (each for an HQ person – these become HQ actions, src/wig/data.js).
// The old OOS list (/weekly/oos) still works but is no longer on the page: out of stock is summed
// from the daily reports (src/oos).

const calc = require('../calc');
const { parseOptional, audit } = require('../admin/common');
const { buildScoreboard } = require('../scoreboard/data');
const { cleanText } = require('./access');
const { isRealDate } = require('../lib/dates');

const NUMBERS = [
  { key: 'opening_stock_value', label: 'Stock value on Monday', money: true, hint: 'Start of the week' },
  { key: 'closing_stock_value', label: 'Stock value on Sunday', money: true, hint: 'End of the week' },
  { key: 'weekly_cogs', label: 'Cost of goods sold this week', money: true, hint: 'COGS, Monday to Sunday' },
  { key: 'sku_qty_on_hand', label: 'SKUs on hand', hint: 'Number of different items in stock' },
  { key: 'skus_sold_mtd', label: 'SKUs sold this month so far', hint: 'Different items sold, month to date' },
  { key: 'zakat_claims_disbursed', label: 'Zakat claims paid out', zakat: true, hint: 'Claims the zakat body has paid' },
  { key: 'zakat_claims_pending', label: 'Zakat claims still pending', zakat: true, hint: 'Submitted, not paid yet' },
];
const TEXTS = [
  { key: 'win_this_week', label: 'One win this week' },
  { key: 'issue_needing_hq_help', label: 'One issue that needs HQ help' },
];

const OOS_STATUSES = ['Open', 'Ordered', 'On the way', 'Substitute offered', 'Back in stock', 'Discontinued', 'Discontinued / use substitute'];
const OOS_OPEN = ['Open', 'Ordered', 'On the way', 'Substitute offered']; // same as src/oos/data.js OPEN

const numbersFor = (branch) => NUMBERS.filter((n) => !n.zakat || branch.zakat_field);
const num = (v) => (v === null || v === undefined ? null : Number(v));

async function loadCheckin(db, branchId, week) {
  const { rows } = await db.query(
    `SELECT c.*, u.display_name AS submitted_by_name FROM weekly_checkins c
     LEFT JOIN users u ON u.id = c.submitted_by WHERE c.branch_id = $1 AND c.week_start = $2`, [branchId, week]);
  return rows[0] || null;
}

function turnoverFor(checkin, branch) {
  const target = branch.stock_turnover_target_per_week === null ? null : Number(branch.stock_turnover_target_per_week);
  if (!checkin) return calc.stockTurnover({ target });
  return calc.stockTurnover({
    weeklyCogs: num(checkin.weekly_cogs), openingStock: num(checkin.opening_stock_value),
    closingStock: num(checkin.closing_stock_value), target,
  });
}

// Open items logged up to this week, plus anything logged this week (even if sorted already).
async function loadOos(db, branchId, week) {
  const { rows } = await db.query(
    `SELECT o.*, c.display_name AS created_by_name, u.display_name AS updated_by_name
     FROM oos_items o LEFT JOIN users c ON c.id = o.created_by LEFT JOIN users u ON u.id = o.updated_by
     WHERE o.branch_id = $1 AND (o.week_start = $2 OR (o.week_start <= $2 AND o.status = ANY($3)))
     ORDER BY array_position($4::text[], o.status), o.out_of_stock_since NULLS LAST, o.id`,
    [branchId, week, OOS_OPEN, OOS_STATUSES]);
  return rows;
}

async function loadCheckinPage(db, { branch, week, today, trackerStart, now }) {
  const wig = require('../wig/data');
  const oosData = require('../oos/data');
  const { loadWeek } = require('./commitments');
  const [board, checkin, oos, oosWeek, asks, lastActions, session, commits, hqPeople] = await Promise.all([
    buildScoreboard(db, { branch, weekStart: week, today, trackerStart }),
    loadCheckin(db, branch.id, week),
    loadOos(db, branch.id, week),
    oosData.branchWeekSummary(db, { branchId: branch.id, week, now }),
    wig.loadActions(db, { week, branchId: branch.id }),
    wig.loadActions(db, { week: calc.addDays(week, -7), branchId: branch.id }),
    wig.loadSession(db, branch.id, week),
    loadWeek(db, branch.id, week),
    wig.hqPeople(db),
  ]);
  const rows = [...board.top, ...board.groups.flatMap((g) => g.rows)];
  const leads = board.top.filter((r) => ['on_track', 'watch', 'off_track'].includes(r.week.status));
  return {
    oosWeek, asks, lastActions, session, commitSummary: wig.resultSummary(commits), hqPeople, maxAsks: wig.MAX_ASKS,
    leadsOnTrack: { on: leads.filter((r) => r.week.status === 'on_track').length, total: leads.length },
    measureCount: rows.length,
    sales: board.sales, asOf: board.asOf, started: board.started, weekEnd: board.weekEnd, mtdFrom: board.mtdFrom,
    checkin, turnover: turnoverFor(checkin, branch), oos,
    numbers: numbersFor(branch), texts: TEXTS, hasZakat: Boolean(branch.zakat_field),
    skuTarget: branch.sku_sold_target_per_month === null ? null : Number(branch.sku_sold_target_per_month),
  };
}

// Returns { errors } or { saved: n } (n = boxes changed).
async function saveCheckin(db, user, branch, week, body) {
  const errors = {};
  const values = {};
  // Boxes not in the form are left as they are.
  for (const n of numbersFor(branch)) {
    if (body[n.key] === undefined) continue;
    const r = parseOptional(body[n.key], { min: 0 });
    if (r.error) errors[n.key] = r.error; else values[n.key] = r.value;
  }
  for (const t of TEXTS) {
    if (body[t.key] === undefined) continue;
    const r = cleanText(body[t.key], { label: t.label });
    if (r.error) errors[t.key] = r.error; else values[t.key] = r.value;
  }
  if (Object.keys(errors).length) return { errors };
  if (!Object.keys(values).length) return { saved: 0 };

  return db.transaction(async (tx) => {
    const before = await loadCheckin(tx, branch.id, week);
    const oldV = {}; const newV = {};
    for (const [k, v] of Object.entries(values)) {
      const isNumber = NUMBERS.some((n) => n.key === k);
      const old = before ? (isNumber ? num(before[k]) : before[k] ?? null) : null;
      if (old !== v) { oldV[k] = old; newV[k] = v; }
    }
    if (!Object.keys(newV).length) return { saved: 0 };
    const cols = Object.keys(values);
    await tx.query(
      `INSERT INTO weekly_checkins (branch_id, week_start, ${cols.join(', ')}, submitted_by, updated_at)
       VALUES ($1, $2, ${cols.map((_, i) => `$${i + 3}`).join(', ')}, $${cols.length + 3}, now())
       ON CONFLICT (branch_id, week_start) DO UPDATE SET
         ${cols.map((c) => `${c} = EXCLUDED.${c}`).join(', ')}, submitted_by = EXCLUDED.submitted_by, updated_at = now()`,
      [branch.id, week, ...cols.map((c) => values[c]), user.id]);
    await audit(tx, user, before ? 'update' : 'insert', 'weekly_checkins', `${branch.code} ${week}`, before ? oldV : null, newV);
    return { saved: Object.keys(newV).length };
  });
}

// ─────────────── OOS list ───────────────

function parseSince(value, today) {
  const s = String(value ?? '').trim();
  if (!s) return { value: null };
  if (!isRealDate(s)) return { error: 'Pick a real date.' };
  if (s > today) return { error: 'That date is in the future.' };
  return { value: s };
}

async function addOos(db, user, branch, week, body, today) {
  const item = cleanText(body.item, { max: 120, label: 'Item' });
  if (item.error) return { error: item.error };
  if (!item.value) return { error: 'Type the item that is out of stock.' };
  const since = parseSince(body.out_of_stock_since, today);
  if (since.error) return { error: since.error };
  const asking = cleanText(body.customers_asking, { max: 200, label: 'Customers asking' });
  if (asking.error) return { error: asking.error };
  return db.transaction(async (tx) => {
    const { rows } = await tx.query(
      `INSERT INTO oos_items (branch_id, week_start, item, out_of_stock_since, customers_asking, created_by, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6, $6) RETURNING id`,
      [branch.id, week, item.value, since.value, asking.value, user.id]);
    await audit(tx, user, 'insert', 'oos_items', `${branch.code} #${rows[0].id}`, null,
      { item: item.value, out_of_stock_since: since.value, customers_asking: asking.value });
    return { id: rows[0].id };
  });
}

// branchEdit: the manager/admin may change what the branch reported.
// answer: HQ/admin may fill in the reason, expected date and status.
async function updateOos(db, user, item, body, { branchEdit, answer, today }) {
  const next = {};
  if (branchEdit) {
    const name = cleanText(body.item, { max: 120, label: 'Item' });
    if (name.error) return { error: name.error };
    if (!name.value) return { error: 'The item name can’t be empty.' };
    const since = parseSince(body.out_of_stock_since, today);
    if (since.error) return { error: since.error };
    const asking = cleanText(body.customers_asking, { max: 200, label: 'Customers asking' });
    if (asking.error) return { error: asking.error };
    Object.assign(next, { item: name.value, out_of_stock_since: since.value, customers_asking: asking.value });
  }
  if (answer) {
    const reason = cleanText(body.reason_for_delay, { max: 300, label: 'Reason' });
    if (reason.error) return { error: reason.error };
    const back = String(body.expected_back ?? '').trim();
    if (back && !isRealDate(back)) return { error: 'Expected back: pick a real date.' };
    Object.assign(next, { reason_for_delay: reason.value, expected_back: back || null });
  }
  if (branchEdit || answer) {
    if (body.status !== undefined) {
      if (!OOS_STATUSES.includes(body.status)) return { error: 'Pick a status from the list.' };
      next.status = body.status;
    }
  }
  const changed = Object.fromEntries(Object.entries(next).filter(([k, v]) => (item[k] ?? null) !== v));
  if (!Object.keys(changed).length) return { saved: 0 };
  const cols = Object.keys(changed);
  await db.transaction(async (tx) => {
    await tx.query(
      `UPDATE oos_items SET ${cols.map((c, i) => `${c} = $${i + 2}`).join(', ')}, updated_by = $${cols.length + 2}, updated_at = now() WHERE id = $1`,
      [item.id, ...cols.map((c) => changed[c]), user.id]);
    await audit(tx, user, 'update', 'oos_items', `${item.branch_code} #${item.id}`,
      Object.fromEntries(cols.map((c) => [c, item[c] ?? null])), changed);
  });
  return { saved: cols.length };
}

async function loadOosItem(db, id) {
  if (!/^\d{1,9}$/.test(String(id))) return null;
  const { rows } = await db.query(
    `SELECT o.*, b.code AS branch_code FROM oos_items o JOIN branches b ON b.id = o.branch_id WHERE o.id = $1`, [id]);
  return rows[0] || null;
}

module.exports = {
  NUMBERS, TEXTS, OOS_STATUSES, OOS_OPEN, numbersFor, turnoverFor,
  loadCheckin, loadCheckinPage, saveCheckin, loadOos, addOos, updateOos, loadOosItem,
};
