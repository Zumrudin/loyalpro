'use strict';

jest.mock('./services/agent-rag', () => ({ buildKnowledgeContext: jest.fn() }));
jest.mock('./db', () => ({ db: { any: jest.fn(), one: jest.fn(), oneOrNone: jest.fn() } }));
jest.mock('./services/yclients', () => ({ ycGet: jest.fn(), ycGetServiceCatalog: jest.fn() }));
jest.mock('./services/yclients-booking', () => ({ ycGetBookTimes: jest.fn(), ycGetStaffSchedule: jest.fn(), ycGetStaffSeances: jest.fn() }));
jest.mock('./services/agent-settings', () => ({ loadServiceFilterSafe: jest.fn() }));
jest.mock('./services/agent/booking', () => ({ createBookingRecord: jest.fn() }));

const { db } = require('./db');
const rag = require('./services/agent-rag');
const { ycGet, ycGetServiceCatalog } = require('./services/yclients');

// Хелпер: собрать возврат ycGetServiceCatalog. pairs = { svcId: [staffId,…] } →
// достоверная карта услуга→мастера. prices = { svcId: { staffId: {price_min,price_max} } } →
// цена per-staff (может отличаться между мастерами).
const catalog = (priced, pairs = {}, prices = {}) => ({
  priced,
  categories: [],
  staffIdsByService: new Map(
    Object.entries(pairs).map(([k, v]) => [String(k), new Set(v.map(String))])),
  staffPricesByService: new Map(
    Object.entries(prices).map(([k, perStaff]) =>
      [String(k), new Map(Object.entries(perStaff).map(([sid, p]) => [String(sid), p]))])),
});
const { ycGetBookTimes, ycGetStaffSchedule, ycGetStaffSeances } = require('./services/yclients-booking');
const settings = require('./services/agent-settings');
const booking = require('./services/agent/booking');

const searchKb = require('./services/agent/tools/search-knowledge-base');
const listServices = require('./services/agent/tools/list-services');
const listStaff = require('./services/agent/tools/list-staff');
const getSlots = require('./services/agent/tools/get-available-slots');
const getDates = require('./services/agent/tools/get-available-dates');
const getClient = require('./services/agent/tools/get-client');
const createBooking = require('./services/agent/tools/create-booking');

beforeEach(() => {
  jest.clearAllMocks();
  settings.loadServiceFilterSafe.mockResolvedValue({
    mode: 'all', denyServices: new Set(), allowServices: new Set(), denyPairs: new Set(),
  });
});

describe('search_knowledge_base', () => {
  test('schema имеет имя и query', () => {
    expect(searchKb.schema.name).toBe('search_knowledge_base');
    expect(searchKb.schema.input_schema.properties.query).toBeDefined();
  });
  test('run отдаёт context из RAG', async () => {
    rag.buildKnowledgeContext.mockResolvedValue({ context: 'Ботокс: от 5000 ₽', sources: [1] });
    const out = await searchKb.run(1, { query: 'ботокс' });
    expect(rag.buildKnowledgeContext).toHaveBeenCalledWith(1, 'ботокс', {});
    expect(out.context).toContain('Ботокс');
    expect(out.sources).toEqual([1]);
  });
  test('пусто → found:false', async () => {
    rag.buildKnowledgeContext.mockResolvedValue({ context: '', sources: [] });
    const out = await searchKb.run(1, { query: 'нет' });
    expect(out.found).toBe(false);
  });
  test('сбой поиска → мягкий found:false с degraded, без error (не «технические сложности»)', async () => {
    rag.buildKnowledgeContext.mockRejectedValue(new Error('aitunnel embed: пустой ответ'));
    const out = await searchKb.run(1, { query: 'эпиляция' });
    expect(out.found).toBe(false);
    expect(out.degraded).toBe(true);
    expect(out.error).toBeUndefined();   // orchestrator НЕ пометит isError
  });
});

