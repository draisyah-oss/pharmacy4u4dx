// Meetings – "What's new" (9 Nov 2026, CEO): every 1:1 held / minutes saved, follow-up, action
// update / status change / done and new item to discuss is written to meeting_events as it happens,
// one line each. The CEO overview shows everything since she last pressed "Mark all as seen"
// (meeting_seen, per login), plus actions that became overdue since then (worked out, not stored).
// Reading goes through the same group access as every other Meetings page; CEO-only rows are only
// for the CEO and the person who wrote them.

const A = require('./access');
const calc = require('../calc');

const KIND_LABEL = {
  minutes: 'Minutes', approved: 'Minutes approved', followup: 'Follow-up', action_update: 'Action update',
  action_status: 'Status change', action_done: 'Action done', action_new: 'New action', item: 'Item to discuss', overdue: 'Now overdue',
};

const firstName = (n) => (n === 'Admin' ? 'Dr Aisyah' : n);
const short = (s, n = 140) => { const t = String(s || '').replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };

// Write one event, in the same transaction as the change it describes (q = db or a transaction).
// Its text is built from boxes that already passed the salary guard.
async function log(q, e) {
  await q.query(
    `INSERT INTO meeting_events (kind, actor, subject_user, group_id, branch, ref_type, ref_id, link_id, text, ceo_only)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [e.kind, e.actor || null, e.subject || null, e.groupId, e.branch || null, e.refType, e.refId, e.linkId || null, short(e.text, 400), Boolean(e.ceoOnly)]);
}

// Name of a login (people.name, else display name; the CEO's admin login shows as Dr Aisyah).
async function nameOf(q, userId) {
  if (!userId) return '–';
  const r = (await q.query('SELECT COALESCE(p.name, u.display_name) AS name FROM users u LEFT JOIN people p ON p.id = u.person_id WHERE u.id = $1', [userId])).rows[0];
  return r ? firstName(r.name) : '–';
}

// The branch manager in a Branch 1:1 group (who the 1:1 is with).
async function branchManagerOf(q, groupId) {
  return (await q.query(
    `SELECT u.id, COALESCE(p.name, u.display_name) AS name FROM meeting_group_members m JOIN users u ON u.id = m.user_id
     LEFT JOIN people p ON p.id = u.person_id WHERE m.group_id = $1 AND u.role = 'branch_manager' AND u.active ORDER BY u.id LIMIT 1`, [groupId])).rows[0] || null;
}

// "WM (Hafizah)" for a Branch 1:1 group, else the group's name.
async function groupLabel(q, group) {
  if (group.kind === 'branch_1on1') {
    const bm = await branchManagerOf(q, group.id);
    return { label: `${group.branch || group.name}${bm ? ` (${bm.name})` : ''}`, bm };
  }
  return { label: group.name, bm: null };
}

// Minutes saved / approved. A Branch 1:1 reads "Hanin held the WM (Hafizah) 1:1 on 2026-11-10 – minutes saved".
async function meetingEvent(q, user, meeting, kind, detail = '') {
  const group = { id: meeting.group_id, name: meeting.group_name, kind: meeting.kind, branch: meeting.group_branch };
  const { label, bm } = await groupLabel(q, group);
  const actor = await nameOf(q, user.id);
  let text;
  if (kind === 'approved') text = `${actor} approved the minutes: ${meeting.title || meeting.group_name}, ${meeting.held_on}`;
  else if (group.kind === 'branch_1on1') text = `${await nameOf(q, meeting.led_by || user.id)} held the ${label} 1:1 on ${meeting.held_on} – minutes saved${detail ? ` (${detail})` : ''}`;
  else text = `${actor} saved the minutes: ${meeting.title || meeting.group_name}, ${meeting.held_on}${detail ? ` (${detail})` : ''}`;
  await log(q, { kind, actor: user.id, subject: bm && bm.id, groupId: group.id, branch: group.branch || null, refType: 'meeting', refId: meeting.id, text });
}

async function seenAt(db, user) {
  const r = (await db.query('SELECT seen_at FROM meeting_seen WHERE user_id = $1', [user.id])).rows[0];
  if (r) return new Date(r.seen_at);
  const s = (await db.query("SELECT value FROM app_settings WHERE key = 'meetings_feed_start'")).rows[0];
  return s && s.value ? new Date(s.value) : new Date(0);
}

async function markSeen(db, user, upto) {
  const t = upto && !Number.isNaN(new Date(upto).getTime()) ? new Date(upto) : null;
  await db.query(
    `INSERT INTO meeting_seen (user_id, seen_at) VALUES ($1, LEAST(now(), COALESCE($2::timestamptz, now())))
     ON CONFLICT (user_id) DO UPDATE SET seen_at = GREATEST(meeting_seen.seen_at, EXCLUDED.seen_at)`, [user.id, t ? t.toISOString() : null]);
}

const linkFor = (e) => {
  if (e.ref_type === 'meeting') return `/meetings/m/${e.ref_id}`;
  if (e.ref_type === 'action') return `/meetings/actions/${e.ref_id}`;
  if (e.ref_type === 'followup') return `/meetings/g/${e.group_code}#fu-${e.ref_id}`;
  if (e.ref_type === 'item') return e.link_id ? `/meetings/m/${e.link_id}#items` : `/meetings/g/${e.group_code}#items`;
  return `/meetings/g/${e.group_code}`;
};

// Everything new for this login since `since` (default: their last "Mark all as seen").
// Filters: branch (WM, BR, … as in actions), person (user id: who did it or who it's about), group (code).
async function feed(db, user, { now, since = null, branch = '', person = '', group = '' } = {}) {
  const from = since || (await seenAt(db, user));
  const [where, args] = await A.groupFilter(db, user, 'e.group_id', [from.toISOString(), user.id, A.isCeo(user)]);
  const rows = (await db.query(
    `SELECT e.*, g.code AS group_code, g.name AS group_name, g.kind AS group_kind
     FROM meeting_events e JOIN meeting_groups g ON g.id = e.group_id
     WHERE e.at > $1 AND g.active AND ${where} AND (NOT e.ceo_only OR $3::boolean OR e.actor = $2)
     ORDER BY e.at DESC, e.id DESC LIMIT 500`, args)).rows;
  const items = rows.map((e) => ({
    id: `e${e.id}`, at: new Date(e.at), kind: e.kind, label: KIND_LABEL[e.kind] || e.kind, text: e.text, href: linkFor(e),
    branch: e.branch, group_code: e.group_code, group_name: e.group_name, people: [e.actor, e.subject_user].filter(Boolean), ceo_only: e.ceo_only,
  }));

  // Actions that became overdue since then: still open, due before today, and either due on or after the day of
  // `from` or added since (an action added with a date already past is new to her too).
  const t = calc.todayInMalaysia(now());
  const fromDay = calc.todayInMalaysia(from);
  const [w2, a2] = await A.groupFilter(db, user, 'a.group_id', [fromDay, t, from.toISOString()]);
  const late = (await db.query(
    `SELECT a.id, a.title, a.due, a.branch, a.owner_user_id, a.created_at, g.code AS group_code, g.name AS group_name, COALESCE(p.name, u.display_name) AS owner
     FROM actions a JOIN meeting_groups g ON g.id = a.group_id LEFT JOIN users u ON u.id = a.owner_user_id LEFT JOIN people p ON p.id = u.person_id
     WHERE a.status <> 'dn' AND a.due IS NOT NULL AND a.due < $2 AND (a.due >= $1 OR a.created_at > $3) AND g.active AND ${w2}`, a2)).rows;
  for (const a of late) {
    const due = typeof a.due === 'string' ? a.due : calc.todayInMalaysia(new Date(a.due));
    const became = new Date(`${calc.addDays(due, 1)}T00:00:00+08:00`);
    items.push({
      id: `o${a.id}`, at: new Date(Math.max(became, new Date(a.created_at))), kind: 'overdue', label: KIND_LABEL.overdue,
      text: `Now overdue: ${a.title} (${a.owner ? firstName(a.owner) : 'no owner'}, ${a.group_name}) – was due ${due}`,
      href: `/meetings/actions/${a.id}`, branch: a.branch, group_code: a.group_code, group_name: a.group_name, people: [a.owner_user_id].filter(Boolean),
    });
  }
  items.sort((x, y) => y.at - x.at);
  const all = items;
  const shown = all.filter((i) => (!branch || i.branch === branch)
    && (!person || i.people.includes(Number(person)))
    && (!group || i.group_code === group));
  return { since: from, all, shown, upto: rows.length ? new Date(rows[0].at) : null };
}

// Count for the badge on the CEO overview tab.
async function count(db, user, { now }) {
  return (await feed(db, user, { now })).all.length;
}

module.exports = { log, meetingEvent, feed, count, markSeen, seenAt, nameOf, branchManagerOf, groupLabel, KIND_LABEL, short };
