// Branch Scoreboard: every measure's week and month-to-date actual vs target, worked out with
// the calculation module (src/calc), plus running totals and branch sales.
// Every number can be traced back to the daily rows behind it (traceMeasure / traceSales /
// traceRunning).

const calc = require('../calc');
const { loadMeasures } = require('../daily/data');

// ─────────────── Weeks ───────────────

// Every week (Monday) from the tracker's first week to the current one.
function weekList(trackerStart, today) {
  const weeks = [];
  for (let w = calc.weekStart(trackerStart); w <= calc.weekStart(today); w = calc.addDays(w, 7)) weeks.push(w);
  return weeks;
}

// The last day included for a week. For a finished week: Sunday. For the current week:
// today once today's numbers are in, otherwise yesterday – so a branch isn't shown short
// for a day it hasn't closed yet.
async function countedThrough(db, branchId, weekStart, today) {
  const weekEnd = calc.addDays(weekStart, 6);
  if (weekEnd < today) return weekEnd;
  const { rows } = await db.query(
    'SELECT 1 FROM daily_entries WHERE branch_id = $1 AND entry_date = $2 LIMIT 1', [branchId, today]);
  return rows.length ? today : calc.addDays(today, -1);
}

// ─────────────── Which measures go at the top ───────────────

// The WIG(s) and the branch's lead measures go in bold at the top; everything else is
// grouped by the person who owns it.
function isTopMeasure(m, branch) {
  if (m.kind === 'WIG') return true;
  if (/\bLEAD \d/i.test(m.label)) return true;
  return m.kind === 'Lead' && [branch.lead1_field, branch.lead2_field].includes(m.numerator_field);
}

// ─────────────── Loading ───────────────

async function loadContext(db, branch) {
  const [measures, fields, people, running, monthTargets, baseline] = await Promise.all([
    loadMeasures(db, branch.id),
    db.query('SELECT key, label, type FROM daily_fields WHERE branch_id = $1', [branch.id]),
    db.query('SELECT id, name, role, sort_order FROM people WHERE branch_id = $1 AND active ORDER BY sort_order', [branch.id]),
    db.query('SELECT * FROM running_totals WHERE branch_id = $1 ORDER BY sort_order', [branch.id]),
    db.query('SELECT * FROM branch_month_targets WHERE branch_id = $1 ORDER BY month', [branch.id]),
    db.query('SELECT * FROM branch_baselines WHERE branch_id = $1', [branch.id]),
  ]);
  const months = monthTargets.rows;
  return {
    measures,
    fieldLabels: Object.fromEntries(fields.rows.map((f) => [f.key, f.label.replace(/\s*\(1\/0\)/, '')])),
    people: people.rows,
    running: running.rows,
    monthTargets: Object.fromEntries(months.map((r) => [r.month.trim(), r])),
    // The period ends with the last month that has a target (31 Dec 2026).
    periodEnd: months.length ? calc.monthEnd(months[months.length - 1].month.trim()) : null,
    baseline: baseline.rows[0] || null,
  };
}

async function loadEntries(db, branchId, from, to) {
  const { rows } = await db.query(
    'SELECT entry_date, field_key, value FROM daily_entries WHERE branch_id = $1 AND entry_date BETWEEN $2 AND $3',
    [branchId, from, to]
  );
  return calc.indexEntries(rows);
}

// ─────────────── Scoreboard ───────────────

