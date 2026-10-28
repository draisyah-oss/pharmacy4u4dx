// "Needs you" (19 Oct): the top of the side menu shows what this person has to do now, with a
// count – late (red), due today (amber), to do (blue) – instead of fixed shortcut tiles. A line
// only appears while there is something to do; with nothing, one "All clear" line. Each line opens
// the page where it gets done. Up to 5 lines, most urgent first.

const calc = require('../calc');

const LEVEL_ORDER = { late: 0, today: 1, todo: 2 };
const MAX = 5;
const isWeekday = (date) => { const d = new Date(`${date}T00:00:00Z`).getUTCDay(); return d >= 1 && d <= 5; };
const dow = (date) => new Date(`${date}T00:00:00Z`).getUTCDay(); // 0 Sun … 6 Sat
const one = async (db, sql, args) => Number((await db.query(sql, args)).rows[0].n) || 0;

async function forInventory(db, at, add) {
  const overdue = await one(db, "SELECT count(*) AS n FROM oos_items WHERE status = 'Open' AND answer IS NULL AND answer_due < $1", [at]);
  const toAnswer = await one(db, "SELECT count(*) AS n FROM oos_items WHERE status = 'Open' AND answer IS NULL AND (answer_due IS NULL OR answer_due >= $1)", [at]);
  const total = overdue + toAnswer;
  if (overdue) add('late', overdue, 'Out-of-stock reports overdue', `past the 11 am deadline · of ${total} open`, '/oos/inbox');
  if (toAnswer) add('today', toAnswer, 'Out-of-stock reports to answer', 'by 11 am the next working day', '/oos/inbox');
  const xLate = await one(db, `SELECT count(*) AS n FROM oos_items WHERE answer IN ('hq_deliver', 'transfer') AND sent_at IS NULL
    AND status = 'On the way' AND answered_at < $1::timestamptz - interval '24 hours'`, [at]);
  const xTodo = await one(db, `SELECT count(*) AS n FROM oos_items WHERE answer IN ('hq_deliver', 'transfer') AND sent_at IS NULL
    AND status = 'On the way' AND answered_at >= $1::timestamptz - interval '24 hours'`, [at]);
  if (xLate) add('late', xLate, 'Deliveries late', 'not sent within 24 hours', '/oos/transfers');
  if (xTodo) add('today', xTodo, 'Deliveries to send', 'HQ deliveries and transfers, within 24 hours', '/oos/transfers');
}

async function forInventoryChat(db, add) {
  const chat = require('../oos/chat');
  const w = await chat.waitingCounts(db, { forHq: true });
  if (w.oos) add('today', w.oos, 'Branches replied', 'out-of-stock questions & photos', '/oos/inbox?tab=waiting');
  const fresh = await one(db, "SELECT count(*) AS n FROM item_requests WHERE status = 'New'", []);
  if (fresh || w.req) add('todo', fresh + w.req, 'New item requests', fresh ? `${fresh} new${w.req ? ` · ${w.req} replied` : ''}` : 'branches replied', '/oos/inbox?tab=new');
}

