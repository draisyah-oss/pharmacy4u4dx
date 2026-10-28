// 28 Oct: inbox table – grey out the boxes a row's answer doesn't use, and mark changed rows.
(function () {
  var uses = { '': [], hq_deliver: ['qty', 'by', 'note'], transfer: ['qty', 'from', 'by', 'note'], order: ['qty', 'by', 'note'], substitute: ['by', 'note'], discontinue: ['note'], done: [] };
  var rows = document.querySelectorAll('tr[data-row]');
  function sync(tr) {
    var a = tr.querySelector('[data-answer]').value;
    var on = uses[a] || [];
    ['qty', 'from', 'by', 'note'].forEach(function (k) {
      var el = tr.querySelector('[name$="[' + k + ']"]');
      if (el) el.classList.toggle('is-unused', on.indexOf(k) < 0);
    });
  }
  for (var i = 0; i < rows.length; i++) {
    (function (tr) {
      sync(tr);
      tr.addEventListener('change', function () { sync(tr); tr.classList.add('is-changed'); });
      tr.addEventListener('input', function () { tr.classList.add('is-changed'); });
    })(rows[i]);
  }
})();
