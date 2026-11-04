// 4 Nov 2026 (CEO): "if any box ticks, update the OOS so it can have the answer too".
// When a line on Today's list (Mr Eve's daily plan) is ticked done, the branches' open out-of-stock
// reports for that item that Inventory hasn't answered yet get the answer from the line:
//   • TRANSFER … with a source → transfer from that branch (or HQ delivers when it comes from HQ / Transit;
//     "BR 3 to JH; Ampang 2 to WM" gives each branch its own source; the quantity when the line names one);
//   • ORDER (or TRANSFER + ORDER with no source found) → order;
//   • customers-asking and recount lines, and TRANSFER lines with no source, answer nothing.
// Matching (pure, tested): the report's branch is named in "short at" (or "… to <branch>", or "every
// outlet"), and the item names share their words (brand / strength / size), each "+" or "/" part of the
// plan item tried on its own. Reports already answered are never changed; unticking leaves answers as they are.

const BRANCHES = ['WM', 'JH', 'BR', 'Bangi', 'Ampang'];
const STOP = new Set(['the', 'and', 'with', 'for', 'new', 'tab', 'tabs', 'tablet', 'tablets', 'box', 'pack', 'pck', 'strip', 'strips', 'stp', 'bot', 'bottle',
  'cap', 'caps', 'capsule', 'capsules', 'syrup', 'syr', 'sachet', 'sachets', 'spray', 'cream', 'gel', 'drop', 'drops', 'liquid', 'oral', 'solution', 'suspension',
  'haleon', 'xepa', 'pharmaniaga', 'duopharma', 'homecare', 'hovid', 'ysp', 'dkp', 'gsk', 'msd', 'pfizer', 'abbott', 'servier', 'nature', 'pharmacy']);

