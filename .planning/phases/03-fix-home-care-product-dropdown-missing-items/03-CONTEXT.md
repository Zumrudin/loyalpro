# Phase 03: fix-home-care-product-dropdown-missing-items — Context

**Gathered:** 2026-05-10
**Status:** Ready for planning

<domain>
## Phase Boundary

Закрыть пробел между каталогом товаров YClients и выпадающим списком в шаблоне «Домашний уход» (Home Care). Сегодня список строится из истории продаж (`goods_sale_items`) и видит ≈35% актуального каталога — врач не может назначить недавно появившиеся SKU и непродаваемые ранее позиции.

Фаза должна:
1. Импортировать полный каталог товаров YClients (номенклатуру) в LoyalPro в персистентную таблицу.
2. Поддерживать каталог в актуальном состоянии — новые товары появляются, исчезнувшие в YClients архивируются.
3. Переключить эндпоинты `/api/home-care/product-tree` и `/api/home-care/products` на этот каталог как источник.

Вне фазы:
- Ручные/сторонние товары не из YClients.
- UI для редактирования каталога (только чтение).
- Переработка `goods_sales`/`goods_sale_items` — таблица остаётся как есть для отчётности и метрик. Поле `goods_sale_items.yclients_category` продолжает обновляться существующим `syncGoodsCategories` для совместимости — но это не источник дропдауна.

</domain>

<decisions>
## Implementation Decisions

### Источник дропдауна и фильтр категорий (Gray Area A — locked by default, не обсуждалось)
- **D-01:** Dropdown показывает товары из новой таблицы каталога, **не** из `goods_sale_items`.
- **D-02:** Группировка — по `category_title` (как сейчас в `/product-tree`).
- **D-03:** **Blacklist служебных категорий** — в дропдауне скрыты товары категорий, очевидно непригодных для домашнего ухода. Стартовый список (хардкод-константа в `services/home-care.js`):
  - `Расходники`
  - `Канцелярия`
  - `Препараты` (инъекционные филлеры/инъектики, например Juvelook)
  - `Аптека`
  - `Сертификаты Сеть Peri Clinic`
  - `Абонементы Сеть Peri Clinic`
- **D-04:** Blacklist проверяется по `lower(trim(category_title))`. Если в будущем понадобится менять список — это правка одного массива.
- **D-05:** Архивные (`is_archived=true`) товары в дропдауне не показываются.

### Стратегия sync с YClients API (Gray Area B — locked by default, не обсуждалось)
- **D-06:** Источник истины — `GET /goods/{cid}?category_id=N&count=200&page=K` с пагинацией до пустой страницы. Этот эндпоинт работает надёжно и возвращает все товары категории.
- **D-07:** **Эндпоинт `/good_categories/{cid}` ненадёжен** — на тестовом стенде PERI CLINIC он возвращает HTTP 404 «Произошла ошибка». Использовать его opportunistically: если получили список категорий — отлично, если нет — fallback к bootstrap (D-08).
- **D-08:** **Bootstrap списка `category_id`** при первом sync (когда таблица пустая):
  1. Попытаться `/good_categories/{cid}`. При успехе — взять оттуда `id`.
  2. При неудаче — собрать distinct `category_id` через перечисление `/goods/{cid}/{good_id}` для всех `yclients_goods_id` из `goods_sale_items` для этого салона. На PERI CLINIC это даёт ≈150 запросов и покрывает 26 категорий.
- **D-09:** **Subsequent syncs** реиспользуют `category_id`, известные из предыдущего sync (хранятся в каталоге). Новый `category_id` обнаруживается, когда любой sold-item с новым `category_id` приходит через webhook (триггер для перепроверки в следующем cron-такте).
- **D-10:** Bulk-цикл `syncGoodsCategories` (`backend/services/home-care.js:25-29`) **починить попутно**: использовать `g.good_id` вместо `g.id` (last всегда null в текущем YClients API) — это уберёт N лишних запросов в существующем синке.
- **D-11:** Между запросами к YClients — задержка 100-200ms (как уже сделано в существующих синках). Таймаут запроса — 30 секунд (как `ycGet`).
- **D-12:** Если sync категории падает на середине (network error, timeout) — продолжаем с остальными, сбойную категорию логируем и пропускаем. Партийная атомарность не нужна.