async function forHqPerson(db, user, today, add) {
  const pid = user.person_id;
  const acts = (await db.query(`SELECT a.due_date, a.issue, b.code FROM hq_actions a LEFT JOIN branches b ON b.id = a.branch_id
    WHERE a.owner_person_id = $1 AND a.status = 'Open' AND a.agreed`, [pid])).rows;
  const late = acts.filter((a) => a.due_date && a.due_date < today);
  const due = acts.filter((a) => a.due_date === today);
  const rest = acts.length - late.length - due.length;
  if (late.length) add('late', late.length, 'Branch actions overdue', late.slice(0, 2).map((a) => `${a.code || 'HQ'} – ${a.issue}`).join(' · '), '/hq/today');
  if (due.length) add('today', due.length, 'Branch actions due today', due.slice(0, 2).map((a) => `${a.code || 'HQ'} – ${a.issue}`).join(' · '), '/hq/today');
  if (rest) add('todo', rest, 'Branch actions open', 'agreed at the Monday meeting', '/hq/today');
  if (isWeekday(today)) {
    const left = await one(db, `SELECT count(*) AS n FROM hq_daily_tasks t
      WHERE t.person_id = $1 AND t.active AND NOT EXISTS (SELECT 1 FROM hq_daily_ticks k WHERE k.task_id = t.id AND k.entry_date = $2)`, [pid, today]);
    if (left) add('todo', left, 'Daily tasks to tick', 'by 11 am', '/hq/today');
  }
  // Wiki: pages waiting for the approver; the owner's pages past their date.
  const approver = (await db.query(`SELECT p.id FROM people p JOIN app_settings s ON s.key = 'wiki_approver'
    WHERE p.branch_id IS NULL AND p.active AND to_jsonb(p.name)::text = s.value`)).rows[0];
  if (approver && approver.id === pid) {
    const n = await one(db, "SELECT count(*) AS n FROM hq_wiki_items WHERE status = 'Checking'", []);
    if (n) add('today', n, 'Wiki pages waiting for your approval', 'sent by Iman', '/hq/wiki?show=open');
  }
  const wikiLate = await one(db, "SELECT count(*) AS n FROM hq_wiki_items WHERE person_id = $1 AND status <> 'Approved' AND due_date < $2", [pid, today]);
  if (wikiLate) add('late', wikiLate, 'Wiki pages past their date', 'your checklist pages', '/hq/wiki?show=mine');
  // Project steps (19 Oct) named on this person (or on a milestone they own when the step has no owner).
  const team = require('../hq/team');
  const steps = (await db.query(`SELECT s.project_id, s.step, s.owner, s.due_date, p.owner AS project_owner
    FROM hq_project_steps s JOIN hq_projects p ON p.id = s.project_id
    WHERE s.active AND p.active AND s.status <> 'Done' AND s.due_date <= $1`, [today])).rows
    .filter((s) => team.ownsStep({ owner: s.owner || s.project_owner }, user.display_name));
  const stepsLate = steps.filter((s) => s.due_date < today);
  const stepsToday = steps.filter((s) => s.due_date === today);
  if (stepsLate.length) add('late', stepsLate.length, 'Project steps overdue', stepsLate.slice(0, 2).map((s) => s.step).join(' · '), `/hq/projects/${stepsLate[0].project_id}/steps`);
  if (stepsToday.length) add('today', stepsToday.length, 'Project steps due today', stepsToday.slice(0, 2).map((s) => s.step).join(' · '), `/hq/projects/${stepsToday[0].project_id}/steps`);
}

async function forCeo(db, today, add) {
  const week = calc.weekStart(today);
  const prev = calc.addDays(week, -7);
  const proposed = (await db.query(`SELECT p.name FROM hq_focus f JOIN people p ON p.id = f.person_id
    WHERE f.week_start = $1 AND f.status = 'proposed' ORDER BY p.sort_order`, [week])).rows.map((r) => r.name);
  if (proposed.length) add('today', proposed.length, 'Focuses waiting for your approval', [...new Set(proposed)].join(', '), '/hq/commitments');
  const late = (await db.query(`SELECT p.name FROM hq_actions a LEFT JOIN people p ON p.id = a.owner_person_id
    WHERE a.status = 'Open' AND a.due_date < $1`, [today])).rows;
  if (late.length) {
    const by = {}; for (const r of late) by[r.name || 'No owner'] = (by[r.name || 'No owner'] || 0) + 1;
    add('late', late.length, 'Branch actions overdue', Object.entries(by).map(([k, v]) => `${k} ${v}`).join(' · '), '/hq/update');
  }
  if (dow(today) === 1 || dow(today) === 2) {
    const missing = (await db.query(`SELECT b.code FROM branches b WHERE b.active AND NOT EXISTS
      (SELECT 1 FROM weekly_checkins c WHERE c.branch_id = b.id AND c.week_start = $1) ORDER BY b.sort_order`, [prev])).rows.map((r) => r.code);
    if (missing.length) add(dow(today) === 1 ? 'todo' : 'late', missing.length, 'Branch updates not sent', `${missing.join(', ')} · meeting Monday 4 pm`, `/hq/update?week=${prev}`);
  }
}

