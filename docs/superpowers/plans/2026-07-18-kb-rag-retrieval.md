# KB RAG Retrieval (Phase 1 — grounded answers) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a hybrid (FTS + vector) retrieval layer over the knowledge base that returns grounded, chunk-level context with live YClients prices, so the chatpush agent can answer "по существу".

**Architecture:** Articles are split into chunks; each chunk stores a Gemini embedding as `real[]` (pgvector is unavailable on Beget — confirmed 2026-07-18) plus a generated `tsvector`. Retrieval runs a JS cosine search and a Postgres FTS search in parallel, merges them with Reciprocal Rank Fusion, then joins live service prices via `kb_article_links`. Embeddings are produced through the same Gemini relay used by the KB assistant.

**Tech Stack:** Node.js/Express, PostgreSQL 16 (`pg`, no ORM), Gemini `text-embedding-004` (via relay), Jest.

**Scope:** This plan covers Phase 1 only (retrieval + grounded context). Booking tools, orchestrator, and the debouncer belong to `2026-07-18-ai-booking-agent-design.md` and are a separate plan.

**Spec:** `docs/superpowers/specs/2026-07-18-kb-rag-retrieval-design.md`

---

## File Structure

- **Create** `backend/services/agent-rag.js` — pure helpers (chunking, hashing, vector norm, cosine, RRF) + IO (`reembedArticle`, `retrieveChunks`, `buildKnowledgeContext`). Pure helpers are exported separately and unit-tested with no DB/HTTP.
- **Create** `backend/agent-rag.test.js` — Jest tests for the pure helpers and (mocked) IO functions.
- **Create** `backend/scripts/backfill-kb-chunks.js` — one-off re-embed of all existing published articles.
- **Modify** `backend/migrations.js` — add `kb_chunks` and `kb_article_links` tables + indexes.
- **Modify** `backend/config.js` — add `KB_EMBED_MODEL`.
- **Modify** `backend/services/kb-assistant.js` — add embedding client (`embedText` with direct + relay dispatch).
- **Modify** `backend/routes/knowledge-base.js` — add relay embed receiver `POST /api/kb/relay/embed`; hook `reembedArticle` into article create/update; register the new public route path.

---

### Task 1: Migrations — `kb_chunks` and `kb_article_links`

**Files:**
- Modify: `backend/migrations.js` (after the `kb_articles` index block, ~line 614)

- [ ] **Step 1: Add the two tables and indexes**

In `backend/migrations.js`, immediately after the `kb_articles_salon_cat_order_idx` block (~line 614), insert:

```javascript
  // ── RAG-слой базы знаний (спека 2026-07-18-kb-rag-retrieval-design) ──
  // pgvector на Beget недоступен → эмбеддинг храним как real[], косинус в JS.
  await client.query(`
    CREATE TABLE IF NOT EXISTS kb_chunks (
      id            SERIAL PRIMARY KEY,
      salon_id      INTEGER NOT NULL REFERENCES salons(id) ON DELETE CASCADE,
      article_id    INTEGER NOT NULL REFERENCES kb_articles(id) ON DELETE CASCADE,
      chunk_index   INTEGER NOT NULL,
      content       TEXT NOT NULL,
      content_hash  TEXT NOT NULL DEFAULT '',
      embedding     REAL[],
      embed_norm    REAL NOT NULL DEFAULT 0,
      search_vector TSVECTOR GENERATED ALWAYS AS (
        to_tsvector('russian'::regconfig, coalesce(content, ''))
      ) STORED,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (article_id, chunk_index)
    )
  `).catch(() => {});
  await client.query(`
    CREATE INDEX IF NOT EXISTS kb_chunks_search_idx
    ON kb_chunks USING GIN (search_vector)
  `).catch(() => {});
  await client.query(`
    CREATE INDEX IF NOT EXISTS kb_chunks_salon_idx
    ON kb_chunks (salon_id)
  `).catch(() => {});

  await client.query(`
    CREATE TABLE IF NOT EXISTS kb_article_links (
      id            SERIAL PRIMARY KEY,
      salon_id      INTEGER NOT NULL REFERENCES salons(id) ON DELETE CASCADE,
      article_id    INTEGER NOT NULL REFERENCES kb_articles(id) ON DELETE CASCADE,
      entity_type   TEXT NOT NULL CHECK (entity_type IN ('service','staff')),
      entity_yc_id  BIGINT NOT NULL,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (article_id, entity_type, entity_yc_id)
    )
  `).catch(() => {});
  await client.query(`
    CREATE INDEX IF NOT EXISTS kb_article_links_lookup_idx
    ON kb_article_links (salon_id, entity_type, entity_yc_id)
  `).catch(() => {});
```

- [ ] **Step 2: Run migrations against the dev DB**

Run: `cd backend && node -e "const {pool}=require('./db'); const {runMigrations}=require('./migrations'); pool.connect().then(async c=>{await runMigrations(c); c.release(); console.log('OK'); process.exit(0)}).catch(e=>{console.error(e);process.exit(1)})"`
Expected: prints `OK` with no error.

- [ ] **Step 3: Verify the tables exist**

Run: `cd backend && node -e "const {db}=require('./db'); db.any(\"SELECT table_name FROM information_schema.tables WHERE table_name IN ('kb_chunks','kb_article_links') ORDER BY 1\").then(r=>{console.log(r);process.exit(0)})"`
Expected: two rows — `kb_article_links` and `kb_chunks`.