### Архивация / исчезновение товаров (Gray Area C — discussed)
- **D-13:** **Soft-delete с временным окном.** Каждый sync обновляет `last_seen_at` для всех виденных товаров (UPSERT). Отдельный шаг в конце sync помечает `is_archived=true` для товаров с `last_seen_at < NOW() - INTERVAL '24 hours'`. 24 часа — буфер на случай частичного сбоя sync (если cron запускается каждые 3 часа, у нас 8 шансов увидеть товар прежде, чем заархивировать).
- **D-14:** **Никогда не делаем hard-delete** — товар может ссылаться через `home_care_items.product_name` (хотя там текст, не FK), но безопаснее держать архивную запись для возможного отчёта/восстановления.
- **D-15:** Если архивный товар возвращается в YClients (sync снова его видит) — `is_archived=false`, `last_seen_at = NOW()`. Запись остаётся та же.

### Триггеры sync (Gray Area D — discussed)
- **D-16:** **Только cron `0 */3 * * *` Europe/Moscow** — рядом с существующими yclients-синками. Новых cron-выражений не вводим; добавляем `syncGoodsCatalog(salon)` вызов в тот же handler, что и `syncGoodsCategories`. Порядок: сначала каталог, потом категории старых продаж.
- **D-17:** Ручной кнопки «Обновить каталог» в UI **не делаем** в этой фазе — это deferred idea (см. ниже).
- **D-18:** TTL-кеша `_treeCache` для `/product-tree` — оставить существующий (clear по `clearTreeCache(salonId)` после успешного `syncGoodsCatalog`). Кеш живёт между запросами, инвалидируется на конце sync.
- **D-19:** Исключение для случая «таблица пустая на момент запроса» — если `/product-tree` запрошен до первого sync, отдаём пустой массив (без блокирующего sync на запросе). Cron подтянет данные в следующем такте. Это отступление от пользовательского ожидания, но альтернативы (синхронный sync на первом запросе) дают непредсказуемый latency.

### Claude's Discretion
- Точное имя таблицы — рекомендованный вариант `yclients_goods_catalog` (явная, что от YClients), но planner может предложить альтернативу.
- Точная структура индексов (наверняка нужен `(salon_id, is_archived)`, `(salon_id, category_title)`).
- Использовать ли отдельный сервис-файл `services/yclients-goods-catalog.js` или расширить `services/home-care.js` — на усмотрение planner-а.
- Уровень логирования (info/warn/error) для каждого шага — стандартный паттерн как в других синках.
- Юнит-тесты для blacklist-фильтра и нормализации категорий — да, но конкретный объём решит planner.
- Поведение `service_categories` / service-tree — не трогаем.

</decisions>

<specifics>
## Specific Ideas

- На тестовом стенде salon_id=1 (PERI CLINIC, YClients company 668791) после первого полноценного sync ожидаем в каталоге ≈ 427 уникальных товаров (при текущем состоянии YClients-каталога). После применения blacklist'а в дропдауне будет ≈ 246 (всё минус Расходники 85, Препараты 64, Аптека 27, Абонементы 33, Сертификаты 10, Канцелярия 2). Это на ≈ 95 позиций больше, чем сейчас (151 в дропдауне), и добавит все недостающие SKU косметических линеек, на которые пожаловался пользователь (Forlle'd, Genosys, Phyto-C, MELINE, ALLIES, GIGI, HELEO4 и т. д.).
- Текущий `syncGoodsCategories` остаётся работать (для совместимости с метриками продаж), но его bulk-цикл попутно чинится по D-10.
- Webhook `/yclients/webhook.v2/:companyId` мы не трогаем.

</specifics>

<canonical_refs>
## Canonical References

**Внешних spec/ADR в проекте нет** — требования зафиксированы в этом CONTEXT.md и в ROADMAP.md.

### Project-level
- `CLAUDE.md` — multi-salon constraint (`salon_id` FK обязателен), миграции `IF NOT EXISTS`, MCP postgres для запросов, MCP playwright для UI, TZ Europe/Moscow.
- `.planning/ROADMAP.md` (Phase 03 entry) — постановка задачи, success criteria, out-of-scope.

### Code touch points (для researcher и planner)
- `backend/services/home-care.js` — текущий `syncGoodsCategories`, ре-экспорт tree-cache helpers. Здесь же добавлять `syncGoodsCatalog` или вынести в новый файл.
- `backend/services/yclients.js` — `ycGet`, `_treeCache`, `getTreeCache/setTreeCache/clearTreeCache`.
- `backend/services/staff.js:68-128` — паттерн `syncGoodsSales` (UPSERT + ON CONFLICT). Использовать как образец для UPSERT каталога.
- `backend/routes/home-care.js:100-112` (`/products`) и `:176-202` (`/product-tree`) — точки переключения источника.
- `backend/migrations.js` — точка добавления новой таблицы (`CREATE TABLE IF NOT EXISTS yclients_goods_catalog …`).
- `backend/server.js` — cron `0 */3 * * *` обработчик, в который добавляется вызов `syncGoodsCatalog`.
- `backend/db.js` — `db` helper (`one`/`any`/`oneOrNone`/`query`), pool со SSL.
- `backend/config.js:25` — `YC: 'https://api.yclients.com/api/v1'`.

