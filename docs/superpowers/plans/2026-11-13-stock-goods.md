# Склад, товары и операции («Управление → Товары») — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Страница «Управление → Товары» с остатками, каталогом, журналом операций (приход/списание/перемещение/продажа/инвентаризация), поставщиками, техкартами и обороткой; остаток считает LoyalPro из единого леджера; в карточке записи журнала видны и корректируются списания расходников и продажи клиенту визита; в карточке пациента — покупки. **В YClients модуль ничего не пишет** (решения владельца 13.11.2026: склад не отправлять; бонусы только на услуги, поэтому и карта лояльности не трогается); YClients — только источник (каталог, склады, техкарты, зеркало операций).

**Architecture:** Леджер `stock_documents`/`stock_movements` питается двумя входами — зеркалом YClients (хук в `economics/store.upsertGoodsTransaction`) и нашими документами; остаток = входящий остаток (снимок `actual_amounts` при включении) + движения по правилу §6.3 спеки. Деньги продажи (наличные/карта) — через `finance-ops`. Фронт — шесть файлов `frontend/js/pages/stock*.js` одной глобальной области с префиксом `stock`.

**Tech Stack:** Node.js/Express, pg без ORM, vanilla JS SPA, Jest (`TZ=Europe/Moscow`), `vm`-тесты фронта, puppeteer. Спека — `docs/superpowers/specs/2026-11-13-stock-goods-design.md` (вторая редакция; разделы — обязательства, ссылки §… — на неё).

---

## Продолжение 14.11.2026

Сессия `3febfa5f-785a-48ab-a311-188e59ad51bf` восстановлена в рабочей копии
`/root/loyalpro-stock`, ветка `feat/stock-goods`. Фактический последний коммит
предыдущей работы — `baaccca`: задача 7 уже реализована, несмотря на статус
`in_progress` в старом списке задач. Базовая проверка склада: 6 наборов / 120 тестов.

Задача 8: реализованы навигация в обоих меню, остатки, каталог с фильтром по
иерархическим путям категорий, карточка товара, локальные формы и история движений.
Панели следующих этапов смонтированы, их кнопки скрыты до реализации.
Проверки: 47 наборов / 1144 теста (склад и смежные модули); после уточнения
форматирования отрицательных остатков — повторный проход 6 UI-тестов.
`backend/scripts/stock-ui-e2e.js` проверяет настоящий браузер с синтетическим API:
две темы, 1280/390 px, отсутствие горизонтального переполнения, экранирование,
открытие/закрытие карточки и отправку формы локального товара.
Скриншоты: `/tmp/stock-{light,dark}-{1280,390}.png`.

Живая проверка на дев-сервере и финальный прогон задачи 15 пока не выполнены.
Сервисы не перезапускались, БД и YClients не изменялись. Следующий этап кода —
задача 9 (операции, документы и продажа), затем 10–15. Опus/Sonnet-ревью не
выполнялось: эти модели в текущем окружении недоступны; проверка проведена Codex.

## 0. Кто что делает (распределение по моделям — требование владельца)

| Роль | Модель | Что | Как вызывать |
|---|---|---|---|
| **Ревьюер и диспетчер** | **Opus** | Перед каждой задачей — бриф исполнителю (цель, файлы, код из задачи, готчи, критерии); после — ревью диффа по чек-листу задачи, запуск тестов самим, принять/вернуть; короткий отчёт в чат; коммит принятого. Итоговое ревью — задача 15 | `Agent` `model: opus`, `subagent_type: superpowers:code-reviewer` для ревью; `general-purpose` для брифов |
| **Исполнитель ядра** | **Codex GPT Astra** (`/usr/local/bin/codex`, модель `gpt-6-astra`) | Задачи **L2**: леджер и SQL с живым EXPLAIN, документы/инвентаризация, продажа с деньгами, интеграция в карточку записи | `codex exec --cd /root/loyalpro-stock -m gpt-6-astra "<бриф>"`; PATH с node v20 (`/root/.nvm/versions/node/v20.20.2/bin`) |
| **Исполнитель механики** | **Sonnet** | Задачи **L1**: пробы чтения, миграции, справочники, роуты по образцу, фронт, скрипты, доки | `Agent` `model: sonnet`, `subagent_type: general-purpose` |
| **Поиск** | **Haiku** | Только поиск по коду/докам на короткий вопрос исполнителя. ГОТЧА (память `feedback-haiku-context-too-small`): субагент Haiku ВНУТРИ репо падает «Prompt is too long» из-за автоподгрузки CLAUDE.md — запускать `claude -p --model claude-haiku-5-5` из каталога БЕЗ CLAUDE.md (например `/tmp/stock-search`) с явными `rg`-командами в промпте; при отказе — Sonnet `Explore` | `cd /tmp/stock-search && claude -p --model claude-haiku-5-5 "…"` |
| **Решения** | Fable (эта сессия) / владелец | Спорные решения §11 спеки, приёмка, выкат | — |

**Правила процесса** (память `feedback_sequential_execution_no_background_burn`, `feedback_check_peer_sessions_before_plan`):
1. По очереди: один исполнитель за раз, без фоновых параллельных агентов; результат каждой задачи — отчёт в чат СРАЗУ.
2. Один ревьюер на задачу (Opus), без второго «quality»-ревьюера. При 429 у субагента незакоммиченные правки остаются в worktree — Opus дочищает и коммитит сам.
3. Перед стартом — `ListAgents`.
4. Исполнитель получает бриф, а не весь план: цель, файлы, код из задачи, чек-лист, команды тестов, 3–5 готчей из раздела ниже.
5. Коммит после каждой принятой задачи в `feat/stock-goods` (worktree `/root/loyalpro-stock`). Прод не трогаем.
6. TDD: сначала красный тест, потом код; исполнитель приводит вывод красного прогона в отчёте.

---

## Как запускать

```bash
export PATH=/root/.nvm/versions/node/v20.20.2/bin:$PATH
git -C /root/loyalpro worktree add /root/loyalpro-stock -b feat/stock-goods main
cd /root/loyalpro-stock/backend && npm install
# один набор (префикс backend/ ОБЯЗАТЕЛЕН — голый шаблон «stock» в рабочей копии с «stock» в имени гонит весь репозиторий):
npx jest backend/stock-model --silent
# все наборы склада:
npx jest backend/stock --silent
# смежные, обязаны остаться зелёными:
npx jest economics backend/journal finance yclients-goods-catalog --silent
# фронт склада (vm-харнесс):
npx jest backend/stock-ui --silent
```

- БД дева — `loyalpro_test` (`DATABASE_URL` в `backend/.env`, PG15 локально `:5432`; MCP postgres смотрит на мёртвый `:5433` — ручные запросы `psql "$DATABASE_URL"`).
- Дев-сервер: `cd /root/loyalpro/backend && PORT=3001 pm2 restart loyalpro` (НЕ `--update-env`).
- В YClients живьём НИЧЕГО не пишется; все прогоны — на нашей БД (`loyalpro_test`).
- Миграции — только в `backend/migrations.js`, блок `// ── STOCK` после блока журнала, `IF NOT EXISTS`/`DO NOTHING`; единственное изменение существующей колонки — `ALTER TABLE yclients_goods_catalog ALTER COLUMN yclients_good_id DROP NOT NULL` (ослабление).
- Правка JS/CSS фронта — с бампом `?v=` в `frontend/index.html`.

## Готчи проекта (в бриф каждой задачи — относящиеся)

1. **`db.one` ≡ `db.oneOrNone`**: оба возвращают `null`. Проверять результат явно.
2. **Общая глобальная область фронта**: `stock*.js` — классические `<script>`; дубль `const`/`let` между файлами = `SyntaxError`, гасящий ВЕСЬ файл. Префикс `stock`/`STOCK_`; тест «нет дублей верхнеуровневых имён» как в `journal-ui.test.js`.
3. **vm-харнесс — не DOM**: `document.getElementById` отдаёт заглушку; логику писать чистыми функциями, обработчики проверять прямым вызовом.
4. **`yclients_goods_catalog.is_archived` занят «Уходами»** — активность для склада по `stock_active`. **Step C синка «Уходов»** (`yclients-goods-catalog.js:~262`) архивирует по `last_seen_at` внутри перечисленных категорий — локальный товар (`yclients_good_id IS NULL`) туда попасть не должен: добавить `AND yclients_good_id IS NOT NULL` (задача 2).
5. **`yclients_good_id` теперь NULLABLE**: код, джойнящий каталог по `yclients_good_id`, обязан переживать `NULL` (экономика джойнит `goods_transactions.good_id = yclients_good_id` — NULL не совпадает, это ок). В леджере товар адресуется только `good_row_id` (= `yclients_goods_catalog.id`).
6. **`changed_after` YClients только с временем**; числа строками; `/goods` — `count=100` до пустой страницы.
7. **Количества**: `operation_unit_type` 1 — ед. продажи, 2 — ед. списания; у части списаний `amount` в ед. продажи при типе 2 — пересчёт ТОЛЬКО через `economics/price.writeoffQty`. `actual_amounts` — в ед. продажи, бывают отрицательные.
8. **Ничего не пишем в YClients** — ни одного `POST/PUT/DELETE` ни к складу, ни к карте лояльности (бонусы на товары не тратятся — решение владельца).
9. **Тексты YClients наружу не отдавать**; **PII** в леджер не писать.
10. **Москва**: `TZ=Europe/Moscow` у jest и pm2; дни отчётов — `AT TIME ZONE 'Europe/Moscow'`.
11. **Экономика не ломается**: хук леджера через `safely()`, `goods_transactions` и `npx jest economics` зелёные; `recorded_at` при апсерте не трогать.
12. **Живой EXPLAIN** с реальными bound-параметрами для SQL остатков/оборотки/журнала (`scripts/stock-explain.js`).
13. **Деньги**: `finance-ops` — единственный писатель `finance_operations`; суммы — в копейках; способы продажи — только `cash|card`.

