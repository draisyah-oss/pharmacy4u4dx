// "Export to Excel": one workbook per branch, or one for the whole group.
// Numbers come from the same calculation code as the scoreboards, and the raw daily entries
// (with who entered them, or "Sales sheet") are included so every figure can be checked.

const ExcelJS = require('exceljs');
const calc = require('../calc');
const { loadBranch } = require('../daily/data');
const { weekList, buildScoreboard } = require('../scoreboard/data');
const { weekLabel } = require('../scoreboard/format');

const BRAND = 'FF0F6B4F';
const MONEY = '#,##0.00';
const PCT = '0.0%';
const STATUS_TEXT = { on_track: '✔ On track', watch: '▲ Watch', off_track: '✕ Off track', track_only: 'Track only', no_data: 'No data' };

function styleHeader(ws, rowNumber) {
  const row = ws.getRow(rowNumber);
  row.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  row.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: BRAND } };
  row.alignment = { vertical: 'middle', wrapText: true };
  ws.views = [{ state: 'frozen', ySplit: rowNumber }];
}

// Adds a titled table: title line, header row, data rows. Returns the sheet.
function addTable(wb, name, { title, columns, rows }) {
  const ws = wb.addWorksheet(name.slice(0, 31));
  let first = 1;
  if (title) {
    ws.getCell('A1').value = title;
    ws.getCell('A1').font = { bold: true, size: 13 };
    first = 3;
  }
  ws.getRow(first).values = columns.map((c) => c.header);
  columns.forEach((c, i) => {
    const col = ws.getColumn(i + 1);
    col.width = c.width || 14;
    if (c.format) col.numFmt = c.format;
  });
  for (const r of rows) ws.addRow(columns.map((c) => (r[c.key] === undefined ? null : r[c.key])));
  styleHeader(ws, first);
  if (rows.length) ws.autoFilter = { from: { row: first, column: 1 }, to: { row: first + rows.length, column: columns.length } };
  return ws;
}

async function loadExportContext(db, now) {
  const today = calc.todayInMalaysia(now());
  const start = (await db.query("SELECT value FROM app_settings WHERE key = 'tracker_start_date'")).rows[0].value;
  const company = (await db.query("SELECT value FROM app_settings WHERE key = 'company_name'")).rows[0]?.value || 'Pharmacy4U';
  return { today, start, company, weeks: weekList(start, today), stamp: new Date(now()).toLocaleString('en-MY', { timeZone: 'Asia/Kuala_Lumpur' }) };
}

async function dailySheet(wb, db, branch, ctx, name) {
  const fields = (await db.query('SELECT key, label, type FROM daily_fields WHERE branch_id = $1 AND active ORDER BY sort_order', [branch.id])).rows;
  const rows = (await db.query(
    'SELECT entry_date, field_key, value FROM daily_entries WHERE branch_id = $1 AND entry_date BETWEEN $2 AND $3',
    [branch.id, ctx.start, ctx.today])).rows;
  const idx = calc.indexEntries(rows);
  const data = calc.dateRange(ctx.start, ctx.today).map((d) => {
    const r = { date: new Date(`${d}T00:00:00Z`) };
    for (const f of fields) r[f.key] = idx.get(d, f.key);
    return r;
  });
  addTable(wb, name, {
    title: `${branch.name} – daily entries, ${ctx.start} to ${ctx.today}`,
    columns: [{ header: 'Date', key: 'date', width: 12, format: 'ddd d mmm yyyy' },
      ...fields.map((f) => ({ header: f.label.replace(/\s*\(1\/0\)/, ''), key: f.key, width: 14, format: f.type === 'money' ? MONEY : undefined }))],
    rows: data,
  });
}