### Reference for YClients API quirks
- `MEMORY.md → ref_yclients_goods_categories.md` — note про `/good_categories`, `/goods` endpoints. **Дополнить:** `/good_categories/{cid}` может отвечать 404 "Произошла ошибка" (наблюдалось на PERI CLINIC); `/goods/{cid}` без фильтра отдаёт ≈25 строк (по умолчанию), пагинация работает только при `category_id=N`; `g.id` всегда `null`, реальный ID — `g.good_id`.

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `ycGet(salon, endpoint, params)` — авторизованный вызов YClients с готовыми хедерами и обработкой `data.success`. Использовать без изменений.
- `getTreeCache/setTreeCache/clearTreeCache` — in-memory кеш per-salon. Уже используется в `/product-tree` и `/service-tree`. Очищать после успешного `syncGoodsCatalog`.
- `db` helper (`db.query`, `db.one`, `db.any`, `db.oneOrNone`) — единственный путь к Postgres. Без ORM.
- Паттерн UPSERT с `ON CONFLICT DO UPDATE` — см. `services/staff.js:91-98` и `:104-127`.
- Паттерн «исключающий update» (`WHERE … IS DISTINCT FROM`) — см. `services/home-care.js:60`.

### Established Patterns
- **Миграции IF NOT EXISTS** — `migrations.js` запускает все ALTER/CREATE при старте, никогда не падает на дубле.
- **`salon_id` обязателен в каждой таблице** — без исключений.
- **Логгер из `createLogger('Name')`** — `backend/logger.js`.
- **Cron handler — единый async-функция** для каждого расписания, ловит свои ошибки, не валит сервер.
- **Возвращаемое значение sync-функции** — `{ updated, failed, total, … }` для логирования и ручных вызовов.

### Integration Points
- **Cron** — `backend/server.js`, существующее расписание `0 */3 * * *` (TZ Europe/Moscow). Новый sync встаёт туда же, **после** существующего `syncGoodsCategories` (чтобы каталог обновился, а потом подтягивались категории старых продаж).
- **HTTP routes** — `backend/routes/home-care.js`, эндпоинты `/products` и `/product-tree`. Полностью переписываем SQL-запросы; форма ответа остаётся прежней (для фронта без изменений).
- **Frontend** — `frontend/js/pages/home-care.js`. Не трогаем; форма JSON-ответа `/product-tree` (`[{cat, items: string[]}]`) сохраняется.
- **Migrations** — `backend/migrations.js`. Добавляем `CREATE TABLE IF NOT EXISTS yclients_goods_catalog (…)` + индексы.

</code_context>

<deferred>
## Deferred Ideas

- **Кнопка «Обновить каталог» в UI** — обсуждалась как опция (D), не вошла в фазу. Кандидат на отдельную фазу/quick-fix позже, если врачи будут жаловаться, что после заведения нового товара в YClients надо ждать до 3 часов.
- **Per-salon настройка blacklist категорий** — сейчас blacklist хардкод. Если появятся салоны с иначе названными служебными категориями — выносить в БД (`salons.dropdown_hidden_categories TEXT[]` или отдельная таблица).
- **Per-category флаг видимости в UI настроек** — pro-вариант предыдущего пункта: в UI отмечаем галочками «показывать в шаблоне ухода». Overkill для MVP.
- **TTL-инвалидация при первом запросе** (синхронный sync на пустую таблицу) — отвергнуто из-за непредсказуемого latency. Возможна доработка позже, если понадобится.
- **Hard-delete старых архивных** (например, `is_archived AND last_seen_at < NOW() - 90 days`) — на будущее, если таблица разрастётся. Сейчас не нужно.
- **Расширение sync на «услуги»** (`service_categories`/`services`) для построения дерева услуг — это уже есть в `/service-tree`, и в текущей фазе не трогаем.

</deferred>

---

*Phase: 03-fix-home-care-product-dropdown-missing-items*
*Context gathered: 2026-05-10*
