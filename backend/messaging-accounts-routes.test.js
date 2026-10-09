'use strict';
const mockClient = { query: jest.fn(), release: jest.fn() };
jest.mock('./db', () => ({
  db: { query: jest.fn(), oneOrNone: jest.fn(), any: jest.fn() },
  pool: { connect: jest.fn(async () => mockClient) },
  withTransaction: jest.fn(async (fn) => fn(mockClient)),
}));
jest.mock('./services/messaging/gateway-client', () => ({ start: jest.fn(), auth: jest.fn(), status: jest.fn(), logout: jest.fn() }));
jest.mock('./services/messaging/accounts', () => ({ listForSalon: jest.fn(), invalidate: jest.fn() }));
jest.mock('./config', () => ({ MESSAGING_GATEWAY: { url: 'http://127.0.0.1:3002', secret: 's' }, CHATPUSH: {} }));
jest.mock('./middleware/auth', () => ({ auth: (req, res, next) => next(), requireRole: () => (req, res, next) => next(), authOrQuery: (req, res, next) => next() }));
jest.mock('./logger', () => ({ createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }) }));

const { db } = require('./db');
const gw = require('./services/messaging/gateway-client');
const accounts = require('./services/messaging/accounts');
const { createTelegramAccount, parseAuthStep, activateAccount } = require('./routes/messaging-accounts');

beforeEach(() => { jest.clearAllMocks(); mockClient.query.mockReset(); });

describe('parseAuthStep', () => {
  test('phone → цифры с 7', () => expect(parseAuthStep({ phone: '+7 (900) 111-22-33' })).toEqual({ phone: '79001112233' }));
  test('8 → 7', () => expect(parseAuthStep({ phone: '89001112233' })).toEqual({ phone: '79001112233' }));
  test('code → только цифры, 4–6', () => {
    expect(parseAuthStep({ code: ' 12345 ' })).toEqual({ code: '12345' });
    expect(parseAuthStep({ code: '12' })).toBeNull();
  });
  test('password как есть, непустой', () => {
    expect(parseAuthStep({ password: ' secret ' })).toEqual({ password: ' secret ' });
    expect(parseAuthStep({ password: '' })).toBeNull();
  });
  test('ничего → null', () => expect(parseAuthStep({})).toBeNull());
});

describe('createTelegramAccount', () => {
  test('в ОДНОЙ транзакции: гасит активную tdlib-строку, вставляет gateway-строку с external_id=id; после коммита — start и сброс кэша', async () => {
    db.oneOrNone.mockResolvedValueOnce(null);                       // активной gateway-строки нет
    mockClient.query
      .mockResolvedValueOnce({ rowCount: 1 })                        // UPDATE … disabled
      .mockResolvedValueOnce({ rows: [{ id: 42 }], rowCount: 1 })    // INSERT … RETURNING id
      .mockResolvedValueOnce({ rowCount: 1 });                       // UPDATE external_id
    gw.start.mockResolvedValueOnce({ authState: 'wait_phone' });
    const out = await createTelegramAccount(1);
    expect(out).toEqual({ id: 42, authState: 'wait_phone' });
    const { withTransaction } = require('./db');
    expect(withTransaction).toHaveBeenCalledTimes(1);
    const [disableSql, disableParams] = mockClient.query.mock.calls[0];
    expect(disableSql).toMatch(/UPDATE messenger_accounts SET status = 'disabled'/);
    expect(disableParams).toEqual([1, 'tdlib']);
    const [insSql, insParams] = mockClient.query.mock.calls[1];
    expect(insSql).toMatch(/INSERT INTO messenger_accounts/);
    expect(insParams[0]).toBe(1);
    expect(insParams[1]).toMatch(/^[0-9a-f]{48}$/);                  // token
    const [extSql, extParams] = mockClient.query.mock.calls[2];
    expect(extSql).toMatch(/SET external_id = \$1 WHERE id = \$2/);
    expect(extParams).toEqual(['42', 42]);
    expect(gw.start).toHaveBeenCalledWith(42);
    expect(accounts.invalidate).toHaveBeenCalled();
    // start зовётся ПОСЛЕ транзакции (строка уже закоммичена и видна шлюзу)
    expect(gw.start.mock.invocationCallOrder[0]).toBeGreaterThan(withTransaction.mock.invocationCallOrder[0]);
  });

  test('активная gateway-строка уже есть → идемпотентно: start по ней, без транзакции', async () => {
    db.oneOrNone.mockResolvedValueOnce({ id: 7 });
    gw.start.mockResolvedValueOnce({ authState: 'ready' });
    expect(await createTelegramAccount(1)).toEqual({ id: 7, authState: 'ready' });
    expect(require('./db').withTransaction).not.toHaveBeenCalled();
  });

  test('шлюз не стартовал → строка остаётся, ошибка наружу (клиент увидит текст шлюза)', async () => {
    db.oneOrNone.mockResolvedValueOnce(null);
    mockClient.query.mockResolvedValueOnce({ rowCount: 1 }).mockResolvedValueOnce({ rows: [{ id: 43 }], rowCount: 1 }).mockResolvedValueOnce({ rowCount: 1 });
    gw.start.mockRejectedValueOnce(Object.assign(new Error('шлюз: ECONNREFUSED'), { status: 502 }));
    await expect(createTelegramAccount(1)).rejects.toThrow(/ECONNREFUSED/);
  });
});

describe('activateAccount', () => {
  test('в одной транзакции гасит прочие активные строки канала и активирует выбранную', async () => {
    mockClient.query.mockResolvedValueOnce({ rowCount: 1 }).mockResolvedValueOnce({ rowCount: 1 });
    await activateAccount(1, 5, 'tdlib');
    const [sql1, p1] = mockClient.query.mock.calls[0];
    expect(sql1).toMatch(/SET status = 'disabled'/); expect(p1).toEqual([1, 'tdlib', 5]);
    const [sql2, p2] = mockClient.query.mock.calls[1];
    expect(sql2).toMatch(/SET status = 'active'/); expect(p2).toEqual([5, 1]);
    expect(accounts.invalidate).toHaveBeenCalled();
  });
});
