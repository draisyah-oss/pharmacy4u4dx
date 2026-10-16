// Reading a branch's daily sales tab from the 2026 Sales Dashboard sheet.
//
// Each tab is a run of month blocks: a month label, a header row ("Day, Date, Transaction,
// Cash, …, Total, …"), one row per day, then total rows. Column order differs between
// branches and sometimes between months, so every block's header row is read and columns
// are found by their header text. Rows without a d/m/yyyy date (totals, averages) are skipped.

// "1,146.01" → 1146.01 ; 1146.01 → 1146.01 ; "", "-", "#DIV/0!" → null
function parseNumber(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const s = String(v).trim().replace(/^RM\s*/i, '').replace(/,/g, '');
  if (s === '' || s === '-' || !/^-?\d*\.?\d+$/.test(s)) return null;
  return Number(s);
}

// "1/10/2026" or "01/10/2026" (day/month/year) → "2026-10-01". Also accepts a sheet date
// serial number (days since 30 Dec 1899) in case a cell comes back unformatted.
function parseDate(v) {
  if (typeof v === 'number' && v > 40000 && v < 80000) {
    const d = new Date(Date.UTC(1899, 11, 30) + Math.round(v) * 86400000);
    return d.toISOString().slice(0, 10);
  }
  const m = String(v ?? '').trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return null;
  const [, d, mo, y] = m.map(Number);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  const iso = `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  return new Date(`${iso}T00:00:00Z`).toISOString().slice(0, 10) === iso ? iso : null;
}

// Header text compared without case, spaces or punctuation: "GRAB PAY" (WM) = "Grabpay" (BR),
// "Zakat " = "Zakat", "Grab sales (RM)" = "grab sales rm".
const norm = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '');

function isHeaderRow(row) {
  const cells = row.map(norm);
  return cells.includes('date') && cells.includes('transaction');
}

// A column setting is a header ("Zakat") or a header minus others:
// { "column": "Total", "minus": ["GRAB PAY"] } – walk-in = the till total without Grab Pay,
// because Grab Pay is counted separately as Grab sales.
// A header can also be a list of names the sheet may use (first one found wins), e.g.
// ["GRAB PAY", "Grabpay", "Grab sales (RM)"] – so renaming a column in the sheet doesn't break it.
const names = (h) => (Array.isArray(h) ? h : [h]).map(norm);
function columnSpec(spec) {
  if (spec && typeof spec === 'object' && !Array.isArray(spec)) {
    return { column: names(spec.column), minus: (spec.minus || []).map(names) };
  }
  return { column: names(spec), minus: [] };
}
const findCol = (cells, alts) => { for (const a of alts) { const i = cells.indexOf(a); if (i >= 0) return i; } return -1; };
const label = (h) => (Array.isArray(h) ? h[0] : h);

// rows: the tab as an array of rows (arrays of cells).
// columns: { appFieldKey: 'Header text in the sheet' or { column, minus }, ... }
//   e.g. { walkin: { column: 'Total', minus: ['GRAB PAY'] }, grab: 'GRAB PAY', tx: 'Transaction' }
// Returns [{ date: '2026-10-12', values: { walkin: 1565.85, tx: 55 }, row: 412 }] – row is
// the 1-based sheet row, so the app can say exactly where a number came from.
// A date that appears twice (e.g. a stray empty "01/09/2026" row above the real one) is
// merged: empty cells never wipe a number, and the last filled-in value wins.
function parseSalesTab(rows, columns) {
  const byDate = new Map();
  const wanted = Object.entries(columns).map(([field, spec]) => [field, columnSpec(spec)]);
  let colOf = null;   // field → { idx, minus: [idx…] } for the current month block
  let dateCol = -1;

  rows.forEach((row, i) => {
    if (!Array.isArray(row)) return;
    if (isHeaderRow(row)) {
      const cells = row.map(norm);
      dateCol = cells.indexOf('date');
      colOf = {};
      for (const [field, spec] of wanted) {
        const idx = findCol(cells, spec.column);
        if (idx >= 0) colOf[field] = { idx, minus: spec.minus.map((alts) => findCol(cells, alts)).filter((j) => j >= 0) };
      }
      return;
    }
    if (!colOf) return;
    const date = parseDate(row[dateCol]);
    if (!date) return;
    const values = {};
    for (const [field, c] of Object.entries(colOf)) {
      let n = parseNumber(row[c.idx]);
      if (n === null) continue;
      for (const j of c.minus) n -= parseNumber(row[j]) || 0;
      values[field] = Math.round(n * 100) / 100;
    }
    const seen = byDate.get(date);
    if (seen) {
      Object.assign(seen.values, values);
      if (Object.keys(values).length) seen.row = i + 1;
      seen.duplicate = true;
    } else {
      byDate.set(date, { date, values, row: i + 1 });
    }
  });
  return [...byDate.values()].sort((a, b) => (a.date < b.date ? -1 : 1));
}

// Columns the newest month block of a tab doesn't have: ["Grab sales (RM) – column “GRAB PAY”", …].
// Shown on the Setup page so a renamed column in the sheet is spotted at once.
function missingColumns(rows, columns) {
  const header = [...(rows || [])].reverse().find((r) => Array.isArray(r) && isHeaderRow(r));
  if (!header) return ['no header row with “Date” and “Transaction”'];
  const cells = header.map(norm);
  const out = [];
  for (const [field, raw] of Object.entries(columns)) {
    const spec = columnSpec(raw);
    const h = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw.column : raw;
    if (findCol(cells, spec.column) < 0) out.push(`${field}: no column “${label(h)}”`);
    spec.minus.forEach((alts, i) => {
      if (findCol(cells, alts) < 0) out.push(`${field}: no column “${label(raw.minus[i])}” to take off`);
    });
  }
  return out;
}

module.exports = { parseNumber, parseDate, parseSalesTab, isHeaderRow, missingColumns };
