# Phase 03: fix-home-care-product-dropdown-missing-items — Research

**Researched:** 2026-05-10
**Domain:** PostgreSQL persistent catalog + YClients sync + Express endpoint repointing
**Confidence:** HIGH

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

**Источник дропдауна и фильтр категорий:**
- **D-01:** Dropdown показывает товары из новой таблицы каталога, **не** из `goods_sale_items`.
- **D-02:** Группировка — по `category_title` (как сейчас в `/product-tree`).
- **D-03:** Blacklist служебных категорий (хардкод-константа в `services/home-care.js`):
  - `Расходники`, `Канцелярия`, `Препараты`, `Аптека`, `Сертификаты Сеть Peri Clinic`, `Абонементы Сеть Peri Clinic`.
- **D-04:** Blacklist проверяется по `lower(trim(category_title))`. Если в будущем понадобится менять список — это правка одного массива.
- **D-05:** Архивные (`is_archived=true`) товары в дропдауне не показываются.

**Стратегия sync с YClients API:**
- **D-06:** Источник истины — `GET /goods/{cid}?category_id=N&count=200&page=K` с пагинацией до пустой страницы.
- **D-07:** `/good_categories/{cid}` ненадёжен — на PERI CLINIC возвращает HTTP 404. Использовать opportunistically.
- **D-08:** Bootstrap списка `category_id` при первом sync: попытаться `/good_categories/{cid}` → при неудаче собрать distinct `category_id` через `/goods/{cid}/{good_id}` для всех `yclients_goods_id` из `goods_sale_items`.
- **D-09:** Subsequent syncs реиспользуют `category_id`, известные из предыдущего sync.
- **D-10:** Bulk-цикл `syncGoodsCategories` (`backend/services/home-care.js:25-29`) починить попутно: `g.good_id` вместо `g.id`.
- **D-11:** Между запросами к YClients — задержка 100-200ms. Таймаут запроса — 30 секунд.
- **D-12:** Если sync категории падает на середине — продолжаем с остальными, сбойную логируем и пропускаем. Партийная атомарность не нужна.

**Архивация / исчезновение товаров:**
- **D-13:** Soft-delete с временным окном. `last_seen_at` обновляется на каждом UPSERT. В конце sync помечается `is_archived=true` для товаров с `last_seen_at < NOW() - INTERVAL '24 hours'`.
- **D-14:** Никогда не делаем hard-delete.
- **D-15:** Если архивный товар возвращается — `is_archived=false`, `last_seen_at = NOW()`. Запись остаётся та же.

**Триггеры sync:**
- **D-16:** Только cron `0 */3 * * *` Europe/Moscow. Новых cron-выражений не вводим. Порядок: сначала каталог, потом `syncGoodsCategories`.
- **D-17:** Ручной кнопки «Обновить каталог» в UI **не делаем** в этой фазе.
- **D-18:** TTL-кеша `_treeCache` для `/product-tree` — оставить существующий. Очищать `clearTreeCache(salonId)` после успешного `syncGoodsCatalog`.
- **D-19:** Если `/product-tree` запрошен до первого sync — отдаём пустой массив без блокирующего sync на запросе.

### Claude's Discretion
- Точное имя таблицы — рекомендованный вариант `yclients_goods_catalog`.
- Точная структура индексов.
- Использовать ли отдельный сервис-файл `services/yclients-goods-catalog.js` или расширить `services/home-care.js`.
- Уровень логирования (info/warn/error) — стандартный паттерн как в других синках.
- Юнит-тесты для blacklist-фильтра и нормализации категорий — да, объём решит planner.
- Поведение `service_categories` / service-tree — не трогаем.

### Deferred Ideas (OUT OF SCOPE)
- Кнопка «Обновить каталог» в UI.
- Per-salon настройка blacklist категорий.
- Per-category флаг видимости в UI настроек.
- TTL-инвалидация при первом запросе (синхронный sync на пустую таблицу).
- Hard-delete старых архивных (`is_archived AND last_seen_at < NOW() - 90 days`).
- Расширение sync на «услуги» (`service_categories`/`services`).
</user_constraints>

## Project Constraints (from CLAUDE.md)

| Directive | Implication for this phase |
|-----------|----------------------------|
| Multi-salon: every table has `salon_id` FK, every query scoped | New table MUST have `salon_id INTEGER REFERENCES salons(id) ON DELETE CASCADE`; both endpoints filter by `req.user.salonId`. |
| Migrations only via `migrations.js`, only `IF NOT EXISTS` patterns, never destructive | New `CREATE TABLE IF NOT EXISTS yclients_goods_catalog (…)` block plus `CREATE INDEX IF NOT EXISTS`. |
| No ORM — raw `pg` pool with `db.{query,one,oneOrNone,many,any}` helpers | UPSERT via `db.query` with `INSERT … ON CONFLICT DO UPDATE`. |
| TZ=Europe/Moscow on server | `last_seen_at TIMESTAMPTZ` is fine (TZ-aware); 24h archive window will be wall-clock-correct. |
| MCP postgres for direct queries (never `psql`) | Validation queries (Section 9) run via `mcp__postgres__query`. |
| MCP playwright for browser tests | Frontend dropdown smoke test uses `mcp__playwright__*`. |
| `db.one` throws if not found, `db.oneOrNone` returns null | Use `oneOrNone` for category lookups that may miss. |
| Specialists can hit `/api/home-care/*` | Endpoint repointing must keep `auth` middleware unchanged — specialists already have access. |

## Summary

The phase needs to (a) introduce a persistent table `yclients_goods_catalog` populated from YClients `/goods/{cid}?category_id=N` with pagination, (b) keep it fresh via the existing `0 */3 * * *` cron with soft-delete after a 24h grace window, (c) repoint `/api/home-care/products` and `/api/home-care/product-tree` from the sales-history-derived query to this catalog with a hardcoded blacklist of service-category titles, and (d) fix a one-character bug in `services/home-care.js:25-29` (`g.id` → `g.good_id`) that has been silently disabling the bulk path of the existing `syncGoodsCategories`.

All design choices are locked in CONTEXT.md (D-01 through D-19). The codebase already provides every reusable primitive: `ycGet`, `_treeCache` + `clearTreeCache`, the `db` helper, and an exemplary UPSERT pattern in `services/staff.js:104-127`. There is no new external dependency.

**Primary recommendation:** Add `syncGoodsCatalog(salon)` to a new file `services/yclients-goods-catalog.js` (keeps `home-care.js` focused on the tree-cache + sales-derived-category sync, separation of concerns), wire it into `backend/server.js` cron BEFORE `syncGoodsCategories`, repoint the two route handlers in `backend/routes/home-care.js`, and add the table + indexes via `backend/migrations.js`. Total surface: ~250 lines added, ~30 lines edited.

<phase_requirements>
## Phase Requirements

No formal REQUIREMENTS.md exists. Goals derived from ROADMAP.md and CONTEXT.md `<domain>` block:

| ID (synthetic) | Description | Research Support |
|----------------|-------------|------------------|
| GOAL-01 | Дропдаун в шаблоне «Домашний уход» показывает все актуальные товары из каталога YClients (≈ 246 после blacklist на тестовом стенде vs. 151 сейчас) | Section 4 (Endpoint repointing), Section 1 (Schema) |
| GOAL-02 | Источник `/api/home-care/product-tree` и `/api/home-care/products` — таблица каталога YClients, не история продаж | Section 4 (Endpoint repointing) |
| GOAL-03 | Sync новых товаров автоматический (cron), без ручных действий | Section 6 (Cron integration), Section 3 (Sync algorithm) |
| GOAL-04 | Архивированные/удалённые в YClients позиции автоматически исчезают из списка | Section 3 (archive step), Section 1 (`is_archived` column) |
| GOAL-05 | Категории сохраняются (товары сгруппированы по `category_title`) | Section 1 (`category_title`), Section 4 (GROUP BY) |
| GOAL-06 | Нет регрессов в `/api/home-care/services` и `/api/home-care/service-tree` | Out-of-scope; не трогаем эти эндпоинты |
| GOAL-07 | Bulk loop `syncGoodsCategories` ускорен (g.good_id) | Section 5 (Bug fix patch) |
</phase_requirements>

## Standard Stack

