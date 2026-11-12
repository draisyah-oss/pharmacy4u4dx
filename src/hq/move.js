// 12 Nov (CEO): HQ moves from Wangsa Maju to Pharmacy4U Ampang. One milestone with a step checklist
// (owner + due date per step) on Projects, so every owner sees their steps in "Needs you"; Mazlina
// (Ampang branch manager) owns Ampang's steps and sees them too. A card at the top of 📣 News shows
// everyone the key dates, a countdown and how many steps are done (worked out from the checklist).
// Dates and owners as the CEO confirmed on 12 Nov: unpack 19 Nov, stock take 17 Nov, pack by 18 Nov,
// HR team = Iman + Hanin, inventory team = Alia, Syarafana, Fariz (+ his twin Farin), keys = Alia.

const PROJECT = 'HQ move to Ampang';
const MILESTONE = 'HQ moves from Wangsa Maju to Ampang';
const OWNER = 'Hanin, with Iman';
const START = '2026-11-12';
const DUE = '2026-11-30';
const SHOW = { from: '2026-11-12', until: '2026-11-30' };
const LAYOUT = '/img/hq-move-ampang-layout.jpg';

const STEPS = [
  { phase: '1 · Get ready (by 18 Nov)', step: 'Decide what HQ brings to Ampang and what to sell', owner: 'Iman', due: '2026-11-16' },
  { phase: '1 · Get ready (by 18 Nov)', step: 'Ampang: give space for HQ', owner: 'Mazlina', due: '2026-11-17' },
  { phase: '1 · Get ready (by 18 Nov)', step: 'Stock take at HQ', owner: 'Alia, with Syarafana, Fariz', due: '2026-11-17' },
  { phase: '1 · Get ready (by 18 Nov)', step: 'Ampang: watch the repairman until the work is done', owner: 'Mazlina', due: '2026-11-18' },
  { phase: '1 · Get ready (by 18 Nov)', step: 'Finish the maintenance at Ampang', owner: 'Iman, with Hanin', due: '2026-11-18' },
  { phase: '1 · Get ready (by 18 Nov)', step: 'Ampang: clear the back and move the shelves (sell shelves if needed)', owner: 'Mazlina', due: '2026-11-18' },
  { phase: '1 · Get ready (by 18 Nov)', step: 'Pack and tidy HQ stock (with Farin and the cleaner)', owner: 'Alia, with Syarafana, Fariz', due: '2026-11-18' },
  { phase: '1 · Get ready (by 18 Nov)', step: 'Take up the HQ carpet', owner: 'Iman, with Hanin', due: '2026-11-18' },
  { phase: '1 · Get ready (by 18 Nov)', step: 'Clean and pack the pantry', owner: 'Iman, with Hanin', due: '2026-11-18' },
  { phase: '1 · Get ready (by 18 Nov)', step: 'Book the Lalamove for 19 Nov: vehicle size and time', owner: 'Syarafana', due: '2026-11-18' },
  { phase: '2 · Move day (19 Nov)', step: 'Lalamove: HQ → Ampang', owner: 'Alia, with Syarafana, Fariz', due: '2026-11-19' },
  { phase: '2 · Move day (19 Nov)', step: 'Unpack HQ at Ampang (HQ and Ampang team)', owner: 'Alia, with Hanin, Iman, Mazlina', due: '2026-11-19' },
  { phase: '3 · HQ open at Ampang (20 Nov)', step: 'HQ starts work at Ampang', owner: 'Hanin', due: '2026-11-20' },
  { phase: '4 · Close out (by 30 Nov)', step: 'Sell the remaining furniture; take the rest to Dr Aisyah’s office', owner: 'Iman, with Hanin', due: '2026-11-29' },
  { phase: '4 · Close out (by 30 Nov)', step: 'Hand the Wangsa Maju HQ keys to the owner', owner: 'Alia', due: '2026-11-30' },
];

const KEY_DATES = [
  { date: '2026-11-17', text: 'Stock take at HQ · Ampang gives space' },
  { date: '2026-11-18', text: 'Everything packed · Ampang ready' },
  { date: '2026-11-19', text: 'Move day: Lalamove and unpacking at Ampang' },
  { date: '2026-11-20', text: 'HQ starts work at Pharmacy4U Ampang' },
  { date: '2026-11-30', text: 'Wangsa Maju keys back to the owner' },
];

async function setupOnce(db, log = () => {}) {
  const flag = 'hq_move_ampang_v1';
  if ((await db.query('SELECT 1 FROM app_settings WHERE key = $1', [flag])).rows.length) return;
  const { insertSeedSteps } = require('./team');
  await db.transaction(async (tx) => {
    let p = (await tx.query('SELECT id FROM hq_projects WHERE milestone = $1 AND active', [MILESTONE])).rows[0];
    if (!p) {
      const order = (await tx.query('SELECT COALESCE(MAX(sort_order), 0) + 1 AS n FROM hq_projects')).rows[0].n;
      p = (await tx.query(
        `INSERT INTO hq_projects (project, milestone, owner, start_date, due_date, status, notes, sort_order)
         VALUES ($1, $2, $3, $4, $5, 'In progress', $6, $7) RETURNING id`,
        [PROJECT, MILESTONE, OWNER, START, DUE, 'CEO 12 Nov. Move 19 Nov, HQ open at Ampang 20 Nov, keys back 30 Nov.', order])).rows[0];
      await insertSeedSteps(tx, p.id, STEPS);
    }
    await tx.query("INSERT INTO audit_log (action, table_name, record_key, new_value) VALUES ('seed', 'hq_projects', $1, NULL)",
      [`${MILESTONE} – ${STEPS.length} steps (CEO, 12 Nov)`]);
    await tx.query('INSERT INTO app_settings (key, value) VALUES ($1, $2)', [flag, new Date().toISOString()]);
  });
  log('HQ move to Ampang: milestone and steps added.');
}

const dayDiff = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);

// The News card: key dates, days to go, steps done (live from the checklist). Null outside its dates.
async function card(db, today) {
  if (today < SHOW.from || today > SHOW.until) return null;
  const p = (await db.query('SELECT id FROM hq_projects WHERE milestone = $1 AND active', [MILESTONE])).rows[0];
  if (!p) return null;
  const s = (await db.query(`SELECT count(*)::int AS total, count(*) FILTER (WHERE status = 'Done')::int AS done,
      count(*) FILTER (WHERE status <> 'Done' AND due_date < $2)::int AS late
    FROM hq_project_steps WHERE project_id = $1 AND active`, [p.id, today])).rows[0];
  const toMove = dayDiff(today, '2026-11-19');
  const headline = toMove > 1 ? `${toMove} days to move day` : toMove === 1 ? 'Move day is tomorrow' : toMove === 0 ? 'Move day is today'
    : today < '2026-11-20' ? '' : 'HQ now works from Ampang';
  return {
    id: p.id, headline, total: s.total, done: s.done, late: s.late, layout: LAYOUT,
    dates: KEY_DATES.map((d) => ({ ...d, past: d.date < today, today: d.date === today })),
  };
}

module.exports = { PROJECT, MILESTONE, STEPS, KEY_DATES, LAYOUT, setupOnce, card };