## Карта файлов

### Создаются
| Файл | Ответственность |
|---|---|
| `backend/services/stock/model.js` | чистая модель: виды, знаки, пересчёт единиц, валидация документа и оплат, дельта расходников, разница инвентаризации, правило счёта (§8 спеки) |
| `backend/services/stock/store.js` | весь SQL склада: справочники, документы, движения, остатки (CTE экспортируется), инвентаризация, покупки клиента, оборотка |
| `backend/services/stock/ledger.js` | `ingestMirrored`, `postDocument` (документ → движения), `openingFromCatalog`, `drainIngestPending` |
| `backend/services/stock/documents.js` | create/cancel для receipt/writeoff/move; инвентаризация; `openingReset` |
| `backend/services/stock/sales.js` | продажа: документ + оплаты (`cash|card`) в `finance-ops` |
| `backend/services/stock/consumables.js` | расходники записи: норма/факт/расхождение, корректировка дельтой |
| `backend/services/stock/catalog-sync.js` | склады, единицы, дерево категорий, расширенные поля товара, вебхук `good`, локальные товары |
| `backend/services/stock/index.js` | фасад для `routes/webhook.js`, `economics/sync.runNightly` |
| `backend/routes/stock.js` | `/api/stock` (§7 спеки) |
| `backend/utils/safely.js` | вынос `safely` из `finance-ops.js` |
| `backend/scripts/stock-api-probe.js`, `stock-opening.js`, `stock-backfill-mirror.js`, `stock-explain.js`, `stock-e2e.js`, `stock-ui-e2e.js` | пробы чтения; входящий остаток; переливка зеркала; EXPLAIN; живой прогон; браузер |
| `backend/stock-model.test.js`, `stock-ledger.test.js`, `stock-documents.test.js`, `stock-sales.test.js`, `stock-consumables.test.js`, `stock-catalog-sync.test.js`, `stock-routes.test.js`, `stock-ui.test.js` | тесты |
| `frontend/js/pages/stock.js`, `stock-balances.js`, `stock-docs.js`, `stock-sale.js`, `stock-inventory.js`, `stock-refs.js`; `frontend/css/stock.css` | страница (§9.1 спеки) |

### Изменяются
| Файл | Что |
|---|---|
| `backend/migrations.js` | блок STOCK (задача 2) |
| `backend/services/yclients-goods-catalog.js` | Step C: `AND yclients_good_id IS NOT NULL` |
| `backend/services/economics/store.js` | хук `ingestMirrored` после апсерта (через `safely`) |
| `backend/services/economics/sync.js` | `parseCatalogGood` → расширенные поля; `runNightly` → `stock.nightly` |
| `backend/services/finance-ops.js` | импорт `safely`; `recordStockSalePayment`, `cancelByStockDocument`; колонка `stock_document_id` |
| `backend/routes/index.js` | `app.use('/api/stock', require('./stock'))` |
| `backend/routes/webhook.js` | вебхук `good` → `stock.handleGoodEvent` |
| `backend/config.js` | `STOCK_LEDGER` |
| `frontend/index.html` | пункт меню «Товары» (оба меню), `#page-stock`, `<script>`/`<link>` с `?v=` |
| `frontend/js/core/nav.js` | заголовок, `loadStock()`, deep-links |
| `frontend/js/pages/journal-card.js` | вкладки «Товары» и «Расходники» |
| `frontend/js/pages/clients.js` | блок «Покупки» в `openCD` |
| `frontend/js/pages/economics.js` | `ecoLoadTechCards(containerId = 'ecoTechCards')` |
| `backend/services/journal/visit-history.js` | покупки и расходники — из леджера |
| `CLAUDE.md` | раздел «Склад и товары» (задача 15) |

---

### Task 0: Карта точек интеграции (поиск)

**Модель:** Haiku (из `/tmp/stock-search`, §0) → при отказе Sonnet `Explore`.

**Files:** Create `docs/2026-11-13-stock-integration-points.md`

- [ ] **Step 1:** собрать все места чтения/записи:
```bash
rg -n "goods_transactions" backend --glob '!*.test.js' -l
rg -n "yclients_goods_catalog" backend frontend --glob '!*.test.js'
rg -n "tech_cards|service_tech_cards" backend --glob '!*.test.js' -l
rg -n "sold_item_id|goods_sale" backend --glob '!*.test.js' -l
rg -n "jrStub\('Товары'|Списание расходников" frontend/js/pages
rg -n "is_archived|last_seen_at" backend --glob '!*.test.js'
rg -l "goods_transactions|yclients_goods_catalog" backend/*.test.js
```
- [ ] **Step 2:** таблица «файл → строка → что делает → трогаем ли» (≤ 80 строк) + список тестов-стражей. Отдельно каждое место, где `yclients_good_id` считается NOT NULL (готча 5).
- [ ] **Step 3:** коммит `docs(stock): карта точек интеграции склада`.

**Чек-лист Opus:** только реальные `file:line`; список тестов-стражей; найдены все JOIN по `yclients_good_id`.

---

### Task 1: Пробы чтения API YClients (read-only)

**Модель:** Sonnet.

**Files:** Create `backend/scripts/stock-api-probe.js`, `docs/2026-11-13-stock-api-live-probe.md`

- [ ] **Step 1:** скрипт `node scripts/stock-api-probe.js` (только `ycGet`): `GET /storages/{cid}`; `GET /goods/{cid}/{good}` для трёх товаров — с `unit_equals>1` и приходом за последний месяц (из `goods_transactions` type 3), с `unit_equals=1`, и «LIP мыло» 20927975 — сравнить `actual_amounts` с суммой `goods_transactions` по складу (оба в ед. продажи? — вывод в отчёт); `GET /goods/{cid}?count=100&page=1` — перечислить ВСЕ ключи первого товара (поля §5.2 присутствуют?); `GET /goods_categories/{cid}/0` и рекурсивно детей (глубина ≤ 4, пауза 400 мс) — число узлов; `GET /technological_cards/record_consumables/{cid}/{record}/` для последней состоявшейся записи 79200255591 — форма ответа; `GET /storages/transactions/{cid}?changed_after=<вчераT00:00:00>&count=100` — есть ли `comment`, `client`, `supplier`. Тела — в `/tmp/stock-api-probe/*.json`.
- [ ] **Step 2:** отчёт: таблица шаг → код → вывод; ответы: (а) единицы `actual_amounts`; (б) полный список полей `/goods`; (в) дерево категорий; (г) форма `record_consumables`.
- [ ] **Step 3:** коммит.

**Чек-лист Opus:** ни одного запроса, кроме GET; отчёт отвечает на (а)–(г).

---

### Task 2: Миграции и чистая модель

**Модель:** Sonnet.

**Files:** Modify `backend/migrations.js`, `backend/services/yclients-goods-catalog.js`, `backend/services/finance-ops.js`; Create `backend/services/stock/model.js`, `backend/stock-model.test.js`, `backend/utils/safely.js`

- [ ] **Step 1: Тесты модели (красные)** — `backend/stock-model.test.js`:

```js
'use strict';
const m = require('./services/stock/model');

describe('единицы', () => {
  test('toBase: ед. продажи × unit_equals, знак по виду', () => {
    expect(m.toBase({ kind: 'receipt', qty: 2, unitType: 1, unitEquals: 500 })).toBe(1000);
    expect(m.toBase({ kind: 'writeoff', qty: 2, unitType: 1, unitEquals: 500 })).toBe(-1000);
    expect(m.toBase({ kind: 'sale', qty: 1, unitType: 1, unitEquals: 1 })).toBe(-1);
  });
  test('toBase: ед. списания — через writeoffQty (готча ед. продажи при типе 2)', () => {
    expect(m.toBase({ kind: 'consumable', qty: 0.1667, unitType: 2, unitEquals: 120, costPerUnit: 16.35, cost: 327 })).toBeCloseTo(-20, 1);
    expect(m.toBase({ kind: 'consumable', qty: 5, unitType: 2, unitEquals: 500, costPerUnit: 8.5, cost: 42.5 })).toBe(-5);
  });
  test('toBaseInfo без unit_equals при типе 1 — qty как есть и флаг', () => {
    expect(m.toBaseInfo({ kind: 'receipt', qty: 3, unitType: 1, unitEquals: null })).toEqual({ qtyBase: 3, unitUnknown: true });
  });
  test('fromBase раскладывает на ед. продажи и остаток', () => {
    expect(m.fromBase(1150, 500)).toEqual({ saleUnits: 2, remainderBase: 150 });
    expect(m.fromBase(-4059, 500)).toEqual({ saleUnits: -9, remainderBase: 441 });
    expect(m.fromBase(7, null)).toEqual({ saleUnits: 7, remainderBase: 0 });
  });
});

describe('validateDocument', () => {
  const ctx = { storages: [{ id: 1, forService: true, forSale: false }, { id: 2, forService: false, forSale: true }], goods: new Map([[10, { stockActive: true, unitEquals: 1 }]]) };
  test('приход: ок, cost со скидкой', () => {
    const r = m.validateDocument({ kind: 'receipt', storageId: 1, docDate: '2026-11-13T10:00:00+03:00', lines: [{ goodRowId: 10, qty: 2, unitType: 1, costPerUnit: 100, discount: 10 }] }, ctx);
    expect(r.ok).toBe(true); expect(r.normalized.lines[0].cost).toBe(180); expect(r.normalized.totalCost).toBe(180);
  });
  test('перемещение на тот же склад — ошибка', () => {
    const r = m.validateDocument({ kind: 'move', storageId: 1, toStorageId: 1, docDate: '2026-11-13', lines: [{ goodRowId: 10, qty: 1, unitType: 1 }] }, ctx);
    expect(r.ok).toBe(false); expect(r.errors[0]).toMatch(/разные склады/);
  });
  test('пустые строки, qty ≤ 0, неизвестный товар, скидка вне 0–100', () => {
    expect(m.validateDocument({ kind: 'writeoff', storageId: 1, docDate: '2026-11-13', lines: [] }, ctx).ok).toBe(false);
    expect(m.validateDocument({ kind: 'writeoff', storageId: 1, docDate: '2026-11-13', lines: [{ goodRowId: 10, qty: 0, unitType: 1 }] }, ctx).ok).toBe(false);
    expect(m.validateDocument({ kind: 'writeoff', storageId: 1, docDate: '2026-11-13', lines: [{ goodRowId: 99, qty: 1, unitType: 1 }] }, ctx).ok).toBe(false);
    expect(m.validateDocument({ kind: 'sale', storageId: 2, docDate: '2026-11-13', clientId: 5, lines: [{ goodRowId: 10, qty: 1, unitType: 1, costPerUnit: 100, discount: 120 }] }, ctx).ok).toBe(false);
  });
  test('склад не того назначения — предупреждение, не ошибка', () => {
    const r = m.validateDocument({ kind: 'sale', storageId: 1, docDate: '2026-11-13', clientId: 5, lines: [{ goodRowId: 10, qty: 1, unitType: 1, costPerUnit: 100, discount: 0 }] }, ctx);
    expect(r.ok).toBe(true); expect(r.warnings[0]).toMatch(/не для продаж/);
  });
  test('продажа с нулевым итогом без gift — ошибка', () => {
    expect(m.validateDocument({ kind: 'sale', storageId: 2, docDate: '2026-11-13', clientId: 5, lines: [{ goodRowId: 10, qty: 1, unitType: 1, costPerUnit: 0, discount: 0 }] }, ctx).ok).toBe(false);
    expect(m.validateDocument({ kind: 'sale', storageId: 2, docDate: '2026-11-13', clientId: 5, gift: true, lines: [{ goodRowId: 10, qty: 1, unitType: 1, costPerUnit: 0, discount: 0 }] }, ctx).ok).toBe(true);
  });
});

describe('validateSalePayments', () => {
  test('сумма оплат = итогу, только cash|card', () => {
    expect(m.validateSalePayments([{ method: 'card', amount: 700 }, { method: 'cash', amount: 300 }], 1000)).toEqual({ ok: true, errors: [] });
    expect(m.validateSalePayments([{ method: 'card', amount: 700 }], 1000).errors[0]).toMatch(/не совпадает/);
    expect(m.validateSalePayments([{ method: 'bonus', amount: 600 }], 600).ok).toBe(false); // бонусы только на услуги (решение владельца 13.11)
    expect(m.validateSalePayments([{ method: 'crypto', amount: 10 }], 10).ok).toBe(false);
  });
  test('подарок — оплат нет', () => expect(m.validateSalePayments([], 0, { gift: true }).ok).toBe(true));
});

describe('дельта расходников и инвентаризация', () => {
  test('consumableDelta — только ненулевые строки, в знаке движения', () => {
    expect(m.consumableDelta([{ goodRowId: 1, qtyBase: 3 }, { goodRowId: 2, qtyBase: 1 }], [{ goodRowId: 1, qtyBase: -2 }, { goodRowId: 3, qtyBase: -1 }]))
      .toEqual([{ goodRowId: 1, qtyBase: -1 }, { goodRowId: 2, qtyBase: -1 }, { goodRowId: 3, qtyBase: 1 }]);
  });
  test('inventoryDiff: подсчёт в ед. продажи → базовые', () => {
    expect(m.inventoryDiff({ expectedBase: 1000, counted: 3, countedUnitType: 1, unitEquals: 500 })).toEqual({ countedBase: 1500, diffBase: 500 });
    expect(m.inventoryDiff({ expectedBase: 1000, counted: 900, countedUnitType: 2, unitEquals: 500 })).toEqual({ countedBase: 900, diffBase: -100 });
  });
});

describe('правило счёта остатка (§6.3)', () => {
  const opening = { takenAt: new Date('2026-11-14T00:00:00Z') };
  test('после снимка по дате операции — считается', () => expect(m.balanceCountsRow({ occurredAt: '2026-11-15T00:00:00Z', recordedAt: '2026-11-15T00:00:00Z', source: 'reconcile' }, opening)).toBe(true));
  test('задним числом через вебхук/наш документ — считается', () => expect(m.balanceCountsRow({ occurredAt: '2026-11-01T00:00:00Z', recordedAt: '2026-11-15T00:00:00Z', source: 'webhook' }, opening)).toBe(true));
  test('старая строка сверкой/догоном — нет', () => expect(m.balanceCountsRow({ occurredAt: '2026-11-01T00:00:00Z', recordedAt: '2026-11-15T00:00:00Z', source: 'backfill' }, opening)).toBe(false));
  test('без входящего остатка — всё считается', () => expect(m.balanceCountsRow({ occurredAt: '2026-11-01T00:00:00Z', recordedAt: '2026-11-01T00:00:00Z', source: 'backfill' }, null)).toBe(true));
});
```

- [ ] **Step 2:** `npx jest backend/stock-model --silent` → FAIL «Cannot find module».

- [ ] **Step 3: Модель** `backend/services/stock/model.js`:

