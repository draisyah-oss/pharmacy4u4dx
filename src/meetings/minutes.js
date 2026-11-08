// Meetings module: minutes. Notes (or Claude's draft) → a draft the meeting reviews and edits →
// Save minutes (decisions, new actions, follow-ups on existing actions, parked items; status
// "Minutes draft") → only the CEO approves (status "Minutes approved", meeting locked).
// Every item raised for the meeting must end as a decision, an action (new or an existing one
// followed up) or parked – Save is refused until each one has an outcome.
//
// Draft shape (meetings.draft, also what the review form posts back):
//   { source, summary, next, parked: [text],
//     dec: { k0: { keep, text, area, branch } }, act: { k0: { keep, title, owner, due, area, branch, priority, needs_ceo } },
//     upd: { k0: { keep, action_id, status, note } }, out: { i<itemId>: 'dec:k0' | 'act:k0' | 'upd:k0' | 'parked' } }

const A = require('./access');
const D = require('./data');
const calc = require('../calc');
const { isRealDate } = require('../lib/dates');

const keys = (o) => Object.keys(o || {}).filter((k) => /^k\d+$/.test(k)).sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));
const kept = (row) => row && (row.keep === true || row.keep === '1' || row.keep === 'on');
const nextKey = (o) => `k${keys(o).reduce((n, k) => Math.max(n, Number(k.slice(1)) + 1), 0)}`;
const str = (v, max = 500) => String(v ?? '').replace(/\r\n/g, '\n').trim().slice(0, max);

function blankDraft(source = 'manual') {
  return { source, summary: '', next: '', parked: [], dec: {}, act: {}, upd: {}, out: {} };
}

// Turn posted form fields (or Claude's JSON) into a clean draft. Unknown values fall back to defaults.
function normalise(body, { memberIds = [], openActionIds = [], itemIds = [] } = {}) {
  const d = blankDraft(body.source === 'claude' ? 'claude' : 'manual');
  d.summary = str(body.summary, 2000);
  d.next = str(body.next, 200);
  d.parked = (Array.isArray(body.parked) ? body.parked : String(body.parked || '').split('\n')).map((x) => str(x, 300)).filter(Boolean).slice(0, 30);
  for (const k of keys(body.dec)) {
    const r = body.dec[k] || {};
    d.dec[k] = { keep: kept(r), text: str(r.text), area: A.AREAS[r.area] ? r.area : 'mgmt', branch: A.BRANCHES[r.branch] ? r.branch : 'ALL' };
  }
  for (const k of keys(body.act)) {
    const r = body.act[k] || {};
    const owner = Number(r.owner) || null;
    d.act[k] = {
      keep: kept(r), title: str(r.title, 300), owner: owner && memberIds.includes(owner) ? owner : null,
      due: isRealDate(String(r.due || '')) ? String(r.due) : '', area: A.AREAS[r.area] ? r.area : 'mgmt',
      branch: A.BRANCHES[r.branch] ? r.branch : 'HQ', priority: A.PRIORITY.includes(r.priority) ? r.priority : 'Normal',
      needs_ceo: r.needs_ceo === true || r.needs_ceo === '1' || r.needs_ceo === 'on',
    };
  }
  for (const k of keys(body.upd)) {
    const r = body.upd[k] || {};
    const id = Number(r.action_id) || 0;
    if (!openActionIds.includes(id)) continue; // never an action from another group, never a duplicate
    if (Object.values(d.upd).some((u) => u.action_id === id)) continue;
    d.upd[k] = { keep: kept(r), action_id: id, status: A.STATUS[r.status] ? r.status : 'ip', note: str(r.note) };
  }
  for (const [k, v] of Object.entries(body.out || {})) {
    const id = Number(String(k).replace(/^i/, ''));
    if (!itemIds.includes(id)) continue;
    const s = String(v || '');
    if (s === 'parked' || /^(dec|act|upd):k\d+$/.test(s)) d.out[`i${id}`] = s;
  }
  return d;
}

// Which items have no (valid) outcome? An outcome must point at a kept row.
function unresolved(draft, items) {
  return items.filter((it) => {
    const o = draft.out[`i${it.id}`];
    if (!o) return true;
    if (o === 'parked') return false;
    const [kind, k] = o.split(':');
    const row = draft[kind] && draft[kind][k];
    return !kept(row);
  }).map((it) => it.id);
}

