// Wiki + Classroom pages. Reading: everyone logged in. Adding/changing: HQ and admin.
// Posters: branch staff and managers send; HQ approves. Files are served only to logged-in users.

const express = require('express');
const multer = require('multer');
const calc = require('../calc');
const wiki = require('./data');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: wiki.MAX_BYTES, files: 1, fields: 20, fieldSize: 64 * 1024 } });

function wikiRoutes(db, { now }) {
  const router = express.Router();
  const forbid = (res, message) => res.status(403).render('message', { title: 'Wiki', message });
  const notFound = (res) => res.status(404).render('message', { title: 'Not found', message: 'That page isn’t in the wiki (it may have been removed).' });

  // multipart forms: parse the upload, then check the form's _csrf (the app-wide check skips them).
  const withFile = (req, res, next) => upload.single('file')(req, res, (err) => {
    if (err) {
      const msg = err.code === 'LIMIT_FILE_SIZE' ? 'That file is bigger than 15 MB. Make it smaller (e.g. save the slides as PDF) and try again.' : 'The upload didn’t work. Try again.';
      return res.status(400).render('message', { title: 'Upload', message: msg });
    }
    if (!req.body || req.body._csrf !== req.csrfToken) {
      return res.status(403).render('message', { title: 'Page expired', message: 'This page was open too long or came from somewhere else. Go back, reload and try again.' });
    }
    next();
  });
  const today = () => calc.todayInMalaysia(now());

  router.get('/wiki', async (req, res, next) => {
    try {
      await wiki.recordRead(db, req.user, null);
      const q = String(req.query.q || '').trim().slice(0, 80);
      const stats = await wiki.homeStats(db, { today: today() });
      const results = q ? await wiki.search(db, q) : null;
      res.render('wiki-home', { title: 'Wiki & Classroom', SECTIONS: wiki.SECTIONS, stats, q, results, canEdit: wiki.canEdit(req.user), canReview: wiki.canReview(req.user), canSend: wiki.canSendPoster(req.user), ok: req.query.ok || null });
    } catch (err) { next(err); }
  });

  router.get('/wiki/org', async (req, res, next) => {
    try {
      await wiki.recordRead(db, req.user, null);
      res.render('wiki-org', { title: 'Org chart', org: await wiki.orgChart(db) });
    } catch (err) { next(err); }
  });

  router.get('/wiki/s/:section', async (req, res, next) => {
    try {
      const section = req.params.section;
      if (!wiki.SECTIONS[section]) return notFound(res);
      await wiki.recordRead(db, req.user, null);
      const q = String(req.query.q || '').trim().slice(0, 80);
      const pages = await wiki.listSection(db, section, { q });
      const queues = section === 'poster' ? await wiki.posterQueues(db, req.user) : null;
      const week = section === 'poster' ? await wiki.posterWeek(db, { today: today() }) : null;
      res.render('wiki-section', {
        title: wiki.SECTIONS[section].name, section, S: wiki.SECTIONS[section], pages, q, queues, week,
        canEdit: wiki.canEdit(req.user), canReview: wiki.canReview(req.user), canSend: wiki.canSendPoster(req.user) && Boolean(req.user.branch_id || wiki.canEdit(req.user)),
        ok: req.query.ok || null, err: req.query.err || null,
      });
    } catch (err) { next(err); }
  });

  router.get('/wiki/p/:id', async (req, res, next) => {
    try {
      const page = await wiki.getPage(db, req.params.id);
      if (!page) return notFound(res);
      const own = page.branch_id && req.user.branch_id === page.branch_id;
      if (page.status !== 'published' && !wiki.canReview(req.user) && !own) return notFound(res);
      await wiki.recordRead(db, req.user, page.status === 'published' ? page : null);
      page.reads = (await db.query('SELECT count(*)::int AS n FROM wiki_reads WHERE page_id = $1', [page.id])).rows[0].n;
      const staff = wiki.canEdit(req.user) ? (await db.query("SELECT count(*)::int AS n FROM users WHERE active AND role <> 'admin'")).rows[0].n : null;
      res.render('wiki-page', {
        title: page.title, page, S: wiki.SECTIONS[page.section], staff,
        canEdit: wiki.canEdit(req.user) && page.section !== 'poster', canReview: wiki.canReview(req.user), own,
        ok: req.query.ok || null, err: req.query.err || null,
      });
    } catch (err) { next(err); }
  });

  // ─── HQ: add / change ───
  const editForm = (res, extra) => res.status(extra.status || 200).render('wiki-edit', { title: extra.page ? 'Change page' : 'Add to the wiki', SECTIONS: wiki.SECTIONS, errors: {}, typed: {}, page: null, ...extra });

  router.get('/wiki/new', (req, res) => {
    if (!wiki.canEdit(req.user)) return forbid(res, 'Only HQ and admin add pages. Branches can send posters.');
    editForm(res, { section: wiki.SECTIONS[req.query.section] && req.query.section !== 'poster' ? req.query.section : 'classroom' });
  });

  router.post('/wiki/new', withFile, async (req, res, next) => {
    try {
      if (!wiki.canEdit(req.user)) return forbid(res, 'Only HQ and admin add pages.');
      const section = wiki.SECTIONS[req.body.section] && req.body.section !== 'poster' ? req.body.section : null;
      const r = await wiki.createPage(db, req.user, { section, body: req.body, file: req.file });
      if (r.errors) return editForm(res, { status: 400, section: section || 'classroom', errors: r.errors, typed: req.body });
      res.redirect(`/wiki/p/${r.id}?ok=${encodeURIComponent('Added to the wiki.')}`);
    } catch (err) { next(err); }
  });

  router.get('/wiki/p/:id/edit', async (req, res, next) => {
    try {
      if (!wiki.canEdit(req.user)) return forbid(res, 'Only HQ and admin change pages.');
      const page = await wiki.getPage(db, req.params.id);
      if (!page || page.section === 'poster') return notFound(res);
      editForm(res, { page, section: page.section, typed: page });
    } catch (err) { next(err); }
  });

  router.post('/wiki/p/:id/edit', withFile, async (req, res, next) => {
    try {
      if (!wiki.canEdit(req.user)) return forbid(res, 'Only HQ and admin change pages.');
      const page = await wiki.getPage(db, req.params.id);
      if (!page || page.section === 'poster') return notFound(res);
      const r = await wiki.updatePage(db, req.user, page, { body: req.body, file: req.file });
      if (r.errors) return editForm(res, { status: 400, page, section: page.section, errors: r.errors, typed: req.body });
      res.redirect(`/wiki/p/${page.id}?ok=${encodeURIComponent('Saved.')}`);
    } catch (err) { next(err); }
  });

  router.post('/wiki/p/:id/remove', async (req, res, next) => {
    try {
      const page = await wiki.getPage(db, req.params.id);
      if (!page) return notFound(res);
      if (!wiki.canEdit(req.user)) return forbid(res, 'Only HQ and admin remove pages.');
      await wiki.archivePage(db, req.user, page);
      res.redirect(`/wiki/s/${page.section}?ok=${encodeURIComponent(`Removed “${page.title}”.`)}`);
    } catch (err) { next(err); }
  });

  // ─── Posters ───
  router.get('/wiki/poster/new', (req, res) => {
    if (!wiki.canSendPoster(req.user)) return forbid(res, 'Posters are sent by branch staff.');
    res.render('wiki-poster-new', { title: 'Send a poster', errors: {}, typed: {}, page: null });
  });

  router.post('/wiki/poster', withFile, async (req, res, next) => {
    try {
      if (!wiki.canSendPoster(req.user)) return forbid(res, 'Posters are sent by branch staff.');
      const r = await wiki.sendPoster(db, req.user, { body: req.body, file: req.file, branchId: req.user.branch_id || null });
      if (r.errors) return res.status(400).render('wiki-poster-new', { title: 'Send a poster', errors: r.errors, typed: req.body, page: null });
      res.redirect(`/wiki/s/poster?ok=${encodeURIComponent('Poster sent to Hanin for approval. Thank you!')}`);
    } catch (err) { next(err); }
  });

  router.post('/wiki/p/:id/resend', withFile, async (req, res, next) => {
    try {
      const page = await wiki.getPage(db, req.params.id);
      if (!page || page.section !== 'poster') return notFound(res);
      if (!(page.branch_id && req.user.branch_id === page.branch_id) && !wiki.canReview(req.user)) return forbid(res, 'Only the branch that made it can resend it.');
      const r = await wiki.resendPoster(db, req.user, page, { body: req.body, file: req.file });
      if (r.errors) return res.redirect(`/wiki/p/${page.id}?err=${encodeURIComponent(Object.values(r.errors).filter(Boolean)[0])}`);
      res.redirect(`/wiki/s/poster?ok=${encodeURIComponent('Sent again for approval.')}`);
    } catch (err) { next(err); }
  });

  router.post('/wiki/p/:id/review', async (req, res, next) => {
    try {
      if (!wiki.canReview(req.user)) return forbid(res, 'Posters are approved by HQ.');
      const page = await wiki.getPage(db, req.params.id);
      if (!page || page.section !== 'poster') return notFound(res);
      const r = await wiki.reviewPoster(db, req.user, page, { decision: req.body.decision, note: req.body.note });
      if (r.error) return res.redirect(`/wiki/p/${page.id}?err=${encodeURIComponent(r.error)}`);
      res.redirect(`/wiki/s/poster?ok=${encodeURIComponent(req.body.decision === 'approve' ? `Approved: ${page.title}` : `Sent back to ${page.branch_code || 'the branch'} with your note.`)}#review`);
    } catch (err) { next(err); }
  });

  router.post('/wiki/p/:id/meta', async (req, res, next) => {
    try {
      if (!wiki.canReview(req.user)) return forbid(res, 'HQ marks posters as posted.');
      const page = await wiki.getPage(db, req.params.id);
      if (!page || page.section !== 'poster' || page.status !== 'published') return notFound(res);
      await wiki.markMeta(db, req.user, page, req.body.posted !== '0');
      res.redirect(`/wiki/s/poster?ok=${encodeURIComponent(req.body.posted !== '0' ? `Marked as posted on Facebook/Instagram: ${page.title}` : 'Unmarked.')}#meta`);
    } catch (err) { next(err); }
  });

  // ─── Files ───
  router.get('/wiki/f/:id', async (req, res, next) => {
    try {
      const f = await wiki.getFile(db, req.params.id);
      if (!f) return notFound(res);
      const inline = f.mime.startsWith('image/') || f.mime === 'application/pdf' || f.mime.startsWith('video/');
      const safeName = f.filename.replace(/[^\w.\- ]+/g, '_');
      res.setHeader('Content-Type', f.mime);
      res.setHeader('Content-Length', f.size);
      res.setHeader('Content-Disposition', `${inline && req.query.download === undefined ? 'inline' : 'attachment'}; filename="${safeName}"`);
      res.setHeader('Cache-Control', 'private, max-age=3600');
      res.setHeader('Content-Security-Policy', "default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'; sandbox");
      res.end(Buffer.isBuffer(f.data) ? f.data : Buffer.from(f.data));
    } catch (err) { next(err); }
  });

  return router;
}

module.exports = { wikiRoutes };
