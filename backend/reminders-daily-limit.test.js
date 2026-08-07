'use strict';
// Анти-спам общий для «Заботы» и напоминаний: клиент не должен получить в один
// день и «как самочувствие», и «пора повторить». Проверяем, что запрос
// действительно смотрит В ОБЕ очереди и считает московские сутки.
const { sentTodayExists, SENT_TODAY_SQL } = require('./services/messaging/daily-limit');

test('SQL смотрит обе очереди', () => {
  expect(SENT_TODAY_SQL).toContain('care_touch_sends');
  expect(SENT_TODAY_SQL).toContain('reminder_queue');
});

// Сервер живёт в Europe/Moscow, но «сутки» обязаны считаться явно: без
// AT TIME ZONE граница дня уедет вместе с TZ процесса.
test('сутки считаются по Москве', () => {
  expect(SENT_TODAY_SQL).toContain(`AT TIME ZONE 'Europe/Moscow'`);
});

test('строка найдена → true', async () => {
  const db = { oneOrNone: jest.fn(async () => ({ ok: 1 })) };
  await expect(sentTodayExists(db, 1, '79001234567')).resolves.toBe(true);
  expect(db.oneOrNone).toHaveBeenCalledWith(SENT_TODAY_SQL, [1, '79001234567']);
});

test('строки нет → false', async () => {
  const db = { oneOrNone: jest.fn(async () => null) };
  await expect(sentTodayExists(db, 1, '79001234567')).resolves.toBe(false);
});
