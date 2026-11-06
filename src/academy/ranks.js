// Academy game: levels, streak + bonuses, badges, weekly ranking. All worked out from what people did.
// Rewards good process only (learning, asking, checking, referring, logging) – never sales or basket size.
const { XP } = require('./data');

const LEVELS = [
  { n: 1, name: 'Trainee', from: 0, cheer: 'Welcome aboard. Every step counts.' },
  { n: 2, name: 'Rising Star', from: 300, cheer: 'Terbaik! You are a Rising Star ⭐' },
  { n: 3, name: 'Counter Pro', from: 800, cheer: 'Customers are lucky to have you at the counter.' },
  { n: 4, name: 'Pharmacy Hero', from: 1500, cheer: 'A true Pharmacy Hero. Syabas!' },
  { n: 5, name: 'Master (Guru Farmasi)', from: 2400, cheer: 'Guru Farmasi! Others learn from you now.' },
];
const BONUS = { 3: 10, 5: 20 };
const WEEK_MODULE_CAP = 4;
const STOCK_GOAL = 10;
const SAFETY_GOAL = 3;

function levelOf(xp) {
  let cur = LEVELS[0];
  for (const l of LEVELS) if (xp >= l.from) cur = l;
  const next = LEVELS.find((l) => l.n === cur.n + 1) || null;
  return { ...cur, next, toNext: next ? next.from - xp : 0, pct: next ? Math.round(((xp - cur.from) / (next.from - cur.from)) * 100) : 100 };
}

