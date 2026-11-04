// 4 Nov (CEO: "whatever we tick in 4DX … update in Telegram as well … so we don't need to update"):
// changes on /inventory go to the team's Telegram group and are written back to the Payment_Approvals sheet.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');

const { createDb } = require('../../src/db');
const { migrate } = require('../../src/db/migrate');
const { readSeed, loadSeed } = require('../../src/db/seed');
const { createApp } = require('../../src/app');
const inv = require('../../src/inventory/data');
const { createTelegram } = require('../../src/lib/telegram');
const { createPaymentsSheet, HEADER } = require('../../src/inventory/sheet');
const { createInventoryEvents } = require('../../src/inventory/events');

const sent = [];
const tgFetch = async (url, opts) => {
  assert.match(url, /^https:\/\/api\.telegram\.org\/bot123456:[\w-]+\/sendMessage$/);
  const b = JSON.parse(opts.body);
  assert.equal(b.chat_id, '-1009876543210');
  sent.push(b.text);
  return { ok: true, status: 200, json: async () => ({ ok: true }) };
};
const telegram = createTelegram({ env: { TELEGRAM_BOT_TOKEN: '123456:ABCdefGhIJKlmnoPQRstuVWxyz_12345', TELEGRAM_CHAT_ID: '-1009876543210' }, fetchImpl: tgFetch, log: () => {} });

const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 1024 });
const account = { email: 'p4u-dashboard@pharmacy4u-4dx.iam.gserviceaccount.com', privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }) };
const writes = []; let sheetStatus = 200;
const gFetch = async (url, opts = {}) => {
  const json = (code, body) => ({ ok: code < 400, status: code, json: async () => body });
  if (url.startsWith('https://oauth2.googleapis.com/token')) {
    const claims = JSON.parse(Buffer.from(new URLSearchParams(opts.body).get('assertion').split('.')[1], 'base64url').toString());
    assert.equal(claims.scope, 'https://www.googleapis.com/auth/spreadsheets');
    return json(200, { access_token: 't' });
  }
  if (sheetStatus !== 200) return json(sheetStatus, { error: { message: 'The caller does not have permission' } });
  if (/\?fields=sheets\.properties\.title$/.test(url)) return json(200, { sheets: [{ properties: { title: 'Payment_Approvals' } }] });
  if (/values:batchClear$/.test(url)) { writes.push({ clear: JSON.parse(opts.body).ranges }); return json(200, {}); }
  if (/\/values\//.test(url) && opts.method === 'PUT') {
    assert.match(url, /valueInputOption=RAW/);
    writes.push({ put: JSON.parse(opts.body).values }); return json(200, {});
  }
  return json(404, { error: { message: 'nope' } });
};

let db; let server; let base; let sheet; let events;
const now = () => new Date('2026-11-04T10:00:00+08:00');
test.before(async () => {
  db = await createDb({ url: '', localDir: 'memory' });
  await migrate(db);
  await loadSeed(db, readSeed(), { adminPassword: 'admin-pass-1' });
  await inv.loadBundledOnce(db);
  await db.query("UPDATE users SET is_super = true WHERE username = 'admin'");
  await db.query('UPDATE users SET pin_hash = $1 WHERE username = $2', [bcrypt.hashSync('4242', 4), 'azwani']);
  await db.query('UPDATE users SET password_hash = $1 WHERE username = $2', [bcrypt.hashSync('alia-pass-1', 4), 'alia']);
  sheet = createPaymentsSheet(db, { account, fetchImpl: gFetch, now, log: () => {}, delayMs: 10 });
  events = createInventoryEvents(db, { telegram, sheet, now, env: { RAILWAY_PUBLIC_DOMAIN: 'p4u-4dx.up.railway.app' }, tickWindowMs: 50 });
  server = createApp(db, { now, inventoryEvents: events, inventorySheet: sheet, telegram }).listen(0);
  base = `http://localhost:${server.address().port}`;
});
test.after(async () => { events.flush(); server.close(); await db.close(); });

