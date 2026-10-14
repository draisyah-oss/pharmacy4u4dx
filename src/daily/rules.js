// Who can see and edit which branch and date on the Daily Entry screen.

const { addDays } = require('../calc');

const EDIT_DAYS = 7; // today + the 6 days before

function canViewBranch(user, branchId) {
  if (!user) return false;
  if (user.role === 'admin' || user.role === 'hq') return true;
  return user.branch_id === branchId;
}

// Returns null if editing is allowed, otherwise the reason (shown on screen).
function editBlockReason(user, branchId, date, { today, trackerStart }) {
  if (!user) return 'Log in to enter numbers.';
  if (user.role === 'hq') return 'HQ can view daily entries but not change them.';
  if (user.role !== 'admin' && user.branch_id !== branchId) return 'You can only enter numbers for your own branch.';
  if (date > today) return 'This date is in the future.';
  if (date < trackerStart) return `The tracker starts on ${trackerStart}. Earlier sales are already in the totals.`;
  if (user.role !== 'admin' && date < addDays(today, -(EDIT_DAYS - 1))) {
    return 'Only the last 7 days can be changed. Ask admin to fix older days.';
  }
  return null;
}

// The dates shown in the date strip: the last 7 days, never before the tracker started.
function dateStrip(today, trackerStart) {
  const out = [];
  for (let i = EDIT_DAYS - 1; i >= 0; i--) {
    const d = addDays(today, -i);
    if (d >= trackerStart) out.push(d);
  }
  return out;
}

module.exports = { EDIT_DAYS, canViewBranch, editBlockReason, dateStrip };
