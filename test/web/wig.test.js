// Weekly WIG rhythm (18 Oct, from the approved mockup): HQ WIG Monday 10 am (focus set by the CEO
// or proposed + approved), managers' update Monday 4 pm (automatic numbers + out-of-stock week,
// "what I need from HQ" → HQ actions), branch WIG Tuesday (HQ's answers, Done / Partly / Not done,
// commitments typed on the phone or by the manager, attendance), and the wiki: Iman writes, Hanin approves.

const test = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');

const { createDb } = require('../../src/db');
const { migrate } = require('../../src/db/migrate');
const { readSeed, loadSeed } = require('../../src/db/seed');
const { createApp } = require('../../src/app');
const suggest = require('../../src/hq/suggest');

let db; let server; let base;
// Tuesday 20 Oct 2026, 10 am Malaysia time: the update (Mon 19th) was for the week of 12 Oct.
let clock = new Date('2026-10-20T10:00:00+08:00');
const now = () => clock;
const LAST = '2026-10-12';
const THIS = '2026-10-19';
const ids = {};

test.before(async () => {
  db = await createDb({ url: '', localDir: 'memory' });
  await migrate(db);
  await loadSeed(db, readSeed(), { adminPassword: 'admin-pass-1' });
  const pw = (u, v) => db.query('UPDATE users SET password_hash = $1 WHERE username = $2', [bcrypt.hashSync(v, 4), u]);
  const pin = (u, v) => db.query('UPDATE users SET pin_hash = $1 WHERE username = $2', [bcrypt.hashSync(v, 4), u]);
  await pw('alia', 'alia-pass-1'); await pw('hanin', 'hanin-pass-1'); await pw('iman', 'iman-pass-1');
  await pw('hafizah', 'manager-pass-1');
  await pin('hazera', '1111'); await pin('fariz', '1357');
  for (const r of (await db.query('SELECT id, name, branch_id FROM people')).rows) ids[r.name] = r.id;
  ids.WM = (await db.query("SELECT id FROM branches WHERE code = 'WM'")).rows[0].id;
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
      if (!csrf) csrf = ((await req('GET', '/daily')).html.match(/name="_csrf" value="([^"]+)"/) || (await req('GET', '/hq/today')).html.match(/name="_csrf" value="([^"]+)"/) || [])[1];
      return req('POST', p, { _csrf: csrf, ...body });
    },
  };
}
const manager = () => login('password', 'hafizah', 'manager-pass-1');
const staff = () => login('pin', 'hazera', '1111');
const alia = () => login('password', 'alia', 'alia-pass-1');
const hanin = () => login('password', 'hanin', 'hanin-pass-1');
const iman = () => login('password', 'iman', 'iman-pass-1');
const fariz = () => login('pin', 'fariz', '1357');
const admin = () => login('password', 'admin', 'admin-pass-1');

