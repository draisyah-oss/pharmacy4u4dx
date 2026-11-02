// 2 Nov 2026 (CEO): Monthly scoreboard – one page that sums up a month (e.g. October) so we can see
// how things moved through the month, at four levels:
//   Company     – company sales (branches + B2B) vs target, week by week; every branch side by side
//   Departments – HQ departments (app_settings hq_departments = seed hq.departments): measures on
//                 track per week and for the month
//   Branches    – each measure week by week (✔▲✕), the month result and whether it improved
//   People      – each person's targets hit per week and for the month, commitments kept
// Plus notes on each level, which can be brought forward to the next month until marked done.
// Weeks: Monday–Sunday weeks that belong to the month (their Thursday is in it), from the tracker's
// first week. Month results use the calendar month (from the tracker start), as the scoreboards do.

const calc = require('../calc');
const fmt = require('../scoreboard/format');
const { loadMeasures } = require('../daily/data');
const { isTopMeasure } = require('../scoreboard/data');
const { weekMonth } = require('../lib/weeks');
const { b2bWeeksFor, companyTarget } = require('../group/company');
const { cleanText } = require('../weekly/access');
const rv = require('../review/data');

const SCOPES = ['company', 'dept', 'branch', 'person'];
const RATED = ['on_track', 'watch', 'off_track'];

function monthWeeks(month, today, trackerStart) {
  const out = [];
  for (let w = calc.weekStart(calc.monthStart(month)); w <= calc.monthEnd(month) && w <= calc.weekStart(today); w = calc.addDays(w, 7)) {
    if (weekMonth(w) === month && calc.addDays(w, 6) >= trackerStart) out.push(w);
  }
  return out;
}
const weekName = (w) => new Date(`${w}T00:00:00Z`).toLocaleDateString('en-GB', { timeZone: 'UTC', day: 'numeric', month: 'short' });

// Improvement through the month: first rated week vs last rated week (by % of target, or by the
// number itself for track-only measures).
function trend(points) {
  const xs = points.filter((p) => p !== null && p !== undefined && !Number.isNaN(p));
  if (xs.length < 2) return null;
  const a = xs[0]; const b = xs.at(-1);
  const d = b - a;
  const scale = Math.max(Math.abs(a), 1e-9);
  if (Math.abs(d) / scale < 0.05) return 'same';
  return d > 0 ? 'up' : 'down';
}
const ARROW = { up: '↑', down: '↓', same: '→' };

// ─────────────── Branch ───────────────

