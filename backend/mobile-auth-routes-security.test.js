'use strict';

const mockIssueOtp = jest.fn();
const mockConsumeOtp = jest.fn();
const mockTryDeliverOtp = jest.fn();
const mockSessionQuery = jest.fn();
const mockOne = jest.fn();
const mockOneOrNone = jest.fn();
const mockTxQuery = jest.fn();

jest.mock('./config', () => ({
  JWT_SECRET: 'j'.repeat(40),
  MOBILE_AUTH: { salonId: 31, otpHashKey: 'h'.repeat(32) },
}));
jest.mock('./db', () => ({
  db: { query: mockSessionQuery, one: mockOne, oneOrNone: mockOneOrNone },
  withTransaction: jest.fn(async callback => callback({ query: mockTxQuery })),
}));
jest.mock('./services/mobile-otp', () => ({
  mobileAuthConfig: jest.fn(() => ({ salonId: 31, otpHashKey: 'h'.repeat(32) })),
  normalizePhone: jest.fn(value => {
    const digits = String(value || '').replace(/\D/g, '');
    if (digits.length === 10) return `7${digits}`;
    if (digits.length === 11 && digits[0] === '8') return `7${digits.slice(1)}`;
    return digits.length === 11 && digits[0] === '7' ? digits : null;
  }),
  issueOtp: mockIssueOtp,
  consumeOtp: mockConsumeOtp,
}));
jest.mock('./services/telegram-otp', () => ({ tryDeliverOtp: mockTryDeliverOtp }));
jest.mock('./services/telegram', () => ({ getBotLink: () => 'https://t.me/synthetic_bot' }));
jest.mock('./logger', () => ({
  createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }),
}));

const express = require('express');
const jwt = require('jsonwebtoken');
const router = require('./routes/mobile-auth');
const { mobileAuth } = require('./middleware/mobile-auth');
const config = require('./config');
const { mobileAuthConfig } = require('./services/mobile-otp');

const phone = '7'.repeat(11);
let server;
let baseUrl;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/mobile/auth', router);
  await new Promise(resolve => { server = app.listen(0, '127.0.0.1', resolve); });
  baseUrl = `http://127.0.0.1:${server.address().port}/api/mobile/auth`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
});

beforeEach(() => {
  jest.clearAllMocks();
  mobileAuthConfig.mockReturnValue({ salonId: 31, otpHashKey: 'h'.repeat(32) });
  mockTryDeliverOtp.mockResolvedValue({ delivered: true });
});

async function post(path, body, token) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

test('login responses do not enumerate clients, links, delivery or OTP', async () => {
  mockIssueOtp.mockResolvedValueOnce({ issued: false, reason: 'not_found' });
  const missing = await post('/login', { phone });
  mockIssueOtp.mockResolvedValueOnce({ issued: true, otp: String(Date.now()).slice(-6), client: { id: 71 } });
  const existing = await post('/login', { phone });
  expect(missing.status).toBe(200);
  expect(existing.status).toBe(200);
  expect(existing.body).toEqual(missing.body);
  expect(existing.body.delivered).toBe(false);
  expect(existing.body.telegramLink).toBe('https://t.me/synthetic_bot');
  expect(JSON.stringify(existing.body)).not.toContain('otp');
  expect(mockTryDeliverOtp).toHaveBeenCalledWith(phone, expect.any(String), 31);
});

test('missing mobile configuration fails closed with no OTP side effect', async () => {
  mobileAuthConfig.mockImplementation(() => {
    const error = new Error('not configured');
    error.code = 'MOBILE_AUTH_NOT_CONFIGURED';
    throw error;
  });
  const response = await post('/login', { phone });
  expect(response.status).toBe(503);
  expect(mockIssueOtp).not.toHaveBeenCalled();
  expect(mockTryDeliverOtp).not.toHaveBeenCalled();
});

test('successful verification binds JWT and stored session to the server salon', async () => {
  mockConsumeOtp.mockResolvedValue(71);
  mockTxQuery.mockImplementation(async sql => {
    if (sql.includes('FROM clients')) return { rows: [{ id: 71, yclients_client_id: 81, name: null, email: null }] };
    if (sql.includes('INSERT INTO mobile_sessions')) return { rows: [] };
    throw new Error('Unexpected query');
  });
  const otp = String(Date.now()).slice(-6);
  const response = await post('/verify-otp', { phone, otp });
  expect(response.status).toBe(200);
  const claims = jwt.verify(response.body.token, config.JWT_SECRET);
  expect(claims).toMatchObject({ clientId: 71, salonId: 31, phone, type: 'client' });
  const insert = mockTxQuery.mock.calls.find(call => call[0].includes('INSERT INTO mobile_sessions'));
  expect(insert[1][0]).toBe(71);
  expect(insert[1][2]).toBe(phone);
  expect(insert[1][3]).toBe(31);
});

test('invalid or already consumed OTP creates no session', async () => {
  mockConsumeOtp.mockResolvedValue(null);
  const response = await post('/verify-otp', { phone, otp: String(Date.now()).slice(-6) });
  expect(response.status).toBe(401);
  expect(response.body.token).toBeUndefined();
  expect(mockTxQuery).not.toHaveBeenCalledWith(expect.stringContaining('INSERT INTO mobile_sessions'), expect.anything());
});

function middlewareResponse() {
  return { status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() };
}

test('mobileAuth loads live session/client/salon and rejects identity mismatch', async () => {
  const token = jwt.sign({ clientId: 71, salonId: 31, phone, type: 'client' }, config.JWT_SECRET);
  const req = { headers: { authorization: `Bearer ${token}` } };
  const res = middlewareResponse();
  const next = jest.fn();
  mockOneOrNone.mockResolvedValue({ clientId: 71, salonId: 31, phone, yclientsClientId: 81 });
  await mobileAuth(req, res, next);
  expect(next).toHaveBeenCalled();
  expect(req.client).toMatchObject({ clientId: 71, salonId: 31, yclientsClientId: 81 });
  expect(mockOneOrNone.mock.calls[0][0]).toContain('ms.salon_id=c.salon_id');
  expect(mockOneOrNone.mock.calls[0][0]).toContain('JOIN salons s ON s.id=c.salon_id AND s.is_active=TRUE');

  const mismatchedReq = { headers: { authorization: `Bearer ${token}` } };
  const mismatchedRes = middlewareResponse();
  mockOneOrNone.mockResolvedValue({ clientId: 71, salonId: 32, phone, yclientsClientId: 81 });
  await mobileAuth(mismatchedReq, mismatchedRes, jest.fn());
  expect(mismatchedRes.status).toHaveBeenCalledWith(401);
});

test('legacy mobile JWT without a server-salon claim is rejected', async () => {
  const token = jwt.sign({ clientId: 71, phone, type: 'client' }, config.JWT_SECRET);
  const res = middlewareResponse();
  await mobileAuth({ headers: { authorization: `Bearer ${token}` } }, res, jest.fn());
  expect(res.status).toHaveBeenCalledWith(401);
  expect(mockOneOrNone).not.toHaveBeenCalled();
});
