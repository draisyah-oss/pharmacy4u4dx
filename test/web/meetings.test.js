// Meetings module (8 Nov 2026, CEO brief): groups and server-side access, actions, decisions,
// meetings, agenda (items to discuss + auto items), meeting updates, private notes, minutes
// (manual and Claude-drafted, every raised item must end as decision / action / parked), CEO
// approval and lock, CEO overview, WhatsApp reminder, Needs you.

const test = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');

const { createDb } = require('../../src/db');
const { prepareDatabase } = require('../../src/db/setup');
const { createApp } = require('../../src/app');
const claude = require('../../src/meetings/claude');
const F = require('../../src/meetings/flags');

process.env.ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin-pass-1';
let db; let server; let base;
const clock = new Date('2026-11-09T10:00:00+08:00'); // Monday
const now = () => clock;
const uid = {};
const gid = {};

test.before(async () => {
  db = await createDb({ url: '', localDir: 'memory' });
  await prepareDatabase(db, { log: () => {} });
  const pw = (u, v) => db.query('UPDATE users SET password_hash = $1 WHERE username = $2', [bcrypt.hashSync(v, 4), u]);
  const pin = (u, v) => db.query('UPDATE users SET pin_hash = $1 WHERE username = $2', [bcrypt.hashSync(v, 4), u]);
  for (const u of ['alia', 'hanin', 'iman', 'hafizah', 'amirah', 'iman.admin']) await pw(u, `${u}-pass-1`);
  for (const u of ['azwani', 'arinah', 'hafiz', 'hazera', 'syarafana']) await pin(u, '2468');
  for (const r of (await db.query('SELECT id, username FROM users')).rows) uid[r.username] = r.id;
  for (const r of (await db.query('SELECT id, code FROM meeting_groups')).rows) gid[r.code] = r.id;
  server = createApp(db, { now }).listen(0);
  base = `http://localhost:${server.address().port}`;
});
test.after(async () => { claude.setClient(null); server.close(); await db.close(); });

async function login(username) {
  const isPin = ['azwani', 'arinah', 'hafiz', 'hazera', 'syarafana'].includes(username);
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
  const secret = isPin ? '2468' : username === 'admin' ? 'admin-pass-1' : `${username}-pass-1`;
  const r = await req('POST', isPin ? '/login/pin' : '/login/password', isPin ? { username, pin: secret } : { username, password: secret });
  assert.equal(r.status, 302, `${username} logs in`);
  let csrf = null;
  return {
    get: (p) => req('GET', p),
    post: async (p, body) => {
      if (!csrf) csrf = ((await req('GET', '/meetings/notes')).html.match(/name="_csrf" value="([^"]+)"/) || [])[1];
      if (body instanceof URLSearchParams) { body.set('_csrf', csrf); return req('POST', p, body); }
      return req('POST', p, { _csrf: csrf, ...body });
    },
  };
}
const one = async (sql, args) => (await db.query(sql, args)).rows[0];

test('setup: 9 groups + 5 Branch 1:1s from seed.json, members matched to their own logins; Arinah has an HQ staff login', async () => {
  const groups = (await db.query('SELECT code, name, kind FROM meeting_groups ORDER BY sort_order')).rows;
  assert.equal(groups.length, 14);
  assert.equal(groups.filter((g) => g.kind === 'branch_1on1').length, 5);
  const members = async (code) => (await db.query(`SELECT u.username FROM meeting_group_members m JOIN users u ON u.id = m.user_id
    WHERE m.group_id = $1 ORDER BY u.username`, [gid[code]])).rows.map((r) => r.username);
  assert.deepEqual(await members('council'), ['alia', 'hanin']);
  assert.deepEqual(await members('bm'), ['afifah', 'aimi', 'alia', 'amirah', 'hafizah', 'hanin', 'mazlina']);
  assert.deepEqual(await members('finance'), ['azwani']);
  assert.deepEqual(await members('marketing-1on1'), ['arinah']);
  assert.deepEqual(await members('bn'), ['alia', 'hafiz', 'iman']);
  assert.equal((await one("SELECT role FROM users WHERE username = 'arinah'")).role, 'hq_staff');
  assert.equal((await one("SELECT kind FROM meeting_groups WHERE code = 'finance'")).kind, 'one_to_one');
  // Once only: running it again changes nothing.
  assert.deepEqual(await require('../../src/meetings/setup').setupOnce(db), { skipped: true });
});

