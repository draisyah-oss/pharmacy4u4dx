// 6 Nov: invoice scan. Each photo is shrunk on the phone (max 1600 px, JPEG) and added as a page
// (hidden "page" box + thumbnail); pages can be removed. While typing the supplier and invoice no., the
// app warns when that invoice is already saved.
(function () {
  var form = document.querySelector('[data-invoice-form]');
  if (!form) return;
  var MAX = 1600; var MAX_PAGES = 10;
  var box = form.querySelector('[data-pages]');
  var file = form.querySelector('[data-page-file]');
  var msg = form.querySelector('[data-page-msg]');

  function renumber() {
    var figs = box.querySelectorAll('figure');
    for (var i = 0; i < figs.length; i++) {
      figs[i].querySelector('img').alt = 'Page ' + (i + 1);
      figs[i].querySelector('figcaption').firstChild.nodeValue = 'Page ' + (i + 1) + ' ';
    }
    msg.textContent = figs.length ? figs.length + (figs.length === 1 ? ' page' : ' pages') + ' ready.' : '';
  }
  function addPage(data) {
    var fig = document.createElement('figure'); fig.className = 'in-thumb';
    var img = document.createElement('img'); img.src = data;
    var hid = document.createElement('input'); hid.type = 'hidden'; hid.name = 'page'; hid.value = data;
    var cap = document.createElement('figcaption'); cap.appendChild(document.createTextNode('Page '));
    var rm = document.createElement('button'); rm.type = 'button'; rm.className = 'link-button'; rm.textContent = 'Remove'; rm.setAttribute('data-remove', '');
    cap.appendChild(rm); fig.appendChild(img); fig.appendChild(hid); fig.appendChild(cap); box.appendChild(fig);
    renumber();
  }
  box.addEventListener('click', function (e) {
    if (e.target && e.target.hasAttribute('data-remove')) { e.target.closest('figure').remove(); renumber(); }
  });
  function shrink(f, done) {
    var reader = new FileReader(); var img = new Image();
    img.onload = function () {
      var scale = Math.min(1, MAX / Math.max(img.width, img.height));
      var c = document.createElement('canvas');
      c.width = Math.round(img.width * scale); c.height = Math.round(img.height * scale);
      var g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height); g.drawImage(img, 0, 0, c.width, c.height);
      var data = c.toDataURL('image/jpeg', 0.75);
      if (data.length > 2400000) data = c.toDataURL('image/jpeg', 0.55);
      done(data);
    };
    img.onerror = function () { done(null); };
    reader.onload = function () { img.src = reader.result; };
    reader.onerror = function () { done(null); };
    reader.readAsDataURL(f);
  }
  file.addEventListener('change', function () {
    var list = Array.prototype.slice.call(file.files || []);
    file.value = '';
    (function next() {
      var f = list.shift();
      if (!f) return renumber();
      if (box.querySelectorAll('figure').length >= MAX_PAGES) { msg.textContent = MAX_PAGES + ' pages at most.'; return; }
      msg.textContent = 'Preparing page…';
      shrink(f, function (data) { if (data) addPage(data); else msg.textContent = 'That file couldn’t be opened as a photo.'; next(); });
    })();
  });
  form.addEventListener('submit', function (e) {
    if (!box.querySelector('figure')) { e.preventDefault(); msg.textContent = 'Add a photo of the invoice first.'; file.focus(); }
  });

  // Already saved? (supplier + invoice no.)
  var sup = form.querySelector('input[name="supplier"]');
  var no = form.querySelector('input[name="invoice_no"]');
  var warn = form.querySelector('[data-dup-msg]');
  var timer = null;
  function check() {
    if (!sup.value.trim() || !no.value.trim()) { warn.hidden = true; return; }
    fetch('/invoices/check?supplier=' + encodeURIComponent(sup.value) + '&invoice_no=' + encodeURIComponent(no.value), { headers: { Accept: 'application/json' } })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) {
        if (!j || !j.duplicates) { warn.hidden = true; return; }
        warn.textContent = '⚠ Already saved: ' + j.first.file + ' (' + j.first.from + (j.first.by ? ', by ' + j.first.by : '') + '). Check it isn’t the same invoice.';
        warn.hidden = false;
      }).catch(function () {});
  }
  [sup, no].forEach(function (el) { el.addEventListener('input', function () { clearTimeout(timer); timer = setTimeout(check, 500); }); el.addEventListener('change', check); });
  check();
})();
