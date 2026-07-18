# Перевод ИИ-путей на aitunnel.ru (Gemini 3.1 Flash Lite) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Перевести диалоговый агент chatpush и базу знаний (чат + эмбеддинги) на aitunnel.ru (OpenAI-совместимый API, Gemini 3.1 Flash Lite), сохранив откат к Anthropic/Gemini-релею через env.

**Architecture:** Ввести слой абстракции провайдера для агента (`services/agent/providers/{index,anthropic,aitunnel}.js`), полностью прячущий формат провода; оркестратор становится провайдер-агностиком. KB-ассистент получает ветку aitunnel для чата и эмбеддингов по env `KB_PROVIDER`. Общий OpenAI-SDK клиент — `services/aitunnel.js`. Разовый скрипт переэмбеддинга базы знаний.

**Tech Stack:** Node.js, Express, `openai` npm SDK, `@anthropic-ai/sdk` (остаётся для отката), PostgreSQL (`pg`), Jest.

**Спека:** `docs/superpowers/specs/2026-07-18-aitunnel-gemini-migration-design.md`

---

## File Structure

- **Create** `backend/services/aitunnel.js` — фабрика OpenAI-SDK клиента к api.aitunnel.ru (агент + KB + эмбеддинги).
- **Create** `backend/services/agent/providers/anthropic.js` — Anthropic-адаптер (перенос логики `claude.js`).
- **Create** `backend/services/agent/providers/aitunnel.js` — OpenAI-адаптер (Gemini через aitunnel).
- **Create** `backend/services/agent/providers/index.js` — выбор провайдера по `config.AGENT_PROVIDER`.
- **Delete** `backend/services/agent/claude.js` — заменён провайдерами.
- **Modify** `backend/services/agent/orchestrator.js` — провайдер-агностик.
- **Modify** `backend/config.js:63-69` — env `AITUNNEL_*`, `AGENT_PROVIDER`, `KB_PROVIDER`.
- **Modify** `backend/services/kb-assistant.js` — ветка aitunnel в `callGemini`/`embedText` + гард `ask`.
- **Create** `backend/scripts/reembed-kb.js` — разовый переэмбеддинг всех чанков.
- **Modify** `backend/package.json` — зависимость `openai`.
- **Tests:** `backend/aitunnel-client.test.js`, `backend/agent-provider-aitunnel.test.js`, `backend/agent-provider-anthropic.test.js` (перенос из `agent-claude.test.js`), `backend/agent-orchestrator.test.js` (адаптация), `backend/kb-assistant-aitunnel.test.js`.

**Тест-раннер:** `npx jest <pattern>` из `backend/` (jest 30 установлен; `npm test` запускает только clients-api).

---

## Task 1: Зависимость openai + config + общий клиент

**Files:**
- Modify: `backend/package.json`
- Modify: `backend/config.js:63-69`
- Create: `backend/services/aitunnel.js`
- Test: `backend/aitunnel-client.test.js`

- [ ] **Step 1: Установить openai SDK**

Run: `cd backend && npm install openai@^4`
Expected: `package.json` получает `"openai": "^4.x"` в dependencies, установка без ошибок.

- [ ] **Step 2: Добавить env в config.js**

В `backend/config.js` после блока `AGENT_DEBOUNCE_MS` (строка 69), внутри того же объекта, добавить:

```js
  // ── aitunnel.ru — OpenAI-совместимый агрегатор (обход геоблока, оплата ₽). ──
  // Единая точка для агента (Gemini 3.1 Flash Lite) и базы знаний (чат + эмбеддинги).
  AITUNNEL_API_KEY:     process.env.AITUNNEL_API_KEY     || '',
  AITUNNEL_BASE:        process.env.AITUNNEL_BASE        || 'https://api.aitunnel.ru/v1',
  AITUNNEL_CHAT_MODEL:  process.env.AITUNNEL_CHAT_MODEL  || 'gemini-3.1-flash-lite',
  AITUNNEL_EMBED_MODEL: process.env.AITUNNEL_EMBED_MODEL || 'gemini-embedding-001',
  AITUNNEL_EMBED_DIM:   process.env.AITUNNEL_EMBED_DIM ? parseInt(process.env.AITUNNEL_EMBED_DIM, 10) : 3072,
  // Провайдер диалогового агента: 'aitunnel' (Gemini) | 'anthropic' (Claude, откат).
  AGENT_PROVIDER:       process.env.AGENT_PROVIDER       || 'aitunnel',
  // Провайдер базы знаний: 'aitunnel' | 'gemini' (старый релей/прямой вызов, откат).
  KB_PROVIDER:          process.env.KB_PROVIDER          || 'aitunnel',
```

- [ ] **Step 3: Написать падающий тест клиента**

Создать `backend/aitunnel-client.test.js`:

