// 30 Oct: Company policies – read-only pages every logged-in user can open (/policies).
// The CEO's approved documents, typed in exactly as approved (wording unchanged) plus the
// signed PDF to download. A new policy = a new entry here (+ its PDF in ./files).
// Blocks: { p }, { h } (sub-heading), { table: { head: [...], rows: [[...]] } }.
// **bold** inside text is shown in bold.

const path = require('path');

const POLICIES = [
  {
    slug: 'annual-leave-carry-forward',
    docNo: 'HR_AL_301026',
    title: 'Annual Leave Carry-Forward Policy and Procedure',
    area: 'HR policies',
    company: 'Iman Wellness and Health Sdn Bhd (1486413-D)',
    effective: '2026-10-30',
    preparedBy: 'HR and Operation Manager',
    approvedBy: 'Dr Aisyah Zainordin (CEO)',
    appliesTo: 'All employees covered by the Employment Act 1955',
    summary: 'Up to 5 days of unused annual leave carry forward each 31 December and must be taken by the next 31 December.',
    file: 'HR_AL_301026.pdf',
    sections: [
      { h: '1. Purpose', blocks: [
        { p: 'This document sets out how unused annual leave (AL) at the end of the leave year is carried forward, how many days may be carried forward, and when carried-forward days expire. It is written to comply with the Employment Act 1955 (the Act).' },
      ] },
      { h: '2. Scope', blocks: [
        { p: '2.1 This policy applies to all confirmed and probationary employees with an AL balance on 31st of December 2026.' },
        { p: '2.2 It covers **AL only**. No other leave type (sick leave, hospitalisation leave, replacement leave, or any other leave) can be carried forward. Such leave lapses at the end of the leave year.' },
      ] },
      { h: '3. Legal Basis', blocks: [
        { p: '3.1 Section 60E of the Act sets the minimum annual leave by length of service and requires the employee to be allowed to take it within 12 months after each 12 months of continuous service.' },
        { p: '3.2 The Act does not require, and does not cap, carry-forward of leave. The carry-forward rule in this document is a company policy that operates on top of the Act.' },
        { p: '3.3 Nothing in this policy reduces any right given to employees by the Act. If this policy conflicts with the Act, the Act prevails.' },
      ] },
      { h: '4. Leave Entitlement', blocks: [
        { p: 'Each employee\'s AL entitlement is as stated in their offer letter and tracked in the Mysyarikat. The leave year runs from 1st of January to 31st of December. This document covers carry-forward only.' },
      ] },
      { h: '5. Carry-Forward Rules', blocks: [
        { p: '5.1 Employees may carry forward their unused AL balance as at 31 December, up to a maximum of **5 days**. This rule applies from the 31 December 2026 year-end.' },
        { p: '5.2 Carried-forward days must be **taken** on or before **31 December** of the year they are carried forward to. Example: days carried forward from 31 December 2026 must be taken by 31 December 2027.' },
        { p: '5.3 Balance above 5 days is forfeited on 31 December, subject to Clause 6.' },
        { p: '5.4 Carried-forward days not taken by 31 December of the year they are carried forward to are forfeited on that date, subject to Clause 6.' },
        { p: '5.5 Carried-forward days are used first when an employee applies for leave in the new year, then the current year\'s entitlement.' },
        { p: '5.6 Half-day balances (0.5 day) are carried forward as they are, within the applicable cap.' },
      ] },
      { h: '6. Protection of Employee Rights', blocks: [
        { p: '6.1 Leave is forfeited only if the employee had a fair opportunity to take it.' },
        { p: '6.2 The company will make sure each employee can take at least their statutory minimum leave within the 12-month period required by the Act.' },
        { p: '6.3 **Statutory minimum:** forfeiture under Clause 5 applies first to days above the employee\'s statutory minimum. Days within the statutory minimum are not forfeited before the end of the 12-month period allowed by Section 60E for taking that leave, counted from the employee\'s service anniversary.' },
        { p: '6.4 All AL requests and their status are kept in the Mysyarikat.' },
      ] },
      { h: '7. Calculation Examples', blocks: [
        { table: { head: ['AL balance on 31 Dec', 'Days carried forward (cap 5)', 'Days forfeited on 31 Dec'], num: true, rows: [
          ['2 days', '2', '0'], ['5 days', '5', '0'], ['6 days', '5', '1'], ['12 days', '5', '7'], ['16 days', '5', '11'],
        ] } },
      ] },
      { h: '8. Cash Conversion and Termination', blocks: [
        { p: '8.1 AL is not converted to cash while the employee is still employed.' },
        { p: '8.2 When employment ends for any reason, accrued and unused AL (including valid carried-forward days) is paid as required by the Act and the employment contract. Calculation: **ordinary daily rate of pay × number of unused days**.' },
        { p: '8.3 If an employee leaves before the carry-forward deadline with a carried-forward balance, that balance is included in the payment under Clause 8.2.' },
      ] },
      { h: '9. Responsibilities', blocks: [
        { table: { head: ['Party', 'Responsibility'], rows: [
          ['Employee', 'Check leave balance, plan and apply for leave early, use leave before the deadline'],
          ['Branch manager', 'Approve leave fairly and plan workload so the team can take leave'],
          ['HR', 'Update balances, send reminders, calculate carry-forward, keep records'],
        ] } },
      ] },
      { h: '10. Procedure and Yearly Timeline', blocks: [
        { table: { head: ['When', 'Action', 'Who'], rows: [
          ['31 October 2026', 'Extract AL balances for all employees', 'HR'],
          ['November 2026', 'Send written notice: balance, carry-forward amount and deadlines', 'HR'],
          ['1 December 2026', 'Second reminder to employees with high balances, copy to managers', 'HR'],
          ['31 December 2026', 'Close current-year balances', 'HR'],
          ['1 to 10 January 2027', 'Update carried-forward balances and email confirmation to each employee', 'HR'],
          ['September & December 2027', 'Reminder: carried-forward balance expires on 31 December', 'HR'],
          ['1 January 2028', 'Forfeit unused carried-forward balance (except protected days under Clause 6)', 'HR'],
        ] } },
        { p: 'HR keeps copies of all notices and reminders.' },
      ] },
      { h: '11. Special Cases', blocks: [
        { p: '11.1 If an employee is on sick leave, maternity leave or other approved leave that stops them from taking carried-forward AL before the carry-forward deadline, the deadline is **automatically extended** by the number of days of that absence.' },
        { p: '11.2 Any other exception requires written approval from HR Manager.' },
      ] },
      { h: '12. Review', blocks: [
        { p: 'This document is reviewed yearly, and whenever the Employment Act or related regulations are amended.' },
      ] },
    ],
  },
];

const FILES_DIR = path.join(__dirname, 'files');

const find = (slug) => POLICIES.find((p) => p.slug === slug) || null;

// Every policy's text in one string (tests check it never mentions salaries).
const allText = (p) => [p.title, p.summary, ...p.sections.flatMap((s) => [s.h, ...s.blocks.flatMap((b) =>
  b.p ? [b.p] : b.table ? [...b.table.head, ...b.table.rows.flat()] : [])])].join('\n');

module.exports = { POLICIES, FILES_DIR, find, allText };