describe('list_services', () => {
  test('активные услуги + достоверные мастера (per-staff) с ценой каждого, неактивные отфильтрованы', async () => {
    db.any
      .mockResolvedValueOnce([{ yclients_service_id: 7, service_title: 'Ботокс' }])            // services_config
      .mockResolvedValueOnce([{ yclients_staff_id: 55, name: 'Аня' }, { yclients_staff_id: 66, name: 'Пери' }]); // staff_members
    db.one.mockResolvedValue({ id: 1, yclients_company_id: 100 });
    ycGetServiceCatalog.mockResolvedValue(catalog(
      [
        { id: 7, title: 'Ботулинотерапия', price_min: 5000, price_max: 8000, active: 1 },
        { id: 11, title: 'Скрытая', price_min: 3000, price_max: 3000, active: 0 },   // active:0 без allow → выкинуть
      ],
      { 7: [55, 66], 11: [55] },
      // цена процедуры отличается между мастерами: Аня 5000, главврач Пери 8000
      { 7: { 55: { price_min: 5000, price_max: 5000 }, 66: { price_min: 8000, price_max: 8000 } } }));
    const out = await listServices.run(1, {});
    expect(out.services).toEqual([
      { yc_id: 7, title: 'Ботулинотерапия', price_min: 5000, price_max: 8000, staff: [
        { name: 'Аня', price_min: 5000, price_max: 5000 },
        { name: 'Пери', price_min: 8000, price_max: 8000 },
      ] },
    ]);
  });
  test('per-staff цена отсутствует → фолбэк на общий диапазон услуги', async () => {
    db.any
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ yclients_staff_id: 55, name: 'Аня' }]);
    db.one.mockResolvedValue({ id: 1, yclients_company_id: 100 });
    ycGetServiceCatalog.mockResolvedValue(catalog(
      [{ id: 7, title: 'Пилинг', price_min: 4000, price_max: 4000, active: 1 }],
      { 7: [55] }));   // prices не заданы
    const out = await listServices.run(1, {});
    expect(out.services[0].staff).toEqual([{ name: 'Аня', price_min: 4000, price_max: 4000 }]);
  });
  test('неизвестный staff_id услуги отбрасывается (нет в staff_members)', async () => {
    db.any
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ yclients_staff_id: 55, name: 'Аня' }]);
    db.one.mockResolvedValue({ id: 1, yclients_company_id: 100 });
    ycGetServiceCatalog.mockResolvedValue(catalog(
      [{ id: 7, title: 'Пилинг', price_min: 4000, price_max: 4000, active: 1 }],
      { 7: [55, 999] }));
    const out = await listServices.run(1, {});
    expect(out.services[0].staff.map(s => s.name)).toEqual(['Аня']);   // 999 не резолвится → выброшен
  });
  test('нет YClients-компании → отдаёт только заголовки из конфига (staff пуст)', async () => {
    db.any
      .mockResolvedValueOnce([{ yclients_service_id: 7, service_title: 'Ботокс' }])
      .mockResolvedValueOnce([]);
    db.one.mockResolvedValue({ id: 1, yclients_company_id: null });
    const out = await listServices.run(1, {});
    expect(out.services[0]).toEqual(expect.objectContaining({ yc_id: 7, title: 'Ботокс', staff: [] }));
    expect(ycGetServiceCatalog).not.toHaveBeenCalled();
  });
  test('скрывает deny-услуги и deny-пары услуга×мастер', async () => {
    db.any
      .mockResolvedValueOnce([])                                                            // services_config
      .mockResolvedValueOnce([{ yclients_staff_id: 5, name: 'Аня' }, { yclients_staff_id: 6, name: 'Пери' }]); // staff_members
    db.one.mockResolvedValue({ id: 1, yclients_company_id: 100 });
    ycGetServiceCatalog.mockResolvedValue(catalog(
      [
        { id: 10, title: 'A', price_min: 1000, price_max: 1000, active: 1 },
        { id: 20, title: 'B', price_min: 500, price_max: 500, active: 1 },
      ],
      { 10: [5, 6], 20: [6] }));
    settings.loadServiceFilterSafe.mockResolvedValue({
      mode: 'all', denyServices: new Set(['20']), allowServices: new Set(), denyPairs: new Set(['10:5']),
    });
    const out = await listServices.run(1, {});
    const ids = out.services.map(s => s.yc_id);
    expect(ids).not.toContain(20);              // услуга целиком скрыта
    const a = out.services.find(s => s.yc_id === 10);
    const aNames = a.staff.map(s => s.name);
    expect(aNames).not.toContain('Аня');        // пара 10:5 скрыта (Аня = мастер 5)
    expect(aNames).toContain('Пери');           // мастер 6 остаётся
  });
  test('active:0 услуга каталога показывается, если явно разрешена (allow)', async () => {
    db.any
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ yclients_staff_id: 5, name: 'Аня' }]);
    db.one.mockResolvedValue({ id: 1, yclients_company_id: 100 });
    ycGetServiceCatalog.mockResolvedValue(catalog(
      [
        { id: 30, title: 'Филлер', price_min: 20000, price_max: 20000, active: 0 }, // не в онлайн-записи
        { id: 31, title: 'Прочее', price_min: 1000, price_max: 1000, active: 0 },   // active:0, без allow → скрыта
      ],
      { 30: [5], 31: [5] }));
    settings.loadServiceFilterSafe.mockResolvedValue({
      mode: 'all', denyServices: new Set(), allowServices: new Set(['30']), denyPairs: new Set(),
    });
    const out = await listServices.run(1, {});
    const ids = out.services.map(s => s.yc_id);
    expect(ids).toContain(30);       // явно разрешена
    expect(ids).not.toContain(31);   // active:0 без allow остаётся скрытой
  });
  test('YClients упал → фолбэк на конфиг', async () => {
    db.any
      .mockResolvedValueOnce([{ yclients_service_id: 7, service_title: 'Ботокс' }])
      .mockResolvedValueOnce([]);
    db.one.mockResolvedValue({ id: 1, yclients_company_id: 100 });
    ycGetServiceCatalog.mockRejectedValue(new Error('yc down'));
    const out = await listServices.run(1, {});
    expect(out.services[0]).toEqual(expect.objectContaining({ yc_id: 7, title: 'Ботокс', staff: [] }));
  });
});

