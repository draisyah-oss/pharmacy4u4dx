// The quotation PDF (11 Nov 2026) – laid out like quotation_template_QT-WM-2026-0224.pdf (A4 portrait).
// Positions are the template's own (points from the top-left; text placed by its baseline), font
// Carlito (free, same shape and widths as Calibri) – 9.3 pt headers, 8.4 pt table.
// More lines than fit → page 2 …; every page repeats the header, "Page x of y" and the footer;
// TOTAL, note and signature go on the last page.

const path = require('path');
const fs = require('fs');
const PDFDocument = require('pdfkit');
const L = require('./logic');

const ASSETS = path.join(__dirname, 'assets');
const asset = (f) => fs.readFileSync(path.join(ASSETS, f));
let cache = null;
const files = () => (cache = cache || {
  regular: asset('Carlito.ttf'), bold: asset('Carlito-Bold.ttf'),
  header: asset('header_banner.png'), title: asset('title_quotation.png'), footer: asset('footer_wm.png'),
});

const H = 9.28; // header / body text (template 13 × 0.714)
const T = 8.35; // table text (11.7 × 0.714)
const LEFT = 56.1; const INDENT = 86.1; const VALUE_X = 441.0;
const LINE = 14.28; // 20 × 0.714
const ROW_TOP = 294.24; // first table row baseline
const ROW_GAP = 17.1; // single-line row pitch
const SUB_LINE = 10.7; // second line (pre-order note) under the description; a 2-line row is 27.8 pt
const DESC_W = 228; // description column width (86 → 314)
const LAST_PAGE_LIMIT = 545; // rows must end above TOTAL (thick rule at 554)
const PAGE_LIMIT = 680; // other pages: rows end above the footer (693)
const COL = { item: 59.7, desc: 178.25, qty: 329.6, price: 370.3, total: 456.7 };

const dmy = (iso) => { const [y, m, d] = String(iso).split('-'); return `${d}/${m}/${y}`; };

function makeDoc() {
  const f = files();
  const doc = new PDFDocument({ size: 'A4', margin: 0, autoFirstPage: false, info: { Title: 'Quotation', Author: 'Pharmacy4U' } });
  doc.registerFont('R', f.regular); doc.registerFont('B', f.bold);
  return doc;
}

// Text by its baseline (pdfkit places text by the top of the line).
// No ligatures, so "ti" / "fi" copy out of the PDF as plain letters (Description, notice).
const NOLIG = { features: { liga: false, clig: false, dlig: false } };
function at(doc, font, size, text, x, baseline, opts = {}) {
  doc.font(font).fontSize(size);
  const top = baseline - (doc._font.ascender / 1000) * size;
  let left = x;
  if (opts.align === 'center') left = x - doc.widthOfString(text, NOLIG) / 2;
  if (opts.align === 'right') left = x - doc.widthOfString(text, NOLIG);
  doc.text(text, left, top, { lineBreak: false, ...NOLIG });
}

// Description lines (wrapped to the column) + the note line under it.
function rowLines(doc, line) {
  doc.font('R').fontSize(T);
  const words = String(line.description || '').split(/\s+/).filter(Boolean);
  const out = []; let cur = '';
  for (const w of words) {
    const tryLine = cur ? `${cur} ${w}` : w;
    if (cur && doc.widthOfString(tryLine) > DESC_W) { out.push(cur); cur = w; } else cur = tryLine;
  }
  if (cur) out.push(cur);
  const note = String(line.note || '').trim();
  if (note) out.push(`(${note.replace(/^\(|\)$/g, '')})`);
  return out.length ? out : [''];
}
const rowHeight = (n) => ROW_GAP + (n - 1) * SUB_LINE;