- [ ] **Step 4: Commit**

```bash
git add backend/migrations.js
git commit -m "feat(agent): миграции kb_chunks + kb_article_links (RAG-слой)"
```

---

### Task 2: Pure chunking + hashing helpers

**Files:**
- Create: `backend/services/agent-rag.js`
- Test: `backend/agent-rag.test.js`

- [ ] **Step 1: Write the failing test**

Create `backend/agent-rag.test.js`:

```javascript
'use strict';

const rag = require('./services/agent-rag');

describe('chunkArticle', () => {
  test('короткая статья → один чанк с заголовком', () => {
    const chunks = rag.chunkArticle({ title: 'Ботокс', body: 'Разглаживает морщины.' }, { maxChars: 1200 });
    expect(chunks).toHaveLength(1);
    expect(chunks[0].chunk_index).toBe(0);
    expect(chunks[0].content).toContain('Ботокс');
    expect(chunks[0].content).toContain('Разглаживает морщины.');
  });

  test('абзацы упаковываются в чанки по лимиту', () => {
    const body = ['A'.repeat(700), 'B'.repeat(700), 'C'.repeat(700)].join('\n\n');
    const chunks = rag.chunkArticle({ title: 'T', body }, { maxChars: 1000 });
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every(c => c.content.length <= 1000 + 100)).toBe(true);
    chunks.forEach((c, i) => expect(c.chunk_index).toBe(i));
  });

  test('пустое тело → один чанк только с заголовком', () => {
    const chunks = rag.chunkArticle({ title: 'Только заголовок', body: '' });
    expect(chunks).toHaveLength(1);
    expect(chunks[0].content).toContain('Только заголовок');
  });

  test('очень длинный абзац режется по maxChars', () => {
    const chunks = rag.chunkArticle({ title: 'T', body: 'X'.repeat(3000) }, { maxChars: 1000 });
    expect(chunks.length).toBeGreaterThanOrEqual(3);
  });
});

describe('hashChunk', () => {
  test('детерминирован и различает контент', () => {
    expect(rag.hashChunk('abc')).toBe(rag.hashChunk('abc'));
    expect(rag.hashChunk('abc')).not.toBe(rag.hashChunk('abd'));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && npx jest agent-rag.test.js -t chunkArticle`
Expected: FAIL — "Cannot find module './services/agent-rag'".

- [ ] **Step 3: Write minimal implementation**

Create `backend/services/agent-rag.js`:

```javascript
'use strict';

const crypto = require('crypto');

// ── Чистые хелперы RAG-слоя (без БД/HTTP, юнит-тестируемы) ──────
// Спека: docs/superpowers/specs/2026-07-18-kb-rag-retrieval-design.md

const DEFAULT_MAX_CHARS = 1200;   // ~300 токенов на чанк

// Режет строку на куски не длиннее maxChars по границам, ближе к концу.
function hardSplit(text, maxChars) {
  const out = [];
  let rest = text;
  while (rest.length > maxChars) {
    out.push(rest.slice(0, maxChars));
    rest = rest.slice(maxChars);
  }
  if (rest) out.push(rest);
  return out;
}

// Бьёт статью на чанки: заголовок префиксом к каждому чанку, тело — по абзацам,
// жадно упаковывая в куски ≤ maxChars. Длинные абзацы дорезаются hardSplit.
function chunkArticle(article, opts = {}) {
  const maxChars = opts.maxChars || DEFAULT_MAX_CHARS;
  const title = String((article && article.title) || '').trim();
  const body = String((article && article.body) || '').trim();
  const prefix = title ? `${title}\n` : '';

  const paras = body ? body.split(/\n\s*\n/).map(p => p.trim()).filter(Boolean) : [];
  const pieces = [];
  for (const p of paras) {
    for (const piece of hardSplit(p, maxChars)) pieces.push(piece);
  }
  if (!pieces.length) pieces.push('');

  const chunks = [];
  let buf = '';
  for (const piece of pieces) {
    const candidate = buf ? `${buf}\n\n${piece}` : piece;
    if (candidate.length > maxChars && buf) {
      chunks.push(buf);
      buf = piece;
    } else {
      buf = candidate;
    }
  }
  if (buf || !chunks.length) chunks.push(buf);

  return chunks.map((content, i) => ({
    chunk_index: i,
    content: `${prefix}${content}`.trim(),
  }));
}

// SHA-256 hex контента чанка — чтобы не переэмбеддить неизменённое.
function hashChunk(content) {
  return crypto.createHash('sha256').update(String(content), 'utf8').digest('hex');
}

module.exports = { DEFAULT_MAX_CHARS, chunkArticle, hashChunk };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && npx jest agent-rag.test.js -t chunkArticle && npx jest agent-rag.test.js -t hashChunk`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/services/agent-rag.js backend/agent-rag.test.js
git commit -m "feat(agent): чанкинг и хеширование статей KB (чистые хелперы)"
```

---

### Task 3: Pure vector + RRF helpers

**Files:**
- Modify: `backend/services/agent-rag.js`
- Test: `backend/agent-rag.test.js`

- [ ] **Step 1: Write the failing test**

Append to `backend/agent-rag.test.js`:

```javascript
describe('vectorNorm & cosineSim', () => {
  test('норма считается корректно', () => {
    expect(rag.vectorNorm([3, 4])).toBeCloseTo(5, 6);
  });

  test('косинус одинаковых векторов = 1', () => {
    const a = [1, 2, 3];
    expect(rag.cosineSim(a, a, rag.vectorNorm(a), rag.vectorNorm(a))).toBeCloseTo(1, 6);
  });

  test('косинус ортогональных = 0', () => {
    const a = [1, 0], b = [0, 1];
    expect(rag.cosineSim(a, b, rag.vectorNorm(a), rag.vectorNorm(b))).toBeCloseTo(0, 6);
  });

  test('нулевая норма → 0 без деления на ноль', () => {
    expect(rag.cosineSim([0, 0], [1, 1], 0, rag.vectorNorm([1, 1]))).toBe(0);
  });
});

