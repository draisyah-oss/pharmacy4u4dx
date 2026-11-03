// 3 Nov 2026 (CEO): the Inventory page (/inventory) – the Mr Eve "Ordering & payment board" moved
// into the app. For Alia (orders), Azwani (payments) and Dr Aisyah (approvals):
//  • Can I order from this supplier? – the month's PO budget by supplier, its terms, and a status that
//    turns open once every payment line for that supplier is marked paid;
//  • Today's list – Mr Eve's daily plan: urgent items, transfers first (no cash), orders, customers
//    asking, recounts – each line can be ticked done;
//  • the weekly cash plan (supplier payments and cash left; the bank stays above RM10,000);
//  • payment approvals – the CEO approves, Azwani marks paid with the date and PV number.
// Recommendations only: nothing here places an order or pays anyone.
// The rules are the board's (same gates, same counts) so the numbers match what Mr Eve sends.

const path = require('path');
const calc = require('../calc');

const FLOOR = 10000; // the bank must stay above RM10,000

// Supplier key: first word of the name, upper case ("AA Alive" → "AA ALIVE").
function keyOf(s) {
  const w = String(s || '').toUpperCase().replace(/[^A-Z0-9 ]/g, ' ').trim().split(/\s+/);
  return w[0] === 'AA' ? `${w[0]} ${w[1] || ''}`.trim() : (w[0] || '');
}
const num = (v) => { if (v === null || v === undefined || String(v).trim() === '') return null; const n = Number(String(v).replace(/[^0-9.\-]/g, '')); return Number.isFinite(n) ? n : null; };

// ---------- who can do what ----------
// 4 Nov (CEO): every HQ login can see the page (read only unless they tick / approve / mark paid).
const canSee = (u) => Boolean(u && (['admin', 'hq', 'hq_staff'].includes(u.role) || u.inventory || u.payments));
const canApprove = (u) => Boolean(u && u.role === 'admin');            // the CEO approves payments
const canPay = (u) => Boolean(u && (u.role === 'admin' || u.payments)); // Azwani marks paid
const canTick = (u) => Boolean(u && (u.role === 'admin' || u.inventory));

// ---------- the board's rules (pure) ----------
// A payment line's status on a day (YYYY-MM-DD).
function payState(p, today) {
  const ok = /^(yes|partial)/i.test(p.approved || '');
  if (p.paid) return 'Paid';
  if (ok && p.pay_date && p.pay_date < today) return 'Not marked paid';
  if (ok) return 'Approved, to pay';
  if (/^no/i.test(p.approved || '')) return 'Not approved';
  return 'Waiting for approval';
}
const money = (p) => (p.approved_amount !== null && p.approved_amount !== undefined ? Number(p.approved_amount) : Number(p.proposed || 0));

function paidByKey(pay) {
  const m = {};
  for (const p of pay) (m[keyOf(p.supplier)] = m[keyOf(p.supplier)] || []).push(Boolean(p.paid));
  return m;
}
const allPaid = (m, k) => (m[k] || []).length > 0 && m[k].every(Boolean);

const GATE_LABEL = { open: 'Open now', paid: 'Open (paid)', wait: 'After payment', after_payment: 'After payment', soa: 'After SOA check', hold: 'On hold', check: 'Check terms', none: '–' };