test('manager’s weekly update: automatic out-of-stock week, up to 3 needs from HQ → HQ actions', async () => {
  // An item reported last week and still open past its date (late), one back in stock.
  await db.query(`INSERT INTO oos_items (branch_id, week_start, item, status, reported_at, customers_count, answer, expected_back, answer_due)
    VALUES ($1, $2, 'Loyuric 100mg', 'Ordered', '2026-10-14T10:00:00+08:00', 2, 'order', '2026-10-16', '2026-10-15T11:00:00+08:00'),
           ($1, $2, 'Biorelief spray', 'Back in stock', '2026-10-13T10:00:00+08:00', 0, 'transfer', NULL, '2026-10-14T11:00:00+08:00')`, [ids.WM, LAST]);
  await db.query("UPDATE oos_items SET received_at = '2026-10-15T10:00:00+08:00' WHERE item = 'Biorelief spray'");
  const m = await manager();
  const page = await m.get(`/weekly?week=${LAST}`);
  assert.equal(page.status, 200);
  assert.match(page.html, /Weekly update to HQ/);
  assert.match(page.html, /Out of stock this week/);
  assert.match(page.html, /Loyuric 100mg<\/b> – \d+ days, 2 customers asking/);
  assert.doesNotMatch(page.html, /Add to the list/, 'no manual OOS list any more');

  const r = await m.post('/weekly', {
    week: LAST, win_this_week: '17 new chronic customers',
    'a[n1][text]': 'Need a Tue/Thu locum – can’t keep up chronic sign-ups', 'a[n1][owner]': String(ids.Hanin),
    'a[n2][text]': 'Shopee voucher for Ampang-style promo', 'a[n2][owner]': String(ids.Alia),
  });
  assert.equal(r.status, 302, r.html.slice(0, 300));
  const acts = (await db.query('SELECT * FROM hq_actions WHERE week_start = $1 ORDER BY id', [LAST])).rows;
  assert.equal(acts.length, 2);
  assert.equal(acts[0].owner_person_id, ids.Hanin);
  assert.equal(acts[0].agreed, false);
  const ci = (await db.query('SELECT issue_needing_hq_help, win_this_week FROM weekly_checkins WHERE branch_id = $1 AND week_start = $2', [ids.WM, LAST])).rows[0];
  assert.match(ci.issue_needing_hq_help, /locum/);
  assert.equal(ci.win_this_week, '17 new chronic customers');

  // Remove one by emptying it; a 4th is refused.
  await m.post('/weekly', { week: LAST, [`a[k${acts[1].id}][text]`]: '', [`a[k${acts[1].id}][owner]`]: String(ids.Alia) });
  assert.equal((await db.query('SELECT count(*)::int AS n FROM hq_actions WHERE week_start = $1', [LAST])).rows[0].n, 1);
  const salary = await m.post('/weekly', { week: LAST, 'a[n1][text]': 'Staff gaji late', 'a[n1][owner]': String(ids.Iman) });
  assert.equal(salary.status, 400);
  assert.equal((await (await staff()).get('/weekly')).status, 403);
});

test('Monday 4 pm: HQ agrees owner + date → on the owner’s day; they tick it done', async () => {
  const a = await alia();
  const page = await a.get(`/hq/update?week=${LAST}`);
  assert.equal(page.status, 200);
  assert.match(page.html, /Weekly Branch Manager Meeting/);
  assert.match(page.html, /locum/);
  const act = (await db.query('SELECT id FROM hq_actions WHERE week_start = $1', [LAST])).rows[0];
  const r = await a.post('/hq/update', {
    week: LAST, [`x[k${act.id}][owner]`]: String(ids.Hanin), [`x[k${act.id}][due]`]: '2026-10-21', [`x[k${act.id}][status]`]: 'Open',
    'x[new][branch]': 'WM', 'x[new][text]': 'Loyuric 100mg from BR', 'x[new][owner]': String(ids.Alia), 'x[new][due]': '2026-10-20',
  });
  assert.equal(r.status, 302, r.html.slice(0, 300));
  const rows = (await db.query('SELECT * FROM hq_actions WHERE week_start = $1 ORDER BY id', [LAST])).rows;
  assert.equal(rows.length, 2);
  assert.ok(rows.every((x) => x.agreed), 'owner + date = agreed');

  const h = await hanin();
  const day = await h.get('/hq/today');
  assert.match(day.html, /HQ actions for branches/);
  assert.match(day.html, /locum/);
  const done = await h.post(`/hq/actions/${rows[0].id}`, { status: 'Done', back: '/hq/today' });
  assert.equal(done.status, 302);
  assert.equal((await db.query('SELECT status FROM hq_actions WHERE id = $1', [rows[0].id])).rows[0].status, 'Done');
  // HQ staff can't run the meeting page, nor close someone else's action.
  const f = await fariz();
  assert.equal((await f.get('/hq/update')).status, 403);
  await f.post(`/hq/actions/${rows[1].id}`, { status: 'Done' });
  assert.equal((await db.query('SELECT status FROM hq_actions WHERE id = $1', [rows[1].id])).rows[0].status, 'Open');
});

