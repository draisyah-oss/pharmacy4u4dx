// Monthly review: "Copy" puts the tab-separated table on the clipboard for Google Sheets.
document.addEventListener('click', function (e) {
  var b = e.target.closest('[data-copy]');
  if (!b) return;
  var box = document.getElementById(b.getAttribute('data-copy'));
  if (!box) return;
  var done = function () { var t = b.textContent; b.textContent = 'Copied ✔'; setTimeout(function () { b.textContent = t; }, 1800); };
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(box.value).then(done, function () { box.select(); document.execCommand('copy'); done(); });
  } else { box.select(); document.execCommand('copy'); done(); }
});
