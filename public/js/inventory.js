// Inventory page (3 Nov): fold / unfold sections. The folding itself is plain <details> (works
// without JavaScript); this only remembers what each person folded on this device, opens the
// section a link points at (#today from the filter pills), and drives "Fold all / Open all".
(function () {
  var KEY = 'p4u-inventory-folded';
  var secs = Array.prototype.slice.call(document.querySelectorAll('details.inv-sec[id]'));
  if (!secs.length) return;
  function read() { try { return JSON.parse(localStorage.getItem(KEY) || '[]') || []; } catch (e) { return []; } }
  function save() {
    var closed = secs.filter(function (d) { return !d.open; }).map(function (d) { return d.id; });
    try { localStorage.setItem(KEY, JSON.stringify(closed)); } catch (e) { /* private window – fine */ }
  }
  var folded = read();
  var hash = (location.hash || '').slice(1);
  var hashEl = hash && document.getElementById(hash);
  var hashSec = hashEl && (hashEl.matches('details.inv-sec') ? hashEl : hashEl.closest('details.inv-sec'));
  secs.forEach(function (d) {
    if (folded.indexOf(d.id) >= 0 && d !== hashSec) d.open = false;
    d.addEventListener('toggle', save);
  });
  // A filter pill or tile link (#today, #approvals) always shows its section.
  function openTarget() {
    var id = (location.hash || '').slice(1);
    var t = id && document.getElementById(id);
    // The section itself (#today) or something inside it (#l12 after ticking a line, #p3 after a payment).
    var d = t && (t.matches('details.inv-sec') ? t : t.closest('details.inv-sec'));
    if (d && !d.open) { d.open = true; save(); if (t !== d) t.scrollIntoView(); }
  }
  window.addEventListener('hashchange', openTarget);
  openTarget();
  var bar = document.querySelector('[data-fold-bar]');
  if (bar) {
    bar.hidden = false;
    bar.addEventListener('click', function (ev) {
      var b = ev.target.closest('[data-fold]');
      if (!b) return;
      var open = b.getAttribute('data-fold') === 'open';
      secs.forEach(function (d) { d.open = open; });
      save();
    });
  }
})();
