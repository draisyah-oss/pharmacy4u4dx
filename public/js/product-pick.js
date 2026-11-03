// 3 Nov: pick the out-of-stock item from the Dynamod product list. Any <input data-product-search>
// gets a dropdown of matches as you type (description, generic, brand, stock ID or barcode);
// tapping one fills the box with the Dynamod description and the hidden product_id.
(function () {
  document.querySelectorAll('input[data-product-search]').forEach(function (input) {
    var form = input.form;
    var hidden = form.querySelector('input[name="product_id"]');
    var info = form.querySelector('[data-product-info]');
    var list = document.createElement('ul');
    list.className = 'pp-list'; list.setAttribute('role', 'listbox'); list.hidden = true;
    input.parentNode.insertBefore(list, input.nextSibling);
    input.setAttribute('role', 'combobox'); input.setAttribute('aria-autocomplete', 'list'); input.setAttribute('autocomplete', 'off');
    var timer = null; var last = ''; var items = []; var active = -1;
    function show(info, p) { if (info) info.textContent = p ? 'Dynamod: ' + p.stock_id + ' · ' + (p.uom || '') + ' · barcode ' + p.barcode : ''; }
    function choose(p) {
      input.value = p.description; hidden.value = p.id; list.hidden = true; show(info, p);
      input.classList.add('pp-ok');
    }
    function render() {
      list.innerHTML = '';
      if (!items.length) {
        var li = document.createElement('li'); li.className = 'pp-none';
        li.innerHTML = 'Not in the Dynamod list. <a href="/oos/new-items">Request a new item ›</a>';
        list.appendChild(li); list.hidden = false; return;
      }
      items.forEach(function (p, i) {
        var li = document.createElement('li'); li.setAttribute('role', 'option'); li.className = i === active ? 'is-active' : '';
        li.innerHTML = '<b></b><small></small>';
        li.firstChild.textContent = p.description;
        li.lastChild.textContent = [p.generic, p.uom, p.stock_id].filter(Boolean).join(' · ');
        li.addEventListener('mousedown', function (e) { e.preventDefault(); choose(p); });
        list.appendChild(li);
      });
      list.hidden = false;
    }
    input.addEventListener('input', function () {
      hidden.value = ''; show(info, null); input.classList.remove('pp-ok');
      var q = input.value.trim(); if (q === last) return; last = q;
      clearTimeout(timer);
      if (q.length < 2) { list.hidden = true; return; }
      timer = setTimeout(function () {
        fetch('/oos/products/search?q=' + encodeURIComponent(q), { headers: { Accept: 'application/json' } })
          .then(function (r) { return r.json(); }).then(function (d) { if (input.value.trim() !== q) return; items = d.items || []; active = -1; render(); })
          .catch(function () { list.hidden = true; });
      }, 200);
    });
    input.addEventListener('keydown', function (e) {
      if (list.hidden || !items.length) return;
      if (e.key === 'ArrowDown') { active = Math.min(items.length - 1, active + 1); render(); e.preventDefault(); }
      else if (e.key === 'ArrowUp') { active = Math.max(0, active - 1); render(); e.preventDefault(); }
      else if (e.key === 'Enter' && active >= 0) { choose(items[active]); e.preventDefault(); }
      else if (e.key === 'Escape') { list.hidden = true; }
    });
    input.addEventListener('blur', function () { setTimeout(function () { list.hidden = true; }, 150); });
    form.addEventListener('submit', function (e) {
      if (input.dataset.required === '1' && !hidden.value) {
        e.preventDefault(); input.focus(); input.setAttribute('aria-invalid', 'true');
        if (info) info.textContent = 'Pick the item from the list (tap a match). Not there? Use New item request.';
      }
    });
  });
  // Upload page: the chosen .xlsx goes in as a data URL (the form posts it with the CSRF token).
  var up = document.querySelector('input[data-xlsx-upload]');
  if (up) up.addEventListener('change', function () {
    var f = up.files[0]; if (!f) return;
    var r = new FileReader();
    r.onload = function () { up.form.querySelector('input[name="file"]').value = r.result; up.form.querySelector('input[name="name"]').value = f.name; };
    r.readAsDataURL(f);
  });
})();
