# База знаний — ИИ-ассистент Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Добавить на страницу «База знаний» чат-ассистента, который отвечает на вопросы сотрудников связным текстом, построенным строго на статьях из `kb_articles`, через бесплатный Gemini API с fallback на платный ключ.

**Architecture:** RAG без эмбеддингов. Retriever — существующий полнотекстовый поиск Postgres по `kb_articles` (топ-4 по `ts_rank`). Контекст найденных статей передаётся в Gemini 2.5 Flash с жёстким промптом «отвечай только по этому тексту». Dual-key: сначала бесплатный ключ, при `429` — платный. Всё скоупится по `salon_id`.

**Tech Stack:** Node.js 20 (глобальный `fetch`), Express, PostgreSQL (`pg` через хелпер `db`), Jest для тестов, ванильный JS фронт.

---

## Спека

`docs/superpowers/specs/2026-07-16-kb-ai-assistant-design.md`

## File Structure

- **Create** `backend/services/kb-assistant.js` — чистые + IO функции ассистента: `buildContext`, `buildPrompt`, `parseGeminiResponse`, `callGemini` (dual-key/fallback), `retrieveArticles`, `logChat`, `ask` (оркестратор).
- **Create** `backend/services/kb-assistant.test.js` — Jest-юниты чистых функций и fallback-логики (сеть мокается).
- **Modify** `backend/config.js` — добавить `KB_GEMINI_KEY_FREE`, `KB_GEMINI_KEY_PAID`, `KB_LLM_MODEL`.
- **Modify** `backend/migrations.js` — таблица `kb_chat_logs` (после блока `kb_articles`, ~строка 614).
- **Modify** `backend/routes/knowledge-base.js` — эндпоинт `POST /ask` (readAny), монтируется на `/api/kb`.
- **Modify** `frontend/index.html` — кнопка «Спросить ИИ» + панель чата в `#page-knowledge-base`.
- **Modify** `frontend/js/pages/knowledge-base.js` — открытие панели, отправка вопроса на `/api/kb/ask`, рендер ответа + источников.
- **Modify** `frontend/css/features.css` — стили панели чата (переиспользуют переменные темы).

---

## Task 1: Конфиг — env-переменные ключей

**Files:**
- Modify: `backend/config.js`

- [ ] **Step 1: Добавить переменные в module.exports**

В `backend/config.js` после строки с `FRONTEND_URL` (или рядом с другими `process.env`-константами) добавить:

```javascript
  // Knowledge-base AI assistant (Gemini). Dual-key: free первым, paid по fallback на 429.
  // Внимание: как только на Google-проекте включён биллинг, бесплатный тариф на нём
  // исчезает — поэтому нужны ДВА ключа из двух разных проектов.
  KB_GEMINI_KEY_FREE: process.env.KB_GEMINI_KEY_FREE || '',   // проект без биллинга (основной)
  KB_GEMINI_KEY_PAID: process.env.KB_GEMINI_KEY_PAID || '',   // ключ periaiassistent (резерв)
  KB_LLM_MODEL:       process.env.KB_LLM_MODEL       || 'gemini-2.5-flash',
```

- [ ] **Step 2: Проверить, что модуль грузится без ошибок**

Run: `cd backend && node -e "const c=require('./config'); console.log(c.KB_LLM_MODEL, JSON.stringify([c.KB_GEMINI_KEY_FREE, c.KB_GEMINI_KEY_PAID]))"`
Expected: `gemini-2.5-flash ["",""]` (ключи пустые, если env не заданы — это нормально).

- [ ] **Step 3: Commit**

```bash
git add backend/config.js
git commit -m "feat(kb): env-конфиг ключей Gemini для ассистента базы знаний"
```

---

## Task 2: Миграция — таблица логов чата

**Files:**
- Modify: `backend/migrations.js` (после блока создания индексов `kb_articles`, ~строка 614)

- [ ] **Step 1: Добавить создание таблицы и индекса**

В `backend/migrations.js` сразу после блока `kb_articles_salon_cat_order_idx` (перед комментарием `// ── Personal Staff Dashboard`) вставить:

```javascript
  // ── База знаний: логи ИИ-ассистента ────────────────────────────
  // Спека: docs/superpowers/specs/2026-07-16-kb-ai-assistant-design.md
  await client.query(`
    CREATE TABLE IF NOT EXISTS kb_chat_logs (
      id          SERIAL PRIMARY KEY,
      salon_id    INTEGER NOT NULL REFERENCES salons(id) ON DELETE CASCADE,
      user_id     INTEGER REFERENCES users(id) ON DELETE SET NULL,
      question    TEXT NOT NULL,
      answer      TEXT NOT NULL DEFAULT '',
      source_ids  INTEGER[] NOT NULL DEFAULT '{}',
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `).catch(() => {});

  await client.query(`
    CREATE INDEX IF NOT EXISTS kb_chat_logs_salon_idx
    ON kb_chat_logs (salon_id, created_at DESC)
  `).catch(() => {});
```

- [ ] **Step 2: Прогнать миграции на dev-БД**

Run: `cd backend && node -e "require('./migrations').runMigrations().then(()=>{console.log('OK');process.exit(0)}).catch(e=>{console.error(e);process.exit(1)})"`
Expected: завершается без ошибки, печатает `OK`.
Примечание: если экспортируемое имя функции отличается — открыть `migrations.js`, найти экспорт (напр. `module.exports = { runMigrations }` или `migrate`) и подставить его в команду.

- [ ] **Step 3: Проверить, что таблица создана**

Использовать MCP PostgreSQL (`mcp__postgres__query`) с запросом:
```sql
SELECT column_name, data_type FROM information_schema.columns
WHERE table_name = 'kb_chat_logs' ORDER BY ordinal_position;
```
Expected: строки `id, salon_id, user_id, question, answer, source_ids, created_at`.

- [ ] **Step 4: Commit**

```bash
git add backend/migrations.js
git commit -m "feat(kb): таблица kb_chat_logs для логов ИИ-ассистента"
```

---

## Task 3: Сервис — чистые функции (buildContext, buildPrompt, parseGeminiResponse)

**Files:**
- Create: `backend/services/kb-assistant.js`
- Test: `backend/services/kb-assistant.test.js`

- [ ] **Step 1: Написать падающие тесты чистых функций**

Создать `backend/services/kb-assistant.test.js`:

```javascript
'use strict';

const {
  buildContext, buildPrompt, parseGeminiResponse,
} = require('./kb-assistant');

describe('buildContext', () => {
  test('склеивает статьи как ### title + body', () => {
    const ctx = buildContext([
      { id: 1, title: 'Отмена записи', body: 'Отменить можно за 24 часа.' },
      { id: 2, title: 'Опоздание',     body: 'Ждём 15 минут.' },
    ]);
    expect(ctx).toContain('### Отмена записи');
    expect(ctx).toContain('Отменить можно за 24 часа.');
    expect(ctx).toContain('### Опоздание');
  });

  test('обрезает контекст по бюджету символов', () => {
    const big = { id: 1, title: 'T', body: 'x'.repeat(20000) };
    const ctx = buildContext([big], 5000);
    expect(ctx.length).toBeLessThanOrEqual(5000);
  });

  test('пустой список → пустая строка', () => {
    expect(buildContext([])).toBe('');
  });
});

describe('buildPrompt', () => {
  test('возвращает system и user, вопрос и контекст внутри user', () => {
    const p = buildPrompt('Как отменить запись?', '### Отмена\nЗа 24 часа.');
    expect(p.system).toMatch(/только/i);
    expect(p.user).toContain('Как отменить запись?');
    expect(p.user).toContain('За 24 часа.');
  });
});

describe('parseGeminiResponse', () => {
  test('достаёт текст из candidates[0].content.parts', () => {
    const json = { candidates: [{ content: { parts: [{ text: 'Ответ.' }] } }] };
    expect(parseGeminiResponse(json)).toBe('Ответ.');
  });

  test('склеивает несколько parts', () => {
    const json = { candidates: [{ content: { parts: [{ text: 'A' }, { text: 'B' }] } }] };
    expect(parseGeminiResponse(json)).toBe('AB');
  });

  test('нет кандидатов → пустая строка', () => {
    expect(parseGeminiResponse({})).toBe('');
    expect(parseGeminiResponse({ candidates: [] })).toBe('');
  });
});
```

- [ ] **Step 2: Запустить тесты — убедиться, что падают**

Run: `cd backend && npx jest kb-assistant -t 'buildContext|buildPrompt|parseGeminiResponse'`
Expected: FAIL — `Cannot find module './kb-assistant'`.

- [ ] **Step 3: Реализовать чистые функции**

Создать `backend/services/kb-assistant.js`:

```javascript
'use strict';

// ── RAG-ассистент базы знаний ─────────────────────────────────
// Спека: docs/superpowers/specs/2026-07-16-kb-ai-assistant-design.md

const CONTEXT_CHAR_BUDGET = 12000;   // сколько символов статей максимум шлём модели

const SYSTEM_PROMPT =
  'Ты ассистент базы знаний салона красоты. Отвечай ТОЛЬКО по тексту статей ниже. ' +
  'Если ответа в тексте нет — честно ответь "В базе знаний нет ответа на этот вопрос". ' +
  'Ничего не выдумывай и не добавляй от себя. Отвечай кратко, по-русски, по делу.';

// Склеивает статьи в единый контекст, обрезая по бюджету символов.
function buildContext(articles, budget = CONTEXT_CHAR_BUDGET) {
  if (!Array.isArray(articles) || !articles.length) return '';
  let out = '';
  for (const a of articles) {
    const block = `### ${a.title}\n${a.body || ''}\n\n`;
    if (out.length + block.length > budget) {
      out += block.slice(0, Math.max(0, budget - out.length));
      break;
    }
    out += block;
  }
  return out.slice(0, budget);
}