async function login(kind, username, secret) {
  let cookie = '';
  const req = async (method, p, body) => {
    const r = await fetch(base + p, { method, redirect: 'manual', headers: { ...(cookie ? { cookie } : {}), ...(body ? { 'content-type': 'application/x-www-form-urlencoded' } : {}) }, body: body ? new URLSearchParams(body).toString() : undefined });
    const set = r.headers.get('set-cookie'); if (set) cookie = set.split(';')[0];
    return { status: r.status, html: await r.text() };
  };
  await req('POST', kind === 'pin' ? '/login/pin' : '/login/password', kind === 'pin' ? { username, pin: secret } : { username, password: secret });
  let csrf;
  return { get: (p) => req('GET', p), post: async (p, b) => { if (!csrf) csrf = (await req('GET', '/inventory')).html.match(/name="_csrf" value="([^"]+)"/)[1]; return req('POST', p, { _csrf: csrf, ...b }); } };
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn) => { for (let i = 0; i < 100; i++) { if (fn()) return; await wait(20); } assert.fail('timed out'); };

test('CEO approves and Azwani marks paid → Telegram messages + the sheet rewritten from 4DX', async () => {
  const ceo = await login('password', 'admin', 'admin-pass-1');
  const az = await login('pin', 'azwani', '4242');
  const dksh = (await db.query("SELECT id FROM inv_payments WHERE supplier = 'DKSH (104)'")).rows[0].id;
  sent.length = 0; writes.length = 0;
  await ceo.post(`/inventory/payments/${dksh}/approve`, { approved: 'Yes' });
  await until(() => sent.length === 1);
  assert.match(sent[0], /^👍 Dr Aisyah approved DKSH \(104\) RM35,677 \(to pay 19 Nov\)\. Azwani can pay it in Swipey\.\nhttps:\/\/p4u-4dx\.up\.railway\.app\/inventory#payments$/);
  await az.post(`/inventory/payments/${dksh}/paid`, { date_paid: '2026-11-04', paid_via: 'Swipey', pv_no: 'SWP-7781' });
  await until(() => sent.length === 2);
  assert.match(sent[1], /^✅ Azwani marked DKSH \(104\) RM35,677 paid on 4 Nov – Swipey, ref SWP-7781\. Every DKSH \(104\) payment is now paid – Alia can order from them\./);
  // The sheet: rewritten (several quick changes → written after the last one), same headers Mr Eve reads.
  await until(() => writes.some((w) => w.put) && (writes.filter((w) => w.put).pop().put.find((r) => r[2] === 'DKSH (104)') || [])[6] === 'Yes');
  const rows = writes.filter((w) => w.put).pop().put;
  assert.deepEqual(rows[0], HEADER);
  assert.equal(rows[1][0].startsWith('EXAMPLE'), true, 'the explaining EXAMPLE row stays (readers skip it)');
  const d = rows.find((r) => r[2] === 'DKSH (104)');
  assert.deepEqual(d.slice(0, 11), ['16-22 Nov', '19/11/2026', 'DKSH (104)', 35677, 'Yes', 35677, 'Yes', '04/11/2026', d[8], 'Swipey', 'SWP-7781']);
  assert.ok(writes.some((w) => w.clear && w.clear[0] === "'Payment_Approvals'!A1:L2000"), 'old rows cleared first');
  // Undo is announced too
  await az.post(`/inventory/payments/${dksh}/paid`, { undo: '1' });
  await until(() => sent.length === 3);
  assert.match(sent[2], /^↩️ Azwani marked DKSH \(104\) RM35,677 as NOT paid/);
  const st = await sheet.status();
  assert.equal(st.error, null);
  assert.match((await ceo.get('/inventory')).html, /Payment_Approvals sheet: kept in step by 4DX/);
});

test('ticks are gathered into one message per person', async () => {
  const alia = await login('password', 'alia', 'alia-pass-1');
  const ids = (await db.query('SELECT id, item FROM inv_plan_lines ORDER BY id LIMIT 3')).rows;
  sent.length = 0;
  for (const l of ids) await alia.post(`/inventory/lines/${l.id}`, { done: '1' });
  await alia.post(`/inventory/lines/${ids[0].id}`, { done: '0' }); // undo – not announced
  await until(() => sent.length === 1);
  await wait(80);
  assert.equal(sent.length, 1);
  assert.match(sent[0], /^☑️ Alia ticked 3 lines done on Mr Eve's list:\n• /);
  for (const l of ids) assert.ok(sent[0].includes(l.item), l.item);
});

test('Mr Eve’s plan arriving is announced with today’s numbers', async () => {
  sent.length = 0;
  await events.planLoaded('2026-11-03', inv.loadPage);
  assert.equal(sent.length, 1);
  assert.match(sent[0], /^📋 Mr Eve's plan for 3 Nov is in 4DX: \d+ urgent, \d+ transfers first \(no cash\), \d+ to order now \(about RM[\d,]+\), \d+ waiting for a supplier payment\./);
});

test('sheet not shared as Editor → a clear message on the page; Telegram off without its settings; no salaries sent', async () => {
  sheetStatus = 403;
  await assert.rejects(sheet.syncNow(), /Share it with p4u-dashboard@pharmacy4u-4dx\.iam\.gserviceaccount\.com as Editor/);
  const ceo = await login('password', 'admin', 'admin-pass-1');
  assert.match((await ceo.get('/inventory')).html, /Payment_Approvals sheet: not updated – 4DX can&#39;t update the Payment_Approvals sheet/);
  sheetStatus = 200;
  const off = createTelegram({ env: {}, fetchImpl: async () => assert.fail('no call') });
  assert.equal(off.configured(), false);
  assert.deepEqual(await off.send('hello'), { off: true });
  assert.deepEqual(await telegram.send('Pay the salary first'), { skipped: true });
  assert.equal(createTelegram({ env: { TELEGRAM_BOT_TOKEN: 'nonsense', TELEGRAM_CHAT_ID: '-100' } }).configured(), false);
});