```js
'use strict';
const aitunnel = require('./services/aitunnel');

describe('aitunnel.makeClient', () => {
  test('создаёт OpenAI-клиент с baseURL aitunnel и переданным ключом', () => {
    const c = aitunnel.makeClient('sk-aitunnel-test');
    expect(c.baseURL).toContain('api.aitunnel.ru/v1');
    expect(c.apiKey).toBe('sk-aitunnel-test');
  });

  test('без аргумента берёт ключ из config (пустой в тестах, но клиент создаётся)', () => {
    const c = aitunnel.makeClient();
    expect(c.baseURL).toContain('api.aitunnel.ru/v1');
  });
});
```

- [ ] **Step 4: Запустить тест — убедиться, что падает**

Run: `cd backend && npx jest aitunnel-client -c '{}' 2>/dev/null || npx jest aitunnel-client`
Expected: FAIL — `Cannot find module './services/aitunnel'`.

- [ ] **Step 5: Реализовать клиент**

Создать `backend/services/aitunnel.js`:

```js
'use strict';

const OpenAI = require('openai');
const config = require('../config');

// ── Общий OpenAI-совместимый клиент к aitunnel.ru ──────────────
// Используется агентом (services/agent/providers/aitunnel.js) и базой знаний.
// baseURL/ключ из config; apiKey можно переопределить (тесты/мультиаккаунт).
function makeClient(apiKey) {
  return new OpenAI({
    apiKey: apiKey || config.AITUNNEL_API_KEY || 'missing',
    baseURL: config.AITUNNEL_BASE,
  });
}

module.exports = { makeClient };
```

Примечание: `|| 'missing'` — OpenAI SDK бросает при пустом ключе в конструкторе; заглушка позволяет создать клиент в тестах без реального ключа (реальный вызов всё равно упадёт 401, что корректно).

- [ ] **Step 6: Запустить тест — убедиться, что проходит**

Run: `cd backend && npx jest aitunnel-client`
Expected: PASS (2 теста).

- [ ] **Step 7: Commit**

```bash
cd backend && git add package.json package-lock.json config.js services/aitunnel.js aitunnel-client.test.js
git commit -m "feat(agent): общий OpenAI-клиент aitunnel + config-переключатели провайдеров"
```

---

## Task 2: Anthropic-провайдер (перенос claude.js под новый интерфейс)

**Files:**
- Create: `backend/services/agent/providers/anthropic.js`
- Test: `backend/agent-provider-anthropic.test.js`

Новый интерфейс провайдера (реализуют оба адаптера):
- `createMessage({ system, messages, tools }, opts)` → `{ text, toolCalls:[{id,name,input}], stopReason, assistantMsg }`
- `toolResultMessages(results)` → `[ ...provider-native msgs ]`, где `results = [{ id, name, result, isError }]`

- [ ] **Step 1: Написать падающий тест**

Создать `backend/agent-provider-anthropic.test.js`:

```js
'use strict';
const anthropic = require('./services/agent/providers/anthropic');

describe('anthropic.createMessage (нормализация)', () => {
  test('зовёт SDK с system/tools/thinking и нормализует ответ в text+toolCalls', async () => {
    const calls = [];
    const fakeClient = { messages: { create: async (p) => {
      calls.push(p);
      return { stop_reason: 'tool_use', content: [
        { type: 'text', text: 'Секунду.' },
        { type: 'tool_use', id: 'tu_1', name: 'get_available_slots', input: { date: '2026-07-20' } },
      ] };
    } } };
    const res = await anthropic.createMessage(
      { system: 'ты админ', messages: [{ role: 'user', content: 'привет' }], tools: [{ name: 't', input_schema: {} }] },
      { client: fakeClient, model: 'claude-opus-4-8', maxTokens: 1024 });

    expect(calls[0].model).toBe('claude-opus-4-8');
    expect(calls[0].system).toBe('ты админ');
    expect(calls[0].thinking).toEqual({ type: 'adaptive' });
    expect(calls[0].tools).toEqual([{ name: 't', input_schema: {} }]);
    expect(res.text).toBe('Секунду.');
    expect(res.stopReason).toBe('tool_use');
    expect(res.toolCalls).toEqual([{ id: 'tu_1', name: 'get_available_slots', input: { date: '2026-07-20' } }]);
    expect(res.assistantMsg).toEqual({ role: 'assistant', content: [
      { type: 'text', text: 'Секунду.' },
      { type: 'tool_use', id: 'tu_1', name: 'get_available_slots', input: { date: '2026-07-20' } },
    ] });
  });
});

describe('anthropic.toolResultMessages', () => {
  test('один user-turn с tool_result-блоками, is_error по флагу', () => {
    const msgs = anthropic.toolResultMessages([
      { id: 'tu_1', name: 'get_available_slots', result: { slots: ['10:00'] }, isError: false },
      { id: 'tu_2', name: 'create_booking', result: { error: 'занято' }, isError: true },
    ]);
    expect(msgs).toHaveLength(1);
    expect(msgs[0].role).toBe('user');
    expect(msgs[0].content[0]).toEqual({ type: 'tool_result', tool_use_id: 'tu_1', content: JSON.stringify({ slots: ['10:00'] }) });
    expect(msgs[0].content[1].is_error).toBe(true);
  });
});
```