test('staff My week: type the commitment on the phone, tap Done; manager sees who typed it', async () => {
  const s = await staff();
  const page = await s.get('/my-week');
  assert.equal(page.status, 200);
  assert.match(page.html, /No commitment yet/);
  const r = await s.post('/my-week', { text: 'Ask every BP-check customer to register, all week', lead: '', by: '2026-10-23' });
  assert.equal(r.status, 302);
  const c = (await db.query('SELECT * FROM commitments WHERE week_start = $1 AND person_id = $2', [THIS, ids.Hazera])).rows[0];
  assert.ok(c, 'saved');
  assert.match((await s.get('/daily')).html, /MY WEEK/);
  await s.post('/my-week', { mark: 'yes' });
  assert.equal((await db.query('SELECT result FROM commitments WHERE id = $1', [c.id])).rows[0].result, 'yes');
  const m = await manager();
  const wig = await m.get('/commitments');
  assert.match(wig.html, /Branch WIG session/);
  assert.match(wig.html, /typed on their phone/);
  assert.match(wig.html, /what HQ will do for us/);
  assert.match(wig.html, /locum/, 'HQ’s answer from the Monday update');
  assert.equal((await s.get('/commitments')).status, 403, 'the session page stays the manager’s');
});

test('branch WIG session: Done / Partly / Not done with why, attendance, session held', async () => {
  await db.query('INSERT INTO commitments (branch_id, week_start, person_id, commitment) VALUES ($1, $2, $3, $4)', [ids.WM, LAST, ids.Zawiyah, 'Fix 15 Grab menu items']);
  const c = (await db.query('SELECT id FROM commitments WHERE week_start = $1 AND person_id = $2', [LAST, ids.Zawiyah])).rows[0];
  const m = await manager();
  const r = await m.post('/commitments', {
    week: THIS, [`done[k${c.id}]`]: 'partly', [`why[k${c.id}]`]: 'Only 9 – Grab app down Thu',
    [`c[p${ids.Zawiyah}][text]`]: 'Finish the last 6 Grab items by Thu', finish: '1', held: '1',
    [`att[p${ids.Hafizah}]`]: '1', [`att[p${ids.Zawiyah}]`]: '1',
  });
  assert.equal(r.status, 302, r.html.slice(0, 400));
  const after = (await db.query('SELECT result, done, why FROM commitments WHERE id = $1', [c.id])).rows[0];
  assert.deepEqual(after, { result: 'partly', done: false, why: 'Only 9 – Grab app down Thu' });
  const s = (await db.query('SELECT * FROM branch_wig_sessions WHERE branch_id = $1 AND week_start = $2', [ids.WM, THIS])).rows[0];
  assert.equal(s.held_on, '2026-10-20');
  assert.deepEqual([...s.attended].sort(), [ids.Hafizah, ids.Zawiyah].sort());
  const z = (await db.query('SELECT created_by FROM commitments WHERE week_start = $1 AND person_id = $2', [THIS, ids.Zawiyah])).rows[0];
  assert.ok(z, 'manager typed Zawiyah’s');
  assert.match((await m.get('/commitments')).html, /typed by/);
  // The next update shows the session and the kept count automatically.
  const up = await m.get(`/weekly?week=${THIS}`);
  assert.match(up.html, /Held 20 Oct|Held Tue 20 Oct/);
});

test('HQ WIG: focus set by the CEO, or proposed by the person and approved by the CEO', async () => {
  const a = await alia();
  await a.post('/hq/commitments', { week: THIS, [`f[p${ids.Alia}][text]`]: 'Ampang 0 out of stock by Fri', [`f[p${ids.Fariz}][text]`]: 'Not mine to set' });
  const rows = (await db.query('SELECT person_id, status FROM hq_focus WHERE week_start = $1', [THIS])).rows;
  assert.deepEqual(rows, [{ person_id: ids.Alia, status: 'proposed' }], 'own focus only, as a proposal');
  assert.match((await a.get('/hq/today')).html, /waiting for the CEO/);

  const ceo = await admin();
  const page = await ceo.get(`/hq/commitments?week=${THIS}`);
  assert.match(page.html, /HQ WIG session/);
  assert.match(page.html, /Approve/);
  await ceo.post('/hq/commitments', {
    week: THIS, [`f[p${ids.Alia}][text]`]: 'Ampang 0 out of stock by Fri', [`f[p${ids.Alia}][approve]`]: '1',
    [`f[p${ids.Syarafana}][text]`]: 'Expiry check in all 5 branches by Thu',
  });
  const after = Object.fromEntries((await db.query('SELECT person_id, status FROM hq_focus WHERE week_start = $1', [THIS])).rows.map((r) => [r.person_id, r.status]));
  assert.equal(after[ids.Alia], 'approved');
  assert.equal(after[ids.Syarafana], 'approved', 'the CEO’s own text is approved at once');
  assert.match((await a.get('/hq/today')).html, /Approved by the CEO/);
  // Changing an approved focus sends it back for approval.
  await a.post('/hq/commitments', { week: THIS, [`f[p${ids.Alia}][text]`]: 'Ampang 0 out of stock by Thu' });
  assert.equal((await db.query('SELECT status FROM hq_focus WHERE week_start = $1 AND person_id = $2', [THIS, ids.Alia])).rows[0].status, 'proposed');
});

