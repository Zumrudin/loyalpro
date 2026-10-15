'use strict';

jest.mock('./db', () => ({ pool: { query: jest.fn() } }));
jest.mock('./services/yclients-records', () => ({
  ycGetRecord: jest.fn(), ycUpdateRecord: jest.fn(),
}));
jest.mock('./services/yclients', () => ({
  ycGetServiceMeta: jest.fn(), ycGetServiceCatalog: jest.fn(),
}));
jest.mock('./services/yclients-booking', () => ({
  ycGetDayRecords: jest.fn(),
}));

const { pool } = require('./db');
const ycr = require('./services/yclients-records');
const yc = require('./services/yclients');
const yb = require('./services/yclients-booking');
const { cancelBookingRecord, rescheduleBookingRecord, modifyBookingServices, confirmBookingRecord, CANCEL_SEANCE_LENGTH } =
  require('./services/agent/booking-modify');

const SALON_ROW = {
  id: 1, yclients_company_id: 100, yclients_partner_token: 'p', yclients_user_token: 'u',
};
const REC = {
  id: 555, attendance: 0, staff_id: 7, datetime: '2026-07-25T12:00:00+03:00',
  seance_length: 3600, comment: 'старый', client: { id: 777, name: 'Аня', phone: '79001112233' },
  services: [{ id: 10, title: 'Пилинг' }],
};

beforeEach(() => {
  jest.clearAllMocks();
  pool.query.mockImplementation((sql) =>
    /FROM salons/.test(sql) ? Promise.resolve({ rows: [SALON_ROW] }) : Promise.resolve({ rows: [] }));
});

describe('cancelBookingRecord', () => {
  test('ставит attendance -1, 5 мин и добавляет услугу «Запрет на отправку»', async () => {
    ycr.ycGetRecord.mockResolvedValue(REC);
    ycr.ycUpdateRecord.mockResolvedValue({ id: 555 });
    const res = await cancelBookingRecord(1, {
      dialogKey: 'd', recordId: 555, expectedYcClientId: 777, noNotifyServiceId: 99,
    });
    expect(res.ok).toBe(true);
    expect(res.no_notify_applied).toBe(true);
    const body = ycr.ycUpdateRecord.mock.calls[0][2];
    expect(body.attendance).toBe(-1);
    expect(body.seance_length).toBe(CANCEL_SEANCE_LENGTH);
    expect(body.services).toEqual([{ id: 10 }, { id: 99 }]);
    // YClients требует обязательный параметр client в PUT /record — иначе 422.
    expect(body.client).toEqual({ id: 777, phone: '79001112233', name: 'Аня' });
    // событие записано
    const kinds = pool.query.mock.calls.map(c => c[1]).filter(Boolean).flat();
    expect(kinds).toContain('booking_cancelled');
  });

  test('запись уже отменена (attendance -1) → already, без PUT', async () => {
    ycr.ycGetRecord.mockResolvedValue({ ...REC, attendance: -1 });
    const res = await cancelBookingRecord(1, { dialogKey: 'd', recordId: 555, expectedYcClientId: 777 });
    expect(res.ok).toBe(true);
    expect(res.already).toBe(true);
    expect(ycr.ycUpdateRecord).not.toHaveBeenCalled();
  });

  test('чужая запись → foreign, без PUT', async () => {
    ycr.ycGetRecord.mockResolvedValue(REC); // client.id=777
    const res = await cancelBookingRecord(1, { dialogKey: 'd', recordId: 555, expectedYcClientId: 888 });
    expect(res.ok).toBe(false);
    expect(res.foreign).toBe(true);
    expect(ycr.ycUpdateRecord).not.toHaveBeenCalled();
  });

  test('без noNotifyServiceId — отмена всё равно проходит, услуга не добавляется', async () => {
    ycr.ycGetRecord.mockResolvedValue(REC);
    ycr.ycUpdateRecord.mockResolvedValue({ id: 555 });
    const res = await cancelBookingRecord(1, { dialogKey: 'd', recordId: 555, expectedYcClientId: 777 });
    expect(res.ok).toBe(true);
    expect(res.no_notify_applied).toBe(false);
    expect(ycr.ycUpdateRecord.mock.calls[0][2].services).toEqual([{ id: 10 }]);
  });
});