### Core (already in repo, no install needed)
| Library | Version (verified `package.json`) | Purpose | Why Standard |
|---------|------------------------------------|---------|--------------|
| `pg` | ^8.11.3 | Postgres pool + parameterized queries | Already wraps `db` helper; pool reused across services |
| `axios` | ^1.6.0 | YClients HTTP client (via `ycGet`) | Existing pattern in `services/yclients.js`, supports timeout |
| `node-cron` | ^3.0.3 | Cron schedule | Already wired in `server.js`, supports `timezone` option |
| `winston` | ^3.19.0 | Structured logging | All services use `createLogger('Name')` from `backend/logger.js` |
| `jest` | ^30.3.0 | Test runner (devDep) | Existing tests `homecare-tree.test.js`, `portfolio.test.js` use Jest `describe/test/expect` |

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| (none new) | — | — | Phase introduces zero new dependencies |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| Raw `db.query` UPSERT row-by-row | Bulk `INSERT … VALUES ($1,$2,…),($N+1,…) ON CONFLICT` | Bulk is faster on large data, but at ~430 rows per salon per 3h, single-row UPSERT inside a `for` loop with 100ms YClients-pacing delays is already << dominant cost (HTTP). Not worth complexity. **Stick with row-by-row** matching `services/staff.js:24-29` and `:104-127`. |
| Separate file `services/yclients-goods-catalog.js` | Append `syncGoodsCatalog` to `services/home-care.js` | New file is cleaner separation: `home-care.js` already does two distinct things (tree-cache helpers + sales-derived category sync); adding a third concern muddles it. **Recommend new file** — Claude's discretion per CONTEXT. |
| `is_archived BOOLEAN` flag | Soft-delete via `archived_at TIMESTAMPTZ NULL` | Boolean is simpler, faster to filter (`WHERE NOT is_archived`), and matches the existing `is_active` pattern in `staff_members`. Timestamp adds nothing — `last_seen_at` already records when archive happened (within the cron tick). **Stick with boolean.** |
| `last_seen_at TIMESTAMPTZ` | `last_seen_at TIMESTAMP` (no TZ) | Server runs Europe/Moscow but `NOW() - INTERVAL '24 hours'` is timezone-agnostic for arithmetic. **TIMESTAMPTZ is correct** — matches `client_segments.updated_at`, `portfolio_categories.created_at`. |

**Installation:** None — all primitives already present.

**Version verification:** All versions read from `/root/loyalpro/backend/package.json` on 2026-05-10. No new packages added; no `npm view` lookups required. [VERIFIED: package.json read]

## Architecture Patterns

### Recommended Project Structure
```
backend/
├── migrations.js                          # ADD: yclients_goods_catalog table + 2 indexes
├── services/
│   ├── yclients-goods-catalog.js          # NEW: syncGoodsCatalog(salon) + BLACKLIST const
│   ├── home-care.js                       # EDIT: 1-line bug fix g.id → g.good_id
│   └── ...
├── routes/
│   └── home-care.js                       # EDIT: rewrite SQL in /products and /product-tree
└── server.js                              # EDIT: add syncGoodsCatalog call before syncGoodsCategories in cron
```

### Pattern 1: UPSERT with `ON CONFLICT DO UPDATE` (idempotent, salon-scoped)
**What:** Each YClients good upserted by `(salon_id, yclients_good_id)` unique key. On conflict, mutable fields (title, article, category_id, category_title) updated and `last_seen_at = NOW()` refreshed. `is_archived` reset to FALSE on every successful upsert (handles "archived good resurfaces" case D-15).

**When to use:** Every YClients-good-row processed inside the pagination loop.

**Example (model is `services/staff.js:104-127`, adapted):**
```javascript
// Source: services/staff.js:104-127 (verified pattern in repo)
await db.query(`
  INSERT INTO yclients_goods_catalog
    (salon_id, yclients_good_id, category_id, category_title, title, article, last_seen_at, is_archived)
  VALUES ($1, $2, $3, $4, $5, $6, NOW(), FALSE)
  ON CONFLICT (salon_id, yclients_good_id) DO UPDATE
    SET category_id    = EXCLUDED.category_id,
        category_title = EXCLUDED.category_title,
        title          = EXCLUDED.title,
        article        = EXCLUDED.article,
        last_seen_at   = NOW(),
        is_archived    = FALSE,
        updated_at     = NOW()
`, [salonId, g.good_id, g.category_id || null, categoryTitle, g.title || '', g.article || null]);
```

**Why this shape:** Mirrors `services/staff.js:24-29` (`staff_members` upsert) and `services/staff.js:91-98` (`goods_sales` upsert). [VERIFIED: read services/staff.js]

### Pattern 2: Pagination loop with break-on-short-page + per-call delay
**What:** Loop `page=1,2,3,…` calling `/goods/{cid}?category_id=N&count=200&page=K`; stop when response is empty OR length < count.

**When to use:** Every category enumeration.

**Example (model is `services/home-care.js:21-34`, copied):**
```javascript
let page = 1;
const COUNT = 200;
while (true) {
  const goods = await ycGet(salon, `/goods/${cid}`, { category_id: catId, count: COUNT, page });
  if (!Array.isArray(goods) || !goods.length) break;
  for (const g of goods) { /* upsert */ }
  if (goods.length < COUNT) break;       // last page — short
  page++;
  await new Promise(r => setTimeout(r, 200));   // YClients-pacing per D-11
}
```

[VERIFIED: pattern lifted directly from `services/home-care.js:21-34`]

### Pattern 3: Cron handler — fire-and-forget per-salon, swallow errors per-salon
**What:** The `0 */3 * * *` handler iterates salons and `.catch()`-es each `syncGoodsCatalog` promise individually so one bad salon never breaks the whole tick.

**Example (model `backend/server.js:119-130`):**
```javascript
// Source: backend/server.js:119-130 (verified)
cron.schedule('0 */3 * * *', async () => {
  cronLogger.info('Auto-sync...');
  try {
    const salons = await db.many(
      `SELECT * FROM salons WHERE is_active=TRUE
         AND yclients_company_id IS NOT NULL AND yclients_user_token IS NOT NULL`
    );
    for (const salon of salons) {
      runSync(salon, 'auto').catch(e => cronLogger.error(`AutoSync salon=${salon.id}: ${e.message}`));
      // NEW: catalog sync FIRST (per D-16 ordering)
      syncGoodsCatalog(salon).catch(e => cronLogger.error(`GoodsCatalogSync salon=${salon.id}: ${e.message}`));
      // EXISTING: keeps goods_sale_items.yclients_category fresh for sales analytics
      syncGoodsCategories(salon).catch(e => cronLogger.error(`GoodsCatSync salon=${salon.id}: ${e.message}`));
    }
  } catch (e) { cronLogger.error(`AutoSync cron: ${e.message}`); }
});
```

**Note:** No `timezone: 'Europe/Moscow'` is currently set on this cron in repo (only on `0 10 * * *` birthday cron). Server-level `TZ=Europe/Moscow` env is what makes it work today. **Do not add the timezone option here unless you also update the existing line** — out of scope.

### Anti-Patterns to Avoid
- **Don't make `syncGoodsCatalog` `await`-blocking inside the cron loop** — keeps the existing fire-and-forget pattern; otherwise one slow salon (30s timeout per request × N pages × M categories) blocks all subsequent salons.
- **Don't use `db.one` for category lookups that might miss** — use `db.oneOrNone` (CLAUDE.md `db.one` vs `db.oneOrNone` rule).
- **Don't `SELECT *` from the new table in hot paths** — `/product-tree` only needs `title, category_title`. Always project narrowly.
- **Don't apply blacklist filter at DB level via SQL `WHERE category_title NOT IN (…)`** — case/whitespace edge cases plus future per-salon overrides will require JS-side filtering anyway. Filter in JS after the query (matches `extractBrand` placement in test fixtures).

  *Counter-consideration:* Pushing the filter to SQL would shrink the row set transmitted across the wire by ~40%. At ~430 rows total this is irrelevant; the network/DB cost is identical. The deferred idea "per-salon blacklist override" makes JS-side filtering strictly more flexible.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| YClients HTTP auth + retry + JSON parsing | Custom `axios.get` per call | `ycGet(salon, endpoint, params)` from `services/yclients.js` | Already handles `Bearer/User` headers, `data.success` envelope, 30s timeout. |
