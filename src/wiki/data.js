// Company wiki + Pharmacy4U Classroom (16 Oct). Lives inside the app so staff open it with the
// login they already have, and it can feed the staff AI assistant later.
//
// Sections: Company (incl. a live org chart from the people list), Job descriptions, SOPs,
// Classroom (modules, slides, documents) and Educational posters. Everyone logged in reads all
// of it; HQ and admin add and change pages. Branch staff send posters (JH makes one a day);
// HQ (Hanin) approves them or asks for a fix; approved posters go into the Classroom and the
// Meta post queue. Files are stored in the database (wiki_files), checked by their content.

const calc = require('../calc');
const { mentionsSalary, SALARY_MESSAGE } = require('../privacy');

const SECTIONS = {
  company: { name: 'Company', blurb: 'About Pharmacy4U, the org chart, policies and how we work.' },
  jd: { name: 'Job descriptions', blurb: 'What each role does and is measured on.' },
  sop: { name: 'SOPs', blurb: 'Step-by-step ways of working, branch and HQ.' },
  classroom: { name: 'Classroom', blurb: 'Pharmacy4U Classroom: training modules, slides and documents.' },
  poster: { name: 'Educational posters', blurb: 'Daily health posters made by the branches, approved by HQ.' },
};

const MAX_BYTES = 15 * 1024 * 1024;

// What a file really is, from its first bytes (never trust the browser's label).
// SVG/HTML are refused: they could carry scripts.
function sniff(buf, filename) {
  const ext = String(filename || '').toLowerCase().split('.').pop();
  const h = buf.subarray(0, 12);
  const starts = (...b) => b.every((x, i) => h[i] === x);
  if (starts(0x89, 0x50, 0x4e, 0x47)) return { mime: 'image/png', kind: 'image' };
  if (starts(0xff, 0xd8, 0xff)) return { mime: 'image/jpeg', kind: 'image' };
  if (starts(0x47, 0x49, 0x46, 0x38)) return { mime: 'image/gif', kind: 'image' };
  if (starts(0x52, 0x49, 0x46, 0x46) && buf.subarray(8, 12).toString('latin1') === 'WEBP') return { mime: 'image/webp', kind: 'image' };
  if (starts(0x25, 0x50, 0x44, 0x46)) return { mime: 'application/pdf', kind: 'pdf' };
  if (buf.subarray(4, 8).toString('latin1') === 'ftyp' && ['mp4', 'm4v', 'mov'].includes(ext)) return { mime: 'video/mp4', kind: 'video' };
  if (starts(0x50, 0x4b, 0x03, 0x04)) {
    const office = {
      pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    }[ext];
    if (office) return { mime: office, kind: 'office' };
  }
  if (starts(0xd0, 0xcf, 0x11, 0xe0)) {
    const old = { ppt: 'application/vnd.ms-powerpoint', doc: 'application/msword', xls: 'application/vnd.ms-excel' }[ext];
    if (old) return { mime: old, kind: 'office' };
  }
  return null;
}
const kindOf = (mime) => (mime.startsWith('image/') ? 'image' : mime === 'application/pdf' ? 'pdf' : mime.startsWith('video/') ? 'video' : 'office');

const canEdit = (user) => user.role === 'hq' || user.role === 'admin';
const canReview = (user) => user.role === 'hq' || user.role === 'admin';
const canSendPoster = (user) => ['branch_staff', 'branch_manager', 'hq', 'admin'].includes(user.role);

function clean(v, { max, label, required = false }) {
  const s = String(v ?? '').replace(/\r\n/g, '\n').trim();
  if (!s) return required ? { error: `${label} can’t be empty.` } : { value: null };
  if (s.length > max) return { error: `${label} is too long (${max} characters at most).` };
  if (mentionsSalary(s)) return { error: SALARY_MESSAGE };
  return { value: s };
}

async function audit(tx, user, action, key, newV) {
  await tx.query(
    "INSERT INTO audit_log (user_id, action, table_name, record_key, new_value) VALUES ($1, $2, 'wiki_pages', $3, $4)",
    [user ? user.id : null, action, key, newV == null ? null : JSON.stringify(newV)]);
}

