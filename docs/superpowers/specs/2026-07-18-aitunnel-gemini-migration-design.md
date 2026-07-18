# Перевод ИИ-путей LoyalPro на aitunnel.ru (Gemini 3.1 Flash Lite)

**Дата:** 2026-07-18
**Статус:** утверждён к реализации
**Автор:** дизайн-сессия (brainstorming)

## Проблема

Два ИИ-пути проекта упираются в геоблок Google/провайдеров:

1. **Диалоговый агент chatpush** (`services/agent/*`) — сейчас Anthropic Claude (`claude-opus-4-8`) через официальный `@anthropic-ai/sdk`, прямой вызов. Работает, т.к. Claude не гео-блокируется на dev-хосте, но это единственная причина, и она хрупкая.
2. **База знаний + эмбеддинги** (`services/kb-assistant.js`, `services/agent-rag.js`) — Google Gemini (`gemini-flash-lite-latest` + `text-embedding-004`) через **хрупкий dev-релей** (`KB_GEMINI_RELAY_URL` / `X-Relay-Secret`), обходящий геоблок проксированием prod→dev.

## Решение

Перевести **оба** пути на российский агрегатор **aitunnel.ru** (OpenAI-совместимый API), который даёт полный доступ к моделям без геоблока, оплата в рублях.

- Чат-модель: **`gemini-3.1-flash-lite`** (tool calling + structured output, контекст 1M токенов).
- Эмбеддинги: **`gemini-embedding-001`**, размерность **3072**.
- Клиент: официальный **`openai` SDK**, `baseURL = https://api.aitunnel.ru/v1`, auth `Authorization: Bearer sk-aitunnel-...`.
- Провайдер **переключается через env** (не хардкод) — откат к Anthropic/Gemini-релею без изменения кода.

### Зафиксированные решения дизайна

| Вопрос | Решение |
|---|---|
| Стратегия провайдера агента | Переключаемый через env (`AGENT_PROVIDER`), default `aitunnel` |
| Охват | Всё: агент + KB-ассистент (`/ask`) + эмбеддинги |
| HTTP-клиент | Официальный `openai` npm SDK (одна новая зависимость) |
| Модель эмбеддингов | `gemini-embedding-001`, dim 3072 |

## Архитектура

### Ключевая сложность: разные форматы провода

Anthropic и OpenAI Chat Completions несовместимы по формату:

| Аспект | Anthropic (сейчас) | OpenAI / aitunnel |
|---|---|---|
| System | отдельный параметр `system` | сообщение `{role:'system'}` |
| Инструменты | `{name, description, input_schema}` | `{type:'function', function:{name, description, parameters}}` |
| Вызов инструмента в ответе | content-блок `tool_use` (`input` — объект) | `message.tool_calls[].function.arguments` (JSON-строка) |
| Результат инструмента | `{role:'user', content:[{type:'tool_result', tool_use_id, content}]}` | одно `{role:'tool', tool_call_id, content}` на каждый вызов |
| Признак «нужен инструмент» | `stop_reason === 'tool_use'` | `finish_reason === 'tool_calls'` |
| Reasoning | `thinking: {type:'adaptive'}` | не отправляется (опционально `reasoning_effort` позже) |

Поэтому это **не «поменять URL и ключ»**, а ввести слой абстракции провайдера, полностью прячущий формат.

### 1. Общий клиент aitunnel — `backend/services/aitunnel.js` (новый)

Тонкая фабрика поверх `openai` SDK, одна на весь проект:

```js
const OpenAI = require('openai');
const config = require('../config');
function makeClient(apiKey) {
  return new OpenAI({ apiKey: apiKey || config.AITUNNEL_API_KEY, baseURL: config.AITUNNEL_BASE });
}
module.exports = { makeClient };
```

Используется агентом, KB-ассистентом и эмбеддингами.

### 2. Абстракция провайдера агента — `backend/services/agent/providers/` (новое)

Интерфейс, который знают только адаптеры; оркестратор — провайдер-агностик:

```
provider.createMessage({ system, messages, tools }, opts)
   → { text, toolCalls: [{ id, name, input }], stopReason, assistantMsg }
provider.toolResultMessages(results)   // results: [{ id, name, result, isError }]
   → [ ...provider-native messages для догрузки в convo ]
```

- **`providers/anthropic.js`** — перенос нынешнего `services/agent/claude.js` без изменения поведения: `system` отдельно, `thinking:{type:'adaptive'}`, tools как есть, ответ из content-блоков, `tool_result` в `{role:'user'}`. `assistantMsg = {role:'assistant', content: message.content}`. `toolResultMessages` возвращает один `{role:'user', content:[tool_result...]}`.
- **`providers/aitunnel.js`** (новый) — OpenAI-формат:
  - вход: `system` → префикс-сообщение `{role:'system'}`; tools → `{type:'function', function:{name, description, parameters: input_schema}}`;
  - вызов `client.chat.completions.create({ model: config.AITUNNEL_CHAT_MODEL, max_tokens, messages, tools })`;
  - разбор: `choices[0].message` → `text = message.content`, `toolCalls = (message.tool_calls||[]).map(tc => ({ id: tc.id, name: tc.function.name, input: JSON.parse(tc.function.arguments||'{}') }))`, `stopReason = choices[0].finish_reason`, `assistantMsg = message` (сырой, включая `tool_calls`);
  - `toolResultMessages(results)` → `results.map(r => ({ role:'tool', tool_call_id: r.id, content: JSON.stringify(r.result) }))`.
- **`providers/index.js`** — `getProvider()` по `config.AGENT_PROVIDER` (`aitunnel` | `anthropic`, default `aitunnel`). Тестовый мок инъектируется через `opts.client` (SDK-мок), как сейчас.

### 3. Оркестратор — `backend/services/agent/orchestrator.js` (правка)

Сделать провайдер-агностиком. Заменить `d.claude`/`claude.*` на `d.provider`/`provider.*`:

```js
const provider = d.provider || getProvider();
...
const resp = await provider.createMessage(
  { system, messages: convo.slice(), tools: registry.schemas }, { client: opts.client });
convo.push(resp.assistantMsg);
if (resp.text) replies.push(resp.text);
if (resp.stopReason !== 'tool_use' && resp.stopReason !== 'tool_calls') break;
if (!resp.toolCalls.length) break;
const results = [];
for (const tc of resp.toolCalls) {
  // handler(salonId, tc.input, toolCtx); учёт SIDE_EFFECT_TOOLS и escalate — как сейчас
  results.push({ id: tc.id, name: tc.name, result, isError });
}
convo.push(...provider.toolResultMessages(results));
```

`history.loadTranscript` уже отдаёт нейтральные `{role, content: string}` — **без изменений**. `tools/index.js` схемы остаются каноничными (JSON-schema `{name, description, input_schema}`), конвертирует провайдер — **без изменений**.

### 4. KB-ассистент — `backend/services/kb-assistant.js` (правка)

`callGemini` и `embedText` получают ветку **aitunnel** через общий клиент (п.1), выбор по env `KB_PROVIDER` (`aitunnel` default | `gemini`):

- Чат: `client.chat.completions.create` с `system`+`user` сообщениями, `model = config.AITUNNEL_CHAT_MODEL`, `temperature: 0.2`, `max_tokens: 800`; ответ из `choices[0].message.content`.
- Эмбеддинги: `client.embeddings.create({ model: config.AITUNNEL_EMBED_MODEL, input: text, dimensions: 3072 })`; вектор из `data[0].embedding`.
- Существующий dev-релей (`callViaRelay`, `embedTextViaRelay`, `KB_GEMINI_RELAY_*`, эндпоинты `/api/kb/relay*` в `routes/knowledge-base.js`) **остаётся** как запасной путь при `KB_PROVIDER=gemini`. Не удаляем — обратная совместимость и мгновенный откат.

### 5. Эмбеддинги: миграция базы знаний

Схему БД менять **не нужно** — `kb_chunks.embedding` уже `REAL[]` (переменная длина, `migrations.js:626`). Но модель эмбеддингов новая → **векторное пространство другое**, все сохранённые векторы (старые 768-мерные Google) несовместимы с новыми запросами (3072-мерные) и дают мусор в косинусе.