| Per-salon in-memory tree cache | New `Map<salonId, …>` | `getTreeCache/setTreeCache/clearTreeCache` from `services/yclients.js` | Existing helpers already keyed correctly; `clearTreeCache(salonId)` is the documented invalidation hook. |
| Logger setup | `console.log` | `createLogger('GoodsCatalog')` from `backend/logger.js` | Auto-rotated daily files, structured `module=` tag, info/warn/error levels. |
| Pagination state machine | Per-category accumulator with manual error-state | The `while (true) { break }` pattern in `services/home-care.js:21-34` | Simple, proven, error path is the existing try/catch wrapper around the loop. |
| Cron dedup / advisory lock | `pg_try_advisory_lock(…)` for the catalog sync | Nothing — the cron runs every 3h, runs are far longer than they overlap | Webhook handler uses advisory locks because of repeated YClients deliveries; cron has no such pressure. Out of scope. |
| Schema migration ordering | Sequential `await client.query` chain that aborts on error | Existing `.catch(() => {})` IF NOT EXISTS pattern in `migrations.js` | Already idempotent; matches every prior table-add. |

**Key insight:** This phase is almost entirely composition of existing primitives. Resist any urge to "improve" `ycGet` or the cache layer — they're stable contracts used by 6 other services.

## Common Pitfalls

### Pitfall 1: `g.id` is always null in YClients goods response
**What goes wrong:** Existing bulk loop in `services/home-care.js:25-29` filters `if (g.id == null) continue;` — which silently skips every row, making the bulk-build of `goodCatMap` empty and falling back to per-good `/goods/{cid}/{good_id}` lookups (~430 extra HTTP calls).

**Why it happens:** YClients product list endpoint uses `good_id` (not `id`) as the canonical identifier. `g.id` exists in the schema but is consistently null in this endpoint's response.

**How to avoid:** Use `g.good_id` consistently. The same fix applies to the new `syncGoodsCatalog` upsert.

**Warning signs:** Logs show `Salon X: ${rows.length} categorized` matching number of rows looked up by per-item HTTP — i.e., the bulk path contributed zero. (After fix, logs should show >> rows being categorized through the bulk map.) [CITED: backend/services/home-care.js:25-29 + CONTEXT.md D-10]

### Pitfall 2: `/good_categories/{cid}` returns 404 on PERI CLINIC
**What goes wrong:** A naive bootstrap that requires `/good_categories` blocks the entire first sync.

**Why it happens:** Endpoint reliability varies by company configuration / YClients backend state. Verified empirically on company_id=668791.

**How to avoid:** Try-catch around `/good_categories`; on failure, derive `category_id` set from `SELECT DISTINCT category_id FROM goods_sale_items WHERE … category_id IS NOT NULL` (cheap), or — if `goods_sale_items.category_id` doesn't exist — by per-good lookups as documented in D-08.

**Code-check note:** `goods_sale_items` schema has `yclients_category` (string title) but NO numeric `category_id` column today. So D-08's bootstrap for derived cat_ids requires the per-good `/goods/{cid}/{good_id}` route. After first successful sync, `yclients_goods_catalog.category_id` becomes the cache for subsequent runs (D-09). [VERIFIED: read backend/migrations.js:99-101 + services/staff.js:104-127 INSERT shape — no `category_id` column on `goods_sale_items`]

**Warning signs:** First-ever sync makes ~150 single-good lookups to discover ~26 categories — expected, only happens once.

### Pitfall 3: Category title can come in 3 different shapes per `g.category` field
**What goes wrong:** Code assumes `g.category` is always a string and crashes / stores `[object Object]`.

**Why it happens:** YClients sometimes returns `g.category = "Расходники"`, sometimes `g.category = { id: 5, title: "Расходники" }`, sometimes `g.category = null` (with `g.category_id` populated separately).

**How to avoid:** Replicate the existing 3-branch normalization in `services/home-care.js:27-29`:
```javascript
function extractCategoryTitle(g, catMap) {
  if (g.category && typeof g.category === 'object' && g.category.title) return g.category.title;
  if (typeof g.category === 'string') return g.category;
  if (g.category_id != null && catMap[g.category_id]) return catMap[g.category_id];
  return null;
}
```
[VERIFIED: pattern at services/home-care.js:27-29]

### Pitfall 4: Race between cron sync and `clearTreeCache`
**What goes wrong:** A request hits `/product-tree` mid-sync, populates `_treeCache`, then sync finishes and clears it — net result fine. BUT the reverse: sync finishes and clears, then a request arrives BEFORE `setTreeCache` repopulates → cache miss → DB hit → cached. Also fine. Only real risk: if upsert runs in transaction and reader sees a half-applied state.

**Why it happens:** `db.query` runs without explicit BEGIN/COMMIT — each statement is auto-committed.

**How to avoid:** No action needed. Each individual UPSERT is atomic; readers see consistent rows. Stale cache is at most 1 cron tick (3h) — acceptable per D-19.

**Warning signs:** None expected.

### Pitfall 5: Multi-salon — running sync for salon without YClients credentials
**What goes wrong:** `syncGoodsCatalog` called on a salon where `yclients_company_id` or `yclients_user_token` is null → `ycGet` errors out.

**Why it happens:** Cron query already filters `WHERE … yclients_company_id IS NOT NULL AND yclients_user_token IS NOT NULL` ([VERIFIED: server.js:122-124]), but the function should still self-guard for direct invocations from routes.

**How to avoid:** First line of `syncGoodsCatalog`:
```javascript
if (!salon.yclients_company_id || !salon.yclients_user_token) {
  return { skipped: true, reason: 'no-yclients' };
}
```
Matches existing pattern in `syncGoodsCategories` line 9.

### Pitfall 6: 24h archive window vs partial sync failures
**What goes wrong:** A network blip causes one salon's sync to fail mid-pagination. Goods in unprocessed categories don't get `last_seen_at` refreshed. After 24h+1 cron tick, they get `is_archived=true` even though they exist.

**Why it happens (math):** Cron every 3h = 8 ticks per 24h. To wrongly archive, ALL 8 must fail to refresh a given good's `last_seen_at`. This requires either (a) 8 consecutive complete sync failures, or (b) the same category to fail mid-flight 8 times in a row.

**How to avoid:** D-13's 24h window is the buffer. Per-category try/catch in the loop ensures a single failed category doesn't kill the whole sync. Logging the failed category at WARN level makes recurring failures visible. Acceptable tradeoff per D-12 + D-13.

**Warning signs:** Spike in `is_archived=true` rows after a sync — log every transition with `cronLogger.warn('Archived: ' + count)` so anomalies are visible.

## Code Examples

Verified patterns from existing repo:

### Existing UPSERT skeleton (template for new catalog table)
```javascript
// Source: services/staff.js:24-29 (staff_members upsert — verified)
await db.query(`
  INSERT INTO staff_members (salon_id, yclients_staff_id, name, specialization, avatar_url, is_active, synced_at)
  VALUES ($1, $2, $3, $4, $5, $6, NOW())
  ON CONFLICT (salon_id, yclients_staff_id) DO UPDATE
    SET name=$3, specialization=$4, avatar_url=$5, is_active=$6, synced_at=NOW()
`, [salon.id, s.id, s.name || 'Сотрудник', s.specialization || null, s.avatar || null, isActive]);
```

### Existing pagination + delay (template for catalog enumeration)
```javascript
// Source: services/home-care.js:21-34 (verified)
let page = 1;
while (true) {
  const goods = await ycGet(salon, `/goods/${cid}`, { count: 200, page });
  if (!Array.isArray(goods) || !goods.length) break;
  for (const g of goods) { /* … */ }
  if (goods.length < 200) break;
  page++;
  await new Promise(r => setTimeout(r, 200));
}
```

### Existing tree-cache invalidation (template for new sync's tail)
```javascript
// Source: services/home-care.js:68 (verified)
clearTreeCache(salon.id);
```

