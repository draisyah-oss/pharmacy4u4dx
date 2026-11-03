// 3 Nov 2026 (CEO): the first page when anyone opens the app is the highlights – something to feel
// good about and to know what's going on:
//   • the company's month sales (and your branch's) with the pace mark
//   • the month's goals (agreed at the monthly review) with progress – goal 1 and 2 worked out by
//     the app (company sales; out-of-stock items fixed within 3 days), the others as their owner sets
//   • 📣 news posted by HQ / the CEO (pinned first)
//   • 🏆 last week's wins: branches ahead of pace, the people who hit the most targets, the longest
//     streaks running, and the managers' "one win this week"
// Worked out from the numbers already in the app; cached for a few minutes (it's every login).

const calc = require('../calc');
const fmt = require('../scoreboard/format');
const { buildScoreboard } = require('../scoreboard/data');
const { loadMeasures } = require('../daily/data');
const { companySalesForWeek } = require('../group/company');
const { cleanText } = require('../weekly/access');

const cache = new Map();
const TTL = 5 * 60e3;

// ── Goals with progress ──
async function oosOver3(db, month, today) {
  const from = new Date(Date.parse(`${calc.monthStart(month)}T00:00:00Z`) - 8 * 3600e3);
  const { rows } = await db.query(
    `SELECT reported_at, received_at, answered_at, status FROM oos_items
     WHERE branch_id IS NOT NULL AND status <> 'Cancelled' AND reported_at >= $1`, [from]);
  const end = new Date(Date.parse(`${today}T00:00:00Z`) - 8 * 3600e3);
  const closedAt = (i) => i.received_at || (String(i.status).startsWith('Discontinued') ? i.answered_at : null);
  // Count an item once its 3 days are up (or it was closed sooner).
  const due = rows.filter((i) => closedAt(i) || end - new Date(i.reported_at) >= 3 * 86400e3);
  const late = due.filter((i) => !closedAt(i) || new Date(closedAt(i)) - new Date(i.reported_at) > 3 * 86400e3);
  return { counted: due.length, late: late.length, pct: due.length ? late.length / due.length : null };
}

async function goalProgress(db, goals, { today, company }) {
  if (!goals) return null;
  const out = [];
  for (const g of goals.goals) {
    const p = { ...g, auto: null, chip: g.status || null };
    if (g.metric === 'company_sales' && company && company.target) {
      p.auto = { text: `${fmt.money(company.total)} of ${fmt.money(company.target)} · ${fmt.pct(company.pct)}${company.perDay ? ` · ${fmt.money(company.perDay)} a day to go` : ''}`,
        pct: company.pct, href: '/group' };
      p.chip = company.status === 'on_track' ? 'On track' : company.status === 'watch' ? 'At risk' : company.status === 'off_track' ? 'Off track' : null;
    }
    if (g.metric === 'oos_over3') {
      const o = await oosOver3(db, goals.month, today);
      p.auto = { text: o.counted ? `${fmt.pct(o.pct)} took over 3 days (${o.late} of ${o.counted}) · goal 5%` : 'No items due yet this month', pct: o.pct, href: '/oos/scoreboard' };
      p.chip = o.pct === null ? null : o.pct <= 0.05 ? 'On track' : o.pct <= 0.1 ? 'At risk' : 'Off track';
    }
    out.push(p);
  }
  return { ...goals, goals: out };
}

async function saveGoalStatus(db, user, { id, status, progress, now }) {
  if (!['admin', 'hq', 'hq_staff'].includes(user.role)) return { error: 'HQ updates goal progress.' };
  const st = ['On track', 'At risk', 'Off track', 'Done'].includes(status) ? status : null;
  const pr = cleanText(progress, { max: 300, label: 'Progress' });
  if (pr.error) return { error: pr.error };
  await db.query('UPDATE month_goals SET status = $2, progress = $3, status_by = $4, status_at = $5 WHERE id = $1', [id, st, pr.value, user.id, now()]);
  await db.query(`INSERT INTO audit_log (user_id, action, table_name, record_key, new_value) VALUES ($1, 'update', 'month_goals', $2, $3)`,
    [user.id, `goal ${id} progress`, JSON.stringify({ status: st, progress: pr.value })]);
  return { ok: 'Goal progress saved.' };
}

