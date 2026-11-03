// 1 Nov 2026 (CEO): Monthly Performance Review. On the first Monday of each month the HQ WIG
// (10 am) and the managers' Monday update (4 pm) become a review of the month just ended and a
// plan for the next one. Spec: claude/monthly-review-spec.md in the P4U Dashboard project.
//
//   Branch review  – month sales vs target, each WIG / lead measure for the month (worked out
//                    from the daily entries, status ✔▲✕), zakat, the month's out-of-stock cases;
//                    next month's target and RM a day; can we hit it, plan, stop / start / keep,
//                    what we need from HQ; an improvement per measure.
//   HQ review      – per HQ person, each measure's weeks on track in the month, an improvement,
//                    next month's focus.
//   Conclusion     – the company's goals for the next month (seed company.month_goals), agreed by
//                    HQ and by the managers, locked by the CEO.

const calc = require('../calc');
const fmt = require('../scoreboard/format');
const { cleanText } = require('../weekly/access');
const { loadMeasures } = require('../daily/data');
const { isTopMeasure } = require('../scoreboard/data');
const { loadHqMeasures, loadHqEntries, show: hqShow } = require('../hq/data');
const { weekMonth } = require('../lib/weeks');
const { readSeed } = require('../db/seed');

const nextMonth = (m) => calc.monthOf(calc.addDays(calc.monthEnd(m), 1));
const prevMonth = (m) => calc.monthOf(calc.addDays(calc.monthStart(m), -1));
const MONTH_NAME = (m) => new Date(`${m}-01T00:00:00Z`).toLocaleDateString('en-GB', { timeZone: 'UTC', month: 'long', year: 'numeric' });

// The review month: the one before this month (on 2 Nov → October). Months to choose: from the
// tracker's first month to this month.
function reviewMonths(today, trackerStart) {
  const out = [];
  for (let m = calc.monthOf(trackerStart); m <= calc.monthOf(today); m = nextMonth(m)) out.push(m);
  return out;
}
const defaultMonth = (today, trackerStart) => {
  const p = prevMonth(calc.monthOf(today));
  return p >= calc.monthOf(trackerStart) ? p : calc.monthOf(today);
};

// First Monday of a month, and whether today is the review week (the 3 days before it up to it).
function firstMonday(month) {
  let d = calc.monthStart(month);
  while (new Date(`${d}T00:00:00Z`).getUTCDay() !== 1) d = calc.addDays(d, 1);
  return d;
}

const statusOf = (r) => r.status;
const STATUS_WORD = { on_track: 'On track', watch: 'Nearly', off_track: 'Off track', track_only: 'Tracked', no_data: 'No data' };

// ─────────────── Branch ───────────────

