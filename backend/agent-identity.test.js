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
    expect(out).toEqual({ id: 7, name: 'Анна', givenName: 'Анна', phone: '79001234567' });
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