describe('list_staff', () => {
  test('активные мастера салона', async () => {
    db.any.mockResolvedValue([{ yclients_staff_id: 55, name: 'Аня', specialization: 'косметолог' }]);
    const out = await listStaff.run(1, {});
    expect(out.staff).toEqual([{ yc_id: 55, name: 'Аня', specialization: 'косметолог' }]);
    const sql = db.any.mock.calls[0][0];
    expect(sql).toMatch(/is_active\s*=\s*true/i);
    expect(db.any.mock.calls[0][1]).toEqual([1]);
  });
});

describe('get_available_slots', () => {
  // Фиксируем «сейчас» на 2026-07-19 12:00 МСК → даты 2026-07-20+ в будущем,
  // фильтр прошедшего времени неактивен (детерминизм независимо от часов машины).
  const NOW = { nowMs: Date.parse('2026-07-19T12:00:00+03:00') };
  const grid1000to1100 = () => {
    const grid = [];
    for (let m = 600; m < 660; m += 5) grid.push({ time: toHHMM(m), is_free: true });
    return grid;
  };
  const toHHMM = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

  test('онлайн-запись: слоты под услугу через book_times', async () => {
    db.one.mockResolvedValue({ id: 1, yclients_company_id: 100 });
    ycGetBookTimes.mockResolvedValue([{ time: '10:00', seance_length: 3600, datetime: '2026-07-20T10:00:00+03:00' }]);
    const out = await getSlots.run(1, { service_yc_id: 7, staff_yc_id: 55, date: '2026-07-20' }, NOW);
    expect(ycGetBookTimes).toHaveBeenCalledWith({ id: 1, yclients_company_id: 100 }, 55, '2026-07-20', [7]);
    expect(out.source).toBe('booking');
    expect(out.slots[0].time).toBe('10:00');
    expect(ycGetStaffSeances).not.toHaveBeenCalled();
  });
  test('book_times пусто → fallback на seances (интервалы + старты шагом 30 мин)', async () => {
    db.one.mockResolvedValue({ id: 1, yclients_company_id: 100 });
    ycGetBookTimes.mockResolvedValue([]);
    ycGetStaffSeances.mockResolvedValue(grid1000to1100());   // 10:00–11:00 свободно
    const out = await getSlots.run(1, { service_yc_id: 7, staff_yc_id: 55, date: '2026-07-20' }, NOW);
    expect(out.source).toBe('schedule');
    expect(out.free_ranges).toEqual([{ from: '10:00', to: '11:00' }]);
    // шагом 30 мин, чтобы влез полный шаг: 10:00 и 10:30 (11:00 не влезает)
    expect(out.slots.map(s => s.time)).toEqual(['10:00', '10:30']);
    expect(out.slots[0].datetime).toBe('2026-07-20T10:00:00+03:00');
  });
  test('дата = сегодня → уже прошедшие окна отрезаны (не предлагаем прошлое)', async () => {
    db.one.mockResolvedValue({ id: 1, yclients_company_id: 100 });
    ycGetBookTimes.mockResolvedValue([
      { time: '10:00', datetime: '2026-07-19T10:00:00+03:00' },   // прошло (сейчас 12:00)
      { time: '13:00', datetime: '2026-07-19T13:00:00+03:00' },   // ещё будет
      { time: '15:30', datetime: '2026-07-19T15:30:00+03:00' },
    ]);
    const out = await getSlots.run(1, { service_yc_id: 7, staff_yc_id: 55, date: '2026-07-19' }, NOW);
    expect(out.slots.map(s => s.time)).toEqual(['13:00', '15:30']);
  });
  test('дата = сегодня, schedule: free_ranges тоже подрезаются по текущему времени', async () => {
    db.one.mockResolvedValue({ id: 1, yclients_company_id: 100 });
    ycGetBookTimes.mockResolvedValue([]);
    // 10:00–14:00 свободно, сейчас 12:00 → остаётся 12:00–14:00
    const grid = [];
    for (let m = 600; m < 840; m += 5) grid.push({ time: toHHMM(m), is_free: true });
    ycGetStaffSeances.mockResolvedValue(grid);
    const out = await getSlots.run(1, { service_yc_id: 7, staff_yc_id: 55, date: '2026-07-19' }, NOW);
    expect(out.free_ranges).toEqual([{ from: '12:00', to: '14:00' }]);
    expect(out.slots.every(s => s.time >= '12:00')).toBe(true);
  });
  test('без service_yc_id сразу идёт в seances (book_times не зовётся)', async () => {
    db.one.mockResolvedValue({ id: 1, yclients_company_id: 100 });
    ycGetStaffSeances.mockResolvedValue([]);
    const out = await getSlots.run(1, { staff_yc_id: 55, date: '2026-07-20' }, NOW);
    expect(ycGetBookTimes).not.toHaveBeenCalled();
    expect(out.source).toBe('schedule');
    expect(out.slots).toEqual([]);
  });
  test('нет мастера/даты → ошибка валидации без вызова YClients', async () => {
    const out = await getSlots.run(1, { service_yc_id: 7 });
    expect(out.error).toBeTruthy();
    expect(ycGetBookTimes).not.toHaveBeenCalled();
    expect(ycGetStaffSeances).not.toHaveBeenCalled();
  });
});

