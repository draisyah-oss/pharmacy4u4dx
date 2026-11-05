// 28 Oct (CEO): "Download Excel" on the out-of-stock inbox, so Inventory can review the list,
// share it and add their own notes. One-way: the app stays the place answers are saved (the
// branches, the step line and "seen by" all read from it). Sheets:
//   Open items      – every open item, by branch (WM … Ampang) then B2B, urgent first, then oldest
//   <branch> / B2B  – the same rows, one sheet per branch that has open items
//   Done – 14 days  – items closed in the last 14 days
//   New item requests – items a branch wants that aren't in Dynamod yet (open + last 30 days)
// Each item row ends with an empty "Inventory notes" column for Inventory to type into, and a link
// back to the item in the app.

const ExcelJS = require('exceljs');
const calc = require('../calc');
const oos = require('./data');
const requests = require('./requests');

const BRAND = 'FF004AAD'; // Pharmacy4U blue
const NOTES_FILL = 'FFFFF6D5';
const URGENT_FILL = 'FFFDE2E1';
const DATE_TIME = 'd mmm yyyy h:mm AM/PM';
const DATE = 'ddd d mmm yyyy';

// Malaysia wall-clock time as a plain date Excel shows as-is (Excel has no time zones).
const myt = (ts) => (ts ? new Date(new Date(ts).getTime() + 8 * 3600e3) : null);
const day = (iso) => (iso ? new Date(`${iso}T00:00:00Z`) : null);
const customers = (n) => (n == null ? null : n === 0 ? '0' : n >= 3 ? '3+' : '1–2');
const left = (n) => (n == null ? null : n);

function answerLabel(it) {
  if (!it.answer) return null;
  if (it.answer === 'transfer' && it.from_branch_id && it.from_branch_id === it.branch_id) return 'From own stock';
  return (oos.ANSWERS[it.answer] || {}).label || it.answer;
}

function fromLabel(it) {
  if (it.answer === 'hq_deliver') return 'HQ';
  if (it.answer !== 'transfer') return null;
  return it.from_branch_id && it.from_branch_id === it.branch_id ? `${it.from_code} (own stock)` : it.from_code;
}

function lastMessage(it) {
  const m = (it.messages || [])[(it.messages || []).length - 1];
  if (!m) return null;
  const who = m.from_branch ? (m.display_name || 'Branch') : (m.display_name || 'Inventory');
  return `${who}: ${m.body || '(photo)'}`;
}

const ITEM_COLUMNS = [
  { header: 'Branch', key: 'branch', width: 9 },
  { header: '#', key: 'id', width: 7 },
  { header: 'Item', key: 'item', width: 32 },
  { header: 'Stock ID', key: 'stockId', width: 10 },
  { header: 'UOM', key: 'uom', width: 7 },
  { header: 'Barcode', key: 'barcode', width: 15 },
  { header: 'Urgent', key: 'urgent', width: 8 },
  { header: 'Left', key: 'left', width: 6 },
  { header: 'Customers asking', key: 'customers', width: 10 },
  { header: 'Branch note', key: 'note', width: 28 },
  { header: 'Reported', key: 'reported', width: 19, format: DATE_TIME },
  { header: 'Reported by', key: 'reportedBy', width: 14 },
  { header: 'Days open', key: 'daysOpen', width: 8, format: '0.0' },
  { header: 'Times in 30 days', key: 'times', width: 9 },
  { header: 'Seen by', key: 'seenBy', width: 12 },
  { header: 'Seen', key: 'seen', width: 19, format: DATE_TIME },
  { header: 'Status', key: 'status', width: 16 },
  { header: 'Answer', key: 'answer', width: 22 },
  { header: 'Qty', key: 'qty', width: 6 },
  { header: 'From', key: 'from', width: 14 },
  { header: 'Arrives by', key: 'arrives', width: 15, format: DATE },
  { header: 'Late', key: 'late', width: 7 },
  { header: 'Substitute', key: 'substitute', width: 22 },
  { header: 'Note to branch', key: 'reason', width: 28 },
  { header: 'Answered by', key: 'answeredBy', width: 12 },
  { header: 'Answered', key: 'answered', width: 19, format: DATE_TIME },
  { header: 'Sent', key: 'sent', width: 19, format: DATE_TIME },
  { header: 'Last message', key: 'lastMessage', width: 34 },
  { header: 'Inventory notes', key: 'notes', width: 34 },
  { header: 'Open in app', key: 'link', width: 14 },
];