// What the review page needs about the meeting.
async function context(db, user, meeting, { now }) {
  const mem = await D.members(db, meeting.group_id);
  const open = await D.listActions(db, user, { groupId: meeting.group_id, open: true, now });
  const items = await D.agendaItems(db, meeting);
  return { members: mem, openActions: open, items, memberIds: mem.map((m) => m.id), openActionIds: open.map((a) => a.id), itemIds: items.map((i) => i.id) };
}

async function storeDraft(db, user, meeting, draft) {
  await db.query('UPDATE meetings SET draft = $2, updated_at = now() WHERE id = $1', [meeting.id, JSON.stringify(draft)]);
  await D.audit(db, user, 'draft', 'meetings', meeting.id, null, { source: draft.source });
}

// Add an empty row to the draft (no JavaScript needed on the page).
function addRow(draft, kind, { today, defaultOwner = null } = {}) {
  const k = nextKey(draft[kind]);
  if (kind === 'dec') draft.dec[k] = { keep: true, text: '', area: 'mgmt', branch: 'ALL' };
  if (kind === 'act') draft.act[k] = { keep: true, title: '', owner: defaultOwner, due: today ? calc.addDays(today, 7) : '', area: 'mgmt', branch: 'HQ', priority: 'Normal', needs_ceo: false };
  if (kind === 'upd') draft.upd[k] = { keep: true, action_id: 0, status: 'ip', note: '' };
  return draft;
}

// Save the reviewed minutes: everything in one transaction.
async function save(db, user, meeting, body, { now }) {
  if (D.locked(meeting)) return { error: 'The minutes are approved – this meeting is locked.' };
  if (meeting.status === 'draft') return { error: 'The minutes are already saved and waiting for Dr Aisyah’s approval.' };
  const ctx = await context(db, user, meeting, { now });
  // Rows for existing actions arrive with action_id in the form; new "follow-up" rows pick one there.
  const draft = normalise(body, ctx);
  const errors = [];
  for (const k of keys(draft.dec)) if (kept(draft.dec[k]) && !draft.dec[k].text) errors.push('A decision is empty – write it or untick it.');
  for (const k of keys(draft.act)) {
    const a = draft.act[k];
    if (!kept(a)) continue;
    if (!a.title) errors.push('An action has no “what needs to be done” – write it or untick it.');
    if (!a.owner) errors.push(`“${a.title || 'An action'}” needs an owner from this group.`);
    if (!a.due) errors.push(`“${a.title || 'An action'}” needs a due date.`);
  }
  const open = unresolved(draft, ctx.items);
  if (open.length) errors.push(`${open.length} item${open.length === 1 ? '' : 's'} raised for this meeting ${open.length === 1 ? 'has' : 'have'} no outcome – choose decision, action or parked (shown in red).`);
  if (errors.length) {
    await storeDraft(db, user, meeting, draft);
    return { error: [...new Set(errors)].join(' '), unresolved: open, draft };
  }
  const t = D.today(now);
  const label = `Minutes ${meeting.held_on}`;
  try {
    await db.transaction(async (tx) => {
      const group = { id: meeting.group_id, code: meeting.group_code };
      const made = { dec: {}, act: {}, upd: {} };
      for (const k of keys(draft.dec)) {
        const r = draft.dec[k];
        if (!kept(r)) continue;
        const out = await D.createDecision(tx, user, group, { text: r.text, area: r.area, branch: r.branch, date: meeting.held_on }, { now, meetingId: meeting.id, tx });
        if (out.error) throw new Error(out.error);
        made.dec[k] = out.id;
      }
      for (const k of keys(draft.act)) {
        const r = draft.act[k];
        if (!kept(r)) continue;
        const out = await D.createAction(tx, user, group, { ...r, status: 'ns' }, { now, meetingId: meeting.id, source: label, tx });
        if (out.error) throw new Error(out.error);
        made.act[k] = out.id;
      }
      const applied = [];
      for (const k of keys(draft.upd)) {
        const r = draft.upd[k];
        if (!kept(r)) continue;
        const a = await D.loadAction(tx, user, r.action_id, { now });
        if (!a) continue;
        const out = await D.updateAction(tx, user, a, { status: r.status, note: r.note || `Discussed at ${label}` }, { now, tx, raised: true });
        if (out.error) throw new Error(out.error);
        made.upd[k] = a.id;
        applied.push({ action_id: a.id, title: a.title, status: r.status, note: r.note });
      }
      const parked = [...draft.parked];
      for (const it of ctx.items) {
        const o = draft.out[`i${it.id}`];
        let outcome; let ref = null;
        if (o === 'parked') { outcome = 'parked'; if (!parked.includes(it.text)) parked.push(it.text); } else {
          const [kind, k] = o.split(':');
          outcome = kind === 'dec' ? 'decision' : 'action';
          ref = made[kind][k] || null;
        }
        await tx.query('UPDATE agenda_items SET outcome = $2, outcome_ref = $3, meeting_id = $4 WHERE id = $1', [it.id, outcome, ref, meeting.id]);
      }
      await tx.query(`UPDATE meetings SET summary = $2, next_meeting = $3, parked = $4, minutes_updates = $5, status = 'draft', draft = NULL,
        updated_at = now() WHERE id = $1`, [meeting.id, draft.summary || null, draft.next || null, JSON.stringify(parked), JSON.stringify(applied)]);
      await D.audit(tx, user, 'minutes', 'meetings', meeting.id, null, { decisions: Object.values(made.dec), actions: Object.values(made.act), followups: Object.values(made.upd), parked: parked.length, day: t });
    });
  } catch (err) {
    if (/salary|pay/i.test(err.message) || /p4u_mentions_salary|check constraint/i.test(err.message)) return { error: 'Salaries and pay can’t be stored in this app (privacy rule).', draft };
    throw err;
  }
  return { ok: true };
}

