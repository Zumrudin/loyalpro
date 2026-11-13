# Склад, товары и операции («Управление → Товары») — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Страница «Управление → Товары» с остатками, каталогом, журналом операций (приход/списание/перемещение/продажа/инвентаризация), поставщиками и техкартами; остаток считает LoyalPro из единого леджера, принимаемое API уходит в YClients очередью; в карточке записи журнала видны и редактируются списания расходников и продажи клиенту визита; в карточке пациента — покупки.

**Architecture:** Леджер `stock_documents`/`stock_movements` питается двумя входами — зеркалом YClients (хук в `economics/store.upsertGoodsTransaction`) и нашими документами; остаток = входящий остаток + движения. Отправка в YClients — `services/stock/outbox-worker.js` по образцу журнала (черновик строкой до отправки, at-most-once, маркер `[LP#id]` в комментарии для сверки). Деньги продажи — через `finance-ops`. Фронт — шесть файлов `frontend/js/pages/stock*.js` одной глобальной области с префиксом `stock`.

**Tech Stack:** Node.js/Express, pg без ORM, vanilla JS SPA, Jest (`TZ=Europe/Moscow`), `vm`-тесты фронта, puppeteer. Спека — `docs/superpowers/specs/2026-11-13-stock-goods-design.md` (разделы — обязательства; ссылки вида §6.3 — на неё).

---

## 0. Кто что делает (распределение по моделям — требование владельца)

| Роль | Модель | Что | Как вызывать |
|---|---|---|---|
| **Ревьюер и диспетчер** | **Opus** | Читает спеку и план; перед каждой задачей выдаёт исполнителю бриф (цель, файлы, готчи, критерии); после задачи — ревью диффа по чек-листу задачи (ниже у каждой), запускает тесты сам, принимает/возвращает; пишет короткий отчёт в чат. Коммитит только принятое. Пишет итоговое ревью (задача 15) | `Agent` `model: opus`, `subagent_type: superpowers:code-reviewer` для ревью; `general-purpose` для брифов |
| **Исполнитель ядра** | **Codex GPT Astra** (`/usr/local/bin/codex`, модель моста `gpt-6-astra`, см. `providers/codex.js`) | Задачи **L2**: SQL леджера и живой EXPLAIN, воркер отправки с идемпотентностью, продажа с оплатой, интеграция в журнал, живые пробы API | `codex exec --cd /root/loyalpro-stock -m gpt-6-astra "<бриф + ссылка на задачу плана>"` из каталога ветки; PATH с node v20 (`/root/.nvm/versions/node/v20.20.2/bin`) |
| **Исполнитель механики** | **Sonnet** | Задачи **L1**: миграции, справочники, CRUD-роуты по образцу, вкладки-формы, скрипты, доки | `Agent` `model: sonnet`, `subagent_type: general-purpose` |
| **Поиск** | **Haiku** | Только поиск по коду/докам по короткому вопросу исполнителя («где читается `goods_transactions`», «какие тесты трогают `yclients_goods_catalog`»). ГОТЧА (память `feedback-haiku-context-too-small`): субагент Haiku ВНУТРИ репо падает «Prompt is too long» из-за автоподгрузки CLAUDE.md — запускать `claude -p --model haiku` из каталога БЕЗ CLAUDE.md (например `/tmp/stock-search`) с явными `rg`-командами в промпте, либо сразу Sonnet `Explore` | `cd /tmp/stock-search && claude -p --model claude-haiku-5-5 "…"` |
| **Решения** | Fable (эта сессия) / владелец | Спорные решения §11 спеки, приёмка, выкат | — |

**Уровни задач:** L1 — Sonnet; L2 — Codex GPT Astra; L3 — только ревью Opus и решения. Каждая задача ниже помечена `**Модель:**`.

**Правила процесса (из опыта проекта, память `feedback_sequential_execution_no_background_burn`):**
1. **По очереди**: один исполнитель за раз, без фоновых параллельных агентов. Результат каждой задачи — отчёт в чат СРАЗУ (что сделано, какие тесты зелёные, что не вошло).
2. **Один ревьюер на задачу (Opus)**, без второго «quality»-ревьюера; качество кода Opus смотрит по дифу. При 429 у субагента незакоммиченные правки остаются в worktree — Opus дочищает и коммитит сам, агента не перезапускает.
3. **Перед стартом** — `ListAgents` (нет ли второй сессии в этом дереве, память `feedback_check_peer_sessions_before_plan`).
4. Исполнитель получает **бриф, не весь план**: цель задачи, список файлов, код из задачи, чек-лист, команды тестов, 3–5 готчей из раздела «Готчи» ниже. Бриф пишет Opus.
5. Коммит после каждой принятой задачи в ветку `feat/stock-goods` (worktree `/root/loyalpro-stock`). Прод не трогаем.
6. **TDD**: сначала тест (красный), потом код; ревьюер проверяет, что тест был красным (исполнитель приводит вывод).

---

## Как запускать

```bash
export PATH=/root/.nvm/versions/node/v20.20.2/bin:$PATH
# worktree ветки (создать один раз из /root/loyalpro, main чистый по нашим файлам):
git -C /root/loyalpro worktree add /root/loyalpro-stock -b feat/stock-goods main
cd /root/loyalpro-stock/backend && npm ci --ignore-scripts 2>/dev/null || npm install
# один набор (префикс backend/ ОБЯЗАТЕЛЕН — голый шаблон «stock» в рабочей копии с «stock» в имени гонит весь репозиторий):
npx jest backend/stock-model --silent
# все наборы склада:
npx jest backend/stock --silent
# смежные, которые обязаны остаться зелёными:
npx jest economics backend/journal finance --silent
# фронт склада (vm-харнесс):
npx jest backend/stock-ui --silent
```

- БД дева — `loyalpro_test` (`DATABASE_URL` в `backend/.env`, PG15 локально на `:5432`; MCP-сервер postgres смотрит на мёртвый `:5433` — для ручных запросов `psql "$DATABASE_URL"`).
- Дев-сервер: `cd /root/loyalpro/backend && PORT=3001 pm2 restart loyalpro` (НЕ `--update-env`). Для живых прогонов воркера — `pm2 stop loyalpro` на время скрипта.
- Записи и продажи в YClients живьём — ТОЛЬКО клиент 79200255591 и тестовый товар «ТЕСТ LoyalPro» (заводит владелец руками в YClients, категория Расходники → Основные товары, обе единицы «шт», `unit_equals` 1); все созданные документы удаляются скриптом (`DELETE /storage_operations/documents`).
- Миграции — только в `backend/migrations.js`, новый блок `// ── STOCK` после блока журнала, только `IF NOT EXISTS`/`DO NOTHING`.
- Правка JS/CSS фронта — с бампом `?v=` в `frontend/index.html`.

## Готчи проекта (в бриф каждой задачи — те, что относятся)

1. **`db.one` ≡ `db.oneOrNone`**: оба возвращают `null`, не бросают. Проверять результат явно.
2. **JSONB переставляет ключи**: тело запроса в YClients хранится СТРОКОЙ (`draft_json TEXT`), повтор отправляет байт-в-байт то же.
3. **Общая глобальная область фронта**: все `stock*.js` — классические `<script>`; дубль `const`/`let` между файлами = `SyntaxError`, который гасит ВЕСЬ файл. Префикс `stock`/`STOCK_` обязателен; тест «нет дублей верхнеуровневых имён» — как в `journal-ui.test.js`.
4. **vm-харнесс — не DOM**: `document.getElementById` отдаёт заглушку; логику писать чистыми функциями (`stockBalanceRows`, `stockFmtQty`…), обработчики проверять прямым вызовом.
5. **`yclients_goods_catalog.is_archived` занят «Уходами»** (экономика вставляет расходники с `is_archived=TRUE`): склад читает активность по своей колонке `stock_active`. Синк «Уходов» (`yclients-goods-catalog.js`) soft-delete'ит по `last_seen_at` — наши новые колонки он не трогает.
6. **`changed_after` YClients только с временем** (`YYYY-MM-DDT00:00:00`), голая дата молча отдаёт всю историю. Числа в ответах — строками. `/goods` — `count=100`, до ПУСТОЙ страницы.
7. **Количества**: `operation_unit_type` 1 — ед. продажи, 2 — ед. списания; у части списаний `amount` в ед. продажи при типе 2 — пересчёт ТОЛЬКО через `economics/price.writeoffQty` (доказательство по `cost`). `actual_amounts` — в ед. продажи, бывают отрицательные.
8. **Права API** (§1.3 спеки): приход/списание/продажа — можно; перемещение, инвентаризация, создание/правка товара — 403 до выдачи прав. Код обязан переживать 403 как `failed:no_permission`, не как `uncertain`.
9. **Тексты YClients наружу не отдавать** — коды; тексты в лог. **PII** (имя/телефон клиента) в леджер не писать.
10. **Москва**: `TZ=Europe/Moscow` у jest и pm2; даты для YClients `create_date` — `YYYY-MM-DD HH:MM:SS` по Москве.
11. **Квота YClients минутная и общая**: воркер ≤ 5 документов за тик, пауза 2 с, 429 — `withRateLimitRetry` (`services/yclients-retry.js`).
12. **Экономика не ломается**: хук леджера зовётся через `safely()` (как `finance-ops`), `goods_transactions` и её тесты (`npx jest economics`) остаются зелёными.
13. **Живой EXPLAIN** с реальными bound-параметрами обязателен для SQL остатков и аренды воркера (`scripts/stock-explain.js`) — EXPLAIN с литералами не ловит вывод типов параметров (готча проекта с `$2::date`).

## Карта файлов

### Создаются
| Файл | Ответственность |
|---|---|
| `backend/services/stock/model.js` | чистая модель: виды, статусы, пересчёт единиц, валидация документа, тело запросов YClients, сопоставление ответа, правило счёта остатка (§8 спеки) |
| `backend/services/stock/store.js` | весь SQL склада: справочники, документы, движения, остатки (CTE экспортируется), показания, инвентаризация; аренда очереди |
| `backend/services/stock/ledger.js` | `ingestMirrored` (зеркало → леджер), `recordLocal` (наш документ → движения), `linkResponse` (связка ответа YClients с нашими строками), `balances`, `discrepancies` |
| `backend/services/stock/documents.js` | создание/отмена/переотправка документов, перевод `local → queued`, инвентаризация (проведение, выравнивание) |
| `backend/services/stock/sales.js` | продажа клиенту: документ + оплата (`journal/yclients.pay`) + `finance-ops` |
| `backend/services/stock/consumables.js` | расходники записи: факт/норма/расхождение, тело `PUT record_consumables` |
| `backend/services/stock/catalog-sync.js` | обход дерева категорий, расширенные поля товара, апсерт складов и единиц, обработка вебхука `good` |
| `backend/services/stock/outbox-worker.js` | тик 5 с: аренда, отправка в YClients, связка, повторы, `uncertain` и сверка по маркеру |
| `backend/services/stock/index.js` | фасад для `server.js`/`routes/webhook.js`/`economics` |
| `backend/services/yclients-write-errors.js` | общая классификация ошибок записи в YClients (`retry/fail/uncertain/no_permission`), вынесена из `journal/outbox-worker.js` |
| `backend/routes/stock.js` | `/api/stock` (§7 спеки) |
| `backend/scripts/stock-opening.js`, `stock-explain.js`, `stock-e2e.js`, `stock-ui-e2e.js` | входящий остаток; EXPLAIN; живой прогон; браузер |
| `backend/stock-model.test.js`, `stock-ledger.test.js`, `stock-documents.test.js`, `stock-outbox-worker.test.js`, `stock-sales.test.js`, `stock-consumables.test.js`, `stock-catalog-sync.test.js`, `stock-routes.test.js`, `stock-ui.test.js`, `yclients-write-errors.test.js` | тесты |
| `frontend/js/pages/stock.js`, `stock-balances.js`, `stock-docs.js`, `stock-sale.js`, `stock-inventory.js`, `stock-refs.js` | страница (§9.1 спеки) |
| `frontend/css/stock.css` | стили страницы и форм |

