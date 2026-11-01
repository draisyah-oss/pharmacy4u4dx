// 1 Nov 2026 (CEO): Monthly Performance Review – first Monday of the month. Branch review (managers),
// HQ review (HQ people), one shared conclusion for the next month (HQ + managers agree, CEO locks).
const test = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');

const { createDb } = require('../../src/db');
const { migrate } = require('../../src/db/migrate');
const { readSeed, loadSeed } = require('../../src/db/seed');
const { createApp } = require('../../src/app');
const rv = require('../../src/review/data');
const calc = require('../../src/calc');

let db; let server; let base;
// Monday 2 Nov 2026, 9 am – the first monthly review (October).
const clock = new Date('2026-11-02T09:00:00+08:00');
const now = () => clock;

test.before(async () => {
  db = await createDb({ url: '', localDir: 'memory' });
  await migrate(db);
  await loadSeed(db, readSeed(), { adminPassword: 'admin-pass-1' });
  const pw = (u, v) => db.query('UPDATE users SET password_hash = $1 WHERE username = $2', [bcrypt.hashSync(v, 4), u]);
  await pw('alia', 'alia-pass-1'); await pw('hanin', 'hanin-pass-1'); await pw('hafizah', 'manager-pass-1'); await pw('afifah', 'manager-pass-2');
  await db.query('UPDATE users SET pin_hash = $1 WHERE username = $2', [bcrypt.hashSync('1111', 4), 'hazera']);
  server = createApp(db, { now }).listen(0);
  base = `http://localhost:${server.address().port}`;
});
test.after(async () => { server.close(); await db.close(); });

async function login(kind, username, secret) {
  let cookie = '';
  const req = async (method, p, body) => {
    const r = await fetch(base + p, {
      method, redirect: 'manual',
      headers: { ...(cookie ? { cookie } : {}), ...(body ? { 'content-type': 'application/x-www-form-urlencoded' } : {}) },
      body: body ? new URLSearchParams(body).toString() : undefined,
    });
    const set = r.headers.get('set-cookie'); if (set) cookie = set.split(';')[0];
    return { status: r.status, location: r.headers.get('location'), html: await r.text() };
  };
  const r = await req('POST', kind === 'pin' ? '/login/pin' : '/login/password', kind === 'pin' ? { username, pin: secret } : { username, password: secret });
  assert.equal(r.status, 302, `${username} logs in`);
  let csrf = null;
  return {
    get: (p) => req('GET', p),
    post: async (p, body) => {
      if (!csrf) csrf = ((await req('GET', '/review')).html.match(/name="_csrf" value="([^"]+)"/) || (await req('GET', '/my-week')).html.match(/name="_csrf" value="([^"]+)"/) || [])[1];
      return req('POST', p, { _csrf: csrf, ...body });
    },
  };
}
const manager = () => login('password', 'hafizah', 'manager-pass-1');
const alia = () => login('password', 'alia', 'alia-pass-1');
const hanin = () => login('password', 'hanin', 'hanin-pass-1');
const admin = () => login('password', 'admin', 'admin-pass-1');

test('October numbers are worked out for the month: sales incl. 1–11 Oct, each measure from the daily rows', async () => {
  const branch = (await db.query("SELECT * FROM branches WHERE code = 'WM'")).rows[0];
  for (const [d, v] of [['2026-10-12', 1500], ['2026-10-20', 2500], ['2026-10-31', 1000]]) {
    await db.query("INSERT INTO daily_entries (branch_id, entry_date, field_key, value) VALUES ($1, $2, 'walkin', $3)", [branch.id, d, v]);
  }
  const m = await rv.branchMonth(db, { branch, month: '2026-10', today: '2026-11-02', trackerStart: '2026-10-12' });
  assert.equal(m.from, '2026-10-12');
  assert.equal(m.to, '2026-10-31');
  const base0 = Number((await db.query('SELECT sales_before_start FROM branch_baselines WHERE branch_id = $1', [branch.id])).rows[0].sales_before_start);
  assert.equal(m.sales.actual, base0 + 5000);
  assert.ok(m.sales.complete);
  const t1 = m.rows.find((r) => r.code === 'T1');
  assert.ok(t1, 'walk-in WIG listed');
  assert.match(t1.actual, /5,000/);
  assert.match(t1.href, /from=2026-10-12&to=2026-10-31/);
  assert.equal(m.next.month, '2026-11');
  assert.ok(m.next.target > 0);
  assert.ok(Math.abs(m.next.perDay - m.next.target / 30) < 1e-6);
  assert.equal(rv.firstMonday('2026-11'), '2026-11-02');
  assert.equal(rv.firstMonday('2026-12'), '2026-12-07');
  assert.equal(rv.defaultMonth('2026-11-02', '2026-10-12'), '2026-10');
  assert.equal(calc.monthOf('2026-11-02'), '2026-11');
});