const norm = (s) => String(s || '').toLowerCase().replace(/\([a-c]\)/g, ' ').replace(/[^a-z0-9.%]+/g, ' ').trim();
function tokens(s) {
  return new Set(norm(s).split(/\s+/).filter((w) => w && !STOP.has(w) && (w.length >= 3 || /\d/.test(w)))
    .map((w) => w.replace(/^(\d+(?:\.\d+)?)(mg|ml|g|mcg|s|'s)$/, '$1$2')));
}
function similar(a, b) {
  const A = tokens(a); const B = tokens(b);
  if (!A.size || !B.size) return 0;
  let both = 0; let long = false;
  for (const w of A) if (B.has(w)) { both++; if (w.length >= 6 && /[a-z]/.test(w)) long = true; }
  // Both name a size / strength (100ml, 20mg, 10s) → at least one must be the same (spray 100ml ≠ gel 15g).
  const nums = (S) => [...S].filter((w) => /\d/.test(w));
  const nA = nums(A); const nB = nums(B);
  if (nA.length && nB.length && !nA.some((w) => B.has(w))) return 0;
  const ratio = both / Math.min(A.size, B.size);
  if (both >= 2 && ratio >= 0.6) return ratio;
  if (both === 1 && long && Math.min(A.size, B.size) <= 2) return ratio; // e.g. "CRYSTORVAS 20MG" vs "Duopharma Crystorvas 20mg"
  return 0;
}
// The plan item split on "+" / " / " – "Xepa Tussidex Forte 120ml + Mucoprom syrup" → 2 names.
const parts = (item) => String(item || '').split(/\s\+\s|\s\/\s/).map((x) => x.trim()).filter(Boolean);
const itemMatch = (planItem, oosItem) => Math.max(0, ...parts(planItem).map((p) => similar(p, oosItem)), similar(planItem, oosItem));

const codeRe = new RegExp(`\\b(${BRANCHES.join('|')})\\b`, 'gi');
const canon = (c) => BRANCHES.find((b) => b.toLowerCase() === String(c).toLowerCase());
function branchesIn(text) {
  const out = new Set();
  for (const m of String(text || '').matchAll(codeRe)) out.add(canon(m[1]));
  return out;
}

// Where branch `to` gets it from, by the "Transfer from" cell → { from: 'HQ' | code, qty } | null
function sourceFor(transferFrom, to) {
  const t = String(transferFrom || '');
  if (!t.trim() || /^none\b/i.test(t.trim())) return null;
  // "BR 3 to JH; Ampang 2 to WM"
  for (const seg of t.split(/[;,]/)) {
    const m = new RegExp(`\\b(${BRANCHES.join('|')}|HQ)\\b\\s*(\\d+)?[^;]*?\\bto\\s+${to}\\b`, 'i').exec(seg);
    if (m) return { from: m[1].toUpperCase() === 'HQ' ? 'HQ' : canon(m[1]), qty: m[2] ? Number(m[2]) : null };
  }
  if (/\bto\s+(WM|JH|BR|Bangi|Ampang)\b/i.test(t)) return null; // transfers named for other branches only
  if (/^\s*(HQ|Transit)\b|HQ\/Transit|\bHQ \d/i.test(t)) {
    const m = /\b(?:HQ|Transit)(?:\/Transit)?\s+(\d+)/i.exec(t);
    return { from: 'HQ', qty: m ? Number(m[1]) : null };
  }
  for (const m of t.matchAll(codeRe)) {
    const c = canon(m[1]);
    if (c !== to) { const q = new RegExp(`\\b${c}\\s+(\\d+)`, 'i').exec(t); return { from: c, qty: q ? Number(q[1]) : null }; }
  }
  return null;
}

// One plan line + open, unanswered reports → [{ item, body, label }] answers to apply.
function proposals(line, openItems) {
  if (['asking', 'recount'].includes(line.section)) return [];
  const action = String(line.action || '');
  const isTransfer = /TRANSFER/i.test(action);
  const isOrder = /ORDER/i.test(action);
  if (!isTransfer && !isOrder) return [];
  const short = String(line.short_at || '');
  const named = branchesIn(short);
  for (const m of String(line.transfer_from || '').matchAll(new RegExp(`\\bto\\s+(${BRANCHES.join('|')})\\b`, 'gi'))) named.add(canon(m[1]));
  const everyOutlet = /every outlet|all outlets/i.test(short);
  const combined = parts(line.item).length > 1;
  const date = line.plan_date ? new Date(`${line.plan_date}T00:00:00Z`).toLocaleDateString('en-GB', { timeZone: 'UTC', day: 'numeric', month: 'short' }) : '';
  const out = [];
  for (const it of openItems) {
    if (!it.branch_code || !(everyOutlet || named.has(it.branch_code))) continue;
    if (!itemMatch(line.item, it.item)) continue;
    const src = isTransfer ? sourceFor(line.transfer_from, it.branch_code) : null;
    const note = `Mr Eve plan${date ? ' ' + date : ''}: ${action}${line.transfer_from && !/^none/i.test(line.transfer_from) ? ' – ' + line.transfer_from : ''}${line.supplier && isOrder ? ' · supplier ' + line.supplier : ''}`.slice(0, 300);
    let body = null;
    if (src) {
      const qty = combined ? null : src.qty;
      body = src.from === 'HQ' ? { answer: 'hq_deliver', qty: qty || '', reason: note } : { answer: 'transfer', from: src.from, qty: qty || '', reason: note };
    } else if (isOrder) body = { answer: 'order', qty: '', reason: note };
    if (!body) continue;
    out.push({ item: it, body, label: body.answer === 'order' ? 'order' : body.answer === 'hq_deliver' ? 'HQ delivers' : `transfer from ${body.from}` });
  }
  return out;
}

const OPEN_SQL = `SELECT o.id, o.item, o.status, o.answer, b.code AS branch_code FROM oos_items o JOIN branches b ON b.id = o.branch_id
  WHERE o.status = 'Open' AND o.answer IS NULL ORDER BY o.reported_at`;

module.exports = { tokens, similar, itemMatch, branchesIn, sourceFor, proposals, OPEN_SQL };
