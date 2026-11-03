// HQ input made quicker (16 Oct): numbers the app already knows are filled in for the person to
// check and save, instead of being counted by hand on Monday.
//
//  - From their own daily task ticks (/hq/today): days Done out of days Done + Not done (N/A left
//    out) – e.g. Alia's "B2B quotes sent within 24 hours", "POs … approved against 30-day sales".
//  - From the out-of-stock flow: inter-store transfers sent within 48 hours of Inventory's answer.
//  - Iman's "HR daily checks fully done": her days fully done ÷ working days.
//  - Iman's wiki measure: pages she sent to Hanin that week; Hanin's: pages she approved (/hq/wiki).
// Every suggestion says where it came from; nothing is saved until they press Save.

const calc = require('../calc');
const team = require('./team');
const wikilist = require('./wikilist');

// measure code → which of the owner's daily tasks it is counted from
const WEEKLY_FROM = '2026-11-02'; // first week of the weekly HQ check-in
const FROM_TASKS = {
  quotes: { task: /quote/i, kind: 'pair', what: 'days you ticked “quotes sent within 24 hours” Done, out of days ticked' },
  po: { task: /\bPOs?\b.*(approv|check)/i, kind: 'pair', what: 'days you ticked the PO check Done, out of days ticked' },
  b2bcalls: { task: /B2B call|B2B.*visit/i, kind: 'count', what: 'days you ticked a B2B call or visit – change it to the real number of calls' },
};

async function suggestions(db, { week, rows, today, at = new Date() }) {
  const out = new Map();
  const through = calc.addDays(week, 6) < today ? calc.addDays(week, 6) : today;
  const byPerson = new Map();
  const tasksOf = async (personId) => {
    if (!byPerson.has(personId)) {
      const tasks = await team.loadTasks(db, personId);
      const ticks = await team.loadTicks(db, tasks.map((t) => t.id), week, through);
      byPerson.set(personId, { tasks, ticks });
    }
    return byPerson.get(personId);
  };

  for (const m of rows) {
    if (m.entry || !m.canEdit || !m.person_id) continue;
    const rule = FROM_TASKS[m.code];
    // 3 Nov: HQ checks in weekly (one tick on the Monday) – a day count can't be worked out any more.
    if (rule && week < WEEKLY_FROM) {
      const { tasks, ticks } = await tasksOf(m.person_id);
      const t = tasks.find((x) => rule.task.test(x.label));
      if (!t) continue;
      let yes = 0; let no = 0;
      for (let d = week; d <= through; d = calc.addDays(d, 1)) {
        const r = ticks.get(`${t.id}|${d}`);
        if (!r || r.na) continue;
        if (r.done) yes++; else no++;
      }
      if (!yes && !no) continue;
      if (rule.kind === 'pair' && m.input === 'done_and_total') out.set(m.id, { value: yes, total: yes + no, from: rule.what });
      else if (rule.kind === 'count') out.set(m.id, { value: yes, from: rule.what });
      continue;
    }
    if (m.code === 'wiki') {
      const n = await wikilist.sentInWeek(db, { week, personId: m.person_id });
      out.set(m.id, { value: n, from: 'the company wiki checklist: your pages sent to Hanin (Checking) this week' });
      continue;
    }
    if (m.code === 'wikisop') {
      const n = await wikilist.approvedInWeek(db, { week });
      out.set(m.id, { value: n, from: 'the company wiki checklist: pages you approved this week' });
      continue;
    }
    if (m.code === 'hrdaily') {
      const { tasks, ticks } = await tasksOf(m.person_id);
      if (!tasks.length) continue;
      if (week >= WEEKLY_FROM) {
        const c = team.weekCheck({ tasks, ticks, week });
        if (c.pct !== null) out.set(m.id, { value: Math.round(c.pct * 1000) / 10, from: `your weekly check-in: ${c.done} of ${c.counted} HR checks done` });
        continue;
      }
      const s = team.dailyWeekSummary({ tasks, ticks, weekStart: week, through });
      if (s.pct !== null) out.set(m.id, { value: Math.round(s.pct * 1000) / 10, from: `your HR daily checks: ${s.fullDays} of ${s.workingDays} working days fully done` });
      continue;
    }
    if (m.code === 'xfer') {
      // Transfers Inventory decided this week whose 48 hours have passed (or that were sent).
      const from = new Date(Date.parse(`${week}T00:00:00+08:00`)); const to = new Date(Date.parse(`${calc.addDays(week, 7)}T00:00:00+08:00`));
      const rowsX = (await db.query(
        "SELECT answered_at, sent_at FROM oos_items WHERE answer = 'transfer' AND answered_at >= $1 AND answered_at < $2", [from, to])).rows;
      const limit = 48 * 3600e3;
      const due = rowsX.filter((r) => r.sent_at || at - new Date(r.answered_at) >= limit);
      if (!due.length) continue;
      const ok = due.filter((r) => r.sent_at && new Date(r.sent_at) - new Date(r.answered_at) <= limit).length;
      out.set(m.id, { value: ok, total: due.length, from: 'out-of-stock transfers sent within 48 hours of your answer' });
    }
  }
  return out;
}

// Last week's numbers, shown as a hint under each box.
async function lastWeek(db, week) {
  const prev = calc.addDays(week, -7);
  const { rows } = await db.query('SELECT hq_measure_id, value, total FROM hq_entries WHERE week_start = $1', [prev]);
  return new Map(rows.map((r) => [r.hq_measure_id, r]));
}

module.exports = { suggestions, lastWeek, FROM_TASKS };
