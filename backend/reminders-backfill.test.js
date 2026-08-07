'use strict';
// Догон: «кому ушло бы напоминание, если бы правило работало последние N дней».
// Планирование чисто событийное, бэкфилла нет — без этой ручки только что
// созданное правило выглядит сломанным (очередь пуста, и непонятно, условия
// кривые или подходящих визитов не было).
const { matchBackfillVisits, spreadOverDays } = require('./services/reminders/backfill');

const CAT_MAP = new Map([['101', '9'], ['200', '7']]);
const COND = { logic: 'and', items: [{ type: 'category', ids: [9] }] };
const NOW = Date.parse('2026-08-07T09:00:00+03:00');

const visit = (over = {}) => ({
  id: 1, date: '2026-07-08 14:00:00', attendance: 1,
  client: { id: 42, phone: '79200255591', name: 'Мария' },
  staff: { id: 55, name: 'Юлия' },
  services: [{ id: 101, title: 'Лазерная эпиляция' }],
  ...over,
});

const run = (records, over = {}) => matchBackfillVisits({
  records, conditions: COND, catMap: CAT_MAP,
  blacklisted: new Set(), mutedPhones: new Set(), queuedRecordIds: new Set(),
  nowMs: NOW, ...over,
});

test('подходящий состоявшийся визит попадает в выборку', () => {
  const out = run([visit()]);
  expect(out.rows).toHaveLength(1);
  expect(out.rows[0].skipReason).toBeNull();
  expect(out.totals.willSend).toBe(1);
});

test('несостоявшийся визит не попадает вовсе', () => {
  expect(run([visit({ attendance: 0 })]).rows).toHaveLength(0);
});

test('визит вне условий не попадает вовсе', () => {
  expect(run([visit({ services: [{ id: 200, title: 'Другое' }] })]).rows).toHaveLength(0);
});

test('нет телефона → no_phone', () => {
  const out = run([visit({ client: { id: 42, phone: '', name: 'М' } })]);
  expect(out.rows[0].skipReason).toBe('no_phone');
});

test('чёрный список → blacklist', () => {
  const out = run([visit()], { blacklisted: new Set(['79200255591']) });
  expect(out.rows[0].skipReason).toBe('blacklist');
});

test('флаг анти-повтора → muted', () => {
  const out = run([visit()], { mutedPhones: new Set(['79200255591']) });
  expect(out.rows[0].skipReason).toBe('muted');
});

test('визит уже в очереди → already_queued', () => {
  const out = run([visit()], { queuedRecordIds: new Set(['1']) });
  expect(out.rows[0].skipReason).toBe('already_queued');
});

// Будущие записи приходят тем же сводным запросом /records — отдельных
// вызовов YClients на каждого клиента не делаем.
test('есть будущая запись под условия → future_booking', () => {
  const future = visit({ id: 2, date: '2026-08-20 14:00:00', attendance: 0 });
  const out = run([visit(), future]);
  const row = out.rows.find(r => r.recordId === 1);
  expect(row.skipReason).toBe('future_booking');
});

test('будущая запись на чужую услугу не мешает', () => {
  const future = visit({ id: 2, date: '2026-08-20 14:00:00', attendance: 0, services: [{ id: 200, title: 'Другое' }] });
  expect(run([visit(), future]).rows.find(r => r.recordId === 1).skipReason).toBeNull();
});

// Из нескольких визитов клиента напоминание ушло бы только от самого позднего.
test('ранний визит того же клиента → superseded', () => {
  const later = visit({ id: 2, date: '2026-07-20 14:00:00' });
  const out = run([visit(), later]);
  expect(out.rows.find(r => r.recordId === 2).skipReason).toBeNull();
  expect(out.rows.find(r => r.recordId === 1).skipReason).toBe('superseded');
});

// Найдено ревью качества: голого isVisitCompleted() мало — предоплаченная
// неявка несёт paid_full=1 ОДНОВРЕМЕННО с attendance=-1, а удалённая запись
// несёт deleted=true при живом attendance. Обе не должны попадать в выборку
// вовсе (как и обычный несостоявшийся визит), иначе реальному клиенту, не
// пришедшему на визит (или чью запись удалили), уйдёт «пора повторить».
test('предоплаченная неявка (attendance=-1, paid_full=1) не попадает в выборку', () => {
  const out = run([visit({ attendance: -1, paid_full: 1 })]);
  expect(out.rows).toHaveLength(0);
});

test('удалённая запись (deleted=true, attendance=1) не попадает в выборку', () => {
  const out = run([visit({ deleted: true, attendance: 1 })]);
  expect(out.rows).toHaveLength(0);
});

