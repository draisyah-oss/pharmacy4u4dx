// Admin → People & logins: add, rename, deactivate; set PINs (branch staff) and passwords
// (managers, HQ, admin); unlock logins after too many wrong tries.

const bcrypt = require('bcryptjs');
const { audit, slug } = require('./common');

const LOGIN_ROLES = { branch: ['branch_staff', 'branch_manager'], hq: ['hq'] };

async function loadPeople(db, branch) {
  const where = branch ? 'p.branch_id = $1' : 'p.branch_id IS NULL';
  const { rows } = await db.query(
    `SELECT p.id, p.name, p.role AS job, p.active, p.sort_order,
            u.id AS user_id, u.username, u.role AS login_role, u.active AS login_active,
            u.pin_hash IS NOT NULL AS has_pin, u.password_hash IS NOT NULL AS has_password,
            u.locked_until > now() AS locked, u.last_login_at
     FROM people p LEFT JOIN users u ON u.person_id = p.id
     WHERE ${where} ORDER BY p.active DESC, p.sort_order, p.name`,
    branch ? [branch.id] : []
  );
  return rows;
}

async function adminUser(db) {
  return (await db.query("SELECT id, username, last_login_at FROM users WHERE role = 'admin' ORDER BY id LIMIT 1")).rows[0];
}

async function usernameFree(db, username, exceptUserId = null) {
  const { rows } = await db.query('SELECT id FROM users WHERE username = $1 AND id IS DISTINCT FROM $2', [username, exceptUserId]);
  return rows.length === 0;
}

async function addPerson(db, { branch, body, user }) {
  const name = String(body.name || '').trim();
  const job = String(body.job || '').trim();
  const loginRole = branch ? (body.login_role === 'branch_manager' ? 'branch_manager' : 'branch_staff') : 'hq';
  if (!name) return { error: 'Type a name.' };
  if (!job) return { error: 'Type their job (e.g. Sales Assistant).' };
  let username = slug(body.username) || slug(name);
  if (!(await usernameFree(db, username))) username = `${username}.${slug(branch ? branch.code : 'hq')}`;
  if (!(await usernameFree(db, username))) return { error: `The username “${username}” is taken – type a different one.` };
  const dup = await db.query('SELECT 1 FROM people WHERE COALESCE(branch_id, 0) = $1 AND lower(name) = lower($2)', [branch ? branch.id : 0, name]);
  if (dup.rows.length) return { error: `${name} is already in this list.` };

  await db.transaction(async (tx) => {
    const order = (await tx.query('SELECT COALESCE(MAX(sort_order), 0) + 1 AS n FROM people WHERE COALESCE(branch_id, 0) = $1', [branch ? branch.id : 0])).rows[0].n;
    const person = (await tx.query(
      'INSERT INTO people (branch_id, name, role, sort_order) VALUES ($1, $2, $3, $4) RETURNING id',
      [branch ? branch.id : null, name, job, order])).rows[0];
    await tx.query(
      'INSERT INTO users (username, display_name, role, branch_id, person_id) VALUES ($1, $2, $3, $4, $5)',
      [username, name, loginRole, branch ? branch.id : null, person.id]);
    await audit(tx, user, 'insert', 'people', `${branch ? branch.code : 'HQ'} ${name}`, null, { name, job, username, login: loginRole });
  });
  return { ok: `Added ${name} (username ${username}). Set their ${loginRole === 'branch_staff' ? 'PIN' : 'password'} next.` };
}

