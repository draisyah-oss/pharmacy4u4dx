// Inventory page (3 Nov, CEO): the "Ordering & Payment Board" worked out from Mr Eve's daily plan
// sheet, the Payment_Approvals sheet and the month's fixed plan (plans.js). Pure functions – no
// database, no network – so the rules are tested on their own (test/inventory.test.js).
// The rules are the dashboard's own (Pharmacy4U Ordering & Payment Board, 3 Nov).

const { mentionsSalary } = require('../privacy');

// ───────────── CSV ─────────────
// Drive's CSV export: quoted cells may hold commas, quotes ("") and line breaks.
function parseCsv(text) {
  const src = String(text || '').replace(/^﻿/, '');
  const rows = []; let row = []; let cell = ''; let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quoted) {
      if (c === '"' && src[i + 1] === '"') { cell += '"'; i++; } else if (c === '"') quoted = false; else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(cell); cell = ''; } else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += c;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((x) => x.trim() !== ''));
}

// Header text without case, spaces or punctuation: "Approved? (Yes / No / Partial)" → "approvedyesnopartial".
const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

// Rows as objects keyed by our own names. `columns` = { name: test(normalisedHeader) }; the first
// header that passes wins, so the sheets' long headers can gain or lose a word without breaking.
function readTable(text, columns) {
  const [head = [], ...body] = parseCsv(text);
  const h = head.map(norm);
  const at = {};
  for (const [name, test] of Object.entries(columns)) {
    const i = h.findIndex((x, j) => test(x) && !Object.values(at).includes(j));
    if (i >= 0) at[name] = i;
  }
  const missing = Object.keys(columns).filter((k) => at[k] === undefined);
  const rows = body.map((r, n) => {
    const o = { line: n + 1 };
    for (const k of Object.keys(columns)) o[k] = at[k] === undefined ? '' : String(r[at[k]] ?? '').trim();
    return o;
  });
  return { rows, missing };
}

const PLAN_COLUMNS = {
  action: (h) => h === 'action',
  item: (h) => h === 'item',
  shortAt: (h) => h.startsWith('branches') || h.startsWith('shortat'),
  transferFrom: (h) => h.startsWith('transferfrom'),
  supplier: (h) => h === 'supplier',
  status: (h) => h.startsWith('supplierstatus'),
  qty: (h) => h.startsWith('orderqty'),
  rm: (h) => h.startsWith('approxrm') || h === 'rm',
};
const PAY_COLUMNS = {
  week: (h) => h === 'week',
  payDate: (h) => h.startsWith('paydate'),
  supplier: (h) => h === 'supplier',
  proposed: (h) => h.startsWith('proposed'),
  approvedAmount: (h) => h.startsWith('approvedamount'),
  approved: (h) => h.startsWith('approved'),
  datePaid: (h) => h.startsWith('datepaid'),
  paid: (h) => h.startsWith('paid'),
  notes: (h) => h.startsWith('note'),
};

// ───────────── helpers ─────────────
// Text from the sheets goes on the page; anything that mentions salaries is held back (privacy rule).
const clean = (s) => (mentionsSalary(s) ? '(hidden – mentions staff pay)' : String(s || ''));

// "1,234.50" / "RM304" / "~5700" → number; '' or text → null.
function num(s) {
  const t = String(s ?? '').trim();
  if (!t) return null;
  const n = Number(t.replace(/[^0-9.\-]/g, ''));
  return t.replace(/[^0-9]/g, '') === '' || Number.isNaN(n) ? null : n;
}

