// 3 Nov 2026: Zakat claims tracker for BR, WM, JH (/zakat).
const test = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');

const { createDb } = require('../../src/db');
const { migrate } = require('../../src/db/migrate');
const { readSeed, loadSeed } = require('../../src/db/seed');
const { createApp } = require('../../src/app');
const zk = require('../../src/zakat/data');
const calc = require('../../src/calc');

let db; let server; let base; let bangiUser;
const now = () => new Date('2026-11-03T15:00:00+08:00');

test.before(async () => {
  db = await createDb({ url: '', localDir: 'memory' });
  await migrate(db);
  await loadSeed(db, readSeed(), { adminPassword: 'admin-pass-1' });
  await zk.setupOnce(db);
  const pw = (u, v) => db.query('UPDATE users SET password_hash = $1 WHERE username = $2', [bcrypt.hashSync(v, 4), u]);
  const pin = (u, v) => db.query('UPDATE users SET pin_hash = $1 WHERE username = $2', [bcrypt.hashSync(v, 4), u]);
  await pw('hafizah', 'manager-pass-1'); await pin('zawiyah', '2468'); await pw('admin', 'admin-pass-1');
  bangiUser = (await db.query("SELECT u.username FROM users u JOIN branches b ON b.id = u.branch_id WHERE b.code = 'Bangi' AND u.role = 'branch_staff' LIMIT 1")).rows[0].username;
  await pin(bangiUser, '1357');
  server = createApp(db, { now }).listen(0);
  base = `http://localhost:${server.address().port}`;
});
test.after(async () => { server.close(); await db.close(); });
const msg = (r) => { const u = new URL('http://x' + r.location); return u.searchParams.get('err') || u.searchParams.get('ok') || ''; };

async function login(kind, username, secret) {
  let cookie = '';
  const req = async (method, p, body) => {
    const r = await fetch(base + p, { method, redirect: 'manual',
      headers: { ...(cookie ? { cookie } : {}), ...(body ? { 'content-type': 'application/x-www-form-urlencoded' } : {}) },
      body: body ? new URLSearchParams(body).toString() : undefined });
    const set = r.headers.get('set-cookie'); if (set) cookie = set.split(';')[0];
    return { status: r.status, location: r.headers.get('location'), html: await r.text() };
  };
  const r = await req('POST', kind === 'pin' ? '/login/pin' : '/login/password', kind === 'pin' ? { username, pin: secret } : { username, password: secret });
  assert.equal(r.status, 302, `${username} logs in`);
  let csrf = null;
  return {
    get: (p) => req('GET', p),
    post: async (p, body) => {
      if (!csrf) csrf = ((await req('GET', '/daily')).html.match(/name="_csrf" value="([^"]+)"/) || [])[1];
      return req('POST', p, { _csrf: csrf, ...body });
    },
  };
}