// One plan line → what to do and whether its supplier is open.
function lineView(r, paidMap) {
  const st = String(r.status_text || '').toLowerCase();
  let gate = st === '' ? 'none' : /on hold/.test(st) ? 'hold' : /^open now|^open \(/.test(st) ? 'open' : /open once/.test(st) ? 'wait' : /soa/.test(st) ? 'soa' : /after/.test(st) ? 'wait' : 'check';
  const key = keyOf(r.supplier);
  if (gate === 'wait' && allPaid(paidMap, key)) gate = 'paid';
  const action = r.action || '';
  const later = /ORDER LATER/i.test(action);
  return { ...r, rm: Number(r.rm || 0), supplier_key: key, gate, status_label: GATE_LABEL[gate], transfer: /TRANSFER/i.test(action), order: /ORDER/i.test(action) && !later, later };
}

const VIEWS = {
  all: { label: 'All', test: () => true },
  urgent: { label: 'Urgent', test: (t) => t.section === 'urgent' },
  transfer: { label: 'Transfer first', test: (t) => t.transfer && t.section !== 'asking' && t.section !== 'recount' },
  order_now: { label: 'Order now', test: (t) => t.order && !t.transfer && (t.gate === 'open' || t.gate === 'paid') && t.section !== 'asking' && t.section !== 'recount' },
  check: { label: 'Check terms', test: (t) => t.order && !t.transfer && (t.gate === 'check' || t.gate === 'none') && t.section !== 'asking' && t.section !== 'recount' },
  wait: { label: 'Wait for payment', test: (t) => (t.order || t.later) && !t.transfer && ['wait', 'soa', 'hold'].includes(t.gate) && t.section !== 'asking' && t.section !== 'recount' },
  asking: { label: 'Customers asking', test: (t) => t.section === 'asking' },
  recount: { label: 'Recount', test: (t) => t.section === 'recount' },
  done: { label: 'Done', test: (t) => Boolean(t.done_at) },
};

function supplierView(budget, todo, paidMap) {
  const known = new Set(budget.map((b) => b.key));
  return budget.map((b) => {
    const lines = todo.filter((t) => (t.order || t.later) && (b.key === 'OTHERS' ? t.supplier_key && !known.has(t.supplier_key) : t.supplier_key === b.key));
    let gate = b.gate;
    if (gate === 'after_payment' && b.unlock_key && allPaid(paidMap, b.unlock_key)) gate = 'paid';
    return { ...b, po_budget: Number(b.po_budget || 0), gate, status_label: gate === 'check' ? 'Check first' : GATE_LABEL[gate] || gate, today_lines: lines.length, today_rm: lines.reduce((s, t) => s + t.rm, 0) };
  });
}

function summary(todo, pay, budget) {
  const sum = (a) => a.reduce((s, t) => s + (t.rm || 0), 0);
  const pick = (v) => todo.filter(VIEWS[v].test);
  const orderNow = pick('order_now'); const check = pick('check'); const wait = pick('wait'); const transfer = pick('transfer');
  const open = pay.filter((p) => !p.paid && /^(yes|partial)/i.test(p.approved || '')).sort((a, b) => String(a.pay_date || '').localeCompare(String(b.pay_date || '')));
  const late = open.filter((p) => p.state === 'Not marked paid');
  const next = open.find((p) => p.state !== 'Not marked paid') || open[0] || null;
  const counts = Object.fromEntries(Object.keys(VIEWS).map((v) => [v, pick(v).length]));
  return {
    counts,
    order_now_lines: orderNow.length, order_now_rm: sum(orderNow),
    check_lines: check.length, check_rm: sum(check),
    wait_lines: wait.length, wait_rm: sum(wait),
    transfer_lines: transfer.length,
    next: next ? { supplier: next.supplier, amount: money(next), date: next.pay_date } : null,
    late_lines: late.length, late_rm: late.reduce((s, p) => s + money(p), 0),
    approved_unpaid_rm: open.reduce((s, p) => s + money(p), 0),
    pending_rm: pay.filter((p) => p.state === 'Waiting for approval').reduce((s, p) => s + Number(p.proposed || 0), 0),
    po_budget_total: budget.reduce((s, b) => s + Number(b.po_budget || 0), 0),
  };
}

// Section of a sheet row from the "SECTION n: …" header above it.
function sectionOf(header) {
  return /URGENT/i.test(header) ? 'urgent' : /HQ/i.test(header) ? 'hq' : /A ITEMS/i.test(header) ? 'a_items' : /CUSTOMERS/i.test(header) ? 'asking' : /COUNT/i.test(header) ? 'recount' : 'other';
}

// Daily plan sheet rows (objects keyed by the sheet headers) → { note, lines } (section headers,
// notes and totals left out, as on the board).
function parsePlanRows(rows) {
  let section = 'other'; let note = ''; const lines = [];
  const g = (r, ...names) => { for (const n of names) if (r[n] !== undefined && r[n] !== null) return String(r[n]).trim(); return ''; };
  for (const r of rows) {
    const action = g(r, 'Action', 'action');
    if (/^SECTION/i.test(action)) { section = sectionOf(action); continue; }
    if (/^NOTE/i.test(action)) { note = action.replace(/^NOTE\s*[-–:]\s*/i, ''); continue; }
    const item = g(r, 'Item', 'item');
    if (/^(TOTALS|\(\+)/i.test(action) || !item) continue;
    lines.push({ line: lines.length + 1, section, action: action.slice(0, 80), item: item.slice(0, 300),
      short_at: g(r, 'Branches/short at', 'short_at').slice(0, 300), transfer_from: g(r, 'Transfer from (qty)', 'transfer_from').slice(0, 300),
      supplier: g(r, 'Supplier', 'supplier').slice(0, 120), status_text: g(r, 'Supplier status', 'status_text').slice(0, 200),
      qty: g(r, 'Order qty', 'qty').slice(0, 60), rm: num(g(r, 'Approx RM', 'rm')) || 0 });
  }
  return { note, lines };
}

// ---------- database ----------
async function loadPayments(db, today) {
  const { rows } = await db.query(`SELECT p.*, p.pay_date::text AS pay_date, p.date_paid::text AS date_paid, a.display_name AS approved_by_name, b.display_name AS paid_by_name
    FROM inv_payments p LEFT JOIN users a ON a.id = p.approved_by LEFT JOIN users b ON b.id = p.paid_by ORDER BY p.pay_date NULLS LAST, p.id`);
  return rows.map((p) => ({ ...p, proposed: p.proposed === null ? null : Number(p.proposed), approved_amount: p.approved_amount === null ? null : Number(p.approved_amount), state: payState(p, today) }));
}

async function latestPlan(db, date) {
  const plans = (await db.query('SELECT id, plan_date::text AS plan_date, title, note, source, created_at FROM inv_plans ORDER BY plan_date DESC LIMIT 14')).rows;
  const plan = (date && plans.find((p) => p.plan_date === date)) || plans[0] || null;
  const lines = plan ? (await db.query(`SELECT l.*, u.display_name AS done_by_name FROM inv_plan_lines l LEFT JOIN users u ON u.id = l.done_by
    WHERE l.plan_id = $1 ORDER BY l.line`, [plan.id])).rows : [];
  return { plan, plans, lines };
}

async function currentMonth(db, today) {
  const m = today.slice(0, 7);
  const has = (await db.query('SELECT month FROM inv_suppliers WHERE month <= $1 ORDER BY month DESC LIMIT 1', [m])).rows[0];
  return has ? has.month : m;
}

async function loadPage(db, { today, date, view = 'all', q = '' } = {}) {
  const month = await currentMonth(db, today);
  const budget = (await db.query('SELECT * FROM inv_suppliers WHERE month = $1 ORDER BY sort, id', [month])).rows;
  const cash = (await db.query('SELECT * FROM inv_cash_weeks WHERE month = $1 ORDER BY sort', [month])).rows
    .map((w) => ({ ...w, sales_in: Number(w.sales_in), zakat_in: Number(w.zakat_in), fixed_out: Number(w.fixed_out), supplier_out: Number(w.supplier_out), cash_end: Number(w.cash_end) }));
  const pay = await loadPayments(db, today);
  const paidMap = paidByKey(pay);
  const { plan, plans, lines } = await latestPlan(db, date);
  const todo = lines.map((l) => lineView(l, paidMap));
  const suppliers = supplierView(budget, todo, paidMap);
  const S = summary(todo, pay, budget);
  const v = VIEWS[view] ? view : 'all';
  const needle = String(q || '').trim().toLowerCase();
  const shown = todo.filter(VIEWS[v].test).filter((t) => !needle || [t.item, t.short_at, t.transfer_from, t.supplier, t.action].join(' ').toLowerCase().includes(needle));
  return { month, budget, cash, pay, plan, plans, todo, shown, suppliers, S, view: v, q: String(q || ''), VIEWS, FLOOR };
}

const audit = (db, userId, action, key, value) => db.query(
  'INSERT INTO audit_log (user_id, action, table_name, record_key, new_value) VALUES ($1, $2, $3, $4, $5)',
  [userId || null, action, 'inventory', key, JSON.stringify(value)]);

async function approve(db, user, id, body, { now }) {
  const p = (await db.query('SELECT * FROM inv_payments WHERE id = $1', [id])).rows[0];
  if (!p) return { error: 'Payment line not found.' };
  const choice = String(body.approved || '');
  if (!['Yes', 'No', 'Partial', ''].includes(choice)) return { error: 'Choose Yes, Partial or No.' };
  let amount = num(body.amount);
  if (choice === 'Partial' && (amount === null || amount <= 0)) return { error: 'Partial: type the amount approved.' };
  if (choice === 'Yes' && amount === null) amount = p.proposed === null ? null : Number(p.proposed);
  if (choice === 'No' || choice === '') amount = null;
  await db.query('UPDATE inv_payments SET approved = $2, approved_amount = $3, approved_by = $4, approved_at = $5 WHERE id = $1',
    [id, choice || null, amount, choice ? user.id : null, choice ? now() : null]);
  await audit(db, user.id, 'approve', `payment ${id} ${p.supplier}`, { approved: choice || null, amount });
  return { ok: true };
}

async function markPaid(db, user, id, body, { now }) {
  const p = (await db.query('SELECT * FROM inv_payments WHERE id = $1', [id])).rows[0];
  if (!p) return { error: 'Payment line not found.' };
  if (body.undo === '1') {
    await db.query('UPDATE inv_payments SET paid = false, date_paid = NULL, pv_no = NULL, paid_by = NULL, paid_at = NULL WHERE id = $1', [id]);
    await audit(db, user.id, 'unpaid', `payment ${id} ${p.supplier}`, { paid: false });
    return { ok: true };
  }
  if (!/^(Yes|Partial)$/.test(p.approved || '')) return { error: 'Not approved by Dr Aisyah yet – a message in Telegram is not an approval.' };
  const date = /^\d{4}-\d{2}-\d{2}$/.test(body.date_paid || '') ? body.date_paid : calc.todayInMalaysia(now());
  const pv = String(body.pv_no || '').trim().slice(0, 40) || null;
  await db.query('UPDATE inv_payments SET paid = true, date_paid = $2, pv_no = $3, paid_by = $4, paid_at = $5 WHERE id = $1', [id, date, pv, user.id, now()]);
  await audit(db, user.id, 'paid', `payment ${id} ${p.supplier}`, { date_paid: date, pv_no: pv });
  return { ok: true };
}

// New payment lines (Mr Eve adds them every Monday; admin / Azwani can add one here too).
async function addPayments(db, userId, rows) {
  let added = 0;
  for (const r of rows || []) {
    const supplier = String(r.supplier || '').trim().slice(0, 120);
    const proposed = num(r.proposed);
    if (!supplier || proposed === null) continue;
    const date = /^\d{4}-\d{2}-\d{2}$/.test(r.pay_date || '') ? r.pay_date : null;
    await db.query('INSERT INTO inv_payments (week, pay_date, supplier, proposed, notes) VALUES ($1, $2, $3, $4, $5)',
      [String(r.week || '').slice(0, 40) || null, date, supplier, proposed, String(r.notes || '').slice(0, 500) || null]);
    added++;
  }
  if (added) await audit(db, userId, 'add', 'payment lines', { added });
  return { added };
}

async function tick(db, user, lineId, done, { now }) {
  const l = (await db.query('SELECT id, item FROM inv_plan_lines WHERE id = $1', [lineId])).rows[0];
  if (!l) return { error: 'Line not found.' };
  await db.query('UPDATE inv_plan_lines SET done_at = $2, done_by = $3 WHERE id = $1', [lineId, done ? now() : null, done ? user.id : null]);
  return { ok: true };
}

// Replace (or add) one day's plan. rows: sheet rows as objects keyed by the sheet headers.
async function savePlan(db, { date, title, rows, source = null }, userId = null) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '')) return { error: 'date (YYYY-MM-DD) needed' };
  const { note, lines } = parsePlanRows(rows || []);
  if (!lines.length) return { error: 'no plan lines' };
  await db.transaction(async (tx) => {
    // Keep ticks on lines that come back with the same item (a re-send of the same day).
    const old = (await tx.query('SELECT l.item, l.done_at, l.done_by FROM inv_plan_lines l JOIN inv_plans p ON p.id = l.plan_id WHERE p.plan_date = $1 AND l.done_at IS NOT NULL', [date])).rows;
    await tx.query('DELETE FROM inv_plans WHERE plan_date = $1', [date]);
    const id = (await tx.query('INSERT INTO inv_plans (plan_date, title, note, source) VALUES ($1, $2, $3, $4) RETURNING id',
      [date, String(title || `Daily plan ${date}`).slice(0, 120), note.slice(0, 600) || null, source])).rows[0].id;
    for (const l of lines) {
      const t = old.find((o) => o.item === l.item);
      await tx.query(`INSERT INTO inv_plan_lines (plan_id, line, section, action, item, short_at, transfer_from, supplier, status_text, qty, rm, done_at, done_by)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [id, l.line, l.section, l.action, l.item, l.short_at || null, l.transfer_from || null, l.supplier || null, l.status_text || null, l.qty || null, l.rm, t ? t.done_at : null, t ? t.done_by : null]);
    }
  });
  await audit(db, userId, 'import', `daily plan ${date}`, { lines: lines.length, source });
  return { ok: true, lines: lines.length };
}

// The month's PO budget by supplier and/or weekly cash plan (replaces that month's rows).
async function saveMonthPlan(db, { month, budget, cash }, userId = null) {
  if (!/^\d{4}-\d{2}$/.test(month || '')) return { error: 'month (YYYY-MM) needed' };
  await db.transaction(async (tx) => {
    if (Array.isArray(budget)) {
      await tx.query('DELETE FROM inv_suppliers WHERE month = $1', [month]);
      let i = 0;
      for (const b of budget) {
        if (!b.supplier) continue;
        const key = String(b.key || keyOf(b.supplier)).toUpperCase();
        await tx.query(`INSERT INTO inv_suppliers (key, supplier, terms, gate, unlock_key, when_text, po_budget, falls_due, sort, month)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT (key) DO UPDATE SET supplier = EXCLUDED.supplier, terms = EXCLUDED.terms, gate = EXCLUDED.gate,
          unlock_key = EXCLUDED.unlock_key, when_text = EXCLUDED.when_text, po_budget = EXCLUDED.po_budget, falls_due = EXCLUDED.falls_due, sort = EXCLUDED.sort, month = EXCLUDED.month`,
        [key, b.supplier, b.terms || null, ['open', 'after_payment', 'soa', 'hold', 'check'].includes(b.gate) ? b.gate : 'check', b.unlock || b.unlock_key || null,
          b.when || b.when_text || null, num(b.po_budget) || 0, b.falls_due || null, ++i, month]);
      }
    }
    if (Array.isArray(cash)) {
      await tx.query('DELETE FROM inv_cash_weeks WHERE month = $1', [month]);
      let i = 0;
      for (const w of cash) {
        if (!w.week) continue;
        await tx.query(`INSERT INTO inv_cash_weeks (month, sort, week, sales_in, zakat_in, fixed_out, supplier_out, cash_end, paying) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [month, w.order || ++i, w.week, num(w.sales_in) || 0, num(w.zakat_in) || 0, num(w.fixed_out) || 0, num(w.supplier_out) || 0, num(w.cash_end) || 0, w.paying || null]);
      }
    }
  });
  await audit(db, userId, 'import', `inventory month plan ${month}`, { budget: (budget || []).length, cash: (cash || []).length });
  return { ok: true };
}

