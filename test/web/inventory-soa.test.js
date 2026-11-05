// 5 Nov 2026: supplier SOA status from the SOA folder in Google Drive.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const ExcelJS = require('exceljs');

const { createDb } = require('../../src/db');
const { migrate } = require('../../src/db/migrate');
const { readSeed, loadSeed } = require('../../src/db/seed');
const { createApp } = require('../../src/app');
const inv = require('../../src/inventory/data');
const soaMod = require('../../src/inventory/soa');
const { parseCsv } = require('../../src/inventory/drive');

let db;
const now = () => new Date('2026-11-05T10:00:00+08:00');

test.before(async () => {
  db = await createDb({ url: '', localDir: 'memory' });
  await migrate(db);
  await loadSeed(db, readSeed(), { adminPassword: 'admin-pass-1' });
  await inv.loadBundledOnce(db);
});
test.after(async () => { await db.close(); });

const AA = `2026 YEAR 2026,,,,,,,,,,,,,
,INVOICE DATE ,TERMS/DAYS,INVOICE NO.,AMOUNT(RM),CREDIT NOTE,,,AMOUNT TO PAY (RM),DUE DATE,PAYMENT STATUS,DATE PAID,PAYMENT REQUEST,PROOF OF PAYMENT
,,,,,CN DATE,CN NO,CN AMOUNT (RM),,,,,,
1,1/1/2026,60,I121155,1083.04,,,,1083.04,02/03/2026,PAID,13/2/26,WMPV0226-040,x
12,15/6/2026,60,I140773,1020.33,,,,1020.33,14/08/2026,UNPAID,,WMPV0926-025,
,07/09/2026,60,I168042,1963.82,,,,1963.82,06/11/2026,UNPAID,,,
,23/9/2026,60,(WM)CN006971,105.00,,,,2885.92,22/11/2026,UNPAID,,,
CN,14/08/2025,60,I094005,1599.00,27/08/2025,CN-003968,24.75,1574.25,13/10/2025,PAID,11/12/25,,
2025 YEAR 2025,,,
,INVOICE DATE ,TERMS/DAYS,INVOICE NO.,AMOUNT(RM),CN DATE,CN NO,CN AMOUNT (RM),AMOUNT TO PAY (RM),DUE DATE,PAYMENT STATUS,DATE PAID,WMPV
,17/10/2025,60,I104933,82.45,,,,1142.80,16/12/2025,,,`;
const DUO = `,INVOICE DATE ,TERMS/DAYS,INVOICE NO.,AMOUNT(RM),DUE DATE,PAYMENT STATUS,DATE PAID,PV NUMBER
,01/09/2026,60,DP100,500,31/10/2026,PAID,30/10/2026,WMPV1026-001
,01/10/2026,60,DP200,700,30/11/2026,,,`;

test('reading an SOA: paid / unpaid, credit notes, CN amounts, PV = paid, overdue by due date', () => {
  const inv1 = soaMod.parseSoa(parseCsv(AA));
  assert.deepEqual(inv1.map((x) => [x.ref, x.amount, x.state]), [['I121155', 1083.04, 'paid'], ['I140773', 1020.33, 'unpaid'], ['I168042', 1963.82, 'unpaid'],
    ['(WM)CN006971', -105, 'unpaid'], ['I094005', 1574.25, 'paid'], ['I104933', 82.45, 'unpaid']]);
  const s = soaMod.summarise(inv1, '2026-11-05');
  assert.equal(s.overdue, 1102.78); assert.equal(s.oldest_due, '2025-12-16'); assert.equal(s.next_due, '2026-11-06'); assert.equal(s.last_paid, '2026-02-13');
  const aish = parseCsv(`,PROFORMA INVOICE,PROFORMA DATE,AMOUNT,INVOICE DATE ,TERMS/DAYS,INVOICE NO.,AMOUNT(RM),DUE DATE,PAYMENT STATUS,DATE PAID,PV NUMBER
,ORD091782,27/5/2026,238.4,,,,,,,29/5/2026,HQPV0526-014
,,,,11/09/2026,30,4ALSHIVW1002363,3172.4,11/10/2026,,,`);
  assert.deepEqual(soaMod.parseSoa(aish).map((x) => [x.ref, x.amount, x.state]), [['ORD091782', 238.4, 'paid'], ['4ALSHIVW1002363', 3172.4, 'unpaid']]);
  assert.equal(soaMod.isoDate('13/2/26'), '2026-02-13');
  assert.deepEqual(soaMod.folderName('(CONSIGNMENT) MOMMYHANA'), { name: 'MOMMYHANA', consignment: true });
});

