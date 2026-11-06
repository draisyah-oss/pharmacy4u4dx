// 6 Nov 2026 (CEO): invoice scan → one PDF per invoice into the Finance inbox on Google Drive.
const test = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');

const { createDb } = require('../../src/db');
const { migrate } = require('../../src/db/migrate');
const { readSeed, loadSeed } = require('../../src/db/seed');
const { createApp } = require('../../src/app');
const { jpegInfo, jpegsToPdf } = require('../../src/invoices/pdf');
const { createInvoiceDrive } = require('../../src/invoices/drive');
const iv = require('../../src/invoices/data');

// A minimal JPEG header: SOI, APP0, SOF0 (height 200, width 100, 3 components), EOI.
function fakeJpeg(w = 100, h = 200) {
  const app0 = Buffer.from([0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00]);
  const sof = Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, h >> 8, h & 255, w >> 8, w & 255, 0x03, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof, Buffer.from([0xff, 0xd9])]);
}
const dataUrl = (b) => `data:image/jpeg;base64,${b.toString('base64')}`;

let db; let server; let base; const uploads = [];
const now = () => new Date('2026-11-06T15:00:00+08:00');
// A pretend Drive: records each upload and "saves" it.
const drive = {
  configured: () => true,
  async upload(id) {
    const r = (await db.query('SELECT file_name, pdf FROM invoices WHERE id = $1', [id])).rows[0];
    uploads.push(r.file_name);
    await db.query("UPDATE invoices SET drive_file_id = 'f' || id, drive_link = 'https://drive.google.com/x', pdf = NULL WHERE id = $1", [id]);
    return { ok: true };
  },
  async download() { return Buffer.from('%PDF-1.4 from drive'); },
};

test.before(async () => {
  db = await createDb({ url: '', localDir: 'memory' });
  await migrate(db);
  await loadSeed(db, readSeed(), { adminPassword: 'admin-pass-1' });
  const pin = (u, v) => db.query('UPDATE users SET pin_hash = $1 WHERE username = $2', [bcrypt.hashSync(v, 4), u]);
  await pin('zawiyah', '2468'); await pin('azwani', '1357'); await pin('nabihah', '9753');
  await db.query('UPDATE users SET password_hash = $1 WHERE username = $2', [bcrypt.hashSync('admin-pass-1', 4), 'admin']);
  await db.query("INSERT INTO inv_suppliers (key, supplier, month) VALUES ('ZUELLIG', 'Zuellig', '2026-11')");
  server = createApp(db, { now, invoiceDrive: drive }).listen(0);
  base = `http://localhost:${server.address().port}`;
});
test.after(async () => { server.close(); await db.close(); });

async function login(kind, username, secret) {
  let cookie = '';
  const req = async (method, p, body) => {
    const r = await fetch(base + p, { method, redirect: 'manual',
      headers: { ...(cookie ? { cookie } : {}), ...(body ? { 'content-type': 'application/x-www-form-urlencoded' } : {}) },
      body: body ? new URLSearchParams(body).toString() : undefined });
    const set = r.headers.get('set-cookie'); if (set) cookie = set.split(';')[0];
    return { status: r.status, location: r.headers.get('location'), type: r.headers.get('content-type'), html: await r.text() };
  };
  const r = await req('POST', kind === 'pin' ? '/login/pin' : '/login/password', kind === 'pin' ? { username, pin: secret } : { username, password: secret });
  assert.equal(r.status, 302, `${username} logs in`);
  let csrf = null;
  return {
    get: (p) => req('GET', p),
    post: async (p, body) => {
      if (!csrf) csrf = ((await req('GET', '/invoices/new')).html.match(/name="_csrf" value="([^"]+)"/) || [])[1];
      const sp = new URLSearchParams({ _csrf: csrf });
      for (const [k, v] of Object.entries(body)) [].concat(v).forEach((x) => sp.append(k, x));
      return req('POST', p, sp);
    },
  };
}

