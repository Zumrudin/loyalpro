# База знаний администратора — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Добавить в LoyalPro раздел «База знаний» — внутренний справочник статей (markdown) в редактируемых папках-категориях, с русским полнотекстовым поиском; читают все роли, редактируют owner+admin.

**Architecture:** Две Postgres-таблицы (`kb_categories`, `kb_articles`) через `migrations.js`. Express-роутер `routes/knowledge-base.js` на `/api/kb` (reads всем, writes через `requireRole`). Чистые хелперы вынесены в `services/knowledge-base.js` (юнит-тесты `node:test`). Frontend — vanilla-страница `knowledge-base.js` + чистый markdown-рендерер `kb-markdown.js` (юнит-тесты). Всё scoped по `salonId`, паттерны скопированы с модуля portfolio.

**Tech Stack:** Node.js/Express, PostgreSQL (`pg`, full-text `russian`), vanilla JS SPA, `node:test`/`node:assert` для юнитов.

Спека: `docs/superpowers/specs/2026-07-16-knowledge-base-design.md`.

---

## File Structure

- **Create** `backend/services/knowledge-base.js` — чистые хелперы: `STARTER_CATEGORIES`, `validateArticleInput`, `normalizeTags`. Без БД/HTTP.
- **Create** `backend/services/knowledge-base.test.js` — юнит-тесты хелперов (`node:test`).
- **Create** `backend/routes/knowledge-base.js` — роутер `/api/kb` (categories + articles CRUD, reorder, search, seed).
- **Modify** `backend/migrations.js` — таблицы `kb_categories`, `kb_articles`, индексы.
- **Modify** `backend/routes/index.js` — смонтировать `/api/kb`.
- **Modify** `backend/config.js` — добавить `/api/kb` в `SPECIALIST_ALLOWED_PREFIXES`.
- **Create** `frontend/js/pages/kb-markdown.js` — чистый markdown→HTML рендерер (глобальный `kbMarkdown` в браузере, экспорт для тестов).
- **Create** `frontend/js/pages/kb-markdown.test.js` — юнит-тесты рендерера (`node:test`).
- **Create** `frontend/js/pages/knowledge-base.js` — страница SPA (список папок, поиск, чтение, модалки редактирования, drag-drop).
- **Modify** `frontend/index.html` — пункт меню, контейнер `#page-knowledge-base`, `<script>`.
- **Modify** `frontend/js/core/nav.js` — хук инициализации страницы в `navTo`.

Переиспользуем существующий `validateReorderPayload` из `services/portfolio.js` (DRY) — не дублируем.

---

## Task 1: Миграция — таблицы kb_categories и kb_articles

**Files:**
- Modify: `backend/migrations.js` (внутри `runMigrations`, перед `module.exports`)

- [ ] **Step 1: Добавить блок миграции**

В `backend/migrations.js`, внутри функции `runMigrations(client)`, добавить в конец тела функции (после последнего существующего `await client.query(...)`, до закрывающей `}`):

