// 5 Nov 2026: change requests #2 (BR neuropathy off) and #3 (OOS urgency Urgent / Soon / Routine).
const test = require('node:test');
const assert = require('node:assert/strict');

const { createDb } = require('../../src/db');
const { migrate } = require('../../src/db/migrate');
const { prepareDatabase } = require('../../src/db/setup');
const oos = require('../../src/oos/data');

process.env.ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin-pass-1';
let db;
const now = () => new Date('2026-11-05T15:00:00+08:00');

test.before(async () => {
  db = await createDb({ url: '', localDir: 'memory' });
  await migrate(db);
  await prepareDatabase(db, { log: () => {} });
});
test.after(async () => { await db.close(); });

test('#2: BR "New neuropathy customers" (NP, neuro) is retired, history kept', async () => {
  const m = (await db.query("SELECT m.active FROM measures m JOIN branches b ON b.id = m.branch_id WHERE b.code = 'BR' AND m.code = 'NP'")).rows;
  assert.ok(m.length && m.every((r) => !r.active));
  const f = (await db.query("SELECT f.active FROM daily_fields f JOIN branches b ON b.id = f.branch_id WHERE b.code = 'BR' AND f.key = 'neuro'")).rows;
  assert.ok(f.length && f.every((r) => !r.active));
  const pc = (await db.query("SELECT m.active FROM measures m JOIN branches b ON b.id = m.branch_id WHERE b.code = 'BR' AND m.code = 'N1'")).rows[0];
  assert.equal(pc.active, true, 'POCT lead stays');
});

test('#3: a report can be Urgent, Soon or Routine; legacy urgent=1 still works; the branch table changes it', async () => {
  const br = (await db.query("SELECT * FROM branches WHERE code = 'BR'")).rows[0];
  const user = (await db.query("SELECT * FROM users WHERE role = 'admin' LIMIT 1")).rows[0];
  const pids = (await db.query('SELECT id FROM products ORDER BY id LIMIT 3')).rows.map((x) => String(x.id));
  const mk = async (body) => { const r = await oos.report(db, user, br, { left: 'none', asking: '0', ...body }, { now }); assert.ok(r.id, JSON.stringify(r.errors)); return oos.loadItem(db, r.id); };
  const a = await mk({ product_id: pids[0], urgency: 'soon' });
  assert.deepEqual([a.urgency, a.urgent], ['soon', false]);
  const b = await mk({ product_id: pids[1], urgent: '1' });
  assert.deepEqual([b.urgency, b.urgent], ['urgent', true]);
  const c = await mk({ product_id: pids[2] });
  assert.equal(c.urgency, 'routine');
  assert.equal(oos.urgencyOf({ urgency: 'bogus' }), 'routine');
  const r = await oos.saveBranchTable(db, user, br, { r: { [`i${c.id}`]: { asking: '0', urgency: 'urgent' } } }, { now });
  assert.equal(r.saved, 1, JSON.stringify(r));
  const c2 = await oos.loadItem(db, c.id);
  assert.deepEqual([c2.urgency, c2.urgent], ['urgent', true]);
});

