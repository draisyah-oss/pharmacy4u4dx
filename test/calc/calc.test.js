// Calculation rules (CLAUDE.md), tested on a sample week.
// Targets come from the real seed.json; expected values are worked out by hand in comments.

const test = require('node:test');
const assert = require('node:assert/strict');

const calc = require('../../src/calc');
const { readSeed } = require('../../src/db/seed');
const { WM_WEEK, AMPANG_WEEK, JH_WEEK, toDays } = require('../fixtures/sample-weeks');

const seed = readSeed();
const START = seed.company.tracker_start_date; // 2026-10-12
const branch = (code) => seed.branches.find((b) => b.code === code);
const measure = (code, id) => branch(code).measures.find((m) => m.id === id);
// WM's Grab-online and TikTok-24h measures were dropped on 16 Oct; their rules are still tested.
const oldMeasure = (code, id) => require('../fixtures/seed-before-wm-16oct.json').branches.find((b) => b.code === code).measures.find((m) => m.id === id);
const entriesFor = (week) => calc.indexEntries(calc.rowsFromDays(toDays(week)));
const NO_ENTRIES = calc.indexEntries([]);

// Equal to 6 decimal places (money and % are shown with far fewer).
const near = (actual, expected, msg) =>
  assert.ok(Math.abs(actual - expected) < 1e-6, `${msg || ''} expected ${expected}, got ${actual}`);

const wm = entriesFor(WM_WEEK);
const WEEK = { from: '2026-10-12', to: '2026-10-18', trackerStart: START };
const wmWeek = (id) => calc.evaluateMeasure({ measure: measure('WM', id), entries: wm, ...WEEK });

// ───────────── Dates ─────────────

test('dates: weeks run Monday–Sunday', () => {
  assert.equal(calc.weekStart('2026-10-12'), '2026-10-12'); // Monday
  assert.equal(calc.weekStart('2026-10-18'), '2026-10-12'); // Sunday belongs to the week before
  assert.equal(calc.weekStart('2026-10-19'), '2026-10-19');
  assert.equal(calc.weekEnd('2026-10-14'), '2026-10-18');
  assert.equal(calc.daysInMonth('2026-10'), 31);
  assert.equal(calc.daysInMonth('2026-11'), 30);
});

test('dates: "today" is Malaysia time, not the server clock', () => {
  // 17:30 UTC on 14 Oct = 01:30 on 15 Oct in Kuala Lumpur
  assert.equal(calc.todayInMalaysia(new Date('2026-10-14T17:30:00Z')), '2026-10-15');
  assert.equal(calc.todayInMalaysia(new Date('2026-10-14T15:59:00Z')), '2026-10-14');
});

// ───────────── Targets ─────────────

test('targets: daily as is, weekly ÷ 7, monthly ÷ days in that month', () => {
  near(calc.dailyTarget({ '2026-10': 1730 }, 'day', '2026-10-14'), 1730);
  near(calc.dailyTarget({ '2026-10': 2 }, 'week', '2026-10-14'), 2 / 7);
  near(calc.dailyTarget({ '2026-10': 1000 }, 'month', '2026-10-14'), 1000 / 31);
  near(calc.dailyTarget({ '2026-11': 2000 }, 'month', '2026-11-14'), 2000 / 30);
  assert.equal(calc.dailyTarget({ '2026-10': null }, 'day', '2026-10-14'), null);
});

// ───────────── Sum measures, sample week ─────────────

test('WM walk-in (WIG, RM 1,795/day since 22 Oct): 12,365 vs 12,565 = 98.4% ▲', () => {
  const r = wmWeek('T1');
  assert.equal(r.actual, 12365);       // 1650+1820+1700+1905+1780+2010+1500
  near(r.target, 12565);               // 7 × 1795
  near(r.pct, 12365 / 12565);          // 0.984
  assert.equal(r.status, 'watch');
  assert.equal(r.daysEntered, 7);
});

test('WM follow-ups (Lead 1, 10/day): 62 vs 70 = 88.6% ✕', () => {
  const r = wmWeek('F1');
  assert.equal(r.actual, 62);
  near(r.target, 70);
  assert.equal(r.status, 'off_track');
});

test('WM new chronic customers (Lead 2, 3/day): 18 vs 21 = 85.7% ✕', () => {
  const r = wmWeek('Z2');
  assert.equal(r.actual, 18);
  near(r.target, 21);
  assert.equal(r.status, 'off_track');
});

test('WM Google reviews (2 a week): 3 vs 2 = 150% ✔', () => {
  const r = wmWeek('T4');
  assert.equal(r.actual, 3);
  near(r.target, 2);                   // 7 days × 2/7
  assert.equal(r.status, 'on_track');
});