async function branchMonth(db, { branch, month, today, trackerStart }) {
  const from = [calc.monthStart(month), trackerStart].sort().pop();
  const lastDay = calc.addDays(today, -1);
  const to = [calc.monthEnd(month), lastDay < from ? from : lastDay].sort()[0];
  const measures = await loadMeasures(db, branch.id);
  const entries = calc.indexEntries((await db.query(
    'SELECT entry_date, field_key, value FROM daily_entries WHERE branch_id = $1 AND entry_date BETWEEN $2 AND $3',
    [branch.id, calc.monthStart(month), to])).rows);
  const branchQs = `&branch=${encodeURIComponent(branch.code)}`;
  const traceHref = (code) => `/scoreboard/trace?type=measure&code=${encodeURIComponent(code)}&from=${from}&to=${to}${branchQs}`;

  const isLead = (m) => isTopMeasure(m, branch) || ['WIG', 'Lead'].includes(m.kind);
  const rows = measures.filter(isLead).map((m) => {
    const r = calc.evaluateMeasure({ measure: m, entries, from, to, trackerStart });
    const shape = { calc: m.calc, money: m.unit === 'RM' };
    const kindLabel = /LEAD \d/.test(m.label) ? m.label.match(/LEAD \d/)[0].replace('LEAD', 'Lead') : m.kind;
    return {
      ref: `m:${m.id}`, code: m.code, kind: kindLabel, label: m.label, owner: m.owner_name,
      actual: fmt.value(shape, r.actual), target: r.target === null ? 'track only' : fmt.value(shape, r.target),
      pct: r.pct, status: statusOf(r), daysEntered: r.daysEntered, daysCounted: r.daysCounted, href: traceHref(m.code),
    };
  });
  const zakat = branch.zakat_field ? measures.filter((m) => m.numerator_field === branch.zakat_field && !isLead(m)).map((m) => {
    const r = calc.evaluateMeasure({ measure: m, entries, from, to, trackerStart });
    const shape = { calc: m.calc, money: m.unit === 'RM' };
    return { ref: `m:${m.id}`, code: m.code, kind: 'Zakat', label: m.label, owner: m.owner_name, actual: fmt.value(shape, r.actual),
      target: r.target === null ? 'track only' : fmt.value(shape, r.target), pct: r.pct, status: statusOf(r), href: traceHref(m.code) };
  }) : [];

  // Sales for the month (incl. the sales before the tracker, as the scoreboard does).
  const baseline = (await db.query('SELECT * FROM branch_baselines WHERE branch_id = $1', [branch.id])).rows[0] || null;
  const mtd = calc.mtdSales({ entries, fields: branch.total_sales_fields || [], asOf: to, baseline });
  const tgt = async (m) => {
    const r = (await db.query('SELECT total_sales_target FROM branch_month_targets WHERE branch_id = $1 AND month = $2', [branch.id, m])).rows[0];
    return r && r.total_sales_target !== null ? Number(r.total_sales_target) : null;
  };
  const monthTarget = await tgt(month);
  const nm = nextMonth(month);
  const nextTarget = await tgt(nm);
  const sales = {
    actual: mtd.total, target: monthTarget, pct: calc.percentOf(mtd.total, monthTarget), complete: to === calc.monthEnd(month),
    to, href: `/scoreboard/trace?type=sales&from=${calc.monthStart(month)}&to=${to}${branchQs}`,
  };
  sales.status = calc.statusFor(sales.pct, { hasTarget: monthTarget !== null });
  const next = {
    month: nm, name: MONTH_NAME(nm), target: nextTarget, perDay: nextTarget === null ? null : nextTarget / calc.daysInMonth(nm),
    vsLast: nextTarget === null ? null : nextTarget - mtd.total,
  };

  // Out of stock in the month: reported, closed, still open, closed within 3 days, open after 3 days.
  const mFrom = new Date(Date.parse(`${calc.monthStart(month)}T00:00:00Z`) - 8 * 3600e3);
  const mTo = new Date(Date.parse(`${calc.addDays(calc.monthEnd(month), 1)}T00:00:00Z`) - 8 * 3600e3);
  const items = (await db.query(
    `SELECT status, reported_at, received_at, cancelled_at, answered_at, customers_count, closed_by_hq
     FROM oos_items WHERE branch_id = $1 AND reported_at >= $2 AND reported_at < $3`, [branch.id, mFrom, mTo])).rows;
  const real = items.filter((i) => i.status !== 'Cancelled');
  const closedAt = (i) => i.received_at || (['Discontinued', 'Discontinued / use substitute'].includes(i.status) ? i.answered_at : null);
  const within3 = real.filter((i) => closedAt(i) && (new Date(closedAt(i)) - new Date(i.reported_at)) <= 3 * 86400e3).length;
  const openNow = real.filter((i) => ['Open', 'Ordered', 'On the way', 'Substitute offered'].includes(i.status)).length;
  const oos = {
    reported: real.length, within3, openNow, cancelled: items.length - real.length,
    customers: real.reduce((a, i) => a + (i.customers_count || 0), 0),
    over3Pct: real.length ? (real.length - within3) / real.length : null,
  };
  return { month, name: MONTH_NAME(month), from, to, rows, zakat, sales, next, oos };
}

// ─────────────── HQ ───────────────