test('access is enforced on the server: other groups (and CEO 1:1s) answer 404 – admin logins included', async () => {
  const azwani = await login('azwani');
  const home = await azwani.get('/meetings');
  assert.equal(home.status, 200);
  assert.match(home.html, /Finance \(CEO 1:1\)/);
  assert.doesNotMatch(home.html, /Management Council|Branch Managers|HR &amp; Ops 1:1/);
  assert.equal((await azwani.get('/meetings/g/council')).status, 404);

  const hafizah = await login('hafizah');
  assert.equal((await hafizah.get('/meetings/g/finance')).status, 404);
  assert.equal((await hafizah.get('/meetings/g/bm')).status, 200);
  assert.equal((await hafizah.get('/meetings/ceo')).status, 404);
  // A POST into a group she isn't in creates nothing.
  const before = (await one('SELECT count(*)::int AS n FROM actions')).n;
  assert.equal((await hafizah.post('/meetings/g/finance/actions', { title: 'Sneaky', owner: String(uid.hafizah) })).status, 404);
  assert.equal((await hafizah.post('/meetings/g/finance/items', { text: 'Sneaky item' })).status, 404);
  assert.equal((await one('SELECT count(*)::int AS n FROM actions')).n, before);

  // A non-super admin login doesn't see the CEO's 1:1s either.
  const imanAdmin = await login('iman.admin');
  assert.equal((await imanAdmin.get('/meetings/g/finance')).status, 404);
  assert.equal((await imanAdmin.get('/meetings/ceo')).status, 404);
  assert.equal((await imanAdmin.get('/meetings/admin/groups')).status, 404);
  // Iman's own login is in HR & Ops team and BN team only.
  const iman = await login('iman');
  assert.equal((await iman.get('/meetings/g/hrops-team')).status, 200);
  assert.equal((await iman.get('/meetings/g/hrops-1on1')).status, 404);

  // Branch staff in no group: no Meetings pages, no menu entry. Hafiz (BN team) gets them.
  const hazera = await login('hazera');
  assert.equal((await hazera.get('/meetings')).status, 404);
  assert.doesNotMatch((await hazera.get('/daily')).html, /href="\/meetings"/);
  const hafiz = await login('hafiz');
  assert.equal((await hafiz.get('/meetings/g/bn')).status, 200);
  assert.match((await hafiz.get('/daily')).html, /href="\/meetings"/);

  // The CEO sees every group.
  const ceo = await login('admin');
  for (const code of Object.keys(gid)) assert.equal((await ceo.get(`/meetings/g/${code}`)).status, 200, code);
  assert.equal((await ceo.get('/meetings/ceo')).status, 200);
});