async function branchWorkbook(db, code, { now = () => new Date() } = {}) {
  const branch = await loadBranch(db, code);
  if (!branch) return null;
  const ctx = await loadExportContext(db, now);
  const wb = new ExcelJS.Workbook();
  wb.creator = `${ctx.company} 4DX`;
  wb.created = new Date(now());

  // Scoreboard: one row per measure per week, with month to date.
  const sb = [];
  const salesRows = [];
  for (const w of ctx.weeks) {
    const board = await buildScoreboard(db, { branch, weekStart: w, today: ctx.today, trackerStart: ctx.start });
    for (const r of [...board.top, ...board.groups.flatMap((g) => g.rows)]) {
      const pctLike = r.calc === 'ratio_percent' || r.calc === 'average_percent';
      sb.push({
        week: weekLabel(board.weekStart, board.weekEnd), counted: board.asOf, code: r.code, label: r.label,
        owner: r.owner, top: r.top ? 'Yes' : '',
        wa: r.week.actual, wt: r.week.target, wp: r.week.pct, ws: STATUS_TEXT[r.week.status],
        ma: r.mtd.actual, mt: r.mtd.target, mp: r.mtd.pct,
        unit: pctLike ? '%' : r.unit,
      });
    }
    salesRows.push({
      week: weekLabel(board.weekStart, board.weekEnd), counted: board.asOf, weekSales: board.sales.weekTotal,
      month: board.sales.month, mtd: board.sales.mtd, target: board.sales.monthTarget, pct: board.sales.pct,
      pace: board.sales.pacePct, perDay: board.sales.perDay,
    });
  }
  addTable(wb, 'Scoreboard', {
    title: `${branch.name} scoreboard – exported ${ctx.stamp}. ${branch.wig}`,
    columns: [
      { header: 'Week', key: 'week', width: 14 }, { header: 'Counted to', key: 'counted', width: 12 },
      { header: 'Code', key: 'code', width: 7 }, { header: 'Measure', key: 'label', width: 48 },
      { header: 'Owner', key: 'owner', width: 12 }, { header: 'WIG / lead', key: 'top', width: 9 },
      { header: 'Unit', key: 'unit', width: 10 },
      { header: 'Week actual', key: 'wa', format: '#,##0.##' }, { header: 'Week target', key: 'wt', format: '#,##0.##' },
      { header: 'Week %', key: 'wp', format: PCT }, { header: 'Status', key: 'ws', width: 12 },
      { header: 'MTD actual', key: 'ma', format: '#,##0.##' }, { header: 'MTD target', key: 'mt', format: '#,##0.##' },
      { header: 'MTD %', key: 'mp', format: PCT },
    ],
    rows: sb,
  });
  addTable(wb, 'Sales', {
    title: `${branch.name} – total branch sales (${(branch.total_sales_fields || []).join(' + ')})`,
    columns: [
      { header: 'Week', key: 'week', width: 14 }, { header: 'Counted to', key: 'counted', width: 12 },
      { header: 'Week sales', key: 'weekSales', format: MONEY }, { header: 'Month', key: 'month', width: 9 },
      { header: 'Month to date', key: 'mtd', format: MONEY }, { header: 'Month target', key: 'target', format: MONEY },
      { header: '% of month', key: 'pct', format: PCT }, { header: 'Pace %', key: 'pace', format: PCT },
      { header: 'Needed per day', key: 'perDay', format: MONEY },
    ],
    rows: salesRows,
  });

  await dailySheet(wb, db, branch, ctx, 'Daily entries');

  const log = (await db.query(
    `SELECT e.entry_date, e.field_key, f.label, e.value, e.source,
            CASE WHEN e.source = 'sheet' THEN 'Sales sheet' ELSE u.display_name END AS who, e.updated_at
     FROM daily_entries e LEFT JOIN daily_fields f ON f.branch_id = e.branch_id AND f.key = e.field_key
     LEFT JOIN users u ON u.id = e.entered_by
     WHERE e.branch_id = $1 ORDER BY e.entry_date, f.sort_order`, [branch.id])).rows;
  addTable(wb, 'Entry log', {
    title: 'Every daily number: who entered it (or the sales sheet) and when',
    columns: [
      { header: 'Date', key: 'entry_date', width: 12 }, { header: 'Field', key: 'field_key', width: 10 },
      { header: 'Label', key: 'label', width: 40 }, { header: 'Value', key: 'value', format: '#,##0.##' },
      { header: 'From', key: 'who', width: 16 }, { header: 'Updated (MY time)', key: 'updated', width: 20 },
    ],
    rows: log.map((r) => ({ ...r, updated: new Date(r.updated_at).toLocaleString('en-MY', { timeZone: 'Asia/Kuala_Lumpur' }) })),
  });

  const targets = (await db.query(
    `SELECT m.code, m.label, m.owner_name, m.target_per, m.calc, t.month, t.target, t.weekend_target, m.high_days
     FROM measures m JOIN measure_targets t ON t.measure_id = m.id
     WHERE m.branch_id = $1 AND m.active ORDER BY m.sort_order, t.month`, [branch.id])).rows;
  addTable(wb, 'Targets', {
    title: `${branch.name} – targets by month (blank = track only; % measures as 0.45 = 45%)`,
    columns: [
      { header: 'Code', key: 'code', width: 7 }, { header: 'Measure', key: 'label', width: 48 },
      { header: 'Owner', key: 'owner_name', width: 12 }, { header: 'Per', key: 'target_per', width: 7 },
      { header: 'Calc', key: 'calc', width: 13 }, { header: 'Month', key: 'month', width: 9 },
      { header: 'Target', key: 'target', format: '#,##0.##' }, { header: 'Weekend / busy-day target', key: 'weekend_target', format: '#,##0.##' }, { header: 'Busy days', key: 'high_days', width: 10 },
    ],
    rows: targets,
  });

  const people = (await db.query(
    `SELECT p.name, p.role, u.username, u.role AS login, CASE WHEN p.active THEN 'Yes' ELSE 'No' END AS active
     FROM people p LEFT JOIN users u ON u.person_id = p.id WHERE p.branch_id = $1 ORDER BY p.sort_order`, [branch.id])).rows;
  addTable(wb, 'People', {
    columns: [{ header: 'Name', key: 'name', width: 16 }, { header: 'Job', key: 'role', width: 24 },
      { header: 'Username', key: 'username', width: 14 }, { header: 'Login', key: 'login', width: 16 }, { header: 'Active', key: 'active', width: 8 }],
    rows: people,
  });

  return { wb, filename: `Pharmacy4U-${branch.code}-4DX-${ctx.today}.xlsx` };
}