test('WM WhatsApp sales (RM 1,000/month in Oct): 250 vs 225.81 = 110.7% ✔', () => {
  const r = wmWeek('Z0');
  assert.equal(r.actual, 250);
  near(r.target, 7000 / 31);           // 7 × 1000/31 = 225.806…
  assert.equal(r.status, 'on_track');
});

test('WM zakat sales (RM 20,000/month): 3,500 vs 4,516.13 = 77.5% ✕', () => {
  const r = wmWeek('W5');
  assert.equal(r.actual, 3500);
  near(r.target, 140000 / 31);         // 4,516.129…
  assert.equal(r.status, 'off_track');
});

test('WM Grab online all hours (yes/no, every day): 6 of 7 days = 85.7% ✕', () => {
  const r = calc.evaluateMeasure({ measure: oldMeasure('WM', 'W2'), entries: wm, ...WEEK });
  assert.equal(r.actual, 6);
  near(r.target, 7);
  assert.equal(r.status, 'off_track');
});

// ───────────── Ratio measures ─────────────

test('WM transactions with 3+ items (45%): 179 ÷ 408 = 43.9% → 97.5% of target ▲', () => {
  const r = wmWeek('L3');
  assert.equal(r.numerator, 179);
  assert.equal(r.denominator, 408);
  near(r.actual, 179 / 408);           // 0.43873
  near(r.target, 0.45);
  near(r.pct, 179 / 408 / 0.45);       // 0.97495
  assert.equal(r.status, 'watch');
});

test('WM TikTok shipped within 24h (100%): 26 ÷ 27 = 96.3% ▲', () => {
  const r = calc.evaluateMeasure({ measure: oldMeasure('WM', 'Z3'), entries: wm, ...WEEK });
  near(r.actual, 26 / 27);
  near(r.target, 1);
  assert.equal(r.status, 'watch');
});

test('ratio with nothing to divide by (0 orders) shows no data, not 0%', () => {
  const r = calc.evaluateMeasure({ measure: oldMeasure('WM', 'Z3'), entries: NO_ENTRIES, ...WEEK });
  assert.equal(r.actual, null);
  assert.equal(r.status, 'no_data');
});

// ───────────── Ratio per storefront day (Ampang) ─────────────

const ampang = entriesFor(AMPANG_WEEK);
const ampangWeek = (id) => calc.evaluateMeasure({ measure: measure('Ampang', id), entries: ampang, ...WEEK });

test('Ampang health checks per storefront day (5/day): 25 ÷ 5 days = 5.0 ✔', () => {
  const r = ampangWeek('U1');
  assert.equal(r.denominator, 5);      // Mon, Tue, Thu, Sat, Sun had 2 staff
  assert.equal(r.numerator, 25);       // 6+4+5+7+3 – Friday's 2 checks (1 staff) not counted
  near(r.actual, 5);
  near(r.target, 5);                   // a number per day, not a %
  assert.equal(r.status, 'on_track');
});

test('Ampang storefront hours per storefront day (4h): 19 ÷ 5 = 3.8 = 95% ▲', () => {
  const r = ampangWeek('U2');
  near(r.actual, 3.8);                 // 4+3.5+4+4.5+3 = 19
  near(r.pct, 0.95);
  assert.equal(r.status, 'watch');
});

// ───────────── Status rule edges ─────────────

test('status: ≥100% ✔, 90–99% ▲, <90% ✕, blank target = track only', () => {
  assert.equal(calc.statusFor(1), 'on_track');
  assert.equal(calc.statusFor(0.9), 'watch');
  assert.equal(calc.statusFor(0.405 / 0.45), 'watch'); // 0.8999999… in floating point = 90%
  assert.equal(calc.statusFor(0.8999), 'off_track');
  assert.equal(calc.statusFor(null), 'no_data');
  assert.equal(calc.statusFor(0.5, { hasTarget: false }), 'track_only');
});

test('blank target = track only: Bangi first-visit vouchers shows the actual, no status', () => {
  const entries = calc.indexEntries(calc.rowsFromDays({ '2026-10-13': { vouch: 4 }, '2026-10-16': { vouch: 2 } }));
  const r = calc.evaluateMeasure({ measure: measure('Bangi', 'Y2'), entries, ...WEEK });
  assert.equal(r.actual, 6);
  assert.equal(r.target, null);
  assert.equal(r.status, 'track_only');
});

// ───────────── Weeks across months, tracker start ─────────────

