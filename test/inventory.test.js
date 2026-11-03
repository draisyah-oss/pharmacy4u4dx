// 3 Nov: Inventory page – the ordering & payment board's rules, worked on real-shape sheets
// (test/fixtures/inventory: Payment_Approvals as exported on 3 Nov, and the start of Mr Eve's
// 3 Nov daily plan with a shortened tail covering every section).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const board = require('../src/inventory/board');
const { PLANS, planFor } = require('../src/inventory/plans');
const { cashChartSvg } = require('../src/inventory/chart');
const { createInventorySource } = require('../src/inventory/source');
const { mentionsSalary } = require('../src/privacy');

const fx = (f) => fs.readFileSync(path.join(__dirname, 'fixtures', 'inventory', f), 'utf8');
const planCsv = fx('daily-plan.csv');
const paymentsCsv = fx('payment-approvals.csv');
const nov = planFor('2026-11');
const build = (opts = {}) => board.buildBoard({ planCsv, paymentsCsv, plan: nov, today: '2026-11-03', ...opts });

test('CSV: quoted cells with commas, quotes and line breaks; blank rows dropped', () => {
  const rows = board.parseCsv('﻿a,b\r\n"x, y","he said ""hi"""\r\n,\r\n"two\nlines",z');
  assert.deepEqual(rows, [['a', 'b'], ['x, y', 'he said "hi"'], ['two\nlines', 'z']]);
});

test('numbers, Malaysian dates and supplier keys', () => {
  assert.equal(board.num('RM1,234.50'), 1234.5);
  assert.equal(board.num('~5700'), 5700);
  assert.equal(board.num('check'), null);
  assert.equal(board.num(''), null);
  assert.equal(board.dmyToIso('05/11/2026'), '2026-11-05');
  assert.equal(board.dmyToIso('5/1/2026'), '2026-01-05');
  assert.equal(board.dmyToIso('31/02/2026'), '');
  assert.equal(board.supplierKey('ZUELLIG PHARMA'), 'ZUELLIG');
  assert.equal(board.supplierKey('Zuellig Pharma'), 'ZUELLIG');
  assert.equal(board.supplierKey('AA Alive'), 'AA ALIVE');
  assert.equal(board.supplierKey('AA Pharmacy / Duopharma'), 'AA PHARMACY');
  assert.equal(board.supplierKey('DKSH (104)'), 'DKSH');
});

test('supplier status text → gate (the dashboard rules)', () => {
  const cases = {
    'OPEN NOW': 'open', 'OPEN (PO placed 2 Nov)': 'open', 'Open once 30 Oct payment confirmed': 'wait',
    'Open once paid - check qty/UOM': 'wait', 'AFTER PAYMENT (wk 16-22 Nov)': 'wait', 'AFTER SOA check': 'soa',
    'Other supplier - check terms': 'check', 'CBD - check overdue with Azwani': 'check', 'On hold': 'hold', '': 'none',
  };
  for (const [text, gate] of Object.entries(cases)) assert.equal(board.gateOf(text), gate, text);
});

test('Payment_Approvals: EXAMPLE row left out; Not marked paid once the pay date has passed', () => {
  const { lines, missing } = board.paymentLines(paymentsCsv, '2026-11-03');
  assert.deepEqual(missing, []);
  assert.equal(lines.length, 9);
  assert.ok(!lines.some((p) => /EXAMPLE/.test(p.supplier)));
  const by = (s) => lines.find((p) => p.supplier === s);
  assert.equal(by('AA Alive').state, 'Not marked paid'); // Yes, 30/10, not paid
  assert.equal(by('YSP Industries').state, 'Not marked paid'); // Partial counts as approved
  assert.equal(by('YSP Industries').amount, 1567); // no approved amount → proposed
  assert.equal(by('Zuellig Pharma').state, 'Approved, to pay'); // 05/11 still ahead
  assert.equal(by('DKSH (104)').state, 'Waiting for approval');
  // On 3 Nov, before 30 Oct had passed, AA Alive was simply approved.
  assert.equal(board.paymentLines(paymentsCsv, '2026-10-30').lines[0].state, 'Approved, to pay');
});

