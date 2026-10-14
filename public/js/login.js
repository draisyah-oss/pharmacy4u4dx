// PIN keypad: big buttons, dots fill in, logs in on the 4th digit.
(function () {
  'use strict';
  var form = document.getElementById('pin-form');
  if (!form) return;
  var input = form.querySelector('.pin-input');
  var dots = form.querySelectorAll('.pin-dots span');
  var keypad = form.querySelector('.keypad');

  form.classList.add('has-keypad');
  keypad.hidden = false;
  input.setAttribute('readonly', 'readonly'); // use the keypad, no phone keyboard popping up

  function render() {
    Array.prototype.forEach.call(dots, function (d, i) { d.classList.toggle('on', i < input.value.length); });
  }

  keypad.addEventListener('click', function (e) {
    var key = e.target.closest('button') && e.target.closest('button').getAttribute('data-key');
    if (!key) return;
    if (key === 'del') input.value = input.value.slice(0, -1);
    else if (input.value.length < 4) input.value += key;
    render();
    if (input.value.length === 4) {
      keypad.classList.add('is-busy');
      form.submit();
    }
  });

  document.addEventListener('keydown', function (e) {
    if (/^\d$/.test(e.key) && input.value.length < 4) { input.value += e.key; render(); if (input.value.length === 4) form.submit(); }
    if (e.key === 'Backspace') { input.value = input.value.slice(0, -1); render(); }
  });
  render();
})();
