'use strict';
// Uses the real db.withTransaction with a mocked pg pool/client. No external calls.
const mockPoolQuery = jest.fn();
const mockConnect = jest.fn();
const mockPrimaryPool = { query: mockPoolQuery, connect: mockConnect };
const mockSecondaryPool = { query: jest.fn(), connect: jest.fn() };
let mockPoolNumber = 0;
jest.mock('pg', () => ({ Pool: jest.fn(() => (++mockPoolNumber === 1 ? mockPrimaryPool : mockSecondaryPool)) }));
const mockPost = jest.fn();
jest.mock('./middleware/auth', () => ({ auth: (_req, _res, next) => next() }));
jest.mock('axios', () => ({ post: mockPost }));
jest.mock('puppeteer', () => ({ launch: jest.fn() }));
jest.mock('./services/yclients', () => ({ ycGet: jest.fn(), getTreeCache: jest.fn(), setTreeCache: jest.fn() }));
jest.mock('./services/home-care', () => ({ syncGoodsCategories: jest.fn() }));
jest.mock('./services/yclients-goods-catalog', () => ({ isBlacklisted: jest.fn() }));
jest.mock('./services/messaging/transport', () => ({}));
jest.mock('./services/outgoing-authorship', () => ({}));
jest.mock('./services/chat-persist', () => ({ persistWhatsappOutgoing: jest.fn() }));
jest.mock('./logger', () => ({ createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }) }));

const router = require('./routes/home-care');
function handler(path, method) {
  return router.stack.find(l => l.route?.path === path && l.route.methods[method.toLowerCase()]).route.stack.at(-1).handle;
}
function response() {
  const res = { statusCode: 200 };
  res.status = jest.fn(code => { res.statusCode = code; return res; });
  res.json = jest.fn(body => { res.body = body; return res; });
  return res;
}
function transaction(queryImpl) {
  const client = { query: jest.fn(queryImpl), release: jest.fn() };
  mockConnect.mockResolvedValue(client);
  return client;
}
beforeEach(() => { jest.clearAllMocks(); mockPoolQuery.mockResolvedValue({ rows: [] }); });

test('foreign client is rejected without writes or push', async () => {
  const client = transaction(async sql => {
    if (sql === 'BEGIN' || sql === 'COMMIT') return { rows: [] };
    if (sql.startsWith('SELECT id FROM clients')) return { rows: [] };
    throw new Error(`unexpected SQL: ${sql}`);
  });
  const res = response();
  await handler('/', 'POST')({ body: { client_id: 902, items: [] }, user: { salonId: 101, userId: 7 } }, res);
  expect(res.statusCode).toBe(404);
  expect(client.query.mock.calls.map(([sql]) => sql)).toEqual(['BEGIN', 'SELECT id FROM clients WHERE id=$1 AND salon_id=$2', 'COMMIT']);
  expect(client.release).toHaveBeenCalledTimes(1);
  expect(mockPost).not.toHaveBeenCalled();
});

test('foreign/mismatched record is rejected; query permits a legacy null record client', async () => {
  const client = transaction(async sql => {
    if (sql === 'BEGIN' || sql === 'COMMIT') return { rows: [] };
    if (sql.startsWith('SELECT id FROM clients')) return { rows: [{ id: 42 }] };
    if (sql.startsWith('SELECT id FROM records')) return { rows: [] };
    throw new Error(`unexpected SQL: ${sql}`);
  });
  const res = response();
  await handler('/', 'POST')({ body: { client_id: 42, record_id: 902, items: [] }, user: { salonId: 101, userId: 7 } }, res);
  expect(res.statusCode).toBe(404);
  expect(client.query).toHaveBeenCalledWith(
    'SELECT id FROM records WHERE id=$1 AND salon_id=$2 AND ($3::int IS NULL OR client_id IS NULL OR client_id=$3)', [902, 101, 42]);
  expect(mockPost).not.toHaveBeenCalled();
});

test('successful POST commits prescription/items before salon-scoped push lookup', async () => {
  const events = [];
  const client = transaction(async sql => {
    events.push(sql === 'COMMIT' ? 'COMMIT' : sql.trim().split(/\s+/)[0]);
    if (sql === 'BEGIN' || sql === 'COMMIT') return { rows: [] };
    if (sql.startsWith('SELECT id FROM clients')) return { rows: [{ id: 42 }] };
    if (sql.trim().startsWith('INSERT INTO home_care_prescriptions')) return { rows: [{ id: 501 }] };
    if (sql.trim().startsWith('INSERT INTO home_care_items')) return { rows: [] };
    throw new Error(`unexpected SQL: ${sql}`);
  });
  mockPoolQuery.mockImplementation(async sql => {
    events.push('push-lookup');
    expect(sql).toContain('JOIN clients c ON c.id = mt.client_id AND c.salon_id = $1');
    return { rows: [] };
  });
  const res = response();
  await handler('/', 'POST')({ body: { client_id: '42', items: [{ time_of_day: 'morning', product_name: 'Synthetic' }] }, user: { salonId: 101, userId: 7 } }, res);
  await new Promise(resolve => setImmediate(resolve));
  expect(res.body).toEqual({ id: 501 });
  expect(events.indexOf('COMMIT')).toBeLessThan(events.indexOf('push-lookup'));
  expect(client.release).toHaveBeenCalledTimes(1);
});

