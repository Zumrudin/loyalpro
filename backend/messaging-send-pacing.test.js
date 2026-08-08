'use strict';
// Темп плановых отправок.
const {
  waitMsLeft, lastPlannedSendAt, paceDeferMinutes, LAST_SENT_SQL,
  inDayWindow, sendTimeInDayWindow, DAY_WINDOW_START_MIN, DAY_WINDOW_END_MIN,
} = require('./services/messaging/send-pacing');

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

// max() поверх UNION ALL PostgreSQL не сводит к «первая строка индекса» —
// живой EXPLAIN давал скан ВСЕХ строк status='sent' каждой таблицы. Три
// отдельных max() под greatest() дают InitPlan → Limit → Index Only Scan.
test('SQL берёт три отдельных max() через greatest(), а не агрегат над UNION', () => {
  expect(LAST_SENT_SQL).toMatch(/greatest\(/i);
  expect(LAST_SENT_SQL).not.toMatch(/UNION/i);
  expect(LAST_SENT_SQL.match(/max\(/gi)).toHaveLength(3);
});

// ── потолок по времени суток ───────────────────────────────────────────────
// Без него пауза 30–120 мин выносит хвост рассылки в ночь живым пациентам, а
// send_time правила теряется после первого же отката (defer считает от NOW).
describe('paceDeferMinutes', () => {
  const msk = (hhmm, day = '08') => Date.parse(`2026-08-${day}T${hhmm}:00+03:00`);

  test('момент отправки внутри окна → ждём ровно паузу', () => {
    expect(paceDeferMinutes(msk('11:00'), 3 * 60000, '11:00')).toBe(3);
  });

  test('за верхней границей окна → перенос на send_time следующего дня', () => {
    // 20:50 + 30 мин = 21:20 (окно кончается в 21:00, конец исключительный);
    // сегодняшние 11:00 позади → завтра 11:00, это 14 ч 10 мин.
    expect(paceDeferMinutes(msk('20:50'), 30 * 60000, '11:00')).toBe(850);
  });

  test('за нижней границей окна → перенос на send_time сегодня', () => {
    expect(paceDeferMinutes(msk('07:00'), 30 * 60000, '11:00')).toBe(240);
  });

  test('границы окна: 09:00 включительно, 21:00 исключительно', () => {
    expect(paceDeferMinutes(msk('08:30'), 30 * 60000, '11:00')).toBe(30);   // ровно 09:00
    expect(paceDeferMinutes(msk('20:30'), 30 * 60000, '11:00')).not.toBe(30); // ровно 21:00
  });

  // Салон выбрал ночное время осознанно — переопределять его мы не вправе.
  test('send_time сам вне окна → потолок не применяется', () => {
    expect(paceDeferMinutes(msk('20:50'), 30 * 60000, '22:00')).toBe(30);
    expect(paceDeferMinutes(msk('07:00'), 30 * 60000, '06:30')).toBe(30);
  });

  // Границы ДВУХ проверок окна разные: момент отправки в 21:00 — уже вечер
  // (перенос), а send_time='21:00' — обычное круглое значение формы правила, и
  // читать его как «салон хочет ночную рассылку» нельзя. С исключительной
  // границей потолок не применялся вовсе, и хвост пачки шёл всю ночь.
  test('send_time=21:00 считается ВНУТРИ окна → потолок применяется', () => {
    // 20:50 + 30 мин = 21:20 (момент отправки вне окна) → ближайшие 21:00, то
    // есть завтра (сегодняшние уже позади): 24 ч 10 мин.
    expect(paceDeferMinutes(msk('20:50'), 30 * 60000, '21:00')).toBe(24 * 60 + 10);
    // 07:00 + 30 мин = 07:30 (до окна) → сегодня в 21:00.
    expect(paceDeferMinutes(msk('07:00'), 30 * 60000, '21:00')).toBe(14 * 60);
  });

  test('21:01 у send_time — уже вне окна, потолок не применяется', () => {
    expect(paceDeferMinutes(msk('20:50'), 30 * 60000, '21:01')).toBe(30);
  });

  test('переход через полночь → ближайшие send_time уже следующих суток', () => {
    // 23:50 + 30 мин = 00:20 следующего дня, вне окна → 11:00 того же дня.
    expect(paceDeferMinutes(msk('23:50'), 30 * 60000, '11:00')).toBe(670);
  });

  // Потолок только УДЛИНЯЕТ: «ближайшее наступление» считается от момента
  // отправки, иначе в узкой полосе он сократил бы саму паузу темпа.
  test('потолок никогда не сокращает паузу темпа', () => {
    // 19:00 + 120 мин = 21:00 (вне окна), а сегодняшние 20:00 ближе паузы.
    const mins = paceDeferMinutes(msk('19:00'), 120 * 60000, '20:00');
    expect(mins).toBe(25 * 60);
    expect(mins).toBeGreaterThanOrEqual(120);
  });

  // pg отдаёт time как '11:00:00'; битое значение — fail-open (потолок это
  // удобство пациента, а не гейт допуска).
  test('формат pg и мусор', () => {
    expect(paceDeferMinutes(msk('07:00'), 30 * 60000, '11:00:00')).toBe(240);
    expect(paceDeferMinutes(msk('07:00'), 30 * 60000, 'утром')).toBe(30);
    expect(paceDeferMinutes(msk('07:00'), 30 * 60000, null)).toBe(30);
  });
});

// Две проверки окна разведены намеренно, и границы у них РАЗНЫЕ — тест это
// фиксирует, чтобы «упрощение» до одного предиката снова не увело
// send_time='21:00' мимо потолка (рассылка всю ночь с шагом паузы).
describe('границы окна: момент отправки vs send_time правила', () => {
  test('начало окна включительно у обеих проверок', () => {
    expect(inDayWindow(DAY_WINDOW_START_MIN)).toBe(true);
    expect(sendTimeInDayWindow(DAY_WINDOW_START_MIN)).toBe(true);
    expect(inDayWindow(DAY_WINDOW_START_MIN - 1)).toBe(false);
    expect(sendTimeInDayWindow(DAY_WINDOW_START_MIN - 1)).toBe(false);
  });

  test('конец окна: у момента отправки исключительный, у send_time включительный', () => {
    expect(inDayWindow(DAY_WINDOW_END_MIN)).toBe(false);
    expect(sendTimeInDayWindow(DAY_WINDOW_END_MIN)).toBe(true);
    expect(inDayWindow(DAY_WINDOW_END_MIN - 1)).toBe(true);
    expect(sendTimeInDayWindow(DAY_WINDOW_END_MIN + 1)).toBe(false);
  });
});
