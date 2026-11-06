// 6 Nov (CEO): invoice scan. Staff photograph a supplier invoice (one or many pages, shrunk on the
// phone – public/js/invoice.js), fill in from / supplier / invoice no. / date / amount / PO ref, and the
// app makes one PDF "YYYY-MM-DD Supplier InvoiceNo (Branch).pdf" for the Finance inbox on Google Drive
// (./drive.js). Statuses: Received → Entered in Dynamod (Finance ticks it; who and when are saved).
// Who: everyone logged in scans; branch people see their own branch's (and their own) invoices, HQ and
// admin see all. Finance = the payments team (app_settings payments_team, Azwani) and admin.

const calc = require('../calc');
const { cleanText } = require('../weekly/access');
const { jpegsToPdf } = require('./pdf');

const MAX_PAGES = 10;
const MAX_PAGE = 1900000; // bytes after decoding
const STATUSES = ['Received', 'Entered in Dynamod'];

const isBranchUser = (u) => ['branch_staff', 'branch_manager'].includes(u.role);
const seesAll = (u) => ['admin', 'hq', 'hq_staff'].includes(u.role);
const isFinance = (u) => u.role === 'admin' || Boolean(u.payments);
const supplierKey = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
const invoiceKey = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const realDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s || '') && new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s;

