// Sample numbers for the calculation tests. Made up, but realistic.
// Expected results in the tests were worked out by hand from these tables.

// Wangsa Maju, week Mon 12 – Sun 18 Oct 2026 (the first tracker week).
//            Mon12  Tue13  Wed14  Thu15  Fri16  Sat17  Sun18   week total
const WM_WEEK = {
  walkin:   [1650,  1820,  1700,  1905,  1780,  2010,  1500], // 12,365
  tx:       [  55,    60,    58,    62,    57,    66,    50], // 408
  two:      [  22,    27,    25,    30,    24,    31,    20], // 179
  fu:       [  10,     8,    12,     9,    10,     6,     7], // 62
  chronic:  [   3,     2,     4,     3,     3,     2,     1], // 18
  reviews:  [   0,     1,     0,     0,     1,     0,     1], // 3
  wa:       [   0,    50,     0,   120,     0,    80,     0], // 250
  tt:       [   0,     0,   150,     0,     0,   200,     0], // 350
  ttship:   [   4,     3,     5,     2,     6,     4,     3], // 27
  ttship24: [   4,     3,     4,     2,     6,     4,     3], // 26
  zakat:    [   0,  1200,     0,   800,     0,  1500,     0], // 3,500
  grab:     [  40,     0,    60,     0,    35,    90,    25], // 250
  grabon:   [   1,     1,     1,     0,     1,     1,     1], // 6
};

// Ampang, same week. Storefront days = days with 2 staff on duty.
//            Mon12  Tue13  Wed14  Thu15  Fri16  Sat17  Sun18
const AMPANG_WEEK = {
  twostaff: [   1,     1,     0,     1,     0,     1,     1], // 5 storefront days
  hc:       [   6,     4,     0,     5,     2,     7,     3], // 25 on storefront days (+2 on Fri, not counted)
  sfhrs:    [   4,   3.5,     0,     4,     0,   4.5,     3], // 19 on storefront days
};

// JH new TikTok followers, same week.
const JH_WEEK = {
  ttfol:    [   3,     5,     2,     4,     6,     1,     0], // 21
};

const WEEK_DATES = ['2026-10-12', '2026-10-13', '2026-10-14', '2026-10-15', '2026-10-16', '2026-10-17', '2026-10-18'];

// { field: [7 values] } → { date: { field: value } }
function toDays(week, dates = WEEK_DATES) {
  const days = {};
  dates.forEach((date, i) => {
    days[date] = {};
    for (const [field, values] of Object.entries(week)) days[date][field] = values[i];
  });
  return days;
}

module.exports = { WM_WEEK, AMPANG_WEEK, JH_WEEK, WEEK_DATES, toDays };
