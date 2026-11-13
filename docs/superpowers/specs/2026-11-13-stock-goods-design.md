# Склад, товары, материалы и операции в LoyalPro («Управление → Товары») — дизайн

Дата: 13.11.2026 (вторая редакция того же дня). Подпроект 3 программы «функции YClients у нас» (решения владельца 12.11.2026: LoyalPro — главный для склада, YClients — копия; порядок журнал → финансы → склад → сертификаты). Ветка работ: `feat/stock-goods` от `main`. Прод не затрагивается до отдельного решения владельца.

Запрос владельца (13.11.2026): «проанализируй, как в YClients устроен склад, товары, материалы и операции, и реализуй аналогичное в LoyalPro, разместить в меню Управление → Товары. Связывать записи со списаниями со склада и техкартами, продажи и списания — с клиентами».

**Уточнение владельца 13.11.2026: отправлять данные по складу обратно в YClients НЕ требуется.** Модуль — ЛОКАЛЬНЫЙ учёт: YClients остаётся только ИСТОЧНИКОМ (каталог товаров, склады, техкарты, операции, которые клиника всё ещё проводит там), ни один документ склада из LoyalPro в YClients не уходит. Это снимает очередь отправки, маркеры, сверку эха и зависимость от прав интеграционного пользователя на запись. Первая редакция спеки (с отправкой) заменена целиком.

**Решения владельца 13.11.2026 (вторая итерация):** (1) бонусы списываются ТОЛЬКО на услуги — товары за бонусы не продаются, модуль не пишет в YClients ничего, включая карту лояльности; (2) локальные товары разрешены, экономика процедур продолжает читать `goods_transactions`. Остальные решения §11 приняты автономно и помечены «подтвердить». План — `docs/superpowers/plans/2026-11-13-stock-goods.md`.

---

## 1. Как склад устроен в YClients (по API-карте и живым данным PERI)

Источники: `docs/2026-11-12-yclients-api-capability-map.md` §3; живые read-only запросы 13.11.2026 с дев-токенов (`GET /storages`, `/goods/{cid}/{id}`, `/goods_categories/{cid}/{parent}`, `/user/permissions`, `/storage_operations/documents/{cid}/{id}`, `/technological_cards`); дев-копия прод-БД (`goods_transactions`, `yclients_goods_catalog`, `tech_cards`).

### 1.1 Сущности

| Сущность YClients | Что это | Чтение через API | У PERI |
|---|---|---|---|
| **Склад** (`storage`) | Место хранения с флагами `for_service` (списания расходников) / `for_sale` (продажи) | `GET /storages/{cid}` | 2 склада: 1334902 «Расходники» (`for_service=1`), 1334903 «Космоцевтика» (`for_sale=1`) |
| **Категория товара** | Дерево: `parent_category_id`, `is_chain` (сетевая) | `GET /goods_categories/{cid}/{parent}` (0 — корни), работает рекурсивно (проверено живьём) | Корни: Абонементы (сеть), Канцелярия, Косметика, Расходники, Сертификаты (сеть). Расходники → Аптека / Основные товары / Препараты. Косметика → бренды (Genosys, Forlled, TIZO, …) |
| **Товар** (`good`) | `title, article, barcode, category_id, cost` (цена продажи), `actual_cost` (себестоимость за ед. продажи), `unit_actual_cost` (за ед. списания), `unit_id`+`unit_short_title` (ед. продажи), `service_unit_id`+`service_unit_short_title` (ед. списания), `unit_equals` (сколько ед. списания в ед. продажи), `critical_amount`, `desired_amount`, `comment`, `actual_amounts[{storage_id, amount}]` (остатки по складам), `loyalty_abonement_type_id`/`loyalty_certificate_type_id` (абонементы и сертификаты — тоже товары), `last_change_date` | `GET /goods/{cid}` (постранично `count=100` до пустой страницы — память `ref_yclients_goods_pagination`), `GET /goods/{cid}/{id}`, `GET /goods/search` | 469 товаров в нашем зеркале (340 активных), 23 категории. Пример: «LIP мыло жидкое 500ml»: `unit` шт, `service_unit` мл, `unit_equals` 500, `actual_cost` 4254, `unit_actual_cost` 8.508 |
| **Единица измерения** | `unit{id,title,short_title}` | справочника нет — только в товарах и транзакциях | 216760 «Штука/шт.», 216761 «мл», «пар.», «бу» |
| **Документ склада** | Шапка операции: `type_id`, `storage_id`, `create_date`, `comment`, `user_id`, `number`, транзакции | `GET /storage_operations/documents/{cid}/{id}`, `GET .../documents/goods_transactions/{doc}` | — |
| **Товарная транзакция** | Строка документа: `good_id, amount` (со знаком: приход +, расход −), `cost_per_unit, discount (%), cost, operation_unit_type` (1 — ед. продажи, 2 — ед. списания), `storage`, `master`, `client`, `supplier`, `service`, `record_id`, `comment`, `good_special_number` (код сертификата/абонемента), `loyalty_certificate_id`/`loyalty_abonement_id` | `GET /storages/transactions/{cid}` (`page,count,start_date,end_date,document_id,changed_after` — `changed_after` ТОЛЬКО с временем) | 9 427 строк с 01.08.2026 в зеркале (§1.2) |
| **Техкарта** | Нормы расходников на услугу: `technological_card_items[{good_id, amount, price, storage_id, good{title, unit}}]`; привязка к услуге/мастеру — в YClients | `/technological_cards/{cid}/`, `default_for_staff_and_service/{cid}/{staff}/{service}/`, `record_consumables/{cid}/{record}/` | 81 техкарта в зеркале, 16 привязок к услугам у нас |
| **Поставщик** | `supplier{id,title}` | справочника нет | в транзакциях PERI всегда `[]` |
| **Остатки** | `actual_amounts` в карточке товара | отчёта «остатки на дату» нет | в ЕДИНИЦАХ ПРОДАЖИ, бывают ОТРИЦАТЕЛЬНЫМИ (LIP мыло на «Расходниках»: −8.118 шт при `unit_equals` 500) |
| **Инвентаризация** | тип документа 6 | API нет | — |