test('5 Nov flow: the CEO approves; Mr 4DX asks / marks Live through its log; answering sends it back; the queue sheet rows', async () => {
  const rq = require('../../src/requests/data');
  const { applyMr4dx } = require('../../src/requests/mr4dx');
  const { queueRows } = require('../../src/requests/queue');
  const ceo = (await db.query("SELECT * FROM users WHERE username = 'admin'")).rows[0];
  const staff = (await db.query("SELECT * FROM users WHERE role = 'branch_staff' AND active LIMIT 1")).rows[0];
  const a = await rq.create(db, staff, { title: 'Bigger buttons', area: 'Daily entry' }, { now });
  const b = await rq.create(db, ceo, { title: 'CEO idea', area: 'Other' }, { now });
  assert.equal(b.approved, true);
  assert.equal((await rq.load(db, b.id)).status, 'Approved', 'the CEO’s own request is approved at once');
  // Not approved yet → Mr 4DX can't mark it Live
  let out = await applyMr4dx(db, { entries: [{ id: a.id, live: 'done' }], now, log: () => {} });
  assert.match(out[0].skipped, /not approved/);
  assert.equal((await rq.load(db, a.id)).status, 'New');
  assert.deepEqual(rq.actionsFor(staff, await rq.load(db, a.id)), { comment: true, approve: false, reject: false });
  assert.equal((await rq.act(db, ceo, await rq.load(db, a.id), 'approve', '', { now })).ok, true);
  // Mr 4DX asks → Need more info; the asker answers → back to Approved
  await applyMr4dx(db, { entries: [{ id: a.id, ask: 'Which page – Daily entry or the week sheet?' }], now, log: () => {} });
  assert.equal((await rq.load(db, a.id)).status, 'Need more info');
  await rq.addNote(db, staff, await rq.load(db, a.id), 'Daily entry');
  assert.equal((await rq.load(db, a.id)).status, 'Approved');
  // The queue sheet lists approved requests first, with the conversation
  const rows = await queueRows(db, { now });
  assert.equal(rows[0][0], 'Status');
  assert.equal(rows[1][0], 'Approved');
  assert.match(rows.find((r) => r[1] === a.id)[8], /Which page[\s\S]*Daily entry/);
  // Live once, with what changed
  out = await applyMr4dx(db, { entries: [{ id: a.id, live: 'Buttons are bigger', commit: 'abc1234' }], now, log: () => {} });
  assert.equal(out[0].ok, true);
  const r = await rq.load(db, a.id);
  assert.equal(r.status, 'Live'); assert.ok(r.live_at);
  assert.match(r.notes.at(-1).body, /Buttons are bigger \(abc1234\)/);
  assert.equal((await applyMr4dx(db, { entries: [{ id: a.id, live: 'Buttons are bigger', commit: 'abc1234' }], now, log: () => {} })).length, 0, 'applied once');
  // The real log is valid JSON with ids and text
  const real = require('../../src/requests/mr4dx').readLog();
  assert.ok(real.length >= 2 && real.every((e) => Number.isInteger(e.id) && (e.live || e.ask)));
});

test('the queue sheet is rewritten through the Sheets API (RAW, A:K)', async () => {
  const crypto = require('crypto');
  const { createRequestQueue } = require('../../src/requests/queue');
  const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 1024 });
  const account = { email: 'sa@x.iam.gserviceaccount.com', privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }) };
  const calls = [];
  const fetchImpl = async (url, opts = {}) => {
    calls.push({ url, method: opts.method || 'GET', body: opts.body });
    const body = url.includes('oauth2') ? { access_token: 't' } : url.includes('fields=sheets') ? { sheets: [{ properties: { title: 'Sheet1' } }] } : {};
    return { ok: true, status: 200, json: async () => body };
  };
  const q = createRequestQueue(db, { account, fetchImpl, now, log: () => {} });
  const r = await q.syncNow();
  assert.ok(r.ok && r.rows >= 2);
  const put = calls.find((c) => c.method === 'PUT');
  assert.match(put.url, /valueInputOption=RAW/);
  assert.equal(JSON.parse(put.body).values[0][2], 'What to change');
});