async function hqMonth(db, { month, today, trackerStart = null }) {
  const weeks = [];
  for (let w = calc.weekStart(calc.monthStart(month)); w <= calc.monthEnd(month) && w <= calc.weekStart(today); w = calc.addDays(w, 7)) {
    if (weekMonth(w) === month && (!trackerStart || calc.addDays(w, 6) >= trackerStart)) weeks.push(w);
  }
  const [measures, entries] = await Promise.all([loadHqMeasures(db), weeks.length ? loadHqEntries(db, weeks[0], weeks.at(-1)) : new Map()]);
  const people = (await db.query('SELECT id, name, role, sort_order FROM people WHERE branch_id IS NULL AND active ORDER BY sort_order')).rows;
  const target = (m) => { const t = m.targets[month]; return t === null || t === undefined ? null : Number(t); };
  const rows = measures.map((m) => {
    const res = weeks.map((w) => {
      const e = entries.get(`${w}|${m.id}`);
      const ev = e ? calc.evaluateHq({ measure: m, entry: { value: e.value === null ? null : Number(e.value), total: e.total === null ? null : Number(e.total) }, target: target(m) }) : null;
      return { week: w, entry: e || null, ev };
    });
    const entered = res.filter((x) => x.entry && x.ev && x.ev.actual !== null && x.ev.actual !== undefined);
    const on = entered.filter((x) => x.ev.status === 'on_track').length;
    const last = entered.at(-1);
    const status = !entered.length ? 'no_data' : target(m) === null ? 'track_only'
      : on / entered.length >= 0.75 ? 'on_track' : on / entered.length >= 0.5 ? 'watch' : 'off_track';
    return {
      ref: `h:${m.id}`, code: m.code, label: m.label, owner: m.owner_name, person_id: m.person_id, kind: m.kind || 'Lead',
      target: target(m) === null ? 'track only' : hqShow(m, target(m)), last: last ? hqShow(m, last.ev.actual) : '–',
      weeksOn: on, weeksEntered: entered.length, weeks: weeks.length, status,
      perWeek: res.map((x) => ({ week: x.week, shown: x.ev && x.ev.actual !== null && x.ev.actual !== undefined ? hqShow(m, x.ev.actual) : null, status: x.ev ? x.ev.status : 'no_data' })),
    };
  });
  const groups = [];
  for (const p of people) {
    const list = rows.filter((r) => r.person_id === p.id || (!r.person_id && r.owner === p.name));
    if (list.length) groups.push({ person: p, rows: list });
  }
  const known = new Set(groups.flatMap((g) => g.rows.map((r) => r.ref)));
  const other = rows.filter((r) => !known.has(r.ref));
  return { month, name: MONTH_NAME(month), weeks, groups, other };
}

// ─────────────── Saved reviews ───────────────

async function loadReview(db, { scope, branchId = null, personId = null, month }) {
  const r = (await db.query(
    `SELECT r.*, u.display_name AS submitted_by_name FROM monthly_reviews r LEFT JOIN users u ON u.id = r.submitted_by
     WHERE r.scope = $1 AND r.month = $2 AND ${scope === 'branch' ? 'r.branch_id = $3' : 'r.person_id = $3'}`,
    [scope, month, scope === 'branch' ? branchId : personId])).rows[0] || null;
  const items = r ? Object.fromEntries((await db.query('SELECT measure_ref, improvement FROM monthly_review_items WHERE review_id = $1', [r.id])).rows.map((x) => [x.measure_ref, x.improvement])) : {};
  return { review: r, items };
}

const TEXT = { plan: 1000, stop: 500, start: 500, keep: 500, needs: 800, focus: 300 };

