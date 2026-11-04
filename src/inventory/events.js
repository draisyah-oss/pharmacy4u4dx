// 4 Nov (CEO: "whatever we tick here in 4DX … update in Telegram as well … so we don't need to update"):
// what happens after a change on /inventory –
//  • a short message to the team's Telegram group (src/lib/telegram.js), and
//  • the Payment_Approvals Google Sheet rewritten from 4DX a few seconds later (src/inventory/sheet.js),
//    which is what Mr Eve reads from Drive.
// Ticks are gathered for 2 minutes per person, so ticking 20 lines sends one message, not 20.

const calc = require('../calc');

const rm = (v) => (v === null || v === undefined || v === '' ? '' : `RM${Number(v).toLocaleString('en-MY', { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`);
const day = (iso) => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || '')); return m ? new Date(`${m[1]}-${m[2]}-${m[3]}T00:00:00Z`).toLocaleDateString('en-GB', { timeZone: 'UTC', day: 'numeric', month: 'short' }) : ''; };
const who = (u) => (u ? (u.is_super ? 'Dr Aisyah' : (u.display_name || u.username || 'Someone')) : 'Mr Eve');
const keyOf = (s) => { const w = String(s || '').toUpperCase().replace(/[^A-Z0-9 ]/g, ' ').trim().split(/\s+/).filter(Boolean); return !w.length ? '' : w[0] === 'AA' ? `AA ${w[1] || ''}`.trim() : w[0]; };

function createInventoryEvents(db, { telegram = null, sheet = null, now = () => new Date(), env = process.env, tickWindowMs = 2 * 60 * 1000 } = {}) {
  const domain = env.APP_URL || (env.RAILWAY_PUBLIC_DOMAIN ? `https://${env.RAILWAY_PUBLIC_DOMAIN}` : '');
  const link = (hash = '') => (domain ? `\n${domain.replace(/\/$/, '')}/inventory${hash}` : '');
  const say = (text) => { if (telegram && telegram.configured()) telegram.post(text); };
  const ticks = new Map(); // user id → { name, items, timer }

  const line = async (id) => (await db.query(`SELECT id, supplier, proposed, approved, approved_amount, paid, pay_date::text AS pay_date,
    date_paid::text AS date_paid, paid_via, pv_no FROM inv_payments WHERE id = $1`, [id])).rows[0];

  return {
    // kind: approve | paid | unpaid | added
    async payment(kind, id, user) {
      if (sheet) sheet.syncSoon();
      if (!telegram || !telegram.configured()) return;
      try {
        const p = kind === 'added' ? null : await line(id);
        if (kind === 'approve' && p) {
          if (p.approved === 'Yes') say(`👍 ${who(user)} approved ${p.supplier} ${rm(p.approved_amount ?? p.proposed)}${p.pay_date ? ` (to pay ${day(p.pay_date)})` : ''}. Azwani can pay it in Swipey.${link('#payments')}`);
          else if (p.approved === 'Partial') say(`👍 ${who(user)} approved part of ${p.supplier}: ${rm(p.approved_amount)} of ${rm(p.proposed)}.${link('#payments')}`);
          else if (p.approved === 'No') say(`✋ ${who(user)} did not approve ${p.supplier} ${rm(p.proposed)} – don't pay it.${link('#payments')}`);
          else say(`↩️ ${who(user)} took back the approval for ${p.supplier} ${rm(p.proposed)}.`);
        } else if (kind === 'paid' && p) {
          const k = keyOf(p.supplier);
          const open = (await db.query('SELECT supplier, paid FROM inv_payments')).rows.filter((r) => keyOf(r.supplier) === k);
          const allPaid = open.length && open.every((r) => r.paid);
          say(`✅ ${who(user)} marked ${p.supplier} ${rm(p.approved_amount ?? p.proposed)} paid${p.date_paid ? ` on ${day(p.date_paid)}` : ''}`
            + `${p.paid_via ? ` – ${p.paid_via}` : ''}${p.pv_no ? `, ref ${p.pv_no}` : ''}.`
            + `${allPaid ? ` Every ${p.supplier} payment is now paid – Alia can order from them.` : ''}${link('#suppliers')}`);
        } else if (kind === 'unpaid' && p) {
          say(`↩️ ${who(user)} marked ${p.supplier} ${rm(p.approved_amount ?? p.proposed)} as NOT paid (undo).`);
        } else if (kind === 'added') {
          const r = (await db.query('SELECT supplier, proposed, pay_date::text AS pay_date FROM inv_payments ORDER BY id DESC LIMIT 1')).rows[0];
          if (r) say(`➕ ${who(user)} added a payment: ${r.supplier} ${rm(r.proposed)}${r.pay_date ? ` for ${day(r.pay_date)}` : ''} – waiting for Dr Aisyah's approval.${link('#payments')}`);
        }
      } catch (err) { console.error('Inventory event:', err.message); }
    },

    // A daily-plan line ticked done (undo ticks aren't announced).
    async tick(lineId, user, done) {
      if (!done || !telegram || !telegram.configured() || !user) return;
      try {
        const l = (await db.query('SELECT item, action FROM inv_plan_lines WHERE id = $1', [lineId])).rows[0];
        if (!l) return;
        let b = ticks.get(user.id);
        if (!b) {
          b = { name: who(user), items: [] };
          ticks.set(user.id, b);
          b.timer = setTimeout(() => {
            ticks.delete(user.id);
            const list = b.items.slice(0, 15).map((t) => `• ${t}`).join('\n');
            const more = b.items.length > 15 ? `\n… and ${b.items.length - 15} more` : '';
            say(`☑️ ${b.name} ticked ${b.items.length} line${b.items.length === 1 ? '' : 's'} done on Mr Eve's list:\n${list}${more}${link('#today')}`);
          }, tickWindowMs);
          if (b.timer.unref) b.timer.unref();
        }
        b.items.push(`${l.item}${l.action ? ` (${String(l.action).replace(/^URGENT \d+ - /i, 'urgent – ').toLowerCase()})` : ''}`);
      } catch (err) { console.error('Inventory event:', err.message); }
    },

    // Mr Eve's new plan arrived from Google Drive.
    async planLoaded(date, loadPage) {
      if (!telegram || !telegram.configured()) return;
      try {
        const d = await loadPage(db, { today: calc.todayInMalaysia(now()), date });
        if (!d.plan) return;
        const S = d.S;
        say(`📋 Mr Eve's plan for ${day(date)} is in 4DX: ${S.counts.urgent} urgent, ${S.transfer_lines} transfers first (no cash), `
          + `${S.order_now_lines} to order now (about ${rm(Math.round(S.order_now_rm))}), ${S.wait_lines} waiting for a supplier payment.`
          + `${S.late_lines ? ` ⚠️ ${S.late_lines} approved payment${S.late_lines === 1 ? ' is' : 's are'} past the pay date and not marked paid.` : ''}${link('#today')}`);
      } catch (err) { console.error('Inventory event:', err.message); }
    },

    flush() { for (const [, b] of ticks) { clearTimeout(b.timer); } ticks.clear(); },
  };
}

module.exports = { createInventoryEvents };
