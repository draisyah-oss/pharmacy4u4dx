// What `npm start` does to the database before the server opens:
// 1. run any new migrations, 2. load seed.json if the database is still empty.

const { migrate } = require('./migrate');
const { readSeed, validateSeed, loadSeed, isSeeded } = require('./seed');

async function prepareDatabase(db, { log = console.log } = {}) {
  await migrate(db, { log });

  if (await isSeeded(db)) {
    log('Seed already loaded – using the data in the database.');
    await backfillNewSettings(db, readSeed(), log);
    await addAdminLoginsOnce(db, readSeed(), log);
    await importDailyOnce(db, 'jh-tracker-2026-10-21.json', 'import_jh_tracker_20261021', log);
    await wmTiktokOffOnce(db, log);
    await wmWalkinUpOnce(db, readSeed(), log);
    await retireBranchItemsOnce(db, 'JH', { fields: ['grabmenu'], measures: ['N3'] }, 'jh_grabmenu_off_v1', 'JH: Grab menu items added/fixed removed (22 Oct)', log);
    await retireBranchItemsOnce(db, 'JH', { fields: ['waord', 'wadays'], measures: ['N5'] }, 'jh_waorders_off_v1', 'JH: WhatsApp orders / days to fulfil removed – WhatsApp customer follow-ups only (22 Oct)', log);
    await relabelOnce(db, 'ampang_eldon_v1', [
      ["UPDATE daily_fields SET label = 'Eldon strip units sold' WHERE key = 'p3' AND branch_id = (SELECT id FROM branches WHERE code = 'Ampang') AND label = 'Oat units sold'"],
      ["UPDATE measures SET label = 'Target product: Eldon strip' WHERE code = 'P3' AND branch_id = (SELECT id FROM branches WHERE code = 'Ampang') AND label = 'Target product: Oat'"],
      ["INSERT INTO audit_log (action, table_name, record_key, new_value) VALUES ('seed', 'measures', 'Ampang: target product Oat → Eldon strip (22 Oct)', NULL)"],
    ]);
    await relabelOnce(db, 'jh_fu_label_v1', [
      ["UPDATE daily_fields SET label = 'WhatsApp customer follow-ups' WHERE key = 'fu' AND branch_id = (SELECT id FROM branches WHERE code = 'JH') AND label LIKE 'WhatsApp blasts%'"],
      ["UPDATE measures SET label = 'WhatsApp customer follow-ups (LEAD 2)' WHERE code = 'N1' AND branch_id = (SELECT id FROM branches WHERE code = 'JH') AND label LIKE 'WhatsApp blasts%'"],
    ]);
    await grabInventoryOnce(db, readSeed(), log);
    await bangiOct27Once(db, readSeed(), log);
    await retireBranchItemsOnce(db, 'JH', { fields: ['oosn', 'oosloss', 'zkrm', 'zkrfq', 'zkrfqok', 'ttcom', 'grabcx'], measures: ['T6', 'T7', 'F7', 'F9', 'Y0', 'N4'] },
      'jh_no_target_v1', 'JH: 7 boxes with no target removed (CEO, 28 Oct) – out-of-stock logged / sales lost, zakat claims RM, RFQ invitations / approved, TikTok commission, Grab cancelled orders', log);
    await brOct29Once(db, readSeed(), log);
    await ampangOct29Once(db, readSeed(), log);
    await bangiNov2Once(db, log);
    await tallyAllOnce(db, readSeed(), log);
    await brNov3Once(db, readSeed(), log);
    return { seeded: false };
  }

  const seed = readSeed();
  const { warnings } = validateSeed(seed);
  warnings.forEach((w) => log(`Note: ${w}`));

  const summary = await loadSeed(db, seed, { adminPassword: process.env.ADMIN_PASSWORD });
  await addAdminLoginsOnce(db, seed, log);
  log(
    `Loaded seed.json: ${summary.branches} branches, ${summary.people} people, ` +
      `${summary.daily_fields} daily fields, ${summary.measures} measures, ` +
      `${summary.hq_measures} HQ measures, ${summary.users} logins.`
  );
  return { seeded: true, summary };
}

// Settings added to seed.json after a database was first loaded (e.g. the sales sheet link)
// are copied in once – only where the database has nothing yet, so Admin edits are kept.
async function backfillNewSettings(db, seed, log) {
  const has = await db.query("SELECT 1 FROM app_settings WHERE key = 'sales_sheet_id'");
  if (!has.rows.length && seed.company.sales_sheet_id) {
    await db.query("INSERT INTO app_settings (key, value) VALUES ('sales_sheet_id', $1)", [seed.company.sales_sheet_id]);
    log('Added the sales sheet link from seed.json.');
  }
  for (const b of seed.branches) {
    if (!b.sales_sheet) continue;
    const r = await db.query('UPDATE branches SET sales_sheet = $2 WHERE code = $1 AND sales_sheet IS NULL', [b.code, JSON.stringify(b.sales_sheet)]);
    if (r.affectedRows || r.rowCount) log(`Added the sales sheet columns for ${b.code}.`);
  }
  await backfillHqTeam(db, seed, log);
  await ensureSetting(db, 'oos_targets', seed.company.oos_targets, log);
  await ensureSetting(db, 'sheet_view_branches', seed.company.sheet_view_branches, log);
  await ensureSetting(db, 'hq_departments', seed.hq && seed.hq.departments, log);
  await ensureSetting(db, 'tally_branches', seed.company.tally_branches, log);
  await backfillHqAccess(db, seed, log);
  await backfillHqTasks(db, seed, log);
  await updateSalesSheetColumns(db, seed, log);
  // 16 Oct: the sheet's Grab Pay column is now called "Grab sales (RM)" – accept either name.
  await updateSalesSheetColumns(db, seed, log, 'sales_sheet_v3');
  // 28 Oct: the daily tabs now have "GrabMart Sales (RM)" – read it as Grab sales (and keep it out of walk-in).
  await updateSalesSheetColumns(db, seed, log, 'sales_sheet_v4');
  await syncBranchFromSeed(db, seed, 'JH', 'jh_update_v1', log);
  await syncBranchFromSeed(db, seed, 'WM', 'wm_update_16oct', log);
  await retireJhPoster(db, log);
  await wikiChecklistOnce(db, seed, log);
  await addHqTaskOnce(db, 'Iman', 'Company wiki: one checklist page moved forward today', 'wiki_tasks_v1', log);
  await addHqTaskOnce(db, 'Hanin', 'Company wiki: SOPs waiting for my check answered today', 'wiki_tasks_hanin_v1', log);
  await threeItems(db, log);
  await wigOnMonday(db, log);
  await renameBranchPersonOnce(db, 'Ampang', 'Aisyah', 'Aishah', 'ampang_aishah_v1', log);
  await addHqTaskOnce(db, 'Alia', 'Zakat orders from the branches placed today', 'alia_zakat_task_v1', log);
  await ensureSetting(db, 'wiki_approver', seed.hq && seed.hq.wiki_approver, log);
  await wigWeekOnce(db, seed, log);
  await ensureSetting(db, 'inventory_team', seed.hq && seed.hq.inventory_team, log);
  await ensureSetting(db, 'oos_needs_off', seed.hq && seed.hq.oos_needs_off, log);
  await ensureSetting(db, 'hq_extra_moves', seed.hq && seed.hq.extra_moves, log);
  await addBranchPersonOnce(db, 'Ampang', { name: 'Anis', job: 'Intern' }, 'ampang_anis_v1', log);
  await projectStepsOnce(db, seed, log);
  const ct = await db.query('SELECT 1 FROM company_month_targets LIMIT 1');
  if (!ct.rows.length && seed.company.monthly_sales_target) {
    for (const [month, target] of Object.entries(seed.company.monthly_sales_target)) {
      await db.query('INSERT INTO company_month_targets (month, total_sales_target) VALUES ($1, $2)', [month, target]);
    }
    log('Added the company monthly sales targets from seed.json.');
  }
}

