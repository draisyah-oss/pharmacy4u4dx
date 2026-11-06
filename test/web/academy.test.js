// Academy (trial): every logged-in role sees the tab; staff go cards → quiz → role-play →
// challenge; the branch manager verifies; XP follows the rules; peers' scores stay private.

const test = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');

const { createDb } = require('../../src/db');
const { migrate } = require('../../src/db/migrate');
const { readSeed, loadSeed } = require('../../src/db/seed');
const { createApp } = require('../../src/app');

let db; let server; let base; let staff; let manager; let otherStaff;

test.before(async () => {
  db = await createDb({ url: '', localDir: 'memory' });
  await migrate(db);
  await loadSeed(db, readSeed(), { adminPassword: 'admin-pass-1' });
  const mgr = (await db.query("SELECT username, branch_id FROM users WHERE role = 'branch_manager' ORDER BY id LIMIT 1")).rows[0];
  const same = (await db.query("SELECT username FROM users WHERE role = 'branch_staff' AND branch_id = $1 ORDER BY id LIMIT 1", [mgr.branch_id])).rows[0];
  const other = (await db.query("SELECT username FROM users WHERE role = 'branch_staff' AND branch_id <> $1 ORDER BY id LIMIT 1", [mgr.branch_id])).rows[0];
  const set = (u, col, v) => db.query(`UPDATE users SET ${col} = $1 WHERE username = $2`, [bcrypt.hashSync(v, 4), u]);
  await set(mgr.username, 'password_hash', 'manager-pass-1');
  await set(same.username, 'pin_hash', '1111');
  await set(other.username, 'pin_hash', '2222');
  staff = same.username; manager = mgr.username; otherStaff = other.username;
  server = createApp(db, { now: () => new Date('2026-11-16T09:00:00+08:00') }).listen(0);
  base = `http://localhost:${server.address().port}`;
});
test.after(async () => { server.close(); await db.close(); });

