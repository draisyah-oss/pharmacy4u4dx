// 28 Oct: inbox table – grey out the boxes a row's answer doesn't use, and mark changed rows.
(function () {
  var uses = { '': [], clarify: ['note'], hq_deliver: ['qty', 'from', 'by', 'note'], transfer: ['qty', 'from', 'by', 'note'], order: ['qty', 'by', 'note'], substitute: ['by', 'note'], discontinue: ['note'], done: [] };
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
      tr.addEventListener('change', function (e) {
        // From = HQ → HQ delivers; a branch → Transfer (28 Oct).
        var ans = tr.querySelector('[data-answer]');
        if (e.target.hasAttribute('data-from') && e.target.value && ['', 'hq_deliver', 'transfer'].indexOf(ans.value) >= 0) ans.value = e.target.value === 'HQ' ? 'hq_deliver' : 'transfer';
        if (e.target === ans && ans.value === 'hq_deliver') tr.querySelector('[data-from]').value = 'HQ';
        sync(tr); tr.classList.add('is-changed');
      });
      tr.addEventListener('input', function () { tr.classList.add('is-changed'); });
    })(rows[i]);
  }
})();
