// Meetings module: bring in the two prototypes' data (Management Council and Branch Manager Meeting
// artifacts). Input shape – one JSON file kept OUTSIDE the repo (the repo is public):
//   { "council": { people, actions, decisions, meetings, agenda, updates },
//     "bm":      { … } }
// each collection an array of { id, data } documents as the prototypes stored them.
// Safe to run twice: every row carries import_key "<group>:<doc id>" and is skipped if present.
// Rows the database refuses (e.g. the salary guard) are skipped and listed.

const A = require('./access');
const calc = require('../calc');
const { isRealDate } = require('../lib/dates');

const GROUP_FOR = { council: 'council', bm: 'bm' };
// Prototype person ids that differ from 4DX usernames.
const USERNAME_FOR = { aisyah: 'admin', hannin: 'hanin' };
const docs = (c) => (Array.isArray(c) ? c : []).map((d) => ({ id: String(d.id), ...(d.data || {}) }));
const day = (v) => (isRealDate(String(v || '').slice(0, 10)) ? String(v).slice(0, 10) : null);

async function importExport(db, data, { log = () => {} } = {}) {
  const summary = { actions: 0, updates: 0, decisions: 0, meetings: 0, agenda: 0, meeting_updates: 0, skipped: [], unmatched: [] };
  const users = (await db.query(`SELECT u.id, u.username, lower(COALESCE(p.name, u.display_name)) AS name FROM users u
    LEFT JOIN people p ON p.id = u.person_id WHERE u.active`)).rows;
  const userFor = (pid, people) => {
    if (!pid) return null;
    const uname = USERNAME_FOR[pid] || pid;
    let u = users.find((x) => x.username === uname);
    if (!u) {
      const p = people.find((x) => x.id === pid);
      const first = p && p.name ? p.name.split(' ')[0].toLowerCase() : null;
      u = first ? users.find((x) => x.name === first) : null;
    }
    if (!u && !summary.unmatched.includes(pid)) summary.unmatched.push(pid);
    return u ? u.id : null;
  };
  const ceo = (await db.query("SELECT id FROM users WHERE role = 'admin' AND is_super ORDER BY id LIMIT 1")).rows[0]?.id || null;

  for (const [key, code] of Object.entries(GROUP_FOR)) {
    const src = data[key];
    if (!src) continue;
    const g = (await db.query('SELECT id FROM meeting_groups WHERE code = $1', [code])).rows[0];
    if (!g) { summary.skipped.push(`${key}: group ${code} not found`); continue; }
    const people = docs(src.people);
    const row = async (what, k, fn) => {
      try { await db.transaction(fn); } catch (err) { summary.skipped.push(`${key}:${k} (${what}): ${err.message.slice(0, 80)}`); }
    };
    const exists = async (table, ik) => (await db.query(`SELECT id FROM ${table} WHERE import_key = $1`, [ik])).rows[0];

    // Meetings: the prototypes sometimes hold two copies of the same meeting – keep the fuller one.
    const ms = docs(src.meetings);
    const keep = ms.filter((m) => !ms.some((o) => o !== m && o.date === m.date && (o.time || '') === (m.time || '')
      && ((o.attendees || []).length > (m.attendees || []).length || ((o.attendees || []).length === (m.attendees || []).length && o.id < m.id))));
    const meetingIds = {};
    for (const m of keep) {
      const ik = `${key}:${m.id}`;
      const found = await exists('meetings', ik);
      if (found) { meetingIds[m.id] = found.id; continue; }
      const held = day(m.date); if (!held) { summary.skipped.push(`${ik}: no date`); continue; }
      await row('meeting', m.id, async (tx) => {
        const mi = m.minutes || {};
        const status = m.status === 'approved' ? 'approved' : m.status === 'draft' ? 'draft' : 'planned';
        const id = (await tx.query(`INSERT INTO meetings (group_id, title, held_on, start_time, status, raw_notes, summary, parked, next_meeting, created_by, import_key)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
        [g.id, m.title || null, held, m.time || null, status, m.notes || null, mi.summary || null, JSON.stringify(mi.parked || []), mi.next || null, ceo, ik])).rows[0].id;
        let att = (m.attendees || []).map((p) => userFor(p, people)).filter(Boolean);
        if (!att.length) att = (await tx.query(`SELECT user_id FROM meeting_group_members WHERE group_id = $1`, [g.id])).rows.map((r) => r.user_id).concat(ceo ? [ceo] : []);
        for (const u of [...new Set(att)]) await tx.query('INSERT INTO meeting_attendees (meeting_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [id, u]);
        meetingIds[m.id] = id;
        summary.meetings++;
      });
    }
    for (const m of ms.filter((x) => !keep.includes(x))) meetingIds[m.id] = meetingIds[keep.find((k) => k.date === m.date && (k.time || '') === (m.time || '')).id];

    for (const a of docs(src.actions)) {
      const ik = `${key}:${a.id}`;
      if (await exists('actions', ik)) continue;
      if (!a.title) { summary.skipped.push(`${ik}: no title`); continue; }
      await row('action', a.id, async (tx) => {
        const id = (await tx.query(`INSERT INTO actions (group_id, title, owner_user_id, due, area, branch, status, priority, needs_ceo, raised_count,
            first_raised, source, last_update_at, created_by, created_at, import_key)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,COALESCE($15::timestamptz, now()),$16) RETURNING id`,
        [g.id, String(a.title).slice(0, 300), userFor(a.owner, people), day(a.due), A.AREAS[a.area] ? a.area : 'mgmt', A.BRANCHES[a.branch] ? a.branch : 'HQ',
          A.STATUS[a.status] ? a.status : 'ns', A.PRIORITY.includes(a.priority) ? a.priority : 'Normal', Boolean(a.needsCEO), Math.max(1, Number(a.raisedCount) || 1),
          day(a.firstRaised), a.source || `Imported from the ${key === 'bm' ? 'Branch Manager Meeting' : 'Management Council'} prototype`,
          a.lastUpdate || null, userFor(a.createdBy, people) || ceo, a.createdAt || null, ik])).rows[0].id;
        for (const u of a.updates || []) {
          if (!u || !u.text) continue;
          await tx.query('INSERT INTO action_updates (action_id, at, by_user, text) VALUES ($1, COALESCE($2::timestamptz, now()), $3, $4)',
            [id, u.at || null, userFor(u.by, people), String(u.text).slice(0, 500)]);
          summary.updates++;
        }
        summary.actions++;
      });
    }

    for (const d of docs(src.decisions)) {
      const ik = `${key}:${d.id}`;
      if (await exists('decisions', ik)) continue;
      if (!d.text) continue;
      await row('decision', d.id, async (tx) => {
        await tx.query(`INSERT INTO decisions (group_id, meeting_id, decided_on, text, context, area, branch, decided_by, created_by, import_key)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [g.id, meetingIds[d.meetingId] || null, day(d.date) || calc.todayInMalaysia(), String(d.text).slice(0, 500), d.context ? String(d.context).slice(0, 500) : null,
          A.AREAS[d.area] ? d.area : 'mgmt', A.BRANCHES[d.branch] ? d.branch : 'ALL', userFor(d.decidedBy, people), ceo, ik]);
        summary.decisions++;
      });
    }

    for (const it of docs(src.agenda)) {
      const ik = `${key}:${it.id}`;
      if (await exists('agenda_items', ik)) continue;
      if (!it.text) continue;
      await row('agenda item', it.id, async (tx) => {
        await tx.query(`INSERT INTO agenda_items (group_id, meeting_id, text, need, raised_by, source, import_key) VALUES ($1,$2,$3,$4,$5,'import',$6)`,
          [g.id, meetingIds[it.meetingId] || null, String(it.text).slice(0, 500), A.NEEDS[it.need] ? it.need : 'discuss', userFor(it.raisedBy || it.by, people), ik]);
        summary.agenda++;
      });
    }

    for (const u of docs(src.updates)) {
      const mid = meetingIds[u.meetingId]; const by = userFor(u.by || u.owner, people);
      if (!mid || !by) continue;
      await row('meeting update', u.id, async (tx) => {
        const r = await tx.query(`INSERT INTO meeting_updates (meeting_id, user_id, win, issue1, issue2, help_needed) VALUES ($1,$2,$3,$4,$5,$6)
          ON CONFLICT (meeting_id, user_id) DO NOTHING`, [mid, by, u.win || null, u.issue1 || null, u.issue2 || null, u.help || u.helpNeeded || null]);
        if (r.rowCount || r.affectedRows) summary.meeting_updates++;
      });
    }
  }
  await db.query("INSERT INTO audit_log (action, table_name, record_key, new_value) VALUES ('import', 'actions', 'Meetings prototypes import', $1)",
    [JSON.stringify({ ...summary, skipped: summary.skipped.length })]);
  log(`Imported: ${summary.actions} actions (${summary.updates} updates), ${summary.decisions} decisions, ${summary.meetings} meetings, ${summary.agenda} agenda items, ${summary.meeting_updates} meeting updates.`);
  if (summary.unmatched.length) log(`No login found for: ${summary.unmatched.join(', ')} (left without owner).`);
  if (summary.skipped.length) log(`Skipped ${summary.skipped.length}:\n  ${summary.skipped.join('\n  ')}`);
  return summary;
}

module.exports = { importExport };
