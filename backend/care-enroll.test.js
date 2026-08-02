'use strict';
const { isVisitCompleted, classifyRecordEvent } = require('./services/care/enroll');

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

describe('classifyRecordEvent', () => {
  test('payload.status=delete → unenroll, даже если визит выглядит состоявшимся', () => {
    expect(classifyRecordEvent({ attendance: 1, paid_full: 1 }, 'delete')).toBe('unenroll');
  });
  test('data.deleted===true → unenroll', () => {
    expect(classifyRecordEvent({ attendance: 1, deleted: true }, 'update')).toBe('unenroll');
  });
  test('attendance=-1 → unenroll даже без status=delete', () => {
    expect(classifyRecordEvent({ attendance: -1 }, 'update')).toBe('unenroll');
  });
  test('предоплаченный визит с неявкой (paid_full=1, attendance=-1) → unenroll, не enroll', () => {
    expect(classifyRecordEvent({ attendance: -1, paid_full: 1 }, 'update')).toBe('unenroll');
  });
  test('attendance=1 → enroll', () => {
    expect(classifyRecordEvent({ attendance: 1, paid_full: 0 }, 'update')).toBe('enroll');
  });
  test('paid_full=1 → enroll', () => {
    expect(classifyRecordEvent({ attendance: 2, paid_full: 1 }, 'update')).toBe('enroll');
  });
  test('ожидание (attendance=0, paid_full=0) → ignore', () => {
    expect(classifyRecordEvent({ attendance: 0, paid_full: 0 }, 'update')).toBe('ignore');
  });
  test('подтверждение без оплаты (attendance=2, paid_full=0) → ignore', () => {
    expect(classifyRecordEvent({ attendance: 2, paid_full: 0 }, 'create')).toBe('ignore');
  });
  test('пусто → ignore', () => {
    expect(classifyRecordEvent(null, 'update')).toBe('ignore');
  });
});
