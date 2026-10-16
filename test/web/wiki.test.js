// Company wiki + Pharmacy4U Classroom (16 Oct): everyone reads, HQ adds pages and files,
// branches send educational posters (JH one a day), Hanin approves them for the Classroom and Meta.

const test = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');

const { createDb } = require('../../src/db');
const { migrate } = require('../../src/db/migrate');
const { readSeed, loadSeed } = require('../../src/db/seed');
const { createApp } = require('../../src/app');
const { sniff } = require('../../src/wiki/data');
const calc = require('../../src/calc');

let db; let server; let base;
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(200, 1)]);
const PDF = Buffer.from('%PDF-1.4\n% test file\n1 0 obj << >> endobj\ntrailer << >>\n%%EOF\n');
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');

test.before(async () => {
  db = await createDb({ url: '', localDir: 'memory' });
  await migrate(db);
  await loadSeed(db, readSeed(), { adminPassword: 'admin-pass-1' });
  const pw = (u, v) => db.query('UPDATE users SET password_hash = $1 WHERE username = $2', [bcrypt.hashSync(v, 4), u]);
  const pin = (u, v) => db.query('UPDATE users SET pin_hash = $1 WHERE username = $2', [bcrypt.hashSync(v, 4), u]);
  await pw('hanin', 'hanin-pass-1'); await pw('iman', 'iman-pass-1');
  await pin('yaya', '2222'); await pin('hazera', '1111');
  server = createApp(db).listen(0);
  base = `http://localhost:${server.address().port}`;
});
test.after(async () => { server.close(); await db.close(); });

async function login(kind, username, secret) {
  let cookie = '';
  const req = async (method, p, body, form) => {
    const headers = { ...(cookie ? { cookie } : {}) };
    let payload;
    if (form) payload = form;
    else if (body) { headers['content-type'] = 'application/x-www-form-urlencoded'; payload = new URLSearchParams(body).toString(); }
    const r = await fetch(base + p, { method, redirect: 'manual', headers, body: payload });
    const set = r.headers.get('set-cookie'); if (set) cookie = set.split(';')[0];
    const type = r.headers.get('content-type') || '';
    return { status: r.status, location: r.headers.get('location'), type, headers: r.headers, html: type.includes('html') ? await r.text() : null, buf: type.includes('html') ? null : Buffer.from(await r.arrayBuffer()) };
  };
  const r = await req('POST', kind === 'pin' ? '/login/pin' : '/login/password', kind === 'pin' ? { username, pin: secret } : { username, password: secret });
  assert.equal(r.status, 302, `${username} logs in`);
  const csrf = ((await req('GET', '/wiki')).html.match(/name="_csrf" value="([^"]+)"/) || [])[1];
  return {
    get: (p) => req('GET', p),
    post: (p, body) => req('POST', p, { _csrf: csrf, ...body }),
    upload: (p, fields, file, { noCsrf = false } = {}) => {
      const fd = new FormData();
      if (!noCsrf) fd.append('_csrf', csrf);
      for (const [k, v] of Object.entries(fields)) fd.append(k, v);
      if (file) fd.append('file', new Blob([file.data]), file.name);
      return req('POST', p, null, fd);
    },
  };
}

test('files are checked by their content, not their name', () => {
  assert.equal(sniff(PNG, 'a.png').mime, 'image/png');
  assert.equal(sniff(PDF, 'slides.pdf').mime, 'application/pdf');
  assert.equal(sniff(SVG, 'x.svg'), null, 'SVG refused (could carry scripts)');
  assert.equal(sniff(Buffer.from('MZ....'), 'evil.pdf'), null, 'a renamed file is refused');
});

