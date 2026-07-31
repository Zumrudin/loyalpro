'use strict';

// Регресс на инцидент 2026-08-01: клиент просил «Голливуд» на завтра, модель
// проверила слоты только запрошенного мастера (Юлии), получила пусто и сказала
// «на завтра свободных окошек нет» — хотя у Татьяны было 14:00 на ту же услугу.
// Фикс детерминированный: при пустой выдаче get_available_slots САМ проверяет
// других исполнителей услуги на ту же дату и кладёт их окна в alternative_staff.

jest.mock('./db', () => ({
  db: {
    one: jest.fn(async () => ({ id: 1, yclients_company_id: 100 })),
    oneOrNone: jest.fn(async () => ({ id: 1, yclients_company_id: 100 })),
  },
}));
jest.mock('./services/yclients-booking', () => ({
  ycGetBookTimes: jest.fn(async () => []),
  ycGetStaffSeances: jest.fn(async () => []),
}));
jest.mock('./services/agent-settings', () => ({ loadServiceFilterSafe: jest.fn(async () => ({})) }));
jest.mock('./services/agent/service-filter', () => ({ isBookable: jest.fn(() => true) }));
jest.mock('./services/agent/equipment-context', () => ({
  loadEquipmentContext: jest.fn(async () => ({ busy: [], resources: [] })),
  durationMin: jest.fn(() => 60),
  instancesFor: jest.fn(() => []),
  busyForService: jest.fn(() => []),
}));
jest.mock('./services/agent/tools/list-services', () => ({ run: jest.fn() }));

const { ycGetBookTimes, ycGetStaffSeances } = require('./services/yclients-booking');
const svcFilter = require('./services/agent/service-filter');
const listServices = require('./services/agent/tools/list-services');
const slots = require('./services/agent/tools/get-available-slots');

// Услуга 900 «Голливуд»: Юлия (11), Татьяна (12), Мария (13).
const CATALOG = {
  services: [
    { yc_id: 900, title: 'ProFacial «Голливуд»', staff: [
      { yc_id: 11, name: 'Юлия' }, { yc_id: 12, name: 'Татьяна' }, { yc_id: 13, name: 'Мария' },
    ] },
  ],
};
const NOON = Date.parse('2026-08-01T09:00:00+03:00');
const DATE = '2026-08-02';
const ARGS = { staff_yc_id: 11, service_yc_id: 900, date: DATE };

beforeEach(() => {
  jest.clearAllMocks();
  listServices.run.mockResolvedValue(CATALOG);
  ycGetBookTimes.mockResolvedValue([]);
  ycGetStaffSeances.mockResolvedValue([]);
  svcFilter.isBookable.mockReturnValue(true);
});

const bookSlot = (time) => [{ time, datetime: `${DATE}T${time}:00+03:00`, seance_length: 3600 }];