```javascript
  // ── База знаний (Knowledge Base) ───────────────────────────────
  await client.query(`
    CREATE TABLE IF NOT EXISTS kb_categories (
      id            SERIAL PRIMARY KEY,
      salon_id      INTEGER NOT NULL REFERENCES salons(id) ON DELETE CASCADE,
      title         TEXT NOT NULL,
      icon          TEXT NOT NULL DEFAULT '',
      display_order INTEGER NOT NULL DEFAULT 0,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `).catch(() => {});

  await client.query(`
    CREATE INDEX IF NOT EXISTS kb_categories_salon_order_idx
    ON kb_categories (salon_id, display_order)
  `).catch(() => {});

  await client.query(`
    CREATE TABLE IF NOT EXISTS kb_articles (
      id            SERIAL PRIMARY KEY,
      salon_id      INTEGER NOT NULL REFERENCES salons(id) ON DELETE CASCADE,
      category_id   INTEGER NOT NULL REFERENCES kb_categories(id) ON DELETE CASCADE,
      title         TEXT NOT NULL,
      body          TEXT NOT NULL DEFAULT '',
      tags          TEXT[] NOT NULL DEFAULT '{}',
      is_published  BOOLEAN NOT NULL DEFAULT TRUE,
      display_order INTEGER NOT NULL DEFAULT 0,
      search_vector TSVECTOR GENERATED ALWAYS AS (
        setweight(to_tsvector('russian', coalesce(title, '')), 'A') ||
        setweight(to_tsvector('russian', coalesce(body,  '')), 'B') ||
        setweight(to_tsvector('russian', array_to_string(tags, ' ')), 'A')
      ) STORED,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `).catch(() => {});

  await client.query(`
    CREATE INDEX IF NOT EXISTS kb_articles_search_idx
    ON kb_articles USING GIN (search_vector)
  `).catch(() => {});

  await client.query(`
    CREATE INDEX IF NOT EXISTS kb_articles_salon_cat_order_idx
    ON kb_articles (salon_id, category_id, display_order)
  `).catch(() => {});
```

- [ ] **Step 2: Применить миграцию на dev**

Run: `pm2 restart loyalpro && sleep 2 && pm2 logs loyalpro --lines 20 --nostream`
Expected: рестарт без ошибок, в логах нет `error` про kb-таблицы.

- [ ] **Step 3: Проверить, что таблицы созданы (MCP postgres)**

Выполнить через `mcp__postgres__query`:
```sql
SELECT table_name FROM information_schema.tables
WHERE table_name IN ('kb_categories','kb_articles') ORDER BY table_name;
```
Expected: две строки — `kb_articles`, `kb_categories`.

- [ ] **Step 4: Commit**

```bash
cd /root/loyalpro && git add backend/migrations.js
git commit -m "feat(kb): миграция таблиц kb_categories и kb_articles"
```

---

## Task 2: Чистые хелперы сервиса + тесты

**Files:**
- Create: `backend/services/knowledge-base.js`
- Test: `backend/services/knowledge-base.test.js`

- [ ] **Step 1: Написать падающий тест**

Создать `backend/services/knowledge-base.test.js`:

```javascript
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { STARTER_CATEGORIES, validateArticleInput, normalizeTags } = require('./knowledge-base');

test('STARTER_CATEGORIES: 8 папок с title/icon/display_order', () => {
  assert.strictEqual(STARTER_CATEGORIES.length, 8);
  for (const c of STARTER_CATEGORIES) {
    assert.ok(typeof c.title === 'string' && c.title.length > 0);
    assert.ok(typeof c.icon === 'string');
    assert.ok(Number.isInteger(c.display_order));
  }
  assert.strictEqual(STARTER_CATEGORIES[0].title, 'Информация о салоне и услугах');
});

test('normalizeTags: массив/строка → чистый массив строк', () => {
  assert.deepStrictEqual(normalizeTags(['a', ' b ', '', 'a']), ['a', 'b']);
  assert.deepStrictEqual(normalizeTags('x, y ,x'), ['x', 'y']);
  assert.deepStrictEqual(normalizeTags(null), []);
  assert.deepStrictEqual(normalizeTags(42), []);
});

test('validateArticleInput: title обязателен', () => {
  assert.deepStrictEqual(
    validateArticleInput({ title: '  ', category_id: 1 }),
    { valid: false, error: 'title обязателен' }
  );
});

test('validateArticleInput: category_id должен быть целым', () => {
  assert.deepStrictEqual(
    validateArticleInput({ title: 'ok', category_id: 'x' }),
    { valid: false, error: 'category_id обязателен' }
  );
});

test('validateArticleInput: валидный вход', () => {
  assert.deepStrictEqual(
    validateArticleInput({ title: 'Скрипт', category_id: 3 }),
    { valid: true }
  );
});
```

- [ ] **Step 2: Запустить тест — убедиться, что падает**

Run: `cd /root/loyalpro/backend && node services/knowledge-base.test.js`
Expected: FAIL — `Cannot find module './knowledge-base'`.

- [ ] **Step 3: Реализовать сервис**

Создать `backend/services/knowledge-base.js`:

```javascript
'use strict';

// Стартовый набор папок, создаётся при первом заходе (когда категорий 0).
// display_order повторяет нумерацию разделов из спеки (3-й у клиента не показан).
const STARTER_CATEGORIES = [
  { title: 'Информация о салоне и услугах', icon: '📋', display_order: 1 },
  { title: 'Скрипты для клиентов',          icon: '💬', display_order: 2 },
  { title: 'Отмены, переносы, опоздания',    icon: '📅', display_order: 4 },
  { title: 'Жалобы и конфликты',             icon: '⚠️', display_order: 5 },
  { title: 'Полномочия администратора',      icon: '🛡', display_order: 6 },
  { title: 'Чек-листы смены',                icon: '✅', display_order: 7 },
  { title: 'Документы и регламенты',         icon: '📁', display_order: 8 },
  { title: 'Лояльность и акции',             icon: '🎁', display_order: 9 },
];

// Приводит теги (массив или строку "a, b") к уникальному массиву непустых строк.
function normalizeTags(tags) {
  let arr;
  if (Array.isArray(tags)) arr = tags;
  else if (typeof tags === 'string') arr = tags.split(',');
  else return [];
  const seen = new Set();
  const out = [];
  for (const t of arr) {
    const s = String(t).trim();
    if (s && !seen.has(s)) { seen.add(s); out.push(s); }
  }
  return out;
}

// Валидация входа статьи для POST/PUT.
function validateArticleInput(body) {
  if (!body || typeof body.title !== 'string' || body.title.trim() === '') {
    return { valid: false, error: 'title обязателен' };
  }
  if (!Number.isInteger(body.category_id)) {
    return { valid: false, error: 'category_id обязателен' };
  }
  return { valid: true };
}

module.exports = { STARTER_CATEGORIES, validateArticleInput, normalizeTags };
```

- [ ] **Step 4: Запустить тест — убедиться, что проходит**

Run: `cd /root/loyalpro/backend && node services/knowledge-base.test.js`
Expected: PASS — все тесты зелёные, `pass 5`.

- [ ] **Step 5: Commit**

```bash
cd /root/loyalpro && git add backend/services/knowledge-base.js backend/services/knowledge-base.test.js
git commit -m "feat(kb): чистые хелперы сервиса + юнит-тесты"
```

---

## Task 3: Роутер /api/kb (категории)

**Files:**
- Create: `backend/routes/knowledge-base.js`
- Modify: `backend/routes/index.js`
- Modify: `backend/config.js`

- [ ] **Step 1: Создать роутер с категориями (+ seed)**

Создать `backend/routes/knowledge-base.js`:

```javascript
'use strict';

const router = require('express').Router();
const { db } = require('../db');
const { auth, requireRole } = require('../middleware/auth');
const { validateReorderPayload } = require('../services/portfolio');
const {
  STARTER_CATEGORIES, validateArticleInput, normalizeTags,
} = require('../services/knowledge-base');
const { createLogger } = require('../logger');
const logger = createLogger('KnowledgeBase');

const readAny  = [auth];                              // читают все роли
const adminOnly = [auth, requireRole('owner', 'admin')];

// ── Categories ────────────────────────────────────────────────

// Создаёт стартовые папки, если у салона их ещё нет (idempotent).
async function seedIfEmpty(salonId) {
  const row = await db.one(
    `SELECT COUNT(*)::int AS n FROM kb_categories WHERE salon_id=$1`, [salonId]);
  if (row.n > 0) return;
  for (const c of STARTER_CATEGORIES) {
    await db.query(
      `INSERT INTO kb_categories (salon_id, title, icon, display_order)
       VALUES ($1,$2,$3,$4)`,
      [salonId, c.title, c.icon, c.display_order]);
  }
  logger.info(`seeded ${STARTER_CATEGORIES.length} categories for salon ${salonId}`);
}

// GET /api/kb/categories — папки с числом опубликованных статей
router.get('/categories', readAny, async (req, res) => {
  try {
    await seedIfEmpty(req.user.salonId);
    const rows = await db.any(
      `SELECT c.id, c.title, c.icon, c.display_order,
              (SELECT COUNT(*) FROM kb_articles a
                WHERE a.salon_id=c.salon_id AND a.category_id=c.id
                  AND a.is_published=true) AS articles_count
         FROM kb_categories c
        WHERE c.salon_id=$1
        ORDER BY c.display_order ASC, c.id ASC`,
      [req.user.salonId]);
    res.json({ categories: rows });
  } catch (e) {
    logger.error(`GET /categories: ${e.message}`);
    res.status(500).json({ error: 'Ошибка загрузки категорий' });
  }
});

// PUT /api/kb/categories/reorder — батч display_order (ДО /:id!)
router.put('/categories/reorder', adminOnly, async (req, res) => {
  const { order } = req.body || {};
  const v = validateReorderPayload(order);
  if (!v.valid) return res.status(400).json({ error: v.error });
  try {
    for (const { id, display_order } of order) {
      await db.query(
        `UPDATE kb_categories SET display_order=$1, updated_at=now()
          WHERE id=$2 AND salon_id=$3`,
        [display_order, id, req.user.salonId]);
    }
    res.json({ ok: true });
  } catch (e) {
    logger.error(`PUT /categories/reorder: ${e.message}`);
    res.status(500).json({ error: 'Ошибка сортировки' });
  }
});

// POST /api/kb/categories — создать папку
router.post('/categories', adminOnly, async (req, res) => {
  const title = (req.body?.title || '').trim();
  const icon  = (req.body?.icon  || '').trim();
  if (!title) return res.status(400).json({ error: 'title обязателен' });
  try {
    const next = await db.one(
      `SELECT COALESCE(MAX(display_order),0)+1 AS next
         FROM kb_categories WHERE salon_id=$1`, [req.user.salonId]);
    const row = await db.one(
      `INSERT INTO kb_categories (salon_id, title, icon, display_order)
       VALUES ($1,$2,$3,$4) RETURNING id, title, icon, display_order`,
      [req.user.salonId, title, icon, next.next]);
    res.json({ category: row });
  } catch (e) {
    logger.error(`POST /categories: ${e.message}`);
    res.status(500).json({ error: 'Ошибка создания папки' });
  }
});

// PUT /api/kb/categories/:id — переименовать/сменить иконку
router.put('/categories/:id', adminOnly, async (req, res) => {
  const title = (req.body?.title || '').trim();
  const icon  = (req.body?.icon  || '').trim();
  if (!title) return res.status(400).json({ error: 'title обязателен' });
  try {
    const row = await db.oneOrNone(
      `UPDATE kb_categories SET title=$1, icon=$2, updated_at=now()
        WHERE id=$3 AND salon_id=$4
        RETURNING id, title, icon, display_order`,
      [title, icon, req.params.id, req.user.salonId]);
    if (!row) return res.status(404).json({ error: 'Папка не найдена' });
    res.json({ category: row });
  } catch (e) {
    logger.error(`PUT /categories/:id: ${e.message}`);
    res.status(500).json({ error: 'Ошибка обновления папки' });
  }
});

// DELETE /api/kb/categories/:id — удалить папку (каскадом статьи)
router.delete('/categories/:id', adminOnly, async (req, res) => {
  try {
    const row = await db.oneOrNone(
      `DELETE FROM kb_categories WHERE id=$1 AND salon_id=$2 RETURNING id`,
      [req.params.id, req.user.salonId]);
    if (!row) return res.status(404).json({ error: 'Папка не найдена' });
    res.json({ ok: true });
  } catch (e) {
    logger.error(`DELETE /categories/:id: ${e.message}`);
    res.status(500).json({ error: 'Ошибка удаления папки' });
  }
});

module.exports = router;
```

- [ ] **Step 2: Смонтировать роутер в index.js**

В `backend/routes/index.js`, в блоке specific-prefix (рядом с `/api/portfolio`), добавить строку:

```javascript
  app.use('/api/kb',                require('./knowledge-base'));
```

- [ ] **Step 3: Открыть доступ специалистам в config.js**

В `backend/config.js` заменить строку `SPECIALIST_ALLOWED_PREFIXES: [...]`, добавив `'/api/kb'`:

```javascript
  SPECIALIST_ALLOWED_PREFIXES: ['/api/home-care', '/api/auth', '/api/template-settings', '/api/patient-portfolio', '/api/analytics/staff-dashboard', '/api/medical-cert', '/api/kb'],
```

- [ ] **Step 4: Рестарт и проверка категорий (seed)**

Run: `pm2 restart loyalpro && sleep 2`
Затем через `mcp__postgres__query`:
```sql
SELECT title, icon, display_order FROM kb_categories ORDER BY display_order LIMIT 3;
```
Expected: Первый вызов `GET /categories` ещё не был — категорий может не быть. Сделать HTTP-проверку в следующем шаге; здесь допускается пустой результат до первого GET.

- [ ] **Step 5: Проверить endpoint по HTTP (seed срабатывает)**

Run (нужен валидный токен owner/admin из localStorage dev-сессии; при отсутствии — пропустить на E2E Task 6):
```bash
curl -s http://localhost:3001/api/kb/categories -H "Authorization: Bearer $KB_TOKEN" | head -c 400
```
Expected: JSON `{"categories":[...]}` с 8 папками (seed сработал при первом GET).

- [ ] **Step 6: Commit**

```bash
cd /root/loyalpro && git add backend/routes/knowledge-base.js backend/routes/index.js backend/config.js
git commit -m "feat(kb): роутер категорий /api/kb + seed + доступ специалистам"
```

---

## Task 4: Роутер /api/kb (статьи + поиск)

**Files:**
- Modify: `backend/routes/knowledge-base.js` (добавить перед `module.exports = router;`)

- [ ] **Step 1: Добавить endpoints статей**

В `backend/routes/knowledge-base.js`, перед строкой `module.exports = router;`, вставить:

```javascript
// ── Articles ──────────────────────────────────────────────────

// GET /api/kb/articles?q=&category_id=&tag= — поиск/список опубликованных
router.get('/articles', readAny, async (req, res) => {
  const q         = (req.query.q || '').trim();
  const catId     = req.query.category_id ? parseInt(req.query.category_id, 10) : null;
  const tag       = (req.query.tag || '').trim();
  try {
    const params = [req.user.salonId];
    const where  = ['a.salon_id=$1', 'a.is_published=true'];

    if (catId) { params.push(catId); where.push(`a.category_id=$${params.length}`); }
    if (tag)   { params.push(tag);   where.push(`$${params.length} = ANY(a.tags)`); }

    let rankSelect = 'NULL::real AS rank';
    let snippetSelect = "left(a.body, 200) AS snippet";
    let orderBy = 'a.display_order ASC, a.id ASC';

    if (q) {
      params.push(q);
      const qp = `$${params.length}`;
      where.push(`(a.search_vector @@ plainto_tsquery('russian', ${qp})
                   OR a.title ILIKE '%'||${qp}||'%'
                   OR a.body  ILIKE '%'||${qp}||'%')`);
      rankSelect = `ts_rank(a.search_vector, plainto_tsquery('russian', ${qp})) AS rank`;
      snippetSelect = `ts_headline('russian', a.body, plainto_tsquery('russian', ${qp}),
                        'MaxWords=30, MinWords=15, ShortWord=2, HighlightAll=false') AS snippet`;
      orderBy = 'rank DESC, a.display_order ASC';
    }

    const rows = await db.any(
      `SELECT a.id, a.category_id, a.title, a.tags, a.display_order,
              ${snippetSelect}, ${rankSelect}
         FROM kb_articles a
        WHERE ${where.join(' AND ')}
        ORDER BY ${orderBy}
        LIMIT 100`,
      params);
    res.json({ articles: rows });
  } catch (e) {
    logger.error(`GET /articles: ${e.message}`);
    res.status(500).json({ error: 'Ошибка поиска' });
  }
});

// GET /api/kb/articles/:id — одна статья целиком
router.get('/articles/:id', readAny, async (req, res) => {
  try {
    const row = await db.oneOrNone(
      `SELECT id, category_id, title, body, tags, is_published, display_order
         FROM kb_articles WHERE id=$1 AND salon_id=$2`,
      [req.params.id, req.user.salonId]);
    if (!row) return res.status(404).json({ error: 'Статья не найдена' });
    res.json({ article: row });
  } catch (e) {
    logger.error(`GET /articles/:id: ${e.message}`);
    res.status(500).json({ error: 'Ошибка загрузки статьи' });
  }
});

// PUT /api/kb/articles/reorder — батч display_order в пределах папки (ДО /:id!)
router.put('/articles/reorder', adminOnly, async (req, res) => {
  const { order } = req.body || {};
  const v = validateReorderPayload(order);
  if (!v.valid) return res.status(400).json({ error: v.error });
  try {
    for (const { id, display_order } of order) {
      await db.query(
        `UPDATE kb_articles SET display_order=$1, updated_at=now()
          WHERE id=$2 AND salon_id=$3`,
        [display_order, id, req.user.salonId]);
    }
    res.json({ ok: true });
  } catch (e) {
    logger.error(`PUT /articles/reorder: ${e.message}`);
    res.status(500).json({ error: 'Ошибка сортировки' });
  }
});

// POST /api/kb/articles — создать статью
router.post('/articles', adminOnly, async (req, res) => {
  const body = req.body || {};
  if (typeof body.category_id === 'string') body.category_id = parseInt(body.category_id, 10);
  const v = validateArticleInput(body);
  if (!v.valid) return res.status(400).json({ error: v.error });
  try {
    // категория обязана принадлежать этому же салону
    const cat = await db.oneOrNone(
      `SELECT id FROM kb_categories WHERE id=$1 AND salon_id=$2`,
      [body.category_id, req.user.salonId]);
    if (!cat) return res.status(400).json({ error: 'Папка не найдена' });

    const tags = normalizeTags(body.tags);
    const next = await db.one(
      `SELECT COALESCE(MAX(display_order),0)+1 AS next
         FROM kb_articles WHERE salon_id=$1 AND category_id=$2`,
      [req.user.salonId, body.category_id]);
    const row = await db.one(
      `INSERT INTO kb_articles
         (salon_id, category_id, title, body, tags, is_published, display_order)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       RETURNING id, category_id, title, body, tags, is_published, display_order`,
      [req.user.salonId, body.category_id, body.title.trim(),
       body.body || '', tags, body.is_published !== false, next.next]);
    res.json({ article: row });
  } catch (e) {
    logger.error(`POST /articles: ${e.message}`);
    res.status(500).json({ error: 'Ошибка создания статьи' });
  }
});

// PUT /api/kb/articles/:id — редактировать статью
router.put('/articles/:id', adminOnly, async (req, res) => {
  const body = req.body || {};
  if (typeof body.category_id === 'string') body.category_id = parseInt(body.category_id, 10);
  const v = validateArticleInput(body);
  if (!v.valid) return res.status(400).json({ error: v.error });
  try {
    const cat = await db.oneOrNone(
      `SELECT id FROM kb_categories WHERE id=$1 AND salon_id=$2`,
      [body.category_id, req.user.salonId]);
    if (!cat) return res.status(400).json({ error: 'Папка не найдена' });

    const tags = normalizeTags(body.tags);
    const row = await db.oneOrNone(
      `UPDATE kb_articles
          SET category_id=$1, title=$2, body=$3, tags=$4,
              is_published=$5, updated_at=now()
        WHERE id=$6 AND salon_id=$7
        RETURNING id, category_id, title, body, tags, is_published, display_order`,
      [body.category_id, body.title.trim(), body.body || '', tags,
       body.is_published !== false, req.params.id, req.user.salonId]);
    if (!row) return res.status(404).json({ error: 'Статья не найдена' });
    res.json({ article: row });
  } catch (e) {
    logger.error(`PUT /articles/:id: ${e.message}`);
    res.status(500).json({ error: 'Ошибка обновления статьи' });
  }
});

// DELETE /api/kb/articles/:id — удалить статью
router.delete('/articles/:id', adminOnly, async (req, res) => {
  try {
    const row = await db.oneOrNone(
      `DELETE FROM kb_articles WHERE id=$1 AND salon_id=$2 RETURNING id`,
      [req.params.id, req.user.salonId]);
    if (!row) return res.status(404).json({ error: 'Статья не найдена' });
    res.json({ ok: true });
  } catch (e) {
    logger.error(`DELETE /articles/:id: ${e.message}`);
    res.status(500).json({ error: 'Ошибка удаления статьи' });
  }
});
```

- [ ] **Step 2: Рестарт**

Run: `pm2 restart loyalpro && sleep 2 && pm2 logs loyalpro --lines 15 --nostream`
Expected: без ошибок загрузки модуля.

- [ ] **Step 3: Smoke-проверка поиска (MCP postgres — прямой SQL)**

Через `mcp__postgres__query` вставить временную статью и проверить поиск (замените `<CID>` на id первой категории, `<SID>` на salon_id dev-салона):
```sql
INSERT INTO kb_articles (salon_id, category_id, title, body, tags)
VALUES (<SID>, <CID>, 'Возражение дорого', 'Скрипт: если клиент говорит что процедура дорогая, подчеркните ценность и результат.', ARRAY['продажи']);

SELECT title,
  ts_rank(search_vector, plainto_tsquery('russian','дорогая')) AS rank,
  ts_headline('russian', body, plainto_tsquery('russian','дорогая')) AS snippet
FROM kb_articles WHERE salon_id=<SID>
  AND search_vector @@ plainto_tsquery('russian','дорогая');
```
Expected: строка «Возражение дорого» с rank > 0 и сниппетом, где `<b>дорогая</b>` подсвечено (морфология: «дорогая» находит «дорогую»). После проверки удалить: `DELETE FROM kb_articles WHERE title='Возражение дорого' AND salon_id=<SID>;`

- [ ] **Step 4: Commit**

```bash
cd /root/loyalpro && git add backend/routes/knowledge-base.js
git commit -m "feat(kb): endpoints статей + русский полнотекстовый поиск"
```

---

## Task 5: Markdown-рендерер (чистый) + тесты

**Files:**
- Create: `frontend/js/pages/kb-markdown.js`
- Test: `frontend/js/pages/kb-markdown.test.js`

- [ ] **Step 1: Написать падающий тест**

Создать `frontend/js/pages/kb-markdown.test.js`:

```javascript
const { test } = require('node:test');
const assert = require('node:assert');
const { kbMarkdown } = require('./kb-markdown');

test('экранирует HTML', () => {
  assert.ok(kbMarkdown('<script>x</script>').includes('&lt;script&gt;'));
  assert.ok(!kbMarkdown('<script>x</script>').includes('<script>x'));
});

test('заголовок # → <h3>', () => {
  assert.ok(kbMarkdown('# Привет').includes('<h3'));
  assert.ok(kbMarkdown('# Привет').includes('Привет'));
});

test('жирный **x** → <strong>', () => {
  assert.ok(kbMarkdown('это **важно** да').includes('<strong>важно</strong>'));
});

test('чекбокс - [ ] → input type=checkbox', () => {
  const html = kbMarkdown('- [ ] проверить записи');
  assert.ok(html.includes('type="checkbox"'));
  assert.ok(html.includes('data-kb-check="0"'));
  assert.ok(!html.includes('checked'));
  assert.ok(html.includes('проверить записи'));
});

test('чекбокс - [x] → checked', () => {
  assert.ok(kbMarkdown('- [x] готово').includes('checked'));
});

test('обычный список - item → <li>', () => {
  const html = kbMarkdown('- первый\n- второй');
  assert.ok(html.includes('<li>первый</li>'));
  assert.ok(html.includes('<li>второй</li>'));
});

test('код-блок ``` → <pre> с кнопкой копирования', () => {
  const html = kbMarkdown('```\nПривет, {name}!\n```');
  assert.ok(html.includes('<pre'));
  assert.ok(html.includes('kb-copy'));
  assert.ok(html.includes('Привет, {name}!'));
});
```

- [ ] **Step 2: Запустить — убедиться, что падает**

Run: `cd /root/loyalpro/frontend && node js/pages/kb-markdown.test.js`
Expected: FAIL — `Cannot find module './kb-markdown'`.

- [ ] **Step 3: Реализовать рендерер**

Создать `frontend/js/pages/kb-markdown.js`:

```javascript
// frontend/js/pages/kb-markdown.js
// Минимальный markdown→HTML рендерер для статей базы знаний.
// Чистая функция: в браузере глобальна (window.kbMarkdown), в Node экспортируется.
'use strict';

