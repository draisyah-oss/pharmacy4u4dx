// List every login: npm run users

require('dotenv').config({ quiet: true });
const { createDb } = require('../src/db');
const { prepareDatabase } = require('../src/db/setup');

async function main() {
  const db = await createDb();
  await prepareDatabase(db, { log: () => {} });
  const { rows } = await db.query(`
    SELECT u.username, u.display_name, u.role, COALESCE(b.code, '–') AS branch,
      CASE WHEN u.password_hash IS NOT NULL THEN 'password'
           WHEN u.pin_hash IS NOT NULL THEN 'PIN'
           ELSE 'not set yet' END AS login
    FROM users u LEFT JOIN branches b ON b.id = u.branch_id
    LEFT JOIN people p ON p.id = u.person_id
    ORDER BY u.role = 'admin' DESC, b.sort_order NULLS LAST, p.sort_order, u.username`);
  console.table(rows);
  await db.close();
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
