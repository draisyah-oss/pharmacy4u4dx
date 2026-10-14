// Group scoreboard (managers' Monday session): one row per branch for a week, the company
// total, the week's wins and issues, and 12-week trend grids. Every number comes from the
// branch scoreboard or the branch's weekly check-in, so it traces back the same way.

const calc = require('../calc');
const { loadMeasures } = require('../daily/data');
const { buildScoreboard } = require('../scoreboard/data');
const { loadCheckin, turnoverFor, OOS_OPEN } = require('../weekly/data');
const { trendWeeks } = require('../lib/weeks');

// The branch's walk-in measure and its two lead measures (from lead1_field / lead2_field).
function keyMeasures(branch, measures) {
  const find = (field, kind) => measures.find((m) => m.numerator_field === field && m.kind === kind)
    || measures.find((m) => m.numerator_field === field);
  return {
    walk: find('walkin', 'WIG'),
    lead1: branch.lead1_field ? find(branch.lead1_field, 'Lead') : null,
    lead2: branch.lead2_field ? find(branch.lead2_field, 'Lead') : null,
  };
}

async function openOos(db, branchId, week) {
  const { rows } = await db.query(
    'SELECT count(*)::int AS n FROM oos_items WHERE branch_id = $1 AND week_start <= $2 AND status = ANY($3)',
    [branchId, week, OOS_OPEN]);
  return rows[0].n;
}

async function branchWeek(db, { branch, measures, week, today, trackerStart }) {
  const [board, checkin, oos] = await Promise.all([
    buildScoreboard(db, { branch, weekStart: week, today, trackerStart }),
    loadCheckin(db, branch.id, week),
    openOos(db, branch.id, week),
  ]);
  const rows = new Map([...board.top, ...board.groups.flatMap((g) => g.rows)].map((r) => [r.code, r]));
  const km = keyMeasures(branch, measures);
  const pick = (m) => {
    const r = m && rows.get(m.code);
    return r ? { code: r.code, label: r.label, calc: r.calc, money: r.money, ...r.week } : null;
  };
  const turnover = turnoverFor(checkin, branch);
  return {
    code: branch.code, name: branch.name, week, asOf: board.asOf, started: board.started, mtdFrom: board.mtdFrom,
    sales: board.sales, walk: pick(km.walk), lead1: pick(km.lead1), lead2: pick(km.lead2),
    turnover, stock: checkin ? {
      cogs: checkin.weekly_cogs === null ? null : Number(checkin.weekly_cogs),
      avg: turnover.averageStock,
    } : null,
    turnTarget: branch.stock_turnover_target_per_week === null ? null : Number(branch.stock_turnover_target_per_week),
    oos, hasZakat: Boolean(branch.zakat_field),
    zakatPending: branch.zakat_field && checkin && checkin.zakat_claims_pending !== null ? Number(checkin.zakat_claims_pending) : null,
    win: checkin ? checkin.win_this_week : null, issue: checkin ? checkin.issue_needing_hq_help : null,
    checkedIn: Boolean(checkin),
  };
}

function companyTotal(rows) {
  const sum = (f) => rows.reduce((a, r) => { const v = f(r); return v === null || v === undefined ? a : a + v; }, 0);
  const any = (f) => rows.some((r) => f(r) !== null && f(r) !== undefined);
  const mtd = sum((r) => r.sales.mtd);
  const monthTarget = any((r) => r.sales.monthTarget) ? sum((r) => r.sales.monthTarget) : null;
  const walkActual = sum((r) => (r.walk ? r.walk.actual : null));
  const walkTarget = any((r) => r.walk && r.walk.target) ? sum((r) => (r.walk ? r.walk.target : null)) : null;
  const withStock = rows.filter((r) => r.stock && r.stock.cogs !== null && r.stock.avg);
  const cogs = withStock.reduce((a, r) => a + r.stock.cogs, 0);
  const avg = withStock.reduce((a, r) => a + r.stock.avg, 0);
  const turnover = avg > 0 ? cogs / avg : null;
  // Company target: the branches' own weekly targets (all 0.23 today), averaged.
  const targets = withStock.map((r) => r.turnTarget).filter((t) => t !== null);
  const turnTarget = targets.length ? targets.reduce((a, t) => a + t, 0) / targets.length : null;
  const turnPct = calc.percentOf(turnover, turnTarget);
  const salesPct = calc.percentOf(mtd, monthTarget);
  const paceTarget = any((r) => r.sales.paceTarget) ? sum((r) => r.sales.paceTarget) : null;
  const pacePct = calc.percentOf(mtd, paceTarget);
  return {
    mtd, monthTarget, salesPct, pacePct, salesStatus: calc.statusFor(pacePct, { hasTarget: monthTarget !== null }),
    perDay: any((r) => r.sales.perDay) ? sum((r) => r.sales.perDay) : null,
    weekSales: sum((r) => r.sales.weekTotal),
    walkPct: calc.percentOf(walkActual, walkTarget),
    walkStatus: calc.statusFor(calc.percentOf(walkActual, walkTarget), { hasTarget: walkTarget !== null }),
    turnover, turnTarget, turnoverStatus: turnover === null ? 'no_data' : calc.statusFor(turnPct, { hasTarget: turnTarget !== null }), turnoverBranches: withStock.length,
    oos: sum((r) => r.oos),
    zakatPending: any((r) => r.zakatPending) ? sum((r) => r.zakatPending) : null,
  };
}

async function buildGroup(db, { week, today, trackerStart }) {
  const branches = (await db.query('SELECT * FROM branches WHERE active ORDER BY sort_order')).rows;
  const measuresBy = new Map(await Promise.all(branches.map(async (b) => [b.id, await loadMeasures(db, b.id)])));

  const rows = [];
  for (const b of branches) rows.push(await branchWeek(db, { branch: b, measures: measuresBy.get(b.id), week, today, trackerStart }));

  // 12-week trends: walk-in %, Lead 1 %, Lead 2 %, stock turnover per branch per week.
  const weeks = trendWeeks(trackerStart, week, 12);
  const trend = [];
  for (const b of branches) {
    const cells = [];
    for (const w of weeks) {
      cells.push(w === week ? rows.find((r) => r.code === b.code)
        : await branchWeek(db, { branch: b, measures: measuresBy.get(b.id), week: w, today, trackerStart }));
    }
    trend.push({ code: b.code, name: b.name, cells });
  }

  return {
    week, weekEnd: calc.addDays(week, 6), rows, total: companyTotal(rows), weeks, trend,
    wins: rows.filter((r) => r.win).map((r) => ({ code: r.code, name: r.name, text: r.win })),
    issues: rows.filter((r) => r.issue).map((r) => ({ code: r.code, name: r.name, text: r.issue })),
  };
}

module.exports = { buildGroup, branchWeek, companyTotal, keyMeasures };
