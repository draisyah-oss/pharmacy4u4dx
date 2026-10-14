// Daily entries come from the database as rows: { entry_date, field_key, value }.
// This indexes them so calculations can ask "what was walk-in on 14 Oct?" quickly.

function indexEntries(rows) {
  const byDate = new Map();
  for (const r of rows) {
    if (!byDate.has(r.entry_date)) byDate.set(r.entry_date, new Map());
    byDate.get(r.entry_date).set(r.field_key, Number(r.value));
  }
  return {
    // value for a field on a date, or null if nothing was entered
    get(date, field) {
      const day = byDate.get(date);
      return day && day.has(field) ? day.get(field) : null;
    },
    has(date, field) {
      const day = byDate.get(date);
      return Boolean(day && day.has(field));
    },
  };
}

// Handy for tests and fixtures: { '2026-10-12': { walkin: 1650, tx: 55 }, ... } → rows
function rowsFromDays(days) {
  const rows = [];
  for (const [date, fields] of Object.entries(days)) {
    for (const [field, value] of Object.entries(fields)) {
      if (value !== null && value !== undefined) rows.push({ entry_date: date, field_key: field, value });
    }
  }
  return rows;
}

module.exports = { indexEntries, rowsFromDays };