// Собирает system + user промпт для Gemini.
function buildPrompt(question, context) {
  return {
    system: SYSTEM_PROMPT,
    user: `СТАТЬИ:\n${context}\n\nВОПРОС: ${question}`,
  };
}

// Достаёт текст ответа из JSON-ответа generateContent.
function parseGeminiResponse(json) {
  const parts = json && json.candidates && json.candidates[0]
    && json.candidates[0].content && json.candidates[0].content.parts;
  if (!Array.isArray(parts)) return '';
  return parts.map(p => (p && p.text) || '').join('');
}

module.exports = {
  CONTEXT_CHAR_BUDGET, SYSTEM_PROMPT,
  buildContext, buildPrompt, parseGeminiResponse,
};
```

- [ ] **Step 4: Запустить тесты — убедиться, что проходят**

Run: `cd backend && npx jest kb-assistant -t 'buildContext|buildPrompt|parseGeminiResponse'`
Expected: PASS (все 8 тестов зелёные).

- [ ] **Step 5: Commit**

```bash
git add backend/services/kb-assistant.js backend/services/kb-assistant.test.js
git commit -m "feat(kb): чистые функции ассистента (context/prompt/parse) + тесты"
```

---

## Task 4: Сервис — callGemini с dual-key fallback по 429

**Files:**
- Modify: `backend/services/kb-assistant.js`
- Modify: `backend/services/kb-assistant.test.js`

- [ ] **Step 1: Написать падающие тесты fallback-логики**

В `backend/services/kb-assistant.test.js` добавить в конец файла:

```javascript
const kb = require('./kb-assistant');

describe('callGemini (dual-key fallback)', () => {
  const prompt = { system: 'S', user: 'U' };
  const okJson = { candidates: [{ content: { parts: [{ text: 'Ответ.' }] } }] };

  function fakeFetch(sequence) {
    // sequence: массив { status, json } по порядку вызовов
    let i = 0;
    return async () => {
      const r = sequence[i++] || sequence[sequence.length - 1];
      return {
        ok: r.status >= 200 && r.status < 300,
        status: r.status,
        json: async () => r.json || {},
      };
    };
  }

  test('free-ключ отвечает 200 → paid не зовём', async () => {
    const calls = [];
    const fetchFn = async (url) => { calls.push(url); return (fakeFetch([{ status: 200, json: okJson }]))(); };
    const text = await kb.callGemini(prompt, { free: 'FREE', paid: 'PAID', model: 'm', fetchFn });
    expect(text).toBe('Ответ.');
    expect(calls.length).toBe(1);
    expect(calls[0]).toContain('FREE');
  });

  test('free возвращает 429 → ретрай на paid-ключе', async () => {
    const calls = [];
    const seq = [{ status: 429 }, { status: 200, json: okJson }];
    let i = 0;
    const fetchFn = async (url) => {
      calls.push(url);
      const r = seq[i++];
      return { ok: r.status < 300, status: r.status, json: async () => r.json || {} };
    };
    const text = await kb.callGemini(prompt, { free: 'FREE', paid: 'PAID', model: 'm', fetchFn });
    expect(text).toBe('Ответ.');
    expect(calls.length).toBe(2);
    expect(calls[1]).toContain('PAID');
  });

  test('оба ключа 429 → бросает ошибку', async () => {
    const fetchFn = async () => ({ ok: false, status: 429, json: async () => ({}) });
    await expect(kb.callGemini(prompt, { free: 'FREE', paid: 'PAID', model: 'm', fetchFn }))
      .rejects.toThrow();
  });

  test('только paid задан → сразу платный, без free-ступени', async () => {
    const calls = [];
    const fetchFn = async (url) => { calls.push(url); return { ok: true, status: 200, json: async () => okJson }; };
    const text = await kb.callGemini(prompt, { free: '', paid: 'PAID', model: 'm', fetchFn });
    expect(text).toBe('Ответ.');
    expect(calls.length).toBe(1);
    expect(calls[0]).toContain('PAID');
  });

  test('ни одного ключа → бросает ошибку', async () => {
    await expect(kb.callGemini(prompt, { free: '', paid: '', model: 'm', fetchFn: async () => ({}) }))
      .rejects.toThrow();
  });
});
```

- [ ] **Step 2: Запустить — убедиться, что падают**

Run: `cd backend && npx jest kb-assistant -t 'callGemini'`
Expected: FAIL — `kb.callGemini is not a function`.

- [ ] **Step 3: Реализовать callGemini и одиночный вызов**

В `backend/services/kb-assistant.js` добавить перед `module.exports`:

```javascript
const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
const REQUEST_TIMEOUT_MS = 20000;

