'use strict';

// Пациент не назвал врача → выбор мастера делает ОН, а не модель: без staff_yc_id
// инструмент считает окна у всех исполнителей услуги и отдаёт их списком.
// Раньше модель брала мастера сама и молча предлагала его (у главврача цена выше).

jest.mock('./db', () => ({
  db: {
    one: jest.fn(async () => ({ id: 1, yclients_company_id: 100 })),
    oneOrNone: jest.fn(async () => ({ id: 1, yclients_company_id: 100 })),
    any: jest.fn(async () => []),
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

const { ycGetBookTimes } = require('./services/yclients-booking');
const svcFilter = require('./services/agent/service-filter');
const listServices = require('./services/agent/tools/list-services');
const slots = require('./services/agent/tools/get-available-slots');

// Услуга 900: Юлия (11), Пери Исамудиновна (12), Мария (13).
const CATALOG = {
  services: [
    { yc_id: 900, title: 'Биоревитализация', staff: [
      { yc_id: 11, name: 'Юлия' }, { yc_id: 12, name: 'Пери Исамудиновна' }, { yc_id: 13, name: 'Мария' },
    ] },
  ],
};
const NOON = Date.parse('2026-08-01T09:00:00+03:00');
const DATE = '2026-08-02';
const ARGS = { service_yc_id: 900, date: DATE };   // БЕЗ staff_yc_id

const bookSlot = (time) => [{ time, datetime: `${DATE}T${time}:00+03:00`, seance_length: 3600 }];

beforeEach(() => {
  jest.clearAllMocks();
  listServices.run.mockResolvedValue(CATALOG);
  ycGetBookTimes.mockResolvedValue([]);
  svcFilter.isBookable.mockReturnValue(true);
});

describe('get_available_slots без staff_yc_id — выбор специалиста пациентом', () => {
  test('окна есть у двоих → staff_options с обоими, слоты дословно', async () => {
    ycGetBookTimes.mockImplementation(async (_salon, staffId) => {
      if (staffId === 11) return bookSlot('12:00');
      if (staffId === 12) return bookSlot('15:00');
      return [];
    });
    const out = await slots.run(1, ARGS, { nowMs: NOON });
    expect(out.staff_options).toEqual([
      { staff_yc_id: 11, name: 'Юлия', position: null, slots: bookSlot('12:00') },
      { staff_yc_id: 12, name: 'Пери Исамудиновна', position: null, slots: bookSlot('15:00') },
    ]);
    expect(out.slots).toBeUndefined();
  });

  test('мастер без окон в список не попадает', async () => {
    ycGetBookTimes.mockImplementation(async (_salon, staffId) =>
      staffId === 12 ? bookSlot('15:00') : []);
    const out = await slots.run(1, ARGS, { nowMs: NOON });
    expect(out.staff_options.map(o => o.staff_yc_id)).toEqual([12]);
  });

  test('порядок — по времени первого свободного окна', async () => {
    ycGetBookTimes.mockImplementation(async (_salon, staffId) => {
      if (staffId === 11) return bookSlot('16:00');
      if (staffId === 12) return bookSlot('11:00');
      return [];
    });
    const out = await slots.run(1, ARGS, { nowMs: NOON });
    expect(out.staff_options.map(o => o.staff_yc_id)).toEqual([12, 11]);
  });

  test('hint требует перечислить всех и запрещает выбирать за пациента и называть цену', async () => {
    ycGetBookTimes.mockImplementation(async (_salon, staffId) =>
      staffId === 13 ? [] : bookSlot('12:00'));
    const out = await slots.run(1, ARGS, { nowMs: NOON });
    expect(out.hint).toMatch(/staff_options/);
    expect(out.hint).toMatch(/НЕ выбирай|не выбирай сама/);
    expect(out.hint).toMatch(/[Цц]ену не называй/);
  });

  test('передан staff_yc_id → поведение прежнее (slots одного мастера, без staff_options)', async () => {
    ycGetBookTimes.mockImplementation(async (_salon, staffId) =>
      staffId === 11 ? bookSlot('12:00') : []);
    const out = await slots.run(1, { ...ARGS, staff_yc_id: 11 }, { nowMs: NOON });
    expect(out.slots).toEqual(bookSlot('12:00'));
    expect(out.staff_options).toBeUndefined();
  });

  test('без date — прежняя ошибка', async () => {
    const out = await slots.run(1, { service_yc_id: 900 }, { nowMs: NOON });
    expect(out.error).toMatch(/date/);
  });

  test('без service_yc_id — прежняя ошибка про услугу', async () => {
    const out = await slots.run(1, { date: DATE }, { nowMs: NOON });
    expect(out.error).toMatch(/service_yc_id/);
  });
});
