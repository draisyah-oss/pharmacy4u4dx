// 5 Nov: October achievers on the front page (📣 News).
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const ejs = require('ejs');
const ach = require('../../src/home/achievers');

test('shows during November only, in English, with the CEO’s figures', async () => {
  assert.equal(ach.current('2026-10-31'), null);
  assert.equal(ach.current('2026-12-01'), null);
  const a = ach.current('2026-11-05');
  assert.equal(a.month, '2026-10');
  const html = await ejs.renderFile(path.join(__dirname, '../../src/views/partials/achievers.ejs'), { A: a });
  assert.match(html, /Congratulations!/);
  assert.match(html, /HAZERA|Hazera/);
  assert.match(html, /RM18,004\.24[\s\S]*Champion/);
  assert.match(html, /RM74,201\.80/);
  assert.match(html, /60 Google reviews/);
  // Podium order: 2, 1, 3
  assert.ok(html.indexOf('Yaya') < html.indexOf('Hazera') && html.indexOf('Hazera') < html.indexOf('Ainnur'));
  assert.doesNotMatch(html, /Tahniah|Pencapaian|Cawangan|Hadiah|Sijil/, 'English only');
  assert.doesNotMatch(html, /salary|gaji/i);
});

test('6 Nov: Dr Aisyah’s push shows only on 6 Nov, in English, with yesterday vs today’s target', async () => {
  const rally = require('../../src/home/rally');
  assert.equal(rally.current('2026-11-05'), null);
  assert.equal(rally.current('2026-11-07'), null);
  const R = rally.current('2026-11-06');
  const html = await ejs.renderFile(path.join(__dirname, '../../src/views/partials/rally.ejs'), { R, myCode: 'BR' });
  assert.match(html, /Let’s bounce back today!/);
  assert.match(html, /is-me"><th scope="row">BR/);
  assert.match(html, /RM639 <small>\(47%\)/);
  assert.match(html, /RM1,355/);
  assert.equal(R.branches.reduce((s, b) => s + b.yesterday, 0).toFixed(2), '5076.80', 'matches the sheet total');
});