### 1.2 Типы операций (`goods_transactions.type_id`) и кто их создаёт

Дев-копия БД, salon 1, строки с 01.08.2026 (удалённые исключены):

| type_id | Название | Строк | Документов | С `record_id` | Склады | `operation_unit_type` | Кто создаёт в YClients |
|---|---|---|---|---|---|---|---|
| 1 | Продажа товара | 260 | 162 | **0** | оба | 1 | администратор в «Продаже», вне визита; сертификат — тоже продажа (`loyalty_certificate_id`) |
| 2 | Списание расходников | 8 941 | 798 | **все** | «Расходники» | 2 | YClients АВТОМАТИЧЕСКИ по техкарте при сохранении записи (`create_date` = время визита, строки появляются за недели до визита) |
| 3 | Приход товара | 135 | 49 | 0 | оба | 1 и 2 | администратор (`cost` = сумма с учётом скидки поставщика) |
| 4 | Списание товара | 91 | 37 | 0 | оба | 1 и 2 | администратор: потери, подарки («за отзыв …»), заказы интернет-магазина |
| 5 | Перемещение | 0 | — | — | — | — | не используется |

Вебхуки (на дев приходят реальные): `goods_operations_sale|receipt|consumable|stolen|move` (`status` create/update/delete; `data` — транзакция с вложенными `good, unit, storage, client, master, service, supplier`), `good`. Удаление приходит ТОЛЬКО вебхуком — API `/storages/transactions` удалённые не отдаёт. Доставка at-least-once, порядок не гарантирован (защита по `last_change_date` уже есть в `economics/store.upsertGoodsTransaction`).

### 1.3 Права интеграционного пользователя (живой `GET /user/permissions`, 13.11.2026)
Чтение склада полное: `storages_access`, `storages_transactions_access`, `storages_last_days_count=-1`. Запись (перемещения, инвентаризация, создание/правка товаров, отчёты, поставщики) — `false`; после уточнения владельца это не имеет значения — модуль в YClients не пишет ничего.

**Вывод:** важно, что YClients продолжит САМ создавать списания расходников (type 2) по своим техкартам при каждой записи — записи клиники по-прежнему живут в YClients (журнал local-first шлёт их туда). Поэтому зеркало операций YClients остаётся обязательным входом леджера: иначе у нас не было бы фактических расходников визитов.

---

## 2. Что уже есть в LoyalPro (переиспользуем, не дублируем)

| Что | Где | Как используем |
|---|---|---|
| Зеркало товарных транзакций YClients `goods_transactions` (вебхук + ночная сверка `changed_after=−2д` + догон по датам + «пробелы» списаний) | `services/economics/goods-events.js`, `store.upsertGoodsTransaction`, `sync.js`, крон `5 5 * * *` | ЕДИНСТВЕННЫЙ вход зеркала. Леджер подписывается на апсерт хуком (§6.1), сверку не дублируем |
| Каталог товаров `yclients_goods_catalog` (+ `unit, service_unit, unit_equals, actual_cost, unit_actual_cost, stock, last_receipt_*`), синк `syncGoodsCatalog` (экономика, весь каталог) и синк «Домашнего ухода» (`services/yclients-goods-catalog.js`, по известным категориям, soft-delete по `last_seen_at`) | `migrations.js` ~402, 2306; `economics/sync.js`; `yclients-goods-catalog.js` | Таблица товаров — ОДНА, эта; расширяем колонками и разрешаем ЛОКАЛЬНЫЕ товары (§5.2). ГОТЧИ: `is_archived` занят «Уходами» (экономика вставляет расходники с `is_archived=TRUE`) — активность для склада своя (`stock_active`); Step C синка «Уходов» архивирует товары с `last_seen_at` старше 24 ч внутри перечисленных категорий — локальный товар он бы заархивировал, поэтому в его `UPDATE` добавляется `AND yclients_good_id IS NOT NULL` |
| Цена единицы материала на дату (`price.unitPriceAsOf`: последний приход → ручная → себестоимость каталога), пересчёт количества списания `writeoffQty` | `economics/price.js` | леджер хранит количество в базовых единицах через ТУ ЖЕ `writeoffQty`; цена единицы — через `unitPriceAsOf`, которому приходы теперь отдаёт леджер (наши и зеркальные) |
| Техкарты: зеркало `tech_cards` + ручные, привязки `service_tech_cards` (manual > lookup > learned), UI «Техкарты» в «Экономике» | `economics/tech-cards.js`, `store.js`, `routes/economics.js`, `frontend/js/pages/economics.js` | Вкладка «Техкарты» в «Товарах» рендерит ТОТ ЖЕ код; нормы техкарт — «ожидаемые расходники» в карточке записи |
| Кассовые операции `revenue_operations`, `finance_operations` (единый писатель `services/finance-ops.js`, kind `goods_sale`) | `services/revenue.js`, `services/finance-ops.js` | оплата продажи пишется через `finance-ops` новым входом (`cash`/`card`) |
| Журнал local-first: карточка записи с заглушками вкладок «Товары» и «Списание расходников» (`journal-card.js:165`), панель клиента, `visit-history.js` (покупки из `finance_operations`, расходники из `goods_transactions` type 2) | `services/journal/*`, `frontend/js/pages/journal-card.js` | вкладки оживают; «История посещений» берёт покупки и расходники из леджера |
| Карта API YClients, пагинация `/goods`, слепота синка «Уходов» к новым категориям | `docs/2026-11-12-yclients-api-capability-map.md`, памяти | категории склада берём деревом `/goods_categories/{cid}/{parent}` рекурсивно — это закрывает и слепоту к новым брендам |