async function forBranch(db, user, today, at, add) {
  const branchId = user.branch_id;
  const week = calc.weekStart(today);
  const prev = calc.addDays(week, -7);
  const yesterday = calc.addDays(today, -1);
  const entered = await one(db, 'SELECT count(*) AS n FROM daily_entries WHERE branch_id = $1 AND entry_date = $2', [branchId, yesterday]);
  if (!entered) add('today', 1, 'Yesterday’s numbers not entered', fmtDay(yesterday), `/daily?date=${yesterday}`);
  // 27 Oct: Inventory asked a question about one of our items / requests.
  // Staff: only items they reported; the manager: the whole branch.
  const w = await require('../oos/chat').waitingCounts(db, { branchId, reportedBy: user.role === 'branch_staff' ? user.id : null });
  if (w.oos) add('today', w.oos, 'Inventory asked you to clarify an item', 'out of stock – reply or send a photo', '/oos');
  if (w.req) add('today', w.req, 'Inventory asked about a new item', 'reply or send a photo', '/oos/new-items');
  if (user.role === 'branch_manager') {
    const sent = await one(db, 'SELECT count(*) AS n FROM weekly_checkins WHERE branch_id = $1 AND week_start = $2', [branchId, prev]);
    if (!sent && dow(today) >= 1 && dow(today) <= 2) {
      add(dow(today) === 1 ? 'today' : 'late', 1, 'Weekly update to HQ', dow(today) === 1 ? 'due today, 4 pm meeting' : 'not sent – the meeting was Monday', `/weekly?week=${prev}`);
    }
    const lateOos = await one(db, `SELECT count(*) AS n FROM oos_items WHERE branch_id = $1 AND status IN ('Open', 'Ordered', 'On the way', 'Substitute offered')
      AND ((expected_back IS NOT NULL AND expected_back < $2) OR (answer IS NULL AND answer_due < $3))`, [branchId, today, at]);
    if (lateOos) add('late', lateOos, 'Out-of-stock items late', 'tell Inventory', '/oos');
    const held = await one(db, 'SELECT count(*) AS n FROM branch_wig_sessions WHERE branch_id = $1 AND week_start = $2 AND held_on IS NOT NULL', [branchId, week]);
    if (!held && dow(today) === 2) add('today', 1, 'Branch WIG session today', 'scoreboard → account → plan', '/commitments');
    if (!held && (dow(today) >= 3 || dow(today) === 0)) add('late', 1, 'Branch WIG session not marked held', 'this week', '/commitments');
    if (dow(today) >= 1 && dow(today) <= 3) {
      const without = await one(db, `SELECT count(*) AS n FROM people p WHERE p.branch_id = $1 AND p.active
        AND NOT EXISTS (SELECT 1 FROM commitments c WHERE c.person_id = p.id AND c.week_start = $2)`, [branchId, week]);
      if (without) add('todo', without, 'Staff without a commitment', 'for this week’s WIG', '/commitments');
    }
  } else if (user.person_id) {
    const mine = await one(db, 'SELECT count(*) AS n FROM commitments WHERE person_id = $1 AND week_start = $2', [user.person_id, week]);
    if (!mine) add('todo', 1, 'My commitment this week', 'write it, or your manager does at Tuesday’s WIG', '/my-week');
  }
}

function fmtDay(date) {
  return new Date(`${date}T00:00:00Z`).toLocaleDateString('en-GB', { timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short' });
}

async function buildNeeds(db, user, { at }) {
  const today = calc.todayInMalaysia(at);
  const items = [];
  const add = (level, count, title, sub, href) => items.push({ level, count, title, sub, href });
  if (user.role === 'admin' || user.inventory) {
    if (user.inventory && !user.oosQuiet) await forInventory(db, at, add);
    // 27 Oct: branch replies to Inventory's questions and new item requests – for the whole
    // inventory team (Alia too: she asks the questions).
    if (user.inventory) await forInventoryChat(db, add);
  }
  if (user.role === 'admin' && user.is_super) await forCeo(db, today, add);
  if ((user.role === 'hq' || user.role === 'hq_staff') && user.person_id) await forHqPerson(db, user, today, add);
  if ((user.role === 'branch_manager' || user.role === 'branch_staff') && user.branch_id) await forBranch(db, user, today, at, add);
  // 28 Oct: change requests – the CEO approves, other admins see new ones, the asker checks previews.
  const cr = await db.query(`SELECT count(*) FILTER (WHERE status = 'Waiting for approval')::int AS approval,
      count(*) FILTER (WHERE status = 'New')::int AS fresh,
      count(*) FILTER (WHERE status = 'Ready to check' AND created_by = $1)::int AS mine FROM change_requests`, [user.id]);
  const c = cr.rows[0];
  if (user.role === 'admin' && user.is_super && c.approval) add('today', c.approval, 'App changes waiting for your approval', 'checked by the person who asked', '/requests');
  if (user.role === 'admin' && !user.is_super && c.fresh) add('todo', c.fresh, 'New app change requests', 'Request a change', '/requests');
  if (c.mine) add('today', c.mine, 'Check a preview of your app change', 'looks right? / not right yet', '/requests');
  items.sort((a, b) => LEVEL_ORDER[a.level] - LEVEL_ORDER[b.level]);
  return { items: items.slice(0, MAX), more: Math.max(0, items.length - MAX) };
}

module.exports = { buildNeeds };