test('actions: create, flags, quick status with history; salary guard; owner must be in the group', async () => {
  const alia = await login('alia');
  let r = await alia.post('/meetings/g/council/actions', { title: 'Zuellig payment plan', owner: String(uid.alia), due: '2026-10-20', area: 'fin', branch: 'HQ', priority: 'High', needs_ceo: '1' });
  assert.equal(r.status, 302);
  const a = await one("SELECT * FROM actions WHERE title = 'Zuellig payment plan'");
  assert.equal(a.group_id, gid.council);
  r = await alia.post('/meetings/g/council/actions', { title: 'Bayar gaji staff', owner: String(uid.alia) });
  assert.match(decodeURIComponent(r.location), /Salaries and pay/);
  r = await alia.post('/meetings/g/council/actions', { title: 'Owner from elsewhere', owner: String(uid.hafizah) });
  assert.match(decodeURIComponent(r.location), /must be in this meeting group/);

  const list = await alia.get('/meetings/mine');
  assert.match(list.html, /Zuellig payment plan/);
  assert.match(list.html, /Overdue 20d/);
  assert.match(list.html, /Needs CEO decision/);

  r = await alia.post(`/meetings/actions/${a.id}`, { quick: '1', status: 'bl' });
  assert.equal(r.status, 302);
  const upd = (await db.query('SELECT text FROM action_updates WHERE action_id = $1', [a.id])).rows.map((x) => x.text);
  assert.ok(upd.includes('Status → Blocked'));
  r = await alia.post(`/meetings/actions/${a.id}`, { title: a.title, owner: String(uid.alia), due: '2026-10-20', status: 'bl', area: 'fin', branch: 'HQ', priority: 'High', needs_ceo: '1', note: 'Waiting for DKSH reply' });
  assert.equal((await one('SELECT count(*)::int AS n FROM action_updates WHERE action_id = $1', [a.id])).n, 2);
  // Hafizah (not in the Council) can't open or change it.
  const hafizah = await login('hafizah');
  assert.equal((await hafizah.get(`/meetings/actions/${a.id}`)).status, 404);
  assert.equal((await hafizah.post(`/meetings/actions/${a.id}`, { quick: '1', status: 'dn' })).status, 404);
  assert.equal((await one('SELECT status FROM actions WHERE id = $1', [a.id])).status, 'bl');

  // Flags (pure)
  const t = '2026-11-09';
  assert.equal(F.overdueDays({ status: 'ip', due: '2026-10-20' }, t), 20);
  assert.equal(F.toCeo({ status: 'ip', due: '2026-10-25' }, t), true, '14+ days overdue goes to the CEO');
  assert.equal(F.toCeo({ status: 'ip', due: '2026-11-01', raised_count: 3 }, t), true);
  assert.equal(F.isStale({ status: 'ip', last_update_at: '2026-11-01T02:00:00Z' }, t), true);
  assert.equal(F.isStale({ status: 'dn', last_update_at: '2026-01-01T02:00:00Z' }, t), false);
});

test('meeting: agenda order, updates sync “help needed” into items, who can remove what, lock after approval', async () => {
  const ceo = await login('admin');
  let r = await ceo.post('/meetings/g/bm/meetings', { date: '2026-11-09', time: '16:00' });
  assert.equal(r.status, 302);
  const mid = Number(r.location.match(/\/meetings\/m\/(\d+)/)[1]);
  const m = await one('SELECT * FROM meetings WHERE id = $1', [mid]);
  assert.equal(m.group_id, gid.bm);
  assert.equal((await one('SELECT count(*)::int AS n FROM meeting_attendees WHERE meeting_id = $1', [mid])).n, 8, '7 members + the CEO');

  const page = await ceo.get(`/meetings/m/${mid}`);
  const order = ['WIG &amp; lead measures', 'Wangsa Maju', 'BR', 'JH', 'Bangi', 'Ampang', 'Requests to HQ', 'Escalations to management'];
  let at = 0;
  for (const s of order) { const i = page.html.indexOf(s, at); assert.ok(i > at, `${s} in order`); at = i; }

  const hafizah = await login('hafizah');
  r = await hafizah.post(`/meetings/m/${mid}/update`, { win: 'Walk-in up 12%', issue1: 'Panadol OOS', help_needed: 'Approve signboard budget' });
  assert.equal(r.status, 302);
  let item = await one("SELECT * FROM agenda_items WHERE meeting_id = $1 AND source = 'update'", [mid]);
  assert.equal(item.text, 'Approve signboard budget');
  await hafizah.post(`/meetings/m/${mid}/update`, { win: 'Walk-in up 12%', help_needed: 'Approve signboard budget RM 800' });
  item = await one('SELECT * FROM agenda_items WHERE id = $1', [item.id]);
  assert.equal(item.text, 'Approve signboard budget RM 800', 'kept in sync');
  const ups = await ceo.get(`/meetings/m/${mid}?tab=updates`);
  assert.match(ups.html, /Walk-in up 12%/);
  assert.match(ups.html, /Not sent yet:.*Amirah/s);

  // Someone outside the meeting can't send an update.
  const azwani = await login('azwani');
  assert.equal((await azwani.post(`/meetings/m/${mid}/update`, { win: 'x' })).status, 404);

  // Items: Amirah adds one; Alia can't remove it; the CEO can.
  const amirah = await login('amirah');
  await amirah.post(`/meetings/m/${mid}/items`, { text: 'BR signboard location', need: 'decision' });
  const mine = await one("SELECT * FROM agenda_items WHERE text = 'BR signboard location'");
  const alia = await login('alia');
  assert.equal((await alia.post(`/meetings/items/${mine.id}/remove`, {})).status, 403);
  assert.equal((await ceo.post(`/meetings/items/${mine.id}/remove`, {})).status, 302);
  assert.ok((await one('SELECT removed_at FROM agenda_items WHERE id = $1', [mine.id])).removed_at);

  // Clearing help needed removes its item.
  await hafizah.post(`/meetings/m/${mid}/update`, { win: 'Walk-in up 12%', help_needed: '' });
  assert.ok((await one('SELECT removed_at FROM agenda_items WHERE id = $1', [item.id])).removed_at);
  // The CEO can delete anyone's update; Alia can't delete Hafizah's.
  assert.equal((await alia.post(`/meetings/m/${mid}/update/delete`, { user: String(uid.hafizah) })).status, 403);
});

