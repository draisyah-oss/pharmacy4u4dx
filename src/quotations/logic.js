// Zakat quotation (WM) – pure rules, no database (11 Nov 2026, CEO handoff Phase 1).
//   splitPaste   a pasted RFQ list → [{ text, qty }]
//   tokens/score fuzzy, token-based matching of portal text against the Dynamod item master
//   autoPrice    cost × (1 + markup), rounded UP to the next RM0.10
//   markupOf     (price − cost) ÷ cost – the "margin" badge is checked against the floor on cost
//   stockDefault Readystock when the balance covers the qty, else Pre-order ("Pre-order - 7 days")

const PREORDER_NOTE = 'Pre-order - 7 days';

// ---------- pasting the RFQ ----------
// One item per line. The qty is a tab / several-space column at the end, or at the end of the line:
// "×30", "x 30", "X30", "- 30", "qty 30", "30 units / pcs / pack(s) / box(es) / tins", or a plain last number.
// A leading "1." / "1)" / "1 -" numbering is dropped. Header lines ("Item … Qty") are skipped.
const QTY_WORD = '(?:units?|pcs?|pieces?|packs?|pkts?|box(?:es)?|tins?|bottles?|btls?|nos?|ea)';
function splitLine(raw) {
  let line = String(raw || '').replace(/\u00a0/g, ' ').trim();
  line = line.replace(/^\d{1,3}(?:[.\]]\s+|\)\s*)(?=\S)/, ''); // "1. " / "2) " numbering
  if (!line) return null;
  if (/^(no\.?\s+)?item\b.*\bqty\b/i.test(line) || /^description\b.*\bqty\b/i.test(line)) return null;
  const cells = line.split(/\t+| {3,}/).map((c) => c.trim()).filter(Boolean);
  if (cells.length >= 2 && /^\d{1,6}$/.test(cells[0]) && cells.length >= 3) cells.shift(); // "1 <tab> item <tab> 30"
  if (cells.length >= 2) {
    const last = cells[cells.length - 1].replace(new RegExp(`\\s*${QTY_WORD}\\.?$`, 'i'), '').replace(/^[×xX]\s*/, '');
    if (/^\d{1,6}$/.test(last)) return { text: clean(cells.slice(0, -1).join(' ')), qty: Number(last) };
  }
  line = line.replace(/^\d{1,3}\s*[.)\]-]\s+/, '');
  const pats = [
    new RegExp(`\\s*[×xX*]\\s*(\\d{1,6})\\s*(?:${QTY_WORD}\\.?)?$`, 'i'),
    new RegExp(`\\s*(?:[-–:=,]|qty\\.?:?|quantity:?)\\s*(\\d{1,6})\\s*(?:${QTY_WORD}\\.?)?$`, 'i'),
    new RegExp(`\\s+(\\d{1,6})\\s*${QTY_WORD}\\.?$`, 'i'),
    /\s+(\d{1,6})$/,
  ];
  for (const p of pats) {
    const m = p.exec(line);
    if (m && m.index > 0) {
      const text = clean(line.slice(0, m.index));
      // "Ensure 800" is a size, not a qty, when nothing else is on the line – keep it as text.
      if (text) return { text, qty: Number(m[1]) };
    }
  }
  return { text: clean(line), qty: null };
}
const clean = (s) => String(s).replace(/\s+/g, ' ').replace(/[\s,;:-]+$/, '').trim();
function splitPaste(text) {
  return String(text || '').split(/\r?\n/).map(splitLine).filter((r) => r && r.text).slice(0, 60);
}

