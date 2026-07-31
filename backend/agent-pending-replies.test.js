'use strict';

// Свежеотправленные ответы агента, ещё не подтверждённые эхом Chatpush.
// Инцидент 2026-07-31: повторный прогон не видел только что отправленный ответ
// (эхо приходит с задержкой) → Мила отвечала на серию заново, с повторным приветствием.
const pending = require('./services/agent/pending-replies');

beforeEach(() => pending._reset());

test('remember/peek: запись возвращается с ts в секундах', () => {
  pending.remember(1, '79001112233', 'Есть окошки в 20:00', 150_000);
  expect(pending.peek(1, '79001112233', 151_000)).toEqual([
    { text: 'Есть окошки в 20:00', ts: 150 },
  ]);
});

test('peek изолирован по салону и диалогу', () => {
  pending.remember(1, 'a', 'ответ A', 100_000);
  expect(pending.peek(1, 'b', 101_000)).toEqual([]);
  expect(pending.peek(2, 'a', 101_000)).toEqual([]);
});

test('несколько ответов возвращаются в порядке отправки', () => {
  pending.remember(1, 'k', 'раз', 100_000);
  pending.remember(1, 'k', 'два', 110_000);
  expect(pending.peek(1, 'k', 111_000).map(e => e.text)).toEqual(['раз', 'два']);
});

test('записи старше TTL отбрасываются (эхо давно должно было прийти)', () => {
  pending.remember(1, 'k', 'старый ответ', 0);
  pending.remember(1, 'k', 'свежий ответ', 31 * 60 * 1000);
  expect(pending.peek(1, 'k', 31 * 60 * 1000 + 1000).map(e => e.text))
    .toEqual(['свежий ответ']);
});

test('_reset очищает всё', () => {
  pending.remember(1, 'k', 'ответ', 100_000);
  pending._reset();
  expect(pending.peek(1, 'k', 101_000)).toEqual([]);
});
