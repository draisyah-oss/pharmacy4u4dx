// Zakat quotation (WM) – database side (11 Nov 2026, CEO handoff Phase 1). See ./logic.js for the rules.
//
// Who (agreed with the CEO 11 Nov):
//   make quotes      WM's branch manager (Hafizah), every HQ login (hq, hq_staff) and admin
//   see cost / %     admin and the inventory team (Alia, Syarafana, Fariz) – everyone else gets the badge only
//   settings         admin and full-HQ members of the inventory team (Alia): markup, floor, recipient,
//                    signature, ref numbers
// Past quotes: everyone who makes quotes sees the list and re-downloads the PDF (never shows cost).

const calc = require('../calc');
const L = require('./logic');
const { mentionsSalary, SALARY_MESSAGE } = require('../privacy');

const SERIES = 'QT-WM';
const MAX_LINES = 60;
// 11 Nov (CEO): every branch quotes, each with its own series and signer, all on the WM layout
// ("use same letterhead with WM"): same banner and title; the footer band carries the branch's own
// name and address. Names, titles and footer address can be changed on Quotation settings.
const BRANCHES = {
  WM: { series: 'QT-WM', layout: 'p4u', name: 'Wangsa Maju', signer: 'ALIA SURAYA BINTI ESA', title: '(Pharmacist)', footer_lines: '' },
  JH: { series: 'QT-JH', layout: 'p4u', name: 'Jenderam Hilir', signer: 'NURUL AFIFAH BINTI ADDNAN', title: '(Pharmacist)', footer_lines: '' },
  BR: { series: 'QT-BR', layout: 'p4u', name: 'Bandar Rinching', signer: 'NUR AMIRAH ABD KARIM', title: '(Pharmacist)', footer_lines: '' },
  Bangi: { series: 'QT-BGI', layout: 'p4u', name: 'Bangi', signer: '', title: '(Pharmacist)', footer_lines: '' },
  Ampang: { series: 'QT-AMP', layout: 'p4u', name: 'Ampang', signer: '', title: '(Pharmacist)', footer_lines: '' },
};
const CODES = Object.keys(BRANCHES);
const SERIES_LIST = CODES.map((c) => BRANCHES[c].series);
const IMAGE_KINDS = ['signature', 'footer'];
const HQ_ROLES = ['admin', 'hq', 'hq_staff'];
const DEFAULTS = {
  markup_default: 0.2,
  markup_floor: 0.15,
  recipient: 'Medkad Sdn Bhd\nNo. 218, Block 3, No. 7 Persiaran Sukan,\nLaman Seri Business Park, Seksyen 13,\n40100 Shah Alam,\nSelangor',
  tel: '',
  cc: '',
};

// Make quotes: HQ logins and admin for any branch; a branch manager for their own branch.
const outletsFor = (u) => (!u ? [] : HQ_ROLES.includes(u.role) ? CODES : (u.role === 'branch_manager' && BRANCHES[u.branch_code] ? [u.branch_code] : []));
const canMake = (u) => outletsFor(u).length > 0;
const canOpen = (u, q) => Boolean(q) && outletsFor(u).includes(q.outlet);
const canSeeCost = (u) => Boolean(u) && (u.role === 'admin' || Boolean(u.inventory));
const canSettings = (u) => Boolean(u) && (u.role === 'admin' || (u.role === 'hq' && Boolean(u.inventory)));

async function audit(db, user, action, key, oldValue, newValue) {
  await db.query('INSERT INTO audit_log (user_id, action, table_name, record_key, old_value, new_value) VALUES ($1, $2, $3, $4, $5, $6)',
    [user ? user.id : null, action, 'quotations', key, oldValue === undefined ? null : JSON.stringify(oldValue), newValue === undefined ? null : JSON.stringify(newValue)]);
}

// ---------- settings ----------
async function settings(db) {
  const r = (await db.query("SELECT value FROM app_settings WHERE key = 'quote_settings'")).rows[0];
  let v = {}; try { v = r ? JSON.parse(r.value) : {}; } catch { v = {}; }
  const s = { ...DEFAULTS, ...v };
  s.markup_default = Number(s.markup_default); s.markup_floor = Number(s.markup_floor);
  const sig = (await db.query("SELECT value FROM app_settings WHERE key = 'quote_signature'")).rows[0];
  s.signature_id = sig ? Number(sig.value) || null : null;
  return s;
}