```js
'use strict';
// Чистая модель склада (§8 спеки): без БД и сети. Количество — в базовой единице списания.
const { writeoffQty } = require('../economics/price');

const KINDS = ['receipt', 'writeoff', 'sale', 'move', 'inventory', 'consumable', 'opening'];
const ORIGINS = ['loyalpro', 'yclients'];
const YC_TYPE_BY_KIND = { sale: 1, consumable: 2, receipt: 3, writeoff: 4, move: 5 };
const KIND_BY_YC_TYPE = Object.fromEntries(Object.entries(YC_TYPE_BY_KIND).map(([k, v]) => [v, k]));
const INFLOW_KINDS = new Set(['receipt', 'opening']);
const PAY_METHODS = ['cash', 'card']; // бонусы — только на услуги (решение владельца 13.11.2026)

class StockError extends Error { constructor(message, status = 400, code = 'bad_request', extra = {}) { super(message); this.status = status; this.code = code; Object.assign(this, extra); } }
const fail = (message, status, code, extra) => { throw new StockError(message, status, code, extra); };

const num = v => { if (v === null || v === undefined || v === '') return null; const n = Number(v); return Number.isFinite(n) ? n : null; };
const round4 = x => Math.round(x * 10000) / 10000;
const kop = x => Math.round(Number(x) * 100);

function signFor(kind) { return INFLOW_KINDS.has(kind) ? 1 : -1; }
function kindByYcType(typeId) { return KIND_BY_YC_TYPE[Number(typeId)] || null; }

/** Количество в базовой единице со знаком вида. Тип 2 — через общий writeoffQty (готча ед. продажи при типе 2). */
function toBaseInfo({ kind, qty, unitType, unitEquals, costPerUnit, cost }) {
  const q = Math.abs(Number(qty) || 0); const eq = num(unitEquals); const sign = signFor(kind);
  if (Number(unitType) === 2) return { qtyBase: round4(sign * writeoffQty({ amount: q, cost_per_unit: costPerUnit, cost }, eq)), unitUnknown: false };
  if (!(eq > 0)) return { qtyBase: round4(sign * q), unitUnknown: true };
  return { qtyBase: round4(sign * q * eq), unitUnknown: false };
}
const toBase = args => toBaseInfo(args).qtyBase;

/** Обратно: ед. продажи (floor) и остаток в базовых — для «2 шт + 150 мл». */
function fromBase(qtyBase, unitEquals) {
  const b = Number(qtyBase) || 0; const eq = num(unitEquals);
  if (!(eq > 0) || eq === 1) return { saleUnits: round4(b), remainderBase: 0 };
  const saleUnits = Math.floor(b / eq);
  return { saleUnits, remainderBase: round4(b - saleUnits * eq) };
}

/** Валидация документа формы. ctx: {storages:[{id,forService,forSale}], goods: Map<rowId,{stockActive,unitEquals}>} */
function validateDocument(body, ctx) {
  const errors = [], warnings = []; const b = body || {};
  if (!['receipt', 'writeoff', 'move', 'sale'].includes(b.kind)) errors.push('Неизвестный вид документа.');
  const storage = (ctx.storages || []).find(s => Number(s.id) === Number(b.storageId));
  if (!storage) errors.push('Склад не найден.');
  const docDate = b.docDate ? new Date(b.docDate) : null;
  if (!docDate || Number.isNaN(docDate.getTime())) errors.push('Дата документа некорректна.');
  if (b.kind === 'move') {
    const to = (ctx.storages || []).find(s => Number(s.id) === Number(b.toStorageId));
    if (!to) errors.push('Склад-получатель не найден.');
    else if (storage && Number(to.id) === Number(storage.id)) errors.push('Перемещение требует разные склады.');
  }
  if (b.kind === 'sale' && !(Number(b.clientId) > 0) && !b.phone) errors.push('Укажите клиента.');
  if (storage && b.kind === 'sale' && storage.forSale === false && storage.forService) warnings.push('Склад «не для продаж» — проверьте выбор.');
  const lines = Array.isArray(b.lines) ? b.lines : [];
  if (!lines.length) errors.push('Добавьте хотя бы одну строку.');
  const normLines = [];
  lines.forEach((l, i) => {
    const n = i + 1; const good = ctx.goods && ctx.goods.get(Number(l.goodRowId));
    if (!good) { errors.push(`Строка ${n}: товар не найден.`); return; }
    if (good.stockActive === false) errors.push(`Строка ${n}: товар неактивен.`);
    const qty = num(l.qty); if (!(qty > 0)) errors.push(`Строка ${n}: количество должно быть больше нуля.`);
    const unitType = Number(l.unitType); if (![1, 2].includes(unitType)) errors.push(`Строка ${n}: единица — продажи (1) или списания (2).`);
    const cpu = l.costPerUnit === undefined || l.costPerUnit === null || l.costPerUnit === '' ? 0 : num(l.costPerUnit);
    if (!(cpu >= 0)) errors.push(`Строка ${n}: цена не может быть отрицательной.`);
    const disc = l.discount === undefined || l.discount === null || l.discount === '' ? 0 : num(l.discount);
    if (!(disc >= 0 && disc <= 100)) errors.push(`Строка ${n}: скидка от 0 до 100 %.`);
    const cost = kop((qty || 0) * (cpu || 0) * (1 - (disc || 0) / 100)) / 100;
    const { qtyBase, unitUnknown } = toBaseInfo({ kind: b.kind, qty: qty || 0, unitType, unitEquals: good.unitEquals, costPerUnit: cpu, cost });
    normLines.push({ goodRowId: Number(l.goodRowId), qty, unitType, costPerUnit: cpu, discount: disc, cost, qtyBase, unitUnknown, comment: typeof l.comment === 'string' ? l.comment.slice(0, 500) : null });
  });
  const totalCost = normLines.reduce((s, l) => s + kop(l.cost), 0) / 100;
  if (b.kind === 'sale' && !errors.length && totalCost <= 0 && b.gift !== true) errors.push('Итог продажи равен нулю — отметьте «подарок» или укажите цену.');
  return { ok: !errors.length, errors, warnings, normalized: { kind: b.kind, storageId: storage ? Number(storage.id) : null, toStorageId: b.kind === 'move' ? Number(b.toStorageId) : null, docDate, comment: typeof b.comment === 'string' ? b.comment.slice(0, 1000) : '', lines: normLines, totalCost } };
}

/** Оплаты продажи: методы cash|card, сумма = итогу (в копейках). */
function validateSalePayments(payments, total, opts = {}) {
  const errors = []; const list = Array.isArray(payments) ? payments : [];
  if (opts.gift === true) { if (list.length) errors.push('У подарка не бывает оплат.'); return { ok: !errors.length, errors }; }
  let sum = 0;
  for (const p of list) {
    if (!PAY_METHODS.includes(p && p.method)) { errors.push('Способ оплаты: наличные или карта (бонусы — только на услуги).'); continue; }
    const a = num(p.amount); if (!(a > 0)) { errors.push('Сумма оплаты должна быть больше нуля.'); continue; }
    sum += kop(a);
  }
  if (!errors.length && sum !== kop(total)) errors.push(`Сумма оплат не совпадает с итогом (${(sum / 100).toFixed(2)} ≠ ${Number(total).toFixed(2)}).`);
  return { ok: !errors.length, errors };
}

/** Целевой состав (положительные qtyBase) против факта (отрицательные) → движения-дельты в знаке движения. */
function consumableDelta(target, actual) {
  const want = new Map(); for (const t of target || []) want.set(Number(t.goodRowId), (want.get(Number(t.goodRowId)) || 0) + Math.abs(Number(t.qtyBase) || 0));
  const have = new Map(); for (const a of actual || []) have.set(Number(a.goodRowId), (have.get(Number(a.goodRowId)) || 0) + Math.abs(Number(a.qtyBase) || 0));
  const ids = [...new Set([...want.keys(), ...have.keys()])].sort((a, b) => a - b);
  return ids.map(id => ({ goodRowId: id, qtyBase: round4(-((want.get(id) || 0) - (have.get(id) || 0))) })).filter(d => d.qtyBase !== 0);
}

function inventoryDiff({ expectedBase, counted, countedUnitType, unitEquals }) {
  const c = Math.abs(Number(counted) || 0); const eq = num(unitEquals);
  const countedBase = Number(countedUnitType) === 1 && eq > 0 ? round4(c * eq) : round4(c);
  return { countedBase, diffBase: round4(countedBase - (Number(expectedBase) || 0)) };
}

/** §6.3: считается ли строка в остаток при данном входящем остатке. */
function balanceCountsRow(row, opening) {
  if (!opening || !opening.takenAt) return true;
  if (['loyalpro', 'inventory'].includes(row.source)) return true;            // локальное — YClients его не видел
  const t = new Date(opening.takenAt).getTime();
  return new Date(row.recordedAt).getTime() > t && ['webhook', 'reconcile'].includes(row.source);
}

module.exports = { KINDS, ORIGINS, YC_TYPE_BY_KIND, PAY_METHODS, StockError, fail, signFor, kindByYcType, toBase, toBaseInfo, fromBase, validateDocument, validateSalePayments, consumableDelta, inventoryDiff, balanceCountsRow, kop };
```

- [ ] **Step 4:** `npx jest backend/stock-model --silent` → PASS.

- [ ] **Step 5: Миграции** — блок `// ── STOCK (склад, 2026-11-13) ──` после `journal_record_prefs`: DDL §5.1 спеки (`stock_storages, stock_units, stock_suppliers, stock_documents, stock_movements, stock_openings, stock_inventory_lines, stock_ingest_pending, stock_settings`), каждый `CREATE TABLE IF NOT EXISTS … .catch(() => {})`, индексы и частичные UNIQUE — `CREATE [UNIQUE] INDEX IF NOT EXISTS`; колонки каталога §5.2 — циклом `ALTER TABLE yclients_goods_catalog ADD COLUMN IF NOT EXISTS …`; `ALTER TABLE yclients_goods_catalog ALTER COLUMN yclients_good_id DROP NOT NULL`; `ALTER TABLE finance_operations ADD COLUMN IF NOT EXISTS stock_document_id BIGINT`.

- [ ] **Step 6: Страж «Уходов»** — `services/yclients-goods-catalog.js` Step C: в `UPDATE … SET is_archived = TRUE` добавить `AND yclients_good_id IS NOT NULL`; экспортировать текст запроса константой `ARCHIVE_SQL` и добавить тест в `backend/yclients-goods-catalog-archive.test.js`: `expect(ARCHIVE_SQL).toMatch(/yclients_good_id IS NOT NULL/)`.

- [ ] **Step 7: `utils/safely.js`** — перенести `safely(label, fn)` из `finance-ops.js` (вместе с троттлингом `_warned`) и импортировать обратно; `npx jest finance --silent` зелёный.

- [ ] **Step 8: Применить на деве**: `node -e "require('dotenv').config(); require('./migrations').runMigrations().then(()=>process.exit(0))"`, затем `psql "$DATABASE_URL" -c "\d stock_movements" -c "\d yclients_goods_catalog" | grep -n "yclients_good_id\|stock_active"` — `yclients_good_id` без `not null`. Вывод — в отчёт.

- [ ] **Step 9:** `npx jest backend/stock-model finance yclients-goods-catalog --silent` → PASS; коммит `feat(stock): миграции склада, чистая модель, страж локальных товаров в «Уходах»`.

**Чек-лист Opus:** красный прогон приведён; `toBaseInfo` зовёт `writeoffQty`; DDL аддитивен, единственный `ALTER COLUMN` — `DROP NOT NULL`; Step C защищён и покрыт тестом; имена колонок = спека §5.1.

---

### Task 3: Справочники и каталог — склады, единицы, поставщики, категории, расширенные поля, локальные товары

**Модель:** Sonnet.

**Files:** Create `backend/services/stock/catalog-sync.js`, `backend/stock-catalog-sync.test.js`, `backend/services/stock/store.js` (справочники, товары), `backend/routes/stock.js` (`/settings`, `/dictionaries`, `/storages*`, `/units*`, `/suppliers*`, `/categories/sync`, `POST /goods`, `PUT /goods/:id`), `backend/services/stock/index.js`; Modify `backend/services/economics/sync.js` (`parseCatalogGood`), `backend/routes/index.js`, `backend/routes/webhook.js`

- [ ] **Step 1: Тесты (красные)** `stock-catalog-sync.test.js`: `parseStorage({id:1334902,title:'Расходники',for_service:1,for_sale:0,comment:'…',weight:2})` → `{ycStorageId:1334902, title, forService:true, forSale:false, comment, weight:2}`; `flattenCategoryTree(roots, childrenById)` → `[{id, title, parentId, path:[{id,title}…]}]`, глубина ≤ 4, цикл обрывается; `parseCatalogGood` отдаёт новые поля (`sale_price` из `cost`, `barcode`, `unit_id`, `service_unit_id`, `critical_amount`, `desired_amount`, `comment`, `loyalty_*_type_id`, `yc_last_change_date`), строки → числа, пустые → null; `unitsFromRows` собирает уникальные `{ycUnitId, title, shortTitle}` из `raw.unit` транзакций и `unit_id/unit_short_title` товаров; `parseLocalGoodBody(b, units)`: title 1–500, `localCategory ≤ 200`, `unitId`/`serviceUnitId` ∈ units, `unitEquals ≥ 1`, `salePrice ≥ 0|null`, `actualCost ≥ 0|null`, `criticalAmount ≥ 0|null`, `barcode ≤ 64`, `note ≤ 1000`; `handleGoodEvent` `status:'delete'` → `stock_active=false`, не удаление; `similarTitles(title, existing)` — нормализация как `tech-cards.normTitle`, совпадение → предупреждение.

