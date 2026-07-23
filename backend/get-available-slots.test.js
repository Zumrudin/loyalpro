'use strict';
const { seancesToRanges, rangesToSlots } = require('./services/agent/tools/get-available-slots');

// 5-мин грид is_free → интервалы (поведение не меняем).
describe('seancesToRanges', () => {
  test('склеивает соседние свободные 5-минутки в интервал', () => {
    const seances = [
      { time: '19:00', is_free: true },
      { time: '19:05', is_free: true },
      { time: '19:10', is_free: true },
    ];
    expect(seancesToRanges(seances)).toEqual([{ start: 1140, end: 1155 }]);
  });
});

// Регресс на баг «слоты со сдвигом на 5 минут» (#2/#3): старты обязаны попадать
// на чистую сетку :00/:30, а не наследовать смещённый r.start от предыдущей записи.
describe('rangesToSlots — привязка к чистой сетке', () => {
  test('окно, начатое в 18:05, отдаёт 18:30/19:00/19:30/20:00 — без :05', () => {
    const ranges = [{ start: 18 * 60 + 5, end: 20 * 60 + 35 }]; // [18:05, 20:35)
    const slots = rangesToSlots(ranges, '2026-07-22', 30).map(s => s.time);
    expect(slots).toEqual(['18:30', '19:00', '19:30', '20:00']);
  });

  test('свободное 19:00 и 20:00 не теряются, когда окно шире', () => {
    const ranges = [{ start: 19 * 60 + 5, end: 21 * 60 }]; // [19:05, 21:00)
    const slots = rangesToSlots(ranges, '2026-07-22', 30).map(s => s.time);
    expect(slots).toContain('19:30');
    expect(slots).toContain('20:00');
    expect(slots.some(t => t.endsWith(':05'))).toBe(false);
  });

  test('окно, уже стоящее на сетке, не смещается', () => {
    const ranges = [{ start: 14 * 60, end: 16 * 60 }]; // [14:00, 16:00)
    const slots = rangesToSlots(ranges, '2026-07-22', 30).map(s => s.time);
    expect(slots).toEqual(['14:00', '14:30', '15:00', '15:30']);
  });

  test('datetime несёт московское смещение +03:00', () => {
    const slots = rangesToSlots([{ start: 600, end: 660 }], '2026-07-22', 30);
    expect(slots[0].datetime).toBe('2026-07-22T10:00:00+03:00');
  });
});

// Услуга должна влезать в окно мастера ЦЕЛИКОМ (как в get_parallel_slots), а не
// первые 30 минут: иначе 60-минутная процедура попадает в хвост окна и упирается
// в занятое кресло уже на create_booking.
describe('rangesToSlots — полная длительность услуги', () => {
  // Интервалы в минутах от полуночи: 19:00–20:00 = {start: 1140, end: 1200}.
  const win = [{ start: 1140, end: 1200 }];

  test('60-минутная услуга в часовом окне — только 19:00', () => {
    const slots = rangesToSlots(win, '2026-07-24', 30, 60);
    expect(slots.map(s => s.time)).toEqual(['19:00']);
  });

  test('30-минутная услуга — 19:00 и 19:30, как раньше', () => {
    const slots = rangesToSlots(win, '2026-07-24', 30, 30);
    expect(slots.map(s => s.time)).toEqual(['19:00', '19:30']);
  });

  test('45 минут — старт 19:30 отпадает (19:30+45 > 20:00), остаётся 19:00', () => {
    const slots = rangesToSlots(win, '2026-07-24', 30, 45);
    expect(slots.map(s => s.time)).toEqual(['19:00']);
  });

  test('услуга длиннее окна — слотов нет', () => {
    const slots = rangesToSlots(win, '2026-07-24', 30, 90);
    expect(slots).toEqual([]);
  });

  test('длительность неизвестна (0/не передана) — прежнее поведение по шагу', () => {
    expect(rangesToSlots(win, '2026-07-24', 30, 0).map(s => s.time))
      .toEqual(['19:00', '19:30']);
    expect(rangesToSlots(win, '2026-07-24', 30).map(s => s.time))
      .toEqual(['19:00', '19:30']);
  });

  test('длительность не ломает привязку к чистой сетке (окно 18:05–20:00, 60 мин)', () => {
    const slots = rangesToSlots([{ start: 1085, end: 1200 }], '2026-07-24', 30, 60);
    expect(slots.map(s => s.time)).toEqual(['18:30', '19:00']);
  });
});