test('minutes (manual): every raised item needs an outcome; save creates decisions/actions/follow-ups; only the CEO approves; then locked', async () => {
  const ceo = await login('admin');
  let r = await ceo.post('/meetings/g/council/meetings', { date: '2026-11-09', time: '11:00' });
  const mid = Number(r.location.match(/\/meetings\/m\/(\d+)/)[1]);
  const hanin = await login('hanin');
  await hanin.post(`/meetings/m/${mid}/items`, { text: 'Roster for Ampang', need: 'decision' });
  await hanin.post(`/meetings/m/${mid}/items`, { text: 'Staff uniform', need: 'discuss' });
  const items = (await db.query('SELECT id, text FROM agenda_items WHERE meeting_id = $1 ORDER BY id', [mid])).rows;
  const zuellig = await one("SELECT id FROM actions WHERE title = 'Zuellig payment plan'");

  r = await hanin.post(`/meetings/m/${mid}/minutes`, { op: 'manual', notes: 'Roster dibincang. Uniform – tunggu bulan depan.' });
  assert.equal(r.status, 302);
  const page = await hanin.get(`/meetings/m/${mid}?tab=minutes`);
  assert.match(page.html, /Review the minutes/);

  const form = {
    op: 'save', summary: 'Roster agreed; uniform parked.',
    'dec[k0][keep]': '1', 'dec[k0][text]': 'Ampang roster: 2 staff on duty weekends', 'dec[k0][area]': 'hr', 'dec[k0][branch]': 'AMP',
    'act[k0][keep]': '1', 'act[k0][title]': 'Publish Ampang roster', 'act[k0][owner]': String(uid.hanin), 'act[k0][due]': '2026-11-12', 'act[k0][area]': 'hr', 'act[k0][branch]': 'AMP', 'act[k0][priority]': 'Normal',
    'upd[k0][keep]': '1', 'upd[k0][action_id]': String(zuellig.id), 'upd[k0][status]': 'ip', 'upd[k0][note]': 'Pay 20k this week',
    [`out[i${items[0].id}]`]: 'dec:k0', next: 'Mon 16 Nov 11am',
  };
  r = await hanin.post(`/meetings/m/${mid}/minutes`, form);
  assert.match(decodeURIComponent(r.location), /no outcome/);
  assert.match(r.location, new RegExp(`unresolved=${items[1].id}`));
  assert.equal((await one('SELECT status FROM meetings WHERE id = $1', [mid])).status, 'planned');

  r = await hanin.post(`/meetings/m/${mid}/minutes`, { ...form, [`out[i${items[1].id}]`]: 'parked' });
  assert.match(decodeURIComponent(r.location), /waiting for Dr Aisyah/);
  const m = await one('SELECT * FROM meetings WHERE id = $1', [mid]);
  assert.equal(m.status, 'draft');
  assert.deepEqual(m.parked, ['Staff uniform']);
  assert.equal((await one('SELECT count(*)::int AS n FROM decisions WHERE meeting_id = $1', [mid])).n, 1);
  const act = await one('SELECT * FROM actions WHERE source_meeting_id = $1', [mid]);
  assert.equal(act.title, 'Publish Ampang roster');
  assert.equal((await one('SELECT raised_count, status FROM actions WHERE id = $1', [zuellig.id])).raised_count, 2, 'follow-up counts as raised again');
  assert.equal((await one('SELECT outcome FROM agenda_items WHERE id = $1', [items[0].id])).outcome, 'decision');
  assert.equal((await one('SELECT outcome FROM agenda_items WHERE id = $1', [items[1].id])).outcome, 'parked');

  // Only the CEO approves.
  assert.equal((await hanin.post(`/meetings/m/${mid}/approve`, {})).status, 403);
  assert.equal((await ceo.post(`/meetings/m/${mid}/approve`, {})).status, 302);
  assert.equal((await one('SELECT status FROM meetings WHERE id = $1', [mid])).status, 'approved');
  // Locked: no updates, items or minutes.
  r = await hanin.post(`/meetings/m/${mid}/update`, { win: 'late win' });
  assert.match(decodeURIComponent(r.location), /locked/);
  r = await hanin.post(`/meetings/m/${mid}/items`, { text: 'late item' });
  assert.match(decodeURIComponent(r.location), /locked/);
  // The decision log shows it with its meeting.
  const log = await hanin.get('/meetings/decisions?q=roster');
  assert.match(log.html, /Ampang roster/);
  assert.match(log.html, new RegExp(`/meetings/m/${mid}`));
  // The CEO can unlock.
  assert.equal((await hanin.post(`/meetings/m/${mid}/unlock`, {})).status, 403);
  await ceo.post(`/meetings/m/${mid}/unlock`, {});
  assert.equal((await one('SELECT status FROM meetings WHERE id = $1', [mid])).status, 'draft');
});