function itemRow(it, at, base) {
  const closedAt = it.received_at || (!it.isOpen ? it.updated_at : null);
  return {
    branch: it.branch_code === 'B2B' ? `B2B` : it.branch_code,
    id: it.id,
    item: it.branch_id ? it.item : `${it.item} (${it.b2b_customer})`,
    stockId: it.product_stock_id || null, uom: it.product_uom || null, barcode: it.product_barcode || null,
    urgent: it.urgent ? 'Urgent' : it.urgency === 'soon' ? 'Soon' : null,
    left: left(it.left_qty),
    customers: customers(it.customers_count),
    note: it.note || null,
    reported: myt(it.reported_at),
    reportedBy: it.reported_by_name || null,
    daysOpen: Math.round(((closedAt ? new Date(closedAt) : at) - new Date(it.reported_at)) / 8640e3) / 10,
    times: it.timesThisMonth || 1,
    seenBy: it.seen_by_name || (it.seen_at ? '–' : 'Not opened yet'),
    seen: myt(it.seen_at),
    status: it.status,
    answer: answerLabel(it),
    qty: it.answer_qty ?? null,
    from: fromLabel(it),
    arrives: day(it.expected_back),
    late: it.late || it.late_flagged_at ? 'LATE' : null,
    substitute: it.substitute || null,
    reason: it.reason_for_delay || null,
    answeredBy: it.answered_by_name || null,
    answered: myt(it.answered_at),
    sent: myt(it.sent_at),
    lastMessage: lastMessage(it),
    notes: null,
    link: base ? { text: `Item #${it.id}`, hyperlink: `${base}/oos/${it.id}` } : null,
  };
}

function addSheet(wb, name, { title, columns, rows, urgentKey }) {
  const ws = wb.addWorksheet(name.slice(0, 31));
  ws.getCell('A1').value = title;
  ws.getCell('A1').font = { bold: true, size: 13 };
  const head = 3;
  ws.getRow(head).values = columns.map((c) => c.header);
  columns.forEach((c, i) => {
    const col = ws.getColumn(i + 1);
    col.width = c.width || 14;
    if (c.format) col.numFmt = c.format;
  });
  const hr = ws.getRow(head);
  hr.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  hr.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: BRAND } };
  hr.alignment = { vertical: 'middle', wrapText: true };
  hr.height = 30;
  ws.views = [{ state: 'frozen', ySplit: head, xSplit: 3 }];
  const notesCol = columns.findIndex((c) => c.key === 'notes') + 1;
  for (const r of rows) {
    const row = ws.addRow(columns.map((c) => (r[c.key] === undefined ? null : r[c.key])));
    row.alignment = { vertical: 'top', wrapText: true };
    if (urgentKey && r[urgentKey]) row.getCell(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: URGENT_FILL } };
    if (notesCol) row.getCell(notesCol).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: NOTES_FILL } };
    const linkCol = columns.findIndex((c) => c.key === 'link') + 1;
    if (linkCol && r.link) row.getCell(linkCol).font = { color: { argb: BRAND }, underline: true };
  }
  if (rows.length) ws.autoFilter = { from: { row: head, column: 1 }, to: { row: head + rows.length, column: columns.length } };
  else ws.getCell(`A${head + 1}`).value = 'Nothing here.';
  return ws;
}

