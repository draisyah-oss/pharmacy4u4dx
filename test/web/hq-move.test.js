// 12 Nov (CEO): HQ moves from Wangsa Maju to Ampang – a milestone with 15 owned steps, Mazlina (Ampang
// branch manager) owns Ampang's steps, a News card with the key dates for everyone.
const test = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');

const { createDb } = require('../../src/db');
const { prepareDatabase } = require('../../src/db/setup');
const { createApp } = require('../../src/app');
const move = require('../../src/hq/move');

process.env.ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin-pass-1';
let db; let server; let base;
let clock = new Date('2026-11-13T10:00:00+08:00');
const now = () => clock;

test.before(async () => {
  db = await createDb({ url: '', localDir: 'memory' });
  await prepareDatabase(db, { log: () => {} });
  for (const u of ['mazlina', 'hafizah', 'alia']) await db.query('UPDATE users SET password_hash = $1 WHERE username = $2', [bcrypt.hashSync(`${u}-pass-1`, 4), u]);
  server = createApp(db, { now }).listen(0);
  base = `http://localhost:${server.address().port}`;
});
test.after(async () => { server.close(); await db.close(); });

async function login(username) {
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
  const r = await req('POST', '/login/password', { username, password: `${username}-pass-1` });
  assert.equal(r.status, 302, `${username} logs in`);
  return { get: (p) => req('GET', p), post: (p, body) => req('POST', p, body) };
}

const project = async () => (await db.query('SELECT * FROM hq_projects WHERE milestone = $1', [move.MILESTONE])).rows[0];
const steps = async (id) => (await db.query('SELECT * FROM hq_project_steps WHERE project_id = $1 AND active ORDER BY sort_order', [id])).rows;

test('the move is one milestone with 15 owned steps, added once', async () => {
  const p = await project();
  assert.equal(p.owner, 'Hanin, with Iman'); assert.equal(p.status, 'In progress');
  const s = await steps(p.id);
  assert.equal(s.length, 15);
  assert.deepEqual(s.filter((x) => x.owner === 'Mazlina').map((x) => x.due_date), ['2026-11-17', '2026-11-18', '2026-11-18']);
  assert.equal(s.find((x) => /Stock take/.test(x.step)).due_date, '2026-11-17');
  assert.equal(s.find((x) => /Unpack/.test(x.step)).due_date, '2026-11-19');
  assert.equal(s.find((x) => /keys/.test(x.step)).owner, 'Alia');
  await move.setupOnce(db);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM hq_projects WHERE milestone = $1', [move.MILESTONE])).rows[0].n, 1);
});

test('Mazlina sees the checklist and the layout, changes her own steps only; Hafizah can’t open it', async () => {
  const p = await project(); const s = await steps(p.id);
  const m = await login('mazlina');
  const page = await m.get(`/hq/projects/${p.id}/steps`);
  assert.equal(page.status, 200);
  assert.match(page.html, /Ampang: give space for HQ/);
  assert.match(page.html, /hq-move-ampang-layout\.jpg/);
  assert.match(page.html, new RegExp(`/hq/projects/${p.id}/steps"`), 'in her side menu');
  const csrf = page.html.match(/name="_csrf" value="([^"]+)"/)[1];
  const mine = s.find((x) => x.step === 'Ampang: give space for HQ');
  let r = await m.post(`/hq/projects/steps/${mine.id}`, { _csrf: csrf, action: 'save', status: 'Done' });
  assert.equal(r.status, 302);
  assert.equal((await db.query('SELECT status FROM hq_project_steps WHERE id = $1', [mine.id])).rows[0].status, 'Done');
  const alias = s.find((x) => /keys/.test(x.step));
  r = await m.post(`/hq/projects/steps/${alias.id}`, { _csrf: csrf, action: 'save', status: 'Done' });
  assert.equal(r.status, 403);
  const h = await login('hafizah');
  assert.equal((await h.get(`/hq/projects/${p.id}/steps`)).status, 403);
});

test('News card for everyone: key dates and countdown; the checklist link only for those who work on it', async () => {
  clock = new Date('2026-11-13T10:00:00+08:00');
  const h = await login('hafizah');
  const home = await h.get('/');
  assert.match(home.html, /HQ moves from Wangsa Maju to Pharmacy4U Ampang/);
  assert.match(home.html, /6 days to move day/);
  assert.match(home.html, /HQ starts work at Pharmacy4U Ampang/);
  assert.doesNotMatch(home.html, /Open the move checklist/);
  const a = await login('alia');
  assert.match((await a.get('/')).html, /Open the move checklist/);
  clock = new Date('2026-12-01T10:00:00+08:00');
  assert.doesNotMatch((await h.get('/')).html, /HQ moves from Wangsa Maju/);
  clock = new Date('2026-11-13T10:00:00+08:00');
});

test('Needs you: Mazlina’s steps due today on 18 Nov', async () => {
  clock = new Date('2026-11-18T09:00:00+08:00');
  const m = await login('mazlina');
  const page = await m.get('/meetings');
  assert.match(page.html, /Project steps due today/);
  clock = new Date('2026-11-13T10:00:00+08:00');
});
