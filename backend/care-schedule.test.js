'use strict';
const { parseVisitAt, computeScheduledAt, plusOneDay } = require('./services/care/schedule');

describe('care schedule', () => {
  test('parseVisitAt: строка YClients (салон-локальная = мск) → Date', () => {
    const d = parseVisitAt('2026-08-02 14:00:00');
    expect(d.toISOString()).toBe('2026-08-02T11:00:00.000Z'); // 14:00 мск
  });
  test('parseVisitAt: мусор → null', () => {
    expect(parseVisitAt('')).toBeNull();
    expect(parseVisitAt('не дата')).toBeNull();
  });
  test('Т+1 в 10:30 мск', () => {
    const visit = parseVisitAt('2026-08-02 14:00:00');
    expect(computeScheduledAt(visit, 1, '10:30').toISOString())
      .toBe('2026-08-03T07:30:00.000Z');
  });
  test('вечерний визит не сдвигает дату (день считается по мск-дате визита)', () => {
    const visit = parseVisitAt('2026-08-02 23:30:00'); // 20:30Z
    expect(computeScheduledAt(visit, 1, '10:30').toISOString())
      .toBe('2026-08-03T07:30:00.000Z');
  });
  test('retention 120 дней', () => {
    const visit = parseVisitAt('2026-08-02 14:00:00');
    expect(computeScheduledAt(visit, 120, '11:00').toISOString())
      .toBe('2026-11-30T08:00:00.000Z');
  });
  test('битый send_time → дефолт 10:30', () => {
    const visit = parseVisitAt('2026-08-02 14:00:00');
    expect(computeScheduledAt(visit, 1, '99:99').toISOString())
      .toBe('2026-08-03T07:30:00.000Z');
  });
  test('plusOneDay: +24ч (анти-спам сдвигает, не скипает)', () => {
    expect(plusOneDay(new Date('2026-08-03T07:30:00Z')).toISOString())
      .toBe('2026-08-04T07:30:00.000Z');
  });
});
