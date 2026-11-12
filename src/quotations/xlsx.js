// A quotation as an Excel file (12 Nov 2026, CEO: "zakat can be saved in Excel") – laid out like the
// QT-2026-00xx.xlsx files the branches keep in Drive: banner + QUOTATION title, To / Your Ref / Date,
// the item table, TOTAL, the note, Yours faithfully, signature, name, and the branch's footer.
// Same rules as the PDF: no stock option / pre-order line on the customer's copy.

const path = require('path');
const fs = require('fs');
const ExcelJS = require('exceljs');
const L = require('./logic');

const ASSETS = path.join(__dirname, 'assets');
const asset = (f) => fs.readFileSync(path.join(ASSETS, f));
const dmy = (iso) => { const [y, m, d] = String(iso || '').split('-'); return d ? `${d}/${m}/${y}` : ''; };
const kind = (buf) => (buf && buf[0] === 0xff && buf[1] === 0xd8 ? 'jpeg' : 'png');

async function quotationXlsx(q, { branch = {}, signature = null, footer = null, header = null } = {}) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Pharmacy4U 4DX';
  const ws = wb.addWorksheet(q.ref || 'Quotation', {
    pageSetup: { paperSize: 9, orientation: 'portrait', fitToPage: true, fitToWidth: 1, fitToHeight: 0, margins: { left: 0.4, right: 0.4, top: 0.4, bottom: 0.4, header: 0.2, footer: 0.2 } },
    views: [{ showGridLines: false }],
  });
  ws.columns = [{ width: 2 }, { width: 6 }, { width: 50 }, { width: 8 }, { width: 14 }, { width: 16 }];
  const font = { name: 'Calibri', size: 11 };
  const bold = { ...font, bold: true };
  const set = (addr, value, f = font, align) => { const c = ws.getCell(addr); c.value = value; c.font = f; if (align) c.alignment = align; return c; };

  // Letterhead banner (12 Nov: the Pharmacy4U letterhead, same for every branch) + QUOTATION title
  const top = header || asset('letterhead_header.png');
  ws.addImage(wb.addImage({ buffer: top, extension: kind(top) }), { tl: { col: 0, row: 0 }, ext: { width: 660, height: 192 } });
  const title = wb.addImage({ buffer: asset('title_quotation.png'), extension: 'png' });
  ws.addImage(title, { tl: { col: 2.45, row: 9.6 }, ext: { width: 150, height: 38 } });
  for (let r = 1; r <= 11; r++) ws.getRow(r).height = 17;

  // To / Your Ref, C. C., Date, Page
  let r = 13;
  const rec = String(q.recipient || '').split('\n').filter(Boolean);
  set(`B${r}`, 'To:', bold);
  rec.forEach((t, i) => set(`C${r + i}`, t));
  [['Your Ref :', q.ref], ['C. C. :', q.cc || ''], ['Date :', dmy(q.quote_date)], ['Page :', '1 of 1']].forEach(([label, v], i) => {
    set(`E${r + i}`, label, bold, { horizontal: 'right' });
    set(`F${r + i}`, v);
  });
  r += Math.max(rec.length, 4);
  set(`B${r}`, `TEL :${q.tel ? ` ${q.tel}` : ''}`);
  r += 2;
  set(`B${r}`, 'Thank you for your inquiry. We are pleased to submit our quote as follows:');
  r += 2;

  // Table
  const head = ['Item', 'Description', 'Qty', 'U/ Price (RM)', 'Total (RM)'];
  head.forEach((h, i) => {
    const c = set(`${'BCDEF'[i]}${r}`, h, bold, { horizontal: 'center', vertical: 'middle' });
    c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD9D9D9' } };
  });
  ws.getRow(r).height = 20;
  r++;
  let total = 0;
  for (const [i, l] of q.lines.entries()) {
    const lineTotal = Math.round(l.qty * l.unit_price * 100) / 100;
    total += lineTotal;
    set(`B${r}`, l.line_no || i + 1, font, { horizontal: 'center', vertical: 'top' });
    set(`C${r}`, String(l.description || ''), font, { wrapText: true, vertical: 'top' });
    set(`D${r}`, l.qty, font, { horizontal: 'center', vertical: 'top' });
    const p = set(`E${r}`, Number(l.unit_price), font, { horizontal: 'center', vertical: 'top' }); p.numFmt = '#,##0.00';
    const t = set(`F${r}`, lineTotal, font, { horizontal: 'center', vertical: 'top' }); t.numFmt = '"RM"#,##0.00';
    r++;
  }
  total = q.total !== undefined && q.total !== null ? Number(q.total) : Math.round(total * 100) / 100;
  r += 1;
  set(`E${r}`, 'TOTAL', bold, { horizontal: 'right' });
  const tc = set(`F${r}`, total, bold, { horizontal: 'center' });
  tc.numFmt = '"RM"#,##0.00';
  tc.border = { top: { style: 'thick' }, bottom: { style: 'double' } };
  r += 2;
  ws.mergeCells(`B${r}:F${r + 1}`);
  set(`B${r}`, 'Note : Prices are subjected to change without prior notice. We hope that our quotation is favourable to you and looking forward to receive your valued orders in due course. Thank and regards.',
    { ...font, size: 10 }, { wrapText: true, vertical: 'top' });
  r += 3;
  set(`C${r}`, 'Yours faithfully,');
  if (signature) {
    try { ws.addImage(wb.addImage({ buffer: signature, extension: kind(signature) }), { tl: { col: 2.35, row: r }, ext: { width: 52, height: 80 } }); } catch (err) { /* no signature */ }
  }
  r += 5;
  set(`C${r}`, branch.signer || '', bold);
  if (branch.title) set(`C${r + 1}`, branch.title);
  r += 3;

  // Footer: the branch's own footer picture if uploaded, else a navy band with the branch name + address
  const pic = footer;
  if (pic) {
    ws.addImage(wb.addImage({ buffer: pic, extension: kind(pic) }), { tl: { col: 1, row: r - 1 }, ext: { width: 640, height: 85 } });
  } else {
    const lines = [`Pharmacy4u ${branch.name || ''}`.trim(), ...String(branch.footer_lines || '').split('\n').filter(Boolean)];
    lines.forEach((t, i) => {
      ws.mergeCells(`B${r + i}:F${r + i}`);
      const c = set(`B${r + i}`, t, { ...bold, color: { argb: 'FFFFFFFF' } }, { horizontal: 'right' });
      c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF28326E' } };
    });
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}

module.exports = { quotationXlsx };
