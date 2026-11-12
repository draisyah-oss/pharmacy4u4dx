// 11 Nov 2026 (CEO handoff): Zakat quotation (WM), Phase 1 – the 0401 RFQ end to end.
// The item master here is made up (the real one has costs and never goes in the repo).
const test = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');

const { createDb } = require('../../src/db');
const { migrate } = require('../../src/db/migrate');
const { readSeed, loadSeed } = require('../../src/db/seed');
const { createApp } = require('../../src/app');
const products = require('../../src/oos/products');

let db; let server; let base;
let today = '2026-11-11';
const now = () => new Date(`${today}T15:00:00+08:00`);

const CSV = [
  'Stock ID,Barcode,Description 1,UOM ID,Balance Quantity (UOM),Cost,Price 1,Price 2,Brand ID',
  '9000001,9000001001,ENSURE GOLD POWDER (VANILLA) 800G,TIN,13,111.11,127,122,ABBOTT',
  '9000002,9000002001,ENSURE GOLD WHEAT 800G,TIN,1,110.00,127,122,ABBOTT',
  '9000003,9000003001,DR. P PREMIUM PANTS SIZE XL 7S,PACK,11,20.00,25.9,24.9,DRP',
  '9000004,9000004001,DR. P PREMIUM ADULT WIPES 40S,PACK,5,7.77,9.9,9.2,DRP',
  '9000005,9000005001,PRIMES DISPOSABLE UNDERPAD 75X75 4PLY 10 SHEETS,PACK,39,8.91,12.5,12,PRIMES',
  '9000005,9000005002,PRIMES DISPOSABLE UNDERPAD 75X75 4PLY 1 SHEET,PCS,390,0.95,1.3,1.2,PRIMES',
  '9000006,9000006001,"NUR CARE UNDERPAD 75CMX75CM (L), ECONOMY 10\'S",PACK,30,7.70,12.9,11.5,NUR',
].join('\n');

test.before(async () => {
  db = await createDb({ url: '', localDir: 'memory' });
  await migrate(db);
  await loadSeed(db, readSeed(), { adminPassword: 'admin-pass-1' });
  const pw = (u) => db.query('UPDATE users SET password_hash = $1 WHERE username = $2', [bcrypt.hashSync('pass-word-1', 4), u]);
  for (const u of ['hafizah', 'alia', 'afifah', 'amirah', 'aimi', 'hanin', 'admin']) await pw(u);
  await db.query('UPDATE users SET pin_hash = $1 WHERE username = $2', [bcrypt.hashSync('2468', 4), 'zawiyah']);
  await db.query('UPDATE users SET pin_hash = $1 WHERE username = $2', [bcrypt.hashSync('1357', 4), 'fariz']);
  server = createApp(db, { now }).listen(0);
  base = `http://localhost:${server.address().port}`;
});
test.after(async () => { server.close(); await db.close(); });

async function login(username, secret, pin = false) {
  let cookie = '';
  const req = async (method, p, body) => {
    const r = await fetch(base + p, { method, redirect: 'manual',
      headers: { ...(cookie ? { cookie } : {}), ...(body ? { 'content-type': 'application/x-www-form-urlencoded' } : {}) },
      body: body ? new URLSearchParams(body).toString() : undefined });
    const set = r.headers.get('set-cookie'); if (set) cookie = set.split(';')[0];
    const buf = Buffer.from(await r.arrayBuffer());
    return { status: r.status, location: r.headers.get('location'), type: r.headers.get('content-type'), html: buf.toString('utf8'), buf };
  };
  const r = await req('POST', pin ? '/login/pin' : '/login/password', pin ? { username, pin: secret } : { username, password: secret });
  assert.equal(r.status, 302, `${username} logs in`);
  let csrf = null;
  const c = {
    get: (p) => req('GET', p),
    post: async (p, body) => {
      if (!csrf) csrf = ((await req('GET', '/policies')).html.match(/name="_csrf" value="([^"]+)"/) || [])[1];
      const sp = new URLSearchParams({ _csrf: csrf });
      for (const [k, v] of Object.entries(body)) [].concat(v).forEach((x) => sp.append(k, x));
      return req('POST', p, sp);
    },
  };
  return c;
}