test('set up once: ZC1–ZC3 per branch, hidden boxes, old zakat leads retired, amount to claim = zakat sales target', async () => {
  const q = async (code, sql) => (await db.query(sql.replace('$B', `(SELECT id FROM branches WHERE code = '${code}')`))).rows;
  for (const code of ['BR', 'WM', 'JH']) {
    const ms = await q(code, "SELECT code, kind, active, owner_name FROM measures WHERE branch_id = $B AND code LIKE 'ZC%' ORDER BY code");
    assert.deepEqual(ms.map((m) => [m.code, m.kind, m.active]), [['ZC1', 'Lead', true], ['ZC2', 'Stream', true], ['ZC3', 'Routine', true]]);
    const f = await q(code, "SELECT key, active FROM daily_fields WHERE branch_id = $B AND key IN ('zclaim', 'zpaid', 'zbid', 'zwon')");
    assert.equal(f.length, 4); assert.ok(f.every((x) => !x.active), 'not on Daily entry');
  }
  assert.equal((await q('BR', "SELECT owner_name FROM measures WHERE branch_id = $B AND code = 'ZC1'"))[0].owner_name, 'Alya');
  assert.equal((await q('WM', "SELECT owner_name FROM measures WHERE branch_id = $B AND code = 'ZC1'"))[0].owner_name, 'Zawiyah');
  const old = await q('BR', "SELECT code, active FROM measures WHERE branch_id = $B AND code IN ('A6', 'A7')");
  assert.ok(old.length === 2 && old.every((m) => !m.active));
  assert.equal((await q('JH', "SELECT active FROM measures WHERE branch_id = $B AND code = 'F6'"))[0].active, false);
  assert.equal((await q('WM', "SELECT active FROM daily_fields WHERE branch_id = $B AND key = 'zkc'"))[0].active, false);
  const t = await q('WM', "SELECT t.target FROM measure_targets t JOIN measures m ON m.id = t.measure_id WHERE m.branch_id = $B AND m.code = 'ZC1' AND t.month = '2026-11'");
  assert.equal(Number(t[0].target), 20000);
  await zk.setupOnce(db);
  assert.equal((await q('WM', "SELECT count(*)::int AS n FROM measures WHERE branch_id = $B AND code LIKE 'ZC%'"))[0].n, 3, 'only once');
});

test('the running totals match the CEO page: carried unclaimed and owed', () => {
  const tl = zk.timeline({ '2026-10': 10000, '2026-11': 12000 },
    { '2026-10-12': { zclaim: 4000, zpaid: 0, zbid: 3, zwon: 1 }, '2026-10-19': { zclaim: 3000, zpaid: 2000, zbid: 0, zwon: 0 }, '2026-11-02': { zclaim: 5000, zpaid: 4000, zbid: 2, zwon: 2 } },
    { month: '2026-11', today: '2026-11-03' });
  const nov = tl.byKey['2026-11'];
  assert.equal(nov.carriedUnclaimed, 3000); assert.equal(nov.carriedOwed, 5000);
  assert.equal(nov.unclaimedEnd, 10000); assert.equal(nov.owedEnd, 6000);
  assert.equal(tl.byKey['2026-10'].bids, 3);
});