### Изменяются
| Файл | Что |
|---|---|
| `backend/migrations.js` | блок STOCK (задача 2) |
| `backend/services/economics/store.js` | хук `stockLedger.ingestMirrored` после апсерта (через `safely`) |
| `backend/services/economics/sync.js` | `parseCatalogGood` → расширенные поля; `runNightly` зовёт `stock.nightly` (категории, показания) |
| `backend/services/journal/outbox-worker.js` | `classify` → импорт из `yclients-write-errors.js` |
| `backend/services/finance-ops.js` | `recordStockSalePayment`, колонка `stock_document_id`, связка `revenue_operations` по `sold_item_id` → наша `yclients_txn_id` |
| `backend/routes/index.js` | `app.use('/api/stock', require('./stock'))` |
| `backend/routes/webhook.js` | вебхук `good` → `stock.handleGoodEvent` |
| `backend/server.js` | старт воркера (`STOCK_OUTBOX!=='false'`), `recoverRunning` при старте |
| `backend/config.js` | `STOCK_OUTBOX`, `STOCK_LEDGER` |
| `frontend/index.html` | пункт меню «Товары» (оба меню), `#page-stock`, `<script>` шести файлов + css |
| `frontend/js/core/nav.js` | заголовок, `loadStock()`, deep-link `#stock/doc/<id>`, `#stock/good/<id>` |
| `frontend/js/pages/journal-card.js` | вкладки «Товары» и «Расходники» |
| `frontend/js/pages/clients.js` | блок «Покупки» в `openCD` |
| `frontend/js/pages/economics.js` | `ecoLoadTechCards(containerId = 'ecoTechCards')` |
| `backend/services/journal/visit-history.js` | покупки — из леджера (наши + зеркало) |
| `CLAUDE.md` | раздел «Склад и товары» (задача 15) |

---

### Task 0: Карта точек интеграции (поиск)

**Модель:** Haiku (из `/tmp/stock-search`, см. §0) → при отказе Sonnet `Explore`.

**Files:**
- Create: `docs/2026-11-13-stock-integration-points.md`

- [ ] **Step 1: Собрать все места чтения/записи**

Запросы (ripgrep по `/root/loyalpro`, исключая `node_modules`):
```bash
rg -n "goods_transactions" backend --glob '!*.test.js' -l
rg -n "yclients_goods_catalog" backend frontend --glob '!*.test.js' -l
rg -n "tech_cards|service_tech_cards" backend --glob '!*.test.js' -l
rg -n "sold_item_id|goods_sale" backend --glob '!*.test.js' -l
rg -n "jrStub\('Товары'|Списание расходников" frontend/js/pages
rg -n "is_archived" backend --glob '!*.test.js'
```

- [ ] **Step 2: Записать таблицу «файл → строка → что делает → трогаем ли»** в документ (≤ 80 строк). Отдельно: все тесты, читающие эти таблицы (`rg -l goods_transactions backend/*.test.js`).

- [ ] **Step 3: Коммит**
```bash
git add docs/2026-11-13-stock-integration-points.md && git commit -m "docs(stock): карта точек интеграции склада"
```

**Чек-лист Opus:** документ без выдумок (каждая строка — реальный `file:line`), есть список тестов-стражей.

---

### Task 1: Живые пробы API склада YClients (read + write на тестовом товаре)

**Модель:** Codex GPT Astra. **Предусловие от владельца:** товар «ТЕСТ LoyalPro» заведён в YClients (категория Расходники → Основные товары, шт/шт, `unit_equals` 1, цена 1 ₽), разрешение на пробные операции 1 ₽ по клиенту 79200255591 с последующим удалением.

**Files:**
- Create: `backend/scripts/stock-api-probe.js`, `docs/2026-11-13-stock-api-live-probe.md`

- [ ] **Step 1: Скрипт проб** — `node scripts/stock-api-probe.js --good=<id> [--write]`; без `--write` только чтение. Использует `ycGet`/`axios` с заголовками `ycHeaders` из `services/journal/yclients.js` (там же — `YCLIENTS_INTEGRATION_USER_TOKEN`). Каждый шаг печатает `STEP <имя>: <статус HTTP> <ключи ответа>`, тела — в `/tmp/stock-api-probe/<step>.json`.

Чтение: `GET /storages/{cid}`; `GET /goods/{cid}/{good}` (`actual_amounts`, единицы); `GET /goods_categories/{cid}/0` и рекурсивно детей (глубина ≤ 4); `GET /storages/transactions/{cid}?changed_after=<вчераT00:00:00>&count=100`; `GET /technological_cards/record_consumables/{cid}/{record}/` для последней состоявшейся записи 79200255591.

Запись (`--write`), каждая — отдельная попытка с `try/catch`, результат фиксируется даже при 4xx:
1. `POST /storage_operations/operation/{cid}` тип 3 (приход +2, `cost_per_unit` 1, `operation_unit_type` 1, `comment '[LP#probe] приход'`) → ожидаем документ + транзакции с id.
2. тип 4 (списание −1, тот же маркер).
3. тип 1 (продажа −1, `client_id` = yclients_client_id 79200255591, `master_id` любой мастер, `cost` 1) → затем `POST /company/{cid}/sale/{document_id}/payment` `{payment:{method:{slug:'account', account_id:<касса>}, amount:1}}` (касса — из `journal/reference-cache` accounts) → `GET /company/{cid}/sale/{document_id}` → `DELETE …/payment/payment_transaction/{id}`. Если `/sale/{doc}` отвергает документ продажи — запасной путь `POST /finance_transactions/{cid}` `{expense_id, amount:1, account_id, client_id, document_id}` и его `DELETE`.
4. тип 5 (перемещение 1 шт Расходники → Космоцевтика) → ожидаем 403 (зафиксировать точный код и текст).
5. `PUT /goods/{cid}/{good}` (`comment: 'probe'`) → ожидаем 403; `POST /goods/{cid}` — НЕ выполнять (создало бы товар, который нельзя удалить без прав).
6. `PUT /technological_cards/record_consumables/consumables/{cid}/{record}/{service}/` на тестовой записи 79200255591: тот же состав, что вернул GET, плюс 1 шт тестового товара; затем вернуть прежний состав. Зафиксировать форму `consumables[]` и ответ.
7. Проверить, что вебхуки `goods_operations_*` на дев пришли (`webhook_logs` по `resource_id`) и как выглядит `data` для нашего документа (есть ли `comment` с маркером).
8. Уборка: `DELETE /storage_operations/documents/{cid}/{doc}` для всех созданных документов; повторный `GET /goods/{cid}/{good}` — `actual_amounts` вернулись к исходным.

- [ ] **Step 2: Отчёт** `docs/2026-11-13-stock-api-live-probe.md`: таблица шаг → код → вывод; ответы на вопросы спеки: (а) в каких единицах `actual_amounts`; (б) принимает ли `/sale/{doc}/payment` документ продажи товара; (в) точная форма `consumables[]`; (г) приходит ли наш `comment` в вебхуке и в `/storages/transactions`; (д) формат `create_date` в теле операции (`YYYY-MM-DD HH:MM:SS` принят?); (е) порядок транзакций в ответе = порядку в запросе?

- [ ] **Step 3: Коммит** скрипта и отчёта.

**Чек-лист Opus:** все созданные документы удалены (в отчёте — id и код DELETE); отчёт отвечает на (а)–(е) явно «да/нет/не проверено»; выводы, расходящиеся со спекой, перечислены отдельным списком «правки спеки» — Fable/владелец решают до задачи 5.

---

### Task 2: Миграции и чистая модель

**Модель:** Sonnet.

**Files:**
- Modify: `backend/migrations.js` (новый блок после `journal_record_prefs`)
- Create: `backend/services/stock/model.js`, `backend/stock-model.test.js`

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
    // «Ватные диски»: amount 0.1667 упаковки при unit_equals 120, cost_per_unit 16.35, cost 327 → 20 шт
    expect(m.toBase({ kind: 'consumable', qty: 0.1667, unitType: 2, unitEquals: 120, costPerUnit: 16.35, cost: 327 })).toBeCloseTo(-20, 1);
    expect(m.toBase({ kind: 'consumable', qty: 5, unitType: 2, unitEquals: 500, costPerUnit: 8.5, cost: 42.5 })).toBe(-5);
  });
  test('toBase без unit_equals при типе 1 — qty как есть и флаг', () => {
    expect(m.toBaseInfo({ kind: 'receipt', qty: 3, unitType: 1, unitEquals: null })).toEqual({ qtyBase: 3, unitUnknown: true });
  });
  test('fromBase раскладывает на ед. продажи и остаток', () => {
    expect(m.fromBase(1150, 500)).toEqual({ saleUnits: 2, remainderBase: 150 });
    expect(m.fromBase(-8.118 * 500, 500).saleUnits).toBe(-9); // отрицательные — вниз, как YClients показывает −8.118
    expect(m.fromBase(7, null)).toEqual({ saleUnits: 7, remainderBase: 0 });
  });
});

describe('validateDocument', () => {
  const ctx = { storages: [{ id: 1, forService: true }, { id: 2, forSale: true }], goods: new Map([[10, { stockActive: true, unitEquals: 1 }]]) };
  test('приход: ок', () => {
    const r = m.validateDocument({ kind: 'receipt', storageId: 1, docDate: '2026-11-13T10:00:00+03:00', lines: [{ goodRowId: 10, qty: 2, unitType: 1, costPerUnit: 100, discount: 0 }] }, ctx);
    expect(r.ok).toBe(true); expect(r.normalized.lines[0].cost).toBe(200);
  });
  test('перемещение на тот же склад — ошибка', () => {
    const r = m.validateDocument({ kind: 'move', storageId: 1, toStorageId: 1, docDate: '2026-11-13', lines: [{ goodRowId: 10, qty: 1, unitType: 1 }] }, ctx);
    expect(r.ok).toBe(false); expect(r.errors[0]).toMatch(/разные склады/);
  });
  test('пустые строки, qty ≤ 0, неактивный товар, скидка вне 0–100', () => {
    expect(m.validateDocument({ kind: 'writeoff', storageId: 1, docDate: '2026-11-13', lines: [] }, ctx).ok).toBe(false);
    expect(m.validateDocument({ kind: 'writeoff', storageId: 1, docDate: '2026-11-13', lines: [{ goodRowId: 10, qty: 0, unitType: 1 }] }, ctx).ok).toBe(false);
    expect(m.validateDocument({ kind: 'writeoff', storageId: 1, docDate: '2026-11-13', lines: [{ goodRowId: 99, qty: 1, unitType: 1 }] }, ctx).ok).toBe(false);
    expect(m.validateDocument({ kind: 'sale', storageId: 2, docDate: '2026-11-13', clientId: 5, lines: [{ goodRowId: 10, qty: 1, unitType: 1, costPerUnit: 100, discount: 120 }] }, ctx).ok).toBe(false);
  });
  test('склад не того назначения — предупреждение, не ошибка', () => {
    const r = m.validateDocument({ kind: 'sale', storageId: 1, docDate: '2026-11-13', clientId: 5, lines: [{ goodRowId: 10, qty: 1, unitType: 1, costPerUnit: 100, discount: 0 }] }, ctx);
    expect(r.ok).toBe(true); expect(r.warnings[0]).toMatch(/не для продаж/);
  });
});