- [ ] **Step 2: Запустить тест — убедиться, что падает**

Run: `cd backend && npx jest agent-provider-anthropic`
Expected: FAIL — `Cannot find module './services/agent/providers/anthropic'`.

- [ ] **Step 3: Реализовать провайдер**

Создать `backend/services/agent/providers/anthropic.js`:

```js
'use strict';

const Anthropic = require('@anthropic-ai/sdk');
const config = require('../../../config');

// ── Anthropic-адаптер (Claude tool-calling). Откат: AGENT_PROVIDER=anthropic. ──
function makeClient(apiKey) {
  return new Anthropic({ apiKey: apiKey || config.ANTHROPIC_API_KEY });
}

// Вызов Claude + нормализация ответа в провайдер-агностичный вид.
async function createMessage({ system, messages, tools }, opts = {}) {
  const client = opts.client || makeClient(opts.apiKey);
  const msg = await client.messages.create({
    model: opts.model || config.AGENT_LLM_MODEL,
    max_tokens: opts.maxTokens || config.AGENT_MAX_TOKENS,
    thinking: { type: 'adaptive' },
    system,
    tools,
    messages,
  });
  const blocks = (msg && msg.content) || [];
  const text = blocks.filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
  const toolCalls = blocks
    .filter(b => b.type === 'tool_use')
    .map(b => ({ id: b.id, name: b.name, input: b.input }));
  return { text, toolCalls, stopReason: msg && msg.stop_reason, assistantMsg: { role: 'assistant', content: msg.content } };
}

// Результаты инструментов → один user-turn с tool_result-блоками (формат Anthropic).
function toolResultMessages(results) {
  return [{
    role: 'user',
    content: results.map(r => {
      const block = { type: 'tool_result', tool_use_id: r.id, content: JSON.stringify(r.result) };
      if (r.isError) block.is_error = true;
      return block;
    }),
  }];
}

module.exports = { makeClient, createMessage, toolResultMessages };
```

- [ ] **Step 4: Запустить тест — убедиться, что проходит**

Run: `cd backend && npx jest agent-provider-anthropic`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd backend && git add services/agent/providers/anthropic.js agent-provider-anthropic.test.js
git commit -m "feat(agent): anthropic-провайдер под провайдер-агностичный интерфейс"
```

---

## Task 3: aitunnel-провайдер (Gemini через OpenAI-формат)

**Files:**
- Create: `backend/services/agent/providers/aitunnel.js`
- Test: `backend/agent-provider-aitunnel.test.js`

- [ ] **Step 1: Написать падающий тест**

Создать `backend/agent-provider-aitunnel.test.js`:

```js
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
```

- [ ] **Step 2: Запустить тест — убедиться, что падает**

Run: `cd backend && npx jest agent-provider-aitunnel`
Expected: FAIL — `Cannot find module './services/agent/providers/aitunnel'`.

- [ ] **Step 3: Реализовать провайдер**

Создать `backend/services/agent/providers/aitunnel.js`:

```js
'use strict';

const aitunnel = require('../../aitunnel');
const config = require('../../../config');

// ── aitunnel-адаптер: Gemini 3.1 Flash Lite через OpenAI-совместимый API. ──

// Anthropic-схема инструмента → OpenAI function-схема.
function toOpenAITools(schemas) {
  return (schemas || []).map(s => ({
    type: 'function',
    function: { name: s.name, description: s.description, parameters: s.input_schema },
  }));
}

function safeParse(s) {
  try { return JSON.parse(s || '{}'); } catch (_) { return {}; }
}

// Вызов chat.completions + нормализация ответа в провайдер-агностичный вид.
async function createMessage({ system, messages, tools }, opts = {}) {
  const client = opts.client || aitunnel.makeClient(opts.apiKey);
  const msgs = system ? [{ role: 'system', content: system }, ...messages] : messages.slice();
  const resp = await client.chat.completions.create({
    model: opts.model || config.AITUNNEL_CHAT_MODEL,
    max_tokens: opts.maxTokens || config.AGENT_MAX_TOKENS,
    messages: msgs,
    tools: toOpenAITools(tools),
  });
  const choice = (resp.choices && resp.choices[0]) || {};
  const m = choice.message || {};
  const text = (m.content || '').trim();
  const toolCalls = (m.tool_calls || []).map(tc => ({
    id: tc.id, name: tc.function.name, input: safeParse(tc.function.arguments),
  }));
  return { text, toolCalls, stopReason: choice.finish_reason, assistantMsg: m };
}

// Результаты инструментов → по одному {role:'tool'} на вызов (формат OpenAI).
function toolResultMessages(results) {
  return results.map(r => ({ role: 'tool', tool_call_id: r.id, content: JSON.stringify(r.result) }));
}

module.exports = { createMessage, toolResultMessages, toOpenAITools };
```

- [ ] **Step 4: Запустить тест — убедиться, что проходит**

Run: `cd backend && npx jest agent-provider-aitunnel`
Expected: PASS (5 тестов).

- [ ] **Step 5: Создать селектор провайдера**

Создать `backend/services/agent/providers/index.js`:

```js
'use strict';

