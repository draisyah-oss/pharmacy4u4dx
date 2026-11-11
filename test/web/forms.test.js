// 11 Nov: the OOS inbox table posts 5 boxes per open item. At ~200 open items that passed the
// form reader's default limit of 1,000 boxes and Save all showed "Something went wrong".
const test = require('node:test');
const assert = require('node:assert/strict');
const { createDb } = require('../../src/db');
const { migrate } = require('../../src/db/migrate');
const { readSeed, loadSeed } = require('../../src/db/seed');
const { createApp } = require('../../src/app');

let db; let server; let base;
test.before(async () => {
  db = await createDb({ url: '', localDir: 'memory' });
  await migrate(db);
  await loadSeed(db, readSeed(), { adminPassword: 'admin-pass-1' });
  server = createApp(db, { now: () => new Date('2026-11-11T10:00:00+08:00') }).listen(0);
  base = `http://localhost:${server.address().port}`;
});
test.after(async () => { server.close(); await db.close(); });

test('a big OOS inbox table (300 rows = 1,500 boxes) saves instead of failing', async () => {
  let cookie = '';
  const req = async (method, p, body) => {
    const r = await fetch(base + p, { method, redirect: 'manual', body: body ? body.toString() : undefined,
      headers: { ...(cookie ? { cookie } : {}), ...(body ? { 'content-type': 'application/x-www-form-urlencoded' } : {}) } });
    const set = r.headers.get('set-cookie'); if (set) cookie = set.split(';')[0];
    return { status: r.status, location: r.headers.get('location'), html: await r.text() };
  };
  await req('POST', '/login/password', new URLSearchParams({ username: 'admin', password: 'admin-pass-1' }));
  const csrf = (await req('GET', '/oos/inbox')).html.match(/name="_csrf" value="([^"]+)"/)[1];
  const body = new URLSearchParams({ _csrf: csrf });
  for (let i = 1; i <= 300; i++) for (const f of ['answer', 'qty', 'from', 'by', 'note']) body.append(`r[i${900000 + i}][${f}]`, '');
  const r = await req('POST', '/oos/inbox/table', body);
  assert.equal(r.status, 302, 'saved and redirected, not the error page');
  assert.match(decodeURIComponent(r.location), /No changes to save/);
});