describe('rescheduleBookingRecord', () => {
  test.each([{ deleted: true }, { attendance: -1 }, { client: null }])
  ('ordinary transfer rejects inactive or unverifiable source: %j', async change => {
    ycr.ycGetRecord.mockResolvedValue({ ...REC, ...change });
    const result = await rescheduleBookingRecord(1, { recordId: REC.id, expectedYcClientId: 777,
      datetime: '2026-10-02T15:00:00+03:00' });
    expect(result.ok).toBe(false);
    expect(ycr.ycUpdateRecord).not.toHaveBeenCalled();
  });

  test.each([
    { services: [{ id: 99 }] }, { services: [] }, { deleted: true },
    { attendance: -1 }, { client: null }, { client: { id: 888 } },
  ])('chain source changed or cannot be verified: no PUT (%j)', async change => {
    ycr.ycGetRecord.mockResolvedValue({ ...REC, ...change });
    const res = await rescheduleBookingRecord(1, { dialogKey: 'd', recordId: REC.id,
      expectedYcClientId: 777, expectedServiceYcIds: [10], datetime: '2026-10-02T15:00:00+03:00' });
    expect(res.ok).toBe(false);
    expect(ycr.ycUpdateRecord).not.toHaveBeenCalled();
  });

  test('retry of a completed chain link does not repeat PUT or notification', async () => {
    ycr.ycGetRecord.mockResolvedValue(REC);
    const res = await rescheduleBookingRecord(1, { dialogKey: 'd', recordId: REC.id,
      expectedYcClientId: 777, expectedServiceYcIds: [10], datetime: REC.datetime,
      staffYcId: REC.staff_id, seanceLength: REC.seance_length });
    expect(res).toMatchObject({ ok: true, already: true, record_id: REC.id });
    expect(ycr.ycUpdateRecord).not.toHaveBeenCalled();
  });
  test('ordinary transfer retry does not repeat PUT either', async () => {
    ycr.ycGetRecord.mockResolvedValue(REC);
    const result = await rescheduleBookingRecord(1, { recordId: REC.id, expectedYcClientId: 777,
      datetime: REC.datetime, staffYcId: REC.staff_id, seanceLength: REC.seance_length });
    expect(result).toMatchObject({ ok: true, already: true, record_id: REC.id });
    expect(ycr.ycUpdateRecord).not.toHaveBeenCalled();
  });

  test('PUT нового datetime, услуги и мастер сохраняются', async () => {
    ycr.ycGetRecord.mockResolvedValue(REC);
    ycr.ycUpdateRecord.mockResolvedValue({ id: 555 });
    const res = await rescheduleBookingRecord(1, {
      dialogKey: 'd', recordId: 555, expectedYcClientId: 777,
      datetime: '2026-07-26T15:00:00+03:00',
    });
    expect(res.ok).toBe(true);
    const body = ycr.ycUpdateRecord.mock.calls[0][2];
    expect(body.datetime).toBe('2026-07-26T15:00:00+03:00');
    expect(body.staff_id).toBe(7);
    expect(body.services).toEqual([{ id: 10 }]);
    // YClients требует обязательный параметр client в PUT /record — иначе 422.
    expect(body.client).toEqual({ id: 777, phone: '79001112233', name: 'Аня' });
    const kinds = pool.query.mock.calls.map(c => c[1]).filter(Boolean).flat();
    expect(kinds).toContain('booking_rescheduled');
  });

  test('чужая запись → foreign', async () => {
    ycr.ycGetRecord.mockResolvedValue(REC);
    const res = await rescheduleBookingRecord(1, {
      dialogKey: 'd', recordId: 555, expectedYcClientId: 888, datetime: '2026-07-26T15:00:00+03:00',
    });
    expect(res.ok).toBe(false);
    expect(res.foreign).toBe(true);
  });

  test('слот подтверждён под ДРУГУЮ услугу записи → wrongService, PUT не идёт', async () => {
    ycr.ycGetRecord.mockResolvedValue(REC); // REC.services = [{ id: 10, title: 'Пилинг' }]
    const { createSlotEvidence } = require('./services/agent/slot-evidence');
    const ev = createSlotEvidence();
    ev.add('get_available_slots', { staff_yc_id: 7, service_yc_id: 999, date: '2026-07-27' },
      { slots: [{ datetime: '2026-07-27T19:30:00+03:00' }] });
    const res = await rescheduleBookingRecord(1, {
      dialogKey: 'd', recordId: 555, expectedYcClientId: 777,
      datetime: '2026-07-27T19:30:00+03:00', slotEvidence: ev,
    });
    expect(res.ok).toBe(false);
    expect(res.wrongService).toBe(true);
    expect(res.error).toMatch(/10/);
    expect(ycr.ycUpdateRecord).not.toHaveBeenCalled();
  });

  test('слот подтверждён под РЕАЛЬНУЮ услугу записи (id 10) → PUT идёт', async () => {
    ycr.ycGetRecord.mockResolvedValue(REC);
    ycr.ycUpdateRecord.mockResolvedValue({ id: 555 });
    const { createSlotEvidence } = require('./services/agent/slot-evidence');
    const ev = createSlotEvidence();
    ev.add('get_available_slots', { staff_yc_id: 7, service_yc_id: 10, date: '2026-07-27' },
      { slots: [{ datetime: '2026-07-27T19:30:00+03:00' }] });
    const res = await rescheduleBookingRecord(1, {
      dialogKey: 'd', recordId: 555, expectedYcClientId: 777,
      datetime: '2026-07-27T19:30:00+03:00', slotEvidence: ev,
    });
    expect(res.ok).toBe(true);
  });

  test('без slotEvidence (fail-open) — прежнее поведение', async () => {
    ycr.ycGetRecord.mockResolvedValue(REC);
    ycr.ycUpdateRecord.mockResolvedValue({ id: 555 });
    const res = await rescheduleBookingRecord(1, {
      dialogKey: 'd', recordId: 555, expectedYcClientId: 777, datetime: '2026-07-27T19:30:00+03:00',
    });
    expect(res.ok).toBe(true);
  });
});