// HQ people and HQ measures added to seed.json later (14 Oct: Syarafana, Fariz, Azwani, Iman
// and the CEO's measure, from the Q4 4DX HQ Tracker). Only what's missing is added – people by
// name, measures by code – so anything changed in Admin stays as it is.
async function backfillHqTeam(db, seed, log) {
  const owners = (seed.hq && seed.hq.owners) || [];
  const measures = (seed.hq && seed.hq.measures) || [];
  await db.transaction(async (tx) => {
    const people = new Map((await tx.query('SELECT id, name FROM people WHERE branch_id IS NULL')).rows.map((p) => [p.name, p.id]));
    const added = [];
    for (const [i, o] of owners.entries()) {
      if (people.has(o.name)) continue;
      const { rows } = await tx.query(
        'INSERT INTO people (branch_id, name, role, sort_order) VALUES (NULL, $1, $2, $3) RETURNING id', [o.name, o.role, i + 1]);
      people.set(o.name, rows[0].id);
      added.push(o.name);
      if (o.login === false) continue;
      let username = o.name.toLowerCase().replace(/[^a-z0-9]+/g, '');
      if ((await tx.query('SELECT 1 FROM users WHERE username = $1', [username])).rows.length) username += '.hq';
      await tx.query(
        `INSERT INTO users (username, display_name, role, person_id, enters_all_hq) VALUES ($1, $2, $3, $4, $5)`,
        [username, o.name, o.access === 'staff' ? 'hq_staff' : 'hq', rows[0].id, Boolean(o.enters_all)]);
    }
    const codes = new Set((await tx.query('SELECT code FROM hq_measures')).rows.map((r) => r.code));
    let newMeasures = 0;
    for (const [i, m] of measures.entries()) {
      if (codes.has(m.id)) continue;
      const { rows } = await tx.query(
        `INSERT INTO hq_measures (code, owner_name, person_id, label, unit, input, better, kind, note, sort_order)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
        [m.id, m.owner, people.get(m.owner) || null, m.label, m.unit, m.input, m.better, m.kind, m.note, 100 + i]);
      for (const [month, target] of Object.entries(m.targets || {})) {
        await tx.query('INSERT INTO hq_measure_targets (hq_measure_id, month, target) VALUES ($1,$2,$3)', [rows[0].id, month, target]);
      }
      newMeasures++;
    }
    if (added.length || newMeasures) {
      await tx.query(
        `INSERT INTO audit_log (action, table_name, record_key, new_value) VALUES ('seed', 'hq_measures', 'HQ team from seed.json', $1)`,
        [JSON.stringify({ people: added, measures: newMeasures })]);
      log(`Added from seed.json: HQ people ${added.join(', ') || 'none'}; ${newMeasures} HQ measures.`);
    }
  });
}

// 15 Oct: HQ access levels, daily tasks and projects. Done once (app_settings flag), so later
// changes in Admin – a different login type, a retired task, a project edited – are kept.
async function backfillHqAccess(db, seed, log) {
  const done = await db.query("SELECT 1 FROM app_settings WHERE key = 'hq_access_v1'");
  if (done.rows.length) return;
  await db.transaction(async (tx) => {
    const people = new Map((await tx.query('SELECT id, name FROM people WHERE branch_id IS NULL')).rows.map((p) => [p.name, p.id]));
    for (const o of seed.hq.owners || []) {
      if (o.access !== 'staff' || !people.has(o.name)) continue;
      // A changed login type needs a new PIN; any old password is cleared.
      await tx.query(
        `UPDATE users SET role = 'hq_staff', password_hash = NULL WHERE person_id = $1 AND role = 'hq'`, [people.get(o.name)]);
    }
    if (!(await tx.query('SELECT 1 FROM hq_daily_tasks LIMIT 1')).rows.length) {
      for (const [name, labels] of Object.entries(seed.hq.daily_tasks || {})) {
        if (!people.has(name)) continue;
        for (const [i, label] of labels.entries()) {
          await tx.query('INSERT INTO hq_daily_tasks (person_id, label, sort_order) VALUES ($1,$2,$3)', [people.get(name), label, i + 1]);
        }
      }
    }
    if (!(await tx.query('SELECT 1 FROM hq_projects LIMIT 1')).rows.length) {
      for (const [i, pr] of (seed.hq.projects || []).entries()) {
        await tx.query(
          'INSERT INTO hq_projects (project, milestone, owner, start_date, due_date, sort_order) VALUES ($1,$2,$3,$4,$5,$6)',
          [pr.project, pr.milestone, pr.owner, pr.start || null, pr.due || null, i + 1]);
      }
    }
    await tx.query("INSERT INTO app_settings (key, value) VALUES ('hq_access_v1', $1)", [new Date().toISOString()]);
    await tx.query(
      `INSERT INTO audit_log (action, table_name, record_key, new_value) VALUES ('seed', 'users', 'HQ access levels, daily tasks, projects', NULL)`);
  });
  log('Set HQ access levels and added HQ daily tasks and projects from seed.json.');
}

// 15 Oct (later): starting daily tasks for every HQ person. Once only, and only for people
// who have never had a task – a list someone already made or trimmed is left alone.
async function backfillHqTasks(db, seed, log) {
  if ((await db.query("SELECT 1 FROM app_settings WHERE key = 'hq_daily_tasks_v2'")).rows.length) return;
  const added = [];
  await db.transaction(async (tx) => {
    const people = new Map((await tx.query('SELECT id, name FROM people WHERE branch_id IS NULL')).rows.map((p) => [p.name, p.id]));
    for (const [name, labels] of Object.entries(seed.hq.daily_tasks || {})) {
      const id = people.get(name);
      if (!id || (await tx.query('SELECT 1 FROM hq_daily_tasks WHERE person_id = $1 LIMIT 1', [id])).rows.length) continue;
      for (const [i, label] of labels.entries()) {
        await tx.query('INSERT INTO hq_daily_tasks (person_id, label, sort_order) VALUES ($1,$2,$3)', [id, label, i + 1]);
      }
      added.push(name);
    }
    await tx.query("INSERT INTO app_settings (key, value) VALUES ('hq_daily_tasks_v2', $1)", [new Date().toISOString()]);
    if (added.length) {
      await tx.query(
        `INSERT INTO audit_log (action, table_name, record_key, new_value) VALUES ('seed', 'hq_daily_tasks', 'Starting daily tasks', $1)`,
        [JSON.stringify(added)]);
    }
  });
  if (added.length) log(`Added starting daily tasks for ${added.join(', ')}.`);
}

// 16 Oct: every WIG session is on Monday now (branch sessions were Tuesday). Wording only, once.
async function wigOnMonday(db, log) {
  if ((await db.query("SELECT 1 FROM app_settings WHERE key = 'wig_monday_v1'")).rows.length) return;
  await db.transaction(async (tx) => {
    await tx.query("UPDATE hq_measures SET label = 'Both WIG sessions held (HQ and branch, both on Monday)' WHERE label = 'Both WIG sessions held (Monday HQ, Tuesday branch)'");
    await tx.query("UPDATE hq_measures SET note = replace(note, 'after the Tuesday session', 'after the Monday sessions') WHERE note LIKE '%Tuesday session%'");
    await tx.query("UPDATE hq_measures SET label = replace(label, 'at Tuesday sessions', 'at the Monday WIG sessions') WHERE label LIKE '%Tuesday sessions%'");
    await tx.query("UPDATE hq_projects SET milestone = replace(milestone, 'every Tuesday', 'every Monday') WHERE milestone LIKE '%every Tuesday%'");
    await tx.query("INSERT INTO app_settings (key, value) VALUES ('wig_monday_v1', $1)", [new Date().toISOString()]);
    await tx.query("INSERT INTO audit_log (action, table_name, record_key, new_value) VALUES ('seed', 'hq_measures', 'All WIG sessions moved to Monday (16 Oct)', NULL)");
  });
  log('WIG sessions: wording changed to Monday.');
}

// 18 Oct: the weekly WIG rhythm – HQ WIG Monday 10 am, managers' update Monday 4 pm, branch WIG
// Tuesday – and the wiki checklist: Iman owns every page, Hanin approves. Wording, owners and the
// wiki targets (only where still the old seed numbers) changed once.
async function wigWeekOnce(db, seed, log) {
  if ((await db.query("SELECT 1 FROM app_settings WHERE key = 'wig_week_v1'")).rows.length) return;
  const hq = new Map(((seed.hq && seed.hq.measures) || []).map((m) => [m.id, m]));
  await db.transaction(async (tx) => {
    for (const code of ['sessions', 'mgr', 'wiki', 'wikisop']) {
      const m = hq.get(code);
      if (m) await tx.query('UPDATE hq_measures SET label = $2, note = $3 WHERE code = $1', [code, m.label, m.note]);
    }
    const old = { wiki: { '2026-10': 4, '2026-11': 4, '2026-12': 2 }, wikisop: { '2026-10': 3, '2026-11': 3, '2026-12': 4 } };
    for (const [code, was] of Object.entries(old)) {
      const m = hq.get(code);
      const row = (await tx.query('SELECT id FROM hq_measures WHERE code = $1', [code])).rows[0];
      if (!m || !row) continue;
      const now = new Map((await tx.query('SELECT month, target FROM hq_measure_targets WHERE hq_measure_id = $1', [row.id])).rows.map((r) => [r.month, Number(r.target)]));
      if (Object.entries(was).some(([month, t]) => now.get(month) !== t)) continue; // edited in Admin – keep
      for (const [month, t] of Object.entries(m.targets)) {
        await tx.query(`INSERT INTO hq_measure_targets (hq_measure_id, month, target) VALUES ($1, $2, $3)
          ON CONFLICT (hq_measure_id, month) DO UPDATE SET target = EXCLUDED.target`, [row.id, month, t]);
      }
    }
    await tx.query("UPDATE hq_projects SET milestone = replace(milestone, 'managers 15 min every Monday', 'managers 15 min every Tuesday') WHERE milestone LIKE '%managers 15 min every Monday%'");
    await tx.query(`UPDATE hq_wiki_items SET title = 'How we run 4DX: WIGs, lead measures, weekly WIG sessions (HQ Monday, branch Tuesday), commitments'
      WHERE title = 'How we run 4DX: WIGs, lead measures, Monday WIG sessions, commitments'`);
    const iman = (await tx.query("SELECT id FROM people WHERE branch_id IS NULL AND name = 'Iman'")).rows[0];
    const moved = iman ? (await tx.query("UPDATE hq_wiki_items SET owner = 'Iman', person_id = $1 WHERE owner = 'Hanin' RETURNING id", [iman.id])).rows.length : 0;
    await tx.query("UPDATE hq_wiki_items SET checking_at = updated_at WHERE status IN ('Checking', 'Approved') AND checking_at IS NULL");
    await tx.query(`UPDATE hq_daily_tasks SET label = 'Company wiki: pages waiting for my approval checked today'
      WHERE label = 'Company wiki: SOPs waiting for my check answered today'`);
    await tx.query("INSERT INTO app_settings (key, value) VALUES ('wig_week_v1', $1)", [new Date().toISOString()]);
    await tx.query("INSERT INTO audit_log (action, table_name, record_key, new_value) VALUES ('seed', 'hq_measures', 'Weekly WIG rhythm + wiki owners (18 Oct)', $1)",
      [JSON.stringify({ wiki_pages_moved_to_iman: moved })]);
    log(`Weekly WIG rhythm: branch WIG on Tuesday; ${moved} wiki pages moved to Iman (Hanin approves).`);
  });
}

// 19 Oct: project steps from seed.json (first: min/max for the top 300 items). Once, matched by
// project + milestone, and only for milestones that have no steps yet.
async function projectStepsOnce(db, seed, log) {
  if ((await db.query("SELECT 1 FROM app_settings WHERE key = 'project_steps_v1'")).rows.length) return;
  const added = [];
  await db.transaction(async (tx) => {
    for (const pr of ((seed.hq && seed.hq.projects) || []).filter((x) => x.steps && x.steps.length)) {
      const row = (await tx.query('SELECT id FROM hq_projects WHERE project = $1 AND milestone = $2 AND active ORDER BY id LIMIT 1', [pr.project, pr.milestone])).rows[0];
      if (!row || (await tx.query('SELECT 1 FROM hq_project_steps WHERE project_id = $1 LIMIT 1', [row.id])).rows.length) continue;
      await require('../hq/team').insertSeedSteps(tx, row.id, pr.steps);
      added.push(`${pr.milestone} (${pr.steps.length})`);
    }
    await tx.query("INSERT INTO app_settings (key, value) VALUES ('project_steps_v1', $1)", [new Date().toISOString()]);
    if (added.length) {
      await tx.query("INSERT INTO audit_log (action, table_name, record_key, new_value) VALUES ('seed', 'hq_project_steps', 'Project steps from seed.json (19 Oct)', $1)",
        [JSON.stringify(added)]);
    }
  });
  if (added.length) log(`Added project steps: ${added.join(', ')}.`);
}

// 22 Oct: WM can't go ahead with a TikTok seller account – TikTok orders shipped (Z3) and TikTok
// sales (Z7) and their daily boxes (ttship, tt) are retired (history kept) and TikTok sales no
// longer count in WM's total or online sales. The month total targets are unchanged.
async function wmTiktokOffOnce(db, log) {
  if ((await db.query("SELECT 1 FROM app_settings WHERE key = 'wm_tiktok_off_v1'")).rows.length) return;
  await db.transaction(async (tx) => {
    const b = (await tx.query("SELECT id, total_sales_fields, online_sales_fields FROM branches WHERE code = 'WM'")).rows[0];
    if (b) {
      await tx.query("UPDATE measures SET active = false WHERE branch_id = $1 AND code IN ('Z3', 'Z7')", [b.id]);
      await tx.query("UPDATE daily_fields SET active = false WHERE branch_id = $1 AND key IN ('ttship', 'tt')", [b.id]);
      const drop = (list) => JSON.stringify((Array.isArray(list) ? list : []).filter((k) => k !== 'tt'));
      await tx.query('UPDATE branches SET total_sales_fields = $2, online_sales_fields = $3 WHERE id = $1', [b.id, drop(b.total_sales_fields), drop(b.online_sales_fields)]);
      await tx.query("INSERT INTO audit_log (action, table_name, record_key, new_value) VALUES ('seed', 'measures', 'WM: TikTok removed (22 Oct)', NULL)");
      log('WM: TikTok measures and boxes retired (no TikTok seller at WM).');
    }
    await tx.query("INSERT INTO app_settings (key, value) VALUES ('wm_tiktok_off_v1', $1)", [new Date().toISOString()]);
  });
}

// Run a few label updates once (flag in app_settings).
async function relabelOnce(db, flag, statements) {
  if ((await db.query('SELECT 1 FROM app_settings WHERE key = $1', [flag])).rows.length) return;
  await db.transaction(async (tx) => {
    for (const [sql, args] of statements) await tx.query(sql, args || []);
    await tx.query('INSERT INTO app_settings (key, value) VALUES ($1, $2)', [flag, new Date().toISOString()]);
  });
}

// 22 Oct: every branch's Grab lead is now Grab active inventory % (above 50%) – box `grabinv`
// (type percent, typed as the Grab merchant app shows it) and measure GI (average_percent),
// owned like the old "Grab menu items added/fixed" (WM Zawiyah, JH Nabihah, BR Qushairi, Bangi Ayuni,
// Ampang Aishah). The grabmenu boxes and measures are retired (history kept). Added from seed.json,
// in the old one's place; branches that already have GI are left alone.
async function grabInventoryOnce(db, seed, log) {
  const flag = 'grab_inventory_v1';
  if ((await db.query('SELECT 1 FROM app_settings WHERE key = $1', [flag])).rows.length) return;
  await db.transaction(async (tx) => {
    const done = [];
    for (const sb of seed.branches) {
      const f = (sb.daily_fields || []).find((x) => x.key === 'grabinv');
      const m = (sb.measures || []).find((x) => x.numerator_field === 'grabinv');
      const b = (await tx.query('SELECT id FROM branches WHERE code = $1', [sb.code])).rows[0];
      if (!b || !f || !m) continue;
      if ((await tx.query('SELECT 1 FROM measures WHERE branch_id = $1 AND code = $2', [b.id, m.id])).rows.length) continue;
      const person = async (name) => (await tx.query('SELECT id FROM people WHERE branch_id = $1 AND name = $2 AND active', [b.id, name])).rows[0]?.id || null;
      const oldF = (await tx.query("SELECT sort_order FROM daily_fields WHERE branch_id = $1 AND key = 'grabmenu' AND active", [b.id])).rows[0];
      const fOrder = oldF ? oldF.sort_order
        : ((await tx.query("SELECT sort_order FROM daily_fields WHERE branch_id = $1 AND key = 'grabon'", [b.id])).rows[0]?.sort_order
          ?? (await tx.query('SELECT COALESCE(max(sort_order), 0) + 1 AS n FROM daily_fields WHERE branch_id = $1', [b.id])).rows[0].n);
      const oldM = (await tx.query("SELECT sort_order FROM measures WHERE branch_id = $1 AND numerator_field = 'grabmenu' AND active ORDER BY sort_order LIMIT 1", [b.id])).rows[0];
      const mOrder = oldM ? oldM.sort_order
        : (await tx.query('SELECT COALESCE(max(sort_order), 0) + 1 AS n FROM measures WHERE branch_id = $1', [b.id])).rows[0].n;
      await tx.query("UPDATE daily_fields SET active = false WHERE branch_id = $1 AND key = 'grabmenu'", [b.id]);
      await tx.query("UPDATE measures SET active = false WHERE branch_id = $1 AND numerator_field = 'grabmenu'", [b.id]);
      await tx.query(`INSERT INTO daily_fields (branch_id, key, label, owner_name, person_id, type, sort_order) VALUES ($1,$2,$3,$4,$5,$6,$7)
        ON CONFLICT (branch_id, key) DO UPDATE SET label = EXCLUDED.label, type = EXCLUDED.type, active = true`,
        [b.id, f.key, f.label, f.owner, await person(f.owner), f.type, fOrder]);
      const mid = (await tx.query(`INSERT INTO measures (branch_id, code, owner_name, person_id, label, kind, unit, target_per,
          calc, numerator_field, denominator_field, note, sort_order, score_by)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING id`,
        [b.id, m.id, m.owner, await person(m.owner), m.label, m.kind, m.unit, m.target_per, m.calc,
          m.numerator_field, m.denominator_field, m.note, mOrder, m.score_by || 'week'])).rows[0].id;
      const months = (await tx.query('SELECT DISTINCT t.month FROM measure_targets t JOIN measures x ON x.id = t.measure_id WHERE x.branch_id = $1', [b.id])).rows.map((r) => r.month.trim());
      for (const month of new Set([...months, ...Object.keys(m.targets || {})])) {
        await tx.query('INSERT INTO measure_targets (measure_id, month, target) VALUES ($1,$2,$3)', [mid, month, (m.targets || {})[month] ?? null]);
      }
      done.push(sb.code);
    }
    await tx.query("INSERT INTO audit_log (action, table_name, record_key, new_value) VALUES ('seed', 'measures', 'Grab menu items → Grab active inventory % above 50% (22 Oct)', $1)", [JSON.stringify({ branches: done })]);
    await tx.query('INSERT INTO app_settings (key, value) VALUES ($1, $2)', [flag, new Date().toISOString()]);
    if (done.length) log(`Grab active inventory % added for ${done.join(', ')}.`);
  });
}

// Add daily boxes and measures from seed.json to a branch that doesn't have them yet (by key /
// code), at the end of its lists, with the seed's targets. Used for one-time moves (27 Oct).
async function addSeedItems(tx, seed, code, { fields = [], measures = [] }) {
  const sb = seed.branches.find((b) => b.code === code);
  const b = (await tx.query('SELECT id FROM branches WHERE code = $1', [code])).rows[0];
  if (!sb || !b) return 0;
  const person = async (name) => (await tx.query('SELECT id FROM people WHERE branch_id = $1 AND name = $2 AND active', [b.id, name])).rows[0]?.id || null;
  let added = 0;
  for (const key of fields) {
    const f = sb.daily_fields.find((x) => x.key === key);
    if (!f) continue;
    const order = (await tx.query('SELECT COALESCE(max(sort_order), 0) + 1 AS n FROM daily_fields WHERE branch_id = $1', [b.id])).rows[0].n;
    await tx.query(`INSERT INTO daily_fields (branch_id, key, label, owner_name, person_id, type, sort_order) VALUES ($1,$2,$3,$4,$5,$6,$7)
      ON CONFLICT (branch_id, key) DO UPDATE SET label = EXCLUDED.label, owner_name = EXCLUDED.owner_name, person_id = EXCLUDED.person_id, active = true`,
      [b.id, f.key, f.label, f.owner, await person(f.owner), f.type, order]);
    added++;
  }
  for (const id of measures) {
    const m = sb.measures.find((x) => x.id === id);
    if (!m || (await tx.query('SELECT 1 FROM measures WHERE branch_id = $1 AND code = $2', [b.id, m.id])).rows.length) continue;
    const order = (await tx.query('SELECT COALESCE(max(sort_order), 0) + 1 AS n FROM measures WHERE branch_id = $1', [b.id])).rows[0].n;
    const mid = (await tx.query(`INSERT INTO measures (branch_id, code, owner_name, person_id, label, kind, unit, target_per,
        calc, numerator_field, denominator_field, note, sort_order, score_by, high_days)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING id`,
      [b.id, m.id, m.owner, await person(m.owner), m.label, m.kind, m.unit, m.target_per, m.calc,
        m.numerator_field, m.denominator_field, m.note, order, m.score_by || 'week', m.high_days || null])).rows[0].id;
    const months = (await tx.query('SELECT DISTINCT t.month FROM measure_targets t JOIN measures x ON x.id = t.measure_id WHERE x.branch_id = $1', [b.id])).rows.map((r) => r.month.trim());
    for (const month of new Set([...months, ...Object.keys(m.targets || {})])) {
      await tx.query('INSERT INTO measure_targets (measure_id, month, target) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [mid, month, (m.targets || {})[month] ?? null]);
    }
    added++;
  }
  return added;
}

// 27 Oct (CEO): Bangi – Siti added (Sales Assistant) and owns every Grab box and measure (was Ayuni);
// target products Oat → Androchi, Neem facial → Canberra (same boxes p3 / p4, numbers kept); the
// neuropathy lead moves to BR (Amirah, NP, 1 a day) – Bangi's A1 and its box retired, history kept.
// Only changes what still looks like the seed (owner Ayuni, the old labels), so Admin edits stay.
async function bangiOct27Once(db, seed, log) {
  const flag = 'bangi_27oct_v1';
  if ((await db.query('SELECT 1 FROM app_settings WHERE key = $1', [flag])).rows.length) return;
  await addBranchPersonOnce(db, 'Bangi', { name: 'Siti', job: 'Sales Assistant' }, 'bangi_siti_v1', log);
  await db.transaction(async (tx) => {
    const bangi = (await tx.query("SELECT id FROM branches WHERE code = 'Bangi'")).rows[0];
    if (bangi) {
      const siti = (await tx.query("SELECT id FROM people WHERE branch_id = $1 AND lower(name) = 'siti' AND active", [bangi.id])).rows[0];
      const grab = ['grabon', 'grabinv', 'graord', 'grab'];
      if (siti) {
        await tx.query("UPDATE daily_fields SET owner_name = 'Siti', person_id = $2 WHERE branch_id = $1 AND key = ANY($3) AND owner_name IN ('Ayuni', 'Siti')", [bangi.id, siti.id, grab]);
        await tx.query("UPDATE measures SET owner_name = 'Siti', person_id = $2 WHERE branch_id = $1 AND numerator_field = ANY($3) AND owner_name IN ('Ayuni', 'Siti')", [bangi.id, siti.id, grab]);
      }
      const relabel = [['p3', 'Oat units sold', 'Androchi units sold', 'Target product: Oat', 'Target product: Androchi'],
        ['p4', 'Neem facial units sold', 'Canberra units sold', 'Target product: Neem facial', 'Target product: Canberra']];
      for (const [key, of, nf, om, nm] of relabel) {
        await tx.query('UPDATE daily_fields SET label = $3 WHERE branch_id = $1 AND key = $2 AND label = $4', [bangi.id, key, nf, of]);
        await tx.query('UPDATE measures SET label = $3 WHERE branch_id = $1 AND numerator_field = $2 AND label = $4', [bangi.id, key, nm, om]);
      }
      await tx.query("UPDATE daily_fields SET active = false WHERE branch_id = $1 AND key = 'neuro'", [bangi.id]);
      await tx.query("UPDATE measures SET active = false WHERE branch_id = $1 AND numerator_field = 'neuro'", [bangi.id]);
    }
    await addSeedItems(tx, seed, 'BR', { fields: ['neuro'], measures: ['NP'] });
    await tx.query("INSERT INTO audit_log (action, table_name, record_key, new_value) VALUES ('seed', 'measures', 'Bangi: Siti owns Grab; Oat → Androchi, Neem facial → Canberra; neuropathy lead moved to BR (27 Oct)', NULL)");
    await tx.query('INSERT INTO app_settings (key, value) VALUES ($1, $2)', [flag, new Date().toISOString()]);
  });
  log('Bangi 27 Oct changes applied (Siti on Grab, Androchi / Canberra, neuropathy lead → BR).');
}

// 29 Oct (CEO): BR 4DX adjustment. Qushairi has left (login off) and Aqilah joins (staff login, PIN in
// Admin → People). Removed (history kept): 3+ items, PWP, Qushairi's target products Magalax, Biovita,
// Freederm, Propolis and the A-frame routine. Owners: focus items → Alya, Lead 2 loyalty → Ainur, Google
// reviews and Grab → Aqilah. New box / measure: Nurvi (P9). Targets Oct–Dec: walk-in RM 1,250 Tue–Sat,
// RM 1,650 on the busy days Sun–Mon (high_days); POCT lead 6 a week; focus items 2 / 0.5 / 0.5 / 0.5 / 1
// a day; Google reviews 20 a month (200 by 31 Dec); Grabmart RM 1,500 a month; zakat claims within 2 weeks.
// Labels, owners and targets come from seed.json, so a fresh database and an older one end up the same.
async function brOct29Once(db, seed, log) {
  const flag = 'br_29oct_v1';
  if ((await db.query('SELECT 1 FROM app_settings WHERE key = $1', [flag])).rows.length) return;
  const sb = seed.branches.find((b) => b.code === 'BR');
  const br = (await db.query("SELECT id FROM branches WHERE code = 'BR'")).rows[0];
  if (!sb || !br) {
    await db.query('INSERT INTO app_settings (key, value) VALUES ($1, $2)', [flag, new Date().toISOString()]);
    return;
  }
  await addBranchPersonOnce(db, 'BR', { name: 'Aqilah', job: 'Sales Assistant' }, 'br_aqilah_v1', log);
  const qus = (await db.query("SELECT id FROM people WHERE branch_id = $1 AND name = 'Qushairi' AND active", [br.id])).rows[0];
  if (qus) await require('../admin/people').setActive(db, { personId: qus.id, active: false, user: null });
  await db.transaction(async (tx) => {
    await tx.query("UPDATE daily_fields SET active = false WHERE branch_id = $1 AND key = ANY($2)", [br.id, ['two', 'pwp', 'p3', 'p5', 'p6', 'p8', 'aframe']]);
    await tx.query("UPDATE measures SET active = false WHERE branch_id = $1 AND (code = ANY($2) OR numerator_field = ANY($3))",
      [br.id, ['T2', 'P3', 'P5', 'P6', 'P8', 'Q4'], ['two', 'pwp', 'p3', 'p5', 'p6', 'p8', 'aframe']]);
    await addSeedItems(tx, seed, 'BR', { fields: ['p9'], measures: ['P9'] });
    const person = async (name) => (await tx.query('SELECT id FROM people WHERE branch_id = $1 AND name = $2 AND active', [br.id, name])).rows[0]?.id || null;
    for (const key of ['p1', 'p2', 'p4', 'p7', 'reviews', 'poct', 'zkc7d', 'loyal', 'grabinv', 'graord', 'grab']) {
      const f = sb.daily_fields.find((x) => x.key === key);
      if (f) await tx.query('UPDATE daily_fields SET label = $3, owner_name = $4, person_id = $5 WHERE branch_id = $1 AND key = $2',
        [br.id, key, f.label, f.owner, await person(f.owner)]);
    }
    // Entered once a month (on the 30th): scored month to date, the week shows the actual only.
    await tx.query("UPDATE measures SET score_by = 'month' WHERE branch_id = $1 AND code = ANY($2)", [br.id, ['A5', 'AL', 'G0']]);
    for (const code of ['T1', 'P1', 'P2', 'P4', 'P7', 'T4', 'N1', 'Q1', 'A7', 'G0', 'GI', 'M3']) {
      const m = sb.measures.find((x) => x.id === code);
      const row = m && (await tx.query('SELECT id FROM measures WHERE branch_id = $1 AND code = $2', [br.id, code])).rows[0];
      if (!row) continue;
      await tx.query(`UPDATE measures SET label = $2, owner_name = $3, person_id = $4, unit = $5, target_per = $6, note = $7, high_days = $8, active = true
        WHERE id = $1`, [row.id, m.label, m.owner, await person(m.owner), m.unit, m.target_per, m.note, m.high_days || null]);
      if (['M3', 'Q1', 'A7', 'GI'].includes(code)) continue; // targets unchanged
      const w = m.weekend_targets || {};
      for (const [month, t] of Object.entries(m.targets || {})) {
        await tx.query(`INSERT INTO measure_targets (measure_id, month, target, weekend_target) VALUES ($1, $2, $3, $4)
          ON CONFLICT (measure_id, month) DO UPDATE SET target = EXCLUDED.target, weekend_target = EXCLUDED.weekend_target`,
          [row.id, month, t, w[month] ?? null]);
      }
    }
    const gr = sb.running_totals.find((r) => r.id === 'GR');
    if (gr) await tx.query("UPDATE running_totals SET label = $2, end_target = $3 WHERE branch_id = $1 AND code = 'GR'", [br.id, gr.label, gr.end_target]);
    await tx.query('UPDATE branches SET wig = $2, wig_detail = $3, lead_measures = $4 WHERE id = $1',
      [br.id, sb.wig, sb.wig_detail, JSON.stringify(sb.lead_measures)]);
    await tx.query("INSERT INTO audit_log (action, table_name, record_key, new_value) VALUES ('seed', 'measures', 'BR 4DX adjustment (CEO, 29 Oct): 3+ items, PWP and Qushairi''s measures removed; Aqilah added; focus items, leads, reviews, Grab and walk-in Tue–Sat / Sun–Mon targets', NULL)");
    await tx.query('INSERT INTO app_settings (key, value) VALUES ($1, $2)', [flag, new Date().toISOString()]);
  });
  log('BR 29 Oct 4DX adjustment applied (Aqilah added, Qushairi off, new focus items, leads and targets).');
}

// 29 Oct (CEO): Ampang target products – PWP 5 a day (unchanged), Biorelief / Biopropolis 2, Proponeem /
// Neem facial 2 (one product now; Neem facial's own box P4 retired), Beecrobes 2, new Loose supplements
// (P6) and Short-expiry products (P7) 2 a day. Eldon strip (P3) is off the list. History kept.
async function ampangOct29Once(db, seed, log) {
  const flag = 'ampang_29oct_v1';
  if ((await db.query('SELECT 1 FROM app_settings WHERE key = $1', [flag])).rows.length) return;
  const sb = seed.branches.find((b) => b.code === 'Ampang');
  await db.transaction(async (tx) => {
    const b = (await tx.query("SELECT id FROM branches WHERE code = 'Ampang'")).rows[0];
    if (b && sb) {
      await tx.query('UPDATE daily_fields SET active = false WHERE branch_id = $1 AND key = ANY($2)', [b.id, ['p3', 'p4']]);
      await tx.query('UPDATE measures SET active = false WHERE branch_id = $1 AND (code = ANY($2) OR numerator_field = ANY($3))', [b.id, ['P3', 'P4'], ['p3', 'p4']]);
      for (const key of ['p1', 'p2']) {
        const f = sb.daily_fields.find((x) => x.key === key);
        await tx.query('UPDATE daily_fields SET label = $3 WHERE branch_id = $1 AND key = $2', [b.id, key, f.label]);
      }
      for (const code of ['P1', 'P2']) {
        const m = sb.measures.find((x) => x.id === code);
        await tx.query('UPDATE measures SET label = $3, note = $4 WHERE branch_id = $1 AND code = $2', [b.id, code, m.label, m.note]);
      }
      await addSeedItems(tx, seed, 'Ampang', { fields: ['p6', 'p7'], measures: ['P6', 'P7'] });
      await tx.query("INSERT INTO audit_log (action, table_name, record_key, new_value) VALUES ('seed', 'measures', 'Ampang target products (CEO, 29 Oct): Proponeem / Neem facial, Biorelief / Biopropolis, loose supplements, short-expiry products; Eldon strip off', NULL)");
      log('Ampang 29 Oct target products applied.');
    }
    await tx.query('INSERT INTO app_settings (key, value) VALUES ($1, $2)', [flag, new Date().toISOString()]);
  });
}

// Retire a branch's daily boxes and measures once (history kept), e.g. JH's Grab menu items (22 Oct).
async function retireBranchItemsOnce(db, code, { fields = [], measures = [] }, flag, note, log) {
  if ((await db.query('SELECT 1 FROM app_settings WHERE key = $1', [flag])).rows.length) return;
  await db.transaction(async (tx) => {
    const b = (await tx.query('SELECT id FROM branches WHERE code = $1', [code])).rows[0];
    if (b) {
      await tx.query('UPDATE daily_fields SET active = false WHERE branch_id = $1 AND key = ANY($2)', [b.id, fields]);
      await tx.query('UPDATE measures SET active = false WHERE branch_id = $1 AND code = ANY($2)', [b.id, measures]);
      await tx.query("INSERT INTO audit_log (action, table_name, record_key, new_value) VALUES ('seed', 'measures', $1, NULL)", [note]);
      log(note);
    }
    await tx.query('INSERT INTO app_settings (key, value) VALUES ($1, $2)', [flag, new Date().toISOString()]);
  });
}

// 22 Oct: WM's month totals stay the same without TikTok, so the walk-in WIG (T1) goes up by about
// RM 65 a day (RM 2,000 a month): 1,795 / 1,980 / 2,165. Only months still at the old target change.
async function wmWalkinUpOnce(db, seed, log) {
  if ((await db.query("SELECT 1 FROM app_settings WHERE key = 'wm_walkin_up_v1'")).rows.length) return;
  const wm = seed.branches.find((b) => b.code === 'WM');
  const t1 = wm && wm.measures.find((m) => m.id === 'T1');
  const old = { '2026-10': 1730, '2026-11': 1910, '2026-12': 2100 };
  await db.transaction(async (tx) => {
    const m = (await tx.query("SELECT m.id FROM measures m JOIN branches b ON b.id = m.branch_id WHERE b.code = 'WM' AND m.code = 'T1'")).rows[0];
    let changed = 0;
    if (m && t1) {
      for (const [month, was] of Object.entries(old)) {
        const r = await tx.query('UPDATE measure_targets SET target = $3 WHERE measure_id = $1 AND month = $2 AND target = $4 RETURNING 1', [m.id, month, t1.targets[month], was]);
        changed += r.rows.length;
      }
      await tx.query("UPDATE branches SET wig = $1, wig_detail = $2 WHERE code = 'WM' AND wig LIKE '%2,100/day%'", [wm.wig, wm.wig_detail]);
      await tx.query("UPDATE measures SET note = $2 WHERE id = $1", [m.id, t1.note]);
      await tx.query("INSERT INTO audit_log (action, table_name, record_key, new_value) VALUES ('seed', 'measure_targets', 'WM T1 walk-in +RM 65/day (TikTok gone, 22 Oct)', $1)", [JSON.stringify({ months_changed: changed })]);
    }
    await tx.query("INSERT INTO app_settings (key, value) VALUES ('wm_walkin_up_v1', $1)", [new Date().toISOString()]);
    log(`WM walk-in target raised for ${changed} month(s) to cover the TikTok sales.`);
  });
}

// 22 Oct: daily numbers a branch kept in its own tracker (src/db/imports/*.json, made from the
// branch's Excel "Daily Log") copied into daily_entries once. Only empty boxes are filled – a number
// already in the app (typed or from the sales sheet) is kept, and the difference is noted in the
// audit log. Fields the sales sheet fills (walk-in, transactions, zakat, Grab) are never in the file.
async function importDailyOnce(db, file, flag, log) {
  if ((await db.query('SELECT 1 FROM app_settings WHERE key = $1', [flag])).rows.length) return;
  const data = JSON.parse(require('fs').readFileSync(require('path').join(__dirname, 'imports', file), 'utf8'));
  const branch = (await db.query('SELECT id, code FROM branches WHERE code = $1', [data.branch])).rows[0];
  if (!branch) return;
  const fields = new Set((await db.query('SELECT key FROM daily_fields WHERE branch_id = $1 AND active', [branch.id])).rows.map((r) => r.key));
  const result = { added: 0, kept: 0, differ: [] };
  await db.transaction(async (tx) => {
    for (const [date, values] of Object.entries(data.days)) {
      for (const [key, value] of Object.entries(values)) {
        if (!fields.has(key)) continue;
        const before = (await tx.query('SELECT value FROM daily_entries WHERE branch_id = $1 AND entry_date = $2 AND field_key = $3', [branch.id, date, key])).rows[0];
        if (before) {
          result.kept++;
          if (Number(before.value) !== Number(value)) result.differ.push(`${date} ${key}: app ${Number(before.value)}, tracker ${value}`);
          continue;
        }
        await tx.query('INSERT INTO daily_entries (branch_id, entry_date, field_key, value, source) VALUES ($1, $2, $3, $4, $5)', [branch.id, date, key, value, 'app']);
        result.added++;
      }
    }
    await tx.query("INSERT INTO audit_log (action, table_name, record_key, new_value) VALUES ('import', 'daily_entries', $1, $2)",
      [`${branch.code} – ${data.source}`, JSON.stringify(result)]);
    await tx.query('INSERT INTO app_settings (key, value) VALUES ($1, $2)', [flag, new Date().toISOString()]);
  });
  log(`Imported ${branch.code}'s tracker: ${result.added} numbers added, ${result.kept} already in the app${result.differ.length ? ` (${result.differ.length} differ – see the audit log)` : ''}.`);
}

// 19 Oct: extra admin logins (seed hq.admin_logins – Iman, Hanin) next to the super admin.
// No password yet: the super admin sets it in Admin → People & logins → HQ.
async function addAdminLoginsOnce(db, seed, log) {
  if ((await db.query("SELECT 1 FROM app_settings WHERE key = 'admin_logins_v1'")).rows.length) return;
  for (const a of (seed.hq && seed.hq.admin_logins) || []) {
    if ((await db.query('SELECT 1 FROM users WHERE username = $1', [a.username])).rows.length) continue;
    await db.query("INSERT INTO users (username, display_name, role, is_super) VALUES ($1, $2, 'admin', false)", [a.username, a.name]);
    log(`Added admin login ${a.username} (set its password in Admin → People & logins → HQ).`);
  }
  await db.query("INSERT INTO app_settings (key, value) VALUES ('admin_logins_v1', $1)", [new Date().toISOString()]);
}

// Add a person (with a staff login, PIN set in Admin → People) to a branch once.
// 2 Nov (CEO): Bangi – Aimi (branch manager) had no boxes left after the neuropathy lead moved to BR,
// so the Team boxes (walk-in, transactions, 3+ items, PWP, target products) are now hers; staff can
// still type them. Siti and Salasilah are the same person: Siti's Grab boxes go to Salasilah, Siti's
// commitments move to Salasilah (where she has none that week), and the Siti login is switched off
// (if only Siti's login had a PIN, Salasilah's login takes it). History is kept.
async function bangiNov2Once(db, log) {
  const flag = 'bangi_2nov_v1';
  if ((await db.query('SELECT 1 FROM app_settings WHERE key = $1', [flag])).rows.length) return;
  await db.transaction(async (tx) => {
    const b = (await tx.query("SELECT id FROM branches WHERE code = 'Bangi'")).rows[0];
    if (b) {
      const pid = async (name) => (await tx.query('SELECT id FROM people WHERE branch_id = $1 AND lower(name) = lower($2) ORDER BY active DESC, id LIMIT 1', [b.id, name])).rows[0]?.id || null;
      const aimi = await pid('Aimi'); const sal = await pid('Salasilah'); const siti = await pid('Siti');
      if (aimi) {
        await tx.query("UPDATE daily_fields SET owner_name = 'Aimi', person_id = $2 WHERE branch_id = $1 AND owner_name = 'Team'", [b.id, aimi]);
        await tx.query("UPDATE measures SET owner_name = 'Aimi', person_id = $2 WHERE branch_id = $1 AND owner_name = 'Team'", [b.id, aimi]);
      }
      if (sal && siti) {
        await tx.query("UPDATE daily_fields SET owner_name = 'Salasilah', person_id = $2 WHERE branch_id = $1 AND (owner_name = 'Siti' OR person_id = $3)", [b.id, sal, siti]);
        await tx.query("UPDATE measures SET owner_name = 'Salasilah', person_id = $2 WHERE branch_id = $1 AND (owner_name = 'Siti' OR person_id = $3)", [b.id, sal, siti]);
        await tx.query(`UPDATE commitments c SET person_id = $1 WHERE c.person_id = $2
          AND NOT EXISTS (SELECT 1 FROM commitments x WHERE x.person_id = $1 AND x.week_start = c.week_start)`, [sal, siti]);
        const su = (await tx.query('SELECT id, pin_hash FROM users WHERE person_id = $1', [siti])).rows[0];
        const lu = (await tx.query('SELECT id, pin_hash FROM users WHERE person_id = $1', [sal])).rows[0];
        if (su && lu && su.pin_hash && !lu.pin_hash) await tx.query('UPDATE users SET pin_hash = $2 WHERE id = $1', [lu.id, su.pin_hash]);
        await tx.query('UPDATE people SET active = false WHERE id = $1', [siti]);
        await tx.query('UPDATE users SET active = false WHERE person_id = $1', [siti]);
        await tx.query("DELETE FROM sessions WHERE (data->>'userId')::int IN (SELECT id FROM users WHERE person_id = $1)", [siti]);
      }
    }
    await tx.query("INSERT INTO audit_log (action, table_name, record_key, new_value) VALUES ('seed', 'measures', 'Bangi: Team boxes → Aimi; Siti = Salasilah (Grab boxes to Salasilah, Siti login off) (2 Nov)', NULL)");
    await tx.query('INSERT INTO app_settings (key, value) VALUES ($1, $2)', [flag, new Date().toISOString()]);
  });
  log('Bangi 2 Nov: Team boxes → Aimi; Siti merged into Salasilah.');
}

// 3 Nov (CEO): BR from November – retail (walk-in, WIG T1) RM 45k a month and the other channels make
// up the rest of a RM 55k month total. Walk-in keeps BR's Sun–Mon busy days: Nov RM 1,355 / 1,790
// (= 45,000), Dec RM 1,340 / 1,775 (= 45,020). YTD month-end targets follow (+55k a month).
// Values come from seed.json; only months still at the old numbers are changed (Admin edits kept).
async function brNov3Once(db, seed, log) {
  const flag = 'br_nov3_v1';
  if ((await db.query('SELECT 1 FROM app_settings WHERE key = $1', [flag])).rows.length) return;
  const sb = seed.branches.find((b) => b.code === 'BR');
  const br = (await db.query("SELECT id FROM branches WHERE code = 'BR'")).rows[0];
  await db.transaction(async (tx) => {
    if (sb && br) {
      const old = { '2026-11': { total: 61600, ytd: 707400, t: 1250, w: 1650 }, '2026-12': { total: 69000, ytd: 776400, t: 1250, w: 1650 } };
      const t1 = sb.measures.find((m) => m.id === 'T1');
      const mid = (await tx.query("SELECT id FROM measures WHERE branch_id = $1 AND code = 'T1'", [br.id])).rows[0]?.id;
      for (const [month, o] of Object.entries(old)) {
        await tx.query(`UPDATE branch_month_targets SET total_sales_target = $3 WHERE branch_id = $1 AND month = $2 AND total_sales_target = $4`,
          [br.id, month, sb.monthly_total_target[month], o.total]);
        await tx.query(`UPDATE branch_month_targets SET ytd_target_month_end = $3 WHERE branch_id = $1 AND month = $2 AND ytd_target_month_end = $4`,
          [br.id, month, sb.before_tracker.ytd_target_month_end[month], o.ytd]);
        if (mid) {
          await tx.query(`UPDATE measure_targets SET target = $3, weekend_target = $4 WHERE measure_id = $1 AND month = $2 AND target = $5 AND weekend_target = $6`,
            [mid, month, t1.targets[month], t1.weekend_targets[month], o.t, o.w]);
        }
      }
      await tx.query('UPDATE branches SET wig = $2 WHERE id = $1', [br.id, sb.wig]);
    }
    await tx.query("INSERT INTO audit_log (action, table_name, record_key, new_value) VALUES ('seed', 'branch_month_targets', 'BR from Nov: retail RM 45k, total RM 55k a month (3 Nov)', NULL)");
    await tx.query('INSERT INTO app_settings (key, value) VALUES ($1, $2)', [flag, new Date().toISOString()]);
  });
  log('BR from November: retail RM 45k, total RM 55k a month.');
}

// 2 Nov (CEO): the −1 / +1 buttons on Daily entry for every branch (was BR only).
async function tallyAllOnce(db, seed, log) {
  const flag = 'tally_all_v1';
  if ((await db.query('SELECT 1 FROM app_settings WHERE key = $1', [flag])).rows.length) return;
  const all = (await db.query('SELECT code FROM branches WHERE active ORDER BY sort_order')).rows.map((r) => r.code);
  await db.query(`INSERT INTO app_settings (key, value) VALUES ('tally_branches', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [JSON.stringify(all)]);
  await db.query('INSERT INTO app_settings (key, value) VALUES ($1, $2)', [flag, new Date().toISOString()]);
  log('+1 buttons on for every branch.');
}

async function addBranchPersonOnce(db, code, person, flag, log) {
  if ((await db.query('SELECT 1 FROM app_settings WHERE key = $1', [flag])).rows.length) return;
  const branch = (await db.query('SELECT * FROM branches WHERE code = $1', [code])).rows[0];
  if (branch && !(await db.query('SELECT 1 FROM people WHERE branch_id = $1 AND lower(name) = lower($2)', [branch.id, person.name])).rows.length) {
    const r = await require('../admin/people').addPerson(db, { branch, body: { name: person.name, job: person.job, login_role: 'branch_staff' }, user: null });
    log(r.error ? `Could not add ${person.name} to ${code}: ${r.error}` : `${r.ok} (${code})`);
  }
  await db.query('INSERT INTO app_settings (key, value) VALUES ($1, $2)', [flag, new Date().toISOString()]);
}

// 16 Oct: the company wiki checklist (64 pages) for Iman and Hanin, added once.
async function wikiChecklistOnce(db, seed, log) {
  if ((await db.query("SELECT 1 FROM app_settings WHERE key = 'wiki_checklist_v1'")).rows.length) return;
  await db.transaction(async (tx) => {
    let n = 0;
    if (!(await tx.query('SELECT 1 FROM hq_wiki_items LIMIT 1')).rows.length) n = await require('../hq/wikilist').insertChecklist(tx, seed);
    await tx.query("INSERT INTO app_settings (key, value) VALUES ('wiki_checklist_v1', $1)", [new Date().toISOString()]);
    if (n) log(`Added the company wiki checklist (${n} pages).`);
  });
}

// 16 Oct: the wiki / Classroom (with JH's daily poster measure E1) was taken out again until the
// framework is agreed. A database that already got E1 and the poster box has them retired (history kept).
async function retireJhPoster(db, log) {
  const r = await db.query(
    `UPDATE measures SET active = false WHERE code = 'E1' AND active AND branch_id = (SELECT id FROM branches WHERE code = 'JH') RETURNING id`);
  await db.query(`UPDATE daily_fields SET active = false WHERE key = 'poster' AND active AND branch_id = (SELECT id FROM branches WHERE code = 'JH')`);
  if ((r.rows || []).length) log('Retired JH’s poster measure (wiki taken out for now).');
}

// A setting from seed.json copied in once (JSON), only when the database has none.
async function ensureSetting(db, key, value, log) {
  if (value === undefined || (await db.query('SELECT 1 FROM app_settings WHERE key = $1', [key])).rows.length) return;
  await db.query('INSERT INTO app_settings (key, value) VALUES ($1, $2)', [key, JSON.stringify(value)]);
  log(`Added ${key} from seed.json.`);
}

// 16 Oct: the add-on measure is now 3+ items a transaction (was 2+), every branch. Labels only;
// the numbers already typed stay as they are.
async function threeItems(db, log) {
  if ((await db.query("SELECT 1 FROM app_settings WHERE key = 'three_items_v1'")).rows.length) return;
  await db.transaction(async (tx) => {
    await tx.query("UPDATE daily_fields SET label = replace(label, '2+ items', '3+ items') WHERE label LIKE '%2+ items%'");
    await tx.query("UPDATE measures SET label = replace(label, '2+ items', '3+ items') WHERE label LIKE '%2+ items%'");
    await tx.query("UPDATE branches SET lead_measures = replace(lead_measures::text, '2+ items', '3+ items')::jsonb WHERE lead_measures::text LIKE '%2+ items%'");
    await tx.query("INSERT INTO app_settings (key, value) VALUES ('three_items_v1', $1)", [new Date().toISOString()]);
    await tx.query("INSERT INTO audit_log (action, table_name, record_key, new_value) VALUES ('seed', 'measures', 'Transactions with 2+ items renamed 3+ items (16 Oct)', NULL)");
  });
  log('Renamed "2+ items" to "3+ items".');
}

// A branch person's name corrected (16 Oct: Ampang's Aisyah is Aishah) – same as Admin → People:
// name, login username, owned fields and measures, and labels that mention them. Once.
async function renameBranchPersonOnce(db, code, from, to, flag, log) {
  if ((await db.query('SELECT 1 FROM app_settings WHERE key = $1', [flag])).rows.length) return;
  const { updatePerson } = require('../admin/people');
  const p = (await db.query('SELECT p.id, p.branch_id FROM people p JOIN branches b ON b.id = p.branch_id WHERE b.code = $1 AND p.name = $2', [code, from])).rows[0];
  if (p) {
    const r = await updatePerson(db, { personId: p.id, body: { name: to, username: to.toLowerCase() }, user: null });
    if (r.error) log(`Could not rename ${from} to ${to}: ${r.error}`);
    else {
      await db.query('UPDATE daily_fields SET label = replace(label, $2, $3) WHERE branch_id = $1', [p.branch_id, from, to]);
      await db.query('UPDATE measures SET label = replace(label, $2, $3) WHERE branch_id = $1', [p.branch_id, from, to]);
      log(`Renamed ${code} ${from} to ${to}.`);
    }
  }
  await db.query('INSERT INTO app_settings (key, value) VALUES ($1, $2)', [flag, new Date().toISOString()]);
}

// Add one daily task to an HQ person's list (once, unless it's already there).
async function addHqTaskOnce(db, name, label, flag, log) {
  if ((await db.query('SELECT 1 FROM app_settings WHERE key = $1', [flag])).rows.length) return;
  await db.transaction(async (tx) => {
    const p = (await tx.query('SELECT id FROM people WHERE branch_id IS NULL AND name = $1', [name])).rows[0];
    if (p && !(await tx.query('SELECT 1 FROM hq_daily_tasks WHERE person_id = $1 AND active AND label = $2', [p.id, label])).rows.length) {
      const next = (await tx.query('SELECT coalesce(max(sort_order), 0) + 1 AS n FROM hq_daily_tasks WHERE person_id = $1', [p.id])).rows[0].n;
      await tx.query('INSERT INTO hq_daily_tasks (person_id, label, sort_order) VALUES ($1,$2,$3)', [p.id, label, next]);
      await tx.query("INSERT INTO audit_log (action, table_name, record_key, new_value) VALUES ('seed', 'hq_daily_tasks', $1, $2)", [name, JSON.stringify(label)]);
      log(`Added "${label}" to ${name}'s daily tasks.`);
    }
    await tx.query('INSERT INTO app_settings (key, value) VALUES ($1, $2)', [flag, new Date().toISOString()]);
  });
}

// 15 Oct: sheet columns corrected – Grab sales (RM) = Grab Pay, Grab orders = GrabMart, and
// walk-in = Total minus Grab Pay (so Grab isn't counted twice). Applied once to older databases;
// the next sync rewrites the numbers that came from the sheet.
async function updateSalesSheetColumns(db, seed, log, flag = 'sales_sheet_v2') {
  if ((await db.query('SELECT 1 FROM app_settings WHERE key = $1', [flag])).rows.length) return;
  await db.transaction(async (tx) => {
    for (const b of seed.branches) {
      if (!b.sales_sheet) continue;
      await tx.query('UPDATE branches SET sales_sheet = $2 WHERE code = $1', [b.code, JSON.stringify(b.sales_sheet)]);
    }
    await tx.query('INSERT INTO app_settings (key, value) VALUES ($1, $2)', [flag, new Date().toISOString()]);
    await tx.query(
      `INSERT INTO audit_log (action, table_name, record_key, new_value) VALUES ('seed', 'branches', 'Sales sheet columns: Grab Pay = Grab sales, GrabMart = Grab orders', NULL)`);
  });
  log('Updated the sales sheet columns (Grab Pay = Grab sales, GrabMart = Grab orders, walk-in without Grab Pay).');
}

// A branch's fields, measures, targets and running totals brought in line with seed.json,
// once (flag in app_settings). Used for JH's own tracker notes (15 Oct). Fields and measures
// no longer in seed.json are retired (history kept), new ones added, the rest updated.
async function syncBranchFromSeed(db, seed, code, flag, log) {
  if ((await db.query('SELECT 1 FROM app_settings WHERE key = $1', [flag])).rows.length) return;
  const b = seed.branches.find((x) => x.code === code);
  if (!b) return;
  await db.transaction(async (tx) => {
    const branch = (await tx.query('SELECT id FROM branches WHERE code = $1', [code])).rows[0];
    if (!branch) return;
    const people = new Map((await tx.query('SELECT id, name FROM people WHERE branch_id = $1', [branch.id])).rows.map((p) => [p.name, p.id]));

    for (const [i, f] of b.daily_fields.entries()) {
      await tx.query(
        `INSERT INTO daily_fields (branch_id, key, label, owner_name, person_id, type, sort_order, active)
         VALUES ($1,$2,$3,$4,$5,$6,$7,true)
         ON CONFLICT (branch_id, key) DO UPDATE SET label = EXCLUDED.label, owner_name = EXCLUDED.owner_name,
           person_id = EXCLUDED.person_id, type = EXCLUDED.type, sort_order = EXCLUDED.sort_order, active = true`,
        [branch.id, f.key, f.label, f.owner, people.get(f.owner) || null, f.type, i + 1]);
    }
    await tx.query('UPDATE daily_fields SET active = false WHERE branch_id = $1 AND NOT (key = ANY($2))', [branch.id, b.daily_fields.map((f) => f.key)]);

    for (const [i, m] of b.measures.entries()) {
      const { rows } = await tx.query(
        `INSERT INTO measures (branch_id, code, owner_name, person_id, label, kind, unit, target_per, calc,
           numerator_field, denominator_field, note, sort_order, score_by, active)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,true)
         ON CONFLICT (branch_id, code) DO UPDATE SET owner_name = EXCLUDED.owner_name, person_id = EXCLUDED.person_id,
           label = EXCLUDED.label, kind = EXCLUDED.kind, unit = EXCLUDED.unit, target_per = EXCLUDED.target_per,
           calc = EXCLUDED.calc, numerator_field = EXCLUDED.numerator_field, denominator_field = EXCLUDED.denominator_field,
           note = EXCLUDED.note, sort_order = EXCLUDED.sort_order, score_by = EXCLUDED.score_by, active = true
         RETURNING id`,
        [branch.id, m.id, m.owner, people.get(m.owner) || null, m.label, m.kind, m.unit, m.target_per, m.calc,
          m.numerator_field, m.denominator_field, m.note, i + 1, m.score_by || 'week']);
      const id = rows[0].id;
      await tx.query('DELETE FROM measure_targets WHERE measure_id = $1', [id]);
      const weekend = m.weekend_targets || {};
      for (const month of [...new Set([...Object.keys(m.targets || {}), ...Object.keys(weekend)])].sort()) {
        await tx.query('INSERT INTO measure_targets (measure_id, month, target, weekend_target) VALUES ($1,$2,$3,$4)',
          [id, month, (m.targets || {})[month] ?? null, weekend[month] ?? null]);
      }
    }
    await tx.query('UPDATE measures SET active = false WHERE branch_id = $1 AND NOT (code = ANY($2))', [branch.id, b.measures.map((m) => m.id)]);

    for (const rt of b.running_totals || []) {
      await tx.query('UPDATE running_totals SET label = $3, end_target = $4 WHERE branch_id = $1 AND code = $2',
        [branch.id, rt.id, rt.label, rt.end_target ?? null]);
    }
    await tx.query('UPDATE branches SET lead_measures = $2 WHERE id = $1', [branch.id, JSON.stringify(b.lead_measures || [])]);
    await tx.query('INSERT INTO app_settings (key, value) VALUES ($1, $2)', [flag, new Date().toISOString()]);
    await tx.query(`INSERT INTO audit_log (action, table_name, record_key, new_value) VALUES ('seed', 'measures', $1, NULL)`,
      [`${code} fields and measures updated from seed.json (${flag})`]);
  });
  log(`Updated ${code}'s fields and measures from seed.json.`);
}

module.exports = { brNov3Once, bangiNov2Once, tallyAllOnce, ampangOct29Once, brOct29Once, bangiOct27Once, addSeedItems, grabInventoryOnce, retireBranchItemsOnce, wmWalkinUpOnce, wmTiktokOffOnce, importDailyOnce, addAdminLoginsOnce, projectStepsOnce, wigOnMonday, wigWeekOnce, addBranchPersonOnce, renameBranchPersonOnce, threeItems, addHqTaskOnce, prepareDatabase, backfillNewSettings, backfillHqTeam, backfillHqAccess, backfillHqTasks, updateSalesSheetColumns, syncBranchFromSeed };
