// Excel-style column filters (3 Nov, CEO: "filtering for each column like in Excel").
// Any <table data-xfilter> gets a ▾ button in each header cell: sort A→Z / Z→A, search the values,
// tick the ones to show (Select all), OK / Clear. Rows are hidden in the browser only – nothing is
// sent anywhere. Numbers sort as numbers. A "Clear all filters" link and "x of y rows" line show
// under the table while a filter is on. Without JavaScript the table is just a table.
(function () {
  var tables = document.querySelectorAll('table[data-xfilter]');
  if (!tables.length) return;
  var openMenu = null;

  function cellText(row, i) {
    var c = row.cells[i];
    return c ? c.textContent.replace(/\s+/g, ' ').trim() : '';
  }
  function asNumber(s) {
    var t = String(s).replace(/[RM,\s]/g, '');
    return t !== '' && !isNaN(Number(t)) ? Number(t) : null;
  }
  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }
  function closeMenu() {
    if (openMenu) { openMenu.remove(); openMenu = null; }
    document.querySelectorAll('.xf-btn[aria-expanded="true"]').forEach(function (b) { b.setAttribute('aria-expanded', 'false'); });
  }
  document.addEventListener('click', function (ev) { if (openMenu && !openMenu.contains(ev.target) && !ev.target.closest('.xf-btn')) closeMenu(); });
  document.addEventListener('keydown', function (ev) { if (ev.key === 'Escape') closeMenu(); });

  Array.prototype.forEach.call(tables, function (table) {
    var tbody = table.tBodies[0];
    if (!tbody) return;
    var heads = table.tHead ? Array.prototype.slice.call(table.tHead.rows[0].cells) : [];
    var rows = Array.prototype.slice.call(tbody.rows);
    var filters = {}; // column index → Set of allowed values
    var status = el('p', 'xf-status muted small');
    status.hidden = true;
    var scroller = table.closest('.mo-scroll') || table;
    scroller.parentNode.insertBefore(status, scroller.nextSibling);

    function apply() {
      var shown = 0;
      rows.forEach(function (r) {
        var ok = Object.keys(filters).every(function (i) { return filters[i].has(cellText(r, Number(i))); });
        r.hidden = !ok;
        if (ok) shown++;
      });
      heads.forEach(function (h, i) { h.classList.toggle('xf-on', Boolean(filters[i])); var b = h.querySelector('.xf-btn'); if (b) b.textContent = filters[i] ? '▼' : '▾'; });
      var n = Object.keys(filters).length;
      status.hidden = !n;
      status.replaceChildren();
      if (n) {
        status.append(el('span', '', shown + ' of ' + rows.length + ' rows · filtered by ' + n + ' column' + (n === 1 ? '' : 's') + ' '));
        var clear = el('button', 'link-button xf-clear', 'Clear all filters');
        clear.type = 'button';
        clear.addEventListener('click', function () { filters = {}; apply(); });
        status.append(clear);
      }
    }

    function sortBy(i, dir) {
      var vals = rows.map(function (r) { return cellText(r, i); });
      var numeric = vals.filter(function (v) { return v !== ''; }).every(function (v) { return asNumber(v) !== null; });
      rows.sort(function (a, b) {
        var x = cellText(a, i); var y = cellText(b, i);
        if (x === '' && y !== '') return 1;
        if (y === '' && x !== '') return -1;
        var c = numeric ? asNumber(x) - asNumber(y) : x.localeCompare(y, 'en', { numeric: true, sensitivity: 'base' });
        return c * dir;
      });
      rows.forEach(function (r) { tbody.appendChild(r); });
    }

    heads.forEach(function (h, i) {
      if (h.hasAttribute('data-xfilter-off')) return;
      var btn = el('button', 'xf-btn', '▾');
      btn.type = 'button';
      btn.setAttribute('aria-haspopup', 'true');
      btn.setAttribute('aria-expanded', 'false');
      btn.setAttribute('aria-label', 'Filter ' + h.textContent.trim());
      h.appendChild(btn);
      btn.addEventListener('click', function (ev) {
        ev.stopPropagation();
        var wasMine = openMenu && openMenu.dataset.col === table.dataset.xfilterId + ':' + i;
        closeMenu();
        if (wasMine) return;
        btn.setAttribute('aria-expanded', 'true');
        var menu = el('div', 'xf-menu');
        menu.dataset.col = table.dataset.xfilterId + ':' + i;
        menu.setAttribute('role', 'dialog');
        menu.setAttribute('aria-label', 'Filter ' + h.textContent.replace('▾', '').replace('▼', '').trim());

        var s1 = el('button', 'xf-item', 'Sort A → Z (smallest first)'); s1.type = 'button';
        var s2 = el('button', 'xf-item', 'Sort Z → A (largest first)'); s2.type = 'button';
        s1.addEventListener('click', function () { sortBy(i, 1); closeMenu(); });
        s2.addEventListener('click', function () { sortBy(i, -1); closeMenu(); });
        menu.append(s1, s2, el('hr'));

        var search = el('input', 'xf-search');
        search.type = 'search';
        search.placeholder = 'Search';
        menu.append(search);

        // Values from rows that pass the OTHER columns' filters (like Excel).
        var counts = new Map();
        rows.forEach(function (r) {
          var ok = Object.keys(filters).every(function (j) { return Number(j) === i || filters[j].has(cellText(r, Number(j))); });
          if (!ok) return;
          var v = cellText(r, i);
          counts.set(v, (counts.get(v) || 0) + 1);
        });
        var values = Array.from(counts.keys()).sort(function (a, b) {
          if (a === '') return 1; if (b === '') return -1;
          var x = asNumber(a); var y = asNumber(b);
          return x !== null && y !== null ? x - y : a.localeCompare(b, 'en', { numeric: true, sensitivity: 'base' });
        });
        var chosen = new Set(filters[i] ? values.filter(function (v) { return filters[i].has(v); }) : values);

        var list = el('div', 'xf-list');
        var allLab = el('label', 'xf-opt xf-all');
        var all = el('input'); all.type = 'checkbox';
        allLab.append(all, el('span', '', '(Select all)'));
        list.append(allLab);
        var boxes = values.map(function (v) {
          var lab = el('label', 'xf-opt');
          var cb = el('input'); cb.type = 'checkbox'; cb.checked = chosen.has(v);
          lab.append(cb, el('span', '', v === '' ? '(Blanks)' : v), el('small', 'muted', ' ' + counts.get(v)));
          cb.addEventListener('change', function () { if (cb.checked) chosen.add(v); else chosen.delete(v); syncAll(); });
          list.append(lab);
          return { v: v, cb: cb, lab: lab };
        });
        function visible() { return boxes.filter(function (b) { return !b.lab.hidden; }); }
        function syncAll() {
          var vis = visible();
          all.checked = vis.length > 0 && vis.every(function (b) { return b.cb.checked; });
          all.indeterminate = !all.checked && vis.some(function (b) { return b.cb.checked; });
        }
        all.addEventListener('change', function () {
          visible().forEach(function (b) { b.cb.checked = all.checked; if (all.checked) chosen.add(b.v); else chosen.delete(b.v); });
          syncAll();
        });
        search.addEventListener('input', function () {
          var q = search.value.trim().toLowerCase();
          boxes.forEach(function (b) { b.lab.hidden = Boolean(q) && b.v.toLowerCase().indexOf(q) < 0; });
          // Like Excel: typing a search ticks only what matches.
          if (q) { boxes.forEach(function (b) { b.cb.checked = !b.lab.hidden; if (b.cb.checked) chosen.add(b.v); else chosen.delete(b.v); }); }
          syncAll();
        });
        syncAll();
        menu.append(list);

        var actions = el('div', 'xf-actions');
        var clear = el('button', 'button secondary small', 'Clear'); clear.type = 'button';
        var okb = el('button', 'button small', 'OK'); okb.type = 'button';
        clear.addEventListener('click', function () { delete filters[i]; apply(); closeMenu(); });
        okb.addEventListener('click', function () {
          if (chosen.size === values.length) delete filters[i];
          else filters[i] = new Set(chosen);
          apply(); closeMenu();
        });
        actions.append(clear, okb);
        menu.append(actions);

        document.body.appendChild(menu);
        var r = btn.getBoundingClientRect();
        var w = Math.min(300, window.innerWidth - 16);
        menu.style.width = w + 'px';
        menu.style.left = Math.max(8, Math.min(r.left + window.scrollX, window.scrollX + window.innerWidth - w - 8)) + 'px';
        menu.style.top = (r.bottom + window.scrollY + 4) + 'px';
        openMenu = menu;
        search.focus();
      });
    });
  });
  Array.prototype.forEach.call(tables, function (t, n) { t.dataset.xfilterId = String(n); });
})();