---

## 3. Цели и границы v1

### Цели
1. Страница **Управление → Товары** (owner, admin): остатки по складам, каталог с карточкой товара и движением, журнал операций (наши и зеркальные), документы прихода/списания/перемещения/продажи/инвентаризации, поставщики, единицы, техкарты, оборотная ведомость, настройки.
2. **Леджер склада в LoyalPro — единственный источник остатка**: входящий остаток (снимок YClients на момент включения) + все движения: наши документы и зеркало операций, которые клиника всё ещё проводит в YClients (прежде всего авто-списания расходников по записям).
3. **Ничего не пишем в YClients**: документы живут только у нас. Показание `actual_amounts` YClients показывается как справочная цифра на момент включения; после него YClients и LoyalPro расходятся по построению, и это не ошибка.
4. **Записи ↔ списания ↔ техкарты**: в карточке записи журнала — фактические списания расходников (зеркало type 2 + наши локальные правки), норма по техкарте, расхождение; расходники записи корректируются локальным документом.
5. **Клиенты ↔ продажи и списания**: продажа товара — клиенту, с оплатой наличными/картой в `finance_operations` (бонусами товары не оплачиваются — решение владельца 13.11); из карточки записи и со страницы; в карточке пациента и «Истории посещений» — покупки и расходники визитов.

### Не делаем в v1 (§12)
Любая запись в YClients по складу; создание техкарт в YClients (ручные нормы — у нас, как сейчас); сертификаты и абонементы как товары (подпроект 4; их продажи видны как зеркало); ККМ/чеки; Мила (ветка `feat/mila-commerce-catalog`); переключение экономики процедур на леджер (экономика продолжает читать `goods_transactions`; переключение отдельным решением); локальные товары в ручных техкартах (items техкарт адресуют `good_id` YClients — расширение на `good_row_id` после v1); мобильное приложение; роли `specialist`/`admin_cashier`.

---

## 4. Принципы

1. **LoyalPro главный; YClients — источник, не приёмник.** Документ существует и меняет остаток в момент сохранения.
2. **Один леджер движений** `stock_movements` для всех источников: зеркало YClients, наши документы, входящий остаток, инвентаризация. Остаток = сумма. Никаких «остаток в колонке товара».
3. **Одна единица хранения количества** — базовая единица списания (`qty_base`), исходное количество и тип единицы рядом; пересчёт через `unit_equals` и общий `price.writeoffQty`.
4. **Историю не переписываем**: удаление — `deleted_at`; правка проведённого документа — отмена и новый (как YClients); аддитивные миграции `IF NOT EXISTS`.
5. **Всё по `salon_id`**; PII (имя/телефон) в леджер не пишем — ссылки `clients.id`/`yclients_client_id`.
6. **Деньги — через `finance-ops`**; бонусы в продаже товаров не участвуют (только услуги — решение владельца), поэтому карта лояльности YClients модулем не трогается.
7. **Вторых копий правил нет**: `writeoffQty`, `unitPriceAsOf`, `pickTechCard`, `isVisitCompleted`, парсер транзакции — импортируются.
8. **Квота YClients минутная и общая**: все чтения — внутри существующего ночного прохода экономики (`5 5 * * *`) и существующих вебхуков; новый обход категорий — не чаще раза в 30 мин и только по кнопке/ночью.

---

## 5. Модель данных (аддитивно, `migrations.js`, блок STOCK)

### 5.1 Новые таблицы

