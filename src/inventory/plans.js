// Fixed parts of the Inventory page (3 Nov, CEO): the month's cash plan by week and the PO budget
// by supplier, agreed at the 28 Oct payment-plan meeting. They change once a month, so they live
// here (like the policies) rather than in Drive. A new month = a new entry, same shape.
//
// Cash plan copied from the "Pharmacy4U Ordering & Payment Board" dashboard's attached file
// (nov_cash_plan.json); PO budget as Dr Aisyah updated it on 3 Nov. Left out on purpose (privacy rule – never show
// salaries): the weekly fixed costs, which include staff pay. Only money in, supplier payments
// and the cash left at the end of each week are shown.
//
// budget[].gate – how ordering stands before the Payment_Approvals sheet is checked:
//   open           order now
//   after_payment  opens once every Payment_Approvals line for `unlock` (a supplier key) is Paid
//   soa            after Azwani confirms the supplier's statement of account
//   check          check the account / terms first
//   hold           not until the account reopens
// budget[].key – the supplier key the daily plan and Payment_Approvals use (see board.supplierKey).

const PLANS = {
  '2026-11': {
    month: '2026-11',
    agreed: '28 Oct meeting',
    cashFloor: 10000,
    cutFirst: 'If sales or zakat come in late, the week 3 payments are cut first.',
    cash: [
      { week: '28 Oct–1 Nov', salesIn: 27200, zakatIn: 0, supplierOut: 30655, cashEnd: 23350, paying: 'AA Alive RM15,482 · Teepham RM13,606 · YSP RM1,567 (to reconfirm)' },
      { week: '1–8 Nov', salesIn: 70700, zakatIn: 0, supplierOut: 41000, cashEnd: 10849, paying: 'Zuellig part 1 (rent RM21,200 by the 7th)' },
      { week: '9–15 Nov', salesIn: 61800, zakatIn: 31866, supplierOut: 71000, cashEnd: 12398, paying: 'Zuellig part 2, needs the zakat money by 15 Nov' },
      { week: '16–22 Nov', salesIn: 61800, zakatIn: 0, supplierOut: 45000, cashEnd: 19398, paying: 'DKSH RM35,677 · Redwood RM5,000 · Pahang RM2,433 · Kotra RM1,890' },
      { week: '23–30 Nov', salesIn: 70700, zakatIn: 0, supplierOut: 0, cashEnd: 17543, paying: 'No supplier payments this week' },
    ],
    // PO budget by supplier – updated 3 Nov by Dr Aisyah (RM200,628.03 in all). Suppliers not in her
    // list stay on the table (status, terms) with no November budget.
    budgetUpdated: '3 Nov (Dr Aisyah)',
    budget: [
      { supplier: 'Zuellig Pharma', key: 'ZUELLIG', terms: '60 days', gate: 'after_payment', unlock: 'ZUELLIG', when: 'Once the RM112k is paid (by 15 Nov)', poBudget: 115961.58, fallsDue: 'about mid-January' },
      { supplier: 'DKSH (104)', key: 'DKSH', terms: '30 days', gate: 'after_payment', unlock: 'DKSH', when: 'After the week 3 payment (A items only)', poBudget: 55023.25, fallsDue: 'about 20 December' },
      { supplier: 'Tongee', key: 'TONGEE', terms: '–', gate: 'check', unlock: '', when: 'Check terms with Azwani first', poBudget: 10237.62, fallsDue: '–' },
      { supplier: 'AISH', key: 'AISH', terms: '–', gate: 'check', unlock: '', when: 'Check terms with Azwani first', poBudget: 4588.85, fallsDue: '–' },
      { supplier: 'Duopharma', key: 'DUOPHARMA', terms: '60 days', gate: 'soa', unlock: '', when: 'Once Azwani confirms its SOA', poBudget: 3911.96, fallsDue: 'about early January' },
      { supplier: 'Nova', key: 'NOVA', terms: '–', gate: 'check', unlock: '', when: 'Check terms with Azwani first', poBudget: 3340.80, fallsDue: '–' },
      { supplier: 'Ben Way', key: 'BEN', terms: '–', gate: 'check', unlock: '', when: 'Check terms with Azwani first', poBudget: 2864.35, fallsDue: '–' },
      { supplier: 'DCH', key: 'DCH', terms: 'CBD', gate: 'check', unlock: '', when: 'Cash before delivery – pay DCH first', poBudget: 2100.00, fallsDue: 'on order' },
      { supplier: 'Mun Xin', key: 'MUN', terms: '–', gate: 'check', unlock: '', when: 'Check terms with Azwani first', poBudget: 1599.62, fallsDue: '–' },
      { supplier: 'DKSH (103)', key: 'DKSH 103', terms: '30 days', gate: 'check', unlock: '', when: 'Check the 103 account with Azwani', poBudget: 1000.00, fallsDue: '–' },
      { supplier: 'Pahang Pharmacy', key: 'PAHANG', terms: '90 days', gate: 'open', unlock: '', when: 'Now', poBudget: 0, fallsDue: 'end of January' },
      { supplier: 'Apex Pharmacy', key: 'APEX', terms: '60 days', gate: 'open', unlock: '', when: 'Now', poBudget: 0, fallsDue: 'about end of December' },
      { supplier: 'AA Alive', key: 'AA ALIVE', terms: '60 days', gate: 'after_payment', unlock: 'AA ALIVE', when: 'Now, once the 30 Oct payment is marked paid', poBudget: 0, fallsDue: 'about end of December' },
      { supplier: 'Teepham Medical', key: 'TEEPHAM', terms: '60 days', gate: 'after_payment', unlock: 'TEEPHAM', when: 'Now, once the 30 Oct payment is marked paid', poBudget: 0, fallsDue: 'about end of December' },
      { supplier: 'Eldon Healthcare', key: 'ELDON', terms: '60 days', gate: 'open', unlock: '', when: 'Now', poBudget: 0, fallsDue: 'about end of December' },
      { supplier: 'Delfi Marketing', key: 'DELFI', terms: '60 days', gate: 'open', unlock: '', when: 'Now', poBudget: 0, fallsDue: 'about end of December' },
      { supplier: 'YSP Industries', key: 'YSP', terms: '60 days', gate: 'after_payment', unlock: 'YSP', when: 'After YSP reconfirms RM1,567 and it is paid', poBudget: 0, fallsDue: 'about early January' },
      { supplier: 'Kotra Pharma', key: 'KOTRA', terms: '30 days', gate: 'after_payment', unlock: 'KOTRA', when: 'After the week 3 payment', poBudget: 0, fallsDue: 'about 20 December' },
      { supplier: 'Pharmaniaga', key: 'PHARMANIAGA', terms: '104 days (Alia, 3 Nov)', gate: 'check', unlock: '', when: 'Not in the November budget. Check overdue with Azwani first', poBudget: 0, fallsDue: '–' },
      { supplier: 'Others (check SOA first)', key: 'OTHERS', terms: '30–90 days', gate: 'check', unlock: '', when: 'Alia to check each one’s SOA', poBudget: 0, fallsDue: '–' },
      { supplier: 'Redwood Pharma', key: 'REDWOOD', terms: '30 days', gate: 'hold', unlock: '', when: 'Not until the account reopens', poBudget: 0, fallsDue: '–' },
    ],
  },
};

// The plan for a month (YYYY-MM); when that month has none yet, the latest one before it, flagged
// so the page can say so. null when there is no plan at all.
function planFor(month, plans = PLANS) {
  if (plans[month]) return { ...plans[month], isCurrent: true };
  const earlier = Object.keys(plans).filter((m) => m < month).sort().pop();
  return earlier ? { ...plans[earlier], isCurrent: false } : null;
}

module.exports = { PLANS, planFor };
