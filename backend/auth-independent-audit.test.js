'use strict';

const jwt = require('jsonwebtoken');

const mockOneOrNone = jest.fn();
const mockResetQuery = jest.fn();

jest.mock('./config', () => ({
  JWT_SECRET: 'audit-only-secret-that-is-longer-than-32-characters',
  API_PUBLIC: ['/api/auth/login', '/api/auth/register'],
  SPECIALIST_ALLOWED_PREFIXES: ['/api/home-care', '/api/auth'],
  CASHIER_ALLOWED_PREFIXES: ['/api/home-care', '/api/auth', '/api/chat'],
}));

jest.mock('./db', () => ({
  db: { oneOrNone: mockOneOrNone },
  pool: { connect: jest.fn(), end: jest.fn() },
}));
jest.mock('bcryptjs', () => ({ hash: jest.fn(async () => 'synthetic-hash') }));

const config = require('./config');
const { apiAuthGuard } = require('./routes/index');

function response() {
  return { status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() };
}

beforeEach(() => { jest.clearAllMocks(); });

function token(role = 'owner') {
  return jwt.sign({ userId: 41, salonId: 7, role }, config.JWT_SECRET, { expiresIn: '1h' });
}

function restrictedRow(restricted = true, role = 'owner') {
  return { userId: 41, salonId: 7, role, mustChangePassword: restricted };
}

test.each([
  ['owner', '/api/users'],
  ['admin', '/api/users'],
  ['specialist', '/api/home-care'],
  ['admin_cashier', '/api/chat'],
])('restricted %s session rejects a directly requested role-authorized API', async (role, originalUrl) => {
  mockOneOrNone.mockResolvedValue(restrictedRow(true, role));
  const req = {
    method: 'GET', headers: { authorization: `Bearer ${token(role)}` },
    originalUrl,
    path: originalUrl.slice(4),
  };
  const res = response();
  const next = jest.fn();

  await apiAuthGuard(req, res, next);

  expect(next).not.toHaveBeenCalled();
  expect(res.status).toHaveBeenCalledWith(403);
  expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'PASSWORD_CHANGE_REQUIRED' }));
  expect(mockOneOrNone.mock.calls[0][0]).toContain('must_change_password');
});

test.each([
  ['GET', '/api/auth/me'],
  ['POST', '/api/auth/change-password'],
  ['POST', '/api/auth/logout'],
])('restricted session permits only necessary endpoint %s %s, including second auth pass', async (method, originalUrl) => {
  mockOneOrNone.mockResolvedValue(restrictedRow());
  const req = { method, originalUrl, path: originalUrl.slice(4), headers: { authorization: `Bearer ${token()}` } };
  const res = response();
  const first = jest.fn();
  const { auth } = require('./middleware/auth');
  await auth(req, res, first);
  expect(first).toHaveBeenCalledTimes(1);
  const second = jest.fn();
  await auth(req, res, second);
  expect(second).toHaveBeenCalledTimes(1);
  expect(mockOneOrNone).toHaveBeenCalledTimes(1);
});

test('restricted session rejects method or path variants outside the exact allowlist', async () => {
  mockOneOrNone.mockResolvedValue(restrictedRow());
  const res = response();
  const { auth } = require('./middleware/auth');
  await auth({ method: 'GET', originalUrl: '/api/auth/logout', path: '/auth/logout', headers: { authorization: `Bearer ${token()}` } }, res, jest.fn());
  expect(res.status).toHaveBeenCalledWith(403);
});

test('ordinary session remains backward compatible', async () => {
  mockOneOrNone.mockResolvedValue(restrictedRow(false));
  const next = jest.fn();
  await apiAuthGuard({ method: 'GET', originalUrl: '/api/users', path: '/users', headers: { authorization: `Bearer ${token()}` } }, response(), next);
  expect(next).toHaveBeenCalledTimes(1);
});

describe('recovery CLI transaction', () => {
  const { resetPassword } = require('./reset-password');

  beforeEach(() => { mockResetQuery.mockReset(); });

  test('atomically updates the hash and revokes every session', async () => {
    mockResetQuery.mockImplementation(async sql => sql.startsWith('SELECT id') ? { rows: [{ id: 9 }] } : { rows: [] });
    await resetPassword({ query: mockResetQuery }, ' Operator@Example.test ', 'new-password-value');
    expect(mockResetQuery.mock.calls.map(call => call[0])).toEqual([
      'BEGIN',
      'SELECT id FROM users WHERE email=$1 FOR UPDATE',
      'UPDATE users SET password_hash=$1, must_change_password=FALSE WHERE id=$2',
      'DELETE FROM sessions WHERE user_id=$1',
      'COMMIT',
    ]);
    expect(mockResetQuery.mock.calls[1][1]).toEqual(['operator@example.test']);
    expect(mockResetQuery.mock.calls[3][1]).toEqual([9]);
  });

  test('rolls back the password update when session revocation fails', async () => {
    mockResetQuery.mockImplementation(async sql => {
      if (sql.startsWith('SELECT id')) return { rows: [{ id: 9 }] };
      if (sql.startsWith('DELETE FROM sessions')) throw new Error('synthetic delete failure');
      return { rows: [] };
    });
    await expect(resetPassword({ query: mockResetQuery }, 'operator@example.test', 'new-password-value')).rejects.toThrow('synthetic delete failure');
    expect(mockResetQuery.mock.calls.at(-1)[0]).toBe('ROLLBACK');
    expect(mockResetQuery).not.toHaveBeenCalledWith('COMMIT');
  });
});