const config = require('../../../config');
const anthropic = require('./anthropic');
const aitunnel = require('./aitunnel');

// Выбор провайдера по env. default — aitunnel (Gemini). 'anthropic' — откат к Claude.
function getProvider(name) {
  const p = name || config.AGENT_PROVIDER;
  if (p === 'anthropic') return anthropic;
  return aitunnel;
}

module.exports = { getProvider, anthropic, aitunnel };
```

- [ ] **Step 6: Commit**

```bash
cd backend && git add services/agent/providers/aitunnel.js services/agent/providers/index.js agent-provider-aitunnel.test.js
git commit -m "feat(agent): aitunnel-провайдер (Gemini, OpenAI-формат) + селектор по env"
```

---

## Task 4: Рефактор оркестратора на провайдер-агностик + адаптация тестов

**Files:**
- Modify: `backend/services/agent/orchestrator.js:1-98`
- Delete: `backend/services/agent/claude.js`
- Modify: `backend/agent-orchestrator.test.js`
- Delete: `backend/agent-claude.test.js` (перенесён в agent-provider-anthropic.test.js в Task 2)

- [ ] **Step 1: Переписать тест оркестратора под новый интерфейс**

Заменить `backend/agent-orchestrator.test.js` целиком на:

```js
'use strict';

// Оркестратор провайдер-агностичен: мокаем provider.createMessage, реальный
// toolResultMessages берём из aitunnel-провайдера (формат {role:'tool'}).
const realProvider = require('./services/agent/providers/aitunnel');
const orchestrator = require('./services/agent/orchestrator');

function makeDeps(overrides = {}) {
  return {
    provider: {
      createMessage: jest.fn(),
      toolResultMessages: realProvider.toolResultMessages,
      ...overrides.provider,
    },
    registry: {
      schemas: [{ name: 'get_available_slots' }, { name: 'escalate_to_operator' }, { name: 'create_booking' }],
      handlers: {
        get_available_slots: jest.fn(async () => ({ slots: [{ time: '10:00' }] })),
        escalate_to_operator: jest.fn(async () => ({ escalated: true, reason: 'жалоба' })),
        create_booking: jest.fn(async () => ({ created: true, record_id: 999 })),
        ...(overrides.handlers || {}),
      },
    },
    history: {
      loadTranscript: jest.fn(async () => ({ messages: [{ role: 'user', content: 'привет' }], watermark: 100 })),
      hasIncomingAfter: jest.fn(async () => false),
      ...overrides.history,
    },
    state: {
      getOrCreate: jest.fn(async () => ({ status: 'bot' })),
      setWatermark: jest.fn(async () => {}),
      ...overrides.state,
    },
  };
}

// Нормализованные ответы провайдера (не сырой формат SDK).
const textResp = (t) => ({ text: t, toolCalls: [], stopReason: 'stop', assistantMsg: { role: 'assistant', content: t } });
const toolResp = (name, input, id = 'c1', text = '') => ({
  text,
  toolCalls: [{ id, name, input }],
  stopReason: 'tool_calls',
  assistantMsg: { role: 'assistant', content: text || null,
    tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(input) } }] },
});