const pct = (v) => { const n = Number(String(v || '').replace('%', '').trim()); return Number.isFinite(n) ? n / 100 : NaN; };
async function saveSettings(db, user, body) {
  if (!canSettings(user)) return { error: 'Only admin and Alia change the quotation settings.' };
  const old = await settings(db);
  const markup = pct(body.markup_default); const floor = pct(body.markup_floor);
  if (!(markup >= 0 && markup <= 3)) return { error: 'Markup must be a % between 0 and 300.' };
  if (!(floor >= 0 && floor <= 3)) return { error: 'Floor must be a % between 0 and 300.' };
  const recipient = String(body.recipient || '').replace(/\r/g, '').split('\n').map((x) => x.trim()).filter(Boolean).slice(0, 8).join('\n');
  if (!recipient) return { error: 'Type the default recipient.' };
  const tel = String(body.tel || '').trim().slice(0, 80); const cc = String(body.cc || '').trim().slice(0, 120);
  if (mentionsSalary(recipient, tel, cc)) return { error: SALARY_MESSAGE };
  const next = { markup_default: markup, markup_floor: floor, recipient, tel, cc };
  await db.query(`INSERT INTO app_settings (key, value) VALUES ('quote_settings', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`, [JSON.stringify(next)]);
  const { signature_id: _s, ...was } = old;
  await audit(db, user, 'update', 'settings', was, next);
  return { ok: 'Quotation settings saved.' };
}

// ---------- per branch: signer, footer address, BR terms (app_settings quote_branches) ----------
async function branchConfigs(db) {
  const r = (await db.query("SELECT value FROM app_settings WHERE key = 'quote_branches'")).rows[0];
  let v = {}; try { v = r ? JSON.parse(r.value) : {}; } catch { v = {}; }
  const keys = (await db.query("SELECT key FROM app_settings WHERE key LIKE 'quote_img_%' OR key = 'quote_signature'")).rows.map((x) => x.key);
  const out = {};
  for (const c of CODES) {
    out[c] = { code: c, ...BRANCHES[c], ...(v[c] || {}), series: BRANCHES[c].series, layout: BRANCHES[c].layout };
    out[c].images = Object.fromEntries(IMAGE_KINDS.map((k) => [k, keys.includes(imageKey(c, k)) || (c === 'WM' && k === 'signature' && keys.includes('quote_signature'))]));
  }
  return out;
}
const branchConfig = async (db, code) => (await branchConfigs(db))[code] || null;

async function saveBranch(db, user, code, body) {
  if (!canSettings(user)) return { error: 'Only admin and Alia change the quotation settings.' };
  if (!BRANCHES[code]) return { error: 'Unknown branch.' };
  const r = (await db.query("SELECT value FROM app_settings WHERE key = 'quote_branches'")).rows[0];
  let all = {}; try { all = r ? JSON.parse(r.value) : {}; } catch { all = {}; }
  const t = (v, n) => String(v || '').trim().slice(0, n);
  const next = { signer: t(body.signer, 80).toUpperCase(), title: t(body.title, 60),
    footer_lines: String(body.footer_lines || '').replace(/\r/g, '').split('\n').map((x) => x.trim()).filter(Boolean).slice(0, 4).join('\n') };
  if (mentionsSalary(...Object.values(next))) return { error: SALARY_MESSAGE };
  const old = all[code] || null;
  all[code] = next;
  await db.query(`INSERT INTO app_settings (key, value) VALUES ('quote_branches', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`, [JSON.stringify(all)]);
  await audit(db, user, 'update', `branch ${code}`, old, next);
  return { ok: `${BRANCHES[code].name} saved.` };
}

