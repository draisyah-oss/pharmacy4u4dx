// The calculation rules from CLAUDE.md. Pure functions: no database, no clock (pass dates in),
// so they're easy to test against the Excel trackers.

module.exports = {
  ...require('./dates'),
  ...require('./targets'),
  ...require('./status'),
  ...require('./entries'),
  ...require('./measures'),
  ...require('./sales'),
  ...require('./stock'),
  ...require('./running'),
  ...require('./hq'),
};