async function branchSummary(db, { branch, month, weeks, to, trackerStart }) {
  const from = [calc.monthStart(month), trackerStart].sort().pop();
  const loadFrom = weeks.length ? [weeks[0], from].sort()[0] : from;
  const loadTo = weeks.length ? [calc.addDays(weeks.at(-1), 6), to].sort()[0] : to;
  const measures = await loadMeasures(db, branch.id);
  const entries = calc.indexEntries((await db.query(
    'SELECT entry_date, field_key, value FROM daily_entries WHERE branch_id = $1 AND entry_date BETWEEN $2 AND $3',
    [branch.id, [loadFrom, calc.monthStart(month)].sort()[0], [loadTo, to].sort().pop()])).rows);
  const qs = `&branch=${encodeURIComponent(branch.code)}`;
  const people = (await db.query('SELECT id, name, role FROM people WHERE branch_id = $1 AND active ORDER BY sort_order', [branch.id])).rows;

  const rows = measures.map((m) => {
    const shape = { calc: m.calc, money: m.unit === 'RM' };
    const monthR = from <= to ? calc.evaluateMeasure({ measure: m, entries, from, to, trackerStart }) : { actual: null, target: null, pct: null, status: 'no_data' };
    const perWeek = weeks.map((w) => {
      const wf = [w, trackerStart].sort().pop(); const wt = [calc.addDays(w, 6), to].sort()[0];
      if (wf > wt) return { week: w, shown: null, status: 'no_data', pct: null, actual: null };
      const r = calc.evaluateMeasure({ measure: m, entries, from: wf, to: wt, trackerStart });
      const status = m.score_by === 'month' && r.status !== 'no_data' ? 'track_only' : r.status;
      return { week: w, shown: r.actual === null ? null : fmt.value(shape, r.actual), status, pct: r.pct, actual: r.actual,
        href: `/scoreboard/trace?type=measure&code=${encodeURIComponent(m.code)}&from=${wf}&to=${wt}${qs}` };
    });
    const tr = trend(perWeek.map((p) => (monthR.target === null ? p.actual : p.pct)));
    return {
      code: m.code, label: m.label, owner: m.owner_name, person_id: m.person_id, kind: m.kind, top: isTopMeasure(m, branch),
      perWeek, actual: monthR.actual === null ? '–' : fmt.value(shape, monthR.actual),
      target: monthR.target === null ? 'track only' : fmt.value(shape, monthR.target), pct: monthR.pct, status: monthR.status,
      trend: tr, href: `/scoreboard/trace?type=measure&code=${encodeURIComponent(m.code)}&from=${from}&to=${to}${qs}`,
    };
  });

  // Sales: month vs target; each week's till sales.
  const baseline = (await db.query('SELECT * FROM branch_baselines WHERE branch_id = $1', [branch.id])).rows[0] || null;
  const fields = branch.total_sales_fields || [];
  const mtd = calc.mtdSales({ entries, fields, asOf: to, baseline });
  const tgt = (await db.query('SELECT total_sales_target FROM branch_month_targets WHERE branch_id = $1 AND month = $2', [branch.id, month])).rows[0];
  const target = tgt && tgt.total_sales_target !== null ? Number(tgt.total_sales_target) : null;
  const salesWeeks = weeks.map((w) => {
    const wf = [w, trackerStart].sort().pop(); const wt = [calc.addDays(w, 6), to].sort()[0];
    return { week: w, total: wf > wt ? null : calc.branchSales({ entries, fields, from: wf, to: wt }).total, days: wf > wt ? 0 : calc.dateRange(wf, wt).length };
  });
  const sales = { actual: mtd.total, target, pct: calc.percentOf(mtd.total, target), weeks: salesWeeks,
    trend: trend(salesWeeks.map((x) => (x.days ? x.total / x.days : null))), href: `/scoreboard/trace?type=sales&from=${calc.monthStart(month)}&to=${to}${qs}` };
  sales.status = calc.statusFor(sales.pct, { hasTarget: target !== null });

  const rated = rows.filter((r) => RATED.includes(r.status));
  const top = rows.filter((r) => r.top);
  const topRated = top.filter((r) => RATED.includes(r.status));
  const weekHits = weeks.map((w, i) => {
    const xs = rows.map((r) => r.perWeek[i]).filter((p) => RATED.includes(p.status));
    return { week: w, on: xs.filter((p) => p.status === 'on_track').length, of: xs.length };
  });

  // People: their own targets.
  const commits = weeks.length ? (await db.query(
    `SELECT person_id, result FROM commitments WHERE branch_id = $1 AND week_start = ANY($2::date[])`, [branch.id, weeks])).rows : [];
  const persons = people.map((p) => {
    const mine = rows.filter((r) => r.person_id === p.id || (!r.person_id && r.owner === p.name));
    const mr = mine.filter((r) => RATED.includes(r.status));
    const perWeek = weeks.map((w, i) => {
      const xs = mine.map((r) => r.perWeek[i]).filter((x) => RATED.includes(x.status));
      return { week: w, on: xs.filter((x) => x.status === 'on_track').length, of: xs.length };
    });
    const c = commits.filter((x) => x.person_id === p.id);
    return {
      id: p.id, name: p.name, role: p.role, branch: branch.code, measures: mine.length,
      on: mr.filter((r) => r.status === 'on_track').length, of: mr.length, perWeek,
      trend: trend(perWeek.map((x) => (x.of ? x.on / x.of : null))),
      commitsKept: c.filter((x) => x.result === 'yes').length, commits: c.length,
      best: mr.filter((r) => r.status === 'on_track').slice(0, 2).map((r) => r.label),
      behind: mr.filter((r) => r.status === 'off_track').slice(0, 2).map((r) => r.label),
    };
  }).filter((p) => p.measures || p.commits);

  const oos = (await rv.branchMonth(db, { branch, month, today: calc.addDays(to, 1), trackerStart })).oos;
  return {
    code: branch.code, name: branch.name, sales, rows, top, others: rows.filter((r) => !r.top),
    on: rated.filter((r) => r.status === 'on_track').length, of: rated.length,
    topOn: topRated.filter((r) => r.status === 'on_track').length, topOf: topRated.length,
    weekHits, persons, oos,
  };
}

// ─────────────── HQ departments + people ───────────────

async function departments(db) {
  const r = (await db.query("SELECT value FROM app_settings WHERE key = 'hq_departments'")).rows[0];
  try { return r ? JSON.parse(r.value) : []; } catch { return []; }
}