// Pictures per branch: signature and (optional) footer picture. Uploaded on the settings
// page into photos – the signatures never sit in the public repo. JPEG / PNG data URL.
const imageKey = (code, kind) => `quote_img_${code}_${kind}`;
async function saveImage(db, user, code, kind, dataUrl) {
  if (!canSettings(user)) return { error: 'Only admin and Alia change the quotation pictures.' };
  if (!BRANCHES[code] || !IMAGE_KINDS.includes(kind)) return { error: 'Unknown picture.' };
  const m = /^data:(image\/(?:jpeg|png));base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl || ''));
  if (!m) return { error: 'Choose the picture (.jpg or .png) first.' };
  const buf = Buffer.from(m[2], 'base64');
  const isJpeg = buf[0] === 0xff && buf[1] === 0xd8; const isPng = buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  if (!(isJpeg || isPng)) return { error: 'That file isn’t a JPEG or PNG picture.' };
  if (buf.length > 1900000) return { error: 'The picture is too big (max about 1.9 MB).' };
  const id = (await db.query('INSERT INTO photos (mime, data, created_by) VALUES ($1, $2, $3) RETURNING id', [isJpeg ? 'image/jpeg' : 'image/png', buf, user.id])).rows[0].id;
  await db.query(`INSERT INTO app_settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`, [imageKey(code, kind), String(id)]);
  await audit(db, user, 'update', `${code} ${kind}`, null, { photo_id: id, bytes: buf.length });
  return { ok: `${BRANCHES[code].name}: ${kind} saved – it goes on every new quotation PDF.` };
}
async function image(db, code, kind) {
  const keys = [imageKey(code, kind)];
  if (code === 'WM' && kind === 'signature') keys.push('quote_signature'); // Phase 1 upload
  for (const k of keys) {
    const r = (await db.query('SELECT p.data FROM app_settings s JOIN photos p ON p.id = s.value::int WHERE s.key = $1', [k])).rows[0];
    if (r) return Buffer.from(r.data);
  }
  return null;
}
// Phase 1 names, kept for WM.
const saveSignature = (db, user, dataUrl) => saveImage(db, user, 'WM', 'signature', dataUrl);
const signature = (db) => image(db, 'WM', 'signature');

// ---------- ref numbers ----------
async function seriesRows(db) {
  return (await db.query(`SELECT s.series, s.year, s.next_no, (SELECT max(ref_no) FROM quotations q WHERE q.series = s.series AND q.ref_year = s.year) AS last_no
    FROM quotation_series s ORDER BY s.series, s.year DESC`)).rows;
}
// Set the next number for a series + year (also the start number of a new year – Dr Aisyah decides it).
async function setNextNo(db, user, { series = SERIES, year, next_no: nextNo }) {
  if (!canSettings(user)) return { error: 'Only admin and Alia change the ref numbers.' };
  if (!SERIES_LIST.includes(series)) return { error: 'Unknown series.' };
  const y = Number(year); const n = Number(nextNo);
  if (!Number.isInteger(y) || y < 2026 || y > 2100) return { error: 'Year must be 2026 or later.' };
  if (!Number.isInteger(n) || n < 1 || n > 9999) return { error: 'The number must be between 1 and 9999.' };
  const last = (await db.query('SELECT max(ref_no) AS n FROM quotations WHERE series = $1 AND ref_year = $2', [series, y])).rows[0].n;
  if (last !== null && n <= Number(last)) return { error: `${L.formatRef(series, y, last)} is already used – the next number must be higher (numbers are never reused).` };
  const old = (await db.query('SELECT next_no FROM quotation_series WHERE series = $1 AND year = $2', [series, y])).rows[0];
  await db.query(`INSERT INTO quotation_series (series, year, next_no) VALUES ($1, $2, $3)
    ON CONFLICT (series, year) DO UPDATE SET next_no = EXCLUDED.next_no, updated_at = now()`, [series, y, n]);
  await audit(db, user, 'update', `${series} ${y}`, old ? { next_no: old.next_no } : null, { next_no: n });
  return { ok: `The next ${series} ${y} quotation will be ${L.formatRef(series, y, n)}.` };
}

// ---------- quotations ----------
// outlets: the branches the viewer may see (data.outletsFor).
async function list(db, { outlets = CODES, limit = 100 } = {}) {
  if (!outlets.length) return [];
  return (await db.query(`SELECT q.id, q.outlet, q.status, q.ref, q.quote_date::text AS quote_date, q.rfq_description, q.total, q.created_at, q.issued_at,
      split_part(q.recipient, E'\\n', 1) AS customer, u.display_name AS by_name,
      (SELECT count(*)::int FROM quotation_lines l WHERE l.quotation_id = q.id) AS lines
    FROM quotations q LEFT JOIN users u ON u.id = q.created_by
    WHERE q.status <> 'cancelled' AND q.outlet = ANY($1::text[])
    ORDER BY (q.status = 'draft') DESC, coalesce(q.issued_at, q.created_at) DESC LIMIT ${Number(limit) || 100}`, [outlets])).rows;
}

