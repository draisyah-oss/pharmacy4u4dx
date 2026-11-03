// 3 Nov 2026 (CEO): Zakat claims tracker for BR, WM and JH (/zakat) – the branch keys in, each week,
// what it claimed, the payment received and the zakat contracts it bid on / won, plus the suppliers
// holding up its supply. It replaces the old zakat lead measures (orders within 2 weeks, claims
// within 7 days). Built from the CEO's "Zakat Claims Tracker" page.
//
// Where the numbers live (so the scoreboard can trace every one):
//  • weekly numbers → daily_entries on the week's Monday, fields zclaim / zpaid / zbid / zwon (daily
//    fields kept inactive, so they don't show on Daily entry);
//  • the month's "amount to claim" → measure ZC1's month target (measure_targets);
//  • suppliers holding up supply → zakat_suppliers (10 rows a branch).
// Measures: ZC1 Zakat claimed (Lead, RM a month vs the amount to claim), ZC2 Zakat payment received
// (Stream, RM a month), ZC3 Zakat contracts won (Routine, % of bids).

const calc = require('../calc');

const BRANCHES = ['BR', 'WM', 'JH'];
const FIELDS = [
  { key: 'zclaim', label: 'Zakat claimed (RM)', type: 'money' },
  { key: 'zpaid', label: 'Zakat payment received (RM)', type: 'money' },
  { key: 'zbid', label: 'Zakat contracts bid on', type: 'count' },
  { key: 'zwon', label: 'Zakat contracts won', type: 'count' },
];
const KEYS = FIELDS.map((f) => f.key);
const SUP_ROWS = 10;
const BACK_WEEKS = 8; // branch people can key in the last 8 weeks; HQ / admin any week

const r2 = (n) => Math.round(n * 100) / 100;
const num = (v) => { const n = Number(String(v ?? '').replace(/[^0-9.\-]/g, '')); return Number.isFinite(n) && n > 0 ? n : 0; };
const addMonth = (key, n) => { const [y, m] = key.split('-').map(Number); const d = new Date(Date.UTC(y, m - 1 + n, 1)); return d.toISOString().slice(0, 7); };

const isZakatBranch = (code) => BRANCHES.includes(code);
const canSee = (u, branch) => Boolean(u && branch && isZakatBranch(branch.code)
  && (u.role === 'admin' || u.role === 'hq' || u.branch_code === branch.code));
const canTarget = (u, branch) => Boolean(u && branch && (u.role === 'admin' || u.role === 'hq' || (u.role === 'branch_manager' && u.branch_code === branch.code)));
const anyWeek = (u) => u.role === 'admin' || u.role === 'hq';

// Month rows with running totals – the same sums as the CEO's page:
// carried unclaimed = targets so far − claimed so far; owed = claimed so far − paid so far.
function timeline(targets, weeks, { month, today }) {
  const t = {};
  const g = (k) => t[k] || (t[k] = { target: 0, claimed: 0, paid: 0, bids: 0, won: 0 });
  for (const [k, v] of Object.entries(targets)) g(k).target = Number(v) || 0;
  for (const [d, w] of Object.entries(weeks)) { const m = g(d.slice(0, 7)); m.claimed += w.zclaim || 0; m.paid += w.zpaid || 0; m.bids += w.zbid || 0; m.won += w.zwon || 0; }
  const keys = Object.keys(t).sort();
  const out = { rows: [], byKey: {} };
  if (!keys.length) return out;
  let last = keys[keys.length - 1];
  const cm = today.slice(0, 7);
  if (month > last) last = month;
  if (cm > last) last = cm;
  let cT = 0; let cC = 0; let cP = 0;
  for (let k = keys[0], guard = 0; k <= last && guard < 600; k = addMonth(k, 1), guard++) {
    const m = t[k] || { target: 0, claimed: 0, paid: 0, bids: 0, won: 0 };
    const row = { key: k, target: r2(m.target), claimed: r2(m.claimed), paid: r2(m.paid), bids: m.bids, won: m.won, carriedUnclaimed: r2(cT - cC), carriedOwed: r2(cC - cP) };
    cT += m.target; cC += m.claimed; cP += m.paid;
    row.unclaimedEnd = r2(cT - cC); row.owedEnd = r2(cC - cP);
    out.rows.push(row); out.byKey[k] = row;
  }
  return out;
}
const zeroRow = (key) => ({ key, target: 0, claimed: 0, paid: 0, bids: 0, won: 0, carriedUnclaimed: 0, carriedOwed: 0, unclaimedEnd: 0, owedEnd: 0 });

async function zc1(db, branchId) {
  return (await db.query("SELECT id FROM measures WHERE branch_id = $1 AND code = 'ZC1'", [branchId])).rows[0] || null;
}

