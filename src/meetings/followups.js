// Quick follow-up log (9 Nov 2026, CEO): a call / visit / WhatsApp / meeting to check on something,
// logged in any group (mainly the Branch 1:1s) so the CEO doesn't need a separate update.
//   – Linked to an action: the follow-up goes into that action's update history, and its status can be
//     changed in the same form. A CEO-only follow-up only writes "Status changed by a private follow-up"
//     there, because the action's history is read by the whole group.
//   – A next step can become a new action (owner from the group, due date).
//   – CEO only: seen by the CEO and the author, nobody else (checked in every query here).
// Every follow-up is a line in the CEO's "What's new".

const A = require('./access');
const D = require('./data');
const E = require('./events');
const { isRealDate } = require('../lib/dates');

const KINDS = { call: 'Call', visit: 'Visit', whatsapp: 'WhatsApp', meeting: 'Meeting' };

const SELECT = `SELECT f.*, g.code AS group_code, g.name AS group_name, g.kind AS group_kind,
  COALESCE(p.name, u.display_name) AS by_name, u.is_super AS by_super,
  a.title AS action_title, n.title AS new_action_title
  FROM followups f JOIN meeting_groups g ON g.id = f.group_id
  JOIN users u ON u.id = f.by_user LEFT JOIN people p ON p.id = u.person_id
  LEFT JOIN actions a ON a.id = f.action_id LEFT JOIN actions n ON n.id = f.new_action_id`;

const tidy = (r) => ({ ...r, by_name: r.by_super && r.by_name === 'Admin' ? 'Dr Aisyah' : r.by_name });

// Follow-ups this login may read: groups they're in (CEO: all), and CEO-only ones only for the CEO / author.
async function list(db, user, { groupId = null, branch = null, limit = 30 } = {}) {
  const [where, args] = await A.groupFilter(db, user, 'f.group_id', [user.id, A.isCeo(user)]);
  const cond = [where, 'g.active', '(NOT f.ceo_only OR $2::boolean OR f.by_user = $1)'];
  if (groupId) { args.push(Number(groupId)); cond.push(`f.group_id = $${args.length}`); }
  if (branch) { args.push(branch); cond.push(`f.branch = $${args.length}`); }
  args.push(Math.min(Number(limit) || 30, 200));
  return (await db.query(`${SELECT} WHERE ${cond.join(' AND ')} ORDER BY f.done_on DESC, f.created_at DESC, f.id DESC LIMIT $${args.length}`, args)).rows.map(tidy);
}

// Actions a follow-up in this group can link to: open actions of the group; in a Branch 1:1 also the
// open actions for that branch in the other groups this login can see (e.g. from the Branch Managers meeting).
async function linkableActions(db, user, group, { now }) {
  const all = await D.listActions(db, user, { open: true, now });
  return all.filter((a) => a.group_id === group.id || (group.kind === 'branch_1on1' && group.branch && a.branch === group.branch));
}

