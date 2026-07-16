const { test } = require('node:test');
const assert = require('node:assert');
const { kbMarkdown } = require('./kb-markdown');

test('экранирует HTML', () => {
  assert.ok(kbMarkdown('<script>x</script>').includes('&lt;script&gt;'));
  assert.ok(!kbMarkdown('<script>x</script>').includes('<script>x'));
});

test('заголовок # → <h3>', () => {
  assert.ok(kbMarkdown('# Привет').includes('<h3'));
  assert.ok(kbMarkdown('# Привет').includes('Привет'));
});

test('жирный **x** → <strong>', () => {
  assert.ok(kbMarkdown('это **важно** да').includes('<strong>важно</strong>'));
});

test('чекбокс - [ ] → input type=checkbox', () => {
  const html = kbMarkdown('- [ ] проверить записи');
  assert.ok(html.includes('type="checkbox"'));
  assert.ok(html.includes('data-kb-check="0"'));
  assert.ok(!html.includes('checked'));
  assert.ok(html.includes('проверить записи'));
});

test('чекбокс - [x] → checked', () => {
  assert.ok(kbMarkdown('- [x] готово').includes('checked'));
});

test('обычный список - item → <li>', () => {
  const html = kbMarkdown('- первый\n- второй');
  assert.ok(html.includes('<li>первый</li>'));
  assert.ok(html.includes('<li>второй</li>'));
});

test('код-блок ``` → <pre> с кнопкой копирования', () => {
  const html = kbMarkdown('```\nПривет, {name}!\n```');
  assert.ok(html.includes('<pre'));
  assert.ok(html.includes('kb-copy'));
  assert.ok(html.includes('Привет, {name}!'));
});