describe('тело операции YClients', () => {
  test('buildOperationBody детерминировано, со знаком и маркером', () => {
    const doc = { id: 77, kind: 'writeoff', ycStorageId: 1334902, docDate: new Date('2026-11-13T07:00:00Z'), comment: 'подарок', masterStaffYcId: null };
    const lines = [{ ycGoodId: 20927782, qty: 2, unitType: 2, costPerUnit: 2.5, discount: 0, cost: 5 }];
    expect(m.buildOperationBody(doc, lines)).toEqual({
      type_id: 4, create_date: '2026-11-13 10:00:00', storage_id: 1334902, comment: '[LP#77] подарок',
      goods_transactions: [{ good_id: 20927782, amount: -2, cost_per_unit: 2.5, discount: 0, cost: 5, operation_unit_type: 2 }],
    });
  });
  test('продажа несёт client_id и master_id', () => {
    const b = m.buildOperationBody({ id: 1, kind: 'sale', ycStorageId: 2, docDate: new Date(), comment: '', masterStaffYcId: 4075416, ycClientId: 555 }, [{ ycGoodId: 1, qty: 1, unitType: 1, costPerUnit: 1, discount: 0, cost: 1 }]);
    expect(b.type_id).toBe(1); expect(b.master_id).toBe(4075416); expect(b.goods_transactions[0].client_id).toBe(555);
  });
  test('matchResponseTransactions — по порядку с проверкой good_id и amount', () => {
    const lines = [{ id: 1, ycGoodId: 5, qty: 2, unitType: 1, kind: 'receipt' }, { id: 2, ycGoodId: 6, qty: 1, unitType: 1, kind: 'receipt' }];
    expect(m.matchResponseTransactions(lines, [{ id: 900, good_id: 5, amount: '2' }, { id: 901, good_id: 6, amount: 1 }])).toEqual({ ok: true, pairs: [{ lineId: 1, ycTxnId: 900 }, { lineId: 2, ycTxnId: 901 }] });
    expect(m.matchResponseTransactions(lines, [{ id: 900, good_id: 5, amount: 2 }]).ok).toBe(false);
  });
});

describe('правило счёта остатка (§6.3)', () => {
  const opening = { takenAt: new Date('2026-11-14T00:00:00Z') };
  test('после снимка по дате операции — считается', () => expect(m.balanceCountsRow({ occurredAt: new Date('2026-11-15T00:00:00Z'), recordedAt: new Date('2026-11-15T00:00:00Z'), source: 'reconcile' }, opening)).toBe(true));
  test('задним числом через вебхук/наш документ — считается', () => expect(m.balanceCountsRow({ occurredAt: new Date('2026-11-01T00:00:00Z'), recordedAt: new Date('2026-11-15T00:00:00Z'), source: 'webhook' }, opening)).toBe(true));
  test('старая строка, пришедшая сверкой/догоном — нет', () => expect(m.balanceCountsRow({ occurredAt: new Date('2026-11-01T00:00:00Z'), recordedAt: new Date('2026-11-15T00:00:00Z'), source: 'backfill' }, opening)).toBe(false));
  test('без входящего остатка — всё считается', () => expect(m.balanceCountsRow({ occurredAt: new Date('2026-11-01T00:00:00Z'), recordedAt: new Date('2026-11-01T00:00:00Z'), source: 'backfill' }, null)).toBe(true));
});
```

- [ ] **Step 2: Запустить** `npx jest backend/stock-model --silent` → FAIL «Cannot find module './services/stock/model'».

- [ ] **Step 3: Модель** `backend/services/stock/model.js`:

```js
'use strict';
// Чистая модель склада (§8 спеки): без БД и сети.
const { writeoffQty } = require('../economics/price');

const KINDS = ['receipt', 'writeoff', 'sale', 'move', 'inventory', 'consumable', 'opening'];
const SYNC_STATUSES = ['local', 'queued', 'sending', 'sent', 'failed', 'uncertain', 'mirror'];
const YC_TYPE_BY_KIND = { sale: 1, consumable: 2, receipt: 3, writeoff: 4, move: 5 };
const KIND_BY_YC_TYPE = Object.fromEntries(Object.entries(YC_TYPE_BY_KIND).map(([k, v]) => [v, k]));
const SENDABLE_KINDS = new Set(['receipt', 'writeoff', 'sale', 'move', 'consumable']);
const INFLOW_KINDS = new Set(['receipt', 'opening']);
const MARKER_RE = /\[LP#(\d+)\]/;

const num = v => { if (v === null || v === undefined || v === '') return null; const n = Number(v); return Number.isFinite(n) ? n : null; };
const round4 = x => Math.round(x * 10000) / 10000;

function signFor(kind) { return INFLOW_KINDS.has(kind) ? 1 : -1; }
function kindByYcType(typeId) { return KIND_BY_YC_TYPE[Number(typeId)] || null; }

/** Количество в базовой единице (ед. списания), со знаком вида. Тип 2 — через общий writeoffQty. */
function toBaseInfo({ kind, qty, unitType, unitEquals, costPerUnit, cost }) {
  const q = Math.abs(Number(qty) || 0);
  const eq = num(unitEquals);
  const sign = signFor(kind);
  if (Number(unitType) === 2) {
    const base = writeoffQty({ amount: q, cost_per_unit: costPerUnit, cost }, eq);
    return { qtyBase: round4(sign * base), unitUnknown: false };
  }
  if (!(eq > 0)) return { qtyBase: round4(sign * q), unitUnknown: true };
  return { qtyBase: round4(sign * q * eq), unitUnknown: false };
}
function toBase(args) { return toBaseInfo(args).qtyBase; }

/** Обратно: сколько ед. продажи и остаток в базовых (для «2 шт + 150 мл»). */
function fromBase(qtyBase, unitEquals) {
  const b = Number(qtyBase) || 0; const eq = num(unitEquals);
  if (!(eq > 0) || eq === 1) return { saleUnits: round4(b), remainderBase: 0 };
  const saleUnits = Math.floor(b / eq);
  return { saleUnits, remainderBase: round4(b - saleUnits * eq) };
}

const MSK_PARTS = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Moscow', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
/** 'YYYY-MM-DD HH:MM:SS' по Москве — формат create_date документа YClients. */
function mskDateTime(d) { return MSK_PARTS.format(d instanceof Date ? d : new Date(d)).replace('T', ' '); }

/** Валидация тела документа из формы. ctx: {storages:[{id,forService,forSale}], goods: Map<rowId,{stockActive,unitEquals}>} */
function validateDocument(body, ctx) {
  const errors = []; const warnings = [];
  const b = body || {};
  if (!['receipt', 'writeoff', 'move', 'sale'].includes(b.kind)) errors.push('Неизвестный вид документа.');
  const storage = (ctx.storages || []).find(s => Number(s.id) === Number(b.storageId));
  if (!storage) errors.push('Склад не найден.');
  const docDate = b.docDate ? new Date(b.docDate) : null;
  if (!docDate || Number.isNaN(docDate.getTime())) errors.push('Дата документа некорректна.');
  if (b.kind === 'move') {
    const to = (ctx.storages || []).find(s => Number(s.id) === Number(b.toStorageId));
    if (!to) errors.push('Склад-получатель не найден.');
    else if (Number(to.id) === Number(storage && storage.id)) errors.push('Перемещение требует разные склады.');
  }
  if (b.kind === 'sale' && !(Number(b.clientId) > 0) && !b.phone) errors.push('Укажите клиента.');
  if (storage && b.kind === 'sale' && storage.forSale === false && storage.forService) warnings.push('Склад «не для продаж» — проверьте выбор.');
  if (storage && (b.kind === 'writeoff' || b.kind === 'receipt') && storage.forService === false && storage.forSale === false) warnings.push('У склада не задано назначение.');
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
    const cost = Math.round(qty * cpu * (1 - disc / 100) * 100) / 100;
    const { qtyBase, unitUnknown } = toBaseInfo({ kind: b.kind, qty, unitType, unitEquals: good.unitEquals, costPerUnit: cpu, cost });
    normLines.push({ goodRowId: Number(l.goodRowId), qty, unitType, costPerUnit: cpu, discount: disc, cost, qtyBase, unitUnknown, comment: typeof l.comment === 'string' ? l.comment.slice(0, 500) : null });
  });
  const total = normLines.reduce((s, l) => s + l.cost, 0);
  if (b.kind === 'sale' && errors.length === 0 && total <= 0 && b.gift !== true) errors.push('Итог продажи равен нулю — отметьте «подарок» или укажите цену.');
  return { ok: errors.length === 0, errors, warnings, normalized: { kind: b.kind, storageId: storage ? Number(storage.id) : null, toStorageId: b.kind === 'move' ? Number(b.toStorageId) : null, docDate, comment: typeof b.comment === 'string' ? b.comment.slice(0, 1000) : '', lines: normLines, totalCost: Math.round(total * 100) / 100 } };
}

/** Тело POST /storage_operations/operation/{cid}. doc: {id, kind, ycStorageId, docDate, comment, masterStaffYcId, ycClientId}. lines: [{ycGoodId, qty, unitType, costPerUnit, discount, cost}] */
function buildOperationBody(doc, lines) {
  const sign = signFor(doc.kind);
  const body = {
    type_id: YC_TYPE_BY_KIND[doc.kind], create_date: mskDateTime(doc.docDate), storage_id: Number(doc.ycStorageId),
    comment: `[LP#${doc.id}]${doc.comment ? ' ' + doc.comment : ''}`,
    goods_transactions: lines.map(l => ({
      good_id: Number(l.ycGoodId), amount: sign * Math.abs(Number(l.qty)), cost_per_unit: Number(l.costPerUnit) || 0,
      discount: Number(l.discount) || 0, cost: Number(l.cost) || 0, operation_unit_type: Number(l.unitType),
      ...(doc.kind === 'sale' && doc.ycClientId ? { client_id: Number(doc.ycClientId) } : {}),
      ...(doc.masterStaffYcId ? { master_id: Number(doc.masterStaffYcId) } : {}),
      ...(l.comment ? { comment: String(l.comment) } : {}),
    })),
  };
  if (doc.masterStaffYcId) body.master_id = Number(doc.masterStaffYcId);
  return body;
}

/** Тело PUT /technological_cards/record_consumables/consumables/{cid}/{record}/{service}/ (форма — по задаче 1). */
function buildConsumablesBody({ recordId, serviceYcId, ycStorageId }, lines) {
  return { consumables: lines.map(l => ({ ...(l.ycTxnId ? { goods_transaction_id: Number(l.ycTxnId) } : {}), record_id: Number(recordId), service_id: Number(serviceYcId), storage_id: Number(ycStorageId), good_id: Number(l.ycGoodId), price: Number(l.costPerUnit) || 0, amount: Math.abs(Number(l.qty)) })) };
}