// ── News ──
async function loadNews(db, today) {
  const { rows } = await db.query(
    `SELECT n.*, u.display_name AS by_name FROM news n LEFT JOIN users u ON u.id = n.created_by
     WHERE n.removed_at IS NULL AND (n.show_until IS NULL OR n.show_until >= $1)
     ORDER BY n.pinned DESC, n.created_at DESC LIMIT 6`, [today]);
  return rows;
}
const canPost = (u) => u.role === 'admin' || u.role === 'hq';
async function postNews(db, user, body, { now }) {
  if (!canPost(user)) return { error: 'HQ posts the news.' };
  const t = cleanText(body.title, { max: 120, label: 'Headline' });
  const b = cleanText(body.body, { max: 600, label: 'Story' });
  if (t.error || b.error) return { error: t.error || b.error };
  if (!t.value) return { error: 'Type a headline.' };
  const emoji = String(body.emoji || '').slice(0, 8) || null;
  const until = /^\d{4}-\d{2}-\d{2}$/.test(String(body.show_until || '')) ? body.show_until : null;
  await db.query('INSERT INTO news (emoji, title, body, pinned, show_until, created_by, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7)',
    [emoji, t.value, b.value, body.pinned === '1', until, user.id, now()]);
  await db.query(`INSERT INTO audit_log (user_id, action, table_name, record_key, new_value) VALUES ($1, 'insert', 'news', $2, NULL)`, [user.id, t.value]);
  return { ok: 'Posted – everyone sees it on the front page.' };
}
async function removeNews(db, user, id, { now }) {
  if (!canPost(user)) return { error: 'HQ posts the news.' };
  await db.query('UPDATE news SET removed_at = $2 WHERE id = $1', [id, now()]);
  await db.query(`INSERT INTO audit_log (user_id, action, table_name, record_key, new_value) VALUES ($1, 'delete', 'news', $2, NULL)`, [user.id, String(id)]);
  return { ok: 'Taken down.' };
}

// ── Wins (all branches, last week) ──
async function wins(db, { today, trackerStart }) {
  const week = calc.weekStart(today);
  const last = calc.addDays(week, -7);
  const company = await companySalesForWeek(db, { week, today, trackerStart });
  if (last < calc.weekStart(trackerStart)) return { company, people: [], teams: [], ahead: [], streaks: [], words: [], week: last };
  const branches = (await db.query('SELECT * FROM branches WHERE active ORDER BY sort_order')).rows;
  const people = []; const teamHits = []; const streaks = [];
  const lastDay = calc.addDays(today, -1);
  for (const b of branches) {
    const board = await buildScoreboard(db, { branch: b, weekStart: last, today, trackerStart });
    const rows = [...board.top, ...board.groups.flatMap((g) => g.rows)];
    const by = new Map();
    for (const r of rows) {
      if (!r.owner || r.owner === 'Team' || !['on_track', 'watch', 'off_track'].includes(r.week.status)) continue;
      const x = by.get(r.owner) || { name: r.owner, branch: b.code, on: 0, of: 0, labels: [] };
      x.of++; if (r.week.status === 'on_track') { x.on++; if (x.labels.length < 2) x.labels.push(r.label); }
      by.set(r.owner, x);
    }
    people.push(...[...by.values()].filter((x) => x.on));
    const rated = rows.filter((r) => ['on_track', 'watch', 'off_track'].includes(r.week.status));
    teamHits.push({ code: b.code, name: b.name, on: rated.filter((r) => r.week.status === 'on_track').length, of: rated.length });
    // Streaks: daily sum targets of a person, days in a row on target up to yesterday.
    const ms = (await loadMeasures(db, b.id)).filter((m) => m.target_per === 'day' && m.calc === 'sum' && m.owner_name && m.owner_name !== 'Team');
    if (ms.length) {
      const from = [trackerStart, calc.addDays(lastDay, -30)].sort().pop();
      const entries = calc.indexEntries((await db.query('SELECT entry_date, field_key, value FROM daily_entries WHERE branch_id = $1 AND entry_date BETWEEN $2 AND $3', [b.id, from, lastDay])).rows);
      for (const m of ms) {
        let n = 0;
        for (let d = lastDay; d >= from; d = calc.addDays(d, -1)) {
          const t = calc.dailyTarget(m.targets, 'day', d, m.weekend_targets, m.high_days);
          const v = entries.get(d, m.numerator_field);
          if (!t || v === null || v < t) break;
          n++;
        }
        if (n >= 3) streaks.push({ name: m.owner_name, branch: b.code, label: m.label, days: n });
      }
    }
  }
  const ahead = company && company.rows ? company.rows.filter((r) => r.sales && r.sales.status === 'on_track' && r.sales.monthTarget).map((r) => ({ code: r.code, name: r.name, pct: r.sales.pct })) : [];
  const words = (await db.query(
    `SELECT b.code, c.win_this_week FROM weekly_checkins c JOIN branches b ON b.id = c.branch_id
     WHERE c.week_start = $1 AND c.win_this_week IS NOT NULL AND c.win_this_week <> '' ORDER BY b.sort_order`, [last])).rows;
  return {
    week: last, company,
    people: people.sort((a, b) => b.on - a.on || b.on / b.of - a.on / a.of).slice(0, 6),
    teams: teamHits.filter((t) => t.of).sort((a, b) => b.on / b.of - a.on / a.of),
    streaks: streaks.sort((a, b) => b.days - a.days).slice(0, 5),
    ahead, words,
  };
}

