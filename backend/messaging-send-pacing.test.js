'use strict';
// Темп плановых отправок. Чистая часть — без БД.
const { waitMsLeft } = require('./services/messaging/send-pacing');

const NOW = Date.parse('2026-08-08T11:00:00+03:00');
const ago = (min) => new Date(NOW - min * 60000);

test('никогда не отправляли → ждать нечего', () => {
  expect(waitMsLeft(null, 3, NOW)).toBe(0);
});

test('интервал 0 → ждать нечего даже сразу после отправки', () => {
  expect(waitMsLeft(ago(0), 0, NOW)).toBe(0);
});

test('интервал не истёк → ждать остаток', () => {
  expect(waitMsLeft(ago(1), 3, NOW)).toBe(2 * 60000);
});

test('интервал истёк ровно → ждать нечего', () => {
  expect(waitMsLeft(ago(3), 3, NOW)).toBe(0);
});

test('интервал истёк с запасом → ждать нечего, отрицательного не возвращаем', () => {
  expect(waitMsLeft(ago(50), 3, NOW)).toBe(0);
});

// sent_at приходит из pg объектом Date, а тесты и скрипты подают ISO-строку —
// та же готча, что в attribution.sentMsOf.
test('ISO-строка понимается наравне с объектом Date', () => {
  expect(waitMsLeft(ago(1).toISOString(), 3, NOW)).toBe(2 * 60000);
});

test('мусорная дата → ждать нечего (fail-open, темп не блокирует отправку)', () => {
  expect(waitMsLeft('позавчера', 3, NOW)).toBe(0);
});

test('нечисловой интервал → ждать нечего', () => {
  expect(waitMsLeft(ago(0), 'три', NOW)).toBe(0);
});
