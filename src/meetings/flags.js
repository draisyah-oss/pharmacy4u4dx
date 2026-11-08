// Meetings module: action flags and the auto agenda (pure functions, no database).
// Same rules as the Management Council / Branch Manager Meeting prototypes:
//   overdue = open and due before today; stale = open and no update for 7+ days (or never);
//   escalated to the CEO = needs-CEO, 14+ days overdue or raised 3+ times; due soon = due within 7 days.

const calc = require('../calc');
const { AREAS, AREA_ORDER, BRANCHES, BRANCH_LIST } = require('./access');

const STALE_DAYS = 7;
const OVERDUE_TO_CEO = 14;

const isOpen = (a) => a.status !== 'dn';
const dayOf = (ts) => (ts ? calc.todayInMalaysia(new Date(ts)) : null);
function overdueDays(a, today) {
  if (!isOpen(a) || !a.due || a.due >= today) return 0;
  return calc.diffDays(a.due, today);
}
function staleDays(a, today) {
  if (!isOpen(a)) return 0;
  const last = dayOf(a.last_update_at || a.created_at);
  if (!last) return STALE_DAYS;
  const d = calc.diffDays(last, today);
  return d >= STALE_DAYS ? d : 0;
}
const isStale = (a, today) => isOpen(a) && staleDays(a, today) >= STALE_DAYS;
const dueSoon = (a, today) => isOpen(a) && a.due && a.due >= today && a.due <= calc.addDays(today, 7);
const toCeo = (a, today) => isOpen(a) && (a.needs_ceo || overdueDays(a, today) >= OVERDUE_TO_CEO || (a.raised_count || 1) >= 3);
// Auto agenda items: overdue, blocked, waiting for a CEO decision, raised 3+ times.
const flagged = (a, today) => isOpen(a) && (overdueDays(a, today) > 0 || a.status === 'bl' || a.needs_ceo || (a.raised_count || 1) >= 3);

function decorate(a, today) {
  return {
    ...a,
    open: isOpen(a), overdue: overdueDays(a, today), stale: isStale(a, today), stale_days: staleDays(a, today),
    due_soon: Boolean(dueSoon(a, today)), to_ceo: toCeo(a, today), flagged: flagged(a, today),
  };
}

// Open first, most overdue, needs-CEO, then by due date (as the prototypes).
function sortActions(list, today) {
  return [...list].sort((a, b) => (Number(isOpen(b)) - Number(isOpen(a)))
    || (overdueDays(b, today) - overdueDays(a, today))
    || (Number(Boolean(b.needs_ceo)) - Number(Boolean(a.needs_ceo)))
    || String(a.due || '9').localeCompare(String(b.due || '9')));
}

// The auto agenda for a meeting. template: council | branch | simple.
//   council: WIG → Sales & Marketing → Inventory & Procurement → Finance & payments → HR & Ops →
//            Products (BN) → Branches → B2B/Zakat/Shopee → Decisions needed
//   branch:  WIG & lead measures → each branch → Requests to HQ → Escalations
//   simple:  Open actions needing attention → Decisions needed
// Each section: { key, title, sub, count (open), list (flagged actions, up to 6), link }.
function buildAgenda(template, actions, today, { hqActions = [], managers = {} } = {}) {
  const open = sortActions(actions.filter(isOpen), today);
  const pick = (xs) => xs.filter((a) => flagged(a, today)).slice(0, 6);
  const ceo = open.filter((a) => toCeo(a, today));
  const s = [];
  if (template === 'council') {
    s.push({ key: 'wig', title: 'WIG scoreboard', sub: 'WIG, lead measures and last week’s commitments in 4DX', count: null, list: [], link: '/group' });
    for (const k of ['sales', 'inv', 'fin', 'hr', 'prod']) {
      const x = open.filter((a) => a.area === k);
      s.push({ key: `area-${k}`, title: AREAS[k], count: x.length, list: pick(x) });
    }
    const br = open.filter((a) => BRANCH_LIST.includes(a.branch));
    s.push({ key: 'branches', title: 'Branches', count: br.length,
      sub: BRANCH_LIST.map((b) => `${BRANCHES[b]} ${open.filter((a) => a.branch === b).length}`).join(' · '), list: pick(br) });
    const b2b = open.filter((a) => a.area === 'b2b');
    s.push({ key: 'area-b2b', title: AREAS.b2b, count: b2b.length, list: pick(b2b) });
    s.push({ key: 'decisions', title: 'Decisions needed', count: ceo.length, list: ceo });
  } else if (template === 'branch') {
    s.push({ key: 'wig', title: 'WIG & lead measures', sub: 'Each branch: sales vs target, walk-ins, Google reviews, POCT, stock (4DX scoreboards)', count: null, list: [], link: '/group' });
    for (const b of BRANCH_LIST) {
      const x = open.filter((a) => a.branch === b);
      s.push({ key: `branch-${b}`, title: BRANCHES[b] + (managers[b] ? ` – ${managers[b]}` : ''), sub: '1 win · 2 issues · help needed', count: x.length, list: pick(x), branch: b });
    }
    const hq = open.filter((a) => !BRANCH_LIST.includes(a.branch));
    s.push({ key: 'hq', title: 'Requests to HQ (stock, HR, ops)', count: hq.length + hqActions.length, list: pick(hq), hqActions, link: '/hq/update' });
    s.push({ key: 'escalations', title: 'Escalations to management', count: ceo.length, list: ceo });
  } else {
    s.push({ key: 'attention', title: 'Open actions needing attention', sub: 'Overdue, blocked, waiting for a decision or raised 3+ times', count: open.length, list: open.filter((a) => flagged(a, today)) });
    s.push({ key: 'decisions', title: 'Decisions needed', count: ceo.length, list: ceo });
  }
  return s;
}

// CEO overview / group overview counts.
function counts(actions, today) {
  const open = actions.filter(isOpen);
  return {
    open: open.length,
    overdue: open.filter((a) => overdueDays(a, today) > 0).length,
    ceo: open.filter((a) => a.needs_ceo).length,
    blocked: open.filter((a) => a.status === 'bl').length,
    stale: open.filter((a) => isStale(a, today)).length,
    soon: open.filter((a) => dueSoon(a, today)).length,
  };
}

module.exports = {
  STALE_DAYS, OVERDUE_TO_CEO, isOpen, overdueDays, staleDays, isStale, dueSoon, toCeo, flagged,
  decorate, sortActions, buildAgenda, counts, AREA_ORDER,
};