async function groupWorkbook(db, { now = () => new Date() } = {}) {
  const ctx = await loadExportContext(db, now);
  const branches = (await db.query('SELECT code FROM branches WHERE active ORDER BY sort_order')).rows;
  const wb = new ExcelJS.Workbook();
  wb.creator = `${ctx.company} 4DX`;
  wb.created = new Date(now());

  const summary = [];
  const weekly = [];
  const current = ctx.weeks[ctx.weeks.length - 1];
  for (const { code } of branches) {
    const branch = await loadBranch(db, code);
    const measures = (await db.query('SELECT code, numerator_field, kind FROM measures WHERE branch_id = $1 AND active ORDER BY sort_order', [branch.id])).rows;
    const lead = (field) => measures.find((m) => m.numerator_field === field && m.kind !== 'WIG');
    const walkin = measures.find((m) => m.kind === 'WIG' && m.numerator_field === 'walkin');
    for (const w of ctx.weeks) {
      const board = await buildScoreboard(db, { branch, weekStart: w, today: ctx.today, trackerStart: ctx.start });
      const rows = [...board.top, ...board.groups.flatMap((g) => g.rows)];
      const find = (m) => (m ? rows.find((r) => r.code === m.code) : null);
      const wi = find(walkin);
      const l1 = find(lead(branch.lead1_field));
      const l2 = find(lead(branch.lead2_field));
      weekly.push({
        week: weekLabel(board.weekStart, board.weekEnd), branch: code, sales: board.sales.weekTotal,
        walkin: wi && wi.week.pct, lead1: l1 && l1.week.pct, lead2: l2 && l2.week.pct,
      });
      if (w === current) {
        summary.push({
          branch: branch.name, month: board.sales.month, target: board.sales.monthTarget, mtd: board.sales.mtd,
          pct: board.sales.pct, pace: board.sales.pacePct, perDay: board.sales.perDay,
          walkin: wi && wi.mtd.pct, lead1: l1 && l1.mtd.pct, lead1Name: l1 && l1.label,
          lead2: l2 && l2.mtd.pct, lead2Name: l2 && l2.label,
        });
      }
    }
  }
  const total = summary.reduce((a, s) => ({ target: a.target + (s.target || 0), mtd: a.mtd + (s.mtd || 0), perDay: a.perDay + (s.perDay || 0) }), { target: 0, mtd: 0, perDay: 0 });
  summary.push({ branch: 'Company total', target: total.target, mtd: total.mtd, pct: total.target ? total.mtd / total.target : null, perDay: total.perDay });

  const ws = addTable(wb, 'Group summary', {
    title: `${ctx.company} – group summary, month to date, exported ${ctx.stamp}`,
    columns: [
      { header: 'Branch', key: 'branch', width: 18 }, { header: 'Month', key: 'month', width: 9 },
      { header: 'Month target', key: 'target', format: MONEY }, { header: 'Sales so far', key: 'mtd', format: MONEY },
      { header: '% of month', key: 'pct', format: PCT }, { header: 'Pace %', key: 'pace', format: PCT },
      { header: 'Needed per day', key: 'perDay', format: MONEY }, { header: 'Walk-in % of target', key: 'walkin', format: PCT },
      { header: 'Lead 1 %', key: 'lead1', format: PCT }, { header: 'Lead 1', key: 'lead1Name', width: 40 },
      { header: 'Lead 2 %', key: 'lead2', format: PCT }, { header: 'Lead 2', key: 'lead2Name', width: 40 },
    ],
    rows: summary,
  });
  ws.lastRow.font = { bold: true };

  addTable(wb, 'Weekly by branch', {
    title: 'Every week since the tracker started (the current week is counted to the last closed day)',
    columns: [{ header: 'Week', key: 'week', width: 14 }, { header: 'Branch', key: 'branch', width: 9 },
      { header: 'Total sales', key: 'sales', format: MONEY }, { header: 'Walk-in % of target', key: 'walkin', format: PCT },
      { header: 'Lead 1 %', key: 'lead1', format: PCT }, { header: 'Lead 2 %', key: 'lead2', format: PCT }],
    rows: weekly,
  });

  for (const { code } of branches) await dailySheet(wb, db, await loadBranch(db, code), ctx, `${code} daily`);

  // Monday screens: check-ins, OOS list, commitments, HQ entries.
  const checkins = (await db.query(
    `SELECT c.week_start AS week, b.code AS branch, c.opening_stock_value AS open, c.closing_stock_value AS close,
            c.weekly_cogs AS cogs, c.sku_qty_on_hand AS skus, c.skus_sold_mtd AS sold, c.zakat_claims_disbursed AS zpaid,
            c.zakat_claims_pending AS zpending, c.win_this_week AS win, c.issue_needing_hq_help AS issue, u.display_name AS who
     FROM weekly_checkins c JOIN branches b ON b.id = c.branch_id LEFT JOIN users u ON u.id = c.submitted_by
     ORDER BY c.week_start, b.sort_order`)).rows.map((r) => {
    const avg = r.open === null || r.close === null ? null : (Number(r.open) + Number(r.close)) / 2;
    return { ...r, turnover: avg && r.cogs !== null ? Number(r.cogs) / avg : null };
  });
  addTable(wb, 'Weekly check-ins', {
    columns: [{ header: 'Week', key: 'week', width: 12 }, { header: 'Branch', key: 'branch', width: 9 },
      { header: 'Stock Mon', key: 'open', format: MONEY }, { header: 'Stock Sun', key: 'close', format: MONEY },
      { header: 'COGS', key: 'cogs', format: MONEY }, { header: 'Turnover', key: 'turnover', format: '0.00' },
      { header: 'SKUs on hand', key: 'skus' }, { header: 'SKUs sold MTD', key: 'sold' },
      { header: 'Zakat paid', key: 'zpaid' }, { header: 'Zakat pending', key: 'zpending' },
      { header: 'Win', key: 'win', width: 40 }, { header: 'Issue for HQ', key: 'issue', width: 40 }, { header: 'Saved by', key: 'who', width: 12 }],
    rows: checkins,
  });
  addTable(wb, 'Out of stock', {
    columns: [{ header: 'Week logged', key: 'week_start', width: 12 }, { header: 'Branch', key: 'branch', width: 9 },
      { header: 'Item', key: 'item', width: 34 }, { header: 'Out since', key: 'out_of_stock_since', width: 12 },
      { header: 'Customers asking', key: 'customers_asking', width: 24 }, { header: 'Reason (HQ)', key: 'reason_for_delay', width: 30 },
      { header: 'Expected back', key: 'expected_back', width: 12 }, { header: 'Status', key: 'status', width: 16 }],
    rows: (await db.query(`SELECT o.*, COALESCE(b.code, 'B2B') AS branch FROM oos_items o LEFT JOIN branches b ON b.id = o.branch_id ORDER BY o.week_start, b.sort_order NULLS LAST, o.id`)).rows,
  });
  addTable(wb, 'Commitments', {
    columns: [{ header: 'Week', key: 'week_start', width: 12 }, { header: 'Branch', key: 'branch', width: 9 },
      { header: 'Person', key: 'person', width: 12 }, { header: 'Commitment', key: 'commitment', width: 44 },
      { header: 'Measure', key: 'lead_measure', width: 36 }, { header: 'By when', key: 'by_when', width: 12 }, { header: 'Done', key: 'done_text', width: 8 }],
    rows: (await db.query(
      `SELECT c.*, b.code AS branch, p.name AS person FROM commitments c JOIN branches b ON b.id = c.branch_id
       JOIN people p ON p.id = c.person_id ORDER BY c.week_start, b.sort_order, p.sort_order`)).rows
      .map((r) => ({ ...r, done_text: r.done === true ? 'Yes' : r.done === false ? 'No' : '' })),
  });
  addTable(wb, 'HQ entries', {
    columns: [{ header: 'Week', key: 'week_start', width: 12 }, { header: 'Owner', key: 'owner_name', width: 10 },
      { header: 'Measure', key: 'label', width: 56 }, { header: 'Unit', key: 'unit', width: 9 },
      { header: 'Value (done)', key: 'value', format: '#,##0.##' }, { header: 'Out of', key: 'total', format: '#,##0.##' },
      { header: 'Entered by', key: 'who', width: 12 }],
    rows: (await db.query(
      `SELECT e.week_start, e.value, e.total, m.owner_name, m.label, m.unit, u.display_name AS who
       FROM hq_entries e JOIN hq_measures m ON m.id = e.hq_measure_id LEFT JOIN users u ON u.id = e.entered_by
       ORDER BY e.week_start, m.sort_order`)).rows,
  });

  const hq = (await db.query(
    `SELECT m.code, m.owner_name, m.label, m.unit, m.better, t.month, t.target FROM hq_measures m
     JOIN hq_measure_targets t ON t.hq_measure_id = m.id WHERE m.active ORDER BY m.sort_order, t.month`)).rows;
  addTable(wb, 'HQ targets', {
    columns: [{ header: 'Code', key: 'code', width: 8 }, { header: 'Owner', key: 'owner_name', width: 10 },
      { header: 'Measure', key: 'label', width: 56 }, { header: 'Unit', key: 'unit', width: 9 },
      { header: 'Better', key: 'better', width: 7 }, { header: 'Month', key: 'month', width: 9 }, { header: 'Target', key: 'target', format: '#,##0.##' }],
    rows: hq,
  });

  const audit = (await db.query(
    `SELECT a.at, COALESCE(u.display_name, CASE WHEN a.action LIKE 'sheet%' THEN 'Sales sheet' ELSE 'System' END) AS who,
            a.action, a.table_name, a.record_key, a.old_value::text AS old_value, a.new_value::text AS new_value
     FROM audit_log a LEFT JOIN users u ON u.id = a.user_id ORDER BY a.id DESC LIMIT 5000`)).rows;
  addTable(wb, 'Audit log', {
    title: 'Latest 5,000 changes, newest first',
    columns: [{ header: 'When (MY time)', key: 'when', width: 20 }, { header: 'Who', key: 'who', width: 14 },
      { header: 'Action', key: 'action', width: 13 }, { header: 'Table', key: 'table_name', width: 18 },
      { header: 'What', key: 'record_key', width: 34 }, { header: 'Old', key: 'old_value', width: 14 }, { header: 'New', key: 'new_value', width: 14 }],
    rows: audit.map((r) => ({ ...r, when: new Date(r.at).toLocaleString('en-MY', { timeZone: 'Asia/Kuala_Lumpur' }) })),
  });

  return { wb, filename: `Pharmacy4U-group-4DX-${ctx.today}.xlsx` };
}

module.exports = { branchWorkbook, groupWorkbook };
