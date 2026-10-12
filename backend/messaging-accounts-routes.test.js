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
const router = require('./routes/messaging-accounts');
const { createTelegramAccount, parseAuthStep, activateAccount, promoteIfReady } = router;

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

// Клиент транзакции: [advisory-lock, SELECT existing, (INSERT, UPDATE external_id) | UPDATE external_id].
const txn = (...results) => { results.forEach(r => mockClient.query.mockResolvedValueOnce(r)); };
const LOCK = { rows: [] };

describe('createTelegramAccount', () => {
  test('НИЧЕГО не гасит: под advisory-локом вставляет pending-строку, external_id=id, сброс кэша, start', async () => {
    txn(LOCK, { rows: [] }, { rows: [{ id: 42 }] }, { rowCount: 1 });
    gw.start.mockResolvedValueOnce({ authState: 'wait_phone' });
    const out = await createTelegramAccount(1);
    expect(out).toEqual({ id: 42, authState: 'wait_phone', status: 'pending' });
    const calls = mockClient.query.mock.calls;
    expect(calls[0][0]).toMatch(/pg_advisory_xact_lock/);
    expect(calls[0][1]).toEqual(['gateway-account:1:tdlib']);
    expect(calls[1][0]).toMatch(/status IN \('active', ?'pending'\)/);
    expect(calls[2][0]).toMatch(/INSERT INTO messenger_accounts/);
    expect(calls[2][0]).toMatch(/'pending'/);
    expect(calls[2][1][0]).toBe(1);
    expect(calls[2][1][1]).toMatch(/^[0-9a-f]{48}$/);
    expect(calls.map(c => c[0]).join('\n')).not.toMatch(/SET status = 'disabled'/);
    expect(calls[3][0]).toMatch(/SET external_id = \$1 WHERE id = \$2/);
    expect(calls[3][1]).toEqual(['42', 42]);
    expect(accounts.invalidate).toHaveBeenCalled();
    expect(gw.start).toHaveBeenCalledWith(42);
  });

  test('gateway-строка active/pending уже есть → идемпотентно: start по ней, без INSERT', async () => {
    txn(LOCK, { rows: [{ id: 7, status: 'pending' }] }, { rowCount: 1 });
    gw.start.mockResolvedValueOnce({ authState: 'wait_code' });
    expect(await createTelegramAccount(1)).toEqual({ id: 7, authState: 'wait_code', status: 'pending' });
    const calls = mockClient.query.mock.calls;
    expect(calls.map(c => c[0]).join('\n')).not.toMatch(/INSERT/);
    // Повтор кнопки дозаполняет external_id, если первый раз второй UPDATE не прошёл.
    expect(calls[2][0]).toMatch(/SET external_id = COALESCE\(external_id, \$1\)/);
    expect(calls[2][1]).toEqual(['7', 7]);
  });

  test('шлюз не стартовал → строка остаётся pending, ошибка наружу', async () => {
    txn(LOCK, { rows: [] }, { rows: [{ id: 43 }] }, { rowCount: 1 });
    gw.start.mockRejectedValueOnce(Object.assign(new Error('шлюз: ECONNREFUSED'), { status: 502 }));
    await expect(createTelegramAccount(1)).rejects.toThrow(/ECONNREFUSED/);
  });
});

describe('promoteIfReady', () => {
  test('pending gateway + ready → activateAccount (транзакция: гасит прочие, активирует) → active', async () => {
    mockClient.query.mockResolvedValueOnce({ rowCount: 1 }).mockResolvedValueOnce({ rowCount: 1 });
    const st = await promoteIfReady(1, { id: 42, provider: 'gateway', channel: 'tdlib', status: 'pending' }, 'ready');
    expect(st).toBe('active');
    expect(require('./db').withTransaction).toHaveBeenCalledTimes(1);
    expect(mockClient.query.mock.calls[0][0]).toMatch(/SET status = 'disabled'/);
    expect(mockClient.query.mock.calls[0][1]).toEqual([1, 'tdlib', 42]);
    expect(mockClient.query.mock.calls[1][0]).toMatch(/SET status = 'active'/);
  });
  test('pending + wait_code → ничего, статус pending', async () => {
    expect(await promoteIfReady(1, { id: 42, provider: 'gateway', channel: 'tdlib', status: 'pending' }, 'wait_code')).toBe('pending');
    expect(require('./db').withTransaction).not.toHaveBeenCalled();
  });
  test('уже active → ничего', async () => {
    expect(await promoteIfReady(1, { id: 42, provider: 'gateway', channel: 'tdlib', status: 'active' }, 'ready')).toBe('active');
    expect(require('./db').withTransaction).not.toHaveBeenCalled();
  });
});

