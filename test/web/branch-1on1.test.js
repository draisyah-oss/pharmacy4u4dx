// Branch 1:1s, quick follow-ups, "What's new" and the branch page (9 Nov 2026, CEO).
// The CEO's test: Hanin logs a follow-up on WM linked to an action and closes it → the CEO sees it in
// What's new without anyone telling her, Hafizah sees it in WM 1:1, Mazlina cannot see it.

const test = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');

const { createDb } = require('../../src/db');
const { prepareDatabase } = require('../../src/db/setup');
const { createApp } = require('../../src/app');

process.env.ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin-pass-1';
let db; let server; let base;
const clock = new Date('2026-11-09T10:00:00+08:00'); // Monday
const now = () => clock;
const uid = {};
const PW = ['hanin', 'alia', 'hafizah', 'amirah', 'afifah', 'aimi', 'mazlina', 'iman.admin'];

test.before(async () => {
  db = await createDb({ url: '', localDir: 'memory' });
  await prepareDatabase(db, { log: () => {} });
  for (const u of PW) await db.query('UPDATE users SET password_hash = $1 WHERE username = $2', [bcrypt.hashSync(`${u}-pass-1`, 4), u]);
  for (const r of (await db.query('SELECT id, username FROM users')).rows) uid[r.username] = r.id;
  // The feed starts before the test clock, so "now overdue" (worked out by date) is in range.
  await db.query("UPDATE app_settings SET value = '2026-11-01T00:00:00+08:00' WHERE key = 'meetings_feed_start'");
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
  const secret = username === 'admin' ? 'admin-pass-1' : `${username}-pass-1`;
  const r = await req('POST', '/login/password', { username, password: secret });
  assert.equal(r.status, 302, `${username} logs in`);
  let csrf = null;
  return {
    get: (p) => req('GET', p),
    post: async (p, body) => {
      if (!csrf) csrf = ((await req('GET', '/meetings/notes')).html.match(/name="_csrf" value="([^"]+)"/) || [])[1];
      return req('POST', p, { _csrf: csrf, ...body });
    },
  };
}
const one = async (sql, args) => (await db.query(sql, args)).rows[0];
const flash = (r) => decodeURIComponent(((r.location || '').match(/[?&](?:ok|err)=([^&#]*)/) || [])[1] || '');

test('five Branch 1:1 groups: branch manager + Hanin, branch set, loaded once', async () => {
  const rows = (await db.query(`SELECT g.code, g.name, g.branch, array_agg(u.username ORDER BY u.username) AS members
    FROM meeting_groups g JOIN meeting_group_members m ON m.group_id = g.id JOIN users u ON u.id = m.user_id
    WHERE g.kind = 'branch_1on1' GROUP BY g.code, g.name, g.branch, g.sort_order ORDER BY g.sort_order`)).rows;
  assert.deepEqual(rows.map((r) => [r.name, r.branch, r.members]), [
    ['WM 1:1', 'WM', ['hafizah', 'hanin']],
    ['BR 1:1', 'BR', ['amirah', 'hanin']],
    ['JH 1:1', 'JH', ['afifah', 'hanin']],
    ['Bangi 1:1', 'BGI', ['aimi', 'hanin']],
    ['Ampang 1:1', 'AMP', ['hanin', 'mazlina']],
  ]);
  assert.deepEqual(await require('../../src/meetings/setup').branchOneOnOnesOnce(db), { skipped: true });
});

test('access on the server: CEO all, Hanin all five, each branch manager only their own', async () => {
  const codes = ['wm-1on1', 'br-1on1', 'jh-1on1', 'bangi-1on1', 'ampang-1on1'];
  const ceo = await login('admin');
  const hanin = await login('hanin');
  for (const c of codes) {
    assert.equal((await ceo.get(`/meetings/g/${c}`)).status, 200, `CEO ${c}`);
    assert.equal((await hanin.get(`/meetings/g/${c}`)).status, 200, `Hanin ${c}`);
  }
  const own = { hafizah: 'wm-1on1', amirah: 'br-1on1', afifah: 'jh-1on1', aimi: 'bangi-1on1', mazlina: 'ampang-1on1' };
  for (const [u, mine] of Object.entries(own)) {
    const s = await login(u);
    for (const c of codes) assert.equal((await s.get(`/meetings/g/${c}`)).status, c === mine ? 200 : 404, `${u} ${c}`);
  }
  // Other admin logins and Alia (full HQ) don't see them.
  assert.equal((await (await login('iman.admin')).get('/meetings/g/wm-1on1')).status, 404);
  assert.equal((await (await login('alia')).get('/meetings/g/wm-1on1')).status, 404);

  // Meetings page: a "Branch 1:1s" section; Hafizah's lists only WM.
  const home = (await (await login('hafizah')).get('/meetings')).html;
  assert.match(home, /Branch 1:1s/);
  assert.match(home, /WM 1:1/);
  assert.doesNotMatch(home, /Ampang 1:1|BR 1:1/);
  const ceoHome = (await ceo.get('/meetings')).html;
  for (const n of ['WM 1:1', 'BR 1:1', 'JH 1:1', 'Bangi 1:1', 'Ampang 1:1']) assert.match(ceoHome, new RegExp(n));
});

test('Led by: CEO or Hanin, default the person creating it (a branch manager → Hanin)', async () => {
  const hafizah = await login('hafizah');
  const hanin = await login('hanin');
  const ceo = await login('admin');
  const r1 = await hafizah.post('/meetings/g/wm-1on1/meetings', { date: '2026-11-09' });
  assert.equal(r1.status, 302);
  const id1 = Number(r1.location.match(/\/meetings\/m\/(\d+)/)[1]);
  assert.equal((await one('SELECT led_by FROM meetings WHERE id = $1', [id1])).led_by, uid.hanin);
  const r2 = await ceo.post('/meetings/g/wm-1on1/meetings', { date: '2026-11-06' });
  const id2 = Number(r2.location.match(/\/meetings\/m\/(\d+)/)[1]);
  assert.equal((await one('SELECT led_by FROM meetings WHERE id = $1', [id2])).led_by, uid.admin);
  // Hanin chooses the CEO; a branch manager can't be chosen (falls back to the default).
  const r3 = await hanin.post('/meetings/g/br-1on1/meetings', { date: '2026-11-05', led_by: String(uid.admin) });
  const id3 = Number(r3.location.match(/\/meetings\/m\/(\d+)/)[1]);
  assert.equal((await one('SELECT led_by FROM meetings WHERE id = $1', [id3])).led_by, uid.admin);
  const r4 = await hanin.post('/meetings/g/br-1on1/meetings', { date: '2026-11-04', led_by: String(uid.amirah) });
  const id4 = Number(r4.location.match(/\/meetings\/m\/(\d+)/)[1]);
  assert.equal((await one('SELECT led_by FROM meetings WHERE id = $1', [id4])).led_by, uid.hanin);
  // Shown on the meeting and the branch page (last 1:1 = today's, led by Hanin).
  assert.match((await hafizah.get(`/meetings/m/${id1}`)).html, /Led by Hanin/);
  assert.match((await hafizah.get(`/meetings/m/${id2}`)).html, /Led by Dr Aisyah/);
  const wm = (await hafizah.get('/meetings/branch/WM')).html;
  assert.match(wm, /Last 1:1/);
  assert.match(wm, /9 Nov[^<]*<\/b><\/a> · led by Hanin/);
  // Other groups don't get a "Led by".
  const r5 = await hanin.post('/meetings/g/council/meetings', { date: '2026-11-09', led_by: String(uid.hanin) });
  const id5 = Number(r5.location.match(/\/meetings\/m\/(\d+)/)[1]);
  assert.equal((await one('SELECT led_by FROM meetings WHERE id = $1', [id5])).led_by, null);
});

test('the CEO’s test: Hanin follows up WM, closes the action → CEO’s What’s new, Hafizah sees it, Mazlina doesn’t', async () => {
  const hanin = await login('hanin');
  const ceo = await login('admin');
  const hafizah = await login('hafizah');
  const mazlina = await login('mazlina');

  let r = await hanin.post('/meetings/g/wm-1on1/actions', { title: 'Aircond service checklist', owner: String(uid.hafizah), due: '2026-11-12', branch: 'WM', area: 'hr' });
  assert.equal(r.status, 302);
  const act = await one("SELECT id FROM actions WHERE title = 'Aircond service checklist'");

  // The CEO looked before (nothing about it yet) – then marks everything seen.
  assert.equal((await ceo.post('/meetings/ceo/seen', {})).status, 302);
  assert.doesNotMatch((await ceo.get('/meetings/ceo')).html, /class="mt-badge"/);

  r = await hanin.post('/meetings/g/wm-1on1/followups', {
    date: '2026-11-09', kind: 'call', checked: 'Aircond service checklist', outcome: 'aircond checklist done',
    action_id: String(act.id), status: 'dn',
  });
  assert.equal(r.status, 302);
  assert.match(flash(r), /Follow-up logged – the action is closed/);

  // The action is closed and the follow-up is in its update history.
  assert.equal((await one('SELECT status FROM actions WHERE id = $1', [act.id])).status, 'dn');
  const hist = (await db.query('SELECT text FROM action_updates WHERE action_id = $1 ORDER BY id', [act.id])).rows.map((x) => x.text);
  assert.ok(hist.some((t) => /Follow-up \(Call, 2026-11-09\): Aircond service checklist → aircond checklist done/.test(t)), hist.join(' | '));

  // CEO: What's new shows the line (one line, not two), with a badge on the tab and a link to the follow-up.
  const page = (await ceo.get('/meetings/ceo')).html;
  assert.match(page, /Hanin followed up WM \(Hafizah\) by call: aircond checklist done → action closed/);
  assert.equal((page.match(/aircond checklist done/g) || []).length, 1);
  assert.match(page, /class="mt-badge"[^>]*>1</);
  assert.match(page, /href="\/meetings\/g\/wm-1on1#fu-\d+"/);
  // Filters: by branch, by person, by group.
  assert.match((await ceo.get('/meetings/ceo?nb=WM')).html, /aircond checklist done/);
  assert.doesNotMatch((await ceo.get('/meetings/ceo?nb=AMP')).html, /aircond checklist done/);
  assert.match((await ceo.get(`/meetings/ceo?np=${uid.hafizah}`)).html, /aircond checklist done/);
  assert.doesNotMatch((await ceo.get(`/meetings/ceo?np=${uid.mazlina}`)).html, /aircond checklist done/);
  assert.match((await ceo.get('/meetings/ceo?ng=wm-1on1')).html, /aircond checklist done/);
  assert.doesNotMatch((await ceo.get('/meetings/ceo?ng=council')).html, /aircond checklist done/);

  // Hafizah sees it in WM 1:1 and on the WM branch page.
  assert.match((await hafizah.get('/meetings/g/wm-1on1')).html, /aircond checklist done/);
  assert.match((await hafizah.get('/meetings/branch/WM')).html, /aircond checklist done/);

  // Mazlina can't: not the group, not the action, not the WM branch page, not her own pages.
  assert.equal((await mazlina.get('/meetings/g/wm-1on1')).status, 404);
  assert.equal((await mazlina.get(`/meetings/actions/${act.id}`)).status, 404);
  assert.equal((await mazlina.get('/meetings/branch/WM')).status, 404);
  assert.equal((await mazlina.get('/meetings/ceo')).status, 404);
  for (const p of ['/meetings', '/meetings/branch/AMP', '/meetings/g/ampang-1on1', '/meetings/g/bm', '/meetings/actions?status=dn']) {
    const x = await mazlina.get(p);
    assert.equal(x.status, 200, p);
    assert.doesNotMatch(x.html, /aircond/i, p);
  }
  // …and a POST into WM 1:1 changes nothing.
  const before = (await one('SELECT count(*)::int AS n FROM followups')).n;
  assert.equal((await mazlina.post('/meetings/g/wm-1on1/followups', { kind: 'call', checked: 'Sneaky' })).status, 404);
  assert.equal((await one('SELECT count(*)::int AS n FROM followups')).n, before);

  // Mark all as seen clears the feed and the badge.
  await ceo.post('/meetings/ceo/seen', {});
  const after = (await ceo.get('/meetings/ceo')).html;
  assert.doesNotMatch(after, /aircond checklist done/);
  assert.doesNotMatch(after, /class="mt-badge"/);
  assert.match(after, /Nothing new since you last looked/);
});

test('CEO only: hidden from everyone but the CEO and the author; the action history gets no private text', async () => {
  const hanin = await login('hanin');
  const ceo = await login('admin');
  const hafizah = await login('hafizah');
  await hanin.post('/meetings/g/wm-1on1/actions', { title: 'Staff roster check', owner: String(uid.hafizah), due: '2026-11-20', branch: 'WM' });
  const act = await one("SELECT id FROM actions WHERE title = 'Staff roster check'");
  const r = await hanin.post('/meetings/g/wm-1on1/followups', {
    date: '2026-11-08', kind: 'visit', checked: 'Private roster concern', outcome: 'talked it through quietly',
    action_id: String(act.id), status: 'ip', ceo_only: '1',
  });
  assert.equal(r.status, 302, flash(r));
  assert.match((await hanin.get('/meetings/g/wm-1on1')).html, /Private roster concern/);
  assert.match((await ceo.get('/meetings/g/wm-1on1')).html, /Private roster concern/);
  assert.match((await ceo.get('/meetings/ceo')).html, /talked it through quietly/);
  assert.doesNotMatch((await hafizah.get('/meetings/g/wm-1on1')).html, /Private roster concern/);
  assert.doesNotMatch((await hafizah.get('/meetings/branch/WM')).html, /Private roster concern/);
  assert.equal((await one('SELECT status FROM actions WHERE id = $1', [act.id])).status, 'ip');
  const hist = (await db.query('SELECT text FROM action_updates WHERE action_id = $1', [act.id])).rows.map((x) => x.text);
  assert.deepEqual(hist, ['Status changed by a private follow-up']);
  assert.doesNotMatch((await hafizah.get(`/meetings/actions/${act.id}`)).html, /roster concern|quietly/);
});

test('next step → new action (owner, due); history newest first; follow-ups in other groups pick a branch', async () => {
  const hanin = await login('hanin');
  let r = await hanin.post('/meetings/g/jh-1on1/followups', {
    date: '2026-11-07', kind: 'whatsapp', checked: 'Zakat claims sent', outcome: 'two still pending', next_step: 'Chase the two pending zakat claims',
    make_action: '1', new_owner: String(uid.afifah), new_due: '2026-11-14',
  });
  assert.equal(r.status, 302, flash(r));
  assert.match(flash(r), /new action added/);
  const a = await one("SELECT * FROM actions WHERE title = 'Chase the two pending zakat claims'");
  assert.equal(a.owner_user_id, uid.afifah);
  assert.equal(a.branch, 'JH');
  assert.equal(String(a.due).slice(0, 10), '2026-11-14');
  r = await hanin.post('/meetings/g/jh-1on1/followups', { date: '2026-11-09', kind: 'visit', checked: 'Store room tidy' });
  assert.equal(r.status, 302);
  const html = (await hanin.get('/meetings/g/jh-1on1')).html;
  assert.ok(html.indexOf('Store room tidy') < html.indexOf('Zakat claims sent'), 'newest first');

  // Owner must be in the group; next step is needed to make an action; no future dates.
  r = await hanin.post('/meetings/g/jh-1on1/followups', { kind: 'call', checked: 'x', next_step: 'y', make_action: '1', new_owner: String(uid.mazlina) });
  assert.match(flash(r), /owner/i);
  r = await hanin.post('/meetings/g/jh-1on1/followups', { kind: 'call', checked: 'x', make_action: '1', new_owner: String(uid.afifah) });
  assert.match(flash(r), /next step/i);
  r = await hanin.post('/meetings/g/jh-1on1/followups', { date: '2026-11-10', kind: 'call', checked: 'x' });
  assert.match(flash(r), /future/);
  // Salary guard.
  r = await hanin.post('/meetings/g/jh-1on1/followups', { kind: 'call', checked: 'Salary advance for staff' });
  assert.equal((await one("SELECT count(*)::int AS n FROM followups WHERE checked LIKE 'Salary%'")).n, 0);

  // Any group: council follow-up with a branch.
  r = await hanin.post('/meetings/g/council/followups', { kind: 'meeting', checked: 'Bangi signage quote', branch: 'BGI' });
  assert.equal(r.status, 302, flash(r));
  assert.equal((await one("SELECT branch FROM followups WHERE checked = 'Bangi signage quote'")).branch, 'BGI');
});

test('What’s new also lists minutes saved, action updates, new items to discuss and newly overdue actions', async () => {
  const hanin = await login('hanin');
  const ceo = await login('admin');
  await ceo.post('/meetings/ceo/seen', {});
  // An item to discuss, an action update, an action that went overdue yesterday.
  await hanin.post('/meetings/g/br-1on1/items', { text: 'BR staff rota for December', need: 'decision' });
  await hanin.post('/meetings/g/br-1on1/actions', { title: 'Fix the BR signboard light', owner: String(uid.amirah), due: '2026-11-08', branch: 'BR' });
  const a = await one("SELECT id FROM actions WHERE title = 'Fix the BR signboard light'");
  await hanin.post(`/meetings/actions/${a.id}`, { note: 'Contractor booked for Wednesday' });
  // Minutes of a BR 1:1 led by Hanin.
  const m = await hanin.post('/meetings/g/br-1on1/meetings', { date: '2026-11-09' });
  const mid = Number(m.location.match(/\/meetings\/m\/(\d+)/)[1]);
  await hanin.post(`/meetings/m/${mid}/minutes`, { op: 'manual' });
  const draft = (await one('SELECT draft FROM meetings WHERE id = $1', [mid])).draft;
  const body = { op: 'save', summary: 'Quick BR check-in' };
  for (const k of Object.keys(draft.dec || {})) body[`dec[${k}][keep]`] = '';
  for (const k of Object.keys(draft.act || {})) body[`act[${k}][keep]`] = '';
  const items = (await db.query('SELECT id FROM agenda_items WHERE group_id = (SELECT group_id FROM meetings WHERE id = $1) AND outcome IS NULL AND removed_at IS NULL', [mid])).rows;
  for (const it of items) body[`out[i${it.id}]`] = 'parked';
  await hanin.post(`/meetings/m/${mid}/minutes`, body);

  const page = (await ceo.get('/meetings/ceo')).html;
  assert.match(page, /Hanin added an item to discuss \(BR 1:1, decision\): BR staff rota for December/);
  assert.match(page, /Hanin updated “Fix the BR signboard light”: Contractor booked for Wednesday/);
  assert.match(page, /Now overdue: Fix the BR signboard light \(Amirah, BR 1:1\)/);
  assert.equal((await one('SELECT status FROM meetings WHERE id = $1', [mid])).status, 'draft');
  assert.match(page, /Hanin held the BR \(Amirah\) 1:1 on 2026-11-09 – minutes saved/);
  // Only the CEO has the overview; the badge is only on her tab.
  assert.equal((await hanin.get('/meetings/ceo')).status, 404);
  assert.doesNotMatch((await hanin.get('/meetings')).html, /class="mt-badge"/);
});