test('week 26 Oct – 1 Nov uses each day\'s own month target', () => {
  const span = { from: '2026-10-26', to: '2026-11-01', trackerStart: START, entries: NO_ENTRIES };
  // WM walk-in: 6 × 1,795 (Oct) + 1 × 1,980 (Nov) = 12,750
  near(calc.evaluateMeasure({ measure: measure('WM', 'T1'), ...span }).target, 12750);
  // WM WhatsApp: 6 × 1,000/31 + 2,000/30 = 260.215…
  near(calc.evaluateMeasure({ measure: measure('WM', 'Z0'), ...span }).target, 6000 / 31 + 2000 / 30);
  // WM Grab active inventory (22 Oct): a rate, 50% in both months – not added up
  near(calc.evaluateMeasure({ measure: measure('WM', 'GI'), ...span }).target, 0.5);
});

test('week from a track-only month into a month with a target compares like with like', () => {
  // A monthly measure: Oct blank, Nov RM 300 → only 1 Nov has a target (300/30 = 10)
  // (shaped like JH's TikTok commission before 15 Oct, when Nov had RM 300)
  const entries = calc.indexEntries(calc.rowsFromDays({ '2026-10-27': { ttcom: 50 }, '2026-11-01': { ttcom: 12 } }));
  const m = { calc: 'sum', target_per: 'month', numerator_field: 'ttcom', denominator_field: null, targets: { '2026-10': null, '2026-11': 300, '2026-12': 1000 } };
  const r = calc.evaluateMeasure({
    measure: m, entries, from: '2026-10-26', to: '2026-11-01', trackerStart: START,
  });
  near(r.target, 10);
  assert.equal(r.actual, 12);          // only 1 Nov counts against the Nov target
  assert.equal(r.partialTarget, true);
  assert.equal(r.status, 'on_track');
});

test('October MTD measure targets count from 12 Oct only', () => {
  // WM walk-in MTD to 18 Oct: target 7 × 1,795 = 12,565 (not 18 × 1,795)
  const r = calc.evaluateMeasure({
    measure: measure('WM', 'T1'), entries: wm, from: '2026-10-01', to: '2026-10-18', trackerStart: START,
  });
  near(r.target, 12565);
  assert.equal(r.actual, 12365);
  assert.equal(r.daysCounted, 7);
});

test('every result lists the daily rows behind it (for click-through)', () => {
  const r = wmWeek('L3');
  assert.equal(r.days.length, 7);
  assert.deepEqual(r.days[1], { date: '2026-10-13', numerator: 27, denominator: 60 });
});

// ───────────── Sales: total, MTD, required per day ─────────────

const WM = branch('WM');
const WM_BASELINE = { baseline_end_date: '2026-10-11', sales_before_start: WM.before_tracker.sales_1_to_11_oct };

test('WM branch total sales for the week = walk-in + zakat + WA + Grab = 16,365 (TikTok dropped 22 Oct)', () => {
  const r = calc.branchSales({ entries: wm, fields: WM.total_sales_fields, ...WEEK });
  assert.equal(r.total, 16365);        // 12,365 + 3,500 + 250 + 250
  assert.equal(r.days[0].total, 1690); // Mon: 1,650 walk-in + 40 Grab
});

test('WM October MTD to 18 Oct adds the 1–11 Oct sales: 19,900 + 16,365 = 36,265', () => {
  const r = calc.mtdSales({ entries: wm, fields: WM.total_sales_fields, asOf: '2026-10-18', baseline: WM_BASELINE });
  assert.equal(r.beforeTracker, 19900);
  assert.equal(r.tracked, 16365);
  assert.equal(r.total, 36265);
});

test('November MTD does not add the October baseline', () => {
  const r = calc.mtdSales({ entries: wm, fields: WM.total_sales_fields, asOf: '2026-11-03', baseline: WM_BASELINE });
  assert.equal(r.total, 0);
});

test('WM required sales/day after 18 Oct: (60,900 − 36,265) ÷ 13 days = RM 1,895', () => {
  const r = calc.requiredPerDay({ monthTarget: WM.monthly_total_target['2026-10'], mtdActual: 36265, asOf: '2026-10-18' });
  assert.equal(r.daysLeft, 13);        // 19–31 Oct
  assert.equal(r.remaining, 24635);
  near(r.perDay, 24635 / 13);          // 1,895
});

test('required sales/day: 0 once the target is hit, none on the last day', () => {
  assert.equal(calc.requiredPerDay({ monthTarget: 60900, mtdActual: 61000, asOf: '2026-10-25' }).perDay, 0);
  const last = calc.requiredPerDay({ monthTarget: 60900, mtdActual: 59000, asOf: '2026-10-31' });
  assert.equal(last.daysLeft, 0);
  assert.equal(last.perDay, null);
  assert.equal(last.remaining, 1900);
});