```sql
stock_storages (
  id BIGSERIAL PRIMARY KEY, salon_id INT NOT NULL REFERENCES salons(id) ON DELETE CASCADE,
  yclients_storage_id BIGINT,                 -- NULL у локального склада
  title VARCHAR(200) NOT NULL, for_service BOOLEAN NOT NULL DEFAULT FALSE, for_sale BOOLEAN NOT NULL DEFAULT FALSE,
  comment TEXT, weight INT, is_active BOOLEAN NOT NULL DEFAULT TRUE, synced_at TIMESTAMPTZ,
  UNIQUE (salon_id, yclients_storage_id) WHERE yclients_storage_id IS NOT NULL
)
stock_units (
  id BIGSERIAL PRIMARY KEY, salon_id INT NOT NULL REFERENCES salons(id) ON DELETE CASCADE,
  yclients_unit_id BIGINT, title VARCHAR(100) NOT NULL, short_title VARCHAR(50) NOT NULL,
  UNIQUE (salon_id, yclients_unit_id) WHERE yclients_unit_id IS NOT NULL,
  UNIQUE (salon_id, lower(short_title))
)
stock_suppliers (
  id BIGSERIAL PRIMARY KEY, salon_id INT NOT NULL REFERENCES salons(id) ON DELETE CASCADE,
  title VARCHAR(255) NOT NULL, inn VARCHAR(20), phone VARCHAR(32), email VARCHAR(120), contact VARCHAR(255), comment TEXT,
  is_active BOOLEAN NOT NULL DEFAULT TRUE, created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (salon_id, lower(title))
)
stock_documents (
  id BIGSERIAL PRIMARY KEY, salon_id INT NOT NULL REFERENCES salons(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('receipt','writeoff','sale','move','inventory','consumable','opening')),
  origin TEXT NOT NULL CHECK (origin IN ('loyalpro','yclients')),      -- наш / зеркало документа YClients
  status TEXT NOT NULL CHECK (status IN ('draft','posted','cancelled')), -- posted — движения считаются
  storage_id BIGINT REFERENCES stock_storages(id), to_storage_id BIGINT REFERENCES stock_storages(id),  -- to_ только move
  supplier_id BIGINT REFERENCES stock_suppliers(id) ON DELETE SET NULL,
  client_id INT REFERENCES clients(id) ON DELETE SET NULL, yclients_client_id BIGINT,
  record_id BIGINT,                              -- sale из карточки записи; consumable — запись визита
  master_staff_yc_id BIGINT, doc_date TIMESTAMPTZ NOT NULL, comment TEXT,
  total_cost NUMERIC(14,2), yclients_document_id BIGINT,            -- только у origin='yclients'
  created_by INT, created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW(), posted_at TIMESTAMPTZ, cancelled_at TIMESTAMPTZ, cancel_reason TEXT,
  UNIQUE (salon_id, yclients_document_id) WHERE yclients_document_id IS NOT NULL
)
-- индексы: (salon_id, doc_date DESC); (salon_id, record_id) WHERE record_id IS NOT NULL; (salon_id, client_id) WHERE client_id IS NOT NULL
stock_movements (
  id BIGSERIAL PRIMARY KEY, salon_id INT NOT NULL REFERENCES salons(id) ON DELETE CASCADE,
  document_id BIGINT NOT NULL REFERENCES stock_documents(id) ON DELETE CASCADE,
  good_row_id BIGINT NOT NULL REFERENCES yclients_goods_catalog(id),  -- ВНУТРЕННИЙ id товара
  storage_id BIGINT NOT NULL REFERENCES stock_storages(id),
  qty NUMERIC(14,4) NOT NULL, unit_type SMALLINT NOT NULL,            -- как ввели/пришло; 1 ед. продажи / 2 ед. списания
  qty_base NUMERIC(16,4) NOT NULL,                                    -- в ед. списания, со знаком
  cost_per_unit NUMERIC(14,4), discount NUMERIC(8,2), cost NUMERIC(14,2),
  record_id BIGINT, service_yc_id BIGINT, master_staff_yc_id BIGINT,
  yclients_txn_id BIGINT,                                             -- связка с goods_transactions
  source TEXT NOT NULL CHECK (source IN ('webhook','reconcile','backfill','loyalpro','opening','inventory')),
  occurred_at TIMESTAMPTZ NOT NULL, recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),  -- recorded_at — правило счёта §6.3
  deleted_at TIMESTAMPTZ, comment TEXT,
  UNIQUE (salon_id, yclients_txn_id) WHERE yclients_txn_id IS NOT NULL
)
-- индексы: (salon_id, good_row_id, storage_id) WHERE deleted_at IS NULL; (salon_id, record_id) WHERE record_id IS NOT NULL; (salon_id, occurred_at)
stock_openings (
  id BIGSERIAL PRIMARY KEY, salon_id INT NOT NULL, good_row_id BIGINT NOT NULL, storage_id BIGINT NOT NULL,
  qty_base NUMERIC(16,4) NOT NULL, taken_at TIMESTAMPTZ NOT NULL, source TEXT NOT NULL DEFAULT 'yclients_actual_amounts',
  yc_qty_base NUMERIC(16,4),                    -- справочно: показание YClients в момент снимка
  note TEXT, created_by INT, UNIQUE (salon_id, good_row_id, storage_id)
)
stock_inventory_lines (
  id BIGSERIAL PRIMARY KEY, salon_id INT NOT NULL, document_id BIGINT REFERENCES stock_documents(id) ON DELETE CASCADE,
  good_row_id BIGINT NOT NULL, storage_id BIGINT NOT NULL, expected_base NUMERIC(16,4), counted NUMERIC(14,4), counted_unit_type SMALLINT,
  counted_base NUMERIC(16,4), diff_base NUMERIC(16,4), UNIQUE (document_id, good_row_id)
)
stock_ingest_pending (salon_id INT NOT NULL, yclients_txn_id BIGINT NOT NULL, good_id BIGINT, raw JSONB, created_at TIMESTAMPTZ DEFAULT NOW(), PRIMARY KEY (salon_id, yclients_txn_id))
stock_settings (
  salon_id INT PRIMARY KEY REFERENCES salons(id) ON DELETE CASCADE,
  enabled BOOLEAN NOT NULL DEFAULT FALSE,                 -- леджер включён (снимок сделан)
  default_sale_storage_id BIGINT, default_service_storage_id BIGINT,
  categories_synced_at TIMESTAMPTZ, updated_at TIMESTAMPTZ
)
```