### Existing service-tree grouped JSON shape (frontend contract — must preserve)
```javascript
// Source: routes/home-care.js:194-198 (verified)
const grouped = {};
for (const r of rows) {
  const cat = (r.yclients_category || '').trim() || 'Без категории';
  if (!grouped[cat]) grouped[cat] = [];
  grouped[cat].push(r.title);
}
const result = Object.entries(grouped)
  .sort(([a],[b]) => a.localeCompare(b, 'ru'))
  .map(([cat, items]) => ({ cat, items }));
```
The new `/product-tree` returns the **same shape** `[{ cat, items: string[] }]` — frontend untouched.

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Dropdown source = `goods_sale_items` history | Dropdown source = `yclients_goods_catalog` table | This phase | +95 visible SKUs on PERI CLINIC, all linecards covered |
| `syncGoodsCategories` bulk loop with `g.id` filter (always-null) | `g.good_id` | This phase (D-10) | ~430 fewer per-good HTTP calls per sync |
| Per-good HTTP fallback (`/goods/{cid}/{good_id}` × N) | Direct paginated `/goods/{cid}?category_id=N` | This phase | 26 categories × ~2 pages ≈ 52 HTTP vs ~430 |

**Deprecated/outdated:**
- The "Прочее" / brand-extraction grouping seen in `homecare-tree.test.js:36-51` (`extractBrand`, first-Latin-word heuristic) is dead code — `routes/home-care.js:184-200` already groups by `yclients_category` directly. The test file describes a behavior the production code doesn't implement. Out of scope to delete, but planner should not be confused: **prod uses `yclients_category` only**, no brand-extraction fallback.

## Section 1 — Schema for `yclients_goods_catalog`

```sql
CREATE TABLE IF NOT EXISTS yclients_goods_catalog (
  id                BIGSERIAL PRIMARY KEY,
  salon_id          INTEGER     NOT NULL REFERENCES salons(id) ON DELETE CASCADE,
  yclients_good_id  BIGINT      NOT NULL,
  category_id       INTEGER,                          -- nullable: YClients sometimes returns category_id=null
  category_title    VARCHAR(200),                     -- normalized via extractCategoryTitle()
  title             VARCHAR(500) NOT NULL DEFAULT '', -- some YClients goods have very long titles; 500 covers tail
  article           VARCHAR(200),                     -- nullable per D-context (no normalization required)
  last_seen_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  is_archived       BOOLEAN     NOT NULL DEFAULT FALSE,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (salon_id, yclients_good_id)
);

-- Hot path: /product-tree filters NOT is_archived, GROUPs by category_title, scoped to salon_id
CREATE INDEX IF NOT EXISTS idx_ygc_salon_active_cat
  ON yclients_goods_catalog (salon_id, category_title)
  WHERE NOT is_archived;

-- Archive sweep: salon_id + last_seen_at predicate
CREATE INDEX IF NOT EXISTS idx_ygc_salon_last_seen
  ON yclients_goods_catalog (salon_id, last_seen_at);
```

**Notes on schema choices:**
- `BIGSERIAL`/`BIGINT` for `yclients_good_id` — defensive against any future YClients ID inflation; matches `chat_id BIGINT` precedent in `mobile_telegram_links` ([VERIFIED: migrations.js:257]).
- `VARCHAR(200)` for `category_title` matches the existing `goods_sale_items.yclients_category VARCHAR(200)` ([VERIFIED: migrations.js:99-101]) — same column type ensures the route-level JOIN/UNION (if ever needed) is type-compatible.
- `VARCHAR(500)` for title — empirically YClients product names can exceed 200 chars (multi-language SKUs with size annotations).
- Partial index `WHERE NOT is_archived` — most queries filter archived; partial keeps index ~95% smaller and avoids needing a `is_archived` column in the index key. [CITED: PostgreSQL docs — partial index pattern]
- `(salon_id, category_title)` ordering in the partial index — supports both `WHERE salon_id=$1 AND NOT is_archived` (full index scan range) and ORDER BY category_title (locale-sort done in JS, but index helps locality).
- `(salon_id, last_seen_at)` — used by archive step `WHERE salon_id=$1 AND last_seen_at < NOW() - INTERVAL '24 hours'`. Index range scan over `last_seen_at` after equality on `salon_id`.
- No `salon_id`-only index — already covered by both above.

**Migration placement in `migrations.js`:** Append to end of `runMigrations` body, after `idx_portfolio_items_staff` (line 311). Three `client.query(…).catch(() => {})` blocks. [VERIFIED: pattern at lines 269-312]

## Section 2 — UPSERT Pattern (single-row inside loop)

```javascript
// Source pattern: services/staff.js:104-127 (verified row-by-row UPSERT under YClients-paced loop)
async function upsertGood(salonId, g, categoryTitle) {
  await db.query(`
    INSERT INTO yclients_goods_catalog
      (salon_id, yclients_good_id, category_id, category_title, title, article, last_seen_at, is_archived)
    VALUES ($1, $2, $3, $4, $5, $6, NOW(), FALSE)
    ON CONFLICT (salon_id, yclients_good_id) DO UPDATE
      SET category_id    = EXCLUDED.category_id,
          category_title = EXCLUDED.category_title,
          title          = EXCLUDED.title,
          article        = EXCLUDED.article,
          last_seen_at   = NOW(),
          is_archived    = FALSE,
          updated_at     = NOW()
  `, [
    salonId,
    g.good_id,                                    // CRITICAL: NOT g.id — bug per D-10
    g.category_id || null,
    categoryTitle,
    (g.title || '').slice(0, 500),
    g.article || null,
  ]);
}
```

**Decision: per-row vs bulk INSERT.** Per-row chosen because:
1. Loop body is dominated by 100-200ms YClients-pacing delay (D-11) + ~50ms YClients HTTP. Single UPSERT is ~2-5ms. Total per-row ~250ms, of which DB is <2%. Bulk batching wouldn't move the needle.
2. Per-row preserves the proven `services/staff.js` template — zero new failure modes.
3. Per-row gives deterministic logging granularity; if one row blows up we know which.

**Decision: include `is_archived = FALSE` in DO UPDATE clause.** Required by D-15 ("если архивный товар возвращается — `is_archived=false`"). Without it, a resurfaced archived good would stay marked archived.

## Section 3 — Sync Algorithm

**Pseudocode:**
```
syncGoodsCatalog(salon):
  if !salon.yclients_company_id || !salon.yclients_user_token: return {skipped: true}
  cid = salon.yclients_company_id
  errors = []

  // STEP A — Bootstrap category set (D-08, D-09)
  catIds = []
  catMap = {}    // cat_id → cat_title (best-effort)

  // A1. Try /good_categories (opportunistic, may 404)
  try:
    cats = await ycGet(salon, /good_categories/{cid})
    if Array.isArray(cats):
      for c in cats:
        if c.id != null && c.title:
          catMap[c.id] = c.title
          catIds.push(c.id)
  catch (e):
    log.warn('good_categories failed, falling back: ' + e.message)

  // A2. If no cats from API, derive from existing catalog (subsequent syncs — D-09)
  if catIds.length === 0:
    knownIds = await db.any(`SELECT DISTINCT category_id FROM yclients_goods_catalog
                             WHERE salon_id=$1 AND category_id IS NOT NULL`, [salon.id])
    catIds = knownIds.map(r => r.category_id)

  // A3. If still empty (first-ever sync, /good_categories failed), bootstrap from sales (D-08)
  if catIds.length === 0:
    soldGoodIds = await db.any(`SELECT DISTINCT gsi.yclients_goods_id
                                FROM goods_sale_items gsi
                                JOIN goods_sales gs ON gs.id = gsi.sale_id
                                WHERE gs.salon_id=$1 AND gsi.yclients_goods_id IS NOT NULL`, [salon.id])
    discovered = new Set()
    for row in soldGoodIds:
      try:
        data = await ycGet(salon, /goods/{cid}/{row.yclients_goods_id})
        if data.category_id != null: discovered.add(data.category_id)
        if data.category && data.category.id: discovered.add(data.category.id)
        if data.category && data.category.title: catMap[data.category_id] = data.category.title
        await sleep(150)
      catch (e): errors.push({step: 'bootstrap', goodId: row.yclients_goods_id, msg: e.message})
    catIds = [...discovered]

  // A4. If catIds STILL empty — log + return; cron will retry next tick
  if catIds.length === 0:
    log.warn('No category_ids discovered; sync skipped')
    return {skipped: true, reason: 'no-categories', errors}

  // STEP B — Enumerate goods per category (D-06, D-11, D-12)
  syncStart = NOW()
  inserted = 0; updated = 0; goodsSeen = 0
  for catId in catIds:
    try:
      page = 1
      while true:
        goods = await ycGet(salon, /goods/{cid}, {category_id: catId, count: 200, page})
        if !Array.isArray(goods) || goods.length === 0: break
        for g in goods:
          if g.good_id == null: continue   // can't upsert without ID
          categoryTitle = extractCategoryTitle(g, catMap)
          before = await db.one(`SELECT 1 FROM yclients_goods_catalog
                                 WHERE salon_id=$1 AND yclients_good_id=$2`, [salon.id, g.good_id])
          await upsertGood(salon.id, g, categoryTitle)
          if before: updated++ else: inserted++
          goodsSeen++
        if goods.length < 200: break
        page++
        await sleep(200)   // D-11
    catch (e):
      errors.push({step: 'enumerate', catId, msg: e.message})
      log.warn('Category ' + catId + ' failed: ' + e.message)
      // continue to next category (D-12)

  // STEP C — Soft-delete stale (D-13)
  archived = await db.query(`UPDATE yclients_goods_catalog
                             SET is_archived = TRUE, updated_at = NOW()
                             WHERE salon_id = $1
                               AND last_seen_at < NOW() - INTERVAL '24 hours'
                               AND NOT is_archived
                             RETURNING id`, [salon.id])

  // STEP D — Invalidate tree cache (D-18)
  clearTreeCache(salon.id)

  return {
    salonId: salon.id,
    inserted, updated, archived: archived.rowCount, goodsSeen,
    categoriesSeen: catIds.length,
    errors: errors.length, errorSamples: errors.slice(0, 5),
    durationMs: Date.now() - syncStart.getTime()
  }
```

