'use strict';

jest.mock('./services/agent-rag', () => ({ buildKnowledgeContext: jest.fn() }));
jest.mock('./db', () => ({ db: { any: jest.fn(), one: jest.fn(), oneOrNone: jest.fn() } }));
jest.mock('./services/yclients', () => ({ ycGet: jest.fn() }));
jest.mock('./services/yclients-booking', () => ({ ycGetBookTimes: jest.fn(), ycGetBookDates: jest.fn() }));

const { db } = require('./db');
const rag = require('./services/agent-rag');
const { ycGet } = require('./services/yclients');
const { ycGetBookTimes, ycGetBookDates } = require('./services/yclients-booking');

const searchKb = require('./services/agent/tools/search-knowledge-base');
const listServices = require('./services/agent/tools/list-services');
const listStaff = require('./services/agent/tools/list-staff');
const getSlots = require('./services/agent/tools/get-available-slots');
const getDates = require('./services/agent/tools/get-available-dates');
const getClient = require('./services/agent/tools/get-client');

beforeEach(() => jest.clearAllMocks());

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
});

describe('list_services', () => {
  test('склеивает services_config с живыми ценами YClients', async () => {
    db.any.mockResolvedValue([{ yclients_service_id: 7, service_title: 'Ботокс' }]);
    db.one.mockResolvedValue({ id: 1, yclients_company_id: 100 });
    ycGet.mockResolvedValue([{ id: 7, title: 'Ботулинотерапия', price_min: 5000, price_max: 8000 }]);
    const out = await listServices.run(1, {});
    expect(out.services).toEqual([
      expect.objectContaining({ yc_id: 7, title: 'Ботулинотерапия', price_min: 5000, price_max: 8000 }),
    ]);
  });
  test('нет YClients-компании → отдаёт только заголовки из конфига', async () => {
    db.any.mockResolvedValue([{ yclients_service_id: 7, service_title: 'Ботокс' }]);
    db.one.mockResolvedValue({ id: 1, yclients_company_id: null });
    const out = await listServices.run(1, {});
    expect(out.services[0]).toEqual(expect.objectContaining({ yc_id: 7, title: 'Ботокс' }));
    expect(ycGet).not.toHaveBeenCalled();
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
  test('тянет слоты через book_times', async () => {
    db.one.mockResolvedValue({ id: 1, yclients_company_id: 100 });
    ycGetBookTimes.mockResolvedValue([{ time: '10:00', seance_length: 3600, datetime: '2026-07-20T10:00:00+03:00' }]);
    const out = await getSlots.run(1, { service_yc_id: 7, staff_yc_id: 55, date: '2026-07-20' });
    expect(ycGetBookTimes).toHaveBeenCalledWith({ id: 1, yclients_company_id: 100 }, 55, '2026-07-20', [7]);
    expect(out.slots[0].time).toBe('10:00');
  });
  test('нет мастера/даты → ошибка валидации без вызова YClients', async () => {
    const out = await getSlots.run(1, { service_yc_id: 7 });
    expect(out.error).toBeTruthy();
    expect(ycGetBookTimes).not.toHaveBeenCalled();
  });
});

describe('get_available_dates', () => {
  test('тянет доступные даты через book_dates', async () => {
    db.one.mockResolvedValue({ id: 1, yclients_company_id: 100 });
    ycGetBookDates.mockResolvedValue({ booking_dates: ['2026-07-20', '2026-07-22'] });
    const out = await getDates.run(1, { staff_yc_id: 55, service_yc_id: 7 });
    expect(ycGetBookDates).toHaveBeenCalledWith({ id: 1, yclients_company_id: 100 }, 55, [7]);
    expect(out.dates).toEqual(['2026-07-20', '2026-07-22']);
  });
  test('без услуги — service_ids пустой', async () => {
    db.one.mockResolvedValue({ id: 1, yclients_company_id: 100 });
    ycGetBookDates.mockResolvedValue({ booking_dates: [] });
    await getDates.run(1, { staff_yc_id: 55 });
    expect(ycGetBookDates).toHaveBeenCalledWith({ id: 1, yclients_company_id: 100 }, 55, []);
  });
  test('нет мастера → ошибка валидации без вызова YClients', async () => {
    const out = await getDates.run(1, {});
    expect(out.error).toBeTruthy();
    expect(ycGetBookDates).not.toHaveBeenCalled();
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
