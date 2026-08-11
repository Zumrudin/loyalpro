'use strict';
const provider = require('./services/agent/providers/polza');

describe('polza.toOpenAITools', () => {
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

describe('polza.createMessage', () => {
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

    // system — content-массивом с cache_control (кэш префикса на anthropic-роуте Polza).
    expect(calls[0].messages[0]).toEqual({
      role: 'system',
      content: [{ type: 'text', text: 'ты админ', cache_control: { type: 'ephemeral' } }],
    });
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

// Транзиентный сбой (429/5xx/сеть) не должен ронять ход — провайдер повторяет вызов.
// Переигровка безопасна: tool_calls на упавшем ответе не исполнялись.
describe('polza.createMessage — ретрай на транзиентном сбое', () => {
  test('529 (overloaded) на первой попытке → повтор → успех', async () => {
    let n = 0;
    const fakeClient = { chat: { completions: { create: async () => {
      n += 1;
      if (n === 1) { const e = new Error('Overloaded'); e.status = 529; throw e; }
      return { choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'Готово ✨' } }] };
    } } } };
    const res = await provider.createMessage(
      { system: 's', messages: [{ role: 'user', content: 'да' }], tools: [] },
      { client: fakeClient, retryBaseMs: 0 });
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

// При персистентном транзиентном сбое основной модели провайдер добивает ТОТ ЖЕ
// запрос через fallback-модель (та же логика, что в aitunnel-провайдере).
describe('polza.createMessage — fallback на другую модель при персистентном сбое', () => {
  test('персистентный 529 на основной модели → добивка через fallback-модель', async () => {
    const calls = [];
    const fakeClient = { chat: { completions: { create: async (p) => {
      calls.push(p.model);
      if (p.model === 'anthropic/claude-sonnet-4.6') {
        const e = new Error('Overloaded'); e.status = 529; throw e;
      }
      return { choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'Готово (Sonnet 5) 🤍' } }] };
    } } } };
    const res = await provider.createMessage(
      { system: 's', messages: [{ role: 'user', content: 'да' }], tools: [] },
      { client: fakeClient, model: 'anthropic/claude-sonnet-4.6',
        fallbackModel: 'anthropic/claude-sonnet-5', maxRetries: 1, retryBaseMs: 0 });
    expect(res.text).toBe('Готово (Sonnet 5) 🤍');
    expect(calls).toContain('anthropic/claude-sonnet-5');
  });

  test('fallback выключен (пустая модель) → транзиентная ошибка пробрасывается', async () => {
    const fakeClient = { chat: { completions: { create: async () => {
      const e = new Error('service unavailable'); e.status = 503; throw e;
    } } } };
    await expect(provider.createMessage(
      { system: 's', messages: [], tools: [] },
      { client: fakeClient, fallbackModel: '', maxRetries: 1, retryBaseMs: 0 }))
      .rejects.toThrow('service unavailable');
  });

  test('нетранзиентная ошибка (400) → fallback НЕ зовётся', async () => {
    const models = [];
    const fakeClient = { chat: { completions: { create: async (p) => {
      models.push(p.model); const e = new Error('bad request'); e.status = 400; throw e;
    } } } };
    await expect(provider.createMessage(
      { system: 's', messages: [], tools: [] },
      { client: fakeClient, model: 'anthropic/claude-sonnet-4.6',
        fallbackModel: 'anthropic/claude-sonnet-5', maxRetries: 1, retryBaseMs: 0 }))
      .rejects.toThrow('bad request');
    expect(models).not.toContain('anthropic/claude-sonnet-5');
  });

  test('основная модель ответила с первой попытки → fallback не трогаем', async () => {
    const models = [];
    const fakeClient = { chat: { completions: { create: async (p) => {
      models.push(p.model);
      return { choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'ок' } }] };
    } } } };
    const res = await provider.createMessage(
      { system: 's', messages: [], tools: [] },
      { client: fakeClient, model: 'anthropic/claude-sonnet-4.6', fallbackModel: 'anthropic/claude-sonnet-5' });
    expect(res.text).toBe('ок');
    expect(models).toEqual(['anthropic/claude-sonnet-4.6']);
  });
});

// Потолок reasoning (2026-08-11): у gemini-2.5-pro «размышления» — 95% output'а
// и ~57% счёта при 54 токенах видимого текста. Ограничение вдвое снизило цену
// и время хода без изменения ответов.
describe('polza.createMessage — потолок reasoning', () => {
  const ok = (calls) => ({ chat: { completions: { create: async (p) => {
    calls.push(p);
    return { choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'ок' } }] };
  } } } });

  test('по умолчанию шлёт reasoning.max_tokens из конфига', async () => {
    const config = require('./config');
    const calls = [];
    await provider.createMessage({ system: 's', messages: [], tools: [] }, { client: ok(calls) });
    expect(calls[0].reasoning).toEqual({ max_tokens: config.POLZA_REASONING_MAX_TOKENS });
  });

  test('явный 0 → параметр не отправляется вовсе (откат к прежнему поведению)', async () => {
    const calls = [];
    await provider.createMessage({ system: 's', messages: [], tools: [] },
      { client: ok(calls), reasoningMaxTokens: 0 });
    expect(calls[0]).not.toHaveProperty('reasoning');
  });

  // Ручку принимают только vertex-роуты Gemini; запасная модель — Anthropic,
  // где бюджет размышлений живёт по своим правилам (на 5.x удалён → 400).
  // Утечка параметра в fallback убила бы его ровно тогда, когда он нужен.
  test('на fallback reasoning НЕ переносится', async () => {
    const calls = [];
    const fakeClient = { chat: { completions: { create: async (p) => {
      calls.push(p);
      if (p.model === 'primary') { const e = new Error('overloaded'); e.status = 529; throw e; }
      return { choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'ок' } }] };
    } } } };
    const res = await provider.createMessage(
      { system: 's', messages: [], tools: [] },
      { client: fakeClient, model: 'primary', fallbackModel: 'anthropic/claude-sonnet-5',
        maxRetries: 0, retryBaseMs: 0, reasoningMaxTokens: 512 });
    expect(res.text).toBe('ок');
    const primary = calls.filter(c => c.model === 'primary');
    const fb = calls.filter(c => c.model === 'anthropic/claude-sonnet-5');
    expect(primary[0].reasoning).toEqual({ max_tokens: 512 });
    expect(fb).toHaveLength(1);
    expect(fb[0]).not.toHaveProperty('reasoning');
    // Остальное тело запроса на fallback обязано сохраниться.
    expect(fb[0].messages).toEqual(primary[0].messages);
  });
});

describe('polza.toolResultMessages', () => {
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
describe('polza.createMessage без инструментов', () => {
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
