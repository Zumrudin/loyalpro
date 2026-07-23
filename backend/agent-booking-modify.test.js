'use strict';

jest.mock('./db', () => ({ pool: { query: jest.fn() } }));
jest.mock('./services/yclients-records', () => ({
  ycGetRecord: jest.fn(), ycUpdateRecord: jest.fn(),
}));

const { pool } = require('./db');
const ycr = require('./services/yclients-records');
const { cancelBookingRecord, rescheduleBookingRecord, CANCEL_SEANCE_LENGTH } =
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
});