test('wiki checklist: Iman owns every page and sends it to Hanin; only Hanin (or admin) approves', async () => {
  const owners = (await db.query('SELECT DISTINCT owner FROM hq_wiki_items')).rows.map((r) => r.owner);
  assert.deepEqual(owners, ['Iman']);
  const page = (await db.query("SELECT id FROM hq_wiki_items WHERE title = 'Opening the branch'")).rows[0];
  const i = await iman();
  const bad = await i.post(`/hq/wiki/${page.id}`, { status: 'Approved' });
  assert.match(decodeURIComponent(bad.location), /Hanin approves/);
  await i.post(`/hq/wiki/${page.id}`, { status: 'Checking' });
  const h = await hanin();
  assert.match((await h.get('/hq/wiki')).html, /Waiting for Hanin/);
  await h.post(`/hq/wiki/${page.id}`, { status: 'Approved' });
  const row = (await db.query('SELECT status, checking_at, approved_at FROM hq_wiki_items WHERE id = $1', [page.id])).rows[0];
  assert.equal(row.status, 'Approved');
  assert.ok(row.checking_at && row.approved_at);
  // Suggested weekly numbers: Iman 1 sent, Hanin 1 approved.
  const m = Object.fromEntries((await db.query("SELECT code, id FROM hq_measures WHERE code IN ('wiki', 'wikisop', 'classroom')")).rows.map((r) => [r.code, r.id]));
  assert.ok(m.classroom, 'Classroom measure for Iman');
  const rows = (await db.query("SELECT id, code, person_id, input, true AS \"canEdit\" FROM hq_measures WHERE code IN ('wiki', 'wikisop')")).rows;
  const got = await suggest.suggestions(db, { week: THIS, rows, today: '2026-10-20', at: clock });
  assert.equal(got.get(m.wiki).value, 1);
  assert.equal(got.get(m.wikisop).value, 1);
});

test('18 Oct upgrade: older databases move Hanin’s wiki pages to Iman and get the Tuesday wording once', async () => {
  const { wigWeekOnce } = require('../../src/db/setup');
  const old = await createDb({ url: '', localDir: 'memory' });
  await migrate(old);
  await loadSeed(old, readSeed(), { adminPassword: 'admin-pass-1' });
  const hn = (await old.query("SELECT id FROM people WHERE name = 'Hanin' AND branch_id IS NULL")).rows[0].id;
  await old.query("UPDATE hq_wiki_items SET owner = 'Hanin', person_id = $1 WHERE area LIKE '%SOPs'", [hn]);
  await old.query("UPDATE hq_measures SET label = 'Both WIG sessions held (HQ and branch, both on Monday)' WHERE code = 'sessions'");
  const wiki = (await old.query("SELECT id FROM hq_measures WHERE code = 'wiki'")).rows[0].id;
  await old.query("UPDATE hq_measure_targets SET target = CASE month WHEN '2026-12' THEN 2 ELSE 4 END WHERE hq_measure_id = $1", [wiki]);
  await old.query("DELETE FROM app_settings WHERE key = 'wig_week_v1'");
  await wigWeekOnce(old, readSeed(), () => {});
  assert.deepEqual((await old.query('SELECT DISTINCT owner FROM hq_wiki_items')).rows.map((r) => r.owner), ['Iman']);
  assert.match((await old.query("SELECT label FROM hq_measures WHERE code = 'sessions'")).rows[0].label, /branch Tuesday/);
  const t = (await old.query("SELECT target FROM hq_measure_targets WHERE hq_measure_id = $1 AND month = '2026-10'", [wiki])).rows[0].target;
  assert.equal(Number(t), 7);
  await old.close();
});