async function loadTracker(db, branch, { month, today }) {
  const m = await zc1(db, branch.id);
  const targets = {};
  if (m) for (const r of (await db.query('SELECT month, target FROM measure_targets WHERE measure_id = $1 AND target IS NOT NULL', [m.id])).rows) targets[String(r.month).trim()] = Number(r.target);
  const weeks = {};
  const { rows } = await db.query(`SELECT entry_date::text AS d, field_key, value FROM daily_entries WHERE branch_id = $1 AND field_key = ANY($2)`, [branch.id, KEYS]);
  for (const r of rows) (weeks[r.d] = weeks[r.d] || { zclaim: 0, zpaid: 0, zbid: 0, zwon: 0 })[r.field_key] = Number(r.value);
  const sup = (await db.query('SELECT slot, name, contracts FROM zakat_suppliers WHERE branch_id = $1 ORDER BY slot', [branch.id])).rows;
  const suppliers = Array.from({ length: SUP_ROWS }, (_, i) => { const s = sup.find((x) => x.slot === i + 1); return { slot: i + 1, name: s ? s.name : '', contracts: s ? s.contracts : 0 }; });
  const tl = timeline(targets, weeks, { month, today });
  const listed = suppliers.filter((s) => s.name.trim() || s.contracts > 0);
  const top = listed.reduce((a, s) => (!a || s.contracts > a.contracts ? s : a), null);
  return { targets, weeks, tl, row: tl.byKey[month] || zeroRow(month), prev: tl.byKey[addMonth(month, -1)] || zeroRow(addMonth(month, -1)),
    suppliers, supply: { count: listed.length, total: listed.reduce((s, x) => s + x.contracts, 0), top }, hasMeasures: Boolean(m) };
}

const audit = (db, userId, key, value) => db.query(
  "INSERT INTO audit_log (user_id, action, table_name, record_key, new_value) VALUES ($1, 'update', 'zakat_tracker', $2, $3)",
  [userId, key, JSON.stringify(value)]);

// Save one week (any date → its Monday). Empty / 0 boxes clear that number.
async function saveWeek(db, user, branch, body, { today }) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(body.week || '')) return { error: 'Pick the week.' };
  const monday = calc.weekStart(body.week);
  if (monday > calc.weekStart(today)) return { error: 'That week hasn’t started yet.' };
  if (!anyWeek(user) && monday < calc.addDays(calc.weekStart(today), -7 * BACK_WEEKS)) return { error: `Weeks older than ${BACK_WEEKS} weeks – ask HQ to change them.` };
  const v = { zclaim: r2(num(body.claimed)), zpaid: r2(num(body.paid)), zbid: Math.round(num(body.bids)), zwon: Math.round(num(body.won)) };
  if (v.zwon > v.zbid) return { error: 'Contracts won can’t be more than contracts bid on.' };
  await db.transaction(async (tx) => {
    // 3 Nov: the weekly check-in mark (zchk = 1) – saved even when every number is 0.
    await tx.query(`INSERT INTO daily_entries (branch_id, entry_date, field_key, value, entered_by, updated_at) VALUES ($1, $2, 'zchk', 1, $3, now())
      ON CONFLICT (branch_id, entry_date, field_key) DO UPDATE SET entered_by = EXCLUDED.entered_by, updated_at = now()`, [branch.id, monday, user.id]);
    for (const k of KEYS) {
      if (!v[k]) await tx.query('DELETE FROM daily_entries WHERE branch_id = $1 AND entry_date = $2 AND field_key = $3', [branch.id, monday, k]);
      else await tx.query(`INSERT INTO daily_entries (branch_id, entry_date, field_key, value, entered_by, updated_at) VALUES ($1, $2, $3, $4, $5, now())
        ON CONFLICT (branch_id, entry_date, field_key) DO UPDATE SET value = EXCLUDED.value, entered_by = EXCLUDED.entered_by, updated_at = now()`, [branch.id, monday, k, v[k], user.id]);
    }
  });
  await audit(db, user.id, `${branch.code} week of ${monday}`, v);
  return { ok: `Saved the week of ${new Date(`${monday}T00:00:00Z`).toLocaleDateString('en-GB', { timeZone: 'UTC', day: 'numeric', month: 'short' })}.`, monday };
}

async function deleteWeek(db, user, branch, week, { today }) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(week || '')) return { error: 'Pick the week.' };
  const monday = calc.weekStart(week);
  if (!anyWeek(user) && monday < calc.addDays(calc.weekStart(today), -7 * BACK_WEEKS)) return { error: `Weeks older than ${BACK_WEEKS} weeks – ask HQ to change them.` };
  await db.query('DELETE FROM daily_entries WHERE branch_id = $1 AND entry_date = $2 AND field_key = ANY($3)', [branch.id, monday, [...KEYS, 'zchk']]);
  await audit(db, user.id, `${branch.code} week of ${monday}`, { deleted: true });
  return { ok: 'Week deleted.' };
}