// body: { can_hit, plan, stop, start, keep, needs, focus, imp: { '<ref>': text }, submit: '1' }
async function saveReview(db, user, { scope, branchId = null, personId = null, month, refs, body, now }) {
  const errors = {};
  const vals = {};
  for (const [k, max] of Object.entries(TEXT)) {
    const c = cleanText(body[k], { max, label: k[0].toUpperCase() + k.slice(1) });
    if (c.error) errors[k] = c.error; else vals[k] = c.value;
  }
  const canHit = ['Yes', 'At risk', 'No'].includes(body.can_hit) ? body.can_hit : null;
  const imps = {};
  const posted = body.imp && typeof body.imp === 'object' ? body.imp : {};
  for (const ref of refs) {
    const key = ref.replace(':', '_');
    if (posted[key] === undefined) continue;
    const c = cleanText(posted[key], { max: 300, label: 'Improvement' });
    if (c.error) errors[`imp_${key}`] = c.error; else imps[ref] = c.value;
  }
  if (Object.keys(errors).length) return { errors };
  const at = now();
  const submit = body.submit === '1';
  await db.transaction(async (tx) => {
    let id = (await tx.query(
      `SELECT id FROM monthly_reviews WHERE scope = $1 AND month = $2 AND ${scope === 'branch' ? 'branch_id = $3' : 'person_id = $3'}`,
      [scope, month, scope === 'branch' ? branchId : personId])).rows[0]?.id;
    if (!id) {
      id = (await tx.query(`INSERT INTO monthly_reviews (scope, branch_id, person_id, month, updated_by, updated_at) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [scope, branchId, personId, month, user.id, at])).rows[0].id;
    }
    await tx.query(
      `UPDATE monthly_reviews SET can_hit = $2, plan = $3, stop = $4, start = $5, keep = $6, needs = $7, focus = $8, updated_at = $9, updated_by = $10,
         submitted_at = CASE WHEN $11 THEN COALESCE(submitted_at, $9) ELSE submitted_at END,
         submitted_by = CASE WHEN $11 THEN COALESCE(submitted_by, $10) ELSE submitted_by END WHERE id = $1`,
      [id, canHit, vals.plan, vals.stop, vals.start, vals.keep, vals.needs, vals.focus, at, user.id, submit]);
    for (const [ref, text] of Object.entries(imps)) {
      await tx.query(`INSERT INTO monthly_review_items (review_id, measure_ref, improvement) VALUES ($1, $2, $3)
        ON CONFLICT (review_id, measure_ref) DO UPDATE SET improvement = EXCLUDED.improvement`, [id, ref, text]);
    }
    await tx.query(`INSERT INTO audit_log (user_id, action, table_name, record_key, new_value) VALUES ($1, 'update', 'monthly_reviews', $2, $3)`,
      [user.id, `${scope} ${scope === 'branch' ? `branch ${branchId}` : `person ${personId}`} ${month}${submit ? ' submitted' : ''}`, JSON.stringify({ can_hit: canHit, ...vals, items: Object.keys(imps).length })]);
  });
  return { ok: true, submitted: submit };
}

// ─────────────── Conclusion (the next month's goals) ───────────────

async function loadGoals(db, month) {
  let goals = (await db.query(
    `SELECT g.*, h.display_name AS hq_by, m.display_name AS mgr_by FROM month_goals g
     LEFT JOIN users h ON h.id = g.hq_agreed_by LEFT JOIN users m ON m.id = g.mgr_agreed_by WHERE g.month = $1 ORDER BY g.slot`, [month])).rows;
  if (!goals.length) {
    const seeded = ((readSeed().company || {}).month_goals || {})[month];
    if (seeded && seeded.length) {
      for (const g of seeded) {
        await db.query(`INSERT INTO month_goals (month, slot, title, detail, owner, due, how_measured, metric) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING`,
          [month, g.slot, g.title, g.detail || null, g.owner || null, g.due || null, g.how_measured || null, g.metric || null]);
      }
      return loadGoals(db, month);
    }
  }
  const c = (await db.query(`SELECT c.*, u.display_name AS locked_by_name FROM month_conclusions c LEFT JOIN users u ON u.id = c.locked_by WHERE c.month = $1`, [month])).rows[0] || null;
  const both = goals.filter((g) => g.hq_agreed_at && g.mgr_agreed_at).length;
  return { month, reviewMonth: prevMonth(month), name: MONTH_NAME(month), goals, conclusion: c, locked: Boolean(c && c.locked_at), agreedBoth: both };
}

const canEditGoals = (u) => u.role === 'admin' || u.role === 'hq';
const canAgreeHq = (u) => u.role === 'admin' || u.role === 'hq' || u.role === 'hq_staff';
const canAgreeMgr = (u) => u.role === 'admin' || u.role === 'branch_manager';
const isCeo = (u) => u.role === 'admin' && Boolean(u.is_super);

// body: g[s<slot>][title|detail|owner|due|how], agree_hq[s<slot>] / agree_mgr[s<slot>] ('1'),
// new goal: g[new][title…], notes, lock ('1' / '0').
async function saveGoals(db, user, month, body, { now }) {
  const state = await loadGoals(db, month);
  if (state.locked && !isCeo(user)) return { error: 'The conclusion is locked by Dr Aisyah.' };
  const at = now();
  const g = body.g && typeof body.g === 'object' ? body.g : {};
  const errors = {};
  const clean = (v, max, label) => { const c = cleanText(v, { max, label }); if (c.error) { errors[label] = c.error; return undefined; } return c.value; };
  await db.transaction(async (tx) => {
    for (const goal of state.goals) {
      const p = g[`s${goal.slot}`];
      if (canEditGoals(user) && p && typeof p === 'object') {
        const title = clean(p.title, 160, 'Goal'); const detail = clean(p.detail, 600, 'Detail');
        const owner = clean(p.owner, 120, 'Owner'); const due = clean(p.due, 60, 'By when'); const how = clean(p.how, 300, 'How measured');
        if (title !== undefined && detail !== undefined && owner !== undefined && due !== undefined && how !== undefined) {
          await tx.query(`UPDATE month_goals SET title = COALESCE($2, title), detail = $3, owner = $4, due = $5, how_measured = $6, updated_at = $7 WHERE id = $1`,
            [goal.id, title, detail, owner, due, how, at]);
        }
      }
      const last = (v) => (Array.isArray(v) ? v[v.length - 1] : v); // hidden '0' + checkbox '1'
      const ah = Boolean(body.agree_hq) && last(body.agree_hq[`s${goal.slot}`]) === '1';
      const am = Boolean(body.agree_mgr) && last(body.agree_mgr[`s${goal.slot}`]) === '1';
      if (canAgreeHq(user) && body.agree_hq) {
        await tx.query(`UPDATE month_goals SET hq_agreed_at = CASE WHEN $2 THEN COALESCE(hq_agreed_at, $3) END, hq_agreed_by = CASE WHEN $2 THEN COALESCE(hq_agreed_by, $4) END WHERE id = $1`, [goal.id, ah, at, user.id]);
      }
      if (canAgreeMgr(user) && body.agree_mgr) {
        await tx.query(`UPDATE month_goals SET mgr_agreed_at = CASE WHEN $2 THEN COALESCE(mgr_agreed_at, $3) END, mgr_agreed_by = CASE WHEN $2 THEN COALESCE(mgr_agreed_by, $4) END WHERE id = $1`, [goal.id, am, at, user.id]);
      }
    }
    if (canEditGoals(user) && g.new && typeof g.new === 'object' && String(g.new.title || '').trim()) {
      const title = clean(g.new.title, 160, 'Goal');
      if (title) {
        const slot = (await tx.query('SELECT COALESCE(max(slot), 0) + 1 AS n FROM month_goals WHERE month = $1', [month])).rows[0].n;
        await tx.query(`INSERT INTO month_goals (month, slot, title, detail, owner, due, how_measured) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [month, slot, title, clean(g.new.detail, 600, 'Detail') || null, clean(g.new.owner, 120, 'Owner') || null, clean(g.new.due, 60, 'By when') || null, clean(g.new.how, 300, 'How measured') || null]);
      }
    }
    if (body.notes !== undefined && canEditGoals(user)) {
      const notes = clean(body.notes, 2000, 'Other decisions');
      if (notes !== undefined) {
        await tx.query(`INSERT INTO month_conclusions (month, notes) VALUES ($1, $2) ON CONFLICT (month) DO UPDATE SET notes = EXCLUDED.notes`, [month, notes]);
      }
    }
    if (isCeo(user) && (body.lock === '1' || body.lock === '0')) {
      await tx.query(`INSERT INTO month_conclusions (month, locked_at, locked_by) VALUES ($1, $2, $3)
        ON CONFLICT (month) DO UPDATE SET locked_at = EXCLUDED.locked_at, locked_by = EXCLUDED.locked_by`,
        [month, body.lock === '1' ? at : null, body.lock === '1' ? user.id : null]);
    }
    await tx.query(`INSERT INTO audit_log (user_id, action, table_name, record_key, new_value) VALUES ($1, 'update', 'month_goals', $2, NULL)`,
      [user.id, `${month} conclusion${body.lock === '1' ? ' locked' : body.lock === '0' ? ' unlocked' : ''}`]);
  });
  if (Object.keys(errors).length) return { error: Object.values(errors)[0] };
  return { ok: true };
}