// ───────────── Stock turnover ─────────────

test('stock turnover: COGS 9,200 ÷ avg stock 40,000 = 0.23 a week, 30.4 days of stock ✔', () => {
  const r = calc.stockTurnover({ weeklyCogs: 9200, openingStock: 41000, closingStock: 39000 });
  near(r.averageStock, 40000);
  near(r.turnover, 0.23);
  near(r.daysOfStock, 7 / 0.23);       // 30.43
  assert.equal(r.status, 'on_track');
});

test('stock turnover: COGS 7,000 → 0.175 = 76% of target ✕; missing numbers → no data', () => {
  const r = calc.stockTurnover({ weeklyCogs: 7000, openingStock: 41000, closingStock: 39000 });
  near(r.turnover, 0.175);
  near(r.daysOfStock, 40);
  assert.equal(r.status, 'off_track');
  assert.equal(calc.stockTurnover({ weeklyCogs: 7000, openingStock: null, closingStock: 39000 }).status, 'no_data');
  assert.equal(calc.stockTurnover({ weeklyCogs: 7000, openingStock: 0, closingStock: 0 }).turnover, null);
});

// ───────────── Running totals ─────────────

test('JH TikTok followers: 762 + 21 = 783 by 18 Oct, ahead of the 782.6 needed to reach 1,000', () => {
  const tf = branch('JH').running_totals.find((r) => r.id === 'TF');
  const r = calc.runningTotal({
    entries: entriesFor(JH_WEEK), field: tf.field, startValue: tf.start_value, startDate: START,
    endTarget: tf.end_target, endDate: '2026-12-31', asOf: '2026-10-18',
  });
  assert.equal(r.total, 783);
  near(r.pctOfTarget, 0.783);
  assert.equal(r.remaining, 217);
  near(r.expectedByNow, 762 + 238 * 7 / 81); // 81 days 12 Oct – 31 Dec; 7 gone
  assert.equal(r.onPace, true);
  near(r.perDayNeeded, 217 / 74);      // 2.93 a day for the last 74 days
});

test('WM chronic database: 0 + 18 = 18 of 200; Google reviews 140 + 3 = 143 of 159', () => {
  const run = (id) => {
    const rt = WM.running_totals.find((r) => r.id === id);
    return calc.runningTotal({
      entries: wm, field: rt.field, startValue: rt.start_value, startDate: START,
      endTarget: rt.end_target, endDate: '2026-12-31', asOf: '2026-10-18',
    });
  };
  assert.equal(run('CR').total, 18);
  near(run('CR').expectedByNow, 200 * 7 / 81); // 17.28 – so 18 is just on pace
  assert.equal(run('CR').onPace, true);
  assert.equal(run('GR').total, 143);
  near(run('GR').expectedByNow, 140 + 19 * 7 / 81); // 141.64 – 143 is ahead
  assert.equal(run('GR').onPace, true);
});

test('running total with no start value yet is flagged, not guessed', () => {
  const r = calc.runningTotal({
    entries: wm, field: 'chronic', startValue: null, startDate: START,
    endTarget: 200, endDate: '2026-12-31', asOf: '2026-10-18',
  });
  assert.equal(r.startMissing, true);
  assert.equal(r.expectedByNow, null);
});

// ───────────── HQ ─────────────

test('HQ: inventory days is better low – 88 vs 92 ✔, 101 vs 92 ▲', () => {
  const turn = seed.hq.measures.find((m) => m.id === 'turn');
  near(calc.evaluateHq({ measure: turn, entry: { value: 88 }, target: 92 }).pct, 92 / 88);
  assert.equal(calc.evaluateHq({ measure: turn, entry: { value: 88 }, target: 92 }).status, 'on_track');
  assert.equal(calc.evaluateHq({ measure: turn, entry: { value: 101 }, target: 92 }).status, 'watch');
});

test('HQ: done of total – 18 of 20 POs checked = 90% ▲', () => {
  const po = seed.hq.measures.find((m) => m.id === 'po');
  const r = calc.evaluateHq({ measure: po, entry: { value: 18, total: 20 }, target: 1 });
  near(r.actual, 0.9);
  assert.equal(r.status, 'watch');
});

// ───────────── Weekday / weekend targets (BR, core JD revision 14 Oct) ─────────────

