// frontend/js/pages/dashboard-verdicts.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

// Оба файла блока подключены обычными <script> и делят ОДНУ глобальную область:
// верхнеуровневый const с именем функции соседа — SyntaxError, гасящий весь файл
// (инцидент с chat-wait-status.js). Грузим их подряд в один контекст, как браузер.
const ctx = vm.createContext({ console, module: undefined, window: {}, document: undefined });
for (const f of ['dashboard-messengers.js', 'dashboard-verdicts.js']) {
  vm.runInContext(fs.readFileSync(path.join(__dirname, f), 'utf8'), ctx, { filename: f });
}
const { vdBuildHash, vdRunText } = ctx;
const vdParseArg = arg => JSON.parse(JSON.stringify(ctx.vdParseArg(arg)));
const vdRowView = row => JSON.parse(JSON.stringify(ctx.vdRowView(row)));
const MSG_VERDICT_COLS = vm.runInContext('MSG_VERDICT_COLS', ctx);

test('оба файла грузятся в одну глобальную область без конфликтов имён', () => {
  assert.strictEqual(typeof ctx.renderMessengerStats, 'function');
  assert.strictEqual(typeof ctx.vdAfterRender, 'function');
  assert.strictEqual(typeof ctx.dashboardOnHashArg, 'function');
});

test('vdParseArg: уровень списка и уровень переписки', () => {
  assert.deepStrictEqual(vdParseArg('msg/whatsapp/declined'), { channel: 'whatsapp', status: 'declined', key: null, day: null });
  assert.deepStrictEqual(vdParseArg('msg/all/unanalyzed'), { channel: '', status: 'unanalyzed', key: null, day: null });
  assert.deepStrictEqual(vdParseArg('msg/tdlib/booked/test-dialog/2026-10-03'),
    { channel: 'tdlib', status: 'booked', key: 'test-dialog', day: '2026-10-03' });
  assert.deepStrictEqual(vdParseArg('msg/max/other/test-hidden/2026-09-18').key, 'test-hidden');
});

test('vdParseArg: мусор → null', () => {
  assert.strictEqual(vdParseArg(null), null);
  assert.strictEqual(vdParseArg(''), null);
  assert.strictEqual(vdParseArg('chat/123'), null);
  assert.strictEqual(vdParseArg('msg/all'), null);
  assert.strictEqual(vdParseArg('msg/all/<script>'), null);
  assert.strictEqual(vdParseArg('msg/all/booked/key'), null);                 // ключ без даты
  assert.strictEqual(vdParseArg('msg/all/booked/a b/2026-10-03'), null);      // пробел в ключе
  assert.strictEqual(vdParseArg('msg/all/booked/test-dialog/03.10.2026'), null);
});

test('vdBuildHash обратна vdParseArg', () => {
  for (const arg of ['msg/whatsapp/declined', 'msg/all/unanalyzed', 'msg/tdlib/booked/test-dialog/2026-10-03']) {
    assert.strictEqual(vdBuildHash(vdParseArg(arg)), 'dashboard/' + arg);
  }
  assert.strictEqual(vdBuildHash(null), 'dashboard');
});

test('vdRunText: строка состояния прогона', () => {
  assert.strictEqual(vdRunText(null), 'анализ ещё не запускался');
  assert.match(vdRunText({ status: 'running', requested: 31, analyzed: 12, started_at: '2026-10-04T06:46:00.000Z' }), /идёт: 12 из 31/);
  const done = vdRunText({ status: 'done', requested: 31, analyzed: 31, failed: 0, model: 'gpt-6-sol', finished_at: '2026-10-04T06:50:00.000Z' });
  assert.match(done, /31 из 31/);
  assert.match(done, /gpt-6-sol/);
  assert.match(vdRunText({ status: 'done', requested: 31, analyzed: 29, failed: 2, finished_at: '2026-10-04T06:50:00.000Z' }), /сбой 2/);
  assert.match(vdRunText({ status: 'error', error: 'all down', finished_at: '2026-10-04T06:50:00.000Z' }), /ошибка: all down/);
});

test('vdRowView: имя или номер, подпись статуса, значки', () => {
  const v = vdRowView({ dialog_key: 'test-dialog', channel: 'whatsapp', day: '2026-10-03', status: 'pending', note: 'ушла думать', notified: false, booked_crm: true, name: 'Тестовый контакт', phone: 'test-dialog' });
  assert.strictEqual(v.title, 'Тестовый контакт');
  assert.strictEqual(v.day, '03.10');
  assert.strictEqual(v.statusLabel, 'Не доведён');
  assert.deepStrictEqual(v.badges, [{ text: 'уведомл.', on: false }, { text: 'CRM', on: true }]);
  const noName = vdRowView({ dialog_key: 'test-hidden', channel: 'tdlib', day: '2026-10-03', status: 'other', label: 'жалоба', note: null, name: null, phone: null });
  assert.strictEqual(noName.title, 'test-hidden');
  assert.strictEqual(noName.statusLabel, 'Другое: жалоба');
  assert.strictEqual(noName.note, '');
});

test('MSG_VERDICT_COLS доступен обоим файлам', () => {
  assert.ok(Array.isArray(MSG_VERDICT_COLS) && MSG_VERDICT_COLS.length === 9);
});
