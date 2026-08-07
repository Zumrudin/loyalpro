'use strict';
// Какая отправленная строка журнала засчитывает себе новую запись клиента.
// Утверждено: окно 30 дней (настраивается в правиле), считаем и запись, и
// состоявшийся визит.
const { pickAttributionRow } = require('./services/reminders/attribution');

const CAT_MAP = new Map([['101', '9'], ['200', '7']]);
const HOUR = 3600000;
const NOW = Date.parse('2026-08-07T10:00:00Z');

const row = (over = {}) => ({
  id: 1,
  rule_id: 5,
  conditions: { logic: 'and', items: [{ type: 'category', ids: [9] }] },
  attribution_days: 30,
  sent_at: new Date(NOW - 24 * HOUR).toISOString(),
  conversion_record_id: null,
  ...over,
});

const booking = { services: [{ id: 101 }], staff: { id: 55 } };

test('свежая отправка под условия правила засчитывается', () => {
  expect(pickAttributionRow([row()], booking, CAT_MAP, NOW)).toMatchObject({ id: 1 });
});

test('запись чужой категории не засчитывается', () => {
  const other = { services: [{ id: 200 }], staff: { id: 55 } };
  expect(pickAttributionRow([row()], other, CAT_MAP, NOW)).toBeNull();
});

test('отправка старше окна атрибуции не засчитывается', () => {
  const old = row({ sent_at: new Date(NOW - 31 * 24 * HOUR).toISOString() });
  expect(pickAttributionRow([old], booking, CAT_MAP, NOW)).toBeNull();
});

// Граница окна включающая: ровно 30 дней ещё считается, 30 дней + час — нет.
test('граница окна', () => {
  const edge = row({ sent_at: new Date(NOW - 30 * 24 * HOUR).toISOString() });
  expect(pickAttributionRow([edge], booking, CAT_MAP, NOW)).toMatchObject({ id: 1 });
  const over = row({ sent_at: new Date(NOW - 30 * 24 * HOUR - HOUR).toISOString() });
  expect(pickAttributionRow([over], booking, CAT_MAP, NOW)).toBeNull();
});

test('уже размеченная строка второй раз не засчитывает', () => {
  expect(pickAttributionRow([row({ conversion_record_id: 99 })], booking, CAT_MAP, NOW)).toBeNull();
});

// Правило удалено — rule_id и conditions NULL, сверять запись не с чем.
test('строка без правила пропускается', () => {
  expect(pickAttributionRow([row({ rule_id: null, conditions: null })], booking, CAT_MAP, NOW)).toBeNull();
});

// Из нескольких подходящих строк конверсию забирает САМАЯ СВЕЖАЯ: именно она
// с наибольшей вероятностью и привела клиента.
test('из нескольких подходящих выбирается самая свежая', () => {
  const older = row({ id: 1, sent_at: new Date(NOW - 20 * 24 * HOUR).toISOString() });
  const newer = row({ id: 2, sent_at: new Date(NOW - 2 * 24 * HOUR).toISOString() });
  expect(pickAttributionRow([older, newer], booking, CAT_MAP, NOW)).toMatchObject({ id: 2 });
});

test('пустой список → null', () => {
  expect(pickAttributionRow([], booking, CAT_MAP, NOW)).toBeNull();
  expect(pickAttributionRow(null, booking, CAT_MAP, NOW)).toBeNull();
});

// pg отдаёт TIMESTAMPTZ объектом Date (не строкой) — боевая форма поля.
// Дублируем проверки границы окна и «побеждает самая свежая», но на Date.
test('sent_at объектом Date (боевая форма): граница окна считается так же', () => {
  const edge = row({ sent_at: new Date(NOW - 30 * 24 * HOUR) });
  expect(pickAttributionRow([edge], booking, CAT_MAP, NOW)).toMatchObject({ id: 1 });
  const over = row({ sent_at: new Date(NOW - 30 * 24 * HOUR - HOUR) });
  expect(pickAttributionRow([over], booking, CAT_MAP, NOW)).toBeNull();
});

test('sent_at объектом Date (боевая форма): побеждает самая свежая', () => {
  const older = row({ id: 1, sent_at: new Date(NOW - 20 * 24 * HOUR) });
  const newer = row({ id: 2, sent_at: new Date(NOW - 2 * 24 * HOUR) });
  expect(pickAttributionRow([older, newer], booking, CAT_MAP, NOW)).toMatchObject({ id: 2 });
});

// Date.parse на объекте Date идёт через неявный ToString и округляет до
// секунды — две отправки в одну секунду, отличающиеся только миллисекундами,
// должны различаться по свежести.
test('две отправки в одну секунду различаются по миллисекундам', () => {
  const earlier = row({ id: 1, sent_at: new Date(NOW - 24 * HOUR) });
  const later = row({ id: 2, sent_at: new Date(NOW - 24 * HOUR + 200) });
  expect(pickAttributionRow([earlier, later], booking, CAT_MAP, NOW)).toMatchObject({ id: 2 });
});