- [ ] **Step 2: Реализация.** `catalog-sync.js`: `syncStorages(salon)`, `syncCategories(salon)` (BFS от 0 по `/goods_categories/{cid}/{parent}`, пауза 400 мс, кап 200 запросов, апдейт `category_path`/`parent_category_id` по `category_id`, `stock_settings.categories_synced_at`; повтор раньше 30 мин → `{skipped:'throttled'}`), `collectUnits(salonId)`, `handleGoodEvent`, `createLocalGood(salonId, userId, body)` (`INSERT yclients_goods_catalog (salon_id, yclients_good_id NULL, source 'loyalpro', title, local_category, unit, service_unit, unit_id, service_unit_id, unit_equals, local_sale_price, critical_amount, barcode, local_note, stock_active TRUE, is_archived TRUE)` — `is_archived TRUE`, чтобы не попасть в «Уходы», как делает экономика для расходников; себестоимость → `economics/store.setPriceOverride`), `updateGood(salonId, id, body)` (у `source='yclients'` — только локальные поля). `store.js`: справочники, `getSettings/saveSettings`, `listGoods` (для форм: `id, title, unit, service_unit, unit_equals, stock_active, source, local_sale_price, sale_price, category_path, local_category`). Роуты по §7 с ручной валидацией и 400 с текстом; `/dictionaries` — склады, единицы, поставщики, мастера (`journal/reference-cache` staff), категории.

- [ ] **Step 3: Подключить** `app.use('/api/stock', require('./stock'))` после `/api/finance`; в `routes/webhook.js` рядом с `goods_operations_*`: `if (resourceType === 'good') await require('../services/stock').handleGoodEvent(salon, payload).catch(e => logger.error(…))`.

- [ ] **Step 4: Живо на деве**: `node -e` → `syncStorages`, `syncCategories` для salon 1 → 2 склада; у «Препараты» путь `Расходники > Препараты`; создать локальный товар «ТЕСТ локальный (удалить)» → строка с `yclients_good_id NULL`; прогнать `syncGoodsCatalog` экономики и `syncGoodsCatalog` из `yclients-goods-catalog.js` — локальный товар не тронут; удалить тестовую строку.

- [ ] **Step 5:** `npx jest backend/stock-catalog-sync economics yclients-goods-catalog --silent` → PASS; коммит `feat(stock): склады, единицы, поставщики, дерево категорий, локальные товары`.

**Чек-лист Opus:** `parseCatalogGood` расширен, а не скопирован; локальный товар не ломает оба синка; троттлинг категорий; `/dictionaries` не ходит в YClients.

---

### Task 4: Леджер — зеркало → движения, входящий остаток, остатки

**Модель:** Codex GPT Astra.

**Files:** Create `backend/services/stock/ledger.js`, `backend/stock-ledger.test.js`, `backend/scripts/stock-opening.js`, `backend/scripts/stock-backfill-mirror.js`, `backend/scripts/stock-explain.js`; Modify `backend/services/stock/store.js` (движения, остатки), `backend/services/economics/store.js` (хук), `backend/config.js`

- [ ] **Step 1: Тесты (красные)** `stock-ledger.test.js` (моки `store`):
  - `ingestMirrored`: type 2 с `record_id`, `service`, `unit_type 2`, товар известен → `upsertMirrorDocument({kind:'consumable', origin:'yclients', ycDocumentId, storageId, docDate, recordId, masterStaffYcId, clientId, ycClientId})`, затем `upsertMovement` с `qtyBase` из `toBaseInfo`, `source` из opts, `ycTxnId`; товар неизвестен → `addIngestPending`, движения нет; `status:'delete'` → `markMovementDeleted`; `raw.client.id` → `store.clientIdByYc`, имя/телефон никуда не передаются (проверка аргументов мока).
  - `postDocument(q, salonId, doc, lines)`: `receipt` → +`qtyBase`; `writeoff`/`sale` → −; `move` → две строки на позицию (− `storageId`, + `toStorageId`), `source 'loyalpro'`, `occurredAt = docDate`.
  - `BALANCES_SQL` экспортируется и содержит `stock_openings`, `recorded_at`, `occurred_at`, `('webhook','loyalpro','inventory')`, `d.status = 'posted'`.
  - `openingFromCatalog(goodRow)` → по каждому `stock[]`: `{storageYcId, qtyBase = amount × unit_equals, ycQtyBase}`; `unit_equals` null → `qtyBase = amount`, флаг.

- [ ] **Step 2: Реализация `ledger.js`**:

```js
'use strict';
const m = require('./model');
const store = require('./store');
const logger = require('../../logger').createLogger('StockLedger');

/** Зеркало YClients → леджер. row — economics/goods-events.parseTransaction; opts {status, source, deletedAt}. */
async function ingestMirrored(salonId, row, opts) {
  const kind = m.kindByYcType(row.type_id);
  if (!kind) return { skipped: 'type' };
  if (opts.status === 'delete') { await store.markMovementDeleted(salonId, row.yclients_txn_id, opts.deletedAt || new Date()); return { deleted: true }; }
  const good = await store.goodByYcId(salonId, row.good_id);
  if (!good) { await store.addIngestPending(salonId, row); logger.warn(`salon=${salonId}: товар ${row.good_id} неизвестен каталогу — строка ${row.yclients_txn_id} отложена`); return { pending: true }; }
  const storage = await store.ensureStorage(salonId, row.storage_id, row.raw && row.raw.storage && row.raw.storage.title);
  const ycClientId = row.raw && row.raw.client && Number(row.raw.client.id) > 0 ? Number(row.raw.client.id) : null;
  const clientId = ycClientId ? await store.clientIdByYc(salonId, ycClientId) : null;
  const { qtyBase, unitUnknown } = m.toBaseInfo({ kind, qty: row.amount, unitType: row.operation_unit_type, unitEquals: good.unit_equals, costPerUnit: row.cost_per_unit, cost: row.cost });
  const doc = await store.upsertMirrorDocument(salonId, { kind, ycDocumentId: row.document_id, storageId: storage.id, docDate: row.create_date, recordId: row.record_id, masterStaffYcId: row.master_id, clientId, ycClientId, comment: row.raw && typeof row.raw.comment === 'string' ? row.raw.comment.slice(0, 1000) : null });
  await store.upsertMovement(salonId, { documentId: doc.id, goodRowId: good.id, storageId: storage.id, qty: row.amount, unitType: row.operation_unit_type, qtyBase, costPerUnit: row.cost_per_unit, discount: row.discount, cost: row.cost, recordId: row.record_id, serviceYcId: row.service_id, masterStaffYcId: row.master_id, ycTxnId: row.yclients_txn_id, source: opts.source, occurredAt: row.create_date, comment: unitUnknown ? 'unit_unknown' : null });
  return { ingested: true };
}

/** Наш документ → движения (внутри транзакции вызывающего: q — client.query). */
async function postDocument(q, salonId, doc, lines) {
  for (const l of lines) {
    const rows = doc.kind === 'move'
      ? [{ storageId: doc.storageId, qtyBase: -Math.abs(l.qtyBase) }, { storageId: doc.toStorageId, qtyBase: Math.abs(l.qtyBase) }]
      : [{ storageId: doc.storageId, qtyBase: l.qtyBase }];
    for (const r of rows) {
      await store.insertMovement(q, salonId, { documentId: doc.id, goodRowId: l.goodRowId, storageId: r.storageId, qty: l.qty, unitType: l.unitType, qtyBase: r.qtyBase, costPerUnit: l.costPerUnit, discount: l.discount, cost: l.cost, recordId: doc.recordId || null, serviceYcId: l.serviceYcId || null, masterStaffYcId: doc.masterStaffYcId || null, source: doc.source || 'loyalpro', occurredAt: doc.docDate, comment: l.comment || null });
    }
  }
}

function openingFromCatalog(goodRow) {
  const eq = Number(goodRow.unit_equals);
  return (Array.isArray(goodRow.stock) ? goodRow.stock : []).filter(s => s && s.storage_id).map(s => {
    const amount = Number(s.amount) || 0; const known = eq > 0;
    return { storageYcId: Number(s.storage_id), qtyBase: known ? amount * eq : amount, ycQtyBase: known ? amount * eq : amount, unitUnknown: !known };
  });
}
module.exports = { ingestMirrored, postDocument, openingFromCatalog };
```
`store.upsertMovement` — `INSERT … ON CONFLICT (salon_id, yclients_txn_id) WHERE yclients_txn_id IS NOT NULL DO UPDATE SET qty, unit_type, qty_base, cost_per_unit, discount, cost, occurred_at, deleted_at = NULL` — `recorded_at` НЕ трогается. `store.BALANCES_SQL`:
```sql
WITH op AS (SELECT good_row_id, storage_id, qty_base, taken_at FROM stock_openings WHERE salon_id = $1),
mv AS (
  SELECT mv.good_row_id, mv.storage_id, SUM(mv.qty_base) AS moved
  FROM stock_movements mv
  JOIN stock_documents d ON d.id = mv.document_id AND d.status = 'posted'
  LEFT JOIN op ON op.good_row_id = mv.good_row_id AND op.storage_id = mv.storage_id
  WHERE mv.salon_id = $1 AND mv.deleted_at IS NULL
    AND (op.taken_at IS NULL OR mv.source IN ('loyalpro','inventory')
         OR (mv.recorded_at > op.taken_at AND mv.source IN ('webhook','reconcile')))
  GROUP BY mv.good_row_id, mv.storage_id)
SELECT g.id AS good_row_id, s.id AS storage_id, COALESCE(op.qty_base,0) + COALESCE(mv.moved,0) AS qty_base, op.taken_at
FROM yclients_goods_catalog g
CROSS JOIN stock_storages s
LEFT JOIN op ON op.good_row_id = g.id AND op.storage_id = s.id
LEFT JOIN mv ON mv.good_row_id = g.id AND mv.storage_id = s.id
WHERE g.salon_id = $1 AND s.salon_id = $1 AND s.is_active AND (op.good_row_id IS NOT NULL OR mv.good_row_id IS NOT NULL)
```
Хук в `economics/store.upsertGoodsTransaction` после `db.query(sql, params)`: `if (config.STOCK_LEDGER !== 'false') await safely('stock ingest', () => require('../stock/ledger').ingestMirrored(salonId, row, { status, source, deletedAt }))`.

