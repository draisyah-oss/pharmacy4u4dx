// Academy: animations can be turned off on this device (also off for "reduce motion").
(function () {
  var KEY = 'p4u_academy_anim_off';
  function get() { try { return localStorage.getItem(KEY) === '1'; } catch (e) { return false; } }
  function set(v) { try { localStorage.setItem(KEY, v ? '1' : '0'); } catch (e) { /* ignore */ } }
  function apply() { document.documentElement.classList.toggle('ac-no-anim', get()); }
  apply();
  var box = document.querySelector('[data-ac-anim-off]');
  if (box) {
    box.checked = get();
    box.addEventListener('change', function () { set(box.checked); apply(); });
  }
})();
