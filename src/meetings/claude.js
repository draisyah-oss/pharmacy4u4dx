// Meetings module: Claude drafts the minutes from rough notes / a transcript / a photo of notes.
// Server-side only – ANTHROPIC_API_KEY lives in Railway and never reaches the browser. Without the
// key (or if the call fails) the same review form is filled in by hand.
// The CEO approved this paid service for the Meetings module (8 Nov 2026).
//
// Model: MEETINGS_CLAUDE_MODEL (default claude-opus-5-5). A declined request falls back to
// Anthropic's recommended model server-side (fallbacks: "default").

const A = require('./access');
const calc = require('../calc');

const DEFAULT_MODEL = 'claude-opus-5-5';
const enabled = () => Boolean(process.env.ANTHROPIC_API_KEY);

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['summary', 'decisions', 'actions', 'updates', 'parked', 'next', 'items'],
  properties: {
    summary: { type: 'string' },
    decisions: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['ref', 'text', 'area', 'branch'],
      properties: { ref: { type: 'string' }, text: { type: 'string' }, area: { type: 'string' }, branch: { type: 'string' } } } },
    actions: { type: 'array', items: { type: 'object', additionalProperties: false,
      required: ['ref', 'title', 'owner', 'due', 'area', 'branch', 'priority', 'needs_ceo'],
      properties: { ref: { type: 'string' }, title: { type: 'string' }, owner: { type: 'integer' }, due: { type: 'string' }, area: { type: 'string' },
        branch: { type: 'string' }, priority: { type: 'string' }, needs_ceo: { type: 'boolean' } } } },
    updates: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['ref', 'action_id', 'status', 'note'],
      properties: { ref: { type: 'string' }, action_id: { type: 'integer' }, status: { type: 'string' }, note: { type: 'string' } } } },
    parked: { type: 'array', items: { type: 'string' } },
    next: { type: 'string' },
    items: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['item_id', 'outcome'],
      properties: { item_id: { type: 'integer' }, outcome: { type: 'string' } } } },
  },
};

const SYSTEM = `You write meeting minutes for IMAN Wellness / Pharmacy4U, a community pharmacy chain in Malaysia.
Notes mix Bahasa Melayu and English; keep that mix and write short, clear lines.
A decision is something agreed or approved. An action is a task someone must do, with an owner and a due date.
Never include salaries, pay, gaji, EPF/KWSP or SOCSO details – leave them out of every field.`;

function prompt({ meeting, members, items, updates, openActions, today }) {
  const nextMon = calc.addDays(calc.weekStart(today), 7);
  const lines = [];
  lines.push(`Meeting: ${meeting.group_name}${meeting.title ? ` – ${meeting.title}` : ''} on ${meeting.held_on}${meeting.start_time ? ` ${meeting.start_time}` : ''}.`);
  lines.push(`Today: ${today}. Next Monday: ${nextMon}.`);
  lines.push('', 'People (use the number as owner):');
  for (const m of members) lines.push(`${m.id}: ${m.name}${m.job ? ` – ${m.job}` : ''}${m.branch_code ? ` (${m.branch_code})` : ''}`);
  lines.push('', `Areas (use the key): ${Object.entries(A.AREAS).map(([k, v]) => `${k} = ${v}`).join('; ')}`);
  lines.push(`Branches (use the code): ${Object.entries(A.BRANCHES).map(([k, v]) => `${k} = ${v}`).join('; ')}`);
  lines.push('', 'Open actions already tracked (id | title | owner | status):');
  lines.push(openActions.length ? openActions.map((a) => `${a.id} | ${a.title} | ${a.owner_name || '–'} | ${A.STATUS[a.status]}`).join('\n') : '(none)');
  lines.push('', 'Items raised for this meeting (id | need | raised by | text):');
  lines.push(items.length ? items.map((i) => `${i.id} | ${i.need} | ${i.raised_by_name || '–'} | ${i.text}`).join('\n') : '(none)');
  lines.push('', 'Meeting updates from the attendees:');
  lines.push(updates.length ? updates.map((u) => `${u.name}: win: ${u.win || '–'}; issue 1: ${u.issue1 || '–'}; issue 2: ${u.issue2 || '–'}; help needed: ${u.help_needed || '–'}`).join('\n') : '(none)');
  lines.push('', `Rules:
- If the notes discuss an open action above, put it in "updates" with that action_id and a status (ns, ip, bl, dn). Never create a duplicate action.
- owner must be one of the people numbers above. due is YYYY-MM-DD; if no date is said, use next Monday.
- area must be an area key, branch a branch code, priority High, Normal or Low.
- needs_ceo is true when the item waits for approval, budget or a decision from Dr Aisyah (CEO).
- Give each decision, action and update a short ref ("d1", "a1", "u1").
- Every item raised for this meeting must appear once in "items" with its outcome: the ref of the decision, action or update that settles it, or "parked" if it was left for later. Parked things also go in "parked".
- summary: 2–3 sentences. next: when and what the next meeting is, if said.`);
  lines.push('', 'Meeting notes:', '"""', meeting.notesForClaude || '(see the attached photo)', '"""');
  return lines.join('\n');
}

