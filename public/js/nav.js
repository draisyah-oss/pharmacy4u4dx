// Side menu: search box, « to hide it on wide screens (remembered on this device),
// Escape closes it on phones. Without JavaScript the menu still opens and closes.
(function () {
  'use strict';
  var root = document.documentElement;
  var check = document.getElementById('nav-open');
  var side = document.getElementById('sidenav');
  if (!check || !side) return;
  root.classList.add('js');
  var KEY = 'p4u-nav-collapsed';
  var wide = window.matchMedia('(min-width: 960px)');
  function get() { try { return localStorage.getItem(KEY) === '1'; } catch (e) { return false; } }
  function set(v) { try { localStorage.setItem(KEY, v ? '1' : '0'); } catch (e) { /* private mode */ } }
  if (get()) root.classList.add('nav-collapsed');

  side.querySelector('[data-nav-collapse]').addEventListener('click', function () {
    root.classList.add('nav-collapsed'); set(true); check.checked = false;
  });
  // On a wide screen the Menu button brings the menu back for good.
  check.addEventListener('change', function () {
    if (check.checked && wide.matches && root.classList.contains('nav-collapsed')) {
      root.classList.remove('nav-collapsed'); set(false); check.checked = false;
    }
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && check.checked) { check.checked = false; }
    var btn = e.target.closest && e.target.closest('.menu-btn, .tabbar label[for="nav-open"]');
    if (btn && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); check.checked = !check.checked; check.dispatchEvent(new Event('change')); }
  });

  // 9 Nov: groups stay folded except the current page's; each person's own opens / folds are remembered.
  var GKEY = 'p4u-nav-groups';
  var saved = {};
  try { saved = JSON.parse(localStorage.getItem(GKEY) || '{}') || {}; } catch (e) { saved = {}; }
  var searching = false;
  side.querySelectorAll('.sn-group[data-group]').forEach(function (g) {
    var name = g.getAttribute('data-group');
    if (!g.hasAttribute('data-current') && Object.prototype.hasOwnProperty.call(saved, name)) g.open = !!saved[name];
    g.addEventListener('toggle', function () {
      if (searching) return;
      saved[name] = g.open;
      try { localStorage.setItem(GKEY, JSON.stringify(saved)); } catch (e) { /* private mode */ }
    });
  });

  // Search: filter the links by name or keyword.
  var search = side.querySelector('[data-nav-search]');
  var none = side.querySelector('.sn-none');
  search.hidden = false;
  search.addEventListener('input', function () {
    searching = true; setTimeout(function () { searching = false; }, 0);
    var q = search.value.trim().toLowerCase();
    var any = false;
    side.querySelectorAll('.sn-group').forEach(function (g) {
      var shown = 0;
      g.querySelectorAll('.sn-link').forEach(function (a) {
        var hit = !q || a.getAttribute('data-words').indexOf(q) !== -1;
        a.hidden = !hit; if (hit) shown++;
      });
      g.hidden = shown === 0;
      if (q && shown) g.open = true;
      if (shown) any = true;
    });
    none.hidden = any;
  });
  search.addEventListener('keydown', function (e) {
    if (e.key !== 'Enter') return;
    var first = side.querySelector('.sn-link:not([hidden])');
    if (first) { e.preventDefault(); window.location.href = first.href; }
  });
})();