test('5 Nov (CEO): Ampang activities – PWP 3, In-house 2, Beecrobes 2, Loose 2, Short-expiry 1, POCT 1, in that order', async () => {
  const rows = (await db.query(`SELECT m.code, m.label, t.target FROM measures m JOIN branches b ON b.id = m.branch_id
      JOIN measure_targets t ON t.measure_id = m.id AND t.month = '2026-11'
    WHERE b.code = 'Ampang' AND m.active AND m.code IN ('T2','P1','P2','P5','P6','P7','P8','P9') ORDER BY m.sort_order`)).rows;
  assert.deepEqual(rows.map((r) => [r.label, Number(r.target)]), [
    ['PWP units sold', 3], ['Target product: In-house products', 2], ['Target product: Beecrobes', 2],
    ['Target product: Loose supplements', 2], ['Target product: Short-expiry products', 1], ['Target product: POCT', 1]]);
  const oct = (await db.query(`SELECT t.target FROM measures m JOIN branches b ON b.id = m.branch_id JOIN measure_targets t ON t.measure_id = m.id
    WHERE b.code = 'Ampang' AND m.code = 'T2' AND t.month = '2026-10'`)).rows[0];
  assert.equal(Number(oct.target), 5, 'October kept');
  const boxes = (await db.query(`SELECT f.key FROM daily_fields f JOIN branches b ON b.id = f.branch_id
    WHERE b.code = 'Ampang' AND f.active AND f.key IN ('pwp','p1','p2','p5','p6','p7','p8','p9') ORDER BY f.sort_order`)).rows.map((r) => r.key);
  assert.deepEqual(boxes, ['pwp', 'p8', 'p5', 'p6', 'p7', 'p9']);
});

test('8 Nov (CEO): Hafiz – BN lead measures off, one box for BN pieces sold (no target); RM boxes kept', async () => {
  const q = async (sql) => (await db.query(sql)).rows;
  const ms = await q(`SELECT m.code, m.active, m.label, m.owner_name FROM measures m JOIN branches b ON b.id = m.branch_id
    WHERE b.code = 'Bangi' AND m.code IN ('H0','H2','H3','H4','H5','H6','H7') ORDER BY m.code`);
  const act = Object.fromEntries(ms.map((m) => [m.code, m.active]));
  assert.deepEqual(act, { H0: true, H2: true, H3: true, H4: false, H5: false, H6: true, H7: true });
  const h7 = ms.find((m) => m.code === 'H7');
  assert.equal(h7.label, 'BN products sold (pieces)'); assert.equal(h7.owner_name, 'Hafiz');
  const t = await q(`SELECT t.target FROM measure_targets t JOIN measures m ON m.id = t.measure_id JOIN branches b ON b.id = m.branch_id
    WHERE b.code = 'Bangi' AND m.code = 'H7' AND t.month = '2026-11'`);
  assert.ok(!t.length || t[0].target == null, 'track only');
  const f = await q(`SELECT f.key, f.active, p.name FROM daily_fields f JOIN branches b ON b.id = f.branch_id LEFT JOIN people p ON p.id = f.person_id
    WHERE b.code = 'Bangi' AND f.key IN ('biop','bnchk','bnpcs')`);
  assert.deepEqual(Object.fromEntries(f.map((r) => [r.key, [r.active, r.name]])), { biop: [false, 'Hafiz'], bnchk: [false, 'Hafiz'], bnpcs: [true, 'Hafiz'] });
});

test('9 Nov (CEO, Hafizah’s list): WM target products – Proponeem soap, Beecrobes, Biorelief, Digezmune, RM10 health screening, 2 a day', async () => {
  const rows = (await db.query(`SELECT m.code, m.label, t.target FROM measures m JOIN branches b ON b.id = m.branch_id
      JOIN measure_targets t ON t.measure_id = m.id AND t.month = '2026-11'
    WHERE b.code = 'WM' AND m.active AND m.code IN ('P1','P2','P3','P4','P5','P6','P7') ORDER BY m.sort_order`)).rows;
  assert.deepEqual(rows.map((r) => [r.label, Number(r.target)]), [
    ['Target product: Proponeem soap', 2], ['Target product: Beecrobes', 2], ['Target product: Biorelief', 2],
    ['Target product: Digezmune', 2], ['Target product: RM10 health screening promo', 2]]);
  const boxes = (await db.query(`SELECT f.key FROM daily_fields f JOIN branches b ON b.id = f.branch_id
    WHERE b.code = 'WM' AND f.active AND f.key IN ('p1','p2','p3','p4','p5','p6','p7') ORDER BY f.sort_order`)).rows.map((r) => r.key);
  assert.deepEqual(boxes, ['p1', 'p5', 'p2', 'p6', 'p7']);
});
