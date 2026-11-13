# Склад, товары, материалы и операции в LoyalPro («Управление → Товары») — дизайн

Дата: 13.11.2026. Подпроект 3 программы «функции YClients у нас» (решения владельца 12.11.2026: LoyalPro — главный для склада, YClients — копия; порядок журнал → финансы → склад → сертификаты). Ветка работ: `feat/stock-goods` от `main`. Прод не затрагивается до отдельного решения владельца.

Запрос владельца (13.11.2026): «проанализируй, как в YClients устроен склад, товары, материалы и операции, и реализуй аналогичное в LoyalPro, разместить в меню Управление → Товары. Связывать записи со списаниями со склада и техкартами, продажи и списания — с клиентами».

Спека написана в автономном режиме: вопросы владельцу задать было нельзя, поэтому все спорные решения собраны в §11 и помечены «подтвердить». План реализации — `docs/superpowers/plans/2026-11-13-stock-goods.md`.

---

## 1. Как склад устроен в YClients (по API-карте и живым данным PERI)

Источники: `docs/2026-11-12-yclients-api-capability-map.md` §3; живые read-only запросы 13.11.2026 с дев-токенов (`GET /storages`, `/goods/{cid}/{id}`, `/goods_categories/{cid}/{parent}`, `/user/permissions`, `/storage_operations/documents/{cid}/{id}`, `/technological_cards`); дев-копия прод-БД (`goods_transactions`, `yclients_goods_catalog`, `tech_cards`).

### 1.1 Сущности

| Сущность YClients | Что это | API | У PERI |
|---|---|---|---|
| **Склад** (`storage`) | Место хранения с флагами `for_service` (списания расходников) / `for_sale` (продажи) | только `GET /storages/{cid}`; CRUD нет | 2 склада: 1334902 «Расходники» (`for_service=1`), 1334903 «Космоцевтика» (`for_sale=1`) |
| **Категория товара** | Дерево: `parent_category_id`, `is_chain` (сетевая) | `GET /goods_categories/{cid}/{parent}` (0 — корни), POST/PUT/DELETE | Корни: Абонементы (сеть), Канцелярия, Косметика, Расходники, Сертификаты (сеть). Расходники → Аптека / Основные товары / Препараты. Косметика → бренды (Genosys, Forlled, TIZO, …) |
| **Товар** (`good`) | `title, article, barcode, category_id, cost` (цена продажи), `actual_cost` (себестоимость за ед. продажи), `unit_actual_cost` (за ед. списания), `unit_id`+`unit_short_title` (ед. продажи), `service_unit_id`+`service_unit_short_title` (ед. списания), `unit_equals` (сколько ед. списания в ед. продажи), `critical_amount`, `desired_amount`, `comment`, `actual_amounts[{storage_id, amount}]` (остатки по складам), `loyalty_abonement_type_id`/`loyalty_certificate_type_id` (абонементы и сертификаты — тоже товары), `last_change_date` | `GET /goods/{cid}` (постранично `count=100` до пустой страницы — см. память `ref_yclients_goods_pagination`), `GET /goods/{cid}/{id}`, `GET /goods/search`, POST/PUT/DELETE | 469 товаров в нашем зеркале (340 активных), 23 категории. Пример: «LIP мыло жидкое 500ml»: `unit` шт, `service_unit` мл, `unit_equals` 500, `actual_cost` 4254, `unit_actual_cost` 8.508 |
| **Единица измерения** | `unit{id,title,short_title}` | справочника в API НЕТ — только id в товарах и транзакциях | известны: 216760 «Штука/шт.», 216761 «мл», «пар.», «бу» |
| **Документ склада** | Шапка операции: `type_id`, `storage_id`, `create_date`, `comment`, `user_id`, `number`, транзакции | `POST /storage_operations/documents/{cid}` (типы 1/3/4), GET/PUT/DELETE; `GET .../documents/goods_transactions/{doc}`; `POST /storage_operations/operation/{cid}` — документ + транзакции ОДНИМ запросом (типы 1, 3, 4, 5) | — |
| **Товарная транзакция** | Строка документа: `good_id, amount` (со знаком: приход +, расход −), `cost_per_unit, discount (%), cost, operation_unit_type` (1 — в ед. продажи, 2 — в ед. списания), `storage`, `master`, `client`, `supplier`, `service`, `record_id`, `comment`, `good_special_number` (код сертификата/абонемента), `loyalty_certificate_id`/`loyalty_abonement_id` | `GET /storages/transactions/{cid}` (`page,count,start_date,end_date,document_id,changed_after` — `changed_after` ТОЛЬКО с временем, голая дата молча игнорируется), POST/GET/PUT/DELETE по id | 9 427 строк с 01.08.2026 в зеркале (см. §1.2) |
| **Техкарта** | Нормы расходников на услугу: `technological_card_items[{good_id, amount, price, storage_id, good{title, unit}}]`; привязка к услуге/мастеру — на стороне YClients | только чтение: `/technological_cards/{cid}/`, `default_for_staff_and_service/{cid}/{staff}/{service}/`, `record_consumables/{cid}/{record}/`; правка расходников конкретной записи `PUT …/record_consumables/consumables/{cid}/{record}/{service}/`, `DELETE …/record_consumables/technological_cards/…`. Создание/правка техкарт — НЕТ | 81 техкарта в зеркале, 16 привязок к услугам у нас |
| **Поставщик** | `supplier{id,title}` | CRUD/списка НЕТ; права `finances_suppliers_*` у интеграционного пользователя `false` | в наших транзакциях `supplier` всегда `[]` |
| **Остатки** | `actual_amounts` в карточке товара | отчёта «остатки на дату» НЕТ | по живым данным — в ЕДИНИЦАХ ПРОДАЖИ и могут быть ОТРИЦАТЕЛЬНЫМИ (LIP мыло на «Расходниках»: −8.118 шт при `unit_equals` 500) |
| **Инвентаризация** | тип документа 6 | создания через API НЕТ; права `storages_inventory_*` `false` | — |

### 1.2 Типы операций (`goods_transactions.type_id`) и их источники

Дев-копия БД, salon 1, строки с 01.08.2026 (удалённые исключены):

