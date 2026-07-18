# RAG-слой базы знаний для агента (гибридный поиск + структура данных) — дизайн

**Дата:** 2026-07-18
**Статус:** черновик, на согласовании
**Ветка контекста:** `feat/admin-chat-page`

## Отношение к соседней спеке

Дополняет `2026-07-18-ai-booking-agent-design.md` (автономный агент-администратор:
Claude + tool-calling, диспетчер, эскалация, `agent_settings`). Тот документ
описывает **оркестрацию и запись**; этот — **слой знаний**: откуда и в каком
виде агент берёт факты для ответа «по существу».

**Обновляет одно решение той спеки.** Пункт «Что вне scope → векторный/
семантический поиск (остаётся FTS)» (строка 341) заменяется на **гибрид
FTS + вектор** — см. ниже. Причина: клиенты пишут своими словами («убрать
морщинки» вместо «ботулинотерапия»), и чистый FTS такие перефразировки
пропускает, что напрямую бьёт по цели «доводить до записи».

## Цель

Дать агенту быстрый и точный слой знаний, чтобы он отвечал по существу
(что за процедура, показания/противопоказания, кто делает, сколько стоит,
сколько длится) и вёл к записи. Ключевая развилка (утверждена на брейншторме
2026-07-18): **гибридный источник фактов** — живые цифры из YClients-синка,
экспертный текст из базы знаний; **гибридный поиск** — FTS + pgvector.

## Контекст (что уже есть)

- **KB:** `kb_categories`, `kb_articles (id, salon_id, category_id, title,
  body, tags[], tags_text, is_published, search_vector TSVECTOR)`. Только
  свободный текст + теги; поиск — `to_tsquery('russian')` + ILIKE-фолбэк в
  `services/kb-assistant.js` (`retrieveArticles`). Векторного поиска нет.
- **Живой каталог (синк из YClients):** `services_config (yclients_service_id,
  title, tag, ...)` — услуги; `staff_members (yclients_staff_id,
  специализация, avatar)` — мастера. Цены/длительность/состав мастеров тут
  всегда актуальны.
- **LLM-инфра:** Gemini через relay (прод геоблокирован, проксирует через
  dev) в `kb-assistant.js` — двухключевой фолбэк, relay-режим. У Anthropic
  **своего эмбеддинг-эндпоинта нет** — для векторов используем Gemini.

## Принцип структуры данных

**Разделяем «живые цифры» и «экспертный текст», связываем по ID YClients.**

- Цена / длительность / состав мастеров → берём из `services_config` /
  `staff_members` в момент ответа. В KB эти числа **не дублируем** (устаревают).
- Описания / показания / противопоказания / скрипты продаж → в `kb_articles`.
- Связь между ними → по `yclients_service_id` / `yclients_staff_id`.

## Схема (через `migrations.js`, `IF NOT EXISTS`-стиль)

### 1. `kb_article_links` — связь статьи с каталогом (новое)

```
kb_article_links
  id            bigserial PK
  salon_id      bigint NOT NULL
  article_id    bigint NOT NULL  REFERENCES kb_articles(id) ON DELETE CASCADE
  entity_type   text   NOT NULL  CHECK (entity_type IN ('service','staff'))
  entity_yc_id  bigint NOT NULL  -- yclients_service_id | yclients_staff_id
  UNIQUE (article_id, entity_type, entity_yc_id)
  INDEX (salon_id, entity_type, entity_yc_id)
```

Одна статья («Ботулинотерапия») может ссылаться на несколько услуг/мастеров.
Найдя статью, агент подтягивает **живую** цену из `services_config` по
`entity_yc_id`.

### 2. `kb_chunks` — чанки + эмбеддинги (новое, сердце поиска)

Статьи бывают длинными; эмбеддить статью целиком — терять точность. Бьём на
чанки ~200–400 токенов по заголовкам/абзацам, каждый со своим эмбеддингом.

```
kb_chunks
  id            bigserial PK
  salon_id      bigint NOT NULL
  article_id    bigint NOT NULL  REFERENCES kb_articles(id) ON DELETE CASCADE
  chunk_index   int    NOT NULL
  content       text   NOT NULL
  content_hash  text   NOT NULL  -- чтобы не переэмбеддить неизменённое
  embedding     vector(768)      -- pgvector; text-embedding-004 = 768 dims
  search_vector tsvector         -- FTS по чанку (weighted title A / body B)
  created_at, updated_at timestamptz DEFAULT now()
  UNIQUE (article_id, chunk_index)
  INDEX hnsw (embedding vector_cosine_ops)   -- ANN-поиск
  INDEX gin  (search_vector)                 -- FTS
  INDEX (salon_id)
```