### 5.2 Расширение `yclients_goods_catalog` (товар)
`ALTER … ADD COLUMN IF NOT EXISTS`: `source VARCHAR(16) NOT NULL DEFAULT 'yclients'` (`loyalpro` у заведённых у нас), `category_path JSONB` (`[{id,title}]` от корня), `parent_category_id BIGINT`, `local_category VARCHAR(200)` (категория локального товара текстом), `sale_price NUMERIC(14,2)` (`cost` YClients), `local_sale_price NUMERIC(14,2)` (наша цена продажи, главнее `sale_price`), `barcode VARCHAR(64)`, `unit_id BIGINT`, `service_unit_id BIGINT`, `critical_amount NUMERIC(14,4)`, `desired_amount NUMERIC(14,4)`, `comment TEXT`, `local_note TEXT`, `loyalty_abonement_type_id BIGINT`, `loyalty_certificate_type_id BIGINT`, `yc_last_change_date TIMESTAMPTZ`, `stock_active BOOLEAN NOT NULL DEFAULT TRUE`.

**`yclients_good_id` становится NULLABLE** (`ALTER TABLE … ALTER COLUMN yclients_good_id DROP NOT NULL` — ослабление, не разрушение; существующий `UNIQUE (salon_id, yclients_good_id)` допускает несколько NULL). Локальный товар: `yclients_good_id IS NULL`, `source='loyalpro'`, `category_id NULL`, `local_category`, единицы — из `stock_units`, `unit_equals` обязателен (≥ 1). Страж: `services/yclients-goods-catalog.js` Step C получает `AND yclients_good_id IS NOT NULL`; экономика (`syncGoodsCatalog`, `listGoods`, `tech-cards`) по локальным товарам ничего не делает — они адресуются только по `id` (`good_row_id`).

### 5.3 Связи
- `finance_operations`: колонка `stock_document_id BIGINT`; идемпотентность — `step_op_id` (uuid оплаты), origin `loyalpro`, kind `goods_sale`, method `cash|card`.
- `goods_transactions` не меняется — сырое зеркало экономики; леджер читает его через хук апсерта.

---

## 6. Потоки

### 6.1 Зеркало YClients → леджер
`economics/store.upsertGoodsTransaction` после записи зовёт `stock/ledger.ingestMirrored(salonId, row, {status, source, deletedAt})` через `safely()` (сбой леджера не ломает экономику; `STOCK_LEDGER=false` отключает хук). Правила:
- `good_row_id` по `yclients_good_id = row.good_id`; товара нет в каталоге → `stock_ingest_pending` + WARN (ночной проход после `syncGoodsCatalog` разбирает очередь); склад — апсерт `stock_storages` по `row.storage_id` + `raw.storage.title`.
- Документ-шапка `origin='yclients'` по `(salon_id, yclients_document_id)`; `kind` по `type_id` (1 sale, 2 consumable, 3 receipt, 4 writeoff, 5 move); клиент продажи — `raw.client.id` → `clients.yclients_client_id`.
- `qty_base` по §8 (`toBaseInfo`); `recorded_at` при апсерте НЕ обновляется; `status='delete'` → `deleted_at`.
- Вебхук `good` → апсерт каталога тем же `parseCatalogGood`.

### 6.2 Наши документы — только локально
Форма сохраняет документ `status='posted'` (остаток меняется сразу) с движениями `source='loyalpro'`: `receipt` (+), `writeoff` (−), `move` (пара строк: − со склада-источника, + на склад-приёмник), `sale` (−), `consumable` (± — корректировка расходников записи, §6.5), `inventory` (± разница, §6.6). Отмена — `status='cancelled'`, движения `deleted_at`, причина обязательна. Правка проведённого документа запрещена — отменить и создать новый. Черновик (`draft`) есть только у инвентаризации.