const lineIds = async (qid) => (await db.query('SELECT id FROM quotation_lines WHERE quotation_id = $1 ORDER BY line_no', [qid])).rows.map((r) => r.id);
const pid = async (desc) => (await db.query('SELECT id FROM products WHERE description = $1', [desc])).rows[0].id;

test('the weekly stock export (.csv) uploads on the Product list, with balances; Active = N rows stay off', async () => {
  const alia = await login('alia', 'pass-word-1');
  const file = `data:text/csv;base64,${Buffer.from(`${CSV}\n`).toString('base64')}`;
  const r = await alia.post('/oos/products', { file, name: 'stock 2 Nov.csv', replace: '1' });
  assert.ok([302, 303].includes(r.status));
  assert.match(decodeURIComponent(r.location), /Product list updated: 7 rows read/);
  const p = (await db.query("SELECT balance, cost, active FROM products WHERE barcode = '9000005001'")).rows[0];
  assert.equal(Number(p.balance), 39); assert.equal(Number(p.cost), 8.91); assert.equal(p.active, true);
  // one Stock ID, two UOM rows = two pickable items
  assert.equal((await db.query("SELECT count(*)::int AS n FROM products WHERE stock_id = '9000005' AND active")).rows[0].n, 2);
  // the bundled masterlist rows not in the file are no longer listed
  assert.equal((await db.query('SELECT count(*)::int AS n FROM products WHERE active')).rows[0].n, 7);
  const parsed = products.parseCsv('Active,Stock ID,Barcode,Description 1\nN,1,1,OLD THING\nY,2,2,NEW THING');
  assert.deepEqual(parsed.rows.map((x) => x.active), ['N', 'Y']);
  assert.match(products.parseCsv('Foo,Bar\n1,2').error, /no column Stock ID/);
});

test('who opens it: branch managers (own branch), HQ, admin – not branch staff', async () => {
  const st = await login('zawiyah', '2468', true);
  assert.equal((await st.get('/quotations')).status, 403, 'branch staff can\'t');
  assert.doesNotMatch((await st.get('/daily')).html, /href="\/quotations"/);
  for (const [u, s, pin] of [['hafizah', 'pass-word-1'], ['afifah', 'pass-word-1'], ['alia', 'pass-word-1'], ['hanin', 'pass-word-1'], ['fariz', '1357', true], ['admin', 'pass-word-1']]) {
    const c = await login(u, s, pin);
    const r = await c.get('/quotations');
    assert.equal(r.status, 200, `${u} can`);
    assert.match(r.html, /href="\/quotations"/, `${u} has it in the menu`);
  }
});