test('minutes (Claude): the draft is checked – unknown actions dropped, owners must be members, items mapped to outcomes', async () => {
  const ceo = await login('admin');
  let r = await ceo.post('/meetings/g/inventory-1on1/meetings', { date: '2026-11-09' });
  const mid = Number(r.location.match(/\/meetings\/m\/(\d+)/)[1]);
  const alia = await login('alia');
  await alia.post(`/meetings/m/${mid}/items`, { text: 'Tongee account for Ampang', need: 'decision' });
  const item = await one('SELECT id FROM agenda_items WHERE meeting_id = $1', [mid]);
  const other = await one("SELECT id FROM actions WHERE title = 'Zuellig payment plan'"); // Council – not this group
  let sent = null;
  claude.setClient({ beta: { messages: { create: async (req) => {
    sent = req;
    return { stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify({
      summary: 'Tongee approved.', next: '', parked: [],
      decisions: [{ ref: 'd1', text: 'Open Tongee account for Ampang', area: 'inv', branch: 'AMP' }],
      actions: [{ ref: 'a1', title: 'Send Tongee forms', owner: uid.alia, due: '2026-11-11', area: 'inv', branch: 'AMP', priority: 'High', needs_ceo: false },
        { ref: 'a2', title: 'Owner not in group', owner: uid.hafizah, due: '2026-11-11', area: 'inv', branch: 'HQ', priority: 'Normal', needs_ceo: false }],
      updates: [{ ref: 'u1', action_id: other.id, status: 'dn', note: 'should be dropped' }],
      items: [{ item_id: item.id, outcome: 'd1' }],
    }) }] };
  } } } });
  try {
    r = await alia.post(`/meetings/m/${mid}/minutes`, { op: 'claude', notes: 'Tongee – Dr A setuju buka akaun.' });
    assert.match(decodeURIComponent(r.location), /Claude drafted/);
  } finally { claude.setClient(null); }
  assert.equal(sent.model, 'claude-opus-5-5');
  assert.equal(sent.fallbacks, 'default');
  assert.equal(sent.output_config.format.type, 'json_schema');
  assert.match(sent.messages[0].content.at(-1).text, /Tongee account for Ampang/);
  const d = (await one('SELECT draft FROM meetings WHERE id = $1', [mid])).draft;
  assert.equal(d.source, 'claude');
  assert.equal(d.act.k0.owner, uid.alia);
  assert.equal(d.act.k1.owner, null, 'not a member → no owner');
  assert.deepEqual(d.upd, {}, 'action from another group dropped');
  assert.equal(d.out[`i${item.id}`], 'dec:k0');
  const page = await alia.get(`/meetings/m/${mid}?tab=minutes`);
  assert.match(page.html, /Drafted by Claude/);
  assert.match(page.html, /Send Tongee forms/);
});