// 3 Nov (CEO): branch people see THEIR branch's month – the WIG and lead measures with the month's
// target and how far along they are – instead of the company's goals.
async function branchTargets(db, { branchCode, today, trackerStart }) {
  const { isTopMeasure } = require('../scoreboard/data');
  const branch = (await db.query('SELECT * FROM branches WHERE code = $1 AND active', [branchCode])).rows[0];
  if (!branch) return null;
  const month = calc.monthOf(today);
  const from = [calc.monthStart(month), trackerStart].sort().pop();
  const lastDay = calc.addDays(today, -1);
  const measures = (await loadMeasures(db, branch.id)).filter((m) => m.kind === 'WIG' || isTopMeasure(m, branch) || m.kind === 'Lead');
  const entries = calc.indexEntries((await db.query('SELECT entry_date, field_key, value FROM daily_entries WHERE branch_id = $1 AND entry_date BETWEEN $2 AND $3',
    [branch.id, from, today])).rows);
  const per = { day: 'a day', week: 'a week', month: 'a month' };
  const rows = measures.map((m) => {
    const shape = { calc: m.calc, money: m.unit === 'RM' };
    const full = calc.evaluateMeasure({ measure: m, entries: calc.indexEntries([]), from, to: calc.monthEnd(month), trackerStart });
    const sofar = lastDay >= from ? calc.evaluateMeasure({ measure: m, entries, from, to: lastDay, trackerStart }) : null;
    const t = m.targets[month]; const w = (m.weekend_targets || {})[month];
    const rate = t === null || t === undefined ? null
      : (m.calc === 'sum' ? fmt.value(shape, Number(t)) : fmt.value(shape, Number(t))) + ' ' + (per[m.target_per] || '')
        + (w !== null && w !== undefined && m.calc === 'sum' ? ` (${calc.highDaysLabel(m.high_days)} ${fmt.value(shape, Number(w))})` : '');
    const isSum = m.calc === 'sum';
    return {
      code: m.code, label: m.label, owner: m.owner_name, wig: m.kind === 'WIG', rate,
      monthTarget: isSum && full.target !== null ? fmt.value(shape, full.target) : null,
      sofar: sofar && sofar.actual !== null ? fmt.value(shape, sofar.actual) : '–',
      pct: sofar ? sofar.pct : null, status: sofar ? sofar.status : 'no_data',
      fill: isSum && full.target ? Math.min(100, Math.round(((sofar && sofar.actual) || 0) / full.target * 100)) : null,
      pace: isSum && full.target && sofar && sofar.target ? Math.min(100, Math.round(sofar.target / full.target * 100)) : null,
      href: `/scoreboard/trace?type=measure&code=${encodeURIComponent(m.code)}&from=${from}&to=${lastDay < from ? from : lastDay}`,
    };
  });
  rows.sort((a, b) => (b.wig - a.wig));
  return { code: branch.code, name: branch.name, monthName: new Date(`${month}-01T00:00:00Z`).toLocaleDateString('en-GB', { timeZone: 'UTC', month: 'long' }), rows };
}

async function buildHighlights(db, { user, now, trackerStart }) {
  const today = calc.todayInMalaysia(now());
  const key = `${today}|${Math.floor(now().getTime() / TTL)}`;
  let shared = cache.get(key);
  if (!shared) {
    const w = await wins(db, { today, trackerStart });
    const goals = await require('../review/data').currentGoals(db, today);
    shared = { wins: w, goals: await goalProgress(db, goals, { today, company: w.company }) };
    cache.clear(); cache.set(key, shared);
  }
  const news = await loadNews(db, today);
  const tazkirah = await require('./tazkirah').today(db, today);
  const targets = user.branch_code && ['branch_staff', 'branch_manager'].includes(user.role)
    ? await branchTargets(db, { branchCode: user.branch_code, today, trackerStart }) : null;
  const branchRow = user.branch_code && shared.wins.company && shared.wins.company.rows ? shared.wins.company.rows.find((r) => r.code === user.branch_code) : null;
  return { today, ...shared, news, tazkirah, targets, canPost: canPost(user), myBranch: branchRow };
}
const clearCache = () => cache.clear();

module.exports = { branchTargets, buildHighlights, goalProgress, saveGoalStatus, postNews, removeNews, loadNews, canPost, oosOver3, clearCache };