let qid;
test('Hafizah pastes the 0401 RFQ, picks items, gets the zakat form table – no cost shown to her', async () => {
  const h = await login('hafizah', 'pass-word-1');
  const r = await h.post('/quotations', { rfq_description: 'RFQ 0401 – Medkad', items: "Ensure Gold 850g ×30\nDr. P Premium LV7 Pants L 8's ×90\nAdult wet wipes 40's ×60\nUnderpad 75cm x 75cm 10's ×36" });
  assert.equal(r.status, 303);
  qid = Number(r.location.split('/').pop());
  let page = await h.get(`/quotations/${qid}`);
  assert.match(page.html, /ENSURE GOLD POWDER \(VANILLA\) 800G/);
  assert.match(page.html, /DR\. P PREMIUM ADULT WIPES 40S/);
  assert.match(page.html, /PRIMES DISPOSABLE UNDERPAD 75X75 4PLY 10 SHEETS/);
  assert.match(page.html, /Not in the list – I’ll type it/);
  assert.doesNotMatch(page.html, /ask Alia/i, 'no "ask Alia" option any more');
  assert.match(page.html, /\(cost 111\.11\)/, '12 Nov (CEO): Hafizah sees the cost');
  assert.match(page.html, /RM133\.40/, 'auto price shown (111.11 × 1.2 = 133.332 → 133.40)');

  const [l1, l2, l3, l4] = await lineIds(qid);
  const k = (id, f) => `l[i${id}][${f}]`;
  await h.post(`/quotations/${qid}`, {
    [k(l1, 'pick')]: String(await pid('ENSURE GOLD POWDER (VANILLA) 800G')),
    [k(l2, 'pick')]: 'need',
    [k(l3, 'pick')]: String(await pid('DR. P PREMIUM ADULT WIPES 40S')),
    [k(l4, 'pick')]: String(await pid('PRIMES DISPOSABLE UNDERPAD 75X75 4PLY 10 SHEETS')),
  });
  let lines = (await db.query('SELECT * FROM quotation_lines WHERE quotation_id = $1 ORDER BY line_no', [qid])).rows;
  assert.deepEqual(lines.map((l) => [l.unit_price === null ? null : Number(l.unit_price), l.stock_option, l.note]), [
    [133.4, 'preorder', 'Pre-order - 7 days'], // balance 13 < 30
    [null, 'preorder', 'Pre-order - 7 days'], // need cost
    [9.4, 'preorder', 'Pre-order - 7 days'], // 7.77 × 1.2 = 9.324 → 9.40; balance 5 < 60
    [10.7, 'readystock', ''], // 39 ≥ 36
  ]);
  assert.equal(Number(lines[0].cost_at_quote), 111.11);

  // Generate is refused while line 2 has no price
  const no = await h.post(`/quotations/${qid}/generate`, {});
  assert.match(decodeURIComponent(no.location), /Line 2: needs a price/);

  // override line 1 (amber under the floor), type line 2 by hand, line 3 readystock, tidy descriptions
  await h.post(`/quotations/${qid}`, {
    [k(l1, 'price')]: '125.00',
    [k(l2, 'desc')]: "dr. p premium pants size l 8's", [k(l2, 'price')]: '28.50', [k(l2, 'note')]: 'Pre-order - 7 to 14 days',
    [k(l3, 'desc')]: "DR. P PREMIUM ADULT WIPES 40'S", [k(l3, 'stock')]: 'readystock', [k(l3, 'price')]: '9.40',
    [k(l4, 'desc')]: "PRIMES DISPOSABLE UNDERPAD 75X75 4PLY 10'S", [k(l4, 'price')]: '10.70', [k(l4, 'stock')]: 'readystock',
  });
  lines = (await db.query('SELECT * FROM quotation_lines WHERE quotation_id = $1 ORDER BY line_no', [qid])).rows;
  assert.equal(lines[0].price_source, 'override');
  assert.equal(lines[1].price_source, 'manual'); assert.equal(lines[1].description, "DR. P PREMIUM PANTS SIZE L 8'S"); assert.equal(lines[1].need_cost, true);
  assert.equal(lines[2].stock_option, 'readystock'); assert.equal(lines[2].note, '', 'the pre-order note goes with Readystock');
  assert.equal(lines[3].price_source, 'auto');

  page = await h.get(`/quotations/${qid}`);
  assert.match(page.html, /Below 15%/, 'amber badge for 125.00 on 111.11 (12.5%)');
  assert.match(page.html, /No cost/);
  // 12 Nov (CEO): Hafizah sees the cost and the margin %
  assert.match(page.html, /12\.5% on cost/);
  assert.match(page.html, /cost RM111\.11/);
  // step 4: Brand | Qty | Price per unit | Stock option | Notes with copy buttons
  assert.match(page.html, /<th>Brand<\/th><th class="n">Qty<\/th><th class="n">Price per unit<\/th><th>Stock option<\/th><th>Notes<\/th>/);
  assert.match(page.html, /data-copy-text="ENSURE GOLD POWDER \(VANILLA\) 800G\t30\t125\.00\tPre-order\tPre-order - 7 days"/);
  assert.match(page.html, /data-copy-text="DR\. P PREMIUM PANTS SIZE L 8&#39;S"/);
  assert.match(page.html, /RM7,264\.20/, 'total 3,750 + 2,565 + 564 + 385.20 = 7,264.20');
});

test('Alia sees cost and % on cost', async () => {
  const a = await login('alia', 'pass-word-1');
  const page = await a.get(`/quotations/${qid}`);
  assert.match(page.html, /cost RM111\.11/);
  assert.match(page.html, /12\.5% on cost/);
});