// Who still has to fill in their review for `month` (for Needs you and the review pages).
// The goals for the month `today` is in (shown on My page, HQ day, the branch WIG), or null.
async function currentGoals(db, today) {
  const g = await loadGoals(db, calc.monthOf(today));
  return g.goals.length ? g : null;
}

async function reviewStatus(db, month) {
  const branches = (await db.query(
    `SELECT b.id, b.code, b.name, r.submitted_at FROM branches b LEFT JOIN monthly_reviews r ON r.branch_id = b.id AND r.scope = 'branch' AND r.month = $1
     WHERE b.active ORDER BY b.sort_order`, [month])).rows;
  return { branches };
}

module.exports = {
  MONTH_NAME, STATUS_WORD, nextMonth, prevMonth, reviewMonths, defaultMonth, firstMonday,
  branchMonth, hqMonth, loadReview, currentGoals, saveReview, loadGoals, saveGoals, reviewStatus,
  canEditGoals, canAgreeHq, canAgreeMgr, isCeo,
};

// ─────────────── Linked to the weekly WIG (3 Nov, CEO: "so they don't have to do it twice") ───────────────
// The review of `month` happens on the first Monday of the next month, in place of that Monday's
// HQ WIG and managers' update. The update it replaces is for the week just ended:
const linkedWeek = (month) => calc.addDays(firstMonday(nextMonth(month)), -7);