async function session(path, form) {
  const res = await fetch(base + path, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(form).toString() });
  assert.equal(res.status, 302, 'login');
  const cookie = res.headers.get('set-cookie').split(';')[0];
  const get = (p) => fetch(base + p, { redirect: 'manual', headers: { cookie } });
  const post = async (p, body) => {
    const page = await (await get('/academy?skip=1')).text();
    const csrf = page.match(/name="_csrf" value="([^"]+)"/)?.[1] || (await (await get('/daily')).text()).match(/name="_csrf" value="([^"]+)"/)[1];
    return fetch(base + p, { method: 'POST', redirect: 'manual', headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' }, body: encode({ _csrf: csrf, ...body }) });
  };
  return { get, post };
}
const asStaff = () => session('/login/pin', { username: staff, pin: '1111' });
const asManager = () => session('/login/password', { username: manager, password: 'manager-pass-1' });
const encode = (o) => { const p = new URLSearchParams(); for (const [k, v] of Object.entries(o)) (Array.isArray(v) ? v : [v]).forEach((x) => p.append(k, x)); return p.toString(); };
const menuHasAcademy = (html) => /<aside class="sidenav"[\s\S]*?<a href="\/academy" class="sn-link/.test(html);

test('logged-out visitors are sent to login', async () => {
  const res = await fetch(base + '/academy', { redirect: 'manual' });
  assert.equal(res.status, 302);
});

test('every role has Academy in the side menu', async () => {
  for (const s of [await asStaff(), await asManager(), await session('/login/password', { username: 'admin', password: 'admin-pass-1' })]) {
    const html = await (await s.get('/academy')).text();
    assert.ok(menuHasAcademy(html), 'Academy is in the side menu');
    assert.match(html, /Itchy eye vs dry eye/);
    assert.match(html, /Stock Gap Hero/);
    assert.match(html, /Learning aid only\. When unsure, ask the pharmacist\./);
  }
});

test('staff flow: cards, failed quiz blocks a retry today, role-play, challenge, manager verifies', async () => {
  const s = await asStaff();
  assert.equal((await s.post('/academy/m/5.1/cards', {})).status, 302);

  // Wrong answers: 0 of 4.
  let res = await s.post('/academy/m/5.1/quiz', { q0: '0', q1: '0', q2: '0', q3: '0' });
  let html = await res.text();
  assert.match(html, /did not reach 80%/);
  // Retry the same day is refused.
  html = await (await s.post('/academy/m/5.1/quiz', { q0: '1', q1: '1', q2: '1', q3: '1' })).text();
  assert.match(html, /next working day/);

  // Quiz page for module 1.5 (not yet attempted): pass with the right answers (Q4 is multi-select).
  res = await s.post('/academy/m/1.5/quiz', { q0: '1', q1: '1', q2: '1', q3: ['0', '1', '2'], q4: '1' });
  html = await res.text();
  assert.match(html, /You passed: 5 of 5/);

  // Role-play for 5.1 needs every round answered.
  html = await (await s.post('/academy/m/5.1/roleplay', { r0: '0' })).text();
  assert.match(html, /Choose an answer for every round/);
  html = await (await s.post('/academy/m/5.1/roleplay', { r0: '0', r1: '0', r2: '0' })).text();
  assert.match(html, /Best response/);

  // Challenge entry: validated, then saved.
  html = await (await s.post('/academy/m/5.1/challenge', { product: 'Glucose test strips', size: '50s', asked: 'many', date: '2026-11-16' })).text();
  assert.match(html, /A whole number/);
  html = await (await s.post('/academy/m/5.1/challenge', { product: 'Glucose test strips', size: '50s', asked: '3', date: '2026-11-16' })).text();
  assert.match(html, /Logged\./);

  // Staff cannot see the manager page or verify.
  assert.equal((await s.get('/academy/manager')).status, 403);
  const id = (await db.query('SELECT id FROM academy_challenges ORDER BY id DESC LIMIT 1')).rows[0].id;
  assert.equal((await s.post(`/academy/verify/${id}`, { k0: 'on', k1: 'on', k2: 'on' })).status, 403);

  // XP so far: 5.1 cards 5 + roleplay 10; 1.5 quiz 15 = 30. Challenge not verified yet.
  html = await (await s.get('/academy?skip=1')).text();
  assert.match(html, /ac-xp-num">30</);

  // The manager sees it waiting, and verifies it.
  const m = await asManager();
  html = await (await m.get('/academy/manager')).text();
  assert.match(html, /Glucose test strips/);
  assert.equal((await m.post(`/academy/verify/${id}`, { k0: 'on', k1: 'on', k2: 'on' })).status, 302);
  // Earned moments are shown once, one at a time, before the next page (never on a form post).
  let r = await s.get('/academy');
  assert.equal(r.status, 302);
  assert.match(r.headers.get('location'), /^\/academy\/celebrate/);
  html = await (await s.get('/academy/celebrate')).text();
  assert.match(html, /VERIFIED/);
  assert.match(html, /\+50 XP/);
  for (let i = 0; i < 6; i += 1) {
    const page = await (await s.get('/academy/celebrate')).text().catch(() => '');
    if (!/ac-card/.test(page)) break;
    await s.post('/academy/celebrate', { next: '/academy' });
  }
  r = await s.get('/academy');
  assert.equal(r.status, 200);
  html = await r.text();
  assert.match(html, /ac-xp-num">80</);

  // Ranks: level, streak, weekly XP and badges.
  assert.match(html, /Level 1 · Trainee/);
  assert.match(html, /ac-flame/);
  html = await (await s.get('/academy/ranks')).text();
  assert.match(html, /XP earned this week/);
  assert.match(html, /You, /);
  assert.match(html, /Stock Hero/);
  assert.match(html, /Team goal this week/);
});

test('a manager cannot verify another branch’s challenge, and a 2 of 3 check is not verified', async () => {
  const o = await session('/login/pin', { username: otherStaff, pin: '2222' });
  await o.post('/academy/m/5.1/challenge', { product: 'Panadol', size: '500mg', asked: '2', date: '2026-11-16' });
  const id = (await db.query('SELECT id FROM academy_challenges ORDER BY id DESC LIMIT 1')).rows[0].id;
  const m = await asManager();
  assert.equal((await m.post(`/academy/verify/${id}`, { k0: 'on', k1: 'on', k2: 'on' })).status, 403);
  const a = await session('/login/password', { username: 'admin', password: 'admin-pass-1' });
  await a.post(`/academy/verify/${id}`, { k0: 'on', k1: 'on' });
  const row = (await db.query('SELECT verified FROM academy_challenges WHERE id = $1', [id])).rows[0];
  assert.equal(row.verified, false);
});

test('salary words are refused in the challenge log', async () => {
  const s = await asStaff();
  const html = await (await s.post('/academy/m/5.1/challenge', { product: 'gaji', size: '1', asked: '1', date: '2026-11-16' })).text();
  assert.match(html, /privacy rule/);
});
