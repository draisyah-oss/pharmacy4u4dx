// Zakat quotation (WM) rules – pasting, matching, pricing, stock option (11 Nov 2026).
// Costs here are made up (the real item master is never in the repo).
const test = require('node:test');
const assert = require('node:assert/strict');
const L = require('../../src/quotations/logic');
const { paginate, rowHeight, ROW_GAP } = require('../../src/quotations/pdf');

test('pasting the 0401 RFQ: one item per line, qty at the end', () => {
  const rows = L.splitPaste("Ensure Gold 850g ×30\nDr. P Premium LV7 Pants L 8's ×90\nAdult wet wipes 40's ×60\nUnderpad 75cm x 75cm 10's ×36\n");
  assert.deepEqual(rows, [
    { text: 'Ensure Gold 850g', qty: 30 },
    { text: "Dr. P Premium LV7 Pants L 8's", qty: 90 },
    { text: "Adult wet wipes 40's", qty: 60 },
    { text: "Underpad 75cm x 75cm 10's", qty: 36 },
  ]);
});

test('pasting: qty columns, words and numbering', () => {
  assert.deepEqual(L.splitPaste('Item\tQty\n1\tPanadol 500mg\t30\n2. Ensure Gold 850g x 12\nOat 800g - 5 tins\nGloves qty: 4\nNo qty here'), [
    { text: 'Panadol 500mg', qty: 30 },
    { text: 'Ensure Gold 850g', qty: 12 },
    { text: 'Oat 800g', qty: 5 },
    { text: 'Gloves', qty: 4 },
    { text: 'No qty here', qty: null },
  ]);
  assert.deepEqual(L.splitPaste('12.5mg tablets x 3'), [{ text: '12.5mg tablets', qty: 3 }], 'a decimal size is not a list number');
  assert.deepEqual(L.splitPaste(''), []);
});

test('matching: sizes and counts are normalised (75cm x 75cm = 75X75, 10\'s = 10S)', () => {
  assert.deepEqual(L.tokens("Underpad 75cm x 75cm 10's"), ['underpad', '75x75', '10']);
  assert.deepEqual(L.tokens('NUR CARE UNDERPAD 75CMX75CM (L) 10S'), ['nur', 'care', 'underpad', '75x75', 'l', '10']);
  assert.deepEqual(L.tokens('Ensure 800 g'), ['ensure', '800g']);
});

test('matching: the best 5, the right item among them', () => {
  const items = [
    'ENSURE GOLD WHEAT 800G', 'ENSURE GOLD POWDER (VANILLA) 800G', 'ENSURE GOLD LIQUID VANILLA 220ML', 'ENSURE PLUS 400G',
    "DR. P PREMIUM ADULT WIPES 40S", "PLOVE ADULT WIPES 40'S", 'BABY WIPES 80S', 'PANADOL 500MG 10S',
    'PRIMES DISPOSABLE UNDERPAD 75X75 4PLY 10 SHEETS', "NUR CARE UNDERPAD 75CMX75CM (L) ECONOMY 10'S", 'UNDERPAD 60X90 10S',
  ].map((description, id) => ({ id, description, balance: 1 }));
  const top = (q) => L.rank(q, items).map((m) => m.description);
  assert.ok(top('Ensure Gold 850g').slice(0, 3).includes('ENSURE GOLD POWDER (VANILLA) 800G'));
  assert.ok(!top('Ensure Gold 850g').includes('PANADOL 500MG 10S'));
  assert.ok(top("Adult wet wipes 40's").slice(0, 2).includes('DR. P PREMIUM ADULT WIPES 40S'));
  const pads = top("Underpad 75cm x 75cm 10's");
  assert.ok(pads.indexOf('PRIMES DISPOSABLE UNDERPAD 75X75 4PLY 10 SHEETS') < pads.indexOf('UNDERPAD 60X90 10S'));
  assert.ok(L.rank('x', items).length <= 5);
  assert.deepEqual(L.searchWords('Ensure Gold 850g'), ['ensure', 'gold', '850g']);
});

test('price = cost × (1 + markup), rounded UP to the next RM0.10', () => {
  assert.equal(L.autoPrice(8.91, 0.2), 10.7); // 10.692 → 10.70
  assert.equal(L.autoPrice(10, 0.2), 12); // exactly 12.00 stays 12.00
  assert.equal(L.autoPrice(7.01, 0.2), 8.5); // 8.412 → 8.50
  assert.equal(L.autoPrice(100, 0.15), 115);
  assert.equal(L.autoPrice(0, 0.2), null);
  assert.equal(L.autoPrice(null, 0.2), null);
});

test('margin badge: green at or above the floor (on cost), amber below or with no cost', () => {
  assert.equal(L.badge(12, 10, 0.15), 'ok');
  assert.equal(L.badge(11.5, 10, 0.15), 'ok'); // exactly 15%
  assert.equal(L.badge(11.4, 10, 0.15), 'low');
  assert.equal(L.badge(28.5, null, 0.15), 'nocost');
  assert.equal(Math.round(L.markupOf(12, 10) * 100), 20);
});

test('stock option: Readystock when the balance covers the qty, else Pre-order - 7 days', () => {
  assert.deepEqual(L.stockDefault(39, 36), { stock_option: 'readystock', note: '' });
  assert.deepEqual(L.stockDefault(13, 30), { stock_option: 'preorder', note: 'Pre-order - 7 days' });
  assert.deepEqual(L.stockDefault(null, 5), { stock_option: 'preorder', note: 'Pre-order - 7 days' });
  assert.equal(L.money(8290.8), '8,290.80');
  assert.equal(L.formatRef('QT-WM', 2026, 403), 'QT-WM-2026-0403');
});

test('PDF pages: about 20 single lines fit one page; more go to page 2 with the TOTAL on the last', () => {
  const one = rowHeight(1);
  assert.equal(one, ROW_GAP);
  assert.equal(paginate(Array(4).fill(one)).length, 1);
  assert.equal(paginate(Array(15).fill(one)).length, 1);
  const p = paginate(Array(30).fill(one));
  assert.ok(p.length >= 2);
  assert.deepEqual(p.flat(), [...Array(30).keys()], 'every line once, in order');
});