// Branch: last week's numbers typed on the review page go into that week's weekly update
// (weekly_checkins – the stock / SKU / zakat boxes), and "what we need from HQ" becomes an HQ
// action for that week (owner and date agreed at the 4 pm meeting), kept in step on every save.
async function linkBranchWeekly(db, user, { branch, month, body, today }) {
  const week = linkedWeek(month);
  const { editDenied } = require('../weekly/access');
  if (editDenied(user, branch, week, today)) return { skipped: true };
  const weekly = require('../weekly/data');
  const nums = {};
  for (const n of weekly.NUMBERS.filter((x) => !x.zakat || branch.zakat_field)) if (body[n.key] !== undefined) nums[n.key] = body[n.key];
  const r = Object.keys(nums).length ? await weekly.saveCheckin(db, user, branch, week, nums) : { saved: 0 };
  if (r.errors) return { errors: r.errors };
  const rev = (await db.query("SELECT id, needs, hq_action_id FROM monthly_reviews WHERE scope = 'branch' AND branch_id = $1 AND month = $2", [branch.id, month])).rows[0];
  if (!rev) return { saved: r.saved };
  const act = rev.hq_action_id ? (await db.query('SELECT * FROM hq_actions WHERE id = $1', [rev.hq_action_id])).rows[0] : null;
  const issue = rev.needs ? rev.needs.slice(0, 300) : null;
  await db.transaction(async (tx) => {
    if (issue && !act) {
      const id = (await tx.query(
        'INSERT INTO hq_actions (branch_id, week_start, issue, raised_by, updated_by) VALUES ($1, $2, $3, $4, $4) RETURNING id',
        [branch.id, week, issue, user.id])).rows[0].id;
      await tx.query('UPDATE monthly_reviews SET hq_action_id = $2 WHERE id = $1', [rev.id, id]);
    } else if (issue && act && !act.agreed && act.issue !== issue) {
      await tx.query('UPDATE hq_actions SET issue = $2, updated_by = $3, updated_at = now() WHERE id = $1', [act.id, issue, user.id]);
    } else if (!issue && act && !act.agreed) {
      await tx.query('UPDATE monthly_reviews SET hq_action_id = NULL WHERE id = $1', [rev.id]);
      await tx.query('DELETE FROM hq_actions WHERE id = $1', [act.id]);
    }
    const asks = (await tx.query('SELECT issue FROM hq_actions WHERE branch_id = $1 AND week_start = $2 ORDER BY id', [branch.id, week])).rows.map((x) => x.issue);
    await tx.query(
      `INSERT INTO weekly_checkins (branch_id, week_start, issue_needing_hq_help, submitted_by) VALUES ($1, $2, $3, $4)
       ON CONFLICT (branch_id, week_start) DO UPDATE SET issue_needing_hq_help = EXCLUDED.issue_needing_hq_help, updated_at = now()`,
      [branch.id, week, asks.join(' · ').slice(0, 500) || null, user.id]);
  });
  return { saved: r.saved };
}

async function loadLinkedCheckin(db, branch, month) {
  const weekly = require('../weekly/data');
  const week = linkedWeek(month);
  return { week, checkin: await weekly.loadCheckin(db, branch.id, week), numbers: weekly.NUMBERS.filter((x) => !x.zakat || branch.zakat_field) };
}

// HQ: the focus for next month written in the HQ review is also that Monday's HQ WIG focus
// (proposed, the CEO approves it as usual) – only when the person has no focus for that week yet.
async function linkHqFocus(db, user, { personId, month }) {
  const rev = (await db.query("SELECT focus FROM monthly_reviews WHERE scope = 'hq' AND person_id = $1 AND month = $2", [personId, month])).rows[0];
  if (!rev || !rev.focus) return;
  const week = firstMonday(nextMonth(month));
  const has = (await db.query('SELECT 1 FROM hq_focus WHERE week_start = $1 AND person_id = $2', [week, personId])).rows.length;
  if (has) return;
  await db.query(`INSERT INTO hq_focus (week_start, person_id, focus, status, proposed_by, slot) VALUES ($1, $2, $3, 'proposed', $4, 1)`,
    [week, personId, rev.focus, user.id]);
}

Object.assign(module.exports, { linkedWeek, linkBranchWeekly, loadLinkedCheckin, linkHqFocus });
