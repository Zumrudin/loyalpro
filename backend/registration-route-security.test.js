'use strict';

const mockQuery = jest.fn();
const mockRelease = jest.fn();
const mockConnect = jest.fn();
const mockRateOne = jest.fn();
jest.mock('./config', () => ({
  JWT_SECRET: 'synthetic-registration-test-secret'.repeat(2),
  REGISTRATION_MODE: 'invite',
}));
jest.mock('./db', () => ({
  pool: { connect: mockConnect },
  db: { one: mockRateOne },
  withTransaction: jest.fn(),
}));
jest.mock('bcryptjs', () => ({ hash: jest.fn(async () => 'synthetic-password-hash') }));

const express = require('express');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const config = require('./config');
const router = require('./routes/auth');
const invitation = 'a'.repeat(43);
const email = 'synthetic@example.invalid';
const tokenHash = crypto.createHash('sha256').update(invitation).digest('hex');
const emailHash = crypto.createHmac('sha256', config.JWT_SECRET).update(`registration:${email}`).digest('hex');
let server;
let baseUrl;
let failSession;
let rejectInvite;
let consoleError;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/auth', router);
  await new Promise(resolve => { server = app.listen(0, '127.0.0.1', resolve); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
});
beforeEach(() => {
  jest.clearAllMocks();
  failSession = false;
  rejectInvite = false;
  consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
  mockRateOne.mockResolvedValue({ count: 1 });
  mockConnect.mockResolvedValue({ query: mockQuery, release: mockRelease });
  mockQuery.mockImplementation(async (sql, params) => {
    if (sql.startsWith('UPDATE registration_invites')) {
      const matched = !rejectInvite && params[0] === tokenHash && params[1] === emailHash;
      return { rows: matched ? [{ token_hash: tokenHash }] : [] };
    }
    if (sql.startsWith('INSERT INTO salons')) return { rows: [{ id: 101 }] };
    if (sql.includes('INSERT INTO users')) return { rows: [{ id: 202, name: 'Synthetic salon', email, role: 'owner' }] };
    if (sql.includes('INSERT INTO sessions') && failSession) throw new Error('Synthetic session failure');
    if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(sql) || /INSERT INTO (loyalty_settings|sessions)/.test(sql)) return { rows: [] };
    throw new Error('Unexpected query');
  });
});
afterEach(() => consoleError.mockRestore());

async function register(overrides = {}) {
  const response = await fetch(`${baseUrl}/api/auth/register`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ salonName: 'Synthetic salon', email, password: 'synthetic-password-only', invitation, ...overrides }),
  });
  return { status: response.status, body: await response.json() };
}
const statements = () => mockQuery.mock.calls.map(([sql]) => sql);

test.each([
  ['missing', undefined],
  ['malformed', 'invalid'],
  ['well-formed but unknown', 'b'.repeat(43)],
])('%s invitation returns 403 before any salon insert', async (_label, invalid) => {
  const result = await register({ invitation: invalid });
  expect(result.status).toBe(403);
  expect(statements()[0]).toBe('BEGIN');
  expect(statements()).toContain('ROLLBACK');
  expect(statements()).not.toContain('COMMIT');
  expect(statements().some(sql => sql.includes('INSERT INTO'))).toBe(false);
  expect(mockRelease).toHaveBeenCalledTimes(1);
});

test('valid invitation and salon/user/session inserts share one transaction', async () => {
  const result = await register();
  expect(result.status).toBe(200);
  expect(mockConnect).toHaveBeenCalledTimes(1);
  const sql = statements();
  expect(sql[0]).toBe('BEGIN');
  expect(sql[1]).toMatch(/^UPDATE registration_invites/);
  expect(mockQuery.mock.calls[1][1]).toEqual([tokenHash, emailHash]);
  expect(sql[2]).toMatch(/^INSERT INTO salons/);
  expect(sql[3]).toMatch(/^INSERT INTO loyalty_settings/);
  expect(sql[4]).toContain('INSERT INTO users');
  expect(sql[5]).toContain('INSERT INTO sessions');
  expect(sql[6]).toBe('COMMIT');
  expect(sql).not.toContain('ROLLBACK');
  expect(jwt.verify(result.body.token, config.JWT_SECRET)).toMatchObject({ userId: 202, salonId: 101, role: 'owner' });
  expect(mockQuery.mock.calls[4][1][0]).toBe(101);
  expect(mockQuery.mock.calls[5][1][0]).toBe(202);
  expect(mockRelease).toHaveBeenCalledTimes(1);
});

test('expired or reused invitation rejected by DB cannot create a salon', async () => {
  rejectInvite = true;
  expect((await register()).status).toBe(403);
  expect(statements().some(sql => sql.includes('INSERT INTO'))).toBe(false);
  expect(statements()).toContain('ROLLBACK');
});

test('session write failure rolls back invitation, salon and user together', async () => {
  failSession = true;
  const result = await register();
  expect(result.status).toBe(500);
  expect(result.body.token).toBeUndefined();
  expect(statements()).toContain('ROLLBACK');
  expect(statements()).not.toContain('COMMIT');
  expect(statements().some(sql => sql.includes('INSERT INTO sessions'))).toBe(true);
  expect(mockRelease).toHaveBeenCalledTimes(1);
});

test('connection acquisition failure returns 500 without transaction or release', async () => {
  mockConnect.mockRejectedValueOnce(new Error('Synthetic connection failure'));
  const result = await register();
  expect(result.status).toBe(500);
  expect(result.body.token).toBeUndefined();
  expect(mockQuery).not.toHaveBeenCalled();
  expect(mockRelease).not.toHaveBeenCalled();
});