const myDay = (d) => new Date(d).toLocaleDateString('en-CA', { timeZone: 'Asia/Kuala_Lumpur' });
const addDays = (iso, n) => { const d = new Date(`${iso}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const mondayOf = (iso) => { const wd = (new Date(`${iso}T00:00:00Z`).getUTCDay() + 6) % 7; return addDays(iso, -wd); };

// Everything dated that gives XP, plus the days a person was active.
async function awards(db, userIds) {
  const mods = new Map((await db.query('SELECT id, code, title FROM academy_modules')).rows.map((m) => [m.id, m]));
  const list = [];
  const days = new Map();
  const addDay = (u, d) => { if (!days.has(u)) days.set(u, new Set()); days.get(u).add(d); };
  const seen = new Set();
  const ev = (await db.query(
    'SELECT user_id, module_id, event, passed, day FROM academy_progress WHERE user_id = ANY($1::int[]) ORDER BY created_at, id', [userIds])).rows;
  for (const e of ev) {
    addDay(e.user_id, e.day);
    const kind = e.event === 'quiz' ? (e.passed ? 'quiz' : null) : e.event;
    if (!kind) continue;
    const k = `${e.user_id}:${e.module_id}:${kind}`;
    if (seen.has(k)) continue;
    seen.add(k);
    list.push({ user: e.user_id, module: e.module_id, kind, xp: XP[kind], day: e.day });
  }
  const chs = (await db.query(
    'SELECT id, user_id, module_id, entry, created_at, verified, verified_at FROM academy_challenges WHERE user_id = ANY($1::int[]) ORDER BY created_at, id',
    [userIds])).rows;
  const logged = new Map();
  for (const c of chs) {
    addDay(c.user_id, myDay(c.created_at));
    const lk = `${c.user_id}:${c.module_id}`;
    if (!logged.has(lk)) logged.set(lk, myDay(c.created_at));
    if (!c.verified || !c.verified_at) continue;
    const k = `${c.user_id}:${c.module_id}:challenge`;
    if (seen.has(k)) continue;
    seen.add(k);
    list.push({ user: c.user_id, module: c.module_id, kind: 'challenge', xp: XP.challenge, day: myDay(c.verified_at), challengeId: c.id });
  }
  // Streak bonuses: +10 at 3 days in a row, +20 at 5, each once per week.
  for (const [u, set] of days) {
    const sorted = [...set].sort();
    let run = 0; const got = new Set();
    sorted.forEach((d, i) => {
      run = i > 0 && addDays(sorted[i - 1], 1) === d ? run + 1 : 1;
      const xp = BONUS[run];
      const key = `${mondayOf(d)}:${run}`;
      if (xp && !got.has(key)) { got.add(key); list.push({ user: u, kind: 'streak', xp, day: d, run }); }
    });
  }
  return { list, days, chs, logged, mods, ev };
}

// Days in a row counted back from today (or yesterday if nothing yet today).
// Shift rosters are not in the app, so calendar days are counted and staff are told.
function streakOf(daySet, today) {
  if (!daySet) return 0;
  let d = daySet.has(today) ? today : addDays(today, -1);
  let n = 0;
  while (daySet.has(d)) { n += 1; d = addDays(d, -1); }
  return n;
}
const bestRun = (daySet) => {
  const s = [...(daySet || [])].sort(); let best = 0; let run = 0;
  s.forEach((d, i) => { run = i > 0 && addDays(s[i - 1], 1) === d ? run + 1 : 1; best = Math.max(best, run); });
  return best;
};

function summary(aw, userId, today) {
  const mine = aw.list.filter((a) => a.user === userId);
  const wk = mondayOf(today);
  const xp = mine.reduce((n, a) => n + a.xp, 0);
  // Weekly ranking score: XP this week; module XP counts for at most 4 modules a week.
  const thisWeek = mine.filter((a) => a.day >= wk);
  const modOrder = [...new Set(thisWeek.filter((a) => a.module).sort((a, b) => a.day.localeCompare(b.day)).map((a) => a.module))].slice(0, WEEK_MODULE_CAP);
  const week = thisWeek.filter((a) => !a.module || modOrder.includes(a.module)).reduce((n, a) => n + a.xp, 0);

  // Modules finished: cards + quiz pass + a logged challenge.
  const done = [];
  for (const [id, m] of aw.mods) {
    const ds = ['cards', 'quiz'].map((k) => mine.find((a) => a.module === id && a.kind === k)?.day);
    const lg = aw.logged.get(`${userId}:${id}`);
    if (ds[0] && ds[1] && lg) done.push({ id, code: m.code, title: m.title, day: [...ds, lg].sort().pop(), xp: mine.filter((a) => a.module === id).reduce((n, a) => n + a.xp, 0) });
  }
  const verifiedFor = (code) => aw.chs.filter((c) => c.user_id === userId && c.verified && aw.mods.get(c.module_id)?.code === code);
  const gaps = verifiedFor('5.1').reduce((n, c) => n + (Number(c.entry?.asked) || 0), 0);
  const refers = verifiedFor('1.5').filter((c) => c.entry?.red_flag === 'Yes' && c.entry?.referred === 'Yes');
  const set = aw.days.get(userId);
  const best = bestRun(set);
  const firstDay = (arr) => arr.map((x) => x.day).sort()[0];
  const konsDay = (() => { const s = [...(set || [])].sort(); let run = 0; for (let i = 0; i < s.length; i++) { run = i > 0 && addDays(s[i - 1], 1) === s[i] ? run + 1 : 1; if (run >= 5) return s[i]; } return null; })();
  const badges = [
    { key: 'first_spark', icon: '✨', name: 'First Spark', why: 'You finished your first module.', note: 'Finish your first module', earned: done.length > 0, date: firstDay(done), progress: `${Math.min(done.length, 1)} of 1 module` },
    { key: 'konsisten', icon: '🔥', name: 'Konsisten', why: 'You learned 5 days in a row.', note: '5 days in a row', earned: best >= 5, date: konsDay, progress: `${Math.min(best, 5)} of 5 days` },
    { key: 'stock_hero', icon: '📦', name: 'Stock Hero', why: 'You logged 10 stock gaps, confirmed by your manager.', note: '10 stock gaps logged, confirmed by the manager', earned: gaps >= STOCK_GOAL, date: null, progress: `${Math.min(gaps, STOCK_GOAL)} of ${STOCK_GOAL} gaps` },
    { key: 'safety_first', icon: '🛡️', name: 'Safety First', why: 'You correctly referred 3 red-flag customers.', note: 'Refer 3 red-flag customers, confirmed', earned: refers.length >= SAFETY_GOAL, date: null, progress: `${Math.min(refers.length, SAFETY_GOAL)} of ${SAFETY_GOAL} referrals` },
  ];
  return { xp, week, streak: streakOf(set, today), best, level: levelOf(xp), badges, done, bonuses: mine.filter((a) => a.kind === 'streak'), verified: mine.filter((a) => a.kind === 'challenge') };
}

// Celebrations a person has earned (checked against what they were already shown).
function celebrations(sum, aw) {
  const out = [];
  for (const l of LEVELS) if (l.n > 1 && sum.xp >= l.from) out.push({ kind: 'level', key: String(l.n), level: l });
  for (const b of sum.badges) if (b.earned) out.push({ kind: 'badge', key: b.key, badge: b });
  for (const s of sum.bonuses) out.push({ kind: 'streak', key: `${s.day}:${s.run}`, run: s.run, xp: s.xp });
  for (const d of sum.done) out.push({ kind: 'module', key: d.code, mod: d });
  for (const v of sum.verified) out.push({ kind: 'verified', key: String(v.challengeId), title: aw.mods.get(v.module)?.title, xp: v.xp });
  return out;
}
const ORDER = { verified: 1, module: 2, streak: 3, badge: 4, level: 5 };

module.exports = { LEVELS, levelOf, awards, summary, streakOf, mondayOf, addDays, celebrations, ORDER };
