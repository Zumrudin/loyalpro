# Карта точек интеграции склада (13.11.2026)

Только поиск по коду, код не менялся. Строки получены из `rg` (команды 1–8) и `sed -n` (±2 строки вокруг совпадения).
Колонка «трогаем ли» — рекомендация для будущей интеграции: **да** = точка записи/логики, которую придётся менять; **только чтение** = безопасно; **нет** = не затрагивается.

## 1. Где читается/пишется goods_transactions

| файл:строка | что делает | трогаем ли |
|---|---|---|
| backend/migrations.js:2259 | DDL создания таблицы goods_transactions | нет |
| backend/migrations.js:2292, 2296, 2300 | индексы (salon+record_id, salon+good+type+date, salon+date), все partial по `deleted_at IS NULL` | нет |
| backend/routes/webhook.js:126 | приём вебхука `goods_operations_*` → запись в goods_transactions, отдельный catch (200 уже отдан) | да |
| backend/services/economics/store.js:40–49 | апсерт строки `ON CONFLICT (salon_id, yclients_txn_id)`; status delete ставит deleted_at | да |
| backend/services/economics/goods-events.js:32 | `parseTransaction`: разбор data вебхука в строку; PII не пишется | да |
| backend/services/economics/store.js:65 | последнее поступление товара (type_id=3) для refreshLastReceipt | только чтение |
| backend/services/economics/store.js:79 | DISTINCT good_id поступлений для refreshAllLastReceipts | только чтение |
| backend/services/economics/store.js:159 | EXISTS: визит имеет списание расходников (type_id=2) | только чтение |
| backend/services/economics/store.js:183 | HAVING bool_and(NOT EXISTS): дни без списаний | только чтение |
| backend/services/economics/store.js:232 | CONSUMABLES_SQL: расходники по record_id | только чтение |
| backend/services/economics/store.js:247 | RECEIPTS_SQL: поступления за период | только чтение |
| backend/services/economics/store.js:354 | EXISTS в каталоге при onlyConsumables | только чтение |
| backend/services/economics/store.js:365 | история поступлений по good_id, LIMIT 100 | только чтение |
| backend/services/journal/visit-history.js:37 | LEFT JOIN по yclients_txn_id = sold_item_id из revenue_operations | только чтение |
| backend/services/journal/visit-history.js:44 | CONSUMABLES_SQL: списания (type_id=2) по record_id | только чтение |
| backend/services/journal/visit-payment.js:50 | goods_transactions из record попадает в snapshot визита | только чтение |
| backend/services/journal/visit-payment.js:84–85 | блокировка оплаты визита с товарами/расходниками | только чтение |
| backend/services/journal/payments.js:145 | сравнение snapshot с goods_transactions перед отметкой прихода | только чтение |
| backend/services/staff.js:83–96 | читает `raw_payload->'goods_transactions'` из records (не из таблицы) | только чтение |
| backend/services/revenue.js:49 | ycGet `/storage_operations/goods_transactions/...` → master_id (API YClients, не таблица) | нет |
| backend/scripts/economics-backfill-goods.js:3, 23, 31 | помесячный догон в goods_transactions; count после записи | нет |
| backend/scripts/economics-sync-e2e.js:23 | проверочный count за 3 дня | только чтение |
| backend/scripts/economics-explain.js:34 | DISTINCT good_id для EXPLAIN | только чтение |
| backend/scripts/backfill-revenue-sold-by.js:5, 50 | ycGet `/storage_operations/goods_transactions/{cid}/{id}` (API) | нет |

## 2. Где читается/пишется yclients_goods_catalog

| файл:строка | что делает | трогаем ли |
|---|---|---|
| backend/migrations.js:402–426 | DDL таблицы и индексы (salon+category_title, salon+last_seen_at, partial `WHERE NOT is_archived`) | нет |
| backend/migrations.js:2314 | ALTER ADD COLUMN last_receipt_price / last_receipt_at и др. | нет |
| backend/services/yclients-goods-catalog.js:82 | полный синк каталога YClients (upsert) | да |
| backend/services/yclients-goods-catalog.js:138 | DISTINCT category_id уже известных категорий | только чтение |
| backend/services/yclients-goods-catalog.js:214–223 | INSERT ... ON CONFLICT DO UPDATE (title, article, last_seen_at=NOW(), is_archived=FALSE) | да |
| backend/services/yclients-goods-catalog.js:265–270 | архивирует строки с last_seen_at старше 24 ч (is_archived=TRUE) | да |
| backend/services/economics/store.js:63 | unit_equals по good_id | только чтение |
| backend/services/economics/store.js:71–72 | UPDATE last_receipt_price / last_receipt_at | да |
| backend/services/economics/store.js:101–105 | upsertCatalogGood: INSERT (is_archived=TRUE), ON CONFLICT обновляет только экономические поля | да |
| backend/services/economics/store.js:253–254 | CATALOG_SQL: `yclients_good_id = ANY($2)` | только чтение |
| backend/services/economics/store.js:356–359 | список каталога с LEFT JOIN goods_price_overrides, без фильтра is_archived | только чтение |
| backend/routes/home-care.js:131–134 | список товаров для выпадашки, `NOT is_archived` | только чтение |
| backend/routes/home-care.js:229–231 | категории и поиск, `NOT is_archived` | только чтение |
| backend/scripts/economics-sync-e2e.js:20 | count с unit_actual_cost | только чтение |