// The workbook Inventory downloads from the inbox. base = the app's address for the item links.
async function oosWorkbook(db, { now = () => new Date(), base = '' } = {}) {
  const at = now();
  const today = calc.todayInMalaysia(at);
  const stamp = at.toLocaleString('en-MY', { timeZone: 'Asia/Kuala_Lumpur', dateStyle: 'medium', timeStyle: 'short' });
  const inbox = await oos.loadInbox(db, { now });
  const branches = (await db.query('SELECT code FROM branches WHERE active ORDER BY sort_order')).rows.map((b) => b.code);
  const rank = (code) => { const i = branches.indexOf(code); return i < 0 ? branches.length : i; };

  // Same order as the inbox table: branch, then urgent first, then the oldest.
  const open = [...inbox.toAnswer, ...inbox.waiting].sort((a, b) => rank(a.branch_code) - rank(b.branch_code)
    || Number(b.urgent) - Number(a.urgent) || new Date(a.reported_at) - new Date(b.reported_at));

  const wb = new ExcelJS.Workbook();
  wb.creator = 'Pharmacy4U 4DX';
  wb.created = at;

  const rows = open.map((it) => itemRow(it, at, base));
  addSheet(wb, 'Open items', {
    title: `Out of stock – open items, exported ${stamp} (${open.length} open, ${inbox.toAnswer.length} to answer). Answers are saved in the app; use "Inventory notes" for your own notes.`,
    columns: ITEM_COLUMNS, rows, urgentKey: 'urgent',
  });
  for (const code of [...branches, 'B2B']) {
    const mine = rows.filter((r) => r.branch === code);
    if (!mine.length) continue;
    addSheet(wb, code, { title: `${code} – open out-of-stock items, exported ${stamp}`, columns: ITEM_COLUMNS, rows: mine, urgentKey: 'urgent' });
  }

  addSheet(wb, 'Done – 14 days', {
    title: `Out of stock – closed in the last 14 days, exported ${stamp}`,
    columns: ITEM_COLUMNS.filter((c) => !['notes', 'late'].includes(c.key)).concat([{ header: 'Closed', key: 'closed', width: 19, format: DATE_TIME }]),
    rows: inbox.done.map((it) => ({ ...itemRow(it, at, base), closed: myt(it.received_at || it.updated_at) })),
  });

  const nr = await requests.loadInbox(db, { now });
  addSheet(wb, 'New item requests', {
    title: `New item requests (not in Dynamod yet) – open and last 30 days, exported ${stamp}`,
    columns: [
      { header: 'Branch', key: 'branch', width: 9 },
      { header: '#', key: 'id', width: 7 },
      { header: 'Item', key: 'item', width: 32 },
      { header: 'Brand / size / where seen', key: 'details', width: 28 },
      { header: 'Customers asking', key: 'customers', width: 10 },
      { header: 'Branch note', key: 'note', width: 28 },
      { header: 'Asked', key: 'asked', width: 19, format: DATE_TIME },
      { header: 'Asked by', key: 'askedBy', width: 14 },
      { header: 'Seen by', key: 'seenBy', width: 12 },
      { header: 'Status', key: 'status', width: 16 },
      { header: 'Note to branch', key: 'answerNote', width: 28 },
      { header: 'Answered by', key: 'answeredBy', width: 12 },
      { header: 'Last message', key: 'lastMessage', width: 34 },
      { header: 'Inventory notes', key: 'notes', width: 34 },
      { header: 'Open in app', key: 'link', width: 14 },
    ],
    rows: [...nr.open, ...nr.done].map((r) => ({
      branch: r.branch_code, id: r.id, item: r.item, details: r.details || null,
      customers: r.customers_count == null ? null : r.customers_count >= 4 ? '4+' : r.customers_count >= 2 ? '2–3' : String(r.customers_count),
      note: r.note || null, asked: myt(r.created_at), askedBy: r.asked_by_name || null,
      seenBy: r.seen_by_name || (r.seen_at ? '–' : 'Not opened yet'), status: r.status, answerNote: r.answer_note || null,
      answeredBy: r.answered_by_name || null, lastMessage: lastMessage(r), notes: null,
      link: base ? { text: `Request #${r.id}`, hyperlink: `${base}/oos/new-items/${r.id}` } : null,
    })),
  });

  return { wb, filename: `Pharmacy4U-out-of-stock-${today}.xlsx`, count: open.length };
}

module.exports = { oosWorkbook };
