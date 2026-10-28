// 28 Oct: Daily entry as a WEEK SHEET (JH first – app_settings sheet_view_branches): boxes down
// the side, Monday–Sunday across, type into the cells, one Save. Same rules as the one-day page:
// a day is editable when editBlockReason allows it, sales-sheet boxes are read-only, every save
// goes through saveDailyEntries (checks, audit). Boxes not on the page keep their numbers.

const calc = require('../calc');
const fmt = require('../scoreboard/format');
const { loadMeasures, saveDailyEntries } = require('./data');
const { editBlockReason } = require('./rules');
const { buildScoreboard } = require('../scoreboard/data');

const DOW = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const cleanLabel = (label) => label.replace(/\s*\(1\/0\)/, '');

async function sheetViewBranches(db) {
  const row = (await db.query("SELECT value FROM app_settings WHERE key = 'sheet_view_branches'")).rows[0];
  try { return row ? JSON.parse(row.value) : []; } catch { return []; }
}
const sheetViewOn = async (db, code) => (await sheetViewBranches(db)).includes(code);

// show: 'mine' (my boxes + Team) or 'all'.
async function loadWeekGrid(db, { branch, week, user, today, trackerStart, sheetFields = new Set(), show = 'all', typed = null }) {
  const days = DOW.map((d, i) => {
    const date = calc.addDays(week, i);
    const blocked = editBlockReason(user, branch.id, date, { today, trackerStart });
    return { date, dow: d, num: Number(date.slice(8)), isToday: date === today, future: date > today, editable: !blocked };
  });
  const [fieldsRes, peopleRes, measures, entryRows] = await Promise.all([
    db.query('SELECT * FROM daily_fields WHERE branch_id = $1 AND active ORDER BY sort_order', [branch.id]),
    db.query('SELECT * FROM people WHERE branch_id = $1 AND active ORDER BY sort_order', [branch.id]),
    loadMeasures(db, branch.id),
    db.query('SELECT entry_date, field_key, value FROM daily_entries WHERE branch_id = $1 AND entry_date BETWEEN $2 AND $3',
      [branch.id, week, calc.addDays(week, 6)]),
  ]);
  const entries = calc.indexEntries(entryRows.rows);
  const board = await buildScoreboard(db, { branch, weekStart: week, today, trackerStart });
  const boardRows = new Map([...board.top, ...board.groups.flatMap((g) => g.rows)].map((r) => [r.code, r]));
  const byField = new Map();
  for (const m of measures) if (!byField.has(m.numerator_field)) byField.set(m.numerator_field, boardRows.get(m.code));

  const rowFor = (f) => {
    const fromSheet = sheetFields.has(f.key);
    const cells = days.map((d) => {
      const stored = entries.get(d.date, f.key);
      const t = typed && typed[d.date] ? typed[d.date][f.key] : undefined;
      return {
        date: d.date, name: `c[${d.date}][${f.key}]`,
        value: t !== undefined ? t : (stored === null ? '' : String(stored)),
        editable: d.editable && !fromSheet, isToday: d.isToday, future: d.future,
      };
    });
    const r = byField.get(f.key);
    let week = null; let target = null; let status = null;
    if (r) {
      week = fmt.value(r, r.week.actual);
      target = r.monthTarget === null || r.monthTarget === undefined ? 'track only' : fmt.targetBasis(r);
      status = r.week.status;
    } else {
      const sum = days.reduce((a, d) => a + (entries.get(d.date, f.key) || 0), 0);
      week = f.type === 'money' ? fmt.money(sum) : fmt.number(sum, f.type === 'percent' ? 1 : 0);
    }
    return { key: f.key, label: cleanLabel(f.label), type: f.type, fromSheet, cells, week, target, status, statusSymbol: fmt.symbol(status) };
  };

  const fields = fieldsRes.rows;
  const people = [...peopleRes.rows].sort((a, b) =>
    (a.id === user.person_id ? -1 : 0) - (b.id === user.person_id ? -1 : 0) || a.sort_order - b.sort_order);
  const groups = [];
  const team = fields.filter((f) => f.owner_name === 'Team');
  if (team.length) groups.push({ name: 'Team', role: 'Whoever closes', rows: team.map(rowFor) });
  for (const p of people) {
    const own = fields.filter((f) => f.owner_name === p.name);
    if (own.length) groups.push({ name: p.name, role: p.role, isMe: p.id === user.person_id, rows: own.map(rowFor) });
  }
  const known = new Set(['Team', ...people.map((p) => p.name)]);
  const orphans = fields.filter((f) => !known.has(f.owner_name));
  if (orphans.length) groups.push({ name: 'Others', role: 'Owner no longer here', rows: orphans.map(rowFor) });

  const shown = show === 'mine' ? groups.filter((g) => g.name === 'Team' || g.isMe) : groups;
  const hidden = groups.filter((g) => !shown.includes(g)).reduce((a, g) => a + g.rows.length, 0);
  return { days, groups: shown, hidden, anyEditable: days.some((d) => d.editable) };
}

// body.c = { 'YYYY-MM-DD': { fieldKey: 'typed' } }. Each day is saved on its own; days with a
// problem come back with their errors and what was typed, the rest are saved.
async function saveWeek(db, { branch, week, user, today, trackerStart, sheetFields, body }) {
  const posted = body && typeof body.c === 'object' && body.c ? body.c : {};
  const errors = {}; let changes = 0;
  for (let i = 0; i < 7; i++) {
    const date = calc.addDays(week, i);
    const input = posted[date];
    if (!input || typeof input !== 'object') continue;
    if (editBlockReason(user, branch.id, date, { today, trackerStart })) continue;
    const r = await saveDailyEntries(db, { branch, date, user, input, sheetFields, keepMissing: true });
    if (Object.keys(r.errors).length) errors[date] = r.errors; else changes += r.changes;
  }
  return { errors, changes, typed: posted };
}

module.exports = { sheetViewBranches, sheetViewOn, loadWeekGrid, saveWeek, DOW };
