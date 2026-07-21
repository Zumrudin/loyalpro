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

// Транзиентный сбой aitunnel (421 «отсутствует поле usage») не должен ронять ход —
// провайдер повторяет вызов. Инцидент 2026-07-21: 421 посреди записи → клиент увидел
// «технический сбой», хотя запись уже создалась.
describe('aitunnel.createMessage — ретрай на транзиентном сбое', () => {
  test('421 на первой попытке → повтор → успех', async () => {
    let n = 0;
    const fakeClient = { chat: { completions: { create: async () => {
      n += 1;
      if (n === 1) { const e = new Error('Не удалось посчитать стоимость запроса, отсутствует поле "usage"'); e.status = 421; throw e; }
      return { choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'Готово ✨' } }] };
    } } } };
    const res = await provider.createMessage(
      { system: 's', messages: [{ role: 'user', content: 'да' }], tools: [] }, { client: fakeClient });
    expect(n).toBe(2);
    expect(res.text).toBe('Готово ✨');
  });

  test('нетранзиентная ошибка (400) не ретраится и пробрасывается', async () => {
    let n = 0;
    const fakeClient = { chat: { completions: { create: async () => {
      n += 1; const e = new Error('bad request'); e.status = 400; throw e;
    } } } };
    await expect(provider.createMessage(
      { system: 's', messages: [], tools: [] }, { client: fakeClient })).rejects.toThrow('bad request');
    expect(n).toBe(1);
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

// Добивочный вызов оркестратора идёт с tools: [] — модель обязана ответить прозой.
// Пустой массив tools API отвергает, поэтому параметр надо опускать целиком.
describe('aitunnel.createMessage без инструментов', () => {
  test('пустой список инструментов → параметр tools не отправляется', async () => {
    const calls = [];
    const fakeClient = { chat: { completions: { create: async (p) => {
      calls.push(p);
      return { choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'Завтра в 16:00.' } }] };
    } } } };

    const res = await provider.createMessage(
      { system: 'ты админ', messages: [{ role: 'user', content: 'когда?' }], tools: [] },
      { client: fakeClient });

    expect(calls[0]).not.toHaveProperty('tools');
    expect(res.text).toBe('Завтра в 16:00.');
    expect(res.toolCalls).toEqual([]);
  });
});
