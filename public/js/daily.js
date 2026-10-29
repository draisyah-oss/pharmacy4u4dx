// Daily Entry: live green/red against target as people type, filled counts, unsaved warning.
(function () {
  'use strict';
  var form = document.getElementById('daily-form');
  if (!form) return;

  var fields = Array.prototype.slice.call(form.querySelectorAll('[data-field]'));
  var byKey = {};
  fields.forEach(function (el) { byKey[el.getAttribute('data-field')] = el; });

  function fmtNum(n) { return Number(n).toLocaleString('en-MY', { maximumFractionDigits: 1 }); }
  function fmtMoney(n) { return 'RM ' + Number(n).toLocaleString('en-MY', { maximumFractionDigits: 0 }); }

  // Current value of a field as a number, or null if empty / not a number.
  function valueOf(key) {
    var el = byKey[key];
    if (!el) return null;
    if (el.getAttribute('data-type') === 'yes_no') {
      var checked = el.querySelector('input:checked');
      return checked ? Number(checked.value) : null;
    }
    var raw = el.querySelector('input').value.trim().replace(/,/g, '');
    if (raw === '') return null;
    var n = Number(raw);
    return isFinite(n) ? n : NaN;
  }

  function rawOf(el) {
    if (el.getAttribute('data-type') === 'yes_no') {
      var c = el.querySelector('input:checked');
      return c ? c.value : '';
    }
    return el.querySelector('input').value.trim();
  }

  // Works out the state of one field: 'good', 'short' or '' (neutral), the text under the
  // input, and how full the gauge is.
  function evaluate(el) {
    var hint = el.getAttribute('data-hint');
    var v = valueOf(el.getAttribute('data-field'));
    var isYesNo = el.getAttribute('data-type') === 'yes_no';
    if (v !== null && isNaN(v)) return { state: 'error', text: 'Numbers only.', fill: 0 };

    // "…of which within 24h" can't be more than its parent number.
    var maxOf = el.getAttribute('data-max-of');
    if (maxOf && v !== null) {
      var parent = valueOf(maxOf);
      if (parent !== null && !isNaN(parent) && v > parent) {
        return { state: 'error', text: 'Can’t be more than “' + el.getAttribute('data-max-of-label') + '” (' + fmtNum(parent) + ').', fill: 0 };
      }
    }
    if (!hint) return { state: '', text: '', fill: 0 };
    var h = JSON.parse(hint);
    var show = h.money ? fmtMoney : fmtNum;

    if (h.kind === 'track') return { state: '', text: v === null ? '' : 'Tracked only – no target this month.', fill: 0 };

    if (h.kind === 'ratio') {
      var den = valueOf(h.den);
      if (v === null) return { state: '', text: '', fill: 0 };
      if (den === null || isNaN(den) || den === 0) {
        return { state: '', text: 'Fill in “' + h.denLabel + '” to see the %.', fill: 0 };
      }
      var r = v / den;
      return {
        state: r >= h.target - 1e-9 ? 'good' : 'short',
        text: Math.round(r * 1000) / 10 + '% of ' + fmtNum(den) + (r >= h.target - 1e-9 ? ' – on target' : ' – target ' + Math.round(h.target * 100) + '%'),
        fill: r / h.target,
      };
    }

    if (h.kind === 'pct') {
      if (v === null) return { state: '', text: '', fill: 0 };
      if (v > 100) return { state: 'error', text: 'A % – 100 at most (type 45 for 45%).', fill: 0 };
      var okPct = v / 100 >= h.target - 1e-9;
      return { state: okPct ? 'good' : 'short', text: v + '%' + (okPct ? ' – on target' : ' – target ' + Math.round(h.target * 100) + '%'), fill: v / 100 / h.target };
    }

    if (h.kind === 'perday') {
      var gate = valueOf(h.gate);
      if (gate !== 1) {
        return { state: '', text: gate === 0 ? 'Not a storefront day – not counted.' : 'Answer “' + h.gateLabel + '” first.', fill: 0 };
      }
      h = { kind: 'day', target: h.target, money: false };
    }

    if (h.kind === 'day') {
      if (v === null) return { state: '', text: '', fill: 0 };
      if (h.target === 0) return { state: v > 0 ? 'good' : '', text: v > 0 ? 'Extra – counts towards the week' : '', fill: v > 0 ? 1 : 0 };
      var ok = v >= h.target - 1e-9;
      if (isYesNo) return { state: ok ? 'good' : 'short', text: ok ? 'Done' : 'Not done today', fill: ok ? 1 : 0.04 };
      var gap = h.target - v;
      return {
        state: ok ? 'good' : 'short',
        text: ok ? 'On target' + (v > h.target ? ' (+' + show(v - h.target) + ')' : '') : show(gap) + ' short of ' + show(h.target),
        fill: h.target ? v / h.target : 1,
      };
    }

    // Weekly / monthly target: progress so far this period vs where it should be by this day.
    var total = h.soFar + (v === null ? 0 : v);
    var label = h.period === 'week' ? 'This week' : 'This month';
    var onPace = total >= h.targetToDate - 1e-9;
    if (v === null && h.soFar === 0) return { state: '', text: '', fill: 0 };
    return {
      state: onPace ? 'good' : 'short',
      text: label + ': ' + show(total) + ' of ' + show(h.targetFull) + (onPace ? ' – on pace' : ' – ' + show(h.targetToDate - total) + ' behind pace'),
      fill: h.targetFull ? total / h.targetFull : 1,
    };
  }

  function paint(el) {
    var r = evaluate(el);
    el.classList.remove('is-good', 'is-short', 'is-error');
    if (r.state) el.classList.add('is-' + r.state);
    el.classList.toggle('is-empty', rawOf(el) === '');
    var status = el.querySelector('.field-status');
    if (!el.classList.contains('has-error') || el.getAttribute('data-touched')) status.textContent = r.text;
    var gauge = el.querySelector('.gauge span');
    if (gauge) gauge.style.width = Math.max(0, Math.min(r.fill, 1)) * 100 + '%';
  }

  function updateCounts() {
    var cards = form.querySelectorAll('[data-card]');
    Array.prototype.forEach.call(cards, function (card) {
      var n = 0;
      var total = 0;
      Array.prototype.forEach.call(card.querySelectorAll('[data-field]'), function (el) {
        total++;
        if (rawOf(el) !== '') n++;
      });
      card.querySelector('[data-count]').textContent = n;
      var chip = document.querySelector('[data-chip="' + card.getAttribute('data-card') + '"] .chip-count');
      if (chip) chip.textContent = n + '/' + total;
    });
  }

  var note = document.querySelector('[data-dirty-note]');
  function dirtyCount() {
    return fields.filter(function (el) { return rawOf(el) !== el.getAttribute('data-initial'); }).length;
  }
  function updateDirty() {
    if (!note) return;
    var n = dirtyCount();
    note.textContent = n === 0 ? 'All saved' : n + (n === 1 ? ' change' : ' changes') + ' not saved yet';
    note.classList.toggle('is-dirty', n > 0);
  }

  function refreshAll() { fields.forEach(paint); updateCounts(); updateDirty(); }

  form.addEventListener('input', function (e) {
    var el = e.target.closest('[data-field]');
    if (el) el.setAttribute('data-touched', '1');
    refreshAll(); // a parent number can change another field's state (e.g. transactions → %)
  });
  form.addEventListener('change', refreshAll);

  // Enter moves to the next box instead of submitting half-filled.
  form.addEventListener('keydown', function (e) {
    if (e.key !== 'Enter' || e.target.tagName !== 'INPUT' || e.target.type !== 'text') return;
    e.preventDefault();
    var inputs = Array.prototype.slice.call(form.querySelectorAll('input.num:not([disabled])'));
    var next = inputs[inputs.indexOf(e.target) + 1];
    if (next) next.focus(); else e.target.blur();
  });

  var submitting = false;
  form.addEventListener('submit', function () {
    submitting = true;
    var btn = form.querySelector('button.save');
    if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }
  });
  window.addEventListener('beforeunload', function (e) {
    if (!submitting && dirtyCount() > 0) { e.preventDefault(); e.returnValue = ''; }
  });

  // 29 Oct: +1 / −1 buttons (BR first). Each tap is saved at once in the background; the box shows
  // the saved number and stays "saved". Without JavaScript the button posts the form instead.
  form.addEventListener('click', function (e) {
    var btn = e.target.closest('button[name=tally]');
    if (!btn || !window.fetch) return;
    e.preventDefault();
    var el = btn.closest('[data-field]');
    var input = el && el.querySelector('input.num');
    if (!input || btn.disabled) return;
    var body = new URLSearchParams();
    ['_csrf', 'date', 'branch', 'show'].forEach(function (n) {
      var h = form.querySelector('input[type=hidden][name=' + n + ']');
      if (h) body.append(n, h.value);
    });
    body.append('tally', btn.value);
    var status = el.querySelector('.field-status');
    btn.disabled = true;
    fetch('/daily/tally', { method: 'POST', credentials: 'same-origin', headers: { Accept: 'application/json' }, body: body })
      .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
      .then(function (res) {
        if (!res.ok) throw new Error(res.j && res.j.error ? res.j.error : 'Not saved – try again.');
        input.value = String(res.j.value);
        el.setAttribute('data-initial', String(res.j.value));
        el.setAttribute('data-touched', '1');
        el.classList.remove('tally-flash'); void el.offsetWidth; el.classList.add('tally-flash');
        refreshAll();
      })
      .catch(function (err) { if (status) status.textContent = err.message || 'Not saved – check the connection.'; })
      .then(function () { btn.disabled = false; });
  });

  refreshAll();
})();
