'use strict';

jest.mock('./db', () => ({ db: { oneOrNone: jest.fn(), any: jest.fn() } }));

const { db } = require('./db');
const identity = require('./services/agent/identity');
const salonNames = require('./utils/salon-names');

beforeEach(() => { jest.clearAllMocks(); salonNames._reset(); db.any.mockResolvedValue([]); });

describe('identity.resolveClient', () => {
  test('находит карточку по полному нормализованному номеру', async () => {
    db.oneOrNone.mockResolvedValue({ id: 7, name: 'Анна', phone: '79001234567' });
    const out = await identity.resolveClient(1, '8 (900) 123-45-67');
    expect(out).toEqual({ id: 7, name: 'Анна', givenName: 'Анна', phone: '79001234567', visits: null, lastVisitAt: null });
    expect(db.oneOrNone.mock.calls[0][1]).toEqual([1, '79001234567']);
  });

  test('короткий номер → null без запроса в БД (суффиксный LIKE зацепил бы чужой номер)', async () => {
    const out = await identity.resolveClient(1, '123');
    expect(out).toBeNull();
    expect(db.oneOrNone).not.toHaveBeenCalled();
  });

  test('пустой номер или salonId → null (fail-closed)', async () => {
    expect(await identity.resolveClient(1, '')).toBeNull();
    expect(await identity.resolveClient(null, '79001234567')).toBeNull();
    expect(db.oneOrNone).not.toHaveBeenCalled();
  });
});

// Инцидент 2026-08-04: пациентке ушло «Мария Андреевна, …» — в промпт попадало
// ФИО целиком. В чат имеет право уйти только личное имя.
describe('identity.resolveClient — имя для обращения', () => {
  test('ФИО одной строкой → в givenName только имя, name остаётся полным', async () => {
    db.oneOrNone.mockResolvedValue({
      id: 8685, name: 'Вихарева Мария Андреевна', phone: '+79133850883', yclients_data: null });
    const out = await identity.resolveClient(1, '79133850883');
    expect(out.givenName).toBe('Мария');
    expect(out.name).toBe('Вихарева Мария Андреевна');
  });

  test('раздельные поля YClients точнее склейки', async () => {
    db.oneOrNone.mockResolvedValue({
      id: 1, name: 'Вихарева Мария Андреевна', phone: '79133850883',
      yclients_data: { name: 'Мария', surname: 'Вихарева', patronymic: 'Андреевна' } });
    expect((await identity.resolveClient(1, '79133850883')).givenName).toBe('Мария');
  });

  test('вместо имени телефон → givenName null (бот спросит, как обращаться)', async () => {
    db.oneOrNone.mockResolvedValue({ id: 2, name: '79265303607', phone: '79265303607' });
    expect((await identity.resolveClient(1, '79265303607')).givenName).toBeNull();
  });

  test('редкое имя добирается словарём салона', async () => {
    db.any.mockResolvedValue([{ name: 'Абулаева Мирлана Ахмедовна' }]);
    db.oneOrNone.mockResolvedValue({ id: 3, name: 'Мирлана', phone: '79001112233' });
    expect((await identity.resolveClient(1, '79001112233')).givenName).toBe('Мирлана');
  });

  test('падение словаря не роняет идентификацию', async () => {
    db.any.mockRejectedValue(new Error('db down'));
    db.oneOrNone.mockResolvedValue({ id: 4, name: 'Вихарева Мария Андреевна', phone: '79133850883' });
    const out = await identity.resolveClient(1, '79133850883');
    expect(out.givenName).toBe('Мария');   // базовый словарь и позиция по отчеству работают
  });
});

// Инцидент 2026-11-09 (79082417232): Мила велела взять паспорт клиентке с двумя
// визитами — признака «повторный пациент» в промпте не было.
describe('identity.visitStats — число визитов для промпта', () => {
  test('берётся больший из карточки YClients и records', () => {
    const v = identity.visitStats({ visits_count: 2, rec_visits: 1,
      last_visit_at: '2026-06-08T08:40:00Z', rec_last_at: '2026-06-08T08:40:00Z' });
    expect(v.visits).toBe(2);
    expect(v.lastVisitAt.toISOString()).toBe('2026-06-08T08:40:00.000Z');
  });
  test('client-вебхук не дошёл (visits_count NULL) → считаем по records', () => {
    const v = identity.visitStats({ visits_count: null, rec_visits: 3, last_visit_at: null, rec_last_at: '2026-10-01T10:00:00Z' });
    expect(v.visits).toBe(3);
    expect(v.lastVisitAt.toISOString()).toBe('2026-10-01T10:00:00.000Z');
  });
  test('ни один источник ничего не знает → visits null (а не «0 визитов»)', () => {
    expect(identity.visitStats({})).toEqual({ visits: null, lastVisitAt: null });
  });
  test('пустая история → 0', () => {
    expect(identity.visitStats({ visits_count: 0, rec_visits: 0 }).visits).toBe(0);
  });
  test('resolveClient отдаёт визиты, SQL считает только состоявшиеся прошедшие записи', async () => {
    db.oneOrNone.mockResolvedValue({ id: 4180, name: 'Мазеина Анастасия Алексеевна', phone: '+79082417232',
      visits_count: 2, rec_visits: 1, last_visit_at: '2026-06-08T08:40:00Z', rec_last_at: null });
    const out = await identity.resolveClient(1, '79082417232');
    expect(out.visits).toBe(2);
    const sql = db.oneOrNone.mock.calls[0][0];
    expect(sql).toMatch(/status IN \('arrived', 'completed'\)/);
    expect(sql).toMatch(/visit_datetime <= now\(\)/);
  });
});