test('Generate takes QT-WM-2026-0403 once, makes the PDF; numbers are never reused', async () => {
  const h = await login('hafizah', 'pass-word-1');
  const r = await h.post(`/quotations/${qid}/generate`, {});
  assert.match(decodeURIComponent(r.location), /QT-WM-2026-0403 is ready/);
  const q = (await db.query('SELECT * FROM quotations WHERE id = $1', [qid])).rows[0];
  assert.equal(q.ref, 'QT-WM-2026-0403'); assert.equal(q.status, 'issued'); assert.equal(Number(q.total), 7264.2);
  const pdf = await h.get(`/quotations/${qid}/pdf?download=1`);
  assert.equal(pdf.status, 200); assert.equal(pdf.type, 'application/pdf');
  assert.equal(pdf.buf.subarray(0, 5).toString(), '%PDF-');
  assert.match(pdf.buf.toString('latin1'), /\/Count 1/);
  // again: refused, number unchanged
  assert.match(decodeURIComponent((await h.post(`/quotations/${qid}/generate`, {})).location), /already issued/);
  assert.match(decodeURIComponent((await h.post(`/quotations/${qid}`, { rfq_description: 'x' })).location), /already issued – make a copy/);
  // a copy gets the next number
  const c = await h.post(`/quotations/${qid}/copy`, {});
  const cid = Number(c.location.split('?')[0].split('/').pop());
  assert.match(decodeURIComponent((await h.post(`/quotations/${cid}/generate`, {})).location), /QT-WM-2026-0404 is ready/);
  const audit = (await db.query("SELECT record_key FROM audit_log WHERE table_name = 'quotations' AND action = 'issue' ORDER BY id")).rows.map((x) => x.record_key);
  assert.deepEqual(audit, ['QT-WM-2026-0403', 'QT-WM-2026-0404']);
  // the list
  const list = await h.get('/quotations');
  assert.match(list.html, /QT-WM-2026-0403/); assert.match(list.html, /QT-WM-2026-0404/);
});

test('settings: admin and Alia only; markup / floor; next number never below a used one; a new year waits for its start number', async () => {
  const h = await login('hafizah', 'pass-word-1');
  assert.equal((await h.get('/quotations/settings')).status, 403);
  assert.equal((await h.post('/quotations/settings', { markup_default: '50', markup_floor: '1', recipient: 'X' })).status, 403);
  const a = await login('alia', 'pass-word-1');
  assert.equal((await a.get('/quotations/settings')).status, 200);
  let r = await a.post('/quotations/settings/series', { series: 'QT-WM', year: '2026', next_no: '403' });
  assert.match(decodeURIComponent(r.location), /QT-WM-2026-0404 is already used/);
  r = await a.post('/quotations/settings', { markup_default: '25', markup_floor: '15', recipient: 'Medkad Sdn Bhd\nShah Alam', tel: '03-1234', cc: '' });
  assert.match(decodeURIComponent(r.location), /saved/);
  r = await a.post('/quotations/settings', { markup_default: 'abc', markup_floor: '15', recipient: 'X' });
  assert.match(decodeURIComponent(r.location), /Markup must be/);
  // signature: only a real JPEG / PNG
  r = await a.post('/quotations/settings/signature', { file: `data:image/jpeg;base64,${Buffer.from('not a picture').toString('base64')}` });
  assert.match(decodeURIComponent(r.location), /isn’t a JPEG or PNG/);

  // 2027: no start number yet → Generate refused (no guessing)
  today = '2027-01-04';
  const c = await h.post('/quotations', { items: 'Ensure Gold 850g ×2' });
  const cid = Number(c.location.split('/').pop());
  const [l1] = await lineIds(cid);
  await h.post(`/quotations/${cid}`, { [`l[i${l1}][pick]`]: String(await pid('ENSURE GOLD POWDER (VANILLA) 800G')) });
  const line = (await db.query('SELECT unit_price, stock_option FROM quotation_lines WHERE id = $1', [l1])).rows[0];
  assert.equal(Number(line.unit_price), 138.9, '25% markup now: 111.11 × 1.25 = 138.8875 → 138.90');
  assert.equal(line.stock_option, 'readystock');
  r = await h.post(`/quotations/${cid}/generate`, {});
  assert.match(decodeURIComponent(r.location), /no QT-WM number for 2027 yet/);
  assert.equal((await db.query('SELECT status FROM quotations WHERE id = $1', [cid])).rows[0].status, 'draft');
  r = await a.post('/quotations/settings/series', { series: 'QT-WM', year: '2027', next_no: '1' });
  assert.match(decodeURIComponent(r.location), /QT-WM-2027-0001/);
  r = await h.post(`/quotations/${cid}/generate`, {});
  assert.match(decodeURIComponent(r.location), /QT-WM-2027-0001 is ready/);
  today = '2026-11-11';
});