test('daily plan: sections, NOTE / TOTALS / "(+" rows skipped, transfers and orders told apart', () => {
  const r = build();
  assert.deepEqual(r.missing, { plan: [], payments: [] });
  const sections = [...new Set(r.lines.map((t) => t.section))];
  assert.deepEqual(sections, ['urgent', 'hq', 'a_items', 'asking', 'recount']);
  assert.ok(!r.lines.some((t) => /^(NOTE|TOTALS|\(\+|SECTION)/.test(t.action)));
  const pan = r.lines.find((t) => t.item.startsWith('Panadol Regular'));
  assert.equal(pan.transfer, true);
  assert.equal(pan.order, true);
  assert.equal(pan.gate, 'wait');
  assert.equal(pan.rm, 304);
  const seladin = r.lines.find((t) => t.item.includes('SELADIN'));
  assert.equal(seladin.later, true);
  assert.equal(seladin.order, false);
  const premarin = r.lines.find((t) => t.item.startsWith('Premarin'));
  assert.equal(premarin.section, 'asking');
});

test('headline counts and RM by what to do', () => {
  const s = build().summary;
  assert.equal(s.counts.all, 27);
  assert.equal(s.counts.urgent, 12);
  assert.equal(s.counts.transfer, 13);
  assert.equal(s.counts.order_now, 4); // Duoderm, Cap Kaki Tiga, Prospan, Hovid folic
  assert.equal(s.orderNowRm, 42 + 44 + 100);
  assert.equal(s.orderSuppliers, 3); // Apex, Delfi, Hovid
  assert.equal(s.counts.check, 3);
  assert.equal(s.counts.wait, 3);
  assert.equal(s.counts.asking, 2);
  assert.equal(s.counts.recount, 2);
  assert.equal(s.late.lines, 3);
  assert.equal(s.late.rm, 15482 + 13606 + 1567);
  assert.equal(s.next.supplier, 'Zuellig Pharma');
  assert.equal(s.next.payDate, '05/11/2026');
  assert.equal(s.approvedUnpaidRm, 30655 + 41000 + 71000);
  assert.equal(s.pendingRm, 35677 + 5000 + 2433 + 1890);
  assert.equal(Math.round(s.poBudgetTotal * 100) / 100, 200628.03);
  // Customers asking and recounts are never counted as transfers or orders.
  const r = build();
  for (const v of ['transfer', 'order_now', 'check', 'wait']) {
    assert.ok(board.filterLines(r.lines, v).every((t) => t.section !== 'asking' && t.section !== 'recount'), v);
  }
});

test('a supplier opens once every Payment_Approvals line for it is Paid', () => {
  const before = build();
  const aa = (r) => r.suppliers.find((x) => x.key === 'AA ALIVE');
  assert.equal(aa(before).gate, 'after_payment');
  assert.equal(aa(before).unpaidLines, 1);
  const paid = paymentsCsv.replace('AA Alive,15482,Yes,15482,,', 'AA Alive,15482,Yes,15482,Yes,31/10/2026');
  const after = build({ paymentsCsv: paid });
  assert.equal(aa(after).gate, 'paid');
  assert.equal(aa(after).label, 'Open (paid)');
  assert.equal(after.summary.late.lines, 2);
  // Plan lines for AA Alive waiting for payment flip to Open (paid) too.
  const evin = (r) => r.lines.find((t) => t.item === 'EVIN PREGNANCY TEST CASSETTE');
  assert.equal(evin(before).gate, 'wait');
  assert.equal(evin(after).gate, 'paid');
  // Zuellig has two lines – one paid is not enough.
  const oneZ = paymentsCsv.replace('Zuellig Pharma,41000,Yes,,', 'Zuellig Pharma,41000,Yes,,Yes');
  assert.equal(build({ paymentsCsv: oneZ }).suppliers.find((x) => x.key === 'ZUELLIG').gate, 'after_payment');
});

test('supplier table: today\'s lines per supplier, unknown suppliers under Others', () => {
  const sup = build().suppliers;
  const by = (k) => sup.find((x) => x.key === k);
  assert.equal(by('ZUELLIG').todayLines, 3);
  assert.equal(by('DELFI').todayLines, 2);
  assert.equal(by('DELFI').todayRm, 144);
  assert.equal(by('OTHERS').todayLines, 4); // Vivadiag (Plusmedics), Glucovance (match?), Uphamol, Hovid
  assert.equal(by('REDWOOD').label, 'On hold');
});

test('filters and search', () => {
  const r = build();
  assert.equal(board.filterLines(r.lines, 'urgent').length, 12);
  assert.equal(board.filterLines(r.lines, 'nope').length, 27); // unknown view = all
  const hits = board.filterLines(r.lines, 'all', 'apex');
  assert.ok(hits.length >= 3 && hits.every((t) => /apex/i.test([t.item, t.supplier, t.shortAt, t.transferFrom, t.action].join(' '))));
  assert.deepEqual(board.filterLines(r.lines, 'recount', 'swab').map((t) => t.item), ['NUR CARE ALCOHOL SWAB 1S']);
});

test('renamed headers still found; a missing column is reported', () => {
  const renamed = paymentsCsv.replace('Pay date (planned)', 'Pay date').replace('Approved? (Yes / No / Partial)', 'Approved?');
  assert.equal(board.paymentLines(renamed, '2026-11-03').lines[0].state, 'Not marked paid');
  const noRm = planCsv.replace(',Approx RM\r\n', ',Cost\r\n');
  assert.deepEqual(build({ planCsv: noRm }).missing.plan, ['rm']);
});

test('text from the sheets that mentions salaries is held back (privacy rule)', () => {
  const csv = paymentsCsv.replace('Instalment (meeting).', 'Pay after salary week.');
  const line = board.paymentLines(csv, '2026-11-03').lines.find((p) => p.supplier === 'Redwood Pharma');
  assert.ok(!mentionsSalary(line.notes));
});

test('cash plan: weeks, floor, tightest week; no salaries in the fixed plans', () => {
  const c = board.cashWeeks(nov);
  assert.equal(c.weeks.length, 5);
  assert.equal(c.floor, 10000);
  assert.equal(c.lowest.week, '1–8 Nov');
  assert.equal(c.totalOut, 30655 + 41000 + 71000 + 45000);
  assert.ok(c.weeks.every((w) => !w.short));
  assert.equal(c.weeks[2].moneyIn, 61800 + 31866);
  // Nov PO budget as Dr Aisyah updated it on 3 Nov: RM200,628.03; one row per supplier key.
  const budget = nov.budget.reduce((s, b) => s + b.poBudget, 0);
  assert.equal(Math.round(budget * 100) / 100, 200628.03);
  assert.equal(new Set(nov.budget.map((b) => b.key)).size, nov.budget.length);
  const by = (k) => nov.budget.find((b) => b.key === k).poBudget;
  assert.equal(by('ZUELLIG'), 115961.58);
  assert.equal(by('DKSH'), 55023.25);
  assert.equal(by('DCH'), 2100);
  assert.equal(by('APEX'), 0, 'suppliers not in the 3 Nov list stay, with no budget');
  assert.ok(!mentionsSalary(JSON.stringify(PLANS)), 'plans.js must not mention salaries');
  for (const p of Object.values(PLANS)) for (const w of p.cash) assert.equal(w.fixedOut, undefined);
});

test('plan for a month: that month, else the latest earlier one (flagged), else none', () => {
  assert.equal(planFor('2026-11').isCurrent, true);
  const dec = planFor('2026-12');
  assert.equal(dec.month, '2026-11');
  assert.equal(dec.isCurrent, false);
  assert.equal(planFor('2026-10'), null);
});

test('cash chart: one bar and one dot per week, the floor line, text escaped', () => {
  const svg = cashChartSvg(board.cashWeeks(nov));
  assert.equal((svg.match(/class="inv-bar"/g) || []).length, 5);
  assert.equal((svg.match(/class="inv-dot/g) || []).length, 5);
  assert.match(svg, /class="inv-floor"/);
  const odd = cashChartSvg({ floor: 10, weeks: [{ week: '<b>', supplierOut: 5, cashEnd: 20, short: false }] });
  assert.ok(!odd.includes('<b>'));
  assert.equal(cashChartSvg({ floor: 1, weeks: [] }), '');
});

// ───────────── Drive (fake Google) ─────────────
function fakeGoogle({ files, exports, status = {} }) {
  const calls = [];
  const fetchImpl = async (url, opts = {}) => {
    calls.push(String(url));
    const json = (code, body) => ({ ok: code < 400, status: code, json: async () => body, text: async () => JSON.stringify(body) });
    if (String(url).startsWith('https://oauth2.googleapis.com/token')) {
      const claims = JSON.parse(Buffer.from(new URLSearchParams(opts.body).get('assertion').split('.')[1], 'base64url').toString());
      assert.equal(claims.scope, 'https://www.googleapis.com/auth/drive.readonly');
      return json(200, { access_token: 'tok' });
    }
    assert.equal(opts.headers.authorization, 'Bearer tok');
    const u = new URL(url);
    if (u.pathname === '/drive/v3/files') {
      assert.equal(u.searchParams.get('supportsAllDrives'), 'true');
      assert.equal(u.searchParams.get('includeItemsFromAllDrives'), 'true');
      assert.match(u.searchParams.get('q'), /'FOLDER_ID_123' in parents/);
      if (status.list) return json(status.list, { error: { message: 'File not found' } });
      return json(200, { files });
    }
    const m = /^\/drive\/v3\/files\/([^/]+)\/export$/.exec(u.pathname);
    if (m && exports[m[1]] !== undefined) {
      assert.equal(u.searchParams.get('mimeType'), 'text/csv');
      return { ok: true, status: 200, text: async () => exports[m[1]] };
    }
    return json(404, { error: { message: 'nope' } });
  };
  return { fetchImpl, calls };
}

const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 1024 });
const account = { email: 'mr-you@p4u.iam.gserviceaccount.com', privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }) };
const settings = { inputs_folder_id: 'FOLDER_ID_123', payment_approvals_id: 'PAYMENTS_ID_123', plan_title_prefix: 'Mr Eve Daily Plan' };