describe('get_available_slots — альтернативный мастер при пустой выдаче', () => {
  test('у запрошенного пусто, у другого мастера есть окно → alternative_staff с именем и слотами', async () => {
    ycGetBookTimes.mockImplementation(async (_salon, staffId) =>
      staffId === 12 ? bookSlot('14:00') : []);
    const out = await slots.run(1, ARGS, { nowMs: NOON });
    expect(out.slots).toEqual([]);
    expect(out.alternative_staff).toEqual([
      { staff_yc_id: 12, name: 'Татьяна', slots: bookSlot('14:00') },
    ]);
    expect(out.hint).toMatch(/другие мастера/);
    expect(out.no_alternative_staff).toBeUndefined();
  });

  test('у запрошенного мастера слоты есть → других НЕ проверяем, alternative_staff нет', async () => {
    ycGetBookTimes.mockImplementation(async (_salon, staffId) =>
      staffId === 11 ? bookSlot('10:00') : bookSlot('14:00'));
    const out = await slots.run(1, ARGS, { nowMs: NOON });
    expect(out.slots.length).toBe(1);
    expect(out.alternative_staff).toBeUndefined();
    expect(ycGetBookTimes).toHaveBeenCalledTimes(1);
  });

  test('пусто у ВСЕХ исполнителей → no_alternative_staff:true (можно честно сказать «ни у кого»)', async () => {
    const out = await slots.run(1, ARGS, { nowMs: NOON });
    expect(out.slots).toEqual([]);
    expect(out.alternative_staff).toBeUndefined();
    expect(out.no_alternative_staff).toBe(true);
    // проверены оба альтернативных мастера (12 и 13), не только запрошенный
    const asked = ycGetBookTimes.mock.calls.map(c => c[1]).sort();
    expect(asked).toEqual([11, 12, 13]);
  });

  test('альтернативы тоже проходят lead-time: слот «впритык» не подсвечивается', async () => {
    // Сейчас 13:30 мск того же дня; у Татьяны окно в 14:00 — ближе 2 часов.
    const now = Date.parse('2026-08-02T13:30:00+03:00');
    ycGetBookTimes.mockImplementation(async (_salon, staffId) =>
      staffId === 12 ? bookSlot('14:00') : []);
    const out = await slots.run(1, ARGS, { nowMs: now });
    expect(out.alternative_staff).toBeUndefined();
    expect(out.no_alternative_staff).toBe(true);
  });

  test('скрытая пара услуга+мастер не предлагается как альтернатива', async () => {
    ycGetBookTimes.mockImplementation(async (_salon, staffId) =>
      staffId === 11 ? [] : bookSlot('14:00'));
    svcFilter.isBookable.mockImplementation((_f, _svc, staffId) => staffId !== 12);
    const out = await slots.run(1, ARGS, { nowMs: NOON });
    // Татьяна (12) скрыта фильтром — осталась только Мария (13)
    expect(out.alternative_staff).toEqual([
      { staff_yc_id: 13, name: 'Мария', slots: bookSlot('14:00') },
    ]);
  });

  test('сбой YClients по одному из альтернативных мастеров не валит ответ', async () => {
    ycGetBookTimes.mockImplementation(async (_salon, staffId) => {
      if (staffId === 12) throw new Error('yclients 500');
      return staffId === 13 ? bookSlot('16:30') : [];
    });
    const out = await slots.run(1, ARGS, { nowMs: NOON });
    expect(out.alternative_staff).toEqual([
      { staff_yc_id: 13, name: 'Мария', slots: bookSlot('16:30') },
    ]);
  });

  test('сбой по всем альтернативам → ни alternative_staff, ни no_alternative_staff (не врём «ни у кого»)', async () => {
    ycGetBookTimes.mockImplementation(async (_salon, staffId) => {
      if (staffId !== 11) throw new Error('yclients 500');
      return [];
    });
    const out = await slots.run(1, ARGS, { nowMs: NOON });
    expect(out.slots).toEqual([]);
    expect(out.alternative_staff).toBeUndefined();
    expect(out.no_alternative_staff).toBeUndefined();
  });

  test('каталог недоступен (fail-open предпроверки) → альтернатив нет, ответ прежний', async () => {
    listServices.run.mockRejectedValue(new Error('yclients down'));
    const out = await slots.run(1, ARGS, { nowMs: NOON });
    expect(out.slots).toEqual([]);
    expect(out.alternative_staff).toBeUndefined();
    expect(out.no_alternative_staff).toBeUndefined();
  });

  test('fallback-режим (график): окна других мастеров тоже считаются', async () => {
    // Онлайн-запись пуста у всех; график: у Юлии всё занято, у Татьяны 14:00–15:00.
    ycGetStaffSeances.mockImplementation(async (_salon, staffId) =>
      staffId === 12
        ? [0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55].map(m =>
            ({ time: `14:${String(m).padStart(2, '0')}`, is_free: true }))
        : []);
    const out = await slots.run(1, ARGS, { nowMs: NOON });
    expect(out.alternative_staff).toBeDefined();
    const alt = out.alternative_staff.find(a => a.staff_yc_id === 12);
    expect(alt.slots.map(s => s.time)).toEqual(['14:00']);   // 60-мин услуга в часовом окне
  });
});
