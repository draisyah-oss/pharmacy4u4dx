// Tiny CSV reader for test fixtures (handles quoted cells with commas and line breaks),
// and a splitter for the "## Sheet name: …" export of the sales sheet.

function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
    else if (c !== '\r') cell += c;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

// { 'Daily sales WM': [[...], ...], ... }
function readSheetExport(text) {
  const tabs = {};
  const parts = text.split(/^## Sheet name: (.+)$/m);
  for (let i = 1; i < parts.length; i += 2) tabs[parts[i].trim()] = parseCsv(parts[i + 1].replace(/^\n/, ''));
  return tabs;
}

module.exports = { parseCsv, readSheetExport };