describe('runDialog', () => {
  test('только текст → возвращает реплику, инструменты не звались', async () => {
    const deps = makeDeps();
    deps.provider.createMessage.mockResolvedValueOnce(textResp('Здравствуйте! Чем помочь?'));
    const out = await orchestrator.runDialog(1, 'k', { deps, today: '2026-07-18' });
    expect(out.replies).toEqual(['Здравствуйте! Чем помочь?']);
    expect(out.escalated).toBe(false);
    expect(out.sideEffect).toBe(false);
    expect(deps.provider.createMessage).toHaveBeenCalledTimes(1);
    expect(deps.state.setWatermark).toHaveBeenCalledWith(1, 'k', 100);
  });

  test('tool_call → выполняет инструмент с ctx.dialogKey, скармливает результат, финализирует', async () => {
    const deps = makeDeps();
    deps.provider.createMessage
      .mockResolvedValueOnce(toolResp('get_available_slots', { staff_yc_id: 55, service_yc_id: 7, date: '2026-07-20' }))
      .mockResolvedValueOnce(textResp('Свободно 10:00. Записать?'));
    const out = await orchestrator.runDialog(1, 'k', { deps, ctx: { phone: '79001112233' } });
    expect(deps.registry.handlers.get_available_slots)
      .toHaveBeenCalledWith(1, { staff_yc_id: 55, service_yc_id: 7, date: '2026-07-20' }, { dialogKey: 'k', clientPhone: '79001112233' });
    expect(out.replies).toContain('Свободно 10:00. Записать?');
    expect(out.sideEffect).toBe(false);
    // второй вызов провайдера получил tool-результат (формат {role:'tool'})
    const secondCallMessages = deps.provider.createMessage.mock.calls[1][0].messages;
    const toolTurn = secondCallMessages[secondCallMessages.length - 1];
    expect(toolTurn.role).toBe('tool');
    expect(toolTurn.tool_call_id).toBe('c1');
  });

  test('escalate_to_operator → escalated:true и цикл останавливается', async () => {
    const deps = makeDeps();
    deps.provider.createMessage.mockResolvedValueOnce(toolResp('escalate_to_operator', { reason: 'жалоба' }));
    const out = await orchestrator.runDialog(1, 'k', { deps });
    expect(out.escalated).toBe(true);
    expect(out.sideEffect).toBe(true);
    expect(deps.provider.createMessage).toHaveBeenCalledTimes(1);
  });

  test('диалог уже escalated → ничего не делаем', async () => {
    const deps = makeDeps({ state: { getOrCreate: jest.fn(async () => ({ status: 'escalated' })) } });
    const out = await orchestrator.runDialog(1, 'k', { deps });
    expect(out.escalated).toBe(true);
    expect(deps.provider.createMessage).not.toHaveBeenCalled();
  });

  test('новое входящее во время прогона без side-effect → черновик выброшен, перегенерация', async () => {
    let calls = 0;
    const deps = makeDeps({ history: { hasIncomingAfter: jest.fn(async () => (++calls === 1)) } });
    deps.provider.createMessage
      .mockResolvedValueOnce(textResp('ответ про маникюр'))
      .mockResolvedValueOnce(textResp('ответ про педикюр'));
    const out = await orchestrator.runDialog(1, 'k', { deps });
    expect(out.replies).toEqual(['ответ про педикюр']);
    expect(deps.history.loadTranscript).toHaveBeenCalledTimes(2);
  });

  test('защитный лимит итераций: бесконечный tool_call не зацикливается', async () => {
    const deps = makeDeps();
    deps.provider.createMessage.mockResolvedValue(
      toolResp('get_available_slots', { staff_yc_id: 1, service_yc_id: 1, date: '2026-07-20' }));
    await orchestrator.runDialog(1, 'k', { deps });
    expect(deps.provider.createMessage).toHaveBeenCalledTimes(orchestrator.MAX_ITERS);
  });
});
```

- [ ] **Step 2: Запустить тест — убедиться, что падает**

Run: `cd backend && npx jest agent-orchestrator`
Expected: FAIL — оркестратор всё ещё зовёт `claude.createMessage`/`splitContent`, мок `provider` не используется (реплики пустые / TypeError).

- [ ] **Step 3: Переписать оркестратор**

Заменить в `backend/services/agent/orchestrator.js` шапку импортов (строки 3-9) и тело цикла. Полностью новый файл:

```js
'use strict';

const providers = require('./providers');
const registryDefault = require('./tools');
const historyDefault = require('./history');
const stateDefault = require('./dialog-state');
const { buildSystemPrompt } = require('./system-prompt');
const { createLogger } = require('../../logger');
const logger = createLogger('AgentOrchestrator');

const MAX_ITERS = 6;   // защитный лимит tool-use итераций на один ход
const MAX_REGEN = 2;   // сколько раз перегенерировать при новом входящем во время прогона

// Пишущие инструменты: их результат нельзя «выбросить» перегенерацией.
const SIDE_EFFECT_TOOLS = new Set(['create_booking', 'escalate_to_operator']);

// YYYY-MM-DD по Москве (для системного промпта «сегодня …»).
function todayMoscow() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Moscow' }).format(new Date());
}

// Прогнать один ход диалога. Возвращает { replies, escalated, sideEffect }.
async function runDialog(salonId, dialogKey, opts = {}) {
  const d = opts.deps || {};
  const provider = d.provider || providers.getProvider();
  const registry = d.registry || registryDefault;
  const history = d.history || historyDefault;
  const state = d.state || stateDefault;
  const ctx = opts.ctx || {};

  const dialog = await state.getOrCreate(salonId, dialogKey);
  if (dialog.status === 'escalated') {
    return { replies: [], escalated: true, sideEffect: false };
  }

  const system = buildSystemPrompt({
    salonName: opts.salonName,
    workingHours: opts.workingHours,
    today: opts.today || todayMoscow(),
  });
  const toolCtx = { dialogKey, clientPhone: ctx.phone };

  for (let attempt = 0; attempt <= MAX_REGEN; attempt++) {
    const { messages, watermark } = await history.loadTranscript(salonId, dialogKey, { limit: 20 });
    if (!messages.length) return { replies: [], escalated: false, sideEffect: false };

    const convo = messages.slice();
    const replies = [];
    let escalated = false;
    let sideEffect = false;

    for (let i = 0; i < MAX_ITERS; i++) {
      const resp = await provider.createMessage(
        { system, messages: convo.slice(), tools: registry.schemas },
        { client: opts.client });

      convo.push(resp.assistantMsg);
      if (resp.text) replies.push(resp.text);

      if (!resp.toolCalls.length) break;

      const results = [];
      for (const tc of resp.toolCalls) {
        const handler = registry.handlers[tc.name];
        let result;
        try {
          result = handler
            ? await handler(salonId, tc.input, toolCtx)
            : { error: `Неизвестный инструмент: ${tc.name}` };
        } catch (e) {
          logger.error(`tool ${tc.name} failed: ${e.message}`);
          result = { error: e.message };
        }
        const isError = !!(result && result.error);
        if (!isError && SIDE_EFFECT_TOOLS.has(tc.name)) sideEffect = true;
        if (tc.name === 'escalate_to_operator' && result && result.escalated) escalated = true;
        results.push({ id: tc.id, name: tc.name, result, isError });
      }
      for (const m of provider.toolResultMessages(results)) convo.push(m);
      if (escalated) break;
    }

    // Пришло ли новое входящее, пока мы думали?
    const stale = await history.hasIncomingAfter(salonId, dialogKey, watermark);
    if (stale && !sideEffect && attempt < MAX_REGEN) {
      logger.info(`dialog ${dialogKey}: новое сообщение во время прогона — выбрасываю черновик, перегенерация (${attempt + 1})`);
      continue;
    }

    await state.setWatermark(salonId, dialogKey, watermark);
    return { replies, escalated, sideEffect };
  }

  return { replies: [], escalated: false, sideEffect: false };
}

