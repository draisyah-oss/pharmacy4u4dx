// Admin → Targets: every measure's target per month (plus weekend targets for daily
// measures), branch month totals, running totals, and HQ measure targets.

const { audit, parseOptional, num, sameNumber } = require('./common');

// Percent measures are typed as 45 (%) and stored as 0.45.
const isPercent = (m) => m.calc === 'ratio_percent';
const hqIsPercent = (m) => m.unit === '%';
const toShown = (v, pct) => (v === null ? '' : String(Math.round((pct ? v * 100 : v) * 10000) / 10000));

async function loadBranchTargets(db, branch) {
  const months = (await db.query(
    'SELECT DISTINCT month FROM branch_month_targets WHERE branch_id = $1 UNION SELECT DISTINCT t.month FROM measure_targets t JOIN measures m ON m.id = t.measure_id WHERE m.branch_id = $1 ORDER BY 1',
    [branch.id])).rows.map((r) => r.month.trim());
  const measures = (await db.query(
    'SELECT * FROM measures WHERE branch_id = $1 ORDER BY active DESC, sort_order', [branch.id])).rows;
  const targets = (await db.query(
    'SELECT t.* FROM measure_targets t JOIN measures m ON m.id = t.measure_id WHERE m.branch_id = $1', [branch.id])).rows;
  const byMeasure = {};
  for (const t of targets) {
    byMeasure[t.measure_id] = byMeasure[t.measure_id] || {};
    byMeasure[t.measure_id][t.month.trim()] = { target: num(t.target), weekend: num(t.weekend_target) };
  }
  const totals = Object.fromEntries((await db.query(
    'SELECT * FROM branch_month_targets WHERE branch_id = $1', [branch.id])).rows
    .map((r) => [r.month.trim(), { total: num(r.total_sales_target), ytd: num(r.ytd_target_month_end) }]));
  const running = (await db.query('SELECT * FROM running_totals WHERE branch_id = $1 ORDER BY sort_order', [branch.id])).rows;
  return {
    months,
    measures: measures.map((m) => ({
      ...m, pct: isPercent(m), daily: m.target_per === 'day' && m.calc === 'sum',
      cells: Object.fromEntries(months.map((mo) => {
        const c = (byMeasure[m.id] || {})[mo] || { target: null, weekend: null };
        return [mo, { target: toShown(c.target, isPercent(m)), weekend: toShown(c.weekend, false) }];
      })),
    })),
    totals, running,
  };
}

async function loadHqTargets(db) {
  const months = (await db.query('SELECT DISTINCT month FROM hq_measure_targets ORDER BY 1')).rows.map((r) => r.month.trim());
  const measures = (await db.query('SELECT * FROM hq_measures ORDER BY active DESC, sort_order')).rows;
  const targets = (await db.query('SELECT * FROM hq_measure_targets')).rows;
  const company = Object.fromEntries((await db.query('SELECT month, total_sales_target FROM company_month_targets')).rows
    .map((r) => [r.month.trim(), num(r.total_sales_target)]));
  return {
    months, company,
    measures: measures.map((m) => ({
      ...m, pct: hqIsPercent(m),
      cells: Object.fromEntries(months.map((mo) => {
        const t = targets.find((x) => x.hq_measure_id === m.id && x.month.trim() === mo);
        return [mo, { target: toShown(t ? num(t.target) : null, hqIsPercent(m)) }];
      })),
    })),
  };
}

