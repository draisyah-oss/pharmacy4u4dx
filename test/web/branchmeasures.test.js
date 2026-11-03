// 3 Nov 2026 (CEO): managers change activities themselves; lead changes wait for the CEO; WIG locked.
const test = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
const { createDb } = require('../../src/db');
const { migrate } = require('../../src/db/migrate');
const { readSeed, loadSeed } = require('../../src/db/seed');
const { createApp } = require('../../src/app');
const bm = require('../../src/branchmeasures/data');

let db; let server; let base;
const now = () => new Date('2026-11-03T10:00:00+08:00');
test.before(async () => {
  db = await createDb({ url: '', localDir: 'memory' });
  await migrate(db);
  await loadSeed(db, readSeed(), { adminPassword: 'admin-pass-1' });
  await db.query('UPDATE users SET password_hash = $1 WHERE username = $2', [bcrypt.hashSync('manager-pass-1', 4), 'hafizah']);
  server = createApp(db, { now }).listen(0);
  base = `http://localhost:${server.address().port}`;
});
test.after(async () => { server.close(); await db.close(); });

async function login(username, password) {
  let cookie = '';
  const req = async (method, p, body) => {
    const r = await fetch(base + p, { method, redirect: 'manual',
      headers: { ...(cookie ? { cookie } : {}), ...(body ? { 'content-type': 'application/x-www-form-urlencoded' } : {}) },
      body: body ? new URLSearchParams(body).toString() : undefined });
    const set = r.headers.get('set-cookie'); if (set) cookie = set.split(';')[0];
    return { status: r.status, location: r.headers.get('location'), html: await r.text() };
  };
  assert.equal((await req('POST', '/login/password', { username, password })).status, 302);
  let csrf = null;
  return { get: (p) => req('GET', p), post: async (p, body) => {
    if (!csrf) csrf = (await req('GET', '/branch/measures')).html.match(/name="_csrf" value="([^"]+)"/)[1];
    return req('POST', p, { _csrf: csrf, ...body });
  } };
}

test('manager: activity saved at once, lead waits for the CEO, WIG locked; CEO approves', async () => {
  const wm = (await db.query("SELECT * FROM branches WHERE code = 'WM'")).rows[0];
  const page = await bm.loadPage(db, { branch: wm, today: '2026-11-03' });
  const act = page.rows.find((r) => r.tier === 'activity' && r.calc === 'sum' && r.targets['2026-11'].t !== null);
  const lead = page.rows.find((r) => r.tier === 'lead' && r.calc === 'sum');
  const wig = page.rows.find((r) => r.tier === 'wig');
  assert.ok(act && lead && wig);
  const mgr = await login('hafizah', 'manager-pass-1');
  const html = (await mgr.get('/branch/measures')).html;
  assert.match(html, /Our measures/);
  assert.match(html, /Locked – only Dr Aisyah changes the WIG/);
  // Activity: label + November target, straight away
  let r = await mgr.post(`/branch/measures/${act.id}`, { label: `${act.label} (new)`, field_label: act.fieldLabel, owner: act.owner, 't[m202611][t]': '7' });
  assert.match(decodeURIComponent(r.location), /ok=Saved/);
  let m = (await db.query("SELECT m.label, t.target FROM measures m JOIN measure_targets t ON t.measure_id = m.id AND t.month = '2026-11' WHERE m.id = $1", [act.id])).rows[0];
  assert.equal(m.label, `${act.label} (new)`); assert.equal(Number(m.target), 7);
  // Lead: waits
  r = await mgr.post(`/branch/measures/${lead.id}`, { label: lead.label, owner: lead.owner, 't[m202611][t]': '99', reason: 'Busier month' });
  assert.match(decodeURIComponent(r.location), /approval/);
  m = (await db.query("SELECT target FROM measure_targets WHERE measure_id = $1 AND month = '2026-11'", [lead.id])).rows[0];
  assert.notEqual(Number(m.target), 99, 'not changed yet');
  // WIG: refused
  r = await mgr.post(`/branch/measures/${wig.id}`, { label: 'Changed WIG' });
  assert.match(decodeURIComponent(r.location), /err=/);
  // Another branch: no
  const jh = (await db.query("SELECT id FROM measures WHERE branch_id = (SELECT id FROM branches WHERE code = 'JH') AND active LIMIT 1")).rows[0];
  r = await mgr.post(`/branch/measures/${jh.id}`, { label: 'x' });
  assert.match(decodeURIComponent(r.location), /err=That measure isn’t on this branch/);
  // CEO sees it in Needs you and approves
  const ceo = await login('admin', 'admin-pass-1');
  const ch = await ceo.get('/branch/measures?branch=WM');
  assert.match(ch.html, /Lead measure changes to approve/);
  assert.match(ch.html, /Busier month/);
  const id = (await db.query("SELECT id FROM measure_changes WHERE status = 'Waiting'")).rows[0].id;
  r = await ceo.post(`/branch/measures/changes/${id}`, { decision: 'approve', branch: 'WM' });
  assert.match(decodeURIComponent(r.location), /Approved/);
  m = (await db.query("SELECT target FROM measure_targets WHERE measure_id = $1 AND month = '2026-11'", [lead.id])).rows[0];
  assert.equal(Number(m.target), 99);
});