/** Сопоставление транзакций ответа с нашими строками: по порядку + good_id + |amount|. */
function matchResponseTransactions(lines, txns) {
  const list = Array.isArray(txns) ? txns : [];
  if (list.length !== lines.length) return { ok: false, reason: 'count', pairs: [] };
  const pairs = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]; const t = list[i];
    if (Number(t.good_id) !== Number(l.ycGoodId) || Math.abs(Number(t.amount)) !== Math.abs(Number(l.qty))) return { ok: false, reason: 'mismatch', pairs: [] };
    pairs.push({ lineId: l.id, ycTxnId: Number(t.id) });
  }
  return { ok: true, pairs };
}

/** §6.3: считается ли строка в остаток при данном входящем остатке. */
function balanceCountsRow(row, opening) {
  if (!opening || !opening.takenAt) return true;
  const t = new Date(opening.takenAt).getTime();
  if (new Date(row.occurredAt).getTime() > t) return true;
  return new Date(row.recordedAt).getTime() > t && ['webhook', 'loyalpro', 'inventory'].includes(row.source);
}

function markerOf(comment) { const m = MARKER_RE.exec(String(comment || '')); return m ? Number(m[1]) : null; }

module.exports = { KINDS, SYNC_STATUSES, YC_TYPE_BY_KIND, SENDABLE_KINDS, signFor, kindByYcType, toBase, toBaseInfo, fromBase, mskDateTime, validateDocument, buildOperationBody, buildConsumablesBody, matchResponseTransactions, balanceCountsRow, markerOf, MARKER_RE };
```

- [ ] **Step 4: Прогнать** `npx jest backend/stock-model --silent` → PASS. Если `fromBase(-8.118*500)` даёт не −9 из-за плавающей точки — проверить `Math.floor(-4059/500) = -9`, тест верен.

- [ ] **Step 5: Миграции** — в `backend/migrations.js` после блока `journal_record_prefs` добавить блок `// ── STOCK (склад, 2026-11-13) ──` с DDL §5.1–5.3 спеки. Каждый `CREATE TABLE IF NOT EXISTS … .catch(() => {})`, индексы `CREATE INDEX IF NOT EXISTS`, частичные UNIQUE — `CREATE UNIQUE INDEX IF NOT EXISTS … WHERE …`. Колонки каталога — циклом `ALTER TABLE yclients_goods_catalog ADD COLUMN IF NOT EXISTS …` как в экономике (строка ~2306). `finance_operations`: `ALTER TABLE finance_operations ADD COLUMN IF NOT EXISTS stock_document_id BIGINT`. Полный список таблиц: `stock_storages, stock_units, stock_suppliers, stock_documents, stock_movements, stock_openings, stock_readings, stock_inventory_lines, stock_settings, stock_ingest_pending(salon_id, yclients_txn_id BIGINT, good_id BIGINT, raw JSONB, created_at, PRIMARY KEY(salon_id, yclients_txn_id))`. Индексы — из §5.1.

- [ ] **Step 6: Применить на деве и проверить** — `node -e "require('dotenv').config(); require('./migrations').runMigrations().then(()=>process.exit(0))"` (`runMigrations` — тот же экспорт, что зовёт `server.js`), затем `psql "$DATABASE_URL" -c "\d stock_movements"` — все колонки и индексы на месте. Приложить вывод к отчёту.

- [ ] **Step 7: Коммит** `feat(stock): миграции склада и чистая модель`.

**Чек-лист Opus:** тесты были красными до кода (вывод в отчёте); `toBaseInfo` зовёт `writeoffQty`, а не копирует правило; DDL только `IF NOT EXISTS`; `yclients_good_id` остался `NOT NULL`; названия колонок совпадают со спекой §5.1 (их читают задачи 4–7).

---

### Task 3: Справочники — склады, единицы, поставщики, категории, расширенный каталог

**Модель:** Sonnet.

**Files:**
- Create: `backend/services/stock/catalog-sync.js`, `backend/stock-catalog-sync.test.js`, `backend/services/stock/store.js` (часть: справочники), `backend/routes/stock.js` (часть: `/settings`, `/storages`, `/units`, `/suppliers`, `/categories/sync`)
- Modify: `backend/services/economics/sync.js` (`parseCatalogGood`), `backend/routes/index.js`, `backend/routes/webhook.js`

- [ ] **Step 1: Тесты (красные)** — `backend/stock-catalog-sync.test.js`: `parseStorage({id:1334902,title:'Расходники',for_service:1,for_sale:0,comment:'…',weight:2})` → `{ycStorageId, title, forService:true, forSale:false, comment, weight}`; `flattenCategoryTree(rootsWithChildren)` → строки `{id, title, parentId, path:[{id,title}…]}` в порядке обхода, глубина ≤ 4, циклы обрываются; `parseCatalogGood` (из `economics/sync`) теперь отдаёт `sale_price, barcode, unit_id, service_unit_id, critical_amount, desired_amount, comment, loyalty_abonement_type_id, loyalty_certificate_type_id, yc_last_change_date` (числа строками → числа, пустые → null); `unitsFromRows([txnRaw…, goodRow…])` собирает уникальные `{ycUnitId, title, shortTitle}`; `handleGoodEvent` с `status:'delete'` → `stock_active=false`, не удаление.

- [ ] **Step 2: Реализация.** `catalog-sync.js`: `syncStorages(salon)` (GET `/storages/{cid}` → апсерт `stock_storages`, пропавшие → `is_active=false`), `syncCategories(salon)` (BFS по `/goods_categories/{cid}/{parent}` от 0, пауза 400 мс, кап 200 запросов → `category_id_path`/`parent_category_id` у товаров по `category_id`; результат пишется в `stock_settings.categories_synced_at` — добавить колонку), `collectUnits(salonId)` (из `goods_transactions.raw->'unit'` и каталога), `handleGoodEvent(salon, payload)`. `store.js`: `listStorages/upsertStorage`, `listUnits/upsertUnit`, `listSuppliers/insertSupplier/updateSupplier/softDeleteSupplier`, `getSettings/saveSettings` (дефолты §5.1). Роуты — валидация полей вручную (title 1–255, inn ≤ 20 цифр, email по простому регэкспу), 400 с текстом. `PUT /settings` при `sendMoves`/`sendGoodsCrud`=true зовёт `GET /user/permissions/{cid}` и отвечает 409 `{error:'no_permission', right:'storages_move_goods_access'}`, если право `false`.

- [ ] **Step 3: Подключить** `app.use('/api/stock', require('./stock'))` в `routes/index.js` после `/api/finance`; в `routes/webhook.js` рядом с `goods_operations_*` — `if (resourceType === 'good') await stock.handleGoodEvent(salon, payload).catch(...)`.

- [ ] **Step 4: Живо** на деве: `node -e` вызвать `syncStorages` и `syncCategories` для salon 1 → в БД 2 склада, у товаров заполнен `category_id_path` (проверить «Препараты» → путь `Расходники > Препараты`). Вывод — в отчёт.

- [ ] **Step 5: Тесты** `npx jest backend/stock-catalog-sync economics --silent` → PASS (экономика не сломана расширением `parseCatalogGood`).

- [ ] **Step 6: Коммит** `feat(stock): склады, единицы, поставщики, дерево категорий`.

**Чек-лист Opus:** `parseCatalogGood` расширен, а не скопирован; `is_archived` не трогается; синк категорий не чаще 30 мин (проверка по `categories_synced_at`); права проверяются живым запросом при включении `send_*`.

---

### Task 4: Леджер — зеркало → движения, входящий остаток, остатки, расхождения

**Модель:** Codex GPT Astra.

**Files:**
- Create: `backend/services/stock/ledger.js`, `backend/stock-ledger.test.js`, `backend/scripts/stock-opening.js`, `backend/scripts/stock-explain.js`
- Modify: `backend/services/stock/store.js` (движения, остатки, показания), `backend/services/economics/store.js` (хук), `backend/services/economics/sync.js` (`runNightly` → `stock.nightly`)

- [ ] **Step 1: Тесты (красные)** `backend/stock-ledger.test.js` с моками `store` (`jest.mock('./services/stock/store')`):
  - `ingestMirrored`: строка type 2 с `record_id`, `service`, `unit_type 2`, товар известен → `upsertMirrorDocument` с `kind:'consumable', origin:'yclients', sync_status:'mirror', yclients_document_id`, затем `upsertMovement` с `qty_base` через `toBase`, `source` из opts, `yclients_txn_id`; товар неизвестен → `addIngestPending` + нет `upsertMovement`; `status:'delete'` → `markMovementDeleted(ycTxnId, at)`; строка с `yclients_txn_id`, уже принадлежащая документу `origin='loyalpro'` (`findMovementByTxn` вернул `{documentOrigin:'loyalpro'}`) → только `updateMovementPrices`, документ не переключается.
  - `balances`: SQL-строка `BALANCES_SQL` экспортируется и содержит `stock_openings`, `recorded_at`, `occurred_at`, список источников `('webhook','loyalpro','inventory')` — тест сверяет текст с `model.balanceCountsRow` через фикстуру из 4 строк, прогнанную обеими реализациями (JS и «ручной» перенос правила) → одинаковый результат. (Живое совпадение SQL и JS проверяет `stock-explain.js` — он гоняет обе.)
  - `discrepancies(readings, balances)` — чистая: `|diff| ≥ 0.5` → в список, отсортировано по `|diff|` убыв.
  - `openingFromCatalog(goodRow)` → по каждому `stock[]` элементу `{storageYcId, qtyBase = amount × unit_equals}`; `unit_equals` null → `qtyBase = amount` + флаг.

- [ ] **Step 2: Реализация `ledger.js`**:

```js
'use strict';
const m = require('./model');
const store = require('./store');
const { createLogger } = require('../../logger');
const logger = createLogger('StockLedger');

/** Зеркало YClients → леджер. row — результат economics/goods-events.parseTransaction; opts {status, source}. */
async function ingestMirrored(salonId, row, opts) {
  const kind = m.kindByYcType(row.type_id);
  if (!kind) return { skipped: 'type' };
  if (opts.status === 'delete') { await store.markMovementDeleted(salonId, row.yclients_txn_id, opts.deletedAt || new Date()); return { deleted: true }; }
  const good = await store.goodByYcId(salonId, row.good_id);
  if (!good) { await store.addIngestPending(salonId, row); logger.warn(`salon=${salonId}: товар ${row.good_id} неизвестен каталогу — строка ${row.yclients_txn_id} отложена`); return { pending: true }; }
  const storage = await store.ensureStorage(salonId, row.storage_id, row.raw && row.raw.storage && row.raw.storage.title);
  const existing = await store.findMovementByTxn(salonId, row.yclients_txn_id);
  const { qtyBase, unitUnknown } = m.toBaseInfo({ kind, qty: row.amount, unitType: row.operation_unit_type, unitEquals: good.unit_equals, costPerUnit: row.cost_per_unit, cost: row.cost });
  if (existing && existing.documentOrigin === 'loyalpro') {
    await store.updateMovementPrices(salonId, existing.id, { costPerUnit: row.cost_per_unit, discount: row.discount, cost: row.cost, occurredAt: row.create_date });
    return { linkedOurs: true };
  }
  const clientId = row.raw && row.raw.client && row.raw.client.id ? await store.clientIdByYc(salonId, Number(row.raw.client.id)) : null;
  const doc = await store.upsertMirrorDocument(salonId, { kind, ycDocumentId: row.document_id, storageId: storage.id, docDate: row.create_date, recordId: row.record_id, masterStaffYcId: row.master_id, clientId, ycClientId: row.raw && row.raw.client ? Number(row.raw.client.id) || null : null, comment: row.raw && row.raw.comment });
  await store.upsertMovement(salonId, { documentId: doc.id, goodRowId: good.id, storageId: storage.id, qty: row.amount, unitType: row.operation_unit_type, qtyBase, costPerUnit: row.cost_per_unit, discount: row.discount, cost: row.cost, recordId: row.record_id, serviceYcId: row.service_id, masterStaffYcId: row.master_id, ycTxnId: row.yclients_txn_id, source: opts.source, occurredAt: row.create_date, comment: unitUnknown ? 'unit_unknown' : null });
  return { ingested: true };
}
module.exports = { ingestMirrored, /* balances, discrepancies, openingFromCatalog, linkResponse — ниже в задаче */ };
```
`store.upsertMovement` — `INSERT … ON CONFLICT (salon_id, yclients_txn_id) WHERE yclients_txn_id IS NOT NULL DO UPDATE SET qty, unit_type, qty_base, cost_per_unit, discount, cost, occurred_at, deleted_at = NULL` — `recorded_at` НЕ обновляется (правило счёта). `store.BALANCES_SQL`:
```sql
WITH op AS (SELECT good_row_id, storage_id, qty_base, taken_at FROM stock_openings WHERE salon_id = $1),
mv AS (
  SELECT mv.good_row_id, mv.storage_id, SUM(mv.qty_base) AS moved
  FROM stock_movements mv
  LEFT JOIN op ON op.good_row_id = mv.good_row_id AND op.storage_id = mv.storage_id
  WHERE mv.salon_id = $1 AND mv.deleted_at IS NULL
    AND (op.taken_at IS NULL OR mv.occurred_at > op.taken_at
         OR (mv.recorded_at > op.taken_at AND mv.source IN ('webhook','loyalpro','inventory')))
  GROUP BY mv.good_row_id, mv.storage_id)
SELECT g.id AS good_row_id, s.id AS storage_id, COALESCE(op.qty_base,0) + COALESCE(mv.moved,0) AS qty_base, op.taken_at
FROM yclients_goods_catalog g
CROSS JOIN stock_storages s
LEFT JOIN op ON op.good_row_id = g.id AND op.storage_id = s.id
LEFT JOIN mv ON mv.good_row_id = g.id AND mv.storage_id = s.id
WHERE g.salon_id = $1 AND s.salon_id = $1 AND s.is_active AND (op.good_row_id IS NOT NULL OR mv.good_row_id IS NOT NULL)
```
Хук в `economics/store.upsertGoodsTransaction` (после `db.query(sql, params)`): `await safely('stock ingest', () => require('../stock/ledger').ingestMirrored(salonId, row, { status, source, deletedAt }))` — `safely` вынести в `backend/utils/safely.js` из `finance-ops.js` (или импортировать оттуда; одна копия). Экспортировать `stockDisabled = config.STOCK_LEDGER === 'false'` → хук не зовётся.

- [ ] **Step 3: Скрипты.** `stock-opening.js --salon=1 [--write]`: `syncGoodsCatalog` (свежие `actual_amounts`) → по каждому товару `openingFromCatalog` → печать таблицы (товар, склад, остаток в ед. продажи и базовых) и ИТОГО; `--write` — в одной транзакции `INSERT stock_openings`, движение `kind opening` для истории (документ `origin loyalpro, sync_status local, status posted`), `stock_settings.enabled=TRUE`; отказывается, если `enabled` уже TRUE (повтор — только «принять показание» по товару). `stock-explain.js`: `EXPLAIN (ANALYZE, BUFFERS)` для `BALANCES_SQL`, `DISCREPANCIES_SQL`, `LEASE_SQL` (появится в задаче 5 — скрипт расширяется там) с реальными `$1`; плюс сверка: JS `balanceCountsRow` по 200 случайным строкам `stock_movements` против SQL-флага — расхождение = exit 1.

- [ ] **Step 4: Живо на деве** (pm2 `loyalpro` можно не останавливать — только чтение+запись в наши таблицы): `node scripts/stock-opening.js --salon=1` (сухо) → разумные цифры (у «Расходников» LIP мыло ≈ −8 шт); затем `--write`; `node scripts/stock-explain.js` → `BALANCES` < 50 мс на дев-данных, инвариант JS=SQL зелёный. Запустить `node -e` разовую «переливку» всех `goods_transactions` в леджер через `ingestMirrored(…, {status:'update', source:'backfill'})` (скрипт `scripts/stock-backfill-mirror.js --salon=1 --write`, тот же файл задачи) → `SELECT count(*) FROM stock_movements` ≈ 9 400; остатки до/после переливки НЕ меняются (строки `backfill` старше `taken_at` не считаются) — это и есть проверка правила §6.3.

- [ ] **Step 5: Тесты** `npx jest backend/stock-ledger economics --silent` → PASS.

- [ ] **Step 6: Коммит** `feat(stock): леджер движений, входящий остаток, остатки и расхождения`.

**Чек-лист Opus:** `recorded_at` не перезаписывается апсертом; хук через `safely` и выключается `STOCK_LEDGER=false`; EXPLAIN приложен; переливка не изменила остатки; PII из `raw.client` в таблицы не попало (только id).

---

### Task 5: Документы и воркер отправки в YClients

**Модель:** Codex GPT Astra. **Зависит от:** отчёта задачи 1 (формат `create_date`, порядок транзакций, маркер в вебхуке).

**Files:**
- Create: `backend/services/yclients-write-errors.js`, `backend/yclients-write-errors.test.js`, `backend/services/stock/documents.js`, `backend/stock-documents.test.js`, `backend/services/stock/outbox-worker.js`, `backend/stock-outbox-worker.test.js`, `backend/services/stock/index.js`
- Modify: `backend/services/journal/outbox-worker.js` (импорт `classify`), `backend/server.js`, `backend/config.js`, `backend/scripts/stock-explain.js` (`LEASE_SQL`)

- [ ] **Step 1: Общая классификация ошибок** — вынести `classify`/`describe`/`statusOf`/`KEY_REUSED` из `journal/outbox-worker.js` в `services/yclients-write-errors.js` с расширением: `classify(e)` → `'uncertain' | 'retry' | 'fail' | 'no_permission'` (`status === 403` → `no_permission`), параметр `isDomainError` (для журнала — `m.isJournal`). Тест: все прежние случаи журнала + 403. Журнал импортирует и остаётся зелёным (`npx jest backend/journal-outbox-worker --silent`).

- [ ] **Step 2: Тесты документов (красные)** `stock-documents.test.js` (моки `store`): `create(salonId, userId, body)` → `validateDocument` (ошибки → `StockError` 400 с `errors[]`), транзакция: документ `status posted`, `sync_status` = `queued` если `settings.auto_send && SENDABLE_KINDS.has(kind) && kindAllowed(kind, settings)` иначе `local`; `move` при `send_moves=false` → `local`; движения через `store.insertMovements` (для `move` — две строки на каждую позицию: − на `storage_id`, + на `to_storage_id`, обе `source 'loyalpro'`); `cancel(id)`: `posted` → `cancelled`, движения `deleted_at`, если `yclients_document_id` — ставится шаг `delete_remote` (`sync_status queued`, `draft_json` с `{action:'delete'}`); `release({ids|from,to})` → `local → queued` только у `SENDABLE_KINDS` и разрешённых настройками; `resend(id)` только для `failed|uncertain`: копия документа с новым id (новый маркер), старый `cancelled` без удаления в YClients.

- [ ] **Step 3: Тесты воркера (красные)** `stock-outbox-worker.test.js` (моки `store`, `axios`/`yc`):
  - аренда: `LEASE_SQL` экспортируется, берёт `sync_status='queued' AND (next_attempt_at IS NULL OR next_attempt_at <= NOW())`, `FOR UPDATE SKIP LOCKED`, `LIMIT 5`, не больше одного документа на салон за тик (вторичный фильтр в JS);
  - `processDocument`: без `draft_json` → `buildOperationBody` → `storeDraft` (строка) ДО вызова; с `draft_json` — тело из него байт-в-байт; успех → `yclients_document_id`, `matchResponseTransactions` → `ledger.linkResponse(pairs)` → `sent`; `ok:false` при сопоставлении → `sent` + `error_code 'uncertain_match'` + WARN (документ в YClients есть);
  - `linkResponse`: зеркальная строка с тем же `yclients_txn_id` уже есть (эхо обогнало) → перенос её на наш документ (UPDATE `document_id`, `source='loyalpro'`), пустой зеркальный документ → `cancelled`;
  - ошибки: `retry` → `attempts+1`, `next_attempt_at` по лестнице `[5, 30, 120, 600, 600, 600]` с, 7-я → `failed`; `fail` → `failed` с кодом; `no_permission` → `failed:no_permission`; `uncertain` (таймаут после отправки) → `uncertain` и `uncertain_since`;
  - сверка `uncertain`: `GET /storages/transactions?changed_after=<uncertain_since − 10 мин>` → строка с `comment` содержащим `[LP#id]` → связка и `sent`; не нашли и прошло > 30 мин → остаётся `uncertain`, лог раз в час;
  - `delete_remote`: `DELETE /storage_operations/documents/{cid}/{doc}` → `sent`; 404 → `sent`;
  - пауза 2 с между документами, ≤ 5 за тик, `withRateLimitRetry` на 429.

- [ ] **Step 4: Реализация.** `documents.js` и `outbox-worker.js` по тестам; скелет воркера:

```js
'use strict';
const axios = require('axios');
const config = require('../../config');
const { db } = require('../../db');
const store = require('./store');
const ledger = require('./ledger');
const m = require('./model');
const { classify, describe } = require('../yclients-write-errors');
const { withRateLimitRetry } = require('../yclients-retry');
const { ycHeaders } = require('../journal/yclients'); // экспортировать из журнала, если ещё не экспортирован
const logger = require('../../logger').createLogger('StockOutbox');

const TICK_MS = 5000, BATCH = 5, GAP_MS = 2000, BACKOFF_S = [5, 30, 120, 600, 600, 600], UNCERTAIN_GRACE_MIN = 10, UNCERTAIN_GIVEUP_MIN = 30;
let inFlight = false, timer = null;

function authSalon(salon) { return config.YCLIENTS_INTEGRATION_USER_TOKEN ? { ...salon, yclients_user_token: config.YCLIENTS_INTEGRATION_USER_TOKEN } : salon; }
async function ycWrite(salon, method, path, data) {
  const r = await axios({ method, url: `${config.YC}${path}`, headers: ycHeaders(authSalon(salon)), timeout: 30000, ...(data ? { data } : {}) });
  if (!r.data || r.data.success === false) { const e = new Error('upstream_write_failed'); e.response = { status: 422, data: r.data }; throw e; }
  return r.data.data !== undefined ? r.data.data : r.data;
}

async function processDocument(row) {
  const salon = await store.salonOf(row.salon_id); const cid = salon.yclients_company_id;
  let draft = typeof row.draft_json === 'string' ? JSON.parse(row.draft_json) : null;
  try {
    if (draft && draft.action === 'delete') {
      try { await withRateLimitRetry(() => ycWrite(salon, 'delete', `/storage_operations/documents/${cid}/${row.yclients_document_id}`)); }
      catch (e) { if ((e.response && e.response.status) !== 404) throw e; }
      return store.markSent(row.id, { ycDocumentId: row.yclients_document_id });
    }
    const lines = await store.linesForSend(row.id);          // [{id, ycGoodId, qty, unitType, costPerUnit, discount, cost, comment}]
    if (!draft) { draft = m.buildOperationBody({ id: row.id, kind: row.kind, ycStorageId: row.yc_storage_id, docDate: row.doc_date, comment: row.comment, masterStaffYcId: row.master_staff_yc_id, ycClientId: row.yclients_client_id }, lines); await store.storeDraft(row.id, JSON.stringify(draft)); }
    await store.markSending(row.id);
    const res = await withRateLimitRetry(() => ycWrite(salon, 'post', `/storage_operations/operation/${cid}`, draft));
    const ycDocumentId = Number(res && (res.document ? res.document.id : res.id));
    const txns = res && (res.goods_transactions || (res.document && res.document.goods_transactions)) || [];
    const match = m.matchResponseTransactions(lines, txns);
    if (match.ok) await ledger.linkResponse(row.salon_id, row.id, match.pairs);
    else logger.warn(`stock doc ${row.id}: транзакции ответа не сопоставлены (${match.reason}) — связка сверкой по маркеру`);
    return store.markSent(row.id, { ycDocumentId, errorCode: match.ok ? null : 'uncertain_match' });
  } catch (e) {
    const cls = classify(e);
    logger.warn(`stock doc ${row.id} salon ${row.salon_id}: ${cls} ${describe(e)}`);
    if (cls === 'uncertain') return store.markUncertain(row.id, describe(e));
    if (cls === 'retry' && row.attempts + 1 < BACKOFF_S.length + 1) return store.deferRetry(row.id, BACKOFF_S[Math.min(row.attempts, BACKOFF_S.length - 1)], describe(e));
    return store.markFailed(row.id, cls === 'no_permission' ? 'no_permission' : 'rejected', describe(e));
  }
}
// tick(): аренда LEASE_SQL → по одному документу на салон → processDocument → sleep(GAP_MS); затем reconcileUncertain() для строк uncertain_since старше UNCERTAIN_GRACE_MIN.
// start()/stop()/kick() — как journal/outbox-worker.js; start только при config.STOCK_OUTBOX !== 'false' и наличии YCLIENTS_INTEGRATION_USER_TOKEN.
```
`server.js`: после старта воркера журнала — `if (config.STOCK_OUTBOX !== 'false') require('./services/stock/outbox-worker').start()`; `config.js`: `STOCK_OUTBOX`, `STOCK_LEDGER` из env.

- [ ] **Step 5: Живо на деве** — `pm2 stop loyalpro` → `scripts/stock-e2e.js` (создаётся здесь в первой версии: приход +2 тестового товара → ждём `sent`, проверяем `yclients_document_id`, `yclients_txn_id` у строк; имитируем эхо, вызвав `ingestMirrored` строкой из `GET /storages/transactions` — дубля в `stock_movements` нет; отмена → `DELETE` → `sent`; `actual_amounts` вернулся) → `PORT=3001 pm2 restart loyalpro`. Расширить `stock-explain.js` на `LEASE_SQL`.

- [ ] **Step 6: Тесты** `npx jest backend/stock backend/journal-outbox-worker yclients-write-errors --silent` → PASS.

- [ ] **Step 7: Коммит** `feat(stock): документы склада и отправка в YClients очередью`.

**Чек-лист Opus:** черновик хранится строкой ДО `markSending`; после реальной отправки ни один путь не возвращает документ в `queued`; `uncertain` не повторяется автоматически; 403 → `no_permission`; журнал зелёный после выноса `classify`; e2e удалил свои документы (id и коды в отчёте).

---

### Task 6: Продажа клиенту с оплатой и финансы

**Модель:** Codex GPT Astra. **Зависит от:** отчёта задачи 1 (п. б — путь оплаты документа продажи).

**Files:**
- Create: `backend/services/stock/sales.js`, `backend/stock-sales.test.js`
- Modify: `backend/services/finance-ops.js`, `backend/services/stock/outbox-worker.js` (шаг `payments[]`), `backend/services/journal/visit-history.js`

- [ ] **Step 1: Тесты (красные)**: `sales.create(salonId, userId, body)` — клиент по `clientId` или `phone` (поиск `clients` по суффиксу номера, как `resolveTestClient` напоминаний; нет в базе → `ycSearchClientIdByPhone` и строка клиента создаётся минимальной, как делает журнал при создании записи); документ `kind sale`, `sync_status queued` ВСЕГДА (приоритет `priority=1` в аренде — `ORDER BY priority DESC, created_at`), `payments[]` в `draft_json` → `{operation, payments:[{opId, method:'account'|'loyalty_card', methodId, amount, state:'pending'}]}`; воркер после `sent` выполняет оплаты по очереди `journal/yclients.pay(salon, ycDocumentId, {slug, account_id|loyalty_card_id}, amount)` (идемпотентность — повторная оплата того же `opId` не отправляется: `state` пишется в `draft_json` после каждой; падение между оплатой и записью — `uncertain_payment`, без повтора); каждая оплата → `finance-ops.recordStockSalePayment({salonId, stockDocumentId, opId, method, amount, clientId, ycClientId, occurredAt, status})`; `payment-options(clientId)` отдаёт способы и баланс бонусов тем же кодом, что `journal/payments-local.localOptions` (вынести общий `paymentMethods(salonId, card)` без зависимости от записи); `finance-ops`: эхо `revenue_operations` с `sold_item_id`, равным нашему `yclients_txn_id` (из `stock_movements`), связывается с нашей строкой (`stock_document_id`), не вставляется второй — тест на `linkRevenueToStockSale`.

- [ ] **Step 2: Реализация** по тестам. `recordStockSalePayment` пишет `kind='goods_sale', origin='loyalpro', method` (как `accountMethod` по кассе / `bonus`), `step_op_id = opId`, `stock_document_id`, `status` по состоянию (`sending|confirmed|failed`), `amount` положительная для оплаты. Бонусы — через `bonus-ledger.recompute` уже внутри `finance-ops` (ничего нового).

- [ ] **Step 3: `visit-history.js`**: покупки — `UNION` строк `finance_operations` (как сейчас) и документов `stock_documents kind='sale' origin='loyalpro'` без `finance_operations` (неотправленные/подарки), дедуп по `stock_document_id`.

- [ ] **Step 4: Живо** (расширение `stock-e2e.js`, `--sale`): продажа 1 шт тестового товара клиенту 79200255591 за 1 ₽ картой → `sent`, оплата `confirmed`, `finance_operations` одна строка `goods_sale`; дождаться вебхука `finances_operation` (≤ 60 с) — вторая строка НЕ появилась, у первой `revenue_operation_id` заполнен; затем удаление оплаты (`removePayment`) и документа.

- [ ] **Step 5: Тесты** `npx jest backend/stock finance --silent` → PASS. **Step 6: Коммит** `feat(stock): продажа клиенту с оплатой через кассу и бонусы`.

**Чек-лист Opus:** оплата идемпотентна по `opId`; при `uncertain_payment` нет автоповтора; `finance-ops` — единственный писатель; баланс бонусов читается тем же кодом, что в журнале (нет второй копии `localOptions`); PII нет в документе.

---

### Task 7: API чтения и отчётов `/api/stock`

**Модель:** Sonnet.

**Files:**
- Modify: `backend/routes/stock.js`, `backend/services/stock/store.js`
- Create: `backend/stock-routes.test.js` (как `reminders-routes.test.js`: чистые парсеры запроса без HTTP)

- [ ] **Step 1: Тесты (красные)**: `parseGoodsQuery(q)` (search ≤ 100 симв., `category` число, `storage` число, флаги `only_critical/only_diff/active` строго `'1'`); `parseDocsQuery(q)` (`kind ∈ KINDS`, `status`, `sync_status ∈ SYNC_STATUSES`, `from/to` календарные даты через `utils/period.js`, период ≤ 731 дня → иначе 400, `client`, `record` числа, `page/limit` ≤ 200); `parseTurnoverQuery`.

- [ ] **Step 2: Роуты** (§7 спеки, кроме уже сделанных в задачах 3/6 и тех, что в 8–11): `GET /goods` (каталог + остатки по складам из `BALANCES_SQL` + `stock_readings` + `critical_amount`), `GET /goods/:id` (поля; остатки; движения постранично `LIMIT 50 OFFSET`; приходы — `store.listReceipts` экономики; техкарты, где используется — `tech_cards.items @> '[{"good_id":N}]'`), `PUT /goods/:id/local` (`local_note ≤ 1000`, `local_sale_price ≥ 0|null`, `stock_active`, `critical_amount ≥ 0|null`), `GET /balances`, `GET /balances/discrepancies`, `POST /openings/accept` (owner), `GET /documents`, `GET /documents/:id` (строки с названиями товаров и единицами, `fromBase` для показа), `POST /documents`, `POST /documents/:id/cancel`, `POST /documents/send`, `GET /documents/unsent-count`, `POST /documents/:id/resend` (owner), `POST /sales`, `GET /sales/payment-options?clientId=`, `GET /clients/:clientId/purchases`, `GET /reports/turnover` (SQL: начало = остаток на `from` по правилу §6.3 с `occurred_at < from`, приход/расход за период по знаку, конец). Любая не-`StockError` → 502 `{error:'unavailable'}` (как журнал).

- [ ] **Step 3: EXPLAIN** добавить `TURNOVER_SQL` и `DOCS_LIST_SQL` в `stock-explain.js`; цель < 100 мс на дев-данных (9 400 движений).

- [ ] **Step 4: Тесты** `npx jest backend/stock --silent`; живая проверка `curl -H "Authorization: Bearer $TOKEN" localhost:3001/api/stock/goods?only_diff=1 | head -c 600` (токен — из таблицы `sessions`, память `dev_db_access_tunnel`). **Step 5: Коммит** `feat(stock): API остатков, товаров, документов и оборотки`.

**Чек-лист Opus:** все ручки под `requireRole('owner','admin')`, owner-only помечены; период капится; тексты YClients не утекают; SQL с `salon_id` везде.

---

### Task 8: Фронт — каркас страницы «Товары», вкладки «Остатки» и «Товары»

**Модель:** Sonnet.

**Files:**
- Create: `frontend/js/pages/stock.js`, `frontend/js/pages/stock-balances.js`, `frontend/css/stock.css`, `backend/stock-ui.test.js`
- Modify: `frontend/index.html` (меню ×2, `#page-stock`, `<script>`/`<link>` с `?v=`), `frontend/js/core/nav.js`

- [ ] **Step 1: Харнесс и тесты (красные)** `backend/stock-ui.test.js` — копия подхода `journal-ui.test.js`: `STOCK_FILES = ['stock.js','stock-balances.js','stock-docs.js','stock-sale.js','stock-inventory.js','stock-refs.js']` (файлы, которых ещё нет, создать пустыми с комментарием-заголовком в этой задаче, чтобы тест порядка `<script>` работал с первой задачи); тесты: нет дублей верхнеуровневых имён; `index.html` грузит все файлы после `#page-stock` с `?v=`; пункт меню `data-p="stock"` есть в ОБОИХ меню с `data-roles="owner,admin"`; `stockFmtQty(1150, 500, 'шт', 'мл')` → `'2 шт + 150 мл'`, `stockFmtQty(-4059, 500,'шт','мл')` → `'−9 шт + 441 мл'` (минус типографский), `stockFmtQty(7, 1, 'шт','шт')` → `'7 шт'`; `stockBalanceRows(goods, storages, {onlyCritical, onlyDiff})` — фильтры и сортировка по названию, у критических `cls:'crit'`, у расхождений `diff`; рендер экранирует названия (`<script>` → `&lt;script&gt;`).

