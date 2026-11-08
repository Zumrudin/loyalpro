'use strict';
const { execFileSync } = require('child_process');
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
  const phoneOf = (raw) => ev.recordSnapshot({ ...base, data: { ...base.data, client: { id: 7, phone: raw } } }).phone;
  test('телефон — только канон 7XXXXXXXXXX: 8→7, 10-значное ядро дополняется, прочее → null', () => {
    expect(phoneOf('89200255591')).toBe('79200255591');
    expect(phoneOf('9200255591')).toBe('79200255591');
    expect(phoneOf('+7 (920) 025-55-91')).toBe('79200255591');
  });
  test('мусор вместо телефона → null, а не truthy «7»', () => {
    // normalizePhoneKey('+7') отдаёт '7' — строка истинна, и job вставился бы без адресата.
    for (const junk of ['+7', '7', '8', '123', '', null, undefined, 'нет', '375291234567', '19171234567']) {
      expect(phoneOf(junk)).toBeNull();
    }
    expect(ev.recordSnapshot({ ...base, data: { ...base.data, client: undefined } }).phone).toBeNull();
  });
});

describe('parseVisitAt', () => {
  const MSK = T('2026-10-20T13:30:00+03:00');
  test('смещение в строке главнее: +03:00, +0300, Z, чужой пояс', () => {
    expect(ev.parseVisitAt('2026-10-20T13:30:00+03:00', '')).toBe(MSK);
    expect(ev.parseVisitAt('2026-10-20T13:30:00+0300', '')).toBe(MSK);
    expect(ev.parseVisitAt('2026-10-20T10:30:00Z', '')).toBe(MSK);
    expect(ev.parseVisitAt('2026-10-20T15:30:00+05:00', '')).toBe(MSK);
    expect(ev.parseVisitAt('2026-10-20T05:30:00-05:00', '')).toBe(MSK);
  });
  test('datetime БЕЗ смещения — московские стенные часы, а не пояс процесса', () => {
    expect(ev.parseVisitAt('2026-10-20T13:30:00', '')).toBe(MSK);
    expect(ev.parseVisitAt('2026-10-20 13:30:00', '')).toBe(MSK);
    expect(ev.parseVisitAt('2026-10-20T13:30', '')).toBe(MSK);
  });
  test('на UTC-хосте (дев-сервер) то же самое: Date.parse без смещения читает ЛОКАЛЬНОЕ время', () => {
    // Jest идёт в TZ=Europe/Moscow (globalSetup), и там ошибка невидима: локальное время = московское.
    // Поэтому проверка — в дочернем процессе с TZ=UTC.
    const out = execFileSync(process.execPath, ['-e',
      `const ev = require(${JSON.stringify(require.resolve('./services/notifications/events'))});
       process.stdout.write(JSON.stringify([ev.parseVisitAt('2026-10-20T13:30:00', ''), ev.parseVisitAt('2026-10-20 13:30:00', ''),
         ev.parseVisitAt('2026-10-20T13:30:00+03:00', '')]));`],
    { env: { ...process.env, TZ: 'UTC' }, encoding: 'utf8' });
    expect(JSON.parse(out)).toEqual([MSK, MSK, MSK]);
  });
  test('нет или мусор в datetime → берётся date (московское время)', () => {
    expect(ev.parseVisitAt(undefined, '2026-10-20 13:30:00')).toBe(MSK);
    expect(ev.parseVisitAt('', '2026-10-20 13:30:00')).toBe(MSK);
    expect(ev.parseVisitAt('вчера', '2026-10-20 13:30:00')).toBe(MSK);
  });
  test('ничего разборчивого → null', () => {
    expect(ev.parseVisitAt(undefined, undefined)).toBeNull();
    expect(ev.parseVisitAt('', '')).toBeNull();
    expect(ev.parseVisitAt('2026-10-20', '2026-10-20')).toBeNull();
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

  // update может прийти РАНЬШЕ create (в реальных вебхуках 3 записи из 1 363, на 14–411 мс): тогда к
  // приходу create состояние уже сохранено, и «нет prev» как условие created потеряло бы «Вы записаны».
  describe('create при уже известном состоянии записи', () => {
    const upd = (over) => ev.recordSnapshot({ ...base, status: 'update', data: { ...base.data, ...over } });
    test('update опередил create → created (письмо «Вы записаны» не теряется)', () => {
      const early = upd({});
      expect(ev.classifyRecordEvent(early, snap)).toMatchObject({ created: true, rescheduled: false, cancelled: false, restored: false });
    });
    test('дубль create тоже created — повтор режет уникальный ключ job-а, а не классификатор', () => {
      expect(ev.classifyRecordEvent(snap, snap).created).toBe(true);
    });
    test('create по записи, которая уже отменена (create несёт отмену) → не created', () => {
      const cancelled = ev.recordSnapshot({ ...base, status: 'create', data: { ...base.data, attendance: -1 } });
      expect(ev.classifyRecordEvent(upd({}), cancelled).created).toBe(false);
      const deleted = ev.recordSnapshot({ ...base, status: 'create', data: { ...base.data, deleted: true } });
      expect(ev.classifyRecordEvent(upd({}), deleted).created).toBe(false);
    });
    test('create никогда не означает перенос: время в create отличается от известного → rescheduled=false', () => {
      const early = upd({ datetime: '2026-10-21T10:00:00+03:00' });
      expect(ev.classifyRecordEvent(early, snap)).toMatchObject({ created: true, rescheduled: false });
    });
    test('не create (update) при известном состоянии по-прежнему не created', () => {
      expect(ev.classifyRecordEvent(snap, upd({})).created).toBe(false);
    });

    // create при известном состоянии — это либо update, опередивший create, либо ПОЗДНИЙ ДУБЛЬ. Снимок такого create
    // несёт данные момента создания, а не нынешние, поэтому по нему ничего, кроме «запись создана», сказать нельзя:
    // иначе дубль «возвращал» из отмены, «переносил» на старое время и «отмечал приход» задним числом.
    describe('поздний create (prev есть): из всех видов остаётся только created', () => {
      const createSnap = (over) => ev.recordSnapshot({ ...base, status: 'create', data: { ...base.data, ...over } });
      const ALL_OFF = { rescheduled: false, restored: false, cancelled: false, noShow: false, arrived: false, confirmed: false };

      test('prev отменён («не придёт»), create живой → created, но НЕ restored', () => {
        expect(ev.classifyRecordEvent(upd({ attendance: -1 }), createSnap({}))).toEqual({ created: true, ...ALL_OFF });
      });
      test('prev удалён, create живой → created, но НЕ restored', () => {
        expect(ev.classifyRecordEvent(upd({ deleted: true }), createSnap({}))).toEqual({ created: true, ...ALL_OFF });
      });
      test('prev на другом времени → created, но НЕ rescheduled', () => {
        expect(ev.classifyRecordEvent(upd({ datetime: '2026-10-22T09:00:00+03:00' }), createSnap({}))).toEqual({ created: true, ...ALL_OFF });
      });
      test('create с attendance=1 / 2 (старый снимок) при prev=0 → НЕ arrived / НЕ confirmed', () => {
        expect(ev.classifyRecordEvent(upd({ attendance: 0 }), createSnap({ attendance: 1 }))).toEqual({ created: true, ...ALL_OFF });
        expect(ev.classifyRecordEvent(upd({ attendance: 0 }), createSnap({ attendance: 2 }))).toEqual({ created: true, ...ALL_OFF });
      });
      test('create несёт отмену (deleted / attendance -1) → не created и НЕ cancelled/noShow', () => {
        expect(ev.classifyRecordEvent(upd({}), createSnap({ attendance: -1 }))).toEqual({ created: false, ...ALL_OFF });
        expect(ev.classifyRecordEvent(upd({}), createSnap({ deleted: true }))).toEqual({ created: false, ...ALL_OFF });
      });
      test('prev нет — create разбирается как раньше (created, остальное по снимку)', () => {
        expect(ev.classifyRecordEvent(null, createSnap({ attendance: 1 }))).toMatchObject({ created: true, arrived: true });
        expect(ev.classifyRecordEvent(null, createSnap({ attendance: -1 }))).toMatchObject({ created: false, cancelled: true, noShow: true });
      });
      test('isLateCreate: только create при известном состоянии', () => {
        expect(ev.isLateCreate(upd({}), createSnap({}))).toBe(true);
        expect(ev.isLateCreate(null, createSnap({}))).toBe(false);
        expect(ev.isLateCreate(upd({}), upd({}))).toBe(false);
        expect(ev.isLateCreate(null, upd({}))).toBe(false);
      });
    });
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

  // Записи «клиент не придёт» (attendance -1) администратор переносит и одним действием снимает отметку:
  // в реальных вебхуках это 12 случаев из 344 (prev {-1, визит A} → {0, визит B}).
  describe('отмена, перенос и возврат из отмены', () => {
    const upd = (over) => ev.recordSnapshot({ ...base, status: 'update', data: { ...base.data, ...over } });
    const noShow = upd({ attendance: -1 });
    const MOVED = { datetime: '2026-10-27T17:00:00+03:00', date: '2026-10-27 17:00:00' };

    test('перенос + снятие «не придёт» одним update → rescheduled (и restored), не cancelled', () => {
      const k = ev.classifyRecordEvent(noShow, upd({ attendance: 0, ...MOVED }));
      expect(k).toMatchObject({ rescheduled: true, restored: true, cancelled: false, created: false });
    });
    test('снятие «не придёт» без смены времени → restored, но не rescheduled', () => {
      expect(ev.classifyRecordEvent(noShow, upd({ attendance: 0 })))
        .toMatchObject({ restored: true, rescheduled: false, cancelled: false });
    });
    test('возврат удалённой записи (deleted → живая) → restored', () => {
      const del = upd({ deleted: true });
      expect(ev.classifyRecordEvent(del, upd({ deleted: false }))).toMatchObject({ restored: true, cancelled: false });
    });
    test('перенос записи, которая ОСТАЁТСЯ отменённой, → ни rescheduled, ни restored', () => {
      const k = ev.classifyRecordEvent(noShow, upd({ attendance: -1, ...MOVED }));
      expect(k).toMatchObject({ rescheduled: false, restored: false, cancelled: false });
    });
    test('restored: нет prev → нет; живая запись без отмены в прошлом → нет; отмена сейчас → нет', () => {
      expect(ev.classifyRecordEvent(null, upd({ attendance: 0 })).restored).toBe(false);
      expect(ev.classifyRecordEvent(snap, upd({ attendance: 0 })).restored).toBe(false);
      expect(ev.classifyRecordEvent(snap, noShow).restored).toBe(false);
      expect(ev.classifyRecordEvent(noShow, noShow).restored).toBe(false);
    });
    test('перенос обычной живой записи по-прежнему rescheduled, restored=false', () => {
      expect(ev.classifyRecordEvent(snap, upd({ ...MOVED }))).toMatchObject({ rescheduled: true, restored: false });
    });
  });
});

describe('reminderAt', () => {
  const snap = ev.recordSnapshot(base);           // визит 20.10 13:30 мск
  const NOW = T('2026-10-18T10:00:00+03:00');
  const DAY_BEFORE = T('2026-10-19T13:30:00+03:00');
  test('за hours_before правила', () => {
    expect(ev.reminderAt(snap, { hours_before: 24 }, {}, NOW)).toBe(DAY_BEFORE);
    expect(ev.reminderAt(snap, { hours_before: 48 }, {}, NOW)).toBe(T('2026-10-18T13:30:00+03:00'));
  });
  test('sms_before записи не влияет — правило главнее', () => {
    // В вебхуках sms_before — дефолт компании (24 или 0), а не выбор клиента; Chatpush шлёт ровно за
    // 24 ч и при sms_before=0. Поэтому поле записи напоминание НЕ сдвигает ни вперёд, ни назад.
    for (const smsBefore of [2, 0, 24, 72]) {
      expect(ev.reminderAt({ ...snap, smsBefore }, { hours_before: 24 }, {}, NOW)).toBe(DAY_BEFORE);
    }
    expect(ev.reminderAt({ ...snap, smsBefore: 2 }, { hours_before: 48 }, {}, NOW)).toBe(T('2026-10-18T13:30:00+03:00'));
  });
  test('hours_before не задан, не число или ≤ 0 → 24 часа', () => {
    for (const hours_before of [undefined, null, 0, -3, NaN, 'abc', Infinity]) {
      expect(ev.reminderAt(snap, { hours_before }, {}, NOW)).toBe(DAY_BEFORE);
    }
    expect(ev.reminderAt(snap, undefined, {}, NOW)).toBe(DAY_BEFORE);
    expect(ev.reminderAt(snap, { hours_before: '12' }, {}, NOW)).toBe(T('2026-10-20T01:30:00+03:00'));
  });
  test('момент уже прошёл → null (YClients тоже не шлёт)', () => {
    expect(ev.reminderAt(snap, { hours_before: 24 }, {}, T('2026-10-19T14:00:00+03:00'))).toBeNull();
  });
  test('нечисловой момент визита или «сейчас» → null, а не NaN в SQL', () => {
    expect(ev.reminderAt({ ...snap, visitAt: NaN }, { hours_before: 24 }, {}, NOW)).toBeNull();
    expect(ev.reminderAt({ ...snap, visitAt: null }, { hours_before: 24 }, {}, NOW)).toBeNull();
    expect(ev.reminderAt(snap, { hours_before: 24 }, {}, NaN)).toBeNull();
  });
  test('тихие часы сдвигают на quiet_to', () => {
    const night = { ...snap, visitAt: T('2026-10-20T23:00:00+03:00') };  // напоминание в 23:00 19.10
    expect(ev.reminderAt(night, { hours_before: 24 }, { quiet_from: '22:00', quiet_to: '09:00' }, NOW))
      .toBe(T('2026-10-20T09:00:00+03:00'));
  });
  test('сдвиг тихими часами за момент визита → null', () => {
    // визит в 08:00, напоминание за 2 ч = 06:00 — в тихих часах; сдвиг на 09:00 уехал бы за сам визит
    const early = { ...snap, visitAt: T('2026-10-20T08:00:00+03:00') };
    expect(ev.reminderAt(early, { hours_before: 2 }, { quiet_from: '22:00', quiet_to: '09:00' }, NOW)).toBeNull();
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
  test('нечисловой delay → 0, без NaN', () => {
    const now = T('2026-10-20T13:40:00+03:00');
    const END = T('2026-10-20T14:30:00+03:00');
    for (const bad of [undefined, null, '', 'abc', NaN, {}, Infinity, -5]) {
      const at = ev.afterVisitAt(snap, bad, now);
      expect(Number.isNaN(at)).toBe(false);
      expect(at).toBe(END);
    }
    expect(ev.afterVisitAt(snap, '7', now)).toBe(END + 7 * 60000);
  });
  test('нет момента визита или длительности → от now / от начала визита, без NaN', () => {
    const now = T('2026-10-20T13:40:00+03:00');
    expect(ev.afterVisitAt({ ...snap, visitAt: null }, 5, now)).toBe(now + 5 * 60000);
    expect(ev.afterVisitAt({ ...snap, seanceLength: undefined }, 0, now)).toBe(now);
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