test('manager: Needs you, fills in the branch review, sends it; can’t open another branch; staff can’t', async () => {
  const mgr = await manager();
  let page = await mgr.get('/review/branch');
  assert.equal(page.status, 200);
  assert.match(page.html, /Monthly review – October/, 'Needs you line');
  assert.match(page.html, /White Mosque|WM|Wangsa/);
  assert.match(page.html, /Can we hit November\?/);
  assert.match(page.html, /Copy as a table for Google Sheets/);
  const ref = page.html.match(/name="imp\[(m_\d+)\]"/)[1];
  const r = await mgr.post('/review/branch', { branch: 'WM', month: '2026-10', can_hit: 'At risk', plan: 'Two PWP offers a day each', stop: 'Late closing log', start: 'Min/max check Monday', keep: 'Google review ask', needs: 'Stock for Shine', [`imp[${ref}]`]: 'Ask every customer about 3+ items', 'imp[oos]': 'Report before it runs out', submit: '1' });
  assert.equal(r.status, 302);
  assert.match(r.location, /ok=submitted/);
  page = await mgr.get('/review/branch?month=2026-10');
  assert.match(page.html, /Ask every customer about 3\+ items/);
  assert.match(page.html, /Report before it runs out/);
  assert.match(page.html, /value="At risk" checked/);
  assert.doesNotMatch(page.html, /Monthly review – October<\/b>|Monthly review – October</, 'Needs you line gone once sent');
  const other = await mgr.get('/review/branch?branch=JH');
  assert.doesNotMatch(other.html, /name="branch" value="JH"/, 'managers only see their own branch');
  const bad = await mgr.post('/review/branch', { branch: 'WM', month: '2026-10', plan: 'Bayar gaji dulu' });
  assert.equal(bad.status, 200);
  assert.match(bad.html, /Not saved/);
  const staff = await login('pin', 'hazera', '1111');
  assert.equal((await staff.get('/review/branch')).status, 403);
  // The hub shows WM as sent.
  const hub = await (await admin()).get('/review');
  assert.match(hub.html, /<b>WM<\/b>[\s\S]{0,200}Sent/);
});

test('HQ review: each person their own measures; HQ staff can’t write for someone else', async () => {
  const a = await alia();
  const page = await a.get('/review/hq');
  assert.equal(page.status, 200);
  const aliaId = (await db.query("SELECT id FROM people WHERE name = 'Alia' AND branch_id IS NULL")).rows[0].id;
  const haninId = (await db.query("SELECT id FROM people WHERE name = 'Hanin' AND branch_id IS NULL")).rows[0].id;
  assert.match(page.html, new RegExp(`id="p${aliaId}"`));
  const ok = await a.post('/review/hq', { month: '2026-10', person: String(aliaId), focus: 'Payment plan with Azwani by 15 Nov', submit: '1' });
  assert.equal(ok.status, 302);
  const no = await a.post('/review/hq', { month: '2026-10', person: String(haninId), focus: 'x' });
  assert.equal(no.status, 403);
  const c = await a.get('/review/conclusion');
  assert.match(c.html, /Payment plan with Azwani by 15 Nov/);
});

test('conclusion: seeded November goals, HQ and managers agree, the CEO locks; goals show on My page and HQ day', async () => {
  const a = await alia();
  let page = await a.get('/review/conclusion?month=2026-10');
  assert.match(page.html, /Hit the November target/);
  assert.match(page.html, /Out of stock down to 5%/);
  assert.match(page.html, /Supplier payment plan/);
  assert.match(page.html, /zakat workflow/i);
  let r = await a.post('/review/conclusion', { month: '2026-10', 'agree_hq[s1]': '1', 'agree_hq[s2]': '1' });
  assert.match(r.location, /ok=saved/);
  const mgr = await manager();
  r = await mgr.post('/review/conclusion', { month: '2026-10', 'agree_mgr[s1]': '1' });
  assert.match(r.location, /ok=saved/);
  let g = await rv.loadGoals(db, '2026-11');
  assert.ok(g.goals[0].hq_agreed_at && g.goals[0].mgr_agreed_at);
  assert.ok(g.goals[1].hq_agreed_at && !g.goals[1].mgr_agreed_at);
  assert.equal(g.agreedBoth, 1);
  // Managers can't edit goal text; Hanin (hq) can't lock.
  await mgr.post('/review/conclusion', { month: '2026-10', 'g[s1][title]': 'Changed by manager' });
  const h = await hanin();
  await h.post('/review/conclusion', { month: '2026-10', lock: '1' });
  g = await rv.loadGoals(db, '2026-11');
  assert.equal(g.goals[0].title, 'Hit the November target');
  assert.equal(g.locked, false);
  // The CEO locks.
  const ceo = await admin();
  page = await ceo.get('/review/conclusion?month=2026-10');
  assert.match(page.html, /Lock anyway/);
  r = await ceo.post('/review/conclusion', { month: '2026-10', lock: '1' });
  assert.match(r.location, /ok=locked/);
  r = await mgr.post('/review/conclusion', { month: '2026-10', 'agree_mgr[s2]': '1' });
  assert.match(r.location, /err=/, 'locked: no more changes');
  const home = await mgr.get('/');
  assert.match(home.html, /November goals/);
  assert.match(home.html, /Agreed/);
  const day = await a.get('/hq/today');
  assert.match(day.html, /November goals/);
});