async function loadOne(db, id) {
  const q = (await db.query(`SELECT q.*, q.quote_date::text AS quote_date, u.display_name AS by_name, i.display_name AS issued_name
    FROM quotations q LEFT JOIN users u ON u.id = q.created_by LEFT JOIN users i ON i.id = q.issued_by WHERE q.id = $1`, [id])).rows[0];
  if (!q) return null;
  q.lines = (await db.query(`SELECT l.*, p.active AS product_active, p.balance AS product_balance, p.cost AS product_cost
    FROM quotation_lines l LEFT JOIN products p ON p.id = l.product_id WHERE l.quotation_id = $1 ORDER BY l.line_no`, [id])).rows;
  for (const l of q.lines) {
    for (const k of ['qty', 'unit_price', 'auto_price', 'cost_at_quote', 'balance_at_quote', 'product_balance', 'product_cost']) l[k] = l[k] === null ? null : Number(l[k]);
  }
  q.markup = Number(q.markup); q.total = q.total === null ? null : Number(q.total);
  return q;
}

const lineTotal = (l) => (l.qty && l.unit_price !== null ? Math.round(l.qty * l.unit_price * 100) / 100 : 0);
const totalOf = (lines) => Math.round(lines.reduce((s, l) => s + lineTotal(l), 0) * 100) / 100;

function textOk(...t) { return !mentionsSalary(...t); }

// New draft from step 1: RFQ description + pasted items.
async function createDraft(db, user, body, { now }) {
  if (!canMake(user)) return { error: 'Zakat quotations are made by the branch managers and HQ.' };
  const outlets = outletsFor(user);
  const outlet = outlets.length === 1 ? outlets[0] : String(body.outlet || '');
  if (!outlets.includes(outlet)) return { error: 'Choose the branch the quotation is from.' };
  const b = await branchConfig(db, outlet);
  const s = await settings(db);
  const rfq = String(body.rfq_description || '').trim().slice(0, 2000);
  const rows = L.splitPaste(body.items);
  if (!rfq && !rows.length) return { error: 'Paste the RFQ items (one per line, qty at the end) or type the RFQ description.' };
  if (!textOk(rfq, ...rows.map((r) => r.text))) return { error: SALARY_MESSAGE };
  const id = await db.transaction(async (tx) => {
    const qid = (await tx.query(`INSERT INTO quotations (series, outlet, recipient, tel, cc, rfq_description, markup, created_by, created_at, updated_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9) RETURNING id`, [b.series, outlet, s.recipient, s.tel, s.cc, rfq, s.markup_default, user.id, now()])).rows[0].id;
    let n = 0;
    for (const r of rows.slice(0, MAX_LINES)) {
      n++;
      await tx.query('INSERT INTO quotation_lines (quotation_id, line_no, portal_text, search_text, qty) VALUES ($1, $2, $3, $3, $4)', [qid, n, r.text.slice(0, 300), r.qty || null]);
    }
    return qid;
  });
  await audit(db, user, 'insert', `quotation ${id}`, null, { rfq, lines: rows.length });
  return { id };
}

// Top matches for a line's search words: candidates by any word in SQL, ranked in JS (./logic.js).
async function candidates(db, text, { limit = 5 } = {}) {
  const words = L.searchWords(text);
  if (!words.length) return [];
  const hits = words.map((_, i) => `(CASE WHEN search LIKE $${i + 1} THEN 1 ELSE 0 END)`).join(' + ');
  const { rows } = await db.query(`SELECT id, stock_id, barcode, description, uom, balance, cost FROM products
    WHERE active AND (${words.map((_, i) => `search LIKE $${i + 1}`).join(' OR ')})
    ORDER BY ${hits} DESC, length(description) LIMIT 400`, words.map((w) => `%${w.replace(/[%_\\]/g, '')}%`));
  return L.rank(text, rows.map((r) => ({ ...r, balance: r.balance === null ? null : Number(r.balance), cost: r.cost === null ? null : Number(r.cost) })), limit);
}

const money = (v) => { const s = String(v === undefined || v === null ? '' : v).replace(/[^0-9.]/g, ''); if (!s) return null; const n = Number(s); return Number.isFinite(n) ? Math.round(n * 100) / 100 : NaN; };

