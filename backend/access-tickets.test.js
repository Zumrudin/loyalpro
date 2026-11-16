'use strict';
const express = require('express');
const mockOne = jest.fn();
const mockOneOrNone = jest.fn();
const mockSubscribe = jest.fn((salonId, res) => res.end());

jest.mock('./db', () => ({ db: { one: mockOne, oneOrNone: mockOneOrNone } }));
jest.mock('./middleware/auth', () => ({
  auth: (req, _res, next) => { req.user = { userId: 5, salonId: 11, role: 'owner' }; next(); },
  requireRole: (...roles) => (req, res, next) => roles.includes(req.user?.role)
    ? next() : res.status(403).json({ error: 'Forbidden' }),
}));
jest.mock('./services/chat-events', () => ({ subscribe: mockSubscribe }));
jest.mock('./services/messaging/transport', () => ({}));
jest.mock('./services/chat-persist', () => ({ persistWhatsappOutgoing: jest.fn() }));
jest.mock('./services/outgoing-authorship', () => ({ remember: jest.fn() }));
jest.mock('./services/agent/dialog-state', () => ({ pauseForOperator: jest.fn() }));
jest.mock('./services/agent/followup-queue', () => ({ close: jest.fn() }));
jest.mock('./logger', () => ({ createLogger: () => ({ error: jest.fn(), warn: jest.fn(), info: jest.fn() }) }));

const tickets = require('./services/access-tickets');
const { API_ACCESS_TICKETS_DDL } = require('./migrations');
const router = require('./routes/chat');

let server;
let baseUrl;
beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use(router);
  await new Promise(resolve => { server = app.listen(0, '127.0.0.1', resolve); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
});
beforeEach(() => {
  jest.clearAllMocks();
  mockOne.mockResolvedValue({ expires_at: new Date('2030-01-01T00:01:00Z') });
  mockOneOrNone.mockResolvedValue({ userId: 5, salonId: 11, role: 'owner' });
});

test('issue stores only a hash of a random ticket scoped to the server identity', async () => {
  const response = await fetch(baseUrl + '/stream-ticket', { method: 'POST' });
  const body = await response.json();
  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect(response.headers.get('referrer-policy')).toBe('no-referrer');
  expect(body.ticket).toMatch(/^[A-Za-z0-9_-]{43}$/);
  const [sql, params] = mockOne.mock.calls[0];
  expect(sql).toContain("NOW()+INTERVAL '60 seconds'");
  expect(params).toEqual([expect.stringMatching(/^[a-f0-9]{64}$/), 5, 11, 'chat:stream']);
  expect(params[0]).not.toBe(body.ticket);
  expect(API_ACCESS_TICKETS_DDL).toContain('token_hash CHAR(64) PRIMARY KEY');
  expect(API_ACCESS_TICKETS_DDL).toContain('salon_id INTEGER NOT NULL REFERENCES salons(id)');
});

test('stream atomically consumes a ticket and uses only its database tenant and current role', async () => {
  const raw = 't'.repeat(43);
  const response = await fetch(baseUrl + '/stream?ticket=' + raw + '&salonId=22');
  expect(response.status).toBe(200);
  expect(await response.text()).toContain('retry: 3000');
  expect(response.headers.get('cache-control')).toContain('no-store');
  const [sql, params] = mockOneOrNone.mock.calls[0];
  expect(params).toEqual([tickets.hash(raw), 'chat:stream']);
  expect(params[0]).not.toBe(raw);
  for (const fragment of ['t.used_at IS NULL', 't.expires_at>NOW()', 'u.is_active=TRUE', 's.id=u.salon_id', 's.is_active=TRUE']) {
    expect(sql).toContain(fragment);
  }
  expect(mockSubscribe).toHaveBeenCalledWith(11, expect.anything());

  mockOneOrNone.mockResolvedValue(null);
  expect((await fetch(baseUrl + '/stream?ticket=' + raw)).status).toBe(401);
  expect(mockSubscribe).toHaveBeenCalledTimes(1);
});

test('current role, expired ticket and storage failure fail closed without provider details', async () => {
  mockOneOrNone.mockResolvedValue({ userId: 5, salonId: 11, role: 'specialist' });
  expect((await fetch(baseUrl + '/stream?ticket=' + 'r'.repeat(43))).status).toBe(403);
  mockOneOrNone.mockResolvedValue(null);
  expect((await fetch(baseUrl + '/stream?ticket=' + 'e'.repeat(43))).status).toBe(401);
  mockOneOrNone.mockRejectedValue(new Error('synthetic-storage-marker'));
  const failed = await fetch(baseUrl + '/stream?ticket=' + 'f'.repeat(43));
  expect(failed.status).toBe(503);
  expect(await failed.text()).not.toContain('synthetic-storage-marker');
  expect(mockSubscribe).not.toHaveBeenCalled();
});
