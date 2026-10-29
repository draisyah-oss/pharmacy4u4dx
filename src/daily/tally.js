// 29 Oct (CEO, BR first – app_settings tally_branches): "+1" buttons on Daily entry, so the counter
// phone counts POCT tests, new members and focus items as they happen instead of a paper tally that
// is typed in at closing. Each tap is saved at once through saveDailyEntries (same checks, audit log
// and 7-day rule as Save). Only count boxes typed by staff – never sales-sheet boxes. "−1" fixes a
// wrong tap and never goes below 0.

const { saveDailyEntries } = require('./data');

async function tallyBranches(db) {
  const row = (await db.query("SELECT value FROM app_settings WHERE key = 'tally_branches'")).rows[0];
  try { return row ? JSON.parse(row.value) : []; } catch { return []; }
}
const tallyOn = async (db, code) => (await tallyBranches(db)).includes(code);

// body.tally = '<field key>:+1' or '<field key>:-1'
function parseTap(value) {
  const m = /^([a-z0-9_]{1,40}):([+-]1)$/i.exec(String(value || ''));
  return m ? { key: m[1], delta: Number(m[2]) } : null;
}

async function addTally(db, { branch, date, user, tap, sheetFields = new Set() }) {
  if (!tap) return { error: 'That button didn’t work – reload the page.' };
  const field = (await db.query('SELECT key, label, type FROM daily_fields WHERE branch_id = $1 AND key = $2 AND active', [branch.id, tap.key])).rows[0];
  if (!field || field.type !== 'count') return { error: 'Only count boxes have +1.' };
  if (sheetFields.has(field.key)) return { error: `${field.label} comes from the sales sheet.` };
  const row = (await db.query('SELECT value FROM daily_entries WHERE branch_id = $1 AND entry_date = $2 AND field_key = $3', [branch.id, date, field.key])).rows[0];
  const before = row ? Number(row.value) : 0;
  const after = Math.max(0, before + tap.delta);
  if (after === before && row) return { key: field.key, label: field.label, value: after, changed: false };
  const r = await saveDailyEntries(db, { branch, date, user, input: { [field.key]: String(after) }, sheetFields, keepMissing: true });
  if (Object.keys(r.errors).length) return { error: r.errors[field.key] || Object.values(r.errors)[0] };
  return { key: field.key, label: field.label, value: after, changed: true };
}

module.exports = { tallyBranches, tallyOn, parseTap, addTally };
