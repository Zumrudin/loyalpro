---
phase: 03-fix-home-care-product-dropdown-missing-items
plan: 04
status: completed
tasks: 3/3
completed: 2026-05-10
---

# Wave 4 Summary — Cron wiring + Production cutover + UI verification

## Objective
Замкнуть цепочку: подключить `syncGoodsCatalog` в существующий cron `0 */3 * * *`, выполнить ручной production cutover для немедленного заполнения каталога, и провести визуальную проверку дропдауна в UI «Домашнего ухода».

## Tasks executed

### Task 1 — Cron wiring (commit `b97ca75`)
Изменения в `backend/server.js`: +2 строки, 0 удалений.
- Line 9 (новая): `const { syncGoodsCatalog } = require('./services/yclients-goods-catalog');`
- Line 128 (новая): `syncGoodsCatalog(salon).catch(e => cronLogger.error(\`GoodsCatalogSync salon=\${salon.id}: \${e.message}\`));` — вставлена между `runSync` и `syncGoodsCategories` в cron-handler `0 */3 * * *`.

Acceptance criteria — все passed:
- `node --check backend/server.js` → OK
- `grep -c "syncGoodsCatalog" backend/server.js` → 2
- `grep -c "GoodsCatalogSync salon=" backend/server.js` → 1
- Token-leak guard (T-03-W4-03): новая строка использует `salon=${salon.id}` (не `salon`, не `JSON.stringify`)
- Cron-expression `'0 */3 * * *'` неизменён
- Остальные 3 cron-handlers (`'0 10 * * *'`, `'0 * * * *'`, `'30 * * * *'`) не тронуты

### Task 2 — Production cutover

**Step A — PM2 restart:** `pm2 restart loyalpro` → server pid 22565, status online, port 3001 listening. Миграция `yclients_goods_catalog` применилась (таблица + 2 индекса созданы — verified via `mcp__postgres__query`).

**Step B — One-shot run для всех активных салонов с YClients-кредами:**
```json
Salons to sync: 1
{"salonId":1,"salonName":"PERI CLINIC","inserted":258,"updated":0,"archived":0,"categoriesSeen":23,"goodsSeen":258,"errors":0,"durationMs":50621}
```

Один активный салон с YClients (PERI CLINIC, salon_id=1). Cutover успешен: 258 inserted, 0 errors, 50.6 секунд.

**Note: YClients endpoint `/good_categories/{cid}` ответил 404** — sync пошёл по fallback path (RESEARCH.md §A1):
> bootstrapping cat_ids from 151 sold goods

Это означает, что `/good_categories` API недоступен на YClients-аккаунте PERI CLINIC. Sync обнаружил категории через постраничный обход `/goods/{cid}` для cat_ids, извлечённых из истории продаж. Этот путь видит только активные категории (с продажами), поэтому 23 категории (план ожидал ≥25).

**Step C — DB verification (через mcp__postgres__query):**
```
salon_id=1: total=258, active=258, cats=23, all last_seen_at within 5 min of cutover
```

Топ-категории: Абонементы Сеть Peri Clinic (25), Genosys (25), Препараты (25), Forlled (21), Phyto-C (18), TIZO (18), Rejudicare (16), ALLIES (13), GIGI (13), Шампуни (12), Skin Formula (11), РЕВИ (11), Сертификаты Сеть Peri Clinic (10), HELEO4 (8), MELINE (7), Luscious Lips (6), Masktini (6), JAN MARINI (5), HELIOCARE (4), Косметика (1), Коллаген (1), Medic Control Peel (1), Peri Clinic (1).

Все 7 ключевых брендов из жалобы пользователя присутствуют в БД: **Forlled, Genosys, Phyto-C, MELINE, ALLIES, GIGI, HELEO4** ✓

3 blacklist-категории (Препараты, Сертификаты, Абонементы) сохранены в БД (фильтрация на HTTP-уровне, не на DB-уровне — design decision из RESEARCH.md).

**Step D — HTTP smoke test:**
```
GET /api/home-care/product-tree (Bearer JWT, salon_id=1)
→ HTTP 200, 20 categories, 198 products
```

После blacklist'а в HTTP-layer:
- 20 категорий (из 23 в БД, 3 blacklisted удалены): Коллаген, Косметика, РЕВИ, Шампуни, ALLIES, Forlled, Genosys, GIGI, HELEO4, HELIOCARE, JAN MARINI, Luscious Lips, Masktini, Medic Control Peel, MELINE, Peri Clinic, Phyto - C, Rejudicare, Skin Formula, TIZO
- 198 товаров (258 в БД минус 60 в трёх blacklisted категориях)

Проверка blacklist через `curl /api/home-care/product-tree | filter`:
- "Расходники" → 0 категорий ✓
- "Канцелярия" → 0 ✓
- "Препараты" → 0 ✓
- "Аптека" → 0 ✓
- "Сертификаты" → 0 ✓
- "Абонементы" → 0 ✓

**Token-leak audit:** `pm2 logs loyalpro | grep -E "yclients_user_token|partner_token"` → 0 совпадений ✓

