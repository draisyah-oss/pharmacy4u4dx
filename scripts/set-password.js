// Set a password or PIN for a login (until the Admin screen exists).
//   npm run set-password -- hafizah MySecret123
//   npm run set-password -- zawiyah 4821        (4 digits = PIN, for branch staff)

require('dotenv').config({ quiet: true });
const bcrypt = require('bcryptjs');
const { createDb } = require('../src/db');
const { prepareDatabase } = require('../src/db/setup');

async function main() {
  const [username, secret] = process.argv.slice(2);
  if (!username || !secret) {
    console.log('Usage: npm run set-password -- <username> <password or 4-digit PIN>');
    process.exit(1);
  }
  const db = await createDb();
  await prepareDatabase(db, { log: () => {} });

  const { rows } = await db.query('SELECT id, role FROM users WHERE username = $1', [username.toLowerCase()]);
  if (!rows.length) {
    console.log(`No login called "${username}". Run "npm run users" to see them all.`);
    process.exit(1);
  }
  const user = rows[0];
  const isPin = /^\d{4}$/.test(secret);

  if (isPin && user.role !== 'branch_staff') {
    console.log('PINs are for branch staff. Managers, HQ and admin need a password of 8+ characters.');
    process.exit(1);
  }
  if (!isPin && secret.length < 8) {
    console.log('Passwords need at least 8 characters (or use a 4-digit PIN for branch staff).');
    process.exit(1);
  }

  const column = isPin ? 'pin_hash' : 'password_hash';
  await db.query(`UPDATE users SET ${column} = $1 WHERE id = $2`, [bcrypt.hashSync(secret, 10), user.id]);
  await db.query(
    `INSERT INTO audit_log (action, table_name, record_key) VALUES ($1, 'users', $2)`,
    [isPin ? 'set_pin' : 'set_password', username.toLowerCase()]
  );
  console.log(`${isPin ? 'PIN' : 'Password'} set for ${username}.`);
  await db.close();
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