test('legacy record with null client can be accepted by the guarded record query', async () => {
  const client = transaction(async sql => {
    if (sql === 'BEGIN' || sql === 'COMMIT') return { rows: [] };
    if (sql.startsWith('SELECT id FROM clients')) return { rows: [{ id: 42 }] };
    if (sql.startsWith('SELECT id FROM records')) return { rows: [{ id: 902 }] };
    if (sql.trim().startsWith('INSERT INTO home_care_prescriptions')) return { rows: [{ id: 501 }] };
    throw new Error(`unexpected SQL: ${sql}`);
  });
  const res = response();
  await handler('/', 'POST')({ body: { client_id: 42, record_id: 902, items: [] }, user: { salonId: 101, userId: 7 } }, res);
  expect(res.body).toEqual({ id: 501 });
  expect(client.query).toHaveBeenCalledWith('COMMIT');
});

test('failed item insert rolls back/releases and never starts push', async () => {
  const client = transaction(async sql => {
    if (sql === 'BEGIN' || sql === 'ROLLBACK') return { rows: [] };
    if (sql.startsWith('SELECT id FROM clients')) return { rows: [{ id: 42 }] };
    if (sql.trim().startsWith('INSERT INTO home_care_prescriptions')) return { rows: [{ id: 501 }] };
    if (sql.trim().startsWith('INSERT INTO home_care_items')) throw new Error('synthetic item failure');
    throw new Error(`unexpected SQL: ${sql}`);
  });
  const res = response();
  await handler('/', 'POST')({ body: { client_id: 42, items: [{ time_of_day: 'morning', product_name: 'Synthetic' }] }, user: { salonId: 101, userId: 7 } }, res);
  expect(res.statusCode).toBe(500);
  expect(client.query).toHaveBeenCalledWith('ROLLBACK');
  expect(client.query).not.toHaveBeenCalledWith('COMMIT');
  expect(client.release).toHaveBeenCalledTimes(1);
  expect(mockPoolQuery).not.toHaveBeenCalled();
  expect(mockPost).not.toHaveBeenCalled();
});

test('successful PUT validates and writes in one committed transaction', async () => {
  const client = transaction(async sql => {
    if (sql === 'BEGIN' || sql === 'COMMIT') return { rows: [] };
    if (sql.startsWith('SELECT id FROM home_care_prescriptions')) return { rows: [{ id: 501 }] };
    if (sql.startsWith('SELECT id FROM clients')) return { rows: [{ id: 42 }] };
    return { rows: [] };
  });
  const res = response();
  await handler('/:id', 'PUT')({ params: { id: '501' }, body: { client_id: 42, items: [] }, user: { salonId: 101, userId: 7 } }, res);
  expect(res.body).toEqual({ ok: true });
  expect(client.query.mock.calls.some(([sql, args]) => sql.includes('WHERE id=$10 AND salon_id=$11') && args[10] === 101)).toBe(true);
  expect(client.query).toHaveBeenCalledWith('COMMIT');
  expect(client.release).toHaveBeenCalledTimes(1);
});

test.each([
  { client_id: 0, items: [] }, { client_id: -1, items: [] }, { client_id: '1.5', items: [] },
  { record_id: Number.MAX_SAFE_INTEGER + 1, items: [] }, { client_id: 42, items: {} },
])('invalid ids/items return 400 before transaction: %j', async body => {
  const res = response();
  await handler('/', 'POST')({ body, user: { salonId: 101, userId: 7 } }, res);
  expect(res.statusCode).toBe(400);
  expect(mockConnect).not.toHaveBeenCalled();
});

test('invalid PUT prescription id returns 400 before transaction', async () => {
  const res = response();
  await handler('/:id', 'PUT')({ params: { id: '1.5' }, body: { client_id: 42, items: [] }, user: { salonId: 101, userId: 7 } }, res);
  expect(res.statusCode).toBe(400);
  expect(mockConnect).not.toHaveBeenCalled();
});

test('prescription read scopes client and specialist joins', async () => {
  const res = response();
  await handler('/:id', 'GET')({ params: { id: '501' }, user: { salonId: 101, userId: 7 } }, res);
  const [sql, args] = mockPoolQuery.mock.calls[0];
  expect(sql).toContain('LEFT JOIN clients c ON c.id=p.client_id AND c.salon_id=p.salon_id');
  expect(sql).toContain('LEFT JOIN users u ON u.id=p.specialist_id AND u.salon_id=p.salon_id');
  expect(args).toEqual(['501', 101]);
  expect(res.statusCode).toBe(404);
});