test('the sync reads every supplier folder; the page shows it; "After SOA check" opens when nothing is overdue', async () => {
  const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 1024 });
  const account = { email: 'mr-you@p4u.iam.gserviceaccount.com', privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }) };
  const xlsx = async (csv) => { const wb = new ExcelJS.Workbook(); const ws = wb.addWorksheet('2026'); parseCsv(csv).forEach((r) => ws.addRow(r)); return Buffer.from(await wb.xlsx.writeBuffer()); };
  const files = { AAF: [{ id: 'AAX', name: 'SOA AA ALIVE SDN BHD.xlsx', mimeType: soaXlsx(), modifiedTime: 't1' }], DUOF: [{ id: 'DUOG', name: 'SOA DUOPHARMA', mimeType: 'application/vnd.google-apps.spreadsheet', modifiedTime: 't1' }], CONF: [] };
  let downloads = 0;
  const fetchImpl = async (url, opts = {}) => {
    const u = new URL(url);
    const json = (code, body) => ({ ok: code < 400, status: code, json: async () => body });
    if (u.host === 'oauth2.googleapis.com') return json(200, { access_token: 't' });
    const q = u.searchParams.get('q') || '';
    if (u.pathname === '/drive/v3/files') {
      if (q.includes(`'${soaMod.DEFAULT_FOLDER}' in parents`)) return json(200, { files: [{ id: 'AAF', name: 'AA ALIVE SDN BHD' }, { id: 'DUOF', name: 'DUOPHARMA (M) SDN BHD' }, { id: 'CONF', name: '(CONSIGNMENT) MOMMYHANA' }] });
      const id = /'([^']+)' in parents/.exec(q)[1];
      return json(200, { files: files[id] || [] });
    }
    downloads++;
    if (u.pathname === '/drive/v3/files/AAX') return { ok: true, status: 200, arrayBuffer: async () => xlsx(AA) };
    if (u.pathname === '/drive/v3/files/DUOG/export') return { ok: true, status: 200, arrayBuffer: async () => xlsx(DUO) };
    return json(404, { error: { message: 'nope' } });
  };
  const soa = soaMod.createSoaSync(db, { account, fetchImpl, now, log: () => {} });
  const r = await soa.syncNow();
  assert.deepEqual([r.folders, r.read], [3, 2]);
  // An empty folder list = not shared with the app → a clear message.
  const empty = soaMod.createSoaSync(db, { account, fetchImpl: async (url) => (new URL(url).host === 'oauth2.googleapis.com' ? { ok: true, status: 200, json: async () => ({ access_token: 't' }) } : { ok: true, status: 200, json: async () => ({ files: [] }) }), now, log: () => {} });
  await assert.rejects(empty.syncNow(), /Share the SOA folder \(Viewer\) with mr-you@/);
  await soa.syncNow({ force: true });
  assert.equal(downloads, 2);
  assert.equal((await soa.syncNow({ force: true })).same, 2, 'unchanged files are not read again');
  assert.equal(downloads, 2);
  const d = await inv.loadPage(db, { today: '2026-11-05' });
  assert.equal(d.soaMap['AA ALIVE'].overdue, 1102.78);
  assert.equal(d.soaMap.DUOPHARMA.overdue, 0);
  const duo = d.suppliers.find((s) => s.key === 'DUOPHARMA');
  assert.equal(duo.gate, 'soaok', 'After SOA check → open, nothing overdue');
  assert.equal(duo.status_label, 'Open (SOA clear)');
  assert.ok(!d.soaMap.MOMMYHANA, 'consignment not counted');
  // Page
  await db.query('UPDATE users SET password_hash = $1 WHERE username = $2', [bcrypt.hashSync('admin-pass-1', 4), 'admin']);
  const server = createApp(db, { now, inventorySoa: soa }).listen(0);
  try {
    const base = `http://localhost:${server.address().port}`;
    const login = await fetch(base + '/login/password', { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'username=admin&password=admin-pass-1' });
    const cookie = login.headers.get('set-cookie').split(';')[0];
    const html = await (await fetch(base + '/inventory', { headers: { cookie } })).text();
    assert.match(html, /Supplier SOA status/);
    assert.match(html, /RM1,103 overdue/);
    assert.match(html, /AA ALIVE SDN BHD/);
    assert.match(html, /Open \(SOA clear\)/);
    assert.match(html, /<details class="iv-soa-sub" id="soa">/, 'inside Can I order – not its own section');
    assert.doesNotMatch(html, /id="soa" open/);
    assert.match(html, /Supplier SOA folder/);
  } finally { server.close(); }
});