// body: t[m<measureId>][month], w[m<measureId>][month], bt[month][total|ytd], rt[r<id>][start|end]
// (ids get a letter in front: the form parser turns small number keys into lists and loses them)
async function saveBranchTargets(db, { branch, body, user }) {
  const errors = [];
  let changes = 0;
  const current = await loadBranchTargets(db, branch);

  await db.transaction(async (tx) => {
    for (const m of current.measures) {
      for (const month of current.months) {
        const key = `${branch.code} ${m.code} ${month}`;
        const typed = body.t && body.t[`m${m.id}`] ? body.t[`m${m.id}`][month] : undefined;
        const typedW = body.w && body.w[`m${m.id}`] ? body.w[`m${m.id}`][month] : undefined;
        if (typed === undefined && typedW === undefined) continue;

        const row = (await tx.query('SELECT target, weekend_target FROM measure_targets WHERE measure_id = $1 AND month = $2', [m.id, month])).rows[0];
        const oldT = row ? num(row.target) : null;
        const oldW = row ? num(row.weekend_target) : null;
        let newT = oldT;
        let newW = oldW;

        if (typed !== undefined) {
          const p = parseOptional(typed, { max: m.pct ? 1000 : 100_000_000 });
          if (p.error) { errors.push(`${m.label} (${month}): ${p.error}`); continue; }
          newT = p.value === null ? null : (m.pct ? p.value / 100 : p.value);
        }
        if (typedW !== undefined && m.daily) {
          const p = parseOptional(typedW);
          if (p.error) { errors.push(`${m.label} weekend (${month}): ${p.error}`); continue; }
          newW = p.value;
        }
        if (sameNumber(oldT, newT) && sameNumber(oldW, newW)) continue;
        await tx.query(
          `INSERT INTO measure_targets (measure_id, month, target, weekend_target) VALUES ($1, $2, $3, $4)
           ON CONFLICT (measure_id, month) DO UPDATE SET target = EXCLUDED.target, weekend_target = EXCLUDED.weekend_target`,
          [m.id, month, newT, newW]
        );
        if (!sameNumber(oldT, newT)) { await audit(tx, user, 'update', 'measure_targets', `${key} target`, oldT, newT); changes++; }
        if (!sameNumber(oldW, newW)) { await audit(tx, user, 'update', 'measure_targets', `${key} weekend target`, oldW, newW); changes++; }
      }
    }

    for (const month of current.months) {
      const typed = body.bt && body.bt[month];
      if (!typed) continue;
      const old = current.totals[month] || { total: null, ytd: null };
      const pt = parseOptional(typed.total);
      const py = parseOptional(typed.ytd);
      if (pt.error || py.error) { errors.push(`Branch totals (${month}): ${pt.error || py.error}`); continue; }
      if (sameNumber(old.total, pt.value) && sameNumber(old.ytd, py.value)) continue;
      await tx.query(
        `INSERT INTO branch_month_targets (branch_id, month, total_sales_target, ytd_target_month_end) VALUES ($1, $2, $3, $4)
         ON CONFLICT (branch_id, month) DO UPDATE SET total_sales_target = EXCLUDED.total_sales_target, ytd_target_month_end = EXCLUDED.ytd_target_month_end`,
        [branch.id, month, pt.value, py.value]
      );
      if (!sameNumber(old.total, pt.value)) { await audit(tx, user, 'update', 'branch_month_targets', `${branch.code} ${month} total sales target`, old.total, pt.value); changes++; }
      if (!sameNumber(old.ytd, py.value)) { await audit(tx, user, 'update', 'branch_month_targets', `${branch.code} ${month} YTD target`, old.ytd, py.value); changes++; }
    }

    for (const rt of current.running) {
      const typed = body.rt && body.rt[`r${rt.id}`];
      if (!typed) continue;
      const ps = parseOptional(typed.start);
      const pe = parseOptional(typed.end);
      if (ps.error || pe.error) { errors.push(`${rt.label}: ${ps.error || pe.error}`); continue; }
      const oldS = num(rt.start_value);
      const oldE = num(rt.end_target);
      if (sameNumber(oldS, ps.value) && sameNumber(oldE, pe.value)) continue;
      await tx.query('UPDATE running_totals SET start_value = $2, end_target = $3 WHERE id = $1', [rt.id, ps.value, pe.value]);
      if (!sameNumber(oldS, ps.value)) { await audit(tx, user, 'update', 'running_totals', `${branch.code} ${rt.code} start value`, oldS, ps.value); changes++; }
      if (!sameNumber(oldE, pe.value)) { await audit(tx, user, 'update', 'running_totals', `${branch.code} ${rt.code} end target`, oldE, pe.value); changes++; }
    }

    if (errors.length) throw Object.assign(new Error('invalid'), { userErrors: errors });
  }).catch((err) => { if (!err.userErrors) throw err; });

  return errors.length ? { errors, changes: 0 } : { errors: [], changes };
}

async function saveHqTargets(db, { body, user }) {
  const errors = [];
  let changes = 0;
  const current = await loadHqTargets(db);
  await db.transaction(async (tx) => {
    for (const m of current.measures) {
      for (const month of current.months) {
        const typed = body.h && body.h[`m${m.id}`] ? body.h[`m${m.id}`][month] : undefined;
        if (typed === undefined) continue;
        const p = parseOptional(typed, { max: m.pct ? 1000 : 100_000_000 });
        if (p.error) { errors.push(`${m.label} (${month}): ${p.error}`); continue; }
        const row = (await tx.query('SELECT target FROM hq_measure_targets WHERE hq_measure_id = $1 AND month = $2', [m.id, month])).rows[0];
        const oldT = row ? num(row.target) : null;
        const newT = p.value === null ? null : (m.pct ? p.value / 100 : p.value);
        if (sameNumber(oldT, newT)) continue;
        await tx.query(
          `INSERT INTO hq_measure_targets (hq_measure_id, month, target) VALUES ($1, $2, $3)
           ON CONFLICT (hq_measure_id, month) DO UPDATE SET target = EXCLUDED.target`, [m.id, month, newT]);
        await audit(tx, user, 'update', 'hq_measure_targets', `HQ ${m.code} ${month} target`, oldT, newT);
        changes++;
      }
    }
    // Company sales target (all branches + B2B), per month.
    for (const month of current.months) {
      const typed = body.ct ? body.ct[month] : undefined;
      if (typed === undefined) continue;
      const p = parseOptional(typed);
      if (p.error) { errors.push(`Company sales target (${month}): ${p.error}`); continue; }
      const oldT = current.company[month] ?? null;
      if (sameNumber(oldT, p.value)) continue;
      await tx.query(
        `INSERT INTO company_month_targets (month, total_sales_target) VALUES ($1, $2)
         ON CONFLICT (month) DO UPDATE SET total_sales_target = EXCLUDED.total_sales_target`, [month, p.value]);
      await audit(tx, user, 'update', 'company_month_targets', `Company sales target ${month}`, oldT, p.value);
      changes++;
    }
    if (errors.length) throw Object.assign(new Error('invalid'), { userErrors: errors });
  }).catch((err) => { if (!err.userErrors) throw err; });
  return errors.length ? { errors, changes: 0 } : { errors: [], changes };
}

module.exports = { loadBranchTargets, loadHqTargets, saveBranchTargets, saveHqTargets };
