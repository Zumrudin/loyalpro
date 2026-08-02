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
});
