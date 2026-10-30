// 30 Oct: Company policies – everyone logged in can read them (branch staff too); nothing before login.
const test = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');

const { createDb } = require('../../src/db');
const { migrate } = require('../../src/db/migrate');
const { readSeed, loadSeed } = require('../../src/db/seed');
const { createApp } = require('../../src/app');
const { mentionsSalary } = require('../../src/privacy');
const { POLICIES, allText } = require('../../src/policies');

let db; let server; let base;
test.before(async () => {
  db = await createDb({ url: '', localDir: 'memory' });
  await migrate(db);
  await loadSeed(db, readSeed(), { adminPassword: 'admin-pass-1' });
  await db.query('UPDATE users SET pin_hash = $1 WHERE username = $2', [bcrypt.hashSync('1111', 4), 'hazera']);
  server = createApp(db, { now: () => new Date('2026-10-30T15:00:00+08:00') }).listen(0);
  base = `http://localhost:${server.address().port}`;
});
test.after(async () => { server.close(); await db.close(); });

async function login(path, form) {
  const r = await fetch(base + path, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(form).toString() });
  assert.equal(r.status, 302);
  const cookie = r.headers.get('set-cookie').split(';')[0];
  return (p) => fetch(base + p, { redirect: 'manual', headers: { cookie } });
}

test('branch staff see the policy list, the full annual leave policy and the PDF', async () => {
  const get = await login('/login/pin', { username: 'hazera', pin: '1111' });
  const list = await (await get('/policies')).text();
  assert.match(list, /Annual Leave Carry-Forward Policy and Procedure/);
  assert.match(list, /href="\/policies"/, 'Policies is in the side menu');
  const page = await get('/policies/annual-leave-carry-forward');
  assert.equal(page.status, 200);
  const html = await page.text();
  for (const t of ['HR_AL_301026', 'Dr Aisyah Zainordin (CEO)', 'up to a maximum of <b>5 days</b>', '5.6 Half-day balances',
    '6.3 <b>Statutory minimum:</b>', '16 days', '1 January 2028', '<b>automatically extended</b>', '12. Review']) {
    assert.ok(html.includes(t), t);
  }
  const pdf = await get('/policies/annual-leave-carry-forward/pdf');
  assert.equal(pdf.status, 200);
  assert.match(pdf.headers.get('content-type'), /pdf/);
  assert.equal(Buffer.from(await pdf.arrayBuffer()).subarray(0, 4).toString(), '%PDF');
  assert.equal((await get('/policies/nope')).status, 404);
});

test('admin sees the policies too; nothing without logging in', async () => {
  const get = await login('/login/password', { username: 'admin', password: 'admin-pass-1' });
  assert.equal((await get('/policies')).status, 200);
  for (const p of ['/policies', '/policies/annual-leave-carry-forward', '/policies/annual-leave-carry-forward/pdf']) {
    const r = await fetch(base + p, { redirect: 'manual' });
    assert.equal(r.status, 302, p);
  }
});

test('no policy mentions salaries (privacy rule)', () => {
  for (const p of POLICIES) assert.ok(!mentionsSalary(allText(p)), p.slug);
});