// "2026-11-06 Zuellig INV-123 (WM).pdf" – characters Drive / phones dislike are taken out.
function fileName({ date, supplier, invoiceNo, from }) {
  const safe = (s) => String(s).replace(/[\\/:*?"<>|#%\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim();
  return `${date} ${safe(supplier)} ${safe(invoiceNo)} (${safe(from)}).pdf`;
}

// Page photos from the form: data URLs of JPEGs (the phone always sends JPEG).
function parsePages(value) {
  const list = (Array.isArray(value) ? value : value ? [value] : []).map((s) => String(s || '').trim()).filter(Boolean);
  if (!list.length) return { error: 'Add a photo of the invoice (one for each page).' };
  if (list.length > MAX_PAGES) return { error: `${MAX_PAGES} pages at most.` };
  const pages = [];
  for (const s of list) {
    const m = /^data:image\/jpeg;base64,([A-Za-z0-9+/=\s]+)$/.exec(s);
    if (!m) return { error: 'A page photo couldn’t be read – take it again.' };
    const data = Buffer.from(m[1], 'base64');
    if (!data.length || data.length > MAX_PAGE) return { error: 'A page photo is too big – take it again.' };
    if (!(data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff)) return { error: 'A page isn’t a photo.' };
    pages.push(data);
  }
  return { pages };
}

async function branches(db) {
  return (await db.query('SELECT id, code, name FROM branches WHERE active ORDER BY id')).rows;
}

// Supplier list for the picker: the Ordering & payments suppliers plus names already used on invoices.
async function suppliers(db) {
  const rows = (await db.query(`SELECT DISTINCT supplier FROM (
      SELECT supplier FROM inv_suppliers UNION SELECT supplier FROM invoices) s WHERE supplier IS NOT NULL ORDER BY supplier`)).rows;
  const seen = new Set(); const out = [];
  for (const r of rows) { const k = supplierKey(r.supplier); if (k && !seen.has(k)) { seen.add(k); out.push(r.supplier); } }
  return out;
}

async function findDuplicates(db, supplier, invoiceNo) {
  const sk = supplierKey(supplier); const ik = invoiceKey(invoiceNo);
  if (!sk || !ik) return [];
  return (await db.query(`SELECT i.id, i.file_name, i.created_at, COALESCE(b.code, 'HQ') AS from_code, u.display_name AS by_name
    FROM invoices i LEFT JOIN branches b ON b.id = i.branch_id LEFT JOIN users u ON u.id = i.created_by
    WHERE i.supplier_key = $1 AND i.invoice_key = $2 ORDER BY i.id`, [sk, ik])).rows;
}

// Saves a scanned invoice. Returns { id, fileName } / { error } / { duplicate: [...] } (needs confirm_dup).
async function saveInvoice(db, user, body, { now = () => new Date() } = {}) {
  const today = calc.todayInMalaysia(now());
  const all = await branches(db);
  const from = String(body.from || '').trim();
  const branch = from === 'HQ' ? null : all.find((b) => b.code === from);
  if (from !== 'HQ' && !branch) return { error: 'Pick where the invoice is from (HQ or the outlet).' };
  const supplier = cleanText(body.supplier, { max: 120, label: 'Supplier' });
  if (supplier.error) return supplier;
  if (!supplier.value) return { error: 'Pick or type the supplier.' };
  const no = cleanText(body.invoice_no, { max: 60, label: 'Invoice no.' });
  if (no.error) return no;
  if (!no.value || !invoiceKey(no.value)) return { error: 'Type the invoice no.' };
  const date = String(body.invoice_date || '').trim();
  if (!realDate(date)) return { error: 'Type the invoice date.' };
  if (date > today) return { error: 'The invoice date can’t be after today.' };
  const amount = Number(String(body.amount || '').replace(/[,\sRMrm]/g, ''));
  if (!Number.isFinite(amount) || amount <= 0 || amount >= 10000000) return { error: 'Type the invoice amount in RM.' };
  const po = cleanText(body.po_ref, { max: 60, label: 'PO ref' });
  if (po.error) return po;
  const pg = parsePages(body.page);
  if (pg.error) return pg;

  const dups = await findDuplicates(db, supplier.value, no.value);
  if (dups.length && !body.confirm_dup) return { duplicate: dups };

  let pdf;
  try { pdf = jpegsToPdf(pg.pages); } catch (err) { return { error: `The photos couldn’t be made into a PDF (${err.message}) – take them again.` }; }
  const name = fileName({ date, supplier: supplier.value, invoiceNo: no.value, from: branch ? branch.code : 'HQ' });
  const at = now().toISOString();
  const id = await db.transaction(async (tx) => {
    const r = await tx.query(`INSERT INTO invoices (branch_id, supplier, supplier_key, invoice_no, invoice_key, invoice_date, amount, po_ref, pages, file_name, pdf, created_by, created_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) RETURNING id`,
      [branch ? branch.id : null, supplier.value, supplierKey(supplier.value), no.value, invoiceKey(no.value), date, Math.round(amount * 100) / 100,
        po.value, pg.pages.length, name, pdf, user.id, at]);
    await tx.query("INSERT INTO audit_log (user_id, action, table_name, record_key, new_value) VALUES ($1, 'insert', 'invoices', $2, $3)",
      [user.id, String(r.rows[0].id), JSON.stringify({ file: name, amount, pages: pg.pages.length, duplicate: dups.length > 0 })]);
    return r.rows[0].id;
  });
  return { id, fileName: name, repeat: dups.length > 0 };
}

const canSee = (user, inv) => seesAll(user) || inv.created_by === user.id || (isBranchUser(user) && inv.branch_id === user.branch_id);

// Finance ticks "Entered in Dynamod" (undo puts it back to Received).
async function setEntered(db, user, id, { undo = false, now = () => new Date() } = {}) {
  if (!isFinance(user)) return { error: 'Only Finance ticks invoices entered in Dynamod.' };
  const inv = (await db.query('SELECT id, status, file_name FROM invoices WHERE id = $1', [id])).rows[0];
  if (!inv) return { error: 'That invoice isn’t in the list.' };
  const to = undo ? 'Received' : 'Entered in Dynamod';
  if (inv.status === to) return { ok: undo ? 'Already Received.' : 'Already entered in Dynamod.' };
  await db.query('UPDATE invoices SET status = $2, entered_at = $3, entered_by = $4 WHERE id = $1',
    [id, to, undo ? null : now().toISOString(), undo ? null : user.id]);
  await db.query("INSERT INTO audit_log (user_id, action, table_name, record_key, old_value, new_value) VALUES ($1, 'update', 'invoices', $2, $3, $4)",
    [user.id, String(id), JSON.stringify({ status: inv.status }), JSON.stringify({ status: to })]);
  return { ok: undo ? `${inv.file_name}: back to Received.` : `${inv.file_name}: entered in Dynamod.` };
}

// The list with filters { supplier, from, month, status }.
async function list(db, user, f = {}) {
  const where = []; const args = [];
  const arg = (v) => { args.push(v); return `$${args.length}`; };
  if (!seesAll(user)) where.push(`(i.created_by = ${arg(user.id)} OR i.branch_id = ${arg(user.branch_id || -1)})`);
  if (f.supplier) where.push(`i.supplier_key = ${arg(supplierKey(f.supplier))}`);
  if (f.from === 'HQ') where.push('i.branch_id IS NULL');
  else if (f.from) where.push(`b.code = ${arg(f.from)}`);
  if (/^\d{4}-\d{2}$/.test(f.month || '')) where.push(`to_char(i.invoice_date, 'YYYY-MM') = ${arg(f.month)}`);
  if (STATUSES.includes(f.status)) where.push(`i.status = ${arg(f.status)}`);
  const rows = (await db.query(`SELECT i.id, i.branch_id, i.supplier, i.invoice_no, to_char(i.invoice_date, 'YYYY-MM-DD') AS invoice_date, i.amount, i.po_ref,
      i.pages, i.file_name, i.drive_link, i.drive_file_id, i.drive_saved_at, i.drive_error, (i.pdf IS NOT NULL) AS has_pdf, i.status, i.entered_at,
      i.created_at, i.created_by, COALESCE(b.code, 'HQ') AS from_code, cu.display_name AS by_name, eu.display_name AS entered_by_name,
      (SELECT count(*) FROM invoices d WHERE d.supplier_key = i.supplier_key AND d.invoice_key = i.invoice_key) AS same_count
    FROM invoices i LEFT JOIN branches b ON b.id = i.branch_id LEFT JOIN users cu ON cu.id = i.created_by LEFT JOIN users eu ON eu.id = i.entered_by
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY i.created_at DESC, i.id DESC LIMIT 500`, args)).rows;
  return rows.map((r) => ({ ...r, amount: Number(r.amount), same_count: Number(r.same_count) }));
}

async function months(db) {
  return (await db.query("SELECT DISTINCT to_char(invoice_date, 'YYYY-MM') AS m FROM invoices ORDER BY m DESC")).rows.map((r) => r.m);
}

async function loadOne(db, id) {
  return (await db.query('SELECT id, branch_id, created_by, file_name, pdf, drive_file_id FROM invoices WHERE id = $1', [id])).rows[0] || null;
}

async function countNotEntered(db) {
  return Number((await db.query("SELECT count(*) AS n FROM invoices WHERE status = 'Received'")).rows[0].n) || 0;
}

module.exports = { STATUSES, MAX_PAGES, isFinance, seesAll, canSee, fileName, parsePages, branches, suppliers, findDuplicates,
  saveInvoice, setEntered, list, months, loadOne, countNotEntered, supplierKey, invoiceKey };