### 6.3 Остатки и входящий остаток
- Включение: `scripts/stock-opening.js --salon=1 [--write]` — свежий `GET /goods` (`actual_amounts`, ед. продажи × `unit_equals`) → `stock_openings` (`taken_at = now`, `yc_qty_base` справочно) + документ `opening` с движениями `source='opening'` для истории, `stock_settings.enabled=TRUE`. Повтор запрещён; по товару — «Пересчитать от показания YClients» (owner, новая строка `stock_openings` с `note`).
- Остаток `(good, storage)` = `opening.qty_base + Σ qty_base` по строкам `deleted_at IS NULL` документов `posted`, где (уточнено ревью 14.11): **локальные движения (`source` `loyalpro`, `inventory`) считаются ВСЕГДА** — их нет в показании YClients по построению; **зеркальные (`webhook`, `reconcile`) — только впервые увиденные у нас ПОСЛЕ снимка** (`recorded_at > taken_at`: новая операция в YClients, в т. ч. внесённая задним числом); `backfill` и `opening` при наличии снимка не считаются (они уже в показании). Без входящего остатка считаются все строки. Леджер получает ИТОГОВУЮ строку `goods_transactions` после апсерта экономики (там живут защита от порядка по `last_change_date` и удаления), а не входящее событие. ОТКРЫТО (проверка в задаче 13): списания расходников с БУДУЩЕЙ датой визита, лежавшие у нас до снимка (545 строк), не считаются — верно, если YClients вычитает их из `actual_amounts` в момент создания; если нет — добавить клаузу «`occurred_at > taken_at` у зеркальных строк».
- SQL остатков — один запрос с CTE (экспортируется ради `scripts/stock-explain.js` с реальными bound-параметрами), индекс `(salon_id, good_row_id, storage_id) WHERE deleted_at IS NULL`; кэш 30 с по салону, инвалидация при любом движении.
- Отрицательный остаток разрешён и подсвечен; критический (`critical_amount`) — подсветка и счётчик в шапке. Показание YClients на момент снимка хранится и показывается в карточке товара как справка; текущих сверок с YClients нет (по построению расходятся).

### 6.4 Продажа клиенту
- Форма (страница и карточка записи): клиент (поиск по `clients`; номер вне базы → `ycSearchClientIdByPhone` + минимальная строка клиента, как делает журнал), мастер, склад (`for_sale` по умолчанию), строки `{товар, кол-во в ед. продажи, цена = local_sale_price ?? sale_price, скидка %}`, итог, оплаты `[{method: cash|card, amount}]` (сумма оплат = итогу или «подарок» явно). Бонусов среди способов НЕТ: решение владельца 13.11 — бонусы только на услуги.
- Сохранение — одна транзакция БД: документ `sale` `posted`, движения, по каждой оплате — `finance-ops.recordStockSalePayment({salonId, stockDocumentId, opId, method, amount, clientId, ycClientId, occurredAt})` → `finance_operations` `kind='goods_sale'`, `method cash|card`, статус `confirmed` сразу (денег в YClients нет, подтверждать нечего). Отмена продажи гасит эти строки (`cancelled`).
- Карточка пациента (`clients.js`, `openCD`) — блок «Покупки»; «История посещений» журнала берёт покупки из леджера (документы `sale` обоих источников) и `finance_operations`.

### 6.5 Записи ↔ списания ↔ техкарты (журнал)
- Вкладка «Расходники» карточки записи: по каждой услуге — факт (движения `consumable` с `record_id`+`service_yc_id`: зеркальные авто-списания YClients плюс наши корректировки), норма (техкарта по `pickTechCard(service_tech_cards, service, staff)` → `tech_cards.items`, цена `unitPriceAsOf`), расхождение (`over` при факте > норма × 1.2, `missing`, `extra`), сумма материалов визита. У неотправленной записи (`id<0`) — только норма.
- «Изменить расходники» → локальный документ `consumable` (`origin loyalpro`, `record_id`, `service_yc_id`, `master_staff_yc_id`) с движениями-ДЕЛЬТАМИ: пользователь задаёт целевой состав, код считает разницу с текущим фактом (`target − actual`) и пишет только ненулевые строки (знак любой). Повторная правка — новый документ. Авто-списания YClients не трогаются и продолжают приходить зеркалом; если YClients позже изменит состав (перепроведение записи), факт у нас изменится, а наша дельта останется — это видно в карточке как отдельная строка «корректировка LoyalPro». Склад по умолчанию — `default_service_storage_id`.
- Привязка техкарт к услугам — существующий UI экономики.

### 6.6 Инвентаризация
Документ `inventory` `draft`: склад и фильтр категории → строки с ожидаемым остатком на момент создания → ввод подсчёта (в ед. продажи или списания) → «Провести»: по каждой строке с разницей — движение `source='inventory'`, `qty_base = counted − expected`, документ `posted`. Черновик старше 7 дней помечается (ожидаемый остаток устарел); перед проведением ожидаемый остаток пересчитывается заново и разница считается от него.

### 6.7 Товары и категории
- Каталог YClients синхронизируется существующим `syncGoodsCatalog` + расширенные поля (`cost`, `barcode`, `critical_amount`, `desired_amount`, `unit_id`, `service_unit_id`, `comment`, `last_change_date`) + обход дерева `GET /goods_categories/{cid}/{parent}` (кап 200 запросов, пауза 400 мс, не чаще раза в 30 мин) → `category_path`, `parent_category_id`.
- **Локальный товар** (`POST /goods`): название, локальная категория (текст; выбор из существующих `local_category` + путей YClients для подсказки), единица продажи и списания (из `stock_units`), `unit_equals`, цена продажи, себестоимость (ручная — в `goods_price_overrides` тем же `setPriceOverride` экономики), критический остаток, штрихкод, заметка. Правка локального товара — все поля; правка товара YClients — только локальные поля (`local_sale_price`, `local_note`, `stock_active`, критический остаток у нас). Дедуп при создании: предупреждение, если нормализованное название совпадает с существующим товаром (не запрет).
- «Уходы» (`goods_sale_items`, `/api/home-care/product-tree`) не трогаем; локальные товары там не появляются (у них нет `category_id` и они не проходят Step A3 синка).