- [ ] **Step 2: Разметка и навигация.** `index.html`: пункт `<div class="tn" data-p="stock" data-roles="owner,admin" …>Товары</div>` в группе «Управление» после «Услуги» — в десктопном и мобильном меню; `<div class="page" id="page-stock">` с шапкой `bc-head` («📦 Товары и склад», подзаголовок со счётчиками: критических, расхождений, неотправленных) и вкладками `stockTabBtn-<tab>` для `balances|goods|docs|suppliers|tech-cards|inventory|settings` (как `ecoTabBtn-*`), контейнеры `#stockTab-<tab>`. `nav.js`: заголовок `stock: 'Товары и склад'`, `if (p === 'stock') loadStock();`, deep-link `#stock/doc/<id>` и `#stock/good/<id>` через `window._deepLinkArg` (по образцу чата).

- [ ] **Step 3: `stock.js`** — `_stock` состояние (`tab`, фильтры, кэш справочников), `stockApi(method, path, body)` через общий `api()`, `loadStock()` (справочники + вкладка по умолчанию «Остатки» + разбор `_deepLinkArg`), `stockSwitchTab(tab)`, `stockLoadCounters()`. `stock-balances.js` — `stockFmtQty`, `stockBalanceRows`, `stockLoadBalances()`, `stockRenderBalances()`, фильтры (склад, категория, поиск, чекбоксы), кнопка «Принять показание YClients» (owner, `confirm`), вкладка «Товары» — список с поиском и деревом категорий (`category_id_path`), карточка товара модалкой `<dialog id="stockGoodModal">` (поля, остатки по складам, движения постранично, приходы, техкарты, локальные поля с сохранением `PUT /goods/:id/local`).

- [ ] **Step 4: CSS** `stock.css`: таблицы `.stock-tbl`, плашки статусов (те же классы цветов, что `journal.css` статусы отправки — скопировать имена, не правила: `.stock-pill.queued/.sending/.sent/.failed/.uncertain/.local`), критический остаток `.stock-crit`, расхождение `.stock-diff`, на ≤ 700px таблицы → карточки (`display:block` строк, `data-label` у ячеек).

- [ ] **Step 5: Тесты** `npx jest backend/stock-ui --silent` → PASS; визуально — открыть на деве `https://dev.zumrudin.ru/#stock`, обе темы, 390px (скриншоты — в отчёт, `scripts/stock-ui-e2e.js` появится в задаче 15). **Step 6: Коммит** `feat(stock): страница «Товары» — каркас, остатки, каталог`.

**Чек-лист Opus:** префиксы `stock`/`STOCK_` без исключений; экранирование через общий `esc`; `?v=` у всех новых скриптов; меню в обоих местах; роли совпадают с API.

---

### Task 9: Фронт — журнал операций и формы прихода/списания/перемещения/продажи

**Модель:** Sonnet.

**Files:**
- Modify: `frontend/js/pages/stock-docs.js`, `frontend/js/pages/stock-sale.js`, `frontend/css/stock.css`, `frontend/index.html` (`<dialog id="stockDocModal">`, `<dialog id="stockSaleModal">`), `backend/stock-ui.test.js`

- [ ] **Step 1: Тесты (красные)**: `stockDocStatusPill(doc)` → текст и класс по `sync_status` («Ждёт отправки», «Передаётся», «Отправлено в YClients», «Ошибка: нет прав» для `no_permission`, «Не подтверждено», «Только в LoyalPro», «Из YClients» для `mirror`); `stockLinesTotal(lines)` считает `cost` с скидкой в копейках; `stockDocFormDraft()` собирает тело `POST /documents` из полей (unitType по выбору «шт/мл» строки); `stockSaleDraft()` — `payments[]` с суммой ≤ итога, бонусы ≤ баланса (`payment-options`), ошибка при превышении; рендер списка экранирует комментарии.

- [ ] **Step 2: Реализация.** `stock-docs.js`: `stockLoadDocs()` с фильтрами (вид, статус отправки, период, склад, клиент), таблица (дата, вид, склад, строк, сумма, клиент/запись, статус-плашка, источник), карточка документа модалкой (строки с `stockFmtQty`, статус, ошибка кодом и подсказкой, кнопки «Отменить» / «Отправить заново» (owner, `confirm` с текстом о новом документе) / «Открыть запись» при `record_id`), кнопка «Отправить в YClients (N)» → `POST /documents/send` c периодом (как dispatch журнала), формы «Приход»/«Списание»/«Перемещение» в одном `<dialog>` с переключателем вида: склад(ы), поставщик (приход), дата (по умолчанию сейчас), строки `[поиск товара (datalist по `GET /goods?search=`), кол-во, единица (шт|мл по товару), цена, скидка, итог]`, «+ строка», предупреждения `warnings[]` сервера жёлтым, ошибки — списком. `stock-sale.js`: `stockSaleOpen({clientId, recordId, staffYcId})` — клиент (поиск `/api/clients?q=` как журнал, либо телефон), мастер (из `journal_reference_cache` staff через `/api/stock/dictionaries` — добавить ручку в задаче 7, если нет: `GET /dictionaries` → staff, storages, units), склад `for_sale` по умолчанию, строки с ценой `local_sale_price ?? sale_price`, блок оплаты (касса/бонусы, сумма, остаток) из `payment-options`, кнопка «Продать и оплатить» → `POST /sales`, после — опрос `GET /documents/:id` каждые 2 с до `sent|failed|uncertain` (как `journal` polling), итог плашкой.

- [ ] **Step 3: Тесты и визуальная проверка** на деве без отправки (воркер остановлен или `auto_send=false`; продажу — не нажимать, кроме тестового товара). **Step 4: Коммит** `feat(stock): журнал операций и формы документов`.

**Чек-лист Opus:** ни одна форма не отправляет без явной кнопки; «Отправить заново» — только owner и с подтверждением; суммы — в копейках (без `0.1+0.2`); экранирование.

---

### Task 10: Фронт — инвентаризация, поставщики, единицы, настройки, вкладка «Техкарты»

**Модель:** Sonnet.

**Files:**
- Modify: `frontend/js/pages/stock-inventory.js`, `frontend/js/pages/stock-refs.js`, `frontend/js/pages/economics.js` (`ecoLoadTechCards(containerId)`), `backend/stock-ui.test.js`, `backend/services/stock/documents.js` (инвентаризация), `backend/routes/stock.js` (`/inventories/*`), `backend/stock-documents.test.js`

- [ ] **Step 1: Бэкенд инвентаризации (тесты красные → код)**: `inventoryCreate(salonId, userId, {storageId, categoryId?})` → документ `kind inventory, status draft, sync_status local` + строки `stock_inventory_lines` с `expected_base` из `BALANCES_SQL` на момент создания; `inventorySetLines(id, [{goodRowId, counted, countedUnitType}])` → `counted_base` через `toBaseInfo` (вид `receipt`, чтобы знак +), `diff_base = counted_base − expected_base`; `inventoryPost(id)` → `status posted`, движение `source 'inventory'` на каждую строку с `diff_base ≠ 0` (`qty_base = diff_base`), `posted_at`; `inventoryAlign(id)` (owner) → два документа `writeoff` (|diff| недостач, `cost_per_unit` = `unitPriceAsOf`) и `receipt` (излишки), `comment 'по инвентаризации [LP#<id>]'`, `sync_status queued`; инвентаризация в `draft` старше 7 дней — предупреждение в списке.

- [ ] **Step 2: Фронт.** `stock-inventory.js`: список инвентаризаций, «Новая» (склад, категория), экран подсчёта — таблица товар / ожидается / подсчёт (поле + единица) / разница с автосохранением строк (`PUT /inventories/:id/lines` дебаунс 800 мс), «Провести» (`confirm`), «Выровнять YClients» (owner, второй `confirm` с суммой строк). `stock-refs.js`: поставщики (таблица + форма), единицы (таблица + «добавить локальную»), настройки (`auto_send`, склады по умолчанию, `send_moves`/`send_goods_crud` с показом ответа 409 «нет права <имя> — выдайте в YClients»). Вкладка «Техкарты»: `ecoLoadTechCards(containerId = 'ecoTechCards')` — заменить `document.getElementById('ecoTechCards')` на параметр; `stockSwitchTab('tech-cards')` → `ecoLoadTechCards('stockTechCards')`; период берётся из `_eco` (если не задан — текущий месяц: вызвать `ecoSetPreset('month')` без рендера периода экономики — выделить `ecoEnsurePeriod()`).

- [ ] **Step 3: Тесты** `npx jest backend/stock backend/stock-ui economics --silent` (экономика: `ecoLoadTechCards` без аргумента работает как прежде — тест в `economics`-наборе фронта, если есть; иначе ручная проверка вкладки «Экономика → Техкарты»). **Step 4: Коммит** `feat(stock): инвентаризация, поставщики, единицы, настройки, техкарты`.

**Чек-лист Opus:** проведение инвентаризации не создаёт движений для `diff=0`; выравнивание — только owner, два документа с маркером; `ecoLoadTechCards()` без аргумента не изменил поведение «Экономики».

---

### Task 11: Журнал записи — вкладки «Товары» и «Расходники»

**Модель:** Codex GPT Astra. **Зависит от:** отчёта задачи 1 (п. в — форма `consumables[]`).

**Files:**
- Create: `backend/services/stock/consumables.js`, `backend/stock-consumables.test.js`
- Modify: `backend/routes/stock.js` (`/records/:recordId/consumables`), `backend/services/stock/outbox-worker.js` (ветка `kind consumable`), `frontend/js/pages/journal-card.js`, `frontend/css/journal.css`, `backend/journal-ui.test.js`

- [ ] **Step 1: Тесты (красные)** `stock-consumables.test.js`: `expectedFor(serviceYcId, staffYcId, links, cards, priceFn)` → строки нормы `{goodRowId, qtyBase, unitPrice, cost}` по `pickTechCard` + `tech_cards.items` (`amount` × `amount` услуги в записи); `compare(expected, actual)` → по товару `{expected, actual, diff, flag: 'ok'|'over'|'missing'|'extra'}` (`over` при `actual > expected × 1.2`, как `overrun` экономики); `summary` — Σ cost факта и нормы; `buildUpdate(recordId, serviceYcId, storage, lines)` → `buildConsumablesBody`; для записи с `id < 0` (неотправленная) → `{expected, actual:[], note:'запись ещё не создана в YClients'}`.

- [ ] **Step 2: Реализация.** `consumables.js`: `forRecord(salonId, recordId)` — услуги записи из зеркала `records.raw_payload.services` (как `journal/index.detail`), факт — `stock_movements kind consumable` по `record_id` (+ `service_yc_id`), норма — по `service_tech_cards`/`tech_cards` через `economics/store` (повторно используя `pickTechCard` и `unitPriceAsOf`), цены — `price.unitPriceAsOf` с приходами `store.listReceipts`; `update(salonId, userId, recordId, serviceYcId, lines)` → документ `kind consumable, origin loyalpro, sync_status queued` с `draft_json = {action:'consumables', body: buildConsumablesBody(...)}`; воркер: ветка `action==='consumables'` → `PUT /technological_cards/record_consumables/consumables/{cid}/{record}/{service}/` → ответ (список транзакций) → `linkResponse`; старые строки факта по этой услуге, которых нет в ответе, → `deleted_at` (YClients заменяет состав). При 4xx (API отказал) — `failed:rejected`, фронт показывает «Изменить в YClients».