test('BR walk-in (29 Oct): RM 1,250 Tuesday–Saturday, RM 1,650 on the busy days Sunday and Monday, every month', () => {
  const t1 = measure('BR', 'T1');
  assert.equal(t1.high_days, 'Sun,Mon');
  const day = (d) => calc.dailyTarget(t1.targets, 'day', d, t1.weekend_targets, t1.high_days);
  assert.equal(day('2026-11-03'), 1250); // Tuesday
  assert.equal(day('2026-11-07'), 1250); // Saturday – no longer a high day
  assert.equal(day('2026-11-08'), 1650); // Sunday
  assert.equal(day('2026-11-09'), 1650); // Monday
  assert.equal(day('2026-12-14'), 1650); // Monday in December – same amounts every month
  assert.equal(day('2026-12-15'), 1250);
  // Without high_days the weekend figure still applies on Saturday and Sunday (other branches)
  assert.equal(calc.dailyTarget(t1.targets, 'day', '2026-11-07', t1.weekend_targets), 1650);
  assert.equal(calc.dailyTarget(t1.targets, 'day', '2026-11-09', t1.weekend_targets), 1250);
  assert.equal(calc.highDaysLabel('Sun,Mon'), 'Sun–Mon');
  assert.equal(calc.highDaysLabel(null), 'Sat–Sun');
});

test('BR walk-in week 2–8 Nov: 5 × 1,250 + 2 × 1,650 = RM 9,550', () => {
  const r = calc.evaluateMeasure({ measure: measure('BR', 'T1'), entries: NO_ENTRIES, from: '2026-11-02', to: '2026-11-08', trackerStart: START });
  near(r.target, 9550);
});

test('BR POCT lead (29 Oct): 6 a week with product recommendations, any day', () => {
  const n1 = measure('BR', 'N1');
  assert.equal(n1.target_per, 'week');
  assert.equal(n1.weekend_targets, undefined);
  const entries = calc.indexEntries(calc.rowsFromDays({ '2026-11-03': { poct: 2 }, '2026-11-05': { poct: 1 }, '2026-11-08': { poct: 3 } }));
  const r = calc.evaluateMeasure({ measure: n1, entries, from: '2026-11-02', to: '2026-11-08', trackerStart: START });
  assert.equal(r.actual, 6);
  near(r.target, 6);
  assert.equal(r.status, 'on_track');
});

test('BR 29 Oct: lag measures, 5 focus items, owners; PWP, 3+ items and Qushairi gone', () => {
  const br = branch('BR');
  assert.equal(br.monthly_total_target['2026-10'], 60000);
  assert.deepEqual(br.total_sales_fields, ['walkin', 'zakat', 'shopee', 'grab', 'alpine']);
  for (const month of ['2026-10', '2026-11', '2026-12']) {
    assert.equal(measure('BR', 'M3').targets[month], 7500);
    assert.equal(measure('BR', 'A5').targets[month], 10000);
    assert.equal(measure('BR', 'AL').targets[month], 500);
    assert.equal(measure('BR', 'G0').targets[month], 1500);
    assert.equal(measure('BR', 'T4').targets[month], 20);
  }
  assert.equal(measure('BR', 'T4').target_per, 'month');
  assert.equal(br.running_totals.find((r) => r.id === 'GR').end_target, 200);
  const focus = br.measures.filter((m) => /^P\d$/.test(m.id));
  assert.deepEqual(focus.map((m) => [m.label.replace('Focus item: ', ''), m.targets['2026-11'], m.owner]), [
    ['Beecrobes', 2, 'Alya'], ['Nature Pharmacy / Proponeem soap bar', 0.5, 'Alya'], ['Androchi', 0.5, 'Alya'], ['Acevis', 1, 'Alya'], ['Nurvi', 0.5, 'Alya']]);
  const owner = (id) => measure('BR', id).owner;
  assert.deepEqual([owner('N1'), owner('Q1'), owner('M3'), owner('A5'), owner('AL'), owner('A7'), owner('T4'), owner('G0')],
    ['Amirah', 'Ainur', 'Ainur', 'Amirah', 'Alya', 'Alya', 'Aqilah', 'Aqilah']);
  assert.match(measure('BR', 'A7').label, /2 weeks of supply/);
  for (const key of ['two', 'pwp', 'aframe', 'p3', 'p5', 'p6', 'p8']) assert.ok(!br.daily_fields.some((f) => f.key === key), key);
  assert.ok(!br.measures.some((m) => m.id === 'T2' || m.id === 'Q4'));
  assert.ok(!br.people.some((p) => p.name === 'Qushairi'));
  assert.ok(br.people.some((p) => p.name === 'Aqilah'));
  assert.ok(![...br.measures, ...br.daily_fields].some((x) => x.owner === 'Qushairi'));
});
