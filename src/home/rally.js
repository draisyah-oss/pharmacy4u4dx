// 6 Nov (CEO: "sales were slow yesterday – encourage the team to make sales today"): a short push
// message from Dr Aisyah at the top of 📣 News, shown only on its day(s). Figures: yesterday's till
// sales from the 2026 Sales Dashboard ("Overall Daily Sales") against today's walk-in WIG target.
const RALLIES = [
  {
    from: '2026-11-06', until: '2026-11-06', from_name: 'Dr Aisyah',
    title: 'Let’s bounce back today!',
    lead: 'Yesterday (Thu 5 Nov) was our slowest day this month – RM5,077 across all branches, about 60% of our walk-in targets. One slow day is just one day. Today we make it up together.',
    branches: [
      { code: 'WM', yesterday: 1211.53, target: 1980 },
      { code: 'JH', yesterday: 1661.30, target: 1830, star: true },
      { code: 'BR', yesterday: 638.65, target: 1355 },
      { code: 'Bangi', yesterday: 1004.87, target: 1980 },
      { code: 'Ampang', yesterday: 560.45, target: 1360 },
    ],
    actions: [
      'Greet every customer and ask: “Anything else you need today?”',
      'Offer one PWP or add-on with every purchase – aim for 3+ items a basket.',
      'Put this week’s target products in customers’ hands, not just on the shelf.',
      'Offer a free health check or POCT when a customer has a minute.',
      'Keep Grab online all day and the menu stocked.',
    ],
    close: 'JH came closest yesterday (91% of target) – well done! Friday is a good day: let’s all hit our target today. Check your branch’s number at closing.',
  },
];

const current = (today, list = RALLIES) => list.find((r) => today >= r.from && today <= r.until) || null;
module.exports = { RALLIES, current };