Зачем «быстрее и точнее»: вектор ловит перефразировки, FTS ловит точные
термины/названия услуг, чанк отдаёт релевантный фрагмент вместо всей статьи.
Мультисалонность — всё скоупится `salon_id`.

**Фолбэк по pgvector** (см. риск №1): если `CREATE EXTENSION vector`
недоступен на Beget — колонка `embedding` становится `real[]`, ANN-индекса
нет, косинус считаем в SQL или в JS по отфильтрованному по `salon_id`
множеству (медленнее, но для небольшой KB одного салона приемлемо). Схема
чанков и весь остальной пайплайн не меняются.

## Пайплайн поиска (гибрид FTS + вектор)

На входящий запрос агента (внутри `search_knowledge_base` из соседней спеки):

1. Эмбеддим запрос — Gemini `text-embedding-004` через существующий relay.
2. **Вектор:** top-N чанков по косинусу (`salon_id` + только опубликованные
   статьи).
3. **FTS:** top-M чанков по `ts_rank` (`to_tsquery('russian')`).
4. **Слияние — Reciprocal Rank Fusion** (без обучения: `score = Σ 1/(k+rank)`)
   → top-K чанков.
5. Для услуг из связанных статей (`kb_article_links`) джойним **живые**
   цену/длительность из `services_config`, мастеров из `staff_members`.
6. Собираем компактный контекст с лимитом символов (как ≤12k в текущем
   `kb-assistant.js`), передаём в Claude.

## Поддержание эмбеддингов

- На create/update статьи в `routes/knowledge-base.js`: переразбить на чанки,
  сравнить `content_hash` по каждому чанку, переэмбеддить **только
  изменённые**, upsert в `kb_chunks`, удалить лишние (по `chunk_index`).
- Разовый backfill-скрипт для существующих статей (по образцу тестов в
  `backend/*.test.js`).
- Всё асинхронно — не блокирует ответ вебхука и сохранение статьи.

## Раскладка модулей

- `services/agent-rag.js` — чанкинг, эмбеддинг (Gemini relay), гибридный
  retrieval + RRF, сборка контекста. Чистые куски (чанкинг, RRF) —
  юнит-тестируемы без БД/HTTP (по образцу `services/portfolio.js` +
  `portfolio.test.js`).
- `services/kb-assistant.js` — переиспользуем relay-клиент Gemini для
  эмбеддингов; `retrieveArticles` остаётся как FTS-ветка гибрида.
- `routes/knowledge-base.js` — хук на create/update → переэмбеддинг.
- `migrations.js` — pgvector extension, `kb_chunks`, `kb_article_links`.
- **Фронт:** в редакторе KB — привязка статьи к услуге/мастеру
  (`kb_article_links`); список услуг/мастеров из синка. Существующие классы
  `stg-section`/`btn-pri`/`fg`/`fl`.

## Связь с инструментом агента

RAG-слой — это реализация `search_knowledge_base(query)` из соседней спеки
(таблица инструментов, «переиспользуем»). В подходе C KB-контекст можно
предзагружать наперёд (без лишнего round-trip) **или** оставить как tool для
drill-down — решается при планировании; структура данных одинакова для обоих.

## Риски / проверить на этапе плана

1. **pgvector на Beget (блокирующее).** Проверить `CREATE EXTENSION vector`
   (dev через SSH-туннель, см. память `dev_db_access_tunnel`). Нет →
   `real[]` + косинус в SQL/JS (фолбэк выше).
2. **Гео-доступ к Gemini эмбеддингам с прода** — идёт через тот же relay, что
   и `generateContent` (уже есть в `kb-assistant.js`); проверить, что
   embeddings-эндпоинт тоже проксируется.
3. **Размерность/модель эмбеддинга** — `text-embedding-004` = 768; если
   перейдём на `gemini-embedding-001` (3072/переменная) — поменять `vector(N)`.
4. **Стоимость/латентность** — эмбеддинг на каждое сообщение; кэшировать
   эмбеддинги чанков (хранятся), для запросов — опционально; prompt-caching
   Claude на system+KB-контекст.

## Этапность (рекомендация)

- **Фаза 1 (MVP RAG):** миграции (`kb_chunks`, `kb_article_links`, pgvector/
  фолбэк) → чанкинг+эмбеддинг+backfill → гибридный retrieval + RRF →
  подключить как источник контекста для ответов «по существу». Без booking.
- **Фаза 2:** связь KB↔каталог в UI + джойн живых цен; booking-инструменты
  и гейт — по соседней спеке.

## Что вне scope (YAGNI)

- Реранкер на отдельной модели (RRF достаточно для старта).
- Кросс-салонный общий индекс (всё per-`salon_id`).
- Мультиязычные эмбеддинги (русский; `text-embedding-004` мультиязычен из
  коробки).
