// Login and logout.
//   Branch staff: pick branch → pick your name → 4-digit PIN.
//   Managers, HQ, admin: username + password.
// After 5 wrong tries a login is locked for 15 minutes (a 4-digit PIN can't be guessed).

const express = require('express');
const bcrypt = require('bcryptjs');
const { startSession, endSession } = require('./sessions');

const MAX_TRIES = 5;
const LOCK_MINUTES = 15;

const { safePath } = require('../lib/safe-path');

// Only allow redirects to our own pages.
const safeNext = (next) => safePath(next, '/');

// A second lock per device: 30 wrong tries in 15 minutes from one IP address blocks that
// device for a while, so nobody can work through PINs across many logins.
const IP_WINDOW_MS = 15 * 60 * 1000;
const IP_MAX_FAILS = 30;
const ipFails = new Map(); // ip -> [timestamps]
function ipBlocked(ip, now = Date.now()) {
  const list = (ipFails.get(ip) || []).filter((t) => now - t < IP_WINDOW_MS);
  ipFails.set(ip, list);
  return list.length >= IP_MAX_FAILS;
}
function ipFailed(ip, now = Date.now()) {
  const list = (ipFails.get(ip) || []).filter((t) => now - t < IP_WINDOW_MS);
  list.push(now);
  ipFails.set(ip, list);
  if (ipFails.size > 10000) ipFails.clear(); // never let this grow without limit
}

function loginRoutes(db) {
  const router = express.Router();

  async function branches() {
    return (await db.query('SELECT id, code, name FROM branches WHERE active ORDER BY sort_order')).rows;
  }

  async function renderLogin(req, res, { status = 200, error = null, username = '' } = {}) {
    const next = safeNext(req.query.next || req.body?.next);
    const mode = req.query.mode || req.body?.mode;
    const allBranches = await branches();
    const branch = allBranches.find((b) => b.code === (req.query.branch || req.body?.branch)) || null;

    let staff = [];
    let picked = null;
    if (branch) {
      staff = (await db.query(
        `SELECT u.username, u.display_name, p.role AS job, u.pin_hash IS NOT NULL AS ready
         FROM users u JOIN people p ON p.id = u.person_id
         WHERE u.branch_id = $1 AND u.role = 'branch_staff' AND u.active
         ORDER BY p.sort_order`,
        [branch.id]
      )).rows;
      const who = req.query.user || req.body?.username;
      picked = staff.find((s) => s.username === who && s.ready) || null;
    }

    res.status(status).render('login', {
      title: 'Log in',
      mode: mode === 'password' ? 'password' : picked ? 'pin' : branch ? 'names' : 'branches',
      branches: allBranches, branch, staff, picked, error, username, next,
    });
  }

  router.get('/login', async (req, res, next) => {
    try {
      if (req.user) return res.redirect('/');
      await renderLogin(req, res);
    } catch (err) { next(err); }
  });

  // Shared check for PIN and password logins.
  async function attempt(req, res, { username, secret, kind }) {
    if (ipBlocked(req.ip)) {
      return { error: 'Too many wrong tries from this device. Wait 15 minutes, or ask admin for help.' };
    }
    const { rows } = await db.query(
      `SELECT id, username, role, password_hash, pin_hash, failed_attempts, locked_until
       FROM users WHERE username = $1 AND active`,
      [String(username || '').trim().toLowerCase()]
    );
    const user = rows[0];
    const wrong = kind === 'pin' ? 'That PIN is not right. Try again.' : 'Username or password is not right.';

    if (!user) { ipFailed(req.ip); return { error: wrong }; }
    if (user.locked_until && new Date(user.locked_until) > new Date()) {
      const mins = Math.ceil((new Date(user.locked_until) - new Date()) / 60000);
      return { error: `Too many wrong tries. This login opens again in ${mins} minute${mins === 1 ? '' : 's'}, or ask admin to reset it.` };
    }

    const hash = kind === 'pin' ? user.pin_hash : user.password_hash;
    const roleOk = kind === 'pin' ? user.role === 'branch_staff' : user.role !== 'branch_staff' || !user.pin_hash;
    const ok = Boolean(hash) && roleOk && bcrypt.compareSync(String(secret || ''), hash);

    if (!ok) {
      ipFailed(req.ip);
      const tries = user.failed_attempts + 1;
      const lock = tries >= MAX_TRIES;
      await db.query(
        `UPDATE users SET failed_attempts = $2,
           locked_until = CASE WHEN $3 THEN now() + make_interval(mins => ${LOCK_MINUTES}) ELSE locked_until END
         WHERE id = $1`,
        [user.id, lock ? 0 : tries, lock]
      );
      await db.query(
        `INSERT INTO audit_log (user_id, action, table_name, record_key) VALUES ($1, $2, 'users', $3)`,
        [user.id, lock ? 'login_locked' : 'login_failed', user.username]
      );
      if (lock) return { error: `Too many wrong tries. This login is locked for ${LOCK_MINUTES} minutes.` };
      return { error: wrong };
    }

    await db.query('UPDATE users SET failed_attempts = 0, locked_until = NULL, last_login_at = now() WHERE id = $1', [user.id]);
    await db.query(
      `INSERT INTO audit_log (user_id, action, table_name, record_key) VALUES ($1, 'login', 'users', $2)`,
      [user.id, user.username]
    );
    await startSession(db, req, res, user);
    return { ok: true };
  }

  router.post('/login/pin', async (req, res, next) => {
    try {
      const result = await attempt(req, res, { username: req.body.username, secret: req.body.pin, kind: 'pin' });
      if (result.ok) return res.redirect(safeNext(req.body.next));
      await renderLogin(req, res, { status: 401, error: result.error });
    } catch (err) { next(err); }
  });

  router.post('/login/password', async (req, res, next) => {
    try {
      const result = await attempt(req, res, { username: req.body.username, secret: req.body.password, kind: 'password' });
      if (result.ok) return res.redirect(safeNext(req.body.next));
      await renderLogin(req, res, { status: 401, error: result.error, username: req.body.username });
    } catch (err) { next(err); }
  });

  router.post('/logout', async (req, res, next) => {
    try {
      if (req.user) {
        await db.query(
          `INSERT INTO audit_log (user_id, action, table_name, record_key) VALUES ($1, 'logout', 'users', $2)`,
          [req.user.id, req.user.username]
        );
      }
      await endSession(db, req, res);
      res.redirect('/login');
    } catch (err) { next(err); }
  });

  return router;
}

module.exports = { loginRoutes, safeNext, MAX_TRIES, IP_MAX_FAILS, _ipFails: ipFails };
