// 10 Nov (CEO: "make it like scan, quality similar to scan / photocopy"): turns a phone photo of a
// page into a scan. Finds the paper's four corners (staff can drag them), straightens the page
// (perspective), evens out shadows / lighting and whitens the paper. Three looks: "bw" (photocopy –
// black text on white), "colour" (whitened paper, stamps and signatures keep their colour), "photo"
// (straightened only). Plain canvas, no library. window.P4UScan.open(file, done) – done(dataUrl|null).
(function () {
  var SRC_MAX = 2600;   // longest side used from the photo
  var OUT_MAX = 2000;   // longest side of the finished page (≈ 200 dpi on A4)
  var LOOK_KEY = 'p4u.scan.look';

  function clamp(v) { return v < 0 ? 0 : v > 255 ? 255 : v; }
  function getLook() { try { return localStorage.getItem(LOOK_KEY) || 'bw'; } catch (e) { return 'bw'; } }
  function setLook(v) { try { localStorage.setItem(LOOK_KEY, v); } catch (e) {} }

  // ---- 1. corners: the biggest bright area (Otsu threshold on a small copy) ----------------------
  function findCorners(canvas) {
    var W = canvas.width; var H = canvas.height;
    var s = Math.min(1, 320 / Math.max(W, H));
    var w = Math.max(8, Math.round(W * s)); var h = Math.max(8, Math.round(H * s));
    var c = document.createElement('canvas'); c.width = w; c.height = h;
    var g = c.getContext('2d'); g.drawImage(canvas, 0, 0, w, h);
    var d = g.getImageData(0, 0, w, h).data;
    var n = w * h; var gray = new Uint8Array(n); var hist = new Array(256).fill(0);
    for (var i = 0; i < n; i++) { var v = (d[i * 4] * 77 + d[i * 4 + 1] * 150 + d[i * 4 + 2] * 29) >> 8; gray[i] = v; hist[v]++; }
    // Otsu
    var sum = 0; for (var t = 0; t < 256; t++) sum += t * hist[t];
    var sumB = 0; var wB = 0; var best = 0; var thr = 128;
    for (t = 0; t < 256; t++) {
      wB += hist[t]; if (!wB) continue; var wF = n - wB; if (!wF) break;
      sumB += t * hist[t]; var mB = sumB / wB; var mF = (sum - sumB) / wF;
      var between = wB * wF * (mB - mF) * (mB - mF); if (between > best) { best = between; thr = t; }
    }
    // largest bright component
    var lab = new Int32Array(n); var bestId = 0; var bestSize = 0; var id = 0; var stack = new Int32Array(n);
    for (i = 0; i < n; i++) {
      if (lab[i] || gray[i] <= thr) continue;
      id++; var sp = 0; stack[sp++] = i; lab[i] = id; var size = 0;
      while (sp) {
        var p = stack[--sp]; size++; var x = p % w; var y = (p - x) / w;
        if (x > 0 && !lab[p - 1] && gray[p - 1] > thr) { lab[p - 1] = id; stack[sp++] = p - 1; }
        if (x < w - 1 && !lab[p + 1] && gray[p + 1] > thr) { lab[p + 1] = id; stack[sp++] = p + 1; }
        if (y > 0 && !lab[p - w] && gray[p - w] > thr) { lab[p - w] = id; stack[sp++] = p - w; }
        if (y < h - 1 && !lab[p + w] && gray[p + w] > thr) { lab[p + w] = id; stack[sp++] = p + w; }
      }
      if (size > bestSize) { bestSize = size; bestId = id; }
    }
    var whole = [[0, 0], [W, 0], [W, H], [0, H]];
    if (!bestId || bestSize < n * 0.15 || bestSize > n * 0.97) return whole;
    var tl = null, tr = null, br = null, bl = null; var a = Infinity, b = -Infinity, cc = -Infinity, dd = Infinity;
    for (i = 0; i < n; i++) {
      if (lab[i] !== bestId) continue;
      x = i % w; y = (i - x) / w;
      if (x + y < a) { a = x + y; tl = [x, y]; }
      if (x - y > b) { b = x - y; tr = [x + 1, y]; }
      if (x + y > cc) { cc = x + y; br = [x + 1, y + 1]; }
      if (x - y < dd) { dd = x - y; bl = [x, y + 1]; }
    }
    var q4 = [tl, tr, br, bl].map(function (q) { return [q[0] / s, q[1] / s]; });
    var cx = (q4[0][0] + q4[1][0] + q4[2][0] + q4[3][0]) / 4, cy = (q4[0][1] + q4[1][1] + q4[2][1] + q4[3][1]) / 4;
    return q4.map(function (q) { // 1.5 % in towards the middle – keeps the table edge out
      return [Math.max(0, Math.min(W, q[0] + (cx - q[0]) * 0.015)), Math.max(0, Math.min(H, q[1] + (cy - q[1]) * 0.015))];
    });
  }

  // ---- 2. straighten: homography from the output rectangle to the four corners -----------------
  function solve(A, bv) { // Gaussian elimination, 8x8
    var m = A.length;
    for (var i = 0; i < m; i++) A[i].push(bv[i]);
    for (var col = 0; col < m; col++) {
      var piv = col; for (var r = col + 1; r < m; r++) if (Math.abs(A[r][col]) > Math.abs(A[piv][col])) piv = r;
      var tmp = A[col]; A[col] = A[piv]; A[piv] = tmp;
      var pv = A[col][col]; if (Math.abs(pv) < 1e-12) return null;
      for (r = 0; r < m; r++) {
        if (r === col) continue; var f = A[r][col] / pv;
        for (var k = col; k <= m; k++) A[r][k] -= f * A[col][k];
      }
    }
    return A.map(function (row, i2) { return row[m] / row[i2]; });
  }
  function homography(from, to) {
    var A = []; var bv = [];
    for (var i = 0; i < 4; i++) {
      var x = from[i][0], y = from[i][1], u = to[i][0], v = to[i][1];
      A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]); bv.push(u);
      A.push([0, 0, 0, x, y, 1, -v * x, -v * y]); bv.push(v);
    }
    var h = solve(A, bv); if (!h) return null; h.push(1); return h;
  }
  function dist(p, q) { return Math.hypot(p[0] - q[0], p[1] - q[1]); }
  function warp(src, q) {
    var ow = Math.max(dist(q[0], q[1]), dist(q[3], q[2]));
    var oh = Math.max(dist(q[0], q[3]), dist(q[1], q[2]));
    var k = Math.min(1, OUT_MAX / Math.max(ow, oh));
    ow = Math.max(1, Math.round(ow * k)); oh = Math.max(1, Math.round(oh * k));
    var H = homography([[0, 0], [ow, 0], [ow, oh], [0, oh]], q);
    var out = document.createElement('canvas'); out.width = ow; out.height = oh;
    if (!H) { out.getContext('2d').drawImage(src, 0, 0, ow, oh); return out; }
    var sw = src.width, sh = src.height;
    var sd = src.getContext('2d').getImageData(0, 0, sw, sh).data;
    var og = out.getContext('2d'); var img = og.createImageData(ow, oh); var od = img.data;
    for (var y = 0; y < oh; y++) {
      for (var x = 0; x < ow; x++) {
        var X = x + 0.5, Y = y + 0.5;
        var den = H[6] * X + H[7] * Y + 1;
        var u = (H[0] * X + H[1] * Y + H[2]) / den - 0.5; var v = (H[3] * X + H[4] * Y + H[5]) / den - 0.5;
        var o = (y * ow + x) * 4;
        if (u < 0) u = 0; if (v < 0) v = 0; if (u > sw - 1.001) u = sw - 1.001; if (v > sh - 1.001) v = sh - 1.001;
        var x0 = u | 0, y0 = v | 0, fx = u - x0, fy = v - y0;
        var i00 = (y0 * sw + x0) * 4, i10 = i00 + 4, i01 = i00 + sw * 4, i11 = i01 + 4;
        for (var ch = 0; ch < 3; ch++) {
          var top = sd[i00 + ch] + (sd[i10 + ch] - sd[i00 + ch]) * fx;
          var bot = sd[i01 + ch] + (sd[i11 + ch] - sd[i01 + ch]) * fx;
          od[o + ch] = top + (bot - top) * fy;
        }
        od[o + 3] = 255;
      }
    }
    og.putImageData(img, 0, 0);
    return out;
  }

  // ---- 3. clean: divide by the paper's own brightness (shadows gone), then levels -------------
  function paperLevel(c) { // small "background" map: text removed by a max filter, then blurred
    var w = Math.max(4, Math.round(c.width / 16)); var h = Math.max(4, Math.round(c.height / 16));
    var t = document.createElement('canvas'); t.width = w; t.height = h;
    var g = t.getContext('2d'); g.drawImage(c, 0, 0, w, h);
    var d = g.getImageData(0, 0, w, h).data; var a = new Float32Array(w * h);
    for (var i = 0; i < w * h; i++) a[i] = Math.max(d[i * 4], d[i * 4 + 1], d[i * 4 + 2]);
    function pass(src, fn) {
      var dst = new Float32Array(w * h);
      for (var y = 0; y < h; y++) for (var x = 0; x < w; x++) {
        var acc = fn === 'max' ? 0 : 0; var cnt = 0;
        for (var dy = -2; dy <= 2; dy++) for (var dx = -2; dx <= 2; dx++) {
          var xx = x + dx, yy = y + dy; if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
          var v = src[yy * w + xx]; if (fn === 'max') { if (v > acc) acc = v; } else { acc += v; cnt++; }
        }
        dst[y * w + x] = fn === 'max' ? acc : acc / cnt;
      }
      return dst;
    }
    a = pass(pass(a, 'max'), 'max'); a = pass(pass(a, 'avg'), 'avg');
    return { w: w, h: h, a: a };
  }
  function clean(c, look) {
    if (look === 'photo') return c;
    var W = c.width, H = c.height; var g = c.getContext('2d');
    var img = g.getImageData(0, 0, W, H); var d = img.data;
    var bg = paperLevel(c); var sx = bg.w / W, sy = bg.h / H;
    for (var y = 0; y < H; y++) {
      var fy = Math.min(bg.h - 1.001, Math.max(0, (y + 0.5) * sy - 0.5)); var y0 = fy | 0; var ty = fy - y0;
      for (var x = 0; x < W; x++) {
        var fx = Math.min(bg.w - 1.001, Math.max(0, (x + 0.5) * sx - 0.5)); var x0 = fx | 0; var tx = fx - x0;
        var i0 = y0 * bg.w + x0;
        var p = bg.a[i0] * (1 - tx) * (1 - ty) + bg.a[i0 + 1] * tx * (1 - ty) + bg.a[i0 + bg.w] * (1 - tx) * ty + bg.a[i0 + bg.w + 1] * tx * ty;
        if (p < 40) p = 40;
        var o = (y * W + x) * 4;
        if (look === 'bw') {
          var l = (d[o] * 77 + d[o + 1] * 150 + d[o + 2] * 29) / 256;
          var n = l / p;                         // 1 = paper, lower = ink
          var v = (n - 0.55) / (0.9 - 0.55);     // ink below 0.55 → black, paper above 0.9 → white
          v = v < 0 ? 0 : v > 1 ? 1 : v; v = Math.pow(v, 1.6);
          d[o] = d[o + 1] = d[o + 2] = clamp(v * 255);
        } else {
          for (var ch = 0; ch < 3; ch++) {
            var m = d[o + ch] / p; var w2 = (m - 0.25) / (0.92 - 0.25);
            w2 = w2 < 0 ? 0 : w2 > 1 ? 1 : w2; d[o + ch] = clamp(Math.pow(w2, 1.25) * 255);
          }
        }
      }
    }
    g.putImageData(img, 0, 0);
    return c;
  }

  function toJpeg(c) {
    var data = c.toDataURL('image/jpeg', 0.82);
    if (data.length > 2400000) data = c.toDataURL('image/jpeg', 0.6);
    return data;
  }
  function process(src, corners, look) { return toJpeg(clean(warp(src, corners), look)); }

  // ---- 4. the "Adjust page" screen ---------------------------------------------------------
  function loadCanvas(file, done) {
    var reader = new FileReader(); var img = new Image();
    img.onload = function () {
      var s = Math.min(1, SRC_MAX / Math.max(img.width, img.height));
      var c = document.createElement('canvas'); c.width = Math.round(img.width * s); c.height = Math.round(img.height * s);
      var g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height); g.drawImage(img, 0, 0, c.width, c.height);
      done(c);
    };
    img.onerror = function () { done(null); };
    reader.onload = function () { img.src = reader.result; };
    reader.onerror = function () { done(null); };
    reader.readAsDataURL(file);
  }

  function open(file, done) {
    loadCanvas(file, function (src) {
      if (!src) return done(null);
      var corners = findCorners(src);
      var look = getLook();
      var ov = document.createElement('div'); ov.className = 'sc-overlay'; ov.setAttribute('role', 'dialog'); ov.setAttribute('aria-modal', 'true'); ov.setAttribute('aria-label', 'Adjust the page');
      ov.innerHTML =
        '<div class="sc-head"><strong>Adjust the page</strong><span class="sc-hint">Drag the corners to the edges of the paper.</span></div>' +
        '<div class="sc-stage"><div class="sc-wrap"><canvas class="sc-photo"></canvas><svg class="sc-lines"><polygon></polygon></svg>' +
        '<button type="button" class="sc-h" aria-label="Top-left corner"></button><button type="button" class="sc-h" aria-label="Top-right corner"></button>' +
        '<button type="button" class="sc-h" aria-label="Bottom-right corner"></button><button type="button" class="sc-h" aria-label="Bottom-left corner"></button></div></div>' +
        '<div class="sc-bar">' +
        '<div class="sc-looks" role="radiogroup" aria-label="Look">' +
        '<label><input type="radio" name="sc-look" value="bw"> Scan (B&amp;W)</label>' +
        '<label><input type="radio" name="sc-look" value="colour"> Colour scan</label>' +
        '<label><input type="radio" name="sc-look" value="photo"> Photo</label></div>' +
        '<div class="sc-btns"><button type="button" class="button secondary" data-sc="cancel">Cancel</button>' +
        '<button type="button" class="link-button" data-sc="whole">Whole photo</button>' +
        '<button type="button" class="button" data-sc="use">Use this page</button></div>' +
        '<p class="sc-busy" aria-live="polite"></p></div>';
      document.body.appendChild(ov); document.body.classList.add('sc-open');
      var view = ov.querySelector('.sc-photo'); var wrap = ov.querySelector('.sc-wrap');
      var poly = ov.querySelector('polygon'); var svg = ov.querySelector('svg');
      var hs = ov.querySelectorAll('.sc-h'); var busy = ov.querySelector('.sc-busy');
      ov.querySelector('input[value="' + look + '"]').checked = true;
      var scale = 1;
      function layout() {
        var stage = ov.querySelector('.sc-stage');
        var mw = stage.clientWidth - 24, mh = stage.clientHeight - 24;
        scale = Math.min(mw / src.width, mh / src.height, 1);
        view.width = Math.round(src.width * scale); view.height = Math.round(src.height * scale);
        view.getContext('2d').drawImage(src, 0, 0, view.width, view.height);
        wrap.style.width = view.width + 'px'; wrap.style.height = view.height + 'px';
        svg.setAttribute('width', view.width); svg.setAttribute('height', view.height);
        draw();
      }
      function draw() {
        poly.setAttribute('points', corners.map(function (p) { return (p[0] * scale) + ',' + (p[1] * scale); }).join(' '));
        for (var i = 0; i < 4; i++) { hs[i].style.left = (corners[i][0] * scale) + 'px'; hs[i].style.top = (corners[i][1] * scale) + 'px'; }
      }
      Array.prototype.forEach.call(hs, function (h, idx) {
        h.addEventListener('pointerdown', function (e) {
          e.preventDefault(); h.setPointerCapture(e.pointerId);
          function move(ev) {
            var r = wrap.getBoundingClientRect();
            corners[idx] = [Math.max(0, Math.min(src.width, (ev.clientX - r.left) / scale)), Math.max(0, Math.min(src.height, (ev.clientY - r.top) / scale))];
            draw();
          }
          function up() { h.removeEventListener('pointermove', move); h.removeEventListener('pointerup', up); h.removeEventListener('pointercancel', up); }
          h.addEventListener('pointermove', move); h.addEventListener('pointerup', up); h.addEventListener('pointercancel', up);
        });
        h.addEventListener('keydown', function (e) { // arrows nudge a corner
          var k = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key]; if (!k) return;
          e.preventDefault(); var step = (e.shiftKey ? 40 : 8) / scale;
          corners[idx] = [Math.max(0, Math.min(src.width, corners[idx][0] + k[0] * step)), Math.max(0, Math.min(src.height, corners[idx][1] + k[1] * step))];
          draw();
        });
      });
      function close(result) { window.removeEventListener('resize', layout); ov.remove(); document.body.classList.remove('sc-open'); done(result); }
      ov.addEventListener('click', function (e) {
        var a = e.target.getAttribute && e.target.getAttribute('data-sc'); if (!a) return;
        if (a === 'cancel') return close(null);
        if (a === 'whole') { corners = [[0, 0], [src.width, 0], [src.width, src.height], [0, src.height]]; return draw(); }
        if (a === 'use') {
          var sel = ov.querySelector('input[name="sc-look"]:checked'); look = sel ? sel.value : 'bw'; setLook(look);
          busy.textContent = 'Making the scan…'; e.target.disabled = true;
          setTimeout(function () { var out = null; try { out = process(src, corners, look); } catch (err) { out = null; } close(out); }, 30);
        }
      });
      ov.addEventListener('keydown', function (e) { if (e.key === 'Escape') close(null); });
      window.addEventListener('resize', layout);
      layout(); ov.querySelector('[data-sc="use"]').focus();
    });
  }

  window.P4UScan = { open: open, findCorners: findCorners, process: process };
})();
