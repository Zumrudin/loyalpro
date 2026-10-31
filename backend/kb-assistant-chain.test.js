'use strict';
// Ассистент базы знаний идёт по той же цепочке, что Мила (мост GPT → Claude → Польза
// на проде, Codex → Польза на деве), но НЕ трогает маршрутизацию Милы:
// упавший вопрос сотрудника не должен переключать её на резерв.
jest.mock('./services/agent/model-routing', () => { throw new Error('model-routing не должен импортироваться'); });

const config = require('./config');
const kb = require('./services/kb-assistant');

afterEach(() => { config.KB_CHAT_PROVIDER = 'agent'; });

describe('callAgentChain', () => {
  test('шлёт system и вопрос одним user-сообщением без инструментов, отдаёт text', async () => {
    const calls = [];
    const provider = { createMessage: async (req) => { calls.push(req); return { text: '  Ответ.\nВторая строка.  ', model: 'gpt-6-astra' }; } };
    const out = await kb.callAgentChain({ system: 'S', user: 'U' }, { provider });
    expect(out).toBe('Ответ.\nВторая строка.');
    expect(calls).toEqual([{ system: 'S', messages: [{ role: 'user', content: 'U' }], tools: [] }]);
  });

  test('отказ всей цепочки пробрасывается (ask уйдёт в деградацию с источниками)', async () => {
    const provider = { createMessage: async () => { throw Object.assign(new Error('x'), { code: 'VERDICT_PROVIDER_FAILED' }); } };
    await expect(kb.callAgentChain({ system: 'S', user: 'U' }, { provider })).rejects.toThrow();
  });
});

describe('callGemini — выбор провайдера', () => {
  test('по умолчанию (agent) — цепочка Милы', async () => {
    expect(config.KB_CHAT_PROVIDER).toBe('agent');
    const provider = { createMessage: async () => ({ text: 'из цепочки' }) };
    await expect(kb.callGemini({ system: 'S', user: 'U' }, { provider })).resolves.toBe('из цепочки');
  });

  test('KB_CHAT_PROVIDER=aitunnel — прежний путь (откат без правки кода)', async () => {
    config.KB_CHAT_PROVIDER = 'aitunnel';
    const provider = { createMessage: async () => { throw new Error('цепочку звать нельзя'); } };
    const client = { chat: { completions: { create: async () => ({ choices: [{ message: { content: 'из aitunnel' } }] }) } } };
    await expect(kb.callGemini({ system: 'S', user: 'U' }, { provider, client })).resolves.toBe('из aitunnel');
  });
});

test('промпт снимает роль «Мила» из инструкций моста', () => {
  expect(kb.SYSTEM_PROMPT).toMatch(/НЕ Мила/);
});