// dd/mm/yyyy (the sheets) → yyyy-mm-dd
const isoDate = (s) => { const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(String(s || '').trim()); return m ? `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}` : null; };

// One time: the board's data as of 3 Nov (src/db/imports/inventory-2026-11-03.json).
async function loadBundledOnce(db, log = () => {}) {
  const flag = 'inventory_20261103_v1';
  if ((await db.query('SELECT 1 FROM app_settings WHERE key = $1', [flag])).rows.length) return;
  const data = require(path.join(__dirname, '..', 'db', 'imports', 'inventory-2026-11-03.json'));
  await saveMonthPlan(db, { month: '2026-11', budget: data.budget, cash: data.cash });
  const obj = (t) => t.rows.map((r) => Object.fromEntries(t.columns.map((c, i) => [c, r[i] === undefined ? '' : r[i]])));
  if (!(await db.query('SELECT 1 FROM inv_payments LIMIT 1')).rows.length) {
    for (const r of obj(data.payments)) {
      if (/EXAMPLE/i.test(Object.values(r).join(' '))) continue;
      const appr = String(r['Approved? (Yes / No / Partial)'] || '').trim();
      const approved = /^yes/i.test(appr) ? 'Yes' : /^partial/i.test(appr) ? 'Partial' : /^no/i.test(appr) ? 'No' : null;
      const proposed = num(r['Proposed amount (RM)']);
      const amount = num(r['Approved amount (RM)']);
      await db.query(`INSERT INTO inv_payments (week, pay_date, supplier, proposed, approved, approved_amount, paid, date_paid, notes) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [r.Week || null, isoDate(r['Pay date (planned)']), r.Supplier, proposed, approved, approved === 'Yes' && amount === null ? proposed : amount,
          /^yes/i.test(r['Paid? (Yes / No)'] || ''), isoDate(r['Date paid']), r.Notes || null]);
    }
  }
  await savePlan(db, { date: data.plan.date, title: data.plan.title, rows: obj(data.plan), source: 'Mr Eve (Google Drive)' });
  await db.query('INSERT INTO app_settings (key, value) VALUES ($1, $2)', [flag, JSON.stringify({ source: data.source, at: new Date().toISOString() })]);
  log('Inventory board data (3 Nov) loaded.');
}

// One time (3 Nov evening, CEO): the November PO budget by supplier as Dr Aisyah updated it –
// RM200,628.03 (src/db/imports/inventory-budget-2026-11-03b.json). Replaces November's supplier rows
// only (the cash plan, payments and daily plans are untouched). Suppliers not in her list stay with RM0.
async function loadBudgetUpdateOnce(db, log = () => {}) {
  const flag = 'inventory_budget_20261103b_v1';
  if ((await db.query('SELECT 1 FROM app_settings WHERE key = $1', [flag])).rows.length) return;
  const data = require(path.join(__dirname, '..', 'db', 'imports', 'inventory-budget-2026-11-03b.json'));
  await saveMonthPlan(db, { month: data.month, budget: data.budget });
  await db.query('INSERT INTO app_settings (key, value) VALUES ($1, $2)', [flag, JSON.stringify({ source: data.source, at: new Date().toISOString() })]);
  log('Inventory: November PO budget updated (3 Nov, RM200,628).');
}

module.exports = { keyOf, payState, lineView, supplierView, summary, parsePlanRows, VIEWS, FLOOR, canSee, canApprove, canPay, canTick,
  loadPage, loadPayments, approve, markPaid, addPayments, tick, savePlan, saveMonthPlan, loadBundledOnce, loadBudgetUpdateOnce, isoDate };