module.exports = { runDialog, todayMoscow, MAX_ITERS, MAX_REGEN };
```

- [ ] **Step 4: Удалить старые файлы claude**

Run: `cd backend && git rm services/agent/claude.js agent-claude.test.js`
Expected: файлы удалены (логика перенесена в providers/anthropic.js + agent-provider-anthropic.test.js).

- [ ] **Step 5: Запустить тест оркестратора — убедиться, что проходит**

Run: `cd backend && npx jest agent-orchestrator`
Expected: PASS (6 тестов).

- [ ] **Step 6: Прогнать все тесты агента — регрессия**

Run: `cd backend && npx jest agent-`
Expected: PASS во всех `agent-*.test.js` (booking, dialog-state, dispatcher, gate, history, orchestrator, provider-anthropic, provider-aitunnel, rag, rag-io, system-prompt, tools). Ни одной ссылки на удалённый `claude`.

- [ ] **Step 7: Commit**

```bash
cd backend && git add services/agent/orchestrator.js agent-orchestrator.test.js
git commit -m "refactor(agent): оркестратор провайдер-агностичен, claude.js → providers/"
```

---

## Task 5: KB-ассистент — ветка aitunnel (чат + эмбеддинги)

**Files:**
- Modify: `backend/services/kb-assistant.js:98-154, 245-252, 308-324, 326-333`
- Test: `backend/kb-assistant-aitunnel.test.js`

- [ ] **Step 1: Написать падающий тест**

Создать `backend/kb-assistant-aitunnel.test.js`:

```js
'use strict';
const kb = require('./services/kb-assistant');

describe('callAitunnel', () => {
  test('шлёт system+user, возвращает content из choices[0]', async () => {
    const calls = [];
    const fakeClient = { chat: { completions: { create: async (p) => {
      calls.push(p);
      return { choices: [{ message: { content: '  Ответ из базы.  ' } }] };
    } } } };
    const out = await kb.callAitunnel({ system: 'S', user: 'U' }, { client: fakeClient });
    expect(out).toBe('Ответ из базы.');
    expect(calls[0].messages).toEqual([{ role: 'system', content: 'S' }, { role: 'user', content: 'U' }]);
    expect(calls[0].temperature).toBe(0.2);
  });
});

describe('embedTextAitunnel', () => {
  test('возвращает вектор из data[0].embedding, шлёт dimensions', async () => {
    const calls = [];
    const fakeClient = { embeddings: { create: async (p) => {
      calls.push(p);
      return { data: [{ embedding: [0.1, 0.2, 0.3] }] };
    } } };
    const vec = await kb.embedTextAitunnel('текст', { client: fakeClient });
    expect(vec).toEqual([0.1, 0.2, 0.3]);
    expect(calls[0].input).toBe('текст');
    expect(typeof calls[0].dimensions).toBe('number');
  });

  test('пустой ответ → бросает', async () => {
    const fakeClient = { embeddings: { create: async () => ({ data: [] }) } };
    await expect(kb.embedTextAitunnel('x', { client: fakeClient })).rejects.toThrow(/пустой ответ/);
  });
});
```

- [ ] **Step 2: Запустить тест — убедиться, что падает**

Run: `cd backend && npx jest kb-assistant-aitunnel`
Expected: FAIL — `kb.callAitunnel is not a function`.

- [ ] **Step 3: Добавить функции aitunnel и переключатель в kb-assistant.js**

В `backend/services/kb-assistant.js` добавить импорт под строкой 4 (`const config = require('../config');`):

```js
const aitunnel = require('./aitunnel');
```

Добавить перед `callGemini` (строка 148) две функции:

```js
// ── aitunnel-ветка (OpenAI-совместимый Gemini) ────────────────
// Чат: system+user → chat.completions. client переопределяется в тестах.
async function callAitunnel(prompt, opts = {}) {
  const client = opts.client || aitunnel.makeClient();
  const resp = await client.chat.completions.create({
    model: config.AITUNNEL_CHAT_MODEL,
    temperature: 0.2,
    max_tokens: 800,
    messages: [
      { role: 'system', content: prompt.system },
      { role: 'user', content: prompt.user },
    ],
  });
  const content = resp && resp.choices && resp.choices[0] && resp.choices[0].message
    && resp.choices[0].message.content;
  return (content || '').trim();
}