---

## 7. API `/api/stock` (`routes/stock.js`, `requireRole('owner','admin')`, поля JWT `req.user.salonId`/`userId`)

| Метод | Назначение |
|---|---|
| `GET /settings`, `PUT /settings` | склады по умолчанию |
| `GET /dictionaries` | склады, единицы, поставщики, мастера (из `journal_reference_cache`), категории (пути) — одним запросом для форм |
| `GET /storages`, `POST /storages` (локальный склад), `PUT /storages/:id`, `POST /storages/sync` | склады |
| `GET /units`, `POST /units`, `PUT /units/:id` | единицы |
| `GET /suppliers`, `POST`, `PUT /:id`, `DELETE /:id` (soft) | поставщики |
| `GET /goods?search&category&storage&only_critical&active&source` | товары с остатками по складам |
| `GET /goods/:id` | карточка: поля, остатки, движения (пагинация), приходы, техкарты, где используется, показание YClients на снимке |
| `POST /goods`, `PUT /goods/:id` | локальный товар / локальные поля (§6.7) |
| `POST /categories/sync` | обход дерева категорий (не чаще 30 мин) |
| `GET /balances?storage&category&only_critical&only_negative` | сводные остатки |
| `POST /openings/reset` `{goodRowId, storageId, note}` | «Пересчитать от показания YClients» (owner) |
| `GET /documents?kind&status&origin&from&to&storage&client&record&page` | журнал операций; `GET /documents/:id` |
| `POST /documents` `{kind: receipt|writeoff|move, storageId, toStorageId?, supplierId?, docDate, comment, lines:[{goodRowId, qty, unitType, costPerUnit, discount, comment}]}` | проведение (§8 валидация) |
| `POST /documents/:id/cancel` `{reason}` | отмена; у `origin='yclients'` — 409 |
| `POST /sales` `{clientId|phone, storageId, masterStaffYcId, recordId?, lines, payments:[{method: cash|card, amount}], gift?}` | продажа с оплатой (§6.4) |
| `GET /records/:recordId/consumables`, `PUT /records/:recordId/consumables/:serviceId` `{lines:[{goodRowId, qtyBase}]}` | расходники записи (§6.5) |
| `GET /clients/:clientId/purchases` | покупки клиента |
| `POST /inventories`, `GET /inventories/:id`, `PUT /inventories/:id/lines`, `POST /inventories/:id/post` | инвентаризация (§6.6) |
| `GET /reports/turnover?from&to&storage&category` | оборотка: начало, приход, расход, конец по товару (из леджера) |

Период капится 731 днём (общий `utils/period.js`); любая не-`StockError` → 502 `{error:'unavailable'}`; тексты YClients наружу не отдаются.

---

## 8. Чистая модель `services/stock/model.js` (без БД и сети)
- `KINDS`, `ORIGINS`, `YC_TYPE_BY_KIND = {sale:1, consumable:2, receipt:3, writeoff:4, move:5}`, `kindByYcType`, `signFor(kind)` (приход/opening +, остальное −; `move` — пара строк; `consumable`/`inventory` — знак по дельте).
- `toBaseInfo({kind, qty, unitType, unitEquals, costPerUnit, cost})` → `{qtyBase, unitUnknown}` (тип 2 — через `price.writeoffQty`), `toBase`, `fromBase(qtyBase, unitEquals)` → `{saleUnits, remainderBase}`.
- `validateDocument(body, ctx)` → `{ok, errors[], warnings[], normalized}`: вид, склад(ы), дата, строки (`qty > 0`, товар активен, `unitType ∈ {1,2}`, цена ≥ 0, скидка 0–100), `move` — разные склады, `sale` — клиент/телефон и итог > 0 либо `gift`.
- `validateSalePayments(payments, total, {gift})` → ошибки «сумма оплат ≠ итогу», метод только `cash|card`.
- `consumableDelta(targetLines, actualLines)` → строки-дельты `{goodRowId, qtyBase}` без нулей.
- `inventoryDiff(expectedBase, counted, countedUnitType, unitEquals)` → `{countedBase, diffBase}`.
- `balanceCountsRow(row, opening)` — правило §6.3 функцией (тест фиксирует словами).

---

## 9. UI

### 9.1 Меню и страница
`frontend/index.html`: пункт `Товары` в группе «Управление» (`data-p="stock"`, `data-roles="owner,admin"`, десктоп и мобильный ящик); `core/nav.js` — заголовок «Товары и склад», `loadStock()`, deep-links `#stock/doc/<id>`, `#stock/good/<rowId>` через `window._deepLinkArg`; `<div class="page" id="page-stock">`. Файлы: `frontend/js/pages/stock.js` (ядро), `stock-balances.js` (остатки, каталог, карточка товара, форма товара), `stock-docs.js` (журнал операций, карточка документа, формы прихода/списания/перемещения), `stock-sale.js` (продажа + оплата; вызывается и из карточки записи), `stock-inventory.js`, `stock-refs.js` (поставщики, единицы, склады, настройки). Префикс глобальных имён `stock`/`STOCK_` (общая глобальная область; `vm`-тест грузит все `<script>` `index.html`). CSS — `frontend/css/stock.css`; правка — с бампом `?v=`.