// Pages of rows: fill to PAGE_LIMIT; the last page must also leave room for the TOTAL block.
// shift = how far a longer address pushes the table down. Returns [[row indexes], …] per page.
function paginate(heights, shift = 0) {
  const top = ROW_TOP + shift;
  const pages = [[]]; let y = top;
  heights.forEach((h, i) => {
    if (pages[pages.length - 1].length && y + h - ROW_GAP > PAGE_LIMIT) { pages.push([]); y = top; }
    pages[pages.length - 1].push(i); y += h;
  });
  const last = pages[pages.length - 1];
  let end = top + last.reduce((s, i) => s + heights[i], 0) - ROW_GAP;
  const moved = [];
  while (last.length > 1 && end > LAST_PAGE_LIMIT) { const i = last.pop(); moved.unshift(i); end -= heights[i]; }
  if (moved.length) pages.push(moved);
  return pages;
}

// The footer band: the branch's footer picture (WM's is built in), else its name and typed address.
function footer(doc, opts) {
  const b = opts.branch || {};
  const pic = opts.footer || (!b.code || b.code === 'WM' ? files().footer : null);
  if (pic) { try { doc.image(pic, 56.1, 693.1, { width: 477.7, height: 63.6 }); return; } catch (err) { /* fall back to text */ } }
  doc.rect(56.1, 693.1, 477.7, 63.6).fill('#1d3b8f');
  doc.fillColor('#ffffff');
  at(doc, 'B', 10, `Pharmacy4u ${b.name || ''}`.trim(), 300, 710);
  String(b.footer_lines || '').split('\n').filter(Boolean).slice(0, 3).forEach((t, i) => at(doc, 'R', 9, t, 300, 724 + i * 11));
  doc.fillColor('#000000');
}

function pageFrame(doc, q, pageNo, pageCount, opts = {}) {
  const f = files();
  doc.addPage({ size: 'A4', margin: 0 });
  doc.image(f.header, 54, 28.35, { width: 443.4, height: 106.4 });
  doc.image(f.title, 204.7, 108.3, { width: 132.1, height: 34.3 });
  // To:
  at(doc, 'B', H, 'To:', LEFT, 154.47);
  const rec = String(q.recipient || '').split('\n').filter(Boolean).slice(0, 7);
  rec.forEach((t, i) => at(doc, 'R', H, t, INDENT, 154.47 + i * LINE));
  at(doc, 'R', H, `TEL :${q.tel ? ` ${q.tel}` : ''}`, LEFT, 154.47 + Math.max(5, rec.length) * LINE);
  // Your Ref / C. C. / Date / Page – labels right-aligned to the end of "Your Ref :"
  doc.font('B').fontSize(H);
  const right = 399.3 + doc.widthOfString('Your Ref :');
  [['Your Ref :', q.ref], ['C. C. :', q.cc || ''], ['Date :', dmy(q.quote_date)], ['Page :', `${pageNo} of ${pageCount}`]].forEach(([label, value], i) => {
    const y = 154.47 + i * LINE;
    at(doc, 'B', H, label, right, y, { align: 'right' });
    if (value) at(doc, 'R', H, value, VALUE_X, y);
  });
  const shift = Math.max(0, rec.length - 5) * LINE; // a longer address pushes the table down
  at(doc, 'R', H, 'Thank you for your inquiry. We are pleased to submit our quote as follows:', LEFT, 255.15 + shift);
  // Table header – grey band
  doc.rect(53.3, 265.4 + shift, 462.7, 19.3).fill('#d9d9d9');
  doc.fillColor('#000000');
  at(doc, 'B', H, 'Item', COL.item, 278.0 + shift);
  at(doc, 'B', H, 'Description', COL.desc, 278.0 + shift);
  at(doc, 'B', H, 'Qty', COL.qty, 278.0 + shift);
  at(doc, 'B', H, 'U/ Price (RM)', COL.price, 278.0 + shift);
  at(doc, 'B', H, 'Total (RM)', COL.total, 278.0 + shift);
  footer(doc, opts);
  return shift;
}

// Column centres = the header words' centres (as in the template).
function centres(doc) {
  doc.font('B').fontSize(H);
  const c = (x, t) => x + doc.widthOfString(t) / 2;
  return { item: c(COL.item, 'Item'), qty: c(COL.qty, 'Qty'), price: c(COL.price, 'U/ Price (RM)'), total: c(COL.total, 'Total (RM)') };
}