- [ ] **Step 3: Скрипты.** `stock-opening.js --salon=1 [--write]`: `syncGoodsCatalog` → `openingFromCatalog` по каждому товару → таблица и ИТОГО; `--write` — одна транзакция: `stock_openings`, документ `kind opening` + движения `source 'opening'`, `stock_settings.enabled=TRUE`; отказ, если `enabled`. `stock-backfill-mirror.js --salon=1 [--write]`: все `goods_transactions` салона → `ingestMirrored(…, {status: deleted_at ? 'delete' : 'update', source: 'backfill'})`, счётчики; остатки до/после одинаковы (проверка §6.3). `stock-explain.js`: `EXPLAIN (ANALYZE, BUFFERS)` для `BALANCES_SQL` (позже + `TURNOVER_SQL`, `DOCS_LIST_SQL`) с реальным `$1`; сверка JS `balanceCountsRow` против SQL-флага на 200 случайных строках — расхождение = exit 1.

- [ ] **Step 4: Живо** (pm2 можно не останавливать): `stock-opening.js --salon=1` сухо → у LIP мыла на «Расходниках» ≈ −4059 мл; `--write`; `stock-backfill-mirror.js --salon=1 --write` → `SELECT count(*) FROM stock_movements` ≈ 9 400, `BALANCES_SQL` до/после переливки совпадает; `stock-explain.js` → < 50 мс, инвариант зелёный.

- [ ] **Step 5:** `npx jest backend/stock-ledger economics --silent` → PASS; коммит `feat(stock): леджер движений, входящий остаток, остатки`.

**Чек-лист Opus:** `recorded_at` неизменяем; хук через `safely` и выключается `STOCK_LEDGER=false`; EXPLAIN приложен; переливка не изменила остатки; PII нет.

---

### Task 5: Документы — приход/списание/перемещение, отмена, инвентаризация

**Модель:** Codex GPT Astra.

**Files:** Create `backend/services/stock/documents.js`, `backend/stock-documents.test.js`; Modify `backend/services/stock/store.js`, `backend/routes/stock.js` (`/documents*`, `/inventories*`, `/balances*`, `/openings/reset`)

- [ ] **Step 1: Тесты (красные)** (моки `store`; транзакция — мок `pool.connect` с `query`): `create(salonId, userId, body)` — `validateDocument` (ошибки → `StockError 400 {errors}`), в одной транзакции `insertDocument(status 'posted', origin 'loyalpro', total_cost)` + `ledger.postDocument` + `invalidateBalances(salonId)`; `cancel(salonId, userId, id, reason)` — `origin 'yclients'` → 409 `mirror`; уже `cancelled` → 409; иначе `status 'cancelled'`, `cancel_reason` (обязателен, ≤ 500), движения `deleted_at = NOW()`; `inventoryCreate({storageId, categoryId?})` → `draft` + строки с `expected_base` из `BALANCES_SQL`; `inventorySetLines(id, lines)` → `inventoryDiff`; `inventoryPost(id)` → пересчёт `expected_base` заново, движения `source 'inventory'` только при `diff ≠ 0`, `status 'posted'`; `openingReset({goodRowId, storageId, note})` (owner) → свежий `GET /goods/{cid}/{good}` (единственное чтение YClients вне синков) → новая строка `stock_openings` (`taken_at = now`, `qty_base` = `actual_amounts × unit_equals`) + движение `kind opening` с `note`; у локального товара (`yclients_good_id NULL`) → 409 `local_good`.

- [ ] **Step 2: Реализация** по тестам; роутер превращает любую не-`StockError` в 502 `unavailable`. Остатки — `store.balances(salonId, filters)` с кэшем 30 с (`Map` по `salonId`, инвалидация при любом движении).

- [ ] **Step 3: Живо** на деве (наша БД, YClients не трогаем): приход 2 шт локального тестового товара → остаток 2; перемещение 1 → 1/1; списание 1 → 0/1; инвентаризация со счётом 3 → движение +2; отмена прихода → остаток пересчитан; через `curl` к `/api/stock` с токеном из `sessions`.

- [ ] **Step 4:** `npx jest backend/stock --silent` → PASS; коммит `feat(stock): документы прихода/списания/перемещения, отмена, инвентаризация`.

**Чек-лист Opus:** документ и движения — в одной транзакции; отмена не удаляет строки; инвентаризация пересчитывает ожидание перед проведением.

---

### Task 6: Продажа клиенту с оплатой, финансы

**Модель:** Codex GPT Astra.

**Files:** Create `backend/services/stock/sales.js`, `backend/stock-sales.test.js`; Modify `backend/services/finance-ops.js` (`recordStockSalePayment`, `cancelByStockDocument`), `backend/routes/stock.js` (`/sales*`, `/clients/:id/purchases`), `backend/services/journal/visit-history.js`

- [ ] **Step 1: Тесты (красные)** `stock-sales.test.js`: `create(salonId, userId, body)`: клиент по `clientId` или `phone` (суффиксный поиск по 10 цифрам в `clients`, как `resolveTestClient` напоминаний; нет → `ycSearchClientIdByPhone` + `INSERT clients` минимальный, как журнал); `validateDocument` + `validateSalePayments(payments, totalCost, {gift})`; одна транзакция: документ `sale` `posted` + движения + по каждой оплате `finOps.recordStockSalePayment(q, {...})` (`kind 'goods_sale'`, `method cash|card`, `amount > 0`), `step_op_id` = новый uuid на оплату, `status 'confirmed'`, `origin 'loyalpro'`, `stock_document_id`. Способ `bonus` отвергается на уровне модели (решение владельца: бонусы только на услуги). `recordStockSalePayment`: идемпотентность по `step_op_id`. `cancelByStockDocument(q, salonId, docId)` → строки `cancelled`.

- [ ] **Step 2: Реализация** по тестам. `documents.cancel` у продажи зовёт `cancelByStockDocument`.

- [ ] **Step 3: `visit-history.js`**: покупки — `UNION` строк `finance_operations` (как сейчас) и документов `stock_documents kind='sale' origin='loyalpro'` без оплат (подарки), дедуп по `stock_document_id`; расходники под услугой — из `stock_movements kind consumable` (зеркало + наши корректировки, строка «корректировка LoyalPro» отдельно). Тесты `journal-visit-history.test.js` правятся на новые SQL.

- [ ] **Step 4: Живо** (`stock-e2e.js`, `--sale`): продажа 1 шт локального тестового товара клиенту 79200255591 за 1 ₽ картой → документ `posted`, `finance_operations` одна строка `goods_sale confirmed`; отмена документа → строка `cancelled`.

- [ ] **Step 5:** `npx jest backend/stock finance backend/journal-visit-history --silent` → PASS; коммит `feat(stock): продажа клиенту, оплата, бонусы, покупки в истории посещений`.

**Чек-лист Opus:** `finance-ops` — единственный писатель; способ `bonus` невозможен ни на фронте, ни на бэке; отмена продажи гасит `finance_operations`; PII нет.

---

### Task 7: API чтения и отчётов

**Модель:** Sonnet.

**Files:** Modify `backend/routes/stock.js`, `backend/services/stock/store.js`; Create `backend/stock-routes.test.js`

- [ ] **Step 1: Тесты (красные)**: `parseGoodsQuery` (search ≤ 100, `category`/`storage` числа, `only_critical/only_negative/active` строго `'1'`, `source ∈ {yclients, loyalpro}`); `parseDocsQuery` (`kind ∈ KINDS`, `status`, `origin`, `from/to` через `utils/period.js`, период ≤ 731 → иначе 400, `client`/`record` числа, `page` ≥ 1, `limit` ≤ 200); `parseTurnoverQuery`.
- [ ] **Step 2: Роуты** §7 спеки: `GET /goods`, `GET /goods/:id` (поля, остатки, движения `LIMIT 50 OFFSET`, приходы — `store.listReceipts`, техкарты — `tech_cards.items @> '[{"good_id":N}]'` только у товаров YClients, `yc_qty_base` снимка), `GET /balances`, `GET /documents`, `GET /documents/:id` (строки с названиями, единицами, `fromBase`), `GET /clients/:clientId/purchases`, `GET /reports/turnover` (`TURNOVER_SQL`: начало = остаток на `from` по правилу §6.3 с `occurred_at < from`, приход/расход по знаку за период, конец). Не-`StockError` → 502.
- [ ] **Step 3:** `stock-explain.js` + `TURNOVER_SQL`, `DOCS_LIST_SQL`; цель < 100 мс на дев-данных.
- [ ] **Step 4:** `npx jest backend/stock --silent`; `curl` живая проверка `GET /api/stock/goods?only_negative=1`; коммит `feat(stock): API остатков, товаров, документов, оборотки`.

