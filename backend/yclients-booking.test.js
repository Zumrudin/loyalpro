'use strict';

jest.mock('./services/yclients', () => ({
  ycGet: jest.fn(),
  ycPost: jest.fn(),
}));

const { ycGet, ycPost } = require('./services/yclients');
const yb = require('./services/yclients-booking');
const config = require('./config');

const salon = { id: 1, yclients_company_id: 100, yclients_user_token: 'OWNER_TOK' };

let savedIntegTok;
beforeEach(() => {
  jest.clearAllMocks();
  savedIntegTok = config.YCLIENTS_INTEGRATION_USER_TOKEN;
  config.YCLIENTS_INTEGRATION_USER_TOKEN = '';   // детерминизм: не зависим от .env
});
afterEach(() => { config.YCLIENTS_INTEGRATION_USER_TOKEN = savedIntegTok; });

describe('ycGetBookTimes', () => {
  test('зовёт /book_times/{cid}/{staff}/{date} с service_ids', async () => {
    ycGet.mockResolvedValue([{ time: '10:00', seance_length: 3600, datetime: '2026-07-20T10:00:00+03:00' }]);
    const out = await yb.ycGetBookTimes(salon, 55, '2026-07-20', [7]);
    expect(ycGet).toHaveBeenCalledWith(salon, '/book_times/100/55/2026-07-20', { 'service_ids[0]': 7 });
    expect(out[0].time).toBe('10:00');
  });
});

describe('ycGetBookDates', () => {
  test('зовёт /book_dates/{cid} со staff и service', async () => {
    ycGet.mockResolvedValue({ booking_dates: ['2026-07-20'] });
    const out = await yb.ycGetBookDates(salon, 55, [7]);
    expect(ycGet).toHaveBeenCalledWith(salon, '/book_dates/100', { staff_id: 55, 'service_ids[0]': 7 });
    expect(out.booking_dates).toContain('2026-07-20');
  });
});

describe('ycCreateRecord', () => {
  test('POST /records/{cid} с телом брони', async () => {
    ycPost.mockResolvedValue({ id: 999 });
    const out = await yb.ycCreateRecord(salon, {
      staffYcId: 55, serviceYcIds: [7], datetime: '2026-07-20T10:00:00+03:00',
      seanceLength: 3600, clientPhone: '79001234567', clientName: 'Аня', comment: 'тест',
    });
    expect(ycPost).toHaveBeenCalledWith(salon, '/records/100', expect.objectContaining({
      staff_id: 55,
      services: [{ id: 7 }],
      datetime: '2026-07-20T10:00:00+03:00',
      seance_length: 3600,
      client: { phone: '79001234567', name: 'Аня' },
      comment: 'тест',
    }));
    expect(out.id).toBe(999);
  });

  test('с YCLIENTS_INTEGRATION_USER_TOKEN запись создаётся под токеном приложения (автор = LoyalPRO)', async () => {
    config.YCLIENTS_INTEGRATION_USER_TOKEN = 'INTEG_TOK';
    ycPost.mockResolvedValue({ id: 1 });
    await yb.ycCreateRecord(salon, {
      staffYcId: 55, serviceYcIds: [7], datetime: '2026-07-20T10:00:00+03:00',
      seanceLength: 3600, clientPhone: '79001234567', comment: 'тест',
    });
    const [passedSalon, path] = ycPost.mock.calls[0];
    expect(passedSalon.yclients_user_token).toBe('INTEG_TOK');   // не OWNER_TOK
    expect(passedSalon.yclients_company_id).toBe(100);           // остальное от салона
    expect(path).toBe('/records/100');
  });
});