// The month's amount to claim = ZC1's target for that month.
async function saveTarget(db, user, branch, month, value) {
  if (!/^\d{4}-\d{2}$/.test(month || '')) return { error: 'Pick the month.' };
  const m = await zc1(db, branch.id);
  if (!m) return { error: 'The zakat claims measure isn’t set up for this branch.' };
  const v = r2(num(value));
  if (v) await db.query('INSERT INTO measure_targets (measure_id, month, target) VALUES ($1, $2, $3) ON CONFLICT (measure_id, month) DO UPDATE SET target = EXCLUDED.target', [m.id, month, v]);
  else await db.query('DELETE FROM measure_targets WHERE measure_id = $1 AND month = $2', [m.id, month]);
  await audit(db, user.id, `${branch.code} amount to claim ${month}`, { target: v || null });
  return { ok: v ? 'Amount to claim saved.' : 'Amount to claim cleared.' };
}

async function saveSuppliers(db, user, branch, body) {
  await db.transaction(async (tx) => {
    for (let i = 1; i <= SUP_ROWS; i++) {
      const name = String(body[`name${i}`] || '').trim().slice(0, 80);
      const n = Math.round(num(body[`n${i}`]));
      if (!name && !n) await tx.query('DELETE FROM zakat_suppliers WHERE branch_id = $1 AND slot = $2', [branch.id, i]);
      else await tx.query(`INSERT INTO zakat_suppliers (branch_id, slot, name, contracts, updated_by, updated_at) VALUES ($1, $2, $3, $4, $5, now())
        ON CONFLICT (branch_id, slot) DO UPDATE SET name = EXCLUDED.name, contracts = EXCLUDED.contracts, updated_by = EXCLUDED.updated_by, updated_at = now()`, [branch.id, i, name, n, user.id]);
    }
  });
  await audit(db, user.id, `${branch.code} suppliers holding up supply`, { rows: SUP_ROWS });
  return { ok: 'Supplier list saved.' };
}

// 3 Nov (CEO): "zakat to check in once a week … ensure the PIC of zakat updates that part once a week".
// Each Monday the PIC (owner of ZC1) keys in last week (claimed, paid, bids – 0 is fine). Returns the
// PIC and whether last week is done (who, when). Due Monday; late from Tuesday (src/lib/needs.js).
async function checkin(db, branch, today) {
  const lastWeek = calc.addDays(calc.weekStart(today), -7);
  const pic = (await db.query(`SELECT m.owner_name, m.person_id, u.id AS user_id FROM measures m LEFT JOIN users u ON u.person_id = m.person_id AND u.active
    WHERE m.branch_id = $1 AND m.code = 'ZC1' AND m.active LIMIT 1`, [branch.id])).rows[0] || null;
  const d = (await db.query(`SELECT e.updated_at, u.display_name FROM daily_entries e LEFT JOIN users u ON u.id = e.entered_by
    WHERE e.branch_id = $1 AND e.entry_date = $2 AND e.field_key = 'zchk'`, [branch.id, lastWeek])).rows[0] || null;
  return { lastWeek, pic, done: d ? { at: d.updated_at, by: d.display_name } : null, late: !d && calc.weekStart(today) !== today };
}

// One time: hidden daily fields, measures ZC1–ZC3 and the old zakat leads retired, per branch.
const OLD = {
  BR: { measures: ['A6', 'A7'], fields: ['zko', 'zkc', 'zko2w', 'zkc7d'] },
  WM: { measures: ['W7'], fields: ['zkc', 'zkc7d'] },
  JH: { measures: ['F6'], fields: ['zko', 'zkc', 'zko2w', 'zkc7d'] },
};
async function checkinFieldOnce(db) {
  if ((await db.query("SELECT 1 FROM app_settings WHERE key = 'zakat_checkin_v1'")).rows.length) return;
  for (const code of BRANCHES) {
    await db.query(`INSERT INTO daily_fields (branch_id, key, label, owner_name, person_id, type, sort_order, active)
      SELECT b.id, 'zchk', 'Zakat weekly check-in done', m.owner_name, m.person_id, 'count', 999, false FROM branches b
      JOIN measures m ON m.branch_id = b.id AND m.code = 'ZC1' WHERE b.code = $1 ON CONFLICT (branch_id, key) DO NOTHING`, [code]);
  }
  await db.query("INSERT INTO app_settings (key, value) VALUES ('zakat_checkin_v1', $1)", [new Date().toISOString()]);
}

async function setupOnce(db, log = () => {}) {
  try { await setupTracker(db, log); } finally { await checkinFieldOnce(db); }
}

