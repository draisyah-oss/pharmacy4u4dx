// 1 Nov (CEO): the front page for branch staff and managers – personal, motivating, honest.
// Everything is worked out from the numbers already in the app (nothing typed for it):
//   Wins     – my targets hit last week, my commitment kept, streaks (days in a row on a daily
//              target), a new personal best, the branch's month sales pace.
//   Shout-outs – teammates who hit targets last week.
//   Focus    – my targets behind this week, with what it takes to catch up by Sunday; my
//              commitment this week; for managers, the team's lead measures that are behind.
// Each line links to the numbers behind it.

const calc = require('../calc');
const fmt = require('../scoreboard/format');
const { loadMeasures } = require('../daily/data');
const { buildScoreboard } = require('../scoreboard/data');

// Short original lines, one a day (rotates by date).
const LINES = [
  'Small wins every day add up to a big December.',
  'The scoreboard only moves when we do – one customer at a time.',
  'Focus on the lead measures; the results follow.',
  'Every number you enter today helps the whole team see where to push.',
  'Good habits beat good intentions. Keep the streak going.',
  'Ask one more question, offer one more product – that’s how the 3+ items happen.',
  'A great pharmacy is built by great people serving one customer well, again and again.',
];

function greeting(at) {
  const h = Number(new Date(at).toLocaleString('en-GB', { timeZone: 'Asia/Kuala_Lumpur', hour: '2-digit', hour12: false }));
  if (h < 12) return 'Selamat pagi';
  if (h < 14) return 'Selamat tengah hari';
  if (h < 19) return 'Selamat petang';
  return 'Selamat malam';
}

const isMine = (m, person) => person && (m.person_id === person.id || m.owner_name === person.name);
const show = (row, n) => fmt.value(row, n);

