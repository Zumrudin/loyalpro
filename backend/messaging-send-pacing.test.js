'use strict';
// Темп плановых отправок.
const { waitMsLeft, lastPlannedSendAt, LAST_SENT_SQL } = require('./services/messaging/send-pacing');

const NOW = Date.parse('2026-08-08T11:00:00+03:00');
const ago = (min) => new Date(NOW - min * 60000);

// SQL смотрит ВСЕ ТРИ плановые очереди — без этой проверки правку UNION
// (например, потерю ветки notification_sends) можно молча проехать.
test('SQL смотрит все три очереди', () => {
  expect(LAST_SENT_SQL).toContain('care_touch_sends');
  expect(LAST_SENT_SQL).toContain('reminder_queue');
  expect(LAST_SENT_SQL).toContain('notification_sends');
});

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

// Часы БД (Beget) и приложения — разные машины: одиночный «будущий» sent_at
// не должен отодвигать отправку дальше самого интервала.
test('lastAt в будущем → ожидание не превышает сам интервал', () => {
  const future = new Date(NOW + 10 * 3600000); // +10 часов
  expect(waitMsLeft(future, 3, NOW)).toBe(3 * 60000);
});

test('lastPlannedSendAt: непустой ответ → Date', async () => {
  const db = { oneOrNone: jest.fn(async () => ({ last_at: ago(5) })) };
  const result = await lastPlannedSendAt(db, 1);
  expect(result).toBeInstanceOf(Date);
  expect(db.oneOrNone).toHaveBeenCalledWith(LAST_SENT_SQL, [1]);
});

// max() на пустой выборке отвечает СТРОКОЙ с last_at=null, а не отсутствием
// строки — это второй guard в lastPlannedSendAt, не только db.oneOrNone.
test('lastPlannedSendAt: max() на пустой выборке → null', async () => {
  const db = { oneOrNone: jest.fn(async () => ({ last_at: null })) };
  await expect(lastPlannedSendAt(db, 1)).resolves.toBeNull();
});