async function saveFile(tx, user, file) {
  if (!file || !file.buffer || !file.size) return { value: null };
  if (file.size > MAX_BYTES) return { error: 'That file is bigger than 15 MB. Make it smaller (e.g. save the slides as PDF) and try again.' };
  const name = String(file.originalname || 'file').replace(/[\\/\0]/g, '_').slice(0, 120);
  if (mentionsSalary(name)) return { error: SALARY_MESSAGE };
  const t = sniff(file.buffer, name);
  if (!t) return { error: 'That kind of file can’t be added. Use a picture (JPG, PNG, WEBP, GIF), PDF, PowerPoint, Word, Excel or a short MP4.' };
  const { rows } = await tx.query(
    'INSERT INTO wiki_files (filename, mime, size, data, created_by) VALUES ($1, $2, $3, $4, $5) RETURNING id',
    [name, t.mime, file.size, file.buffer, user.id]);
  return { value: rows[0].id };
}

const SELECT = `
  SELECT p.id, p.section, p.title, p.body, p.tags, p.file_id, p.branch_id, p.status, p.review_note, p.approved_at,
    p.meta_posted_at, p.created_at, p.updated_at, p.created_by,
    f.filename, f.mime, f.size, b.code AS branch_code, b.name AS branch_name,
    cu.display_name AS created_by_name, au.display_name AS approved_by_name,
    (SELECT count(*)::int FROM wiki_reads r WHERE r.page_id = p.id) AS reads
  FROM wiki_pages p LEFT JOIN wiki_files f ON f.id = p.file_id LEFT JOIN branches b ON b.id = p.branch_id
  LEFT JOIN users cu ON cu.id = p.created_by LEFT JOIN users au ON au.id = p.approved_by`;

const decorate = (p) => (p ? { ...p, kind: p.mime ? kindOf(p.mime) : null } : p);

async function getPage(db, id) {
  if (!/^\d{1,9}$/.test(String(id))) return null;
  return decorate((await db.query(`${SELECT} WHERE p.id = $1 AND p.active`, [id])).rows[0]);
}

// Published pages of a section (newest first), optionally matching a search.
async function listSection(db, section, { q = '' } = {}) {
  const like = q ? `%${q.replace(/[%_\\]/g, (c) => `\\${c}`)}%` : null;
  const rows = (await db.query(
    `${SELECT} WHERE p.active AND p.section = $1 AND p.status = 'published'
       AND ($2::text IS NULL OR p.title ILIKE $2 OR p.body ILIKE $2 OR p.tags ILIKE $2)
     ORDER BY ${section === 'poster' || section === 'classroom' ? 'COALESCE(p.approved_at, p.created_at) DESC' : 'p.title'}`,
    [section, like])).rows;
  return rows.map(decorate);
}

