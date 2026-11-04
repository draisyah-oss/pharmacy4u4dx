// 4 Nov (CEO: "whatever we tick in 4DX … update in Telegram as well"): short messages to the team's
// Telegram group through a Telegram bot. Never blocks a page: sends in the background, a failure is
// only logged (and kept for the Inventory page's status line).
//
// Railway variables: TELEGRAM_BOT_TOKEN (from @BotFather) and TELEGRAM_CHAT_ID (the group's id, e.g.
// -1001234567890). Either missing → off (nothing is sent). Text that mentions salaries is never sent.

const { mentionsSalary } = require('../privacy');

function createTelegram({ env = process.env, fetchImpl = fetch, log = console.log } = {}) {
  const token = String(env.TELEGRAM_BOT_TOKEN || '').trim();
  const chatId = String(env.TELEGRAM_CHAT_ID || '').trim();
  const on = Boolean(token && chatId && /^\d+:[\w-]{20,}$/.test(token) && /^-?\d+$|^@\w+$/.test(chatId));
  const state = { sent: 0, lastError: null, lastSentAt: null };

  async function send(text) {
    if (!on) return { off: true };
    const body = String(text || '').trim().slice(0, 3800);
    if (!body || mentionsSalary(body)) return { skipped: true };
    try {
      const res = await fetchImpl(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text: body, disable_web_page_preview: true }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || j.ok === false) throw new Error(j.description || `HTTP ${res.status}`);
      state.sent++; state.lastSentAt = new Date().toISOString(); state.lastError = null;
      return { ok: true };
    } catch (err) {
      state.lastError = err.message;
      log(`Telegram message not sent: ${err.message}`);
      return { error: err.message };
    }
  }

  return {
    configured: () => on,
    status: () => ({ configured: on, ...state }),
    send,
    // Fire and forget – for use inside request handlers.
    post(text) { send(text).catch(() => {}); },
  };
}

module.exports = { createTelegram };