### Task 3 — UI visual verification (Playwright)

Открыта страница `/#home-care` под owner (salon_id=1, JWT через localStorage `lp_tk`). Кликнута «Новое назначение» → открыта модалка → кликнут «+ добавить» под «🌅 Утро / ✓ Очищение» → появилось autocomplete-поле «Название продукта...».

Введена буква «F» → дропдаун открылся, показывает 10 товаров (UI limit на autocomplete):
- 360º Fluid – Солнцезащитный крем-флюид с SPF 50+, 50 мл
- 360º Invisible Spray
- 360º Mineral Tolerance
- Advanced - Солнцезащитный спрей SPF 50, 200 мл
- ALLIES OF SKIN 20% Vitamin C Brighten + Firm Serum
- ALLIES OF SKIN 35% Vitamin C + Perfecting Serum
- ALLIES OF SKIN Daily Firming Trio Kit
- ALLIES OF SKIN Molecular Silk (100мл и 250мл)
- ALLIES OF SKIN Peptides & Antioxidants Advanced Firming Daily Treatment

Скриншот сохранён: `.planning/phases/03-fix-home-care-product-dropdown-missing-items/03-04-dropdown-screenshot.png`

**Дополнительная диагностика endpoint'а `/products?search=`:**

| Бренд | Кол-во в БД (категория) | Найдено через search | Объяснение |
|-------|------------------------|--------------------|-----------|
| Forlled | 21 | 0 | title товаров не содержит «Forlled» (например «Крем для век») |
| Genosys | 25 | 0 | то же — бренд только в category_title |
| GIGI | 13 | 0 | то же |
| Phyto | 18 | 1 | в title есть «Phyto C ...» |
| MELINE | 7 | 1 | один title содержит «MELINE» |
| ALLIES | 13 | 10 | многие title начинаются с «ALLIES OF SKIN» |
| HELEO4 | 8 | 8 | все title содержат «HELEO4» |

`/api/home-care/products?search=` ищет substring **в `title`**, не в `category_title`. Эта семантика существовала до фазы и не изменена. Бренды, у которых название не дублируется в title каждого товара, через текстовый поиск не находятся, но **присутствуют в дропдауне как optgroup-категории через `/product-tree`** — что и видит пользователь.

## Phase Goal verification

| Критерий | План | Факт | Статус |
|---------|------|------|--------|
| backend/server.js импортирует syncGoodsCatalog | ✓ | ✓ | ✓ |
| Cron вызывает syncGoodsCatalog перед syncGoodsCategories | ✓ | ✓ | ✓ |
| Token-leak guard (.catch только salon.id + e.message) | ✓ | ✓ | ✓ |
| Manual cutover заполнил БД для salon_id=1 | ≥427 total / ≥240 active | 258/258 | ⚠ ниже плана (см. ниже) |
| HTTP /product-tree категорий | ≥25 (план) / ≥20 (acceptance) | 20 | ⚠ ниже плана (≥25), ✓ acceptance (≥20) |
| HTTP /product-tree товаров | ≥240 | 198 | ⚠ ниже плана |
| 6 blacklist-категорий отсутствуют в HTTP | ✓ | ✓ | ✓ |
| 7 ключевых брендов присутствуют (хотя бы по 1 SKU) | ✓ | ✓ | ✓ (все 7 в БД и в product-tree) |
| /service-tree без регрессии (не менялся) | ✓ | ✓ | ✓ (код не менялся) |
| pm2 logs без yclients_user_token / partner_token | 0 | 0 | ✓ |

**Почему численные пороги ниже плана:** YClients endpoint `/good_categories/{cid}` ответил 404 для PERI CLINIC. Sync сработал по fallback-пути (bootstrap из 151 sold good), который не видит категорий без продаж. План предполагал доступность `/good_categories` (это давало бы 26+ категорий и 427+ товаров). На текущем YClients-аккаунте PERI CLINIC `/good_categories` закрыт.

**Что это значит для Phase Goal:** Корневая проблема (дропдаун ограничен только проданными товарами) решена для всех товаров YClients, у которых есть продажи в любой категории. Дропдаун теперь содержит:
- 198 товаров vs 151 до фазы (+31%)
- 20 категорий vs ~12 до фазы (+67%)
- Все 7 ключевых брендов из жалобы

Если YClients откроет `/good_categories` для аккаунта PERI CLINIC, sync автоматически (без дополнительных изменений в коде) увидит все категории и товары — текущий код использует `/good_categories` если он доступен, и fallback-bootstrap только при 404.

## Files modified
- `backend/server.js` (+2 lines, 0 deletions)

## Files NOT modified (per scope)
- Frontend (frontend/js/pages/home-care.js, etc.)
- Other backend services / routes / migrations
- Tests (Wave 3 tests cover the new flow)

## Commits
- `b97ca75` — feat(03-04): wire syncGoodsCatalog into 0 */3 * * * cron handler

## Next steps
- Code review gate (gsd-code-review)
- Phase verification (gsd-verifier)
- Update ROADMAP / STATE
- Mark phase 03 complete (with note о /good_categories 404 fallback)