// dd/mm/yyyy (Malaysian sheets) → YYYY-MM-DD, or '' when it isn't a real date.
function dmyToIso(s) {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(String(s || '').trim());
  if (!m) return '';
  const iso = `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  const d = new Date(`${iso}T00:00:00Z`);
  return Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== iso ? '' : iso;
}

// The supplier's first word in capitals ("Zuellig Pharma" / "ZUELLIG PHARMA" → ZUELLIG);
// "AA …" keeps two words so AA Alive and AA Pharmacy stay apart.
function supplierKey(s) {
  const w = String(s || '').toUpperCase().replace(/[^A-Z0-9 ]/g, ' ').trim().split(/\s+/).filter(Boolean);
  if (!w.length) return '';
  return w[0] === 'AA' ? `AA ${w[1] || ''}`.trim() : w[0];
}

// ───────────── Payment_Approvals ─────────────
const PAY_STATES = { PAID: 'Paid', TO_PAY: 'Approved, to pay', LATE: 'Not marked paid', NO: 'Not approved', WAITING: 'Waiting for approval' };

// One line per sheet row (EXAMPLE rows left out) with a state:
// Paid · Approved, to pay · Not marked paid (approved, pay date before today) · Not approved · Waiting for approval.
function paymentLines(csvText, today) {
  const { rows, missing } = readTable(csvText, PAY_COLUMNS);
  const lines = rows
    .filter((r) => !/EXAMPLE/i.test(Object.values(r).join(' ')) && (r.supplier || r.proposed))
    .map((r) => {
      const approved = r.approved;
      const paid = /^y/i.test(r.paid);
      const payDay = dmyToIso(r.payDate);
      const ok = /^(yes|partial)/i.test(approved);
      const state = paid ? PAY_STATES.PAID
        : ok && payDay && payDay < today ? PAY_STATES.LATE
          : ok ? PAY_STATES.TO_PAY
            : /^no/i.test(approved) ? PAY_STATES.NO : PAY_STATES.WAITING;
      const proposed = num(r.proposed);
      const approvedAmount = num(r.approvedAmount);
      return {
        line: r.line, week: clean(r.week), payDate: r.payDate, payDay, supplier: clean(r.supplier), key: supplierKey(r.supplier),
        proposed, approved: approved || '–', approvedAmount, ok, paid, datePaid: r.datePaid, notes: clean(r.notes), state,
        amount: approvedAmount ?? proposed ?? 0,
      };
    });
  return { lines, missing };
}

// Every Payment_Approvals line for the supplier key is marked Paid (and there is at least one).
function paidBySupplier(pay) {
  const by = {};
  for (const p of pay) (by[p.key] = by[p.key] || []).push(p.paid);
  return (key) => Boolean(key) && (by[key] || []).length > 0 && by[key].every(Boolean);
}

// ───────────── daily plan ─────────────
const GATE_LABELS = { open: 'Open now', paid: 'Open (paid)', wait: 'After payment', soa: 'After SOA check', hold: 'On hold', check: 'Check terms', none: '–' };

// The plan's "Supplier status" text → a gate.
function gateOf(statusText) {
  const st = String(statusText || '').toLowerCase().trim();
  if (!st) return 'none';
  if (/on hold/.test(st)) return 'hold';
  if (/^open now|^open \(/.test(st)) return 'open';
  if (/open once/.test(st)) return 'wait';
  if (/soa/.test(st)) return 'soa';
  if (/after/.test(st)) return 'wait';
  return 'check';
}

function sectionOf(action) {
  if (/URGENT/i.test(action)) return 'urgent';
  if (/HQ/i.test(action)) return 'hq';
  if (/A ITEMS/i.test(action)) return 'a_items';
  if (/CUSTOMERS/i.test(action)) return 'asking';
  if (/COUNT/i.test(action)) return 'recount';
  return 'other';
}

// Plan rows grouped by their SECTION header; NOTE, TOTALS and "(+ …)" rows and rows with no item
// are left out. A supplier waiting for payment shows Open (paid) once Payment_Approvals says so.
function planLines(csvText, pay) {
  const { rows, missing } = readTable(csvText, PLAN_COLUMNS);
  const allPaid = paidBySupplier(pay);
  let section = 'other';
  const lines = [];
  for (const r of rows) {
    const action = r.action;
    if (/^SECTION/i.test(action)) { section = sectionOf(action); continue; }
    if (/^(NOTE|TOTALS|\(\+)/i.test(action) || !r.item) continue;
    const key = supplierKey(r.supplier);
    let gate = gateOf(r.status);
    if (gate === 'wait' && allPaid(key)) gate = 'paid';
    const later = /ORDER LATER/i.test(action);
    lines.push({
      line: r.line, section, action: clean(action), item: clean(r.item), shortAt: clean(r.shortAt), transferFrom: clean(r.transferFrom),
      supplier: clean(r.supplier), key, statusText: clean(r.status), gate, gateLabel: GATE_LABELS[gate],
      transfer: /TRANSFER/i.test(action), order: /ORDER/i.test(action) && !later, later,
      qty: clean(r.qty), rm: num(r.rm) || 0,
    });
  }
  return { lines, missing };
}

// What each filter shows. Customers asking and recounts are their own lists, never counted as
// transfers or orders.
const isItem = (t) => t.section !== 'asking' && t.section !== 'recount';
const VIEWS = {
  all: { label: 'All', test: () => true },
  urgent: { label: 'Urgent', test: (t) => t.section === 'urgent' },
  transfer: { label: 'Transfer first', test: (t) => isItem(t) && t.transfer },
  order_now: { label: 'Order now', test: (t) => isItem(t) && t.order && !t.transfer && (t.gate === 'open' || t.gate === 'paid') },
  check: { label: 'Check terms', test: (t) => isItem(t) && t.order && !t.transfer && (t.gate === 'check' || t.gate === 'none') },
  wait: { label: 'Wait for payment', test: (t) => isItem(t) && (t.order || t.later) && !t.transfer && ['wait', 'soa', 'hold'].includes(t.gate) },
  asking: { label: 'Customers asking', test: (t) => t.section === 'asking' },
  recount: { label: 'Recount', test: (t) => t.section === 'recount' },
};

function filterLines(lines, view, q) {
  const v = VIEWS[view] || VIEWS.all;
  const needle = String(q || '').trim().toLowerCase();
  return lines.filter((t) => v.test(t)
    && (!needle || [t.item, t.shortAt, t.transferFrom, t.supplier, t.action].join(' ').toLowerCase().includes(needle)));
}

// ───────────── supplier table ─────────────
const SUPPLIER_LABELS = { open: 'Open now', paid: 'Open (paid)', after_payment: 'After payment', soa: 'After SOA check', hold: 'On hold', check: 'Check first' };

// The month's PO budget by supplier, with today's order lines for each, and a status that turns
// open once every Payment_Approvals line for that supplier is marked Paid.
function supplierRows(budget, lines, pay) {
  const allPaid = paidBySupplier(pay);
  const known = new Set(budget.map((b) => b.key));
  return budget.map((b) => {
    const mine = lines.filter((t) => (t.order || t.later) && (b.key === 'OTHERS' ? t.key && !known.has(t.key) : t.key === b.key));
    const gate = b.gate === 'after_payment' && b.unlock && allPaid(b.unlock) ? 'paid' : b.gate;
    const unpaid = pay.filter((p) => p.key === (b.unlock || b.key) && !p.paid);
    return {
      ...b, gate, label: SUPPLIER_LABELS[gate] || gate, todayLines: mine.length, todayRm: mine.reduce((s, t) => s + t.rm, 0),
      unpaidLines: unpaid.length, unpaidRm: unpaid.reduce((s, p) => s + p.amount, 0),
    };
  });
}

// ───────────── headline ─────────────
function summary(lines, pay, budget) {
  const pick = (v) => lines.filter(VIEWS[v].test);
  const sum = (a) => a.reduce((s, t) => s + (t.rm || 0), 0);
  const counts = Object.fromEntries(Object.keys(VIEWS).map((v) => [v, pick(v).length]));
  const orderNow = pick('order_now'); const check = pick('check'); const wait = pick('wait');
  const open = pay.filter((p) => !p.paid && p.ok).sort((a, b) => (a.payDay || '9').localeCompare(b.payDay || '9'));
  const late = open.filter((p) => p.state === PAY_STATES.LATE);
  const next = open.find((p) => p.state !== PAY_STATES.LATE) || null;
  return {
    counts,
    orderNowRm: sum(orderNow), checkRm: sum(check), waitRm: sum(wait),
    orderSuppliers: new Set(orderNow.map((t) => t.key).filter(Boolean)).size,
    next, late: { lines: late.length, rm: late.reduce((s, p) => s + p.amount, 0) },
    approvedUnpaidRm: open.reduce((s, p) => s + p.amount, 0),
    pendingRm: pay.filter((p) => p.state === PAY_STATES.WAITING).reduce((s, p) => s + (p.proposed || 0), 0),
    paidRm: pay.filter((p) => p.paid).reduce((s, p) => s + p.amount, 0),
    poBudgetTotal: budget.reduce((s, b) => s + (b.poBudget || 0), 0),
  };
}

// ───────────── cash plan ─────────────
// Weekly supplier payments vs cash at week end; a week is short when its cash ends under the floor.
function cashWeeks(plan) {
  if (!plan) return { weeks: [], floor: 0, lowest: null };
  const weeks = plan.cash.map((w) => ({ ...w, moneyIn: w.salesIn + w.zakatIn, short: w.cashEnd < plan.cashFloor, headroom: w.cashEnd - plan.cashFloor }));
  const lowest = weeks.reduce((lo, w) => (!lo || w.cashEnd < lo.cashEnd ? w : lo), null);
  return { weeks, floor: plan.cashFloor, lowest, totalOut: weeks.reduce((s, w) => s + w.supplierOut, 0) };
}

// Everything the page shows, from the two CSV exports and the month's plan.
function buildBoard({ planCsv, paymentsCsv, plan, today }) {
  const pay = paymentLines(paymentsCsv, today);
  const todo = planLines(planCsv, pay.lines);
  const budget = plan ? plan.budget : [];
  return {
    pay: pay.lines, lines: todo.lines,
    suppliers: supplierRows(budget, todo.lines, pay.lines),
    summary: summary(todo.lines, pay.lines, budget),
    cash: cashWeeks(plan),
    missing: { plan: todo.missing, payments: pay.missing },
  };
}

module.exports = {
  parseCsv, readTable, num, dmyToIso, supplierKey, gateOf, paymentLines, planLines, supplierRows, summary, cashWeeks,
  filterLines, buildBoard, VIEWS, PAY_STATES, GATE_LABELS,
};
