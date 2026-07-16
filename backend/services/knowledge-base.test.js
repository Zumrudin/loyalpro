'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { STARTER_CATEGORIES, validateArticleInput, normalizeTags } = require('./knowledge-base');

test('STARTER_CATEGORIES: 8 папок с title/icon/display_order', () => {
  assert.strictEqual(STARTER_CATEGORIES.length, 8);
  for (const c of STARTER_CATEGORIES) {
    assert.ok(typeof c.title === 'string' && c.title.length > 0);
    assert.ok(typeof c.icon === 'string');
    assert.ok(Number.isInteger(c.display_order));
  }
  assert.strictEqual(STARTER_CATEGORIES[0].title, 'Информация о салоне и услугах');
});

test('normalizeTags: массив/строка → чистый массив строк', () => {
  assert.deepStrictEqual(normalizeTags(['a', ' b ', '', 'a']), ['a', 'b']);
  assert.deepStrictEqual(normalizeTags('x, y ,x'), ['x', 'y']);
  assert.deepStrictEqual(normalizeTags(null), []);
  assert.deepStrictEqual(normalizeTags(42), []);
});

test('validateArticleInput: title обязателен', () => {
  assert.deepStrictEqual(
    validateArticleInput({ title: '  ', category_id: 1 }),
    { valid: false, error: 'title обязателен' }
  );
});

test('validateArticleInput: category_id должен быть целым', () => {
  assert.deepStrictEqual(
    validateArticleInput({ title: 'ok', category_id: 'x' }),
    { valid: false, error: 'category_id обязателен' }
  );
});

test('validateArticleInput: валидный вход', () => {
  assert.deepStrictEqual(
    validateArticleInput({ title: 'Скрипт', category_id: 3 }),
    { valid: true }
  );
});