describe('modifyBookingServices', () => {
  beforeEach(() => {
    // По умолчанию: длительности услуг известны, мастер 7 выполняет услугу 20, день пуст.
    yc.ycGetServiceMeta.mockResolvedValue({
      durationByService: new Map([['10', 1800], ['20', 2700]]),
    });
    yc.ycGetServiceCatalog.mockResolvedValue({
      staffIdsByService: new Map([['20', new Set(['7'])]]),
    });
    yb.ycGetDayRecords.mockResolvedValue([]);
  });

  test('добавление услуги: PUT с новым набором и пересчитанной длительностью', async () => {
    ycr.ycGetRecord.mockResolvedValue(REC);           // services [{id:10}], staff 7
    ycr.ycUpdateRecord.mockResolvedValue({ id: 555 });
    const res = await modifyBookingServices(1, {
      dialogKey: 'd', recordId: 555, expectedYcClientId: 777, addServiceYcIds: [20],
    });
    expect(res.ok).toBe(true);
    const body = ycr.ycUpdateRecord.mock.calls[0][2];
    expect(body.services).toEqual([{ id: 10 }, { id: 20 }]);
    expect(body.seance_length).toBe(4500);            // 1800 + 2700 (пересчёт, не старые 3600)
    expect(body.datetime).toBe('2026-07-25T12:00:00+03:00');  // время не меняется
    expect(body.client).toEqual({ id: 777, phone: '79001112233', name: 'Аня' });
    expect(body.save_if_busy).toBe(false);
    const kinds = pool.query.mock.calls.map(c => c[1]).filter(Boolean).flat();
    expect(kinds).toContain('booking_services_modified');
  });

  test('удаление услуги: набор и длительность пересчитаны', async () => {
    ycr.ycGetRecord.mockResolvedValue({ ...REC, services: [{ id: 10 }, { id: 20 }] });
    ycr.ycUpdateRecord.mockResolvedValue({ id: 555 });
    const res = await modifyBookingServices(1, {
      dialogKey: 'd', recordId: 555, expectedYcClientId: 777, removeServiceYcIds: [20],
    });
    expect(res.ok).toBe(true);
    const body = ycr.ycUpdateRecord.mock.calls[0][2];
    expect(body.services).toEqual([{ id: 10 }]);
    expect(body.seance_length).toBe(1800);
  });

  test('удаление последней услуги → removed_all, без PUT', async () => {
    ycr.ycGetRecord.mockResolvedValue(REC);           // единственная услуга 10
    const res = await modifyBookingServices(1, {
      dialogKey: 'd', recordId: 555, expectedYcClientId: 777, removeServiceYcIds: [10],
    });
    expect(res.ok).toBe(false);
    expect(res.removed_all).toBe(true);
    expect(ycr.ycUpdateRecord).not.toHaveBeenCalled();
  });

  test('наложение на следующую запись мастера → overlaps, без PUT', async () => {
    ycr.ycGetRecord.mockResolvedValue(REC);           // старт 12:00, после add длительность 75 мин → конец 13:15
    yb.ycGetDayRecords.mockResolvedValue([
      { id: 556, staff_id: 7, datetime: '2026-07-25T13:00:00+03:00' },   // следующая в 13:00 < 13:15
    ]);
    const res = await modifyBookingServices(1, {
      dialogKey: 'd', recordId: 555, expectedYcClientId: 777, addServiceYcIds: [20],
    });
    expect(res.ok).toBe(false);
    expect(res.overlaps).toBe(true);
    expect(ycr.ycUpdateRecord).not.toHaveBeenCalled();
  });

  test('добавляемую услугу мастер не выполняет → invalid_service, без PUT', async () => {
    ycr.ycGetRecord.mockResolvedValue(REC);
    yc.ycGetServiceCatalog.mockResolvedValue({
      staffIdsByService: new Map([['20', new Set(['9'])]]),   // услугу 20 делает мастер 9, а запись у 7
    });
    const res = await modifyBookingServices(1, {
      dialogKey: 'd', recordId: 555, expectedYcClientId: 777, addServiceYcIds: [20],
    });
    expect(res.ok).toBe(false);
    expect(res.invalid_service).toBe(true);
    expect(ycr.ycUpdateRecord).not.toHaveBeenCalled();
  });

  test('чужая запись → foreign, без PUT', async () => {
    ycr.ycGetRecord.mockResolvedValue(REC);           // client.id 777
    const res = await modifyBookingServices(1, {
      dialogKey: 'd', recordId: 555, expectedYcClientId: 888, addServiceYcIds: [20],
    });
    expect(res.ok).toBe(false);
    expect(res.foreign).toBe(true);
    expect(ycr.ycUpdateRecord).not.toHaveBeenCalled();
  });
});

