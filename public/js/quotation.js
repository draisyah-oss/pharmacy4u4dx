// Zakat quotation (11 Nov 2026): copy buttons for the "Fill in the zakat form" table, picking an item
// saves the page (prices / stock option update), and the signature picture goes in as a data URL.
// Everything works without JavaScript too (Save button; the cells can be selected by hand).
(function () {
  function copyText(text, btn) {
    var done = function () { var t = btn.textContent; btn.textContent = '✓'; btn.classList.add('is-copied'); setTimeout(function () { btn.textContent = t; btn.classList.remove('is-copied'); }, 1200); };
    var fallback = function () {
      var box = document.createElement('textarea'); box.value = text; box.setAttribute('readonly', '');
      box.style.position = 'fixed'; box.style.opacity = '0'; document.body.appendChild(box); box.select();
      try { document.execCommand('copy'); done(); } catch (e) { /* the text stays selectable in the table */ }
      document.body.removeChild(box);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, fallback); else fallback();
  }
  document.querySelectorAll('[data-copy-text]').forEach(function (btn) {
    btn.addEventListener('click', function () { copyText(btn.getAttribute('data-copy-text'), btn); });
  });

  // Picking an item (or "Need cost") saves at once and comes back to the same line.
  var form = document.getElementById('qt-form');
  if (form) {
    form.querySelectorAll('input[data-qt-pick]').forEach(function (r) {
      r.addEventListener('change', function () {
        var line = r.closest('.qt-line');
        form.querySelector('input[name="goto"]').value = line ? line.id : '';
        form.submit();
      });
    });
  }

  document.querySelectorAll('input[data-dataurl-upload]').forEach(function (up) {
    up.addEventListener('change', function () {
      var f = up.files[0]; if (!f) return;
      var rd = new FileReader();
      rd.onload = function () { up.form.querySelector('input[name="file"]').value = rd.result; };
      rd.readAsDataURL(f);
    });
  });
})();
