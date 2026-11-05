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
