# LoyalPro — Roadmap

## Active milestone

### Phase 03: fix-home-care-product-dropdown-missing-items

**Status:** active

**Problem:** В выпадающем списке при создании шаблона домашнего ухода (раздел «Домашний уход») видна только часть товаров из YClients. Расследование на тестовом стенде PERI CLINIC (salon_id=1, YClients company 668791) показало:

- В дропдауне 151 уникальный товар, в YClients-каталоге — минимум 427 (281 позиция отсутствует, ≈ 65% каталога).
- Среди недостающих — позиции косметических линеек, которые ещё ни разу не продавались через кассу: новые SKU Forlle'd, объёмные/рефильные позиции Genosys, новые Phyto-C, MELINE, ALLIES, GIGI, HELEO4 и т. д.

**Корневая причина:** Источник дропдауна — `goods_sale_items` (история продаж), а не каталог YClients. Эндпоинт [`GET /api/home-care/product-tree`](../backend/routes/home-care.js#L176-L202) и [`GET /api/home-care/products`](../backend/routes/home-care.js#L100-L112) читают только из таблицы продаж. Полная номенклатура из YClients в LoyalPro не импортируется.

**Сопутствующий баг:** [`backend/services/home-care.js:25-29`](../backend/services/home-care.js#L25-L29) — bulk-цикл `syncGoodsCategories` использует `g.id` (всегда null в YClients API), вместо `g.good_id`; в результате каждое обновление категории идёт через медленный fallback `/goods/{cid}/{goodId}`.

**Goal:** Дропдаун в шаблоне «Домашний уход» показывает все актуальные товары из каталога YClients (а не только те, что когда-либо продавались), с разбиением по категориям. Архивированные/удалённые в YClients позиции автоматически исчезают из списка.

**Success criteria:**
- На тестовом стенде salon_id=1 после нового sync-а в дропдауне видно все актуальные товары из YClients (количество совпадает с тем, что отдаёт `/goods/{cid}` с пагинацией по всем категориям, минус архивные).
- Источник `/api/home-care/product-tree` и `/api/home-care/products` — таблица каталога YClients, не история продаж.
- Категории сохраняются (товары сгруппированы по `category_title`).
- Нет регрессов в `/api/home-care/services` и `/api/home-care/service-tree` (они и не трогаются).
- Sync новых товаров происходит автоматически (cron) и не требует ручных действий.

**Out of scope (deferred):**
- Сторонние/ручные товары, не из YClients.
- UI для редактирования каталога — только чтение.
- Переработка раздела продаж (`goods_sales`/`goods_sale_items`) — таблица остаётся как есть для метрик/отчётности.

**Branch:** `fix/home-care-goods-catalog-sync`

**Depends on:** —
**Plans:** 3/4 plans executed

Plans:
- [x] 03-01-PLAN.md — Wave 1: миграция yclients_goods_catalog + scaffold services/yclients-goods-catalog.js + bug fix g.id→g.good_id (3 tasks)
- [x] 03-02-PLAN.md — Wave 2: реализация syncGoodsCatalog body — bootstrap + enumerate + UPSERT + soft-delete + clearTreeCache (1 task)
- [x] 03-03-PLAN.md — Wave 3: repointing /products + /product-tree на новый каталог + юнит-тесты (3 tasks)
- [ ] 03-04-PLAN.md — Wave 4: cron wiring + manual production cutover + visual smoke (3 tasks, includes checkpoint)