test('Drive: newest "Mr Eve Daily Plan" sheet + Payment_Approvals exported as CSV, kept 5 minutes', async () => {
  const g = fakeGoogle({
    files: [
      { id: 'OLD_PLAN_1234', name: 'Mr Eve Daily Plan 02 Nov 2026', modifiedTime: '2026-11-01T23:53:08Z' },
      { id: 'NEW_PLAN_1234', name: 'Mr Eve Daily Plan 03 Nov 2026', modifiedTime: '2026-11-02T23:56:41Z' },
      { id: 'COPY_PLAN_123', name: 'Copy of Mr Eve Daily Plan 04 Nov', modifiedTime: '2026-11-03T01:00:00Z' },
    ],
    exports: { NEW_PLAN_1234: planCsv, PAYMENTS_ID_123: paymentsCsv },
  });
  let t = new Date('2026-11-03T09:00:00+08:00');
  const src = createInventorySource({ account, fetchImpl: g.fetchImpl, now: () => t });
  assert.equal(src.configured(), true);
  const a = await src.load(settings);
  assert.equal(a.planFile.name, 'Mr Eve Daily Plan 03 Nov 2026');
  assert.equal(a.planCsv, planCsv);
  assert.equal(a.paymentsCsv, paymentsCsv);
  assert.equal(a.cached, false);
  const n = g.calls.length;
  t = new Date(t.getTime() + 60 * 1000);
  assert.equal((await src.load(settings)).cached, true);
  assert.equal((await src.load(settings, { force: true })).cached, false, '"Check Drive now" after 20 s fetches again');
  assert.ok(g.calls.length > n);
  const m = g.calls.length;
  await src.load(settings, { force: true });
  assert.equal(g.calls.length, m, 'a second "Check Drive now" within 20 s uses the copy just read');
  t = new Date(t.getTime() + 6 * 60 * 1000);
  assert.equal((await src.load(settings)).cached, false);
});