async function approve(db, user, meeting) {
  if (!A.isCeo(user)) return { forbidden: true, error: 'Only Dr Aisyah approves minutes.' };
  if (meeting.status !== 'draft') return { error: 'Save the minutes first.' };
  await db.query("UPDATE meetings SET status = 'approved', approved_by = $2, approved_at = now(), updated_at = now() WHERE id = $1", [meeting.id, user.id]);
  await D.audit(db, user, 'approve', 'meetings', meeting.id, { status: 'draft' }, { status: 'approved' });
  return { ok: true };
}

async function unlock(db, user, meeting) {
  if (!A.isCeo(user)) return { forbidden: true, error: 'Only Dr Aisyah can unlock approved minutes.' };
  if (meeting.status !== 'approved') return { ok: true };
  await db.query("UPDATE meetings SET status = 'draft', approved_by = NULL, approved_at = NULL, updated_at = now() WHERE id = $1", [meeting.id]);
  await D.audit(db, user, 'unlock', 'meetings', meeting.id, { status: 'approved' }, { status: 'draft' });
  return { ok: true };
}

// Saved minutes, unapproved: the summary, parked items and next meeting can still be corrected.
async function editText(db, user, meeting, body) {
  if (meeting.status !== 'draft') return { error: D.locked(meeting) ? 'The minutes are approved – this meeting is locked.' : 'Save the minutes first.' };
  const summary = D.clean(body.summary, { max: 2000, label: 'Summary' }); if (summary.error) return summary;
  const next = D.clean(body.next, { max: 200, label: 'Next meeting' }); if (next.error) return next;
  const parked = String(body.parked || '').split('\n').map((x) => x.trim()).filter(Boolean).slice(0, 30);
  const pc = D.clean(parked.join('\n'), { max: 9000, label: 'Parked items' }); if (pc.error) return pc;
  await db.query('UPDATE meetings SET summary = $2, next_meeting = $3, parked = $4, updated_at = now() WHERE id = $1', [meeting.id, summary.value, next.value, JSON.stringify(parked)]);
  await D.audit(db, user, 'update', 'meetings', meeting.id, { summary: meeting.summary, next: meeting.next_meeting, parked: meeting.parked }, { summary: summary.value, next: next.value, parked });
  return { ok: true };
}

module.exports = { blankDraft, normalise, unresolved, context, storeDraft, addRow, save, approve, unlock, editText, keys, kept };
