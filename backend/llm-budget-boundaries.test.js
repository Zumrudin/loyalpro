'use strict';
const mockAny = jest.fn();
const mockQuery = jest.fn();
const mockAttempt = jest.fn();
const mockRunLlm = jest.fn();
let mockContext;
jest.mock('./config', () => ({ KB_GEMINI_KEY_FREE: 'synthetic', KB_LLM_MODEL: 'synthetic', KB_EMBED_MODEL: 'synthetic' }));
jest.mock('./db', () => ({ db: { any: mockAny, query: mockQuery } }));
jest.mock('./logger', () => ({ createLogger: () => ({ info: jest.fn(), warn: jest.fn() }) }));
jest.mock('./services/resource-limits', () => ({
  attempt: mockAttempt,
  runLlm: mockRunLlm,
  isLimitError: e => ['BUDGET_EXHAUSTED', 'CONCURRENCY', 'PAID_DISABLED'].includes(e?.code),
}));
jest.mock('./services/knowledge-base', () => ({ buildPrefixTsQuery: value => value }));
jest.mock('./services/agent-rag', () => ({
  vectorNorm: () => 1, cosineSim: () => 1,
  reciprocalRankFusion: lists => [...new Set(lists.flat())],
}));
const kb = require('./services/kb-assistant');
const anthropic = require('./services/agent/providers/anthropic');
const originalFetch = global.fetch;
const errorFor = code => Object.assign(new Error('Synthetic budget denial'), { code, status: 429 });

beforeEach(() => {
  jest.clearAllMocks();
  mockContext = null;
  mockRunLlm.mockImplementation(async (salonId, userId, fn) => {
    expect(mockContext).toBeNull(); // A second nested lease would fail.
    mockContext = { salonId, userId };
    try { return await fn(); } finally { mockContext = null; }
  });
  mockAttempt.mockImplementation(async () => {
    expect(mockContext).toEqual({ salonId: 101, userId: 202 });
  });
  mockAny.mockReset()
    .mockResolvedValueOnce([{ id: 1 }])
    .mockResolvedValueOnce([{ article_id: 1, embedding: [1], embed_norm: 1 }])
    .mockResolvedValueOnce([{ id: 1, title: 'Synthetic article', body: 'Synthetic content' }]);
  mockQuery.mockResolvedValue({ rows: [] });
  global.fetch = jest.fn()
    .mockResolvedValueOnce({ ok: true, json: async () => ({ embedding: { values: [1] } }) })
    .mockResolvedValueOnce({ ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: '{"ids":[1]}' }] } }] }) })
    .mockResolvedValueOnce({ ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: 'Synthetic answer' }] } }] }) });
});
afterAll(() => { global.fetch = originalFetch; });

test('one salon context covers embedding, reranking and final generation', async () => {
  await expect(kb.ask(101, 202, 'synthetic query')).resolves.toMatchObject({ answer: 'Synthetic answer' });
  expect(mockRunLlm).toHaveBeenCalledTimes(1);
  expect(mockAttempt).toHaveBeenCalledTimes(3);
  expect(global.fetch).toHaveBeenCalledTimes(3);
  expect(mockContext).toBeNull();
});

test.each(['BUDGET_EXHAUSTED', 'CONCURRENCY', 'PAID_DISABLED'])('%s in embedding stops retrieval and all later providers', async code => {
  mockAttempt.mockRejectedValueOnce(errorFor(code));
  await expect(kb.ask(101, 202, 'synthetic query')).rejects.toMatchObject({ code });
  expect(global.fetch).not.toHaveBeenCalled();
  expect(mockAttempt).toHaveBeenCalledTimes(1);
});

test.each(['BUDGET_EXHAUSTED', 'CONCURRENCY', 'PAID_DISABLED'])('%s in reranking stops generation instead of falling back', async code => {
  mockAttempt.mockResolvedValueOnce().mockRejectedValueOnce(errorFor(code));
  await expect(kb.ask(101, 202, 'synthetic query')).rejects.toMatchObject({ code });
  expect(global.fetch).toHaveBeenCalledTimes(1);
  expect(mockAttempt).toHaveBeenCalledTimes(2);
});

test.each(['BUDGET_EXHAUSTED', 'PAID_DISABLED'])('Anthropic %s stops the paid SDK before invocation', async code => {
  mockAttempt.mockRejectedValueOnce(errorFor(code));
  const create = jest.fn();
  await expect(anthropic.createMessage({ messages: [], tools: [] }, { client: { messages: { create } } })).rejects.toMatchObject({ code });
  expect(mockAttempt).toHaveBeenCalledWith({ paid: true });
  expect(create).not.toHaveBeenCalled();
});

test('Anthropic accounts each invocation and forbids SDK retries', async () => {
  mockAttempt.mockResolvedValue();
  const create = jest.fn().mockResolvedValue({ content: [{ type: 'text', text: 'Synthetic answer' }] });
  for (let i = 0; i < 2; i++) await anthropic.createMessage({ messages: [], tools: [] }, { client: { messages: { create } } });
  expect(mockAttempt).toHaveBeenCalledTimes(2);
  expect(create).toHaveBeenCalledTimes(2);
  expect(create.mock.calls.every(([, options]) => options.maxRetries === 0)).toBe(true);
});

test.each(['gpt', 'claude', 'polza'])('budget denial in %s preserves routing state and stops fallback', async active => {
  const error = errorFor('BUDGET_EXHAUSTED');
  const store = { get: jest.fn().mockResolvedValue({ active }), transition: jest.fn(), outcome: jest.fn() };
  const providers = Object.fromEntries(['gpt', 'claude', 'polza'].map(name => [name, { createMessage: jest.fn().mockRejectedValue(error) }]));
  const provider = require('./services/agent/providers/resilient').createProvider({ salonId: 101, store, providers });
  await expect(provider.createMessage({ messages: [] })).rejects.toBe(error);
  expect(providers[active].createMessage).toHaveBeenCalledTimes(1);
  for (const [name, candidate] of Object.entries(providers)) {
    if (name !== active) expect(candidate.createMessage).not.toHaveBeenCalled();
  }
  expect(store.transition).not.toHaveBeenCalled();
  expect(store.outcome).not.toHaveBeenCalled();
});