| type_id | Название | Строк | Документов | С `record_id` | Склады | `operation_unit_type` | Кто создаёт в YClients |
|---|---|---|---|---|---|---|---|
| 1 | Продажа товара | 260 | 162 | **0** | оба | 1 (ед. продажи) | администратор в «Продаже» (вне визита — у PERI продажи к записи не привязаны ни разу); сертификат — тоже продажа (`loyalty_certificate_id`) |
| 2 | Списание расходников | 8 941 | 798 | **все** | «Расходники» | 2 (ед. списания) | YClients АВТОМАТИЧЕСКИ по техкарте при сохранении записи (`create_date` = время визита, строки появляются за недели до визита) |
| 3 | Приход товара | 135 | 49 | 0 | оба | 1 и 2 | администратор, документ прихода (`cost` = сумма с учётом скидки поставщика) |
| 4 | Списание товара | 91 | 37 | 0 | оба | 1 и 2 | администратор: потери, подарки («за отзыв …»), заказы интернет-магазина («заказ через ИМ #6698») |
| 5 | Перемещение | 0 | — | — | — | — | — (у PERI не используется; прав у нашего пользователя нет) |

Вебхуки: `goods_operations_sale|receipt|consumable|stolen|move` (`status` create/update/delete; `data` = транзакция с вложенными `good, unit, storage, client, master, service, supplier`), `good`. Удаление приходит ТОЛЬКО вебхуком — API `/storages/transactions` удалённые не отдаёт. Доставка at-least-once, порядок не гарантирован (защита по `last_change_date` уже есть в `economics/store.upsertGoodsTransaction`).

### 1.3 Права интеграционного пользователя (живой `GET /user/permissions`, 13.11.2026; у `salons.yclients_user_token` и `YCLIENTS_INTEGRATION_USER_TOKEN` права ОДИНАКОВЫЕ)

| Право | Значение | Следствие для нас |
|---|---|---|
| `storages_access`, `storages_transactions_access`, `storages_last_days_count=-1` | true | читать всё, без ограничения по давности |
| `storages_create_transactions_access` (+`_buy_`, `_sale_`), `storages_edit_transactions_access`, `storages_delete_transactions_access` | true | приход (3), списание (4), продажа (1) — можно создавать, править, удалять |
| `storages_move_goods_access` | **false** | перемещение (5) в YClients отправить нельзя |
| `storages_inventory_*` | **false** | инвентаризации в YClients нет (и API создания нет) |
| `storages_goods_crud_access` true, но `storages_goods_create_access`, `_update_`, `_delete_`, `_title_edit_`, `_category_edit_`, `_selling_price_edit_`, `_cost_price_edit_`, `_units_edit_`, `_critical_balance_edit_` | **false** | создание/правка товара через API, скорее всего, вернёт 403 — проверить живьём (план, задача 1); до выдачи прав владельцем товары заводятся в YClients руками |
| `storages_goods_prime_cost_view_access` | false | при этом `actual_cost`/`unit_actual_cost` в `GET /goods` отдаются — право действует на отчёты |
| `storages_*_report_access` (остатки, продажи, расходники, списания, оборотка) | false | отчёты YClients нам недоступны — считаем свои |
| `finances_suppliers_read_access` | false | поставщики — только локально |

**Вывод:** API YClients закрывает приход/списание/продажу и чтение всего остального. Перемещения, инвентаризация, поставщики, единицы и правка товаров живут ТОЛЬКО в LoyalPro, пока владелец не выдаст права интеграционному пользователю (`storages_move_goods_access`, `storages_goods_*`) — тогда соответствующие ветки отправки включаются без правки кода (см. §6.2).

---

## 2. Что уже есть в LoyalPro (переиспользуем, не дублируем)

| Что | Где | Как используем |
|---|---|---|
| Зеркало товарных транзакций YClients `goods_transactions` (вебхук + ночная сверка `changed_after=−2д` + догон по датам + «пробелы» списаний) | `services/economics/goods-events.js`, `store.upsertGoodsTransaction`, `sync.js`, крон `5 5 * * *` | ЕДИНСТВЕННЫЙ вход зеркала. Леджер склада подписывается на апсерт хуком (§6.1), сверку не дублируем |
| Каталог товаров `yclients_goods_catalog` (+ `unit, service_unit, unit_equals, actual_cost, unit_actual_cost, stock, last_receipt_*`), синк `syncGoodsCatalog` (экономика, постранично весь каталог) и синк «Домашнего ухода» (`services/yclients-goods-catalog.js`, по известным категориям, soft-delete по `last_seen_at`) | `migrations.js` ~402, 2306; `economics/sync.js`; `yclients-goods-catalog.js` | Таблица товаров — ОДНА, эта. Расширяем колонками (§5.2). ГОТЧА: экономика вставляет расходники с `is_archived=TRUE`, чтобы они не попадали в выпадашку «Уходов»; `is_archived` нельзя читать как «товар удалён» — для склада признак активности свой (`stock_active`) |
| Цена единицы материала на дату (`price.unitPriceAsOf`: последний приход → ручная → себестоимость каталога), пересчёт количества списания `writeoffQty` (готча: часть списаний в ед. продажи при `operation_unit_type=2`) | `economics/price.js` | леджер хранит количество в базовых единицах через ТУ ЖЕ `writeoffQty` — вторая копия правила разъехалась бы |
| Техкарты: зеркало `tech_cards` (YClients + ручные), привязки `service_tech_cards` (manual > lookup > learned), UI вкладка «Техкарты» в «Экономике» | `economics/tech-cards.js`, `store.js`, `routes/economics.js`, `frontend/js/pages/economics.js` | Вкладка «Техкарты» в «Товарах» рендерит ТОТ ЖЕ код (общая глобальная область фронта); нормы техкарт — источник «ожидаемых расходников» в карточке записи |
| Кассовые операции `revenue_operations` (в т. ч. `category='goods'`, `sold_item_id` → `goods_transaction`), `finance_operations` (единый писатель `services/finance-ops.js`, kind `goods_sale`) | `services/revenue.js`, `services/finance-ops.js` | оплата продажи товара пишется через `finance-ops` новым входом; `revenue_operations` при эхе вебхука связывается с нашей строкой тем же правилом «совпало — не вставлять, а связать» |
| Журнал local-first: `journal_outbox` с `draftJson`, at-most-once, `payments.pay` → `POST /company/{cid}/sale/{document}/payment`, `removePayment`, карточка записи с заглушками вкладок «Товары» и «Списание расходников» (`journal-card.js:165`) | `services/journal/*`, `frontend/js/pages/journal-card.js` | тот же приём отправки (черновик строкой до отправки, идемпотентность, классификация сбоев `busy/slot_taken/uncertain`), тот же `yc.pay` для оплаты документа продажи |
| «История посещений» клиента: покупки из `finance_operations`, расходники под услугой из `goods_transactions` type 2 | `services/journal/visit-history.js` | дополняется документами склада (неотправленные продажи видны сразу) |
| Карта API YClients, пагинация `/goods`, слепота синка «Уходов» к новым категориям | `docs/2026-11-12-yclients-api-capability-map.md`, память `ref_yclients_goods_pagination`, `catalog_sync_new_category_blind_spot` | категории склада берём деревом `/goods_categories/{cid}/{parent}` рекурсивно — это и закрывает слепоту (новая категория видна без вставки руками) |

---

## 3. Цели и границы v1

### Цели
1. Страница **Управление → Товары** (owner, admin): остатки по складам, карточка товара с движением, журнал операций, документы прихода/списания/перемещения/продажи/инвентаризации, поставщики, единицы, техкарты, настройки.
2. **Леджер склада в LoyalPro — главный**: остаток считается у нас из входящего остатка и всех движений (наших и зеркала YClients); показание `actual_amounts` YClients — контрольная цифра, расхождения видны списком.
3. **Односторонняя отправка в YClients** того, что API принимает (приход, списание, продажа), по образцу журнала: пакет → очередь → `POST /storage_operations/operation` → связка транзакций с нашими строками; эхо вебхука не задваивает движение.
4. **Записи ↔ списания ↔ техкарты**: в карточке записи журнала видны фактические списания расходников (зеркало type 2), ожидание по техкарте и расхождение; расходники записи можно поправить (отправка `PUT record_consumables`).
5. **Клиенты ↔ продажи и списания**: продажа товара — клиенту (с оплатой через кассу/бонусы, в `finance_operations`), из карточки записи и со страницы; в карточке пациента и «Истории посещений» видны покупки и расходники визитов.

### Не делаем в v1 (§12)
Создание техкарт в YClients (API нет — техкарты ручные живут у нас, как сейчас), сертификаты и абонементы как товары (подпроект 4), ККМ/чеки, цены продажи «главные у нас» (цену продажи товара ведёт YClients, у нас — ручная переоценка только как поле каталога без отправки), Мила (отдельная ветка `feat/mila-commerce-catalog`), переключение экономики процедур на леджер (экономика продолжает читать `goods_transactions`; переключение — отдельным решением после месяца параллельной жизни), мобильное приложение, роли `specialist`/`admin_cashier`.

---

## 4. Принципы

1. **LoyalPro главный, YClients копия** (решение владельца 12.11.2026). Документ существует у нас с момента сохранения, остаток меняется сразу (наложение, как `overlay` журнала); в YClients он уходит отдельно и может не дойти — это видно статусом, а не теряется.
2. **Один леджер движений** `stock_movements` для ВСЕХ источников (зеркало YClients, наши документы, входящий остаток, инвентаризация). Остаток = сумма. Никаких «остаток в колонке товара, который кто-то обновляет».
3. **Одна единица хранения количества** — базовая единица списания (`qty_base`, мл/шт.), исходное количество и тип единицы сохраняются рядом. Пересчёт — через `unit_equals` каталога и общий `price.writeoffQty`.
4. **At-most-once отправка** и идемпотентность, как в журнале и уведомлениях: черновик запроса хранится СТРОКОЙ до отправки (JSONB переставляет ключи — готча журнала), `sending` до вызова, после реальной отправки ничего не возвращает документ в очередь; исход «неизвестно» (таймаут) — `uncertain`, без автоповтора, только сверка маркером.
5. **Эхо не задваивает**: транзакции, созданные нашей отправкой, связываются с нашими строками по `yclients_txn_id` из ответа; эхо вебхука/сверки на тот же id ОБНОВЛЯЕТ нашу строку (цены, даты), а не вставляет вторую. Гонка «эхо раньше ответа» решается слиянием: зеркальная строка, найденная при записи ответа, переключается на наш документ.
6. **Нельзя удалять и переписывать историю**: удаление — `deleted_at`, правка документа после отправки — только через YClients-совместимые операции (PUT/DELETE транзакции) и новую версию строк; аддитивные миграции `IF NOT EXISTS`.
7. **Всё по `salon_id`**; PII (имя/телефон клиента) в строки леджера не пишем — ссылка на `clients.id`/`yclients_client_id`.
8. **Деньги — через `finance-ops`** (единственный писатель `finance_operations`), бонусы — через тот же путь, что оплата визита.
9. **Квота YClients минутная и общая** с Милой/«Заботой»/экономикой: отправка — не чаще одного документа в 2 с, пачками ≤ 5 за тик; сверки — внутри существующего ночного прохода экономики (`5 5 * * *`), а не отдельным кроном.
10. **Мораторий на вторые копии правил**: критерий «визит состоялся», цена единицы, пересчёт количества, классификация сбоев YClients — импортируются, не копируются.

---

## 5. Модель данных (аддитивно, `migrations.js`, блок STOCK)

### 5.1 Новые таблицы

```sql
-- Склады: зеркало GET /storages + локальные поля.
stock_storages (
  id            BIGSERIAL PRIMARY KEY,
  salon_id      INT NOT NULL REFERENCES salons(id) ON DELETE CASCADE,
  yclients_storage_id BIGINT NOT NULL,
  title         VARCHAR(200) NOT NULL,
  for_service   BOOLEAN NOT NULL DEFAULT FALSE,
  for_sale      BOOLEAN NOT NULL DEFAULT FALSE,
  comment       TEXT,
  weight        INT,
  is_active     BOOLEAN NOT NULL DEFAULT TRUE,     -- пропал из GET /storages → FALSE (не удаляем)
  synced_at     TIMESTAMPTZ,
  UNIQUE (salon_id, yclients_storage_id)
)

-- Единицы измерения: собраны из unit{id,title,short_title} транзакций и каталога; CRUD локальный.
stock_units (
  id            BIGSERIAL PRIMARY KEY,
  salon_id      INT NOT NULL REFERENCES salons(id) ON DELETE CASCADE,
  yclients_unit_id BIGINT,                         -- NULL у локальной единицы
  title         VARCHAR(100) NOT NULL,
  short_title   VARCHAR(50) NOT NULL,
  UNIQUE (salon_id, yclients_unit_id) WHERE yclients_unit_id IS NOT NULL,
  UNIQUE (salon_id, lower(short_title))
)

-- Поставщики: только у нас (API нет).
stock_suppliers (
  id, salon_id, title VARCHAR(255) NOT NULL, inn VARCHAR(20), phone VARCHAR(32), email VARCHAR(120),
  contact VARCHAR(255), comment TEXT, is_active BOOLEAN DEFAULT TRUE, created_at, updated_at,
  UNIQUE (salon_id, lower(title))
)

-- Документ (шапка операции).
stock_documents (
  id            BIGSERIAL PRIMARY KEY,
  salon_id      INT NOT NULL REFERENCES salons(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL CHECK (kind IN ('receipt','writeoff','sale','move','inventory','consumable','opening')),
  origin        TEXT NOT NULL CHECK (origin IN ('loyalpro','yclients')),  -- наш документ / зеркало документа YClients
  status        TEXT NOT NULL CHECK (status IN ('draft','posted','cancelled')),  -- posted = проведён (движения считаются)
  sync_status   TEXT NOT NULL CHECK (sync_status IN ('local','queued','sending','sent','failed','uncertain','mirror')),
  storage_id    BIGINT REFERENCES stock_storages(id),          -- для move: откуда
  to_storage_id BIGINT REFERENCES stock_storages(id),          -- только move
  supplier_id   BIGINT REFERENCES stock_suppliers(id) ON DELETE SET NULL,
  client_id     INT REFERENCES clients(id) ON DELETE SET NULL,  -- sale
  yclients_client_id BIGINT,
  record_id     BIGINT,                                        -- sale из карточки записи; consumable — запись визита
  master_staff_yc_id BIGINT,
  doc_date      TIMESTAMPTZ NOT NULL,                          -- дата операции (create_date YClients)
  comment       TEXT,
  total_cost    NUMERIC(14,2),                                 -- Σ cost строк (приход — закупка, продажа — к оплате)
  yclients_document_id BIGINT,                                 -- после отправки / из зеркала
  draft_json    TEXT,                                          -- ТЕЛО запроса в YClients строкой (готча JSONB)
  attempts      SMALLINT NOT NULL DEFAULT 0, next_attempt_at TIMESTAMPTZ, error_code TEXT, error_text TEXT,
  created_by    INT, created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW(), posted_at TIMESTAMPTZ, cancelled_at TIMESTAMPTZ,
  UNIQUE (salon_id, yclients_document_id) WHERE yclients_document_id IS NOT NULL
)
-- индексы: (salon_id, doc_date DESC), (salon_id, sync_status) WHERE sync_status IN ('queued','sending'), (salon_id, record_id) WHERE record_id IS NOT NULL, (salon_id, client_id) WHERE client_id IS NOT NULL

-- Движение (строка документа). Знак: приход +, расход −. qty_base — в единице списания.
stock_movements (
  id            BIGSERIAL PRIMARY KEY,
  salon_id      INT NOT NULL REFERENCES salons(id) ON DELETE CASCADE,
  document_id   BIGINT NOT NULL REFERENCES stock_documents(id) ON DELETE CASCADE,
  good_row_id   BIGINT NOT NULL REFERENCES yclients_goods_catalog(id),   -- ВНУТРЕННИЙ id товара, не yclients_good_id
  storage_id    BIGINT NOT NULL REFERENCES stock_storages(id),
  qty           NUMERIC(14,4) NOT NULL,          -- как ввели/как пришло (со знаком)
  unit_type     SMALLINT NOT NULL,               -- 1 ед. продажи / 2 ед. списания (operation_unit_type)
  qty_base      NUMERIC(16,4) NOT NULL,          -- в ед. списания, со знаком (writeoffQty + unit_equals)
  cost_per_unit NUMERIC(14,4), discount NUMERIC(8,2), cost NUMERIC(14,2),
  record_id     BIGINT, service_yc_id BIGINT, master_staff_yc_id BIGINT,
  yclients_txn_id BIGINT,                        -- связка с goods_transactions.yclients_txn_id
  source        TEXT NOT NULL CHECK (source IN ('webhook','reconcile','backfill','loyalpro','opening','inventory')),
  occurred_at   TIMESTAMPTZ NOT NULL,            -- create_date YClients / doc_date
  recorded_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),  -- когда строка впервые появилась у НАС (правило счёта §6.3)
  deleted_at    TIMESTAMPTZ,
  comment       TEXT,
  UNIQUE (salon_id, yclients_txn_id) WHERE yclients_txn_id IS NOT NULL
)
-- индексы: (salon_id, good_row_id, storage_id) WHERE deleted_at IS NULL; (salon_id, record_id) WHERE record_id IS NOT NULL; (salon_id, occurred_at)

-- Входящий остаток: снимок actual_amounts в момент включения модуля (или «принять показание YClients» по товару).
stock_openings (
  id, salon_id, good_row_id BIGINT NOT NULL, storage_id BIGINT NOT NULL,
  qty_base NUMERIC(16,4) NOT NULL, taken_at TIMESTAMPTZ NOT NULL, source TEXT NOT NULL DEFAULT 'yclients_actual_amounts',
  note TEXT, created_by INT,
  UNIQUE (salon_id, good_row_id, storage_id)      -- одна действующая строка; повтор перезаписывает (история — в stock_movements kind opening)
)

-- Контрольные показания YClients и расхождения (ночью и по кнопке).
stock_readings (
  salon_id, good_row_id, storage_id, yc_qty_base NUMERIC(16,4), our_qty_base NUMERIC(16,4),
  diff_base NUMERIC(16,4), read_at TIMESTAMPTZ, PRIMARY KEY (salon_id, good_row_id, storage_id)
)

-- Инвентаризация: подсчёт по строкам; проведение создаёт документ inventory с движениями-корректировками.
stock_inventory_lines (
  id, salon_id, document_id BIGINT REFERENCES stock_documents(id) ON DELETE CASCADE,
  good_row_id, storage_id, expected_base NUMERIC(16,4), counted NUMERIC(14,4), counted_unit_type SMALLINT,
  counted_base NUMERIC(16,4), diff_base NUMERIC(16,4), UNIQUE (document_id, good_row_id)
)

stock_settings (
  salon_id INT PRIMARY KEY REFERENCES salons(id) ON DELETE CASCADE,
  enabled  BOOLEAN NOT NULL DEFAULT FALSE,              -- леджер включён (сделан входящий остаток)
  auto_send BOOLEAN NOT NULL DEFAULT FALSE,             -- приход/списание уходят сами; FALSE — по кнопке «Отправить в YClients» (как журнал)
  default_sale_storage_id BIGINT, default_service_storage_id BIGINT,
  send_moves BOOLEAN NOT NULL DEFAULT FALSE,            -- включить после выдачи права storages_move_goods_access
  send_goods_crud BOOLEAN NOT NULL DEFAULT FALSE,       -- включить после выдачи storages_goods_create/update
  updated_at TIMESTAMPTZ
)
```

### 5.2 Расширение `yclients_goods_catalog` (товар)

Добавить `IF NOT EXISTS`: `category_id_path JSONB` (путь категорий `[{id,title}]` от корня), `parent_category_id BIGINT`, `sale_price NUMERIC(14,2)` (`cost` YClients), `barcode VARCHAR(64)`, `unit_id BIGINT`, `service_unit_id BIGINT`, `critical_amount NUMERIC(14,4)`, `desired_amount NUMERIC(14,4)`, `comment TEXT`, `loyalty_abonement_type_id BIGINT`, `loyalty_certificate_type_id BIGINT`, `yc_last_change_date TIMESTAMPTZ`, `stock_active BOOLEAN NOT NULL DEFAULT TRUE` (признак активности для СКЛАДА — `is_archived` занят «Уходами»), `local_note TEXT`, `local_sale_price NUMERIC(14,2)` (наша переоценка, в YClients не уходит без права), `yc_sync_error TEXT`.

`yclients_good_id` остаётся `NOT NULL`: товар появляется у нас ТОЛЬКО с id YClients (см. §6.2 — создание товара синхронно через API либо руками в YClients). Это сознательное упрощение v1: товар без id YClients не мог бы участвовать ни в одной отправляемой операции.

### 5.3 Связи с существующими таблицами
- `finance_operations`: новая колонка `stock_document_id BIGINT` (навигация); идемпотентность оплаты продажи — через уже существующий `step_op_id` (uuid операции, origin `loyalpro`, kind `goods_sale`).
- `goods_transactions` не меняется: остаётся сырым зеркалом для экономики. Леджер читает его через хук апсерта, а не JOIN в рантайме.

---

## 6. Потоки

### 6.1 Зеркало YClients → леджер
`economics/store.upsertGoodsTransaction` после записи зовёт `stock/ledger.ingestMirrored(salonId, row, {status, source})` (через `safely()`: сбой леджера не ломает экономику). Правила:
- `good_row_id` — по `yclients_good_id = row.good_id`; товара нет в каталоге → строка в `stock_ingest_pending` (очередь «неизвестный товар», ночной проход каталога её разбирает) и WARN; `storage_id` — апсерт `stock_storages` по `row.storage_id`+`title` из `raw.storage` (склад, которого нет в `GET /storages`, всё равно появляется).
- Документ-шапка `origin='yclients', sync_status='mirror'` создаётся/находится по `(salon_id, yclients_document_id = row.document_id)`; `kind` по `type_id`: 1 → `sale`, 2 → `consumable`, 3 → `receipt`, 4 → `writeoff`, 5 → `move`. Клиент продажи — по `raw.client.id` → `clients.yclients_client_id` (телефон/имя не пишем).
- `qty_base = writeoffQty(row, unit_equals) × sign` для `unit_type=2`; `row.amount × unit_equals` для `unit_type=1` (нет `unit_equals` → `qty_base = qty`, флаг `unit_unknown` в comment и WARN).
- Строка с `yclients_txn_id`, УЖЕ принадлежащая нашему документу (`source='loyalpro'`), обновляется ценами/датами, но не переключается на зеркальный документ (эхо нашей отправки).
- `status='delete'` → `deleted_at` (как в `goods_transactions`).
- Вебхук `good` (create/update/delete) → апсерт каталога тем же `parseCatalogGood` из `economics/sync.js`.

### 6.2 Наш документ → YClients
1. Форма сохраняет документ: `status='posted'` сразу (остаток меняется у нас), `sync_status`: `queued` при `auto_send` или при продаже с оплатой; `local` — если тип не отправляется (move без `send_moves`, inventory, opening) или `auto_send=false` (тогда кнопка «Отправить в YClients (N)» переводит `local → queued`, как dispatch журнала).
2. Воркер `services/stock/outbox-worker.js` (тик 5 с, аренда `FOR UPDATE SKIP LOCKED`, один документ салона за раз, пауза 2 с между документами): формирует тело `POST /storage_operations/operation/{cid}` — `{type_id, create_date (мск), storage_id, master_id, comment: '[LP#<id>] ' + comment, goods_transactions:[{good_id, amount (со знаком, как у YClients), cost_per_unit, discount, cost, operation_unit_type, client_id?, master_id?, comment?}]}`; тело хранится в `draft_json` ДО отправки, повтор отправляет ТО ЖЕ тело.
3. Ответ: `document.id` → `yclients_document_id`; транзакции ответа сопоставляются с нашими строками по порядку и `good_id`+`amount` → `yclients_txn_id`. Зеркальная строка с таким id, уже лежащая в леджере (эхо обогнало), переносится на наш документ, её шапка-зеркало, оставшаяся пустой, помечается `cancelled`.
4. Сбои — классификация как у журнала (`outbox-worker.classify`): сеть/429/5xx → повтор 5 с → 30 с → 2 мин → 10 мин (6 попыток); 4xx с текстом → `failed` (текст YClients — в лог, пользователю код); таймаут после отправки → `uncertain`: воркер при следующем тике ищет документ по маркеру `[LP#id]` через `GET /storages/transactions?changed_after=<за 10 мин до отправки>` и, найдя, связывает; не найдя за 30 мин — остаётся `uncertain`, кнопки «Повторить» нет (повтор = второй документ), только «Отправить заново» с явным подтверждением, которое создаёт НОВЫЙ документ-копию и гасит старый `cancelled`.
5. Маркер `[LP#id]` в комментарии — единственный способ опознать свой документ после потери ответа; он же защищает ночную сверку от второго документа.
6. 403 на перемещении / правке товара → `failed` с кодом `no_permission` и подсказкой «выдайте право интеграционному пользователю в YClients»; остаток у нас при этом уже верный.

Правка/отмена отправленного документа: `cancelled` → `DELETE /storage_operations/documents/{cid}/{doc}` (одна операция, те же статусы); правка строк после отправки запрещена — отменить и создать новый (как делает YClients с проведёнными документами).

### 6.3 Остатки, входящий остаток, сверка
- Включение модуля: `scripts/stock-opening.js --salon=1 [--write]` — берёт `actual_amounts` каждого товара из свежего `GET /goods` (ед. продажи → `× unit_equals`), пишет `stock_openings` (`taken_at = now`) и `stock_settings.enabled=TRUE`. До включения страница показывает только зеркало операций без остатков.
- Остаток `(good, storage)` = `opening.qty_base + Σ qty_base` по строкам `deleted_at IS NULL`, у которых **(`occurred_at > taken_at`) ИЛИ (`recorded_at > taken_at` И `source IN ('webhook','loyalpro','inventory')`)**. Смысл: вебхук о задним числом внесённом приходе считается (его не было в снимке), а догон/сверка старых строк (`reconcile`/`backfill`, которые уже сидели в снимке) — нет. Остаточный риск — правка старой строки зеркалом сверки не меняет остаток; её ловит контрольное показание.
- SQL остатков — один запрос с CTE (экспортируется ради `scripts/stock-explain.js` с реальными bound-параметрами — правило проекта), покрыт индексом `(salon_id, good_row_id, storage_id) WHERE deleted_at IS NULL`. Кэш 30 с по салону, инвалидация при любом движении.
- Контроль: в ночном проходе экономики после `syncGoodsCatalog` — `stock_readings` = `actual_amounts × unit_equals` против нашего остатка; `|diff| > 0.5 ед. списания` — расхождение; список на вкладке «Остатки» (фильтр «с расхождениями»), кнопка «Принять показание YClients» = новая строка `stock_openings` для товара (с `note` и автором) + движение `kind opening` в леджере для истории. Автоматически ничего не правится (как у баланса бонусов).
- Отрицательный остаток разрешён (так живёт YClients) и подсвечен; критический остаток (`critical_amount`) — подсветка и счётчик в шапке страницы.

### 6.4 Продажа клиенту
- Форма продажи (страница «Товары → Операции → Продажа» и карточка записи → вкладка «Товары»): клиент (поиск по `clients`, как в журнале; номер вне базы → поиск в YClients `clients/search`, как в тесте напоминаний), мастер, склад (`for_sale` по умолчанию), строки `{товар, кол-во в ед. продажи, цена = local_sale_price ?? sale_price, скидка %}`, итог.
- «Продать и оплатить»: документ `sale` создаётся `posted`, `sync_status='queued'` с приоритетом (оплата возможна только после документа в YClients) → воркер отправляет сразу (вне очереди `auto_send`) → по `yclients_document_id` выполняется оплата тем же `journal/yclients.pay(salon, documentId, method, amount)` (`loyalty_card`/`account`) — задача 1 плана ЖИВЬЁМ проверяет, что `/sale/{doc}/payment` принимает документ продажи товара; если нет — оплата через `POST /finance_transactions/{cid}` с `document_id` (запасной путь, тоже проверяется задачей 1). Оплата — отдельный шаг в `draft_json` документа (`payments[]`), идемпотентный по `op_id`.
- Деньги: `finance-ops.recordStockSalePayment({stockDocumentId, opId, method, amount, clientId, status})` → строка `kind='goods_sale'`, origin `loyalpro`; эхо `finances_operation`/`revenue_operations` с `sold_item_id` = наша `yclients_txn_id` связывается с этой строкой, а не вставляется второй (правило `finance-ops` «совпало — связать»).
- Бонусы: списание бонусов при продаже — тот же `loyalty_card` метод и тот же путь `bonus-ledger`, что у визита (ничего нового).
- Карточка пациента (`clients.js`, `openCD`) — блок «Покупки» (документы `sale` клиента: дата, товары, сумма, статус отправки); «История посещений» журнала — покупки берёт из леджера (включая неотправленные), а не только из `finance_operations`.

### 6.5 Записи ↔ списания ↔ техкарты (журнал)
- Вкладка «Расходники» карточки записи: по каждой услуге — факт (движения `consumable` с `record_id`+`service_yc_id`; у неотправленной записи `id<0` — пусто), норма (техкарта по `pickTechCard(service_tech_cards, service, staff)` → `tech_cards.items`, цена единицы `unitPriceAsOf`), расхождение факта и нормы (как `overrun`/`no_consumables` экономики, но по записи), сумма материалов визита. Записи, созданные нашим журналом, получают списания от YClients автоматически (техкарты привязаны в YClients) — мы их только показываем.
- «Изменить расходники»: редактор строк услуги → `PUT /technological_cards/record_consumables/consumables/{cid}/{record}/{service}/` с полным составом (`consumables[{goods_transaction_id?, record_id, service_id, storage_id, good_id, price, amount}]`) — отправка документом `kind='consumable', origin='loyalpro'` через тот же воркер (отдельная ветка тела запроса); ответ/эхо обновляет зеркало. Форма этого запроса в документации описана схемой, живьём не проверена — задача 1 плана проверяет на тестовой записи 79200255591; при отказе API вкладка остаётся read-only с кнопкой «Открыть в YClients».
- Привязка техкарт к услугам — существующий UI экономики (вкладка «Техкарты» страницы «Товары» показывает его же).

### 6.6 Инвентаризация (только локально)
Документ `inventory` в статусе `draft`: выбор склада и фильтра категорий → строки с ожидаемым остатком → ввод подсчёта (в ед. продажи или списания) → проведение: по каждому расхождению создаётся движение `source='inventory'` с `qty_base = counted − expected` в документе инвентаризации; документ `sync_status='local'`. Кнопка «Выровнять YClients» (owner): формирует ДВА обычных документа — `writeoff` (недостачи) и `receipt` (излишки, `cost_per_unit` = текущая цена единицы) — и ставит их в очередь; это единственный способ довести остатки YClients до наших при отсутствии API инвентаризации, и он помечен в документах комментарием «по инвентаризации [LP#id]».

### 6.7 Товары и категории
- Каталог синхронизируется существующим `syncGoodsCatalog` (экономика) + новый обход дерева `GET /goods_categories/{cid}/{parent}` рекурсивно → `category_id_path`, `parent_category_id`; расширенные поля (`cost`, `barcode`, `critical_amount`, `desired_amount`, `unit_id`, `service_unit_id`, `comment`, `last_change_date`) — из того же `/goods` ответа (`parseCatalogGood` расширяется).
- Создание/правка товара со страницы: при `send_goods_crud=FALSE` (дефолт, прав нет) — форма создания скрыта, показывается подсказка «товары заводятся в YClients; выдайте права интеграционному пользователю, чтобы заводить здесь»; локальные поля (`local_note`, `local_sale_price`, `stock_active`, критический остаток — пока только локально) редактируются всегда. При `send_goods_crud=TRUE` — создание СИНХРОННО `POST /goods/{cid}` (ответ даёт id → строка каталога; отказ → 4xx пользователю, товар не создаётся), правка — `PUT /goods/{cid}/{id}`.
- «Уходы» (`goods_sale_items`, `/api/home-care/product-tree`) не трогаем: их чёрный список категорий и `is_archived` остаются как есть.

---

## 7. API `/api/stock` (`routes/stock.js`, `requireRole('owner','admin')`, поля JWT `req.user.salonId`/`userId`)

| Метод | Назначение |
|---|---|
| `GET /settings`, `PUT /settings` | настройки §5.1 (`auto_send`, склады по умолчанию, `send_moves`, `send_goods_crud`); `PUT` с `send_*=true` сначала живьём проверяет `GET /user/permissions` и отвечает 409, если права нет |
| `GET /storages`, `POST /storages/sync` | склады и пересинк |
| `GET /units`, `POST /units`, `PUT /units/:id` | единицы |
| `GET /suppliers`, `POST`, `PUT /:id`, `DELETE /:id` (soft) | поставщики |
| `GET /goods?search&category&storage&only_critical&only_diff&active` | товары с остатками по складам, показанием YClients, расхождением |
| `GET /goods/:id` | карточка: поля, остатки, движения (пагинация), приходы, техкарты, где используется |
| `PUT /goods/:id/local` | локальные поля |
| `POST /goods`, `PUT /goods/:id` | только при `send_goods_crud` (§6.7) |
| `POST /categories/sync` | обход дерева категорий |
| `GET /balances?storage&category` | остатки сводно (вкладка «Остатки»), `GET /balances/discrepancies` |
| `POST /openings/accept` `{goodRowId, storageId, note}` | «Принять показание YClients» |
| `GET /documents?kind&status&sync_status&from&to&storage&client&record` | журнал операций (наши + зеркало), `GET /documents/:id` |
| `POST /documents` `{kind: receipt|writeoff|move, storageId, toStorageId?, supplierId?, docDate, comment, lines:[{goodRowId, qty, unitType, costPerUnit, discount}]}` | валидация по модели (§8), `posted` сразу, `sync_status` по настройке |
| `POST /documents/:id/cancel` | отмена (+ `DELETE` в YClients, если был отправлен) |
| `POST /documents/send` `{ids?|from,to}` | перевод `local → queued` (кнопка «Отправить в YClients») ; `GET /documents/unsent-count` |
| `POST /documents/:id/resend` | для `uncertain`/`failed`: новый документ-копия, старый `cancelled` (с подтверждением на фронте) |
| `POST /sales` `{clientId|phone, storageId, masterStaffYcId, recordId?, lines, payments:[{method, methodId, amount}]}` | продажа с оплатой (§6.4); ответ — документ и статус оплаты |
| `GET /sales/:id/payment-options` | способы оплаты и баланс бонусов клиента (тот же код, что `journal/payments-local`) |
| `GET /records/:recordId/consumables` | факт/норма/расхождение по услугам записи (§6.5); `PUT /records/:recordId/consumables/:serviceId` |
| `GET /clients/:clientId/purchases` | покупки клиента (карточка пациента) |
| `POST /inventories`, `PUT /inventories/:id/lines`, `POST /inventories/:id/post`, `POST /inventories/:id/align-yclients` | инвентаризация (§6.6) |
| `GET /reports/turnover?from&to&storage` | оборотная ведомость: начало, приход, расход, конец по товару (из леджера) |

Все записи в YClients идут только через воркер (кроме синхронного создания товара и `permissions`-проверки). Ошибки YClients наружу — кодами (`no_permission`, `rejected`, `uncertain`, `unavailable`), текст YClients — только в лог (правило журнала).

---

## 8. Чистая модель `services/stock/model.js` (без БД и сети, покрывается юнит-тестами)
- `KINDS`, `SYNC_STATUSES`, `YC_TYPE_BY_KIND = {sale:1, consumable:2, receipt:3, writeoff:4, move:5}`, `kindByYcType`.
- `toBase({qty, unitType, unitEquals, costPerUnit, cost})` → `qty_base` со знаком (через `price.writeoffQty` для `unitType=2`), `fromBase(qtyBase, unitEquals)` → `{saleUnits, remainderBase}` для отображения «2 шт + 150 мл».
- `signFor(kind)`: приход/опening +, остальное − (для `move` — пара строк: − со склада-источника, + на склад-приёмник).
- `validateDocument(body, ctx)` → `{ok, errors[], normalized}`: тип, склад существует и подходит (`for_service`/`for_sale` — предупреждение, не запрет), строки непустые, `qty > 0`, товар активен, `unitType ∈ {1,2}`, цена ≥ 0, скидка 0–100, для `move` склады разные; `sale` — клиент или телефон, итог > 0 или явное «подарок».
- `buildOperationBody(doc, lines, goodsById, {marker})` → тело `POST /storage_operations/operation` (детерминированное — порядок строк как в документе); `buildConsumablesBody(...)` → тело `PUT record_consumables`.
- `matchResponseTransactions(lines, responseTxns)` → `[{lineId, yclientsTxnId}]` по порядку с проверкой `good_id` и `amount`; несовпадение длины → `uncertain_match` (документ `sent`, но строки без связки → сверка маркером).
- `classifySendError(e)` — импорт `journal/outbox-worker.classify` вынести в общий `services/yclients-write-errors.js` (одно правило на журнал и склад; план, задача 5).
- `balanceCountsRow(row, opening)` — правило §6.3 как функция (тест фиксирует его словами).

---

## 9. UI

### 9.1 Меню и страница
`frontend/index.html`: пункт `Товары` в группе «Управление» (`data-p="stock"`, `data-roles="owner,admin"`, в обоих меню — десктоп и мобильный ящик); `core/nav.js` — заголовок «Товары и склад», `loadStock()`; `<div class="page" id="page-stock">`. Файлы: `frontend/js/pages/stock.js` (ядро: состояние `_stock`, `stockApi`, вкладки, фильтры), `stock-balances.js` (остатки и расхождения — чистые помощники `stockFmtQty`, `stockBalanceRows`), `stock-docs.js` (журнал операций, карточка документа, формы прихода/списания/перемещения, статусы и «Отправить в YClients»), `stock-sale.js` (форма продажи + оплата; используется и из карточки записи журнала), `stock-inventory.js`, `stock-refs.js` (поставщики, единицы, настройки). Префикс глобальных имён `stock`/`STOCK_` (общая глобальная область; `vm`-тест грузит все `<script>` `index.html` одним контекстом, как `journal-ui.test.js`). CSS — `frontend/css/stock.css`. Правка JS/CSS — с бампом `?v=`.

Вкладки: **Остатки** (таблица товар × склады, фильтры категория/склад/«ниже критического»/«с расхождением», показание YClients и дельта, «Принять показание»), **Товары** (каталог: поиск, категории деревом, карточка товара справа/модалкой: поля, остатки, движения, приходы, техкарты, где используется; локальные поля), **Операции** (журнал документов с фильтрами; кнопки «Приход», «Списание», «Перемещение», «Продажа», «Инвентаризация»; «Отправить в YClients (N)»; карточка документа со строками, статусом отправки, ошибкой, «Отменить», «Отправить заново»), **Поставщики**, **Техкарты** (рендер кодом экономики: `ecoLoadTechCards(container)` — параметр контейнера добавить), **Инвентаризация**, **Настройки**.

Визуально — как остальные страницы Ivory & Brass (переменные темы, обе темы, телефон 390px: таблицы в карточки). Статусы отправки — те же плашки и цвета, что у журнала («Ждёт отправки», «Передаётся», «Отправлено», «Ошибка», «Не подтверждено», «Только в LoyalPro»).

### 9.2 Карточка записи журнала (`journal-card.js`)
Вкладка «Товары» (сейчас заглушка `jrStub('Товары')`): список продаж, связанных с записью (`record_id`), кнопка «Продать товар» → `stockSaleOpen({recordId, clientId, staffYcId})` (та же форма). Плитка «Списание расходников» (заглушка) → вкладка «Расходники»: таблица по услугам (норма / факт / разница / сумма), «Изменить» (§6.5). Несохранённые правки карточки не теряются (вкладки переключаются без перерисовки — правило паритета v1).

### 9.3 Карточка пациента (`clients.js`)
Блок «Покупки» в `openCD`: дата, товары, сумма, статус; клик — карточка документа на странице «Товары» (hash `#stock/doc/<id>`).

Глубокие ссылки: `#stock/doc/<id>`, `#stock/good/<rowId>` через `window._deepLinkArg` (как у чата).

---

## 10. Ошибки, лимиты, безопасность
- Квота YClients: воркер — ≤ 5 документов за тик, пауза 2 с, при 429 — `withRateLimitRetry` (общий `yclients-retry.js`, 2 повтора по 60 с) и откладывание документа; синк категорий — не чаще раза в 30 мин (кэш в `stock_settings`-подобной строке `categories_synced_at`).
- Любой запрос в YClients — с таймаутом 30 с (как журнал); исход после отправки неизвестен → `uncertain`, никаких автоповторов.
- Отмена документа, который YClients уже удалил (404) — считается выполненной.
- Права: `owner`/`admin`; «Принять показание», «Выровнять YClients», «Отправить заново», настройки `send_*` — только `owner`.
- Тексты ошибок YClients не показываются (502 `unavailable` + код), PII в движениях нет, клиент — по id.
- Все даты — Москва; `doc_date` для YClients — `YYYY-MM-DD HH:MM:SS` по Москве (как `create_date` документа в ответе YClients).

---

## 11. Решения, принятые без владельца (ПОДТВЕРДИТЬ до выката на прод)
1. **Отправка в YClients по умолчанию кнопкой**, как в журнале (`auto_send=false`); продажа с оплатой уходит сразу всегда (иначе оплатить нечего). Альтернатива — `auto_send=true` для прихода/списания.
2. **Товары создаются в YClients руками**, пока у интеграционного пользователя нет прав `storages_goods_create/update` (владелец может выдать их в настройках сотрудников YClients → тогда включается `send_goods_crud`). Товар без id YClients в v1 не существует.
3. **Перемещения и инвентаризация — только у нас**; выравнивание YClients по инвентаризации — парой документов приход/списание по кнопке владельца. При выдаче права на перемещения — `send_moves=true`.
4. **Поставщик — локальный справочник**; в YClients уходит текстом в комментарии документа («Поставщик: …»), поля `supplier_id` нет.
5. **Продажа из карточки записи — отдельный документ продажи**, связанный с записью у нас, а НЕ строки `goods_transactions` визита (у PERI за три месяца 0 продаж, привязанных к визиту; привязка через `PUT /visits` потребовала бы полного PUT визита с услугами — риск цен). Оплата продажи — своя (не форма оплаты визита).
6. **Правило счёта остатка** (§6.3): задним числом внесённое через вебхук — считается, догон/сверка старых строк — нет; расхождения — показанием YClients.
7. **Экономика процедур продолжает читать `goods_transactions`**; леджер — рядом; переключение после месяца параллельной работы.
8. **Роли**: owner/admin; кассиру (`admin_cashier`) продажа не открыта.
9. **Пороги**: расхождение ≥ 0.5 базовой единицы; `overrun` расходников записи — факт > норма × 1.2 (как в экономике).

Открытые вопросы владельцу: нужны ли права для API (п. 2, 3); нужна ли печать чека продажи (ККМ) — в v1 нет; должны ли сертификаты/абонементы продаваться с этой же страницы (сейчас — подпроект 4, их продажи в журнале операций видны как зеркало).

---

## 12. Вне рамок v1
Создание техкарт в YClients; сертификаты/абонементы (кроме отображения зеркала); ККМ/чеки; штрихкод-сканер; цена продажи главная у нас; Мила; мобильное приложение; переключение экономики на леджер; отчёты YClients (своих три: остатки, движение товара, оборотка); многосалонность в UI (данные — по `salon_id`, страница — текущий салон).

## 13. Живые проверки и тесты
- `npx jest backend/stock` (путь с префиксом — голый шаблон в рабочей копии с «stock» в имени гнал бы весь репозиторий), `node --test`/`vm` для фронта (`backend/stock-ui.test.js` грузит все `<script>` `index.html`).
- `scripts/stock-explain.js` — EXPLAIN (ANALYZE) SQL остатков и аренды воркера с реальными bound-параметрами.
- `scripts/stock-opening.js --salon=1 [--write]` — входящий остаток (сухой прогон по умолчанию).
- `scripts/stock-e2e.js` — на деве: приход тестового товара (владелец заводит в YClients товар «ТЕСТ LoyalPro», категория Расходники → Основные) → списание → продажа 79200255591 на 1 ₽ с оплатой картой и удалением оплаты → отмена документов (`DELETE`); проверяет связку эха и отсутствие дублей в леджере; ОТКАЗЫВАЕТСЯ работать при online pm2 `loyalpro` (его воркер и воркер скрипта делили бы очередь).
- `scripts/stock-ui-e2e.js` — puppeteer: страница, две темы, 390px, формы без отправки.