test('19 Oct: HQ WIG takes up to 2 focuses and 2 commitments; the CEO can commit to removing bottlenecks for staff', async () => {
  const ceo = await admin();
  const r = await ceo.post('/hq/commitments', {
    week: THIS, [`f2[p${ids.Alia}][text]`]: 'Top 100 in stock 95% by Fri',
    [`c[p${ids['Dr Aisyah']}][text]`]: 'Sit with each branch manager for 15 min', [`c[p${ids['Dr Aisyah']}][moves]`]: 'Remove bottlenecks for staff',
    [`c2[p${ids['Dr Aisyah']}][text]`]: 'Sign off the November campaign',
  });
  assert.equal(r.status, 302, r.html.slice(0, 300));
  const focus = (await db.query('SELECT slot, status FROM hq_focus WHERE week_start = $1 AND person_id = $2 ORDER BY slot', [THIS, ids.Alia])).rows;
  assert.deepEqual(focus.map((f) => f.slot), [1, 2]);
  const cs = (await db.query('SELECT slot, moves FROM hq_commitments WHERE week_start = $1 AND person_id = $2 ORDER BY slot', [THIS, ids['Dr Aisyah']])).rows;
  assert.deepEqual(cs, [{ slot: 1, moves: 'Remove bottlenecks for staff' }, { slot: 2, moves: null }]);
  assert.match((await (await alia()).get('/hq/today')).html, /Top 100 in stock 95% by Fri/);
  // Not offered to anyone else
  const bad = await (await alia()).post('/hq/commitments', { week: THIS, [`c[p${ids.Alia}][text]`]: 'x', [`c[p${ids.Alia}][moves]`]: 'Remove bottlenecks for staff' });
  assert.equal(bad.status, 400);
});

test('19 Oct: Inventory menu only for Alia, Syarafana, Fariz (and admin); Projects menu for HQ; Anis at Ampang', async () => {
  const a = (await (await alia()).get('/hq/today')).html;
  assert.match(a, /<summary>Inventory<\/summary>/);
  assert.match(a, /<summary>Projects<\/summary>[\s\S]*sn-sub[^>]*>Wiki checklist/);
  const h = (await (await hanin()).get('/hq/today')).html;
  assert.doesNotMatch(h, /<summary>Inventory<\/summary>/);
  assert.match(h, /<summary>Projects<\/summary>/);
  assert.equal((await (await hanin()).get('/oos/transfers')).status, 403);
  const f = (await (await fariz()).get('/hq/today')).html;
  assert.match(f, /<summary>Inventory<\/summary>/);
  assert.doesNotMatch((await (await manager()).get('/daily')).html, /<summary>Projects<\/summary>|<summary>Inventory<\/summary>/);
  const anis = (await db.query("SELECT p.role, u.username, u.role AS login FROM people p JOIN branches b ON b.id = p.branch_id JOIN users u ON u.person_id = p.id WHERE b.code = 'Ampang' AND p.name = 'Anis'")).rows[0];
  assert.deepEqual(anis, { role: 'Intern', username: 'anis', login: 'branch_staff' });
});

test('19 Oct: "Needs you" at the top of the menu – counts per person, fixed tiles for everyone', async () => {
  const ceo = (await (await admin()).get('/hq/update')).html;
  assert.match(ceo, /Needs you[\s\S]*Focuses waiting for your approval/);
  assert.match(ceo, />Group scoreboard</);
  const al = (await (await alia()).get('/hq/today')).html;
  assert.match(al, /Needs you[\s\S]*(Out-of-stock reports|Daily tasks to tick)/);
  const st = (await (await staff()).get('/daily')).html;
  assert.match(st, />Daily entry</);
  assert.match(st, />WM scoreboard</);
  assert.match(st, />Group scoreboard</);
});
