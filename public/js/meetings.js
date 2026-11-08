// Meetings module (8 Nov 2026): copy buttons and status selects that save on change.
// Everything also works without JavaScript (the status form has a Set button).
(function () {
  document.querySelectorAll('[data-copy]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var box = document.querySelector(btn.getAttribute('data-copy'));
      if (!box) return;
      var done = function () { var t = btn.textContent; btn.textContent = 'Copied ✓'; setTimeout(function () { btn.textContent = t; }, 1800); };
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(box.value).then(done, function () { box.select(); document.execCommand('copy'); done(); });
      else { box.select(); document.execCommand('copy'); done(); }
    });
  });
  document.querySelectorAll('select[data-autosubmit]').forEach(function (sel) {
    sel.addEventListener('change', function () { if (sel.form) sel.form.submit(); });
  });
})();