// Save steps 1–3 (the whole page form). body.l = { i<lineId>: { portal, search, qty, pick, desc, price, stock, note, remove } }, body.add = more pasted lines.
async function saveDraft(db, user, id, body, { now }) {
  const q = await loadOne(db, id);
  if (!canOpen(user, q)) return { error: 'That quotation isn’t in the list.' };
  if (q.status !== 'draft') return { error: `${q.ref} is already issued – make a copy to change it.` };
  const s = await settings(db);
  const recipient = String(body.recipient === undefined ? q.recipient : body.recipient).replace(/\r/g, '').split('\n').map((x) => x.trim()).filter(Boolean).slice(0, 8).join('\n');
  const tel = String(body.tel === undefined ? q.tel : body.tel).trim().slice(0, 80);
  const cc = String(body.cc === undefined ? q.cc : body.cc).trim().slice(0, 120);
  const rfq = String(body.rfq_description === undefined ? q.rfq_description : body.rfq_description).trim().slice(0, 2000);
  if (!recipient) return { error: 'Type who the quotation is to.' };
  const form = body.l && typeof body.l === 'object' ? body.l : {};
  const problems = [];
  const updates = []; const removes = [];
  const allText = [recipient, tel, cc, rfq];
  for (const l of q.lines) {
    const f = form[`i${l.id}`];
    if (!f) continue;
    if (f.remove) { removes.push(l.id); continue; }
    const n = { ...l };
    const portal = String(f.portal === undefined ? l.portal_text : f.portal).trim().slice(0, 300);
    if (portal) n.portal_text = portal;
    n.search_text = String(f.search === undefined ? l.search_text : f.search).trim().slice(0, 300) || n.portal_text;
    const qty = String(f.qty === undefined ? (l.qty || '') : f.qty).trim();
    n.qty = qty === '' ? null : Number(qty);
    if (n.qty !== null && !(Number.isInteger(n.qty) && n.qty > 0 && n.qty <= 1000000)) { problems.push(`Line ${l.line_no}: qty must be a whole number.`); n.qty = l.qty; }
    // Item picked: a product id, 'need' (Need cost – ask Alia) or nothing.
    const pick = String(f.pick === undefined ? (l.need_cost ? 'need' : (l.product_id || '')) : f.pick);
    let productChanged = false;
    if (pick === 'need') {
      if (!l.need_cost || l.product_id) productChanged = true;
      Object.assign(n, { need_cost: true, product_id: null, stock_id: null, barcode: null, uom: null, cost_at_quote: null, balance_at_quote: null, auto_price: null });
    } else if (/^\d+$/.test(pick) && Number(pick) !== l.product_id) {
      const p = (await db.query('SELECT id, stock_id, barcode, description, uom, balance, cost FROM products WHERE id = $1 AND active', [Number(pick)])).rows[0];
      if (!p) problems.push(`Line ${l.line_no}: that item isn’t in the item master any more – pick another.`);
      else {
        productChanged = true;
        Object.assign(n, { need_cost: false, product_id: p.id, stock_id: p.stock_id, barcode: p.barcode, uom: p.uom, description: p.description.toUpperCase(),
          cost_at_quote: p.cost === null ? null : Number(p.cost), balance_at_quote: p.balance === null ? null : Number(p.balance) });
      }
    } else if (pick === '' && (l.product_id || l.need_cost)) {
      productChanged = true;
      Object.assign(n, { need_cost: false, product_id: null, stock_id: null, barcode: null, uom: null, cost_at_quote: null, balance_at_quote: null, auto_price: null });
    }
    // Description printed on the quote / brand in the zakat form (upper case). Typed text wins unless the item just changed.
    const typedDesc = String(f.desc === undefined ? '' : f.desc).trim().slice(0, 200).toUpperCase();
    if (!productChanged && typedDesc) n.description = typedDesc;
    if (productChanged && n.need_cost) n.description = typedDesc && typedDesc !== (l.description || '') ? typedDesc : n.portal_text.toUpperCase();
    if (productChanged && !n.need_cost && !n.product_id) n.description = '';
    // Price: auto from cost, or typed (override / manual). A new item resets the price to auto.
    n.auto_price = n.cost_at_quote ? L.autoPrice(n.cost_at_quote, s.markup_default) : null;
    const typed = productChanged ? null : money(f.price);
    if (Number.isNaN(typed)) { problems.push(`Line ${l.line_no}: the price must be a number (RM).`); n.unit_price = l.unit_price; }
    else if (typed === null || typed === n.auto_price) {
      // blank (or the auto price itself) = the auto price
      n.unit_price = n.auto_price;
      n.price_source = n.unit_price === null ? null : 'auto';
    } else {
      n.unit_price = typed;
      n.price_source = n.cost_at_quote ? 'override' : 'manual';
    }
    // Stock option: Readystock when the balance covers the qty, else Pre-order – unless staff chose.
    const qtyChanged = n.qty !== l.qty;
    const chosen = f.stock === undefined ? l.stock_option : f.stock;
    // (a line with no option yet posts the select's first choice – that isn't a choice)
    const userChose = Boolean(l.stock_option) && !productChanged && f.stock !== undefined && f.stock !== l.stock_option && ['readystock', 'preorder'].includes(f.stock);
    const typedNote = String(f.note === undefined ? l.note : f.note).trim().slice(0, 120);
    const noteChanged = typedNote !== (l.note || '');
    if (userChose) {
      n.stock_option = chosen;
      n.note = noteChanged ? typedNote : (chosen === 'preorder' ? (typedNote || L.PREORDER_NOTE) : (typedNote === L.PREORDER_NOTE ? '' : typedNote));
    } else if (productChanged || qtyChanged || !l.stock_option) {
      const d = L.stockDefault(n.need_cost ? null : n.balance_at_quote, n.qty);
      n.stock_option = d.stock_option;
      n.note = noteChanged ? typedNote : (l.note && l.note !== L.PREORDER_NOTE ? l.note : d.note);
    } else {
      n.stock_option = ['readystock', 'preorder'].includes(chosen) ? chosen : l.stock_option;
      n.note = typedNote;
    }
    allText.push(n.portal_text, n.search_text, n.description, n.note);
    updates.push(n);
  }
  const more = L.splitPaste(body.add);
  allText.push(...more.map((r) => r.text));
  if (!textOk(...allText)) return { error: SALARY_MESSAGE };
  if (q.lines.length - removes.length + more.length > MAX_LINES) return { error: `A quotation can have up to ${MAX_LINES} lines.` };
  await db.transaction(async (tx) => {
    await tx.query('UPDATE quotations SET recipient = $2, tel = $3, cc = $4, rfq_description = $5, markup = $6, updated_at = $7 WHERE id = $1',
      [id, recipient, tel, cc, rfq, s.markup_default, now()]);
    if (removes.length) await tx.query('DELETE FROM quotation_lines WHERE quotation_id = $1 AND id = ANY($2::int[])', [id, removes]);
    for (const n of updates) {
      await tx.query(`UPDATE quotation_lines SET portal_text = $2, search_text = $3, product_id = $4, stock_id = $5, barcode = $6, description = $7, uom = $8,
        qty = $9, unit_price = $10, auto_price = $11, cost_at_quote = $12, balance_at_quote = $13, price_source = $14, need_cost = $15, stock_option = $16, note = $17 WHERE id = $1`,
      [n.id, n.portal_text, n.search_text, n.product_id, n.stock_id, n.barcode, n.description || '', n.uom, n.qty, n.unit_price, n.auto_price, n.cost_at_quote,
        n.balance_at_quote, n.price_source, n.need_cost, n.stock_option, n.note || '']);
    }
    let no = (await tx.query('SELECT coalesce(max(line_no), 0)::int AS n FROM quotation_lines WHERE quotation_id = $1', [id])).rows[0].n;
    for (const r of more) {
      no++;
      await tx.query('INSERT INTO quotation_lines (quotation_id, line_no, portal_text, search_text, qty) VALUES ($1, $2, $3, $3, $4)', [id, no, r.text.slice(0, 300), r.qty || null]);
    }
    // keep line numbers 1, 2, 3 … after removals (two steps so the unique (quotation, line_no) never clashes)
    if (removes.length) {
      await tx.query('UPDATE quotation_lines SET line_no = line_no + 1000 WHERE quotation_id = $1', [id]);
      await tx.query(`UPDATE quotation_lines l SET line_no = r.rn FROM (SELECT id, row_number() OVER (ORDER BY line_no) AS rn FROM quotation_lines WHERE quotation_id = $1) r
        WHERE l.id = r.id`, [id]);
    }
  });
  await audit(db, user, 'update', `quotation ${id}`, null, { lines: updates.length, removed: removes.length, added: more.length });
  return { ok: problems.length ? `Saved, but: ${problems.join(' ')}` : 'Saved.', problems };
}