async function buildScoreboard(db, { branch, weekStart, today, trackerStart }) {
  const weekEnd = calc.addDays(weekStart, 6);
  const asOf = await countedThrough(db, branch.id, weekStart, today);
  const month = calc.monthOf(asOf < weekStart ? weekStart : asOf);
  const mtdFrom = calc.monthStart(month);
  const ctx = await loadContext(db, branch);
  // One load covers the week, month-to-date and running totals (which start on 12 Oct).
  const windowStart = [mtdFrom, weekStart, trackerStart, ...ctx.running.map((r) => r.start_date)].sort()[0];
  const entries = await loadEntries(db, branch.id, windowStart, weekEnd);
  const started = asOf >= weekStart && asOf >= trackerStart;

  const rows = ctx.measures.map((m) => {
    let week = calc.evaluateMeasure({ measure: m, entries, from: weekStart, to: asOf, trackerStart });
    // Scored month to date only (e.g. JH zakat): the week shows its actual, no target or status.
    if (m.score_by === 'month') week = { ...week, target: null, pct: null, status: 'track_only' };
    const mtd = calc.evaluateMeasure({ measure: m, entries, from: mtdFrom, to: asOf, trackerStart });
    return {
      code: m.code, label: m.label, owner: m.owner_name, kind: m.kind, unit: m.unit, calc: m.calc,
      targetPer: m.target_per, note: m.note, top: isTopMeasure(m, branch),
      monthTarget: calc.monthTarget(m.targets, started ? asOf : weekStart),
      weekendTarget: calc.monthTarget(m.weekend_targets, started ? asOf : weekStart), highDays: m.high_days || null,
      money: m.unit === 'RM', week: strip(week), mtd: strip(mtd), scoreBy: m.score_by || 'week',
    };
  });

  // Top section keeps the seed order; the rest is grouped Team first, then people in order.
  const top = rows.filter((r) => r.top);
  const groups = [];
  const rest = rows.filter((r) => !r.top);
  const owners = ['Team', ...ctx.people.map((p) => p.name)];
  for (const owner of owners) {
    const list = rest.filter((r) => r.owner === owner);
    if (list.length) groups.push({ owner, role: owner === 'Team' ? 'Whole team' : ctx.people.find((p) => p.name === owner)?.role, rows: list });
  }
  const orphans = rest.filter((r) => !owners.includes(r.owner));
  if (orphans.length) groups.push({ owner: 'Other', role: '', rows: orphans });

  // Running totals as progress bars.
  const running = ctx.running.map((rt) => {
    const r = calc.runningTotal({
      entries, field: rt.field_key, startValue: rt.start_value, startDate: rt.start_date,
      endTarget: rt.end_target === null ? null : Number(rt.end_target),
      endDate: ctx.periodEnd || weekEnd, asOf: started ? asOf : calc.addDays(weekStart, -1),
    });
    return {
      code: rt.code, label: rt.label, field: rt.field_key, endDate: ctx.periodEnd,
      total: r.total, start: r.start, startMissing: r.startMissing, endTarget: r.endTarget,
      pctOfTarget: r.pctOfTarget, expectedByNow: r.expectedByNow, onPace: r.onPace,
      remaining: r.remaining, perDayNeeded: r.perDayNeeded,
    };
  });
  // Branch total sales: this week, and month-to-date vs the month target.
  const salesFields = branch.total_sales_fields || [];
  const weekSales = started
    ? calc.branchSales({ entries, fields: salesFields, from: weekStart < trackerStart ? trackerStart : weekStart, to: asOf }).total
    : 0;
  const mtd = calc.mtdSales({ entries, fields: salesFields, asOf: started ? asOf : calc.addDays(weekStart, -1), baseline: ctx.baseline });
  const monthTarget = ctx.monthTargets[month] ? Number(ctx.monthTargets[month].total_sales_target) : null;
  const need = started ? calc.requiredPerDay({ monthTarget, mtdActual: mtd.total, asOf }) : { perDay: null, daysLeft: null };
  // Colour by pace: 60% of the month's target after 18 of 31 days is ahead, not behind.
  const dayOfMonth = Number((started ? asOf : weekStart).slice(8));
  const paceTarget = monthTarget === null ? null : monthTarget * (dayOfMonth / calc.daysInMonth(month));
  const pacePct = calc.percentOf(mtd.total, paceTarget);
  const sales = {
    month, weekTotal: weekSales, mtd: mtd.total, beforeTracker: mtd.beforeTracker, monthTarget,
    pct: calc.percentOf(mtd.total, monthTarget), paceTarget, pacePct,
    perDay: need.perDay, daysLeft: need.daysLeft,
    status: started ? calc.statusFor(pacePct, { hasTarget: monthTarget !== null }) : 'no_data',
  };

  return { weekStart, weekEnd, asOf, started, month, mtdFrom, top, groups, running, sales };
}

// Keep only what the screen needs (drop the per-day rows – those come from the trace).
function strip(r) {
  return {
    actual: r.actual, target: r.target, pct: r.pct, status: r.status,
    numerator: r.numerator, denominator: r.denominator,
    daysCounted: r.daysCounted, daysEntered: r.daysEntered, partialTarget: r.partialTarget,
  };
}

// ─────────────── Traces: the daily rows behind a number ───────────────

