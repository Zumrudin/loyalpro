'use strict';

const mockOneOrNone = jest.fn();
const mockOne = jest.fn();
const mockQuery = jest.fn();
const mockTxQuery = jest.fn();

jest.mock('./config', () => ({
  JWT_SECRET: 's'.repeat(40),
  API_PUBLIC: ['/api/auth/login', '/api/auth/register'],
  SPECIALIST_ALLOWED_PREFIXES: ['/api/home-care', '/api/auth'],
  CASHIER_ALLOWED_PREFIXES: ['/api/home-care', '/api/auth', '/api/chat'],
}));
jest.mock('./db', () => ({
  db: { oneOrNone: mockOneOrNone, one: mockOne, query: mockQuery, any: jest.fn() },
  pool: { connect: jest.fn() },
  withTransaction: jest.fn(async callback => callback({ query: mockTxQuery })),
}));
jest.mock('bcryptjs', () => ({
  hash: jest.fn(async () => 'synthetic-password-hash'),
  compare: jest.fn(async () => true),
}));

const express = require('express');
const jwt = require('jsonwebtoken');
const config = require('./config');
const { auth, requireRole } = require('./middleware/auth');
const { apiAuthGuard } = require('./routes/index');
const usersRouter = require('./routes/users');
const authRouter = require('./routes/auth');

function tokenFor(role = 'owner', salonId = 11) {
  return jwt.sign({ userId: 5, salonId, role }, config.JWT_SECRET, { expiresIn: '1h' });
}
function staffRow(role = 'owner', salonId = 11) {
  return { userId: 5, salonId, role };
}
function fakeResponse() {
  return { status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockOneOrNone.mockResolvedValue(staffRow());
});

test('deactivated user, disabled salon, expired/revoked session and tenant mismatch fail closed', async () => {
  const token = tokenFor();
  for (const row of [null, null, null]) {
    mockOneOrNone.mockResolvedValueOnce(row);
    const res = fakeResponse();
    await auth({ headers: { authorization: `Bearer ${token}` }, query: {} }, res, jest.fn());
    expect(res.status).toHaveBeenCalledWith(401);
  }
  mockOneOrNone.mockResolvedValueOnce(staffRow('owner', 12));
  const mismatch = fakeResponse();
  await auth({ headers: { authorization: `Bearer ${token}` }, query: {} }, mismatch, jest.fn());
  expect(mismatch.status).toHaveBeenCalledWith(401);
  const sql = mockOneOrNone.mock.calls[0][0];
  expect(sql).toContain('u.is_active=TRUE');
  expect(sql).toContain('sl.is_active=TRUE');
  expect(sql).toContain('s.expires_at>NOW()');
  expect(sql).toContain('s.user_id=$2');
  expect(sql).toContain('u.salon_id=$3');
});

test('current database role overrides stale JWT role in middleware and global guard', async () => {
  const token = tokenFor('owner');
  mockOneOrNone.mockResolvedValue(staffRow('specialist'));
  const req = { headers: { authorization: `Bearer ${token}` }, query: {} };
  const res = fakeResponse();
  const next = jest.fn();
  await auth(req, res, next);
  expect(next).toHaveBeenCalled();
  expect(req.user.role).toBe('specialist');
  expect(req.token).toBe(token);
  requireRole('owner')(req, res, jest.fn());
  expect(res.status).toHaveBeenCalledWith(403);

  const guardReq = { headers: { authorization: `Bearer ${token}` }, query: {}, path: '/users' };
  const guardRes = fakeResponse();
  await apiAuthGuard(guardReq, guardRes, jest.fn());
  expect(guardRes.status).toHaveBeenCalledWith(403);

  mockOneOrNone.mockResolvedValue(staffRow('owner'));
  const promotedNext = jest.fn();
  await apiAuthGuard({ headers: { authorization: `Bearer ${token}` }, query: {}, path: '/users' }, fakeResponse(), promotedNext);
  expect(promotedNext).toHaveBeenCalled();
});

test('global API guard rejects a valid JWT supplied only in the URL', async () => {
  const res = fakeResponse();
  const next = jest.fn();
  await apiAuthGuard({ headers: {}, query: { token: tokenFor() }, path: '/users' }, res, next);
  expect(res.status).toHaveBeenCalledWith(401);
  expect(next).not.toHaveBeenCalled();
  expect(mockOneOrNone).not.toHaveBeenCalled();
});

