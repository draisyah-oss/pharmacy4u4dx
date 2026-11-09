// Meetings module pages (8 Nov 2026). Access is checked on the server for every request: a group,
// meeting, action or item outside the login's groups answers 404 (CEO 1:1 names never leak).

const express = require('express');
const A = require('./access');
const D = require('./data');
const F = require('./flags');
const M = require('./minutes');
const C = require('./claude');
const E = require('./events');
const FU = require('./followups');
const { reminderText } = require('./remind');

function meetingRoutes(db, { now }) {
  const router = express.Router();
  const notFound = (res) => res.status(404).render('message', { title: 'Page not found', message: 'That page doesn’t exist.' });
  const forbid = (res, msg) => res.status(403).render('message', { title: 'Not allowed', message: msg || 'You can’t change this.' });
  const back = (res, path, msg, kind = 'ok') => res.redirect(`${path}${path.includes('?') ? '&' : '?'}${kind}=${encodeURIComponent(msg)}`);
  const flash = (req) => ({ ok: req.query.ok || null, err: req.query.err || null });
  const dayOf = (ts) => require('../calc').todayInMalaysia(new Date(ts));
  const base = (req, extra) => ({ A, today: D.today(now), dayOf, ...flash(req), navActive: 'meetings', ...extra });
  const wrap = (fn) => async (req, res, next) => { try { await fn(req, res, next); } catch (err) { next(err); } };
  const managersByBranch = (mem) => Object.fromEntries(mem.filter((m) => m.role === 'branch_manager').map((m) => {
    const code = Object.entries(A.APP_BRANCH).find(([, v]) => v === m.branch_code);
    return [code ? code[0] : m.branch_code, m.name];
  }));

  // 9 Nov: count badge on the CEO overview tab ("What's new" since she last marked it seen).
  router.use('/meetings', wrap(async (req, res, next) => {
    if (req.method === 'GET' && req.user && A.isCeo(req.user)) res.locals.whatsNewCount = await E.count(db, req.user, { now });
    next();
  }));

  // ── Home: my groups, upcoming meetings, my actions ──
  router.get('/meetings', wrap(async (req, res) => {
    const groups = await D.groupsFor(db, req.user);
    if (!groups.length && !A.isCeo(req.user)) return notFound(res);
    const t = D.today(now);
    const all = await D.listActions(db, req.user, { open: true, now });
    const mine = all.filter((a) => a.owner_user_id === req.user.id);
    for (const g of groups) g.counts = F.counts(all.filter((a) => a.group_id === g.id), t);
    const upcoming = (await D.listMeetings(db, req.user, { from: t })).reverse().slice(0, 8);
    const recent = (await D.listMeetings(db, req.user, {})).filter((m) => m.held_on < t).slice(0, 5);
    // Branch 1:1 cards: who it's with, last 1:1 held (and who led it), last follow-up.
    const held = (await D.listMeetings(db, req.user, {})).filter((m) => m.kind === 'branch_1on1' && m.held_on <= t);
    for (const g of groups.filter((x) => x.kind === 'branch_1on1')) {
      const bm = await E.branchManagerOf(db, g.id);
      g.bm = bm ? bm.name : null;
      g.last1on1 = held.find((m) => m.group_id === g.id) || null;
      const fu = await FU.list(db, req.user, { groupId: g.id, limit: 1 });
      g.lastFollowup = fu.length ? fu[0].done_on : null;
    }
    res.render('meetings-home', base(req, { title: 'Meetings', groups, mine, upcoming, recent, ceo: A.isCeo(req.user) }));
  }));

  // ── My actions (needs your update first) ──
  router.get('/meetings/mine', wrap(async (req, res) => {
    const list = await D.listActions(db, req.user, { ownerId: req.user.id, now });
    const open = list.filter((a) => a.open);
    const need = open.filter((a) => a.overdue || a.stale);
    const rest = open.filter((a) => !(a.overdue || a.stale));
    const done = list.filter((a) => !a.open).slice(0, 8);
    res.render('meetings-mine', base(req, { title: 'My actions', need, rest, done }));
  }));

  // ── All actions across my groups, with filters ──
  router.get('/meetings/actions', wrap(async (req, res) => {
    const groups = await D.groupsFor(db, req.user);
    if (!groups.length && !A.isCeo(req.user)) return notFound(res);
    const f = { group: String(req.query.group || ''), status: String(req.query.status || 'open'), area: String(req.query.area || ''), branch: String(req.query.branch || ''), q: String(req.query.q || '').slice(0, 80) };
    const g = f.group ? groups.find((x) => x.code === f.group) : null;
    let list = await D.listActions(db, req.user, { groupId: g ? g.id : null, now });
    list = filterActions(list, f);
    res.render('meetings-actions', base(req, { title: 'All actions', list, groups, f }));
  }));

  // ── Decision log ──
  router.get('/meetings/decisions', wrap(async (req, res) => {
    const groups = await D.groupsFor(db, req.user);
    if (!groups.length && !A.isCeo(req.user)) return notFound(res);
    const f = { group: String(req.query.group || ''), q: String(req.query.q || '').slice(0, 80), area: String(req.query.area || ''), branch: String(req.query.branch || ''), from: String(req.query.from || ''), to: String(req.query.to || '') };
    const g = f.group ? groups.find((x) => x.code === f.group) : null;
    const list = await D.listDecisions(db, req.user, { ...f, groupId: g ? g.id : null });
    res.render('meetings-decisions', base(req, { title: 'Decision log', list, groups, f }));
  }));

  // ── CEO overview across every group ──
  router.get('/meetings/ceo', wrap(async (req, res) => {
    if (!A.isCeo(req.user)) return notFound(res);
    const t = D.today(now);
    const groups = await D.groupsFor(db, req.user);
    const all = await D.listActions(db, req.user, { open: true, now });
    const perGroup = groups.map((g) => ({ g, c: F.counts(all.filter((a) => a.group_id === g.id), t) }));
    const perBranch = Object.keys(A.BRANCHES).map((b) => ({ b, c: F.counts(all.filter((a) => a.branch === b), t) }));
    const total = F.counts(all, t);
    const focus = all.filter((a) => a.to_ceo);
    const waiting = (await D.listMeetings(db, req.user, {})).filter((m) => m.status === 'draft');
    const view = ['overdue', 'ceo', 'blocked', 'soon'].includes(req.query.show) ? req.query.show : null;
    const shown = view ? all.filter((a) => (view === 'overdue' ? a.overdue : view === 'ceo' ? a.needs_ceo : view === 'blocked' ? a.status === 'bl' : a.due_soon)) : null;
    // What's new since the last "Mark all as seen", with filters by branch, person and group.
    const nf = { branch: A.BRANCHES[req.query.nb] ? String(req.query.nb) : '', person: String(Number(req.query.np) || ''), group: groups.some((g) => g.code === req.query.ng) ? String(req.query.ng) : '' };
    const news = await E.feed(db, req.user, { now, ...nf });
    const ids = [...new Set(news.all.flatMap((i) => i.people))];
    const people = ids.length ? (await db.query(`SELECT u.id, COALESCE(p.name, u.display_name) AS name, u.is_super FROM users u LEFT JOIN people p ON p.id = u.person_id
      WHERE u.id = ANY($1::int[]) ORDER BY 2`, [ids])).rows.map((r) => ({ id: r.id, name: r.is_super && r.name === 'Admin' ? 'Dr Aisyah' : r.name })) : [];
    res.render('meetings-ceo', base(req, { title: 'CEO overview', perGroup, perBranch, total, focus, waiting, view, shown, news, nf, people, groups }));
  }));

  router.post('/meetings/ceo/seen', wrap(async (req, res) => {
    if (!A.isCeo(req.user)) return notFound(res);
    await E.markSeen(db, req.user, req.body.upto);
    back(res, '/meetings/ceo', 'All marked as seen.');
  }));

  // ── A branch: open actions, last 1:1, recent follow-ups, the branch manager's latest update ──
  // Branch logins only open their own branch; everyone else needs a Meetings group (the CEO all).
  // Each part only shows what comes from groups this login is in.
  router.get('/meetings/branch/:b', wrap(async (req, res) => {
    const b = String(req.params.b).toUpperCase();
    if (!A.BRANCH_LIST.includes(b)) return notFound(res);
    if (['branch_manager', 'branch_staff'].includes(req.user.role) && req.user.branch_code !== A.APP_BRANCH[b]) return notFound(res);
    if (!(await A.hasMeetings(db, req.user))) return notFound(res);
    const t = D.today(now);
    const actions = (await D.listActions(db, req.user, { open: true, now })).filter((a) => a.branch === b);
    const meetings = (await D.listMeetings(db, req.user, {})).filter((m) => m.kind === 'branch_1on1' && m.group_branch === b);
    const last1on1 = meetings.find((m) => m.held_on <= t) || null;
    const next1on1 = meetings.filter((m) => m.held_on > t).pop() || null;
    const followups = await FU.list(db, req.user, { branch: b, limit: 15 });
    const groups = (await D.groupsFor(db, req.user)).filter((g) => g.kind === 'branch_1on1' && g.branch === b);
    const [where, args] = await A.groupFilter(db, req.user, 'm.group_id', [A.APP_BRANCH[b]]);
    const bmUpdate = (await db.query(
      `SELECT x.*, m.held_on, m.title, g.name AS group_name, COALESCE(p.name, u.display_name) AS name
       FROM meeting_updates x JOIN meetings m ON m.id = x.meeting_id JOIN meeting_groups g ON g.id = m.group_id
       JOIN users u ON u.id = x.user_id LEFT JOIN people p ON p.id = u.person_id LEFT JOIN branches br ON br.id = u.branch_id
       WHERE u.role = 'branch_manager' AND br.code = $1 AND g.active AND ${where}
       ORDER BY x.updated_at DESC LIMIT 1`, args)).rows[0] || null;
    res.render('meetings-branch', base(req, {
      title: `${A.BRANCHES[b]} – meetings`, b, FU, actions, last1on1, next1on1, followups, groups, bmUpdate, counts: F.counts(actions, t),
    }));
  }));

  // ── A group: overview, actions, meetings, decisions ──
  async function groupOr404(req, res) {
    const g = await A.loadGroup(db, req.user, req.params.code);
    if (!g) { notFound(res); return null; }
    return g;
  }

  router.get('/meetings/g/:code', wrap(async (req, res) => {
    const g = await groupOr404(req, res); if (!g) return;
    const t = D.today(now);
    const tab = ['overview', 'actions', 'meetings', 'decisions'].includes(req.query.tab) ? req.query.tab : 'overview';
    const actions = await D.listActions(db, req.user, { groupId: g.id, now });
    const members = await D.members(db, g.id);
    const meetings = await D.listMeetings(db, req.user, { groupId: g.id });
    const decisions = tab === 'decisions' ? await D.listDecisions(db, req.user, { groupId: g.id, q: req.query.q || '' }) : [];
    const items = await D.openItemsForGroup(db, g.id);
    const f = { status: String(req.query.status || 'open'), area: String(req.query.area || ''), branch: String(req.query.branch || ''), owner: String(req.query.owner || ''), q: String(req.query.q || '').slice(0, 80) };
    const followups = tab === 'overview' ? await FU.list(db, req.user, { groupId: g.id, limit: 30 }) : [];
    const linkable = tab === 'overview' ? await FU.linkableActions(db, req.user, g, { now }) : [];
    const leaders = g.kind === 'branch_1on1' ? D.leaders(members) : [];
    res.render('meetings-group', base(req, {
      title: g.name, g, tab, members, meetings, decisions, items, f, followups, linkable, leaders, FU,
      ledDefault: leaders.length ? D.defaultLeader(leaders, req.user) : null,
      bm: members.find((m) => m.role === 'branch_manager') || null,
      counts: F.counts(actions, t), focus: actions.filter((a) => a.to_ceo),
      list: filterActions(actions, f), next: await D.nextMeeting(db, g.id, { now }),
      perBranch: A.BRANCH_LIST.map((b) => ({ b, n: actions.filter((a) => a.open && a.branch === b).length, late: actions.filter((a) => a.open && a.branch === b && a.overdue).length })),
      perArea: F.AREA_ORDER.map((k) => ({ k, n: actions.filter((a) => a.open && a.area === k).length, late: actions.filter((a) => a.open && a.area === k && a.overdue).length })),
    }));
  }));

  router.post('/meetings/g/:code/followups', wrap(async (req, res) => {
    const g = await groupOr404(req, res); if (!g) return;
    const r = await FU.create(db, req.user, g, req.body, { now });
    const msg = r.error || `Follow-up logged${r.closed ? ' – the action is closed' : ''}${r.newActionId ? ' – new action added' : ''}.`;
    back(res, `/meetings/g/${g.code}`, msg, r.error ? 'err' : 'ok');
  }));

  router.get('/meetings/g/:code/remind', wrap(async (req, res) => {
    const g = await groupOr404(req, res); if (!g) return;
    const actions = await D.listActions(db, req.user, { groupId: g.id, ownerId: req.query.me ? req.user.id : null, now });
    const day = g.default_day ? { Mon: 'Isnin', Tue: 'Selasa', Wed: 'Rabu', Thu: 'Khamis', Fri: 'Jumaat', Sat: 'Sabtu', Sun: 'Ahad' }[g.default_day] : null;
    const text = reminderText(actions, { title: g.name, updateBy: day ? `${day}${g.default_time ? ` ${g.default_time}` : ''}` : null, today: D.today(now) });
    res.render('meetings-remind', base(req, { title: `${g.name}: reminder`, g, text }));
  }));

  router.post('/meetings/g/:code/meetings', wrap(async (req, res) => {
    const g = await groupOr404(req, res); if (!g) return;
    const r = await D.createMeeting(db, req.user, g, req.body, { now });
    if (r.error) return back(res, `/meetings/g/${g.code}?tab=meetings`, r.error, 'err');
    back(res, `/meetings/m/${r.id}`, 'Meeting created – the agenda is built from open items.');
  }));

  router.post('/meetings/g/:code/items', wrap(async (req, res) => {
    const g = await groupOr404(req, res); if (!g) return;
    const r = await D.addItem(db, req.user, g, req.body);
    back(res, `/meetings/g/${g.code}#items`, r.error || 'Added to the next meeting’s agenda.', r.error ? 'err' : 'ok');
  }));

  router.post('/meetings/g/:code/actions', wrap(async (req, res) => {
    const g = await groupOr404(req, res); if (!g) return;
    const r = await D.createAction(db, req.user, g, req.body, { now });
    back(res, `/meetings/g/${g.code}?tab=actions`, r.error || 'Action added.', r.error ? 'err' : 'ok');
  }));

  router.post('/meetings/g/:code/decisions', wrap(async (req, res) => {
    const g = await groupOr404(req, res); if (!g) return;
    const r = await D.createDecision(db, req.user, g, req.body, { now });
    back(res, `/meetings/g/${g.code}?tab=decisions`, r.error || 'Decision recorded.', r.error ? 'err' : 'ok');
  }));

  // ── An action ──
  router.get('/meetings/actions/:id', wrap(async (req, res) => {
    const a = await D.loadAction(db, req.user, req.params.id, { now });
    if (!a) return notFound(res);
    const members = await D.members(db, a.group_id);
    res.render('meetings-action', base(req, { title: 'Action', a, members, backTo: req.query.back || `/meetings/g/${a.group_code}?tab=actions` }));
  }));

  router.post('/meetings/actions/:id', wrap(async (req, res) => {
    const a = await D.loadAction(db, req.user, req.params.id, { now });
    if (!a) return notFound(res);
    const body = req.body.quick ? { status: req.body.status } : { ...req.body, _full: true };
    const r = await D.updateAction(db, req.user, a, body, { now });
    const to = require('../lib/safe-path').safePath(req.body.back, `/meetings/actions/${a.id}`);
    back(res, to, r.error || (r.unchanged ? 'Nothing changed.' : 'Saved.'), r.error ? 'err' : 'ok');
  }));

  // ── A meeting: agenda, updates, minutes ──
  async function meetingOr404(req, res) {
    const m = await D.loadMeeting(db, req.user, req.params.id);
    if (!m) { notFound(res); return null; }
    return m;
  }

  router.get('/meetings/m/:id', wrap(async (req, res) => {
    const m = await meetingOr404(req, res); if (!m) return;
    const t = D.today(now);
    const members = await D.members(db, m.group_id);
    const actions = await D.listActions(db, req.user, { groupId: m.group_id, open: true, now });
    let hqActions = [];
    if (m.agenda_template === 'branch') {
      hqActions = (await db.query(`SELECT a.id, a.issue, a.due_date, a.status, b.code, COALESCE(p.name, '–') AS owner FROM hq_actions a
        LEFT JOIN branches b ON b.id = a.branch_id LEFT JOIN people p ON p.id = a.owner_person_id
        WHERE a.status = 'Open' ORDER BY a.due_date NULLS LAST, a.id LIMIT 30`)).rows;
    }
    const agenda = F.buildAgenda(m.agenda_template, actions, t, { hqActions, managers: managersByBranch(members) });
    const items = await D.agendaItems(db, m);
    const updates = await D.updatesFor(db, m);
    const missing = m.attendee_list.filter((a) => !updates.some((u) => u.user_id === a.id));
    const mine = updates.find((u) => u.user_id === req.user.id) || null;
    const tab = ['agenda', 'updates', 'minutes'].includes(req.query.tab) ? req.query.tab : 'agenda';
    let review = null;
    if (m.draft && !D.locked(m)) {
      const ctx = await M.context(db, req.user, m, { now });
      review = { draft: M.normalise(m.draft, ctx), ctx, unresolved: M.unresolved(M.normalise(m.draft, ctx), ctx.items) };
    }
    let saved = null;
    if (m.status !== 'planned') {
      saved = {
        decisions: (await db.query('SELECT * FROM decisions WHERE meeting_id = $1 ORDER BY id', [m.id])).rows,
        actions: (await D.listActions(db, req.user, { groupId: m.group_id, now })).filter((a) => a.source_meeting_id === m.id),
      };
    }
    res.render('meeting', base(req, {
      title: m.title || m.group_name, m, members, agenda, items, updates, missing, mine, tab, review, saved,
      ceo: A.isCeo(req.user), attendee: m.attendee_list.some((a) => a.id === req.user.id), claudeOn: C.enabled(),
      openActions: actions, unresolvedFlash: String(req.query.unresolved || '').split(',').map(Number).filter(Boolean),
    }));
  }));

  router.post('/meetings/m/:id/items', wrap(async (req, res) => {
    const m = await meetingOr404(req, res); if (!m) return;
    const r = await D.addItem(db, req.user, { id: m.group_id, code: m.group_code, name: m.group_name, branch: m.group_branch }, req.body, { meeting: m });
    back(res, `/meetings/m/${m.id}#items`, r.error || 'Added to the agenda.', r.error ? 'err' : 'ok');
  }));

  router.post('/meetings/items/:id/remove', wrap(async (req, res) => {
    const r = await D.removeItem(db, req.user, req.params.id);
    if (r.notFound) return notFound(res);
    if (r.forbidden) return forbid(res, r.error);
    const to = r.meetingId ? `/meetings/m/${r.meetingId}#items` : require('../lib/safe-path').safePath(req.body.back, '/meetings');
    back(res, to, r.error || 'Item removed.', r.error ? 'err' : 'ok');
  }));

  router.post('/meetings/m/:id/update', wrap(async (req, res) => {
    const m = await meetingOr404(req, res); if (!m) return;
    const r = await D.saveUpdate(db, req.user, m, req.body);
    if (r.forbidden) return forbid(res, r.error);
    back(res, `/meetings/m/${m.id}?tab=updates`, r.error || 'Your update is saved.', r.error ? 'err' : 'ok');
  }));

  router.post('/meetings/m/:id/update/delete', wrap(async (req, res) => {
    const m = await meetingOr404(req, res); if (!m) return;
    const r = await D.deleteUpdate(db, req.user, m, req.body.user || req.user.id);
    if (r.forbidden) return forbid(res, r.error);
    back(res, `/meetings/m/${m.id}?tab=updates`, r.error || 'Update deleted.', r.error ? 'err' : 'ok');
  }));

  // Minutes: op = claude | manual | save_draft | add_dec | add_act | add_upd | discard | save
  router.post('/meetings/m/:id/minutes', wrap(async (req, res) => {
    const m = await meetingOr404(req, res); if (!m) return;
    const to = `/meetings/m/${m.id}?tab=minutes`;
    if (D.locked(m)) return back(res, to, 'The minutes are approved – this meeting is locked.', 'err');
    if (m.status === 'draft') return back(res, to, 'The minutes are already saved and waiting for Dr Aisyah’s approval.', 'err');
    const op = String(req.body.op || '');
    const ctx = await M.context(db, req.user, m, { now });
    if (op === 'claude' || op === 'manual') {
      const notes = D.clean(req.body.notes, { max: 60000, label: 'Notes' });
      if (notes.error) return back(res, to, notes.error, 'err');
      if (notes.value !== m.raw_notes) await db.query('UPDATE meetings SET raw_notes = $2 WHERE id = $1', [m.id, notes.value]);
      if (op === 'manual') {
        const d = M.addRow(M.addRow(M.blankDraft('manual'), 'dec'), 'act', { today: D.today(now) });
        await M.storeDraft(db, req.user, m, d);
        return back(res, to, 'Fill in the minutes below, then Save.');
      }
      const photo = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(String(req.body.photo || ''));
      if (!notes.value && !photo) return back(res, to, 'Paste the notes or add a photo first.', 'err');
      const updates = await D.updatesFor(db, m);
      const r = await C.draftMinutes({ ...ctx, meeting: { ...m, notesForClaude: notes.value }, updates, today: D.today(now) },
        { image: photo ? { type: photo[1], data: photo[2] } : null });
      if (r.error) {
        await M.storeDraft(db, req.user, m, M.addRow(M.addRow(M.blankDraft('manual'), 'dec'), 'act', { today: D.today(now) }));
        return back(res, to, r.error, 'err');
      }
      await M.storeDraft(db, req.user, m, M.normalise(r.draft, ctx));
      return back(res, to, 'Claude drafted the minutes. Check every line, untick anything wrong, then Save.');
    }
    if (op === 'discard') {
      await db.query('UPDATE meetings SET draft = NULL WHERE id = $1', [m.id]);
      return back(res, to, 'Draft discarded.');
    }
    if (op === 'save') {
      const r = await M.save(db, req.user, m, req.body, { now });
      if (r.error) return res.redirect(`${to}&err=${encodeURIComponent(r.error)}${r.unresolved && r.unresolved.length ? `&unresolved=${r.unresolved.join(',')}` : ''}#review`);
      return back(res, to, 'Minutes saved – waiting for Dr Aisyah’s approval.');
    }
    const d = M.normalise({ ...req.body, source: (m.draft && m.draft.source) || 'manual' }, ctx);
    if (op === 'add_dec') M.addRow(d, 'dec');
    if (op === 'add_act') M.addRow(d, 'act', { today: D.today(now) });
    if (op === 'add_upd') {
      const k = `k${M.keys(d.upd).length + 50}`;
      const id = Number(req.body.new_upd) || 0;
      if (ctx.openActionIds.includes(id) && !Object.values(d.upd).some((u) => u.action_id === id)) d.upd[k] = { keep: true, action_id: id, status: 'ip', note: '' };
    }
    await M.storeDraft(db, req.user, m, d);
    back(res, `${to}#review`, op === 'save_draft' ? 'Draft kept.' : 'Row added.');
  }));

  router.post('/meetings/m/:id/text', wrap(async (req, res) => {
    const m = await meetingOr404(req, res); if (!m) return;
    const r = await M.editText(db, req.user, m, req.body);
    back(res, `/meetings/m/${m.id}?tab=minutes`, r.error || 'Minutes corrected.', r.error ? 'err' : 'ok');
  }));

  router.post('/meetings/m/:id/approve', wrap(async (req, res) => {
    const m = await meetingOr404(req, res); if (!m) return;
    const r = await M.approve(db, req.user, m);
    if (r.forbidden) return forbid(res, r.error);
    back(res, `/meetings/m/${m.id}?tab=minutes`, r.error || 'Minutes approved. The meeting is locked.', r.error ? 'err' : 'ok');
  }));

  router.post('/meetings/m/:id/unlock', wrap(async (req, res) => {
    const m = await meetingOr404(req, res); if (!m) return;
    const r = await M.unlock(db, req.user, m);
    if (r.forbidden) return forbid(res, r.error);
    back(res, `/meetings/m/${m.id}?tab=minutes`, r.error || 'Unlocked – the minutes are a draft again.', r.error ? 'err' : 'ok');
  }));

  // ── My notes (private) ──
  router.get('/meetings/notes', wrap(async (req, res) => {
    const notes = await D.myNotes(db, req.user);
    const t = D.today(now);
    const meetings = (await D.listMeetings(db, req.user, {})).filter((m) => m.status !== 'approved' && m.held_on >= require('../calc').addDays(t, -7)).reverse();
    res.render('meetings-notes', base(req, { title: 'My notes', notes, meetings }));
  }));

  router.post('/meetings/notes', wrap(async (req, res) => {
    const r = await D.addNote(db, req.user, req.body);
    back(res, '/meetings/notes', r.error || 'Note saved – only you can see it.', r.error ? 'err' : 'ok');
  }));

  router.post('/meetings/notes/:id', wrap(async (req, res) => {
    const r = await D.noteAct(db, req.user, req.params.id, String(req.body.action || ''), { meetingId: Number(req.body.meeting) || null });
    if (r.notFound) return notFound(res);
    const msgs = { agenda: 'Added to the agenda.', takeback: 'Taken back from the agenda.', done: 'Marked done.', undone: 'Back on your list.', delete: 'Note deleted.' };
    back(res, '/meetings/notes', r.error || msgs[req.body.action] || 'Saved.', r.error ? 'err' : 'ok');
  }));

  // ── Admin → Meeting groups (CEO) ──
  router.get('/meetings/admin/groups', wrap(async (req, res) => {
    if (!A.isCeo(req.user)) return notFound(res);
    res.render('meetings-admin', base(req, { title: 'Meeting groups', groups: await D.allGroupsForAdmin(db), users: await D.selectableUsers(db) }));
  }));

  router.post('/meetings/admin/groups', wrap(async (req, res) => {
    if (!A.isCeo(req.user)) return notFound(res);
    const r = await D.saveGroup(db, req.user, req.body);
    back(res, '/meetings/admin/groups', r.error || 'Group saved.', r.error ? 'err' : 'ok');
  }));

  return router;
}

function filterActions(list, f) {
  const q = (f.q || '').toLowerCase();
  return list.filter((a) => {
    if (f.group && a.group_code !== f.group) return false;
    if (f.area && a.area !== f.area) return false;
    if (f.branch && a.branch !== f.branch) return false;
    if (f.owner && String(a.owner_user_id) !== f.owner) return false;
    const s = f.status || 'open';
    if (s === 'open' && !a.open) return false;
    if (s === 'overdue' && !a.overdue) return false;
    if (s === 'ceo' && !(a.open && a.needs_ceo)) return false;
    if (s === 'stale' && !a.stale) return false;
    if (s === 'soon' && !a.due_soon) return false;
    if (['ns', 'ip', 'bl', 'dn'].includes(s) && a.status !== s) return false;
    if (q && !`${a.title} ${a.last_text || ''}`.toLowerCase().includes(q)) return false;
    return true;
  });
}

module.exports = { meetingRoutes, filterActions };
