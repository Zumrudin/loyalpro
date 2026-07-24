'use strict';

jest.mock('./db', () => ({ db: { oneOrNone: jest.fn() } }));

const { db } = require('./db');
const identity = require('./services/agent/identity');

beforeEach(() => jest.clearAllMocks());

describe('identity.resolveClient', () => {
  test('находит карточку по полному нормализованному номеру', async () => {
    db.oneOrNone.mockResolvedValue({ id: 7, name: 'Анна', phone: '79001234567' });
    const out = await identity.resolveClient(1, '8 (900) 123-45-67');
    expect(out).toEqual({ id: 7, name: 'Анна', phone: '79001234567' });
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

describe('identity.resolveYclientsClientId', () => {
  test('короткий номер → null без запроса в БД', async () => {
    const out = await identity.resolveYclientsClientId(1, '4567');
    expect(out).toBeNull();
    expect(db.oneOrNone).not.toHaveBeenCalled();
  });

  test('полный номер → yc_client_id числом', async () => {
    db.oneOrNone.mockResolvedValue({ yc_client_id: '555' });
    const out = await identity.resolveYclientsClientId(1, '79001234567');
    expect(out).toBe(555);
  });
});
