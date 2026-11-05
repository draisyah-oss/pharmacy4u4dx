// 5 Nov (CEO): "October achievers" on the front page, in 📣 News – from the CEO's design
// (claude.ai design "October Achievers"), in English. Each entry shows from `from` to `until`
// (Malaysia dates). Add next month's by adding an entry – figures exactly as the CEO announced them.
const ACHIEVERS = [
  {
    month: '2026-10', label: 'October 2026', from: '2026-11-01', until: '2026-11-30',
    podiumTitle: 'Best sales performance · Top 3',
    podium: [
      { place: 1, name: 'Hazera', amount: 'RM18,004.24', tag: 'Champion' },
      { place: 2, name: 'Yaya', amount: 'RM17,109.83' },
      { place: 3, name: 'Ainnur', amount: 'RM15,479.45' },
    ],
    podiumPrize: 'Prize: certificate · rotating trophy',
    branches: [
      { title: 'Highest branch sales', note: 'including zakat and Shopee', branch: 'JH', value: 'RM74,201.80', prizes: ['Certificate', 'RM50 hamper'] },
      { title: 'Highest retail sales', note: 'walk-in only', branch: 'Bangi', value: 'RM49,006.87', prizes: ['Certificate', 'Rotating trophy', 'RM100 cash'] },
      { title: '4DX performance: consistent on target', branch: 'BR', prizes: ['Certificate'] },
      { title: 'Google review excellence', branch: 'JH', value: '60 Google reviews', prizes: ['Certificate'], gold: true },
    ],
    thanks: 'Thank you to every team for your dedication and effort',
    next: 'Let’s set a new record in November',
  },
];

// The entry showing on `today` (YYYY-MM-DD), newest first.
const current = (today, list = ACHIEVERS) => list.filter((a) => today >= a.from && today <= a.until).sort((a, b) => b.month.localeCompare(a.month))[0] || null;

module.exports = { ACHIEVERS, current };