- [ ] **Step 3: Фронт карточки записи.** В `journal-card.js`: `jrStub('Товары','box','jr-tab-stub')` → живая вкладка `<button id="jrTabGoods">Товары</button>` в `jr-service-tabs`; переключение «Услуги/Товары» без перерисовки карточки (панели `#jrServicesPane`/`#jrGoodsPane`, как «Клиент/Чат»); панель «Товары»: продажи записи (`GET /api/stock/documents?record=<id>`), кнопка «Продать товар» → `stockSaleOpen({recordId, clientId: summary.clientId, staffYcId})` (диалог журнала в top layer — открывать `stockSaleModal` поверх через `showModal()` после `jrModal`; проверить z-order живьём). Плитка «Списание расходников» (заглушка) → живая, открывает панель «Расходники» в центре карточки: таблица по услугам (товар / норма / факт / разница / сумма), итог материалов визита, кнопка «Изменить» → редактор строк (кол-во в ед. списания) → `PUT /api/stock/records/:id/consumables/:serviceId` → плашка статуса отправки. У записи `id<0` — только норма и подсказка. Тесты в `journal-ui.test.js`: вкладка переключает панели без вызова `jrAppointmentCard`; строки экранируются.

- [ ] **Step 4: Живо** на деве: открыть карточку состоявшейся записи 79200255591 — факт списаний совпадает с `goods_transactions` type 2 этой записи; изменение расходников (+1 тестовый товар) → `sent` → в YClients `record_consumables` содержит строку → вернуть состав. **Step 5: Тесты** `npx jest backend/stock backend/journal-ui --silent`. **Step 6: Коммит** `feat(stock): расходники и продажи в карточке записи`.

**Чек-лист Opus:** норма считается общими `pickTechCard`/`unitPriceAsOf`; замена состава не оставляет «висячих» строк факта; несохранённые правки карточки живут при переключении вкладок; тестовая запись приведена в исходный состав.

---

### Task 12: Карточка пациента — покупки; «История посещений»

**Модель:** Sonnet.

**Files:**
- Modify: `frontend/js/pages/clients.js` (`openCD`), `frontend/js/pages/journal-visits.js` (покупки из леджера уже отдаёт бэкенд задачи 6 — проверить рендер статуса), тесты `backend/journal-visit-history.test.js`, фронт-тест клиентов (если есть — `backend/clients-ui.test.js`; иначе добавить минимальный `vm`-тест рендера блока)

- [ ] **Step 1: Тест (красный)**: `cdPurchasesHtml(rows)` рендерит дату, товары (экранировано), сумму, плашку статуса (`stockDocStatusPill` — функция из `stock-docs.js` доступна глобально; тест грузит оба файла), пусто → «Покупок нет».
- [ ] **Step 2: Реализация**: в `openCD(id)` после блока визитов — `GET /api/stock/clients/:id/purchases` (не блокирует карточку: отдельный `try/catch`, при ошибке — прочерк), блок «Покупки» с кликом → `navTo('stock'); location.hash = '#stock/doc/<id>'`.
- [ ] **Step 3: Тесты + живая проверка** на пациенте с продажей из зеркала (есть 260 продаж). **Step 4: Коммит** `feat(stock): покупки в карточке пациента`.

**Чек-лист Opus:** сбой ручки не ломает карточку пациента; `salon_id` в SQL покупок; экранирование.

---

### Task 13: Создание и правка товара (при наличии прав)

**Модель:** Sonnet. **Зависит от:** `send_goods_crud` (настройка задачи 3) и права владельца; код пишется сейчас, включается настройкой.

**Files:**
- Modify: `backend/routes/stock.js` (`POST /goods`, `PUT /goods/:id`), `backend/services/stock/catalog-sync.js` (`createGood`, `updateGood`), `frontend/js/pages/stock-balances.js` (форма товара), тесты `backend/stock-catalog-sync.test.js`, `backend/stock-ui.test.js`

- [ ] **Step 1: Тесты (красные)**: `parseGoodBody(b)` — `title` 1–500, `categoryId` число, `saleUnitId`/`serviceUnitId` из `stock_units` с `yclients_unit_id`, `unitEquals > 0`, `cost ≥ 0`, `actualCost ≥ 0`, `criticalAmount/desiredAmount ≥ 0`, `article/barcode ≤ 64`; `createGood` при `send_goods_crud=false` → `StockError 409 'crud_disabled'`; при 403 от YClients → 409 `no_permission`, товар НЕ создаётся локально; успех → апсерт каталога по ответу (`good_id`).
- [ ] **Step 2: Реализация**: `POST /goods/{cid}` синхронно (`axios` через `ycWrite` воркера — вынести `ycWrite` в `services/stock/yc-write.js`), `PUT /goods/{cid}/{id}` — только поля из формы; фронт — кнопка «+ Товар» видна при `settings.send_goods_crud`, иначе подсказка (§6.7); редактирование полей YClients в карточке товара — при включённой настройке, локальные поля — всегда.
- [ ] **Step 3: Тесты и коммит** `feat(stock): создание и правка товара в YClients при наличии прав`.

**Чек-лист Opus:** без права нет локального «полутовара»; подсказка пользователю называет право (`storages_goods_create_access`).

---

### Task 14: Ночной проход, сверка показаний, pending-товары, рычаги

**Модель:** Codex GPT Astra.

**Files:**
- Modify: `backend/services/stock/index.js` (`nightly(salon)`), `backend/services/economics/sync.js` (`runNightly` → после `syncGoodsCatalog`: `stock.nightly`), `backend/services/stock/ledger.js` (`readings`, `drainIngestPending`), `backend/services/stock/outbox-worker.js` (`recoverRunning` при старте: `sending` старше 15 мин → `uncertain`), тесты `backend/stock-ledger.test.js`, `backend/stock-outbox-worker.test.js`

- [ ] **Step 1: Тесты (красные)**: `nightly`: (а) `drainIngestPending` — строки, чей `good_id` теперь в каталоге, проходят `ingestMirrored` и удаляются из pending; (б) `readings` — по каждому товару `stock[]` × `unit_equals` → `stock_readings` с `our_qty_base` из `BALANCES_SQL`, `diff_base`; (в) `syncStorages`, `syncCategories` (если старше 30 мин); (г) `uncertain` старше 24 ч — WARN раз в сутки списком id; (д) `stock_documents.sync_status='sending'` старше 15 мин при старте → `uncertain` (процесс мог упасть между отправкой и записью).
- [ ] **Step 2: Реализация** + лог итогов одной строкой (`stock nightly salon=1: pending=0 readings=469 diffs=12 uncertain=0`). `economics.runNightly` зовёт `stock.nightly` в своём `try/catch`, результат — в `r.errors` при падении.
- [ ] **Step 3: Живо**: `node -e` вызвать `nightly` для salon 1 → `stock_readings` заполнена, расхождения разумны (товары с движением после снимка — ≈ 0; у «Ватных дисков» возможное расхождение — известная ошибка себестоимости YClients, не наша).
- [ ] **Step 4: Тесты, коммит** `feat(stock): ночная сверка показаний YClients и восстановление очереди`.

**Чек-лист Opus:** ночной проход внутри экономического (одна квота, один крон); ничего не правит остатки автоматически; `recoverRunning` не переотправляет.

---

### Task 15: Живые прогоны, документация, финальное ревью

**Модель:** Sonnet (скрипты, доки) → **Opus** (финальное ревью всей ветки, по файлам, с записью находок в `docs/2026-11-13-stock-review.md` ПО ХОДУ — не в конце; ревью одного прохода, без фоновых агентов).

**Files:**
- Create: `backend/scripts/stock-ui-e2e.js` (puppeteer: страница, вкладки, формы без отправки, карточка товара, две темы, 390px; скриншоты `/tmp/stock-*.png`), финальная версия `backend/scripts/stock-e2e.js` (`--receipt --writeoff --sale --consumables --cleanup`, отказ при online pm2), `docs/2026-11-13-stock-acceptance.md` (чек-лист приёмки владельцем: что нажать, что увидеть), `docs/2026-11-13-stock-review.md`
- Modify: `CLAUDE.md` — раздел «### Склад и товары («Управление → Товары», с 13.11.2026, дев)» ≤ 40 строк: таблицы, правило счёта остатка, маркер `[LP#id]`, права API, рычаги `STOCK_OUTBOX`/`STOCK_LEDGER`, команды тестов и скриптов, что не отправляется в YClients; память проекта — файл `stock_goods_module_2026_11_13.md` + строка в `MEMORY.md`.

- [ ] **Step 1: Полный прогон** `npx jest backend/stock economics backend/journal finance --silent` — все зелёные (известный флейк `primary-clients` — см. память `jest_full_run_flake_primary_clients`, не относится).
- [ ] **Step 2: `stock-e2e.js`** на деве с `pm2 stop loyalpro` → отчёт в `docs/2026-11-13-stock-acceptance.md` (id документов, коды, остатки до/после одинаковы) → `PORT=3001 pm2 restart loyalpro`.
- [ ] **Step 3: `stock-ui-e2e.js`** → скриншоты, приложить пути.
- [ ] **Step 4: Opus — финальное ревью**: по чек-листам всех задач + сквозные инварианты: (1) ни одного пути `sent/uncertain → queued`; (2) `recorded_at` неизменяем; (3) `safely` вокруг хука; (4) все SQL с `salon_id`; (5) нет второй копии `writeoffQty`/`unitPriceAsOf`/`pickTechCard`/`classify`/`localOptions`; (6) PII; (7) `?v=` бампы; (8) миграции аддитивны. Находки — в `docs/2026-11-13-stock-review.md` по мере обнаружения; критичные чинит Sonnet/Codex отдельными коммитами, Opus перепроверяет.
- [ ] **Step 5: CLAUDE.md и память**, коммит `docs(stock): раздел CLAUDE.md, приёмка, ревью`. Сообщить владельцу список решений §11 спеки, требующих подтверждения, и права, которые стоит выдать интеграционному пользователю.

---

## Самопроверка плана (выполнена при написании)

- **Покрытие спеки:** §5 → задача 2; §6.1/6.3 → 4, 14; §6.2 → 5; §6.4 → 6, 9, 12; §6.5 → 11; §6.6 → 10; §6.7 → 3, 13; §7 → 3, 6, 7, 10, 11; §9.1 → 8–10; §9.2 → 11; §9.3 → 12; §13 → 4, 5, 15; §1.3 (права) → 3, 5, 13.
- **Имена, общие между задачами:** `model.toBaseInfo/toBase/fromBase/validateDocument/buildOperationBody/buildConsumablesBody/matchResponseTransactions/balanceCountsRow/markerOf`; `store.BALANCES_SQL/LEASE_SQL/upsertMovement/findMovementByTxn/upsertMirrorDocument/storeDraft/markSending/markSent/markUncertain/markFailed/deferRetry/linesForSend`; `ledger.ingestMirrored/linkResponse`; `documents.create/cancel/release/resend/inventory*`; `sales.create`; `consumables.forRecord/update`; `yclients-write-errors.classify/describe`; фронт `stockApi/stockSwitchTab/stockFmtQty/stockBalanceRows/stockDocStatusPill/stockSaleOpen/stockLoadDocs`; `ecoLoadTechCards(containerId)`.
- **Зависимости от живых проб (задача 1):** задачи 5, 6, 11 начинать только после отчёта; расхождения с спекой решает Fable/владелец, план правится точечно.
- **Что не вошло (сознательно, §12 спеки):** сертификаты/абонементы, ККМ, Мила, переключение экономики на леджер, роли кассира.