// Rename / change job / username / staff↔manager. A new name is carried into the measures
// and daily fields that person owns, so their cards and scoreboard rows follow them.
async function updatePerson(db, { personId, body, user }) {
  const p = (await db.query(
    `SELECT p.*, u.id AS user_id, u.username, u.role AS login_role, b.code AS branch_code
     FROM people p LEFT JOIN users u ON u.person_id = p.id LEFT JOIN branches b ON b.id = p.branch_id WHERE p.id = $1`,
    [personId])).rows[0];
  if (!p) return { error: 'That person doesn’t exist.' };
  const name = String(body.name || '').trim() || p.name;
  const job = String(body.job || '').trim() || p.role;
  const username = slug(body.username) || p.username;
  const loginRole = p.branch_id ? (body.login_role === 'branch_manager' ? 'branch_manager' : body.login_role === 'branch_staff' ? 'branch_staff' : p.login_role) : 'hq';
  if (p.user_id && username !== p.username && !(await usernameFree(db, username, p.user_id))) return { error: `The username “${username}” is taken.` };
  if (name !== p.name) {
    const dup = await db.query('SELECT 1 FROM people WHERE COALESCE(branch_id, 0) = $1 AND lower(name) = lower($2) AND id <> $3', [p.branch_id || 0, name, p.id]);
    if (dup.rows.length) return { error: `There's already someone called ${name} here.` };
  }
  const where = p.branch_code || 'HQ';
  let changes = 0;

  await db.transaction(async (tx) => {
    if (name !== p.name || job !== p.role) {
      await tx.query('UPDATE people SET name = $2, role = $3 WHERE id = $1', [p.id, name, job]);
      if (name !== p.name) {
        await audit(tx, user, 'update', 'people', `${where} ${p.name} name`, p.name, name);
        if (p.branch_id) {
          await tx.query('UPDATE measures SET owner_name = $3 WHERE branch_id = $1 AND owner_name = $2', [p.branch_id, p.name, name]);
          await tx.query('UPDATE daily_fields SET owner_name = $3 WHERE branch_id = $1 AND owner_name = $2', [p.branch_id, p.name, name]);
        } else {
          await tx.query('UPDATE hq_measures SET owner_name = $2 WHERE owner_name = $1', [p.name, name]);
        }
        if (p.user_id) await tx.query('UPDATE users SET display_name = $2 WHERE id = $1', [p.user_id, name]);
        changes++;
      }
      if (job !== p.role) { await audit(tx, user, 'update', 'people', `${where} ${name} job`, p.role, job); changes++; }
    }
    if (p.user_id && username !== p.username) {
      await tx.query('UPDATE users SET username = $2 WHERE id = $1', [p.user_id, username]);
      await audit(tx, user, 'update', 'users', `${where} ${name} username`, p.username, username);
      changes++;
    }
    if (p.user_id && loginRole !== p.login_role) {
      // Staff use a PIN, managers a password: clear the old kind so they must be given the new one.
      await tx.query('UPDATE users SET role = $2, pin_hash = NULL, password_hash = NULL WHERE id = $1', [p.user_id, loginRole]);
      await tx.query("DELETE FROM sessions WHERE (data->>'userId')::int = $1", [p.user_id]);
      await audit(tx, user, 'update', 'users', `${where} ${name} login role`, p.login_role, loginRole);
      changes++;
    }
  });
  if (!changes) return { ok: 'No changes.' };
  return { ok: loginRole !== p.login_role ? `Saved. ${name} now needs a new ${loginRole === 'branch_staff' ? 'PIN' : 'password'}.` : `Saved changes to ${name}.` };
}

async function setActive(db, { personId, active, user }) {
  const p = (await db.query('SELECT p.*, b.code FROM people p LEFT JOIN branches b ON b.id = p.branch_id WHERE p.id = $1', [personId])).rows[0];
  if (!p) return { error: 'That person doesn’t exist.' };
  await db.transaction(async (tx) => {
    await tx.query('UPDATE people SET active = $2 WHERE id = $1', [p.id, active]);
    await tx.query('UPDATE users SET active = $2 WHERE person_id = $1', [p.id, active]);
    if (!active) await tx.query("DELETE FROM sessions WHERE (data->>'userId')::int IN (SELECT id FROM users WHERE person_id = $1)", [p.id]);
    await audit(tx, user, active ? 'reactivate' : 'deactivate', 'people', `${p.code || 'HQ'} ${p.name}`, !active, active);
  });
  if (active) return { ok: `${p.name} is active again and can log in.` };
  const owned = p.branch_id
    ? (await db.query("SELECT count(*)::int AS n FROM measures WHERE branch_id = $1 AND owner_name = $2 AND active", [p.branch_id, p.name])).rows[0].n
    : 0;
  return { ok: `${p.name} can no longer log in.${owned ? ` They still own ${owned} measure${owned === 1 ? '' : 's'} – reassign them under Measures.` : ''}` };
}

// PIN for branch staff (4 digits), password for everyone else (8+ characters).
async function setSecret(db, { userId, secret, user }) {
  const u = (await db.query('SELECT id, username, role FROM users WHERE id = $1', [userId])).rows[0];
  if (!u) return { error: 'That login doesn’t exist.' };
  const s = String(secret || '');
  if (u.role === 'branch_staff') {
    if (!/^\d{4}$/.test(s)) return { error: 'A PIN is exactly 4 digits.' };
    if (['0000', '1111', '1234', '2222', '4321', '9999'].includes(s)) return { error: 'Choose a PIN that’s harder to guess.' };
  } else if (s.length < 8) {
    return { error: 'Passwords need at least 8 characters.' };
  }
  const column = u.role === 'branch_staff' ? 'pin_hash' : 'password_hash';
  await db.transaction(async (tx) => {
    await tx.query(`UPDATE users SET ${column} = $2, failed_attempts = 0, locked_until = NULL WHERE id = $1`, [u.id, bcrypt.hashSync(s, 10)]);
    // Never store the PIN or password itself in the audit log.
    await audit(tx, user, column === 'pin_hash' ? 'set_pin' : 'set_password', 'users', u.username, null, null);
  });
  return { ok: `${column === 'pin_hash' ? 'PIN' : 'Password'} set for ${u.username}.` };
}

async function unlock(db, { userId, user }) {
  const u = (await db.query('SELECT username FROM users WHERE id = $1', [userId])).rows[0];
  if (!u) return { error: 'That login doesn’t exist.' };
  await db.query('UPDATE users SET failed_attempts = 0, locked_until = NULL WHERE id = $1', [userId]);
  await audit(db, user, 'unlock', 'users', u.username, null, null);
  return { ok: `${u.username} can log in again.` };
}

module.exports = { LOGIN_ROLES, loadPeople, adminUser, addPerson, updatePerson, setActive, setSecret, unlock };
