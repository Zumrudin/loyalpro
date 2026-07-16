const { test } = require('node:test');
const assert = require('node:assert');
const { kbMarkdown, kbSnippet } = require('./kb-markdown');

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

test('kbSnippet: экранирует HTML из тела (защита от XSS)', () => {
  const out = kbSnippet('<img src=x onerror=alert(1)>');
  assert.ok(out.includes('&lt;img'));
  assert.ok(!out.includes('<img'));
});

test('kbSnippet: сентинел-маркеры → <b>/</b>', () => {
  assert.strictEqual(kbSnippet('текст @@KBH_S@@важно@@KBH_E@@ да'),
    'текст <b>важно</b> да');
});

test('kbSnippet: подсветка поверх опасного html остаётся безопасной', () => {
  const out = kbSnippet('@@KBH_S@@<b>@@KBH_E@@');
  assert.strictEqual(out, '<b>&lt;b&gt;</b>');
});

test('kbSnippet: пустой/undefined → пустая строка', () => {
  assert.strictEqual(kbSnippet(null), '');
  assert.strictEqual(kbSnippet(undefined), '');
});