test('Drive: clear messages when the folder isn\'t shared, no plan yet, or no key', async () => {
  const denied = createInventorySource({ account, fetchImpl: fakeGoogle({ files: [], exports: {}, status: { list: 404 } }).fetchImpl });
  await assert.rejects(denied.load(settings), /Share the Inventory Agent Inputs folder \(Viewer\) with mr-you@p4u\.iam\.gserviceaccount\.com/);
  const empty = createInventorySource({ account, fetchImpl: fakeGoogle({ files: [], exports: {} }).fetchImpl });
  await assert.rejects(empty.load(settings), /No sheet called "Mr Eve Daily Plan …"/);
  const none = createInventorySource({ env: {} });
  assert.equal(none.configured(), false);
  await assert.rejects(none.load(settings), /No Google service account key/);
  await assert.rejects(createInventorySource({ account, fetchImpl: async () => assert.fail('no call') }).load({}), /missing in app_settings/);
});

test('Drive: its own key first, else the sales sheet\'s key', () => {
  const key = (email) => JSON.stringify({ client_email: email, private_key: 'x' });
  const both = createInventorySource({ env: { INVENTORY_GOOGLE_SERVICE_ACCOUNT_JSON: key('inv@x'), GOOGLE_SERVICE_ACCOUNT_JSON: key('sales@x') } });
  assert.equal(both.status().email, 'inv@x');
  assert.equal(createInventorySource({ env: { GOOGLE_SERVICE_ACCOUNT_JSON: key('sales@x') } }).status().email, 'sales@x');
  const bad = createInventorySource({ env: { INVENTORY_GOOGLE_SERVICE_ACCOUNT_JSON: '{not json' } });
  assert.equal(bad.configured(), false);
  assert.ok(bad.status().keyError);
});