function kbEsc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Инлайн-разметка внутри уже экранированной строки: **жирный**.
function kbInline(escaped) {
  return escaped.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
}

function kbMarkdown(src) {
  const lines = String(src ?? '').replace(/\r\n/g, '\n').split('\n');
  const out = [];
  let listBuf = null;      // 'ul' пока копим <li>
  let checkIdx = 0;        // сквозной индекс чекбоксов для localStorage
  let i = 0;

  const flushList = () => {
    if (listBuf) { out.push(`<ul class="kb-ul">${listBuf}</ul>`); listBuf = null; }
  };

  while (i < lines.length) {
    const line = lines[i];

    // код-блок ```
    if (line.trim().startsWith('```')) {
      flushList();
      const buf = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith('```')) {
        buf.push(kbEsc(lines[i])); i++;
      }
      i++; // закрывающая ```
      out.push(
        `<div class="kb-code"><button type="button" class="kb-copy" title="Копировать">⧉</button>` +
        `<pre><code>${buf.join('\n')}</code></pre></div>`);
      continue;
    }

    // чекбокс - [ ] / - [x]
    const cb = line.match(/^\s*-\s*\[( |x|X)\]\s+(.*)$/);
    if (cb) {
      flushList();
      const checked = cb[1].toLowerCase() === 'x' ? ' checked' : '';
      out.push(
        `<label class="kb-check"><input type="checkbox" data-kb-check="${checkIdx}"${checked}> ` +
        `<span>${kbInline(kbEsc(cb[2]))}</span></label>`);
      checkIdx++;
      i++; continue;
    }

    // заголовки # ## ###  → h3/h4/h5 (h1/h2 занят layout-ом страницы)
    const h = line.match(/^(#{1,3})\s+(.*)$/);
    if (h) {
      flushList();
      const lvl = Math.min(5, h[1].length + 2);
      out.push(`<h${lvl} class="kb-h">${kbInline(kbEsc(h[2]))}</h${lvl}>`);
      i++; continue;
    }

    // обычный список - item
    const li = line.match(/^\s*-\s+(.*)$/);
    if (li) {
      listBuf = (listBuf || '') + `<li>${kbInline(kbEsc(li[1]))}</li>`;
      i++; continue;
    }

    // пустая строка
    if (line.trim() === '') { flushList(); i++; continue; }

    // абзац
    flushList();
    out.push(`<p>${kbInline(kbEsc(line))}</p>`);
    i++;
  }
  flushList();
  return out.join('\n');
}

if (typeof window !== 'undefined') { window.kbMarkdown = kbMarkdown; window.kbEsc = kbEsc; }
if (typeof module !== 'undefined' && module.exports) { module.exports = { kbMarkdown, kbEsc }; }
```

- [ ] **Step 4: Запустить — убедиться, что проходит**

Run: `cd /root/loyalpro/frontend && node js/pages/kb-markdown.test.js`
Expected: PASS — `pass 7`.

- [ ] **Step 5: Commit**

```bash
cd /root/loyalpro && git add frontend/js/pages/kb-markdown.js frontend/js/pages/kb-markdown.test.js
git commit -m "feat(kb): чистый markdown-рендерер с чекбоксами и код-блоками + тесты"
```

---

## Task 6: Страница SPA + интеграция

**Files:**
- Create: `frontend/js/pages/knowledge-base.js`
- Modify: `frontend/index.html`
- Modify: `frontend/js/core/nav.js`

- [ ] **Step 1: Добавить пункт меню, контейнер страницы и скрипты в index.html**

В `frontend/index.html`, в `#mainNav` (рядом со строкой `<div class="tn" data-p="settings" ...>`), добавить пункт с доступом всем ролям:

```html
      <div class="tn" data-p="knowledge-base" data-roles="owner,admin,specialist" onclick="nav(this)">База знаний</div>
```

Аналогичный пункт добавить в мобильный `#mnavList` (там, где перечислены остальные `data-p` пункты drawer — скопировать соседний пункт и заменить `data-p`/текст, сохранив `data-roles`).

Добавить контейнер страницы рядом с другими `<div class="page" ...>` (например, после `#page-settings`):

```html
    <div class="page" id="page-knowledge-base">
      <div class="kb-wrap">
        <div class="kb-topbar">
          <input id="kb-search" class="kb-search" type="search" placeholder="Поиск по базе знаний…" autocomplete="off">
          <button id="kb-add-article" class="btn-pri kb-admin-only" type="button">+ Статья</button>
        </div>
        <div class="kb-body">
          <aside id="kb-folders" class="kb-folders"></aside>
          <section id="kb-content" class="kb-content"></section>
        </div>
      </div>
    </div>
```

Перед `<script src="js/app.js"></script>` добавить:

```html
<script src="js/pages/kb-markdown.js"></script>
<script src="js/pages/knowledge-base.js"></script>
```

- [ ] **Step 2: Добавить хук инициализации в nav.js**

В `frontend/js/core/nav.js`, в функции `navTo`, среди прочих `if (p === ...)` добавить:

```javascript
  if (p === 'knowledge-base') loadKnowledgeBase();
```

- [ ] **Step 3: Реализовать страницу knowledge-base.js**

Создать `frontend/js/pages/knowledge-base.js`:

```javascript
// ── База знаний администратора ─────────────────────────────────
'use strict';

let _kbCats = [];
let _kbActiveCat = null;       // id выбранной папки или null (все)
let _kbSearchTimer = null;

const _kbCanEdit = () => ME && (ME.role === 'owner' || ME.role === 'admin');

async function loadKnowledgeBase() {
  document.body.classList.toggle('kb-editor', _kbCanEdit());
  try {
    const data = await api('GET', '/api/kb/categories');
    _kbCats = data.categories || [];
    renderKbFolders();
    await kbRunSearch();
    kbBindOnce();
  } catch (e) {
    document.getElementById('kb-content').innerHTML =
      `<div class="kb-empty">Ошибка загрузки: ${kbEsc(e.message)}</div>`;
  }
}

let _kbBound = false;
function kbBindOnce() {
  if (_kbBound) return; _kbBound = true;

  document.getElementById('kb-search').addEventListener('input', () => {
    clearTimeout(_kbSearchTimer);
    _kbSearchTimer = setTimeout(kbRunSearch, 250);
  });
  document.getElementById('kb-add-article').addEventListener('click', () => kbOpenArticleModal(null));

  // делегирование: клики по чекбоксам и кнопкам копирования внутри статьи
  document.getElementById('kb-content').addEventListener('click', (ev) => {
    const copy = ev.target.closest('.kb-copy');
    if (copy) {
      const code = copy.parentElement.querySelector('code');
      if (code) navigator.clipboard.writeText(code.innerText).then(() => {
        copy.textContent = '✓'; setTimeout(() => (copy.textContent = '⧉'), 1200);
      });
    }
  });
}

function renderKbFolders() {
  const el = document.getElementById('kb-folders');
  const all = `<div class="kb-folder ${_kbActiveCat === null ? 'active' : ''}" data-cat="">
      📚 Все разделы</div>`;
  const items = _kbCats.map(c => `
    <div class="kb-folder ${_kbActiveCat === c.id ? 'active' : ''}" data-cat="${c.id}">
      <span>${kbEsc(c.icon)} ${kbEsc(c.title)}</span>
      <span class="kb-count">${c.articles_count}</span>
    </div>`).join('');
  const addBtn = _kbCanEdit()
    ? `<button class="btn-sec kb-admin-only" id="kb-add-folder" type="button">+ Папка</button>` : '';
  el.innerHTML = all + items + addBtn;

  el.querySelectorAll('.kb-folder').forEach(f => f.addEventListener('click', () => {
    const v = f.dataset.cat;
    _kbActiveCat = v === '' ? null : parseInt(v, 10);
    renderKbFolders();
    kbRunSearch();
  }));
  const addFolder = document.getElementById('kb-add-folder');
  if (addFolder) addFolder.addEventListener('click', kbCreateFolder);
}

async function kbRunSearch() {
  const q = document.getElementById('kb-search').value.trim();
  const params = new URLSearchParams();
  if (q) params.set('q', q);
  if (_kbActiveCat) params.set('category_id', _kbActiveCat);
  const content = document.getElementById('kb-content');
  try {
    const data = await api('GET', '/api/kb/articles?' + params.toString());
    const arts = data.articles || [];
    if (!arts.length) {
      content.innerHTML = `<div class="kb-empty">Ничего не найдено.
        ${_kbCanEdit() ? 'Добавьте статью кнопкой «+ Статья».' : ''}</div>`;
      return;
    }
    content.innerHTML = arts.map(a => `
      <div class="kb-card" data-id="${a.id}">
        <div class="kb-card-title">${kbEsc(a.title)}</div>
        <div class="kb-card-snippet">${a.snippet || ''}</div>
        <div class="kb-card-tags">${(a.tags || []).map(t => `<span class="kb-tag">${kbEsc(t)}</span>`).join('')}</div>
      </div>`).join('');
    content.querySelectorAll('.kb-card').forEach(card =>
      card.addEventListener('click', () => kbOpenArticle(parseInt(card.dataset.id, 10))));
  } catch (e) {
    content.innerHTML = `<div class="kb-empty">Ошибка поиска: ${kbEsc(e.message)}</div>`;
  }
}

async function kbOpenArticle(id) {
  try {
    const { article } = await api('GET', '/api/kb/articles/' + id);
    const content = document.getElementById('kb-content');
    const editBtns = _kbCanEdit()
      ? `<button class="btn-sec" id="kb-edit-art" type="button">Редактировать</button>
         <button class="btn-sec" id="kb-del-art" type="button">Удалить</button>` : '';
    content.innerHTML = `
      <div class="kb-article">
        <button class="btn-sec" id="kb-back" type="button">← Назад</button>
        <h2 class="kb-article-title">${kbEsc(article.title)}</h2>
        <div class="kb-article-body">${kbMarkdown(article.body)}</div>
        <div class="kb-article-actions">${editBtns}</div>
      </div>`;
    // восстановить состояние чекбоксов из localStorage
    const key = 'kbcheck_' + id;
    const saved = JSON.parse(localStorage.getItem(key) || '{}');
    content.querySelectorAll('input[data-kb-check]').forEach(inp => {
      const idx = inp.dataset.kbCheck;
      if (saved[idx]) inp.checked = true;
      inp.addEventListener('change', () => {
        saved[idx] = inp.checked;
        localStorage.setItem(key, JSON.stringify(saved));
      });
    });
    document.getElementById('kb-back').addEventListener('click', kbRunSearch);
    const eb = document.getElementById('kb-edit-art');
    if (eb) eb.addEventListener('click', () => kbOpenArticleModal(article));
    const db = document.getElementById('kb-del-art');
    if (db) db.addEventListener('click', () => kbDeleteArticle(id));
  } catch (e) {
    alert('Ошибка: ' + e.message);
  }
}

async function kbCreateFolder() {
  const title = prompt('Название папки:');
  if (!title || !title.trim()) return;
  const icon = prompt('Иконка (эмодзи, можно пусто):', '📄') || '';
  try {
    await api('POST', '/api/kb/categories', { title: title.trim(), icon: icon.trim() });
    await loadKnowledgeBase();
  } catch (e) { alert('Ошибка: ' + e.message); }
}

function kbOpenArticleModal(article) {
  const isEdit = !!article;
  const opts = _kbCats.map(c =>
    `<option value="${c.id}" ${article && article.category_id === c.id ? 'selected' : ''}>${kbEsc(c.title)}</option>`).join('');
  const wrap = document.createElement('div');
  wrap.className = 'kb-modal-ov';
  wrap.innerHTML = `
    <div class="kb-modal">
      <h3>${isEdit ? 'Редактировать статью' : 'Новая статья'}</h3>
      <div class="fg"><label class="fl">Заголовок</label>
        <input id="kbm-title" type="text" value="${isEdit ? kbEsc(article.title) : ''}"></div>
      <div class="fg"><label class="fl">Папка</label>
        <select id="kbm-cat">${opts}</select></div>
      <div class="fg"><label class="fl">Теги (через запятую)</label>
        <input id="kbm-tags" type="text" value="${isEdit ? kbEsc((article.tags || []).join(', ')) : ''}"></div>
      <div class="fg"><label class="fl">Текст (markdown: # заголовок, **жирный**, - список, - [ ] чекбокс, \`\`\` код)</label>
        <textarea id="kbm-body" rows="12">${isEdit ? kbEsc(article.body) : ''}</textarea></div>
      <div class="kb-modal-actions">
        <button class="btn-sec" id="kbm-cancel" type="button">Отмена</button>
        <button class="btn-pri" id="kbm-save" type="button">Сохранить</button>
      </div>
    </div>`;
  document.body.appendChild(wrap);
  const close = () => wrap.remove();
  wrap.querySelector('#kbm-cancel').addEventListener('click', close);
  wrap.addEventListener('click', e => { if (e.target === wrap) close(); });
  wrap.querySelector('#kbm-save').addEventListener('click', async () => {
    const payload = {
      title: wrap.querySelector('#kbm-title').value.trim(),
      category_id: parseInt(wrap.querySelector('#kbm-cat').value, 10),
      tags: wrap.querySelector('#kbm-tags').value,
      body: wrap.querySelector('#kbm-body').value,
    };
    if (!payload.title) { alert('Введите заголовок'); return; }
    try {
      if (isEdit) await api('PUT', '/api/kb/articles/' + article.id, payload);
      else        await api('POST', '/api/kb/articles', payload);
      close();
      await loadKnowledgeBase();
    } catch (e) { alert('Ошибка: ' + e.message); }
  });
}

async function kbDeleteArticle(id) {
  if (!confirm('Удалить статью?')) return;
  try {
    await api('DELETE', '/api/kb/articles/' + id);
    await loadKnowledgeBase();
  } catch (e) { alert('Ошибка: ' + e.message); }
}
```

- [ ] **Step 4: Добавить стили**

В `frontend/index.html` найти существующий `<style>` блок (внутри `<head>`) и добавить в его конец:

```css
.kb-wrap { padding: 16px; }
.kb-topbar { display: flex; gap: 12px; margin-bottom: 16px; }
.kb-search { flex: 1; padding: 12px 16px; font-size: 16px; border-radius: 12px;
  border: 1px solid var(--border, #ddd); background: var(--card, #fff); color: inherit; }
.kb-body { display: flex; gap: 16px; align-items: flex-start; }
.kb-folders { width: 260px; flex-shrink: 0; display: flex; flex-direction: column; gap: 6px; }
.kb-folder { display: flex; justify-content: space-between; align-items: center; gap: 8px;
  padding: 10px 14px; border-radius: 10px; cursor: pointer; background: var(--card, #fff); }
.kb-folder:hover { background: var(--hover, #f2f2f7); }
.kb-folder.active { background: var(--accent, #6c5ce7); color: #fff; }
.kb-count { font-size: 12px; opacity: .7; }
.kb-content { flex: 1; display: flex; flex-direction: column; gap: 12px; min-width: 0; }
.kb-card { padding: 14px 16px; border-radius: 12px; background: var(--card, #fff);
  cursor: pointer; border: 1px solid var(--border, #eee); }
.kb-card:hover { border-color: var(--accent, #6c5ce7); }
.kb-card-title { font-weight: 600; margin-bottom: 4px; }
.kb-card-snippet { font-size: 14px; opacity: .8; }
.kb-card-snippet b { background: rgba(255,214,0,.4); }
.kb-tag { display: inline-block; font-size: 12px; padding: 2px 8px; border-radius: 8px;
  background: var(--hover, #eee); margin-right: 6px; margin-top: 6px; }
.kb-empty { padding: 40px; text-align: center; opacity: .6; }
.kb-article-body { line-height: 1.6; }
.kb-article-body .kb-h { margin: 16px 0 8px; }
.kb-article-body .kb-check { display: flex; align-items: flex-start; gap: 8px; padding: 4px 0; }
.kb-code { position: relative; margin: 12px 0; }
.kb-code pre { background: #1e1e2e; color: #eee; padding: 14px; border-radius: 10px; overflow-x: auto; }
.kb-copy { position: absolute; top: 8px; right: 8px; background: rgba(255,255,255,.15);
  border: none; color: #fff; border-radius: 6px; padding: 4px 8px; cursor: pointer; }
.kb-admin-only { display: none; }
body.kb-editor .kb-admin-only { display: inline-flex; }
.kb-modal-ov { position: fixed; inset: 0; background: rgba(0,0,0,.5); display: flex;
  align-items: center; justify-content: center; z-index: 1000; padding: 16px; }
.kb-modal { background: var(--card, #fff); border-radius: 16px; padding: 20px; width: 640px;
  max-width: 100%; max-height: 90vh; overflow-y: auto; }
.kb-modal-actions, .kb-article-actions { display: flex; gap: 10px; justify-content: flex-end; margin-top: 12px; }
@media (max-width: 720px) { .kb-body { flex-direction: column; } .kb-folders { width: 100%; } }
```

- [ ] **Step 5: E2E-проверка в браузере (Playwright MCP)**

Открыть dev (`http://localhost:3001`), войти как owner/admin. Через `mcp__playwright__*`:
1. Перейти в «База знаний» → видны 8 папок (seed сработал).
2. «+ Статья» → создать статью в папке «Скрипты для клиентов»: заголовок «Возражение дорого», теги `продажи`, тело с чек-листом `- [ ] уточнить бюджет` и код-блоком со скриптом. Сохранить.
3. Ввести в поиск «дорого» → статья находится, в сниппете подсветка.
4. Открыть статью → чекбокс кликается, отметка сохраняется после ухода/возврата (localStorage).
5. Кнопка копирования у код-блока → `✓`.
6. Отредактировать и удалить статью — работает.

Expected: все пункты проходят; в консоли браузера нет ошибок.

- [ ] **Step 6: Проверка роли specialist (только чтение)**

Войти как specialist (или через другого пользователя). Ожидается: пункт «База знаний» виден, папки и статьи читаются и ищутся, кнопки «+ Статья»/«+ Папка»/«Редактировать»/«Удалить» скрыты. Прямой `PUT /api/kb/articles/:id` под specialist-токеном → 403.

- [ ] **Step 7: Прогнать все юнит-тесты**

Run:
```bash
cd /root/loyalpro/backend && node services/knowledge-base.test.js
cd /root/loyalpro/frontend && node js/pages/kb-markdown.test.js
```
Expected: оба набора — PASS.

- [ ] **Step 8: Commit**

```bash
cd /root/loyalpro && git add frontend/js/pages/knowledge-base.js frontend/index.html frontend/js/core/nav.js
git commit -m "feat(kb): страница «База знаний» — поиск, чтение, редактирование, чек-листы"
```

---

## Self-Review Notes

- **Spec coverage:** таблицы (§4) → Task 1; хелперы/seed (§7) → Task 2/3; API reads+writes (§5) → Task 3/4; поиск с подсветкой (§5) → Task 4; markdown+чекбоксы+копирование (§6) → Task 5; страница/раскладка/роли (§6, §8) → Task 6; доступ специалистам (§8) → Task 3 Step 3; юнит+E2E тесты (§10) → Task 2/5/6. Стартовые папки (§3) → `STARTER_CATEGORIES`.
- **Роли:** чтение через `readAny=[auth]` (specialist в whitelist), запись через `adminOnly=[auth, requireRole('owner','admin')]` — проверка на сервере, не только UI.
- **DRY:** `validateReorderPayload` переиспользован из `services/portfolio.js`; `kbEsc` определён один раз в рендерере и переиспользован страницей.
- **Reorder перед /:id:** объявлены до параметрических роутов (как в portfolio) — избегаем коллизии path-matcher. (Сами drag-drop UI-обработчики — вне v1-минимума страницы; endpoints готовы для последующего подключения.)
- **Имена:** `salonId` (camelCase, как в проекте), `kbMarkdown`/`kbEsc`, `_kbCats`/`_kbActiveCat` — консистентны между задачами.
```
