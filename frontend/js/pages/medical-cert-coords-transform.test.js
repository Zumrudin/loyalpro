// frontend/js/pages/medical-cert-coords-transform.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const { mcPtToScreen, mcScreenToPt, mcSampleFor } = require('./medical-cert-coords-transform');

const ctx = { scale: 1.5, pageHeightPt: 842 };

test('mcPtToScreen: x*scale, инверсия Y, baseline-поправка', () => {
  const r = mcPtToScreen({ x: 130, y: 800, fontSize: 11 }, ctx);
  assert.strictEqual(r.left, 195);
  assert.strictEqual(r.top, 46.5);
});

test('mcPtToScreen: fontSize по умолчанию 11', () => {
  const a = mcPtToScreen({ x: 0, y: 0 }, ctx);
  const b = mcPtToScreen({ x: 0, y: 0, fontSize: 11 }, ctx);
  assert.deepStrictEqual(a, b);
});

test('round-trip pt->screen->pt даёт исходные целые pt', () => {
  for (const f of [
    { x: 130, y: 800, fontSize: 11 },
    { x: 60, y: 250, fontSize: 12 },
    { x: 500, y: 352, fontSize: 11 },
    { x: 0, y: 0, fontSize: 9 },
  ]) {
    const s = mcPtToScreen(f, ctx);
    const back = mcScreenToPt(s.left, s.top, f.fontSize, ctx);
    assert.deepStrictEqual(back, { x: f.x, y: f.y });
  }
});

test('mcScreenToPt округляет до целых pt', () => {
  const r = mcScreenToPt(195.4, 46.9, 11, ctx);
  assert.strictEqual(Number.isInteger(r.x), true);
  assert.strictEqual(Number.isInteger(r.y), true);
});

test('mcSampleFor: известные поля и дефолты', () => {
  assert.strictEqual(mcSampleFor('payer_last', { type: 'text' }), 'АГАФОНОВ');
  assert.strictEqual(mcSampleFor('payer_birthdate', { type: 'cells', max: 8 }), '08051989');
  assert.strictEqual(mcSampleFor('unknown_x', { type: 'cells', max: 5 }), '11111');
  assert.strictEqual(mcSampleFor('whatever', { type: 'text' }), 'whatever');
});
