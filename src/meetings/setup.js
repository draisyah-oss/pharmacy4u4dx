// Meetings module (8 Nov 2026): the meeting groups from seed.json → meetings.groups, loaded once
// (app_settings meetings_groups_v1). After that the CEO edits groups and members in Admin.
// Members are matched by person name to that person's own login (never the *.admin logins).

const { readSeed } = require('../db/seed');

const FLAG = 'meetings_groups_v1';

async function userForName(q, name) {
  return (await q.query(
    `SELECT u.id FROM users u JOIN people p ON p.id = u.person_id
     WHERE lower(p.name) = lower($1) AND p.active AND u.active ORDER BY u.id LIMIT 1`, [name])).rows[0]?.id || null;
}

async function setupOnce(db, log = () => {}, seed = readSeed()) {
  if ((await db.query('SELECT 1 FROM app_settings WHERE key = $1', [FLAG])).rows.length) return { skipped: true };
  const groups = (seed.meetings && seed.meetings.groups) || [];
  const missing = [];
  await db.transaction(async (tx) => {
    for (const [i, g] of groups.entries()) {
      const row = (await tx.query(
        `INSERT INTO meeting_groups (code, name, kind, default_day, default_time, agenda_template, sort_order, branch)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT (code) DO NOTHING RETURNING id`,
        [g.code, g.name, g.kind || 'team', g.day || null, g.time || null, g.agenda || 'simple', i + 1, g.branch || null])).rows[0];
      if (!row) continue;
      for (const name of g.members || []) {
        const uid = await userForName(tx, name);
        if (!uid) { missing.push(`${g.name}: ${name}`); continue; }
        await tx.query('INSERT INTO meeting_group_members (group_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [row.id, uid]);
      }
    }
    await tx.query(
      "INSERT INTO audit_log (action, table_name, record_key, new_value) VALUES ('seed', 'meeting_groups', 'Meeting groups from seed.json (8 Nov)', $1)",
      [JSON.stringify({ groups: groups.map((g) => g.code), missing })]);
    await tx.query('INSERT INTO app_settings (key, value) VALUES ($1, $2)', [FLAG, new Date().toISOString()]);
  });
  log(`Meeting groups added: ${groups.length}${missing.length ? ` (no login found for ${missing.join(', ')})` : ''}.`);
  return { groups: groups.length, missing };
}

// 9 Nov: Branch 1:1s (seed kind 'branch_1on1') added once to databases set up before them; groups
// already there are left alone. Also stamps when the "What's new" feed starts (nothing before it).
const BRANCH_FLAG = 'meetings_branch_1on1_v1';
async function branchOneOnOnesOnce(db, log = () => {}, seed = readSeed()) {
  if ((await db.query('SELECT 1 FROM app_settings WHERE key = $1', [BRANCH_FLAG])).rows.length) return { skipped: true };
  const groups = ((seed.meetings && seed.meetings.groups) || []).filter((g) => g.kind === 'branch_1on1');
  const added = []; const missing = [];
  await db.transaction(async (tx) => {
    let order = (await tx.query('SELECT COALESCE(max(sort_order), 0) AS n FROM meeting_groups')).rows[0].n;
    for (const g of groups) {
      const row = (await tx.query(
        `INSERT INTO meeting_groups (code, name, kind, default_day, default_time, agenda_template, sort_order, branch)
         VALUES ($1, $2, 'branch_1on1', $3, $4, $5, $6, $7) ON CONFLICT (code) DO NOTHING RETURNING id`,
        [g.code, g.name, g.day || null, g.time || null, g.agenda || 'simple', ++order, g.branch])).rows[0];
      if (!row) { await tx.query("UPDATE meeting_groups SET branch = $2 WHERE code = $1 AND branch IS NULL AND kind = 'branch_1on1'", [g.code, g.branch]); continue; }
      added.push(g.code);
      for (const name of g.members || []) {
        const uid = await userForName(tx, name);
        if (!uid) { missing.push(`${g.name}: ${name}`); continue; }
        await tx.query('INSERT INTO meeting_group_members (group_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [row.id, uid]);
      }
    }
    await tx.query(
      "INSERT INTO audit_log (action, table_name, record_key, new_value) VALUES ('seed', 'meeting_groups', 'Branch 1:1s (9 Nov)', $1)",
      [JSON.stringify({ added, missing })]);
    await tx.query("INSERT INTO app_settings (key, value) VALUES ('meetings_feed_start', now()::text) ON CONFLICT (key) DO NOTHING");
    await tx.query('INSERT INTO app_settings (key, value) VALUES ($1, $2)', [BRANCH_FLAG, new Date().toISOString()]);
  });
  if (added.length) log(`Branch 1:1 groups added: ${added.join(', ')}${missing.length ? ` (no login found for ${missing.join(', ')})` : ''}.`);
  return { added, missing };
}

module.exports = { setupOnce, branchOneOnOnesOnce, FLAG, BRANCH_FLAG };