test('without ANTHROPIC_API_KEY the minutes are written by hand (no Claude button)', async () => {
  const saved = process.env.ANTHROPIC_API_KEY; delete process.env.ANTHROPIC_API_KEY;
  try {
    const ceo = await login('admin');
    const r = await ceo.post('/meetings/g/hrops-1on1/meetings', { date: '2026-11-10' });
    const mid = Number(r.location.match(/\/meetings\/m\/(\d+)/)[1]);
    const page = await ceo.get(`/meetings/m/${mid}?tab=minutes`);
    assert.doesNotMatch(page.html, /Draft minutes with Claude/);
    assert.match(page.html, /Write minutes myself/);
    const out = await claude.draftMinutes({ meeting: {}, members: [], items: [], updates: [], openActions: [], today: '2026-11-09', memberIds: [], openActionIds: [], itemIds: [] });
    assert.match(out.error, /isn’t switched on/);
  } finally { if (saved) process.env.ANTHROPIC_API_KEY = saved; }
});

test('my notes are private: add to agenda, take back, done, delete – nobody else can read or act on them', async () => {
  const alia = await login('alia');
  await alia.post('/meetings/notes', { text: 'Ask about Pharmaniaga terms', need: 'decision' });
  const n = await one("SELECT * FROM private_notes WHERE text = 'Ask about Pharmaniaga terms'");
  assert.equal(n.user_id, uid.alia);
  const hanin = await login('hanin');
  assert.doesNotMatch((await hanin.get('/meetings/notes')).html, /Pharmaniaga terms/);
  assert.equal((await hanin.post(`/meetings/notes/${n.id}`, { action: 'delete' })).status, 404);
  const ceo = await login('admin');
  assert.doesNotMatch((await ceo.get('/meetings/notes')).html, /Pharmaniaga terms/, 'not even the CEO');

  const r = await ceo.post('/meetings/g/council/meetings', { date: '2026-11-16', time: '11:00' });
  const mid = Number(r.location.match(/\/meetings\/m\/(\d+)/)[1]);
  await alia.post(`/meetings/notes/${n.id}`, { action: 'agenda', meeting: String(mid) });
  const item = await one("SELECT * FROM agenda_items WHERE source = 'note' AND source_id = $1", [n.id]);
  assert.equal(item.meeting_id, mid);
  assert.match((await hanin.get(`/meetings/m/${mid}`)).html, /Pharmaniaga terms/, 'on the agenda everyone in the meeting sees it');
  await alia.post(`/meetings/notes/${n.id}`, { action: 'takeback' });
  assert.ok((await one('SELECT removed_at FROM agenda_items WHERE id = $1', [item.id])).removed_at);
  await alia.post(`/meetings/notes/${n.id}`, { action: 'done' });
  assert.ok((await one('SELECT done_at FROM private_notes WHERE id = $1', [n.id])).done_at);
  await alia.post(`/meetings/notes/${n.id}`, { action: 'delete' });
  assert.equal((await one('SELECT count(*)::int AS n FROM private_notes WHERE id = $1', [n.id])).n, 0);
});