test('PDF: one page per JPEG, sized from the photo', () => {
  assert.deepEqual(jpegInfo(fakeJpeg(100, 200)), { width: 100, height: 200, components: 3 });
  const pdf = jpegsToPdf([fakeJpeg(100, 200), fakeJpeg(300, 150)]).toString('latin1');
  assert.ok(pdf.startsWith('%PDF-1.4'));
  assert.match(pdf, /\/Count 2/);
  assert.match(pdf, /\/MediaBox \[0 0 595 1190\]/);
  assert.match(pdf, /\/MediaBox \[0 0 595 298\]/);
  assert.match(pdf, /startxref\n\d+\n%%EOF/);
  assert.throws(() => jpegsToPdf([Buffer.from('not a photo')]));
  assert.equal(iv.fileName({ date: '2026-11-05', supplier: 'Zuellig / Pharma', invoiceNo: 'INV:77', from: 'WM' }), '2026-11-05 Zuellig Pharma INV 77 (WM).pdf');
});

test('staff scan an invoice → PDF named by date, supplier, no. and branch, sent to Drive', async () => {
  const s = await login('pin', 'zawiyah', '2468');
  const form = await s.get('/invoices/new');
  assert.equal(form.status, 200);
  assert.match(form.html, /<option value="WM" selected/, 'own branch picked');
  assert.match(form.html, /Zuellig/, 'supplier list from Ordering & payments');
  const body = { from: 'WM', supplier: 'Zuellig', invoice_no: 'ZP-1001', invoice_date: '2026-11-05', amount: '1,250.40', po_ref: 'PO 55',
    page: [dataUrl(fakeJpeg()), dataUrl(fakeJpeg(120, 160))] };
  const r = await s.post('/invoices', body);
  assert.equal(r.status, 303, r.html.slice(0, 300));
  assert.match(decodeURIComponent(r.location.replace(/\+/g, " ")), /2026-11-05 Zuellig ZP-1001 \(WM\)\.pdf saved\. Saved in the Finance inbox/);
  assert.deepEqual(uploads, ['2026-11-05 Zuellig ZP-1001 (WM).pdf']);
  const row = (await db.query('SELECT amount, pages, status, po_ref, pdf FROM invoices')).rows[0];
  assert.equal(Number(row.amount), 1250.4); assert.equal(row.pages, 2); assert.equal(row.status, 'Received'); assert.equal(row.pdf, null, 'cleared once in Drive');

  // Same supplier + invoice no. → warning, saved only when confirmed.
  const chk = JSON.parse((await s.get('/invoices/check?supplier=zuellig&invoice_no=zp1001')).html);
  assert.equal(chk.duplicates, 1);
  const dup = await s.post('/invoices', { ...body, supplier: ' ZUELLIG ', invoice_no: 'ZP 1001' });
  assert.equal(dup.status, 200);
  assert.match(dup.html, /already saved/);
  assert.match(dup.html, /name="page" value="data:image\/jpeg/, 'photos kept on the form');
  assert.equal(uploads.length, 1);
  const ok = await s.post('/invoices', { ...body, confirm_dup: '1' });
  assert.equal(ok.status, 303);

  // Checks.
  const bad = await s.post('/invoices', { ...body, invoice_no: 'X1', page: [] });
  assert.equal(bad.status, 400); assert.match(bad.html, /Add a photo/);
  const future = await s.post('/invoices', { ...body, invoice_no: 'X2', invoice_date: '2026-11-07' });
  assert.match(future.html, /can’t be after today/);
  const pay = await s.post('/invoices', { ...body, invoice_no: 'X3', supplier: 'Gaji supplier' });
  assert.equal(pay.status, 400);

  const list = await s.get('/invoices');
  assert.match(list.html, /ZP-1001/); assert.match(list.html, /⚠ 2×/);
  assert.doesNotMatch(list.html, /Entered in Dynamod<\/button>/, 'staff can’t tick');
  const pdf = await s.get(`/invoices/${(await db.query('SELECT min(id) AS id FROM invoices')).rows[0].id}/pdf`);
  assert.equal(pdf.type, 'application/pdf');
});

test('other branches don’t see it; Finance gets Needs you and ticks Entered in Dynamod', async () => {
  const jh = await login('pin', 'nabihah', '9753');
  assert.doesNotMatch((await jh.get('/invoices')).html, /ZP-1001/);
  const id = (await db.query('SELECT min(id) AS id FROM invoices')).rows[0].id;
  assert.equal((await jh.get(`/invoices/${id}/pdf`)).status, 404);
  assert.equal((await jh.post(`/invoices/${id}/entered`, {})).status, 303);
  assert.equal((await db.query('SELECT status FROM invoices WHERE id = $1', [id])).rows[0].status, 'Received', 'not Finance');

  const az = await login('pin', 'azwani', '1357');
  const page = await az.get('/invoices?status=Received');
  assert.match(page.html, /Invoices not yet entered in Dynamod/);
  assert.match(page.html, /✔ Entered in Dynamod/);
  const r = await az.post(`/invoices/${id}/entered`, { f_status: 'Received' });
  assert.match(decodeURIComponent(r.location.replace(/\+/g, " ")), /entered in Dynamod/);
  const row = (await db.query("SELECT i.status, i.entered_at, u.username FROM invoices i JOIN users u ON u.id = i.entered_by WHERE i.id = $1", [id])).rows[0];
  assert.equal(row.status, 'Entered in Dynamod'); assert.ok(row.entered_at); assert.equal(row.username, 'azwani');
  const filtered = await az.get('/invoices?status=Entered+in+Dynamod&from=WM&month=2026-11&supplier=Zuellig');
  assert.match(filtered.html, /1 invoice ·/);
  await az.post(`/invoices/${id}/entered`, { undo: '1' });
  assert.equal((await db.query('SELECT status, entered_at FROM invoices WHERE id = $1', [id])).rows[0].entered_at, null);
});

test('Drive upload: month subfolder in the Finance inbox, multipart PDF, error kept for retry', async () => {
  const calls = [];
  const fetchImpl = async (url, opt = {}) => {
    calls.push({ url: String(url), method: opt.method || 'GET', body: opt.body });
    const json = (o, status = 200) => ({ ok: status < 400, status, json: async () => o, arrayBuffer: async () => new ArrayBuffer(0) });
    if (String(url).includes('oauth2')) return json({ access_token: 't' });
    if (String(url).includes('/upload/')) return json({ id: 'F1', webViewLink: 'https://drive.google.com/file/d/F1/view' });
    if (opt.method === 'POST') return json({ id: 'MONTH' });
    return json({ files: [] });
  };
  const { generateKeyPairSync } = require('crypto');
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 1024 });
  const d = createInvoiceDrive(db, { fetchImpl, now, log: () => {}, account: { email: 'sa@x.iam', privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }) } });
  const id = (await db.query(`INSERT INTO invoices (supplier, supplier_key, invoice_no, invoice_key, invoice_date, amount, pages, file_name, pdf)
    VALUES ('DKSH', 'dksh', 'D1', 'D1', '2026-10-30', 10, 1, '2026-10-30 DKSH D1 (HQ).pdf', $1) RETURNING id`, [jpegsToPdf([fakeJpeg()])])).rows[0].id;
  const r = await d.upload(id);
  assert.equal(r.ok, true);
  assert.ok(calls.some((c) => c.url.includes("1bAMclSUrp9QGqEHyZS4yktxNQEVuravB") && decodeURIComponent(c.url.replace(/\+/g, ' ')).includes("name = '2026-10'")), 'looks for the month folder');
  const folder = calls.find((c) => c.method === 'POST' && !c.url.includes('/upload/') && !c.url.includes('oauth2'));
  assert.deepEqual(JSON.parse(folder.body).parents, ['1bAMclSUrp9QGqEHyZS4yktxNQEVuravB']);
  const up = calls.find((c) => c.url.includes('/upload/'));
  assert.match(up.url, /supportsAllDrives=true/);
  assert.match(up.body.toString('latin1'), /"parents":\["MONTH"\]/);
  assert.match(up.body.toString('latin1'), /%PDF-1\.4/);
  const row = (await db.query('SELECT drive_file_id, pdf FROM invoices WHERE id = $1', [id])).rows[0];
  assert.equal(row.drive_file_id, 'F1'); assert.equal(row.pdf, null);

  const none = createInvoiceDrive(db, { account: null, log: () => {} });
  const id2 = (await db.query(`INSERT INTO invoices (supplier, supplier_key, invoice_no, invoice_key, invoice_date, amount, pages, file_name, pdf)
    VALUES ('DKSH', 'dksh', 'D2', 'D2', '2026-10-30', 10, 1, 'x.pdf', '\\x00') RETURNING id`)).rows[0].id;
  assert.match((await none.upload(id2)).error, /service account/);
  assert.ok((await db.query('SELECT drive_error, pdf FROM invoices WHERE id = $1', [id2])).rows[0].pdf, 'kept for the retry');
});
