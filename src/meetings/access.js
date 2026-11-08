// Meetings module (8 Nov 2026): who can see and change what. Enforced on the server – every route
// loads the group through here, and every list query is limited to groupIdsFor(user).
//
//   Super admin (users.is_super – Dr Aisyah): every group; edits groups and members; approves
//     and unlocks minutes; removes any agenda item or update.
//   Group member: that group's meetings, agenda, updates, actions and decisions; adds items,
//     their own update, actions and action updates; removes their own items and update.
//   Everyone else – other admin logins and full HQ included – gets "not found" for a group they
//     aren't in, so even the names of the CEO's 1:1s don't show.
//   My notes are private to the person who wrote them (no exception).

const AREAS = {
  mgmt: 'Management & Strategy', sales: 'Sales & Marketing', inv: 'Inventory & Procurement',
  fin: 'Finance & Payments', hr: 'HR & Ops', prod: 'Products (BN)', b2b: 'B2B / Zakat / Shopee',
};
const AREA_ORDER = ['sales', 'inv', 'fin', 'hr', 'prod', 'b2b', 'mgmt'];
const BRANCHES = { HQ: 'HQ', WM: 'Wangsa Maju', BR: 'BR', JH: 'JH', BGI: 'Bangi', AMP: 'Ampang', ALL: 'All branches' };
const BRANCH_LIST = ['WM', 'BR', 'JH', 'BGI', 'AMP'];
// Meetings branch codes → the app's branch codes (scoreboard links).
const APP_BRANCH = { WM: 'WM', BR: 'BR', JH: 'JH', BGI: 'Bangi', AMP: 'Ampang' };
const STATUS = { ns: 'Not started', ip: 'In progress', bl: 'Blocked', dn: 'Done' };
const PRIORITY = ['High', 'Normal', 'Low'];
const NEEDS = { decision: 'Decision', update: 'Update', discuss: 'Discuss' };
const MEETING_STATUS = { planned: 'Planned', draft: 'Minutes draft', approved: 'Minutes approved' };
const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

const isCeo = (user) => Boolean(user && user.role === 'admin' && user.is_super);

// Group ids this login may open (null = every group, for the CEO).
async function groupIdsFor(db, user) {
  if (isCeo(user)) return null;
  if (!user) return [];
  return (await db.query(
    `SELECT m.group_id FROM meeting_group_members m JOIN meeting_groups g ON g.id = m.group_id
     WHERE m.user_id = $1 AND g.active`, [user.id])).rows.map((r) => r.group_id);
}

// SQL filter for "groups this login may open": returns [sqlFragment, args] for `column`.
async function groupFilter(db, user, column, args = []) {
  const ids = await groupIdsFor(db, user);
  if (ids === null) return ['TRUE', args];
  return [`${column} = ANY($${args.length + 1}::int[])`, [...args, ids]];
}

async function canSeeGroup(db, user, groupId) {
  const ids = await groupIdsFor(db, user);
  return ids === null || ids.includes(Number(groupId));
}

// Load a group the user may open; null otherwise (the route answers 404).
async function loadGroup(db, user, key) {
  const byCode = typeof key === 'string' && !/^\d+$/.test(key);
  const g = (await db.query(`SELECT * FROM meeting_groups WHERE ${byCode ? 'code' : 'id'} = $1 AND active`, [byCode ? key : Number(key) || 0])).rows[0];
  if (!g || !(await canSeeGroup(db, user, g.id))) return null;
  return g;
}

// Does this login belong to any group (or is the CEO)? Drives the side-menu section.
async function hasMeetings(db, user) {
  if (isCeo(user)) return true;
  const ids = await groupIdsFor(db, user);
  return ids.length > 0;
}

module.exports = {
  AREAS, AREA_ORDER, BRANCHES, BRANCH_LIST, APP_BRANCH, STATUS, PRIORITY, NEEDS, MEETING_STATUS, DAYS,
  isCeo, groupIdsFor, groupFilter, canSeeGroup, loadGroup, hasMeetings,
};
