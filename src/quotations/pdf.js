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

// The footer band: the branch's own footer picture if uploaded; else WM's footer picture, and for the
// other branches WM's address panel (navy #28326e) is covered and the branch's name and typed address
// are printed in the same place and style (CEO 11 Nov: same letterhead as WM for every branch).
function footer(doc, opts) {
  const b = opts.branch || {};
  if (opts.footer) { try { doc.image(opts.footer, 56.1, 693.1, { width: 477.7, height: 63.6 }); return; } catch (err) { /* use WM's */ } }
  doc.image(files().footer, 56.1, 693.1, { width: 477.7, height: 63.6 });
  if (!b.code || b.code === 'WM') return;
  doc.rect(352.4, 701.6, 178.5, 43).fill('#28326e');
  doc.fillColor('#ffffff');
  const lines = [`Pharmacy4u ${b.name || ''}`.trim(), ...String(b.footer_lines || '').split('\n').filter(Boolean)].slice(0, 4);
  lines.forEach((t, i) => { doc.font('B').fontSize(8.6); let size = 8.6; while (size > 6 && doc.widthOfString(t, NOLIG) > 172) { size -= 0.2; doc.fontSize(size); } at(doc, 'B', size, t, 355.3, 708.8 + i * 11.2); });
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

module.exports = { quotationPdf, paginate, rowHeight, ROW_TOP, ROW_GAP, PAGE_LIMIT, LAST_PAGE_LIMIT };
