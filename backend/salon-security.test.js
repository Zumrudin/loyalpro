'use strict';

const mockCurrentUser = { userId: 5, salonId: 11, role: 'owner' };
const mockOne = jest.fn();
const mockOneOrNone = jest.fn();
const mockQuery = jest.fn();
const mockYcAuth = jest.fn();
const mockLog = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };

jest.mock('./middleware/auth', () => ({
  auth: (req, _res, next) => { req.user = { ...mockCurrentUser }; next(); },
  requireRole: (...roles) => (req, res, next) => roles.includes(req.user.role)
    ? next() : res.status(403).json({ error: 'forbidden' }),
}));
jest.mock('./db', () => ({ db: { one: mockOne, oneOrNone: mockOneOrNone, query: mockQuery } }));
jest.mock('./services/yclients', () => ({ ycAuth: mockYcAuth, ycWebSessions: {} }));
jest.mock('./services/loyalty', () => ({ getLoyaltySettings: jest.fn() }));
jest.mock('./logger', () => ({ createLogger: () => mockLog }));

const express = require('express');
const router = require('./routes/salon');

let server;
let baseUrl;
beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/salon', router);
  await new Promise(resolve => { server = app.listen(0, '127.0.0.1', resolve); });
  baseUrl = `http://127.0.0.1:${server.address().port}/api/salon`;
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
});
beforeEach(() => {
  jest.clearAllMocks();
  Object.assign(mockCurrentUser, { userId: 5, salonId: 11, role: 'owner' });
});

async function request(path, method = 'GET', body) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

const expectedFields = [
  'id', 'name', 'city', 'timezone', 'logo_url',
  'yclients_company_id', 'yclients_card_type_id', 'yclients_card_type_name', 'yclients_chain_id',
  'yclients_partner_configured', 'yclients_user_configured',
  'yclients_web_session_configured', 'yclients_webhook_configured',
  'plan', 'max_users',
];

test('GET returns an exact whitelist DTO and no secret markers', async () => {
  mockOne.mockResolvedValue({
    id: 11, name: 'Synthetic', city: null, timezone: 'Europe/Moscow', logo_url: null,
    yclients_company_id: 'company', yclients_card_type_id: 2, yclients_card_type_name: 'Card',
    yclients_chain_id: null, yclients_partner_configured: true, yclients_user_configured: true,
    yclients_web_session_configured: true, yclients_webhook_configured: true,
    plan: 'test', max_users: 3,
    yclients_partner_token: 'synthetic-secret-marker',
    yclients_user_token: 'synthetic-secret-marker',
    yclients_password: 'synthetic-secret-marker',
    yclients_web_cookie: 'synthetic-secret-marker',
    yclients_webhook_secret: 'synthetic-secret-marker',
    future_private_field: 'synthetic-secret-marker',
  });
  const response = await request('/');
  expect(response.status).toBe(200);
  expect(Object.keys(response.body)).toEqual(expectedFields);
  expect(JSON.stringify(response.body)).not.toContain('synthetic-secret-marker');
  expect(Object.keys(response.body)).not.toContainEqual(expect.stringMatching(/secret|token|password|cookie|private/i));
  expect(mockOne.mock.calls[0][0]).not.toContain('SELECT *');
  expect(mockOne.mock.calls[0][1]).toEqual([11]);
});

test('general settings remain available to admin but integration writes are owner-only', async () => {
  mockCurrentUser.role = 'admin';
  mockQuery.mockResolvedValue({ rows: [] });
  const general = await request('/', 'PUT', { name: 'Synthetic', city: null, timezone: 'Europe/Moscow' });
  expect(general.status).toBe(200);
  expect(mockQuery).toHaveBeenCalledTimes(1);
  mockQuery.mockClear();
  const integration = await request('/', 'PUT', { yclients_company_id: 'another' });
  expect(integration.status).toBe(403);
  expect(mockQuery).not.toHaveBeenCalled();
});

test('settings failures do not expose database details', async () => {
  mockQuery.mockRejectedValue(new Error('synthetic-private-database-marker'));
  const response = await request('/', 'PUT', { name: 'Synthetic' });
  expect(response).toEqual({ status: 500, body: { error: 'Внутренняя ошибка сервера' } });
});

test('credential authentication returns no token and cannot be invoked by admin', async () => {
  mockCurrentUser.role = 'admin';
  expect((await request('/yclients-auth', 'POST', {})).status).toBe(403);
  expect(mockYcAuth).not.toHaveBeenCalled();

  mockCurrentUser.role = 'owner';
  mockYcAuth.mockResolvedValue({ user_token: 'synthetic-secret-marker' });
  mockQuery.mockResolvedValue({ rows: [{ yclients_company_id: 'synthetic-company' }] });
  const response = await request('/yclients-auth', 'POST', {
    partnerToken: 'synthetic-input', login: 'synthetic-login', password: 'synthetic-password',
    yclients_company_id: 'synthetic-company',
  });
  expect(response.status).toBe(200);
  expect(response.body).toEqual({ ok: true, configured: true, companyId: 'synthetic-company' });
  expect(JSON.stringify(response.body)).not.toContain('synthetic-secret-marker');
  expect(JSON.stringify(mockLog)).not.toContain('synthetic-secret-marker');
  expect(mockQuery.mock.calls[0][1][6]).toBe(11);
});

test('webhook secret rotation is owner-only and status never returns the value', async () => {
  mockCurrentUser.role = 'admin';
  expect((await request('/webhook-secret', 'POST', {})).status).toBe(403);
  expect(mockQuery).not.toHaveBeenCalled();
  mockOneOrNone.mockResolvedValue({ yclients_webhook_secret: 'synthetic-secret-marker' });
  const status = await request('/webhook-secret');
  expect(status.body).toEqual({ configured: true });
  expect(JSON.stringify(status.body)).not.toContain('synthetic-secret-marker');
});
