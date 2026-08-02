'use strict';
const { isVisitCompleted } = require('./services/care/enroll');

describe('isVisitCompleted', () => {
  test('attendance=1 → визит состоялся', () => {
    expect(isVisitCompleted({ attendance: 1, paid_full: 0 })).toBe(true);
  });
  test('paid_full=1 → визит состоялся (даже при attendance=2)', () => {
    expect(isVisitCompleted({ attendance: 2, paid_full: 1 })).toBe(true);
  });
  test('ожидание/не пришёл/подтвердил без оплаты → нет', () => {
    expect(isVisitCompleted({ attendance: 0, paid_full: 0 })).toBe(false);
    expect(isVisitCompleted({ attendance: -1, paid_full: 0 })).toBe(false);
    expect(isVisitCompleted({ attendance: 2, paid_full: 0 })).toBe(false);
  });
  test('строковые значения из payload', () => {
    expect(isVisitCompleted({ attendance: '1' })).toBe(true);
    expect(isVisitCompleted({ paid_full: '1' })).toBe(true);
  });
  test('пусто → нет', () => {
    expect(isVisitCompleted({})).toBe(false);
    expect(isVisitCompleted(null)).toBe(false);
  });
});
