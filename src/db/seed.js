// Loads seed.json into an empty database.
//
// It runs ONCE – the first time the app starts on a fresh database. After that the database
// is the source of truth (targets, people and measures are edited in Admin), and seed.json
// is never applied again, so nobody's edits get overwritten.

const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const { mentionsSalary } = require('../privacy');

const SEED_PATH = path.resolve(__dirname, '..', '..', 'seed.json');

const CALCS = ['sum', 'ratio_percent', 'ratio_per_day', 'average_percent'];
const TARGET_PER = ['day', 'week', 'month'];
const FIELD_TYPES = ['money', 'count', 'yes_no', 'percent'];
const MONTH_RE = /^\d{4}-\d{2}$/;

function readSeed(file = SEED_PATH) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

// Checks that every field a measure, total or running total refers to actually exists,
// so a typo in seed.json fails loudly instead of showing zeros on a scoreboard.
// Returns { errors: [...], warnings: [...] }.
function validateSeed(seed) {
  const errors = [];
  const warnings = [];
  const err = (m) => errors.push(m);

  const start = seed.company && seed.company.tracker_start_date;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start || '')) err('company.tracker_start_date must be YYYY-MM-DD');

  if (!Array.isArray(seed.branches) || seed.branches.length === 0) err('No branches in seed.json');
  const codes = new Set();

  for (const b of seed.branches || []) {
    const at = `Branch ${b.code}`;
    if (codes.has(b.code)) err(`${at}: branch code appears twice`);
    codes.add(b.code);

    const people = new Set((b.people || []).map((p) => p.name));
    if (people.size !== (b.people || []).length) err(`${at}: the same person is listed twice`);

    const keys = new Set();
    for (const f of b.daily_fields || []) {
      if (keys.has(f.key)) err(`${at}: daily field "${f.key}" appears twice`);
      keys.add(f.key);
      if (!FIELD_TYPES.includes(f.type)) err(`${at}: field "${f.key}" has unknown type "${f.type}"`);
      if (f.owner !== 'Team' && !people.has(f.owner)) {
        err(`${at}: field "${f.key}" owner "${f.owner}" is not a person in this branch`);
      }
    }
    const needField = (key, where) => {
      if (key && !keys.has(key)) err(`${at}: ${where} uses field "${key}", which is not a daily field`);
    };

    (b.total_sales_fields || []).forEach((k) => needField(k, 'total_sales_fields'));
    (b.online_sales_fields || []).forEach((k) => needField(k, 'online_sales_fields'));
    needField(b.zakat_field, 'zakat_field');
    needField(b.lead1_field, 'lead1_field');
    needField(b.lead2_field, 'lead2_field');
    if (b.sales_sheet) {
      if (!b.sales_sheet.tab || !b.sales_sheet.columns) err(`${at}: sales_sheet needs a tab and columns`);
      Object.keys(b.sales_sheet.columns || {}).forEach((k) => needField(k, 'sales_sheet'));
    }

    const measureIds = new Set();
    for (const m of b.measures || []) {
      const mat = `${at} measure ${m.id}`;
      if (measureIds.has(m.id)) err(`${mat}: id appears twice`);
      measureIds.add(m.id);
      if (!CALCS.includes(m.calc)) err(`${mat}: unknown calc "${m.calc}"`);
      if (!TARGET_PER.includes(m.target_per)) err(`${mat}: unknown target_per "${m.target_per}"`);
      needField(m.numerator_field, `measure ${m.id}`);
      if (m.calc !== 'sum' && m.calc !== 'average_percent') {
        if (!m.denominator_field) err(`${mat}: ${m.calc} needs a denominator_field`);
        needField(m.denominator_field, `measure ${m.id}`);
      }
      for (const [month, t] of Object.entries(m.targets || {})) {
        if (!MONTH_RE.test(month)) err(`${mat}: target month "${month}" must be YYYY-MM`);
        if (t !== null && typeof t !== 'number') err(`${mat}: target for ${month} must be a number or null`);
      }
      if (m.weekend_targets) {
        if (m.target_per !== 'day' || m.calc !== 'sum') err(`${mat}: weekend_targets only work for daily sum measures`);
        for (const [month, t] of Object.entries(m.weekend_targets)) {
          if (!MONTH_RE.test(month)) err(`${mat}: weekend target month "${month}" must be YYYY-MM`);
          if (t !== null && typeof t !== 'number') err(`${mat}: weekend target for ${month} must be a number or null`);
        }
      }
      if (m.high_days !== undefined && !/^(Sun|Mon|Tue|Wed|Thu|Fri|Sat)(,(Sun|Mon|Tue|Wed|Thu|Fri|Sat))*$/.test(String(m.high_days))) {
        err(`${mat}: high_days must be day names like "Sun,Mon"`);
      }
      if (m.owner !== 'Team' && !people.has(m.owner)) {
        err(`${mat}: owner "${m.owner}" is not a person in this branch`);
      }
    }

    for (const rt of b.running_totals || []) {
      needField(rt.field, `running total ${rt.id}`);
      if (rt.start_value === null || rt.start_value === undefined) {
        warnings.push(`${at}: running total ${rt.id} has no start value yet`);
      }
    }
    for (const month of Object.keys(b.monthly_total_target || {})) {
      if (!MONTH_RE.test(month)) err(`${at}: monthly_total_target month "${month}" must be YYYY-MM`);
    }
  }

  const hqIds = new Set();
  const hqOwners = new Set(((seed.hq && seed.hq.owners) || []).map((o) => o.name));
  for (const m of (seed.hq && seed.hq.measures) || []) {
    if (hqIds.has(m.id)) err(`HQ measure ${m.id}: id appears twice`);
    hqIds.add(m.id);
    if (!['single_value', 'done_and_total', 'yes_no'].includes(m.input)) err(`HQ measure ${m.id}: unknown input "${m.input}"`);
    if (!['high', 'low'].includes(m.better)) err(`HQ measure ${m.id}: better must be high or low`);
    if (!hqOwners.has(m.owner)) err(`HQ measure ${m.id}: owner "${m.owner}" is not an HQ owner`);
  }

  // Guard the privacy rule: no salary anywhere in the seed.
  const { privacy, ...rest } = seed.company || {};
  if (mentionsSalary(JSON.stringify({ ...seed, company: rest }))) {
    err('seed.json mentions salaries – salaries must never be stored in this app');
  }

  return { errors, warnings };
}