// Один вызов generateContent конкретным ключом. Бросает {status} на не-2xx.
async function callGeminiOnce(prompt, { key, model, fetchFn }) {
  const url = `${GEMINI_BASE}/${model}:generateContent?key=${key}`;
  const body = {
    system_instruction: { parts: [{ text: prompt.system }] },
    contents: [{ role: 'user', parts: [{ text: prompt.user }] }],
    generationConfig: { temperature: 0.2, maxOutputTokens: 800 },
  };
  const res = await fetchFn(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = new Error(`Gemini HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return parseGeminiResponse(await res.json());
}

// Dual-key: сначала free, при 429 (лимит) — paid. Пустые ключи пропускаются.
// opts: { free, paid, model, fetchFn }. fetchFn по умолчанию — глобальный fetch.
async function callGemini(prompt, opts) {
  const { free, paid, model } = opts;
  const fetchFn = opts.fetchFn || fetch;
  const keys = [free, paid].filter(Boolean);
  if (!keys.length) throw new Error('Gemini: не задан ни один ключ');

  let lastErr;
  for (const key of keys) {
    try {
      return await callGeminiOnce(prompt, { key, model, fetchFn });
    } catch (e) {
      lastErr = e;
      // На 429 (лимит) пробуем следующий ключ; на прочих ошибках — тоже пробуем,
      // но если ключей больше нет — пробросим ошибку ниже.
      continue;
    }
  }
  throw lastErr || new Error('Gemini: все ключи недоступны');
}
```

И расширить `module.exports`:

```javascript
module.exports = {
  CONTEXT_CHAR_BUDGET, SYSTEM_PROMPT, REQUEST_TIMEOUT_MS,
  buildContext, buildPrompt, parseGeminiResponse,
  callGeminiOnce, callGemini,
};
```

- [ ] **Step 4: Запустить — убедиться, что проходят**

Run: `cd backend && npx jest kb-assistant -t 'callGemini'`
Expected: PASS (5 тестов).

- [ ] **Step 5: Commit**

```bash
git add backend/services/kb-assistant.js backend/services/kb-assistant.test.js
git commit -m "feat(kb): callGemini с dual-key fallback по 429 + тесты"
```

---

## Task 5: Сервис — retrieveArticles, logChat, ask (оркестратор)

**Files:**
- Modify: `backend/services/kb-assistant.js`

Примечание: эти функции ходят в БД (`db`) и вызывают `callGemini`, поэтому юнит-тестами их не покрываем — проверяем через ручной прогон эндпоинта в Task 7. Держим их тонкими.

- [ ] **Step 1: Добавить импорты и функции retrieveArticles / logChat / ask**

В начало `backend/services/kb-assistant.js` (после `'use strict';`) добавить импорты:

```javascript
const { db } = require('../db');
const config = require('../config');
const { buildPrefixTsQuery } = require('./knowledge-base');
```

Перед `module.exports` добавить:

```javascript
// Топ-N опубликованных статей салона по релевантности вопросу (FTS + ILIKE fallback).
async function retrieveArticles(salonId, question, limit = 4) {
  const tsq = buildPrefixTsQuery(question);
  if (tsq) {
    return db.any(
      `SELECT id, title, body, category_id,
              ts_rank(search_vector, to_tsquery('russian', $2)) AS rank
         FROM kb_articles
        WHERE salon_id = $1 AND is_published = true
          AND (search_vector @@ to_tsquery('russian', $2)
               OR title ILIKE '%'||$3||'%' OR body ILIKE '%'||$3||'%')
        ORDER BY rank DESC NULLS LAST, display_order ASC
        LIMIT $4`,
      [salonId, tsq, question, limit]);
  }
  // Ввод из одних спецсимволов → только ILIKE.
  return db.any(
    `SELECT id, title, body, category_id, NULL::real AS rank
       FROM kb_articles
      WHERE salon_id = $1 AND is_published = true
        AND (title ILIKE '%'||$2||'%' OR body ILIKE '%'||$2||'%')
      ORDER BY display_order ASC
      LIMIT $3`,
    [salonId, question, limit]);
}

// Пишет запись в kb_chat_logs. Ошибку логирования глотаем — не роняем ответ.
async function logChat(salonId, userId, question, answer, sourceIds) {
  try {
    await db.query(
      `INSERT INTO kb_chat_logs (salon_id, user_id, question, answer, source_ids)
       VALUES ($1,$2,$3,$4,$5)`,
      [salonId, userId, question, answer, sourceIds]);
  } catch (_) { /* лог не критичен */ }
}

// Оркестратор: retrieve → guard → prompt → LLM → log → { answer, sources }.
// Бросает ошибку с .code для дифференциации на уровне роута.
async function ask(salonId, userId, question) {
  const free  = config.KB_GEMINI_KEY_FREE;
  const paid  = config.KB_GEMINI_KEY_PAID;
  const model = config.KB_LLM_MODEL;
  if (!free && !paid) {
    const e = new Error('Ассистент не настроен'); e.code = 'NOT_CONFIGURED'; throw e;
  }

  const articles = await retrieveArticles(salonId, question, 4);
  const sources = articles.map(a => ({ id: a.id, title: a.title, category_id: a.category_id }));
  const sourceIds = articles.map(a => a.id);

  if (!articles.length) {
    const answer = 'В базе знаний нет статей по этому вопросу.';
    await logChat(salonId, userId, question, answer, []);
    return { answer, sources: [] };
  }

  const context = buildContext(articles);
  const prompt = buildPrompt(question, context);

  let answer;
  try {
    answer = await callGemini(prompt, { free, paid, model });
  } catch (e) {
    // LLM недоступен/лимит → деградация: отдаём источники, помечаем degraded.
    await logChat(salonId, userId, question, '[LLM error] ' + e.message, sourceIds);
    const err = new Error('LLM недоступен'); err.code = 'LLM_UNAVAILABLE'; err.sources = sources;
    throw err;
  }

  answer = (answer || '').trim() || 'Не удалось сформировать ответ.';
  await logChat(salonId, userId, question, answer, sourceIds);
  return { answer, sources };
}
```

И добавить их в `module.exports` (дополнить существующий объект):

```javascript
  retrieveArticles, logChat, ask,
```

- [ ] **Step 2: Проверить, что модуль грузится и функции экспортированы**

Run: `cd backend && node -e "const k=require('./services/kb-assistant'); console.log(typeof k.ask, typeof k.retrieveArticles, typeof k.logChat)"`
Expected: `function function function`.

- [ ] **Step 3: Прогнать весь тест-файл (убедиться, что импорт БД не сломал юниты)**

Run: `cd backend && npx jest kb-assistant`
Expected: PASS — все тесты из Task 3 и Task 4 зелёные.

- [ ] **Step 4: Commit**

```bash
git add backend/services/kb-assistant.js
git commit -m "feat(kb): retrieveArticles + logChat + ask-оркестратор ассистента"
```

---

## Task 6: Роут — POST /api/kb/ask

**Files:**
- Modify: `backend/routes/knowledge-base.js`

- [ ] **Step 1: Подключить сервис ask и добавить эндпоинт**

В `backend/routes/knowledge-base.js` расширить импорт сервиса (строки 7-9) — добавить `ask` через отдельный require, чтобы не смешивать с существующей деструктуризацией:

```javascript
const kbAssistant = require('../services/kb-assistant');
```
(вставить сразу после существующего блока `const { STARTER_CATEGORIES, ... } = require('../services/knowledge-base');`)

Затем в секции `// ── Articles ──` (например, после роута `GET /articles/:id`, ~строка 197) добавить:

```javascript
// POST /api/kb/ask — ИИ-ассистент: ответ по статьям базы знаний
router.post('/ask', readAny, async (req, res) => {
  const question = (req.body?.question || '').trim();
  if (!question)              return res.status(400).json({ error: 'Пустой вопрос' });
  if (question.length > 500)  return res.status(400).json({ error: 'Слишком длинный вопрос (макс. 500 символов)' });
  try {
    const out = await kbAssistant.ask(req.user.salonId, req.user.id, question);
    res.json(out);
  } catch (e) {
    if (e.code === 'NOT_CONFIGURED') {
      return res.status(503).json({ error: 'ИИ-ассистент не настроен' });
    }
    if (e.code === 'LLM_UNAVAILABLE') {
      // Деградация: ответа нет, но отдаём найденные статьи-источники.
      return res.status(200).json({
        answer: 'Не удалось получить ответ ассистента, попробуйте позже. Смотрите найденные статьи ниже.',
        sources: e.sources || [],
        degraded: true,
      });
    }
    logger.error(`POST /ask: ${e.message}`);
    res.status(500).json({ error: 'Ошибка ассистента' });
  }
});
```

- [ ] **Step 2: Проверить, что роутер грузится без синтаксических ошибок**

Run: `cd backend && node -e "require('./routes/knowledge-base'); console.log('route OK')"`
Expected: `route OK`.

- [ ] **Step 3: Проверить, что req.user содержит id и salonId**

Run: `cd backend && grep -n "req.user.id\|salonId\|user.id" middleware/auth.js | head`
Expected: подтверждение, что `auth`-middleware кладёт `id` и `salonId` в `req.user`. Если поле называется иначе (напр. `userId`) — поправить `req.user.id` в роуте на фактическое имя.

- [ ] **Step 4: Commit**

```bash
git add backend/routes/knowledge-base.js
git commit -m "feat(kb): эндпоинт POST /api/kb/ask (ИИ-ассистент)"
```

---

## Task 7: Ручная проверка бэкенда (dev-сервер)

**Files:** нет (проверка)

- [ ] **Step 1: Задать тестовый ключ и перезапустить dev**

Задать в env dev-бэкенда `KB_GEMINI_KEY_PAID` = значение `GOOGLE_API_KEY` из `/root/PeriAiAssistent/.env` (скопировать вручную, не коммитить). Перезапустить PM2:
Run: `pm2 restart loyalpro --update-env && pm2 logs loyalpro --lines 5 --nostream`
Expected: сервис поднялся без ошибок.

- [ ] **Step 2: Проверить guard-ветку без ключа (опционально)**

Если ключ не задан — `POST /api/kb/ask` должен вернуть 503. С заданным ключом переходим к следующему шагу.

- [ ] **Step 3: Позвать эндпоинт через авторизованный запрос**

Получить JWT тестового пользователя (из сессии/логина dev). Затем через MCP Playwright или curl с токеном:
```bash
curl -s -X POST http://localhost:3001/api/kb/ask \
  -H "Authorization: Bearer <JWT>" -H "Content-Type: application/json" \
  -d '{"question":"Как отменить запись?"}' | head -c 800
```
Expected: JSON `{ "answer": "...", "sources": [...] }`. Если статей по теме нет — `answer` = «В базе знаний нет статей по этому вопросу.» и `sources: []`.

- [ ] **Step 4: Проверить запись в логах**

MCP PostgreSQL:
```sql
SELECT question, left(answer,60) AS answer, source_ids, created_at
FROM kb_chat_logs ORDER BY id DESC LIMIT 3;
```
Expected: появилась строка с заданным вопросом.

- [ ] **Step 5: Зафиксировать результат**

Записать в терминал результат (успех/ошибка). Кода-коммита нет — это шаг верификации.

---

## Task 8: Фронтенд — разметка панели чата

**Files:**
- Modify: `frontend/index.html` (блок `#page-knowledge-base`, ~строки 1190-1204)

- [ ] **Step 1: Добавить кнопку и панель ассистента**

В `frontend/index.html` внутри `.kb-topbar` (после кнопки `#kb-add-article`, строка 1197) добавить кнопку:

```html
          <button id="kb-ask-toggle" class="btn-sec" type="button">🤖 Спросить ИИ</button>
```

И сразу после `.kb-topbar` (перед `<div class="kb-body">`, строка 1199) вставить панель:

```html
        <div id="kb-ask-panel" class="kb-ask-panel" hidden>
          <div class="kb-ask-row">
            <input id="kb-ask-input" class="kb-ask-input" type="text"
                   maxlength="500" placeholder="Задайте вопрос по базе знаний…" autocomplete="off">
            <button id="kb-ask-send" class="btn-pri" type="button">Спросить</button>
          </div>
          <div id="kb-ask-result" class="kb-ask-result" hidden></div>
        </div>
```

- [ ] **Step 2: Проверить, что страница открывается без сломанной вёрстки**

Через MCP Playwright открыть dev-URL страницы «База знаний», убедиться, что кнопка «🤖 Спросить ИИ» отображается в топбаре, панель скрыта.
Expected: кнопка видна, `#kb-ask-panel` присутствует в DOM и `hidden`.

- [ ] **Step 3: Commit**

```bash
git add frontend/index.html
git commit -m "feat(kb): разметка панели ИИ-ассистента на странице базы знаний"
```

---

## Task 9: Фронтенд — логика чата (открытие, запрос, рендер)

**Files:**
- Modify: `frontend/js/pages/knowledge-base.js` (привязка в `kbBindOnce`, ~строка 55)

- [ ] **Step 1: Привязать обработчики в kbBindOnce**

В `frontend/js/pages/knowledge-base.js` внутри `kbBindOnce()` после строки
`document.getElementById('kb-add-article').addEventListener('click', () => kbOpenArticleModal(null));`
добавить:

```javascript
  const askToggle = document.getElementById('kb-ask-toggle');
  const askPanel  = document.getElementById('kb-ask-panel');
  const askInput  = document.getElementById('kb-ask-input');
  const askSend   = document.getElementById('kb-ask-send');
  if (askToggle && askPanel) {
    askToggle.addEventListener('click', () => {
      askPanel.hidden = !askPanel.hidden;
      if (!askPanel.hidden) askInput.focus();
    });
    askSend.addEventListener('click', kbAskSend);
    askInput.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') { ev.preventDefault(); kbAskSend(); }
    });
  }
```

- [ ] **Step 2: Добавить функцию kbAskSend**

В конец `frontend/js/pages/knowledge-base.js` (перед возможным финальным комментарием, но на верхнем уровне файла) добавить:

```javascript
async function kbAskSend() {
  const input  = document.getElementById('kb-ask-input');
  const result = document.getElementById('kb-ask-result');
  const q = (input.value || '').trim();
  if (q.length < 2) return;
  result.hidden = false;
  result.innerHTML = `<div class="kb-ask-loading">Думаю…</div>`;
  try {
    const data = await api('POST', '/api/kb/ask', { question: q });
    const answer = kbMarkdown(data.answer || '');
    const sources = (data.sources || []).map(s =>
      `<button class="kb-ask-src" type="button" data-id="${s.id}">${kbEsc(s.title)}</button>`
    ).join('');
    result.innerHTML = `
      <div class="kb-ask-answer">${answer}</div>
      ${sources ? `<div class="kb-ask-sources"><span>Источники:</span> ${sources}</div>` : ''}`;
    result.querySelectorAll('.kb-ask-src').forEach(btn =>
      btn.addEventListener('click', () => kbOpenArticle(parseInt(btn.dataset.id, 10))));
  } catch (e) {
    result.innerHTML = `<div class="kb-ask-error">Ошибка: ${kbEsc(e.message)}</div>`;
  }
}
```

Примечание: `kbMarkdown`, `kbEsc` — глобальные из `kb-markdown.js`; `api`, `kbOpenArticle` уже определены в этом окружении. Ответ ассистента рендерим через `kbMarkdown`, который экранирует HTML (защита от XSS), — тот же путь, что и для тела статьи.

- [ ] **Step 3: Проверить в браузере (MCP Playwright)**

Открыть страницу «База знаний» на dev, нажать «🤖 Спросить ИИ», ввести вопрос («Как отменить запись?»), нажать «Спросить».
Expected: появляется блок с ответом и (если есть) кнопками-источниками; клик по источнику открывает статью. Если ключ не настроен — виден текст ошибки «ИИ-ассистент не настроен».

- [ ] **Step 4: Commit**

```bash
git add frontend/js/pages/knowledge-base.js
git commit -m "feat(kb): логика чата с ИИ-ассистентом (запрос, рендер, источники)"
```

---

## Task 10: Фронтенд — стили панели чата

**Files:**
- Modify: `frontend/css/features.css`

- [ ] **Step 1: Добавить стили (в конец блока стилей базы знаний)**

В `frontend/css/features.css` добавить (переиспользуем существующие CSS-переменные темы, как в соседних `.kb-*` правилах — если имена переменных отличаются, взять фактические из соседних `.kb-suggest`/`.kb-card`):

```css
/* ── База знаний: ИИ-ассистент ─────────────────────────── */
.kb-ask-panel {
  margin: 8px 0 12px;
  padding: 12px;
  border: 1px solid var(--border, #e2e2e2);
  border-radius: 10px;
  background: var(--card-bg, #fff);
}
.kb-ask-row { display: flex; gap: 8px; }
.kb-ask-input {
  flex: 1; padding: 9px 12px;
  border: 1px solid var(--border, #ccc); border-radius: 8px;
  font-size: 14px; background: var(--input-bg, #fff); color: var(--text, #222);
}
.kb-ask-result { margin-top: 12px; }
.kb-ask-loading, .kb-ask-error { padding: 8px 0; color: var(--muted, #888); }
.kb-ask-error { color: var(--danger, #c0392b); }
.kb-ask-answer { line-height: 1.5; white-space: normal; }
.kb-ask-sources {
  margin-top: 10px; display: flex; flex-wrap: wrap; gap: 6px; align-items: center;
  font-size: 13px; color: var(--muted, #888);
}
.kb-ask-src {
  padding: 4px 10px; border: 1px solid var(--border, #ddd); border-radius: 999px;
  background: transparent; color: var(--accent, #3b82f6); cursor: pointer; font-size: 13px;
}
.kb-ask-src:hover { background: var(--accent, #3b82f6); color: #fff; }
```

- [ ] **Step 2: Проверить в браузере (MCP Playwright)**

Открыть панель ассистента, задать вопрос, убедиться, что блок ответа и «пилюли»-источники отображаются аккуратно и читаемо в текущей теме.
Expected: панель, поле, кнопка и источники выглядят согласованно с остальной страницей.

- [ ] **Step 3: Commit**

```bash
git add frontend/css/features.css
git commit -m "style(kb): стили панели ИИ-ассистента базы знаний"
```

---

## Task 11: Финальная проверка и полный прогон тестов

**Files:** нет (проверка)

- [ ] **Step 1: Прогнать все тесты сервиса ассистента**

Run: `cd backend && npx jest kb-assistant`
Expected: PASS — все юниты (Task 3 + Task 4) зелёные.

- [ ] **Step 2: Прогнать существующий KB-тест (регрессия)**

Run: `cd backend && npx jest knowledge-base`
Expected: PASS — существующие тесты `buildPrefixTsQuery` не сломаны.

- [ ] **Step 3: E2E-проверка в браузере**

MCP Playwright: полный сценарий — открыть «База знаний» → «🤖 Спросить ИИ» → вопрос с ответом в базе (получаем связный ответ + источники) → вопрос без ответа в базе (получаем «В базе знаний нет ответа…»).
Expected: оба сценария отрабатывают корректно.

- [ ] **Step 4: Обновить спеку статусом (опционально)**

Если всё зелёное — сменить в спеке `Статус: дизайн, ожидает утверждения` → `Статус: реализовано`.

---

## Self-Review

- **Spec coverage:** тип ответа генеративный (T3-5), dual-key free→paid (T1,T4), только сотрудники/`readAny` (T6), retriever на существующем FTS (T5), таблица `kb_chat_logs` (T2), эндпоинт `/api/kb/ask` (T6), сервис `kb-assistant.js` (T3-5), config (T1), фронт-виджет (T8-10), обработка ошибок 503/деградация (T6), тесты fallback (T4), приватность — обеспечена выбором «только регламенты» на уровне спеки (кода не требует). Все разделы спеки покрыты.
- **Placeholder scan:** плейсхолдеров нет; весь код приведён целиком, где `<JWT>`/`<значение ключа>` — это подставляемые вручную секреты на шагах ручной верификации, не код.
- **Type consistency:** `buildContext/buildPrompt/parseGeminiResponse/callGemini/retrieveArticles/logChat/ask` — имена согласованы между Task 3-6; `{answer, sources, degraded}` — единый контракт роут↔фронт; `req.user.salonId`/`req.user.id` — с оговоркой проверки в T6 Step 3.
