// 27 Oct: shrink a photo on the phone before sending (max 1280 px, JPEG) and put it into the
// form's hidden "photo" box as a data URL. Without JavaScript the photo is simply not sent.
(function () {
  var MAX = 1280;
  function setup(wrap) {
    var file = wrap.querySelector('.ph-file');
    var hidden = wrap.querySelector('input[name="photo"]');
    var preview = wrap.querySelector('.ph-preview');
    var clear = wrap.querySelector('.ph-clear');
    var msg = wrap.querySelector('.ph-msg');
    function reset() { hidden.value = ''; preview.hidden = true; preview.removeAttribute('src'); clear.hidden = true; file.value = ''; msg.textContent = ''; }
    clear.addEventListener('click', reset);
    file.addEventListener('change', function () {
      var f = file.files && file.files[0];
      if (!f) return;
      msg.textContent = 'Preparing photo…';
      // Read as a data URL (the page's security rules allow data: images, not blob:).
      var reader = new FileReader();
      var img = new Image();
      img.onload = function () {
        var scale = Math.min(1, MAX / Math.max(img.width, img.height));
        var c = document.createElement('canvas');
        c.width = Math.round(img.width * scale); c.height = Math.round(img.height * scale);
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        var data = c.toDataURL('image/jpeg', 0.72);
        if (data.length > 2400000) data = c.toDataURL('image/jpeg', 0.5);
        hidden.value = data; preview.src = data; preview.hidden = false; clear.hidden = false; msg.textContent = 'Photo ready – it sends with the form.';
      };
      img.onerror = function () { reset(); msg.textContent = 'That file couldn’t be opened as a photo.'; };
      reader.onload = function () { img.src = reader.result; };
      reader.onerror = function () { reset(); msg.textContent = 'That file couldn’t be read.'; };
      reader.readAsDataURL(f);
    });
  }
  var all = document.querySelectorAll('[data-photo]');
  for (var i = 0; i < all.length; i++) setup(all[i]);
})();