**Чек-лист Opus:** `requireRole('owner','admin')` везде, owner-only помечены; период капится; `salon_id` в каждом SQL.

---

### Task 8: Фронт — каркас, «Остатки», «Товары», карточка и форма товара

**Модель:** Sonnet.

**Files:** Create `frontend/js/pages/stock.js`, `stock-balances.js`, пустые `stock-docs.js`, `stock-sale.js`, `stock-inventory.js`, `stock-refs.js` (заголовок-комментарий), `frontend/css/stock.css`, `backend/stock-ui.test.js`; Modify `frontend/index.html`, `frontend/js/core/nav.js`

- [x] **Step 1: Харнесс и тесты (красные)** `backend/stock-ui.test.js` — копия подхода `journal-ui.test.js` с `STOCK_FILES`; тесты: нет дублей верхнеуровневых имён; `index.html` грузит все файлы после `#page-stock` с `?v=`; пункт `data-p="stock"` в ОБОИХ меню с `data-roles="owner,admin"`; `stockFmtQty(1150, 500, 'шт', 'мл')` → `'2 шт + 150 мл'`, `stockFmtQty(-4059, 500, 'шт', 'мл')` → `'−9 шт + 441 мл'`, `stockFmtQty(7, 1, 'шт', 'шт')` → `'7 шт'`; `stockBalanceRows(goods, storages, {onlyCritical, onlyNegative, search})` — фильтры, сортировка по названию, классы `crit`/`neg`; `stockGoodFormDraft()` собирает тело `POST /goods`; рендер экранирует (`<script>` → `&lt;script&gt;`).
- [x] **Step 2: Разметка и навигация.** `index.html`: пункт «Товары» в группе «Управление» после «Услуги» в обоих меню; `<div class="page" id="page-stock">` с `bc-head` («📦 Товары и склад», счётчики: критических, отрицательных, документов за сегодня) и вкладками `stockTabBtn-<tab>` для `balances|goods|docs|suppliers|tech-cards|inventory|turnover|settings`, контейнеры `#stockTab-<tab>`; `<link rel="stylesheet" href="css/stock.css?v=…">`. `nav.js`: `stock: 'Товары и склад'`, `if (p === 'stock') loadStock();`, deep-links.
- [x] **Step 3: `stock.js`**: `_stock` (вкладка, фильтры, справочники), `stockApi`, `loadStock()` (`GET /dictionaries` + вкладка + `_deepLinkArg`), `stockSwitchTab`, `stockLoadCounters`. `stock-balances.js`: «Остатки» (товар × склады, фильтры, подсветки, клик → карточка товара), «Товары» (поиск, дерево категорий из `category_path`/`local_category`, бейдж «LoyalPro» у локальных, «+ Товар» → форма в `<dialog id="stockGoodModal">`), карточка товара (поля, остатки, движения постранично, приходы, техкарты, «YClients на снимке», локальные поля, `PUT /goods/:id`).
- [x] **Step 4: CSS** `stock.css`: таблицы, бейджи источника, подсветки, диалоги; ≤ 700px таблицы → карточки (`data-label`).
- [ ] **Step 5:** `npx jest backend/stock-ui --silent` → PASS; визуально на деве `#stock` в обеих темах и 390px (скриншоты в отчёт). Коммит `feat(stock): страница «Товары» — каркас, остатки, каталог`.

**Чек-лист Opus:** префиксы; `esc` везде; `?v=`; меню в обоих местах; роли = API.

---

### Task 9: Фронт — журнал операций, формы прихода/списания/перемещения, продажа

**Модель:** Sonnet.

**Files:** Modify `frontend/js/pages/stock-docs.js`, `stock-sale.js`, `stock.css`, `index.html` (`<dialog id="stockDocModal">`, `<dialog id="stockSaleModal">`), `backend/stock-ui.test.js`

- [ ] **Step 1: Тесты (красные)**: `stockDocBadge(doc)` → текст/класс по `origin` и `status` («LoyalPro» / «YClients», «Отменён»); `stockLinesTotal(lines)` в копейках; `stockDocFormDraft()` → тело `POST /documents`; `stockSaleDraft()` → `payments[]` (`cash|card`), клиентская проверка при сумме ≠ итогу (повтор логики `validateSalePayments`; сервер — источник правды); рендер экранирует комментарии.
- [ ] **Step 2: Реализация.** `stock-docs.js`: `stockLoadDocs()` с фильтрами (вид, источник, статус, период, склад, клиент), таблица, карточка документа (строки с `stockFmtQty`, итог, источник, «Отменить» с причиной — только у `origin='loyalpro'`, «Открыть запись» при `record_id`, у продажи — оплаты); формы «Приход»/«Списание»/«Перемещение» в одном `<dialog>`: склад(ы), поставщик (приход), дата, строки `[поиск товара (datalist по `GET /goods?search=`), кол-во, единица (шт|мл по товару), цена, скидка, итог]`, «+ строка», `warnings[]` жёлтым, `errors[]` списком. `stock-sale.js`: `stockSaleOpen({clientId, recordId, staffYcId})` — клиент (поиск `/api/clients?q=` как журнал, либо телефон), мастер, склад `for_sale`, строки с ценой `local_sale_price ?? sale_price`, оплаты (наличные/карта), «Подарок», «Продать» → `POST /sales` → итог плашкой.
- [ ] **Step 3:** тесты, визуальная проверка на деве (продажа — только локального тестового товара на 79200255591, «наличные» 1 ₽, затем отмена из карточки документа). Коммит `feat(stock): журнал операций, формы документов, продажа`.

**Чек-лист Opus:** суммы в копейках; отмена — с причиной; экранирование; форма продажи работает и из карточки записи.

---

### Task 10: Фронт — инвентаризация, оборотка, поставщики, единицы, склады, настройки, техкарты

**Модель:** Sonnet.

**Files:** Modify `frontend/js/pages/stock-inventory.js`, `stock-refs.js`, `frontend/js/pages/economics.js` (`ecoLoadTechCards(containerId)`), `backend/stock-ui.test.js`

- [ ] **Step 1: Тесты (красные)**: `stockInvRows(lines)` — разница с подсветкой, итого недостач/излишков; `stockTurnoverRows(rows, {search})`; `ecoLoadTechCards()` без аргумента пишет в `ecoTechCards`.
- [ ] **Step 2: Реализация.** `stock-inventory.js`: список инвентаризаций, «Новая» (склад, категория), экран подсчёта с автосохранением (`PUT /inventories/:id/lines`, дебаунс 800 мс), «Провести» (`confirm`), пометка «черновик старше 7 дней». Оборотка: период (`pb-wrap` как в экономике), склад, категория, таблица начало/приход/расход/конец, CSV-выгрузка на фронте. `stock-refs.js`: поставщики (таблица + форма), единицы, склады (локальный склад — форма; YClients-склады — только назначение по умолчанию), настройки (`default_*_storage_id` — owner). Вкладка «Техкарты»: `ecoLoadTechCards('stockTechCards')`; выделить `ecoEnsurePeriod()` (текущий месяц, если `_eco.from` пуст).
- [ ] **Step 3:** `npx jest backend/stock backend/stock-ui economics --silent`; коммит `feat(stock): инвентаризация, оборотка, справочники, настройки, техкарты`.

**Чек-лист Opus:** проведение не создаёт движений при `diff=0`; `ecoLoadTechCards()` без аргумента не изменил «Экономику»; owner-only настройки скрыты у admin.

---

### Task 11: Журнал записи — вкладки «Товары» и «Расходники»

**Модель:** Codex GPT Astra.

**Files:** Create `backend/services/stock/consumables.js`, `backend/stock-consumables.test.js`; Modify `backend/routes/stock.js` (`/records/:recordId/consumables*`), `frontend/js/pages/journal-card.js`, `frontend/css/journal.css`, `backend/journal-ui.test.js`

