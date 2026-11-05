// 5 Nov: Mr 4DX's log of what it did with approved change requests (src/requests/mr4dx.json),
// applied once on start – so Mr 4DX never needs a key to the live app:
//   { "id": 7, "live": "what changed, in plain words", "commit": "abc1234" }  → Approved → Live
//   { "id": 7, "ask": "the question" }                                        → Approved → Need more info
// Each entry is applied once (app_settings mr4dx:<id>:<live|ask>:<hash>). "live" only ever applies to a
// request Dr Aisyah approved; anything else is skipped and logged.
const crypto = require('crypto');
const rq = require('./data');

function readLog(file = require('path').join(__dirname, 'mr4dx.json')) {
  try { const a = JSON.parse(require('fs').readFileSync(file, 'utf8')); return Array.isArray(a) ? a : []; } catch { return []; }
}

async function applyMr4dx(db, { entries = readLog(), now = () => new Date(), log = console.log } = {}) {
  const done = [];
  for (const e of entries) {
    const kind = e && e.live ? 'live' : e && e.ask ? 'ask' : null;
    if (!kind || !Number.isInteger(e.id)) continue;
    const text = String(e[kind]);
    const key = `mr4dx:${e.id}:${kind}:${crypto.createHash('sha1').update(text).digest('hex').slice(0, 10)}`;
    if ((await db.query('SELECT 1 FROM app_settings WHERE key = $1', [key])).rows.length) continue;
    const r = await rq.load(db, e.id);
    let out = { skipped: 'not found' };
    if (r && kind === 'live') {
      out = r.approved_at && ['Approved', 'Need more info'].includes(r.status)
        ? await rq.setStatus(db, null, r, { status: 'Live', message: `${text}${e.commit ? ` (${e.commit})` : ''}` }, { now, author: 'Mr 4DX' })
        : { skipped: `status ${r.status}${r.approved_at ? '' : ', not approved'}` };
    } else if (r && kind === 'ask') {
      out = r.status === 'Approved'
        ? await rq.setStatus(db, null, r, { status: 'Need more info', message: text }, { now, author: 'Mr 4DX' })
        : { skipped: `status ${r.status}` };
    }
    await db.query('INSERT INTO app_settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING', [key, JSON.stringify({ at: now().toISOString(), ...out })]);
    log(`Mr 4DX #${e.id} ${kind}: ${out.skipped ? `skipped (${out.skipped})` : out.error || 'done'}`);
    done.push({ id: e.id, kind, ...out });
  }
  return done;
}

module.exports = { applyMr4dx, readLog };
