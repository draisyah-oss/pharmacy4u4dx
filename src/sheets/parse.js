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

const norm = (s) => String(s ?? '').trim().toLowerCase().replace(/\s+/g, ' ');

function isHeaderRow(row) {
  const cells = row.map(norm);
  return cells.includes('date') && cells.includes('transaction');
}

// rows: the tab as an array of rows (arrays of cells).
// columns: { appFieldKey: 'Header text in the sheet', ... } e.g. { walkin: 'Total', tx: 'Transaction' }
// Returns [{ date: '2026-10-12', values: { walkin: 1565.85, tx: 55 }, row: 412 }] – row is
// the 1-based sheet row, so the app can say exactly where a number came from.
// A date that appears twice (e.g. a stray empty "01/09/2026" row above the real one) is
// merged: empty cells never wipe a number, and the last filled-in value wins.
function parseSalesTab(rows, columns) {
  const byDate = new Map();
  const wanted = Object.entries(columns).map(([field, header]) => [field, norm(header)]);
  let colOf = null;   // field → column index for the current month block
  let dateCol = -1;

  rows.forEach((row, i) => {
    if (!Array.isArray(row)) return;
    if (isHeaderRow(row)) {
      const cells = row.map(norm);
      dateCol = cells.indexOf('date');
      colOf = {};
      for (const [field, header] of wanted) {
        const idx = cells.indexOf(header);
        if (idx >= 0) colOf[field] = idx;
      }
      return;
    }
    if (!colOf) return;
    const date = parseDate(row[dateCol]);
    if (!date) return;
    const values = {};
    for (const [field, idx] of Object.entries(colOf)) {
      const n = parseNumber(row[idx]);
      if (n !== null) values[field] = n;
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

module.exports = { parseNumber, parseDate, parseSalesTab, isHeaderRow };