async function create(db, user, group, body, { now }) {
  const t = D.today(now);
  const doneOn = isRealDate(String(body.date || '')) ? String(body.date) : t;
  if (doneOn > t) return { error: 'The follow-up date can’t be in the future.' };
  const kind = KINDS[body.kind] ? body.kind : null;
  if (!kind) return { error: 'Choose how you followed up: call, visit, WhatsApp or meeting.' };
  const checked = D.clean(body.checked, { max: 500, label: 'What was checked', required: true });
  if (checked.error) return checked;
  const outcome = D.clean(body.outcome, { max: 500, label: 'Outcome' });
  if (outcome.error) return outcome;
  const next = D.clean(body.next_step, { max: 300, label: 'Next step' });
  if (next.error) return next;
  const branch = group.kind === 'branch_1on1' && group.branch ? group.branch
    : (Object.keys(A.BRANCHES).includes(body.branch) ? body.branch : 'HQ');
  const ceoOnly = body.ceo_only === '1' || body.ceo_only === 'on';

  let action = null;
  if (Number(body.action_id)) {
    action = (await linkableActions(db, user, group, { now })).find((a) => a.id === Number(body.action_id));
    if (!action) return { error: 'That action can’t be linked here (it is closed or not in this group).' };
  }
  const status = action && A.STATUS[body.status] && body.status !== action.status ? body.status : null;
  const makeAction = (body.make_action === '1' || body.make_action === 'on');
  if (makeAction && !next.value) return { error: 'Write the next step to turn it into an action.' };

  const members = await D.members(db, group.id);
  if (makeAction && !members.some((m) => m.id === Number(body.new_owner))) return { error: 'Choose an owner for the new action from this group.' };

  return db.transaction(async (tx) => {
    const id = (await tx.query(
      `INSERT INTO followups (group_id, branch, done_on, kind, checked, outcome, next_step, action_id, status_from, status_to, ceo_only, by_user)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
      [group.id, branch, doneOn, kind, checked.value, outcome.value, next.value, action ? action.id : null,
        status ? action.status : null, status, ceoOnly, user.id])).rows[0].id;

    if (action) {
      const note = ceoOnly
        ? (status ? 'Status changed by a private follow-up' : null)
        : `Follow-up (${KINDS[kind]}, ${doneOn}): ${checked.value}${outcome.value ? ` → ${outcome.value}` : ''}${next.value ? `. Next: ${next.value}` : ''}`;
      if (note || status) {
        const r = await D.updateAction(tx, user, action, { ...(status ? { status } : {}), ...(note ? { note } : {}) }, { now, tx, quiet: true });
        if (r.error) throw new Error(r.error);
      }
    }

    let newId = null;
    if (makeAction) {
      const r = await D.createAction(tx, user, group, {
        title: next.value, owner: String(body.new_owner), due: body.new_due, branch: branch, area: Object.keys(A.AREAS).includes(body.new_area) ? body.new_area : 'mgmt',
        note: ceoOnly ? null : `From a follow-up on ${doneOn}: ${checked.value}`,
      }, { now, source: `Follow-up ${doneOn}`, tx });
      if (r.error) throw new Error(r.error);
      newId = r.id;
      await tx.query('UPDATE followups SET new_action_id = $2 WHERE id = $1', [id, newId]);
    }

    await D.audit(tx, user, 'insert', 'followups', id, null, {
      group: group.code, branch, done_on: doneOn, kind, checked: checked.value, outcome: outcome.value, next_step: next.value,
      action_id: action && action.id, status_to: status, new_action_id: newId, ceo_only: ceoOnly,
    });

    // "Hanin followed up WM (Hafizah): aircond checklist done → action closed"
    const who = await E.nameOf(tx, user.id);
    const { label, bm } = await E.groupLabel(tx, group);
    const where = group.kind === 'branch_1on1' ? label : `${A.BRANCHES[branch] || branch} (${group.name})`;
    let text = `${who} followed up ${where} by ${KINDS[kind].toLowerCase()}: ${outcome.value || checked.value}`;
    if (status === 'dn') text += ' → action closed';
    else if (status) text += ` → action ${A.STATUS[status].toLowerCase()}`;
    if (newId) text += ` · new action: ${next.value}`;
    else if (next.value) text += ` · next: ${next.value}`;
    await E.log(tx, { kind: 'followup', actor: user.id, subject: (bm && bm.id) || (action && action.owner_user_id), groupId: group.id, branch,
      refType: 'followup', refId: id, text, ceoOnly });
    return { ok: true, id, newActionId: newId, closed: status === 'dn' };
  }).catch((err) => {
    if (/p4u_mentions_salary|check constraint|salary/i.test(err.message)) return { error: 'Salaries and pay can’t be stored in this app (privacy rule).' };
    if (/owner must be|needs|empty|too long/i.test(err.message)) return { error: err.message };
    throw err;
  });
}

module.exports = { KINDS, list, linkableActions, create };
