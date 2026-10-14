// Privacy rule (CLAUDE.md): never store or show salaries.
//
// The app has no salary data by design. This guard stops anyone adding it later – a daily
// field, measure or sales-sheet column called "Salary", "Gaji", "Wages", "Payroll"… is refused
// in seed.json, in Admin and by the sales-sheet sync. The database has the same check
// (migration 005), so even code that forgets to call this can't save one.
// "Commission" is allowed on purpose: JH's TikTok affiliate commission is sales income.

const SALARY_WORDS = /salar(y|ies)?|gaji|\bwages?\b|payroll|\bupah\b|pay\s*slip|slip\s*gaji|\bkwsp\b|\bepf\b|\bsocso\b|\bperkeso\b/i;

function mentionsSalary(...texts) {
  return texts.some((t) => t !== null && t !== undefined && SALARY_WORDS.test(String(t)));
}

const SALARY_MESSAGE = 'Salaries and pay can’t be stored in this app (privacy rule).';

module.exports = { SALARY_WORDS, mentionsSalary, SALARY_MESSAGE };