function soaXlsx() { return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'; }

test('5 Nov: lines not done on an earlier plan are brought forward (backlog) until ticked or on a newer plan', async () => {
  const base = await inv.loadPage(db, { today: '2026-11-05' });
  const old = base.todo.filter((t) => !t.backlog);
  assert.equal(base.plan.plan_date, '2026-11-03');
  const done = old.find((t) => /Hydrocyn Aqua 100ml/i.test(t.item));
  await db.query('UPDATE inv_plan_lines SET done_at = $2 WHERE id = $1', [done.id, new Date('2026-11-04T10:00:00+08:00')]);
  await inv.savePlan(db, { date: '2026-11-05', title: 'Mr Eve Daily Plan 05 Nov 2026', rows: [
    { Action: 'SECTION 1: URGENT', Item: '' },
    { Action: 'URGENT 1 - TRANSFER', Item: 'Panadol Regular Coated 10s (A) - NEW', 'Branches/short at': 'JH 0', 'Transfer from (qty)': 'BR 5', Supplier: 'Zuellig', 'Supplier status': 'OPEN NOW' },
    { Action: 'URGENT 2 - ORDER', Item: 'Brand new thing 10s', 'Branches/short at': 'WM 0', Supplier: 'Apex', 'Supplier status': 'OPEN NOW', 'Order qty': '2', 'Approx RM': '20' },
  ] });
  const d = await inv.loadPage(db, { today: '2026-11-05' });
  assert.equal(d.plan.plan_date, '2026-11-05');
  const back = d.todo.filter((t) => t.backlog);
  const key = (x) => x.toLowerCase().replace(/\([a-c]\)|-\s*new\b/g, ' ').replace(/[^a-z0-9]+/g, ' ').trim();
  const expect = new Set(old.filter((t) => t.id !== done.id && !/Panadol Regular Coated/i.test(t.item)).map((t) => key(t.item)));
  assert.equal(back.length, expect.size, 'all 3 Nov lines (one per item) except the one done and the one on today’s plan');
  assert.ok(back.every((t) => t.from_date === '2026-11-03'));
  assert.ok(!back.some((t) => /Panadol Regular Coated/i.test(t.item)), 'today’s plan has it');
  assert.equal(d.S.counts.backlog, back.length);
  // Ticked today → still shown (done); viewing the old day shows no backlog
  await inv.tick(db, { id: 1 }, back[0].id, true, { now });
  const d2 = await inv.loadPage(db, { today: '2026-11-05', view: 'backlog' });
  assert.ok(d2.shown.find((t) => t.id === back[0].id).done_at);
  assert.equal((await inv.loadPage(db, { today: '2026-11-05', date: '2026-11-03' })).todo.filter((t) => t.backlog).length, 0);
});