**Optimization note on Step B's `before` check:** A second DB round-trip per row (~430 trips per salon). Alternative: use `RETURNING (xmax = 0) AS is_insert` from the UPSERT itself, like `services/staff.js:97`. **Recommend the RETURNING form** — saves 430 round-trips:

```javascript
const result = await db.one(`
  INSERT INTO yclients_goods_catalog (...) VALUES (...)
  ON CONFLICT (salon_id, yclients_good_id) DO UPDATE SET ...
  RETURNING (xmax = 0) AS is_insert
`, [...]);
if (result.is_insert) inserted++; else updated++;
```
[VERIFIED: pattern at services/staff.js:97]

**Idempotency on partial failure:**
- Per-category try/catch ensures a mid-flight failure of category K leaves categories K+1..N untouched in the catalog (rows from a previous sync stay valid; their `last_seen_at` from the previous tick keeps them <24h fresh).
- The `last_seen_at < NOW() - INTERVAL '24h'` archive predicate is the safety net: 8 cron ticks per 24h means ~8 chances to refresh before false-archive (D-13 math).
- Re-running the same sync is idempotent — every UPSERT either creates or updates with `last_seen_at = NOW()`, no duplicate rows possible (UNIQUE constraint).
- Archive step is also idempotent — `WHERE NOT is_archived` ensures already-archived rows aren't re-touched.

## Section 4 — Endpoint Repointing

**Blacklist constant** (place at top of `services/yclients-goods-catalog.js` or `services/home-care.js`):

```javascript
// Категории YClients, которые не показываются в выпадающем списке домашнего ухода (D-03)
// Сравнение: lower(trim(category_title)) — case-insensitive, whitespace-tolerant (D-04)
const HOME_CARE_CATEGORY_BLACKLIST = new Set([
  'расходники',
  'канцелярия',
  'препараты',
  'аптека',
  'сертификаты сеть peri clinic',
  'абонементы сеть peri clinic',
]);

function isBlacklisted(categoryTitle) {
  if (!categoryTitle) return false;   // "Без категории" passes through
  return HOME_CARE_CATEGORY_BLACKLIST.has(categoryTitle.trim().toLowerCase());
}

module.exports = { /* … */ HOME_CARE_CATEGORY_BLACKLIST, isBlacklisted };
```

### `/api/home-care/products` (search autocomplete) — new SQL

```javascript
// Source: routes/home-care.js:100-112 (current) — fully replaced
router.get('/products', auth, async (req, res) => {
  try {
    const { search = '', limit = 10 } = req.query;
    const rows = await db.any(
      `SELECT title, yclients_good_id AS id, category_title
         FROM yclients_goods_catalog
        WHERE salon_id = $1
          AND NOT is_archived
          AND title IS NOT NULL AND trim(title) != ''
          AND ($2 = '' OR title ILIKE '%' || $2 || '%')
        ORDER BY lower(trim(title)), title
        LIMIT $3`,
      [req.user.salonId, search, parseInt(limit) * 3]   // pull 3× then JS-filter blacklist
    );
    const filtered = rows
      .filter(r => !isBlacklisted(r.category_title))
      .slice(0, parseInt(limit));
    res.json(filtered.map(({ title, id }) => ({ title, id })));   // shape unchanged
  } catch (e) { res.status(500).json({ error: e.message }); }
});
```

**Note:** No `DISTINCT ON` needed — UNIQUE `(salon_id, yclients_good_id)` plus `NOT is_archived` already gives one row per real product. Pull 3× LIMIT to compensate for blacklist trimming.

### `/api/home-care/product-tree` (full grouped) — new SQL

```javascript
// Source: routes/home-care.js:176-202 (current) — fully replaced
router.get('/product-tree', auth, async (req, res) => {
  try {
    const { search = '' } = req.query;
    const salonId = req.user.salonId;
    if (!search) {
      const cached = getTreeCache(salonId);
      if (cached?.products) return res.json(cached.products);
    }
    const rows = await db.any(
      `SELECT title, COALESCE(NULLIF(trim(category_title), ''), 'Без категории') AS cat
         FROM yclients_goods_catalog
        WHERE salon_id = $1
          AND NOT is_archived
          AND title IS NOT NULL AND trim(title) != ''
          AND ($2 = '' OR lower(title) LIKE '%' || lower($2) || '%')
        ORDER BY lower(trim(title))
        LIMIT 1000`,
      [salonId, search]
    );
    const grouped = {};
    for (const r of rows) {
      if (isBlacklisted(r.cat)) continue;
      if (!grouped[r.cat]) grouped[r.cat] = [];
      grouped[r.cat].push(r.title);
    }
    const result = Object.entries(grouped)
      .sort(([a], [b]) => a.localeCompare(b, 'ru'))
      .map(([cat, items]) => ({ cat, items }));
    if (!search) setTreeCache(salonId, 'products', result);
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});
```

**Frontend response shape preserved:** `[{ cat: string, items: string[] }]` ordered by Russian-locale category title. [VERIFIED: matches existing routes/home-care.js:198 contract]

**LIMIT 1000:** Safety cap — current LIMIT was 600 on a sales-history table that maxed at ~150 distinct rows. Fresh catalog at PERI CLINIC has 427 rows, so 1000 is comfortably above the largest expected salon while bounding payload at ~80KB.

**Empty catalog (D-19):** If table empty, `db.any` returns `[]`, `grouped = {}`, `Object.entries(…) = []`, response `[]`. Cached. Frontend renders empty dropdown. Next cron tick populates. ✓

## Section 5 — Bug Fix in `services/home-care.js`

**Patch (one character changes, three call sites):**

```diff
--- a/backend/services/home-care.js
+++ b/backend/services/home-care.js
@@ -22,12 +22,12 @@
       const goods = await ycGet(salon, `/goods/${cid}`, { count: 200, page });
       if (!Array.isArray(goods) || !goods.length) break;
       for (const g of goods) {
-        if (g.id == null) continue;
-        if (g.category && typeof g.category === 'object' && g.category.title) goodCatMap[g.id] = g.category.title;
-        else if (g.category && typeof g.category === 'string') goodCatMap[g.id] = g.category;
-        else if (g.category_id != null && catMap[g.category_id]) goodCatMap[g.id] = catMap[g.category_id];
+        if (g.good_id == null) continue;
+        if (g.category && typeof g.category === 'object' && g.category.title) goodCatMap[g.good_id] = g.category.title;
+        else if (g.category && typeof g.category === 'string') goodCatMap[g.good_id] = g.category;
+        else if (g.category_id != null && catMap[g.category_id]) goodCatMap[g.good_id] = catMap[g.category_id];
       }
```

