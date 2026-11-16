'use strict';

const mockOneOrNone = jest.fn();
const mockOne = jest.fn();
const mockQuery = jest.fn();
const mockGetSettings = jest.fn();
const mockProcessRecord = jest.fn();
const mockUpsertClient = jest.fn();
const mockProcessFinance = jest.fn();

jest.mock('./config', () => ({
  WEBHOOK_RATE_LIMIT: { windowMs: 60000, ipLimit: 1000, accountLimit: 1000 },
}));
jest.mock('./db', () => ({ db: { oneOrNone: mockOneOrNone, one: mockOne, query: mockQuery } }));
jest.mock('./services/loyalty', () => ({
  getLoyaltySettings: mockGetSettings,
  processRecordEvent: mockProcessRecord,
  processFinancesOperation: mockProcessFinance,
}));
jest.mock('./services/notifications', () => ({ handleRecordEvent: jest.fn() }));
jest.mock('./services/care/enroll', () => ({ handleRecordEvent: jest.fn() }));
jest.mock('./services/reminders/enroll', () => ({ handleRecordEvent: jest.fn(), handleAttribution: jest.fn() }));
jest.mock('./services/client-upsert', () => ({ upsertClientFromYc: mockUpsertClient }));
jest.mock('./services/economics', () => ({ handleGoodsEvent: jest.fn() }));
jest.mock('./services/agent/followup-queue', () => ({ closeByPhone: jest.fn() }));
jest.mock('./services/agent-gate', () => ({ normalizePhoneKey: jest.fn() }));
jest.mock('./logger', () => {
  const log = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
  return { createLogger: () => log, __log: log };
});

const express = require('express');
const router = require('./routes/webhook');
const config = require('./config');
const { __log: log } = require('./logger');

const secret = 's'.repeat(32);
let server;
let baseUrl;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/yclients', router);
  await new Promise(resolve => { server = app.listen(0, '127.0.0.1', resolve); });
  baseUrl = `http://127.0.0.1:${server.address().port}/yclients/webhook.v2`;
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
});
beforeEach(() => {
  jest.clearAllMocks();
  mockOneOrNone.mockResolvedValue({ id: 9, yclients_webhook_secret: secret });
  mockOne.mockResolvedValue({ id: 99 });
  mockQuery.mockResolvedValue({ rows: [] });
  mockGetSettings.mockResolvedValue({});
});

async function post(company, key, headers = {}) {
  const response = await fetch(`${baseUrl}/${company}${key === null ? '' : `?key=${encodeURIComponent(key)}`}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify({ resource: 'unsupported', data: {} }),
  });
  return { status: response.status, body: await response.json() };
}

function expectNoSideEffects() {
  expect(mockOne).not.toHaveBeenCalled();
  expect(mockGetSettings).not.toHaveBeenCalled();
  expect(mockProcessRecord).not.toHaveBeenCalled();
  expect(mockUpsertClient).not.toHaveBeenCalled();
  expect(mockProcessFinance).not.toHaveBeenCalled();
}

test('empty salon secret returns 503 before event log or handlers', async () => {
  mockOneOrNone.mockResolvedValue({ id: 9, yclients_webhook_secret: null });
  expect((await post('101', secret)).status).toBe(503);
  expectNoSideEffects();
});

test.each([[null], [''], ['wrong']])('missing/empty/wrong key returns 401 before side effects', async key => {
  expect((await post('102', key)).status).toBe(401);
  expectNoSideEffects();
});

test('unknown company cannot be used as an unauthenticated processing path', async () => {
  mockOneOrNone.mockResolvedValue(null);
  expect((await post('103', secret)).status).toBe(404);
  expectNoSideEffects();
});

test('valid secret receives fast ACK and only then reaches processing', async () => {
  const response = await post('104', secret);
  expect(response.status).toBe(200);
  expect(response.body).toEqual({ ok: true });
  expect(mockOne).toHaveBeenCalledTimes(1);
  expect(mockGetSettings).toHaveBeenCalledWith(9);
  const output = JSON.stringify(Object.values(log).flatMap(fn => fn.mock.calls));
  expect(output).not.toContain(secret);
});

test('IP and company limiters reject before salon lookup', async () => {
  const previous = { ...config.WEBHOOK_RATE_LIMIT };
  config.WEBHOOK_RATE_LIMIT.ipLimit = 2;
  config.WEBHOOK_RATE_LIMIT.accountLimit = 2;
  let limitedRouter;
  jest.isolateModules(() => { limitedRouter = require('./routes/webhook'); });
  const app = express();
  app.set('trust proxy', 1);
  app.use(express.json());
  app.use('/yclients', limitedRouter);
  let limitedServer;
  await new Promise(resolve => { limitedServer = app.listen(0, '127.0.0.1', resolve); });
  const limitedBase = `http://127.0.0.1:${limitedServer.address().port}/yclients/webhook.v2`;
  try {
    const send = (forwardedFor, company = 105) => fetch(`${limitedBase}/${company}?key=wrong`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(forwardedFor ? { 'X-Forwarded-For': forwardedFor } : {}) },
      body: '{}',
    });
    expect((await send()).status).toBe(401);
    expect((await send()).status).toBe(401);
    expect((await send()).status).toBe(429);
    expect(mockOneOrNone).toHaveBeenCalledTimes(2);
    expectNoSideEffects();

    mockOneOrNone.mockClear();
    expect((await send('192.0.2.1', 106)).status).toBe(401);
    expect((await send('192.0.2.2', 106)).status).toBe(401);
    expect((await send('192.0.2.3', 106)).status).toBe(429);
    expect(mockOneOrNone).toHaveBeenCalledTimes(2);
    expectNoSideEffects();
  } finally {
    limitedServer.closeAllConnections();
    await new Promise(resolve => limitedServer.close(resolve));
    Object.assign(config.WEBHOOK_RATE_LIMIT, previous);
  }
});