function dayBefore(isoDate) {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

// Usernames: the person's first name in lowercase ("hafizah"). If two people share a name,
// the branch code is added ("yaya.jh"). Admin can change usernames later.
function makeUsernames(seed) {
  const all = [];
  for (const b of seed.branches) for (const p of b.people) all.push({ name: p.name, branch: b.code });
  for (const o of seed.hq.owners) if (o.login !== false) all.push({ name: o.name, branch: 'hq' });

  const base = (n) => n.toLowerCase().replace(/[^a-z0-9]+/g, '');
  const counts = {};
  all.forEach((x) => { counts[base(x.name)] = (counts[base(x.name)] || 0) + 1; });

  const map = new Map();
  for (const x of all) {
    const b = base(x.name);
    map.set(`${x.branch}|${x.name}`, counts[b] > 1 ? `${b}.${x.branch.toLowerCase()}` : b);
  }
  return map;
}

function userRoleFor(personRole) {
  return /branch manager/i.test(personRole || '') ? 'branch_manager' : 'branch_staff';
}

async function isSeeded(db) {
  const { rows } = await db.query("SELECT value FROM app_settings WHERE key = 'seed_loaded_at'");
  return rows.length > 0;
}

async function loadSeed(db, seed, { adminPassword } = {}) {
  const { errors } = validateSeed(seed);
  if (errors.length) {
    throw new Error(`seed.json has problems – nothing was loaded:\n  - ${errors.join('\n  - ')}`);
  }
  if (!adminPassword || adminPassword.length < 8) {
    throw new Error('ADMIN_PASSWORD must be set (at least 8 characters) before the first start.');
  }

  const startDate = seed.company.tracker_start_date;
  const usernames = makeUsernames(seed);
  const summary = { branches: 0, people: 0, daily_fields: 0, measures: 0, targets: 0, hq_measures: 0, users: 0 };

  await db.transaction(async (tx) => {
    if (await isSeeded(tx)) throw new Error('Seed has already been loaded into this database.');

    const one = async (sql, params) => (await tx.query(sql, params)).rows[0];

    for (const [bi, b] of seed.branches.entries()) {
      const branch = await one(
        `INSERT INTO branches (code, name, wig, wig_detail, total_sales_fields, online_sales_fields,
           zakat_field, lead1_field, lead2_field, lead_measures,
           stock_turnover_target_per_week, sku_sold_target_per_month, sort_order, sales_sheet)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING id`,
        [b.code, b.name, b.wig, b.wig_detail,
          JSON.stringify(b.total_sales_fields || []), JSON.stringify(b.online_sales_fields || []),
          b.zakat_field, b.lead1_field, b.lead2_field, JSON.stringify(b.lead_measures || []),
          b.stock_turnover_target_per_week, b.sku_sold_target_per_month, bi + 1,
          b.sales_sheet ? JSON.stringify(b.sales_sheet) : null]
      );
      summary.branches++;

      const personIds = {};
      for (const [pi, p] of b.people.entries()) {
        const person = await one(
          'INSERT INTO people (branch_id, name, role, sort_order) VALUES ($1,$2,$3,$4) RETURNING id',
          [branch.id, p.name, p.role, pi + 1]
        );
        personIds[p.name] = person.id;
        summary.people++;

        await tx.query(
          `INSERT INTO users (username, display_name, role, branch_id, person_id)
           VALUES ($1,$2,$3,$4,$5)`,
          [usernames.get(`${b.code}|${p.name}`), p.name, userRoleFor(p.role), branch.id, person.id]
        );
        summary.users++;
      }

      for (const [fi, f] of b.daily_fields.entries()) {
        await tx.query(
          `INSERT INTO daily_fields (branch_id, key, label, owner_name, person_id, type, sort_order)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [branch.id, f.key, f.label, f.owner, personIds[f.owner] || null, f.type, fi + 1]
        );
        summary.daily_fields++;
      }

      for (const [mi, m] of b.measures.entries()) {
        const measure = await one(
          `INSERT INTO measures (branch_id, code, owner_name, person_id, label, kind, unit, target_per,
             calc, numerator_field, denominator_field, note, sort_order, score_by, high_days)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING id`,
          [branch.id, m.id, m.owner, personIds[m.owner] || null, m.label, m.kind, m.unit, m.target_per,
            m.calc, m.numerator_field, m.denominator_field, m.note, mi + 1, m.score_by || 'week', m.high_days || null]
        );
        summary.measures++;
        const weekend = m.weekend_targets || {};
        for (const month of [...new Set([...Object.keys(m.targets || {}), ...Object.keys(weekend)])].sort()) {
          await tx.query(
            'INSERT INTO measure_targets (measure_id, month, target, weekend_target) VALUES ($1,$2,$3,$4)',
            [measure.id, month, (m.targets || {})[month] ?? null, weekend[month] ?? null]
          );
          summary.targets++;
        }
      }

      const bt = b.before_tracker || {};
      const months = new Set([
        ...Object.keys(b.monthly_total_target || {}),
        ...Object.keys(bt.ytd_target_month_end || {}),
      ]);
      for (const month of [...months].sort()) {
        await tx.query(
          `INSERT INTO branch_month_targets (branch_id, month, total_sales_target, ytd_target_month_end)
           VALUES ($1,$2,$3,$4)`,
          [branch.id, month, (b.monthly_total_target || {})[month] ?? null, (bt.ytd_target_month_end || {})[month] ?? null]
        );
      }

      await tx.query(
        `INSERT INTO branch_baselines (branch_id, baseline_end_date, sales_before_start, ytd_sales_to_date)
         VALUES ($1,$2,$3,$4)`,
        [branch.id, dayBefore(startDate), bt.sales_1_to_11_oct ?? null, bt.ytd_sales_to_11_oct ?? null]
      );

      for (const [ri, rt] of (b.running_totals || []).entries()) {
        await tx.query(
          `INSERT INTO running_totals (branch_id, code, label, field_key, start_value, start_date, end_target, sort_order)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [branch.id, rt.id, rt.label, rt.field, rt.start_value, startDate, rt.end_target, ri + 1]
        );
      }
    }

    const hqPeople = {};
    for (const [oi, o] of seed.hq.owners.entries()) {
      const person = await one(
        'INSERT INTO people (branch_id, name, role, sort_order) VALUES (NULL,$1,$2,$3) RETURNING id',
        [o.name, o.role, oi + 1]
      );
      hqPeople[o.name] = person.id;
      summary.people++;
      if (o.login === false) continue; // e.g. the CEO, who logs in as admin
      await tx.query(
        `INSERT INTO users (username, display_name, role, person_id, enters_all_hq) VALUES ($1,$2,$3,$4,$5)`,
        [usernames.get(`hq|${o.name}`), o.name, o.access === 'staff' ? 'hq_staff' : 'hq', person.id, Boolean(o.enters_all)]
      );
      summary.users++;
    }

    for (const [mi, m] of seed.hq.measures.entries()) {
      const hm = await one(
        `INSERT INTO hq_measures (code, owner_name, person_id, label, unit, input, better, kind, note, sort_order)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
        [m.id, m.owner, hqPeople[m.owner] || null, m.label, m.unit, m.input, m.better, m.kind, m.note, mi + 1]
      );
      summary.hq_measures++;
      for (const [month, target] of Object.entries(m.targets || {})) {
        await tx.query(
          'INSERT INTO hq_measure_targets (hq_measure_id, month, target) VALUES ($1,$2,$3)',
          [hm.id, month, target]
        );
      }
    }

    for (const [name, labels] of Object.entries(seed.hq.daily_tasks || {})) {
      if (!hqPeople[name]) continue;
      for (const [i, label] of labels.entries()) {
        await tx.query('INSERT INTO hq_daily_tasks (person_id, label, sort_order) VALUES ($1,$2,$3)', [hqPeople[name], label, i + 1]);
      }
    }
    await require('../hq/wikilist').insertChecklist(tx, seed);
    for (const [i, pr] of (seed.hq.projects || []).entries()) {
      const row = (await tx.query(
        'INSERT INTO hq_projects (project, milestone, owner, start_date, due_date, sort_order) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id',
        [pr.project, pr.milestone, pr.owner, pr.start || null, pr.due || null, i + 1])).rows[0];
      await require('../hq/team').insertSeedSteps(tx, row.id, pr.steps);
    }

    const admin = await one(
      `INSERT INTO users (username, display_name, role, password_hash, is_super)
       VALUES ('admin', 'Admin', 'admin', $1, true) RETURNING id`,
      [bcrypt.hashSync(adminPassword, 10)]
    );
    summary.users++;

    for (const [month, target] of Object.entries(seed.company.monthly_sales_target || {})) {
      await tx.query('INSERT INTO company_month_targets (month, total_sales_target) VALUES ($1, $2)', [month, target]);
    }

    // Company-level settings the screens will need.
    const settings = {
      company_name: seed.company.name,
      period: seed.company.period,
      company_wig: seed.company.company_wig,
      tracker_start_date: startDate,
      sales_sheet_id: seed.company.sales_sheet_id || null,
      seed_loaded_at: new Date().toISOString(),
      hq_access_v1: new Date().toISOString(),
      hq_daily_tasks_v2: new Date().toISOString(),
      sales_sheet_v2: new Date().toISOString(),
      jh_update_v1: new Date().toISOString(),
      wm_update_16oct: new Date().toISOString(),
      sales_sheet_v3: new Date().toISOString(),
      sales_sheet_v4: new Date().toISOString(),
      ampang_aishah_v1: new Date().toISOString(),
      three_items_v1: new Date().toISOString(),
      alia_zakat_task_v1: new Date().toISOString(),
      wig_monday_v1: new Date().toISOString(),
      wiki_checklist_v1: new Date().toISOString(),
      wiki_tasks_v1: new Date().toISOString(),
      wiki_tasks_hanin_v1: new Date().toISOString(),
      wig_week_v1: new Date().toISOString(),
      ampang_anis_v1: new Date().toISOString(),
      project_steps_v1: new Date().toISOString(),
      inventory_team: seed.hq && seed.hq.inventory_team ? JSON.stringify(seed.hq.inventory_team) : null,
      oos_needs_off: seed.hq && seed.hq.oos_needs_off ? JSON.stringify(seed.hq.oos_needs_off) : null,
      hq_extra_moves: seed.hq && seed.hq.extra_moves ? JSON.stringify(seed.hq.extra_moves) : null,
      wiki_approver: seed.hq && seed.hq.wiki_approver ? JSON.stringify(seed.hq.wiki_approver) : null,
      oos_targets: seed.company.oos_targets ? JSON.stringify(seed.company.oos_targets) : null,
      sheet_view_branches: seed.company.sheet_view_branches ? JSON.stringify(seed.company.sheet_view_branches) : null,
    };
    for (const [key, value] of Object.entries(settings)) {
      if (value === null) continue;
      await tx.query('INSERT INTO app_settings (key, value) VALUES ($1,$2)', [key, value]);
    }

    await tx.query(
      `INSERT INTO audit_log (user_id, action, table_name, record_key, new_value)
       VALUES ($1, 'seed', NULL, 'seed.json', $2)`,
      [admin.id, JSON.stringify(summary)]
    );
  });

  return summary;
}

module.exports = { readSeed, validateSeed, loadSeed, isSeeded, makeUsernames, SEED_PATH };
