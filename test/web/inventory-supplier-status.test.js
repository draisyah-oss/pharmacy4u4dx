// 5 Nov 2026: Mr Eve's "Supplier_Status (from SOA)" sheet shown in Can I order from this supplier?
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');

const { createDb } = require('../../src/db');
const { migrate } = require('../../src/db/migrate');
const { readSeed, loadSeed } = require('../../src/db/seed');
const { createApp } = require('../../src/app');
const inv = require('../../src/inventory/data');
const ss = require('../../src/inventory/supplier-status');
const { csvToRows } = require('../../src/inventory/drive');

let db;
const now = () => new Date('2026-11-05T10:00:00+08:00');

test.before(async () => {
  db = await createDb({ url: '', localDir: 'memory' });
  await migrate(db);
  await loadSeed(db, readSeed(), { adminPassword: 'admin-pass-1' });
  await inv.loadBundledOnce(db);
  await inv.loadBudgetUpdateOnce(db);
});
test.after(async () => { await db.close(); });

const HEAD = 'Supplier,Suggested status,Can order now?,Unpaid RM,Overdue RM,Due 5-19 Nov RM,Not yet due RM,Oldest overdue due date,Payment_Approvals line,Note,SOA file,SOA read on';
const CSV = `${HEAD}
Eldon,OPEN,Yes,2708.4,0,0,2708.4,,None,No overdue. Only Oct invoices open.,https://drive.google.com/file/d/E/view,2026-11-05
DKSH (103),OPEN,Yes,107.77,0,0,107.77,,"RM1,000 on 19 Nov",Only RM107.77 left.,https://x/103,2026-11-05
Zuellig Pharma,AFTER PAYMENT (~13 Nov),No,176208.1,119630.91,860.33,55716.86,2026-09-05,"RM41,000 5 Nov + RM71,000 12 Nov",SOA overdue vs plan gap RM3669.,https://x/z,2026-11-05
DKSH (104),AFTER PAYMENT (19 Nov),No,58692.69,58692.69,0,0,2026-08-16,"RM55,023.25 on 19 Nov",30-day terms.,https://x/104,2026-11-05
Apex,ON HOLD,No,57541.18,20586.25,0,36954.93,2026-10-02,None,Needs approval line.,https://x/a,2026-11-05
Tongee,CHECK,Check first,2546.23,2546.23,0,0,2026-08-16,"RM10,237.62 on 19 Nov",Two SOA files disagree.,https://x/t,2026-11-05
NOTE,Suggested by Mr Eve from SOAs on 5 Nov 2026.,,,,,,,,,,`;

test('rows: NOTE skipped, numbers read, DKSH (103) and (104) keep their own budget keys', () => {
  const rows = ss.parseStatusRows(csvToRows(CSV));
  assert.deepEqual(rows.map((r) => r.key), ['ELDON', 'DKSH 103', 'ZUELLIG', 'DKSH', 'APEX', 'TONGEE']);
  const z = rows.find((r) => r.key === 'ZUELLIG');
  assert.equal(z.overdue, 119630.91); assert.equal(z.gate, 'wait'); assert.equal(z.plan_line, 'RM41,000 5 Nov + RM71,000 12 Nov');
  assert.deepEqual(rows.map((r) => r.gate), ['open', 'open', 'wait', 'wait', 'hold', 'check']);
  assert.equal(rows[0].oldest_overdue, null);
});

test('sync picks the newest sheet, skips an unchanged one, and the page shows his suggestion without moving the gate', async () => {
  const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 1024 });
  const account = { email: 'mr-you@p4u.iam.gserviceaccount.com', privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }) };
  let exports = 0;
  const fetchImpl = async (url) => {
    const u = new URL(url);
    const json = (code, body) => ({ ok: code < 400, status: code, json: async () => body });
    if (u.host === 'oauth2.googleapis.com') return json(200, { access_token: 't' });
    if (u.pathname === '/drive/v3/files') {
      return json(200, { files: [
        { id: 'OLD', name: 'Supplier_Status (from SOA) 04 Nov 2026', modifiedTime: '2026-11-04T01:00:00Z' },
        { id: 'NEW', name: 'Supplier_Status (from SOA) 05 Nov 2026', modifiedTime: '2026-11-05T01:53:21Z' },
        { id: 'OTHER', name: 'Mr Eve Daily Plan 05 Nov 2026', modifiedTime: '2026-11-05T02:00:00Z' },
      ] });
    }
    if (u.pathname === '/drive/v3/files/NEW/export') { exports++; return { ok: true, status: 200, text: async () => CSV }; }
    return json(404, { error: { message: 'wrong file' } });
  };
  const sync = ss.createSupplierStatusSync(db, { account, fetchImpl, now, log: () => {} });
  const r = await sync.syncNow();
  assert.deepEqual([r.file, r.suppliers], ['Supplier_Status (from SOA) 05 Nov 2026', 6]);
  assert.equal((await sync.syncNow({ force: true })).unchanged, true);
  assert.equal(exports, 1, 'unchanged sheet is not downloaded again');

  const d = await inv.loadPage(db, { today: '2026-11-05' });
  const z = d.suppliers.find((s) => s.key === 'ZUELLIG');
  assert.equal(z.mreve.status, 'AFTER PAYMENT (~13 Nov)');
  const apex = d.suppliers.find((s) => s.key === 'APEX');
  assert.equal(apex.mreve.gate, 'hold');
  assert.equal(d.suppliers.find((s) => s.key === 'DKSH 103').mreve.can_order, 'Yes');
  const before = d.suppliers.find((s) => s.key === 'ELDON').gate;
  assert.ok(before, 'our own gate is unchanged by his sheet');
  assert.equal(d.mreve.read_on, '2026-11-05');

  await db.query('UPDATE users SET password_hash = $1 WHERE username = $2', [bcrypt.hashSync('admin-pass-1', 4), 'admin']);
  const server = createApp(db, { now, supplierStatus: sync }).listen(0);
  try {
    const base = `http://localhost:${server.address().port}`;
    const login = await fetch(base + '/login/password', { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'username=admin&password=admin-pass-1' });
    const cookie = login.headers.get('set-cookie').split(';')[0];
    const html = await (await fetch(base + '/inventory', { headers: { cookie } })).text();
    assert.match(html, /Mr Eve’s SOA check/);
    assert.match(html, /AFTER PAYMENT \(~13 Nov\)/);
    assert.match(html, /RM119,631 overdue/);
    assert.match(html, /Supplier_Status \(from SOA\) 05 Nov 2026/);
  } finally { server.close(); }
});