// Инцидент 2026-09-19 (79651442032): «Превышен лимит запросов… через 0 секунд»
// на reschedule_booking без единого повтора. Повтор идёт через yclients-retry.
describe('лимит запросов YClients (429) повторяется', () => {
  test('reschedule: первая попытка 429, вторая — успех', async () => {
    jest.useFakeTimers();
    try {
      ycr.ycGetRecord.mockResolvedValue(REC);
      ycr.ycUpdateRecord
        .mockRejectedValueOnce(new Error('Превышен лимит запросов, попробуйте повторить запрос через 0 секунд.'))
        .mockResolvedValueOnce({ id: 555 });
      const p = rescheduleBookingRecord(1, {
        dialogKey: 'd', recordId: 555, expectedYcClientId: 777, datetime: '2026-07-26T15:00:00+03:00',
      });
      await jest.advanceTimersByTimeAsync(1500);
      const res = await p;
      expect(res.ok).toBe(true);
      expect(ycr.ycUpdateRecord).toHaveBeenCalledTimes(2);
    } finally { jest.useRealTimers(); }
  });

  test('отказ по времени НЕ повторяется', async () => {
    ycr.ycGetRecord.mockResolvedValue(REC);
    ycr.ycUpdateRecord.mockRejectedValue(new Error('Выбранное время недоступно'));
    const res = await rescheduleBookingRecord(1, {
      dialogKey: 'd', recordId: 555, expectedYcClientId: 777, datetime: '2026-07-26T15:00:00+03:00',
    });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/недоступно/);
    expect(ycr.ycUpdateRecord).toHaveBeenCalledTimes(1);
  });
});