**Verification that the fix doesn't break the per-item fallback path:**
The fallback in `services/home-care.js:51-56` calls `/goods/{cid}/{goodId}` where `goodId` is `rows[i].yclients_goods_id` (from `goods_sale_items` table — already correct). The fallback doesn't read `g.id` or `g.good_id` — it reads `data.category` / `data.category_id` from a single-good response. Untouched by this fix.

After fix, the bulk loop's `goodCatMap` is keyed by real `good_id`s and the lookup at line 50 (`let category = goodCatMap[goodId]`) resolves on cache-hit, which now actually happens for ~95% of rows instead of 0%.

**Order of operations:** This bug fix is independent of the new sync — it can land in the same commit as the catalog sync, or earlier. Recommend bundling for atomic git history.

## Section 6 — Cron Integration

**Exact placement in `backend/server.js`:** Inside the existing `cron.schedule('0 */3 * * *', …)` handler (currently lines 119-130), insert ONE line between `runSync` and `syncGoodsCategories`:

```diff
--- a/backend/server.js
+++ b/backend/server.js
@@ -5,6 +5,7 @@
 const { runSync }           = require('./services/loyalty');
 const { syncGoodsCategories } = require('./services/home-care');
+const { syncGoodsCatalog }    = require('./services/yclients-goods-catalog');
 const { syncStaffData }     = require('./services/staff');
 const { refreshSegments }   = require('./services/segments');
@@ -125,6 +126,8 @@
     for (const salon of salons) {
       runSync(salon, 'auto').catch(e => cronLogger.error(`AutoSync salon=${salon.id}: ${e.message}`));
+      syncGoodsCatalog(salon).catch(e => cronLogger.error(`GoodsCatalogSync salon=${salon.id}: ${e.message}`));
       syncGoodsCategories(salon).catch(e => cronLogger.error(`GoodsCatSync salon=${salon.id}: ${e.message}`));
     }
```

**Ordering rationale (D-16):** `syncGoodsCatalog` first → catalog table fresh → then `syncGoodsCategories` (which reads `goods_sale_items` and updates their `yclients_category` field for sales-analytics). Both happen concurrently per-salon (fire-and-forget), so strictly speaking the "ordering" is just statement order, but they don't share state — `syncGoodsCategories` reads from `goods_sale_items` and writes to it, while `syncGoodsCatalog` reads/writes only `yclients_goods_catalog`. No race.

**No new cron expression** per D-16. No timezone option needed — server-level `TZ=Europe/Moscow` env handles it (consistent with the rest of `0 */3` and `0 *` schedules in this file).

## Section 7 — Cache Invalidation

**Where to call `clearTreeCache(salonId)`:** Last step of successful `syncGoodsCatalog` (Step D in algorithm). Mirrors the existing `services/home-care.js:68` invocation.

```javascript
// At the bottom of syncGoodsCatalog, just before return:
clearTreeCache(salon.id);
return { /* … */ };
```

**Why not on every UPSERT:** Tree-cache is per-tree (e.g. `'products'` key), not per-good. Invalidating on every row would defeat the cache during sync (which can take minutes). One-shot invalidation at end is correct.

**Why `syncGoodsCategories` ALSO calls `clearTreeCache`:** The current `/product-tree` reads from `goods_sale_items` and groups by `yclients_category` — when that field changes, the tree changes, hence invalidation. After this phase, `/product-tree` reads from the new catalog table, so `syncGoodsCategories`'s `clearTreeCache` becomes a no-op for the products tree (categories of `goods_sale_items` no longer drive the dropdown). It's safe to leave the call in (idempotent), but worth noting in code review that it's now belt-and-suspenders. **Recommendation:** leave as-is for safety; deferred cleanup if ever revisited.

## Section 8 — Failure Handling

**Partial-sync math:**

