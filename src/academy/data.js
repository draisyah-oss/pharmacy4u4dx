// Academy data: loading modules, what a person has done, and XP.
// XP (trial): cards 5, quiz pass 15, role-play 10, Counter Challenge 50 once the manager verifies it.

const { MODULES } = require('./content');

const XP = { cards: 5, quiz: 15, roleplay: 10, challenge: 50 };

// Adds any module from content.js that is not in the database yet. Never overwrites edits.
async function ensureModules(db) {
  for (const m of MODULES) {
    await db.query(
      `INSERT INTO academy_modules (code, title, track, minutes, source, sort_order, cards, questions, roleplay, challenge)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT (code) DO NOTHING`,
      [m.code, m.title, m.track, m.minutes, m.source, m.sort_order,
        JSON.stringify(m.cards), JSON.stringify(m.questions), JSON.stringify(m.roleplay), JSON.stringify(m.challenge)]);
  }
}

const listModules = async (db) =>
  (await db.query('SELECT * FROM academy_modules WHERE published ORDER BY sort_order, id')).rows;

const getModule = async (db, code) =>
  (await db.query('SELECT * FROM academy_modules WHERE code = $1 AND published', [code])).rows[0] || null;

// Everything one person has done, grouped by module id.
async function progressFor(db, userIds) {
  const ev = (await db.query(
    'SELECT * FROM academy_progress WHERE user_id = ANY($1::int[]) ORDER BY created_at, id', [userIds])).rows;
  const ch = (await db.query(
    'SELECT * FROM academy_challenges WHERE user_id = ANY($1::int[]) ORDER BY created_at, id', [userIds])).rows;
  const out = new Map();
  const slot = (u, m) => {
    const k = `${u}:${m}`;
    if (!out.has(k)) out.set(k, { cards: false, quizPassed: false, quizBest: null, lastQuiz: null, roleplay: false, challenges: [] });
    return out.get(k);
  };
  for (const e of ev) {
    const s = slot(e.user_id, e.module_id);
    if (e.event === 'cards') s.cards = true;
    if (e.event === 'roleplay') s.roleplay = true;
    if (e.event === 'quiz') {
      if (e.passed) s.quizPassed = true;
      if (!s.quizBest || e.score > s.quizBest.score) s.quizBest = { score: e.score, total: e.total };
      s.lastQuiz = e;
    }
  }
  for (const c of ch) slot(c.user_id, c.module_id).challenges.push(c);
  return { get: (u, m) => slot(u, m), all: out };
}

const isDone = (s) => s.cards && s.quizPassed && s.challenges.length > 0;

function xpOf(s) {
  return (s.cards ? XP.cards : 0) + (s.quizPassed ? XP.quiz : 0) + (s.roleplay ? XP.roleplay : 0)
    + (s.challenges.some((c) => c.verified) ? XP.challenge : 0);
}

async function userXp(db, userId, modules) {
  const prog = await progressFor(db, [userId]);
  return modules.reduce((sum, m) => sum + xpOf(prog.get(userId, m.id)), 0);
}

const record = (db, userId, moduleId, event, day, extra = {}) => db.query(
  `INSERT INTO academy_progress (user_id, module_id, event, day, score, total, passed) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
  [userId, moduleId, event, day, extra.score ?? null, extra.total ?? null, extra.passed ?? null]);

module.exports = { XP, ensureModules, listModules, getModule, progressFor, isDone, xpOf, userXp, record };