async function search(db, q) {
  const like = `%${q.replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
  return (await db.query(
    `${SELECT} WHERE p.active AND p.status = 'published' AND (p.title ILIKE $1 OR p.body ILIKE $1 OR p.tags ILIKE $1 OR f.filename ILIKE $1)
     ORDER BY p.updated_at DESC LIMIT 50`, [like])).rows.map(decorate);
}

// Home page numbers. HQ also sees who has opened the wiki and the poster count this week.
async function homeStats(db, { today }) {
  const counts = Object.fromEntries((await db.query(
    "SELECT section, count(*)::int AS n FROM wiki_pages WHERE active AND status = 'published' GROUP BY section")).rows.map((r) => [r.section, r.n]));
  const latest = (await db.query(`${SELECT} WHERE p.active AND p.status = 'published' ORDER BY COALESCE(p.approved_at, p.updated_at) DESC LIMIT 6`)).rows.map(decorate);
  const pending = (await db.query("SELECT count(*)::int AS n FROM wiki_pages WHERE active AND section = 'poster' AND status = 'pending'")).rows[0].n;
  const staff = (await db.query(
    `SELECT count(*)::int AS total, count(v.user_id)::int AS opened FROM users u LEFT JOIN wiki_visits v ON v.user_id = u.id
     WHERE u.active AND u.role <> 'admin'`)).rows[0];
  return { counts, latest, pending, staff, posters: await posterWeek(db, { today }) };
}

// Posters sent per branch this week (Mon–today), against the branch's target per day.
async function posterWeek(db, { today }) {
  const week = calc.weekStart(today);
  const days = calc.diffDays(week, today) + 1;
  const targets = await posterTargets(db);
  const rows = (await db.query(
    `SELECT b.code, b.name,
       count(p.id) FILTER (WHERE p.status <> 'needs_fix')::int AS sent,
       count(p.id) FILTER (WHERE p.status = 'published')::int AS approved
     FROM branches b LEFT JOIN wiki_pages p ON p.branch_id = b.id AND p.section = 'poster' AND p.active
       AND (p.created_at AT TIME ZONE 'Asia/Kuala_Lumpur')::date BETWEEN $1 AND $2
     WHERE b.active GROUP BY b.code, b.name, b.sort_order ORDER BY b.sort_order`, [week, today])).rows;
  return rows.map((r) => ({ ...r, target: targets[r.code] ? targets[r.code] * days : null }));
}

async function posterTargets(db) {
  const row = (await db.query("SELECT value FROM app_settings WHERE key = 'poster_targets'")).rows[0];
  if (row) { try { return JSON.parse(row.value); } catch { /* seed below */ } }
  return require('../db/seed').readSeed().company.poster_targets_per_day || {};
}

async function recordRead(db, user, page) {
  await db.query(
    `INSERT INTO wiki_visits (user_id) VALUES ($1) ON CONFLICT (user_id) DO UPDATE SET last_at = now()`, [user.id]);
  if (page) await db.query('INSERT INTO wiki_reads (page_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [page.id, user.id]);
}

// ─────────────── HQ: add / change pages ───────────────

function parsePage(body, { section, needFile = false, file = null, page = null }) {
  const errors = {};
  if (!SECTIONS[section]) errors.section = 'Pick a section.';
  const title = clean(body.title, { max: 160, label: 'Title', required: true });
  const text = clean(body.body, { max: 20000, label: 'Text' });
  const tags = clean(body.tags, { max: 200, label: 'Tags' });
  for (const [k, r] of Object.entries({ title, body: text, tags })) if (r.error) errors[k] = r.error;
  if (!errors.title && !text.value && !(file && file.size) && !(page && page.file_id) && needFile !== false) {
    errors.body = 'Add some text or a file.';
  }
  return { errors, values: { title: title.value, body: text.value, tags: tags.value } };
}

async function createPage(db, user, { section, body, file }) {
  const { errors, values } = parsePage(body, { section, file, needFile: true });
  if (Object.keys(errors).length) return { errors };
  return db.transaction(async (tx) => {
    const f = await saveFile(tx, user, file);
    if (f.error) return { errors: { file: f.error } };
    const { rows } = await tx.query(
      `INSERT INTO wiki_pages (section, title, body, tags, file_id, status, created_by, updated_by, approved_by, approved_at)
       VALUES ($1, $2, $3, $4, $5, 'published', $6, $6, $6, now()) RETURNING id`,
      [section, values.title, values.body, values.tags, f.value, user.id]);
    await audit(tx, user, 'insert', `${section} #${rows[0].id}`, { title: values.title, file: file ? file.originalname : null });
    return { id: rows[0].id };
  });
}

async function updatePage(db, user, page, { body, file }) {
  const section = SECTIONS[body.section] && page.section !== 'poster' ? body.section : page.section;
  const { errors, values } = parsePage(body, { section, file, page, needFile: true });
  if (Object.keys(errors).length) return { errors };
  return db.transaction(async (tx) => {
    const f = await saveFile(tx, user, file);
    if (f.error) return { errors: { file: f.error } };
    const removeFile = body.remove_file === '1' && !f.value;
    await tx.query(
      `UPDATE wiki_pages SET section = $2, title = $3, body = $4, tags = $5,
         file_id = CASE WHEN $6::int IS NOT NULL THEN $6 WHEN $7 THEN NULL ELSE file_id END, updated_by = $8, updated_at = now()
       WHERE id = $1`, [page.id, section, values.title, values.body, values.tags, f.value, removeFile, user.id]);
    await audit(tx, user, 'update', `${page.section} #${page.id}`, { title: values.title, file: file ? file.originalname : removeFile ? 'removed' : undefined });
    return { id: page.id };
  });
}