// ---------- matching ----------
const STOP = new Set(['the', 'and', 'of', 'for', 'with', 'in', 'a', 'an', 'to', 'size', 'x']);
function normalise(s) {
  return String(s || '').toLowerCase()
    .replace(/[’`]/g, "'")
    .replace(/(\d+(?:\.\d+)?)\s*cm(?=[^a-z]|x|$)/g, '$1')            // 75cm → 75 (also 75cmx75cm)
    .replace(/(\d+(?:\.\d+)?)\s*[x×*]\s*(\d+(?:\.\d+)?)/g, '$1x$2') // 75 x 75 → 75x75
    .replace(/(\d+)\s*'?\s*s\b/g, '$1')                              // 8's / 10s → 8 / 10
    .replace(/(\d+(?:\.\d+)?)\s+(g|kg|mg|ml|l|mcg|iu|ply|m)\b/g, '$1$2'); // 800 g → 800g
}
function tokens(s) {
  return normalise(s).split(/[^a-z0-9.x]+/).map((t) => t.replace(/^\.+|\.+$/g, '')).filter((t) => t && !STOP.has(t));
}
const unitOf = (t) => { const m = /^\d+(?:\.\d+)?([a-z]+)$/.exec(t); return m ? m[1] : null; };
// How well one query word matches one item word (0–1).
function wordScore(q, c) {
  if (q === c) return 1;
  const qn = /^\d/.test(q); const cn = /^\d/.test(c);
  if (qn || cn) {
    if (qn && cn && unitOf(q) && unitOf(q) === unitOf(c)) return 0.35; // 850g vs 800g: same kind of size
    return 0;
  }
  if (q.length >= 3 && c.startsWith(q)) return 0.85;
  if (c.length >= 3 && q.startsWith(c)) return 0.7;
  if (q.length >= 5 && c.length >= 5 && (q.includes(c) || c.includes(q))) return 0.6;
  return 0;
}
// Score 0–1: mostly how much of the query is found, a little for how much of the item name is used.
function score(queryTokens, itemText) {
  const ct = tokens(itemText);
  if (!queryTokens.length || !ct.length) return 0;
  let got = 0; const used = new Set();
  for (const q of queryTokens) {
    let best = 0; let at = -1;
    ct.forEach((c, i) => { const s = wordScore(q, c) * (used.has(i) ? 0.5 : 1); if (s > best) { best = s; at = i; } });
    if (at >= 0) used.add(at);
    got += best;
  }
  const weightQ = got / queryTokens.length;
  const weightC = used.size / ct.length;
  return Math.round((weightQ * 0.8 + weightC * 0.2) * 1000) / 1000;
}
// The words used to pull candidates from the database (longest first, max 6).
function searchWords(text) {
  return [...new Set(tokens(text).filter((t) => t.length >= 3 || /^\d+[a-z]+$/.test(t)))].sort((a, b) => b.length - a.length).slice(0, 6);
}
function rank(text, items, limit = 5) {
  const qt = tokens(text);
  return items.map((it) => ({ ...it, score: score(qt, it.description) }))
    .filter((it) => it.score > 0.2)
    .sort((a, b) => b.score - a.score || (Number(b.balance) || 0) - (Number(a.balance) || 0) || a.description.length - b.description.length)
    .slice(0, limit);
}

// ---------- prices ----------
const num = (v) => (v === null || v === undefined || v === '' ? null : Number(v));
function autoPrice(cost, markup) {
  const c = num(cost); const m = num(markup);
  if (!(c > 0) || !(m >= 0)) return null;
  const tenSen = Math.ceil(Math.round(c * (1 + m) * 1e6) / 1e5 - 1e-9); // in units of RM0.10
  return Math.round(tenSen) / 10;
}
function markupOf(price, cost) {
  const p = num(price); const c = num(cost);
  if (!(p > 0) || !(c > 0)) return null;
  return (p - c) / c;
}
// 'ok' (green) / 'low' (amber, under the floor) / 'nocost' (amber)
function badge(price, cost, floor) {
  const m = markupOf(price, cost);
  if (m === null) return 'nocost';
  return m + 1e-9 >= Number(floor) ? 'ok' : 'low';
}
function stockDefault(balance, qty) {
  const b = num(balance); const q = num(qty);
  if (b !== null && q !== null && b >= q) return { stock_option: 'readystock', note: '' };
  return { stock_option: 'preorder', note: PREORDER_NOTE };
}
// Money as on the quotation: 8290.8 → "8,290.80"
const money = (n) => Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const formatRef = (series, year, no) => `${series}-${year}-${String(no).padStart(4, '0')}`;

module.exports = { PREORDER_NOTE, splitLine, splitPaste, normalise, tokens, score, searchWords, rank, autoPrice, markupOf, badge, stockDefault, money, formatRef };
