// Out-of-stock flow (16 Oct): branch reports any time → Inventory answers by 11 am next working
// day → Fariz sends a transfer within 24 h → branch confirms back in stock → scoreboard.

const test = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');

const { createDb } = require('../../src/db');
const { migrate } = require('../../src/db/migrate');
const { readSeed, loadSeed } = require('../../src/db/seed');
const { createApp } = require('../../src/app');
const oos = require('../../src/oos/data');
const calc = require('../../src/calc');

let db; let server; let base;
// A clock the tests move: Thu 15 Oct 2026, 9:40 pm Malaysia time.
let clock = new Date('2026-10-15T21:40:00+08:00');
const now = () => clock;

test.before(async () => {
  db = await createDb({ url: '', localDir: 'memory' });
  await migrate(db);
  await loadSeed(db, readSeed(), { adminPassword: 'admin-pass-1' });
  const pw = (u, v) => db.query('UPDATE users SET password_hash = $1 WHERE username = $2', [bcrypt.hashSync(v, 4), u]);
  const pin = (u, v) => db.query('UPDATE users SET pin_hash = $1 WHERE username = $2', [bcrypt.hashSync(v, 4), u]);
  await pw('alia', 'alia-pass-1'); await pw('hafizah', 'manager-pass-1');
  await pin('hazera', '1111'); await pin('fariz', '1357'); await pin('yaya', '2222');
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
      if (!csrf) csrf = ((await req('GET', '/sales')).html.match(/name="_csrf" value="([^"]+)"/) || (await req('GET', '/daily')).html.match(/name="_csrf" value="([^"]+)"/) || [])[1];
      return req('POST', p, { _csrf: csrf, ...body });
    },
  };
}

test('answer deadline: 11 am the next working day (Friday or weekend → Monday)', () => {
  const due = (s) => oos.answerDueFor(new Date(s), 11).toISOString();
  assert.equal(due('2026-10-15T21:40:00+08:00'), new Date('2026-10-16T11:00:00+08:00').toISOString());
  assert.equal(due('2026-10-16T09:00:00+08:00'), new Date('2026-10-19T11:00:00+08:00').toISOString(), 'Friday → Monday');
  assert.equal(due('2026-10-17T15:00:00+08:00'), new Date('2026-10-19T11:00:00+08:00').toISOString(), 'Saturday → Monday');
});