async function archivePage(db, user, page) {
  await db.transaction(async (tx) => {
    await tx.query('UPDATE wiki_pages SET active = false, updated_by = $2, updated_at = now() WHERE id = $1', [page.id, user.id]);
    await audit(tx, user, 'delete', `${page.section} #${page.id}`, { title: page.title });
  });
}

// ─────────────── Posters ───────────────

// A branch with a "poster" daily field (JH) gets it filled in automatically: posters sent that
// day (Malaysia date of sending), not counting ones sent back for a fix.
async function syncPosterCount(tx, user, branchId, createdAt) {
  if (!branchId) return;
  const field = (await tx.query("SELECT 1 FROM daily_fields WHERE branch_id = $1 AND key = 'poster' AND active", [branchId])).rows[0];
  if (!field) return;
  const day = calc.todayInMalaysia(new Date(createdAt));
  const n = (await tx.query(
    `SELECT count(*)::int AS n FROM wiki_pages WHERE section = 'poster' AND active AND branch_id = $1 AND status <> 'needs_fix'
       AND (created_at AT TIME ZONE 'Asia/Kuala_Lumpur')::date = $2`, [branchId, day])).rows[0].n;
  if (n) {
    await tx.query(
      `INSERT INTO daily_entries (branch_id, entry_date, field_key, value, entered_by, source, updated_at) VALUES ($1, $2, 'poster', $3, $4, 'app', now())
       ON CONFLICT (branch_id, entry_date, field_key) DO UPDATE SET value = EXCLUDED.value, entered_by = EXCLUDED.entered_by, updated_at = now()`,
      [branchId, day, n, user.id]);
  } else {
    await tx.query("DELETE FROM daily_entries WHERE branch_id = $1 AND entry_date = $2 AND field_key = 'poster'", [branchId, day]);
  }
}

async function sendPoster(db, user, { body, file, branchId }) {
  const errors = {};
  const title = clean(body.title, { max: 160, label: 'Topic', required: true });
  const caption = clean(body.body, { max: 2200, label: 'Caption' });
  const tags = clean(body.tags, { max: 200, label: 'Tags' });
  if (title.error) errors.title = title.error;
  if (caption.error) errors.body = caption.error;
  if (tags.error) errors.tags = tags.error;
  if (!file || !file.size) errors.file = 'Add the poster picture (JPG or PNG) or PDF.';
  if (Object.keys(errors).length) return { errors };
  return db.transaction(async (tx) => {
    const f = await saveFile(tx, user, file);
    if (f.error) return { errors: { file: f.error } };
    const kind = kindOf((await tx.query('SELECT mime FROM wiki_files WHERE id = $1', [f.value])).rows[0].mime);
    if (kind !== 'image' && kind !== 'pdf') return { errors: { file: 'A poster must be a picture (JPG, PNG, WEBP) or a PDF.' } };
    const { rows } = await tx.query(
      `INSERT INTO wiki_pages (section, title, body, tags, file_id, branch_id, status, created_by, updated_by)
       VALUES ('poster', $1, $2, $3, $4, $5, 'pending', $6, $6) RETURNING id`,
      [title.value, caption.value, tags.value, f.value, branchId, user.id]);
    await audit(tx, user, 'insert', `poster #${rows[0].id}`, { title: title.value });
    await syncPosterCount(tx, user, branchId, new Date());
    return { id: rows[0].id };
  });
}

// Resend a poster after "needs a fix": new picture and/or caption, back to pending.
async function resendPoster(db, user, page, { body, file }) {
  const title = clean(body.title, { max: 160, label: 'Topic', required: true });
  const caption = clean(body.body, { max: 2200, label: 'Caption' });
  if (title.error || caption.error) return { errors: { title: title.error, body: caption.error } };
  return db.transaction(async (tx) => {
    const f = await saveFile(tx, user, file);
    if (f.error) return { errors: { file: f.error } };
    await tx.query(
      `UPDATE wiki_pages SET title = $2, body = $3, file_id = COALESCE($4, file_id), status = 'pending', updated_by = $5, updated_at = now() WHERE id = $1`,
      [page.id, title.value, caption.value, f.value, user.id]);
    await audit(tx, user, 'update', `poster #${page.id} resent`, { title: title.value });
    await syncPosterCount(tx, user, page.branch_id, page.created_at);
    return { id: page.id };
  });
}

