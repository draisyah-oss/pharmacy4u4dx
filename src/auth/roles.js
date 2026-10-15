// Login roles in one place.
//
//   branch_staff    own branch, daily entry only                              PIN
//   branch_manager  own branch: daily, scoreboard, check-in, commitments,      password
//                   plus the group scoreboard
//   hq_staff        HQ with a normal login (Syarafana, Fariz, Azwani): group   PIN
//                   scoreboard, HQ scoreboard, own KPIs, own daily tasks,
//                   own commitments, own projects
//   hq              full HQ (Alia, Hanin, Iman): reads every branch, HQ input  password
//   admin           everything                                                 password

const PIN_ROLES = ['branch_staff', 'hq_staff'];
const usesPin = (role) => PIN_ROLES.includes(role);
const isHqLead = (user) => Boolean(user) && (user.role === 'hq' || user.role === 'admin');
const isHqPerson = (user) => Boolean(user) && (user.role === 'hq' || user.role === 'hq_staff');
const ROLE_TEXT = {
  branch_staff: 'Staff (PIN)', branch_manager: 'Manager (password)',
  hq: 'HQ – full access (password)', hq_staff: 'HQ staff – own KPIs (PIN)', admin: 'Admin',
};

module.exports = { PIN_ROLES, usesPin, isHqLead, isHqPerson, ROLE_TEXT };
