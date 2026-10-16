// Sales progress chart: tap (or hover, or Tab to) a dot to see its number. Tap elsewhere to hide.
(function () {
  'use strict';
  document.querySelectorAll('.year-chart').forEach(function (fig) {
    var svg = fig.querySelector('svg');
    var tip = fig.querySelector('.yc-tip');
    if (!svg || !tip) return;
    var W = Number(fig.getAttribute('data-w')); var H = Number(fig.getAttribute('data-h'));
    var current = null;
    function show(g) {
      if (current) current.classList.remove('is-on');
      current = g; g.classList.add('is-on');
      tip.querySelector('i').style.background = g.getAttribute('data-color');
      tip.querySelector('b').textContent = g.getAttribute('data-tip');
      tip.querySelector('span').textContent = g.getAttribute('data-vs') || '';
      tip.hidden = false;
      var box = svg.getBoundingClientRect(); var fb = fig.getBoundingClientRect();
      var px = box.left - fb.left + fig.scrollLeft + (Number(g.getAttribute('data-x')) / W) * box.width;
      var py = box.top - fb.top + (Number(g.getAttribute('data-y')) / H) * box.height;
      var left = Math.max(4, Math.min(px - tip.offsetWidth / 2, fig.scrollWidth - tip.offsetWidth - 4));
      var top = py - tip.offsetHeight - 14;
      if (top < 4) top = py + 16;
      tip.style.left = left + 'px'; tip.style.top = top + 'px';
    }
    function hide() { if (current) current.classList.remove('is-on'); current = null; tip.hidden = true; }
    fig.addEventListener('click', function (e) {
      var g = e.target.closest('.yc-pt');
      // Always show on tap: a touch fires mouseover first, so toggling would hide it again at once.
      if (g) show(g); else hide();
    });
    fig.addEventListener('mouseover', function (e) { var g = e.target.closest('.yc-pt'); if (g) show(g); });
    fig.addEventListener('focusin', function (e) { var g = e.target.closest('.yc-pt'); if (g) show(g); });
    fig.addEventListener('keydown', function (e) {
      var g = e.target.closest('.yc-pt');
      if (g && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); show(g); }
      if (e.key === 'Escape') hide();
    });
  });
})();