describe('createGatewayAccount(whatsapp)', () => {
  const { createGatewayAccount } = router;
  test('вставляет pending-строку channel=whatsapp с display_name WhatsApp, external_id=id, start', async () => {
    txn(LOCK, { rows: [] }, { rows: [{ id: 43 }] }, { rowCount: 1 });
    gw.start.mockResolvedValue({ authState: 'starting' });
    const r = await createGatewayAccount(1, 'whatsapp');
    expect(r).toEqual({ id: 43, authState: 'starting', status: 'pending' });
    const calls = mockClient.query.mock.calls;
    expect(calls[2][0]).toMatch(/'gateway', 'whatsapp', 'pending'/);
    expect(calls[2][0]).toMatch(/WhatsApp \(свой шлюз\)/);
    expect(calls[1][1]).toEqual([1, 'whatsapp']);
    expect(calls[0][1]).toEqual(['gateway-account:1:whatsapp']);
    expect(gw.start).toHaveBeenCalledWith(43);
  });
  test('неизвестный канал → ошибка 400 без запросов', async () => {
    await expect(createGatewayAccount(1, 'max')).rejects.toMatchObject({ status: 400 });
    expect(mockClient.query).not.toHaveBeenCalled();
  });
  test('createTelegramAccount = createGatewayAccount(…, tdlib)', async () => {
    txn(LOCK, { rows: [] }, { rows: [{ id: 44 }] }, { rowCount: 1 });
    gw.start.mockResolvedValue({ authState: 'starting' });
    await createTelegramAccount(1);
    expect(mockClient.query.mock.calls[1][1]).toEqual([1, 'tdlib']);
  });
  test('POST /accounts/whatsapp и qr/pairingCode проходят через /auth и /status', async () => {
    const route = (method, path) => router.stack.find(l => l.route && l.route.path === path && l.route.methods[method]).route.stack.slice(-1)[0].handle;
    const fakeRes = () => ({ status: jest.fn().mockReturnThis(), json: jest.fn() });
    txn(LOCK, { rows: [] }, { rows: [{ id: 45 }] }, { rowCount: 1 });
    gw.start.mockResolvedValue({ authState: 'wait_qr' });
    let res = fakeRes();
    await route('post', '/accounts/whatsapp')({ body: {}, user: { salonId: 1 } }, res);
    expect(res.json).toHaveBeenCalledWith({ id: 45, authState: 'wait_qr', status: 'pending' });
    db.oneOrNone.mockResolvedValueOnce({ id: 45, provider: 'gateway', channel: 'whatsapp', status: 'pending' });
    gw.auth.mockResolvedValueOnce({ authState: 'wait_qr', pairingCode: 'ABCDEFGH', error: null });
    res = fakeRes();
    await route('post', '/accounts/:id/auth')({ params: { id: '45' }, body: { phone: '79001112233' }, user: { salonId: 1 } }, res);
    expect(res.json).toHaveBeenCalledWith({ authState: 'wait_qr', pairingCode: 'ABCDEFGH', error: null, status: 'pending' });
    db.oneOrNone.mockResolvedValueOnce({ id: 45, provider: 'gateway', channel: 'whatsapp', status: 'pending' });
    gw.status.mockResolvedValueOnce({ authState: 'wait_qr', qr: 'data:image/png;base64,AA', pairingCode: null });
    res = fakeRes();
    await route('get', '/accounts/:id/status')({ params: { id: '45' }, body: {}, user: { salonId: 1 } }, res);
    expect(res.json).toHaveBeenCalledWith({ authState: 'wait_qr', qr: 'data:image/png;base64,AA', pairingCode: null, status: 'pending' });
  });
});

