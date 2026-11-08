// Meetings module: the copy-ready WhatsApp reminder (Bahasa Melayu), grouped by person –
// overdue, due in the next 7 days, no update for 7+ days. Pure function, no database.

const fmt = (iso) => new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-GB', { timeZone: 'UTC', day: 'numeric', month: 'short' });

function reminderText(actions, { title, updateBy, today }) {
  const open = actions.filter((a) => a.open);
  const byOwner = new Map();
  for (const a of open) {
    if (!(a.overdue || a.due_soon || a.stale)) continue;
    const k = a.owner_name || 'Belum ada PIC';
    if (!byOwner.has(k)) byOwner.set(k, []);
    byOwner.get(k).push(a);
  }
  const lines = [`*${title} – peringatan tindakan* (${fmt(today)})`];
  if (updateBy) lines.push(`Sila kemas kini status + satu ayat update sebelum ${updateBy}.`);
  if (!byOwner.size) { lines.push('', 'Tiada tindakan lewat atau tertunggak. Terima kasih semua! 👏'); return lines.join('\n'); }
  for (const [name, list] of [...byOwner.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    lines.push('', `*${name}*`);
    for (const a of list) {
      const why = a.overdue ? `🔴 lewat ${a.overdue} hari` : a.due_soon ? `🟡 due ${fmt(a.due)}` : '';
      const quiet = a.stale ? `⚪ tiada update ${a.stale_days >= 7 ? `${a.stale_days} hari` : ''}`.trim() : '';
      lines.push(`- ${a.title}${[why, quiet].filter(Boolean).length ? ` (${[why, quiet].filter(Boolean).join(', ')})` : ''}`);
    }
  }
  return lines.join('\n');
}

module.exports = { reminderText };
