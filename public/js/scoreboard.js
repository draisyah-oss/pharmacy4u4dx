// Scoreboard: tap any number to open the daily entries behind it, right under that row.
// Without JavaScript the same links open a full page.
(function () {
  'use strict';
  var openSlot = null;
  var openHref = null;

  function close() {
    if (!openSlot) return;
    openSlot.hidden = true;
    openSlot.innerHTML = '';
    var owner = openSlot.parentElement;
    if (owner) owner.classList.remove('is-open');
    openSlot = null;
    openHref = null;
  }

  document.addEventListener('click', function (e) {
    if (e.target.closest('[data-trace-close]')) { e.preventDefault(); var row = openSlot && openSlot.parentElement; close(); if (row) row.querySelector('[data-trace]').focus(); return; }
    var link = e.target.closest('a[data-trace]');
    if (!link || e.metaKey || e.ctrlKey || e.shiftKey) return;
    var owner = link.closest('[data-row], .sales');
    var slot = owner && owner.querySelector('.trace-slot');
    if (!slot) return;
    e.preventDefault();

    var href = link.getAttribute('href');
    if (openSlot === slot && openHref === href) { close(); return; }
    close();
    openSlot = slot;
    openHref = href;
    owner.classList.add('is-open');
    slot.hidden = false;
    slot.innerHTML = '<p class="trace-loading">Loading the daily entries…</p>';

    fetch(href + '&partial=1', { credentials: 'same-origin', headers: { 'X-Requested-With': 'fetch' } })
      .then(function (r) { if (!r.ok) throw new Error(r.status); return r.text(); })
      .then(function (html) {
        if (openSlot !== slot) return;
        slot.innerHTML = html;
        var title = slot.querySelector('.trace-title');
        if (title) { title.setAttribute('tabindex', '-1'); title.focus({ preventScroll: true }); }
        slot.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      })
      .catch(function () {
        slot.innerHTML = '<p class="trace-loading">Couldn’t load the entries. <a href="' + href + '">Open them on their own page</a>.</p>';
      });
  });

  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') close(); });
})();