// What still stops "Generate quotation".
function missing(q) {
  const out = [];
  if (!q.lines.length) out.push('Add at least one item.');
  for (const l of q.lines) {
    const what = [];
    if (!l.qty) what.push('qty');
    if (!l.description) what.push('an item (pick one, or "Need cost – ask Alia" and type the description)');
    if (!(l.unit_price > 0)) what.push(l.need_cost ? 'a price (ask Alia for the cost)' : 'a price');
    if (!l.stock_option) what.push('stock option');
    if (what.length) out.push(`Line ${l.line_no}: needs ${what.join(', ')}.`);
  }
  return out;
}

// Generate: take the next ref number and make the PDF in one transaction (a failure uses no number).
async function issue(db, user, id, { now, makePdf }) {
  const q = await loadOne(db, id);
  if (!canOpen(user, q)) return { error: 'That quotation isn’t in the list.' };
  if (q.status !== 'draft') return { error: `${q.ref} is already issued.` };
  const gaps = missing(q);
  if (gaps.length) return { error: gaps.join(' ') };
  const today = calc.todayInMalaysia(now());
  const year = Number(today.slice(0, 4));
  const branch = await branchConfig(db, q.outlet);
  if (!branch) return { error: 'This quotation has no branch.' };
  if (!branch.signer) return { error: `Set who signs ${branch.name}’s quotations in Quotation settings (admin or Alia) first.` };
  const pics = { signature: await image(db, q.outlet, 'signature'), footer: await image(db, q.outlet, 'footer') };
  let ref;
  try {
    ref = await db.transaction(async (tx) => {
      const got = (await tx.query('UPDATE quotation_series SET next_no = next_no + 1, updated_at = now() WHERE series = $1 AND year = $2 RETURNING next_no - 1 AS no', [q.series, year])).rows[0];
      if (!got) throw Object.assign(new Error(`There is no ${q.series} number for ${year} yet – an admin sets the first ${year} number in Quotation settings (Dr Aisyah decides it).`), { userFacing: true });
      const no = Number(got.no);
      if (no > 9999) throw Object.assign(new Error(`${q.series} ${year} has run out of numbers.`), { userFacing: true });
      const r = L.formatRef(q.series, year, no);
      const total = totalOf(q.lines);
      const pdf = await makePdf({ ...q, ref: r, quote_date: today, total }, { ...pics, branch });
      const upd = await tx.query(`UPDATE quotations SET status = 'issued', ref = $2, ref_year = $3, ref_no = $4, quote_date = $5, total = $6, pdf = $7,
        issued_by = $8, issued_at = $9, updated_at = $9 WHERE id = $1 AND status = 'draft'`, [id, r, year, no, today, total, pdf, user.id, now()]);
      if (!(upd.rowCount || upd.affectedRows)) throw Object.assign(new Error('Someone issued this quotation a moment ago.'), { userFacing: true });
      await tx.query('INSERT INTO audit_log (user_id, action, table_name, record_key, new_value) VALUES ($1, $2, $3, $4, $5)',
        [user.id, 'issue', 'quotations', r, JSON.stringify({ id, total, lines: q.lines.length })]);
      return r;
    });
  } catch (err) {
    if (err.userFacing) return { error: err.message };
    throw err;
  }
  return { ok: `${ref} made.`, ref };
}