let server;
let baseUrl;
let token;
beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.headers.authorization = `Bearer ${token}`;
    next();
  });
  app.use('/api', apiAuthGuard);
  app.use('/api/users', usersRouter);
  app.use('/api/auth', authRouter);
  app.get('/api/protected-test', (_req, res) => res.json({ ok: true }));
  await new Promise(resolve => { server = app.listen(0, '127.0.0.1', resolve); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
});

async function request(path, method, body) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

test.each([
  ['role change', { role: 'admin' }],
  ['deactivation', { is_active: false }],
  ['owner password reset', { password: 'synthetic-new-password' }],
])('%s updates user and revokes sessions in one transaction', async (_name, patch) => {
  token = tokenFor();
  mockTxQuery.mockImplementation(async sql => sql.includes('UPDATE users')
    ? { rows: [{ id: 8, role: 'admin', is_active: true }] }
    : { rows: [] });
  const response = await request('/api/users/8', 'PATCH', patch);
  expect(response.status).toBe(200);
  const update = mockTxQuery.mock.calls.find(call => call[0].includes('UPDATE users'));
  expect(update[1].slice(-2)).toEqual(['8', 11]);
  expect(mockTxQuery).toHaveBeenCalledWith('DELETE FROM sessions WHERE user_id=$1', [8]);
});

test('self-demotion and self-deactivation remain forbidden without writes', async () => {
  token = tokenFor();
  expect((await request('/api/users/5', 'PATCH', { role: 'admin' })).status).toBe(400);
  expect((await request('/api/users/5', 'PATCH', { is_active: false })).status).toBe(400);
  expect(mockTxQuery).not.toHaveBeenCalled();
});

test('DELETE deactivates only same-tenant user and revokes that user sessions', async () => {
  token = tokenFor();
  mockTxQuery.mockImplementation(async sql => sql.includes('UPDATE users') ? { rows: [{ id: 8 }] } : { rows: [] });
  const response = await request('/api/users/8', 'DELETE');
  expect(response.status).toBe(200);
  expect(mockTxQuery).toHaveBeenCalledWith(
    'UPDATE users SET is_active=FALSE WHERE id=$1 AND salon_id=$2 RETURNING id', ['8', 11]
  );
  expect(mockTxQuery).toHaveBeenCalledWith('DELETE FROM sessions WHERE user_id=$1', ['8']);
});

test('own password change preserves only current server-derived session', async () => {
  token = tokenFor();
  mockOne.mockResolvedValue({ id: 5, password_hash: 'synthetic-old-hash' });
  mockTxQuery.mockImplementation(async sql => sql.includes('UPDATE users') ? { rows: [{ id: 5 }] } : { rows: [] });
  const response = await request('/api/auth/change-password', 'POST', {
    current_password: 'synthetic-current', new_password: 'synthetic-new-password',
  });
  expect(response.status).toBe(200);
  expect(mockTxQuery).toHaveBeenCalledWith(
    'DELETE FROM sessions WHERE user_id=$1 AND token<>$2', [5, token]
  );
});

test('restricted session changes password through double auth and becomes unrestricted', async () => {
  token = tokenFor();
  mockOneOrNone.mockResolvedValue({ ...staffRow(), mustChangePassword: true });
  expect((await request('/api/protected-test', 'GET')).status).toBe(403);

  mockOne.mockResolvedValue({ id: 5, password_hash: 'synthetic-old-hash' });
  mockTxQuery.mockImplementation(async sql => sql.includes('UPDATE users')
    ? { rows: [{ id: 5 }] }
    : { rows: [] });
  const changed = await request('/api/auth/change-password', 'POST', {
    current_password: 'synthetic-current', new_password: 'synthetic-new-password',
  });
  expect(changed.status).toBe(200);

  mockOneOrNone.mockResolvedValue({ ...staffRow(), mustChangePassword: false });
  expect((await request('/api/protected-test', 'GET')).status).toBe(200);
});

test('logout deletes exactly the current authenticated session', async () => {
  token = tokenFor();
  mockQuery.mockResolvedValue({ rows: [] });
  const response = await request('/api/auth/logout', 'POST', {});
  expect(response.status).toBe(200);
  expect(mockQuery).toHaveBeenCalledWith(
    'DELETE FROM sessions WHERE token=$1 AND user_id=$2', [token, 5]
  );
});