async function whoEntered(db, branchId, fieldKeys, from, to) {
  if (!fieldKeys.length || from > to) return new Map();
  const { rows } = await db.query(
    `SELECT e.entry_date, e.field_key, e.updated_at, e.source,
            CASE WHEN e.source = 'sheet' THEN 'Sales sheet' ELSE u.display_name END AS display_name
     FROM daily_entries e LEFT JOIN users u ON u.id = e.entered_by
     WHERE e.branch_id = $1 AND e.field_key = ANY($2) AND e.entry_date BETWEEN $3 AND $4`,
    [branchId, fieldKeys, from, to]
  );
  return new Map(rows.map((r) => [`${r.entry_date}|${r.field_key}`, r]));
}

async function traceMeasure(db, { branch, code, from, to, trackerStart }) {
  const ctx = await loadContext(db, branch);
  const m = ctx.measures.find((x) => x.code === code);
  if (!m) return null;
  const entries = await loadEntries(db, branch.id, from, to);
  const result = calc.evaluateMeasure({ measure: m, entries, from, to, trackerStart });
  const fields = [m.numerator_field, m.denominator_field].filter(Boolean);
  const who = await whoEntered(db, branch.id, fields, from, to);

  const days = result.days.map((d) => {
    const w = who.get(`${d.date}|${m.numerator_field}`) || (m.denominator_field && who.get(`${d.date}|${m.denominator_field}`));
    const counted = m.calc !== 'ratio_per_day' || (d.denominator || 0) > 0;
    return {
      date: d.date, numerator: d.numerator, denominator: d.denominator, counted,
      target: m.calc === 'sum' ? calc.dailyTarget(m.targets, m.target_per, d.date, m.weekend_targets, m.high_days) : calc.monthTarget(m.targets, d.date),
      enteredBy: w ? w.display_name : null, updatedAt: w ? w.updated_at : null,
    };
  });
  return {
    kind: 'measure', code: m.code, label: m.label, calc: m.calc, money: m.unit === 'RM', unit: m.unit,
    targetPer: m.target_per,
    numeratorLabel: ctx.fieldLabels[m.numerator_field] || m.numerator_field,
    denominatorLabel: m.denominator_field ? ctx.fieldLabels[m.denominator_field] : null,
    from, to, days, result: strip(result),
  };
}

async function traceSales(db, { branch, from, to, trackerStart }) {
  const ctx = await loadContext(db, branch);
  const fields = branch.total_sales_fields || [];
  const start = from < trackerStart ? trackerStart : from;
  const entries = await loadEntries(db, branch.id, start, to);
  const sales = start <= to ? calc.branchSales({ entries, fields, from: start, to }) : { total: 0, days: [] };
  // The month the tracker started also includes the sales from before it.
  let before = 0;
  if (ctx.baseline && from <= ctx.baseline.baseline_end_date && calc.monthOf(from) === calc.monthOf(ctx.baseline.baseline_end_date)) {
    before = Number(ctx.baseline.sales_before_start) || 0;
  }
  return {
    kind: 'sales', label: 'Total branch sales', from, to, money: true,
    fields: fields.map((f) => ({ key: f, label: ctx.fieldLabels[f] || f })),
    days: sales.days, tracked: sales.total, before, total: sales.total + before,
    baselineEnd: before ? ctx.baseline.baseline_end_date : null,
  };
}

async function traceRunning(db, { branch, code, to }) {
  const ctx = await loadContext(db, branch);
  const rt = ctx.running.find((r) => r.code === code);
  if (!rt) return null;
  const end = ctx.periodEnd && ctx.periodEnd < to ? ctx.periodEnd : to;
  const entries = await loadEntries(db, branch.id, rt.start_date, end);
  const r = calc.runningTotal({
    entries, field: rt.field_key, startValue: rt.start_value, startDate: rt.start_date,
    endTarget: rt.end_target === null ? null : Number(rt.end_target), endDate: ctx.periodEnd || end, asOf: end,
  });
  const who = await whoEntered(db, branch.id, [rt.field_key], rt.start_date, end);
  let runningSum = r.start;
  const days = r.days.map((d) => {
    runningSum += d.value || 0;
    const w = who.get(`${d.date}|${rt.field_key}`);
    return { date: d.date, value: d.value, total: runningSum, enteredBy: w ? w.display_name : null };
  });
  return {
    kind: 'running', code: rt.code, label: rt.label, fieldLabel: ctx.fieldLabels[rt.field_key],
    from: rt.start_date, to: end, start: r.start, startMissing: r.startMissing, total: r.total,
    endTarget: r.endTarget, days,
  };
}

module.exports = { weekList, countedThrough, isTopMeasure, buildScoreboard, traceMeasure, traceSales, traceRunning };