// Будущая ОТМЕНЁННАЯ запись не должна считаться «клиент уже записан» —
// прошлый визит остаётся с skipReason: null, напоминание всё ещё уйдёт.
test('будущая отменённая запись (deleted) не помечает клиента как уже записанного', () => {
  const futureDeleted = visit({ id: 2, date: '2026-08-20 14:00:00', deleted: true });
  const out = run([visit(), futureDeleted]);
  expect(out.rows.find(r => r.recordId === 1).skipReason).toBeNull();
});

test('будущая отменённая запись (attendance=-1) не помечает клиента как уже записанного', () => {
  const futureNoShow = visit({ id: 2, date: '2026-08-20 14:00:00', attendance: -1 });
  const out = run([visit(), futureNoShow]);
  expect(out.rows.find(r => r.recordId === 1).skipReason).toBeNull();
});

describe('spreadOverDays', () => {
  const rows = (n) => Array.from({ length: n }, (_, i) => ({ recordId: i + 1 }));

  test('кап соблюдается: 70 строк по 30 в день → 3 дня', () => {
    const out = spreadOverDays(rows(70), { maxPerDay: 30, sendTime: '11:00', nowMs: NOW });
    const byDay = new Map();
    for (const r of out) {
      const k = r.scheduledAt.toISOString().slice(0, 10);
      byDay.set(k, (byDay.get(k) || 0) + 1);
    }
    expect([...byDay.values()]).toEqual([30, 30, 10]);
  });

  test('время отправки — send_time правила по Москве', () => {
    const out = spreadOverDays(rows(1), { maxPerDay: 30, sendTime: '11:00', nowMs: NOW });
    expect(out[0].scheduledAt.toISOString()).toBe('2026-08-07T08:00:00.000Z');
  });

  // Время сегодня уже прошло — начинаем с завтра, иначе строка встанет в
  // прошлое и воркер выстрелит ей немедленно, минуя кап.
  test('если send_time сегодня уже прошло — старт с завтра', () => {
    const late = Date.parse('2026-08-07T20:00:00+03:00');
    const out = spreadOverDays(rows(1), { maxPerDay: 30, sendTime: '11:00', nowMs: late });
    expect(out[0].scheduledAt.toISOString()).toBe('2026-08-08T08:00:00.000Z');
  });

  test('нулевой или отрицательный кап трактуется как 1', () => {
    const out = spreadOverDays(rows(2), { maxPerDay: 0, sendTime: '11:00', nowMs: NOW });
    expect(out[0].scheduledAt.toISOString().slice(0, 10)).not.toBe(out[1].scheduledAt.toISOString().slice(0, 10));
  });

  test('пустой список → пустой результат', () => {
    expect(spreadOverDays([], { maxPerDay: 30, sendTime: '11:00', nowMs: NOW })).toEqual([]);
  });

  // Решение владельца: первым догон дёргает того, кто НЕ БЫЛ ДОЛЬШЕ ВСЕХ —
  // самый просроченный по смыслу правила, держать его в хвосте многодневной
  // очереди неправильно.
  test('самый давний визит уходит первым днём, самый свежий — последним', () => {
    const withDates = [
      { recordId: 1, visitAt: '2026-07-01T10:00:00.000Z' },
      { recordId: 2, visitAt: '2026-05-01T10:00:00.000Z' },
      { recordId: 3, visitAt: '2026-06-01T10:00:00.000Z' },
    ];
    const out = spreadOverDays(withDates, { maxPerDay: 1, sendTime: '11:00', nowMs: NOW });
    expect(out.map(r => r.recordId)).toEqual([2, 3, 1]);
    const days = out.map(r => r.scheduledAt.toISOString().slice(0, 10));
    expect(days[0] < days[1]).toBe(true);
    expect(days[1] < days[2]).toBe(true);
  });

  test('строки без visitAt сохраняют исходный относительный порядок', () => {
    const noDates = [{ recordId: 1 }, { recordId: 2 }, { recordId: 3 }];
    const out = spreadOverDays(noDates, { maxPerDay: 1, sendTime: '11:00', nowMs: NOW });
    expect(out.map(r => r.recordId)).toEqual([1, 2, 3]);
  });

  test('смешанный случай: с датой и без — не бросает, датированные упорядочены по возрастанию', () => {
    const mixed = [
      { recordId: 1 },
      { recordId: 2, visitAt: '2026-07-01T10:00:00.000Z' },
      { recordId: 3 },
      { recordId: 4, visitAt: '2026-05-01T10:00:00.000Z' },
    ];
    expect(() => spreadOverDays(mixed, { maxPerDay: 1, sendTime: '11:00', nowMs: NOW })).not.toThrow();
    const out = spreadOverDays(mixed, { maxPerDay: 1, sendTime: '11:00', nowMs: NOW });
    const dated = out.filter(r => r.recordId === 2 || r.recordId === 4);
    expect(dated.map(r => r.recordId)).toEqual([4, 2]);
  });
});