| Scenario | Probability | Effect |
|----------|-------------|--------|
| Single category fails (network blip) | Common (~5%) | One category's goods don't refresh `last_seen_at` for one tick. Caught up next tick (3h). |
| Whole sync fails (e.g. salon's YClients credentials revoked) | Rare | All goods go stale. After 8 ticks (~24h) all become `is_archived=true`. **Acceptable per D-13** — when YClients credentials are gone, we have no source of truth anyway. |
| Bootstrap fails on first-ever sync | One-shot | `catIds.length === 0` after all 3 fallbacks → return `{skipped: true, reason: 'no-categories'}`. Cron retries in 3h. Empty `/product-tree` (D-19) until success. |
| Mid-pagination crash inside a category | Rare | Goods in pages 1..K get refreshed; pages K+1..end don't. Same recovery as "single category fails." |

**Logging strategy:**
```javascript
const logger = createLogger('GoodsCatalog');
logger.info(`Salon ${salon.id}: starting catalog sync, ${catIds.length} categories`);
// … per-category WARN on catch …
logger.info(`Salon ${salon.id}: done. inserted=${inserted} updated=${updated} archived=${archived} errors=${errors.length} duration=${ms}ms`);
```

**No retries inside the sync function** — relying on cron's natural 3h retry cadence (D-13 buffer). Adding axios-retry would complicate without measurable benefit.

**Tradeoff documentation:** D-13's 24h archive window means a deleted-in-YClients product stays in the dropdown for ≤24h after deletion. Acceptable per D-context (clinic catalog turnover is weeks/months, not hours).

## Section 9 — Validation Architecture (Nyquist Dimension 8)

**Test framework status:**

| Property | Value |
|----------|-------|
| Framework | Jest ^30.3.0 (devDep, [VERIFIED: backend/package.json]) |
| Config file | None — Jest uses default discovery (`*.test.js`) |
| Quick run command | `cd backend && npx jest catalog -x` (matches catalog-related tests) |
| Full suite command | `cd backend && npx jest` |
| `npm test` script | `jest clients-api` ([VERIFIED: package.json] — currently filtered to one test file; planner can extend or run jest directly) |

### Phase Requirements → Test Map

| Goal ID | Behavior | Test Type | Automated Command | File Exists? |
|---------|----------|-----------|-------------------|--------------|
| GOAL-01 | After sync, ≥246 non-archived goods on PERI CLINIC | Integration (DB) | `mcp__postgres__query` (manual) — **manual sample query** | N/A — manual |
| GOAL-02 | `/api/home-care/product-tree` reads from `yclients_goods_catalog`, not `goods_sale_items` | Unit + integration | `npx jest catalog-route -x` | ❌ Wave 0 |
| GOAL-03 | `syncGoodsCatalog(salon)` is called from `0 */3 * * *` cron | Manual code review | grep `syncGoodsCatalog` in `server.js` | N/A |
| GOAL-04 | Good archived after 24h+1 absence | Integration (DB) | manual `mcp__postgres__query` after time-shift | N/A — manual |
| GOAL-05 | `/product-tree` returns shape `[{ cat, items: string[] }]` ordered by ru-locale | Unit | `npx jest catalog-tree -x` | ❌ Wave 0 |
| GOAL-07 | After bug fix, `g.good_id` actually populates `goodCatMap` | Unit (pure) | `npx jest home-care-bugfix -x` | ❌ Wave 0 |

### Sample Queries (run via `mcp__postgres__query`)

**GOAL-01 — minimum row count after first sync:**
```sql
SELECT COUNT(*) AS active_count
FROM yclients_goods_catalog
WHERE salon_id = 1 AND NOT is_archived;
-- Expected: ≥ 427 (raw); after blacklist filter applied at HTTP layer: ≥ 246
```

**GOAL-04 — archive verification (negative path):**
```sql
-- Before sync: pick a good that we'll force-disappear
UPDATE yclients_goods_catalog
   SET last_seen_at = NOW() - INTERVAL '25 hours'
 WHERE salon_id = 1 AND yclients_good_id = <known_id>;

-- Run sync (or wait for cron)

-- After sync: verify it got archived
SELECT yclients_good_id, is_archived, last_seen_at
  FROM yclients_goods_catalog
 WHERE salon_id = 1 AND yclients_good_id = <known_id>;
-- Expected: is_archived = TRUE
```

**GOAL-07 — bug fix verification (HTTP call count):**
```sql
-- After server restart with fix, count YClients API calls in logs:
-- Before fix: ~430 single-good calls per sync (visible in app-YYYY-MM-DD.log)
-- After fix: ~30-50 paginated /goods calls + same per-item fallback for unmatched
SELECT COUNT(*) FROM goods_sale_items WHERE yclients_category IS NOT NULL;
-- Expected: same total count, but populated faster (cron tick log shows duration drop)
```

### HTTP smoke test (manual via `mcp__playwright__*` or curl)
```bash
# (1) Login → token
curl -s -X POST http://localhost:3001/api/auth/login \
     -H 'Content-Type: application/json' \
     -d '{"login":"<owner>","password":"<pwd>"}' | jq -r '.token'

# (2) Tree endpoint
curl -s -H "Authorization: Bearer <token>" \
     http://localhost:3001/api/home-care/product-tree | jq 'length, .[0].cat, .[0].items | length'

# Expected: total categories ~ 20 (26 minus 6 blacklisted), each items array non-empty
```

### Wave 0 Gaps
- [ ] `backend/yclients-goods-catalog.test.js` — unit tests for `extractCategoryTitle`, `isBlacklisted`, `HOME_CARE_CATEGORY_BLACKLIST` invariants
- [ ] `backend/home-care-bugfix.test.js` — small fixture proving `g.good_id` is read (parameterized over the three category-shape branches)
- [ ] Optional: `backend/catalog-route.test.js` — pure grouping function (extracted from `/product-tree` handler) tests, mirroring existing `homecare-tree.test.js` structure
- [ ] **No framework install needed** — Jest already a devDep; existing tests run with `npx jest`

### Sampling Rate
- **Per task commit:** `npx jest <changed-file-pattern> -x`
- **Per wave merge:** `npx jest` (full suite — runs all `*.test.js` in backend root)
- **Phase gate:** Full suite green + manual `mcp__postgres__query` checks pass + `mcp__playwright__*` dropdown smoke shows ≥240 items in salon 1 dropdown before `/gsd-verify-work`

## Section 10 — Edge Cases / Risks

| Edge case | Mitigation | Confidence |
|-----------|------------|------------|
| Race: cron sync vs admin opens template | Stale tree cache for ≤ 1 cycle (3h). Tolerable per D-19. | HIGH |
| YClients rate-limit (typically 60 rpm per partner) | 26 categories × ~2 pages × 200ms delay = ~52 calls in ~10s. Far under any reasonable RPM cap. | HIGH ([VERIFIED: empirical pacing in services/staff.js:58 and services/home-care.js:33]) |
| Empty catalog on first install | `/product-tree` returns `[]` (D-19). Frontend renders empty. Cron tick within 3h populates. | HIGH |
| Multi-salon: no YClients creds | Cron query already filters; sync function self-guards. Skipped silently. | HIGH |
| Data volume: ~430 rows/salon × N salons | Trivial. Even 100 salons = 43k rows total — small. Indexes scale. | HIGH |
| Migrations on existing prod data | All `IF NOT EXISTS` — zero downtime. New table empty until first cron tick. | HIGH |
| Existing dropdown breaks during deploy | Endpoint shape unchanged; on first request after deploy, table is empty → empty list. **MINOR REGRESSION RISK** for ~3h until first sync. | MEDIUM — see mitigation below |
| Blacklist category title drift (YClients renames "Расходники" → "Расходные материалы") | Blacklist match misses, dropdown grows by ~85 items unexpectedly. | LOW frequency, MEDIUM impact — log first-sync category list in INFO so renames are visible |
| Specialist hits `/products` while sync mid-flight | Reads partial state (categories 1..K-1 fresh, K..end stale). User sees consistent rows (no broken UI). | HIGH |
| `goods_sale_items.yclients_goods_id` is null for some rows (bootstrap fallback) | `WHERE yclients_goods_id IS NOT NULL` filter in bootstrap query handles. | HIGH |
| Title >500 chars overflows VARCHAR | `slice(0, 500)` in upsert binding. Worst case: title truncated. | HIGH |
| Two simultaneous cron ticks (highly unlikely with 3h spacing but theoretical) | Per-row UPSERT is atomic; UNIQUE constraint prevents duplicates; fire-and-forget pattern means ticks could overlap if previous took >3h. **Mitigation:** none needed — UPSERT is idempotent. | HIGH |

**Deploy regression mitigation:** Run `syncGoodsCatalog(salon)` once manually right after deploy via a one-shot script before flipping endpoint over (or accept the ≤3h empty-dropdown window). Planner decides; recommend manual one-shot for the production cutover task.

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| Node.js | Backend runtime | ✓ | ≥18.0.0 ([VERIFIED: package.json engines]) | — |
| PostgreSQL | DB | ✓ | (Beget cloud) | — |
| `pg` (npm) | DB driver | ✓ | ^8.11.3 ([VERIFIED: package.json]) | — |
| `axios` | YClients HTTP | ✓ | ^1.6.0 | — |
| `node-cron` | Cron | ✓ | ^3.0.3 | — |
| `winston` | Logging | ✓ | ^3.19.0 | — |
| `jest` | Tests | ✓ | ^30.3.0 (devDep) | — |
| YClients API access | Sync | ✓ (per-salon `yclients_user_token` + `yclients_partner_token`) | — | Skip salon if creds missing (existing pattern) |
| MCP `postgres` server | Validation queries | Assumed available per CLAUDE.md | — | — |
| MCP `playwright` server | UI smoke tests | Assumed available per CLAUDE.md | — | — |

**No missing dependencies. No fallbacks needed.** All work is composition of existing primitives.

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | YClients `/goods/{cid}?category_id=N` pagination terminates with empty array or short page (length < count) | Section 3, Pattern 2 | If endpoint returns `null` or non-array on success, the `if (!Array.isArray) break` guard handles it. Low risk — same pattern works in production today for `syncGoodsCategories`. [ASSUMED — same shape as observed in services/home-care.js:24] |
| A2 | `goods_sale_items` table has no `category_id` numeric column today | Section 3 Step A3 / Pitfall 2 | If it actually exists (added by a migration not visible in `migrations.js`), Step A3's bootstrap can use it directly instead of the per-good loop. [ASSUMED based on grep through `migrations.js` showing only `yclients_category VARCHAR(200)` ALTER at line 99-101] — planner should verify with `\d goods_sale_items` via `mcp__postgres__query` before finalizing the bootstrap path. |
| A3 | YClients `/goods/{cid}/{good_id}` returns `data.category_id` and/or `data.category` | Section 3 Step A3 | If single-good lookup also returns `category_id: null`, bootstrap-from-sales path won't discover any cat_ids. Cron retries; first sync produces empty catalog. **MITIGATION:** existing `syncGoodsCategories` uses the same endpoint with the same field accesses (services/home-care.js:53-55) and has been working in production — strong evidence the field is populated. [ASSUMED with strong precedent] |
| A4 | YClients responses to `/goods` may have title strings up to 500 chars | Section 1 Schema | If exceeded, `slice(0, 500)` truncates. Worst case is cosmetic (admin sees truncated title in dropdown). Risk is low — DB write does not fail. [ASSUMED] |
| A5 | The `0 */3 * * *` cron handler doesn't already overlap (a single tick takes <3h to finish all salons) | Section 6 | If overlapping, fire-and-forget means concurrent runs of `syncGoodsCatalog` for the same salon. Per-row UPSERT is atomic; UNIQUE prevents duplicates. Worst case: two-times the YClients API calls. [ASSUMED — at PERI CLINIC scale (1 salon, ~50 calls in 10s) overlap is impossible; for many salons, planner should consider serializing if becomes a problem] |
| A6 | Existing tests in `backend/*.test.js` use Jest (`describe/test/expect`) | Validation Architecture | New tests follow same idiom. [VERIFIED: read homecare-tree.test.js + portfolio.test.js — both use Jest globals] — *correction: this is verified, not assumed; remove from this table.* |

**A6 was VERIFIED, not assumed — leaving in table for transparency but it's not a real assumption.**

If this table looks small: most claims in this research are sourced directly from existing repo files (Read tool) or from CONTEXT.md's locked decisions. The five real assumptions (A1–A5) are about external YClients API behavior or absent code paths that the planner can verify before locking.

## Open Questions (RESOLVED)

1. **Should `is_archived=true` rows be cleaned up at all?** — **RESOLVED: defer per CONTEXT.**
   - What we know: D-14 says no hard-delete. Deferred ideas mention `is_archived AND last_seen_at < NOW() - 90 days` as future work.
   - What's unclear: at scale of ~430 rows/salon, the table will reach ~5x size if every quarter half the catalog churns. Still negligible. No action needed.
   - Recommendation: defer per CONTEXT.md.

2. **Is the synthetic `/sync-goods-categories` POST endpoint (`routes/home-care.js:167-174`) still useful?** — **RESOLVED: defer.**
   - What we know: It's a manual trigger for `syncGoodsCategories`. Currently exposed but not used by the frontend (per phase scope).
   - What's unclear: should we add a sibling `/sync-goods-catalog` POST for ops? (D-17 says no UI button, but a curl-able endpoint is different.)
   - Recommendation: defer — not in phase scope. Cron is enough; ops can `pm2 restart` to trigger startup-time sync if a future task adds one.

3. **Should the new `services/yclients-goods-catalog.js` file export tree-cache helpers like `home-care.js` does (line 75)?** — **RESOLVED: NO.**
   - What we know: `routes/home-care.js:10` imports `getTreeCache, setTreeCache` from `services/yclients`, not from `services/home-care`. The re-export in `home-care.js` is unused.
   - Recommendation: do NOT re-export from the new file. Keep imports going directly to `services/yclients`. Cleaner.

4. **What's the actual category-title encoding from YClients?** — **RESOLVED: trim+lowercase covers ASCII; NBSP fringe risk deferred.**
   - What we know: D-03 lists titles in Cyrillic UTF-8. Existing `goods_sale_items.yclients_category` stores them fine.
   - What's unclear: Whether YClients ever returns titles with leading/trailing whitespace or NBSP (U+00A0).
   - Recommendation: `category_title` storage uses raw `g.category` (or normalized via existing 3-branch helper); `isBlacklisted` does `.trim().toLowerCase()` — covers ASCII whitespace. NBSP is a fringe risk; if observed, add `.replace(/ /g, ' ')` to the normalizer.

## Sources

### Primary (HIGH confidence)
- `/root/loyalpro/CLAUDE.md` — multi-salon, migrations, db helpers, TZ, MCP tools (all verified by Read)
- `/root/loyalpro/.planning/phases/03-fix-home-care-product-dropdown-missing-items/03-CONTEXT.md` — D-01..D-19, blacklist, deferred ideas
- `/root/loyalpro/.planning/ROADMAP.md` — Phase 03 entry, success criteria, line-references to bug
- `/root/loyalpro/backend/services/home-care.js` — current `syncGoodsCategories`, line-by-line bug location
- `/root/loyalpro/backend/services/yclients.js` — `ycGet`, `_treeCache`, `clearTreeCache`
- `/root/loyalpro/backend/services/staff.js` — UPSERT pattern at lines 24-29 and 91-127 (template)
- `/root/loyalpro/backend/routes/home-care.js` — current `/products`, `/product-tree`, `/sync-goods-categories`
- `/root/loyalpro/backend/migrations.js` — `IF NOT EXISTS` pattern, table-add precedents (`portfolio_categories`, `staff_members`)
- `/root/loyalpro/backend/server.js` — cron handler at lines 119-130
- `/root/loyalpro/backend/db.js` — `db` helper API surface
- `/root/loyalpro/backend/config.js` — `YC` URL, env-driven config
- `/root/loyalpro/backend/package.json` — verified Jest 30.3.0, pg 8.11.3, etc.
- `/root/loyalpro/backend/homecare-tree.test.js` — Jest idiom + grouped-tree test pattern (template for new tests)
- `/root/loyalpro/backend/portfolio.test.js` — Jest idiom for pure-function unit tests

### Secondary (MEDIUM confidence)
- YClients API empirical behavior (from CONTEXT.md `<canonical_refs>` and `<additional_context>`):
  - `/good_categories/{cid}` returns 404 on PERI CLINIC company 668791
  - `/goods/{cid}` without `category_id` returns ~25 rows
  - `/goods/{cid}?category_id=N&count=200&page=K` paginates correctly
  - `g.id` is always null; real ID is `g.good_id`
  - 26 categories, 427 goods, 246 surviving blacklist on test stand

### Tertiary (LOW confidence)
- (none used — all claims sourced from above)

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — all libraries already in `package.json` and used in repo
- Schema design: HIGH — patterns directly modeled on existing `staff_members`, `portfolio_categories` tables
- UPSERT/sync algorithm: HIGH — verbatim adaptation of `services/staff.js:91-127` proven pattern
- Endpoint repointing SQL: HIGH — frontend contract verified preserved by reading `homecare-tree.test.js` expected shape
- Bug fix: HIGH — bug location and fix verified by reading actual code at `services/home-care.js:25-29`
- Blacklist: HIGH — list verbatim from D-03; case-insensitive comparison verbatim from D-04
- Cron integration: HIGH — exact lines identified in `server.js:119-130`
- YClients API quirks: MEDIUM — relies on CONTEXT.md-supplied empirical findings (not re-verified in this research session, but consistent with the always-null-`g.id` evidence visible in current code)
- Validation architecture: HIGH — Jest already a devDep with two existing test files in matching style

**Research date:** 2026-05-10
**Valid until:** 2026-06-10 (stable backend; YClients API surface may shift but the contract used here is also used by the production `syncGoodsCategories` so any breakage would surface there first)

---

## RESEARCH COMPLETE

**Phase:** 03 - fix-home-care-product-dropdown-missing-items
**Confidence:** HIGH

### Key Findings

- All 24 design decisions in CONTEXT.md (D-01..D-19) are implementable as composition of existing primitives — zero new npm packages, zero new external services, zero new cron expressions.
- The schema (`yclients_goods_catalog` with `salon_id` + `yclients_good_id` UNIQUE, `last_seen_at TIMESTAMPTZ`, `is_archived BOOLEAN`, partial index `WHERE NOT is_archived`) is a direct analog of existing `staff_members` and `portfolio_categories` tables.
- The UPSERT can use the `RETURNING (xmax = 0) AS is_insert` trick from `services/staff.js:97` to count inserts vs updates without an extra round-trip — saves ~430 DB calls per sync.
- The bug at `services/home-care.js:25-29` is a single-character fix (`g.id` → `g.good_id`) that has been silently disabling the bulk path of the existing `syncGoodsCategories`. Fix is independent of the new sync and can land in the same commit.
- 24h archive window math checks out: cron every 3h = 8 chances per 24h, so a single transient failure cannot wrongly archive any good; only 8 consecutive failures of the same category would.
- Frontend response shape `[{ cat: string, items: string[] }]` is preserved exactly — no frontend changes needed.

### File Created
`/root/loyalpro/.planning/phases/03-fix-home-care-product-dropdown-missing-items/03-RESEARCH.md`

### Confidence Assessment
| Area | Level | Reason |
|------|-------|--------|
| Standard Stack | HIGH | All deps already in `package.json` |
| Schema | HIGH | Modeled on verified existing tables |
| UPSERT / Sync algorithm | HIGH | Verbatim adaptation of `services/staff.js` |
| Endpoint repointing | HIGH | Frontend contract preserved (verified via tests file) |
| Bug fix | HIGH | Code read line-by-line, fix is single-char |
| Cron integration | HIGH | Exact insertion point identified |
| YClients API quirks | MEDIUM | Empirical findings sourced from CONTEXT.md, not re-verified |
| Validation Architecture | HIGH | Jest framework + idiom verified |

### Open Questions (non-blocking)
1. Should we add a sibling POST `/api/home-care/sync-goods-catalog` for ops? — defer per D-17.
2. Whether `goods_sale_items.category_id` numeric column exists (would simplify Step A3) — planner verify with `mcp__postgres__query` `\d goods_sale_items` before locking the bootstrap path.
3. NBSP in YClients category titles — fringe risk, add normalizer if observed.

### Ready for Planning
Research complete. Planner can now create PLAN.md files. Recommend a 4-task wave structure: (1) migrations + new service file scaffold, (2) `syncGoodsCatalog` implementation + unit tests, (3) endpoint repointing + bug fix in `home-care.js`, (4) cron wiring + integration smoke + manual cutover sync.
