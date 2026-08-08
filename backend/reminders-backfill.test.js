'use strict';
// Догон: «кому ушло бы напоминание, если бы правило работало последние N дней».
// Планирование чисто событийное, бэкфилла нет — без этой ручки только что
// созданное правило выглядит сломанным (очередь пуста, и непонятно, условия
// кривые или подходящих визитов не было).
const { matchBackfillVisits, planBackfillSchedule } = require('./services/reminders/backfill');

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

// ── план догона ────────────────────────────────────────────────
// NOW = 2026-08-07 09:00 МСК, то есть send_time 11:00 сегодня ещё впереди.
describe('planBackfillSchedule', () => {
  const DELAY = 60;
  const plan = (rows, over = {}) => planBackfillSchedule(rows, {
    delayDays: DELAY, sendTime: '11:00', maxPerDay: 30, nowMs: NOW, ...over });

  // Естественная дата = визит + delay_days в send_time, ровно как в боевом
  // планировщике (enroll.js). Визит моложе задержки ждёт своей даты.
  test('визит моложе delay_days встаёт на естественную дату, а не на завтра', () => {
    const out = plan([{ recordId: 1, visitAt: '2026-08-01T10:00:00.000Z' }]);
    expect(out).toHaveLength(1);
    expect(out[0].overdue).toBe(false);
    // 01.08 + 60 дней = 30.09, 11:00 МСК = 08:00 UTC
    expect(out[0].scheduledAt.toISOString()).toBe('2026-09-30T08:00:00.000Z');
  });

  test('просроченный визит уходит в догоняющую пачку — сегодня, пока 11:00 не прошло', () => {
    const out = plan([{ recordId: 1, visitAt: '2026-06-01T11:00:00.000Z' }]);
    expect(out[0].overdue).toBe(true);
    expect(out[0].scheduledAt.toISOString()).toBe('2026-08-07T08:00:00.000Z');
  });

  test('если send_time уже прошло — догоняющая пачка стартует завтра', () => {
    const late = Date.parse('2026-08-07T12:00:00+03:00');
    const out = plan([{ recordId: 1, visitAt: '2026-06-01T11:00:00.000Z' }], { nowMs: late });
    expect(out[0].scheduledAt.toISOString()).toBe('2026-08-08T08:00:00.000Z');
  });

  // Кап существует ради всплеска догона — к строкам, стоящим на свою
  // естественную дату, он не применяется: там всплеска нет по построению.
  test('кап режет только просроченных, будущие не трогает', () => {
    const overdue = Array.from({ length: 3 }, (_, i) => (
      { recordId: 100 + i, visitAt: `2026-06-0${i + 1}T11:00:00.000Z` }));
    const future = Array.from({ length: 5 }, (_, i) => (
      { recordId: 200 + i, visitAt: '2026-08-01T10:00:00.000Z' }));
    const out = plan([...future, ...overdue], { maxPerDay: 2 });
    const od = out.filter(r => r.overdue).map(r => r.scheduledAt.toISOString());
    expect(od).toEqual([
      '2026-08-07T08:00:00.000Z',   // 1-й и 2-й — сегодня
      '2026-08-07T08:00:00.000Z',
      '2026-08-08T08:00:00.000Z',   // 3-й переехал на завтра
    ]);
    // Все пять будущих остались на одной дате, кап их не разнёс.
    const fu = out.filter(r => !r.overdue).map(r => r.scheduledAt.toISOString());
    expect(fu).toEqual(Array(5).fill('2026-09-30T08:00:00.000Z'));
  });

  // Решение владельца салона: первым напоминание получает тот, кто НЕ БЫЛ
  // ДОЛЬШЕ ВСЕХ. Это отдельная сортировка от «свежие сверху» в
  // matchBackfillVisits (та нужна только для дедупликации superseded).
  test('просроченные сортируются по дате визита по возрастанию', () => {
    const rows = [
      { recordId: 1, visitAt: '2026-06-20T11:00:00.000Z' },
      { recordId: 2, visitAt: '2026-05-01T11:00:00.000Z' },
      { recordId: 3, visitAt: '2026-06-01T11:00:00.000Z' },
    ];
    const out = plan(rows, { maxPerDay: 1 });
    expect(out.map(r => r.recordId)).toEqual([2, 3, 1]);
  });

  test('строка без даты визита не роняет план и попадает в догоняющую пачку', () => {
    const out = plan([{ recordId: 1, visitAt: null }]);
    expect(out).toHaveLength(1);
    expect(out[0].overdue).toBe(true);
    expect(out[0].scheduledAt).toBeInstanceOf(Date);
  });

  test('пустой вход → пустой план', () => {
    expect(plan([])).toEqual([]);
  });
});