test('Zawiyah keys in a week → scoreboard measures; manager sets the amount to claim; suppliers', async () => {
  const z = await login('pin', 'zawiyah', '2468');
  const page = await z.get('/zakat');
  assert.equal(page.status, 200);
  assert.match(page.html, /Zakat claims – WM/);
  assert.doesNotMatch(page.html, /name="target"/, 'staff don’t set the amount to claim');
  assert.match(page.html, /href="\/zakat"/, 'in her menu');
  let r = await z.post('/zakat/week', { branch: 'WM', week: '2026-11-04', claimed: '3,500.50', paid: '1200', bids: '4', won: '5' });
  assert.match(msg(r), /can’t be more than/);
  r = await z.post('/zakat/week', { branch: 'JH', week: '2026-11-04', claimed: '3500.50', paid: '1200', bids: '4', won: '1' });
  assert.equal(r.status, 303);
  const rows = (await db.query("SELECT b.code, e.entry_date::text AS d, e.field_key, e.value FROM daily_entries e JOIN branches b ON b.id = e.branch_id WHERE e.field_key LIKE 'z%' AND e.field_key NOT IN ('zakat', 'zchk') ORDER BY e.field_key")).rows;
  assert.ok(rows.every((x) => x.code === 'WM' && x.d === '2026-11-02'), 'her own branch, on the Monday');
  assert.deepEqual(rows.map((x) => [x.field_key, Number(x.value)]), [['zbid', 4], ['zclaim', 3500.5], ['zpaid', 1200], ['zwon', 1]]);
  // Too old for staff, future refused
  assert.match(msg(await z.post('/zakat/week', { week: '2026-08-03', claimed: '1' })), /older than 8 weeks/);
  assert.match(msg(await z.post('/zakat/week', { week: '2026-11-09', claimed: '1' })), /hasn’t started/);
  // ZC1 on the scoreboard: measure evaluated from the entries
  const wm = (await db.query("SELECT id FROM branches WHERE code = 'WM'")).rows[0];
  const m = (await db.query("SELECT * FROM measures WHERE branch_id = $1 AND code = 'ZC1'", [wm.id])).rows[0];
  assert.equal(m.numerator_field, 'zclaim');
  // Manager sets the amount to claim
  const h = await login('password', 'hafizah', 'manager-pass-1');
  assert.match((await h.get('/zakat?month=2026-11')).html, /name="target"/);
  r = await h.post('/zakat/target', { month: '2026-11', target: '15000' });
  assert.equal(r.status, 303);
  const tr = await zk.loadTracker(db, { id: wm.id, code: 'WM' }, { month: '2026-11', today: '2026-11-03' });
  assert.equal(tr.row.target, 15000); assert.equal(tr.row.claimed, 3500.5); assert.equal(tr.row.paid, 1200);
  const ov = (await h.get('/zakat?month=2026-11')).html;
  assert.match(ov, /23% claimed/); assert.match(ov, /RM 11,499.50/, 'left to claim');
  // Suppliers
  r = await z.post('/zakat/suppliers', { branch: 'WM', name1: 'Zuellig Pharma', n1: '3', name2: 'DKSH', n2: '2' });
  assert.equal(r.status, 303);
  const sup = (await z.get('/zakat?tab=suppliers')).html;
  assert.match(sup, /value="Zuellig Pharma"/); assert.match(sup, /across 2 suppliers/);
  assert.match((await z.get('/zakat')).html, /5 contracts affected/);
  // Delete the week
  await z.post('/zakat/week/delete', { week: '2026-11-02' });
  assert.equal((await db.query("SELECT count(*)::int AS n FROM daily_entries WHERE field_key IN ('zclaim', 'zpaid', 'zbid', 'zwon')")).rows[0].n, 0);
  const audit = (await db.query("SELECT count(*)::int AS n FROM audit_log WHERE table_name = 'zakat_tracker'")).rows[0].n;
  assert.ok(audit >= 4);
});

test('who: Bangi has no tracker; admin picks the branch', async () => {
  const b = await login('pin', bangiUser, '1357');
  assert.equal((await b.get('/zakat')).status, 403);
  const a = await login('password', 'admin', 'admin-pass-1');
  const p = await a.get('/zakat?branch=JH&tab=weekly');
  assert.equal(p.status, 200); assert.match(p.html, /Zakat claims – JH/); assert.match(p.html, /Add or update a week/);
  assert.equal(calc.weekStart('2026-11-08'), '2026-11-02');
});

test('weekly check-in: the PIC sees it in Needs you until last week is saved (0 is fine); the manager when late', async () => {
  const z = await login('pin', 'zawiyah', '2468');
  const h = await login('password', 'hafizah', 'manager-pass-1');
  let page = (await z.get('/zakat')).html;
  assert.match(page, /Zakat weekly check-in/, 'Needs you (Tuesday = late)');
  assert.match(page, /⚠ Late – Update the week of Mon 26 Oct/);
  assert.match(page, /PIC Zawiyah/);
  assert.match((await z.get('/zakat?tab=weekly')).html, /name="week" value="2026-10-26"/, 'the form opens on last week');
  assert.match((await h.get('/zakat')).html, /Zakat check-in not done \(Zawiyah\)/);
  const r = await z.post('/zakat/week', { week: '2026-10-26', claimed: '', paid: '', bids: '', won: '' });
  assert.equal(r.status, 303);
  page = (await z.get('/zakat')).html;
  assert.doesNotMatch(page, /Zakat weekly check-in/);
  assert.match(page, /✔ Week of Mon 26 Oct updated/);
  assert.doesNotMatch((await h.get('/zakat')).html, /Zakat check-in not done/);
});