async function hqSummary(db, { month, today, trackerStart, weeks }) {
  const hq = await rv.hqMonth(db, { month, today, trackerStart });
  // hqMonth's week list may start earlier; line its weeks up with ours.
  const idx = weeks.map((w) => hq.weeks.indexOf(w));
  const pick = (r) => idx.map((i, k) => (i >= 0 ? r.perWeek[i] : { week: weeks[k], shown: null, status: 'no_data' }));
  const commits = weeks.length ? (await db.query('SELECT person_id, done FROM hq_commitments WHERE week_start = ANY($1::date[])', [weeks])).rows : [];
  const persons = hq.groups.map((g) => {
    const rows = g.rows.map((r) => ({ ...r, perWeek: pick(r), trend: trend(pick(r).map((x) => (x.status === 'on_track' ? 1 : RATED.includes(x.status) ? 0 : null))) }));
    const rated = rows.filter((r) => RATED.includes(r.status));
    const perWeek = weeks.map((w, i) => {
      const xs = rows.map((r) => r.perWeek[i]).filter((x) => RATED.includes(x.status));
      return { week: w, on: xs.filter((x) => x.status === 'on_track').length, of: xs.length };
    });
    const c = commits.filter((x) => x.person_id === g.person.id);
    return {
      id: g.person.id, name: g.person.name, role: g.person.role, branch: 'HQ', rows, measures: rows.length,
      on: rated.filter((r) => r.status === 'on_track').length, of: rated.length, perWeek,
      trend: trend(perWeek.map((x) => (x.of ? x.on / x.of : null))),
      commitsKept: c.filter((x) => x.done === 'yes').length, commits: c.length,
      best: rated.filter((r) => r.status === 'on_track').slice(0, 2).map((r) => r.label),
      behind: rated.filter((r) => r.status === 'off_track').slice(0, 2).map((r) => r.label),
    };
  });
  const depts = (await departments(db)).map((d) => {
    const ps = persons.filter((p) => d.people.includes(p.name));
    const perWeek = weeks.map((w, i) => ({ week: w, on: ps.reduce((a, p) => a + p.perWeek[i].on, 0), of: ps.reduce((a, p) => a + p.perWeek[i].of, 0) }));
    return {
      name: d.name, people: ps, on: ps.reduce((a, p) => a + p.on, 0), of: ps.reduce((a, p) => a + p.of, 0), perWeek,
      trend: trend(perWeek.map((x) => (x.of ? x.on / x.of : null))),
      commitsKept: ps.reduce((a, p) => a + p.commitsKept, 0), commits: ps.reduce((a, p) => a + p.commits, 0),
    };
  }).filter((d) => d.people.length);
  const inDept = new Set(depts.flatMap((d) => d.people.map((p) => p.name)));
  const loose = persons.filter((p) => !inDept.has(p.name));
  if (loose.length) depts.push({ name: 'Other HQ', people: loose, on: loose.reduce((a, p) => a + p.on, 0), of: loose.reduce((a, p) => a + p.of, 0),
    perWeek: weeks.map((w, i) => ({ week: w, on: loose.reduce((a, p) => a + p.perWeek[i].on, 0), of: loose.reduce((a, p) => a + p.perWeek[i].of, 0) })), trend: null,
    commitsKept: loose.reduce((a, p) => a + p.commitsKept, 0), commits: loose.reduce((a, p) => a + p.commits, 0) });
  return { persons, depts };
}

// ─────────────── Notes (brought forward until done) ───────────────

async function loadNotes(db, month) {
  const { rows } = await db.query(
    `SELECT n.*, c.display_name AS by_name, d.display_name AS done_name FROM month_notes n
     LEFT JOIN users c ON c.id = n.created_by LEFT JOIN users d ON d.id = n.done_by
     WHERE n.month = $1 OR (n.month < $1 AND n.bring_forward AND (n.done_at IS NULL OR n.done_at >= $2))
     ORDER BY n.month, n.created_at`, [month, new Date(Date.parse(`${calc.monthStart(month)}T00:00:00Z`) - 8 * 3600e3)]);
  const by = {};
  for (const n of rows) {
    const k = `${n.scope}|${n.ref}`;
    (by[k] = by[k] || { forward: [], here: [] })[n.month === month ? 'here' : 'forward'].push(n);
  }
  return by;
}

// Who may write a note on (scope, ref) – and tick one done.
function canNote(user, scope, ref, { deptOf = () => null, branchOfPerson = () => null } = {}) {
  if (user.role === 'admin' || user.role === 'hq') return true;
  if (user.role === 'branch_manager') {
    if (scope === 'branch') return ref === user.branch_code;
    if (scope === 'person') return branchOfPerson(ref) === user.branch_code;
    return false;
  }
  if (user.role === 'hq_staff') {
    if (scope === 'person') return String(user.person_id) === String(ref);
    if (scope === 'dept') return deptOf(user.person_id) === ref;
  }
  return false;
}