**Требуется разовый переэмбеддинг всей базы знаний.** Добавить скрипт `backend/scripts/reembed-kb.js`:
- проходит по всем `kb_chunks` (по всем салонам), пересчитывает `embedding` + `embed_norm` новой моделью, переиспользуя логику `agent-rag.js` (`vectorNorm`, upsert);
- идемпотентен, логирует прогресс и итог;
- запуск вручную **после деплоя кода** и установки `AITUNNEL_*` env.

**Это блокирующий шаг релиза:** до переэмбеддинга RAG-поиск (`search_knowledge_base` tool и `/ask`) выдаёт мусор. Порядок выката: (1) деплой кода + env, (2) `node scripts/reembed-kb.js`, (3) включить агента.

### 6. Config — `backend/config.js` (правка)

Добавить:
```
AITUNNEL_API_KEY:   process.env.AITUNNEL_API_KEY   || '',
AITUNNEL_BASE:      process.env.AITUNNEL_BASE      || 'https://api.aitunnel.ru/v1',
AITUNNEL_CHAT_MODEL:  process.env.AITUNNEL_CHAT_MODEL  || 'gemini-3.1-flash-lite',
AITUNNEL_EMBED_MODEL: process.env.AITUNNEL_EMBED_MODEL || 'gemini-embedding-001',
AITUNNEL_EMBED_DIM:   process.env.AITUNNEL_EMBED_DIM ? parseInt(process.env.AITUNNEL_EMBED_DIM, 10) : 3072,
AGENT_PROVIDER:     process.env.AGENT_PROVIDER     || 'aitunnel',
KB_PROVIDER:        process.env.KB_PROVIDER        || 'aitunnel',
```
`AGENT_LLM_MODEL`/`ANTHROPIC_API_KEY` и `KB_GEMINI_*` остаются для отката.

### 7. Тесты

- Новый `backend/services/agent/providers/aitunnel.test.js` — конвертация форматов в обе стороны: tools → OpenAI-схема; парсинг `tool_calls` (JSON-строка аргументов, несколько вызовов в одном ходе); `toolResultMessages` (по одному `{role:'tool'}` на вызов, правильный `tool_call_id`); system-префикс; `finish_reason` маппинг.
- Существующие ~80 unit-тестов агента: адаптировать мок-шов `d.claude` → `d.provider`. Поведение оркестратора (дебаунс, перегенерация, эскалация, side-effect) не меняется.
- Anthropic-провайдер: вынести существующие тесты `claude.js` под новый путь без изменения ожиданий.

## Зависимости

- Добавить `openai` в `backend/package.json`.

## Риски

1. **Форматный слой Anthropic↔OpenAI** — главный источник ошибок: мультивызовы инструментов в одном ходе, порядок и соответствие `tool_call_id`↔результат, пустой `content` при чистом tool-call. Покрываем юнит-тестами и живым E2E на whitelist-пилоте.
2. **Переэмбеддинг** — обязательный ручной шаг; пропуск ломает RAG молча (косинус по несовместимым векторам). Документируем в спеке, скрипте и порядке выката.
3. **Единая точка отказа** — раньше агент (Claude) и KB (Gemini) были независимы; теперь оба через aitunnel. Смягчение: env-переключатели позволяют откатить любой путь по отдельности.
4. **Поведенческая разница моделей** — Gemini 3.1 Flash Lite слабее Claude Opus в следовании инструкциям/tool-calling; системный промпт и tool-описания могут потребовать подстройки после E2E.

## Порядок реализации (для writing-plans)

1. `openai` в зависимости + `services/aitunnel.js` + config.
2. Абстракция провайдера агента: `providers/{index,anthropic,aitunnel}.js` (перенос claude.js) + рефактор `orchestrator.js`.
3. Адаптация unit-тестов агента + новый тест aitunnel-провайдера.
4. KB-ассистент: ветка aitunnel для чата и эмбеддингов + `KB_PROVIDER`.
5. `scripts/reembed-kb.js` + документация порядка выката.
6. Живой E2E на пилоте (после установки `AITUNNEL_API_KEY`).
