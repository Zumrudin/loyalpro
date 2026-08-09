const { test } = require('node:test');
const assert = require('node:assert');
const { remPlanDayLabel, remPlanDayFinish } = require('./reminders-plan');

test('день показывается как дд.мм без разбора Date', () => {
  // Строку 'YYYY-MM-DD' нельзя гонять через new Date(): браузер разберёт её как
  // UTC-полночь, и в минусовых поясах день уедет на предыдущий.
  assert.strictEqual(remPlanDayLabel('2026-08-10'), '10.08');
  assert.strictEqual(remPlanDayLabel('2026-10-06'), '06.10');
  assert.strictEqual(remPlanDayLabel('чепуха'), '—');
  assert.strictEqual(remPlanDayLabel(null), '—');
});

test('одно сообщение в дне — оценки конца нет', () => {
  assert.strictEqual(remPlanDayFinish('11:00', 1, 3), null);
});

test('пауза 0 (или не задана) — очередь уходит пачкой, конца не считаем', () => {
  assert.strictEqual(remPlanDayFinish('11:00', 30, 0), null);
  assert.strictEqual(remPlanDayFinish('11:00', 30, null), null);
});

test('последняя отправка = первая + (n-1) пауз', () => {
  // 32 строки по 3 минуты: 31 пауза = 93 минуты от 11:00.
  const r = remPlanDayFinish('11:00', 32, 3);
  assert.strictEqual(r.text, '12:33');
  assert.strictEqual(r.overflow, false);
  assert.strictEqual(r.fits, 32);
});

test('что не влезло до 21:00 — уедет на следующий день', () => {
  // Дневной потолок темпа (paceDeferMinutes): отправка, попадающая вне
  // окна 09:00–21:00, переносится на следующее наступление send_time.
  const r = remPlanDayFinish('11:00', 300, 30);
  assert.strictEqual(r.overflow, true);
  // С 11:00 по 30 минут до 21:00 включительно помещается 21 отправка
  // (11:00 … 21:00 — это 20 шагов), а 21:00 — уже вне окна, значит 20.
  assert.strictEqual(r.fits, 20);
});

test('ровно упирающаяся в 21:00 партия считается не влезшей целиком', () => {
  // 11:00 + 20 шагов по 30 = 21:00, а конец окна ИСКЛЮЧАЮЩИЙ (inDayWindow).
  const r = remPlanDayFinish('11:00', 21, 30);
  assert.strictEqual(r.overflow, true);
  assert.strictEqual(r.fits, 20);
});

test('битое время старта не роняет блок', () => {
  assert.strictEqual(remPlanDayFinish('чепуха', 10, 3), null);
  assert.strictEqual(remPlanDayFinish(null, 10, 3), null);
});
