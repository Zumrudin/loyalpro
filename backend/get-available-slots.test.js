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
