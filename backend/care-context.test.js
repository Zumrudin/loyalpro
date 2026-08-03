'use strict';
const { splitRecords, hasMatchingRepeatVisit } = require('./services/care/context');

const anchorMs = Date.parse('2026-08-02T11:00:00Z');
const nowMs = Date.parse('2026-08-10T09:00:00Z');
const recs = [
  { id: 1, datetime: '2026-08-02T14:00:00+03:00', attendance: 1, services: [{ id: 10, title: 'Биорев' }] },      // сам якорь
  { id: 2, datetime: '2026-08-06T12:00:00+03:00', attendance: 1, services: [{ id: 10, title: 'Биорев' }] },      // повторный визит
  { id: 3, datetime: '2026-08-20T14:00:00+03:00', attendance: 0, services: [{ id: 30, title: 'Чистка' }], staff_id: 5 }, // будущая
  { id: 4, datetime: '2026-08-05T10:00:00+03:00', attendance: -1, services: [{ id: 10, title: 'Биорев' }] },     // не пришёл
];

describe('splitRecords', () => {
  test('делит на состоявшиеся-после-якоря и будущие', () => {
    const { completedAfter, future } = splitRecords(recs, anchorMs, nowMs);
    expect(completedAfter.map(r => r.id)).toEqual([2]);   // якорь и «не пришёл» отброшены
    expect(future.map(r => r.id)).toEqual([3]);
  });
});

describe('hasMatchingRepeatVisit', () => {
  const catMap = new Map([['10', '100']]);
  test('повторный визит по условиям программы найден', () => {
    const conditions = { logic: 'and', items: [{ type: 'service', ids: [10] }] };
    const { completedAfter } = splitRecords(recs, anchorMs, nowMs);
    expect(hasMatchingRepeatVisit(completedAfter, conditions, catMap)).toBe(true);
  });
  test('условия не совпали → false', () => {
    const conditions = { logic: 'and', items: [{ type: 'service', ids: [999] }] };
    const { completedAfter } = splitRecords(recs, anchorMs, nowMs);
    expect(hasMatchingRepeatVisit(completedAfter, conditions, catMap)).toBe(false);
  });
  test('пустые условия (программа «на любую запись») → любой повтор считается', () => {
    const { completedAfter } = splitRecords(recs, anchorMs, nowMs);
    expect(hasMatchingRepeatVisit(completedAfter, { logic: 'and', items: [] }, catMap)).toBe(true);
  });

  test('staff-условие матчится и через staff_id, и через r.staff.id', () => {
    const conditions = { logic: 'and', items: [{ type: 'staff', ids: [5] }] };
    const viaStaffId = [{ id: 90, datetime: '2026-08-06T12:00:00+03:00', attendance: 1, services: [], staff_id: 5 }];
    const viaStaffObj = [{ id: 91, datetime: '2026-08-06T12:00:00+03:00', attendance: 1, services: [], staff: { id: 5 } }];
    expect(hasMatchingRepeatVisit(viaStaffId, conditions, catMap)).toBe(true);
    expect(hasMatchingRepeatVisit(viaStaffObj, conditions, catMap)).toBe(true);
  });
});

describe('splitRecords — граничные случаи', () => {
  test('deleted:true отбрасывается целиком (ни completedAfter, ни future)', () => {
    const deletedRec = [{ id: 100, datetime: '2026-08-06T12:00:00+03:00', attendance: 1, deleted: true, services: [] }];
    const { completedAfter, future } = splitRecords(deletedRec, anchorMs, nowMs);
    expect(completedAfter).toEqual([]);
    expect(future).toEqual([]);
  });

  test('битая дата отбрасывается', () => {
    const brokenRec = [{ id: 101, datetime: 'не дата', attendance: 1, services: [] }];
    const { completedAfter, future } = splitRecords(brokenRec, anchorMs, nowMs);
    expect(completedAfter).toEqual([]);
    expect(future).toEqual([]);
  });

  test('att=2 (подтверждено, исход не проставлен) в прошлом не попадает никуда', () => {
    const confirmedPastRec = [{ id: 102, datetime: '2026-08-06T12:00:00+03:00', attendance: 2, services: [] }];
    const { completedAfter, future } = splitRecords(confirmedPastRec, anchorMs, nowMs);
    expect(completedAfter).toEqual([]);
    expect(future).toEqual([]);
  });

  test('«голая» строка datetime (без TZ) интерпретируется как московская — тот же результат, что и с явным +03:00', () => {
    const bare = [{ id: 103, datetime: '2026-08-06 12:00:00', attendance: 1, services: [] }];
    const withTz = [{ id: 103, datetime: '2026-08-06T12:00:00+03:00', attendance: 1, services: [] }];
    const bareResult = splitRecords(bare, anchorMs, nowMs);
    const tzResult = splitRecords(withTz, anchorMs, nowMs);
    expect(bareResult.completedAfter.map(r => r.id)).toEqual(tzResult.completedAfter.map(r => r.id));
    expect(bareResult.future.map(r => r.id)).toEqual(tzResult.future.map(r => r.id));
  });
});