Во frontend/ совпадений по `yclients_goods_catalog` нет.
## 3. yclients_good_id как NOT NULL

Схема: `backend/migrations.js:405` — `yclients_good_id BIGINT NOT NULL`; `migrations.js:414` — `UNIQUE (salon_id, yclients_good_id)`.

| файл:строка | выражение | риск при NULL |
|---|---|---|
| backend/services/economics/store.js:63 | `WHERE salon_id=$1 AND yclients_good_id=$2` | строка не находится, unit_equals молча undefined |
| backend/services/economics/store.js:72 | `UPDATE ... WHERE yclients_good_id=$2` | 0 строк, цена поступления молча не сохраняется |
| backend/services/economics/store.js:101–105 | INSERT с `yclients_good_id` ... ON CONFLICT | ошибка NOT NULL, апсерт падает |
| backend/services/yclients-goods-catalog.js:214–217 | INSERT ... ON CONFLICT (salon_id, yclients_good_id) | ошибка NOT NULL, синк каталога падает на строке |
| backend/services/economics/store.js:253–254 | `yclients_good_id = ANY($2::bigint[])` | NULL в массиве не матчится, товар молча пропадает |
| backend/services/economics/store.js:354 | EXISTS `t.good_id = c.yclients_good_id` | NULL в goods_transactions.good_id не совпадает, расходник молча выпадает из фильтра |
| backend/services/economics/store.js:358–359 | LEFT JOIN overrides `o.good_id = c.yclients_good_id` | риска нет (колонка NOT NULL) |
| backend/routes/home-care.js:131 | `SELECT yclients_good_id AS id` | риска нет (NOT NULL) |

Примечание: `goods_transactions.good_id` nullable (фильтры `IS NOT NULL`: store.js:79, economics-explain.js:34).

## 4. Техкарты и продажи

Техкарты (`tech_cards|service_tech_cards`, команда 3): backend/migrations.js, backend/scripts/economics-sync-e2e.js, backend/services/economics/store.js, backend/services/economics/tech-cards.js, backend/services/economics/sync.js

Продажи (`sold_item_id|goods_sale`, команда 4, файлы без разбивки по строкам): backend/migrations.js, backend/routes/staff.js, backend/routes/finance.js, backend/routes/api.js, backend/scripts/bootstrap-base-schema.sql, backend/scripts/backfill-revenue-sold-by.js, backend/services/staff.js, backend/services/yclients-goods-catalog.js, backend/services/finance-ops.js, backend/services/economics/calc.js, backend/services/economics/store.js, backend/services/home-care.js, backend/services/revenue.js:49, backend/services/journal/visit-history.js:37

## 5. Заглушки «Товары» и «Списание расходников» (frontend)

| файл:строка | что | 
|---|---|
| frontend/js/pages/journal-forms.js:208 | `jrStub('Товары','box','jr-tab-stub')` — вкладка «Товары» в форме создания записи |
| frontend/js/pages/journal-card.js:105 | `jrStub('Товары','box','jr-tab-stub')` — вкладка «Товары» в карточке визита |
| frontend/js/pages/journal-card.js:64 | «Списание расходников» — пункт в массиве кнопок `.jr-tools` (иконка box), не через jrStub |

## 6. is_archived / last_seen_at

| файл:строка | что делает |
|---|---|
| backend/migrations.js:410 | `last_seen_at DEFAULT NOW()` — ставится по умолчанию |
| backend/migrations.js:411 | `is_archived DEFAULT FALSE` — ставится по умолчанию |
| backend/migrations.js:421 | partial-индекс `WHERE NOT is_archived` — читается индексом |
| backend/migrations.js:426 | индекс (salon_id, last_seen_at) |
| backend/services/yclients-goods-catalog.js:215–223 | ставит last_seen_at=NOW(), is_archived=FALSE при upsert |
| backend/services/yclients-goods-catalog.js:266–270 | ставит is_archived=TRUE при last_seen_at < NOW()-24h; читает last_seen_at в WHERE |
| backend/services/economics/store.js:97–102 | новая строка из экономики: is_archived=TRUE, last_seen_at=NOW(); на конфликте last_seen_at не трогается (по комментарию store.js:97) |
| backend/services/economics/store.js:348 | комментарий: is_archived в каталоге экономики НЕ фильтруется |
| backend/routes/home-care.js:134 | читает: `AND NOT is_archived` (список товаров) |
| backend/routes/home-care.js:231 | читает: `AND NOT is_archived` (категории/поиск) |

## 7. Тесты-стражи (команда 7)

backend/loyalty-sync-helpers.test.js, backend/journal-visit-payment.test.js, backend/journal-visit-history.test.js, backend/journal-payments.test.js, backend/journal-integration.test.js, backend/journal-account-contract.test.js, backend/economics-store.test.js
