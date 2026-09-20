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
const { cancelBookingRecord, rescheduleBookingRecord, modifyBookingServices, CANCEL_SEANCE_LENGTH } =
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