async function setupTracker(db, log) {
  const flag = 'zakat_tracker_v1';
  if ((await db.query('SELECT 1 FROM app_settings WHERE key = $1', [flag])).rows.length) return;
  await db.transaction(async (tx) => {
    for (const code of BRANCHES) {
      const b = (await tx.query('SELECT id FROM branches WHERE code = $1', [code])).rows[0];
      if (!b) continue;
      const old = OLD[code];
      // Owner: whoever owned the old zakat claims lead (else the zakat sales box).
      const own = (await tx.query(`SELECT owner_name, person_id FROM measures WHERE branch_id = $1 AND code = ANY($2) ORDER BY code DESC LIMIT 1`, [b.id, old.measures])).rows[0]
        || (await tx.query("SELECT owner_name, person_id FROM daily_fields WHERE branch_id = $1 AND key = 'zakat'", [b.id])).rows[0] || { owner_name: 'Team', person_id: null };
      let sort = Number((await tx.query('SELECT max(sort_order) AS m FROM daily_fields WHERE branch_id = $1', [b.id])).rows[0].m) || 0;
      for (const f of FIELDS) {
        await tx.query(`INSERT INTO daily_fields (branch_id, key, label, owner_name, person_id, type, sort_order, active) VALUES ($1,$2,$3,$4,$5,$6,$7,false)
          ON CONFLICT (branch_id, key) DO NOTHING`, [b.id, f.key, f.label, own.owner_name, own.person_id, f.type, ++sort]);
      }
      let ms = Number((await tx.query('SELECT max(sort_order) AS m FROM measures WHERE branch_id = $1', [b.id])).rows[0].m) || 0;
      const add = async (m) => {
        const r = await tx.query(`INSERT INTO measures (branch_id, code, owner_name, person_id, label, kind, unit, target_per, calc, numerator_field, denominator_field, note, sort_order, score_by)
          VALUES ($1,$2,$3,$4,$5,$6,$7,'month',$8,$9,$10,$11,$12,'month') ON CONFLICT (branch_id, code) DO NOTHING RETURNING id`,
        [b.id, m.code, own.owner_name, own.person_id, m.label, m.kind, m.unit, m.calc, m.num, m.den || null, m.note, ++ms]);
        return r.rows[0] ? r.rows[0].id : null;
      };
      const zc1Id = await add({ code: 'ZC1', label: 'Zakat claimed vs amount to claim', kind: 'Lead', unit: 'RM', calc: 'sum', num: 'zclaim',
        note: 'Zakat claims tracker (CEO, 3 Nov): RM claimed each week, keyed in on Zakat claims; target = the month’s amount to claim.' });
      await add({ code: 'ZC2', label: 'Zakat payment received', kind: 'Stream', unit: 'RM', calc: 'sum', num: 'zpaid', note: 'Zakat claims tracker: payments received from zakat each week.' });
      await add({ code: 'ZC3', label: 'Zakat contracts won (of bids)', kind: 'Routine', unit: '% won', calc: 'ratio_percent', num: 'zwon', den: 'zbid', note: 'Zakat claims tracker: contracts won ÷ contracts bid on.' });
      // Start the amount to claim at the zakat sales target (managers / HQ change it on the tracker).
      if (zc1Id) {
        await tx.query(`INSERT INTO measure_targets (measure_id, month, target)
          SELECT $1, t.month, t.target FROM measure_targets t JOIN measures s ON s.id = t.measure_id
          WHERE s.branch_id = $2 AND s.numerator_field = 'zakat' AND s.active AND t.month >= '2026-11' AND t.target IS NOT NULL
          ON CONFLICT DO NOTHING`, [zc1Id, b.id]);
      }
      await tx.query('UPDATE measures SET active = false WHERE branch_id = $1 AND code = ANY($2)', [b.id, old.measures]);
      await tx.query('UPDATE daily_fields SET active = false WHERE branch_id = $1 AND key = ANY($2)', [b.id, old.fields]);
      await tx.query("INSERT INTO audit_log (action, table_name, record_key, new_value) VALUES ('seed', 'measures', $1, NULL)",
        [`${code}: zakat claims tracker (CEO, 3 Nov) – ZC1 claimed vs amount to claim, ZC2 payment received, ZC3 contracts won; old zakat leads ${old.measures.join(', ')} retired`]);
    }
    await tx.query('INSERT INTO app_settings (key, value) VALUES ($1, $2)', [flag, new Date().toISOString()]);
  });
  log('Zakat claims tracker set up for BR, WM and JH.');
}

module.exports = { BRANCHES, FIELDS, KEYS, SUP_ROWS, BACK_WEEKS, isZakatBranch, canSee, canTarget, anyWeek, timeline, addMonth,
  loadTracker, checkin, saveWeek, deleteWeek, saveTarget, saveSuppliers, setupOnce };