describe('reciprocalRankFusion', () => {
  test('id из обоих списков поднимается выше', () => {
    const merged = rag.reciprocalRankFusion([['a', 'b', 'c'], ['b', 'd']], 60);
    expect(merged[0]).toBe('b');           // встречается в обоих
    expect(merged).toContain('a');
    expect(merged).toContain('d');
  });

  test('пустые списки → пустой результат', () => {
    expect(rag.reciprocalRankFusion([[], []], 60)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && npx jest agent-rag.test.js -t reciprocalRankFusion`
Expected: FAIL — "rag.reciprocalRankFusion is not a function".

- [ ] **Step 3: Write minimal implementation**

In `backend/services/agent-rag.js`, add before `module.exports`:

```javascript
// Евклидова норма вектора.
function vectorNorm(vec) {
  let s = 0;
  for (let i = 0; i < vec.length; i++) s += vec[i] * vec[i];
  return Math.sqrt(s);
}

// Косинус по предпосчитанным нормам. Нулевая норма → 0.
function cosineSim(a, b, normA, normB) {
  if (!normA || !normB) return 0;
  const n = Math.min(a.length, b.length);
  let dot = 0;
  for (let i = 0; i < n; i++) dot += a[i] * b[i];
  return dot / (normA * normB);
}

// Reciprocal Rank Fusion: score(id) = Σ 1/(k + rank). rank — 0-based позиция
// в каждом ранжированном списке id. Возвращает id, отсортированные по убыванию.
function reciprocalRankFusion(rankLists, k = 60) {
  const scores = new Map();
  for (const list of rankLists) {
    list.forEach((id, rank) => {
      scores.set(id, (scores.get(id) || 0) + 1 / (k + rank));
    });
  }
  return [...scores.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id);
}
```

Update the exports line to:

```javascript
module.exports = {
  DEFAULT_MAX_CHARS, chunkArticle, hashChunk,
  vectorNorm, cosineSim, reciprocalRankFusion,
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && npx jest agent-rag.test.js`
Expected: PASS (all describe blocks).

- [ ] **Step 5: Commit**

```bash
git add backend/services/agent-rag.js backend/agent-rag.test.js
git commit -m "feat(agent): косинус и RRF для гибридного поиска (чистые хелперы)"
```

---

### Task 4: Embedding client (direct Gemini)

**Files:**
- Modify: `backend/config.js:34` (KB config block)
- Modify: `backend/services/kb-assistant.js`
- Test: `backend/kb-embed.test.js`

- [ ] **Step 1: Add config for the embedding model**

In `backend/config.js`, in the KB block (after `KB_LLM_MODEL`, ~line 34), add:

```javascript
  // Эмбеддинги для RAG. text-embedding-004 = 768 значений. Через тот же relay, что и чат.
  KB_EMBED_MODEL: process.env.KB_EMBED_MODEL || 'text-embedding-004',
```

- [ ] **Step 2: Write the failing test**

Create `backend/kb-embed.test.js`:

```javascript
'use strict';

const kb = require('./services/kb-assistant');

function fakeFetch(payload, ok = true, status = 200) {
  return async () => ({ ok, status, json: async () => payload });
}

describe('embedContentOnce', () => {
  test('парсит embedding.values', async () => {
    const fetchFn = fakeFetch({ embedding: { values: [0.1, 0.2, 0.3] } });
    const vec = await kb.embedContentOnce('привет', { key: 'K', model: 'text-embedding-004', fetchFn });
    expect(vec).toEqual([0.1, 0.2, 0.3]);
  });

  test('не-2xx бросает ошибку со status', async () => {
    const fetchFn = fakeFetch({}, false, 429);
    await expect(kb.embedContentOnce('x', { key: 'K', model: 'm', fetchFn }))
      .rejects.toMatchObject({ status: 429 });
  });
});

describe('embedTextDirect', () => {
  test('фолбэк на второй ключ при ошибке первого', async () => {
    let calls = 0;
    const fetchFn = async () => {
      calls++;
      if (calls === 1) return { ok: false, status: 429, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => ({ embedding: { values: [1, 2] } }) };
    };
    const vec = await kb.embedTextDirect('x', { free: 'F', paid: 'P', model: 'm', fetchFn });
    expect(vec).toEqual([1, 2]);
    expect(calls).toBe(2);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd backend && npx jest kb-embed.test.js`
Expected: FAIL — "kb.embedContentOnce is not a function".

- [ ] **Step 4: Write minimal implementation**

In `backend/services/kb-assistant.js`, add before `module.exports` (after `callGemini`, ~line 154):

```javascript
// ── Эмбеддинги (RAG) ───────────────────────────────────────────
// Один вызов embedContent конкретным ключом. Возвращает массив чисел. Бросает {status}.
async function embedContentOnce(text, { key, model, fetchFn }) {
  const url = `${GEMINI_BASE}/${model}:embedContent?key=${key}`;
  const body = { model: `models/${model}`, content: { parts: [{ text }] } };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let res;
  try {
    res = await fetchFn(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    const err = new Error(`Gemini embed HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  const json = await res.json();
  const values = json && json.embedding && json.embedding.values;
  if (!Array.isArray(values)) throw new Error('Gemini embed: пустой ответ');
  return values;
}

// Dual-key эмбеддинг: free → paid на любой ошибке. Пустые ключи пропускаются.
async function embedTextDirect(text, opts) {
  const { free, paid, model } = opts;
  const fetchFn = opts.fetchFn || fetch;
  const keys = [free, paid].filter(Boolean);
  if (!keys.length) throw new Error('Gemini embed: не задан ни один ключ');
  let lastErr;
  for (const key of keys) {
    try {
      return await embedContentOnce(text, { key, model, fetchFn });
    } catch (e) { lastErr = e; continue; }
  }
  throw lastErr || new Error('Gemini embed: все ключи недоступны');
}
```

Update the `module.exports` object to also include the new names:

```javascript
module.exports = {
  CONTEXT_CHAR_BUDGET, SYSTEM_PROMPT, REQUEST_TIMEOUT_MS,
  buildContext, buildPrompt, parseGeminiResponse,
  callGeminiOnce, callGemini, callGeminiDirect, callViaRelay,
  retrieveArticles, logChat, ask,
  embedContentOnce, embedTextDirect,
};
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd backend && npx jest kb-embed.test.js`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add backend/config.js backend/services/kb-assistant.js backend/kb-embed.test.js
git commit -m "feat(agent): прямой Gemini-эмбеддинг (dual-key) для RAG"
```

---

### Task 5: Relay embed variant (prod → dev)

**Files:**
- Modify: `backend/services/kb-assistant.js`
- Modify: `backend/routes/knowledge-base.js` (add `POST /api/kb/relay/embed`; register public path)
- Test: `backend/kb-embed.test.js`

- [ ] **Step 1: Write the failing test**

Append to `backend/kb-embed.test.js`:

```javascript
describe('embedTextViaRelay', () => {
  test('шлёт {text} и парсит {embedding}', async () => {
    let sentBody;
    const fetchFn = async (url, opts) => {
      sentBody = JSON.parse(opts.body);
      return { ok: true, status: 200, json: async () => ({ embedding: [4, 5, 6] }) };
    };
    const vec = await kb.embedTextViaRelay('запрос', { url: 'http://dev/api/kb/relay/embed', secret: 'S', fetchFn });
    expect(sentBody).toEqual({ text: 'запрос' });
    expect(vec).toEqual([4, 5, 6]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && npx jest kb-embed.test.js -t embedTextViaRelay`
Expected: FAIL — "kb.embedTextViaRelay is not a function".

- [ ] **Step 3: Write minimal implementation**

In `backend/services/kb-assistant.js`, add after `embedTextDirect`:

```javascript
// Relay-режим для эмбеддингов: прод шлёт текст на dev, тот эмбеддит своим ключом.
// Тело: { text }; ответ: { embedding: number[] }.
async function embedTextViaRelay(text, { url, secret, fetchFn }) {
  const fn = fetchFn || fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let res;
  try {
    res = await fn(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Relay-Secret': secret || '' },
      body: JSON.stringify({ text }),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    const err = new Error(`Relay embed HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  const json = await res.json();
  if (!Array.isArray(json && json.embedding)) throw new Error('Relay embed: пустой ответ');
  return json.embedding;
}

// Диспетчер: relay-URL задан (прод) → relay; иначе прямой вызов.
async function embedText(text, opts) {
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

Update `module.exports` to add `embedTextViaRelay, embedText`:

```javascript
module.exports = {
  CONTEXT_CHAR_BUDGET, SYSTEM_PROMPT, REQUEST_TIMEOUT_MS,
  buildContext, buildPrompt, parseGeminiResponse,
  callGeminiOnce, callGemini, callGeminiDirect, callViaRelay,
  retrieveArticles, logChat, ask,
  embedContentOnce, embedTextDirect, embedTextViaRelay, embedText,
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && npx jest kb-embed.test.js`
Expected: PASS.

- [ ] **Step 5: Add the relay receiver route (dev side)**

In `backend/routes/knowledge-base.js`, immediately after the existing `POST /relay` handler (ends ~line 266), add:

```javascript
// POST /api/kb/relay/embed — dev-приёмник эмбеддингов для прода (гео-блок Gemini).
// Тело: { text }; ответ: { embedding }. БЕЗ JWT, защищён X-Relay-Secret.
router.post('/relay/embed', async (req, res) => {
  if (!config.KB_GEMINI_RELAY_SECRET ||
      req.get('X-Relay-Secret') !== config.KB_GEMINI_RELAY_SECRET) {
    return res.status(403).json({ error: 'forbidden' });
  }
  const text = req.body && req.body.text;
  if (typeof text !== 'string' || !text.trim()) {
    return res.status(400).json({ error: 'bad text' });
  }
  try {
    const embedding = await kbAssistant.embedTextDirect(text, {
      free:  config.KB_GEMINI_KEY_FREE,
      paid:  config.KB_GEMINI_KEY_PAID,
      model: config.KB_EMBED_MODEL,
    });
    res.json({ embedding });
  } catch (e) {
    logger.error(`POST /relay/embed: ${e.message}`);
    res.status(502).json({ error: 'gemini', message: e.message });
  }
});
```

- [ ] **Step 6: Register the new public path**

In `backend/routes/knowledge-base.js`, find the `API_PUBLIC` array that contains `'/api/kb/relay'` (~line 68) and add `'/api/kb/relay/embed'` next to it:

```javascript
  '/api/kb/relay',
  '/api/kb/relay/embed',
```

If `API_PUBLIC` lives in another file (e.g. `routes/index.js`), add the same entry there wherever `'/api/kb/relay'` is listed. Confirm with:
Run: `cd backend && grep -rn "'/api/kb/relay'" .`
Then add `'/api/kb/relay/embed'` alongside each match.

- [ ] **Step 7: Verify server still boots**

Run: `cd backend && node -e "require('./routes/knowledge-base'); console.log('route module OK')"`
Expected: prints `route module OK` (no syntax/require errors).

- [ ] **Step 8: Commit**

```bash
git add backend/services/kb-assistant.js backend/routes/knowledge-base.js backend/kb-embed.test.js
git commit -m "feat(agent): relay-эмбеддинг прод→dev + приёмник /api/kb/relay/embed"
```

---

### Task 6: `reembedArticle` — chunk → embed → upsert

**Files:**
- Modify: `backend/services/agent-rag.js`
- Test: `backend/agent-rag-io.test.js`

- [ ] **Step 1: Write the failing test (mock db + kb-assistant)**

Create `backend/agent-rag-io.test.js`:

```javascript
'use strict';

jest.mock('./services/kb-assistant', () => ({
  embedText: jest.fn(async () => [0.1, 0.2, 0.3]),
}));
jest.mock('./db', () => ({
  db: { any: jest.fn(), one: jest.fn(), query: jest.fn(async () => ({})) },
}));

const { db } = require('./db');
const kb = require('./services/kb-assistant');
const rag = require('./services/agent-rag');

beforeEach(() => {
  jest.clearAllMocks();
});

describe('reembedArticle', () => {
  test('эмбеддит новые чанки и апсертит', async () => {
    db.one.mockResolvedValue({ id: 7, salon_id: 1, title: 'Ботокс', body: 'Разглаживает морщины.' });
    db.any.mockResolvedValue([]); // существующих чанков нет
    await rag.reembedArticle(1, 7);
    expect(kb.embedText).toHaveBeenCalledTimes(1);        // один короткий чанк
    // upsert выполнен (INSERT ... ON CONFLICT)
    const upsertCalls = db.query.mock.calls.filter(c => /INSERT INTO kb_chunks/i.test(c[0]));
    expect(upsertCalls.length).toBe(1);
  });

  test('неизменённый чанк (совпал hash) не переэмбеддивается', async () => {
    const { hashChunk, chunkArticle } = rag;
    const art = { id: 7, salon_id: 1, title: 'Ботокс', body: 'Разглаживает морщины.' };
    const existingHash = hashChunk(chunkArticle({ title: art.title, body: art.body })[0].content);
    db.one.mockResolvedValue(art);
    db.any.mockResolvedValue([{ chunk_index: 0, content_hash: existingHash }]);
    await rag.reembedArticle(1, 7);
    expect(kb.embedText).not.toHaveBeenCalled();
  });

  test('нет статьи → тихо выходит', async () => {
    db.one.mockResolvedValue(null);
    await rag.reembedArticle(1, 999);
    expect(kb.embedText).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && npx jest agent-rag-io.test.js -t reembedArticle`
Expected: FAIL — "rag.reembedArticle is not a function".

- [ ] **Step 3: Write minimal implementation**

In `backend/services/agent-rag.js`, add `require`s at the top (after `const crypto`):

```javascript
const { db } = require('../db');
const kbAssistant = require('./kb-assistant');
```

Then add before `module.exports`:

```javascript
// ── IO: переэмбеддинг статьи ────────────────────────────────────
// Разбивает статью на чанки, переэмбеддит только изменённые (по content_hash),
// апсертит kb_chunks, удаляет лишние старые чанки. Безопасно вызывать асинхронно.
async function reembedArticle(salonId, articleId) {
  const art = await db.one(
    `SELECT id, salon_id, title, body FROM kb_articles WHERE id=$1 AND salon_id=$2`,
    [articleId, salonId]);
  if (!art) return;

  const chunks = chunkArticle({ title: art.title, body: art.body });
  const existing = await db.any(
    `SELECT chunk_index, content_hash FROM kb_chunks WHERE article_id=$1`,
    [articleId]);
  const oldHash = new Map(existing.map(r => [r.chunk_index, r.content_hash]));

  for (const ch of chunks) {
    const hash = hashChunk(ch.content);
    if (oldHash.get(ch.chunk_index) === hash) continue;   // не изменился
    const embedding = await kbAssistant.embedText(ch.content);
    const norm = vectorNorm(embedding);
    await db.query(
      `INSERT INTO kb_chunks
         (salon_id, article_id, chunk_index, content, content_hash, embedding, embed_norm, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7, now())
       ON CONFLICT (article_id, chunk_index) DO UPDATE
         SET content=$4, content_hash=$5, embedding=$6, embed_norm=$7, updated_at=now()`,
      [salonId, articleId, ch.chunk_index, ch.content, hash, embedding, norm]);
  }

  // Удаляем чанки, которых больше нет (статья стала короче).
  await db.query(
    `DELETE FROM kb_chunks WHERE article_id=$1 AND chunk_index >= $2`,
    [articleId, chunks.length]);
}
```

Update the exports:

```javascript
module.exports = {
  DEFAULT_MAX_CHARS, chunkArticle, hashChunk,
  vectorNorm, cosineSim, reciprocalRankFusion,
  reembedArticle,
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && npx jest agent-rag-io.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/services/agent-rag.js backend/agent-rag-io.test.js
git commit -m "feat(agent): reembedArticle — чанкинг+эмбеддинг+апсерт kb_chunks"
```

---

### Task 7: Hook re-embedding into article create/update

**Files:**
- Modify: `backend/routes/knowledge-base.js` (POST ~305-311, PUT ~332-339)

- [ ] **Step 1: Import agent-rag in the routes file**

At the top of `backend/routes/knowledge-base.js`, near the other `require`s, add:

```javascript
const agentRag = require('../services/agent-rag');
```

- [ ] **Step 2: Fire re-embedding after create (POST handler)**

In the `POST /articles` handler, immediately after `const row = await db.one( ... RETURNING ...)` and before `res.json({ article: row });`, insert:

```javascript
    // Переэмбеддинг — асинхронно, не блокируем ответ. Ошибку глотаем (не критично).
    agentRag.reembedArticle(req.user.salonId, row.id)
      .catch(e => logger.error(`reembed(create ${row.id}): ${e.message}`));
```

- [ ] **Step 3: Fire re-embedding after update (PUT handler)**

In the `PUT /articles/:id` handler, immediately after the `const row = await db.oneOrNone( ... RETURNING ...)` and the `if (!row) return res.status(404)...` guard, before `res.json({ article: row });`, insert:

```javascript
    agentRag.reembedArticle(req.user.salonId, row.id)
      .catch(e => logger.error(`reembed(update ${row.id}): ${e.message}`));
```

- [ ] **Step 4: Verify the module still loads**

Run: `cd backend && node -e "require('./routes/knowledge-base'); console.log('OK')"`
Expected: prints `OK`.

- [ ] **Step 5: Commit**

```bash
git add backend/routes/knowledge-base.js
git commit -m "feat(agent): переэмбеддинг статьи при create/update (async, non-blocking)"
```

---

### Task 8: Backfill script for existing articles

**Files:**
- Create: `backend/scripts/backfill-kb-chunks.js`

- [ ] **Step 1: Write the script**

Create `backend/scripts/backfill-kb-chunks.js`:

```javascript
'use strict';

// Разовый переэмбеддинг всех опубликованных статей во все kb_chunks.
// Запуск: node scripts/backfill-kb-chunks.js [salonId]
// salonId опционален — без него проходит по всем салонам.

const { db, pool } = require('../db');
const agentRag = require('../services/agent-rag');

async function main() {
  const salonArg = process.argv[2] ? parseInt(process.argv[2], 10) : null;
  const rows = await db.any(
    salonArg
      ? `SELECT id, salon_id FROM kb_articles WHERE is_published = true AND salon_id = $1 ORDER BY id`
      : `SELECT id, salon_id FROM kb_articles WHERE is_published = true ORDER BY id`,
    salonArg ? [salonArg] : []);

  console.log(`Статей к обработке: ${rows.length}`);
  let done = 0, failed = 0;
  for (const r of rows) {
    try {
      await agentRag.reembedArticle(r.salon_id, r.id);
      done++;
      if (done % 10 === 0) console.log(`  ...${done}/${rows.length}`);
    } catch (e) {
      failed++;
      console.error(`  статья ${r.id}: ${e.message}`);
    }
  }
  console.log(`Готово. Успешно: ${done}, ошибок: ${failed}`);
  await pool.end();
  process.exit(failed ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
```

- [ ] **Step 2: Dry-run the script's require graph**

Run: `cd backend && node -e "require('./scripts/backfill-kb-chunks.js')" 2>&1 | head -5 || true`
Expected: it starts running (may print "Статей к обработке: N" or a Gemini-key/DB error) — no syntax/require error. Ctrl-C or let it finish. (Actual embedding requires Gemini keys configured.)

- [ ] **Step 3: Commit**

```bash
git add backend/scripts/backfill-kb-chunks.js
git commit -m "feat(agent): backfill-скрипт переэмбеддинга существующих статей KB"
```

---

### Task 9: Hybrid retrieval — `retrieveChunks`

**Files:**
- Modify: `backend/services/agent-rag.js`
- Test: `backend/agent-rag-io.test.js`

- [ ] **Step 1: Write the failing test**

Append to `backend/agent-rag-io.test.js`:

```javascript
describe('retrieveChunks', () => {
  test('сливает вектор и FTS через RRF, отдаёт top-K', async () => {
    kb.embedText.mockResolvedValue([1, 0, 0]);
    // Все чанки салона (для JS-косинуса):
    db.any.mockImplementation(async (sql) => {
      if (/FROM kb_chunks[\s\S]*embedding/i.test(sql) && !/search_vector/i.test(sql)) {
        return [
          { id: 10, article_id: 1, content: 'ботокс морщины', embedding: [1, 0, 0], embed_norm: 1 },
          { id: 11, article_id: 1, content: 'массаж спины',   embedding: [0, 1, 0], embed_norm: 1 },
        ];
      }
      if (/search_vector/i.test(sql)) {
        return [{ id: 11, article_id: 1 }]; // FTS нашёл второй
      }
      return [];
    });
    const out = await rag.retrieveChunks(1, 'ботокс', { limit: 2 });
    expect(out.map(c => c.id)).toContain(10);
    expect(out.length).toBeLessThanOrEqual(2);
    expect(out[0]).toHaveProperty('content');
  });

  test('пустой запрос → пусто без вызова эмбеддинга', async () => {
    const out = await rag.retrieveChunks(1, '   ', { limit: 4 });
    expect(out).toEqual([]);
    expect(kb.embedText).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && npx jest agent-rag-io.test.js -t retrieveChunks`
Expected: FAIL — "rag.retrieveChunks is not a function".

- [ ] **Step 3: Write minimal implementation**

In `backend/services/agent-rag.js`, add a `require` for the FTS query builder at the top:

```javascript
const { buildPrefixTsQuery } = require('./knowledge-base');
```

Add before `module.exports`:

```javascript
const VECTOR_TOPN = 12;   // сколько кандидатов брать из каждого поиска до слияния

// Гибридный поиск чанков: JS-косинус (pgvector недоступен) + Postgres FTS → RRF.
// Возвращает top-K чанков { id, article_id, content }.
async function retrieveChunks(salonId, query, opts = {}) {
  const limit = opts.limit || 4;
  const q = String(query || '').trim();
  if (!q) return [];

  // 1) Вектор: эмбеддим запрос, тянем все чанки салона, косинус в JS.
  const qvec = await kbAssistant.embedText(q);
  const qnorm = vectorNorm(qvec);
  const all = await db.any(
    `SELECT id, article_id, content, embedding, embed_norm
       FROM kb_chunks
      WHERE salon_id = $1 AND embedding IS NOT NULL`,
    [salonId]);
  const byId = new Map(all.map(c => [c.id, c]));
  const vectorRanked = all
    .map(c => ({ id: c.id, score: cosineSim(qvec, c.embedding, qnorm, c.embed_norm) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, VECTOR_TOPN)
    .map(r => r.id);

  // 2) FTS по search_vector чанков (prefix-tsquery; при пустом — пропускаем).
  let ftsRanked = [];
  const tsq = buildPrefixTsQuery(q);
  if (tsq) {
    const ftsRows = await db.any(
      `SELECT id, article_id,
              ts_rank(search_vector, to_tsquery('russian', $2)) AS rank
         FROM kb_chunks
        WHERE salon_id = $1 AND search_vector @@ to_tsquery('russian', $2)
        ORDER BY rank DESC NULLS LAST
        LIMIT $3`,
      [salonId, tsq, VECTOR_TOPN]);
    ftsRanked = ftsRows.map(r => r.id);
    for (const r of ftsRows) if (!byId.has(r.id)) byId.set(r.id, r);
  }

  // 3) Слияние RRF → top-K, восстанавливаем контент.
  const merged = reciprocalRankFusion([vectorRanked, ftsRanked]).slice(0, limit);
  return merged
    .map(id => byId.get(id))
    .filter(Boolean)
    .map(c => ({ id: c.id, article_id: c.article_id, content: c.content }));
}
```

Update the exports:

```javascript
module.exports = {
  DEFAULT_MAX_CHARS, chunkArticle, hashChunk,
  vectorNorm, cosineSim, reciprocalRankFusion,
  reembedArticle, retrieveChunks,
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && npx jest agent-rag-io.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/services/agent-rag.js backend/agent-rag-io.test.js
git commit -m "feat(agent): retrieveChunks — гибридный поиск (косинус+FTS+RRF)"
```

---

### Task 10: `buildKnowledgeContext` — grounded context + live prices

**Files:**
- Modify: `backend/services/agent-rag.js`
- Test: `backend/agent-rag-io.test.js`

- [ ] **Step 1: Write the failing test**

Append to `backend/agent-rag-io.test.js`:

```javascript
describe('buildKnowledgeContext', () => {
  test('собирает контекст из чанков и живых цен связанных услуг', async () => {
    kb.embedText.mockResolvedValue([1, 0, 0]);
    db.any.mockImplementation(async (sql) => {
      if (/FROM kb_chunks[\s\S]*embedding/i.test(sql) && !/search_vector/i.test(sql)) {
        return [{ id: 10, article_id: 1, content: 'Ботокс: разглаживает морщины', embedding: [1, 0, 0], embed_norm: 1 }];
      }
      if (/search_vector/i.test(sql)) return [];
      if (/kb_article_links/i.test(sql)) {
        return [{ title: 'Ботулинотерапия', price_min: 5000, price_max: 8000, duration: 30 }];
      }
      return [];
    });
    const ctx = await rag.buildKnowledgeContext(1, 'ботокс');
    expect(ctx.context).toContain('разглаживает морщины');
    expect(ctx.context).toContain('Ботулинотерапия');
    expect(ctx.context).toMatch(/5000/);
    expect(ctx.sources).toContain(1);   // article_id
  });

  test('нет чанков → пустой контекст', async () => {
    kb.embedText.mockResolvedValue([1, 0, 0]);
    db.any.mockResolvedValue([]);
    const ctx = await rag.buildKnowledgeContext(1, 'нет-такого');
    expect(ctx.context).toBe('');
    expect(ctx.sources).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && npx jest agent-rag-io.test.js -t buildKnowledgeContext`
Expected: FAIL — "rag.buildKnowledgeContext is not a function".

- [ ] **Step 3: Write minimal implementation**

In `backend/services/agent-rag.js`, add before `module.exports`:

```javascript
const CONTEXT_CHAR_BUDGET = 12000;

// Живые цены/длительность услуг, связанных со статьями (kb_article_links → services_config).
async function liveServicesForArticles(salonId, articleIds) {
  if (!articleIds.length) return [];
  return db.any(
    `SELECT DISTINCT sc.title,
            sc.price_min, sc.price_max, sc.duration
       FROM kb_article_links l
       JOIN services_config sc
         ON sc.salon_id = l.salon_id
        AND sc.yclients_service_id = l.entity_yc_id
      WHERE l.salon_id = $1
        AND l.entity_type = 'service'
        AND l.article_id = ANY($2::int[])`,
    [salonId, articleIds]);
}

// Формат строки цены из услуги: "5000–8000 ₽, 30 мин".
function formatServiceLine(s) {
  const parts = [];
  if (s.price_min != null && s.price_max != null && s.price_min !== s.price_max) {
    parts.push(`${s.price_min}–${s.price_max} ₽`);
  } else if (s.price_min != null) {
    parts.push(`${s.price_min} ₽`);
  }
  if (s.duration != null) parts.push(`${s.duration} мин`);
  return `${s.title}${parts.length ? ' — ' + parts.join(', ') : ''}`;
}

// Собирает grounded-контекст для агента: релевантные чанки + блок живых цен.
// Возвращает { context, sources: number[] (article_id) }.
async function buildKnowledgeContext(salonId, query, opts = {}) {
  const budget = opts.budget || CONTEXT_CHAR_BUDGET;
  const chunks = await retrieveChunks(salonId, query, { limit: opts.limit || 4 });
  if (!chunks.length) return { context: '', sources: [] };

  const articleIds = [...new Set(chunks.map(c => c.article_id))];
  const services = await liveServicesForArticles(salonId, articleIds);

  let context = '';
  for (const c of chunks) {
    const block = `${c.content}\n\n`;
    if (context.length + block.length > budget) break;
    context += block;
  }
  if (services.length) {
    context += 'АКТУАЛЬНЫЕ УСЛУГИ И ЦЕНЫ:\n' +
      services.map(formatServiceLine).join('\n') + '\n';
  }

  return { context: context.trim(), sources: articleIds };
}
```

Update the exports:

```javascript
module.exports = {
  DEFAULT_MAX_CHARS, CONTEXT_CHAR_BUDGET, chunkArticle, hashChunk,
  vectorNorm, cosineSim, reciprocalRankFusion,
  reembedArticle, retrieveChunks,
  liveServicesForArticles, formatServiceLine, buildKnowledgeContext,
};
```

> **Note:** confirm `services_config` has columns `price_min`, `price_max`, `duration`, `yclients_service_id`, `salon_id`. If the real column names differ, adjust the SELECT in `liveServicesForArticles` and `formatServiceLine` accordingly (verify with `cd backend && node -e "const {db}=require('./db'); db.any(\"SELECT column_name FROM information_schema.columns WHERE table_name='services_config' ORDER BY 1\").then(r=>{console.log(r.map(x=>x.column_name));process.exit(0)})"`).

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && npx jest agent-rag-io.test.js`
Expected: PASS.

- [ ] **Step 5: Run the full suite**

Run: `cd backend && npx jest agent-rag.test.js agent-rag-io.test.js kb-embed.test.js`
Expected: PASS across all three files.

- [ ] **Step 6: Commit**

```bash
git add backend/services/agent-rag.js backend/agent-rag-io.test.js
git commit -m "feat(agent): buildKnowledgeContext — grounded-контекст + живые цены"
```

---

## Self-Review Notes

- **Spec coverage:** `kb_chunks`/`kb_article_links` (Task 1) ✓; chunking (Task 2) ✓; RRF+cosine (Task 3) ✓; Gemini embeddings direct + relay (Tasks 4–5) ✓; embedding maintenance hook (Tasks 6–7) ✓; backfill (Task 8) ✓; hybrid FTS+vector retrieval (Task 9) ✓; live-price join via links (Task 10) ✓. `real[]`-fallback (no pgvector) is baked into Tasks 1 & 9.
- **Out of scope here (Phase 2):** booking tools, orchestrator, debouncer, KB↔catalog linking UI, agent tool wiring — separate plan (`ai-booking-agent`).
- **Type consistency:** `embedText`/`embedTextDirect`/`embedTextViaRelay`/`embedContentOnce`, `chunkArticle`/`hashChunk`/`vectorNorm`/`cosineSim`/`reciprocalRankFusion`, `reembedArticle`/`retrieveChunks`/`buildKnowledgeContext` — names consistent across tasks and export lists.
- **Open verification item:** `services_config` column names (flagged in Task 10 Step 3). `API_PUBLIC` location (flagged in Task 5 Step 6).
```