// ── confirmBookingRecord: «Подтвердил» (attendance=2) по ответу пациента на напоминание ──
// PUT /record только с {attendance} YClients отвергает (422 — как и везде в этом модуле, нужен ПОЛНЫЙ
// набор: мастер, услуги, client, время), поэтому тело собирается из текущей записи, как у отмены.
describe('confirmBookingRecord', () => {
  const FULL_BODY = {
    staff_id: 7, services: [{ id: 10 }], client: { id: 777, phone: '79001112233', name: 'Аня' },
    datetime: '2026-07-25T12:00:00+03:00', seance_length: 3600, attendance: 2, comment: 'старый',
  };

  test('ставит attendance=2 ПОЛНЫМ PUT: мастер, услуги, клиент, время, длительность и комментарий сохраняются', async () => {
    ycr.ycGetRecord.mockResolvedValue(REC);
    ycr.ycUpdateRecord.mockResolvedValue({ id: 555 });
    const res = await confirmBookingRecord(1, 555);
    expect(res).toEqual({ ok: true, record_id: 555 });
    expect(ycr.ycUpdateRecord).toHaveBeenCalledTimes(1);
    const [salon, recordId, body] = ycr.ycUpdateRecord.mock.calls[0];
    expect(salon.yclients_company_id).toBe(100);
    expect(recordId).toBe(555);
    expect(body).toEqual(FULL_BODY);   // ровно эти поля: ни меньше (422), ни лишнего
  });

  test('запись читается ДО PUT, а не берётся на веру (GET по id и салону)', async () => {
    ycr.ycGetRecord.mockResolvedValue(REC);
    ycr.ycUpdateRecord.mockResolvedValue({ id: 555 });
    await confirmBookingRecord(1, 555);
    expect(ycr.ycGetRecord).toHaveBeenCalledWith(expect.objectContaining({ yclients_company_id: 100 }), 555);
    expect(ycr.ycGetRecord.mock.invocationCallOrder[0]).toBeLessThan(ycr.ycUpdateRecord.mock.invocationCallOrder[0]);
  });

  test('комментарий пустой/отсутствует → пустая строка, остальное как есть', async () => {
    ycr.ycGetRecord.mockResolvedValue({ ...REC, comment: undefined });
    ycr.ycUpdateRecord.mockResolvedValue({ id: 555 });
    await confirmBookingRecord(1, 555);
    expect(ycr.ycUpdateRecord.mock.calls[0][2]).toEqual({ ...FULL_BODY, comment: '' });
  });

  test('уже «Подтвердил» (attendance 2) → ok/already, без PUT', async () => {
    ycr.ycGetRecord.mockResolvedValue({ ...REC, attendance: 2 });
    const res = await confirmBookingRecord(1, 555);
    expect(res).toEqual({ ok: true, already: true, record_id: 555 });
    expect(ycr.ycUpdateRecord).not.toHaveBeenCalled();
  });

  test.each([
    ['«не пришёл» (attendance -1)', { attendance: -1 }],
    ['запись удалена (deleted)', { deleted: true }],
    ['удалена, хотя когда-то была подтверждена', { deleted: true, attendance: 2 }],
    ['в записи не осталось услуг (артефакт правок)', { services: [] }],
  ])('%s → ok:false, не подтверждаем, без PUT', async (_name, change) => {
    ycr.ycGetRecord.mockResolvedValue({ ...REC, ...change });
    const res = await confirmBookingRecord(1, 555);
    expect(res.ok).toBe(false);
    expect(res.error).toBeTruthy();
    expect(ycr.ycUpdateRecord).not.toHaveBeenCalled();
  });

  test('пациент уже отмечен «пришёл» (attendance 1) → ok:false: статус «Пришёл» не откатываем до «Подтвердил»', async () => {
    ycr.ycGetRecord.mockResolvedValue({ ...REC, attendance: 1 });
    const res = await confirmBookingRecord(1, 555);
    expect(res.ok).toBe(false);
    expect(res.arrived).toBe(true);
    expect(ycr.ycUpdateRecord).not.toHaveBeenCalled();
  });

  test.each([[null], [{}], [{ id: 0 }]])('записи нет (%j) → ошибка, без PUT', async (rec) => {
    ycr.ycGetRecord.mockResolvedValue(rec);
    const res = await confirmBookingRecord(1, 555);
    expect(res).toMatchObject({ ok: false, error: 'Запись не найдена.' });
    expect(ycr.ycUpdateRecord).not.toHaveBeenCalled();
  });

  test('GET упал → ok:false с текстом, без PUT', async () => {
    ycr.ycGetRecord.mockRejectedValue(new Error('YClients 404'));
    const res = await confirmBookingRecord(1, 555);
    expect(res).toEqual({ ok: false, error: 'YClients 404' });
    expect(ycr.ycUpdateRecord).not.toHaveBeenCalled();
  });

  test('салон без подключения к YClients → ok:false, в YClients не ходим', async () => {
    pool.query.mockImplementation(() => Promise.resolve({ rows: [{ ...SALON_ROW, yclients_company_id: null }] }));
    const res = await confirmBookingRecord(1, 555);
    expect(res.ok).toBe(false);
    expect(ycr.ycGetRecord).not.toHaveBeenCalled();
    expect(ycr.ycUpdateRecord).not.toHaveBeenCalled();
  });

  test('чужая запись по id клиента → foreign, без PUT', async () => {
    ycr.ycGetRecord.mockResolvedValue(REC);   // client.id 777
    const res = await confirmBookingRecord(1, 555, { expectedYcClientId: 888 });
    expect(res).toMatchObject({ ok: false, foreign: true });
    expect(ycr.ycUpdateRecord).not.toHaveBeenCalled();
  });

  test('свой клиент по id → подтверждаем', async () => {
    ycr.ycGetRecord.mockResolvedValue(REC);
    ycr.ycUpdateRecord.mockResolvedValue({ id: 555 });
    expect(await confirmBookingRecord(1, 555, { expectedYcClientId: 777 })).toEqual({ ok: true, record_id: 555 });
  });

  test('чужая запись по телефону (запись переписали на другого клиента) → foreign, без PUT', async () => {
    ycr.ycGetRecord.mockResolvedValue(REC);   // телефон записи 79001112233
    const res = await confirmBookingRecord(1, 555, { expectedPhone: '79200255591' });
    expect(res).toMatchObject({ ok: false, foreign: true });
    expect(ycr.ycUpdateRecord).not.toHaveBeenCalled();
  });

  test.each([['79001112233'], ['89001112233'], ['+7 (900) 111-22-33'], ['9001112233']])(
    'телефон записи совпадает с ожидаемым независимо от формата (%s) → подтверждаем', async (expectedPhone) => {
      ycr.ycGetRecord.mockResolvedValue({ ...REC, client: { ...REC.client, phone: '+7 900 111-22-33' } });
      ycr.ycUpdateRecord.mockResolvedValue({ id: 555 });
      expect((await confirmBookingRecord(1, 555, { expectedPhone })).ok).toBe(true);
    });

  test('у записи нет клиента вовсе, а владельца надо проверить → foreign, без PUT', async () => {
    ycr.ycGetRecord.mockResolvedValue({ ...REC, client: null });
    const res = await confirmBookingRecord(1, 555, { expectedPhone: '79001112233' });
    expect(res).toMatchObject({ ok: false, foreign: true });
    expect(ycr.ycUpdateRecord).not.toHaveBeenCalled();
  });

  test('в записи у клиента нет телефона → проверять нечем, не блокируем', async () => {
    ycr.ycGetRecord.mockResolvedValue({ ...REC, client: { id: 777, name: 'Аня' } });
    ycr.ycUpdateRecord.mockResolvedValue({ id: 555 });
    expect((await confirmBookingRecord(1, 555, { expectedPhone: '79200255591' })).ok).toBe(true);
  });

  test('лимит запросов YClients (429) повторяется, как у отмены и переноса', async () => {
    jest.useFakeTimers();
    try {
      ycr.ycGetRecord.mockResolvedValue(REC);
      ycr.ycUpdateRecord
        .mockRejectedValueOnce(new Error('Превышен лимит запросов, попробуйте повторить запрос через 0 секунд.'))
        .mockResolvedValueOnce({ id: 555 });
      const p = confirmBookingRecord(1, 555);
      await jest.advanceTimersByTimeAsync(1500);
      expect(await p).toEqual({ ok: true, record_id: 555 });
      expect(ycr.ycUpdateRecord).toHaveBeenCalledTimes(2);
    } finally { jest.useRealTimers(); }
  });

  test('отказ YClients по существу (422) → ok:false с текстом, без повторов', async () => {
    ycr.ycGetRecord.mockResolvedValue(REC);
    ycr.ycUpdateRecord.mockRejectedValue(new Error('Не передан обязательный параметр client'));
    const res = await confirmBookingRecord(1, 555);
    expect(res).toEqual({ ok: false, error: 'Не передан обязательный параметр client' });
    expect(ycr.ycUpdateRecord).toHaveBeenCalledTimes(1);
  });

  test('запись под учёткой интеграции, если она задана (автор изменения — LoyalPRO)', async () => {
    const config = require('./config');
    const prev = config.YCLIENTS_INTEGRATION_USER_TOKEN;
    config.YCLIENTS_INTEGRATION_USER_TOKEN = 'integration-token';
    try {
      ycr.ycGetRecord.mockResolvedValue(REC);
      ycr.ycUpdateRecord.mockResolvedValue({ id: 555 });
      await confirmBookingRecord(1, 555);
      expect(ycr.ycUpdateRecord.mock.calls[0][0].yclients_user_token).toBe('integration-token');
    } finally { config.YCLIENTS_INTEGRATION_USER_TOKEN = prev; }
  });
});
