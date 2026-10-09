'use strict';

jest.mock('./db', () => ({ db: { query: jest.fn(), oneOrNone: jest.fn(), any: jest.fn() } }));
jest.mock('./config', () => ({
  CHATPUSH: { apiBase: 'https://api.chatpush.ru', instanceToken: 'ENVTOKEN', customerId: 777, salonId: 1 },
  MESSAGING_GATEWAY: { url: 'http://127.0.0.1:3002', secret: 's', webhookSecret: 'w' },
}));
jest.mock('./logger', () => {
  const log = { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() };
  return { createLogger: () => log, __log: log };
});

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
    db.oneOrNone.mockResolvedValueOnce(null).mockResolvedValueOnce(null);
    const c = await accounts.credentialsFor(1, 'whatsapp');
    expect(c).toEqual({ id: 'env', provider: 'chatpush', channel: 'whatsapp', apiBase: 'https://api.chatpush.ru', token: 'ENVTOKEN' });
  });

  test('строки нет, чужой салон → null (не подставлять чужой токен)', async () => {
    db.oneOrNone.mockResolvedValueOnce(null).mockResolvedValueOnce(null);
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

describe('credentialsFor — ревью', () => {
  afterEach(() => { jest.restoreAllMocks(); });

  test('TTL: через 61 с снова идёт в БД', async () => {
    const row = { id: 5, provider: 'chatpush', channel: 'max', api_base: 'x', token: 't' };
    db.oneOrNone.mockResolvedValue(row);
    const t0 = 1_000_000;
    const spy = jest.spyOn(Date, 'now').mockReturnValue(t0);
    await accounts.credentialsFor(1, 'max');
    spy.mockReturnValue(t0 + 61 * 1000);
    await accounts.credentialsFor(1, 'max');
    expect(db.oneOrNone).toHaveBeenCalledTimes(2);
  });

  test('сбой БД не кэшируется: следующий вызов берёт строку', async () => {
    db.oneOrNone
      .mockRejectedValueOnce(new Error('db down'))
      .mockResolvedValueOnce({ id: 5, provider: 'chatpush', channel: 'tdlib', api_base: 'https://a', token: 'ROW' });
    expect((await accounts.credentialsFor(1, 'tdlib')).token).toBe('ENVTOKEN');
    const c = await accounts.credentialsFor(1, 'tdlib');
    expect(c.token).toBe('ROW');
    expect(db.oneOrNone).toHaveBeenCalledTimes(2);
    expect(require('./logger').__log.warn).toHaveBeenCalled();
  });

  test('сбой БД при протухшем кэше → прежнее значение, не env', async () => {
    db.oneOrNone.mockResolvedValueOnce({ id: 5, provider: 'chatpush', channel: 'tdlib', api_base: 'https://a', token: 'ROW' });
    const t0 = 2_000_000;
    const spy = jest.spyOn(Date, 'now').mockReturnValue(t0);
    await accounts.credentialsFor(1, 'tdlib');
    spy.mockReturnValue(t0 + 61 * 1000);
    db.oneOrNone.mockRejectedValueOnce(new Error('db down'));
    const c = await accounts.credentialsFor(1, 'tdlib');
    expect(c.token).toBe('ROW');
    expect(c.id).toBe(5);
  });

  test('у салона есть строки, но активной по каналу нет → null (канал выключен)', async () => {
    db.oneOrNone.mockResolvedValueOnce(null).mockResolvedValueOnce({ '?column?': 1 });
    expect(await accounts.credentialsFor(1, 'tdlib')).toBeNull();
    const [sql, params] = db.oneOrNone.mock.calls[1];
    expect(sql).toMatch(/SELECT 1 FROM messenger_accounts WHERE salon_id = \$1/);
    expect(params).toEqual([1]);
  });

  test('gateway-строка при пустом MESSAGING_GATEWAY.url → null', async () => {
    const cfg = require('./config');
    const prev = cfg.MESSAGING_GATEWAY.url;
    cfg.MESSAGING_GATEWAY.url = '';
    try {
      db.oneOrNone.mockResolvedValueOnce({ id: 9, provider: 'gateway', channel: 'tdlib', api_base: null, token: 'GW' });
      expect(await accounts.credentialsFor(1, 'tdlib')).toBeNull();
    } finally {
      cfg.MESSAGING_GATEWAY.url = prev;
    }
  });

  test('результат заморожен', async () => {
    db.oneOrNone.mockResolvedValueOnce({ id: 5, provider: 'chatpush', channel: 'tdlib', api_base: 'https://a', token: 'ROW' });
    expect(Object.isFrozen(await accounts.credentialsFor(1, 'tdlib'))).toBe(true);
  });
});

describe('resolveSalon', () => {
  test('SQL: активная строка и самая свежая первыми', async () => {
    db.oneOrNone.mockResolvedValueOnce({ salon_id: 3 });
    await accounts.resolveSalon('gateway', 12);
    expect(db.oneOrNone.mock.calls[0][0]).toMatch(/ORDER BY \(status = 'active'\) DESC, id DESC/);
  });
  test('сбой БД → chatpush с совпавшим customer = env-салон, gateway = null', async () => {
    db.oneOrNone.mockRejectedValue(new Error('db down'));
    expect(await accounts.resolveSalon('chatpush', 777)).toBe(1);
    expect(await accounts.resolveSalon('gateway', 777)).toBeNull();
  });
  test('strict: сбой БД пробрасывается (вебхук шлюза ответит 503); без strict → null', async () => {
    db.oneOrNone.mockRejectedValue(new Error('db down'));
    await expect(accounts.resolveSalon('gateway', 9, { strict: true })).rejects.toThrow('db down');
    expect(await accounts.resolveSalon('gateway', 9)).toBeNull();
  });
  test('chatpush с externalId=null при заданном customerId → null', async () => {
    expect(await accounts.resolveSalon('chatpush', null)).toBeNull();
  });

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

describe('credentialsById', () => {
  test('строка chatpush → креды с api_base строки, любой статус, скоуп по салону', async () => {
    db.oneOrNone.mockResolvedValueOnce({ id: 5, provider: 'chatpush', channel: 'tdlib', api_base: 'https://row.base', token: 'ROW' });
    expect(await accounts.credentialsById(1, 5)).toEqual({ id: 5, provider: 'chatpush', channel: 'tdlib', apiBase: 'https://row.base', token: 'ROW' });
    const [sql, params] = db.oneOrNone.mock.calls[0];
    expect(sql).toMatch(/WHERE id = \$1 AND salon_id = \$2/);
    expect(sql).not.toMatch(/status/);
    expect(params).toEqual([5, 1]);
  });
  test('строки нет → null', async () => {
    db.oneOrNone.mockResolvedValueOnce(null);
    expect(await accounts.credentialsById(1, 404)).toBeNull();
  });
  test('сбой БД → null без исключения, warn', async () => {
    db.oneOrNone.mockRejectedValueOnce(new Error('db down'));
    expect(await accounts.credentialsById(1, 5)).toBeNull();
    expect(require('./logger').__log.warn).toHaveBeenCalled();
  });
  test("'env' → null без запроса в БД", async () => {
    expect(await accounts.credentialsById(1, 'env')).toBeNull();
    expect(db.oneOrNone).not.toHaveBeenCalled();
    expect(require('./logger').__log.warn).not.toHaveBeenCalled();
  });
  test('без кэша: два вызова — два запроса', async () => {
    db.oneOrNone.mockResolvedValue({ id: 5, provider: 'chatpush', channel: 'tdlib', api_base: 'x', token: 't' });
    await accounts.credentialsById(1, 5);
    await accounts.credentialsById(1, 5);
    expect(db.oneOrNone).toHaveBeenCalledTimes(2);
  });
});