- [ ] **Step 1: Тесты (красные)** `stock-consumables.test.js`: `expectedFor(service, staffYcId, links, cards, priceFn)` → норма `{goodRowId, qtyBase, unitPrice, cost}` по `pickTechCard` + `tech_cards.items` × `amount` услуги (товар YClients → `goodRowId` по `good_id`); `compare(expected, actual)` → по товару `{expected, actual, diff, flag: ok|over|missing|extra}` (`over` при факте > норма × 1.2); `summary` — Σ cost факта/нормы; `update(…)` → `consumableDelta(target, actual)` → документ `consumable` с дельтами (`service_yc_id`, `record_id`, `master_staff_yc_id`, склад `default_service_storage_id`), нулевая дельта → 200 без документа; запись `id<0` → `{expected, actual:[], note}`.
- [ ] **Step 2: Реализация.** `forRecord(salonId, recordId)`: услуги записи — из зеркала `records.raw_payload.services` (как `journal/index.detail`), мастер — `records.staff_id`; факт — `stock_movements kind consumable` по `record_id` (+`service_yc_id`), строки документов `origin='loyalpro'` помечены «корректировка LoyalPro»; норма — `economics/store` (`service_tech_cards`, `tech_cards`) + `price.unitPriceAsOf` (приходы — `store.listReceipts` леджера, задача 14 — до неё из `economics/store.listReceipts`); `update` — транзакция как `documents.create`.
- [ ] **Step 3: Фронт карточки записи.** `jrStub('Товары','box','jr-tab-stub')` → живая вкладка `#jrTabGoods`, переключение «Услуги/Товары» без перерисовки (панели `#jrServicesPane`/`#jrGoodsPane`, как «Клиент/Чат»); панель: продажи записи (`GET /api/stock/documents?record=<id>`), «Продать товар» → `stockSaleOpen({recordId, clientId: summary.clientId, staffYcId})` (второй `<dialog>` поверх `jrModal` — `showModal()` после; z-order проверить живьём). Плитка «Списание расходников» → панель «Расходники»: таблица по услугам (товар / норма / факт / разница / сумма, корректировки отдельно), итог материалов визита, «Изменить» → редактор целевого состава (кол-во в ед. списания) → `PUT /api/stock/records/:id/consumables/:serviceId`. У `id<0` — только норма. Тесты в `journal-ui.test.js`: вкладка переключает панели без `jrAppointmentCard`; экранирование.
- [ ] **Step 4: Живо** на деве: карточка состоявшейся записи 79200255591 — факт совпадает с `goods_transactions` type 2 этой записи; правка (+1 тестовый локальный товар) → документ `consumable` с дельтой −1 (расход), факт обновился; правка обратно → дельта +1. YClients не трогается.
- [ ] **Step 5:** `npx jest backend/stock backend/journal-ui --silent`; коммит `feat(stock): расходники и продажи в карточке записи`.

**Чек-лист Opus:** норма — через общие `pickTechCard`/`unitPriceAsOf`; корректировки — дельтами, факт YClients не переписывается; несохранённые правки карточки живут.

---

### Task 12: Карточка пациента — покупки

**Модель:** Sonnet.

**Files:** Modify `frontend/js/pages/clients.js` (`openCD`); тест — `vm`-рендер блока (отдельный `backend/clients-purchases-ui.test.js`, грузит `clients.js` и `stock-docs.js`)

- [ ] **Step 1: Тест (красный)**: `cdPurchasesHtml(rows)` рендерит дату, товары (экранировано), сумму, способ оплаты; пусто → «Покупок нет».
- [ ] **Step 2:** в `openCD(id)` после блока визитов — `GET /api/stock/clients/:id/purchases` в своём `try/catch` (сбой → прочерк), блок «Покупки», клик → `navTo('stock')` + `#stock/doc/<id>`.
- [ ] **Step 3:** тесты, живая проверка на пациенте с продажей из зеркала; коммит `feat(stock): покупки в карточке пациента`.

**Чек-лист Opus:** сбой ручки не ломает карточку; экранирование; бамп `?v=` у `clients.js`.

---

### Task 13: Ночной проход

**Модель:** Sonnet.

**Files:** Modify `backend/services/stock/index.js` (`nightly(salon)`), `backend/services/economics/sync.js` (`runNightly` → `stock.nightly` после `syncGoodsCatalog`), `backend/services/stock/ledger.js` (`drainIngestPending`), тесты `backend/stock-ledger.test.js`

- [ ] **Step 1: Тесты (красные)**: `drainIngestPending` — строки, чей `good_id` появился в каталоге, проходят `ingestMirrored` и удаляются; `nightly` зовёт `syncStorages`, `syncCategories` (троттлинг 30 мин), `drainIngestPending`, пишет одну строку лога `stock nightly salon=1: pending=0 storages=2 categories=skipped`; исключение любого шага не роняет остальные.
- [ ] **Step 2: Реализация**; `economics.runNightly` зовёт `stock.nightly` в своём `try/catch`, ошибка — в `r.errors`.
- [ ] **Step 3:** живой вызов `nightly` для salon 1; `npx jest backend/stock economics --silent`; коммит `feat(stock): ночной проход склада внутри экономического`.

**Чек-лист Opus:** один крон (экономический); ничего не правит остатки.

---

### Task 14: Цена единицы по приходам леджера

**Модель:** Sonnet. **Назначение:** экономика считает цену единицы по «последнему приходу» из `goods_transactions`; наши приходы туда не попадают. Карточка товара и расходники записи берут цену по приходам ЛЕДЖЕРА (наши + зеркало) через тот же `price.unitPriceAsOf`.

**Files:** Modify `backend/services/stock/store.js` (`listReceipts(salonId, goodRowId)` — `stock_movements kind receipt` обоих источников в форме `{create_date, amount, cost, operation_unit_type}`), `backend/services/stock/consumables.js`, `routes/stock.js` (карточка товара); тесты `backend/stock-consumables.test.js`

- [ ] **Step 1: Тест (красный)**: норма расходников берёт цену по приходу `origin='loyalpro'`, если он позже последнего зеркального.
- [ ] **Step 2:** реализация через `price.unitPriceAsOf({receipts: store.listReceipts(…), override, catalogRow, date})`.
- [ ] **Step 3:** тесты; коммит `feat(stock): цена единицы по приходам леджера`. Экономика процедур НЕ меняется (решение §11 п. 7).

**Чек-лист Opus:** `unitPriceAsOf` не копируется; экономика по-прежнему читает `goods_transactions`.

---

### Task 15: Живые прогоны, документация, финальное ревью

**Модель:** Sonnet (скрипты, доки) → **Opus** (финальное ревью ветки с записью находок в `docs/2026-11-13-stock-review.md` ПО ХОДУ; один проход, без фоновых агентов).

**Files:** Create `backend/scripts/stock-ui-e2e.js` (puppeteer: страница, вкладки, формы без сохранения, карточка товара, карточка записи с вкладками, две темы, 390px; скриншоты `/tmp/stock-*.png`), финальная `backend/scripts/stock-e2e.js` (`--sale --cleanup`), `docs/2026-11-13-stock-acceptance.md`, `docs/2026-11-13-stock-review.md`; Modify `CLAUDE.md` (раздел «### Склад и товары («Управление → Товары», с 13.11.2026, дев)» ≤ 40 строк: таблицы, правило счёта, «в YClients не пишем ничего», готча nullable `yclients_good_id` и страж «Уходов», рычаг `STOCK_LEDGER`, команды), память проекта (`stock_goods_plan_2026_11_13.md` обновить; строка `MEMORY.md` ≤ 200 символов).

- [ ] **Step 1:** `npx jest backend/stock economics backend/journal finance yclients-goods-catalog --silent` — зелёные (флейк `primary-clients` не относится).
- [ ] **Step 2:** `stock-e2e.js` на деве → `stock-acceptance.md` (остатки до/после одинаковы, `finance_operations` чист).
- [ ] **Step 3:** `stock-ui-e2e.js` → скриншоты.
- [ ] **Step 4: Opus — финальное ревью**: чек-листы задач + инварианты: (1) ни одного `POST/PUT/DELETE` к YClients; (2) `recorded_at` неизменяем; (3) `safely` вокруг хука; (4) `salon_id` во всех SQL; (5) нет копий `writeoffQty`/`unitPriceAsOf`/`pickTechCard`/`parseCatalogGood`; (6) PII; (7) `?v=`; (8) миграции аддитивны, единственный `ALTER COLUMN` — `DROP NOT NULL`; (9) Step C «Уходов» защищён. Находки — в файл по ходу; критичные чинятся отдельными коммитами.
- [ ] **Step 5:** CLAUDE.md и память; коммит `docs(stock): раздел CLAUDE.md, приёмка, ревью`. Владельцу — список решений §11 на подтверждение.

---

## Самопроверка плана
- **Покрытие спеки:** §5 → 2; §6.1/6.3 → 4, 13; §6.2 → 5; §6.4 → 6, 9, 12; §6.5 → 11, 14; §6.6 → 5, 10; §6.7 → 3, 8; §7 → 3, 5, 6, 7, 11; §9.1 → 8–10; §9.2 → 11; §9.3 → 12; §13 → 4, 15.
- **Имена, общие между задачами:** `model.toBaseInfo/toBase/fromBase/validateDocument/validateSalePayments/consumableDelta/inventoryDiff/balanceCountsRow/kop/StockError/fail`; `store.BALANCES_SQL/TURNOVER_SQL/DOCS_LIST_SQL/upsertMovement/insertMovement/upsertMirrorDocument/listReceipts/balances/goodByYcId/ensureStorage/clientIdByYc/addIngestPending/markMovementDeleted/getSettings/saveSettings/listGoods`; `ledger.ingestMirrored/postDocument/openingFromCatalog/drainIngestPending`; `documents.create/cancel/inventoryCreate/inventorySetLines/inventoryPost/openingReset`; `sales.create`; `consumables.forRecord/update`; `catalog-sync.syncStorages/syncCategories/collectUnits/handleGoodEvent/createLocalGood/updateGood`; `finance-ops.recordStockSalePayment/cancelByStockDocument`; фронт `stockApi/stockSwitchTab/stockFmtQty/stockBalanceRows/stockDocBadge/stockSaleOpen/stockLoadDocs`; `ecoLoadTechCards(containerId)`.
- **Отличие от первой редакции:** убраны воркер отправки, `draft_json`, маркеры `[LP#id]`, сверка эха, права на запись, `sync_status`, живые пробы записи; добавлены локальные товары (nullable `yclients_good_id` + страж «Уходов»), корректировка расходников дельтой, оплата продажи без YClients (только наличные/карта — бонусы только на услуги), цена по приходам леджера.
