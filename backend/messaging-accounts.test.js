'use strict';

jest.mock('./db', () => ({ db: { query: jest.fn(), oneOrNone: jest.fn(), any: jest.fn() } }));
jest.mock('./config', () => ({
  CHATPUSH: { apiBase: 'https://api.chatpush.ru', instanceToken: 'ENVTOKEN', customerId: 777, salonId: 1 },
  MESSAGING_GATEWAY: { url: 'http://127.0.0.1:3002', secret: 's', webhookSecret: 'w' },
}));

const { db } = require('./db');
const accounts = require('./services/messaging/accounts');

beforeEach(() => { jest.clearAllMocks(); accounts.invalidate(); });

describe('credentialsFor', () => {
  test('строка chatpush → apiBase из строки, token из строки', async () => {
    db.oneOrNone.mockResolvedValueOnce({ id: 5, provider: 'chatpush', channel: 'tdlib', api_base: 'https://api.chatpush.ru', token: 'ROWTOKEN' });
    const c = await accounts.credentialsFor(1, 'tdlib');
    expect(c).toEqual({ id: 5, provider: 'chatpush', channel: 'tdlib', apiBase: 'https://api.chatpush.ru', token: 'ROWTOKEN' });
    const [sql, params] = db.oneOrNone.mock.calls[0];
    expect(sql).toMatch(/FROM messenger_accounts/);
    expect(sql).toMatch(/status = 'active'/);
    expect(params).toEqual([1, 'tdlib']);
  });

  test('строка gateway → apiBase из config.MESSAGING_GATEWAY.url, не из строки', async () => {
    db.oneOrNone.mockResolvedValueOnce({ id: 9, provider: 'gateway', channel: 'tdlib', api_base: null, token: 'GW' });
    const c = await accounts.credentialsFor(1, 'tdlib');
    expect(c.apiBase).toBe('http://127.0.0.1:3002');
    expect(c.token).toBe('GW');
  });

  test('строки нет, салон из env → legacy-креды из env', async () => {
    db.oneOrNone.mockResolvedValueOnce(null);
    const c = await accounts.credentialsFor(1, 'whatsapp');
    expect(c).toEqual({ id: 'env', provider: 'chatpush', channel: 'whatsapp', apiBase: 'https://api.chatpush.ru', token: 'ENVTOKEN' });
  });

  test('строки нет, чужой салон → null (не подставлять чужой токен)', async () => {
    db.oneOrNone.mockResolvedValueOnce(null);
    expect(await accounts.credentialsFor(2, 'whatsapp')).toBeNull();
  });

  test('кэш 60 с: второй вызов не ходит в БД, invalidate сбрасывает', async () => {
    db.oneOrNone.mockResolvedValue({ id: 5, provider: 'chatpush', channel: 'max', api_base: 'x', token: 't' });
    await accounts.credentialsFor(1, 'max');
    await accounts.credentialsFor(1, 'max');
    expect(db.oneOrNone).toHaveBeenCalledTimes(1);
    accounts.invalidate();
    await accounts.credentialsFor(1, 'max');
    expect(db.oneOrNone).toHaveBeenCalledTimes(2);
  });

  test('сбой БД → fallback на env для своего салона, null для чужого', async () => {
    db.oneOrNone.mockRejectedValue(new Error('db down'));
    expect((await accounts.credentialsFor(1, 'tdlib')).token).toBe('ENVTOKEN');
    expect(await accounts.credentialsFor(2, 'tdlib')).toBeNull();
  });
});

describe('resolveSalon', () => {
  test('по (provider, external_id) из БД', async () => {
    db.oneOrNone.mockResolvedValueOnce({ salon_id: 3 });
    expect(await accounts.resolveSalon('gateway', 12)).toBe(3);
    expect(db.oneOrNone.mock.calls[0][1]).toEqual(['gateway', '12']);
  });
  test('chatpush без строки → env-мэппинг (customer совпал)', async () => {
    db.oneOrNone.mockResolvedValueOnce(null);
    expect(await accounts.resolveSalon('chatpush', 777)).toBe(1);
  });
  test('chatpush без строки, customer не совпал → null', async () => {
    db.oneOrNone.mockResolvedValueOnce(null);
    expect(await accounts.resolveSalon('chatpush', 1)).toBeNull();
  });
  test('gateway без строки → null (env к шлюзу не относится)', async () => {
    db.oneOrNone.mockResolvedValueOnce(null);
    expect(await accounts.resolveSalon('gateway', 777)).toBeNull();
  });
});

describe('listForSalon', () => {
  test('отдаёт строки салона без токена', async () => {
    db.any.mockResolvedValueOnce([{ id: 1, provider: 'chatpush', channel: 'tdlib', status: 'active', token: 'SECRET', phone: null, auth_state: null, auth_error: null, display_name: 'x', created_at: 'd' }]);
    const rows = await accounts.listForSalon(1);
    expect(rows[0].token).toBeUndefined();
    expect(rows[0]).toMatchObject({ id: 1, provider: 'chatpush', channel: 'tdlib', status: 'active' });
  });
});