test('HQ adds a Classroom module with slides; everyone reads it; read count and org chart', async () => {
  const iman = await login('password', 'iman', 'iman-pass-1');
  // Without the form token the upload is refused
  assert.equal((await iman.upload('/wiki/new', { section: 'classroom', title: 'x' }, null, { noCsrf: true })).status, 403);
  const bad = await iman.upload('/wiki/new', { section: 'classroom', title: 'Bad file' }, { data: SVG, name: 'x.svg' });
  assert.equal(bad.status, 400);
  assert.match(bad.html, /can’t be added/);
  const r = await iman.upload('/wiki/new', { section: 'classroom', title: 'Module 1: Gout basics', body: 'What gout is.\n\n- Avoid organ meat\n- Drink water', tags: 'gout, chronic' }, { data: PDF, name: 'gout-module.pdf' });
  assert.equal(r.status, 302);
  const id = Number(r.location.match(/\/wiki\/p\/(\d+)/)[1]);

  const staff = await login('pin', 'hazera', '1111');
  // Branch staff now have the side menu, with the Wiki
  const home = (await staff.get('/wiki')).html;
  assert.match(home, /class="sidenav"/);
  assert.match(home, /Module 1: Gout basics/);
  const page = (await staff.get(`/wiki/p/${id}`)).html;
  assert.match(page, /<li>Avoid organ meat<\/li>/);
  const file = await staff.get(`/wiki/f/${(await db.query('SELECT file_id FROM wiki_pages WHERE id = $1', [id])).rows[0].file_id}`);
  assert.equal(file.type, 'application/pdf');
  assert.match(file.headers.get('content-security-policy'), /sandbox/);
  assert.ok(file.buf.equals(PDF));
  // Staff can't add pages
  assert.equal((await staff.upload('/wiki/new', { section: 'sop', title: 'x', body: 'y' })).status, 403);
  // Read count for HQ, search, org chart
  assert.match((await iman.get(`/wiki/p/${id}`)).html, /read by 2 of/);
  assert.match((await staff.get('/wiki?q=gout')).html, /1 found for “gout”/);
  const org = (await staff.get('/wiki/org')).html;
  assert.match(org, /Aishah/); assert.match(org, /Hafizah/);
  // Salary words never stored
  const sal = await iman.upload('/wiki/new', { section: 'company', title: 'Salary scale 2026', body: 'x' });
  assert.equal(sal.status, 400);
  // Logged-out people get nothing
  assert.equal((await fetch(`${base}/wiki/p/${id}`, { redirect: 'manual' })).status, 302);
});

test('JH poster: send → counted on Daily entry → Hanin asks for a fix → resend → approve → Meta queue', async () => {
  const yaya = await login('pin', 'yaya', '2222');
  assert.equal((await yaya.upload('/wiki/poster', { title: 'Gout: foods to avoid' }, null)).status, 400, 'picture needed');
  const r = await yaya.upload('/wiki/poster', { title: 'Gout: foods to avoid', body: 'Kurangkan makanan laut. Anda tahu?' }, { data: PNG, name: 'poster.png' });
  assert.equal(r.status, 302);
  const p = (await db.query("SELECT * FROM wiki_pages WHERE section = 'poster'")).rows[0];
  assert.equal(p.status, 'pending');
  const jh = (await db.query("SELECT id FROM branches WHERE code = 'JH'")).rows[0].id;
  const today = calc.todayInMalaysia(new Date());
  const count = async () => Number(((await db.query("SELECT value FROM daily_entries WHERE branch_id = $1 AND entry_date = $2 AND field_key = 'poster'", [jh, today])).rows[0] || { value: 0 }).value);
  assert.equal(await count(), 1, 'JH daily poster counted automatically');
  // Not yet in the Classroom for others
  const staff = await login('pin', 'hazera', '1111');
  assert.equal((await staff.get(`/wiki/p/${p.id}`)).status, 404);

  const hanin = await login('password', 'hanin', 'hanin-pass-1');
  const queue = (await hanin.get('/wiki/s/poster')).html;
  assert.match(queue, /To approve \(1\)/);
  assert.match(queue, /class="sn-badge"[^>]*>1</);
  assert.match(queue, /<b>JH<\/b> 1 of \d+ sent/);
  // A fix needs a note
  assert.match((await hanin.post(`/wiki/p/${p.id}/review`, { decision: 'fix' })).location, /err=/);
  await hanin.post(`/wiki/p/${p.id}/review`, { decision: 'fix', note: 'Add our logo and the source' });
  assert.equal(await count(), 0, 'a poster sent back doesn’t count until it’s resent');
  assert.match((await yaya.get('/wiki/s/poster')).html, /FIX NEEDED[\s\S]*Add our logo/);
  assert.equal((await yaya.upload(`/wiki/p/${p.id}/resend`, { title: 'Gout: foods to avoid', body: 'v2' }, { data: PNG, name: 'poster2.png' })).status, 302);
  assert.equal(await count(), 1);
  await hanin.post(`/wiki/p/${p.id}/review`, { decision: 'approve' });
  assert.match((await staff.get('/wiki/s/poster')).html, /Gout: foods to avoid/);
  // Meta queue: approved but not posted → mark posted
  assert.match((await hanin.get('/wiki/s/poster')).html, /not yet on Facebook \/ Instagram \(1\)/);
  await hanin.post(`/wiki/p/${p.id}/meta`, {});
  assert.match((await hanin.get('/wiki/s/poster')).html, /not yet on Facebook \/ Instagram \(0\)/);
  // JH scoreboard measure E1 exists
  assert.equal((await db.query("SELECT count(*)::int AS n FROM measures WHERE code = 'E1' AND branch_id = $1 AND active", [jh])).rows[0].n, 1);
  // Branch staff can't approve; a multipart post to another page is still checked for its token
  assert.equal((await yaya.post(`/wiki/p/${p.id}/review`, { decision: 'approve' })).status, 403);
  const fd = new FormData(); fd.append('item', 'x');
  assert.equal((await fetch(`${base}/oos`, { method: 'POST', body: fd, redirect: 'manual' })).status, 302, 'not logged in → login');
});