test('salary guard and drafts: pay words refused; a draft can be deleted by its maker', async () => {
  const h = await login('hafizah', 'pass-word-1');
  const r = await h.post('/quotations', { items: 'Staff salary advance ×1' });
  assert.match(decodeURIComponent(r.location), /salar|pay/i);
  const c = await h.post('/quotations', { items: 'Ensure Gold 850g ×1\nWipes ×2' });
  const cid = Number(c.location.split('/').pop());
  const [, l2] = await lineIds(cid);
  await h.post(`/quotations/${cid}`, { [`l[i${l2}][remove]`]: '1', add: 'Underpad 75cm x 75cm 10\'s ×3' });
  const rows = (await db.query('SELECT line_no, portal_text, qty FROM quotation_lines WHERE quotation_id = $1 ORDER BY line_no', [cid])).rows;
  assert.deepEqual(rows.map((x) => [x.line_no, x.portal_text, x.qty]), [[1, 'Ensure Gold 850g', 1], [2, "Underpad 75cm x 75cm 10's", 3]]);
  const a = await login('alia', 'pass-word-1');
  assert.match(decodeURIComponent((await a.post(`/quotations/${cid}/delete`, {})).location), /Only the person who started/);
  assert.match(decodeURIComponent((await h.post(`/quotations/${cid}/delete`, {})).location), /Draft deleted/);
});

test('every branch quotes with its own numbers; managers see only their branch', async () => {
  const jh = await login('afifah', 'pass-word-1');
  const list = await jh.get('/quotations');
  assert.match(list.html, /Zakat quotation – Jenderam Hilir/);
  assert.doesNotMatch(list.html, /QT-WM-2026-0403/, 'JH does not see WM quotes');
  // a WM quote is not there for JH
  const wmId = (await db.query("SELECT id FROM quotations WHERE ref = 'QT-WM-2026-0403'")).rows[0].id;
  assert.equal((await jh.get(`/quotations/${wmId}`)).status, 404);
  assert.equal((await jh.get(`/quotations/${wmId}/pdf`)).status, 404);
  // JH asks for WM in the form – still a JH quote
  const c = await jh.post('/quotations', { outlet: 'WM', items: 'Ensure Gold 850g ×2' });
  const id = Number(c.location.split('/').pop());
  const q = (await db.query('SELECT outlet, series FROM quotations WHERE id = $1', [id])).rows[0];
  assert.deepEqual(q, { outlet: 'JH', series: 'QT-JH' });
  const [l1] = await lineIds(id);
  await jh.post(`/quotations/${id}`, { [`l[i${l1}][pick]`]: String(await pid('ENSURE GOLD POWDER (VANILLA) 800G')) });
  const r = await jh.post(`/quotations/${id}/generate`, {});
  assert.match(decodeURIComponent(r.location), /QT-JH-2026-0073 is ready/, 'JH continues its own count (0072 was the last on paper)');
  const pdf = await jh.get(`/quotations/${id}/pdf`);
  assert.equal(pdf.buf.subarray(0, 5).toString(), '%PDF-');
});

test('BR: same layout as WM, its own footer address and signer; HQ picks the branch', async () => {
  const a = await login('alia', 'pass-word-1');
  let r = await a.post('/quotations/settings/branch/BR', { signer: 'nur amirah abd karim', title: '(Pharmacist)', footer_lines: 'Bandar Rinching, Semenyih\nTel: 000-000 0000' });
  assert.match(decodeURIComponent(r.location), /Bandar Rinching saved/);
  const cfg = await require('../../src/quotations/data').branchConfig(db, 'BR');
  assert.equal(cfg.signer, 'NUR AMIRAH ABD KARIM'); assert.equal(cfg.layout, 'p4u');
  const c = await a.post('/quotations', { outlet: 'BR', items: 'Underpad 75cm x 75cm 10\'s ×5' });
  const id = Number(c.location.split('/').pop());
  assert.equal((await db.query('SELECT outlet FROM quotations WHERE id = $1', [id])).rows[0].outlet, 'BR');
  const [l1] = await lineIds(id);
  await a.post(`/quotations/${id}`, { [`l[i${l1}][pick]`]: String(await pid('PRIMES DISPOSABLE UNDERPAD 75X75 4PLY 10 SHEETS')) });
  r = await a.post(`/quotations/${id}/generate`, {});
  assert.match(decodeURIComponent(r.location), /QT-BR-2026-0034 is ready/);
  // Amirah (BR manager) sees it; Hafizah (WM) doesn't
  assert.equal((await (await login('amirah', 'pass-word-1')).get(`/quotations/${id}`)).status, 200);
  assert.equal((await (await login('hafizah', 'pass-word-1')).get(`/quotations/${id}`)).status, 404);
});

