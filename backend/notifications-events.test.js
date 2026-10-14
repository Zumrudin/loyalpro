'use strict';
const ev = require('./services/notifications/events');

const base = {
  status: 'create',
  data: {
    id: 100, datetime: '2026-10-20T13:30:00+03:00', date: '2026-10-20 13:30:00', seance_length: 3600,
    attendance: 0, deleted: false, sms_before: 24, client: { id: 7, phone: '+7 (920) 025-55-91', name: 'Иванова Анна' },
    staff: { id: 55, name: 'Татьяна' }, services: [{ id: 1, title: 'Пилинг' }], created_user_id: 13287477,
    short_link: 'https://yc.gl/c/x/y',
  },
};
const T = (iso) => new Date(iso).getTime();

describe('recordSnapshot', () => {
  test('нормализует телефон, момент визита и поля', () => {
    const s = ev.recordSnapshot(base);
    expect(s.recordId).toBe(100);
    expect(s.phone).toBe('79200255591');
    expect(s.visitAt).toBe(T('2026-10-20T13:30:00+03:00'));
    expect(s.seanceLength).toBe(3600);
    expect(s.smsBefore).toBe(24);
    expect(s.staffId).toBe(55);
    expect(s.services).toEqual([{ id: 1, title: 'Пилинг' }]);
    expect(s.createdUserId).toBe(13287477);
  });
  test('status=delete → deleted', () => {
    expect(ev.recordSnapshot({ ...base, status: 'delete' }).deleted).toBe(true);
  });
  test('без datetime берёт date как московское время', () => {
    const s = ev.recordSnapshot({ ...base, data: { ...base.data, datetime: undefined } });
    expect(s.visitAt).toBe(T('2026-10-20T13:30:00+03:00'));
  });
});

describe('classifyRecordEvent', () => {
  const snap = ev.recordSnapshot(base);
  test('первое появление с create → created', () => {
    expect(ev.classifyRecordEvent(null, snap)).toMatchObject({ created: true, rescheduled: false, cancelled: false, arrived: false });
  });
  test('первое появление с update → не created (только состояние)', () => {
    const upd = ev.recordSnapshot({ ...base, status: 'update' });
    expect(ev.classifyRecordEvent(null, upd).created).toBe(false);
  });
  test('смена datetime → rescheduled', () => {
    const moved = ev.recordSnapshot({ ...base, status: 'update', data: { ...base.data, datetime: '2026-10-21T10:00:00+03:00' } });
    expect(ev.classifyRecordEvent(snap, moved)).toMatchObject({ rescheduled: true, created: false });
  });
  test('deleted → cancelled один раз', () => {
    const del = ev.recordSnapshot({ ...base, status: 'update', data: { ...base.data, deleted: true } });
    expect(ev.classifyRecordEvent(snap, del)).toMatchObject({ cancelled: true, noShow: false });
    expect(ev.classifyRecordEvent(del, del).cancelled).toBe(false);
  });
  test('attendance=-1 → cancelled + noShow', () => {
    const ns = ev.recordSnapshot({ ...base, status: 'update', data: { ...base.data, attendance: -1 } });
    expect(ev.classifyRecordEvent(snap, ns)).toMatchObject({ cancelled: true, noShow: true });
  });
  test('attendance 0→1 → arrived, 1→1 нет', () => {
    const arr = ev.recordSnapshot({ ...base, status: 'update', data: { ...base.data, attendance: 1 } });
    expect(ev.classifyRecordEvent(snap, arr).arrived).toBe(true);
    expect(ev.classifyRecordEvent(arr, arr).arrived).toBe(false);
  });
  test('attendance=2 → confirmed', () => {
    const c = ev.recordSnapshot({ ...base, status: 'update', data: { ...base.data, attendance: 2 } });
    expect(ev.classifyRecordEvent(snap, c).confirmed).toBe(true);
  });
});

describe('reminderAt', () => {
  const snap = ev.recordSnapshot(base);           // визит 20.10 13:30 мск
  test('за hours_before правила', () => {
    expect(ev.reminderAt(snap, { hours_before: 24 }, {}, T('2026-10-18T10:00:00+03:00')))
      .toBe(T('2026-10-19T13:30:00+03:00'));
  });
  test('sms_before записи перекрывает правило', () => {
    const s = { ...snap, smsBefore: 2 };
    expect(ev.reminderAt(s, { hours_before: 24 }, {}, T('2026-10-18T10:00:00+03:00')))
      .toBe(T('2026-10-20T11:30:00+03:00'));
  });
  test('момент уже прошёл → null (YClients тоже не шлёт)', () => {
    expect(ev.reminderAt(snap, { hours_before: 24 }, {}, T('2026-10-19T14:00:00+03:00'))).toBeNull();
  });
  test('тихие часы сдвигают на quiet_to', () => {
    const night = { ...snap, visitAt: T('2026-10-20T23:00:00+03:00') };  // напоминание в 23:00 19.10
    expect(ev.reminderAt(night, { hours_before: 24 }, { quiet_from: '22:00', quiet_to: '09:00' }, T('2026-10-18T10:00:00+03:00')))
      .toBe(T('2026-10-20T09:00:00+03:00'));
  });
  test('сдвиг тихими часами за момент визита → null', () => {
    const early = { ...snap, visitAt: T('2026-10-20T08:00:00+03:00'), smsBefore: 2 };
    expect(ev.reminderAt(early, { hours_before: 24 }, { quiet_from: '22:00', quiet_to: '09:00' }, T('2026-10-18T10:00:00+03:00'))).toBeNull();
  });
});

describe('afterVisitAt', () => {
  const snap = ev.recordSnapshot(base);
  test('конец визита + delay', () => {
    expect(ev.afterVisitAt(snap, 5, T('2026-10-20T13:40:00+03:00'))).toBe(T('2026-10-20T14:35:00+03:00'));
  });
  test('«пришёл» поставлен после окончания → от now', () => {
    expect(ev.afterVisitAt(snap, 5, T('2026-10-20T15:00:00+03:00'))).toBe(T('2026-10-20T15:05:00+03:00'));
  });
});

describe('applyQuietHours', () => {
  test('вне окна — без изменений', () => {
    const t = T('2026-10-20T12:00:00+03:00');
    expect(ev.applyQuietHours(t, { quiet_from: '22:00', quiet_to: '09:00' })).toBe(t);
  });
  test('ночью → ближайшее quiet_to', () => {
    expect(ev.applyQuietHours(T('2026-10-20T01:30:00+03:00'), { quiet_from: '22:00', quiet_to: '09:00' }))
      .toBe(T('2026-10-20T09:00:00+03:00'));
    expect(ev.applyQuietHours(T('2026-10-20T22:30:00+03:00'), { quiet_from: '22:00', quiet_to: '09:00' }))
      .toBe(T('2026-10-21T09:00:00+03:00'));
  });
  test('битые границы → без изменений', () => {
    const t = T('2026-10-20T01:30:00+03:00');
    expect(ev.applyQuietHours(t, { quiet_from: '25:00', quiet_to: '09:00' })).toBe(t);
    expect(ev.applyQuietHours(t, {})).toBe(t);
  });
});