async function pdfOf(db, id) {
  return (await db.query('SELECT ref, pdf FROM quotations WHERE id = $1 AND pdf IS NOT NULL', [id])).rows[0] || null;
}

// A new draft with the same recipient, RFQ and lines (to change an issued quotation – its number stays used).
async function copy(db, user, id, { now }) {
  const q = await loadOne(db, id);
  if (!canOpen(user, q)) return { error: 'That quotation isn’t in the list.' };
  const s = await settings(db);
  const nid = await db.transaction(async (tx) => {
    const qid = (await tx.query(`INSERT INTO quotations (series, outlet, customer_kind, recipient, tel, cc, rfq_description, markup, created_by, created_at, updated_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $10) RETURNING id`, [q.series, q.outlet, q.customer_kind, q.recipient, q.tel, q.cc, q.rfq_description, s.markup_default, user.id, now()])).rows[0].id;
    for (const l of q.lines) {
      await tx.query(`INSERT INTO quotation_lines (quotation_id, line_no, portal_text, search_text, product_id, stock_id, barcode, description, uom, qty, unit_price, auto_price,
        cost_at_quote, balance_at_quote, price_source, need_cost, stock_option, note) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
      [qid, l.line_no, l.portal_text, l.search_text, l.product_id, l.stock_id, l.barcode, l.description, l.uom, l.qty, l.unit_price, l.auto_price,
        l.cost_at_quote, l.balance_at_quote, l.price_source, l.need_cost, l.stock_option, l.note]);
    }
    return qid;
  });
  await audit(db, user, 'insert', `quotation ${nid}`, null, { copied_from: q.ref || `quotation ${id}` });
  return { id: nid };
}

// Who deletes: a draft – the person who started it or admin; an issued quotation (12 Nov, CEO: "have
// option delete so it's easier", e.g. a test quote) – admin and Alia (the people who own the numbers).
const canDeleteIssued = (u) => canSettings(u);
function canDelete(user, q) {
  if (!q) return false;
  return q.status === 'draft' ? (user.role === 'admin' || q.created_by === user.id) : canDeleteIssued(user);
}

// Delete a quotation for good (the audit log keeps what it was). An issued one needs confirm = '1'.
// If it was the latest number of its series and year, the number is given back (the next quotation
// gets it); an older number is not reused.
async function removeQuote(db, user, id, { confirm = false } = {}) {
  const q = await loadOne(db, id);
  if (!canOpen(user, q)) return { error: 'That quotation isn’t in the list.' };
  if (!canDelete(user, q)) {
    return { error: q.status === 'draft' ? 'Only the person who started this draft (or admin) can delete it.' : 'Only admin and Alia delete an issued quotation.' };
  }
  if (q.status === 'draft') {
    await db.query('DELETE FROM quotations WHERE id = $1', [id]);
    await audit(db, user, 'delete', `quotation ${id}`, { rfq: q.rfq_description, lines: q.lines.length }, null);
    return { ok: 'Draft deleted.' };
  }
  if (!confirm) return { error: `Tick “Yes, delete ${q.ref}” first.` };
  let back = false;
  await db.transaction(async (tx) => {
    await tx.query('DELETE FROM quotations WHERE id = $1', [id]);
    const r = await tx.query('UPDATE quotation_series SET next_no = $3, updated_at = now() WHERE series = $1 AND year = $2 AND next_no = $3 + 1', [q.series, q.ref_year, q.ref_no]);
    back = Boolean(r.rowCount || r.affectedRows);
    await tx.query('INSERT INTO audit_log (user_id, action, table_name, record_key, old_value, new_value) VALUES ($1, $2, $3, $4, $5, $6)',
      [user.id, 'delete', 'quotations', q.ref, JSON.stringify({ id, outlet: q.outlet, quote_date: q.quote_date, total: q.total, recipient: q.recipient.split('\n')[0], rfq: q.rfq_description,
        lines: q.lines.map((l) => ({ description: l.description, qty: l.qty, unit_price: l.unit_price })) }), JSON.stringify({ number_given_back: back })]);
  });
  return { ok: `${q.ref} deleted.${back ? ` The next ${q.series} quotation gets ${q.ref} again.` : ` ${q.ref} won’t be used again (newer numbers were already given out).`}` };
}
const removeDraft = (db, user, id) => removeQuote(db, user, id);

async function itemMasterInfo(db) {
  const r = (await db.query(`SELECT count(*) FILTER (WHERE active)::int AS active, count(*) FILTER (WHERE active AND balance IS NOT NULL)::int AS with_balance,
    max(balance_at) AS balance_at FROM products`)).rows[0];
  const last = (await db.query("SELECT value FROM app_settings WHERE key = 'products_last_upload'")).rows[0];
  let up = null; try { up = last ? JSON.parse(last.value) : null; } catch { up = null; }
  return { ...r, last: up };
}

module.exports = {
  SERIES, DEFAULTS, MAX_LINES, BRANCHES, CODES, SERIES_LIST, IMAGE_KINDS, outletsFor, canMake, canOpen, canSeeCost, canSettings, settings, saveSettings,
  branchConfigs, branchConfig, saveBranch, saveImage, image, saveSignature, signature, seriesRows, setNextNo,
  list, loadOne, lineTotal, totalOf, createDraft, candidates, saveDraft, missing, issue, pdfOf, copy, removeDraft, removeQuote, canDelete, canDeleteIssued, itemMasterInfo,
};
