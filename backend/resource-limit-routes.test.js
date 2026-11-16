'use strict';
const express = require('express');
const mockConnect = jest.fn();
const mockAsk = jest.fn();
const mockRelayCall = jest.fn();
const mockRegisterLimit = jest.fn();
const mockAskRate = jest.fn();
const mockRelayRate = jest.fn();
const mockClaimGlobal = jest.fn();

jest.mock('./db', () => ({
  pool: { connect: mockConnect }, db: { one: jest.fn(), oneOrNone: jest.fn(), query: jest.fn(), any: jest.fn() },
  withTransaction: jest.fn(),
}));
jest.mock('./config', () => ({
  JWT_SECRET: 's'.repeat(40),
  KB_GEMINI_RELAY_SECRET: 'synthetic-relay-secret',
  KB_GEMINI_KEY_FREE: '', KB_GEMINI_KEY_PAID: '', KB_LLM_MODEL: 'synthetic', KB_EMBED_MODEL: 'synthetic',
  RESOURCE_LIMITS: { relayPerMinute: 120 },
}));
jest.mock('./middleware/auth', () => ({
  auth: (req, _res, next) => { req.user = { salonId: 11, userId: 5, role: 'owner' }; next(); },
  requireRole: () => (_req, _res, next) => next(),
}));
jest.mock('./services/resource-limits', () => ({
  register: mockRegisterLimit, askRate: mockAskRate, consumeRate: mockRelayRate, claimGlobal: mockClaimGlobal,
}));
jest.mock('./services/kb-assistant', () => ({
  ask: mockAsk, callGeminiDirect: mockRelayCall, embedTextDirect: jest.fn(),
}));
jest.mock('./services/agent-rag', () => ({ reembedArticle: jest.fn() }));
jest.mock('./logger', () => ({ createLogger: () => ({ error: jest.fn(), warn: jest.fn(), info: jest.fn() }) }));

const authRouter = require('./routes/auth');
const kbRouter = require('./routes/knowledge-base');
let server;
let baseUrl;
beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/auth', authRouter);
  app.use('/kb', kbRouter);
  await new Promise(resolve => { server = app.listen(0, '127.0.0.1', resolve); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
});
beforeEach(() => {
  jest.clearAllMocks();
  mockRegisterLimit.mockResolvedValue(undefined);
  mockAskRate.mockResolvedValue(undefined);
  mockRelayRate.mockResolvedValue(true);
  mockClaimGlobal.mockResolvedValue(undefined);
});
async function post(path, body, relay = false) {
  return fetch(baseUrl + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(relay ? { 'X-Relay-Secret': 'synthetic-relay-secret' } : {}) },
    body: JSON.stringify(body),
  });
}

test('registration rate rejection happens before a DB connection or salon creation', async () => {
  mockRegisterLimit.mockRejectedValue(Object.assign(new Error('Too many'), { status: 429 }));
  const response = await post('/auth/register', {
    salonName: 'Synthetic', email: 'synthetic@example.invalid', password: 'synthetic-password',
  });
  expect(response.status).toBe(429);
  expect(mockConnect).not.toHaveBeenCalled();
});

test('ask rate rejection never reaches the assistant', async () => {
  mockAskRate.mockRejectedValue(Object.assign(new Error('Too many'), { status: 429 }));
  expect((await post('/kb/ask', { question: 'Synthetic question' })).status).toBe(429);
  expect(mockAsk).not.toHaveBeenCalled();
});

test('relay budget exhaustion and oversized payloads never reach the provider', async () => {
  mockClaimGlobal.mockRejectedValue(Object.assign(new Error('Budget'), { status: 429 }));
  expect((await post('/kb/relay', { prompt: { system: 'Synthetic', user: 'Synthetic' } }, true)).status).toBe(429);
  expect(mockRelayCall).not.toHaveBeenCalled();
  mockClaimGlobal.mockResolvedValue(undefined);
  expect((await post('/kb/relay', { prompt: { system: 's'.repeat(16001), user: 'Synthetic' } }, true)).status).toBe(400);
  expect((await post('/kb/relay/embed', { text: 'x'.repeat(10001) }, true)).status).toBe(400);
  expect(mockClaimGlobal).toHaveBeenCalledTimes(1);
  expect(mockRelayCall).not.toHaveBeenCalled();
});

test('relay provider failures return no provider response or secret', async () => {
  mockRelayCall.mockRejectedValue(new Error('synthetic-provider-marker'));
  const response = await post('/kb/relay', { prompt: { system: 'Synthetic', user: 'Synthetic' } }, true);
  expect(response.status).toBe(502);
  const text = await response.text();
  expect(text).not.toContain('synthetic-provider-marker');
  expect(text).not.toContain('synthetic-relay-secret');
});