test('the whole flow: report → inbox badge → transfer answer → Fariz sends → branch receives → scoreboard', async () => {
  const staff = await login('pin', 'hazera', '1111');
  // Daily entry shows the out-of-stock box with the Report button
  const daily = (await staff.get('/daily')).html;
  assert.match(daily, /Report out of stock/);
  // A report with a missing choice is refused and nothing saved
  const bad = await staff.post('/oos', { item: 'Loyuric 100mg (30s)' });
  assert.equal(bad.status, 400);
  assert.match(bad.html, /Pick none or low/);
  const r = await staff.post('/oos', { item: 'Loyuric 100mg (30s)', left: 'none', asking: '1-2', urgent: '1', note: 'Pn. Rosnah, gout' });
  assert.equal(r.status, 302);
  const item = (await db.query("SELECT * FROM oos_items WHERE item = 'Loyuric 100mg (30s)'")).rows[0];
  assert.equal(item.left_qty, 0); assert.equal(item.urgent, true); assert.equal(item.customers_count, 2);
  assert.equal(item.week_start, '2026-10-12');
  assert.equal(new Date(item.answer_due).toISOString(), new Date('2026-10-16T11:00:00+08:00').toISOString());

  // Alia: red badge in the menu, item at the top of the inbox
  const alia = await login('password', 'alia', 'alia-pass-1');
  const inbox = (await alia.get('/oos/inbox')).html;
  assert.match(inbox, /class="sn-badge"[^>]*>1</);
  assert.match(inbox, /Loyuric 100mg \(30s\)[\s\S]*URGENT/);
  assert.match(inbox, /13 h 20 m left/);
  // 19 Oct: the inventory team (Alia, Syarafana, Fariz) has the inbox; other HQ (Hanin) and staff don't
  const fariz = await login('pin', 'fariz', '1357');
  assert.equal((await fariz.get(`/oos/${item.id}`)).status, 200);
  await db.query('UPDATE users SET password_hash = $1 WHERE username = $2', [bcrypt.hashSync('hanin-pass-1', 4), 'hanin']);
  const hn = await login('password', 'hanin', 'hanin-pass-1');
  assert.equal((await hn.get('/oos/inbox')).status, 403);
  assert.equal((await hn.get('/oos/transfers')).status, 403);
  assert.doesNotMatch((await hn.get('/hq/today')).html, /Out-of-stock inbox/);
  assert.match(inbox, /Inventory<\/summary>/);
  assert.equal((await staff.post(`/oos/${item.id}/answer`, { answer: 'order', qty: '5', expected_back: '2026-10-20' })).status, 403);
  // Answer: transfer 6 from JH
  clock = new Date('2026-10-16T10:05:00+08:00');
  const ans = await alia.post(`/oos/${item.id}/answer`, { answer: 'transfer', from: 'JH', qty: '6', expected_back: '2026-10-17' });
  assert.equal(ans.status, 302);
  // The branch sees the answer on Daily entry
  assert.match((await staff.get('/daily')).html, /Transfer 6 from JH/);
  // Fariz's list: send by 10:05 am tomorrow
  const xfers = (await fariz.get('/oos/transfers')).html;
  assert.match(xfers, /Loyuric 100mg \(30s\) × 6/);
  assert.match(xfers, /<b>JH<\/b> → <b>WM<\/b>/);
  clock = new Date('2026-10-16T15:40:00+08:00');
  assert.equal((await fariz.post(`/oos/${item.id}/picked`, {})).status, 302);
  assert.equal((await fariz.post(`/oos/${item.id}/sent`, {})).status, 302);
  // Another branch's staff can't close it; this branch can
  const jhStaff = await login('pin', 'yaya', '2222');
  assert.equal((await jhStaff.post(`/oos/${item.id}/received`, {})).status, 403);
  clock = new Date('2026-10-17T12:00:00+08:00');
  assert.equal((await staff.post(`/oos/${item.id}/received`, {})).status, 302);
  const done = (await db.query('SELECT status, received_at FROM oos_items WHERE id = $1', [item.id])).rows[0];
  assert.equal(done.status, 'Back in stock');

  // Scoreboard for the week of 12 Oct: answered on time, transfer on time, 1.6 days to restock
  const b = await oos.buildBoard(db, { week: '2026-10-12', now });
  assert.equal(b.answered.done, 1); assert.equal(b.answered.total, 1);
  assert.equal(b.transfers.pct, 1);
  assert.ok(Math.abs(b.restock.transfer - (1 + (14 * 60 + 20) / 1440)) < 1e-6, 'Thu 9:40 pm → Sat 12:00 pm = 1.6 days');
  assert.equal(b.branches.find((x) => x.code === 'WM').customers, 2);
  const page = (await alia.get('/oos/scoreboard?week=2026-10-12')).html;
  assert.match(page, /100% ✔/);
  // Audit trail for every step
  const steps = (await db.query("SELECT record_key FROM audit_log WHERE table_name = 'oos_items' ORDER BY id")).rows.map((x) => x.record_key);
  assert.deepEqual(steps.map((k) => k.replace(/^WM #\d+ ?/, '')), ['', 'answer', 'picked', 'sent', 'received']);
});

test('late items and repeats: order past its date shows LATE, branch can tell Inventory; repeats counted', async () => {
  clock = new Date('2026-10-19T09:00:00+08:00');
  const mgr = await login('password', 'hafizah', 'manager-pass-1');
  await mgr.post('/oos', { item: 'Dermacyn wound gel', left: 'low', left_qty: '2', asking: '0' });
  await mgr.post('/oos', { item: 'dermacyn wound gel', left: 'none', asking: '3+' });
  const ids = (await db.query("SELECT id FROM oos_items WHERE lower(item) = 'dermacyn wound gel' ORDER BY id")).rows.map((r) => r.id);
  const alia = await login('password', 'alia', 'alia-pass-1');
  await alia.post(`/oos/${ids[0]}/answer`, { answer: 'order', qty: '10', expected_back: '2026-10-20' });
  await alia.post(`/oos/${ids[1]}/answer`, { answer: 'substitute', substitute: 'Hydrocyn gel 50g' });
  clock = new Date('2026-10-22T09:00:00+08:00');
  const page = (await mgr.get('/oos')).html;
  assert.match(page, /LATE/);
  assert.match(page, /Offer instead: Hydrocyn gel 50g/);
  assert.equal((await mgr.post(`/oos/${ids[0]}/late`, {})).status, 302);
  const inbox = (await alia.get('/oos/inbox?tab=waiting')).html;
  assert.match(inbox, /Branch says it’s late/);
  const b = await oos.buildBoard(db, { week: '2026-10-19', now });
  assert.ok(b.repeats.some((r) => /dermacyn/i.test(r.item) && r.n === 2));
  // The Monday check-in list and the group scoreboard still count them as open
  const open = (await db.query("SELECT count(*)::int AS n FROM oos_items WHERE status = ANY($1)", [oos.OPEN])).rows[0].n;
  assert.equal(open, 2);
});

test('who sees what: staff no inbox or scoreboard; HQ staff get transfers; salary words refused', async () => {
  const staff = await login('pin', 'hazera', '1111');
  assert.equal((await staff.get('/oos/inbox')).status, 403);
  assert.equal((await staff.get('/oos/scoreboard')).status, 403);
  const fariz = await login('pin', 'fariz', '1357');
  assert.equal((await fariz.get('/oos')).location, '/oos/transfers');
  assert.equal((await fariz.post('/oos', { item: 'x', left: 'none' })).status, 403);
  const r = await staff.post('/oos', { item: 'Salary advance form', left: 'none', asking: '0' });
  assert.equal(r.status, 400);
});

test('HQ input for Alia: only her own numbers, filled in from her daily ticks and the transfers', async () => {
  clock = new Date('2026-10-19T09:00:00+08:00'); // Monday: entering the week of 12 Oct
  const alia = (await db.query("SELECT id FROM people WHERE name = 'Alia' AND branch_id IS NULL")).rows[0].id;
  const task = (await db.query("SELECT id FROM hq_daily_tasks WHERE person_id = $1 AND label LIKE 'B2B quotes%'", [alia])).rows[0].id;
  const tick = (d, done, na = false) => db.query('INSERT INTO hq_daily_ticks (task_id, entry_date, done, na) VALUES ($1, $2, $3, $4)', [task, d, done, na]);
  await tick('2026-10-13', true); await tick('2026-10-14', true); await tick('2026-10-15', false); await tick('2026-10-16', false, true);
  const b = await login('password', 'alia', 'alia-pass-1');
  const page = (await b.get('/hq?week=2026-10-12')).html;
  assert.match(page, /My HQ numbers/);
  assert.doesNotMatch(page, /Shifts fully staffed/, 'Hanin’s measures hidden by default');
  assert.match(page, /Suggested<\/span> from days you ticked “quotes sent within 24 hours” Done, out of days ticked \(2 of 3\)/);
  assert.match(page, /Suggested<\/span> from out-of-stock transfers sent within 48 hours of your answer \(1 of 1\)/);
  assert.match((await b.get('/hq?week=2026-10-12&show=all')).html, /Shifts fully staffed/);
  // Saving the suggested boxes stores them like typed numbers
  const quotes = (await db.query("SELECT id FROM hq_measures WHERE code = 'quotes'")).rows[0].id;
  const r = await b.post('/hq', { week: '2026-10-12', [`v[m${quotes}]`]: '2', [`t[m${quotes}]`]: '3' });
  assert.equal(r.status, 302);
  const e = (await db.query('SELECT value, total FROM hq_entries WHERE hq_measure_id = $1 AND week_start = $2', [quotes, '2026-10-12'])).rows[0];
  assert.deepEqual([Number(e.value), Number(e.total)], [2, 3]);
  assert.match((await b.get('/hq?week=2026-10-19')).html, /Last week: 2 of 3/);
});

test('company wiki checklist: 64 pages, Iman writes, Hanin approves, approvals feed the weekly wiki measures', async () => {
  const pw = (u, v) => db.query('UPDATE users SET password_hash = $1 WHERE username = $2', [bcrypt.hashSync(v, 4), u]);
  await pw('iman', 'iman-pass-1'); await pw('hanin', 'hanin-pass-1');
  const n = (await db.query("SELECT count(*)::int AS n, count(*) FILTER (WHERE priority = 'P1')::int AS p1 FROM hq_wiki_items")).rows[0];
  assert.deepEqual([n.n, n.p1], [64, 28]);
  clock = new Date('2026-10-20T10:00:00+08:00');
  const hanin = await login('password', 'hanin', 'hanin-pass-1');
  const page = (await hanin.get('/hq/wiki')).html;
  assert.match(page, /0 of 28/);
  // 18 Oct: Iman owns every page and sends it to Hanin (Checking); only Hanin approves.
  const sop = (await db.query("SELECT id FROM hq_wiki_items WHERE title = 'Opening the branch'")).rows[0].id;
  const about = (await db.query("SELECT id FROM hq_wiki_items WHERE title = 'Vision, mission and values'")).rows[0].id;
  const iman = await login('password', 'iman', 'iman-pass-1');
  assert.match(decodeURIComponent((await iman.post(`/hq/wiki/${about}`, { status: 'Approved' })).location), /Hanin approves/, 'Iman can’t approve');
  await iman.post(`/hq/wiki/${sop}`, { status: 'Checking', writer: 'Hafizah' });
  await iman.post(`/hq/wiki/${about}`, { status: 'Checking' });
  await hanin.post(`/hq/wiki/${sop}`, { status: 'Approved', writer: 'Hafizah' });
  await hanin.post(`/hq/wiki/${about}`, { status: 'Approved' });
  // Weekly measures are filled in from the checklist (app clock: approved this week)
  const week = calc.weekStart('2026-10-20');
  const { suggestions } = require('../../src/hq/suggest');
  const hq = require('../../src/hq/data');
  const user = (await db.query("SELECT * FROM users WHERE username = 'hanin'")).rows[0];
  const rows = (await hq.loadHqWeek(db, { week, user })).filter((r) => r.canEdit);
  const s = await suggestions(db, { week, rows, today: '2026-10-20' });
  const m = rows.find((r) => r.code === 'wikisop');
  assert.equal(s.get(m.id).value, 2, 'Hanin approved 2 pages this week');
  assert.match((await hanin.get('/hq/wiki')).html, /2 of 28/);
  // Daily tasks include the wiki task; the HQ scoreboard shows progress
  const tasks = (await db.query("SELECT label FROM hq_daily_tasks t JOIN people p ON p.id = t.person_id WHERE p.name IN ('Iman', 'Hanin') AND t.label LIKE 'Company wiki%'")).rows;
  assert.equal(tasks.length, 2);
  assert.match((await hanin.get('/hq/scoreboard')).html, /Company wiki: <a href="\/hq\/wiki">2 of 28 must-have pages approved/);
  // Branch staff can't open it
  const staff = await login('pin', 'hazera', '1111');
  assert.equal((await staff.get('/hq/wiki')).status, 403);
});

test('25 Oct: HQ delivers to Ampang – picked/on the way shown to the branch, branch accepts; Inventory can close it', async () => {
  clock = new Date('2026-10-26T09:00:00+08:00');
  await db.query('UPDATE users SET pin_hash = $1 WHERE username = $2', [bcrypt.hashSync('4444', 4), 'aishah']);
  const amp = await login('pin', 'aishah', '4444');
  await amp.post('/oos', { item: 'Eldon strip 10s', left: 'none', asking: '3+' });
  await amp.post('/oos', { item: 'Oat 1kg', left: 'low', left_qty: '1', asking: '0' });
  const id = async (name) => (await db.query('SELECT id FROM oos_items WHERE item = $1', [name])).rows[0].id;
  const eldon = await id('Eldon strip 10s'); const oat = await id('Oat 1kg');
  const alia = await login('password', 'alia', 'alia-pass-1');
  // "HQ delivers" is the first answer and the default; no branch to pick
  const form = (await alia.get(`/oos/${eldon}`)).html;
  assert.match(form, /value="hq_deliver" checked/);
  assert.match(form, /Done – delivered \/ fulfilled/);
  assert.equal((await alia.post(`/oos/${eldon}/answer`, { answer: 'hq_deliver', qty: '10', expected_back: '2026-10-27' })).status, 302);
  let page = (await amp.get('/oos')).html;
  assert.match(page, /HQ sends 10/);
  assert.match(page, /HQ WILL SEND/);
  assert.match(page, /aria-current="step"[^>]*>[\s\S]*?Picked at HQ/);
  // Fariz picks: the branch sees it's picked, then on the way with an Accept button on Daily entry
  const fariz = await login('pin', 'fariz', '1357');
  const xf = (await fariz.get('/oos/transfers')).html;
  assert.match(xf, /Deliveries to send/);
  assert.match(xf, /<b>HQ<\/b> → <b>Ampang<\/b>/);
  await fariz.post(`/oos/${eldon}/picked`, {});
  assert.match((await amp.get('/oos')).html, /PICKED – BEING PACKED/);
  await fariz.post(`/oos/${eldon}/sent`, {});
  const daily = (await amp.get('/daily')).html;
  assert.match(daily, /ON THE WAY – ACCEPT WHEN IT ARRIVES/);
  assert.match(daily, /Accept – received 10/);
  clock = new Date('2026-10-27T10:00:00+08:00');
  const acc = await amp.post(`/oos/${eldon}/received`, { back: '/daily' });
  assert.equal(acc.location.split('?')[0], '/daily');
  assert.equal((await db.query('SELECT status, closed_by_hq FROM oos_items WHERE id = $1', [eldon])).rows[0].status, 'Back in stock');
  assert.doesNotMatch((await fariz.get('/oos/transfers')).html, /Eldon strip/);
  // Alia fulfilled the oat herself without answering: she can still close it ("Done")
  assert.equal((await amp.post(`/oos/${oat}/done`, {})).status, 403, 'branch can’t use Inventory’s Done');
  const done = await alia.post(`/oos/${oat}/done`, { back: '/oos/inbox' });
  assert.equal(done.status, 302);
  const row = (await db.query('SELECT status, closed_by_hq, answer, answered_at FROM oos_items WHERE id = $1', [oat])).rows[0];
  assert.equal(row.status, 'Back in stock'); assert.equal(row.closed_by_hq, true); assert.equal(row.answer, 'hq_deliver'); assert.ok(row.answered_at);
  assert.match((await amp.get('/oos')).html, /DONE – DELIVERED[\s\S]*closed by Inventory/);
  // A closed item can't be answered again
  const again = await alia.post(`/oos/${oat}/answer`, { answer: 'order', qty: '2', expected_back: '2026-10-30' });
  assert.equal(again.status, 400);
});

test('25 Oct: a transfer the branch already accepted before it was sent leaves the send list', async () => {
  clock = new Date('2026-10-28T09:00:00+08:00');
  const staff = await login('pin', 'hazera', '1111');
  await staff.post('/oos', { item: 'Biorelief spray', left: 'none', asking: '0' });
  const it = (await db.query("SELECT id FROM oos_items WHERE item = 'Biorelief spray'")).rows[0].id;
  const alia = await login('password', 'alia', 'alia-pass-1');
  await alia.post(`/oos/${it}/answer`, { answer: 'transfer', from: 'JH', qty: '2', expected_back: '2026-10-29' });
  await staff.post(`/oos/${it}/received`, {});
  assert.doesNotMatch((await alia.get('/oos/transfers')).html, /Biorelief spray/);
});

test('27 Oct: questions & photos on an out-of-stock item; new item requests (not in Dynamod)', async () => {
  clock = new Date('2026-10-27T10:00:00+08:00');
  const jpeg = `data:image/jpeg;base64,${Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 5, 6, 0xff, 0xd9]).toString('base64')}`;
  const staff = await login('pin', 'hazera', '1111');
  // Report with a photo
  assert.equal((await staff.post('/oos', { item: 'Ubat batuk hijau', left: 'none', asking: '1-2', photo: jpeg })).status, 302);
  const it = (await db.query("SELECT id, photo_id FROM oos_items WHERE item = 'Ubat batuk hijau'")).rows[0];
  assert.ok(it.photo_id);
  assert.equal((await staff.post('/oos', { item: 'Bad photo', left: 'none', asking: '0', photo: 'data:image/jpeg;base64,AAAA' })).status, 400, 'not a photo');
  // Alia asks the branch what it is
  const alia = await login('password', 'alia', 'alia-pass-1');
  const ask = await alia.post(`/oos/${it.id}/message`, { message: 'Brg apa ni? Brand apa?', back: `/oos/${it.id}` });
  assert.equal(ask.location.split('?')[0], `/oos/${it.id}`);
  // The branch sees the question (thread open), on Daily entry and in Needs you
  const page = (await staff.get('/oos')).html;
  assert.match(page, /<details class="oo-thread" open>[\s\S]*INVENTORY ASKED[\s\S]*Brg apa ni\? Brand apa\?/);
  assert.match((await staff.get('/daily')).html, /Inventory asked a question/);
  assert.match((await staff.get('/daily')).html, /Inventory asked you to clarify an item/);
  // The photo: this branch and Inventory can open it, another branch can't
  assert.equal((await staff.get(`/oos/photo/${it.photo_id}`)).status, 200);
  assert.equal((await alia.get(`/oos/photo/${it.photo_id}`)).status, 200);
  const jhStaff = await login('pin', 'yaya', '2222');
  assert.equal((await jhStaff.get(`/oos/photo/${it.photo_id}`)).status, 404);
  assert.equal((await jhStaff.post(`/oos/${it.id}/message`, { message: 'hi' })).status, 403);
  // The branch replies with a photo; Inventory sees "Branch replied"
  await staff.post(`/oos/${it.id}/message`, { message: 'Ini dia, Ubat Batuk Cap Ibu & Anak 120ml', photo: jpeg, back: '/oos' });
  assert.equal((await db.query('SELECT count(*)::int AS n FROM oos_messages WHERE oos_id = $1', [it.id])).rows[0].n, 2);
  assert.match((await alia.get('/oos/inbox')).html, /Branch replied/);
  assert.match((await alia.get(`/oos/${it.id}`)).html, /Cap Ibu &amp; Anak[\s\S]*\/oos\/photo\/\d+/);
  assert.equal((await staff.post(`/oos/${it.id}/message`, { message: '' })).status, 302, 'empty → message, nothing saved');
  assert.equal((await db.query('SELECT count(*)::int AS n FROM oos_messages WHERE oos_id = $1', [it.id])).rows[0].n, 2);

  // New item request – not out of stock, a new item for Dynamod
  const r = await staff.post('/oos/new-items', { item: 'Bio-Oil 60ml', details: 'Guardian RM 39.90', asking: '2-3', photo: jpeg });
  assert.equal(r.status, 302);
  const req = (await db.query("SELECT * FROM item_requests WHERE item = 'Bio-Oil 60ml'")).rows[0];
  assert.equal(req.status, 'New'); assert.ok(req.photo_id); assert.equal(req.customers_count, 3);
  const inbox = (await alia.get('/oos/inbox?tab=new')).html;
  assert.match(inbox, /Bio-Oil 60ml[\s\S]*NEW REQUEST/);
  assert.match(inbox, /New item requests \(1\)/);
  assert.equal((await staff.post(`/oos/new-items/${req.id}/answer`, { answer: 'will' })).status, 403);
  assert.match(decodeURIComponent((await alia.post(`/oos/new-items/${req.id}/answer`, { answer: 'no' })).location), /Say why/);
  await alia.post(`/oos/new-items/${req.id}/message`, { message: 'Saiz 60ml atau 125ml?' });
  await alia.post(`/oos/new-items/${req.id}/answer`, { answer: 'listed', answer_note: 'Listed as BIO-OIL 60ML – order with next PO' });
  const mine = (await staff.get('/oos/new-items')).html;
  assert.match(mine, /LISTED – CAN ORDER[\s\S]*BIO-OIL 60ML/);
  assert.match(mine, /Saiz 60ml atau 125ml\?/);
  // New item requests don't count as out-of-stock items
  const wm = (await db.query("SELECT id FROM branches WHERE code = 'WM'")).rows[0].id;
  assert.equal((await db.query("SELECT count(*)::int AS n FROM oos_items WHERE item = 'Bio-Oil 60ml' AND branch_id = $1", [wm])).rows[0].n, 0);
});

test('28 Oct: "seen by Inventory" when Alia opens an item; activity log for the CEO', async () => {
  clock = new Date('2026-10-28T09:00:00+08:00');
  const staff = await login('pin', 'hazera', '1111');
  await staff.post('/oos', { item: 'Gaviscon 150ml', left: 'none', asking: '0' });
  const id = (await db.query("SELECT id FROM oos_items WHERE item = 'Gaviscon 150ml'")).rows[0].id;
  assert.match((await staff.get('/oos')).html, /Gaviscon 150ml[\s\S]*?not seen by Inventory yet/);
  // The CEO (admin) opening it doesn't count as seen; Alia opening it does
  const admin = await login('password', 'admin', 'admin-pass-1');
  await admin.get(`/oos/${id}`);
  assert.equal((await db.query('SELECT seen_at FROM oos_items WHERE id = $1', [id])).rows[0].seen_at, null);
  let act = (await admin.get('/oos/activity')).html;
  assert.match(act, /Not opened by Inventory yet[\s\S]*Gaviscon 150ml/);
  clock = new Date('2026-10-28T09:20:00+08:00');
  const alia = await login('password', 'alia', 'alia-pass-1');
  await alia.get(`/oos/${id}`);
  const row = (await db.query('SELECT seen_at, seen_by FROM oos_items WHERE id = $1', [id])).rows[0];
  assert.equal(new Date(row.seen_at).toISOString(), clock.toISOString());
  assert.match((await staff.get('/oos')).html, /Gaviscon 150ml[\s\S]*?seen by Alia today 9:20 am/);
  await alia.post(`/oos/${id}/message`, { message: 'Saiz berapa?' });
  act = (await admin.get('/oos/activity?branch=WM')).html;
  assert.doesNotMatch(act, /Not opened by Inventory yet[\s\S]*Gaviscon 150ml/);
  assert.match(act, /Seen by Inventory[\s\S]*Alia/);
  assert.match(act, /Inventory asked: Saiz berapa\?/);
  // Seen 2 today (also the Biorelief transfer she answered at 9 am), 1 question, 1 answer
  assert.match(act, /<td>Alia<\/td><td class="n">2<\/td><td class="n">1<\/td><td class="n">1<\/td>/);
  // Branch staff can't open the activity log
  assert.equal((await staff.get('/oos/activity')).status, 403);
});

test('28 Oct: inbox as a table by branch + B2B – answer many rows in one Save', async () => {
  clock = new Date('2026-10-28T10:00:00+08:00');
  const staff = await login('pin', 'hazera', '1111');
  for (const item of ['Panadol 10s', 'Strepsils honey', 'Vicks 50g']) await staff.post('/oos', { item, left: 'none', asking: '0' });
  const id = async (name) => (await db.query('SELECT id FROM oos_items WHERE item = $1', [name])).rows[0].id;
  const [p, s, v] = [await id('Panadol 10s'), await id('Strepsils honey'), await id('Vicks 50g')];
  const alia = await login('password', 'alia', 'alia-pass-1');
  // B2B item added by Inventory
  assert.match(decodeURIComponent((await alia.post('/oos/inbox/b2b', { item: 'Face mask 50s', customer: '' })).location), /Type the B2B customer/);
  await alia.post('/oos/inbox/b2b', { item: 'Face mask 50s', customer: 'Klinik Mesra', note: '20 boxes' });
  const b2b = await id('Face mask 50s');
  const page = (await alia.get('/oos/inbox')).html;
  assert.match(page, /Table – answer all/);
  assert.match(page, /id="t-WM"[\s\S]*Panadol 10s[\s\S]*id="t-JH"[\s\S]*id="t-B2B"[\s\S]*Face mask 50s[\s\S]*Klinik Mesra/);
  // One Save: Panadol HQ delivers 5, Strepsils order 3 but no date (error), B2B order 20, Vicks untouched
  const r = await alia.post('/oos/inbox/table', {
    [`r[i${p}][answer]`]: 'hq_deliver', [`r[i${p}][qty]`]: '5', [`r[i${p}][by]`]: '2026-10-29', [`r[i${p}][note]`]: 'van tomorrow',
    [`r[i${s}][answer]`]: 'order', [`r[i${s}][qty]`]: '3', [`r[i${s}][by]`]: '',
    [`r[i${b2b}][answer]`]: 'order', [`r[i${b2b}][qty]`]: '20', [`r[i${b2b}][by]`]: '2026-11-02',
    [`r[i${v}][answer]`]: '', [`r[i${v}][qty]`]: '',
  });
  assert.equal(r.status, 400);
  assert.match(r.html, /2 saved\. 1 row not saved/);
  assert.match(r.html, /Strepsils honey: Pick the date it should arrive/);
  assert.match(r.html, new RegExp(`name="r\\[i${s}\\]\\[qty\\]"[^>]*value="3"`), 'typed value kept');
  const row = async (i) => (await db.query('SELECT answer, answer_qty, reason_for_delay, status, seen_by FROM oos_items WHERE id = $1', [i])).rows[0];
  assert.equal((await row(p)).answer, 'hq_deliver'); assert.equal((await row(p)).reason_for_delay, 'van tomorrow'); assert.ok((await row(p)).seen_by);
  assert.equal((await row(s)).answer, null);
  assert.equal((await row(v)).answer, null);
  assert.equal((await row(b2b)).answer, 'order');
  // Same values again = no change; Done from the table closes it
  const again = await alia.post('/oos/inbox/table', { [`r[i${p}][answer]`]: 'hq_deliver', [`r[i${p}][qty]`]: '5', [`r[i${p}][by]`]: '2026-10-29', [`r[i${p}][note]`]: 'van tomorrow' });
  assert.match(decodeURIComponent(again.location), /No changes to save/);
  await alia.post('/oos/inbox/table', { [`r[i${b2b}][answer]`]: 'done' });
  assert.equal((await row(b2b)).status, 'Back in stock');
  // B2B never counts in a branch: WM's open count unchanged by it; branch staff can't add B2B
  assert.equal((await staff.post('/oos/inbox/b2b', { item: 'x', customer: 'y' })).status, 403);
  assert.match((await alia.get('/oos/activity')).html, /Face mask 50s[\s\S]*B2B/);
});

test('28 Oct: table – "Ask branch to clarify" goes to the person who reported it; From can be HQ or own branch', async () => {
  clock = new Date('2026-10-28T11:00:00+08:00');
  const staff = await login('pin', 'hazera', '1111');
  await staff.post('/oos', { item: 'Ubat X', left: 'none', asking: '0' });
  await staff.post('/oos', { item: 'Cream Y', left: 'none', asking: '0' });
  await staff.post('/oos', { item: 'Spray Z', left: 'none', asking: '0' });
  const id = async (n) => (await db.query('SELECT id FROM oos_items WHERE item = $1', [n])).rows[0].id;
  const [x, y, z] = [await id('Ubat X'), await id('Cream Y'), await id('Spray Z')];
  const alia = await login('password', 'alia', 'alia-pass-1');
  const page = (await alia.get('/oos/inbox')).html;
  assert.match(page, /❓ Ask branch to clarify/);
  assert.match(page, new RegExp(`name="r\\[i${x}\\]\\[from\\]"[\\s\\S]*?<option value="HQ"[\\s\\S]*?WM \\(own stock\\)`));
  const r = await alia.post('/oos/inbox/table', {
    [`r[i${x}][answer]`]: 'clarify', [`r[i${x}][note]`]: 'Ubat X tu brand apa? Boleh hantar gambar?',
    [`r[i${y}][answer]`]: 'transfer', [`r[i${y}][from]`]: 'HQ', [`r[i${y}][qty]`]: '2', [`r[i${y}][by]`]: '2026-10-29',
    [`r[i${z}][answer]`]: 'transfer', [`r[i${z}][from]`]: 'WM', [`r[i${z}][qty]`]: '1', [`r[i${z}][by]`]: '2026-10-28',
  });
  assert.match(decodeURIComponent(r.location), /3 items saved/);
  assert.equal((await db.query('SELECT answer FROM oos_items WHERE id = $1', [x])).rows[0].answer, null, 'clarify doesn’t answer');
  assert.equal((await db.query('SELECT body FROM oos_messages WHERE oos_id = $1', [x])).rows[0].body, 'Ubat X tu brand apa? Boleh hantar gambar?');
  assert.equal((await db.query('SELECT answer FROM oos_items WHERE id = $1', [y])).rows[0].answer, 'hq_deliver', 'From HQ = HQ delivers');
  const own = (await db.query('SELECT answer, from_branch_id = branch_id AS own FROM oos_items WHERE id = $1', [z])).rows[0];
  assert.equal(own.answer, 'transfer'); assert.equal(own.own, true);
  // Clarify needs a question
  const bad = await alia.post('/oos/inbox/table', { [`r[i${x}][answer]`]: 'clarify', [`r[i${x}][note]`]: '' });
  assert.match(bad.html, /Type your question for the branch/);
  // The reporter sees it in Needs you; another WM staff member who didn't report it doesn't
  const daily = (await staff.get('/daily')).html;
  assert.match(daily, /Inventory asked you to clarify an item/);
  assert.match((await staff.get('/oos')).html, /From your own stock: 1/);
  await db.query('UPDATE users SET pin_hash = $1 WHERE username = $2', [bcrypt.hashSync('3333', 4), 'zawiyah']);
  const other = await login('pin', 'zawiyah', '3333');
  assert.doesNotMatch((await other.get('/daily')).html, /Inventory asked you to clarify/);
});