Вкладки: **Остатки** (товар × склады; фильтры категория/склад/«ниже критического»/«отрицательные»/поиск), **Товары** (каталог деревом категорий, карточка товара: поля, остатки, движения, приходы, техкарты, где используется, справка «YClients на снимке»; «+ Товар»), **Операции** (журнал с фильтрами, источник «LoyalPro»/«YClients», кнопки «Приход», «Списание», «Перемещение», «Продажа», «Инвентаризация»; карточка документа: строки, итог, «Отменить» с причиной), **Поставщики**, **Техкарты** (`ecoLoadTechCards('stockTechCards')`), **Инвентаризация**, **Оборотка**, **Настройки**. Обе темы, телефон 390px (таблицы → карточки).

### 9.2 Карточка записи журнала (`journal-card.js`)
Вкладка «Товары» (заглушка → живая): продажи, связанные с записью, «Продать товар» → `stockSaleOpen({recordId, clientId, staffYcId})`. Плитка «Списание расходников» → панель «Расходники»: по услугам норма / факт / разница / сумма, «Изменить» → редактор целевого состава → `PUT /records/:id/consumables/:serviceId`. Переключение вкладок не перерисовывает карточку (несохранённые правки живут).

### 9.3 Карточка пациента (`clients.js`)
Блок «Покупки» в `openCD`: дата, товары, сумма, способ оплаты; клик → `#stock/doc/<id>`.

---

## 10. Ошибки, лимиты, безопасность
- Чтения YClients — только существующими путями (вебхуки, ночной проход экономики, кнопка синка категорий с троттлингом 30 мин); `withRateLimitRetry` на 429.
- Записей в YClients нет вовсе.
- Роли `owner`/`admin`; owner-only: «Пересчитать от показания», настройки, отмена чужих документов старше суток.
- PII в леджере нет; тексты ошибок YClients не показываются.
- Все даты — Москва (`TZ=Europe/Moscow`), `doc_date` — timestamptz, день для отчётов — `AT TIME ZONE 'Europe/Moscow'`.

---

## 11. Решения, принятые без владельца (ПОДТВЕРДИТЬ)
1. ~~Бонусы при продаже~~ — РЕШЕНО владельцем 13.11: бонусы только на услуги, товары за бонусы не продаются.
2. **Касса и карта при продаже — локальная запись в `finance_operations`**, без кассы YClients и чека ККМ (чек — вне рамок).
3. **Правка расходников записи — локальной дельтой**, авто-списания YClients не трогаются.
4. **Локальные товары разрешены** (`yclients_good_id` nullable) — ПОДТВЕРЖДЕНО владельцем 13.11; они не попадают в «Уходы», техкарты и экономику процедур в v1.
5. **Правило счёта остатка** (§6.3): задним числом через вебхук считается, догон/сверка старых строк — нет.
6. **Входящий остаток — из `actual_amounts` YClients на момент включения**; дальше YClients и LoyalPro расходятся намеренно, сверок нет.
7. **Экономика процедур продолжает читать `goods_transactions`** — ПОДТВЕРЖДЕНО владельцем 13.11 (наши приходы не влияют на «цену последнего прихода» экономики).
8. **Роли** owner/admin; кассиру продажа не открыта.
9. **Пороги**: `over` расходников — факт > норма × 1.2 (как `overrun` экономики).

Открытые вопросы владельцу: нужна ли печать чека; продавать ли сертификаты/абонементы с этой страницы (подпроект 4).

---

## 12. Вне рамок v1
Любая запись склада в YClients; создание техкарт в YClients; сертификаты/абонементы (кроме зеркала); ККМ/чеки; штрихкод-сканер; локальные товары в техкартах и экономике; Мила; мобильное приложение; переключение экономики на леджер; многосалонный UI.

## 13. Проверки
- `npx jest backend/stock` (путь с префиксом обязателен), `backend/stock-ui.test.js` — `vm`-харнесс всех `<script>` `index.html`.
- `scripts/stock-explain.js` — EXPLAIN (ANALYZE) остатков, оборотки, журнала с реальными bound-параметрами + сверка JS-правила §6.3 с SQL на 200 случайных строках.
- `scripts/stock-opening.js --salon=1 [--write]` — входящий остаток; `scripts/stock-backfill-mirror.js --salon=1 [--write]` — переливка `goods_transactions` в леджер (остатки до/после одинаковы — проверка правила §6.3).
- `scripts/stock-e2e.js` — на дев-БД: приход → списание → перемещение → продажа тестовому клиенту 79200255591 с оплатой картой → инвентаризация → отмена; инварианты остатков и `finance_operations`; в YClients не пишет ничего.
- `scripts/stock-ui-e2e.js` — puppeteer: страница, вкладки, формы без сохранения, две темы, 390px.
