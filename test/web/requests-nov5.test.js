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