test('CEO overview, WhatsApp reminder, Needs you, and the CEO edits groups', async () => {
  const ceo = await login('admin');
  const ov = await ceo.get('/meetings/ceo');
  assert.match(ov.html, /Per group/);
  assert.match(ov.html, /Management Council/);
  assert.match(ov.html, /Finance \(CEO 1:1\)/);
  const rem = await ceo.get('/meetings/g/council/remind');
  assert.match(rem.html, /Alia/);
  assert.match(rem.html, /peringatan/);

  // Needs you: Alia's overdue action, and the CEO's minutes to approve.
  const { buildNeeds } = require('../../src/lib/needs');
  const aliaUser = await one("SELECT * FROM users WHERE username = 'alia'");
  const nd = await buildNeeds(db, aliaUser, { at: clock });
  assert.ok(nd.items.some((i) => i.title === 'My meeting actions overdue' && i.href === '/meetings/mine') || nd.more > 0);
  const ceoUser = await one("SELECT * FROM users WHERE username = 'admin'");
  const cn = await buildNeeds(db, ceoUser, { at: clock });
  assert.ok(cn.items.some((i) => i.title === 'Minutes to approve') || cn.more > 0);

  // Only the CEO edits groups. Adding Iman to the Council lets her open it.
  const hanin = await login('hanin');
  assert.equal((await hanin.post('/meetings/admin/groups', { id: String(gid.council), name: 'X' })).status, 404);
  const iman = await login('iman');
  assert.equal((await iman.get('/meetings/g/council')).status, 404);
  const body = new URLSearchParams({ id: String(gid.council), name: 'Management Council', kind: 'team', default_day: 'Mon', default_time: '11:00', agenda_template: 'council', active: 'yes' });
  for (const u of ['alia', 'hanin', 'iman']) body.append('members', String(uid[u]));
  const r = await ceo.post('/meetings/admin/groups', body);
  assert.equal(r.status, 302);
  assert.match(decodeURIComponent(r.location), /Group saved/);
  assert.equal((await iman.get('/meetings/g/council')).status, 200);
  assert.ok((await one("SELECT 1 AS x FROM audit_log WHERE table_name = 'meeting_group_members'")));
});

test('no page in the module mentions salaries; the database refuses them too', async () => {
  const ceo = await login('admin');
  for (const p of ['/meetings', '/meetings/ceo', '/meetings/decisions', '/meetings/actions', '/meetings/g/council', '/meetings/admin/groups']) {
    const r = await ceo.get(p);
    assert.equal(r.status, 200, p);
    assert.doesNotMatch(r.html.replace(/Salaries and pay can’t be stored/g, ''), /salary|gaji|payroll/i, p);
  }
  await assert.rejects(db.query("INSERT INTO decisions (group_id, decided_on, text) VALUES ($1, '2026-11-09', 'Naik gaji 5%')", [gid.council]));
  await assert.rejects(db.query("INSERT INTO private_notes (user_id, text) VALUES ($1, 'payroll check')", [uid.alia]));
});

test('import: prototype data comes in once, owners matched, duplicates of a meeting merged, salary rows skipped', async () => {
  const { importExport } = require('../../src/meetings/import');
  const data = require('../fixtures/meetings-sample.json');
  const s = await importExport(db, data);
  assert.equal(s.actions, 4, '3 council + 1 bm (the salary one skipped)');
  assert.equal(s.decisions, 1);
  assert.equal(s.meetings, 1, 'two copies of the same meeting → one');
  assert.deepEqual(s.unmatched, ['ghost']);
  assert.equal(s.skipped.length, 1);
  assert.match(s.skipped[0], /council:a04/);
  const a = await one("SELECT * FROM actions WHERE import_key = 'council:a01'");
  assert.equal(a.owner_user_id, uid.alia);
  assert.equal(a.group_id, gid.council);
  assert.equal(a.raised_count, 4);
  assert.equal(a.needs_ceo, true);
  assert.equal((await one('SELECT count(*)::int AS n FROM action_updates WHERE action_id = $1', [a.id])).n, 1);
  assert.equal((await one("SELECT owner_user_id FROM actions WHERE import_key = 'council:a02'")).owner_user_id, uid.hanin, 'hannin → hanin');
  const odd = await one("SELECT * FROM actions WHERE import_key = 'council:a03'");
  assert.deepEqual([odd.owner_user_id, odd.area, odd.branch, odd.status], [null, 'mgmt', 'HQ', 'ns']);
  assert.equal((await one("SELECT group_id FROM actions WHERE import_key = 'bm:b01'")).group_id, gid.bm);
  assert.equal((await one("SELECT decided_by FROM decisions WHERE import_key = 'council:d01'")).decided_by, uid.admin);
  const m = await one("SELECT id FROM meetings WHERE import_key = 'council:m-2026-11-09'");
  assert.equal((await one('SELECT count(*)::int AS n FROM meeting_attendees WHERE meeting_id = $1', [m.id])).n, 3);
  // Twice = nothing new.
  const again = await importExport(db, data);
  assert.deepEqual([again.actions, again.decisions, again.meetings], [0, 0, 0]);
});