// Эмбеддинг через aitunnel /v1/embeddings с фиксированной размерностью.
async function embedTextAitunnel(text, opts = {}) {
  const client = opts.client || aitunnel.makeClient();
  const resp = await client.embeddings.create({
    model: config.AITUNNEL_EMBED_MODEL,
    input: text,
    dimensions: config.AITUNNEL_EMBED_DIM,
  });
  const emb = resp && resp.data && resp.data[0] && resp.data[0].embedding;
  if (!Array.isArray(emb)) throw new Error('aitunnel embed: пустой ответ');
  return emb;
}
```

Заменить диспетчер `callGemini` (строки 149-154) на:

```js
async function callGemini(prompt, opts) {
  if (config.KB_PROVIDER === 'aitunnel') return callAitunnel(prompt, opts);
  if (config.KB_GEMINI_RELAY_URL) {
    return callViaRelay(prompt, { fetchFn: (opts && opts.fetchFn) || fetch });
  }
  return callGeminiDirect(prompt, opts);
}
```

Заменить диспетчер `embedText` (строки 309-324) на:

```js
async function embedText(text, opts) {
  if (config.KB_PROVIDER === 'aitunnel') return embedTextAitunnel(text, opts);
  const model = (opts && opts.model) || config.KB_EMBED_MODEL;
  const fetchFn = (opts && opts.fetchFn) || fetch;
  if (config.KB_GEMINI_RELAY_URL) {
    return embedTextViaRelay(text, {
      url: config.KB_GEMINI_RELAY_URL + '/embed',
      secret: config.KB_GEMINI_RELAY_SECRET,
      fetchFn,
    });
  }
  return embedTextDirect(text, {
    free: config.KB_GEMINI_KEY_FREE,
    paid: config.KB_GEMINI_KEY_PAID,
    model, fetchFn,
  });
}
```

Обновить гард в `ask` (строки 246-251) — для aitunnel проверяем свой ключ:

```js
async function ask(salonId, userId, question) {
  const free  = config.KB_GEMINI_KEY_FREE;
  const paid  = config.KB_GEMINI_KEY_PAID;
  const model = config.KB_LLM_MODEL;
  if (config.KB_PROVIDER === 'aitunnel') {
    if (!config.AITUNNEL_API_KEY) {
      const e = new Error('Ассистент не настроен'); e.code = 'NOT_CONFIGURED'; throw e;
    }
  } else if (!free && !paid) {
    const e = new Error('Ассистент не настроен'); e.code = 'NOT_CONFIGURED'; throw e;
  }
```

Добавить `callAitunnel, embedTextAitunnel` в `module.exports` (строки 326-332):

```js
module.exports = {
  CONTEXT_CHAR_BUDGET, SYSTEM_PROMPT, REQUEST_TIMEOUT_MS,
  buildContext, buildPrompt, parseGeminiResponse,
  callGeminiOnce, callGemini, callGeminiDirect, callViaRelay, callAitunnel,
  retrieveArticles, logChat, ask,
  embedContentOnce, embedTextDirect, embedTextViaRelay, embedText, embedTextAitunnel,
};
```

- [ ] **Step 4: Запустить тест — убедиться, что проходит**

Run: `cd backend && npx jest kb-assistant-aitunnel`
Expected: PASS (3 теста).

- [ ] **Step 5: Регрессия KB/RAG-тестов**

Run: `cd backend && npx jest agent-rag kb-`
Expected: PASS (существующие rag/rag-io тесты не сломаны — они мокают `embedText` на уровне зависимостей либо не зовут сеть; если какой-то тест дергает реальный `embedText`, он должен инъектировать client/fetchFn — проверить, что провайдер по умолчанию не ломает мок).

- [ ] **Step 6: Commit**

```bash
cd backend && git add services/kb-assistant.js kb-assistant-aitunnel.test.js
git commit -m "feat(kb): ветка aitunnel для чата и эмбеддингов базы знаний (KB_PROVIDER)"
```

---

## Task 6: Скрипт переэмбеддинга базы знаний + runbook

**Files:**
- Create: `backend/scripts/reembed-kb.js`
- Modify: `docs/superpowers/specs/2026-07-18-aitunnel-gemini-migration-design.md` (добавить runbook в конец — опционально)

Причина отдельного скрипта: `agent-rag.reembedArticle` пропускает чанки с неизменённым `content_hash`, а при смене модели контент не меняется → нужен безусловный проход по всем чанкам.

- [ ] **Step 1: Написать скрипт**

Создать `backend/scripts/reembed-kb.js`:

```js
'use strict';

// Разовый переэмбеддинг ВСЕЙ базы знаний новой моделью (смена провайдера).
// content_hash не меняется при смене модели → reembedArticle пропустил бы чанки,
// поэтому идём напрямую по kb_chunks и пересчитываем безусловно.
//
// Запуск (после деплоя кода и установки env):
//   KB_PROVIDER=aitunnel AITUNNEL_API_KEY=sk-aitunnel-... node scripts/reembed-kb.js

const { db } = require('../db');
const kbAssistant = require('../services/kb-assistant');
const { vectorNorm } = require('../services/agent-rag');
const config = require('../config');

async function main() {
  if (config.KB_PROVIDER !== 'aitunnel') {
    console.warn(`ВНИМАНИЕ: KB_PROVIDER=${config.KB_PROVIDER} (не aitunnel). Переэмбеддинг пойдёт текущим провайдером.`);
  }
  const rows = await db.any(`SELECT id, content FROM kb_chunks ORDER BY id`);
  console.log(`Переэмбеддинг ${rows.length} чанков моделью ${config.AITUNNEL_EMBED_MODEL} (dim ${config.AITUNNEL_EMBED_DIM})...`);

  let done = 0, failed = 0;
  for (const r of rows) {
    try {
      const emb = await kbAssistant.embedText(r.content);
      const norm = vectorNorm(emb);
      await db.query(
        `UPDATE kb_chunks SET embedding=$1, embed_norm=$2, updated_at=now() WHERE id=$3`,
        [emb, norm, r.id]);
      done++;
      if (done % 25 === 0) console.log(`  прогресс: ${done}/${rows.length}`);
    } catch (e) {
      failed++;
      console.error(`  чанк ${r.id} провалился: ${e.message}`);
    }
  }
  console.log(`Готово: ${done} успешно, ${failed} с ошибкой из ${rows.length}.`);
  await db.$pool?.end?.();
  process.exit(failed ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
```

Примечание: `db.$pool.end()` может отсутствовать в обёртке — потому вызов защищён `?.`. Если процесс висит после завершения, добавить `pool.end()` вручную по фактическому API `db.js`.

- [ ] **Step 2: Проверить синтаксис скрипта (без сети)**

Run: `cd backend && node -c scripts/reembed-kb.js && echo OK`
Expected: `OK` (файл парсится; реальный прогон требует БД и AITUNNEL_API_KEY — выполняется вручную при выкате).

- [ ] **Step 3: Commit**

```bash
cd backend && git add scripts/reembed-kb.js
git commit -m "chore(kb): скрипт разового переэмбеддинга базы знаний под новую модель"
```

---

## Task 7: Полная регрессия + проверка отсутствия висящих ссылок

**Files:** (проверка, без изменений кода)

- [ ] **Step 1: Прогнать все backend-тесты**

Run: `cd backend && npx jest`
Expected: PASS во всех сьютах. Ни одного `Cannot find module '.../claude'`.

- [ ] **Step 2: Убедиться, что claude.js больше нигде не импортируется**

Run: `cd backend && grep -rn "agent/claude\|require('./claude')" --include=*.js . | grep -v node_modules`
Expected: пусто.

- [ ] **Step 3: Проверить загрузку сервера (smoke)**

Run: `cd backend && node -e "require('./services/agent/orchestrator'); require('./services/kb-assistant'); require('./services/aitunnel'); console.log('require OK')"`
Expected: `require OK` (все модули грузятся, циклических/битых импортов нет).

- [ ] **Step 4: Commit (если были правки) — иначе пропустить**

Нет изменений кода на этом шаге; коммит не требуется.

---

## Порядок выката (после мержа)

1. Деплой кода на прод.
2. Установить env: `AITUNNEL_API_KEY=sk-aitunnel-...`, `AGENT_PROVIDER=aitunnel`, `KB_PROVIDER=aitunnel` (модели — дефолтные).
3. Разово: `KB_PROVIDER=aitunnel AITUNNEL_API_KEY=... node backend/scripts/reembed-kb.js` — **до включения агента** (иначе RAG на несовместимых векторах).
4. `pm2 restart loyalpro` и проверить `/ask` + живой диалог на whitelist-пилоте.
5. Откат при проблеме: `AGENT_PROVIDER=anthropic` и/или `KB_PROVIDER=gemini` + рестарт (переэмбеддинг обратно для gemini потребует старую модель).

## Self-Review (выполнено при написании плана)

- **Покрытие спеки:** клиент (T1) ✓, абстракция провайдера T2/T3 ✓, рефактор оркестратора T4 ✓, KB+эмбеддинги T5 ✓, переэмбеддинг T6 ✓, config T1 ✓, тесты во всех задачах ✓, порядок выката ✓.
- **Плейсхолдеры:** нет — весь код приведён целиком.
- **Согласованность типов:** интерфейс `createMessage → {text,toolCalls,stopReason,assistantMsg}` и `toolResultMessages(results:[{id,name,result,isError}])` одинаков в anthropic (T2) и aitunnel (T3), потребляется оркестратором (T4) и тестами (T4). `embedText`/`callGemini` сохраняют сигнатуры, добавляют ветку.