async function addNote(db, user, { month, scope, ref, note, bringForward, now }) {
  if (!SCOPES.includes(scope)) return { error: 'Unknown section.' };
  const c = cleanText(note, { max: 600, label: 'Note' });
  if (c.error) return { error: c.error };
  if (!c.value) return { error: 'Type a note first.' };
  await db.query(`INSERT INTO month_notes (month, scope, ref, note, bring_forward, created_by, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [month, scope, String(ref || ''), c.value, Boolean(bringForward), user.id, now()]);
  await db.query(`INSERT INTO audit_log (user_id, action, table_name, record_key, new_value) VALUES ($1, 'insert', 'month_notes', $2, $3)`,
    [user.id, `${month} ${scope} ${ref || ''}`, JSON.stringify({ note: c.value })]);
  return { ok: true };
}

async function tickNote(db, user, id, { done, now }) {
  await db.query('UPDATE month_notes SET done_at = $2, done_by = $3 WHERE id = $1', [id, done ? now() : null, done ? user.id : null]);
  await db.query(`INSERT INTO audit_log (user_id, action, table_name, record_key, new_value) VALUES ($1, 'update', 'month_notes', $2, $3)`,
    [user.id, String(id), JSON.stringify({ done: Boolean(done) })]);
}

// ─────────────── The whole page ───────────────

// show: { company, depts, branches: [codes] | 'all', hqPeople }
async function buildMonth(db, { month, today, trackerStart, show }) {
  const weeks = monthWeeks(month, today, trackerStart);
  const yesterday = calc.addDays(today, -1);
  const to = [calc.monthEnd(month), yesterday].sort()[0];
  const complete = to === calc.monthEnd(month);
  const allBranches = (await db.query('SELECT * FROM branches WHERE active ORDER BY sort_order')).rows;
  const branchList = allBranches.filter((b) => show.branches === 'all' || show.branches.includes(b.code) || show.company);
  const branches = [];
  for (const b of branchList) branches.push(await branchSummary(db, { branch: b, month, weeks, to, trackerStart }));

  let company = null;
  if (show.company) {
    const [target, b2b] = await Promise.all([companyTarget(db, month), b2bWeeksFor(db, month, to)]);
    const b2bTotal = b2b.reduce((a, w) => a + w.value, 0);
    const total = branches.reduce((a, b) => a + b.sales.actual, 0) + b2bTotal;
    const perWeek = weeks.map((w, i) => {
      const br = branches.map((b) => b.sales.weeks[i].total);
      const bw = b2b.find((x) => x.week === w);
      return { week: w, total: br.some((x) => x !== null) || bw ? br.reduce((a, x) => a + (x || 0), 0) + (bw ? bw.value : 0) : null,
        days: Math.max(0, ...branches.map((b) => b.sales.weeks[i].days)) };
    });
    const prev = rv.prevMonth(month);
    let prevPct = null;
    if (prev >= calc.monthOf(trackerStart)) {
      const pt = await companyTarget(db, prev);
      let ptotal = 0;
      for (const b of allBranches) {
        const ents = calc.indexEntries((await db.query('SELECT entry_date, field_key, value FROM daily_entries WHERE branch_id = $1 AND entry_date BETWEEN $2 AND $3',
          [b.id, calc.monthStart(prev), calc.monthEnd(prev)])).rows);
        const base = (await db.query('SELECT * FROM branch_baselines WHERE branch_id = $1', [b.id])).rows[0] || null;
        ptotal += calc.mtdSales({ entries: ents, fields: b.total_sales_fields || [], asOf: calc.monthEnd(prev), baseline: base }).total;
      }
      ptotal += (await b2bWeeksFor(db, prev, calc.monthEnd(prev))).reduce((a, w) => a + w.value, 0);
      prevPct = calc.percentOf(ptotal, pt);
    }
    company = {
      total, target, pct: calc.percentOf(total, target), b2b: b2bTotal, perWeek, trend: trend(perWeek.map((x) => (x.days ? x.total / x.days : null))),
      status: calc.statusFor(calc.percentOf(total, target), { hasTarget: target !== null }), prevPct, prevName: rv.MONTH_NAME(prev).split(' ')[0],
    };
  }

  const hq = show.depts || show.hqPeople ? await hqSummary(db, { month, today, trackerStart, weeks }) : { persons: [], depts: [] };
  const shownBranches = branches.filter((b) => show.branches === 'all' || show.branches.includes(b.code));
  return {
    month, name: rv.MONTH_NAME(month), short: rv.MONTH_NAME(month).split(' ')[0], weeks: weeks.map((w) => ({ week: w, name: weekName(w) })),
    from: [calc.monthStart(month), trackerStart].sort().pop(), to, complete,
    company, league: show.company ? branches : [], branches: shownBranches, depts: show.depts ? hq.depts : [],
    hqPersons: show.hqPeople ? hq.persons : [],
  };
}

module.exports = { buildMonth, monthWeeks, trend, ARROW, loadNotes, canNote, addNote, tickNote, departments, SCOPES };