test('Bangi: no signer set yet → no PDF until admin / Alia sets one; pictures per branch', async () => {
  const bg = await login('aimi', 'pass-word-1');
  const c = await bg.post('/quotations', { items: 'Ensure Gold 850g ×1' });
  const id = Number(c.location.split('/').pop());
  const [l1] = await lineIds(id);
  await bg.post(`/quotations/${id}`, { [`l[i${l1}][pick]`]: String(await pid('ENSURE GOLD POWDER (VANILLA) 800G')) });
  assert.match((await bg.get(`/quotations/${id}`)).html, /Who signs Bangi’s quotations isn’t set yet/);
  let r = await bg.post(`/quotations/${id}/generate`, {});
  assert.match(decodeURIComponent(r.location), /Set who signs Bangi/);
  assert.equal((await bg.post('/quotations/settings/branch/Bangi', { signer: 'X' })).status, 403, 'managers don\'t change settings');
  const a = await login('alia', 'pass-word-1');
  await a.post('/quotations/settings/branch/Bangi', { signer: 'Aimi Test', title: '(Pharmacist)', footer_lines: 'Bangi address line\nTel: 000' });
  // a 1×1 PNG as the Bangi footer picture
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  r = await a.post('/quotations/settings/image/Bangi/footer', { file: `data:image/png;base64,${png}` });
  assert.match(decodeURIComponent(r.location), /Bangi: footer saved/);
  assert.equal((await a.get('/quotations/settings/image/Bangi/footer')).type, 'image/png');
  assert.match(decodeURIComponent((await a.post('/quotations/settings/image/Bangi/nonsense', { file: `data:image/png;base64,${png}` })).location), /Unknown picture/);
  r = await bg.post(`/quotations/${id}/generate`, {});
  assert.match(decodeURIComponent(r.location), /QT-BGI-2026-0001 is ready/);
  const set = await a.get('/quotations/settings');
  for (const s of ['QT-WM', 'QT-JH', 'QT-BR', 'QT-BGI', 'QT-AMP']) assert.match(set.html, new RegExp(s));
});

