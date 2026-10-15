// Login sessions, stored in the `sessions` table (works the same locally and on Railway).
// The browser only holds a long random id in an httpOnly cookie.

const crypto = require('crypto');

const COOKIE = 'p4u_sid';
const HOURS = 3600 * 1000;
// Staff log in quickly with a PIN, so their session is one working day.
// Managers, HQ and admin stay logged in for a week.
// Admin can change everything, so admin logins last 12 hours.
const LIFETIME = { branch_staff: 14 * HOURS, admin: 12 * HOURS, default: 7 * 24 * HOURS };

const randomId = () => crypto.randomBytes(32).toString('base64url');

function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function cookieHeader(value, { maxAgeMs, secure }) {
  const parts = [`${COOKIE}=${value}`, 'Path=/', 'HttpOnly', 'SameSite=Lax'];
  parts.push(maxAgeMs > 0 ? `Max-Age=${Math.floor(maxAgeMs / 1000)}` : 'Max-Age=0');
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

const isSecure = (req) => req.secure || process.env.NODE_ENV === 'production';

async function startSession(db, req, res, user) {
  const sid = randomId();
  const lifetime = LIFETIME[user.role] || LIFETIME.default;
  const data = { userId: user.id, csrf: randomId() };
  await db.query('INSERT INTO sessions (sid, data, expires) VALUES ($1, $2, $3)', [
    sid, JSON.stringify(data), new Date(Date.now() + lifetime).toISOString(),
  ]);
  res.setHeader('Set-Cookie', cookieHeader(sid, { maxAgeMs: lifetime, secure: isSecure(req) }));
}

async function endSession(db, req, res) {
  const sid = parseCookies(req.headers.cookie)[COOKIE];
  if (sid) await db.query('DELETE FROM sessions WHERE sid = $1', [sid]);
  res.setHeader('Set-Cookie', cookieHeader('', { maxAgeMs: 0, secure: isSecure(req) }));
}

// Middleware: puts the logged-in user (or null) on req.user and res.locals.user.
function loadUser(db) {
  return async (req, res, next) => {
    req.user = null;
    try {
      const sid = parseCookies(req.headers.cookie)[COOKIE];
      if (sid) {
        const { rows } = await db.query(
          `SELECT s.data, u.id, u.username, u.display_name, u.role, u.branch_id, u.person_id, u.enters_all_hq,
                  b.code AS branch_code, b.name AS branch_name
           FROM sessions s
           JOIN users u ON u.id = (s.data->>'userId')::int AND u.active
           LEFT JOIN branches b ON b.id = u.branch_id
           WHERE s.sid = $1 AND s.expires > now()`,
          [sid]
        );
        if (rows.length) {
          const { data, ...user } = rows[0];
          req.user = user;
          req.csrfToken = data.csrf;
          req.sessionId = sid;
        }
      }
    } catch (err) {
      return next(err);
    }
    res.locals.user = req.user;
    res.locals.csrfToken = req.csrfToken || '';
    next();
  };
}

function requireLogin(req, res, next) {
  if (!req.user) return res.redirect(`/login?next=${encodeURIComponent(req.originalUrl)}`);
  next();
}

// Every POST made while logged in must carry the session's form token.
function checkCsrf(req, res, next) {
  if (!req.user || (req.body && req.body._csrf === req.csrfToken)) return next();
  res.status(403).render('message', {
    title: 'Page expired',
    message: 'This page was open too long or came from somewhere else. Go back, reload and try again.',
  });
}

async function clearExpiredSessions(db) {
  await db.query('DELETE FROM sessions WHERE expires < now()');
}

module.exports = {
  COOKIE, startSession, endSession, loadUser, requireLogin, checkCsrf, clearExpiredSessions, parseCookies,
};