// Claude's JSON → the review form's draft shape (see ./minutes). Refs are mapped to form keys.
function toDraft(out, { memberIds, openActionIds, itemIds }) {
  const body = { source: 'claude', summary: out.summary || '', next: out.next || '', parked: out.parked || [], dec: {}, act: {}, upd: {}, out: {} };
  const refs = {};
  (out.decisions || []).forEach((d, i) => { body.dec[`k${i}`] = { keep: true, text: d.text, area: d.area, branch: d.branch }; refs[d.ref] = `dec:k${i}`; });
  (out.actions || []).forEach((a, i) => {
    body.act[`k${i}`] = { keep: true, title: a.title, owner: memberIds.includes(a.owner) ? a.owner : null, due: a.due, area: a.area, branch: a.branch, priority: a.priority, needs_ceo: Boolean(a.needs_ceo) };
    refs[a.ref] = `act:k${i}`;
  });
  let n = 0;
  for (const u of out.updates || []) {
    if (!openActionIds.includes(u.action_id)) continue; // unknown or other group's action: dropped
    body.upd[`k${n}`] = { keep: true, action_id: u.action_id, status: u.status, note: u.note };
    refs[u.ref] = `upd:k${n}`; n++;
  }
  for (const it of out.items || []) {
    if (!itemIds.includes(it.item_id)) continue;
    const v = it.outcome === 'parked' ? 'parked' : refs[it.outcome];
    if (v) body.out[`i${it.item_id}`] = v;
  }
  return body;
}

let clientOverride = null; // tests put a fake client here
function setClient(c) { clientOverride = c; }
function client() {
  if (clientOverride) return clientOverride;
  const Anthropic = require('@anthropic-ai/sdk');
  const C = Anthropic.default || Anthropic;
  return new C(); // reads ANTHROPIC_API_KEY
}

// Returns { draft } or { error } (never throws for API problems – the page falls back to manual).
async function draftMinutes(ctx, { image = null } = {}) {
  if (!enabled() && !clientOverride) return { error: 'Claude drafting isn’t switched on (no ANTHROPIC_API_KEY). Write the minutes yourself below.' };
  const content = [];
  if (image) content.push({ type: 'image', source: { type: 'base64', media_type: image.type, data: image.data } });
  content.push({ type: 'text', text: prompt(ctx) });
  let response;
  try {
    response = await client().beta.messages.create({
      model: process.env.MEETINGS_CLAUDE_MODEL || DEFAULT_MODEL,
      max_tokens: 16000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      system: SYSTEM,
      output_config: { effort: 'medium', format: { type: 'json_schema', schema: SCHEMA } },
      messages: [{ role: 'user', content }],
    });
  } catch (err) {
    const Anthropic = (() => { try { const m = require('@anthropic-ai/sdk'); return m.default || m; } catch { return null; } })();
    if (Anthropic && err instanceof Anthropic.AuthenticationError) return { error: 'Claude drafting: the API key isn’t valid. Write the minutes yourself below.' };
    if (Anthropic && err instanceof Anthropic.RateLimitError) return { error: 'Claude is busy right now – try again in a minute, or write the minutes yourself below.' };
    console.error('Meetings – Claude draft failed:', err && err.message);
    return { error: 'Claude couldn’t draft the minutes this time. Try again, or write them yourself below.' };
  }
  if (response.stop_reason === 'refusal') return { error: 'Claude declined to draft these notes. Write the minutes yourself below.' };
  if (response.stop_reason === 'max_tokens') return { error: 'The notes were too long for one draft. Shorten them, or write the minutes yourself below.' };
  const text = (response.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
  let out;
  try { out = JSON.parse(text); } catch { return { error: 'Claude’s answer couldn’t be read. Try again, or write the minutes yourself below.' }; }
  return { draft: toDraft(out, ctx) };
}

module.exports = { enabled, draftMinutes, toDraft, prompt, setClient, SCHEMA, DEFAULT_MODEL };
