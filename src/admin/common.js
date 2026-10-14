// Shared bits for the Admin screens: who may use them, the audit log, number parsing.

function requireAdmin(req, res, next) {
  if (req.user && req.user.role === 'admin') return next();
  res.status(403).render('message', { title: 'Admin only', message: 'Only admin can change targets, people and measures.' });
}

// Every Admin change goes through here. `db` may be a transaction.
async function audit(db, user, action, table, recordKey, oldValue, newValue) {
  await db.query(
    `INSERT INTO audit_log (user_id, action, table_name, record_key, old_value, new_value)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [user ? user.id : null, action, table, recordKey,
      oldValue === undefined || oldValue === null ? null : JSON.stringify(oldValue),
      newValue === undefined || newValue === null ? null : JSON.stringify(newValue)]
  );
}

// Typed text → number, null (blank) or an error message.
function parseOptional(text, { min = 0, max = 100_000_000 } = {}) {
  const s = String(text ?? '').trim().replace(/,/g, '').replace(/%$/, '').replace(/^RM\s*/i, '');
  if (s === '') return { value: null };
  if (!/^-?\d*\.?\d+$/.test(s)) return { error: 'numbers only' };
  const n = Number(s);
  if (n < min) return { error: `can’t be below ${min}` };
  if (n > max) return { error: 'too big' };
  return { value: n };
}

const num = (v) => (v === null || v === undefined ? null : Number(v));
const sameNumber = (a, b) => (a === null && b === null) || (a !== null && b !== null && Math.abs(a - b) < 1e-9);

// Redirect back with a short message shown at the top of the page.
function back(res, path, { ok, err, error } = {}) {
  err = err || error;
  const sep = path.includes('?') ? '&' : '?';
  const qs = ok ? `ok=${encodeURIComponent(ok)}` : err ? `err=${encodeURIComponent(err)}` : '';
  res.redirect(qs ? `${path}${sep}${qs}` : path);
}

const slug = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');

module.exports = { requireAdmin, audit, parseOptional, num, sameNumber, back, slug };