async function quotationPdf(q, opts = {}) {
  if (opts.branch && opts.branch.layout === 'br') return brPdf(q, opts);
  const signature = opts.signature || null;
  const b = opts.branch || {};
  const doc = makeDoc();
  const chunks = [];
  doc.on('data', (c) => chunks.push(c));
  const done = new Promise((resolve, reject) => { doc.on('end', resolve); doc.on('error', reject); });

  const lines = q.lines.map((l) => ({ ...l, rows: null }));
  lines.forEach((l) => { l.rows = rowLines(doc, l); });
  const shiftAll = Math.max(0, String(q.recipient || '').split('\n').filter(Boolean).slice(0, 7).length - 5) * LINE;
  const heights = lines.map((l) => rowHeight(l.rows.length));
  const pagesFinal = paginate(heights, shiftAll);
  const total = q.total !== undefined && q.total !== null ? Number(q.total) : lines.reduce((s, l) => s + Math.round(l.qty * l.unit_price * 100) / 100, 0);

  pagesFinal.forEach((idx, p) => {
    const shift = pageFrame(doc, q, p + 1, pagesFinal.length, opts);
    const c = centres(doc);
    let y = ROW_TOP + shift;
    for (const i of idx) {
      const l = lines[i];
      at(doc, 'R', T, String(l.line_no || i + 1), c.item, y, { align: 'center' });
      l.rows.forEach((t, k) => at(doc, 'R', T, t, INDENT, y + k * SUB_LINE));
      at(doc, 'R', T, String(l.qty), c.qty, y, { align: 'center' });
      at(doc, 'R', T, L.money(l.unit_price), c.price, y, { align: 'center' });
      at(doc, 'R', T, `RM${L.money(Math.round(l.qty * l.unit_price * 100) / 100)}`, c.total, y, { align: 'center' });
      y += heights[i];
    }
    if (p < pagesFinal.length - 1) {
      at(doc, 'R', T, 'Continued on the next page …', 516, Math.min(y + 4, 685), { align: 'right' });
      return;
    }
    // TOTAL: thick rule, total, double rule
    doc.lineWidth(2.14).moveTo(355.3, 554.3).lineTo(516.0, 554.3).stroke('#000000');
    at(doc, 'B', H, 'TOTAL', 348.4, 565.06, { align: 'right' });
    at(doc, 'B', H, `RM${L.money(total)}`, 435.6, 565.06, { align: 'center' });
    doc.lineWidth(0.71).moveTo(355.3, 568.6).lineTo(516.0, 568.6).stroke('#000000');
    doc.lineWidth(0.71).moveTo(355.3, 570.0).lineTo(516.0, 570.0).stroke('#000000');
    at(doc, 'R', T, 'Note : Prices are subjected to change without prior notice. We hope that our quotation is favourable to you and looking forward to', LEFT, 589.1);
    at(doc, 'R', T, 'receive your valued orders in due course. Thank and regards.', LEFT, 599.3);
    at(doc, 'R', H, 'Yours faithfully,', INDENT, 624.3);
    if (signature) {
      try { doc.image(signature, 160.4, 603.9, { fit: [37.1, 59.3], align: 'center', valign: 'center' }); } catch (err) { /* a bad picture never stops the quotation */ }
    }
    at(doc, 'B', H, b.signer || 'ALIA SURAYA BINTI ESA', INDENT, 675.1);
    const title = b.signer ? (b.title || '') : '(Pharmacist)';
    if (title) at(doc, 'R', 10.2, title, INDENT, 688.1);
  });
  doc.end();
  await done;
  return Buffer.concat(chunks);
}