describe('HTTP-ручки', () => {
  const route = (method, path) => router.stack.find(l => l.route && l.route.path === path && l.route.methods[method]).route.stack.slice(-1)[0].handle;
  const fakeRes = () => ({ status: jest.fn().mockReturnThis(), json: jest.fn() });
  const req = (id, body) => ({ params: { id: String(id) }, body: body || {}, user: { salonId: 1 } });

  test('auth: ready на pending-строке → продвижение, в ответе status=active', async () => {
    db.oneOrNone.mockResolvedValueOnce({ id: 42, provider: 'gateway', channel: 'tdlib', status: 'pending' });
    gw.auth.mockResolvedValueOnce({ authState: 'ready', phone: '79001112233' });
    mockClient.query.mockResolvedValue({ rowCount: 1 });
    const res = fakeRes();
    await route('post', '/accounts/:id/auth')(req(42, { code: '12345' }), res);
    expect(res.json).toHaveBeenCalledWith({ authState: 'ready', phone: '79001112233', status: 'active' });
    expect(require('./db').withTransaction).toHaveBeenCalledTimes(1);
  });

  test('status: pending + wait_code → status=pending, без записи', async () => {
    db.oneOrNone.mockResolvedValueOnce({ id: 42, provider: 'gateway', channel: 'tdlib', status: 'pending' });
    gw.status.mockResolvedValueOnce({ authState: 'wait_code' });
    const res = fakeRes();
    await route('get', '/accounts/:id/status')(req(42), res);
    expect(res.json).toHaveBeenCalledWith({ authState: 'wait_code', status: 'pending' });
    expect(require('./db').withTransaction).not.toHaveBeenCalled();
  });

  test('logout: канал остался без активной → восстанавливается прежний chatpush-аккаунт', async () => {
    db.oneOrNone
      .mockResolvedValueOnce({ id: 42, provider: 'gateway', channel: 'tdlib', status: 'active' })   // ownRow
      .mockResolvedValueOnce(null)                                                                  // активной нет
      .mockResolvedValueOnce({ id: 3 });                                                            // прежний
    db.query.mockResolvedValueOnce({ rowCount: 1 });
    gw.logout.mockResolvedValueOnce({});
    mockClient.query.mockResolvedValue({ rowCount: 1 });
    const res = fakeRes();
    await route('post', '/accounts/:id/logout')(req(42), res);
    expect(res.json).toHaveBeenCalledWith({ ok: true, restored: 3 });
    const [prevSql, prevParams] = db.oneOrNone.mock.calls[2];
    expect(prevSql).toMatch(/provider <> \$3/);
    expect(prevSql).toMatch(/ORDER BY updated_at DESC LIMIT 1/);
    expect(prevParams).toEqual([1, 'tdlib', 'gateway']);
    expect(mockClient.query.mock.calls[1][0]).toMatch(/SET status = 'active'/);
    expect(mockClient.query.mock.calls[1][1]).toEqual([3, 1]);
  });

  test('logout: активная строка канала уже есть → ничего не восстанавливаем', async () => {
    db.oneOrNone
      .mockResolvedValueOnce({ id: 42, provider: 'gateway', channel: 'tdlib', status: 'pending' })
      .mockResolvedValueOnce({ id: 3 });
    db.query.mockResolvedValueOnce({ rowCount: 1 });
    gw.logout.mockResolvedValueOnce({});
    const res = fakeRes();
    await route('post', '/accounts/:id/logout')(req(42), res);
    expect(res.json).toHaveBeenCalledWith({ ok: true, restored: null });
    expect(require('./db').withTransaction).not.toHaveBeenCalled();
  });

  test('activate gateway-строки без ready → 409, ничего не пишется', async () => {
    db.oneOrNone.mockResolvedValueOnce({ id: 42, provider: 'gateway', channel: 'tdlib', status: 'disabled' });
    gw.start.mockResolvedValueOnce({ authState: 'wait_code' });
    gw.status.mockResolvedValueOnce({ authState: 'wait_code' });
    const res = fakeRes();
    await route('post', '/accounts/:id/activate')(req(42), res);
    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith({ error: 'аккаунт шлюза не авторизован' });
    expect(require('./db').withTransaction).not.toHaveBeenCalled();
    expect(db.query).not.toHaveBeenCalled();
  });

  test('activate gateway-строки с ready → activateAccount', async () => {
    db.oneOrNone.mockResolvedValueOnce({ id: 42, provider: 'gateway', channel: 'tdlib', status: 'disabled' });
    gw.start.mockResolvedValueOnce({ authState: 'ready' });
    gw.status.mockResolvedValueOnce({ authState: 'ready' });
    mockClient.query.mockResolvedValue({ rowCount: 1 });
    const res = fakeRes();
    await route('post', '/accounts/:id/activate')(req(42), res);
    expect(res.json).toHaveBeenCalledWith({ ok: true });
    expect(require('./db').withTransaction).toHaveBeenCalledTimes(1);
  });

  test('activate chatpush-строки — без шлюза', async () => {
    db.oneOrNone.mockResolvedValueOnce({ id: 3, provider: 'chatpush', channel: 'tdlib', status: 'disabled' });
    mockClient.query.mockResolvedValue({ rowCount: 1 });
    const res = fakeRes();
    await route('post', '/accounts/:id/activate')(req(3), res);
    expect(gw.start).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith({ ok: true });
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
