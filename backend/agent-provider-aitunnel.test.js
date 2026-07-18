'use strict';
const provider = require('./services/agent/providers/aitunnel');

describe('aitunnel.toOpenAITools', () => {
  test('конвертирует Anthropic-схему в OpenAI function-схему', () => {
    const out = provider.toOpenAITools([
      { name: 'get_available_slots', description: 'слоты', input_schema: { type: 'object', properties: {} } },
    ]);
    expect(out).toEqual([{
      type: 'function',
      function: { name: 'get_available_slots', description: 'слоты', parameters: { type: 'object', properties: {} } },
    }]);
  });
});

describe('aitunnel.createMessage', () => {
  test('добавляет system-сообщение, шлёт tools, парсит tool_calls из JSON-аргументов', async () => {
    const calls = [];
    const fakeClient = { chat: { completions: { create: async (p) => {
      calls.push(p);
      return { choices: [{ finish_reason: 'tool_calls', message: {
        role: 'assistant', content: null,
        tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'get_available_slots', arguments: '{"date":"2026-07-20"}' } }],
      } }] };
    } } } };
    const res = await provider.createMessage(
      { system: 'ты админ', messages: [{ role: 'user', content: 'привет' }], tools: [{ name: 'get_available_slots', description: 'd', input_schema: {} }] },
      { client: fakeClient });

    expect(calls[0].messages[0]).toEqual({ role: 'system', content: 'ты админ' });
    expect(calls[0].messages[1]).toEqual({ role: 'user', content: 'привет' });
    expect(calls[0].tools[0].type).toBe('function');
    expect(res.text).toBe('');
    expect(res.stopReason).toBe('tool_calls');
    expect(res.toolCalls).toEqual([{ id: 'call_1', name: 'get_available_slots', input: { date: '2026-07-20' } }]);
    expect(res.assistantMsg.tool_calls[0].id).toBe('call_1');
  });

  test('чистый текст → toolCalls пуст, text заполнен', async () => {
    const fakeClient = { chat: { completions: { create: async () => (
      { choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'Здравствуйте!' } }] }
    ) } } };
    const res = await provider.createMessage(
      { system: 's', messages: [{ role: 'user', content: 'привет' }], tools: [] }, { client: fakeClient });
    expect(res.text).toBe('Здравствуйте!');
    expect(res.toolCalls).toEqual([]);
    expect(res.stopReason).toBe('stop');
  });

  test('битые аргументы tool_call → input = {} без падения', async () => {
    const fakeClient = { chat: { completions: { create: async () => (
      { choices: [{ finish_reason: 'tool_calls', message: { role: 'assistant', content: null,
        tool_calls: [{ id: 'c1', type: 'function', function: { name: 'x', arguments: '{битый' } }] } }] }
    ) } } };
    const res = await provider.createMessage({ system: 's', messages: [], tools: [] }, { client: fakeClient });
    expect(res.toolCalls[0].input).toEqual({});
  });
});

describe('aitunnel.toolResultMessages', () => {
  test('по одному {role:tool} на вызов с tool_call_id', () => {
    const msgs = provider.toolResultMessages([
      { id: 'c1', name: 'get_available_slots', result: { slots: ['10:00'] }, isError: false },
      { id: 'c2', name: 'create_booking', result: { error: 'занято' }, isError: true },
    ]);
    expect(msgs).toEqual([
      { role: 'tool', tool_call_id: 'c1', content: JSON.stringify({ slots: ['10:00'] }) },
      { role: 'tool', tool_call_id: 'c2', content: JSON.stringify({ error: 'занято' }) },
    ]);
  });
});
