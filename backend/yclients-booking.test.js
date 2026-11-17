'use strict';

// Legacy fixtures have not migrated local service assignments.
jest.mock('./services/service-catalog-policy', () => ({
  ...jest.requireActual('./services/service-catalog-policy'), load: jest.fn(async () => new Map()),
}));

jest.mock('./services/yclients', () => ({
  ycGet: jest.fn(),
  ycPost: jest.fn(),
  ycGetServiceMeta: jest.fn(),
}));

const { ycGet, ycPost, ycGetServiceMeta } = require('./services/yclients');
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

  test('без seanceLength (онлайн-запись выключена) длительность берётся из меты услуги', async () => {
    // Регресс инцидента 2026-07-23: management POST /records требует seance_length.
    // При выключенной онлайн-записи слот приходит из графика без длительности —
    // берём её из ycGetServiceMeta.durationByService, а не шлём undefined (иначе 422).
    ycGetServiceMeta.mockResolvedValue({
      durationByService: new Map([['7', 1800]]),
      resourceIdsByService: new Map(),
    });
    ycPost.mockResolvedValue({ id: 777 });
    await yb.ycCreateRecord(salon, {
      staffYcId: 55, serviceYcIds: [7], datetime: '2026-07-27T15:00:00+03:00',
      seanceLength: undefined, clientPhone: '79001234567', comment: 'без длительности',
    });
    expect(ycGetServiceMeta).toHaveBeenCalledWith(salon);
    expect(ycPost).toHaveBeenCalledWith(salon, '/records/100', expect.objectContaining({
      seance_length: 1800,
    }));
  });

  test('seanceLength из слота имеет приоритет и НЕ дёргает мету', async () => {
    ycPost.mockResolvedValue({ id: 1 });
    await yb.ycCreateRecord(salon, {
      staffYcId: 55, serviceYcIds: [7], datetime: '2026-07-20T10:00:00+03:00',
      seanceLength: 3600, clientPhone: '79001234567',
    });
    expect(ycGetServiceMeta).not.toHaveBeenCalled();
    expect(ycPost.mock.calls[0][2].seance_length).toBe(3600);
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

describe('managed local service assignments', () => {
  const policy = require('./services/service-catalog-policy');
  afterEach(() => policy.load.mockResolvedValue(new Map()));
  const managed = () => new Map([['7', { active: true, staffDetails: [{ id: 55, duration: 45, priceMin: 0 }] }]]);
  test('freshly verifies external pair and sends current local duration and zero price', async () => {
    policy.load.mockResolvedValue(managed());
    ycGet.mockResolvedValue([{ id: 7 }]);
    ycPost.mockResolvedValue({ id: 999 });
    await yb.ycCreateRecord(salon, { staffYcId: 55, serviceYcIds: [7], seanceLength: 1800, datetime: '2030-01-01T12:00:00+03:00' });
    expect(ycPost).toHaveBeenCalledWith(expect.anything(), '/records/100', expect.objectContaining({ services: [{ id: 7, cost: 0 }], seance_length: 2700 }));
  });
  test('removed local assignment blocks final create even with cached slot evidence', async () => {
    policy.load.mockResolvedValue(new Map([['7', { active: true, staffDetails: [] }]]));
    await expect(yb.ycCreateRecord(salon, { staffYcId: 55, serviceYcIds: [7], seanceLength: 1800 })).rejects.toThrow(/назначена/);
    expect(ycPost).not.toHaveBeenCalled();
  });
  test('upstream pair removed after offer blocks final create', async () => {
    policy.load.mockResolvedValue(managed());
    ycGet.mockResolvedValue([]);
    await expect(yb.ycCreateRecord(salon, { staffYcId: 55, serviceYcIds: [7] })).rejects.toThrow(/не подтверждено/);
    expect(ycPost).not.toHaveBeenCalled();
  });
});


test('mixed local and external services sum staff-specific durations; unknown duration blocks write', async () => {
 const policy = require('./services/service-catalog-policy');
 policy.load.mockResolvedValue(new Map([['7', {active:true, staffDetails:[{id:55,duration:45,priceMin:0}]}]]));
 ycGet.mockImplementation(async (_, path) => path.includes('/company/') ? [{id:8,duration:600,staff:[{id:55,seance_length:1800}]}] : [{id:7}]);
 try {
  await yb.ycCreateRecord(salon,{staffYcId:55,serviceYcIds:[7,8],seanceLength:600});
  expect(ycPost).toHaveBeenCalledWith(expect.anything(),expect.anything(),expect.objectContaining({seance_length:4500}));
  ycPost.mockClear();
  ycGet.mockImplementation(async (_, path) => path.includes('/company/') ? [] : [{id:7}]);
  await expect(yb.ycCreateRecord(salon,{staffYcId:55,serviceYcIds:[7,8],seanceLength:600})).rejects.toThrow(/длительность/);
  expect(ycPost).not.toHaveBeenCalled();
 } finally { policy.load.mockResolvedValue(new Map()); }
});
