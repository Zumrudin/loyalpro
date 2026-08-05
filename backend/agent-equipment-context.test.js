'use strict';

// Дедуп ОДНОВРЕМЕННЫХ загрузок контекста оборудования.
// Пациент, не назвавший врача, запускает до MAX_STAFF_OPTIONS параллельных
// computeStaffSlots, и каждый зовёт loadEquipmentContext(salon, date). У PERI
// онлайн-запись выключена почти на всём каталоге (активны 4 услуги из 317),
// поэтому путь ВСЕГДА идёт в fallback → три одинаковых одновременных /records
// (count=300) на каждое «а когда можно?». ycGetResources и ycGetServiceMeta
// кэшированы, ycGetDayRecords — нет; на нём и считаем.

jest.mock('./services/yclients-booking', () => ({
  ycGetResources: jest.fn(async () => []),
  ycGetDayRecords: jest.fn(async () => []),
}));
jest.mock('./services/yclients', () => ({ ycGetServiceMeta: jest.fn(async () => null) }));

const { ycGetDayRecords } = require('./services/yclients-booking');
const eqContext = require('./services/agent/equipment-context');

const SALON = { id: 1, yclients_company_id: 100 };
const DATE = '2026-08-05';

// Промис, который резолвится по команде теста: пока он висит, оба вызова
// loadEquipmentContext заведомо «в полёте» одновременно.
function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

beforeEach(() => {
  jest.clearAllMocks();
  ycGetDayRecords.mockResolvedValue([]);
});

describe('loadEquipmentContext — дедуп одновременных запросов', () => {
  test('два одновременных вызова с одним ключом → один запрос в YClients', async () => {
    const d = deferred();
    ycGetDayRecords.mockImplementation(() => d.promise);
    const a = eqContext.loadEquipmentContext(SALON, DATE);
    const b = eqContext.loadEquipmentContext(SALON, DATE);
    d.resolve([]);
    const [ra, rb] = await Promise.all([a, b]);
    expect(ycGetDayRecords).toHaveBeenCalledTimes(1);
    expect(ra).toBe(rb);   // обоим достался ОДИН результат, а не две копии
  });

  // Это НЕ кэш: занятость меняется постоянно, и переиспользование результата
  // после завершения означало бы предложенный занятый слот.
  test('два последовательных вызова → два запроса (результат не переживает промис)', async () => {
    await eqContext.loadEquipmentContext(SALON, DATE);
    await eqContext.loadEquipmentContext(SALON, DATE);
    expect(ycGetDayRecords).toHaveBeenCalledTimes(2);
  });

  test('одновременные вызовы на РАЗНЫЕ даты не схлопываются', async () => {
    const d = deferred();
    ycGetDayRecords.mockImplementation(() => d.promise);
    const a = eqContext.loadEquipmentContext(SALON, DATE);
    const b = eqContext.loadEquipmentContext(SALON, '2026-08-06');
    d.resolve([]);
    await Promise.all([a, b]);
    expect(ycGetDayRecords).toHaveBeenCalledTimes(2);
  });

  test('одновременные вызовы РАЗНЫХ салонов не схлопываются', async () => {
    const d = deferred();
    ycGetDayRecords.mockImplementation(() => d.promise);
    const a = eqContext.loadEquipmentContext(SALON, DATE);
    const b = eqContext.loadEquipmentContext({ id: 2, yclients_company_id: 200 }, DATE);
    d.resolve([]);
    await Promise.all([a, b]);
    expect(ycGetDayRecords).toHaveBeenCalledTimes(2);
  });

  // Запись из карты обязана уходить при ЛЮБОМ исходе: залипший промис навсегда
  // приморозил бы дату к устаревшему (а то и пустому) контексту оборудования.
  test('после сбоя ключ освобождается — следующий вызов идёт в YClients заново', async () => {
    ycGetDayRecords.mockRejectedValueOnce(new Error('502 YClients'));
    const first = await eqContext.loadEquipmentContext(SALON, DATE);
    expect(first.busy instanceof Map).toBe(true);   // мягкая деградация, не исключение
    await eqContext.loadEquipmentContext(SALON, DATE);
    expect(ycGetDayRecords).toHaveBeenCalledTimes(2);
  });
});
