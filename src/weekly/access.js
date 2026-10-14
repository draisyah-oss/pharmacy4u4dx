// Who can see and change the Monday screens (check-in, OOS list, commitments).
//
// - Branch managers: their own branch, this week and last week.
// - Admin: every branch, every week.
// - HQ: reads every branch; on the OOS list Inventory fills in the reason, expected date and status.
// - Branch staff: none of these (daily log only).

const calc = require('../calc');
const { mentionsSalary, SALARY_MESSAGE } = require('../privacy');

function viewDenied(user, branch) {
  if (user.role === 'admin' || user.role === 'hq') return null;
  if (user.role === 'branch_manager' && user.branch_id === branch.id) return null;
  if (user.role === 'branch_manager') return 'You can only open your own branch.';
  return 'The weekly check-in and commitments are for branch managers. Your manager goes through them at the Monday session.';
}

function editDenied(user, branch, week, today) {
  if (user.role === 'admin') return null;
  if (user.role === 'hq') return 'HQ can read this; the branch manager fills it in.';
  if (user.role !== 'branch_manager' || user.branch_id !== branch.id) return 'Only this branch’s manager can change it.';
  const thisWeek = calc.weekStart(today);
  if (week > thisWeek) return 'That week hasn’t started yet.';
  if (week < calc.addDays(thisWeek, -7)) return 'Only this week and last week can be changed. Ask admin to fix older weeks.';
  return null;
}

// HQ (Inventory) and admin answer OOS items: reason for the delay, expected date, status.
const canAnswerOos = (user) => user.role === 'hq' || user.role === 'admin';

// Free text from a form: trimmed, length-limited, never salary/pay details.
function cleanText(value, { max = 500, label = 'This box' } = {}) {
  const s = String(value ?? '').replace(/\s+/g, ' ').trim();
  if (!s) return { value: null };
  if (s.length > max) return { error: `${label} is too long (${max} characters at most).` };
  if (mentionsSalary(s)) return { error: SALARY_MESSAGE };
  return { value: s };
}

module.exports = { viewDenied, editDenied, canAnswerOos, cleanText };