async function reviewPoster(db, user, page, { decision, note }) {
  const n = clean(note, { max: 500, label: 'Note' });
  if (n.error) return { error: n.error };
  if (decision === 'fix' && !n.value) return { error: 'Say what needs fixing.' };
  if (!['approve', 'fix'].includes(decision)) return { error: 'Approve it or ask for a fix.' };
  await db.transaction(async (tx) => {
    if (decision === 'approve') {
      await tx.query(
        "UPDATE wiki_pages SET status = 'published', review_note = $2, approved_by = $3, approved_at = now(), updated_by = $3, updated_at = now() WHERE id = $1",
        [page.id, n.value, user.id]);
    } else {
      await tx.query("UPDATE wiki_pages SET status = 'needs_fix', review_note = $2, updated_by = $3, updated_at = now() WHERE id = $1", [page.id, n.value, user.id]);
    }
    await audit(tx, user, 'update', `poster #${page.id} ${decision === 'approve' ? 'approved' : 'needs a fix'}`, { note: n.value });
    await syncPosterCount(tx, user, page.branch_id, page.created_at);
  });
  return { ok: true };
}

async function markMeta(db, user, page, posted) {
  await db.transaction(async (tx) => {
    await tx.query('UPDATE wiki_pages SET meta_posted_at = CASE WHEN $2 THEN now() END, updated_by = $3, updated_at = now() WHERE id = $1', [page.id, posted, user.id]);
    await audit(tx, user, 'update', `poster #${page.id} meta`, posted);
  });
}

async function posterQueues(db, user) {
  const pending = (await db.query(`${SELECT} WHERE p.active AND p.section = 'poster' AND p.status = 'pending' ORDER BY p.created_at`)).rows.map(decorate);
  const mine = user.branch_id
    ? (await db.query(`${SELECT} WHERE p.active AND p.section = 'poster' AND p.branch_id = $1 AND p.status <> 'published' ORDER BY p.updated_at DESC`, [user.branch_id])).rows.map(decorate)
    : [];
  const meta = (await db.query(`${SELECT} WHERE p.active AND p.section = 'poster' AND p.status = 'published' AND p.meta_posted_at IS NULL ORDER BY p.approved_at`)).rows.map(decorate);
  return { pending, mine, meta };
}

// ─────────────── Org chart (live, from the people list) ───────────────

async function orgChart(db) {
  const hq = (await db.query(
    `SELECT p.name, p.role, u.role AS login_role FROM people p LEFT JOIN users u ON u.person_id = p.id
     WHERE p.branch_id IS NULL AND p.active ORDER BY p.sort_order, p.name`)).rows;
  const branches = (await db.query('SELECT id, code, name FROM branches WHERE active ORDER BY sort_order')).rows;
  const people = (await db.query('SELECT branch_id, name, role FROM people WHERE branch_id IS NOT NULL AND active ORDER BY sort_order, name')).rows;
  return {
    hq,
    branches: branches.map((b) => {
      const mine = people.filter((p) => p.branch_id === b.id);
      return { ...b, managers: mine.filter((p) => /manager/i.test(p.role || '')), staff: mine.filter((p) => !/manager/i.test(p.role || '')) };
    }),
  };
}

async function getFile(db, id) {
  if (!/^\d{1,9}$/.test(String(id))) return null;
  const f = (await db.query(
    `SELECT f.* FROM wiki_files f WHERE f.id = $1 AND EXISTS (SELECT 1 FROM wiki_pages p WHERE p.file_id = f.id AND p.active)`, [id])).rows[0];
  return f || null;
}

module.exports = {
  SECTIONS, MAX_BYTES, sniff, kindOf, canEdit, canReview, canSendPoster,
  getPage, listSection, search, homeStats, posterWeek, posterTargets, recordRead,
  createPage, updatePage, archivePage, sendPoster, resendPoster, reviewPoster, markMeta, posterQueues, orgChart, getFile,
};
