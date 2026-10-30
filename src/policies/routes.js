// 30 Oct: /policies – company policies, read-only, for everyone who is logged in (branch staff too).
const path = require('path');
const express = require('express');
const { POLICIES, FILES_DIR, find } = require('./index');

// "**bold**" → <b>bold</b>, everything else escaped.
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const rich = (s) => esc(s).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');

function policyRoutes() {
  const router = express.Router();

  router.get('/policies', (req, res) => {
    res.render('policies', { title: 'Company policies', policies: POLICIES });
  });

  router.get('/policies/:slug', (req, res) => {
    const p = find(req.params.slug);
    if (!p) return res.status(404).render('message', { title: 'Not found', message: 'That policy isn’t in the app.' });
    res.render('policy', { title: p.title, p, rich });
  });

  // The approved PDF – behind the login, not in /public.
  router.get('/policies/:slug/pdf', (req, res) => {
    const p = find(req.params.slug);
    if (!p || !p.file) return res.status(404).render('message', { title: 'Not found', message: 'That policy has no PDF.' });
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.download(path.join(FILES_DIR, p.file), `${p.docNo}.pdf`, { dotfiles: 'deny' });
  });

  return router;
}

module.exports = { policyRoutes };