test('Won / Cancelled: Won counts in Zakat claims; only a cancelled quotation can be deleted; the newest number is given back', async () => {
  const idOf = async (ref) => (await db.query('SELECT id FROM quotations WHERE ref = $1', [ref])).rows[0].id;
  const next = async (series) => (await db.query('SELECT next_no FROM quotation_series WHERE series = $1 AND year = 2026', [series])).rows[0].next_no;
  const h = await login('hafizah', 'pass-word-1');
  const id403 = await idOf('QT-WM-2026-0403'); const id404 = await idOf('QT-WM-2026-0404');
  // an issued (open) quotation can't be deleted – cancel it first
  let page = (await h.get(`/quotations/${id404}`)).html;
  assert.match(page, /✔ Won/); assert.match(page, /✕ Cancelled/);
  assert.doesNotMatch(page, /Delete this quotation/);
  assert.match(decodeURIComponent((await h.post(`/quotations/${id404}/delete`, { confirm: '1' })).location), /mark QT-WM-2026-0404 Cancelled first/);

  // Excel copy of a quotation
  const x = await h.get(`/quotations/${id403}/xlsx`);
  assert.equal(x.status, 200);
  assert.match(x.type, /spreadsheetml/);
  const ExcelJS = require('exceljs'); const wb = new ExcelJS.Workbook(); await wb.xlsx.load(x.buf);
  const cells = []; wb.worksheets[0].eachRow((row) => row.eachCell((c) => cells.push(String(c.value))));
  assert.ok(cells.includes('QT-WM-2026-0403')); assert.ok(cells.includes('ENSURE GOLD POWDER (VANILLA) 800G')); assert.ok(cells.includes('TOTAL'));
  assert.ok(!cells.some((c) => /pre-order/i.test(c)), 'no pre-order line on the customer\'s copy');
  assert.ok(cells.includes('ALIA SURAYA BINTI ESA'));

  // Won → listed on Zakat claims (WM) and counted as a contract won in its week
  let r = await h.post(`/quotations/${id403}/outcome`, { outcome: 'won' });
  assert.match(decodeURIComponent(r.location), /QT-WM-2026-0403: Won\. It counts as a contract won in Zakat claims/);
  const zk = await h.get('/zakat?branch=WM&month=2026-11&tab=overview');
  assert.match(zk.html, /Won quotations – to claim/);
  assert.match(zk.html, /QT-WM-2026-0403/);
  const wk = await h.get('/zakat?branch=WM&month=2026-11&tab=weekly&week=2026-11-09');
  assert.match(wk.html, /From zakat quotations this week: <b>2<\/b> issued, <b>1<\/b> won/);
  assert.match(wk.html, /name="bids" inputmode="numeric" value="2"/, 'filled in for the PIC when nothing is typed yet');
  const Q = require('../../src/quotations/data');
  assert.deepEqual((await Q.zakatWeeks(db, 'WM'))['2026-11-09'], { bids: 2, won: 1, wonTotal: 7264.2 });
  // a Won quotation can't be deleted either; Undo brings it back to open
  assert.match(decodeURIComponent((await h.post(`/quotations/${id403}/delete`, { confirm: '1' })).location), /Cancelled first/);
  r = await h.post(`/quotations/${id403}/outcome`, { outcome: 'issued' });
  assert.match(decodeURIComponent(r.location), /Open/);

  // another branch's manager can't touch it; HQ staff (not Alia) can't delete a cancelled one
  const jhm = await login('afifah', 'pass-word-1');
  assert.match(decodeURIComponent((await jhm.post(`/quotations/${id404}/outcome`, { outcome: 'cancelled' })).location), /isn’t in the list/);
  // Cancelled → delete (Hafizah, WM's manager); 0404 is the newest so the number comes back
  r = await h.post(`/quotations/${id404}/outcome`, { outcome: 'cancelled' });
  assert.match(decodeURIComponent(r.location), /Cancelled\. You can delete it now/);
  page = (await h.get(`/quotations/${id404}`)).html;
  assert.match(page, /Yes, delete QT-WM-2026-0404/);
  const hn = await login('hanin', 'pass-word-1');
  assert.match(decodeURIComponent((await hn.post(`/quotations/${id404}/delete`, { confirm: '1' })).location), /Only admin, Alia and the branch manager/);
  assert.match(decodeURIComponent((await h.post(`/quotations/${id404}/delete`, {})).location), /Tick “Yes, delete QT-WM-2026-0404” first/);
  assert.equal(await next('QT-WM'), 405);
  r = await h.post(`/quotations/${id404}/delete`, { confirm: '1' });
  assert.match(decodeURIComponent(r.location), /QT-WM-2026-0404 deleted\. The next QT-WM quotation gets QT-WM-2026-0404 again/);
  assert.equal(await next('QT-WM'), 404);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM quotation_lines WHERE quotation_id = $1', [id404])).rows[0].n, 0);
  const log = (await db.query("SELECT old_value FROM audit_log WHERE table_name = 'quotations' AND action = 'delete' AND record_key = 'QT-WM-2026-0404'")).rows[0];
  assert.ok(log, 'the audit log keeps what was deleted');

  // an older number is not given back: two JH quotes, cancel and delete the older one (Alia)
  const a = await login('alia', 'pass-word-1');
  const mk = async () => {
    const c = await jhm.post('/quotations', { items: 'Ensure Gold 850g ×1' });
    const qid = Number(c.location.split('/').pop()); const [l1] = await lineIds(qid);
    await jhm.post(`/quotations/${qid}`, { [`l[i${l1}][pick]`]: String(await pid('ENSURE GOLD POWDER (VANILLA) 800G')) });
    await jhm.post(`/quotations/${qid}/generate`, {});
    return qid;
  };
  const older = await mk(); await mk();
  const before = await next('QT-JH');
  await a.post(`/quotations/${older}/outcome`, { outcome: 'cancelled' });
  r = await a.post(`/quotations/${older}/delete`, { confirm: '1' });
  assert.match(decodeURIComponent(r.location), /won’t be used again/);
  assert.equal(await next('QT-JH'), before);
});
