'use strict';

// Регресс на баг: агент предлагал свободное время мастера, который НЕ выполняет
// запрошенную услугу (клиент назвал мастера по имени → модель брала его yc_id из
// list_staff, минуя поле staff услуги; график/кресло мастера слепы к тому, делает
// ли он процедуру). Предпроверка должна отсекать такую пару ещё на этапе слотов,
// а не только в create_booking (где уже потрачено время клиента и остаётся эскалация).

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
const listServices = require('./services/agent/tools/list-services');
const slots = require('./services/agent/tools/get-available-slots');
const parallel = require('./services/agent/tools/get-parallel-slots');

const CATALOG = {
  services: [
    { yc_id: 900, title: 'Лазерная эпиляция ног', staff: [{ yc_id: 11, name: 'Мила' }, { yc_id: 12, name: 'Пери' }] },
    { yc_id: 901, title: 'Ботулинотерапия', staff: [{ yc_id: 21, name: 'Астемир' }] },
  ],
};
const NOON = Date.parse('2026-07-23T09:00:00+03:00');

beforeEach(() => {
  jest.clearAllMocks();
  listServices.run.mockResolvedValue(CATALOG);
  ycGetBookTimes.mockResolvedValue([]);
  ycGetStaffSeances.mockResolvedValue([]);
});

describe('get_available_slots — предпроверка «мастер выполняет услугу»', () => {
  test('мастер НЕ выполняет услугу → staff_mismatch, слоты пусты, YClients не дёргаем', async () => {
    const out = await slots.run(1, { staff_yc_id: 99, service_yc_id: 900, date: '2026-07-23' }, { nowMs: NOON });
    expect(out.staff_mismatch).toBe(true);
    expect(out.slots).toEqual([]);
    expect(ycGetBookTimes).not.toHaveBeenCalled();
    expect(ycGetStaffSeances).not.toHaveBeenCalled();
  });

  test('в ошибке перечислены мастера, которые услугу выполняют (для редиректа)', async () => {
    const out = await slots.run(1, { staff_yc_id: 99, service_yc_id: 900, date: '2026-07-23' }, { nowMs: NOON });
    expect(out.error).toMatch(/Мила/);
    expect(out.error).toMatch(/Пери/);
  });

  test('мастер выполняет услугу → проходит к получению слотов', async () => {
    ycGetBookTimes.mockResolvedValue([{ time: '16:00', datetime: '2026-07-23T16:00:00+03:00', seance_length: 3600 }]);
    const out = await slots.run(1, { staff_yc_id: 11, service_yc_id: 900, date: '2026-07-23' }, { nowMs: NOON });
    expect(out.staff_mismatch).toBeUndefined();
    expect(out.slots.length).toBeGreaterThan(0);
    expect(ycGetBookTimes).toHaveBeenCalled();
  });

  test('fail-open: каталог недоступен → не блокируем, идём за слотами', async () => {
    listServices.run.mockRejectedValue(new Error('yclients down'));
    ycGetBookTimes.mockResolvedValue([{ time: '16:00', datetime: '2026-07-23T16:00:00+03:00', seance_length: 3600 }]);
    const out = await slots.run(1, { staff_yc_id: 99, service_yc_id: 900, date: '2026-07-23' }, { nowMs: NOON });
    expect(out.staff_mismatch).toBeUndefined();
    expect(ycGetBookTimes).toHaveBeenCalled();
  });

  test('без service_yc_id проверки нет — отдаём график мастера как есть', async () => {
    ycGetStaffSeances.mockResolvedValue([{ time: '16:00', is_free: true }]);
    const out = await slots.run(1, { staff_yc_id: 99, date: '2026-07-23' }, { nowMs: NOON });
    expect(out.staff_mismatch).toBeUndefined();
    expect(listServices.run).not.toHaveBeenCalled();
  });
});

describe('get_parallel_slots — предпроверка по каждому гостю', () => {
  test('один из гостей у мастера, который услугу не делает → staff_mismatch', async () => {
    const out = await parallel.run(1, {
      date: '2026-07-23',
      guests: [
        { service_yc_id: 900, staff_yc_id: 11 },  // ок
        { service_yc_id: 900, staff_yc_id: 21 },  // Астемир лазер не делает
      ],
    }, { nowMs: NOON });
    expect(out.staff_mismatch).toBe(true);
    expect(out.starts).toEqual([]);
    expect(ycGetStaffSeances).not.toHaveBeenCalled();
  });

  test('оба гостя у профильных мастеров → предпроверка пропускает', async () => {
    ycGetStaffSeances.mockResolvedValue([]);
    const out = await parallel.run(1, {
      date: '2026-07-23',
      guests: [
        { service_yc_id: 900, staff_yc_id: 11 },
        { service_yc_id: 901, staff_yc_id: 21 },
      ],
    }, { nowMs: NOON });
    expect(out.staff_mismatch).toBeUndefined();
  });
});