describe('get_available_dates', () => {
  test('возвращает график: рабочие дни с часами (management /schedule)', async () => {
    db.one.mockResolvedValue({ id: 1, yclients_company_id: 100 });
    ycGetStaffSchedule.mockResolvedValue([
      { date: '2026-07-20', is_working: 1, slots: [{ from: '10:00', to: '22:00' }] },
      { date: '2026-07-21', is_working: 0, slots: [] },
      { date: '2026-07-22', is_working: 1, slots: [{ from: '09:00', to: '15:00' }] },
    ]);
    const out = await getDates.run(1, { staff_yc_id: 55, date_from: '2026-07-20', date_to: '2026-07-22' });
    expect(ycGetStaffSchedule).toHaveBeenCalledWith({ id: 1, yclients_company_id: 100 }, 55, '2026-07-20', '2026-07-22');
    // выходной (is_working:0) отфильтрован
    expect(out.schedule).toEqual([
      { date: '2026-07-20', hours: [{ from: '10:00', to: '22:00' }] },
      { date: '2026-07-22', hours: [{ from: '09:00', to: '15:00' }] },
    ]);
    expect(out.working_days_count).toBe(2);
  });
  test('без date_from/date_to — период по умолчанию (передаёт две даты)', async () => {
    db.one.mockResolvedValue({ id: 1, yclients_company_id: 100 });
    ycGetStaffSchedule.mockResolvedValue([]);
    const out = await getDates.run(1, { staff_yc_id: 55 });
    const args = ycGetStaffSchedule.mock.calls[0];
    expect(args[1]).toBe(55);
    expect(args[2]).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(args[3]).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(out.schedule).toEqual([]);
    expect(out.working_days_count).toBe(0);
  });
  test('нет мастера → ошибка валидации без вызова YClients', async () => {
    const out = await getDates.run(1, {});
    expect(out.error).toBeTruthy();
    expect(ycGetStaffSchedule).not.toHaveBeenCalled();
  });
});

describe('get_client', () => {
  test('находит клиента по телефону в этом салоне', async () => {
    db.oneOrNone.mockResolvedValue({ id: 42, name: 'Аня', phone: '79001234567' });
    const out = await getClient.run(1, { phone: '89001234567' });
    expect(out.found).toBe(true);
    expect(out.client.id).toBe(42);
    // телефон нормализован к 7XXXXXXXXXX перед поиском
    expect(db.oneOrNone.mock.calls[0][1]).toEqual([1, '79001234567']);
  });
  test('не найден → found:false', async () => {
    db.oneOrNone.mockResolvedValue(null);
    const out = await getClient.run(1, { phone: '79990000000' });
    expect(out.found).toBe(false);
  });
});

describe('create_booking', () => {
  test('отказывает при скрытой паре услуга×мастер и НЕ создаёт запись', async () => {
    settings.loadServiceFilterSafe.mockResolvedValue({
      mode: 'all', denyServices: new Set(), allowServices: new Set(), denyPairs: new Set(['10:5']),
    });
    const out = await createBooking.run(1, {
      staff_yc_id: 5, service_yc_id: 10,
      datetime: '2026-07-20T10:00:00+03:00', client_phone: '79990000000',
    });
    expect(out.not_bookable).toBe(true);
    expect(booking.createBookingRecord).not.toHaveBeenCalled();
  });
});