// ---------- BR: Bandar Rinching letterhead layout (RFQ TEMPLATE-BR) ----------
// Letterhead across the top; QUOTATION + No. on the right; To on the left, Your Ref. / From / C. C. /
// Date / Page on the right; TEL / FAX; a ruled table; Total; Validity / Delivery Term / Payment Term;
// the note; Yours faithfully, signature, name.
async function brPdf(q, opts) {
  const b = opts.branch || {};
  const doc = makeDoc();
  const chunks = []; doc.on('data', (c) => chunks.push(c));
  const done = new Promise((resolve, reject) => { doc.on('end', resolve); doc.on('error', reject); });
  const L0 = 48; const R0 = 547; const W = R0 - L0;
  const cols = [{ k: 'no', x: L0, w: 34, al: 'center', h: 'Item' }, { k: 'desc', x: L0 + 34, w: 255, al: 'left', h: 'Description' },
    { k: 'qty', x: L0 + 289, w: 50, al: 'center', h: 'Qty' }, { k: 'price', x: L0 + 339, w: 75, al: 'right', h: 'U/ Price (RM)' }, { k: 'total', x: L0 + 414, w: W - 414, al: 'right', h: 'Total (RM)' }];
  const lines = q.lines.map((l) => ({ ...l, rows: null }));
  doc.font('R').fontSize(9);
  const wrap = (t) => { const out = []; let cur = ''; for (const w of String(t || '').split(/\s+/).filter(Boolean)) { const tr = cur ? `${cur} ${w}` : w; if (cur && doc.widthOfString(tr) > cols[1].w - 8) { out.push(cur); cur = w; } else cur = tr; } if (cur) out.push(cur); return out.length ? out : ['']; };
  lines.forEach((l) => { l.rows = wrap(l.description); if (String(l.note || '').trim()) l.rows.push(`(${String(l.note).trim().replace(/^\(|\)$/g, '')})`); });
  const rowH = (l) => 8 + l.rows.length * 11;
  const TOP = 330; const LIMIT_LAST = 560; const LIMIT = 760;
  const pages = [[]]; let y = TOP;
  lines.forEach((l, i) => { if (pages[pages.length - 1].length && y + rowH(l) > LIMIT) { pages.push([]); y = TOP; } pages[pages.length - 1].push(i); y += rowH(l); });
  const last = pages[pages.length - 1]; let end = TOP + last.reduce((t, i) => t + rowH(lines[i]), 0); const moved = [];
  while (last.length > 1 && end > LIMIT_LAST) { const i = last.pop(); moved.unshift(i); end -= rowH(lines[i]); }
  if (moved.length) pages.push(moved);
  const total = q.total !== undefined && q.total !== null ? Number(q.total) : lines.reduce((t, l) => t + Math.round(l.qty * l.unit_price * 100) / 100, 0);
  const cell = (c, t, yy, font = 'R', size = 9) => { doc.font(font).fontSize(size); const w = doc.widthOfString(t, NOLIG);
    const x = c.al === 'center' ? c.x + (c.w - w) / 2 : c.al === 'right' ? c.x + c.w - 6 - w : c.x + 6; doc.text(t, x, yy, { lineBreak: false, ...NOLIG }); };

  pages.forEach((idx, p) => {
    doc.addPage({ size: 'A4', margin: 0 });
    // letterhead
    let top = 40;
    if (opts.letterhead) {
      try { doc.image(opts.letterhead, L0, 28, { fit: [W, 120], align: 'center' }); top = 150; } catch (err) { top = 40; }
    }
    if (top === 40) { at(doc, 'B', 16, `PHARMACY4U ${String(b.name || 'BANDAR RINCHING').toUpperCase()}`, L0, 60); String(b.footer_lines || '').split('\n').filter(Boolean).slice(0, 3).forEach((t, i) => at(doc, 'R', 9, t, L0, 75 + i * 11)); top = 120; }
    // QUOTATION + No.
    at(doc, 'B', 16, 'QUOTATION', R0, top + 18, { align: 'right' });
    at(doc, 'R', 9.5, 'No.', 405, top + 36); at(doc, 'R', 9.5, ':', 445, top + 36); at(doc, 'B', 9.5, q.ref, 455, top + 36);
    // To (left) / Your Ref., From, C. C., Date, Page (right)
    const y0 = top + 62;
    at(doc, 'B', 9.5, 'To', L0, y0);
    String(q.recipient || '').split('\n').filter(Boolean).slice(0, 6).forEach((t, i) => at(doc, 'R', 9.5, t, L0 + 40, y0 + i * 13));
    [['Your Ref.', ''], ['From', q.from_name || b.signer || ''], ['C. C.', q.cc || ''], ['Date', dmy(q.quote_date)], ['Page', `${p + 1} of ${pages.length}`]]
      .forEach(([label, value], i) => { const yy = y0 + i * 13; at(doc, 'R', 9.5, label, 360, yy); at(doc, 'R', 9.5, ':', 420, yy); if (value) at(doc, 'R', 9.5, value, 430, yy); });
    const y1 = y0 + 6 * 13 + 4;
    at(doc, 'R', 9.5, 'TEL', L0, y1); at(doc, 'R', 9.5, ':', L0 + 32, y1); if (q.tel) at(doc, 'R', 9.5, q.tel, L0 + 40, y1);
    at(doc, 'R', 9.5, 'FAX', 200, y1); at(doc, 'R', 9.5, ':', 228, y1); if (q.fax) at(doc, 'R', 9.5, q.fax, 236, y1);
    at(doc, 'R', 9.5, 'Thank you for your inquiry. We are pleased to submit our quote as follows:', L0, y1 + 24);
    // table
    const th = y1 + 34;
    doc.lineWidth(0.8).rect(L0, th, W, 18).stroke('#000000');
    cols.forEach((c) => { cell({ ...c, al: 'center' }, c.h, th + 5, 'B', 9.5); if (c.x > L0) doc.moveTo(c.x, th).lineTo(c.x, th + 18).stroke(); });
    let yy = th + 18;
    for (const i of idx) {
      const l = lines[i]; const h = rowH(l);
      cell(cols[0], `${l.line_no || i + 1}.`, yy + 5);
      l.rows.forEach((t, k) => cell(cols[1], t, yy + 5 + k * 11));
      cell(cols[2], String(l.qty), yy + 5);
      cell(cols[3], L.money(l.unit_price), yy + 5);
      cell(cols[4], L.money(Math.round(l.qty * l.unit_price * 100) / 100), yy + 5);
      yy += h;
    }
    const tableEnd = p < pages.length - 1 ? Math.max(yy, 700) : Math.max(yy + 10, LIMIT_LAST);
    doc.rect(L0, th + 18, W, tableEnd - th - 18).stroke();
    cols.forEach((c) => { if (c.x > L0) doc.moveTo(c.x, th + 18).lineTo(c.x, tableEnd).stroke(); });
    if (p < pages.length - 1) { at(doc, 'R', 8.5, 'Continued on the next page …', R0, tableEnd + 14, { align: 'right' }); return; }
    // Total + terms
    const ty = tableEnd + 16;
    at(doc, 'B', 10, 'Total', cols[3].x + 6, ty); at(doc, 'B', 10, `RM ${L.money(total)}`, R0 - 6, ty, { align: 'right' });
    doc.lineWidth(0.8).moveTo(cols[3].x, ty + 5).lineTo(R0, ty + 5).stroke();
    [['Validity', q.validity], ['Delivery Term', q.delivery_term], ['Payment Term', q.payment_term]].forEach(([label, v], i) => {
      const y2 = ty + i * 15; at(doc, 'R', 9.5, label, L0 + 10, y2); at(doc, 'R', 9.5, ':', L0 + 95, y2); if (v) at(doc, 'R', 9.5, v, L0 + 105, y2); });
    const ny = ty + 58;
    at(doc, 'R', 8.5, 'Note : Prices are subjected to change without prior notice. We hope that our quotation is favourable to you and looking forward to', L0 + 10, ny);
    at(doc, 'R', 8.5, 'receive your valued orders in due course. Thank and regards.', L0 + 10, ny + 11);
    at(doc, 'R', 9.5, 'Yours faithfully,', L0 + 30, ny + 34);
    if (opts.signature) { try { doc.image(opts.signature, L0 + 40, ny + 40, { fit: [90, 50] }); } catch (err) { /* no signature */ } }
    at(doc, 'B', 9.5, b.signer || '', L0 + 40, ny + 104);
    if (b.title) at(doc, 'R', 9.5, b.title, L0 + 40, ny + 117);
  });
  doc.end();
  await done;
  return Buffer.concat(chunks);
}

module.exports = { quotationPdf, brPdf, paginate, rowHeight, ROW_TOP, ROW_GAP, PAGE_LIMIT, LAST_PAGE_LIMIT };
