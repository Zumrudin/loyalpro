'use strict';

// Минимальный срок до визита: день в день +2ч; заявка в 22:00+ на завтра — с 12:00.
// Чистая арифметика без БД/сети.

const lt = require('./services/agent/lead-time');

const NOW = (date, hh, mm = 0) => ({ date, minutes: hh * 60 + mm });

describe('minStartMin — день в день (+2 часа)', () => {
  test('днём: сейчас 12:00 → на сегодня не раньше 14:00', () => {
    expect(lt.minStartMin(NOW('2026-08-01', 12), '2026-08-01')).toBe(14 * 60);
  });
  test('floor включительный: слот ровно now+2ч валиден (>= floor)', () => {
    const floor = lt.minStartMin(NOW('2026-08-01', 9, 30), '2026-08-01');
    expect(floor).toBe(11 * 60 + 30);
  });
  test('поздний вечер на сегодня: floor уходит за полночь — записать нельзя ничего', () => {
    expect(lt.minStartMin(NOW('2026-08-01', 22, 30), '2026-08-01')).toBe(24 * 60 + 30);
  });
});

describe('minStartMin — ночная заявка на сегодня (с 12:00)', () => {
  test('в 02:00 на сегодня → не раньше 12:00 (а не 04:00 по правилу +2ч)', () => {
    expect(lt.minStartMin(NOW('2026-08-01', 2), '2026-08-01')).toBe(12 * 60);
  });
  test('в 06:59 ещё ночь → с 12:00', () => {
    expect(lt.minStartMin(NOW('2026-08-01', 6, 59), '2026-08-01')).toBe(12 * 60);
  });
  test('в 07:00 ночь кончилась → обычные +2 часа (09:00)', () => {
    expect(lt.minStartMin(NOW('2026-08-01', 7), '2026-08-01')).toBe(9 * 60);
  });
  test('ночью на завтра ограничений нет (это уже не «следующий день» вечерней заявки)', () => {
    expect(lt.minStartMin(NOW('2026-08-01', 2), '2026-08-02')).toBe(0);
  });
});

describe('minStartMin — вечерняя заявка на завтра (с 12:00)', () => {
  test('в 22:00 ровно уже действует: завтра не раньше 12:00', () => {
    expect(lt.minStartMin(NOW('2026-08-01', 22), '2026-08-02')).toBe(12 * 60);
  });
  test('в 21:59 ещё НЕ действует', () => {
    expect(lt.minStartMin(NOW('2026-08-01', 21, 59), '2026-08-02')).toBe(0);
  });
  test('в 23:59 действует', () => {
    expect(lt.minStartMin(NOW('2026-08-01', 23, 59), '2026-08-02')).toBe(12 * 60);
  });
  test('через границу месяца: 31 июля 22:30 → 1 августа с 12:00', () => {
    expect(lt.minStartMin(NOW('2026-07-31', 22, 30), '2026-08-01')).toBe(12 * 60);
  });
  test('послезавтра ограничений нет', () => {
    expect(lt.minStartMin(NOW('2026-08-01', 23), '2026-08-03')).toBe(0);
  });
  test('обычный день в будущем без ограничений', () => {
    expect(lt.minStartMin(NOW('2026-08-01', 12), '2026-08-05')).toBe(0);
  });
});

describe('violation — guard для create_booking/reschedule_booking', () => {
  test('день в день ближе 2 часов → нарушение с floor', () => {
    const v = lt.violation(NOW('2026-08-01', 12), '2026-08-01T13:00:00+03:00');
    expect(v).toEqual({ date: '2026-08-01', floor: 14 * 60, sameDay: true, night: false });
    expect(lt.violationHint(v)).toMatch(/14:00/);
  });
  test('день в день ровно через 2 часа → допустимо', () => {
    expect(lt.violation(NOW('2026-08-01', 12), '2026-08-01T14:00:00+03:00')).toBeNull();
  });
  test('вечером на завтра 10:00 → нарушение, hint про 12:00', () => {
    const v = lt.violation(NOW('2026-08-01', 22, 30), '2026-08-02T10:00:00+03:00');
    expect(v).toEqual({ date: '2026-08-02', floor: 12 * 60, sameDay: false, night: false });
    expect(lt.violationHint(v)).toMatch(/12:00/);
  });
  test('ночью (02:00) на сегодня 09:00 → нарушение night, hint про 12:00', () => {
    const v = lt.violation(NOW('2026-08-01', 2), '2026-08-01T09:00:00+03:00');
    expect(v).toEqual({ date: '2026-08-01', floor: 12 * 60, sameDay: true, night: true });
    expect(lt.violationHint(v)).toMatch(/только с 12:00/);
  });
  test('ночью на сегодня 12:00 → допустимо', () => {
    expect(lt.violation(NOW('2026-08-01', 2), '2026-08-01T12:00:00+03:00')).toBeNull();
  });
  test('вечером на завтра 12:00 → допустимо', () => {
    expect(lt.violation(NOW('2026-08-01', 22, 30), '2026-08-02T12:00:00+03:00')).toBeNull();
  });
  test('вечером на сегодня (floor за полночь) → hint «на сегодня записи больше нет»', () => {
    const v = lt.violation(NOW('2026-08-01', 22, 30), '2026-08-01T23:30:00+03:00');
    expect(v.sameDay).toBe(true);
    expect(lt.violationHint(v)).toMatch(/на сегодня записи больше нет/);
  });
  test('днём на завтра ограничений нет', () => {
    expect(lt.violation(NOW('2026-08-01', 12), '2026-08-02T09:00:00+03:00')).toBeNull();
  });
  test('кривой datetime → fail-open (null), отловят другие проверки', () => {
    expect(lt.violation(NOW('2026-08-01', 12), 'завтра в десять')).toBeNull();
    expect(lt.violation(NOW('2026-08-01', 12), null)).toBeNull();
  });
  test('формат с пробелом вместо T тоже разбирается', () => {
    const v = lt.violation(NOW('2026-08-01', 22, 30), '2026-08-02 10:00');
    expect(v && v.floor).toBe(12 * 60);
  });
});