async function buildMyPage(db, { user, branch, now, trackerStart }) {
  const at = now();
  const today = calc.todayInMalaysia(at);
  const week = calc.weekStart(today);
  const weekEnd = calc.addDays(week, 6);
  const lastWeek = calc.addDays(week, -7);
  const person = user.person_id ? (await db.query('SELECT id, name, role FROM people WHERE id = $1', [user.person_id])).rows[0] : null;
  const isManager = user.role === 'branch_manager';

  const [measures, boardThis, boardLast] = await Promise.all([
    loadMeasures(db, branch.id),
    buildScoreboard(db, { branch, weekStart: week, today, trackerStart }),
    lastWeek >= calc.weekStart(trackerStart) ? buildScoreboard(db, { branch, weekStart: lastWeek, today, trackerStart }) : null,
  ]);
  const rowsOf = (b) => (b ? new Map([...b.top, ...b.groups.flatMap((g) => g.rows)].map((r) => [r.code, r])) : new Map());
  const thisRows = rowsOf(boardThis); const lastRows = rowsOf(boardLast);
  const from = [trackerStart, calc.addDays(today, -60)].sort().pop();
  const entries = calc.indexEntries((await db.query(
    'SELECT entry_date, field_key, value FROM daily_entries WHERE branch_id = $1 AND entry_date BETWEEN $2 AND $3',
    [branch.id, from, today])).rows);
  const enteredToday = (await db.query('SELECT 1 FROM daily_entries WHERE branch_id = $1 AND entry_date = $2 LIMIT 1', [branch.id, today])).rows.length > 0;
  const lastDay = enteredToday ? today : calc.addDays(today, -1);
  const trace = (code, wk) => {
    const to = [calc.addDays(wk, 6), lastDay].sort()[0];
    return `/scoreboard/trace?type=measure&code=${encodeURIComponent(code)}&from=${wk}&to=${to < wk ? wk : to}`;
  };

  const mine = measures.filter((m) => isMine(m, person));
  const wins = []; const focus = [];

  // ── Wins ──
  for (const m of mine) {
    const r = lastRows.get(m.code);
    if (r && r.week.status === 'on_track') {
      wins.push({ kind: 'target', title: `You hit “${r.label}” last week`, sub: `${show(r, r.week.actual)} against ${show(r, r.week.target)}`, href: trace(m.code, lastWeek) });
    }
  }
  // Streak: days in a row (to the last day entered) on a daily target of mine.
  for (const m of mine.filter((x) => x.target_per === 'day' && x.calc === 'sum')) {
    let n = 0;
    for (let d = lastDay; d >= trackerStart; d = calc.addDays(d, -1)) {
      const t = calc.dailyTarget(m.targets, 'day', d, m.weekend_targets, m.high_days);
      const v = entries.get(d, m.numerator_field);
      if (!t || v === null || v < t) break;
      n++;
    }
    if (n >= 3) wins.push({ kind: 'streak', title: `${n} days in a row on “${m.label}”`, sub: 'Keep the streak going today', streak: n, href: trace(m.code, week) });
  }
  // Personal best: the last day entered is my highest day since the tracker started (7+ days of data).
  for (const m of mine.filter((x) => x.calc === 'sum')) {
    const days = calc.dateRange(from, lastDay).map((d) => entries.get(d, m.numerator_field)).filter((v) => v !== null);
    const last = entries.get(lastDay, m.numerator_field);
    if (days.length >= 7 && last > 0 && last >= Math.max(...days) && days.filter((v) => v === last).length === 1) {
      wins.push({ kind: 'best', title: `New personal best: ${fmt.number(last, 0)} on “${m.label}”`, sub: lastDay === today ? 'today' : 'yesterday', href: trace(m.code, week) });
    }
  }
  if (person) {
    const kept = (await db.query('SELECT commitment FROM commitments WHERE person_id = $1 AND week_start = $2 AND result = $3', [person.id, lastWeek, 'yes'])).rows[0];
    if (kept) wins.push({ kind: 'commit', title: 'You kept last week’s commitment', sub: kept.commitment, href: '/my-week' });
  }
  const s = boardThis.sales;
  // 9 Nov: Monday before today's numbers are in – "needed per day" from the last day with numbers.
  if (s && s.monthTarget && (s.perDay === null || s.perDay === undefined) && boardThis.asOf && boardThis.asOf.slice(0, 7) === s.month) {
    const need = calc.requiredPerDay({ monthTarget: s.monthTarget, mtdActual: s.mtd || 0, asOf: boardThis.asOf });
    s.perDay = need.perDay; s.daysLeft = need.daysLeft;
  }
  if (s && s.status === 'on_track' && s.monthTarget) {
    wins.push({ kind: 'branch', title: `${branch.code} is ahead of pace this month`, sub: `${fmt.money(s.mtd)} so far – ${fmt.pct(s.pct)} of ${fmt.money(s.monthTarget)}`, href: '/scoreboard' });
  }
  const teamRows = [...lastRows.values()].filter((r) => r.owner === 'Team' && ['on_track', 'watch', 'off_track'].includes(r.week.status));
  const teamHit = teamRows.filter((r) => r.week.status === 'on_track').length;
  if (teamHit) wins.push({ kind: 'team', title: `The team hit ${teamHit} of ${teamRows.length} team targets last week`, sub: teamRows.filter((r) => r.week.status === 'on_track').slice(0, 3).map((r) => r.label).join(' · '), href: `/scoreboard?week=${lastWeek}` });

  // ── Shout-outs: teammates with targets hit last week ──
  const by = new Map();
  for (const r of lastRows.values()) {
    if (r.owner === 'Team' || (person && r.owner === person.name) || r.week.status !== 'on_track') continue;
    if (!by.has(r.owner)) by.set(r.owner, []);
    by.get(r.owner).push(r.label);
  }
  const shoutouts = [...by.entries()].sort((a, b) => b[1].length - a[1].length).slice(0, 4)
    .map(([name, labels]) => ({ name, n: labels.length, labels: labels.slice(0, 2).join(' · ') }));

  // ── Focus: my targets behind this week, and what it takes by Sunday ──
  const daysLeft = calc.dateRange(enteredToday ? calc.addDays(today, 1) : today, weekEnd).length;
  const behind = (list) => list.map((m) => ({ m, r: thisRows.get(m.code) }))
    .filter(({ r }) => r && ['off_track', 'watch'].includes(r.week.status))
    .sort((a, b) => (a.r.week.pct ?? 0) - (b.r.week.pct ?? 0));
  for (const { m, r } of behind(mine).slice(0, 3)) {
    const item = { title: r.label, now: `${show(r, r.week.actual)} so far · target ${show(r, r.week.target)}`, status: r.week.status, href: trace(m.code, week) };
    if (m.calc === 'sum' && daysLeft > 0) {
      const full = calc.evaluateMeasure({ measure: m, entries, from: week, to: weekEnd, trackerStart }).target;
      let need = full === null ? null : full - (r.week.actual || 0);
      if (need > 0) {
        if (!r.money) need = Math.ceil(need - 1e-9); // whole items / customers
        const fullShown = r.money ? full : Math.ceil(full - 1e-9);
        item.now = `${show(r, r.week.actual)} so far · goal ${show(r, fullShown)} this week`;
        const perDay = need / daysLeft;
        item.plan = `${show(r, need)} more by Sunday${m.target_per === 'day' && perDay >= 1 ? ` – about ${show(r, r.money ? perDay : Math.ceil(perDay))} a day` : ''}`;
      }
    } else if (m.calc === 'average_percent') item.plan = `Keep it at ${show(r, r.week.target)} or more on the days left`;
    else if (m.calc !== 'sum') item.plan = `Aim for ${show(r, r.week.target)} – every customer counts`;
    focus.push(item);
  }
  let myCommit = null;
  if (person) myCommit = (await db.query('SELECT commitment, result FROM commitments WHERE person_id = $1 AND week_start = $2', [person.id, week])).rows[0] || null;
  const teamFocus = isManager
    ? behind(measures.filter((m) => !isMine(m, person) && thisRows.get(m.code) && thisRows.get(m.code).top)).slice(0, 3)
      .map(({ m, r }) => ({ title: r.label, owner: r.owner, now: `${show(r, r.week.actual)} of ${show(r, r.week.target)}`, status: r.week.status, href: trace(m.code, week) }))
    : [];

  // 9 Nov (CEO: "staff want to look at their WIG and lead measures"): every one of my measures this
  // week – leads first, then the ones behind – with a progress bar and a link to log it on Daily entry.
  const rated = (st) => ['on_track', 'watch', 'off_track'].includes(st);
  const order = { off_track: 0, watch: 1, on_track: 2 };
  const myMeasures = mine.map((m) => ({ m, r: thisRows.get(m.code) })).filter(({ r }) => r)
    .map(({ m, r }) => {
      const rateOk = rated(r.week.status);
      const pct = rateOk && r.week.pct !== null && r.week.pct !== undefined ? r.week.pct : null;
      return {
        code: m.code, label: r.label, status: rateOk ? r.week.status : 'track_only',
        lead: !!(r.top || r.kind === 'Lead'),
        actual: r.week.actual === null || r.week.actual === undefined ? '–' : show(r, r.week.actual),
        target: r.week.target === null || r.week.target === undefined ? null : show(r, r.week.target),
        fill: pct === null ? null : Math.max(0, Math.min(100, Math.round(pct * 100))),
        href: trace(m.code, week), logHref: m.numerator_field ? `/daily#f_${encodeURIComponent(m.numerator_field)}` : '/daily',
      };
    })
    .sort((a, b) => (b.lead - a.lead) || ((order[a.status] ?? 3) - (order[b.status] ?? 3)));
  // Managers: each teammate's targets on track this week and the one furthest behind.
  const team = [];
  if (isManager) {
    const byOwner = new Map();
    for (const r of thisRows.values()) {
      if (!r.owner || r.owner === 'Team' || !rated(r.week.status)) continue;
      const x = byOwner.get(r.owner) || { name: r.owner, on: 0, of: 0, low: null };
      x.of++; if (r.week.status === 'on_track') x.on++;
      else if (!x.low || (r.week.pct ?? 0) < (x.low.pct ?? 0)) x.low = { label: r.label, pct: r.week.pct };
      byOwner.set(r.owner, x);
    }
    team.push(...[...byOwner.values()].sort((a, b) => a.on / a.of - b.on / b.of));
  }

  const dayIndex = Math.floor(Date.parse(`${today}T00:00:00Z`) / 86400000);
  return {
    greeting: greeting(at), name: person ? person.name : user.display_name, branch, isManager,
    line: LINES[dayIndex % LINES.length],
    wins: wins.slice(0, 5), shoutouts, myMeasures, team, weekStart: week, focus, myCommit, teamFocus, enteredToday, today,
    wig: branch.wig || null, sales: s, onTrackMine: mine.filter((m) => (thisRows.get(m.code) || {}).week?.status === 'on_track').length,
    mineCount: mine.filter((m) => ['on_track', 'watch', 'off_track'].includes((thisRows.get(m.code) || {}).week?.status)).length,
  };
}

module.exports = { buildMyPage, greeting, LINES };
