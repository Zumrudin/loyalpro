# Экономика процедур (себестоимость и маржинальность) — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Страница «💰 Экономика» для владельца: по каждой услуге за период — визиты, выручка, материалы (факт/норма), оплата врача, эквайринг, маржинальная прибыль, постоянные расходы, аппараты, операционная прибыль, прибыль/час; данные о материалах — из YClients (вебхуки товарных операций, техкарты, поступления), правила и бюджеты — в LoyalPro.

**Architecture:** Чистые модули расчёта в `backend/services/economics/` (разбор вебхука, цена «на дату», правила оплаты, распределение, расчёт строки «запись × услуга» и агрегация) без БД и HTTP, покрытые jest; IO-слой (`store.js` с экспортируемым SQL, `sync.js` для ночного прохода по YClients, `report.js` со склейкой и кэшем 60 с); роутер `/api/economics` только для владельца; фронт — страница с семью вкладками и чистым `economics-table.js` под `node --test`. Расчёт на лету по запросу, без материализации.

**Tech Stack:** Node.js/Express, PostgreSQL (`pg`, без ORM, миграции `IF NOT EXISTS`), YClients REST API (`ycGet`, `withRateLimitRetry`), node-cron (TZ Europe/Moscow), jest (`TZ=Europe/Moscow` через `jest.global-setup.js`), vanilla JS SPA + `node --test` в `vm`.

Спека: `docs/superpowers/specs/2026-10-18-procedure-economics-design.md`. Исследование: `docs/2026-10-18-procedure-margin-research.md`.

---

## Распределение задач по моделям

Цель — экономия токенов и лимитов: дорогая модель только там, где нужна связность многих правил или нетривиальный SQL/расчёт. **Haiku не использовать** — контекст проекта (CLAUDE.md) в неё не помещается («Prompt is too long»). Исполнение **по очереди, с отчётом в этой сессии, без фоновых агентов** (фоновое ревью 16.10 сгорело лимитом без отчёта).

| Уровень | Модель | Когда | Задачи |
|---|---|---|---|
| L1 | **Sonnet** | механика по готовому образцу: миграции, разбор payload'а с известными полями, CRUD-роуты по образцу `routes/reminders.js`, вкладки-таблицы с формами, скрипты-обвязки, документация | 1, 2, 3, 4, 5, 8, 9, 13, 14, 15, 17, 18, 19, 20, 21, 23 |
| L2 | **Opus** | много связанных правил или внешний API с лимитами: сверка/догон транзакций, техкарты и обучение привязок, SQL отчёта с живым EXPLAIN, склейка отчёта, вкладка «Услуги» с детализацией, предупреждения | 6, 7, 11, 12, 16, 22 |
| L3 | **Fable** (эта сессия) | ядро расчёта (3.1–3.7 спеки в одном модуле, тесты на числах прода) и два ревью-чекпоинта | 10, ревью после задачи 12 и после задачи 20 |

Ревью — ИНЛАЙН в этой сессии (`/code-review` по диффу этапа), не фоновым агентом.

## Порядок и этапы

Этап 1 «Данные и маржинальная прибыль» — задачи 1–18. Этап 2 «Полная себестоимость» — 19–20 (расчёт overhead уже заложен в задаче 10, этап добавляет справочники и UI). Этап 3 «Контроль» — 21–22. Документация — 23. Задачи внутри этапа идут строго по номерам: каждая следующая опирается на экспорты предыдущих.

## Карта файлов

Создать (backend):
- `backend/services/economics/goods-events.js` — чистый разбор вебхука `goods_operations_*` и строки `/storages/transactions` (одна функция на оба входа), вырезание PII.
- `backend/services/economics/price.js` — цена единицы «на дату»: последнее поступление → ручная → `unit_actual_cost` → 0.
- `backend/services/economics/pay-rules.js` — выбор правила оплаты по приоритету и периоду, расчёт оплаты врача.
- `backend/services/economics/allocation.js` — деление по весам, минуты между услугами, доли месяцев в периоде, ставки по драйверам, амортизация аппаратов.
- `backend/services/economics/tech-cards.js` — стоимость нормы по техкарте, подсказки совпадений по названию, разбор ответов YClients о техкартах.
- `backend/services/economics/calc.js` — строки «запись × услуга» (3.1–3.6), overhead, агрегация (3.7).
- `backend/services/economics/store.js` — SQL (экспортируется) и загрузчики/апсерты.
- `backend/services/economics/sync.js` — каталог, техкарты, сверка транзакций, обучение привязок, `runNightly`.
- `backend/services/economics/report.js` — склейка store → calc, кэш 60 с, детализация.
- `backend/services/economics/index.js` — фасад для `routes/webhook.js` и `server.js`.
- `backend/routes/economics.js` — `/api/economics`, owner.
- `backend/scripts/economics-backfill-goods.js`, `backend/scripts/economics-explain.js`, `backend/scripts/economics-sync-e2e.js`.
- Тесты (jest, в корне `backend/`): `economics-goods-events.test.js`, `economics-price.test.js`, `economics-pay-rules.test.js`, `economics-allocation.test.js`, `economics-tech-cards.test.js`, `economics-calc.test.js`, `economics-store.test.js`, `economics-sync.test.js`, `economics-report.test.js`, `economics-routes.test.js`, `economics-webhook.test.js`.

Создать (frontend):
- `frontend/js/pages/economics-table.js` — чистые помощники (формат, сортировка, итоги, колонки) + `economics-table.test.js` (`node --test`).
- `frontend/js/pages/economics.js` — страница: загрузка, вкладки, рендер, модалки.

Изменить:
- `backend/migrations.js` — таблицы раздела 5 спеки.
- `backend/routes/webhook.js` — вызов `economics.handleGoodsEvent` для `goods_operations_*`.
- `backend/routes/index.js` — монтирование `/api/economics`.
- `backend/server.js` — крон `5 5 * * *`.
- `backend/config.js` — `ECONOMICS_SYNC`.
- `frontend/index.html` — пункт меню (owner), `page-economics`, подключение скриптов.
- `frontend/js/core/nav.js` — `if (p === 'economics') loadEconomics();`.
- `frontend/css/features.css` — стили страницы.
- `CLAUDE.md` — раздел модуля.

## Соглашения, которые нельзя нарушать

- Все запросы — со `salon_id`. Миграции — только `CREATE TABLE IF NOT EXISTS` / `ADD COLUMN IF NOT EXISTS` / `CREATE INDEX IF NOT EXISTS`, с `.catch(() => {})`, как соседи.
- `db.one` === `db.oneOrNone` (возвращает `null`, не бросает) — проверять результат явно.
- Вебхук отвечает 200 ДО обработки; новый обработчик — в своём `try/catch`, не ломает начисления.
- Даты — московские: `visit_date` DATE, сравнения строками `'YYYY-MM-DD'`; в SQL `$N::date`.
- Деньги — `NUMERIC`, в JS округление до копеек только на выдаче (`round2`), промежуточные — без округления.
- `ycGet(salon, endpoint, params)` возвращает `data.data`; ошибки лимита — `withRateLimitRetry` из `services/yclients-retry.js`.
- Логгер: `const { createLogger } = require('../../logger'); const logger = createLogger('Economics');`.
- Тесты jest лежат в корне `backend/`, мокают `./db`, `./services/yclients`, `./logger` как в `yclients-reconcile.test.js`.
- Правка JS/CSS фронта — с бампом `?v=` в `index.html`.
- Коммиты — маленькие, после каждой задачи; сообщение на русском с префиксом `feat(economics):` / `test(economics):`.

---

## Этап 1. Данные и маржинальная прибыль

### Task 1: Миграции — таблицы модуля

**Модель: Sonnet (L1).**

**Files:**
- Modify: `backend/migrations.js` (добавить блок перед `module.exports`, после блока `dialog_verdicts`)

- [ ] **Step 1: Добавить блок миграций**

Вставить перед строкой `module.exports = { runMigrations };` (внутри `runMigrations`, в самом конце функции — найти последний `await client.query(` и дописать после него):

```js
  // ── Экономика процедур (спека docs/superpowers/specs/2026-10-18-procedure-economics-design.md, §5) ──
  // Товарные транзакции YClients: списания расходников (type_id 2), приходы (3),
  // продажи, списания-потери. delete ставит deleted_at, строка остаётся (форензика).
  // client.* из payload НЕ пишется (PII).
  await client.query(`
    CREATE TABLE IF NOT EXISTS goods_transactions (
      id                  BIGSERIAL PRIMARY KEY,
      salon_id            INT NOT NULL REFERENCES salons(id) ON DELETE CASCADE,
      yclients_txn_id     BIGINT NOT NULL,
      document_id         BIGINT,
      type_id             SMALLINT,
      type_title          VARCHAR(100),
      good_id             BIGINT,
      good_title          VARCHAR(500),
      storage_id          BIGINT,
      unit_title          VARCHAR(50),
      operation_unit_type SMALLINT,
      amount              NUMERIC(14,4) NOT NULL DEFAULT 0,
      cost_per_unit       NUMERIC(14,4),
      cost                NUMERIC(14,2),
      discount            NUMERIC(8,2),
      record_id           BIGINT,
      service_id          BIGINT,
      service_title       VARCHAR(500),
      master_id           BIGINT,
      supplier_title      VARCHAR(255),
      create_date         TIMESTAMPTZ,
      last_change_date    TIMESTAMPTZ,
      deleted_at          TIMESTAMPTZ,
      source              VARCHAR(16) NOT NULL DEFAULT 'webhook',
      raw                 JSONB,
      created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (salon_id, yclients_txn_id)
    )
  `).catch(() => {});
  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_goods_txn_record
      ON goods_transactions (salon_id, record_id) WHERE deleted_at IS NULL AND record_id IS NOT NULL
  `).catch(() => {});
  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_goods_txn_good_type_date
      ON goods_transactions (salon_id, good_id, type_id, create_date DESC) WHERE deleted_at IS NULL
  `).catch(() => {});
  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_goods_txn_salon_date
      ON goods_transactions (salon_id, create_date) WHERE deleted_at IS NULL
  `).catch(() => {});
  // Списания бонусов по записи читаются отчётом по (salon_id, record_id).
  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_lct_salon_record
      ON loyalty_card_transactions (salon_id, record_id) WHERE record_id IS NOT NULL
  `).catch(() => {});

  // Каталог товаров: единицы, себестоимость YClients, остатки, последняя закупка.
  for (const col of [
    'unit VARCHAR(50)', 'service_unit VARCHAR(50)', 'unit_equals NUMERIC(14,4)',
    'actual_cost NUMERIC(14,4)', 'unit_actual_cost NUMERIC(14,4)', 'stock JSONB',
    'last_receipt_price NUMERIC(14,4)', 'last_receipt_at TIMESTAMPTZ',
  ]) {
    await client.query(`ALTER TABLE yclients_goods_catalog ADD COLUMN IF NOT EXISTS ${col}`).catch(() => {});
  }

  await client.query(`
    CREATE TABLE IF NOT EXISTS goods_price_overrides (
      salon_id   INT NOT NULL REFERENCES salons(id) ON DELETE CASCADE,
      good_id    BIGINT NOT NULL,
      unit_price NUMERIC(14,4) NOT NULL,
      note       VARCHAR(500),
      updated_by INT,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (salon_id, good_id)
    )
  `).catch(() => {});

  // Техкарты: импорт YClients (yc_card_id) и нормы LoyalPro (source='manual', yc_card_id NULL).
  await client.query(`
    CREATE TABLE IF NOT EXISTS tech_cards (
      id         SERIAL PRIMARY KEY,
      salon_id   INT NOT NULL REFERENCES salons(id) ON DELETE CASCADE,
      yc_card_id BIGINT,
      title      VARCHAR(500) NOT NULL DEFAULT '',
      items      JSONB NOT NULL DEFAULT '[]',
      source     VARCHAR(16) NOT NULL DEFAULT 'yclients',
      synced_at  TIMESTAMPTZ,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `).catch(() => {});
  await client.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_tech_cards_yc
      ON tech_cards (salon_id, yc_card_id) WHERE yc_card_id IS NOT NULL
  `).catch(() => {});

  // Привязка техкарты к услуге (и, опционально, сотруднику). UNIQUE через COALESCE —
  // NULL в staff_yc_id иначе не участвует в UNIQUE и дубли «для всех» проходили бы.
  await client.query(`
    CREATE TABLE IF NOT EXISTS service_tech_cards (
      id            SERIAL PRIMARY KEY,
      salon_id      INT NOT NULL REFERENCES salons(id) ON DELETE CASCADE,
      service_yc_id BIGINT NOT NULL,
      staff_yc_id   BIGINT,
      tech_card_id  INT NOT NULL REFERENCES tech_cards(id) ON DELETE CASCADE,
      source        VARCHAR(16) NOT NULL DEFAULT 'learned',
      updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `).catch(() => {});
  await client.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_service_tech_cards
      ON service_tech_cards (salon_id, service_yc_id, COALESCE(staff_yc_id, 0))
  `).catch(() => {});

  await client.query(`
    CREATE TABLE IF NOT EXISTS staff_pay_rules (
      id              SERIAL PRIMARY KEY,
      salon_id        INT NOT NULL REFERENCES salons(id) ON DELETE CASCADE,
      staff_yc_id     BIGINT,
      service_yc_id   BIGINT,
      category_yc_id  BIGINT,
      percent         NUMERIC(6,2) NOT NULL DEFAULT 0,
      base            VARCHAR(20) NOT NULL DEFAULT 'gross',
      fixed_per_visit NUMERIC(12,2) NOT NULL DEFAULT 0,
      valid_from      DATE,
      valid_to        DATE,
      note            VARCHAR(500),
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `).catch(() => {});
  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_staff_pay_rules_salon ON staff_pay_rules (salon_id)
  `).catch(() => {});

  await client.query(`
    CREATE TABLE IF NOT EXISTS economics_settings (
      salon_id                  INT PRIMARY KEY REFERENCES salons(id) ON DELETE CASCADE,
      payroll_multiplier        NUMERIC(6,3) NOT NULL DEFAULT 1.30,
      pay_base_includes_bonuses BOOLEAN NOT NULL DEFAULT FALSE,
      allocation_driver         VARCHAR(16) NOT NULL DEFAULT 'minutes',
      usn_rate                  NUMERIC(5,2) NOT NULL DEFAULT 15,
      acquiring                 JSONB NOT NULL DEFAULT '{}',
      updated_at                TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `).catch(() => {});

  await client.query(`
    CREATE TABLE IF NOT EXISTS fixed_costs (
      id           SERIAL PRIMARY KEY,
      salon_id     INT NOT NULL REFERENCES salons(id) ON DELETE CASCADE,
      category     VARCHAR(64) NOT NULL,
      title        VARCHAR(255) NOT NULL DEFAULT '',
      amount_month NUMERIC(14,2) NOT NULL DEFAULT 0,
      month_from   DATE NOT NULL,
      month_to     DATE,
      note         VARCHAR(500),
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `).catch(() => {});
  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_fixed_costs_salon_month ON fixed_costs (salon_id, month_from)
  `).catch(() => {});

  await client.query(`
    CREATE TABLE IF NOT EXISTS equipment (
      id                  SERIAL PRIMARY KEY,
      salon_id            INT NOT NULL REFERENCES salons(id) ON DELETE CASCADE,
      name                VARCHAR(255) NOT NULL,
      purchase_price      NUMERIC(14,2) NOT NULL DEFAULT 0,
      purchase_date       DATE,
      useful_life_months  INT NOT NULL DEFAULT 60,
      residual_pct        NUMERIC(5,2) NOT NULL DEFAULT 0,
      maintenance_monthly NUMERIC(12,2) NOT NULL DEFAULT 0,
      service_ids         JSONB NOT NULL DEFAULT '[]',
      is_active           BOOLEAN NOT NULL DEFAULT TRUE,
      note                VARCHAR(500),
      created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `).catch(() => {});
```

- [ ] **Step 2: Перезапустить дев и проверить, что таблицы появились**

Run: `cd /root/loyalpro/backend && PORT=3001 pm2 restart loyalpro && sleep 5 && pm2 logs loyalpro --lines 20 --nostream | grep -i "migrat\|error" | head`
Expected: строка об успешных миграциях, без `ERROR`.

Проверить через `mcp__postgres__query`:
```sql
SELECT table_name FROM information_schema.tables
WHERE table_name IN ('goods_transactions','goods_price_overrides','tech_cards','service_tech_cards','staff_pay_rules','economics_settings','fixed_costs','equipment') ORDER BY 1;
SELECT column_name FROM information_schema.columns WHERE table_name='yclients_goods_catalog' AND column_name IN ('unit','service_unit','unit_equals','actual_cost','unit_actual_cost','stock','last_receipt_price','last_receipt_at');
```
Expected: 8 таблиц, 8 колонок (миграции глотают ошибки — проверка обязательна).

- [ ] **Step 3: Commit**

```bash
cd /root/loyalpro && git add backend/migrations.js && git commit -m "feat(economics): таблицы модуля экономики процедур (goods_transactions, tech_cards, pay rules, settings, fixed_costs, equipment)"
```

---

### Task 2: `goods-events.js` — чистый разбор товарной операции

**Модель: Sonnet (L1).**

Один разбор на два входа: `payload.data` вебхука `goods_operations_*` и строка `GET /storages/transactions`. Поля совпадают (проверено по 11 737 вебхукам и примеру API): `id, document_id, type_id, type, operation_unit_type, amount, cost_per_unit, cost, discount, good{id,title}, storage{id,title}, unit{id,title,short_title}, record_id (0 = нет), service ({id,title} | []), master ({id,title} | []), supplier ({id,title} | []), client (PII — выбрасываем), create_date "2026-10-18T12:30:00+0400"`. В API числа приходят СТРОКАМИ (`"cost_per_unit": "1.07"`, `"id": "333222111"`).

**Files:**
- Create: `backend/services/economics/goods-events.js`
- Test: `backend/economics-goods-events.test.js`

- [ ] **Step 1: Написать падающий тест**

```js
'use strict';
const { parseGoodsOperation, parseTransaction, GOODS_RESOURCES } = require('./services/economics/goods-events');

const CONSUMABLE = {
  resource: 'goods_operations_consumable', status: 'create', company_id: 668791, resource_id: 1926952027,
  data: {
    id: 1926952027, cost: 6800, good: { id: 20999974, title: 'Meso-Wharton P199' }, type: 'Списание расходников',
    unit: { id: 216760, title: 'Штука', short_title: 'шт.' }, amount: -1,
    client: { id: 143396511, name: 'Мамедова Айнура', phone: '79850306156' }, master: [], comment: '',
    service: { id: 9536494, title: 'MesoWharton 1,5 ml ( 60 минут)' }, storage: { id: 1334902, title: 'Расходники' },
    type_id: 2, discount: 0, supplier: [], record_id: 2037605603, create_date: '2026-10-18T12:30:00+0400',
    document_id: 2320695578, cost_per_unit: 6800, last_change_date: '2026-10-18T22:36:55+04:00', operation_unit_type: 2,
  },
};

describe('parseGoodsOperation', () => {
  test('списание: все поля, record/service, PII вырезан, дата нормализована', () => {
    const r = parseGoodsOperation(CONSUMABLE);
    expect(r.resource).toBe('goods_operations_consumable');
    expect(r.status).toBe('create');
    const row = r.row;
    expect(row.yclients_txn_id).toBe(1926952027);
    expect(row.type_id).toBe(2);
    expect(row.good_id).toBe(20999974);
    expect(row.good_title).toBe('Meso-Wharton P199');
    expect(row.unit_title).toBe('шт.');
    expect(row.amount).toBe(-1);
    expect(row.cost_per_unit).toBe(6800);
    expect(row.cost).toBe(6800);
    expect(row.record_id).toBe(2037605603);
    expect(row.service_id).toBe(9536494);
    expect(row.master_id).toBeNull();
    expect(row.supplier_title).toBeNull();
    expect(row.operation_unit_type).toBe(2);
    expect(row.create_date).toBe('2026-10-18T08:30:00.000Z');
    expect(row.raw.client).toBeUndefined();
    expect(row.raw.good.title).toBe('Meso-Wharton P199');
  });

  test('приход: record_id 0 → null, service [] → null, числа из API-строк', () => {
    const r = parseGoodsOperation({
      resource: 'goods_operations_receipt', status: 'update',
      data: { id: '1927251299', cost: '12180', good: { id: '20933400', title: 'Шприц' }, unit: { id: '216764', title: 'Упаковка' },
        amount: '3', client: [], master: { id: '112233445', title: 'Василий' }, service: [], storage: { id: 1334902, title: 'Расходники' },
        type_id: 3, discount: '5.00', supplier: { id: '11112222', title: 'Поставщик' }, record_id: 0,
        create_date: '2026-10-18T16:10:00+0400', document_id: 2336035170, cost_per_unit: '4060', operation_unit_type: 1 },
    });
    expect(r.status).toBe('update');
    expect(r.row.yclients_txn_id).toBe(1927251299);
    expect(r.row.record_id).toBeNull();
    expect(r.row.service_id).toBeNull();
    expect(r.row.master_id).toBe(112233445);
    expect(r.row.supplier_title).toBe('Поставщик');
    expect(r.row.unit_title).toBe('Упаковка');
    expect(r.row.amount).toBe(3);
    expect(r.row.cost).toBe(12180);
    expect(r.row.discount).toBe(5);
  });

  test('delete-статус проходит, неизвестный ресурс/статус/битые данные → null', () => {
    expect(parseGoodsOperation({ ...CONSUMABLE, status: 'delete' }).status).toBe('delete');
    expect(parseGoodsOperation({ ...CONSUMABLE, resource: 'record' })).toBeNull();
    expect(parseGoodsOperation({ ...CONSUMABLE, status: 'archive' })).toBeNull();
    expect(parseGoodsOperation({ ...CONSUMABLE, data: null })).toBeNull();
    expect(parseGoodsOperation({ ...CONSUMABLE, data: { ...CONSUMABLE.data, id: 'abc' } })).toBeNull();
    expect(parseGoodsOperation({ ...CONSUMABLE, data: { ...CONSUMABLE.data, amount: null } })).toBeNull();
    expect(parseGoodsOperation(null)).toBeNull();
  });

  test('parseTransaction применим к строке /storages/transactions напрямую', () => {
    const row = parseTransaction({ id: 1, amount: '-0.25', type_id: 2, good: { id: 5, title: 'X' }, record_id: 7, create_date: '2012-12-21T19:08:00+0400', cost: '0.00', cost_per_unit: '1.07' });
    expect(row.amount).toBe(-0.25);
    expect(row.record_id).toBe(7);
    expect(row.cost_per_unit).toBe(1.07);
  });

  test('GOODS_RESOURCES — четыре ресурса', () => {
    expect([...GOODS_RESOURCES].sort()).toEqual(['goods_operations_consumable', 'goods_operations_receipt', 'goods_operations_sale', 'goods_operations_stolen']);
  });
});
```

- [ ] **Step 2: Запустить — убедиться, что падает**

Run: `cd /root/loyalpro/backend && npx jest economics-goods-events 2>&1 | tail -5`
Expected: FAIL, `Cannot find module './services/economics/goods-events'`.

- [ ] **Step 3: Реализация**

```js
'use strict';
// Чистый разбор товарной операции YClients. ОДИН разбор на два входа:
// payload.data вебхука goods_operations_* и строка GET /storages/transactions —
// поля совпадают, но API отдаёт числа строками ("cost_per_unit": "1.07").
// client.* (имя/телефон) выбрасывается — в goods_transactions PII не пишется.

const GOODS_RESOURCES = new Set([
  'goods_operations_consumable', 'goods_operations_receipt',
  'goods_operations_sale', 'goods_operations_stolen',
]);
const STATUSES = new Set(['create', 'update', 'delete']);

function num(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function obj(v) { return v && typeof v === 'object' && !Array.isArray(v) ? v : null; }
function idOf(v) { const o = obj(v); const n = o ? num(o.id) : null; return n && n > 0 ? n : null; }
function titleOf(v, max = 500) { const o = obj(v); return o && typeof o.title === 'string' && o.title ? o.title.slice(0, max) : null; }
function str(v, max) { return typeof v === 'string' && v ? v.slice(0, max) : null; }

// "2026-10-18T12:30:00+0400" → ISO UTC; "+0400" без двоеточия Date.parse понимает
// не везде, поэтому нормализуем смещение явно.
function parseDate(v) {
  if (typeof v !== 'string' || !v) return null;
  const s = v.replace(/([+-]\d{2})(\d{2})$/, '$1:$2');
  const t = Date.parse(s);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

/** Строка goods_transactions из data вебхука или строки API; null при битых полях. */
function parseTransaction(d) {
  if (!obj(d)) return null;
  const id = num(d.id);
  if (!id || id <= 0) return null;
  const amount = num(d.amount);
  if (amount === null) return null;
  const recordId = num(d.record_id);
  const unit = obj(d.unit);
  const { client, ...raw } = d; // eslint-disable-line no-unused-vars
  return {
    yclients_txn_id: id,
    document_id: num(d.document_id),
    type_id: num(d.type_id),
    type_title: str(d.type, 100),
    good_id: idOf(d.good),
    good_title: titleOf(d.good),
    storage_id: idOf(d.storage),
    unit_title: unit ? (str(unit.short_title, 50) || str(unit.title, 50)) : null,
    operation_unit_type: num(d.operation_unit_type),
    amount,
    cost_per_unit: num(d.cost_per_unit),
    cost: num(d.cost),
    discount: num(d.discount),
    record_id: recordId && recordId > 0 ? recordId : null,
    service_id: idOf(d.service),
    service_title: titleOf(d.service),
    master_id: idOf(d.master),
    supplier_title: titleOf(d.supplier, 255),
    create_date: parseDate(d.create_date),
    last_change_date: parseDate(d.last_change_date),
    raw,
  };
}

/** { resource, status, row } или null (не наш ресурс / неизвестный статус / битые данные). */
function parseGoodsOperation(payload) {
  if (!obj(payload)) return null;
  const resource = payload.resource || payload.resource_type;
  if (!GOODS_RESOURCES.has(resource)) return null;
  const status = payload.status;
  if (!STATUSES.has(status)) return null;
  const row = parseTransaction(payload.data);
  if (!row) return null;
  return { resource, status, row };
}

module.exports = { parseGoodsOperation, parseTransaction, parseDate, GOODS_RESOURCES };
```

- [ ] **Step 4: Запустить тест**

Run: `cd /root/loyalpro/backend && npx jest economics-goods-events 2>&1 | tail -5`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
cd /root/loyalpro && git add backend/services/economics/goods-events.js backend/economics-goods-events.test.js && git commit -m "feat(economics): чистый разбор товарных операций YClients (вебхук и API), без PII"
```

---

### Task 3: Апсерт транзакции, обновление «последней закупки», хук в вебхуке

**Модель: Sonnet (L1).**

**Files:**
- Create: `backend/services/economics/store.js` (первая часть — апсерты; загрузчики отчёта добавит задача 11)
- Create: `backend/services/economics/index.js`
- Modify: `backend/routes/webhook.js:120-125`
- Test: `backend/economics-store.test.js`, `backend/economics-webhook.test.js`

- [ ] **Step 1: Падающий тест апсерта**

```js
'use strict';
jest.mock('./db', () => ({ db: { one: jest.fn(), oneOrNone: jest.fn(), query: jest.fn(), any: jest.fn() }, pool: {} }));
const mockLog = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
jest.mock('./logger', () => ({ createLogger: () => mockLog }));
const { db } = require('./db');
const store = require('./services/economics/store');

const ROW = {
  yclients_txn_id: 10, document_id: 20, type_id: 3, type_title: 'Приход товара', good_id: 7, good_title: 'Шприц',
  storage_id: 1, unit_title: 'уп.', operation_unit_type: 1, amount: 3, cost_per_unit: 4060, cost: 12180, discount: 0,
  record_id: null, service_id: null, service_title: null, master_id: null, supplier_title: null,
  create_date: '2026-10-18T12:10:00.000Z', last_change_date: null, raw: { id: 10 },
};

beforeEach(() => { jest.clearAllMocks(); db.query.mockResolvedValue({ rows: [], rowCount: 1 }); db.any.mockResolvedValue([]); db.oneOrNone.mockResolvedValue(null); });

describe('upsertGoodsTransaction', () => {
  test('create/update: INSERT … ON CONFLICT, deleted_at NULL, source из опций', async () => {
    await store.upsertGoodsTransaction(1, ROW, { status: 'update', source: 'webhook' });
    const [sql, params] = db.query.mock.calls[0];
    expect(sql).toMatch(/INSERT INTO goods_transactions/);
    expect(sql).toMatch(/ON CONFLICT \(salon_id, yclients_txn_id\) DO UPDATE/);
    expect(params[0]).toBe(1);
    expect(params[1]).toBe(10);
    expect(params[params.length - 2]).toBe('webhook');
    expect(params[params.length - 1]).toBeNull();      // deleted_at
  });
  test('delete: deleted_at = NOW() (строка не удаляется)', async () => {
    await store.upsertGoodsTransaction(1, ROW, { status: 'delete', source: 'webhook' });
    const [sql] = db.query.mock.calls[0];
    expect(sql).toMatch(/deleted_at\s*=\s*COALESCE\(\$\d+::timestamptz, NOW\(\)\)/);
  });
});

describe('refreshLastReceipt', () => {
  test('последнее поступление ≤ сегодня → цена за единицу списания с учётом unit_equals', async () => {
    db.oneOrNone
      .mockResolvedValueOnce({ unit_equals: '10' })                                             // каталог
      .mockResolvedValueOnce({ create_date: '2026-10-18T12:10:00.000Z', amount: '3', cost: '12180', operation_unit_type: 1 }); // приход
    await store.refreshLastReceipt(1, 7);
    const upd = db.query.mock.calls.find(c => /UPDATE yclients_goods_catalog/.test(c[0]));
    expect(upd[1]).toEqual([1, 7, 406, '2026-10-18T12:10:00.000Z']); // 12180/3/10
  });
  test('приходов нет → цена и дата сбрасываются в NULL', async () => {
    db.oneOrNone.mockResolvedValueOnce({ unit_equals: null }).mockResolvedValueOnce(null);
    await store.refreshLastReceipt(1, 7);
    const upd = db.query.mock.calls.find(c => /UPDATE yclients_goods_catalog/.test(c[0]));
    expect(upd[1]).toEqual([1, 7, null, null]);
  });
});
```

- [ ] **Step 2: Запустить — падает**

Run: `cd /root/loyalpro/backend && npx jest economics-store 2>&1 | tail -5`
Expected: FAIL (модуль не найден).

- [ ] **Step 3: `price.js` нужен здесь только одной функцией — создать минимальный модуль (полностью задача 4 дополнит)**

`backend/services/economics/price.js`:

```js
'use strict';
// Цена единицы материала. Полное правило (§3.2 спеки) — unitPriceAsOf, ниже.
// receiptUnitPrice: цена ЕДИНИЦЫ СПИСАНИЯ по строке прихода. Приход идёт в единице
// продажи (operation_unit_type 1: флакон, упаковка), списание — в единице списания
// (мл, ед.); пересчёт через unit_equals каталога. cost прихода уже с учётом скидки
// поставщика (10 шт по 11 630 ₽ со скидкой 5 % → cost 110 485 → 11 048,5 ₽/шт).
function round4(x) { return Math.round(x * 10000) / 10000; }

function receiptUnitPrice(txn, unitEquals) {
  if (!txn) return null;
  const amount = Math.abs(Number(txn.amount));
  const cost = Number(txn.cost);
  if (!(amount > 0) || !Number.isFinite(cost) || cost < 0) return null;
  let per = cost / amount;
  const eq = Number(unitEquals);
  if (Number(txn.operation_unit_type) === 1 && eq > 0) per = per / eq;
  return round4(per);
}

module.exports = { receiptUnitPrice, round4 };
```

- [ ] **Step 4: `store.js` — апсерты**

```js
'use strict';
// IO-слой экономики процедур. SQL экспортируется ради живого EXPLAIN
// (scripts/economics-explain.js) — ГОТЧА проекта: EXPLAIN с литералами не
// ловит вывод типов параметров. Загрузчики отчёта — ниже (задача 11).
const { db } = require('../../db');
const { receiptUnitPrice } = require('./price');
const { createLogger } = require('../../logger');
const logger = createLogger('EconomicsStore');

const TXN_COLS = [
  'document_id', 'type_id', 'type_title', 'good_id', 'good_title', 'storage_id', 'unit_title',
  'operation_unit_type', 'amount', 'cost_per_unit', 'cost', 'discount', 'record_id', 'service_id',
  'service_title', 'master_id', 'supplier_title', 'create_date', 'last_change_date', 'raw',
];

/**
 * Апсерт строки goods_transactions. status 'delete' ставит deleted_at (строка
 * остаётся — форензика), create/update снимают deleted_at (сверка вернула живую).
 * @param {number} salonId
 * @param {object} row — результат goods-events.parseTransaction
 * @param {{status:'create'|'update'|'delete', source:'webhook'|'reconcile'|'backfill', deletedAt?:string}} opts
 */
async function upsertGoodsTransaction(salonId, row, opts) {
  const { status, source } = opts;
  const deletedAt = status === 'delete' ? (opts.deletedAt || null) : null;
  const vals = TXN_COLS.map(c => (c === 'raw' ? JSON.stringify(row.raw || {}) : (row[c] === undefined ? null : row[c])));
  const params = [salonId, row.yclients_txn_id, ...vals, source, deletedAt];
  const colList = TXN_COLS.join(', ');
  const placeholders = TXN_COLS.map((c, i) => `$${i + 3}${c === 'raw' ? '::jsonb' : ''}`).join(', ');
  const nSrc = TXN_COLS.length + 3;
  const nDel = TXN_COLS.length + 4;
  const sets = TXN_COLS.map(c => `${c} = EXCLUDED.${c}`).join(', ');
  const sql = `
    INSERT INTO goods_transactions (salon_id, yclients_txn_id, ${colList}, source, deleted_at)
    VALUES ($1, $2, ${placeholders}, $${nSrc}, ${status === 'delete' ? `COALESCE($${nDel}::timestamptz, NOW())` : `$${nDel}::timestamptz`})
    ON CONFLICT (salon_id, yclients_txn_id) DO UPDATE SET
      ${sets}, source = EXCLUDED.source, updated_at = NOW(),
      deleted_at = ${status === 'delete' ? `COALESCE($${nDel}::timestamptz, NOW())` : 'NULL'}
  `;
  await db.query(sql, params);
  return { deleted: status === 'delete' };
}

/** Цена последнего поступления товара → yclients_goods_catalog.last_receipt_price/at. */
async function refreshLastReceipt(salonId, goodId) {
  const cat = await db.oneOrNone(
    'SELECT unit_equals FROM yclients_goods_catalog WHERE salon_id=$1 AND yclients_good_id=$2', [salonId, goodId]);
  const last = await db.oneOrNone(
    `SELECT create_date, amount, cost, operation_unit_type FROM goods_transactions
     WHERE salon_id=$1 AND good_id=$2 AND type_id=3 AND deleted_at IS NULL AND amount > 0
     ORDER BY create_date DESC, yclients_txn_id DESC LIMIT 1`, [salonId, goodId]);
  const price = last ? receiptUnitPrice(last, cat && cat.unit_equals) : null;
  const at = last ? last.create_date : null;
  await db.query(
    `UPDATE yclients_goods_catalog SET last_receipt_price=$3, last_receipt_at=$4, updated_at=NOW()
     WHERE salon_id=$1 AND yclients_good_id=$2`, [salonId, goodId, price, at]);
  return { price, at };
}

/** Для всех товаров салона с приходами (ночной проход после сверки). */
async function refreshAllLastReceipts(salonId) {
  const goods = await db.any(
    `SELECT DISTINCT good_id FROM goods_transactions WHERE salon_id=$1 AND type_id=3 AND deleted_at IS NULL AND good_id IS NOT NULL`, [salonId]);
  let n = 0;
  for (const g of goods) {
    try { await refreshLastReceipt(salonId, Number(g.good_id)); n++; }
    catch (e) { logger.warn(`refreshLastReceipt good=${g.good_id}: ${e.message}`); }
  }
  return n;
}

module.exports = { upsertGoodsTransaction, refreshLastReceipt, refreshAllLastReceipts, TXN_COLS };
```

- [ ] **Step 5: Запустить тест store**

Run: `cd /root/loyalpro/backend && npx jest economics-store 2>&1 | tail -5`
Expected: PASS, 4 tests.

- [ ] **Step 6: Фасад `index.js` и тест хука вебхука**

`backend/services/economics/index.js`:

```js
'use strict';
// Фасад модуля для routes/webhook.js и server.js.
const { parseGoodsOperation } = require('./goods-events');
const store = require('./store');
const { createLogger } = require('../../logger');
const logger = createLogger('Economics');

/**
 * Вебхук goods_operations_*: разобрать → апсерт → для прихода пересчитать
 * «последнюю закупку». Исключение логируется (200 уже отдан), потерянное
 * добирает ночная сверка.
 * @returns {Promise<{handled:boolean, status?:string}>}
 */
async function handleGoodsEvent(salon, payload) {
  const parsed = parseGoodsOperation(payload);
  if (!parsed) return { handled: false };
  const { status, row } = parsed;
  await store.upsertGoodsTransaction(salon.id, row, { status, source: 'webhook' });
  if (Number(row.type_id) === 3 && row.good_id) {
    await store.refreshLastReceipt(salon.id, row.good_id)
      .catch(e => logger.warn(`last receipt good=${row.good_id}: ${e.message}`));
  }
  return { handled: true, status };
}

module.exports = { handleGoodsEvent };
```

`backend/economics-webhook.test.js`:

```js
'use strict';
jest.mock('./services/economics/store', () => ({ upsertGoodsTransaction: jest.fn(), refreshLastReceipt: jest.fn() }));
const mockLog = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
jest.mock('./logger', () => ({ createLogger: () => mockLog }));
const store = require('./services/economics/store');
const { handleGoodsEvent } = require('./services/economics');

const SALON = { id: 1 };
const base = (type_id, extra = {}) => ({
  resource: type_id === 3 ? 'goods_operations_receipt' : 'goods_operations_consumable', status: 'create',
  data: { id: 5, type_id, amount: type_id === 3 ? 2 : -1, cost: 100, good: { id: 9, title: 'G' }, record_id: 0, ...extra },
});

beforeEach(() => { jest.clearAllMocks(); store.upsertGoodsTransaction.mockResolvedValue({}); store.refreshLastReceipt.mockResolvedValue({}); });

test('списание: апсерт source=webhook, last receipt не трогаем', async () => {
  const r = await handleGoodsEvent(SALON, base(2));
  expect(r).toEqual({ handled: true, status: 'create' });
  expect(store.upsertGoodsTransaction).toHaveBeenCalledWith(1, expect.objectContaining({ yclients_txn_id: 5 }), { status: 'create', source: 'webhook' });
  expect(store.refreshLastReceipt).not.toHaveBeenCalled();
});
test('приход: после апсерта пересчитывается последняя закупка товара', async () => {
  await handleGoodsEvent(SALON, base(3));
  expect(store.refreshLastReceipt).toHaveBeenCalledWith(1, 9);
});
test('чужой ресурс → handled:false без обращений к БД', async () => {
  expect(await handleGoodsEvent(SALON, { resource: 'record', status: 'create', data: { id: 1 } })).toEqual({ handled: false });
  expect(store.upsertGoodsTransaction).not.toHaveBeenCalled();
});
test('сбой пересчёта закупки не роняет обработчик', async () => {
  store.refreshLastReceipt.mockRejectedValue(new Error('db down'));
  await expect(handleGoodsEvent(SALON, base(3))).resolves.toEqual({ handled: true, status: 'create' });
  expect(mockLog.warn).toHaveBeenCalled();
});
```

Run: `cd /root/loyalpro/backend && npx jest economics-webhook 2>&1 | tail -5` → Expected: PASS, 4 tests.

- [ ] **Step 7: Хук в `routes/webhook.js`**

Добавить импорт в начало файла рядом с `const { upsertClientFromYc } = ...`:

```js
const economics = require('../services/economics');
```

После блока `if (resourceType === 'finances_operation') { ... }` (строка ~122) добавить:

```js
    // Товарные операции (списания расходников, приходы, продажи, потери) →
    // goods_transactions для экономики процедур. Свой catch: 200 уже отдан,
    // потерянное добирает ночная сверка (services/economics/sync.js).
    if (typeof resourceType === 'string' && resourceType.startsWith('goods_operations_')) {
      await economics.handleGoodsEvent(salon, payload).catch(e =>
        logger.error(`economics goods event: ${e.message}`));
    }
```

- [ ] **Step 8: Проверить на деве живым вебхуком**

Run: `cd /root/loyalpro/backend && PORT=3001 pm2 restart loyalpro && sleep 60 && pm2 logs loyalpro --lines 200 --nostream | grep -c "resource=goods_operations"`
Затем через `mcp__postgres__query`: `SELECT count(*), max(created_at) FROM goods_transactions WHERE salon_id=1;`
Expected: при живом трафике клиники (≈55 списаний в день) — строки появляются; если трафика нет в эту минуту, повторить проверку позже, `pm2 logs` без `economics goods event:` ошибок.

- [ ] **Step 9: Commit**

```bash
cd /root/loyalpro && git add backend/services/economics/ backend/routes/webhook.js backend/economics-store.test.js backend/economics-webhook.test.js && git commit -m "feat(economics): приём goods_operations_* вебхуков в goods_transactions, цена последней закупки"
```

---

### Task 4: `price.js` — цена единицы «на дату»

**Модель: Sonnet (L1).**

**Files:**
- Modify: `backend/services/economics/price.js` (дополнить `unitPriceAsOf`, `mskDay`)
- Test: `backend/economics-price.test.js`

- [ ] **Step 1: Падающий тест**

```js
'use strict';
const { unitPriceAsOf, receiptUnitPrice, mskDay } = require('./services/economics/price');

const R = (date, amount, cost, out = 1) => ({ create_date: date, amount, cost, operation_unit_type: out });

describe('receiptUnitPrice', () => {
  test('приход в единице продажи делится на unit_equals; скидка уже в cost', () => {
    expect(receiptUnitPrice(R('2026-03-21', 10, 110485), 1)).toBe(11048.5);
    expect(receiptUnitPrice(R('2026-03-21', 3, 12180), 10)).toBe(406);
  });
  test('приход в единице списания (operation_unit_type 2) не делится', () => {
    expect(receiptUnitPrice(R('2026-03-21', 100, 50, 2), 10)).toBe(0.5);
  });
  test('нулевое количество/битая цена → null', () => {
    expect(receiptUnitPrice(R('2026-03-21', 0, 100), 1)).toBeNull();
    expect(receiptUnitPrice(R('2026-03-21', 1, 'x'), 1)).toBeNull();
    expect(receiptUnitPrice(null, 1)).toBeNull();
  });
});

describe('unitPriceAsOf', () => {
  const receipts = [
    R('2026-02-01T10:00:00.000Z', 10, 1000),   // 100/шт
    R('2026-05-01T10:00:00.000Z', 10, 1200),   // 120/шт
    R('2026-09-01T10:00:00.000Z', 10, 1500),   // 150/шт
  ];
  test('берётся последнее поступление с датой ≤ визита', () => {
    expect(unitPriceAsOf({ receipts, date: '2026-06-15' })).toEqual({ price: 120, source: 'receipt', at: '2026-05-01T10:00:00.000Z' });
    expect(unitPriceAsOf({ receipts, date: '2026-10-01' }).price).toBe(150);
    expect(unitPriceAsOf({ receipts, date: '2026-05-01' }).price).toBe(120); // день прихода включительно
  });
  test('поступлений до даты нет → ручная цена → unit_actual_cost → 0 с no_price', () => {
    expect(unitPriceAsOf({ receipts, date: '2026-01-01', override: { unit_price: '77' }, catalogRow: { unit_actual_cost: 50 } }))
      .toEqual({ price: 77, source: 'override' });
    expect(unitPriceAsOf({ receipts: [], date: '2026-01-01', catalogRow: { unit_actual_cost: '50' } }))
      .toEqual({ price: 50, source: 'catalog' });
    expect(unitPriceAsOf({ receipts: [], date: '2026-01-01' })).toEqual({ price: 0, source: 'none' });
  });
  test('приход с нулевой ценой пропускается, unit_equals каталога применяется', () => {
    const rs = [R('2026-01-01', 5, 0), R('2025-12-01', 2, 200)];
    expect(unitPriceAsOf({ receipts: rs, date: '2026-02-01', catalogRow: { unit_equals: 10 } }).price).toBe(10);
  });
  test('даты сравниваются по московскому дню (Date-объекты из pg)', () => {
    const rs = [R(new Date('2026-05-01T21:30:00.000Z'), 1, 100)]; // 02.05 00:30 мск
    expect(unitPriceAsOf({ receipts: rs, date: '2026-05-01' }).source).toBe('none');
    expect(unitPriceAsOf({ receipts: rs, date: '2026-05-02' }).price).toBe(100);
  });
});

test('mskDay', () => {
  expect(mskDay('2026-05-01T21:30:00.000Z')).toBe('2026-05-02');
  expect(mskDay('2026-05-01')).toBe('2026-05-01');
  expect(mskDay(null)).toBeNull();
});
```

- [ ] **Step 2: Запустить — падает**

Run: `cd /root/loyalpro/backend && npx jest economics-price 2>&1 | tail -5`
Expected: FAIL, `unitPriceAsOf is not a function`.

- [ ] **Step 3: Дополнить `price.js`**

Добавить перед `module.exports`:

```js
const MSK = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Moscow' });
/** 'YYYY-MM-DD' по Москве из Date/ISO/'YYYY-MM-DD'; null для пустого. */
function mskDay(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)) return v;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isFinite(d.getTime()) ? MSK.format(d) : null;
}

/**
 * Правило §3.2: 1) последний приход ≤ date (cost/amount/unit_equals), 2) ручная
 * цена goods_price_overrides, 3) unit_actual_cost каталога, 4) 0 + source 'none'
 * (в отчёте — флаг «товар без цены»).
 * @param {{receipts?:Array, override?:{unit_price}|null, catalogRow?:{unit_equals,unit_actual_cost}|null, date:string}} a
 */
function unitPriceAsOf({ receipts = [], override = null, catalogRow = null, date }) {
  const day = mskDay(date);
  const eq = catalogRow ? catalogRow.unit_equals : null;
  const cands = (receipts || [])
    .filter(r => r && Number(r.amount) > 0 && (!day || mskDay(r.create_date) <= day))
    .sort((a, b) => String(mskDay(b.create_date)).localeCompare(String(mskDay(a.create_date))));
  for (const r of cands) {
    const p = receiptUnitPrice(r, eq);
    if (p !== null && p > 0) return { price: p, source: 'receipt', at: r.create_date };
  }
  const ov = override && Number(override.unit_price);
  if (ov > 0) return { price: ov, source: 'override' };
  const uac = catalogRow && Number(catalogRow.unit_actual_cost);
  if (uac > 0) return { price: uac, source: 'catalog' };
  return { price: 0, source: 'none' };
}

module.exports = { receiptUnitPrice, unitPriceAsOf, mskDay, round4 };
```

(Удалить прежний `module.exports = { receiptUnitPrice, round4 };`.)

- [ ] **Step 4: Запустить тесты**

Run: `cd /root/loyalpro/backend && npx jest economics-price economics-store 2>&1 | tail -5`
Expected: PASS (оба набора).

- [ ] **Step 5: Commit**

```bash
cd /root/loyalpro && git add backend/services/economics/price.js backend/economics-price.test.js && git commit -m "feat(economics): цена единицы материала на дату визита (приход → ручная → себестоимость YClients)"
```

---

### Task 5: `sync.js` — ночной синк каталога товаров (единицы, себестоимость, остатки)

**Модель: Sonnet (L1).**

Источник — `GET /goods/{cid}?count=100&page=N` до пустой страницы (БЕЗ `category_id`: так отдаётся весь каталог, см. memory `ref_yclients_goods_pagination`). Поля ответа (пример openapi): `good_id, title, unit_short_title, service_unit_short_title, unit_equals, actual_cost, unit_actual_cost, actual_amounts:[{storage_id, amount}], cost, last_change_date` — числа строками. Существующий `yclients-goods-catalog.js` не трогать.

**Files:**
- Create: `backend/services/economics/sync.js`
- Test: `backend/economics-sync.test.js`

- [ ] **Step 1: Падающий тест**

```js
'use strict';
jest.mock('./db', () => ({ db: { one: jest.fn(), oneOrNone: jest.fn(), query: jest.fn(), any: jest.fn() }, pool: {} }));
jest.mock('./services/yclients', () => ({ ycGet: jest.fn() }));
jest.mock('./services/economics/store', () => ({
  upsertGoodsTransaction: jest.fn(), refreshLastReceipt: jest.fn(), refreshAllLastReceipts: jest.fn(),
  upsertCatalogGood: jest.fn(), upsertTechCard: jest.fn(), upsertServiceTechCard: jest.fn(),
  listTechCardIdsByYc: jest.fn(), listRecordsToLearn: jest.fn(),
}));
const mockLog = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
jest.mock('./logger', () => ({ createLogger: () => mockLog }));
const { ycGet } = require('./services/yclients');
const store = require('./services/economics/store');
const sync = require('./services/economics/sync');

const SALON = { id: 1, yclients_company_id: '668791' };
const noSleep = async () => {};
beforeEach(() => { jest.clearAllMocks(); Object.values(store).forEach(f => f.mockResolvedValue && f.mockResolvedValue(undefined)); });

describe('syncGoodsCatalog', () => {
  test('постранично до пустой страницы, числа из строк, остатки в stock', async () => {
    ycGet.mockImplementation(async (s, path, params) => {
      expect(path).toBe('/goods/668791');
      expect(params.count).toBe(100);
      if (params.page === 1) return [{ good_id: '123', title: 'Шампунь', unit_short_title: 'шт', service_unit_short_title: 'гр',
        unit_equals: '10', actual_cost: '1050', unit_actual_cost: '105', actual_amounts: [{ storage_id: '987', amount: '1000000' }] }];
      if (params.page === 2) return [{ good_id: 124, title: 'Б', unit_equals: '', actual_cost: null }];
      return [];
    });
    const r = await sync.syncGoodsCatalog(SALON, { sleep: noSleep });
    expect(r).toEqual({ pages: 3, goods: 2 });
    expect(store.upsertCatalogGood).toHaveBeenCalledWith(1, {
      good_id: 123, title: 'Шампунь', unit: 'шт', service_unit: 'гр', unit_equals: 10,
      actual_cost: 1050, unit_actual_cost: 105, stock: [{ storage_id: 987, amount: 1000000 }],
    });
    expect(store.upsertCatalogGood).toHaveBeenCalledWith(1, expect.objectContaining({ good_id: 124, unit_equals: null, actual_cost: null, stock: [] }));
  });
  test('кап страниц — не больше MAX_GOODS_PAGES', async () => {
    ycGet.mockResolvedValue([{ good_id: 1, title: 'x' }]);
    const r = await sync.syncGoodsCatalog(SALON, { sleep: noSleep });
    expect(r.pages).toBe(sync.MAX_GOODS_PAGES);
    expect(mockLog.warn).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Запустить — падает**

Run: `cd /root/loyalpro/backend && npx jest economics-sync 2>&1 | tail -5`
Expected: FAIL (модуль не найден).

- [ ] **Step 3: Добавить `upsertCatalogGood` в `store.js`**

```js
/** Апсерт экономических колонок товара; дерево категорий (category_*) не трогает. */
async function upsertCatalogGood(salonId, g) {
  await db.query(`
    INSERT INTO yclients_goods_catalog (salon_id, yclients_good_id, title, unit, service_unit, unit_equals,
      actual_cost, unit_actual_cost, stock, last_seen_at, updated_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, NOW(), NOW())
    ON CONFLICT (salon_id, yclients_good_id) DO UPDATE SET
      title = CASE WHEN EXCLUDED.title <> '' THEN EXCLUDED.title ELSE yclients_goods_catalog.title END,
      unit = EXCLUDED.unit, service_unit = EXCLUDED.service_unit, unit_equals = EXCLUDED.unit_equals,
      actual_cost = EXCLUDED.actual_cost, unit_actual_cost = EXCLUDED.unit_actual_cost, stock = EXCLUDED.stock,
      last_seen_at = NOW(), updated_at = NOW()
  `, [salonId, g.good_id, g.title || '', g.unit, g.service_unit, g.unit_equals, g.actual_cost, g.unit_actual_cost, JSON.stringify(g.stock || [])]);
}
```
И добавить в `module.exports`.

- [ ] **Step 4: `sync.js` — каталог**

```js
'use strict';
// Ночной проход экономики процедур: каталог товаров → техкарты → сверка товарных
// транзакций → обучение привязок техкарт → пересчёт «последней закупки».
// Квота YClients минутная и общая с Милой/«Заботой»: ≈33 запроса на салон,
// крон 5 5 * * * мск (после сверки записей 35 4 и чистки 40 4). Каждый шаг в
// своём try/catch — ошибка одного не останавливает остальные. Прогон идемпотентен.
const { ycGet } = require('../yclients');
const { withRateLimitRetry } = require('../yclients-retry');
const store = require('./store');
const { createLogger } = require('../../logger');
const logger = createLogger('EconomicsSync');

const PAGE = 100;
const MAX_GOODS_PAGES = 50;         // 5 000 товаров — на порядок больше 467 у PERI
const PAGE_PAUSE_MS = 400;
const RETRY = { retries: 2, delayMs: 60_000 };
const defaultSleep = (ms) => new Promise(r => setTimeout(r, ms));

function num(v) { if (v === null || v === undefined || v === '') return null; const n = Number(v); return Number.isFinite(n) ? n : null; }

function parseCatalogGood(g) {
  const id = num(g && (g.good_id !== undefined ? g.good_id : g.id));
  if (!id) return null;
  return {
    good_id: id,
    title: typeof g.title === 'string' ? g.title.slice(0, 500) : '',
    unit: typeof g.unit_short_title === 'string' ? g.unit_short_title.slice(0, 50) : null,
    service_unit: typeof g.service_unit_short_title === 'string' ? g.service_unit_short_title.slice(0, 50) : null,
    unit_equals: num(g.unit_equals),
    actual_cost: num(g.actual_cost),
    unit_actual_cost: num(g.unit_actual_cost),
    stock: (Array.isArray(g.actual_amounts) ? g.actual_amounts : [])
      .map(a => ({ storage_id: num(a.storage_id), amount: num(a.amount) })).filter(a => a.storage_id),
  };
}

/** GET /goods/{cid}?count=100&page=N до пустой страницы (БЕЗ category_id — иначе не весь каталог). */
async function syncGoodsCatalog(salon, opts = {}) {
  const sleep = opts.sleep || defaultSleep;
  const cid = salon.yclients_company_id;
  let pages = 0, goods = 0;
  for (let page = 1; page <= MAX_GOODS_PAGES; page++) {
    const chunk = await withRateLimitRetry(() => ycGet(salon, `/goods/${cid}`, { count: PAGE, page }), RETRY);
    pages++;
    if (!Array.isArray(chunk) || !chunk.length) return { pages, goods };
    for (const g of chunk) {
      const row = parseCatalogGood(g);
      if (!row) continue;
      await store.upsertCatalogGood(salon.id, row);
      goods++;
    }
    await sleep(PAGE_PAUSE_MS);
  }
  logger.warn(`salon=${salon.id}: каталог товаров упёрся в кап ${MAX_GOODS_PAGES} страниц`);
  return { pages, goods };
}

module.exports = { syncGoodsCatalog, parseCatalogGood, MAX_GOODS_PAGES, PAGE, RETRY, PAGE_PAUSE_MS, defaultSleep, num };
```

- [ ] **Step 5: Запустить тест**

Run: `cd /root/loyalpro/backend && npx jest economics-sync 2>&1 | tail -5`
Expected: PASS, 2 tests.

- [ ] **Step 6: Commit**

```bash
cd /root/loyalpro && git add backend/services/economics/sync.js backend/services/economics/store.js backend/economics-sync.test.js && git commit -m "feat(economics): ночной синк каталога товаров — единицы, себестоимость, остатки"
```

---

### Task 6: Сверка товарных транзакций и догон истории

**Модель: Opus (L2).** Внешний API с минутным лимитом, пагинация, идемпотентность, два режима (changed_after для крона, start_date/end_date помесячно для догона).

`GET /storages/transactions/{cid}` принимает `page, count, start_date, end_date, changed_after, changed_before`. Сверка крона — `changed_after=<−2 дня>`; догон — помесячно `start_date/end_date` (у поступлений до 21.03.2026 вебхуков у нас нет).

**Files:**
- Modify: `backend/services/economics/sync.js`
- Create: `backend/scripts/economics-backfill-goods.js`
- Test: `backend/economics-sync.test.js` (дополнить)

- [ ] **Step 1: Дописать падающие тесты**

```js
describe('reconcileGoodsTransactions', () => {
  test('changed_after за 2 дня, постранично, апсерт source=reconcile, приходы пересчитывают закупку', async () => {
    const rows = [
      { id: 1, type_id: 2, amount: '-1', cost: '5', good: { id: 9, title: 'G' }, record_id: 77, create_date: '2026-10-17T10:00:00+0400' },
      { id: 2, type_id: 3, amount: '3', cost: '12180', good: { id: 9, title: 'G' }, record_id: 0, create_date: '2026-10-17T11:00:00+0400' },
    ];
    ycGet.mockImplementation(async (s, path, params) => {
      expect(path).toBe('/storages/transactions/668791');
      expect(params.changed_after).toBe('2026-10-16');
      return params.page === 1 ? rows : [];
    });
    const r = await sync.reconcileGoodsTransactions(SALON, { now: new Date('2026-10-18T12:00:00+03:00'), sleep: noSleep });
    expect(r).toEqual({ pages: 2, upserted: 2, skipped: 0, receipts: 1 });
    expect(store.upsertGoodsTransaction).toHaveBeenCalledWith(1, expect.objectContaining({ yclients_txn_id: 1, record_id: 77 }), { status: 'update', source: 'reconcile' });
    expect(store.refreshLastReceipt).toHaveBeenCalledWith(1, 9);
  });
  test('битая строка пропускается и считается в skipped', async () => {
    ycGet.mockImplementation(async (s, p, params) => (params.page === 1 ? [{ id: 'x' }, { id: 3, amount: '1', type_id: 2 }] : []));
    const r = await sync.reconcileGoodsTransactions(SALON, { sleep: noSleep });
    expect(r.upserted).toBe(1);
    expect(r.skipped).toBe(1);
  });
});

describe('backfillGoodsTransactions', () => {
  test('помесячно start_date/end_date, source=backfill, идёт до текущего месяца', async () => {
    const seen = [];
    ycGet.mockImplementation(async (s, p, params) => { seen.push({ ...params }); return params.page === 1 ? [{ id: 100 + seen.length, amount: '1', type_id: 2, create_date: params.start_date + 'T10:00:00+0400' }] : []; });
    const r = await sync.backfillGoodsTransactions(SALON, { from: '2026-08-15', to: '2026-10-05', sleep: noSleep });
    expect(seen.filter(p => p.page === 1).map(p => [p.start_date, p.end_date])).toEqual([
      ['2026-08-15', '2026-08-31'], ['2026-09-01', '2026-09-30'], ['2026-10-01', '2026-10-05'],
    ]);
    expect(r.months).toBe(3);
    expect(r.upserted).toBe(3);
    expect(store.upsertGoodsTransaction).toHaveBeenCalledWith(1, expect.anything(), { status: 'update', source: 'backfill' });
    expect(store.refreshAllLastReceipts).toHaveBeenCalledWith(1);
  });
});
```

- [ ] **Step 2: Запустить — падает**

Run: `cd /root/loyalpro/backend && npx jest economics-sync 2>&1 | tail -5`
Expected: FAIL, `reconcileGoodsTransactions is not a function`.

- [ ] **Step 3: Реализация в `sync.js`**

Добавить `const { parseTransaction } = require('./goods-events');` и функции:

```js
const RECONCILE_DAYS = 2;
const MAX_TXN_PAGES = 200;          // 20 000 транзакций за запрос — месяц у PERI ≈ 1 700

function mskDate(now = new Date(), shiftDays = 0) {
  const d = new Date(now.getTime() + shiftDays * 86400000);
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Moscow' }).format(d);
}

/** Постранично читает /storages/transactions с заданными params и апсертит. */
async function pullTransactions(salon, params, source, sleep) {
  const cid = salon.yclients_company_id;
  let pages = 0, upserted = 0, skipped = 0, receipts = 0;
  const receiptGoods = new Set();
  for (let page = 1; page <= MAX_TXN_PAGES; page++) {
    const chunk = await withRateLimitRetry(
      () => ycGet(salon, `/storages/transactions/${cid}`, { ...params, page, count: PAGE }), RETRY);
    pages++;
    if (!Array.isArray(chunk) || !chunk.length) break;
    for (const t of chunk) {
      const row = parseTransaction(t);
      if (!row) { skipped++; continue; }
      await store.upsertGoodsTransaction(salon.id, row, { status: 'update', source });
      upserted++;
      if (Number(row.type_id) === 3 && row.good_id) { receipts++; receiptGoods.add(row.good_id); }
    }
    if (page === MAX_TXN_PAGES) logger.warn(`salon=${salon.id}: транзакции упёрлись в кап ${MAX_TXN_PAGES} страниц (${JSON.stringify(params)})`);
    await sleep(PAGE_PAUSE_MS);
  }
  return { pages, upserted, skipped, receipts, receiptGoods };
}

/** Крон: changed_after = сегодня − 2 дня (потерянные вебхуки, правки задним числом). */
async function reconcileGoodsTransactions(salon, opts = {}) {
  const sleep = opts.sleep || defaultSleep;
  const changedAfter = mskDate(opts.now || new Date(), -RECONCILE_DAYS);
  const r = await pullTransactions(salon, { changed_after: changedAfter }, 'reconcile', sleep);
  for (const goodId of r.receiptGoods) {
    await store.refreshLastReceipt(salon.id, goodId).catch(e => logger.warn(`last receipt good=${goodId}: ${e.message}`));
  }
  logger.info(`salon=${salon.id}: сверка транзакций changed_after=${changedAfter}: ${r.upserted} строк, ${r.skipped} битых`);
  return { pages: r.pages, upserted: r.upserted, skipped: r.skipped, receipts: r.receipts };
}

function monthRanges(from, to) {
  const out = [];
  let cur = from;
  while (cur <= to) {
    const [y, m] = cur.split('-').map(Number);
    const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
    const end = `${cur.slice(0, 7)}-${String(lastDay).padStart(2, '0')}`;
    out.push([cur, end < to ? end : to]);
    const next = new Date(Date.UTC(y, m, 1));
    cur = next.toISOString().slice(0, 10);
  }
  return out;
}

/** Разовый догон истории помесячно (start_date/end_date); только ручным скриптом. */
async function backfillGoodsTransactions(salon, opts = {}) {
  const sleep = opts.sleep || defaultSleep;
  const from = opts.from;
  const to = opts.to || mskDate(new Date());
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from || '') || !/^\d{4}-\d{2}-\d{2}$/.test(to) || from > to) throw new Error('backfill: from/to в формате YYYY-MM-DD');
  let months = 0, upserted = 0, skipped = 0;
  for (const [start, end] of monthRanges(from, to)) {
    const r = await pullTransactions(salon, { start_date: start, end_date: end }, 'backfill', sleep);
    months++; upserted += r.upserted; skipped += r.skipped;
    logger.info(`salon=${salon.id}: догон ${start}..${end}: ${r.upserted} строк`);
    if (opts.onMonth) opts.onMonth({ start, end, ...r });
  }
  await store.refreshAllLastReceipts(salon.id);
  return { months, upserted, skipped };
}
```

Добавить в `module.exports`: `reconcileGoodsTransactions, backfillGoodsTransactions, monthRanges, mskDate, RECONCILE_DAYS`.

- [ ] **Step 4: Запустить тесты**

Run: `cd /root/loyalpro/backend && npx jest economics-sync 2>&1 | tail -5`
Expected: PASS, 5 tests.

- [ ] **Step 5: Скрипт догона**

`backend/scripts/economics-backfill-goods.js`:

```js
#!/usr/bin/env node
'use strict';
// Разовый догон товарных транзакций YClients в goods_transactions помесячно.
//   node scripts/economics-backfill-goods.js --salon=1 --from=2025-10-01 [--to=YYYY-MM-DD]
// Идемпотентен (UNIQUE salon+yclients_txn_id). Один запрос страницы ≈1 с,
// пауза 400 мс, повтор на 429 через 60 с. Нужен ОДИН раз при включении модуля:
// цены поступлений до 21.03.2026 (начало вебхуков) иначе неизвестны.
const { db, pool } = require('../db');
const { backfillGoodsTransactions } = require('../services/economics/sync');

const opt = (name) => { const a = process.argv.find(x => x.startsWith(`--${name}=`)); return a ? a.slice(name.length + 3) : null; };
const salonId = Number(opt('salon') || 1);
const from = opt('from');
const to = opt('to') || undefined;
if (!from) { console.error('нужен --from=YYYY-MM-DD'); process.exit(2); }

(async () => {
  const salon = await db.oneOrNone('SELECT * FROM salons WHERE id=$1 AND is_active', [salonId]);
  if (!salon) { console.error(`салон ${salonId} не найден`); process.exit(2); }
  const t0 = Date.now();
  const r = await backfillGoodsTransactions(salon, { from, to, onMonth: m => console.log(`${m.start}..${m.end}: ${m.upserted} строк, ${m.skipped} битых, ${m.pages} стр.`) });
  console.log(`итого: ${r.months} мес., ${r.upserted} строк, ${r.skipped} битых, ${Math.round((Date.now() - t0) / 1000)} с`);
  const cnt = await db.oneOrNone('SELECT count(*)::int AS n, min(create_date) AS mn, max(create_date) AS mx FROM goods_transactions WHERE salon_id=$1', [salonId]);
  console.log('goods_transactions:', cnt);
  await pool.end();
})().catch(e => { console.error(e); process.exit(1); });
```

- [ ] **Step 6: Прогнать догон на деве за один месяц (живой YClients, пишет в дев-БД)**

Run: `cd /root/loyalpro/backend && node scripts/economics-backfill-goods.js --salon=1 --from=2026-09-01 --to=2026-09-30 2>&1 | tail -5`
Expected: `2026-09-01..2026-09-30: N строк` (N порядка 1 500–2 000), без исключений. Проверить через `mcp__postgres__query`: `SELECT type_id, count(*) FROM goods_transactions WHERE salon_id=1 AND create_date >= '2026-09-01' AND create_date < '2026-10-01' GROUP BY 1;` — есть `type_id=2` и `3`.

- [ ] **Step 7: Commit**

```bash
cd /root/loyalpro && git add backend/services/economics/sync.js backend/economics-sync.test.js backend/scripts/economics-backfill-goods.js && git commit -m "feat(economics): сверка товарных транзакций по changed_after и помесячный догон истории"
```

---

### Task 7: Техкарты — импорт, нормы, привязки, обучение по факту

**Модель: Opus (L2).** Три источника привязки с приоритетом, ответы YClients трёх форм, лимит вызовов.

Форма `GET /technological_cards/{cid}/`: `[{id, title, technological_card_items:[{id, good_id, amount, unit, price, title, storage_id}]}]`. Форма `record_consumables/{cid}/{record_id}/`: `[{service_id, record_id, technological_cards:[{id, title, technological_card_items:[…]}], consumables:[…]}]`. Форма `default_for_staff_and_service/{cid}/{staff}/{service}/`: один объект техкарты или пусто.

**Files:**
- Create: `backend/services/economics/tech-cards.js`
- Modify: `backend/services/economics/store.js`, `backend/services/economics/sync.js`
- Test: `backend/economics-tech-cards.test.js`, `backend/economics-sync.test.js` (дополнить)

- [ ] **Step 1: Падающий тест чистого модуля**

```js
'use strict';
const { parseYcCard, normCost, suggestLinks, pickTechCard } = require('./services/economics/tech-cards');

describe('parseYcCard', () => {
  test('карта YClients → {yc_card_id, title, items}', () => {
    expect(parseYcCard({ id: '36069', title: 'Revi Silk 2 ml', technological_card_items: [
      { id: 1, good_id: 6858783, amount: '2', unit: 'мл', price: '1000', title: 'Revi' },
      { id: 2, good_id: 'bad', amount: 1 },
    ] })).toEqual({ yc_card_id: 36069, title: 'Revi Silk 2 ml', items: [{ good_id: 6858783, amount: 2, unit: 'мл', price_at_sync: 1000, title: 'Revi' }] });
    expect(parseYcCard({ id: 0 })).toBeNull();
    expect(parseYcCard(null)).toBeNull();
  });
});

describe('normCost', () => {
  const card = { items: [{ good_id: 1, amount: 2 }, { good_id: 2, amount: 0.5 }, { good_id: 3, amount: 1 }] };
  const priceFn = (goodId) => ({ 1: { price: 100, source: 'receipt' }, 2: { price: 40, source: 'catalog' }, 3: { price: 0, source: 'none' } })[goodId];
  test('Σ amount × price, товары без цены — в noPrice', () => {
    expect(normCost(card, priceFn, '2026-09-01')).toEqual({ cost: 220, noPrice: [3], items: 3 });
  });
  test('нет карты/пустая → null', () => {
    expect(normCost(null, priceFn, '2026-09-01')).toBeNull();
    expect(normCost({ items: [] }, priceFn, '2026-09-01')).toBeNull();
  });
});

describe('pickTechCard', () => {
  const links = [
    { service_yc_id: 10, staff_yc_id: null, source: 'learned', tech_card_id: 1 },
    { service_yc_id: 10, staff_yc_id: 5, source: 'learned', tech_card_id: 2 },
    { service_yc_id: 10, staff_yc_id: null, source: 'manual', tech_card_id: 3 },
    { service_yc_id: 11, staff_yc_id: 5, source: 'lookup', tech_card_id: 4 },
  ];
  test('manual главнее любого; иначе сотрудник-специфичная главнее общей', () => {
    expect(pickTechCard(links, 10, 5).tech_card_id).toBe(3);
    expect(pickTechCard(links.filter(l => l.source !== 'manual'), 10, 5).tech_card_id).toBe(2);
    expect(pickTechCard(links.filter(l => l.source !== 'manual'), 10, 6).tech_card_id).toBe(1);
    expect(pickTechCard(links, 11, 6)).toBeNull();      // привязка только к сотруднику 5
    expect(pickTechCard(links, 99, 5)).toBeNull();
  });
});

describe('suggestLinks', () => {
  test('совпадение по нормализованному названию, без подтверждения не применяется', () => {
    const cards = [{ id: 1, title: 'Revi Silk 2 ml' }, { id: 2, title: 'Чистка лица' }];
    const services = [{ id: 10, title: 'Revi Silk 2 ml (45 минут)' }, { id: 11, title: 'Массаж' }];
    expect(suggestLinks(cards, services)).toEqual([{ service_yc_id: 10, tech_card_id: 1, title: 'Revi Silk 2 ml' }]);
  });
});
```

- [ ] **Step 2: Запустить — падает**

Run: `cd /root/loyalpro/backend && npx jest economics-tech-cards 2>&1 | tail -5`
Expected: FAIL (модуль не найден).

- [ ] **Step 3: Реализация `tech-cards.js`**

```js
'use strict';
// Техкарты: разбор ответов YClients, стоимость нормы, выбор привязки, подсказки.
function num(v) { if (v === null || v === undefined || v === '') return null; const n = Number(v); return Number.isFinite(n) ? n : null; }

/** Карта YClients (список, default_for_staff_and_service, record_consumables) → строка tech_cards. */
function parseYcCard(c) {
  if (!c || typeof c !== 'object') return null;
  const id = num(c.id);
  if (!id || id <= 0) return null;
  const items = (Array.isArray(c.technological_card_items) ? c.technological_card_items : [])
    .map(i => ({ good_id: num(i.good_id), amount: num(i.amount), unit: typeof i.unit === 'string' ? i.unit : (i.good && i.good.unit) || null,
      price_at_sync: num(i.price), title: typeof i.title === 'string' ? i.title : (i.good && i.good.title) || null }))
    .filter(i => i.good_id && i.amount !== null);
  return { yc_card_id: id, title: typeof c.title === 'string' ? c.title.slice(0, 500) : '', items };
}

/** Σ amount × unit_price(good, date). priceFn(goodId, date) → {price, source}. */
function normCost(card, priceFn, date) {
  const items = card && Array.isArray(card.items) ? card.items : [];
  if (!items.length) return null;
  let cost = 0; const noPrice = [];
  for (const it of items) {
    const p = priceFn(it.good_id, date) || { price: 0, source: 'none' };
    if (!(p.price > 0)) noPrice.push(it.good_id);
    cost += Math.abs(Number(it.amount) || 0) * (Number(p.price) || 0);
  }
  return { cost, noPrice, items: items.length };
}

const SOURCE_RANK = { manual: 0, lookup: 1, learned: 2 };
/** Привязка для пары услуга+сотрудник: manual > lookup > learned; внутри источника — с сотрудником > общая. */
function pickTechCard(links, serviceYcId, staffYcId) {
  const cands = (links || []).filter(l => String(l.service_yc_id) === String(serviceYcId)
    && (l.staff_yc_id === null || l.staff_yc_id === undefined || String(l.staff_yc_id) === String(staffYcId)));
  if (!cands.length) return null;
  cands.sort((a, b) => (SOURCE_RANK[a.source] ?? 9) - (SOURCE_RANK[b.source] ?? 9)
    || ((b.staff_yc_id != null) - (a.staff_yc_id != null)));
  return cands[0];
}

function normTitle(s) {
  return String(s || '').toLowerCase().replace(/\([^)]*\)/g, ' ').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}
/** Подсказки «техкарта ↔ услуга» по совпадению нормализованных названий (префикс). */
function suggestLinks(cards, services) {
  const out = [];
  for (const s of services || []) {
    const st = normTitle(s.title);
    if (st.length < 4) continue;
    const c = (cards || []).find(card => { const ct = normTitle(card.title); return ct.length >= 4 && (ct === st || st.startsWith(ct) || ct.startsWith(st)); });
    if (c) out.push({ service_yc_id: s.id, tech_card_id: c.id, title: c.title });
  }
  return out;
}

module.exports = { parseYcCard, normCost, pickTechCard, suggestLinks, normTitle };
```

- [ ] **Step 4: Запустить тест**

Run: `cd /root/loyalpro/backend && npx jest economics-tech-cards 2>&1 | tail -5`
Expected: PASS, 4 describe-блока.

- [ ] **Step 5: Store — апсерты техкарт и привязок, выборка записей для обучения**

Добавить в `store.js`:

```js
/** Импорт карты YClients: UPSERT по (salon_id, yc_card_id). Возвращает id. */
async function upsertTechCard(salonId, card) {
  const r = await db.oneOrNone(`
    INSERT INTO tech_cards (salon_id, yc_card_id, title, items, source, synced_at, updated_at)
    VALUES ($1, $2, $3, $4::jsonb, 'yclients', NOW(), NOW())
    ON CONFLICT (salon_id, yc_card_id) WHERE yc_card_id IS NOT NULL DO UPDATE SET
      title = EXCLUDED.title, items = EXCLUDED.items, synced_at = NOW(), updated_at = NOW()
    RETURNING id`, [salonId, card.yc_card_id, card.title, JSON.stringify(card.items)]);
  return r ? r.id : null;
}

/** Привязка услуга(+сотрудник) → техкарта. manual перезаписывает всё; lookup/learned не трогают manual. */
async function upsertServiceTechCard(salonId, { serviceYcId, staffYcId = null, techCardId, source }) {
  await db.query(`
    INSERT INTO service_tech_cards (salon_id, service_yc_id, staff_yc_id, tech_card_id, source, updated_at)
    VALUES ($1, $2, $3, $4, $5, NOW())
    ON CONFLICT (salon_id, service_yc_id, COALESCE(staff_yc_id, 0)) DO UPDATE SET
      tech_card_id = EXCLUDED.tech_card_id, source = EXCLUDED.source, updated_at = NOW()
    WHERE service_tech_cards.source <> 'manual' OR EXCLUDED.source = 'manual'`,
    [salonId, serviceYcId, staffYcId, techCardId, source]);
}

/** Map yc_card_id → tech_cards.id. */
async function listTechCardIdsByYc(salonId) {
  const rows = await db.any('SELECT id, yc_card_id FROM tech_cards WHERE salon_id=$1 AND yc_card_id IS NOT NULL', [salonId]);
  return new Map(rows.map(r => [String(r.yc_card_id), r.id]));
}

/**
 * Состоявшиеся записи дня со списаниями, у которых пара (услуга, сотрудник) ещё
 * не привязана ни к одной техкарте. Это кандидаты на record_consumables.
 */
async function listRecordsToLearn(salonId, day, limit) {
  return db.any(`
    SELECT r.yclients_record_id AS record_id, (r.staff->>'id')::bigint AS staff_yc_id
    FROM records r
    WHERE r.salon_id = $1 AND r.visit_date = $2::date AND r.raw_payload->>'attendance' = '1'
      AND COALESCE(r.status,'') <> 'deleted'
      AND EXISTS (SELECT 1 FROM goods_transactions t WHERE t.salon_id = r.salon_id AND t.record_id = r.yclients_record_id AND t.type_id = 2 AND t.deleted_at IS NULL)
      AND EXISTS (
        SELECT 1 FROM jsonb_array_elements(r.services) s
        WHERE NOT EXISTS (SELECT 1 FROM service_tech_cards l WHERE l.salon_id = r.salon_id
          AND l.service_yc_id = (s->>'id')::bigint AND (l.staff_yc_id IS NULL OR l.staff_yc_id = (r.staff->>'id')::bigint)))
    ORDER BY r.yclients_record_id LIMIT $3`, [salonId, day, limit]);
}
```
Добавить все четыре в `module.exports`.

- [ ] **Step 6: Падающие тесты синка техкарт и обучения (в `economics-sync.test.js`)**

```js
describe('syncTechCards', () => {
  test('постранично, каждая карта → upsertTechCard', async () => {
    ycGet.mockImplementation(async (s, p, params) => { expect(p).toBe('/technological_cards/668791/'); return params.page === 1 ? [{ id: 1, title: 'A', technological_card_items: [{ good_id: 5, amount: 1 }] }, { id: 'bad' }] : []; });
    store.upsertTechCard.mockResolvedValue(11);
    const r = await sync.syncTechCards(SALON, { sleep: noSleep });
    expect(r).toEqual({ pages: 2, cards: 1, skipped: 1 });
    expect(store.upsertTechCard).toHaveBeenCalledWith(1, { yc_card_id: 1, title: 'A', items: [{ good_id: 5, amount: 1, unit: null, price_at_sync: null, title: null }] });
  });
});

describe('learnTechCardLinks', () => {
  test('по вчерашним записям: record_consumables → привязка learned по services[].technological_cards[]', async () => {
    store.listRecordsToLearn.mockResolvedValue([{ record_id: 500, staff_yc_id: 7 }]);
    store.listTechCardIdsByYc.mockResolvedValue(new Map([['36069', 11]]));
    ycGet.mockResolvedValue([{ service_id: 21558, record_id: 500, technological_cards: [{ id: 36069, title: 'X', technological_card_items: [] }], consumables: [] }]);
    const r = await sync.learnTechCardLinks(SALON, { now: new Date('2026-10-18T12:00:00+03:00'), sleep: noSleep });
    expect(store.listRecordsToLearn).toHaveBeenCalledWith(1, '2026-10-17', sync.MAX_LEARN_CALLS);
    expect(ycGet).toHaveBeenCalledWith(SALON, '/technological_cards/record_consumables/668791/500/');
    expect(store.upsertServiceTechCard).toHaveBeenCalledWith(1, { serviceYcId: 21558, staffYcId: 7, techCardId: 11, source: 'learned' });
    expect(r).toEqual({ records: 1, linked: 1, unknownCards: 0 });
  });
  test('карта не импортирована → unknownCards, привязки нет', async () => {
    store.listRecordsToLearn.mockResolvedValue([{ record_id: 500, staff_yc_id: 7 }]);
    store.listTechCardIdsByYc.mockResolvedValue(new Map());
    ycGet.mockResolvedValue([{ service_id: 1, technological_cards: [{ id: 999 }] }]);
    const r = await sync.learnTechCardLinks(SALON, { sleep: noSleep });
    expect(r.unknownCards).toBe(1);
    expect(store.upsertServiceTechCard).not.toHaveBeenCalled();
  });
});

describe('lookupTechCardForService', () => {
  test('по каждому исполнителю ≤ 4 вызова, найденная карта импортируется и привязывается lookup', async () => {
    store.upsertTechCard.mockResolvedValue(12);
    ycGet.mockImplementation(async (s, p) => (p.endsWith('/5/10/') ? { id: 77, title: 'C', technological_card_items: [] } : null));
    const r = await sync.lookupTechCardForService(SALON, 10, [5, 6], { sleep: noSleep });
    expect(ycGet).toHaveBeenCalledTimes(2);
    expect(store.upsertServiceTechCard).toHaveBeenCalledWith(1, { serviceYcId: 10, staffYcId: 5, techCardId: 12, source: 'lookup' });
    expect(r).toEqual({ checked: 2, found: [{ staffYcId: 5, techCardId: 12, title: 'C' }] });
  });
});
```

- [ ] **Step 7: Реализация в `sync.js`**

Добавить `const { parseYcCard } = require('./tech-cards');` и:

```js
const MAX_CARD_PAGES = 20;
const MAX_LEARN_CALLS = 15;
const MAX_LOOKUP_STAFF = 4;

async function syncTechCards(salon, opts = {}) {
  const sleep = opts.sleep || defaultSleep;
  const cid = salon.yclients_company_id;
  let pages = 0, cards = 0, skipped = 0;
  for (let page = 1; page <= MAX_CARD_PAGES; page++) {
    const chunk = await withRateLimitRetry(() => ycGet(salon, `/technological_cards/${cid}/`, { count: PAGE, page }), RETRY);
    pages++;
    if (!Array.isArray(chunk) || !chunk.length) break;
    for (const c of chunk) {
      const card = parseYcCard(c);
      if (!card) { skipped++; continue; }
      await store.upsertTechCard(salon.id, card);
      cards++;
    }
    await sleep(PAGE_PAUSE_MS);
  }
  return { pages, cards, skipped };
}

/** Обучение привязок по фактам: вчерашние записи со списаниями → record_consumables. */
async function learnTechCardLinks(salon, opts = {}) {
  const sleep = opts.sleep || defaultSleep;
  const day = mskDate(opts.now || new Date(), -1);
  const recs = await store.listRecordsToLearn(salon.id, day, MAX_LEARN_CALLS);
  const byYc = await store.listTechCardIdsByYc(salon.id);
  let linked = 0, unknownCards = 0;
  for (const rec of recs) {
    let data;
    try {
      data = await withRateLimitRetry(() => ycGet(salon, `/technological_cards/record_consumables/${salon.yclients_company_id}/${rec.record_id}/`), RETRY);
    } catch (e) { logger.warn(`record_consumables ${rec.record_id}: ${e.message}`); continue; }
    for (const entry of Array.isArray(data) ? data : []) {
      const serviceYcId = num(entry.service_id);
      if (!serviceYcId) continue;
      for (const c of Array.isArray(entry.technological_cards) ? entry.technological_cards : []) {
        const techCardId = byYc.get(String(num(c.id)));
        if (!techCardId) { unknownCards++; continue; }
        await store.upsertServiceTechCard(salon.id, { serviceYcId, staffYcId: rec.staff_yc_id || null, techCardId, source: 'learned' });
        linked++;
      }
    }
    await sleep(PAGE_PAUSE_MS);
  }
  return { records: recs.length, linked, unknownCards };
}

/** По запросу из админки: default_for_staff_and_service по каждому исполнителю услуги (≤ 4). */
async function lookupTechCardForService(salon, serviceYcId, staffYcIds, opts = {}) {
  const sleep = opts.sleep || defaultSleep;
  const found = [];
  const staff = (staffYcIds || []).slice(0, MAX_LOOKUP_STAFF);
  for (const staffYcId of staff) {
    const data = await withRateLimitRetry(
      () => ycGet(salon, `/technological_cards/default_for_staff_and_service/${salon.yclients_company_id}/${staffYcId}/${serviceYcId}/`), RETRY)
      .catch(e => { logger.warn(`lookup staff=${staffYcId} service=${serviceYcId}: ${e.message}`); return null; });
    const card = parseYcCard(data);
    if (card) {
      const techCardId = await store.upsertTechCard(salon.id, card);
      await store.upsertServiceTechCard(salon.id, { serviceYcId, staffYcId, techCardId, source: 'lookup' });
      found.push({ staffYcId, techCardId, title: card.title });
    }
    await sleep(PAGE_PAUSE_MS);
  }
  return { checked: staff.length, found };
}
```
Экспортировать: `syncTechCards, learnTechCardLinks, lookupTechCardForService, MAX_LEARN_CALLS, MAX_LOOKUP_STAFF`.

- [ ] **Step 8: Запустить тесты**

Run: `cd /root/loyalpro/backend && npx jest economics-sync economics-tech-cards 2>&1 | tail -5`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
cd /root/loyalpro && git add backend/services/economics/ backend/economics-tech-cards.test.js backend/economics-sync.test.js && git commit -m "feat(economics): импорт техкарт YClients, нормы, привязки learned/lookup/manual"
```

---

### Task 8: `pay-rules.js` — выбор правила оплаты и оплата врача

**Модель: Sonnet (L1).**

**Files:**
- Create: `backend/services/economics/pay-rules.js`
- Test: `backend/economics-pay-rules.test.js`

- [ ] **Step 1: Падающий тест**

```js
'use strict';
const { pickRule, doctorPay, ruleRank } = require('./services/economics/pay-rules');

const R = (o) => ({ id: 1, staff_yc_id: null, service_yc_id: null, category_yc_id: null, percent: 30, base: 'gross', fixed_per_visit: 0, valid_from: null, valid_to: null, ...o });

describe('pickRule', () => {
  const rules = [
    R({ id: 1 }),                                             // салон по умолчанию
    R({ id: 2, staff_yc_id: 5 }),                             // сотрудник целиком
    R({ id: 3, category_yc_id: 100 }),                        // категория
    R({ id: 4, service_yc_id: 10 }),                          // услуга
    R({ id: 5, service_yc_id: 10, staff_yc_id: 5 }),          // услуга у сотрудника
    R({ id: 6, staff_yc_id: 5, valid_from: '2026-10-01', valid_to: '2026-10-31', percent: 50 }),
  ];
  const q = (o) => ({ staffId: 5, serviceId: 10, categoryId: 100, date: '2026-09-15', ...o });
  test('приоритет: услуга+сотрудник > услуга > категория > сотрудник > салон', () => {
    expect(pickRule(rules, q()).id).toBe(5);
    expect(pickRule(rules.filter(r => r.id !== 5), q()).id).toBe(4);
    expect(pickRule(rules.filter(r => ![4, 5].includes(r.id)), q()).id).toBe(3);
    expect(pickRule(rules.filter(r => ![3, 4, 5].includes(r.id)), q()).id).toBe(2);
    expect(pickRule(rules.filter(r => ![2, 3, 4, 5].includes(r.id)), q({ date: '2026-09-15' })).id).toBe(1);
  });
  test('период действия: вне окна правило не действует; внутри — позднейшее valid_from побеждает при равном ранге', () => {
    const only = rules.filter(r => [2, 6].includes(r.id));
    expect(pickRule(only, q({ serviceId: 99, categoryId: 99 })).id).toBe(2);
    expect(pickRule(only, q({ serviceId: 99, categoryId: 99, date: '2026-10-15' })).id).toBe(6);
    expect(pickRule(only, q({ serviceId: 99, categoryId: 99, date: '2026-11-01' })).id).toBe(2);
  });
  test('чужой сотрудник не подходит под staff-правило; нет правил → null', () => {
    expect(pickRule([R({ id: 2, staff_yc_id: 5 })], q({ staffId: 6 }))).toBeNull();
    expect(pickRule([], q())).toBeNull();
  });
  test('ruleRank экспортирован (для сортировки в UI)', () => {
    expect(ruleRank(R({ service_yc_id: 1, staff_yc_id: 1 }))).toBe(0);
    expect(ruleRank(R({}))).toBe(5);
  });
});

describe('doctorPay', () => {
  const settings = { payroll_multiplier: 1.3, pay_base_includes_bonuses: false };
  const row = { price: 10000, revenue: 9000, materials_used: 1000 };
  test('gross: от выручки; множитель ФОТ', () => {
    expect(doctorPay(row, R({ percent: 30 }), settings)).toEqual({ base: 9000, pay: 2700, cost: 3510, noRule: false });
  });
  test('net_of_materials: выручка − материалы; плюс фикс за визит', () => {
    expect(doctorPay(row, R({ percent: 40, base: 'net_of_materials', fixed_per_visit: 500 }), settings)).toEqual({ base: 8000, pay: 3700, cost: 4810, noRule: false });
  });
  test('pay_base_includes_bonuses → база price (до вычета бонусов)', () => {
    expect(doctorPay(row, R({ percent: 10 }), { ...settings, pay_base_includes_bonuses: true }).base).toBe(10000);
  });
  test('нет правила → 0 и noRule; отрицательная база → 0', () => {
    expect(doctorPay(row, null, settings)).toEqual({ base: 0, pay: 0, cost: 0, noRule: true });
    expect(doctorPay({ price: 100, revenue: 100, materials_used: 500 }, R({ percent: 50, base: 'net_of_materials' }), settings).pay).toBe(0);
  });
  test('битый множитель → 1', () => {
    expect(doctorPay(row, R({ percent: 10 }), { payroll_multiplier: null }).cost).toBe(900);
  });
});
```

- [ ] **Step 2: Запустить — падает**

Run: `cd /root/loyalpro/backend && npx jest economics-pay-rules 2>&1 | tail -5`
Expected: FAIL.

- [ ] **Step 3: Реализация**

```js
'use strict';
// Правила оплаты врача (§3.3 спеки). Приоритет: услуга у сотрудника → услуга →
// категория у сотрудника → категория → сотрудник целиком → салон по умолчанию;
// у каждого правила период действия (строки 'YYYY-MM-DD', NULL = открыт).
function eq(a, b) { return a !== null && a !== undefined && b !== null && b !== undefined && String(a) === String(b); }
function isNull(v) { return v === null || v === undefined; }
function day(v) { return v ? String(v).slice(0, 10) : null; }

function ruleRank(r) {
  if (!isNull(r.service_yc_id)) return isNull(r.staff_yc_id) ? 1 : 0;
  if (!isNull(r.category_yc_id)) return isNull(r.staff_yc_id) ? 3 : 2;
  if (!isNull(r.staff_yc_id)) return 4;
  return 5;
}

function pickRule(rules, { staffId, serviceId, categoryId, date }) {
  const d = day(date);
  const cands = (rules || []).filter(r =>
    (isNull(r.staff_yc_id) || eq(r.staff_yc_id, staffId))
    && (isNull(r.service_yc_id) || eq(r.service_yc_id, serviceId))
    && (isNull(r.category_yc_id) || eq(r.category_yc_id, categoryId))
    && (!day(r.valid_from) || !d || day(r.valid_from) <= d)
    && (!day(r.valid_to) || !d || day(r.valid_to) >= d));
  if (!cands.length) return null;
  cands.sort((a, b) => ruleRank(a) - ruleRank(b)
    || String(day(b.valid_from) || '').localeCompare(String(day(a.valid_from) || ''))
    || Number(b.id || 0) - Number(a.id || 0));
  return cands[0];
}

/** row: {price, revenue, materials_used}; settings: {payroll_multiplier, pay_base_includes_bonuses}. */
function doctorPay(row, rule, settings = {}) {
  if (!rule) return { base: 0, pay: 0, cost: 0, noRule: true };
  const mult = Number(settings.payroll_multiplier) > 0 ? Number(settings.payroll_multiplier) : 1;
  const start = settings.pay_base_includes_bonuses ? Number(row.price) || 0 : Number(row.revenue) || 0;
  const base = rule.base === 'net_of_materials' ? start - (Number(row.materials_used) || 0) : start;
  const pay = Math.max(0, base) * (Number(rule.percent) || 0) / 100 + (Number(rule.fixed_per_visit) || 0);
  return { base, pay, cost: pay * mult, noRule: false };
}

module.exports = { pickRule, doctorPay, ruleRank };
```

- [ ] **Step 4: Запустить тесты**

Run: `cd /root/loyalpro/backend && npx jest economics-pay-rules 2>&1 | tail -5`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd /root/loyalpro && git add backend/services/economics/pay-rules.js backend/economics-pay-rules.test.js && git commit -m "feat(economics): правила оплаты врача — приоритет, период, база, множитель ФОТ"
```

---

### Task 9: `allocation.js` — деление по весам, минуты, месяцы периода, драйверы, аппараты

**Модель: Sonnet (L1).**

**Files:**
- Create: `backend/services/economics/allocation.js`
- Test: `backend/economics-allocation.test.js`

- [ ] **Step 1: Падающий тест**

```js
'use strict';
const A = require('./services/economics/allocation');

describe('splitByWeights', () => {
  test('делит пропорционально, сумма сходится до копейки (остаток — последней)', () => {
    expect(A.splitByWeights(100, [1, 1, 1])).toEqual([33.33, 33.33, 33.34]);
    expect(A.splitByWeights(1000, [22500, 5000])).toEqual([818.18, 181.82]);
  });
  test('нулевые веса → поровну; пусто → []', () => {
    expect(A.splitByWeights(10, [0, 0])).toEqual([5, 5]);
    expect(A.splitByWeights(10, [])).toEqual([]);
  });
});

describe('splitMinutes', () => {
  test('seance_length (сек) делится по длительностям услуг из каталога', () => {
    expect(A.splitMinutes(3600, [2700, 900])).toEqual([45, 15]);
  });
  test('нет длительностей → поровну; одна услуга → всё ей', () => {
    expect(A.splitMinutes(3600, [null, null])).toEqual([30, 30]);
    expect(A.splitMinutes(3600, [0])).toEqual([60]);
  });
});

describe('monthShares', () => {
  test('доли дней месяцев в периоде', () => {
    expect(A.monthShares('2026-09-16', '2026-10-15')).toEqual([
      { month: '2026-09', days: 15, share: 0.5 },
      { month: '2026-10', days: 15, share: 15 / 31 },
    ]);
    expect(A.monthShares('2026-02-01', '2026-02-28')).toEqual([{ month: '2026-02', days: 28, share: 1 }]);
  });
});

describe('periodFixedCosts', () => {
  const rows = [
    { id: 1, category: 'rent', amount_month: 300000, month_from: '2026-01-01', month_to: null },
    { id: 2, category: 'admin', amount_month: 120000, month_from: '2026-10-01', month_to: '2026-10-01' },
    { id: 3, category: 'rent', amount_month: 999, month_from: '2027-01-01', month_to: null },
  ];
  test('Σ по месяцам amount × доля дней; строки вне своих месяцев не считаются', () => {
    const r = A.periodFixedCosts(rows, '2026-09-16', '2026-10-15');
    expect(r.total).toBeCloseTo(300000 * 0.5 + 300000 * 15 / 31 + 120000 * 15 / 31, 2);
    expect(r.byCategory.rent).toBeCloseTo(300000 * (0.5 + 15 / 31), 2);
    expect(r.byCategory.admin).toBeCloseTo(120000 * 15 / 31, 2);
  });
  test('пусто → 0', () => { expect(A.periodFixedCosts([], '2026-09-01', '2026-09-30').total).toBe(0); });
});

describe('equipment', () => {
  const eq = { purchase_price: 5050000, residual_pct: 10, useful_life_months: 60, maintenance_monthly: 20000, purchase_date: '2025-01-15', is_active: true };
  test('equipmentMonthly: амортизация + ТО', () => {
    expect(A.equipmentMonthly(eq)).toEqual({ depreciation: 75750, maintenance: 20000, total: 95750 });
  });
  test('equipmentPeriodCost: по долям месяцев; до покупки — 0; после срока службы — только ТО', () => {
    expect(A.equipmentPeriodCost(eq, '2026-09-01', '2026-09-30')).toBe(95750);
    expect(A.equipmentPeriodCost(eq, '2024-12-01', '2024-12-31')).toBe(0);
    expect(A.equipmentPeriodCost(eq, '2030-02-01', '2030-02-28')).toBe(20000);
    expect(A.equipmentPeriodCost({ ...eq, is_active: false }, '2026-09-01', '2026-09-30')).toBe(0);
  });
});

describe('rate/allocate', () => {
  const rows = [{ minutes: 60, service_yc_id: 1 }, { minutes: 30, service_yc_id: 2 }, { minutes: 30, service_yc_id: 1 }];
  test('minutes: ставка за минуту; visits: поровну', () => {
    expect(A.rate('minutes', 1200, rows)).toBe(10);
    expect(A.rate('visits', 1200, rows)).toBe(400);
    expect(A.rate('minutes', 1200, [])).toBe(0);
  });
  test('allocate: по драйверу, с фильтром услуг (аппарат)', () => {
    expect(A.allocate(rows, 'minutes', 1200)).toEqual([600, 300, 300]);
    expect(A.allocate(rows, 'visits', 1200)).toEqual([400, 400, 400]);
    expect(A.allocate(rows, 'minutes', 900, new Set([1]))).toEqual([600, 0, 300]);
    expect(A.allocate(rows, 'visits', 900, new Set([2]))).toEqual([0, 900, 0]);
  });
});
```

- [ ] **Step 2: Запустить — падает**

Run: `cd /root/loyalpro/backend && npx jest economics-allocation 2>&1 | tail -5`
Expected: FAIL.

- [ ] **Step 3: Реализация**

```js
'use strict';
// Распределения (§3.1, 3.6 спеки). Чистые функции, даты — строки 'YYYY-MM-DD'.
const r2 = (x) => Math.round(x * 100) / 100;

/** total по весам; копейки сходятся: последняя доля — остаток. Нулевые веса → поровну. */
function splitByWeights(total, weights) {
  const n = weights.length;
  if (!n) return [];
  const w = weights.map(x => Math.max(0, Number(x) || 0));
  const sum = w.reduce((a, b) => a + b, 0);
  const eff = sum > 0 ? w : w.map(() => 1);
  const effSum = sum > 0 ? sum : n;
  const out = [];
  let acc = 0;
  for (let i = 0; i < n - 1; i++) { const v = r2(total * eff[i] / effSum); out.push(v); acc += v; }
  out.push(r2(total - acc));
  return out;
}

/** Минуты записи между услугами пропорционально длительности в каталоге (сек); нет — поровну. */
function splitMinutes(seanceLengthSec, durationsSec) {
  const minutes = (Number(seanceLengthSec) || 0) / 60;
  const ds = (durationsSec || []).map(d => Number(d) || 0);
  return splitByWeights(minutes, ds.some(d => d > 0) ? ds : ds.map(() => 1));
}

function daysInMonth(ym) { const [y, m] = ym.split('-').map(Number); return new Date(Date.UTC(y, m, 0)).getUTCDate(); }
function addDays(iso, n) { const d = new Date(iso + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }

/** [{month:'YYYY-MM', days, share}] — доли дней каждого месяца, попавших в период (границы включительно). */
function monthShares(from, to) {
  const out = [];
  let cur = from;
  while (cur <= to) {
    const ym = cur.slice(0, 7);
    const dim = daysInMonth(ym);
    const monthEnd = `${ym}-${String(dim).padStart(2, '0')}`;
    const end = monthEnd < to ? monthEnd : to;
    const days = Math.round((Date.parse(end) - Date.parse(cur)) / 86400000) + 1;
    out.push({ month: ym, days, share: days / dim });
    cur = addDays(monthEnd, 1);
  }
  return out;
}

/** Σ amount_month × доля месяца по строкам бюджета, действующим в этом месяце. */
function periodFixedCosts(rows, from, to) {
  const shares = monthShares(from, to);
  let total = 0; const byCategory = {}; const byMonth = {};
  for (const { month, share } of shares) {
    for (const fc of rows || []) {
      const mf = String(fc.month_from || '').slice(0, 7);
      const mt = fc.month_to ? String(fc.month_to).slice(0, 7) : null;
      if (!mf || mf > month || (mt && mt < month)) continue;
      const v = (Number(fc.amount_month) || 0) * share;
      total += v;
      byCategory[fc.category] = (byCategory[fc.category] || 0) + v;
      byMonth[month] = (byMonth[month] || 0) + v;
    }
  }
  return { total, byCategory, byMonth, months: shares };
}

function equipmentMonthly(eq) {
  const price = Number(eq.purchase_price) || 0;
  const residual = Math.min(100, Math.max(0, Number(eq.residual_pct) || 0));
  const life = Math.max(1, Number(eq.useful_life_months) || 60);
  const depreciation = r2(price * (1 - residual / 100) / life);
  const maintenance = r2(Number(eq.maintenance_monthly) || 0);
  return { depreciation, maintenance, total: r2(depreciation + maintenance) };
}

/** Стоимость аппарата за период: амортизация в пределах срока службы + ТО; неактивный → 0. */
function equipmentPeriodCost(eq, from, to) {
  if (eq.is_active === false) return 0;
  const m = equipmentMonthly(eq);
  const startYm = eq.purchase_date ? String(eq.purchase_date).slice(0, 7) : null;
  const life = Math.max(1, Number(eq.useful_life_months) || 60);
  let endYm = null;
  if (startYm) { const [y, mo] = startYm.split('-').map(Number); const e = new Date(Date.UTC(y, mo - 1 + life - 1, 1)); endYm = e.toISOString().slice(0, 7); }
  let total = 0;
  for (const { month, share } of monthShares(from, to)) {
    if (startYm && month < startYm) continue;
    const dep = (!endYm || month <= endYm) ? m.depreciation : 0;
    total += (dep + m.maintenance) * share;
  }
  return r2(total);
}

function rate(driver, sum, rows) {
  if (!rows || !rows.length) return 0;
  if (driver === 'visits') return sum / rows.length;
  const minutes = rows.reduce((a, r) => a + (Number(r.minutes) || 0), 0);
  return minutes > 0 ? sum / minutes : 0;
}

/** Массив сумм параллельно rows; filterServiceIds (Set) — только строки этих услуг (аппарат). */
function allocate(rows, driver, sum, filterServiceIds = null) {
  const idx = rows.map((r, i) => i).filter(i => !filterServiceIds || filterServiceIds.has(Number(rows[i].service_yc_id)));
  const sub = idx.map(i => rows[i]);
  const weights = driver === 'visits' ? sub.map(() => 1) : sub.map(r => Number(r.minutes) || 0);
  const parts = splitByWeights(sum, weights);
  const out = rows.map(() => 0);
  idx.forEach((i, k) => { out[i] = parts[k]; });
  return out;
}

module.exports = { splitByWeights, splitMinutes, monthShares, periodFixedCosts, equipmentMonthly, equipmentPeriodCost, rate, allocate, daysInMonth, addDays, r2 };
```

- [ ] **Step 4: Запустить тесты**

Run: `cd /root/loyalpro/backend && npx jest economics-allocation 2>&1 | tail -5`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd /root/loyalpro && git add backend/services/economics/allocation.js backend/economics-allocation.test.js && git commit -m "feat(economics): распределения — веса, минуты, доли месяцев, драйверы, амортизация аппаратов"
```

---

### Task 10: `calc.js` — строка «запись × услуга», эквайринг, overhead, агрегация

**Модель: Fable (L3).** Ядро модуля: §3.1–3.7 спеки в одном месте, десяток связанных правил и флагов; ошибка здесь искажает все цифры отчёта. Тест — на числах реального визита 2049113510 (Belotero 22 500 + ботулинотерапия 5 000, `seance_length` 3600, списания по Belotero).

**Files:**
- Create: `backend/services/economics/calc.js`
- Test: `backend/economics-calc.test.js`

Контракт входа `buildRows(record, ctx)`:
- `record = { record_id, visit_date:'YYYY-MM-DD', staff_yc_id, staff_name, seance_length (сек), services:[{id,title,cost_to_pay,first_cost,cost}], consumables:[{good_id, service_id|null, amount, cost}], bonus_redeemed, payments:[{amount, account_title}] }`
- `ctx = { durations: Map<svcIdStr, сек>, categories: Map<svcIdStr, catId>, priceFn(goodId, date)→{price,source}, techCardFor(serviceId, staffId)→card|null, payRules:[…], settings:{payroll_multiplier, pay_base_includes_bonuses, acquiring:{[account_title]:pct}} }`

- [ ] **Step 1: Падающий тест**

```js
'use strict';
const C = require('./services/economics/calc');

// Визит 2049113510 (прод, 18.10.2026): Belotero 22 500 + ботулинотерапия 5 000, seance 3600 с.
// Списания — только по Belotero (service 9536380) + одно без service_id (перчатки).
const RECORD = {
  record_id: 2049113510, visit_date: '2026-10-18', staff_yc_id: 1910274, staff_name: 'Гаджиева Пери', seance_length: 3600,
  services: [
    { id: 9536380, title: 'Belotero lips contur 0,6 ml', cost_to_pay: 22500, first_cost: 22500 },
    { id: 25013124, title: 'Ботулинотерапия-Круговая мышца рта', cost_to_pay: 5000, first_cost: 5000 },
  ],
  consumables: [
    { good_id: 1, service_id: 9536380, amount: -1, cost: 5267 },      // Belotero
    { good_id: 2, service_id: 9536380, amount: -15, cost: 117 },      // анестезия 15 мг × 7.8
    { good_id: 3, service_id: 9536380, amount: -1, cost: 2 },         // маска
    { good_id: 4, service_id: null, amount: -1, cost: 1.99 },         // перчатки — без услуги
  ],
  bonus_redeemed: 1000,
  payments: [{ amount: 27500, account_title: 'Расчетный счет' }],
};
const PRICES = { 1: 5267, 2: 7.8, 3: 2, 4: 1.99, 5: 0 };
const ctx = () => ({
  durations: new Map(), categories: new Map([['25013124', 100]]),
  priceFn: (goodId) => ({ price: PRICES[goodId] ?? 0, source: PRICES[goodId] ? 'receipt' : 'none' }),
  techCardFor: () => null,
  payRules: [{ id: 1, staff_yc_id: null, service_yc_id: null, category_yc_id: null, percent: 30, base: 'gross', fixed_per_visit: 0, valid_from: null, valid_to: null }],
  settings: { payroll_multiplier: 1.3, pay_base_includes_bonuses: false, acquiring: { 'Расчетный счет': 1.5 } },
});

describe('buildRows + finalizeRows на визите 2049113510', () => {
  const rows = C.buildRows(RECORD, ctx());
  C.finalizeRows(rows, { avgAcquiringRate: 0 });
  const [bel, btx] = rows;
  test('две строки, минуты поровну (длительностей нет), бонусы и перчатки по доле цены', () => {
    expect(rows).toHaveLength(2);
    expect(bel.minutes).toBe(30); expect(btx.minutes).toBe(30);
    expect(bel.bonus_redeemed).toBeCloseTo(818.18, 2); expect(btx.bonus_redeemed).toBeCloseTo(181.82, 2);
    expect(bel.revenue).toBeCloseTo(21681.82, 2); expect(btx.revenue).toBeCloseTo(4818.18, 2);
    expect(bel.discount).toBe(0);
  });
  test('материалы: факт по услуге + доля записи; у второй услуги только доля записи, но это факт (списания по записи есть)', () => {
    expect(bel.materials_fact).toBeCloseTo(5386 + 1.63, 2);
    expect(bel.materials_yc_cost).toBeCloseTo(5386 + 1.63, 2);
    expect(btx.materials_fact).toBeCloseTo(0.36, 2);
    expect(bel.materials_used).toBeCloseTo(5387.63, 2);
    expect(bel.materials_estimated).toBe(false);
    expect(btx.no_materials_data).toBe(false);
    expect(bel.has_consumables).toBe(true);
  });
  test('оплата врача 30 % gross × 1.3; категория берётся из ctx', () => {
    expect(bel.doctor_pay).toBeCloseTo(6504.55, 2);
    expect(bel.doctor_cost).toBeCloseTo(8455.91, 2);
    expect(btx.doctor_cost).toBeCloseTo(1879.09, 2);
    expect(bel.no_pay_rule).toBe(false);
    expect(btx.category_yc_id).toBe(100);
  });
  test('эквайринг по кассе 1.5 % от 27 500, деление по цене; не оценка', () => {
    expect(bel.acquiring_cost).toBeCloseTo(337.5, 2);
    expect(btx.acquiring_cost).toBeCloseTo(75, 2);
    expect(bel.acquiring_estimated).toBe(false);
  });
  test('маржинальная прибыль и %', () => {
    expect(bel.contribution).toBeCloseTo(7500.78, 2);
    expect(btx.contribution).toBeCloseTo(2863.73, 2);
    expect(bel.contribution_pct).toBeCloseTo(7500.78 / 21681.82, 4);
  });
});

describe('норма и флаги покрытия', () => {
  test('нет списаний + есть техкарта → materials_used = норма, estimated; нет ни того ни другого → 0 + no_materials_data', () => {
    const c = ctx();
    c.techCardFor = (sid) => (sid === 9536380 ? { items: [{ good_id: 1, amount: 1 }, { good_id: 5, amount: 2 }] } : null);
    const rows = C.buildRows({ ...RECORD, consumables: [] }, c);
    expect(rows[0].materials_norm).toBe(5267);
    expect(rows[0].materials_used).toBe(5267);
    expect(rows[0].materials_estimated).toBe(true);
    expect(rows[0].has_tech_card).toBe(true);
    expect(rows[0].no_price_goods).toEqual([5]);
    expect(rows[1].materials_used).toBe(0);
    expect(rows[1].no_materials_data).toBe(true);
  });
  test('нет правила оплаты → 0 и no_pay_rule', () => {
    const c = ctx(); c.payRules = [];
    const rows = C.buildRows(RECORD, c);
    expect(rows[0].doctor_cost).toBe(0);
    expect(rows[0].no_pay_rule).toBe(true);
  });
  test('нет оплат → эквайринг по средней доле периода, estimated', () => {
    const rows = C.buildRows({ ...RECORD, payments: [] }, ctx());
    C.finalizeRows(rows, { avgAcquiringRate: 0.012 });
    expect(rows[0].acquiring_estimated).toBe(true);
    expect(rows[0].acquiring_cost).toBeCloseTo(21681.82 * 0.012, 2);
  });
  test('avgAcquiringRate: Σ эквайринг / Σ выручка по строкам с оплатами', () => {
    const rows = C.buildRows(RECORD, ctx());
    expect(C.avgAcquiringRate(rows)).toBeCloseTo(412.5 / 26500, 6);
    expect(C.avgAcquiringRate([])).toBe(0);
  });
  test('длительности каталога делят минуты; нет услуг → []', () => {
    const c = ctx(); c.durations = new Map([['9536380', 2700], ['25013124', 900]]);
    const rows = C.buildRows(RECORD, c);
    expect(rows[0].minutes).toBe(45);
    expect(C.buildRows({ ...RECORD, services: [] }, c)).toEqual([]);
  });
});

describe('applyOverhead + aggregate', () => {
  function rowsFixture() {
    const rows = C.buildRows(RECORD, ctx());
    C.finalizeRows(rows, { avgAcquiringRate: 0 });
    return rows;
  }
  test('постоянные по минутам, аппарат только на свои услуги, УСН 15 % с положительной прибыли, прибыль/час', () => {
    const rows = rowsFixture();
    C.applyOverhead(rows, { driver: 'minutes', fixedTotal: 600, equipment: [{ id: 1, name: 'Laser', service_ids: [25013124], periodCost: 100 }], usnRate: 15 });
    expect(rows[0].overhead).toBe(300); expect(rows[1].overhead).toBe(300);
    expect(rows[0].equipment_cost).toBe(0); expect(rows[1].equipment_cost).toBe(100);
    expect(rows[0].operating_profit).toBeCloseTo(7500.78 - 300, 2);
    expect(rows[1].operating_profit).toBeCloseTo(2863.73 - 400, 2);
    expect(rows[0].usn_estimate).toBeCloseTo((7500.78 - 300) * 0.15, 2);
    expect(rows[0].profit_per_hour).toBeCloseTo(7500.78 / 0.5, 2);
  });
  test('драйвер visits — поровну; убыток → УСН 0', () => {
    const rows = rowsFixture();
    C.applyOverhead(rows, { driver: 'visits', fixedTotal: 20000, equipment: [], usnRate: 15 });
    expect(rows[0].overhead).toBe(10000);
    expect(rows[1].operating_profit).toBeLessThan(0);
    expect(rows[1].usn_estimate).toBe(0);
  });
  test('aggregate по услуге: суммы, визиты, флаги покрытия, проценты', () => {
    const rows = rowsFixture();
    C.applyOverhead(rows, { driver: 'minutes', fixedTotal: 0, equipment: [], usnRate: 15 });
    const g = C.aggregate(rows, r => r.service_yc_id, r => r.service_title);
    expect(g).toHaveLength(2);
    const bel = g.find(x => x.key === 9536380);
    expect(bel.label).toBe('Belotero lips contur 0,6 ml');
    expect(bel.visits).toBe(1);
    expect(bel.revenue).toBeCloseTo(21681.82, 2);
    expect(bel.materials_used).toBeCloseTo(5387.63, 2);
    expect(bel.materials_estimated_rows).toBe(0);
    expect(bel.contribution).toBeCloseTo(7500.78, 2);
    expect(bel.contribution_pct).toBeCloseTo(7500.78 / 21681.82, 4);
    expect(bel.hours).toBe(0.5);
    expect(bel.profit_per_hour).toBeCloseTo(15001.56, 2);
    expect(bel.coverage).toEqual({ rows: 1, with_consumables: 1, with_tech_card: 0, no_pay_rule: 0, no_price_goods: [], acquiring_estimated: 0 });
  });
  test('summary: ставки минуты (факт / при полной загрузке), простой, покрытие', () => {
    const rows = rowsFixture();
    C.applyOverhead(rows, { driver: 'minutes', fixedTotal: 600, equipment: [], usnRate: 15 });
    const s = C.summary(rows, { fixedTotal: 600, capacityMinutes: 120, driver: 'minutes', equipmentTotal: 0 });
    expect(s.minutes).toBe(60);
    expect(s.rate_minute_fact).toBe(10);
    expect(s.rate_minute_capacity).toBe(5);
    expect(s.idle_cost).toBe(300);                 // 600 − 5 × 60
    expect(s.visits).toBe(1);
    expect(s.revenue).toBeCloseTo(26500, 2);
    expect(s.coverage.consumables_share).toBe(1);
    expect(s.coverage.services_without_tech_card).toBe(2);
    expect(s.coverage.staff_without_pay_rule).toBe(0);
  });
});
```

- [ ] **Step 2: Запустить — падает**

Run: `cd /root/loyalpro/backend && npx jest economics-calc 2>&1 | tail -5`
Expected: FAIL (модуль не найден).

- [ ] **Step 3: Реализация**

```js
'use strict';
// Расчёт экономики по строке «запись × услуга» (§3 спеки). Чистый модуль.
const { splitByWeights, splitMinutes, allocate, r2 } = require('./allocation');
const { pickRule, doctorPay } = require('./pay-rules');
const { normCost } = require('./tech-cards');

const n = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

/** Одна запись → строки по услугам. Эквайринг без оплат считает finalizeRows (нужна средняя доля периода). */
function buildRows(record, ctx) {
  const services = (Array.isArray(record.services) ? record.services : [])
    .map(s => ({
      id: Number(s.id), title: String(s.title || ''),
      price: n(s.cost_to_pay !== undefined && s.cost_to_pay !== null ? s.cost_to_pay : s.cost),
      first_cost: n(s.first_cost !== undefined && s.first_cost !== null ? s.first_cost : s.cost),
    })).filter(s => s.id);
  if (!services.length) return [];
  const staffId = record.staff_yc_id != null ? Number(record.staff_yc_id) : null;
  const date = record.visit_date;
  const prices = services.map(s => s.price);
  const minutes = splitMinutes(record.seance_length, services.map(s => ctx.durations.get(String(s.id)) || 0));
  const bonusParts = splitByWeights(n(record.bonus_redeemed), prices);

  // Списания: по своей услуге или на запись (без service_id / чужой service_id) — по доле цены.
  const cons = Array.isArray(record.consumables) ? record.consumables : [];
  const hasCons = cons.length > 0;
  const own = new Map(services.map(s => [s.id, { fact: 0, yc: 0, noPrice: [] }]));
  const rec = { fact: 0, yc: 0, noPrice: [] };
  for (const t of cons) {
    const qty = Math.abs(n(t.amount));
    const p = ctx.priceFn(Number(t.good_id), date) || { price: 0 };
    const fact = qty * n(p.price);
    const target = own.get(Number(t.service_id)) || rec;
    target.fact += fact;
    target.yc += Math.abs(n(t.cost));
    if (!(n(p.price) > 0) && qty > 0) target.noPrice.push(Number(t.good_id));
  }
  const recFact = splitByWeights(rec.fact, prices);
  const recYc = splitByWeights(rec.yc, prices);

  // Эквайринг по кассам: только когда оплаты привязаны к записи.
  const payments = Array.isArray(record.payments) ? record.payments : [];
  const pct = (ctx.settings && ctx.settings.acquiring) || {};
  const acqTotal = payments.reduce((a, p) => a + n(p.amount) * (n(pct[p.account_title]) / 100), 0);
  const acqParts = splitByWeights(acqTotal, prices);

  return services.map((s, i) => {
    const o = own.get(s.id);
    const materials_fact = o.fact + recFact[i];
    const card = ctx.techCardFor(s.id, staffId);
    const norm = card ? normCost(card, ctx.priceFn, date) : null;
    const materials_norm = norm ? norm.cost : null;
    const materials_used = hasCons ? materials_fact : (norm ? norm.cost : 0);
    const bonus = bonusParts[i];
    const revenue = s.price - bonus;
    const categoryId = ctx.categories.has(String(s.id)) ? ctx.categories.get(String(s.id)) : null;
    const rule = pickRule(ctx.payRules || [], { staffId, serviceId: s.id, categoryId, date });
    const dp = doctorPay({ price: s.price, revenue, materials_used }, rule, ctx.settings || {});
    const noPriceGoods = [...new Set([...o.noPrice, ...rec.noPrice, ...(hasCons ? [] : (norm ? norm.noPrice : []))])];
    return {
      record_id: record.record_id, visit_date: date, staff_yc_id: staffId, staff_name: record.staff_name || '',
      service_yc_id: s.id, service_title: s.title, category_yc_id: categoryId,
      price: s.price, first_cost: s.first_cost, discount: Math.max(0, s.first_cost - s.price),
      minutes: minutes[i], hours: minutes[i] / 60,
      bonus_redeemed: bonus, revenue,
      materials_fact, materials_yc_cost: o.yc + recYc[i], materials_norm, materials_used,
      materials_estimated: !hasCons && !!norm, no_materials_data: !hasCons && !norm,
      has_consumables: hasCons, has_tech_card: !!card, no_price_goods: noPriceGoods,
      pay_rule_id: rule ? rule.id : null, pay_base: dp.base, doctor_pay: dp.pay, doctor_cost: dp.cost, no_pay_rule: dp.noRule,
      has_payments: payments.length > 0,
      acquiring_cost: payments.length ? acqParts[i] : null, acquiring_estimated: payments.length === 0,
      contribution: null, contribution_pct: null,
      overhead: 0, equipment_cost: 0, operating_profit: null, operating_pct: null, usn_estimate: 0, profit_per_hour: null,
    };
  });
}

/** Средняя доля эквайринга по строкам с привязанными оплатами (для оценки у остальных). */
function avgAcquiringRate(rows) {
  let acq = 0, rev = 0;
  for (const r of rows) if (r.has_payments) { acq += n(r.acquiring_cost); rev += n(r.revenue); }
  return rev > 0 ? acq / rev : 0;
}

/** Дооценка эквайринга и маржинальная прибыль. Мутирует rows. */
function finalizeRows(rows, { avgAcquiringRate: avg = 0 } = {}) {
  for (const r of rows) {
    if (r.acquiring_cost === null) r.acquiring_cost = r.revenue * n(avg);
    r.contribution = r.revenue - r.materials_used - r.doctor_cost - r.acquiring_cost;
    r.contribution_pct = r.revenue > 0 ? r.contribution / r.revenue : null;
  }
  return rows;
}

/** Постоянные расходы и аппараты по драйверу; операционная прибыль, УСН, прибыль/час. Мутирует rows. */
function applyOverhead(rows, { driver = 'minutes', fixedTotal = 0, equipment = [], usnRate = 15 } = {}) {
  const ov = allocate(rows, driver, n(fixedTotal));
  rows.forEach((r, i) => { r.overhead = ov[i]; r.equipment_cost = 0; });
  for (const eq of equipment || []) {
    const ids = new Set((eq.service_ids || []).map(Number));
    if (!ids.size || !(n(eq.periodCost) > 0)) continue;
    const parts = allocate(rows, driver, n(eq.periodCost), ids);
    rows.forEach((r, i) => { r.equipment_cost += parts[i]; });
  }
  for (const r of rows) {
    r.operating_profit = r.contribution - r.overhead - r.equipment_cost;
    r.operating_pct = r.revenue > 0 ? r.operating_profit / r.revenue : null;
    r.usn_estimate = Math.max(0, r.operating_profit) * n(usnRate) / 100;
    r.profit_per_hour = r.hours > 0 ? r.contribution / r.hours : null;
  }
  return rows;
}

const SUM_FIELDS = ['price', 'discount', 'bonus_redeemed', 'revenue', 'materials_fact', 'materials_yc_cost', 'materials_used',
  'doctor_pay', 'doctor_cost', 'acquiring_cost', 'contribution', 'overhead', 'equipment_cost', 'operating_profit', 'usn_estimate', 'minutes'];

/** Группировка строк (3.7). keyFn/labelFn — по услуге, по услуге×сотруднику и т.д. */
function aggregate(rows, keyFn, labelFn) {
  const groups = new Map();
  for (const r of rows) {
    const key = keyFn(r);
    let g = groups.get(key);
    if (!g) {
      g = { key, label: labelFn ? labelFn(r) : String(key), rows: 0, _records: new Set(),
        materials_norm: 0, materials_norm_rows: 0, materials_estimated_sum: 0, materials_estimated_rows: 0,
        coverage: { rows: 0, with_consumables: 0, with_tech_card: 0, no_pay_rule: 0, no_price_goods: new Set(), acquiring_estimated: 0 } };
      for (const f of SUM_FIELDS) g[f] = 0;
      groups.set(key, g);
    }
    g.rows++; g._records.add(r.record_id);
    for (const f of SUM_FIELDS) g[f] += n(r[f]);
    if (r.materials_norm !== null) { g.materials_norm += r.materials_norm; g.materials_norm_rows++; }
    if (r.materials_estimated) { g.materials_estimated_sum += r.materials_used; g.materials_estimated_rows++; }
    const c = g.coverage;
    c.rows++;
    if (r.has_consumables) c.with_consumables++;
    if (r.has_tech_card) c.with_tech_card++;
    if (r.no_pay_rule) c.no_pay_rule++;
    if (r.acquiring_estimated) c.acquiring_estimated++;
    for (const gid of r.no_price_goods || []) c.no_price_goods.add(gid);
  }
  return [...groups.values()].map(g => {
    const out = { ...g, visits: g._records.size, hours: g.minutes / 60 };
    delete out._records;
    out.contribution_pct = g.revenue > 0 ? g.contribution / g.revenue : null;
    out.operating_pct = g.revenue > 0 ? g.operating_profit / g.revenue : null;
    out.profit_per_hour = out.hours > 0 ? g.contribution / out.hours : null;
    out.coverage = { ...g.coverage, no_price_goods: [...g.coverage.no_price_goods].sort((a, b) => a - b) };
    for (const f of SUM_FIELDS) out[f] = r2(out[f]);
    out.materials_norm = r2(out.materials_norm); out.materials_estimated_sum = r2(out.materials_estimated_sum);
    return out;
  });
}

/** Сводка периода: ставки минуты, простой, покрытие. */
function summary(rows, { fixedTotal = 0, capacityMinutes = 0, driver = 'minutes', equipmentTotal = 0 } = {}) {
  const minutes = rows.reduce((a, r) => a + n(r.minutes), 0);
  const records = new Set(rows.map(r => r.record_id));
  const tot = {};
  for (const f of SUM_FIELDS) tot[f] = r2(rows.reduce((a, r) => a + n(r[f]), 0));
  const rateFact = minutes > 0 ? n(fixedTotal) / minutes : 0;
  const rateCap = capacityMinutes > 0 ? n(fixedTotal) / capacityMinutes : 0;
  const services = new Map();
  const staff = new Map();
  for (const r of rows) {
    const s = services.get(r.service_yc_id) || { tech: false, cons: 0, rows: 0 };
    s.tech = s.tech || r.has_tech_card; s.cons += r.has_consumables ? 1 : 0; s.rows++;
    services.set(r.service_yc_id, s);
    if (r.staff_yc_id != null) staff.set(r.staff_yc_id, (staff.get(r.staff_yc_id) || false) || !r.no_pay_rule);
  }
  const noPrice = new Set(); rows.forEach(r => (r.no_price_goods || []).forEach(g => noPrice.add(g)));
  return {
    ...tot, visits: records.size, rows: rows.length, minutes, hours: minutes / 60, driver,
    fixed_total: r2(n(fixedTotal)), equipment_total: r2(n(equipmentTotal)),
    rate_minute_fact: rateFact, rate_minute_capacity: rateCap, capacity_minutes: capacityMinutes,
    idle_cost: capacityMinutes > 0 ? r2(Math.max(0, n(fixedTotal) - rateCap * minutes)) : null,
    contribution_pct: tot.revenue > 0 ? tot.contribution / tot.revenue : null,
    operating_pct: tot.revenue > 0 ? tot.operating_profit / tot.revenue : null,
    coverage: {
      consumables_share: rows.length ? rows.filter(r => r.has_consumables).length / rows.length : 0,
      services_without_tech_card: [...services.values()].filter(s => !s.tech).length,
      services_total: services.size,
      goods_without_price: [...noPrice].sort((a, b) => a - b),
      staff_without_pay_rule: [...staff.values()].filter(ok => !ok).length,
      acquiring_estimated_share: rows.length ? rows.filter(r => r.acquiring_estimated).length / rows.length : 0,
    },
  };
}

module.exports = { buildRows, avgAcquiringRate, finalizeRows, applyOverhead, aggregate, summary, SUM_FIELDS };
```

- [ ] **Step 4: Запустить тесты**

Run: `cd /root/loyalpro/backend && npx jest economics-calc 2>&1 | tail -8`
Expected: PASS, все describe-блоки. Если расходятся сотые — проверить `splitByWeights` (остаток последней доле) и порядок операций, а не подгонять ожидания.

- [ ] **Step 5: Commit**

```bash
cd /root/loyalpro && git add backend/services/economics/calc.js backend/economics-calc.test.js && git commit -m "feat(economics): расчёт строки запись×услуга, эквайринг, overhead, агрегация и сводка"
```

---

### Task 11: `store.js` — загрузчики отчёта (SQL) и живой EXPLAIN

**Модель: Opus (L2).** SQL с `jsonb`, `LATERAL`, массивами id; вывод типов параметров проверяется только живым EXPLAIN с bound-параметрами (готча проекта).

**Files:**
- Modify: `backend/services/economics/store.js`
- Create: `backend/scripts/economics-explain.js`
- Test: `backend/economics-store.test.js` (дополнить)

- [ ] **Step 1: Падающий тест загрузчика**

```js
describe('loadPeriod', () => {
  test('собирает записи с consumables/payments, товары, карты, правила, настройки, бюджет, аппараты, мощность', async () => {
    db.any.mockImplementation(async (sql, params) => {
      if (/FROM records r/.test(sql)) return [{ record_id: '1', visit_date: '2026-09-10', staff_yc_id: '5', staff_name: 'A', seance_length: 3600,
        services: [{ id: 10, cost_to_pay: 1000 }], bonus_redeemed: '100' }];
      if (/FROM goods_transactions t WHERE t.salon_id = \$1 AND t.type_id = 2/.test(sql)) { expect(params[1]).toEqual([1]); return [{ record_id: '1', service_id: '10', good_id: '7', amount: '-1', cost: '50' }]; }
      if (/FROM revenue_operations/.test(sql)) return [{ record_id: '1', amount: '1000', account_title: 'Расчетный счет' }];
      if (/FROM tech_cards/.test(sql)) return [{ id: 3, yc_card_id: '36', title: 'C', items: [{ good_id: 8, amount: 2 }], source: 'yclients' }];
      if (/FROM service_tech_cards/.test(sql)) return [{ service_yc_id: '10', staff_yc_id: null, tech_card_id: 3, source: 'learned' }];
      if (/type_id = 3/.test(sql)) { expect(new Set(params[1])).toEqual(new Set([7, 8])); return [{ good_id: '7', create_date: new Date('2026-09-01T10:00:00Z'), amount: '2', cost: '100', operation_unit_type: 1 }]; }
      if (/FROM yclients_goods_catalog/.test(sql)) return [{ good_id: '7', title: 'G', unit_equals: '1', unit_actual_cost: '45' }];
      if (/FROM goods_price_overrides/.test(sql)) return [{ good_id: '8', unit_price: '9' }];
      if (/FROM staff_pay_rules/.test(sql)) return [{ id: 1, percent: '30', base: 'gross', fixed_per_visit: '0', valid_from: null, valid_to: null, staff_yc_id: null, service_yc_id: null, category_yc_id: null }];
      if (/FROM fixed_costs/.test(sql)) return [{ id: 1, category: 'rent', amount_month: '1000', month_from: '2026-01-01', month_to: null }];
      if (/FROM equipment/.test(sql)) return [{ id: 1, name: 'L', purchase_price: '100', purchase_date: '2025-01-01', useful_life_months: 60, residual_pct: '0', maintenance_monthly: '0', service_ids: [10], is_active: true }];
      return [];
    });
    db.oneOrNone.mockImplementation(async (sql) => {
      if (/FROM economics_settings/.test(sql)) return { payroll_multiplier: '1.3', pay_base_includes_bonuses: false, allocation_driver: 'minutes', usn_rate: '15', acquiring: { 'Расчетный счет': 1.5 } };
      if (/FROM staff_schedule/.test(sql)) return { minutes: '58415' };
      return null;
    });
    const d = await store.loadPeriod(1, '2026-09-01', '2026-09-30');
    expect(d.records).toHaveLength(1);
    const r = d.records[0];
    expect(r.record_id).toBe(1); expect(r.staff_yc_id).toBe(5); expect(r.bonus_redeemed).toBe(100);
    expect(r.consumables).toEqual([{ good_id: 7, service_id: 10, amount: -1, cost: 50 }]);
    expect(r.payments).toEqual([{ amount: 1000, account_title: 'Расчетный счет' }]);
    expect(d.receiptsByGood.get(7)).toHaveLength(1);
    expect(d.catalogByGood.get(7).unit_actual_cost).toBe(45);
    expect(d.overridesByGood.get(8).unit_price).toBe(9);
    expect(d.cards.get(3).title).toBe('C');
    expect(d.links[0].service_yc_id).toBe(10);
    expect(d.payRules[0].percent).toBe(30);
    expect(d.settings.payroll_multiplier).toBe(1.3);
    expect(d.fixedCosts[0].amount_month).toBe(1000);
    expect(d.equipment[0].service_ids).toEqual([10]);
    expect(d.capacityMinutes).toBe(58415);
  });
  test('пустой период и нет настроек → дефолты и пустые коллекции', async () => {
    db.any.mockResolvedValue([]); db.oneOrNone.mockResolvedValue(null);
    const d = await store.loadPeriod(1, '2026-09-01', '2026-09-30');
    expect(d.records).toEqual([]);
    expect(d.settings).toEqual(store.DEFAULT_SETTINGS);
    expect(d.capacityMinutes).toBe(0);
  });
});
```

- [ ] **Step 2: Запустить — падает**

Run: `cd /root/loyalpro/backend && npx jest economics-store 2>&1 | tail -5`
Expected: FAIL, `loadPeriod is not a function`.

- [ ] **Step 3: SQL и загрузчик в `store.js`**

```js
const DEFAULT_SETTINGS = Object.freeze({
  payroll_multiplier: 1.3, pay_base_includes_bonuses: false, allocation_driver: 'minutes', usn_rate: 15, acquiring: {},
});

// Состоявшиеся визиты периода: attendance=1, не удалены. Списания бонусов по записи — LATERAL.
const RECORDS_SQL = `
  SELECT r.yclients_record_id AS record_id,
         to_char(r.visit_date, 'YYYY-MM-DD') AS visit_date,
         NULLIF(r.staff->>'id','')::bigint AS staff_yc_id,
         COALESCE(r.staff->>'name', r.specialist_name, '') AS staff_name,
         COALESCE(NULLIF(r.raw_payload->>'seance_length','')::int, 0) AS seance_length,
         COALESCE(r.services, '[]'::jsonb) AS services,
         COALESCE(b.bonus_redeemed, 0) AS bonus_redeemed
  FROM records r
  LEFT JOIN LATERAL (
    SELECT SUM(ABS(t.amount)) AS bonus_redeemed FROM loyalty_card_transactions t
    WHERE t.salon_id = r.salon_id AND t.record_id = r.yclients_record_id AND t.type = 'redemption'
  ) b ON TRUE
  WHERE r.salon_id = $1 AND r.visit_date BETWEEN $2::date AND $3::date
    AND r.raw_payload->>'attendance' = '1'
    AND COALESCE(r.status, '') <> 'deleted'
    AND COALESCE(r.raw_payload->>'deleted', 'false') <> 'true'
  ORDER BY r.visit_date, r.yclients_record_id`;

const CONSUMABLES_SQL = `
  SELECT t.record_id, t.service_id, t.good_id, t.good_title, t.amount, t.cost, t.cost_per_unit, t.unit_title
  FROM goods_transactions t WHERE t.salon_id = $1 AND t.type_id = 2 AND t.deleted_at IS NULL
    AND t.record_id = ANY($2::bigint[])
  ORDER BY t.record_id, t.yclients_txn_id`;

const PAYMENTS_SQL = `
  SELECT yclients_record_id AS record_id, amount, account_title
  FROM revenue_operations WHERE salon_id = $1 AND category = 'services' AND yclients_record_id = ANY($2::bigint[])`;

const RECEIPTS_SQL = `
  SELECT good_id, create_date, amount, cost, operation_unit_type
  FROM goods_transactions WHERE salon_id = $1 AND type_id = 3 AND deleted_at IS NULL AND amount > 0
    AND good_id = ANY($2::bigint[]) AND create_date < ($3::date + 1)
  ORDER BY good_id, create_date DESC`;

const CATALOG_SQL = `
  SELECT yclients_good_id AS good_id, title, unit, service_unit, unit_equals, actual_cost, unit_actual_cost, last_receipt_price, last_receipt_at
  FROM yclients_goods_catalog WHERE salon_id = $1 AND yclients_good_id = ANY($2::bigint[])`;

const OVERRIDES_SQL = `SELECT good_id, unit_price, note FROM goods_price_overrides WHERE salon_id = $1`;
const CARDS_SQL = `SELECT id, yc_card_id, title, items, source, synced_at, updated_at FROM tech_cards WHERE salon_id = $1`;
const LINKS_SQL = `SELECT service_yc_id, staff_yc_id, tech_card_id, source, updated_at FROM service_tech_cards WHERE salon_id = $1`;
const PAY_RULES_SQL = `
  SELECT id, staff_yc_id, service_yc_id, category_yc_id, percent, base, fixed_per_visit,
         to_char(valid_from, 'YYYY-MM-DD') AS valid_from, to_char(valid_to, 'YYYY-MM-DD') AS valid_to, note
  FROM staff_pay_rules WHERE salon_id = $1 ORDER BY id`;
const SETTINGS_SQL = `SELECT payroll_multiplier, pay_base_includes_bonuses, allocation_driver, usn_rate, acquiring FROM economics_settings WHERE salon_id = $1`;
const FIXED_SQL = `
  SELECT id, category, title, amount_month, to_char(month_from, 'YYYY-MM-DD') AS month_from, to_char(month_to, 'YYYY-MM-DD') AS month_to, note
  FROM fixed_costs WHERE salon_id = $1 ORDER BY month_from, id`;
const EQUIPMENT_SQL = `
  SELECT id, name, purchase_price, to_char(purchase_date, 'YYYY-MM-DD') AS purchase_date, useful_life_months, residual_pct,
         maintenance_monthly, service_ids, is_active, note
  FROM equipment WHERE salon_id = $1 ORDER BY id`;
const CAPACITY_SQL = `SELECT COALESCE(SUM(work_minutes), 0) AS minutes FROM staff_schedule WHERE salon_id = $1 AND date BETWEEN $2::date AND $3::date`;

const N = (v) => (v === null || v === undefined ? null : Number(v));
const toInt = (v) => (v === null || v === undefined ? null : Number(v));

function normSettings(s) {
  if (!s) return { ...DEFAULT_SETTINGS };
  return {
    payroll_multiplier: N(s.payroll_multiplier) || DEFAULT_SETTINGS.payroll_multiplier,
    pay_base_includes_bonuses: !!s.pay_base_includes_bonuses,
    allocation_driver: s.allocation_driver === 'visits' ? 'visits' : 'minutes',
    usn_rate: N(s.usn_rate) ?? DEFAULT_SETTINGS.usn_rate,
    acquiring: s.acquiring && typeof s.acquiring === 'object' ? s.acquiring : {},
  };
}

/** Всё, что нужно отчёту за период, одним проходом. Типы приведены к числам. */
async function loadPeriod(salonId, from, to) {
  const recs = await db.any(RECORDS_SQL, [salonId, from, to]);
  const ids = recs.map(r => toInt(r.record_id));
  const [cons, pays] = ids.length
    ? await Promise.all([db.any(CONSUMABLES_SQL, [salonId, ids]), db.any(PAYMENTS_SQL, [salonId, ids])])
    : [[], []];
  const consBy = new Map(); const paysBy = new Map();
  for (const c of cons) { const k = toInt(c.record_id); if (!consBy.has(k)) consBy.set(k, []); consBy.get(k).push({ good_id: toInt(c.good_id), service_id: toInt(c.service_id), amount: N(c.amount), cost: N(c.cost) }); }
  for (const p of pays) { const k = toInt(p.record_id); if (!paysBy.has(k)) paysBy.set(k, []); paysBy.get(k).push({ amount: N(p.amount), account_title: p.account_title || '' }); }
  const records = recs.map(r => ({
    record_id: toInt(r.record_id), visit_date: r.visit_date, staff_yc_id: toInt(r.staff_yc_id), staff_name: r.staff_name || '',
    seance_length: Number(r.seance_length) || 0, services: Array.isArray(r.services) ? r.services : [],
    bonus_redeemed: N(r.bonus_redeemed) || 0, consumables: consBy.get(toInt(r.record_id)) || [], payments: paysBy.get(toInt(r.record_id)) || [],
  }));

  const [cardRows, linkRows, payRuleRows, settingsRow, fixedRows, eqRows, capRow, overrideRows] = await Promise.all([
    db.any(CARDS_SQL, [salonId]), db.any(LINKS_SQL, [salonId]), db.any(PAY_RULES_SQL, [salonId]),
    db.oneOrNone(SETTINGS_SQL, [salonId]), db.any(FIXED_SQL, [salonId]), db.any(EQUIPMENT_SQL, [salonId]),
    db.oneOrNone(CAPACITY_SQL, [salonId, from, to]), db.any(OVERRIDES_SQL, [salonId]),
  ]);
  const cards = new Map(cardRows.map(c => [c.id, { ...c, yc_card_id: toInt(c.yc_card_id), items: Array.isArray(c.items) ? c.items : [] }]));
  const links = linkRows.map(l => ({ ...l, service_yc_id: toInt(l.service_yc_id), staff_yc_id: toInt(l.staff_yc_id) }));

  const goodIds = new Set();
  for (const c of cons) if (c.good_id) goodIds.add(toInt(c.good_id));
  for (const card of cards.values()) for (const it of card.items) if (it && it.good_id) goodIds.add(Number(it.good_id));
  const goodList = [...goodIds];
  const [receiptRows, catalogRows] = goodList.length
    ? await Promise.all([db.any(RECEIPTS_SQL, [salonId, goodList, to]), db.any(CATALOG_SQL, [salonId, goodList])])
    : [[], []];
  const receiptsByGood = new Map();
  for (const r of receiptRows) { const k = toInt(r.good_id); if (!receiptsByGood.has(k)) receiptsByGood.set(k, []); receiptsByGood.get(k).push({ create_date: r.create_date, amount: N(r.amount), cost: N(r.cost), operation_unit_type: toInt(r.operation_unit_type) }); }
  const catalogByGood = new Map(catalogRows.map(c => [toInt(c.good_id), { ...c, good_id: toInt(c.good_id), unit_equals: N(c.unit_equals), unit_actual_cost: N(c.unit_actual_cost), actual_cost: N(c.actual_cost), last_receipt_price: N(c.last_receipt_price) }]));
  const overridesByGood = new Map(overrideRows.map(o => [toInt(o.good_id), { unit_price: N(o.unit_price), note: o.note }]));

  return {
    from, to, records, cards, links, receiptsByGood, catalogByGood, overridesByGood,
    payRules: payRuleRows.map(r => ({ ...r, staff_yc_id: toInt(r.staff_yc_id), service_yc_id: toInt(r.service_yc_id), category_yc_id: toInt(r.category_yc_id), percent: N(r.percent), fixed_per_visit: N(r.fixed_per_visit) })),
    settings: normSettings(settingsRow),
    fixedCosts: fixedRows.map(f => ({ ...f, amount_month: N(f.amount_month) })),
    equipment: eqRows.map(e => ({ ...e, purchase_price: N(e.purchase_price), residual_pct: N(e.residual_pct), maintenance_monthly: N(e.maintenance_monthly), service_ids: Array.isArray(e.service_ids) ? e.service_ids.map(Number) : [] })),
    capacityMinutes: capRow ? Number(capRow.minutes) || 0 : 0,
  };
}
```
Экспортировать `loadPeriod, normSettings, DEFAULT_SETTINGS` и все `*_SQL`.

- [ ] **Step 4: Запустить тесты**

Run: `cd /root/loyalpro/backend && npx jest economics-store 2>&1 | tail -5`
Expected: PASS.

- [ ] **Step 5: Скрипт живого EXPLAIN**

`backend/scripts/economics-explain.js`:

```js
#!/usr/bin/env node
'use strict';
// Живой EXPLAIN ANALYZE SQL отчёта экономики с НАСТОЯЩИМИ bound-параметрами
// (готча проекта: литералы не ловят вывод типов $N) + замер loadPeriod.
//   node scripts/economics-explain.js [salonId] [--from=YYYY-MM-DD] [--to=YYYY-MM-DD] [--plan]
// Порог спеки: отчёт за квартал ≤ 1 с. В БД ничего не пишет.
const { db, pool } = require('../db');
const S = require('../services/economics/store');

const args = process.argv.slice(2);
const salonId = Number(args.find(a => /^\d+$/.test(a)) || 1);
const opt = name => { const a = args.find(x => x.startsWith(`--${name}=`)); return a ? a.slice(name.length + 3) : null; };
const msk = (shift = 0) => new Date(Date.now() + shift * 86400e3).toLocaleDateString('sv-SE', { timeZone: 'Europe/Moscow' });
const to = opt('to') || msk(0);
const from = opt('from') || msk(-89);

async function explain(label, sql, params) {
  const plan = await db.any('EXPLAIN (ANALYZE, BUFFERS) ' + sql, params);
  const lines = plan.map(r => r['QUERY PLAN']);
  console.log(`${label}: ${lines.find(l => /^Execution Time/.test(l))}`);
  if (args.includes('--plan')) console.log(lines.join('\n'));
}

(async () => {
  console.log(`salon ${salonId}, период ${from}..${to}`);
  await explain('RECORDS_SQL', S.RECORDS_SQL, [salonId, from, to]);
  const recs = await db.any(S.RECORDS_SQL, [salonId, from, to]);
  const ids = recs.map(r => Number(r.record_id));
  if (ids.length) {
    await explain('CONSUMABLES_SQL', S.CONSUMABLES_SQL, [salonId, ids]);
    await explain('PAYMENTS_SQL', S.PAYMENTS_SQL, [salonId, ids]);
  }
  const goods = await db.any('SELECT DISTINCT good_id FROM goods_transactions WHERE salon_id=$1 AND good_id IS NOT NULL', [salonId]);
  await explain('RECEIPTS_SQL', S.RECEIPTS_SQL, [salonId, goods.map(g => Number(g.good_id)), to]);
  await explain('CAPACITY_SQL', S.CAPACITY_SQL, [salonId, from, to]);
  const t = Date.now();
  const d = await S.loadPeriod(salonId, from, to);
  const ms = Date.now() - t;
  console.log(`loadPeriod: ${d.records.length} записей, ${d.records.reduce((a, r) => a + r.consumables.length, 0)} списаний, ${d.cards.size} карт, ${d.links.length} привязок — ${ms} мс`);
  if (ms > 1000) { console.error('ПРЕВЫШЕН порог 1 с'); process.exitCode = 1; }
  await pool.end();
})().catch(e => { console.error(e); process.exit(1); });
```

- [ ] **Step 6: Прогнать на деве за месяц и квартал**

Run: `cd /root/loyalpro/backend && node scripts/economics-explain.js 1 --from=2026-09-01 --to=2026-09-30 && node scripts/economics-explain.js 1 --from=2026-07-01 --to=2026-09-30`
Expected: все EXPLAIN без ошибок типов (это главная проверка), `loadPeriod` < 1000 мс на квартале. Если `RECORDS_SQL` идёт Seq Scan по `records` дольше 300 мс — добавить в миграции `CREATE INDEX IF NOT EXISTS idx_records_salon_visit ON records (salon_id, visit_date)` и повторить.

- [ ] **Step 7: Commit**

```bash
cd /root/loyalpro && git add backend/services/economics/store.js backend/economics-store.test.js backend/scripts/economics-explain.js && git commit -m "feat(economics): загрузчики отчёта за период + живой EXPLAIN с bound-параметрами"
```

---

### Task 12: `report.js` — склейка, кэш 60 с, детализация, покрытие

**Модель: Opus (L2).**

**Files:**
- Create: `backend/services/economics/report.js`
- Test: `backend/economics-report.test.js`

- [ ] **Step 1: Падающий тест**

```js
'use strict';
jest.mock('./services/economics/store', () => ({ loadPeriod: jest.fn() }));
jest.mock('./services/yclients', () => ({ ycGetServiceMeta: jest.fn(), ycGetServiceCatalog: jest.fn() }));
const mockLog = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
jest.mock('./logger', () => ({ createLogger: () => mockLog }));
const store = require('./services/economics/store');
const yc = require('./services/yclients');
const report = require('./services/economics/report');

const SALON = { id: 1, yclients_company_id: '668791' };
function period() {
  return {
    from: '2026-09-01', to: '2026-09-30',
    records: [{ record_id: 1, visit_date: '2026-09-10', staff_yc_id: 5, staff_name: 'A', seance_length: 3600,
      services: [{ id: 10, title: 'S10', cost_to_pay: 1000, first_cost: 1000 }], bonus_redeemed: 0,
      consumables: [{ good_id: 7, service_id: 10, amount: -2, cost: 90 }], payments: [] }],
    cards: new Map([[3, { id: 3, title: 'C', items: [{ good_id: 8, amount: 1 }], source: 'yclients' }]]),
    links: [{ service_yc_id: 11, staff_yc_id: null, tech_card_id: 3, source: 'learned' }],
    receiptsByGood: new Map([[7, [{ create_date: '2026-09-01T10:00:00Z', amount: 2, cost: 100, operation_unit_type: 2 }]]]),
    catalogByGood: new Map([[7, { unit_equals: 1, unit_actual_cost: 45 }], [8, { unit_actual_cost: 12 }]]),
    overridesByGood: new Map(),
    payRules: [{ id: 1, staff_yc_id: null, service_yc_id: null, category_yc_id: null, percent: 10, base: 'gross', fixed_per_visit: 0, valid_from: null, valid_to: null }],
    settings: { payroll_multiplier: 1, pay_base_includes_bonuses: false, allocation_driver: 'minutes', usn_rate: 15, acquiring: {} },
    fixedCosts: [{ id: 1, category: 'rent', amount_month: 3000, month_from: '2026-01-01', month_to: null }],
    equipment: [], capacityMinutes: 600,
  };
}
beforeEach(() => {
  jest.clearAllMocks(); report.invalidate();
  store.loadPeriod.mockImplementation(async () => period());
  yc.ycGetServiceMeta.mockResolvedValue({ durationByService: new Map([['10', 3600]]) });
  yc.ycGetServiceCatalog.mockResolvedValue({ priced: [{ id: 10, title: 'S10 full', category_id: 100 }, { id: 11, title: 'S11', category_id: 100 }] });
});

test('buildReport: строки, услуги, услуга×сотрудник, сводка; цена по приходу; постоянные за месяц целиком', async () => {
  const r = await report.buildReport(SALON, '2026-09-01', '2026-09-30');
  expect(r.rows).toHaveLength(1);
  expect(r.rows[0].materials_fact).toBe(100);           // 2 × 50 (приход 100/2)
  expect(r.rows[0].doctor_cost).toBe(100);
  expect(r.rows[0].overhead).toBe(3000);
  expect(r.byService[0].key).toBe(10);
  expect(r.byServiceStaff[0].key).toBe('10|5');
  expect(r.summary.rate_minute_fact).toBe(50);
  expect(r.summary.rate_minute_capacity).toBe(5);
  expect(r.summary.coverage.services_without_tech_card).toBe(1);
});
test('кэш 60 с на ключ salon+from+to; invalidate сбрасывает', async () => {
  await report.buildReport(SALON, '2026-09-01', '2026-09-30');
  await report.buildReport(SALON, '2026-09-01', '2026-09-30');
  expect(store.loadPeriod).toHaveBeenCalledTimes(1);
  report.invalidate(1);
  await report.buildReport(SALON, '2026-09-01', '2026-09-30');
  expect(store.loadPeriod).toHaveBeenCalledTimes(2);
});
test('сбой каталога YClients не роняет отчёт (длительности/категории пустые)', async () => {
  yc.ycGetServiceMeta.mockRejectedValue(new Error('429')); yc.ycGetServiceCatalog.mockRejectedValue(new Error('429'));
  const r = await report.buildReport(SALON, '2026-09-01', '2026-09-30');
  expect(r.rows[0].minutes).toBe(60);
  expect(mockLog.warn).toHaveBeenCalled();
});
test('serviceDetail: статьи, по сотрудникам, визиты; неизвестная услуга → null', async () => {
  const d = await report.serviceDetail(SALON, 10, '2026-09-01', '2026-09-30');
  expect(d.service.label).toBe('S10');
  expect(d.byStaff[0].label).toBe('A');
  expect(d.visits[0].record_id).toBe(1);
  expect(await report.serviceDetail(SALON, 999, '2026-09-01', '2026-09-30')).toBeNull();
});
test('coverage: услуги периода с покрытием, техкартой и подсказками по названию', async () => {
  const c = await report.coverage(SALON, '2026-09-01', '2026-09-30');
  expect(c.services).toEqual([expect.objectContaining({ service_yc_id: 10, title: 'S10', visits: 1, consumables_share: 1, tech_card: null, suggestions: [] })]);
  expect(c.cards).toHaveLength(1);
});
```

- [ ] **Step 2: Запустить — падает**

Run: `cd /root/loyalpro/backend && npx jest economics-report 2>&1 | tail -5`
Expected: FAIL.

- [ ] **Step 3: Реализация**

```js
'use strict';
// Склейка отчёта: store.loadPeriod → calc → aggregate. Кэш 60 с на ключ
// salon+from+to: один отчёт открывают несколько раз подряд (вкладки, детализация).
// Отчёт никогда не падает из-за отсутствия справочников: пустые правила/бюджет/
// аппараты и недоступный каталог YClients дают нули и флаги, не ошибку.
const store = require('./store');
const calc = require('./calc');
const { unitPriceAsOf } = require('./price');
const { pickTechCard, suggestLinks } = require('./tech-cards');
const { periodFixedCosts, equipmentPeriodCost } = require('./allocation');
const { ycGetServiceMeta, ycGetServiceCatalog } = require('../yclients');
const { createLogger } = require('../../logger');
const logger = createLogger('EconomicsReport');

const TTL_MS = 60_000;
const _cache = new Map();   // `${salonId}|${from}|${to}` → { ts, data }

function invalidate(salonId) {
  if (salonId === undefined) { _cache.clear(); return; }
  for (const k of [..._cache.keys()]) if (k.startsWith(`${salonId}|`)) _cache.delete(k);
}

/** Длительности, категории и названия услуг из каталога YClients; сбой → пустые карты + WARN. */
async function loadServiceMeta(salon) {
  const out = { durations: new Map(), categories: new Map(), titles: new Map(), staffByService: new Map() };
  try {
    const meta = await ycGetServiceMeta(salon);
    if (meta && meta.durationByService) out.durations = meta.durationByService;
  } catch (e) { logger.warn(`service meta: ${e.message}`); }
  try {
    const cat = await ycGetServiceCatalog(salon);
    for (const s of (cat && cat.priced) || []) {
      out.categories.set(String(s.id), s.category_id != null ? Number(s.category_id) : null);
      out.titles.set(String(s.id), s.title || '');
    }
    if (cat && cat.staffIdsByService) out.staffByService = cat.staffIdsByService;
  } catch (e) { logger.warn(`service catalog: ${e.message}`); }
  return out;
}

function buildCtx(data, meta) {
  const priceMemo = new Map();
  const priceFn = (goodId, date) => {
    const k = `${goodId}|${date}`;
    if (!priceMemo.has(k)) priceMemo.set(k, unitPriceAsOf({
      receipts: data.receiptsByGood.get(Number(goodId)) || [], override: data.overridesByGood.get(Number(goodId)) || null,
      catalogRow: data.catalogByGood.get(Number(goodId)) || null, date }));
    return priceMemo.get(k);
  };
  const techCardFor = (serviceId, staffId) => {
    const link = pickTechCard(data.links, serviceId, staffId);
    return link ? data.cards.get(link.tech_card_id) || null : null;
  };
  return { durations: meta.durations, categories: meta.categories, priceFn, techCardFor, payRules: data.payRules, settings: data.settings };
}

async function compute(salon, from, to) {
  const data = await store.loadPeriod(salon.id, from, to);
  const meta = await loadServiceMeta(salon);
  const ctx = buildCtx(data, meta);
  const rows = data.records.flatMap(rec => calc.buildRows(rec, ctx));
  calc.finalizeRows(rows, { avgAcquiringRate: calc.avgAcquiringRate(rows) });
  const fixed = periodFixedCosts(data.fixedCosts, from, to);
  const equipment = data.equipment.map(eq => ({ id: eq.id, name: eq.name, service_ids: eq.service_ids, periodCost: equipmentPeriodCost(eq, from, to) }));
  const driver = data.settings.allocation_driver;
  calc.applyOverhead(rows, { driver, fixedTotal: fixed.total, equipment, usnRate: data.settings.usn_rate });
  const equipmentTotal = equipment.reduce((a, e) => a + e.periodCost, 0);
  const byService = calc.aggregate(rows, r => r.service_yc_id, r => r.service_title).sort((a, b) => b.revenue - a.revenue);
  const byServiceStaff = calc.aggregate(rows, r => `${r.service_yc_id}|${r.staff_yc_id}`, r => `${r.service_title} — ${r.staff_name}`)
    .map(g => ({ ...g, service_yc_id: Number(g.key.split('|')[0]), staff_yc_id: Number(g.key.split('|')[1]) || null }));
  const summary = { ...calc.summary(rows, { fixedTotal: fixed.total, capacityMinutes: data.capacityMinutes, driver, equipmentTotal }),
    fixed_by_category: fixed.byCategory, equipment: equipment.map(e => ({ id: e.id, name: e.name, period_cost: e.periodCost })) };
  return { from, to, rows, byService, byServiceStaff, summary, settings: data.settings, meta, data };
}

async function buildReport(salon, from, to, { force = false } = {}) {
  const key = `${salon.id}|${from}|${to}`;
  const hit = _cache.get(key);
  if (!force && hit && Date.now() - hit.ts < TTL_MS) return hit.data;
  const data = await compute(salon, from, to);
  _cache.set(key, { ts: Date.now(), data });
  return data;
}

/** Детализация услуги: статьи, по сотрудникам, визиты со строками и флагами. */
async function serviceDetail(salon, serviceId, from, to) {
  const r = await buildReport(salon, from, to);
  const sid = Number(serviceId);
  const rows = r.rows.filter(x => x.service_yc_id === sid);
  if (!rows.length) return null;
  const [service] = calc.aggregate(rows, () => sid, x => x.service_title);
  const byStaff = calc.aggregate(rows, x => x.staff_yc_id, x => x.staff_name).sort((a, b) => b.revenue - a.revenue);
  const visits = rows.map(x => ({
    record_id: x.record_id, visit_date: x.visit_date, staff_name: x.staff_name, price: x.price, discount: x.discount, bonus_redeemed: x.bonus_redeemed,
    revenue: x.revenue, materials_used: x.materials_used, materials_fact: x.materials_fact, materials_norm: x.materials_norm, materials_yc_cost: x.materials_yc_cost,
    materials_estimated: x.materials_estimated, no_materials_data: x.no_materials_data, no_price_goods: x.no_price_goods,
    doctor_cost: x.doctor_cost, no_pay_rule: x.no_pay_rule, acquiring_cost: x.acquiring_cost, acquiring_estimated: x.acquiring_estimated,
    contribution: x.contribution, overhead: x.overhead, equipment_cost: x.equipment_cost, operating_profit: x.operating_profit, minutes: x.minutes,
  })).sort((a, b) => b.visit_date.localeCompare(a.visit_date) || b.record_id - a.record_id);
  return { service, byStaff, visits, settings: r.settings };
}

/** Покрытие техкартами: услуги периода, доля визитов со списаниями, привязка, подсказки. */
async function coverage(salon, from, to) {
  const r = await buildReport(salon, from, to);
  const cards = [...r.data.cards.values()].map(c => ({ id: c.id, yc_card_id: c.yc_card_id, title: c.title, source: c.source, items: c.items }));
  const byService = new Map();
  for (const x of r.rows) {
    const s = byService.get(x.service_yc_id) || { service_yc_id: x.service_yc_id, title: x.service_title, visits: new Set(), cons: 0, rows: 0, staff: new Set() };
    s.visits.add(x.record_id); s.rows++; if (x.has_consumables) s.cons++; if (x.staff_yc_id != null) s.staff.add(x.staff_yc_id);
    byService.set(x.service_yc_id, s);
  }
  const services = [...byService.values()].map(s => {
    const link = pickTechCard(r.data.links, s.service_yc_id, null) || r.data.links.find(l => l.service_yc_id === s.service_yc_id) || null;
    const card = link ? r.data.cards.get(link.tech_card_id) : null;
    const sugg = card ? [] : suggestLinks(cards, [{ id: s.service_yc_id, title: s.title }]);
    return { service_yc_id: s.service_yc_id, title: s.title, visits: s.visits.size, consumables_share: s.rows ? s.cons / s.rows : 0,
      staff_yc_ids: [...s.staff], tech_card: card ? { id: card.id, title: card.title, source: link.source, staff_yc_id: link.staff_yc_id, items: card.items } : null,
      suggestions: sugg };
  }).sort((a, b) => b.visits - a.visits);
  return { services, cards };
}

module.exports = { buildReport, serviceDetail, coverage, invalidate, loadServiceMeta, TTL_MS };
```

- [ ] **Step 4: Запустить тесты**

Run: `cd /root/loyalpro/backend && npx jest economics-report 2>&1 | tail -5`
Expected: PASS, 5 tests.

- [ ] **Step 5: Живая проверка на деве (read-only)**

Run:
```bash
cd /root/loyalpro/backend && node -e "
const { db, pool } = require('./db'); const R = require('./services/economics/report');
(async () => { const s = await db.oneOrNone('SELECT * FROM salons WHERE id=1'); const t = Date.now();
const r = await R.buildReport(s, '2026-09-01', '2026-09-30');
console.log('rows', r.rows.length, 'services', r.byService.length, Date.now()-t, 'ms');
console.log(r.byService.slice(0,5).map(g => [g.label, g.visits, g.revenue, g.materials_used, g.contribution]));
console.log('summary', JSON.stringify(r.summary.coverage)); await pool.end(); })()"
```
Expected: ~315 строк за сентябрь, топ-5 услуг с ненулевой выручкой; `materials_used` > 0 у услуг со списаниями (после догона задачи 6); время < 1 с.

- [ ] **Step 6: Commit**

```bash
cd /root/loyalpro && git add backend/services/economics/report.js backend/economics-report.test.js && git commit -m "feat(economics): отчёт за период — склейка, кэш 60 с, детализация услуги, покрытие техкартами"
```

> **РЕВЬЮ-ЧЕКПОИНТ 1 (Fable, инлайн):** после задачи 12 прогнать `npx jest economics` и `/code-review` по диффу задач 2–12. Особое внимание: деление с остатком в `splitByWeights`, сравнение дат по Москве в `price.js`, `COALESCE(staff_yc_id,0)` в UNIQUE и `ON CONFLICT` в `upsertServiceTechCard`, приоритет `manual` в привязках, флаги `estimated`/`no_materials_data`.

---

### Task 13: `routes/economics.js` — API этапа 1 (owner)

**Модель: Sonnet (L1).** CRUD по образцу `routes/reminders.js` (`parseRuleBody` вынесена наружу ради теста без HTTP).

**Files:**
- Create: `backend/routes/economics.js`
- Modify: `backend/services/economics/store.js` (CRUD-функции), `backend/services/economics/sync.js` (`runNightly`, `isRunning`), `backend/routes/index.js`
- Test: `backend/economics-routes.test.js`

- [ ] **Step 1: Падающий тест валидации**

```js
'use strict';
// Роутер тянет store → db, report → yclients, логгер: всё мокаем, тестируем только парсеры.
jest.mock('./db', () => ({ db: { one: jest.fn(), oneOrNone: jest.fn(), query: jest.fn(), any: jest.fn() }, pool: {} }));
jest.mock('./services/yclients', () => ({ ycGet: jest.fn(), ycGetServiceMeta: jest.fn(), ycGetServiceCatalog: jest.fn() }));
jest.mock('./logger', () => ({ createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }) }));
const { parsePayRule, parseSettings, parsePriceBody, parseManualCard, parsePeriodDays } = require('./routes/economics');

describe('parsePayRule', () => {
  const ok = { staffYcId: 5, serviceYcId: null, categoryYcId: null, percent: 30, base: 'gross', fixedPerVisit: 0, validFrom: '2026-01-01', validTo: null, note: '' };
  test('валидное тело', () => {
    expect(parsePayRule(ok).value).toEqual({ staff_yc_id: 5, service_yc_id: null, category_yc_id: null, percent: 30, base: 'gross', fixed_per_visit: 0, valid_from: '2026-01-01', valid_to: null, note: '' });
  });
  test('процент 0–100, база из списка, фикс ≥ 0, даты календарные, from ≤ to', () => {
    expect(parsePayRule({ ...ok, percent: 101 }).error).toMatch(/0–100/);
    expect(parsePayRule({ ...ok, base: 'net' }).error).toMatch(/база/i);
    expect(parsePayRule({ ...ok, fixedPerVisit: -1 }).error).toMatch(/фикс/i);
    expect(parsePayRule({ ...ok, validFrom: '2026-02-30' }).error).toMatch(/дата/i);
    expect(parsePayRule({ ...ok, validFrom: '2026-05-01', validTo: '2026-04-01' }).error).toMatch(/период/i);
    expect(parsePayRule({ ...ok, serviceYcId: 10, categoryYcId: 100 }).error).toMatch(/услуг.*категори|категори.*услуг/i);
  });
});

describe('parseSettings', () => {
  test('множитель 1–3, драйвер из списка, УСН 0–50, эквайринг {касса: 0–10}', () => {
    const r = parseSettings({ payrollMultiplier: 1.494, payBaseIncludesBonuses: true, allocationDriver: 'visits', usnRate: 15, acquiring: { 'Расчетный счет': 1.5, 'Основная касса': 0 } });
    expect(r.value).toEqual({ payroll_multiplier: 1.494, pay_base_includes_bonuses: true, allocation_driver: 'visits', usn_rate: 15, acquiring: { 'Расчетный счет': 1.5, 'Основная касса': 0 } });
    expect(parseSettings({ payrollMultiplier: 0.5 }).error).toBeTruthy();
    expect(parseSettings({ payrollMultiplier: 1.3, allocationDriver: 'revenue' }).error).toBeTruthy();
    expect(parseSettings({ payrollMultiplier: 1.3, allocationDriver: 'minutes', usnRate: 15, acquiring: { 'X': 11 } }).error).toBeTruthy();
    expect(parseSettings({ payrollMultiplier: 1.3, allocationDriver: 'minutes', usnRate: 15, acquiring: [] }).error).toBeTruthy();
  });
});

describe('parsePriceBody / parseManualCard / parsePeriodDays', () => {
  test('цена: число > 0 или null (снять)', () => {
    expect(parsePriceBody({ unitPrice: '12.5' }).value).toBe(12.5);
    expect(parsePriceBody({ unitPrice: null }).value).toBeNull();
    expect(parsePriceBody({ unitPrice: -1 }).error).toBeTruthy();
  });
  test('ручная норма: название и ≥1 позиция с целым good_id и amount > 0', () => {
    expect(parseManualCard({ title: 'Норма', items: [{ goodId: 7, amount: 2, unit: 'мл' }] }).value).toEqual({ title: 'Норма', items: [{ good_id: 7, amount: 2, unit: 'мл', price_at_sync: null, title: null }] });
    expect(parseManualCard({ title: '', items: [] }).error).toBeTruthy();
    expect(parseManualCard({ title: 'X', items: [{ goodId: 'a', amount: 1 }] }).error).toBeTruthy();
  });
  test('период ≤ 731 дня', () => {
    expect(parsePeriodDays('2026-01-01', '2026-01-31')).toBe(31);
    expect(parsePeriodDays('2024-01-01', '2026-12-31')).toBeGreaterThan(731);
  });
});
```

- [ ] **Step 2: Запустить — падает**

Run: `cd /root/loyalpro/backend && npx jest economics-routes 2>&1 | tail -5`
Expected: FAIL.

- [ ] **Step 3: CRUD в `store.js`**

```js
// ── Справочники (роуты) ──────────────────────────────────────────────────────
async function listGoods(salonId, { search = '', onlyConsumables = false } = {}) {
  const params = [salonId];
  let where = 'c.salon_id = $1 AND NOT c.is_archived';
  if (search) { params.push(`%${search}%`); where += ` AND c.title ILIKE $${params.length}`; }
  if (onlyConsumables) where += ` AND EXISTS (SELECT 1 FROM goods_transactions t WHERE t.salon_id = c.salon_id AND t.good_id = c.yclients_good_id AND t.type_id = 2 AND t.deleted_at IS NULL)`;
  return db.any(`
    SELECT c.yclients_good_id AS good_id, c.title, c.category_title, c.unit, c.service_unit, c.unit_equals, c.actual_cost, c.unit_actual_cost,
           c.stock, c.last_receipt_price, c.last_receipt_at, o.unit_price AS override_price, o.note AS override_note
    FROM yclients_goods_catalog c
    LEFT JOIN goods_price_overrides o ON o.salon_id = c.salon_id AND o.good_id = c.yclients_good_id
    WHERE ${where} ORDER BY c.title LIMIT 1000`, params);
}
async function listReceipts(salonId, goodId) {
  return db.any(`
    SELECT yclients_txn_id, create_date, amount, cost, cost_per_unit, discount, supplier_title, unit_title, operation_unit_type
    FROM goods_transactions WHERE salon_id = $1 AND good_id = $2 AND type_id = 3 AND deleted_at IS NULL
    ORDER BY create_date DESC LIMIT 100`, [salonId, goodId]);
}
async function setPriceOverride(salonId, goodId, unitPrice, note, userId) {
  if (unitPrice === null) { await db.query('DELETE FROM goods_price_overrides WHERE salon_id=$1 AND good_id=$2', [salonId, goodId]); return; }
  await db.query(`
    INSERT INTO goods_price_overrides (salon_id, good_id, unit_price, note, updated_by, updated_at) VALUES ($1, $2, $3, $4, $5, NOW())
    ON CONFLICT (salon_id, good_id) DO UPDATE SET unit_price = EXCLUDED.unit_price, note = EXCLUDED.note, updated_by = EXCLUDED.updated_by, updated_at = NOW()`,
    [salonId, goodId, unitPrice, note || null, userId || null]);
}
async function listTechCards(salonId) {
  return db.any(`
    SELECT c.id, c.yc_card_id, c.title, c.items, c.source, c.synced_at, c.updated_at,
           (SELECT count(*)::int FROM service_tech_cards l WHERE l.tech_card_id = c.id) AS links
    FROM tech_cards c WHERE c.salon_id = $1 ORDER BY c.source, c.title`, [salonId]);
}
async function insertManualCard(salonId, card) {
  const r = await db.one(`INSERT INTO tech_cards (salon_id, yc_card_id, title, items, source, updated_at) VALUES ($1, NULL, $2, $3::jsonb, 'manual', NOW()) RETURNING id`,
    [salonId, card.title, JSON.stringify(card.items)]);
  return r.id;
}
async function updateManualCard(salonId, id, card) {
  const r = await db.query(`UPDATE tech_cards SET title=$3, items=$4::jsonb, updated_at=NOW() WHERE salon_id=$1 AND id=$2 AND source='manual'`, [salonId, id, card.title, JSON.stringify(card.items)]);
  return r.rowCount > 0;
}
async function deleteManualCard(salonId, id) {
  const r = await db.query(`DELETE FROM tech_cards WHERE salon_id=$1 AND id=$2 AND source='manual'`, [salonId, id]);
  return r.rowCount > 0;
}
async function techCardExists(salonId, id) {
  return !!(await db.oneOrNone('SELECT 1 FROM tech_cards WHERE salon_id=$1 AND id=$2', [salonId, id]));
}
async function clearServiceTechCard(salonId, serviceYcId, staffYcId) {
  await db.query(`DELETE FROM service_tech_cards WHERE salon_id=$1 AND service_yc_id=$2 AND COALESCE(staff_yc_id,0) = COALESCE($3::bigint,0)`, [salonId, serviceYcId, staffYcId]);
}
async function listPayRules(salonId) { return db.any(PAY_RULES_SQL, [salonId]); }
async function insertPayRule(salonId, v) {
  const r = await db.one(`INSERT INTO staff_pay_rules (salon_id, staff_yc_id, service_yc_id, category_yc_id, percent, base, fixed_per_visit, valid_from, valid_to, note)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`, [salonId, v.staff_yc_id, v.service_yc_id, v.category_yc_id, v.percent, v.base, v.fixed_per_visit, v.valid_from, v.valid_to, v.note]);
  return r.id;
}
async function updatePayRule(salonId, id, v) {
  const r = await db.query(`UPDATE staff_pay_rules SET staff_yc_id=$3, service_yc_id=$4, category_yc_id=$5, percent=$6, base=$7, fixed_per_visit=$8, valid_from=$9, valid_to=$10, note=$11, updated_at=NOW()
    WHERE salon_id=$1 AND id=$2`, [salonId, id, v.staff_yc_id, v.service_yc_id, v.category_yc_id, v.percent, v.base, v.fixed_per_visit, v.valid_from, v.valid_to, v.note]);
  return r.rowCount > 0;
}
async function deletePayRule(salonId, id) { const r = await db.query('DELETE FROM staff_pay_rules WHERE salon_id=$1 AND id=$2', [salonId, id]); return r.rowCount > 0; }
async function getSettings(salonId) { return normSettings(await db.oneOrNone(SETTINGS_SQL, [salonId])); }
async function saveSettings(salonId, v) {
  await db.query(`INSERT INTO economics_settings (salon_id, payroll_multiplier, pay_base_includes_bonuses, allocation_driver, usn_rate, acquiring, updated_at)
    VALUES ($1,$2,$3,$4,$5,$6::jsonb,NOW())
    ON CONFLICT (salon_id) DO UPDATE SET payroll_multiplier=EXCLUDED.payroll_multiplier, pay_base_includes_bonuses=EXCLUDED.pay_base_includes_bonuses,
      allocation_driver=EXCLUDED.allocation_driver, usn_rate=EXCLUDED.usn_rate, acquiring=EXCLUDED.acquiring, updated_at=NOW()`,
    [salonId, v.payroll_multiplier, v.pay_base_includes_bonuses, v.allocation_driver, v.usn_rate, JSON.stringify(v.acquiring)]);
}
/** Кассы салона за 12 месяцев — для формы эквайринга. */
async function listAccounts(salonId) {
  const rows = await db.any(`SELECT account_title, count(*)::int AS n FROM revenue_operations WHERE salon_id=$1 AND category='services'
    AND operation_date >= (CURRENT_DATE - INTERVAL '12 months') AND account_title IS NOT NULL GROUP BY 1 ORDER BY 2 DESC`, [salonId]);
  return rows.map(r => ({ title: r.account_title, operations: r.n }));
}
```
Добавить все в `module.exports`.

- [ ] **Step 4: `runNightly` и флаг в `sync.js`**

```js
const _inFlight = new Set();   // salonId
function isRunning(salonId) { return _inFlight.has(salonId); }

/** Ночной проход; каждый шаг в своём try/catch. Возвращает счётчики и ошибки по шагам. */
async function runNightly(salon, opts = {}) {
  if (_inFlight.has(salon.id)) throw Object.assign(new Error('синк уже идёт'), { code: 'BUSY' });
  _inFlight.add(salon.id);
  const out = { steps: {}, errors: {} };
  const step = async (name, fn) => { try { out.steps[name] = await fn(); } catch (e) { out.errors[name] = e.message; logger.warn(`salon=${salon.id} ${name}: ${e.message}`); } };
  try {
    await step('catalog', () => syncGoodsCatalog(salon, opts));
    await step('techCards', () => syncTechCards(salon, opts));
    await step('transactions', () => reconcileGoodsTransactions(salon, opts));
    await step('learn', () => learnTechCardLinks(salon, opts));
    await step('lastReceipts', () => store.refreshAllLastReceipts(salon.id));
    out.ok = Object.keys(out.errors).length === 0;
    logger.info(`salon=${salon.id}: ночной проход ${out.ok ? 'ok' : 'с ошибками'}: ${JSON.stringify(out.steps)} ${JSON.stringify(out.errors)}`);
    return out;
  } finally { _inFlight.delete(salon.id); }
}
```
Экспортировать `runNightly, isRunning`.

- [ ] **Step 5: Роутер**

`backend/routes/economics.js`:

```js
'use strict';
// /api/economics — экономика процедур. ТОЛЬКО владелец (зарплаты и закупки).
// Валидация недоверчивая, как parseRuleBody в routes/reminders.js: тела вне
// контракта — 400 с полем. Парсеры вынесены наружу ради теста без HTTP.
const router = require('express').Router();
const { auth, requireRole } = require('../middleware/auth');
const { db } = require('../db');
const store = require('../services/economics/store');
const report = require('../services/economics/report');
const sync = require('../services/economics/sync');
const { createLogger } = require('../logger');
const logger = createLogger('EconomicsAPI');

const MAX_PERIOD_DAYS = 731;
const ISO = /^\d{4}-\d{2}-\d{2}$/;
const PAY_BASES = ['gross', 'net_of_materials'];
const DRIVERS = ['minutes', 'visits'];

const isDate = (s) => ISO.test(String(s || '')) && new Date(s + 'T00:00:00Z').toISOString().slice(0, 10) === s;
const optInt = (v) => (v === null || v === undefined || v === '' ? null : (Number.isInteger(Number(v)) && Number(v) > 0 ? Number(v) : NaN));
function parsePeriodDays(from, to) { return Math.round((Date.parse(to) - Date.parse(from)) / 86400000) + 1; }

// Период — тот же выбор, что у дашборда (from/to или period=today|week|month|N).
function resolvePeriod(req) {
  const todayMsk = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Moscow' }).format(new Date());
  let { from, to } = req.query;
  if (isDate(from) && isDate(to)) { if (from > to) [from, to] = [to, from]; return { from, to }; }
  const preset = String(req.query.period || '').toLowerCase();
  const addDays = (iso, n) => { const d = new Date(iso + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
  if (preset === 'today') return { from: todayMsk, to: todayMsk };
  if (preset === 'week') { const dow = new Date(todayMsk + 'T00:00:00Z').getUTCDay(); return { from: addDays(todayMsk, -(dow === 0 ? 6 : dow - 1)), to: todayMsk }; }
  if (preset === 'month') return { from: todayMsk.slice(0, 8) + '01', to: todayMsk };
  if (preset === 'quarter') { const m = Number(todayMsk.slice(5, 7)); const qm = String(Math.floor((m - 1) / 3) * 3 + 1).padStart(2, '0'); return { from: `${todayMsk.slice(0, 4)}-${qm}-01`, to: todayMsk }; }
  const days = Math.max(1, Number.parseInt(req.query.period || '30', 10) || 30);
  return { from: addDays(todayMsk, -(days - 1)), to: todayMsk };
}

function parsePayRule(b) {
  b = b || {};
  const staff = optInt(b.staffYcId), service = optInt(b.serviceYcId), category = optInt(b.categoryYcId);
  if ([staff, service, category].some(Number.isNaN)) return { error: 'Идентификаторы — целые числа' };
  if (service !== null && category !== null) return { error: 'Правило либо на услугу, либо на категорию' };
  const percent = Number(b.percent);
  if (!Number.isFinite(percent) || percent < 0 || percent > 100) return { error: 'Процент 0–100' };
  if (!PAY_BASES.includes(b.base)) return { error: 'База: gross или net_of_materials' };
  const fixed = b.fixedPerVisit === undefined || b.fixedPerVisit === null || b.fixedPerVisit === '' ? 0 : Number(b.fixedPerVisit);
  if (!Number.isFinite(fixed) || fixed < 0) return { error: 'Фикс за визит ≥ 0' };
  const vf = b.validFrom || null, vt = b.validTo || null;
  if ((vf && !isDate(vf)) || (vt && !isDate(vt))) return { error: 'Дата в формате YYYY-MM-DD' };
  if (vf && vt && vf > vt) return { error: 'Период: начало позже конца' };
  return { value: { staff_yc_id: staff, service_yc_id: service, category_yc_id: category, percent, base: b.base, fixed_per_visit: fixed, valid_from: vf, valid_to: vt, note: String(b.note || '').slice(0, 500) } };
}

function parseSettings(b) {
  b = b || {};
  const mult = Number(b.payrollMultiplier);
  if (!Number.isFinite(mult) || mult < 1 || mult > 3) return { error: 'Множитель ФОТ 1–3' };
  if (!DRIVERS.includes(b.allocationDriver)) return { error: 'Драйвер: minutes или visits' };
  const usn = b.usnRate === undefined ? 15 : Number(b.usnRate);
  if (!Number.isFinite(usn) || usn < 0 || usn > 50) return { error: 'Ставка УСН 0–50' };
  const acq = b.acquiring === undefined ? {} : b.acquiring;
  if (!acq || typeof acq !== 'object' || Array.isArray(acq)) return { error: 'Эквайринг — объект {касса: процент}' };
  const acquiring = {};
  for (const [k, v] of Object.entries(acq)) {
    const key = String(k).slice(0, 128); const pct = Number(v);
    if (!key || !Number.isFinite(pct) || pct < 0 || pct > 10) return { error: `Эквайринг «${key}»: процент 0–10` };
    acquiring[key] = pct;
  }
  return { value: { payroll_multiplier: mult, pay_base_includes_bonuses: !!b.payBaseIncludesBonuses, allocation_driver: b.allocationDriver, usn_rate: usn, acquiring } };
}

function parsePriceBody(b) {
  b = b || {};
  if (b.unitPrice === null || b.unitPrice === '') return { value: null };
  const p = Number(b.unitPrice);
  if (!Number.isFinite(p) || p <= 0 || p > 1e7) return { error: 'Цена — число больше 0' };
  return { value: p };
}

function parseManualCard(b) {
  b = b || {};
  const title = String(b.title || '').trim();
  if (!title || title.length > 500) return { error: 'Название нормы 1–500 символов' };
  const raw = Array.isArray(b.items) ? b.items : [];
  if (!raw.length || raw.length > 100) return { error: 'Нужна хотя бы одна позиция (не больше 100)' };
  const items = [];
  for (const [i, it] of raw.entries()) {
    const gid = optInt(it && it.goodId); const amount = Number(it && it.amount);
    if (!gid || Number.isNaN(gid)) return { error: `Позиция ${i + 1}: товар — целый id` };
    if (!Number.isFinite(amount) || amount <= 0) return { error: `Позиция ${i + 1}: количество больше 0` };
    items.push({ good_id: gid, amount, unit: it.unit ? String(it.unit).slice(0, 50) : null, price_at_sync: null, title: null });
  }
  return { value: { title, items } };
}

async function salonOf(req) {
  return db.oneOrNone('SELECT * FROM salons WHERE id=$1', [req.user.salonId]);
}
function periodOr400(req, res) {
  const p = resolvePeriod(req);
  const days = parsePeriodDays(p.from, p.to);
  if (!(days >= 1 && days <= MAX_PERIOD_DAYS)) { res.status(400).json({ error: `период не больше ${MAX_PERIOD_DAYS} дней` }); return null; }
  return p;
}
const fail = (res, label) => (e) => { logger.warn(`${label}: ${e.message}`); res.status(500).json({ error: e.message }); };

router.use(auth, requireRole('owner'));

// ── отчёт ──
router.get('/services', async (req, res) => {
  const p = periodOr400(req, res); if (!p) return;
  try {
    const salon = await salonOf(req);
    const r = await report.buildReport(salon, p.from, p.to);
    res.json({ from: p.from, to: p.to, services: r.byService, byServiceStaff: r.byServiceStaff, summary: r.summary, settings: r.settings });
  } catch (e) { fail(res, 'services')(e); }
});
router.get('/services/:serviceId(\\d+)', async (req, res) => {
  const p = periodOr400(req, res); if (!p) return;
  try {
    const d = await report.serviceDetail(await salonOf(req), Number(req.params.serviceId), p.from, p.to);
    if (!d) return res.status(404).json({ error: 'Услуга без визитов в периоде' });
    res.json({ from: p.from, to: p.to, ...d });
  } catch (e) { fail(res, 'service detail')(e); }
});
router.get('/coverage', async (req, res) => {
  const p = periodOr400(req, res); if (!p) return;
  try { res.json({ from: p.from, to: p.to, ...(await report.coverage(await salonOf(req), p.from, p.to)) }); }
  catch (e) { fail(res, 'coverage')(e); }
});

// ── товары и цены ──
router.get('/goods', async (req, res) => {
  try {
    const search = String(req.query.search || '').slice(0, 100);
    res.json({ goods: await store.listGoods(req.user.salonId, { search, onlyConsumables: req.query.only_consumables === '1' }) });
  } catch (e) { fail(res, 'goods')(e); }
});
router.get('/goods/:goodId(\\d+)/receipts', async (req, res) => {
  try { res.json({ receipts: await store.listReceipts(req.user.salonId, Number(req.params.goodId)) }); }
  catch (e) { fail(res, 'receipts')(e); }
});
router.put('/goods/:goodId(\\d+)/price', async (req, res) => {
  const p = parsePriceBody(req.body); if (p.error) return res.status(400).json({ error: p.error });
  try {
    await store.setPriceOverride(req.user.salonId, Number(req.params.goodId), p.value, req.body && req.body.note, req.user.userId);
    report.invalidate(req.user.salonId);
    res.json({ ok: true });
  } catch (e) { fail(res, 'price override')(e); }
});

// ── техкарты ──
router.get('/tech-cards', async (req, res) => {
  try { res.json({ cards: await store.listTechCards(req.user.salonId) }); } catch (e) { fail(res, 'tech-cards')(e); }
});
router.post('/tech-cards/sync', async (req, res) => {
  const sid = req.user.salonId;
  if (sync.isRunning(sid)) return res.status(409).json({ error: 'Синхронизация уже идёт' });
  try {
    const salon = await salonOf(req);
    const r = await sync.syncTechCards(salon);
    report.invalidate(sid);
    res.json(r);
  } catch (e) { fail(res, 'tech-cards sync')(e); }
});
router.post('/tech-cards', async (req, res) => {
  const p = parseManualCard(req.body); if (p.error) return res.status(400).json({ error: p.error });
  try { const id = await store.insertManualCard(req.user.salonId, p.value); report.invalidate(req.user.salonId); res.json({ id }); }
  catch (e) { fail(res, 'tech-card create')(e); }
});
router.put('/tech-cards/:id(\\d+)', async (req, res) => {
  const p = parseManualCard(req.body); if (p.error) return res.status(400).json({ error: p.error });
  try {
    const ok = await store.updateManualCard(req.user.salonId, Number(req.params.id), p.value);
    if (!ok) return res.status(404).json({ error: 'Норма не найдена или не ручная' });
    report.invalidate(req.user.salonId); res.json({ ok: true });
  } catch (e) { fail(res, 'tech-card update')(e); }
});
router.delete('/tech-cards/:id(\\d+)', async (req, res) => {
  try {
    const ok = await store.deleteManualCard(req.user.salonId, Number(req.params.id));
    if (!ok) return res.status(404).json({ error: 'Норма не найдена или не ручная' });
    report.invalidate(req.user.salonId); res.json({ ok: true });
  } catch (e) { fail(res, 'tech-card delete')(e); }
});
router.put('/services/:serviceId(\\d+)/tech-card', async (req, res) => {
  const sid = req.user.salonId; const serviceYcId = Number(req.params.serviceId);
  const b = req.body || {};
  const staff = optInt(b.staffYcId); if (Number.isNaN(staff)) return res.status(400).json({ error: 'staffYcId — целое' });
  try {
    if (b.techCardId === null || b.techCardId === undefined) { await store.clearServiceTechCard(sid, serviceYcId, staff); }
    else {
      const cardId = optInt(b.techCardId);
      if (!cardId || Number.isNaN(cardId) || !(await store.techCardExists(sid, cardId))) return res.status(400).json({ error: 'Техкарта не найдена' });
      await store.upsertServiceTechCard(sid, { serviceYcId, staffYcId: staff, techCardId: cardId, source: 'manual' });
    }
    report.invalidate(sid); res.json({ ok: true });
  } catch (e) { fail(res, 'service tech-card')(e); }
});
router.post('/services/:serviceId(\\d+)/tech-card/lookup', async (req, res) => {
  const staffIds = (Array.isArray(req.body && req.body.staffYcIds) ? req.body.staffYcIds : []).map(optInt).filter(x => x && !Number.isNaN(x));
  if (!staffIds.length) return res.status(400).json({ error: 'Нужен список staffYcIds' });
  try {
    const r = await sync.lookupTechCardForService(await salonOf(req), Number(req.params.serviceId), staffIds);
    report.invalidate(req.user.salonId); res.json(r);
  } catch (e) { fail(res, 'tech-card lookup')(e); }
});

// ── правила оплаты ──
router.get('/pay-rules', async (req, res) => { try { res.json({ rules: await store.listPayRules(req.user.salonId) }); } catch (e) { fail(res, 'pay-rules')(e); } });
router.post('/pay-rules', async (req, res) => {
  const p = parsePayRule(req.body); if (p.error) return res.status(400).json({ error: p.error });
  try { const id = await store.insertPayRule(req.user.salonId, p.value); report.invalidate(req.user.salonId); res.json({ id }); } catch (e) { fail(res, 'pay-rule create')(e); }
});
router.put('/pay-rules/:id(\\d+)', async (req, res) => {
  const p = parsePayRule(req.body); if (p.error) return res.status(400).json({ error: p.error });
  try {
    const ok = await store.updatePayRule(req.user.salonId, Number(req.params.id), p.value);
    if (!ok) return res.status(404).json({ error: 'Правило не найдено' });
    report.invalidate(req.user.salonId); res.json({ ok: true });
  } catch (e) { fail(res, 'pay-rule update')(e); }
});
router.delete('/pay-rules/:id(\\d+)', async (req, res) => {
  try {
    const ok = await store.deletePayRule(req.user.salonId, Number(req.params.id));
    if (!ok) return res.status(404).json({ error: 'Правило не найдено' });
    report.invalidate(req.user.salonId); res.json({ ok: true });
  } catch (e) { fail(res, 'pay-rule delete')(e); }
});

// ── настройки ──
router.get('/settings', async (req, res) => {
  try { res.json({ settings: await store.getSettings(req.user.salonId), accounts: await store.listAccounts(req.user.salonId) }); }
  catch (e) { fail(res, 'settings')(e); }
});
router.put('/settings', async (req, res) => {
  const p = parseSettings(req.body); if (p.error) return res.status(400).json({ error: p.error });
  try { await store.saveSettings(req.user.salonId, p.value); report.invalidate(req.user.salonId); res.json({ ok: true, settings: p.value }); }
  catch (e) { fail(res, 'settings save')(e); }
});

// ── ручной ночной проход ──
router.post('/sync', async (req, res) => {
  const sid = req.user.salonId;
  if (sync.isRunning(sid)) return res.status(409).json({ error: 'Синхронизация уже идёт' });
  try { const r = await sync.runNightly(await salonOf(req)); report.invalidate(sid); res.json(r); }
  catch (e) { if (e.code === 'BUSY') return res.status(409).json({ error: e.message }); fail(res, 'sync')(e); }
});

module.exports = router;
module.exports.parsePayRule = parsePayRule;
module.exports.parseSettings = parseSettings;
module.exports.parsePriceBody = parsePriceBody;
module.exports.parseManualCard = parseManualCard;
module.exports.parsePeriodDays = parsePeriodDays;
module.exports.resolvePeriod = resolvePeriod;
```

- [ ] **Step 6: Смонтировать в `routes/index.js`**

После строки `app.use('/api/medical-cert', require('./medical-cert'));` добавить:

```js
  app.use('/api/economics',         require('./economics'));
```

- [ ] **Step 7: Запустить тесты и живую проверку 403/200**

Run: `cd /root/loyalpro/backend && npx jest economics-routes 2>&1 | tail -5`
Expected: PASS.

Run: `cd /root/loyalpro/backend && PORT=3001 pm2 restart loyalpro && sleep 4 && TOKEN=$(node -e "const {db,pool}=require('./db');db.oneOrNone(\"SELECT s.token FROM sessions s JOIN users u ON u.id=s.user_id WHERE u.role='owner' AND s.expires_at>NOW() ORDER BY s.expires_at DESC LIMIT 1\").then(r=>{console.log(r?r.token:'');return pool.end()})") && curl -s -H "Authorization: Bearer $TOKEN" "http://localhost:3001/api/economics/services?from=2026-09-01&to=2026-09-30" | head -c 600`
Expected: JSON с `services[]`, `summary`. (Если сессии владельца нет — войти в админку дева и повторить.) Для роли admin тот же запрос обязан дать `403 {"error":"Нет доступа"}`.

- [ ] **Step 8: Commit**

```bash
cd /root/loyalpro && git add backend/routes/economics.js backend/routes/index.js backend/services/economics/store.js backend/services/economics/sync.js backend/economics-routes.test.js && git commit -m "feat(economics): API /api/economics — отчёт, товары и цены, техкарты, правила оплаты, настройки, синк"
```

---

### Task 14: Крон, флаг, фасад и e2e-скрипт синка

**Модель: Sonnet (L1).**

**Files:**
- Modify: `backend/config.js`, `backend/server.js`, `backend/services/economics/index.js`
- Create: `backend/scripts/economics-sync-e2e.js`

- [ ] **Step 1: Флаг в `config.js`**

Рядом с другими флагами (после `DIALOG_VERDICTS`-подобных, в объекте `module.exports`):

```js
  // Экономика процедур: ночной синк YClients (каталог, техкарты, сверка транзакций).
  // 'false' гасит ТОЛЬКО крон; вебхуки и ручной POST /api/economics/sync работают.
  ECONOMICS_SYNC: process.env.ECONOMICS_SYNC !== 'false',
```

- [ ] **Step 2: Фасад — ночной проход по салонам с WARN после трёх провалов подряд**

Добавить в `services/economics/index.js`:

```js
const sync = require('./sync');
const report = require('./report');
const { db } = require('../../db');

const _failStreak = new Map();   // salonId → провалов подряд
const REPEATED_FAILURES = 3;

async function runNightlyAll() {
  const salons = await db.any(`SELECT * FROM salons WHERE is_active AND yclients_company_id IS NOT NULL AND yclients_user_token IS NOT NULL`);
  for (const salon of salons) {
    try {
      const r = await sync.runNightly(salon);
      report.invalidate(salon.id);
      if (r.ok) _failStreak.set(salon.id, 0);
      else {
        const n = (_failStreak.get(salon.id) || 0) + 1; _failStreak.set(salon.id, n);
        if (n >= REPEATED_FAILURES) logger.warn(`salon=${salon.id}: экономика: синк не проходит ${n} ночи подряд: ${JSON.stringify(r.errors)}`);
      }
    } catch (e) { logger.error(`salon=${salon.id}: ночной проход экономики: ${e.message}`); }
  }
}

module.exports = { handleGoodsEvent, runNightlyAll };
```

После этого `index.js` тянет `./sync` и `./report` (а те — `../yclients`, `../../db`). В `economics-webhook.test.js` добавить моки сверху, иначе тест задачи 3 поднимет реальные модули:

```js
jest.mock('./db', () => ({ db: { one: jest.fn(), oneOrNone: jest.fn(), query: jest.fn(), any: jest.fn() }, pool: {} }));
jest.mock('./services/economics/sync', () => ({ runNightly: jest.fn(), isRunning: jest.fn() }));
jest.mock('./services/economics/report', () => ({ invalidate: jest.fn() }));
```
и дописать тест:
```js
test('runNightlyAll: по активным салонам с токенами, сброс кэша отчёта, WARN после трёх провалов подряд', async () => {
  const { db } = require('./db'); const sync = require('./services/economics/sync'); const report = require('./services/economics/report');
  db.any.mockResolvedValue([{ id: 1, yclients_company_id: '668791' }]);
  sync.runNightly.mockResolvedValue({ ok: false, steps: {}, errors: { catalog: '429' } });
  const { runNightlyAll } = require('./services/economics');
  await runNightlyAll(); await runNightlyAll(); await runNightlyAll();
  expect(report.invalidate).toHaveBeenCalledWith(1);
  expect(mockLog.warn).toHaveBeenCalledWith(expect.stringMatching(/синк не проходит 3 ночи/));
});
```
Run: `cd /root/loyalpro/backend && npx jest economics-webhook 2>&1 | tail -3` → PASS.

- [ ] **Step 3: Крон в `server.js`**

После блока крона `35 4 * * *` (ночная сверка записей) добавить:

```js
// ── Экономика процедур: ночной проход YClients (каталог, техкарты, транзакции,
// привязки) — 5:05 мск, после сверки записей 4:35 и чистки 4:40; ≈33 запроса.
if (config.ECONOMICS_SYNC) {
  cron.schedule('5 5 * * *', async () => {
    try { await require('./services/economics').runNightlyAll(); }
    catch (e) { cronLogger.error(`economics nightly: ${e.message}`); }
  }, { timezone: 'Europe/Moscow' });
} else {
  cronLogger.warn('ECONOMICS_SYNC=false — ночной синк экономики выключен');
}
```
(Проверить, что `config` уже импортирован в `server.js`; если нет — `const config = require('./config');` в начале.)

- [ ] **Step 4: Скрипт живого прогона**

`backend/scripts/economics-sync-e2e.js`:

```js
#!/usr/bin/env node
'use strict';
// Живой прогон ночного синка экономики на деве: каталог товаров, техкарты,
// сверка транзакций за 2 дня, обучение привязок. Пишет в ДЕВ-БД (как крон),
// никому ничего не шлёт. Печатает счётчики каждого шага и итоги по таблицам.
//   node scripts/economics-sync-e2e.js [salonId]
const { db, pool } = require('../db');
const sync = require('../services/economics/sync');

const salonId = Number(process.argv[2] || 1);
(async () => {
  const salon = await db.oneOrNone('SELECT * FROM salons WHERE id=$1', [salonId]);
  if (!salon) throw new Error(`салон ${salonId} не найден`);
  const t0 = Date.now();
  const r = await sync.runNightly(salon);
  console.log(`ночной проход за ${Math.round((Date.now() - t0) / 1000)} с, ok=${r.ok}`);
  for (const [k, v] of Object.entries(r.steps)) console.log(`  ${k}:`, JSON.stringify(v));
  for (const [k, v] of Object.entries(r.errors)) console.log(`  ОШИБКА ${k}:`, v);
  const q = async (sql) => (await db.oneOrNone(sql, [salonId])) || {};
  console.log('каталог с unit_actual_cost:', await q('SELECT count(*)::int AS n FROM yclients_goods_catalog WHERE salon_id=$1 AND unit_actual_cost IS NOT NULL'));
  console.log('техкарты:', await q("SELECT count(*)::int AS n, sum(jsonb_array_length(items))::int AS items FROM tech_cards WHERE salon_id=$1 AND source='yclients'"));
  console.log('привязки:', await q('SELECT count(*)::int AS n, count(DISTINCT service_yc_id)::int AS services FROM service_tech_cards WHERE salon_id=$1'));
  console.log('транзакции за 3 дня:', await q("SELECT count(*)::int AS n FROM goods_transactions WHERE salon_id=$1 AND create_date > NOW() - INTERVAL '3 days'"));
  if (!r.ok) process.exitCode = 1;
  await pool.end();
})().catch(e => { console.error(e); process.exit(1); });
```

- [ ] **Step 5: Прогнать на деве**

Run: `cd /root/loyalpro/backend && node scripts/economics-sync-e2e.js 1`
Expected: `ok=true`; `catalog: {"pages":6,"goods":46x}`; `techCards: {"cards":81,…}` (исследование: 81 карта, 449 позиций); `learn: {"records":N,"linked":M}` с M > 0 при вчерашних визитах со списаниями; без строк `ОШИБКА`.

- [ ] **Step 6: Перезапуск дева и commit**

Run: `cd /root/loyalpro/backend && PORT=3001 pm2 restart loyalpro && sleep 3 && pm2 logs loyalpro --lines 30 --nostream | grep -i "economics\|error" | head`
Expected: без ошибок.

```bash
cd /root/loyalpro && git add backend/config.js backend/server.js backend/services/economics/index.js backend/scripts/economics-sync-e2e.js && git commit -m "feat(economics): крон ночного синка 5:05 мск, флаг ECONOMICS_SYNC, e2e-скрипт синка"
```

---

### Task 15: Фронт — каркас страницы, меню, чистые помощники `economics-table.js`

**Модель: Sonnet (L1).**

**Files:**
- Modify: `frontend/index.html` (пункт меню в ДВУХ списках, `page-economics`, два `<script>`), `frontend/js/core/nav.js:84`, `frontend/css/features.css`
- Create: `frontend/js/pages/economics-table.js`, `frontend/js/pages/economics-table.test.js`, `frontend/js/pages/economics.js` (каркас; вкладки заполняют задачи 16–18, 20–21)

- [ ] **Step 1: Падающий тест чистых помощников (`node --test`, один `vm`-контекст)**

`frontend/js/pages/economics-table.test.js`:

```js
// Чистые помощники страницы «Экономика» + проверка общей глобальной области.
// Запуск: node --test frontend/js/pages/economics-table.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const FRONT = path.join(__dirname, '..', '..');
function browserContext() {
  const ctx = vm.createContext({ console, URLSearchParams, localStorage: { getItem: () => null, setItem() {}, removeItem() {} } });
  ctx.window = ctx; return ctx;
}
const ctx = browserContext();
for (const f of ['js/core/utils.js', 'js/core/api.js', 'js/pages/economics-table.js', 'js/pages/economics.js']) {
  vm.runInContext(fs.readFileSync(path.join(FRONT, f), 'utf8'), ctx, { filename: f });
}
const plain = (x) => JSON.parse(JSON.stringify(x));
const k = (name) => vm.runInContext(name, ctx);

test('файлы грузятся в одну область (нет редекларации имён)', () => {
  for (const n of ['ecoMoney', 'ecoPct', 'ecoSort', 'ecoTotals', 'loadEconomics', 'ecoSwitchTab']) assert.strictEqual(typeof ctx[n], 'function', n);
  assert.ok(Array.isArray(plain(k('ECO_SERVICE_COLS'))));
});

test('ecoMoney / ecoPct / ecoNum', () => {
  assert.strictEqual(ctx.ecoMoney(1234567.891), '1 234 568 ₽');
  assert.strictEqual(ctx.ecoMoney(-50.4), '−50 ₽');
  assert.strictEqual(ctx.ecoMoney(null), '—');
  assert.strictEqual(ctx.ecoPct(0.4256), '42,6%');
  assert.strictEqual(ctx.ecoPct(null), '—');
  assert.strictEqual(ctx.ecoNum(2.5, 1), '2,5');
});

test('ecoSort: по числу и строке, направление, null в конец', () => {
  const rows = [{ label: 'б', revenue: 10 }, { label: 'а', revenue: null }, { label: 'в', revenue: 30 }];
  assert.deepStrictEqual(plain(ctx.ecoSort(rows, 'revenue', 'desc')).map(r => r.label), ['в', 'б', 'а']);
  assert.deepStrictEqual(plain(ctx.ecoSort(rows, 'revenue', 'asc')).map(r => r.label), ['б', 'в', 'а']);
  assert.deepStrictEqual(plain(ctx.ecoSort(rows, 'label', 'asc')).map(r => r.label), ['а', 'б', 'в']);
});

test('ecoTotals: суммы по колонкам, проценты и прибыль/час пересчитываются от сумм', () => {
  const t = plain(ctx.ecoTotals([
    { visits: 1, revenue: 100, materials_used: 10, doctor_cost: 20, acquiring_cost: 1, contribution: 69, overhead: 9, equipment_cost: 0, operating_profit: 60, usn_estimate: 9, hours: 0.5, materials_estimated_rows: 1, discount: 0, bonus_redeemed: 0 },
    { visits: 2, revenue: 300, materials_used: 30, doctor_cost: 60, acquiring_cost: 3, contribution: 207, overhead: 27, equipment_cost: 10, operating_profit: 170, usn_estimate: 25.5, hours: 1.5, materials_estimated_rows: 0, discount: 5, bonus_redeemed: 2 },
  ]));
  assert.strictEqual(t.visits, 3);
  assert.strictEqual(t.revenue, 400);
  assert.strictEqual(t.contribution, 276);
  assert.strictEqual(t.contribution_pct, 0.69);
  assert.strictEqual(t.profit_per_hour, 138);
  assert.strictEqual(t.materials_estimated_rows, 1);
});

test('ecoPeriodPreset: месяц и квартал по московской дате', () => {
  assert.deepStrictEqual(plain(ctx.ecoPeriodPreset('month', '2026-10-18')), { from: '2026-10-01', to: '2026-10-18' });
  assert.deepStrictEqual(plain(ctx.ecoPeriodPreset('quarter', '2026-10-18')), { from: '2026-10-01', to: '2026-10-18' });
  assert.deepStrictEqual(plain(ctx.ecoPeriodPreset('prev-month', '2026-10-18')), { from: '2026-09-01', to: '2026-09-30' });
});

test('ecoFlags: бейджи покрытия строки услуги', () => {
  const f = plain(ctx.ecoFlags({ coverage: { rows: 4, with_consumables: 2, with_tech_card: 0, no_pay_rule: 1, no_price_goods: [5], acquiring_estimated: 4 }, materials_estimated_rows: 2 }));
  assert.deepStrictEqual(f.map(x => x.key), ['estimated', 'no_tech_card', 'no_pay_rule', 'no_price', 'acq_est']);
});
```

- [ ] **Step 2: Запустить — падает**

Run: `cd /root/loyalpro && node --test frontend/js/pages/economics-table.test.js 2>&1 | tail -5`
Expected: FAIL (`ENOENT economics-table.js`).

- [ ] **Step 3: `economics-table.js`**

```js
// Чистые помощники страницы «💰 Экономика» (без document). Тест — economics-table.test.js
// в одном vm-контексте с economics.js: верхнеуровневый const с именем чужой функции
// гасит ВЕСЬ файл (готча проекта, 12.08.2026). Все имена — с префиксом eco/ECO_.

function ecoNum(v, digits = 0) {
  if (v === null || v === undefined || !Number.isFinite(Number(v))) return '—';
  const n = Number(v);
  const s = Math.abs(n).toLocaleString('ru-RU', { minimumFractionDigits: digits, maximumFractionDigits: digits }).replace(/ /g, ' ');
  return (n < 0 ? '−' : '') + s;
}
function ecoMoney(v) { return v === null || v === undefined || !Number.isFinite(Number(v)) ? '—' : ecoNum(Math.round(Number(v))) + ' ₽'; }
function ecoPct(v) { return v === null || v === undefined || !Number.isFinite(Number(v)) ? '—' : ecoNum(Number(v) * 100, 1) + '%'; }

function ecoSort(rows, key, dir) {
  const sign = dir === 'asc' ? 1 : -1;
  return [...rows].sort((a, b) => {
    const x = a[key], y = b[key];
    const xn = x === null || x === undefined, yn = y === null || y === undefined;
    if (xn && yn) return 0; if (xn) return 1; if (yn) return -1;
    if (typeof x === 'number' && typeof y === 'number') return (x - y) * sign;
    return String(x).localeCompare(String(y), 'ru') * sign;
  });
}

const ECO_SUM_KEYS = ['visits', 'revenue', 'discount', 'bonus_redeemed', 'materials_used', 'materials_norm', 'doctor_cost', 'acquiring_cost',
  'contribution', 'overhead', 'equipment_cost', 'operating_profit', 'usn_estimate', 'hours', 'materials_estimated_rows'];
function ecoTotals(groups) {
  const t = {};
  for (const k of ECO_SUM_KEYS) t[k] = groups.reduce((a, g) => a + (Number(g[k]) || 0), 0);
  t.contribution_pct = t.revenue > 0 ? t.contribution / t.revenue : null;
  t.operating_pct = t.revenue > 0 ? t.operating_profit / t.revenue : null;
  t.profit_per_hour = t.hours > 0 ? t.contribution / t.hours : null;
  return t;
}

// Колонки вкладки «Услуги»: key — поле группы, fmt — money|pct|num|hours, title — заголовок.
const ECO_SERVICE_COLS = [
  { key: 'label', title: 'Услуга', fmt: 'text' },
  { key: 'visits', title: 'Визитов', fmt: 'num' },
  { key: 'revenue', title: 'Выручка', fmt: 'money' },
  { key: 'materials_used', title: 'Материалы', fmt: 'money', flag: 'estimated' },
  { key: 'doctor_cost', title: 'Врач', fmt: 'money' },
  { key: 'acquiring_cost', title: 'Эквайринг', fmt: 'money' },
  { key: 'contribution', title: 'Марж. прибыль', fmt: 'money', strong: true },
  { key: 'contribution_pct', title: '%', fmt: 'pct' },
  { key: 'overhead', title: 'Постоянные', fmt: 'money' },
  { key: 'equipment_cost', title: 'Аппарат', fmt: 'money' },
  { key: 'operating_profit', title: 'Прибыль', fmt: 'money', strong: true },
  { key: 'operating_pct', title: '%', fmt: 'pct' },
  { key: 'profit_per_hour', title: '₽/час', fmt: 'money' },
];
function ecoFmt(v, fmt) {
  if (fmt === 'money') return ecoMoney(v);
  if (fmt === 'pct') return ecoPct(v);
  if (fmt === 'num') return ecoNum(v);
  if (fmt === 'hours') return ecoNum(v, 1);
  return v === null || v === undefined ? '' : String(v);
}

/** Бейджи покрытия у строки услуги. */
function ecoFlags(g) {
  const c = g.coverage || {};
  const out = [];
  if (g.materials_estimated_rows > 0) out.push({ key: 'estimated', text: `оценка ${g.materials_estimated_rows}`, title: 'Материалы по норме техкарты, списаний нет', cls: 'eco-badge-warn' });
  if (c.rows && !c.with_tech_card) out.push({ key: 'no_tech_card', text: 'нет техкарты', title: 'Ни одна привязка к техкарте не найдена', cls: 'eco-badge-muted' });
  if (c.no_pay_rule > 0) out.push({ key: 'no_pay_rule', text: `нет правила ${c.no_pay_rule}`, title: 'Строки без правила оплаты врача — оплата 0', cls: 'eco-badge-err' });
  if (c.no_price_goods && c.no_price_goods.length) out.push({ key: 'no_price', text: `товары без цены ${c.no_price_goods.length}`, title: 'Нет ни прихода, ни ручной цены, ни себестоимости YClients', cls: 'eco-badge-err' });
  if (c.rows && c.acquiring_estimated === c.rows) out.push({ key: 'acq_est', text: 'эквайринг оценка', title: 'Нет привязанных оплат — средняя доля периода', cls: 'eco-badge-muted' });
  return out;
}

/** Период по пресету от московской даты today ('YYYY-MM-DD'). */
function ecoPeriodPreset(preset, today) {
  const y = Number(today.slice(0, 4)), m = Number(today.slice(5, 7));
  const pad = (n) => String(n).padStart(2, '0');
  const lastDay = (yy, mm) => new Date(Date.UTC(yy, mm, 0)).getUTCDate();
  if (preset === 'month') return { from: `${today.slice(0, 7)}-01`, to: today };
  if (preset === 'prev-month') { const pm = m === 1 ? 12 : m - 1, py = m === 1 ? y - 1 : y; return { from: `${py}-${pad(pm)}-01`, to: `${py}-${pad(pm)}-${pad(lastDay(py, pm))}` }; }
  if (preset === 'quarter') { const qm = Math.floor((m - 1) / 3) * 3 + 1; return { from: `${y}-${pad(qm)}-01`, to: today }; }
  if (preset === 'year') return { from: `${y}-01-01`, to: today };
  return { from: `${today.slice(0, 7)}-01`, to: today };
}

function ecoTodayMsk() { return new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Moscow' }); }
```

- [ ] **Step 4: Каркас `economics.js`**

```js
// ── «💰 ЭКОНОМИКА» (только владелец): себестоимость и маржинальность по услугам ──
// Вкладки: services, goods, tech-cards, pay, fixed, equipment, settings. Период —
// пресеты + произвольный диапазон, как на дашборде. Зависимости: api(), esc(),
// notify(), ecoMoney()/ecoPct()/ecoSort()/ecoTotals() из economics-table.js.
const ECO_TABS = ['services', 'goods', 'tech-cards', 'pay', 'fixed', 'equipment', 'settings'];
let _eco = { tab: 'services', from: null, to: null, preset: 'month', report: null, sortKey: 'revenue', sortDir: 'desc', dicts: null, goods: null, cards: null };

function loadEconomics() {
  if (!_eco.from) { const p = ecoPeriodPreset('month', ecoTodayMsk()); _eco.from = p.from; _eco.to = p.to; }
  ecoRenderPeriod();
  ecoSwitchTab(_eco.tab || 'services');
}
function ecoSwitchTab(tab) {
  _eco.tab = tab;
  for (const t of ECO_TABS) {
    const pane = document.getElementById(`ecoTab-${t}`); const btn = document.getElementById(`ecoTabBtn-${t}`);
    if (pane) pane.style.display = t === tab ? '' : 'none';
    if (btn) btn.classList.toggle('active', t === tab);
  }
  const loaders = { services: ecoLoadServices, goods: ecoLoadGoods, 'tech-cards': ecoLoadTechCards, pay: ecoLoadPay, fixed: ecoLoadFixed, equipment: ecoLoadEquipment, settings: ecoLoadSettings };
  if (typeof loaders[tab] === 'function') loaders[tab]();
}
function ecoRenderPeriod() {
  document.querySelectorAll('#ecoPeriod .pb-btn').forEach(b => b.classList.toggle('active', b.dataset.preset === _eco.preset));
  const f = document.getElementById('ecoFrom'), t = document.getElementById('ecoTo');
  if (f) f.value = _eco.from; if (t) t.value = _eco.to;
  const lbl = document.getElementById('ecoPeriodLabel'); if (lbl) lbl.textContent = `${_eco.from} — ${_eco.to}`;
}
function ecoSetPreset(preset) {
  _eco.preset = preset;
  if (preset !== 'custom') { const p = ecoPeriodPreset(preset, ecoTodayMsk()); _eco.from = p.from; _eco.to = p.to; }
  _eco.report = null; ecoRenderPeriod();
  const r = document.getElementById('ecoRange'); if (r) r.style.display = preset === 'custom' ? '' : 'none';
  if (preset !== 'custom') ecoSwitchTab(_eco.tab);
}
function ecoApplyRange() {
  const f = document.getElementById('ecoFrom').value, t = document.getElementById('ecoTo').value;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(f) || !/^\d{4}-\d{2}-\d{2}$/.test(t)) return notify('Укажите обе даты', 'err');
  _eco.from = f <= t ? f : t; _eco.to = f <= t ? t : f; _eco.report = null; ecoRenderPeriod(); ecoSwitchTab(_eco.tab);
}
function ecoQs() { return `from=${_eco.from}&to=${_eco.to}`; }
async function ecoDicts() {
  if (!_eco.dicts) _eco.dicts = await api('GET', '/api/notification-rules/dictionaries');
  return _eco.dicts;
}
function ecoDictName(list, id) { const x = (list || []).find(i => String(i.id) === String(id)); return x ? x.name || x.title : String(id); }

// Загрузчики вкладок — задачи 16–18, 20–21. Заглушки, чтобы каркас работал.
function ecoLoadServices() {}
function ecoLoadGoods() {}
function ecoLoadTechCards() {}
function ecoLoadPay() {}
function ecoLoadFixed() {}
function ecoLoadEquipment() {}
function ecoLoadSettings() {}
```

- [ ] **Step 5: Разметка `index.html`**

В оба меню (десктоп `#mainNav` после «Пользователи» и drawer `#mnavList` после «Пользователи») добавить:

```html
      <div class="tn" data-p="economics" data-roles="owner" onclick="nav(this)">💰 Экономика</div>
```

Перед `<div class="page" id="page-knowledge-base">` добавить страницу:

```html
    <div class="page" id="page-economics">
      <div class="bc-head">
        <div>
          <div class="bc-head-title">💰 Экономика процедур</div>
          <div class="bc-head-sub">Себестоимость и маржинальность по услугам · <span id="ecoPeriodLabel"></span></div>
        </div>
        <div class="pb-wrap" id="ecoPeriod">
          <div class="pb-btns">
            <button class="pb-btn active" data-preset="month" onclick="ecoSetPreset('month')">Месяц</button>
            <button class="pb-btn" data-preset="prev-month" onclick="ecoSetPreset('prev-month')">Прошлый</button>
            <button class="pb-btn" data-preset="quarter" onclick="ecoSetPreset('quarter')">Квартал</button>
            <button class="pb-btn" data-preset="year" onclick="ecoSetPreset('year')">Год</button>
            <button class="pb-btn" data-preset="custom" onclick="ecoSetPreset('custom')">Период</button>
          </div>
          <div class="pb-range" id="ecoRange" style="display:none">
            <input type="date" id="ecoFrom" class="pb-date"><span class="pb-dash">—</span><input type="date" id="ecoTo" class="pb-date">
            <button class="btn btn-sm btn-pri" onclick="ecoApplyRange()">OK</button>
          </div>
        </div>
      </div>
      <div class="tabs eco-tabs">
        <button class="tab active" id="ecoTabBtn-services" onclick="ecoSwitchTab('services')">📊 Услуги</button>
        <button class="tab" id="ecoTabBtn-goods" onclick="ecoSwitchTab('goods')">🧴 Материалы</button>
        <button class="tab" id="ecoTabBtn-tech-cards" onclick="ecoSwitchTab('tech-cards')">📋 Техкарты</button>
        <button class="tab" id="ecoTabBtn-pay" onclick="ecoSwitchTab('pay')">👩‍⚕️ Оплата труда</button>
        <button class="tab" id="ecoTabBtn-fixed" onclick="ecoSwitchTab('fixed')">🏢 Постоянные</button>
        <button class="tab" id="ecoTabBtn-equipment" onclick="ecoSwitchTab('equipment')">🔬 Аппараты</button>
        <button class="tab" id="ecoTabBtn-settings" onclick="ecoSwitchTab('settings')">⚙️ Настройки</button>
      </div>
      <div id="ecoTab-services"><div id="ecoSummary" class="eco-summary"></div><div id="ecoServices" class="empty">Загрузка…</div><div id="ecoDetail"></div></div>
      <div id="ecoTab-goods" style="display:none"><div id="ecoGoods" class="empty">Загрузка…</div></div>
      <div id="ecoTab-tech-cards" style="display:none"><div id="ecoTechCards" class="empty">Загрузка…</div></div>
      <div id="ecoTab-pay" style="display:none"><div id="ecoPay" class="empty">Загрузка…</div></div>
      <div id="ecoTab-fixed" style="display:none"><div id="ecoFixed" class="empty">Загрузка…</div></div>
      <div id="ecoTab-equipment" style="display:none"><div id="ecoEquipment" class="empty">Загрузка…</div></div>
      <div id="ecoTab-settings" style="display:none"><div id="ecoSettings" class="empty">Загрузка…</div></div>
    </div>
```

После `<script src="js/pages/reminders.js?v=2026-08-19a"></script>` добавить:

```html
<script src="js/pages/economics-table.js?v=2026-10-18a"></script>
<script src="js/pages/economics.js?v=2026-10-18a"></script>
```

- [ ] **Step 6: `nav.js` и CSS**

В `navTo` после `if (p === 'agent-services') loadAgentServices();` добавить:

```js
  if (p === 'economics')      loadEconomics();
```

В `features.css` дописать в конец (и бампнуть `?v=` у `features.css` в `index.html` на `2026-10-18-eco1`):

```css
/* ── Экономика процедур ── */
.eco-tabs{max-width:980px}
.eco-summary{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px;margin-bottom:14px}
.eco-summary>.sc{min-width:0}
.eco-kpi{font-size:20px;font-weight:700}.eco-kpi-sub{font-size:12px;color:var(--t3);margin-top:2px}
.eco-tbl th{cursor:pointer;white-space:nowrap;user-select:none}.eco-tbl th.sorted::after{content:' ▾';opacity:.6}.eco-tbl th.sorted.asc::after{content:' ▴'}
.eco-tbl td.num,.eco-tbl th.num{text-align:right;font-variant-numeric:tabular-nums}
.eco-tbl tr.eco-total td{font-weight:700;border-top:2px solid var(--bd)}
.eco-tbl tr.eco-row{cursor:pointer}.eco-tbl tr.eco-row:hover{background:var(--bg)}
.eco-neg{color:#ef4444}.eco-strong{font-weight:600}
.eco-badge-warn{background:#fef3c7;color:#92400e}.eco-badge-err{background:#fee2e2;color:#991b1b}.eco-badge-muted{background:var(--bg);color:var(--t3)}
.eco-flags{display:flex;gap:4px;flex-wrap:wrap;margin-top:3px}
.eco-form{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:10px;align-items:end}
.eco-form .fg{margin-bottom:0}
.eco-detail{margin-top:14px}
@media(max-width:700px){.eco-summary{grid-template-columns:1fr 1fr}.eco-form{grid-template-columns:1fr}}
```

- [ ] **Step 7: Запустить тесты фронта и открыть страницу**

Run: `cd /root/loyalpro && node --test frontend/js/pages/economics-table.test.js frontend/js/pages/notifications.test.js 2>&1 | tail -6`
Expected: PASS (включая проверку всех `<script>` index.html одним контекстом в `notifications.test.js`).

Открыть `http://localhost:3001/#economics` под владельцем через `mcp__playwright__*`: пункт «💰 Экономика» виден, вкладки переключаются, у администратора пункта нет.

- [ ] **Step 8: Commit**

```bash
cd /root/loyalpro && git add frontend/index.html frontend/js/core/nav.js frontend/css/features.css frontend/js/pages/economics-table.js frontend/js/pages/economics-table.test.js frontend/js/pages/economics.js && git commit -m "feat(economics): страница «Экономика» — каркас, период, пункт меню владельца, чистые помощники"
```

---

### Task 16: Фронт — вкладка «Услуги»: сводка, таблица с сортировкой, детализация

**Модель: Opus (L2).** Самая насыщенная вкладка: сводка периода, 13 колонок с итогом и бейджами, детализация по статьям/сотрудникам/визитам.

**Files:**
- Modify: `frontend/js/pages/economics.js` (заменить заглушку `ecoLoadServices`)

- [ ] **Step 1: Реализация**

```js
async function ecoLoadServices() {
  const box = document.getElementById('ecoServices'); const sum = document.getElementById('ecoSummary');
  document.getElementById('ecoDetail').innerHTML = '';
  try {
    if (!_eco.report) { box.innerHTML = '<div class="empty">Загрузка…</div>'; _eco.report = await api('GET', `/api/economics/services?${ecoQs()}`); }
    ecoRenderSummary(_eco.report.summary, sum);
    ecoRenderServices(_eco.report.services, box);
  } catch (e) { box.innerHTML = `<div class="empty">Ошибка: ${esc(e.message)}</div>`; sum.innerHTML = ''; }
}

function ecoRenderSummary(s, el) {
  const c = s.coverage || {};
  const tile = (kpi, title, sub) => `<div class="sc"><div class="eco-kpi">${kpi}</div><div>${esc(title)}</div>${sub ? `<div class="eco-kpi-sub">${sub}</div>` : ''}</div>`;
  el.innerHTML = [
    tile(ecoMoney(s.revenue), 'Выручка', `${ecoNum(s.visits)} визитов · ${ecoNum(s.hours, 0)} ч`),
    tile(ecoMoney(s.contribution), 'Маржинальная прибыль', ecoPct(s.contribution_pct)),
    tile(ecoMoney(s.operating_profit), 'Операционная прибыль', `${ecoPct(s.operating_pct)} · УСН ≈ ${ecoMoney(s.usn_estimate)}`),
    tile(`${ecoNum(s.rate_minute_fact, 1)} ₽`, 'Ставка минуты (факт)', s.rate_minute_capacity ? `при полной загрузке ${ecoNum(s.rate_minute_capacity, 1)} ₽ · простой ${ecoMoney(s.idle_cost)}` : 'график сотрудников не загружен'),
    tile(ecoPct(c.consumables_share), 'Визитов со списаниями', `${ecoNum(c.services_without_tech_card)} из ${ecoNum(c.services_total)} услуг без техкарты`),
    tile(ecoNum((c.goods_without_price || []).length), 'Товаров без цены', `${ecoNum(c.staff_without_pay_rule)} сотрудников без правила оплаты`),
  ].join('');
}

function ecoRenderServices(groups, el) {
  if (!groups.length) { el.innerHTML = '<div class="empty">Состоявшихся визитов в периоде нет</div>'; return; }
  const rows = ecoSort(groups, _eco.sortKey, _eco.sortDir);
  const t = ecoTotals(groups);
  const th = ECO_SERVICE_COLS.map(c => `<th class="${c.fmt === 'text' ? '' : 'num'}${_eco.sortKey === c.key ? ' sorted ' + _eco.sortDir : ''}" onclick="ecoSortBy('${c.key}')">${esc(c.title)}</th>`).join('');
  const cell = (g, c) => {
    const v = g[c.key]; const neg = typeof v === 'number' && v < 0 && c.fmt === 'money';
    const txt = c.fmt === 'text' ? `${esc(v)}<div class="eco-flags">${ecoFlags(g).map(f => `<span class="badge ${f.cls}" title="${escAttr(f.title)}">${esc(f.text)}</span>`).join('')}</div>` : ecoFmt(v, c.fmt);
    return `<td class="${c.fmt === 'text' ? '' : 'num'}${neg ? ' eco-neg' : ''}${c.strong ? ' eco-strong' : ''}">${txt}</td>`;
  };
  const body = rows.map(g => `<tr class="eco-row" onclick="ecoOpenService(${Number(g.key)})">${ECO_SERVICE_COLS.map(c => cell(g, c)).join('')}</tr>`).join('');
  const total = `<tr class="eco-total">${ECO_SERVICE_COLS.map(c => `<td class="${c.fmt === 'text' ? '' : 'num'}">${c.key === 'label' ? 'Итого' : ecoFmt(t[c.key], c.fmt)}</td>`).join('')}</tr>`;
  el.innerHTML = `<div class="card" style="padding:0"><div class="tw"><table class="mtbl eco-tbl"><thead><tr>${th}</tr></thead><tbody>${body}${total}</tbody></table></div></div>
    <div class="eco-kpi-sub" style="margin-top:8px">Материалы — факт списаний YClients по записи; «оценка N» — у N строк списаний не было, взята норма техкарты. Эквайринг без привязанных оплат — по средней доле периода. Клик по услуге — детализация.</div>`;
}
function ecoSortBy(key) {
  if (_eco.sortKey === key) _eco.sortDir = _eco.sortDir === 'desc' ? 'asc' : 'desc'; else { _eco.sortKey = key; _eco.sortDir = key === 'label' ? 'asc' : 'desc'; }
  if (_eco.report) ecoRenderServices(_eco.report.services, document.getElementById('ecoServices'));
}

async function ecoOpenService(serviceId) {
  const el = document.getElementById('ecoDetail');
  el.innerHTML = '<div class="empty">Загрузка…</div>';
  try {
    const d = await api('GET', `/api/economics/services/${serviceId}?${ecoQs()}`);
    const s = d.service;
    const line = (label, value, note) => `<tr><td>${esc(label)}</td><td class="num">${value}</td><td class="eco-kpi-sub">${note || ''}</td></tr>`;
    const items = [
      line('Стоимость услуг (после скидок)', ecoMoney(s.price), `скидки ${ecoMoney(s.discount)} — справочно`),
      line('− списанные бонусы', ecoMoney(s.bonus_redeemed), 'доля записи по цене услуги'),
      line('= Выручка', ecoMoney(s.revenue), ''),
      line('− Материалы', ecoMoney(s.materials_used), `факт ${ecoMoney(s.materials_fact)} · норма ${ecoMoney(s.materials_norm)} · оценка у ${ecoNum(s.materials_estimated_rows)} строк`),
      line('− Оплата врача', ecoMoney(s.doctor_cost), `на руки ${ecoMoney(s.doctor_pay)} × множитель ФОТ ${ecoNum(d.settings.payroll_multiplier, 3)}`),
      line('− Эквайринг', ecoMoney(s.acquiring_cost), `${ecoNum(s.coverage.acquiring_estimated)} строк по оценке`),
      line('= Маржинальная прибыль', ecoMoney(s.contribution), ecoPct(s.contribution_pct)),
      line('− Постоянные расходы', ecoMoney(s.overhead), `драйвер: ${d.settings.allocation_driver === 'visits' ? 'поровну на визит' : 'по минутам'}`),
      line('− Аппараты', ecoMoney(s.equipment_cost), ''),
      line('= Операционная прибыль', ecoMoney(s.operating_profit), `${ecoPct(s.operating_pct)} · УСН ≈ ${ecoMoney(s.usn_estimate)} · ${ecoMoney(s.profit_per_hour)}/час`),
    ].join('');
    const staff = d.byStaff.map(g => `<tr><td>${esc(g.label)}</td><td class="num">${ecoNum(g.visits)}</td><td class="num">${ecoMoney(g.revenue)}</td><td class="num">${ecoMoney(g.materials_used)}</td><td class="num">${ecoMoney(g.doctor_cost)}</td><td class="num">${ecoMoney(g.contribution)}</td><td class="num">${ecoPct(g.contribution_pct)}</td></tr>`).join('');
    const flags = (v) => [v.materials_estimated ? 'оценка материалов' : '', v.no_materials_data ? 'нет данных о материалах' : '', v.no_price_goods.length ? `без цены: ${v.no_price_goods.length}` : '', v.no_pay_rule ? 'нет правила оплаты' : '', v.acquiring_estimated ? 'нет оплат' : ''].filter(Boolean).join(' · ');
    const visits = d.visits.map(v => `<tr><td>${esc(v.visit_date)}</td><td>${esc(v.staff_name)}</td><td class="num">${ecoMoney(v.price)}</td><td class="num">${ecoMoney(v.revenue)}</td><td class="num">${ecoMoney(v.materials_used)}</td><td class="num">${ecoMoney(v.doctor_cost)}</td><td class="num">${ecoMoney(v.acquiring_cost)}</td><td class="num ${v.contribution < 0 ? 'eco-neg' : ''}">${ecoMoney(v.contribution)}</td><td class="num">${ecoNum(v.minutes)}</td><td class="eco-kpi-sub">${esc(flags(v))}</td></tr>`).join('');
    el.innerHTML = `<div class="card eco-detail">
      <div class="bc-head"><div><div class="bc-head-title">${esc(s.label)}</div><div class="bc-head-sub">${ecoNum(s.visits)} визитов · ${ecoNum(s.hours, 1)} ч</div></div><button class="btn btn-sm" onclick="document.getElementById('ecoDetail').innerHTML=''">✕ Закрыть</button></div>
      <div class="tw"><table class="mtbl eco-tbl"><tbody>${items}</tbody></table></div>
      <h4 style="margin:14px 0 6px">По сотрудникам</h4>
      <div class="tw"><table class="mtbl eco-tbl"><thead><tr><th>Сотрудник</th><th class="num">Визитов</th><th class="num">Выручка</th><th class="num">Материалы</th><th class="num">Врач</th><th class="num">Марж. прибыль</th><th class="num">%</th></tr></thead><tbody>${staff}</tbody></table></div>
      <h4 style="margin:14px 0 6px">Визиты</h4>
      <div class="tw"><table class="mtbl eco-tbl"><thead><tr><th>Дата</th><th>Сотрудник</th><th class="num">Цена</th><th class="num">Выручка</th><th class="num">Материалы</th><th class="num">Врач</th><th class="num">Экв.</th><th class="num">Марж.</th><th class="num">Мин</th><th>Флаги</th></tr></thead><tbody>${visits}</tbody></table></div>
    </div>`;
    el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (e) { el.innerHTML = `<div class="empty">Ошибка: ${esc(e.message)}</div>`; }
}
```

- [ ] **Step 2: Проверить тесты и живую страницу**

Run: `cd /root/loyalpro && node --test frontend/js/pages/economics-table.test.js 2>&1 | tail -3` → PASS.

Через `mcp__playwright__*` открыть `#economics` на деве за «Прошлый» месяц: сводка из 6 плиток, таблица с итогом, сортировка по клику на «Выручка» и «%», клик по услуге открывает детализацию с тремя таблицами; на ширине 390px таблица листается горизонтально (`.tw`), карточки сводки в 2 колонки. Скриншот — `/tmp/eco-services.png`.

- [ ] **Step 3: Бамп `?v=` и commit**

Поднять `economics.js?v=2026-10-18b` в `index.html`.

```bash
cd /root/loyalpro && git add frontend/js/pages/economics.js frontend/index.html && git commit -m "feat(economics): вкладка «Услуги» — сводка периода, таблица с сортировкой и итогом, детализация"
```

---

### Task 17: Фронт — вкладки «Материалы» и «Техкарты»

**Модель: Sonnet (L1).**

**Files:**
- Modify: `frontend/js/pages/economics.js` (заменить заглушки `ecoLoadGoods`, `ecoLoadTechCards`)

- [ ] **Step 1: «Материалы»**

```js
async function ecoLoadGoods(search) {
  const el = document.getElementById('ecoGoods');
  try {
    const q = search !== undefined ? search : (document.getElementById('ecoGoodsSearch') || {}).value || '';
    const only = (document.getElementById('ecoGoodsOnly') || {}).checked !== false;
    const r = await api('GET', `/api/economics/goods?search=${encodeURIComponent(q)}&only_consumables=${only ? 1 : 0}`);
    _eco.goods = r.goods;
    const rows = r.goods.map(g => `<tr>
      <td>${esc(g.title)}<div class="eco-kpi-sub">${esc(g.category_title || '')}</div></td>
      <td>${esc(g.service_unit || g.unit || '')}${g.unit_equals && Number(g.unit_equals) !== 1 ? `<div class="eco-kpi-sub">1 ${esc(g.unit || '')} = ${ecoNum(g.unit_equals, 2)} ${esc(g.service_unit || '')}</div>` : ''}</td>
      <td class="num">${g.last_receipt_price != null ? ecoNum(g.last_receipt_price, 2) : '—'}${g.last_receipt_at ? `<div class="eco-kpi-sub">${esc(String(g.last_receipt_at).slice(0, 10))}</div>` : ''}</td>
      <td class="num">${g.unit_actual_cost != null ? ecoNum(g.unit_actual_cost, 2) : '—'}</td>
      <td class="num"><input type="number" step="0.01" min="0" class="eco-price" style="width:90px" value="${g.override_price != null ? esc(String(g.override_price)) : ''}" placeholder="—" onchange="ecoSavePrice(${Number(g.good_id)}, this.value)"></td>
      <td class="num">${(g.stock || []).reduce((a, s) => a + (Number(s.amount) || 0), 0).toLocaleString('ru-RU')}</td>
      <td><button class="btn btn-sm" onclick="ecoShowReceipts(${Number(g.good_id)}, this)">История</button></td>
    </tr>`).join('');
    el.innerHTML = `<div class="bc-head"><div><div class="bc-head-title">🧴 Материалы</div><div class="bc-head-sub">Цена единицы списания: последняя закупка → ручная → себестоимость YClients</div></div>
        <div style="display:flex;gap:8px;align-items:center"><input id="ecoGoodsSearch" placeholder="Поиск…" value="${escAttr(q)}" onkeydown="if(event.key==='Enter')ecoLoadGoods()"><label style="font-size:12px"><input type="checkbox" id="ecoGoodsOnly" ${only ? 'checked' : ''} onchange="ecoLoadGoods()"> только расходники</label></div></div>
      <div class="card" style="padding:0"><div class="tw"><table class="mtbl eco-tbl"><thead><tr><th>Товар</th><th>Ед. списания</th><th class="num">Последняя закупка</th><th class="num">Себест. YClients</th><th class="num">Ручная цена</th><th class="num">Остаток</th><th></th></tr></thead><tbody>${rows || '<tr><td colspan="7" class="empty">Ничего не найдено</td></tr>'}</tbody></table></div></div>`;
  } catch (e) { el.innerHTML = `<div class="empty">Ошибка: ${esc(e.message)}</div>`; }
}
async function ecoSavePrice(goodId, value) {
  try {
    await api('PUT', `/api/economics/goods/${goodId}/price`, { unitPrice: value === '' ? null : Number(value) });
    _eco.report = null; notify(value === '' ? 'Ручная цена снята' : 'Ручная цена сохранена');
  } catch (e) { notify('Ошибка: ' + e.message, 'err'); }
}
async function ecoShowReceipts(goodId, btn) {
  const tr = btn.closest('tr');
  const next = tr.nextElementSibling;
  if (next && next.classList.contains('eco-receipts')) { next.remove(); return; }
  try {
    const r = await api('GET', `/api/economics/goods/${goodId}/receipts`);
    const rows = r.receipts.map(x => `<tr><td>${esc(String(x.create_date).slice(0, 10))}</td><td class="num">${ecoNum(x.amount, 2)} ${esc(x.unit_title || '')}</td><td class="num">${ecoNum(x.cost_per_unit, 2)}</td><td class="num">${ecoNum(x.discount, 2)}%</td><td class="num">${ecoMoney(x.cost)}</td><td>${esc(x.supplier_title || '')}</td></tr>`).join('');
    tr.insertAdjacentHTML('afterend', `<tr class="eco-receipts"><td colspan="7"><table class="mtbl eco-tbl"><thead><tr><th>Дата</th><th class="num">Кол-во</th><th class="num">Цена за ед.</th><th class="num">Скидка</th><th class="num">Сумма</th><th>Поставщик</th></tr></thead><tbody>${rows || '<tr><td colspan="6" class="empty">Поступлений нет</td></tr>'}</tbody></table></td></tr>`);
  } catch (e) { notify('Ошибка: ' + e.message, 'err'); }
}
```

- [ ] **Step 2: «Техкарты»**

```js
async function ecoLoadTechCards() {
  const el = document.getElementById('ecoTechCards');
  try {
    const [cov, cards] = await Promise.all([api('GET', `/api/economics/coverage?${ecoQs()}`), api('GET', '/api/economics/tech-cards')]);
    _eco.cards = cards.cards;
    const cardOpts = (sel) => `<option value="">— выбрать техкарту —</option>` + _eco.cards.map(c => `<option value="${c.id}" ${sel === c.id ? 'selected' : ''}>${esc(c.title)}${c.source === 'manual' ? ' (норма LoyalPro)' : ''}</option>`).join('');
    const rows = cov.services.map(s => {
      const tc = s.tech_card;
      const items = tc ? tc.items.map(i => `${esc(i.title || ('товар ' + i.good_id))} × ${ecoNum(i.amount, 2)} ${esc(i.unit || '')}`).join('; ') : '';
      const sugg = s.suggestions.map(x => `<button class="btn btn-sm" onclick="ecoLinkCard(${s.service_yc_id}, ${x.tech_card_id})">Похоже: ${esc(x.title)}</button>`).join(' ');
      return `<tr>
        <td>${esc(s.title)}<div class="eco-kpi-sub">${ecoNum(s.visits)} визитов · списания у ${ecoPct(s.consumables_share)}</div></td>
        <td>${tc ? `<b>${esc(tc.title)}</b> <span class="badge eco-badge-muted">${esc(tc.source)}${tc.staff_yc_id ? ' · сотрудник ' + esc(String(tc.staff_yc_id)) : ''}</span><div class="eco-kpi-sub">${items}</div>` : `<span class="badge eco-badge-warn">нет техкарты</span> ${sugg}`}</td>
        <td style="white-space:nowrap">
          <select onchange="ecoLinkCard(${s.service_yc_id}, this.value)">${cardOpts(tc ? tc.id : null)}</select>
          <button class="btn btn-sm" onclick="ecoLookupCard(${s.service_yc_id}, ${JSON.stringify(s.staff_yc_ids)})" title="default_for_staff_and_service по каждому исполнителю (≤4 вызова)">Найти в YClients</button>
          ${tc && tc.source === 'manual' ? `<button class="btn btn-sm" onclick="ecoLinkCard(${s.service_yc_id}, null)">Отвязать</button>` : ''}
        </td></tr>`;
    }).join('');
    const manual = _eco.cards.filter(c => c.source === 'manual').map(c => `<tr><td>${esc(c.title)}</td><td class="eco-kpi-sub">${c.items.map(i => `${esc(i.title || ('товар ' + i.good_id))} × ${ecoNum(i.amount, 2)}`).join('; ')}</td><td class="num">${c.links}</td><td><button class="btn btn-sm" onclick="ecoDeleteManual(${c.id})">Удалить</button></td></tr>`).join('');
    el.innerHTML = `<div class="bc-head"><div><div class="bc-head-title">📋 Техкарты и покрытие</div><div class="bc-head-sub">Услуги периода: есть ли норма и доля визитов со списаниями — рабочий список «что заполнить в YClients»</div></div>
        <div style="display:flex;gap:8px"><button class="btn btn-sm" onclick="ecoSyncCards()">⟳ Импорт из YClients</button><button class="btn btn-sm btn-pri" onclick="ecoNewManual()">+ Завести норму</button></div></div>
      <div class="card" style="padding:0"><div class="tw"><table class="mtbl eco-tbl"><thead><tr><th>Услуга</th><th>Техкарта</th><th>Привязка</th></tr></thead><tbody>${rows || '<tr><td colspan="3" class="empty">Визитов в периоде нет</td></tr>'}</tbody></table></div></div>
      <div id="ecoManualForm"></div>
      <h4 style="margin:14px 0 6px">Нормы LoyalPro (ручные)</h4>
      <div class="card" style="padding:0"><div class="tw"><table class="mtbl eco-tbl"><thead><tr><th>Название</th><th>Состав</th><th class="num">Привязок</th><th></th></tr></thead><tbody>${manual || '<tr><td colspan="4" class="empty">Ручных норм нет</td></tr>'}</tbody></table></div></div>
      <div class="eco-kpi-sub" style="margin-top:8px">Импортированных техкарт YClients: ${_eco.cards.filter(c => c.source === 'yclients').length} (только чтение; состав — в YClients).</div>`;
  } catch (e) { el.innerHTML = `<div class="empty">Ошибка: ${esc(e.message)}</div>`; }
}
async function ecoLinkCard(serviceId, cardId) {
  try { await api('PUT', `/api/economics/services/${serviceId}/tech-card`, { techCardId: cardId ? Number(cardId) : null }); _eco.report = null; notify('Привязка сохранена'); ecoLoadTechCards(); }
  catch (e) { notify('Ошибка: ' + e.message, 'err'); }
}
async function ecoLookupCard(serviceId, staffIds) {
  try {
    const r = await api('POST', `/api/economics/services/${serviceId}/tech-card/lookup`, { staffYcIds: staffIds });
    _eco.report = null; notify(r.found.length ? `Найдено: ${r.found.map(f => f.title).join(', ')}` : `Проверено исполнителей: ${r.checked}, техкарты в YClients нет`, r.found.length ? 'ok' : 'err');
    ecoLoadTechCards();
  } catch (e) { notify('Ошибка: ' + e.message, 'err'); }
}
async function ecoSyncCards() {
  try { const r = await api('POST', '/api/economics/tech-cards/sync'); notify(`Импортировано техкарт: ${r.cards}`); ecoLoadTechCards(); }
  catch (e) { notify('Ошибка: ' + e.message, 'err'); }
}
function ecoNewManual() {
  document.getElementById('ecoManualForm').innerHTML = `<div class="card" style="margin-top:12px">
    <div class="fg"><label class="fl">Название нормы</label><input id="ecoManTitle" placeholder="Например: Чистка лица — расходники"></div>
    <div id="ecoManItems"></div>
    <button class="btn btn-sm" onclick="ecoManAddItem()">+ Позиция</button>
    <div style="margin-top:10px"><button class="btn btn-pri" onclick="ecoSaveManual()">Сохранить</button> <button class="btn" onclick="document.getElementById('ecoManualForm').innerHTML=''">Отмена</button></div></div>`;
  ecoManAddItem();
}
function ecoManAddItem() {
  const opts = (_eco.goods || []).map(g => `<option value="${g.good_id}">${esc(g.title)}</option>`).join('');
  document.getElementById('ecoManItems').insertAdjacentHTML('beforeend', `<div class="eco-form eco-man-item" style="margin-bottom:8px">
    <div class="fg"><label class="fl">Товар</label>${opts ? `<select class="eco-man-good">${opts}</select>` : '<input class="eco-man-good" type="number" placeholder="id товара YClients">'}</div>
    <div class="fg"><label class="fl">Количество</label><input class="eco-man-amount" type="number" step="0.01" min="0"></div>
    <div class="fg"><label class="fl">Единица</label><input class="eco-man-unit" placeholder="мл / ед. / шт."></div></div>`);
  if (!_eco.goods) ecoPreloadGoods();
}
async function ecoPreloadGoods() { try { _eco.goods = (await api('GET', '/api/economics/goods?only_consumables=1')).goods; } catch {} }
async function ecoSaveManual() {
  const items = [...document.querySelectorAll('.eco-man-item')].map(d => ({ goodId: Number(d.querySelector('.eco-man-good').value), amount: Number(d.querySelector('.eco-man-amount').value), unit: d.querySelector('.eco-man-unit').value }));
  try { await api('POST', '/api/economics/tech-cards', { title: document.getElementById('ecoManTitle').value, items }); _eco.report = null; notify('Норма сохранена'); ecoLoadTechCards(); }
  catch (e) { notify('Ошибка: ' + e.message, 'err'); }
}
async function ecoDeleteManual(id) {
  if (!confirm('Удалить норму? Привязки к ней тоже удалятся.')) return;
  try { await api('DELETE', `/api/economics/tech-cards/${id}`); _eco.report = null; ecoLoadTechCards(); } catch (e) { notify('Ошибка: ' + e.message, 'err'); }
}
```

- [ ] **Step 3: Проверка и commit**

Run: `cd /root/loyalpro && node --test frontend/js/pages/economics-table.test.js 2>&1 | tail -3` → PASS. Через `mcp__playwright__*`: вкладка «Материалы» показывает каталог с ценами последней закупки (после догона задачи 6), ручная цена сохраняется и переживает перезагрузку; «Техкарты» — список услуг периода, «Найти в YClients» по услуге без привязки отрабатывает (уведомление), импорт — «Импортировано техкарт: 81».

Поднять `economics.js?v=2026-10-18c`.

```bash
cd /root/loyalpro && git add frontend/js/pages/economics.js frontend/index.html && git commit -m "feat(economics): вкладки «Материалы» (цены, история поступлений) и «Техкарты» (покрытие, привязки, нормы)"
```

---

### Task 18: Фронт — вкладки «Оплата труда» и «Настройки»

**Модель: Sonnet (L1).**

**Files:**
- Modify: `frontend/js/pages/economics.js` (заменить заглушки `ecoLoadPay`, `ecoLoadSettings`)

- [ ] **Step 1: «Оплата труда»**

```js
async function ecoLoadPay() {
  const el = document.getElementById('ecoPay');
  try {
    const [r, d] = await Promise.all([api('GET', '/api/economics/pay-rules'), ecoDicts()]);
    const scope = (x) => [x.staff_yc_id ? 'сотрудник: ' + ecoDictName(d.staff, x.staff_yc_id) : '', x.service_yc_id ? 'услуга: ' + ecoDictName(d.services, x.service_yc_id) : '', x.category_yc_id ? 'категория: ' + ecoDictName(d.categories, x.category_yc_id) : ''].filter(Boolean).join(' · ') || 'салон по умолчанию';
    const rows = r.rules.map(x => `<tr><td>${esc(scope(x))}${x.note ? `<div class="eco-kpi-sub">${esc(x.note)}</div>` : ''}</td><td class="num">${ecoNum(x.percent, 2)}%</td><td>${x.base === 'net_of_materials' ? 'выручка − материалы' : 'выручка'}</td><td class="num">${ecoMoney(x.fixed_per_visit)}</td><td>${esc(x.valid_from || '…')} — ${esc(x.valid_to || '…')}</td><td><button class="btn btn-sm" onclick="ecoEditRule(${x.id})">Изменить</button> <button class="btn btn-sm" onclick="ecoDeleteRule(${x.id})">Удалить</button></td></tr>`).join('');
    _eco.rules = r.rules;
    el.innerHTML = `<div class="bc-head"><div><div class="bc-head-title">👩‍⚕️ Оплата труда</div><div class="bc-head-sub">Приоритет: услуга → категория → сотрудник → салон. Сотрудник без правила — оплата 0 и флаг в отчёте</div></div><button class="btn btn-sm btn-pri" onclick="ecoEditRule(null)">+ Правило</button></div>
      <div id="ecoRuleForm"></div>
      <div class="card" style="padding:0"><div class="tw"><table class="mtbl eco-tbl"><thead><tr><th>Область</th><th class="num">%</th><th>База</th><th class="num">Фикс/визит</th><th>Период</th><th></th></tr></thead><tbody>${rows || '<tr><td colspan="6" class="empty">Правил нет — оплата врача в отчёте равна 0</td></tr>'}</tbody></table></div></div>
      <div id="ecoPayrollCheck"></div>`;
  } catch (e) { el.innerHTML = `<div class="empty">Ошибка: ${esc(e.message)}</div>`; }
}
async function ecoEditRule(id) {
  const d = await ecoDicts();
  const x = id ? _eco.rules.find(r => r.id === id) : { percent: 30, base: 'gross', fixed_per_visit: 0 };
  const opt = (list, sel, label) => `<option value="">${label}</option>` + list.map(i => `<option value="${i.id}" ${String(sel) === String(i.id) ? 'selected' : ''}>${esc(i.name || i.title)}</option>`).join('');
  document.getElementById('ecoRuleForm').innerHTML = `<div class="card" style="margin-bottom:12px"><div class="eco-form">
    <div class="fg"><label class="fl">Сотрудник</label><select id="ecoRStaff">${opt(d.staff, x.staff_yc_id, '— все —')}</select></div>
    <div class="fg"><label class="fl">Услуга</label><select id="ecoRService">${opt(d.services, x.service_yc_id, '— любая —')}</select></div>
    <div class="fg"><label class="fl">Категория</label><select id="ecoRCat">${opt(d.categories, x.category_yc_id, '— любая —')}</select></div>
    <div class="fg"><label class="fl">Процент</label><input id="ecoRPct" type="number" step="0.01" min="0" max="100" value="${esc(String(x.percent))}"></div>
    <div class="fg"><label class="fl">База</label><select id="ecoRBase"><option value="gross" ${x.base === 'gross' ? 'selected' : ''}>от выручки</option><option value="net_of_materials" ${x.base === 'net_of_materials' ? 'selected' : ''}>выручка − материалы</option></select></div>
    <div class="fg"><label class="fl">Фикс за визит, ₽</label><input id="ecoRFixed" type="number" step="1" min="0" value="${esc(String(x.fixed_per_visit || 0))}"></div>
    <div class="fg"><label class="fl">Действует с</label><input id="ecoRFrom" type="date" value="${esc(x.valid_from || '')}"></div>
    <div class="fg"><label class="fl">по</label><input id="ecoRTo" type="date" value="${esc(x.valid_to || '')}"></div>
    <div class="fg"><label class="fl">Заметка</label><input id="ecoRNote" value="${escAttr(x.note || '')}"></div>
    </div><div style="margin-top:10px"><button class="btn btn-pri" onclick="ecoSaveRule(${id || 'null'})">Сохранить</button> <button class="btn" onclick="document.getElementById('ecoRuleForm').innerHTML=''">Отмена</button></div></div>`;
}
async function ecoSaveRule(id) {
  const v = (i) => document.getElementById(i).value;
  const body = { staffYcId: v('ecoRStaff') || null, serviceYcId: v('ecoRService') || null, categoryYcId: v('ecoRCat') || null, percent: Number(v('ecoRPct')), base: v('ecoRBase'), fixedPerVisit: Number(v('ecoRFixed')), validFrom: v('ecoRFrom') || null, validTo: v('ecoRTo') || null, note: v('ecoRNote') };
  try { await api(id ? 'PUT' : 'POST', id ? `/api/economics/pay-rules/${id}` : '/api/economics/pay-rules', body); _eco.report = null; notify('Правило сохранено'); ecoLoadPay(); }
  catch (e) { notify('Ошибка: ' + e.message, 'err'); }
}
async function ecoDeleteRule(id) {
  if (!confirm('Удалить правило?')) return;
  try { await api('DELETE', `/api/economics/pay-rules/${id}`); _eco.report = null; ecoLoadPay(); } catch (e) { notify('Ошибка: ' + e.message, 'err'); }
}
```

- [ ] **Step 2: «Настройки»**

```js
async function ecoLoadSettings() {
  const el = document.getElementById('ecoSettings');
  try {
    const r = await api('GET', '/api/economics/settings');
    const s = r.settings;
    const acc = r.accounts.map(a => `<div class="fg"><label class="fl">${esc(a.title)} <span class="eco-kpi-sub">(${a.operations} оп.)</span></label><input class="eco-acq" data-account="${escAttr(a.title)}" type="number" step="0.01" min="0" max="10" value="${esc(String(s.acquiring[a.title] ?? 0))}"></div>`).join('');
    el.innerHTML = `<div class="card"><div class="bc-head-title">⚙️ Настройки расчёта</div>
      <div class="eco-form" style="margin-top:12px">
        <div class="fg"><label class="fl">Множитель налогов на ФОТ</label><input id="ecoSMult" type="number" step="0.001" min="1" max="3" value="${esc(String(s.payroll_multiplier))}"><div class="eco-kpi-sub">1,30 — взносы 30 %. Если процент врача «на руки» — 1,494 (= 1,30 / 0,87)</div></div>
        <div class="fg"><label class="fl">База процента врача</label><select id="ecoSBase"><option value="0" ${!s.pay_base_includes_bonuses ? 'selected' : ''}>выручка (после списания бонусов)</option><option value="1" ${s.pay_base_includes_bonuses ? 'selected' : ''}>стоимость услуг до вычета бонусов (как схемы YClients)</option></select></div>
        <div class="fg"><label class="fl">Драйвер постоянных расходов</label><select id="ecoSDriver"><option value="minutes" ${s.allocation_driver === 'minutes' ? 'selected' : ''}>по минутам визита (рекомендуется)</option><option value="visits" ${s.allocation_driver === 'visits' ? 'selected' : ''}>поровну на визит</option></select><div class="eco-kpi-sub">По минутам: аренду и администратора потребляет время кабинета. «Поровну» нагружает 15-минутную процедуру как 90-минутную.</div></div>
        <div class="fg"><label class="fl">Ставка УСН, %</label><input id="ecoSUsn" type="number" step="0.5" min="0" max="50" value="${esc(String(s.usn_rate))}"><div class="eco-kpi-sub">Оценка от положительной операционной прибыли услуги</div></div>
      </div>
      <h4 style="margin:16px 0 6px">Эквайринг по кассам, %</h4>
      <div class="eco-kpi-sub" style="margin-bottom:8px">Кассы — из оплат за 12 месяцев. С 2026 года комиссия по картам облагается НДС 22 % — закладывайте в процент. Наличные — 0.</div>
      <div class="eco-form">${acc || '<div class="eco-kpi-sub">Оплат по услугам пока нет</div>'}</div>
      <div style="margin-top:14px"><button class="btn btn-pri" onclick="ecoSaveSettings()">Сохранить</button> <button class="btn" onclick="ecoRunSync()">⟳ Синхронизировать с YClients сейчас</button></div></div>`;
  } catch (e) { el.innerHTML = `<div class="empty">Ошибка: ${esc(e.message)}</div>`; }
}
async function ecoSaveSettings() {
  const acquiring = {};
  document.querySelectorAll('.eco-acq').forEach(i => { acquiring[i.dataset.account] = Number(i.value) || 0; });
  const body = { payrollMultiplier: Number(document.getElementById('ecoSMult').value), payBaseIncludesBonuses: document.getElementById('ecoSBase').value === '1', allocationDriver: document.getElementById('ecoSDriver').value, usnRate: Number(document.getElementById('ecoSUsn').value), acquiring };
  try { await api('PUT', '/api/economics/settings', body); _eco.report = null; notify('Настройки сохранены'); } catch (e) { notify('Ошибка: ' + e.message, 'err'); }
}
async function ecoRunSync() {
  try { const r = await api('POST', '/api/economics/sync'); _eco.report = null; notify(r.ok ? 'Синхронизация выполнена' : 'Синхронизация с ошибками: ' + Object.keys(r.errors).join(', '), r.ok ? 'ok' : 'err'); }
  catch (e) { notify('Ошибка: ' + e.message, 'err'); }
}
```

- [ ] **Step 3: Проверка и commit**

Run: `cd /root/loyalpro && node --test frontend/js/pages/economics-table.test.js 2>&1 | tail -3` → PASS. Через `mcp__playwright__*`: создать правило «салон по умолчанию 30 % gross», сохранить настройки с эквайрингом «Расчетный счет» 1.5 — после этого вкладка «Услуги» показывает ненулевые «Врач» и «Эквайринг».

Поднять `economics.js?v=2026-10-18d`.

```bash
cd /root/loyalpro && git add frontend/js/pages/economics.js frontend/index.html && git commit -m "feat(economics): вкладки «Оплата труда» (правила) и «Настройки» (ФОТ, база, драйвер, УСН, эквайринг)"
```

**Этап 1 завершён.** Контрольная точка: `cd backend && npx jest economics` зелёный; на деве за сентябрь 2026 у «Фотоомоложение Lumeca - лицо» число визитов совпадает со страницей «Записи» (фильтр по услуге, статус «пришёл»).

---

## Этап 2. Полная себестоимость

Расчёт overhead/аппаратов/УСН/прибыли в час уже заложен в `calc.js` и `report.js` (задачи 10, 12): без строк бюджета и аппаратов они дают нули. Этап добавляет справочники и их UI.

### Task 19: API бюджета постоянных расходов и реестра аппаратов

**Модель: Sonnet (L1).**

**Files:**
- Modify: `backend/routes/economics.js`, `backend/services/economics/store.js`
- Create: `backend/services/economics/equipment-seed.js`, `backend/services/economics/fixed-categories.js`
- Test: `backend/economics-routes.test.js` (дополнить)

- [ ] **Step 1: Падающие тесты парсеров**

```js
const { parseFixedCost, parseEquipment, parseMonth } = require('./routes/economics');

describe('parseFixedCost', () => {
  test('категория из списка, сумма ≥ 0, месяцы YYYY-MM → первое число', () => {
    expect(parseFixedCost({ category: 'rent', title: 'Аренда', amountMonth: 300000, monthFrom: '2026-01', monthTo: null }).value)
      .toEqual({ category: 'rent', title: 'Аренда', amount_month: 300000, month_from: '2026-01-01', month_to: null, note: '' });
    expect(parseFixedCost({ category: 'x', amountMonth: 1, monthFrom: '2026-01' }).error).toMatch(/категори/i);
    expect(parseFixedCost({ category: 'rent', amountMonth: -1, monthFrom: '2026-01' }).error).toMatch(/сумм/i);
    expect(parseFixedCost({ category: 'rent', amountMonth: 1, monthFrom: '2026-13' }).error).toMatch(/месяц/i);
    expect(parseFixedCost({ category: 'rent', amountMonth: 1, monthFrom: '2026-05', monthTo: '2026-04' }).error).toMatch(/период/i);
  });
});
describe('parseEquipment', () => {
  test('название, цена ≥ 0, срок 1–240, остаточная 0–100, ТО ≥ 0, service_ids — целые', () => {
    expect(parseEquipment({ name: 'Lumecca', purchasePrice: 5050000, purchaseDate: '2025-01-15', usefulLifeMonths: 60, residualPct: 10, maintenanceMonthly: 20000, serviceIds: [1, '2'], isActive: true }).value)
      .toEqual({ name: 'Lumecca', purchase_price: 5050000, purchase_date: '2025-01-15', useful_life_months: 60, residual_pct: 10, maintenance_monthly: 20000, service_ids: [1, 2], is_active: true, note: '' });
    expect(parseEquipment({ name: '', purchasePrice: 1 }).error).toBeTruthy();
    expect(parseEquipment({ name: 'X', purchasePrice: 1, usefulLifeMonths: 0 }).error).toBeTruthy();
    expect(parseEquipment({ name: 'X', purchasePrice: 1, serviceIds: ['a'] }).error).toBeTruthy();
    expect(parseEquipment({ name: 'X', purchasePrice: 1, purchaseDate: '2025-02-30' }).error).toBeTruthy();
  });
});
test('parseMonth', () => { expect(parseMonth('2026-09')).toBe('2026-09-01'); expect(parseMonth('2026-9')).toBeNull(); });
```

- [ ] **Step 2: Запустить — падает**

Run: `cd /root/loyalpro/backend && npx jest economics-routes 2>&1 | tail -5` → FAIL.

- [ ] **Step 3: Сид аппаратов (§12 спеки) — `equipment-seed.js`**

```js
'use strict';
// Сид реестра аппаратов PERI (§12 спеки, 18.10.2026): цены — ориентир из открытых
// источников, владелец вводит фактическую. service_ids пусты — привязку делает
// владелец на вкладке. Предлагается при первом открытии пустого реестра.
const EQUIPMENT_SEED = [
  { name: 'Morpheus8 (InMode)', purchase_price: 4400000, useful_life_months: 60, note: 'estelab.ru 4,4 млн – prosalonoff.ru 5,3 млн; насадки — расходник техкарты' },
  { name: 'Lumecca (InMode)', purchase_price: 5050000, useful_life_months: 60, note: 'prosalonoff.ru; лампа 100 000 вспышек → в ТО/мес; если одна платформа с Morpheus8 — ввести цену платформы один раз' },
  { name: 'Volnewmer (Classys)', purchase_price: 7100000, useful_life_months: 60, note: 'bc-clinic.ru, medeq.ru; картриджи — расходник' },
  { name: 'Pacer One Pro (MBT)', purchase_price: 1190000, useful_life_months: 60, note: 'paceronepro.ru 0,52–1,19 млн; лазерная эпиляция' },
  { name: 'Tesla Former (Iskra Medical)', purchase_price: 2800000, useful_life_months: 60, note: 'laserexpert.pro от 2,8 млн (б/у и аренда) — новая цена не найдена' },
  { name: 'PlaDuo (SHEnB)', purchase_price: 0, useful_life_months: 60, note: 'цена в РФ-источниках не найдена — уточнить у дилера' },
  { name: 'Beautylizer RSL', purchase_price: 0, useful_life_months: 60, note: 'цена не найдена — уточнить' },
  { name: 'HELEO4 (Harmonia LED Pro)', purchase_price: 0, useful_life_months: 60, note: 'цена не найдена; гель-фотосенсибилизатор — расходник' },
  { name: 'ProFacial A000-23', purchase_price: 100000, useful_life_months: 36, note: '≈30–100 тыс. по зарубежным листингам; Hollywood, аквапилинг, RF-лифтинг' },
  { name: 'Микротоки (модель уточнить)', purchase_price: 0, useful_life_months: 60, note: 'модель и цена неизвестны' },
];
module.exports = { EQUIPMENT_SEED };
```

- [ ] **Step 4: Категории и store**

`backend/services/economics/fixed-categories.js` — отдельный файл БЕЗ зависимостей, чтобы фронтовый `node --test` мог сверить паритет, не загружая `db.js`:

```js
'use strict';
// Статьи постоянных расходов. Фронт (ECO_FIXED_CATS в economics-table.js) сверяется с этим списком тестом.
const FIXED_CATEGORIES = ['rent', 'admin', 'cleaning', 'utilities', 'software', 'marketing', 'accounting', 'medwaste', 'other'];
module.exports = { FIXED_CATEGORIES };
```

В `store.js`:

```js
const { FIXED_CATEGORIES } = require('./fixed-categories');
async function listFixedCosts(salonId) { return db.any(FIXED_SQL, [salonId]); }
async function insertFixedCost(salonId, v) {
  const r = await db.one(`INSERT INTO fixed_costs (salon_id, category, title, amount_month, month_from, month_to, note) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
    [salonId, v.category, v.title, v.amount_month, v.month_from, v.month_to, v.note]);
  return r.id;
}
async function updateFixedCost(salonId, id, v) {
  const r = await db.query(`UPDATE fixed_costs SET category=$3, title=$4, amount_month=$5, month_from=$6, month_to=$7, note=$8, updated_at=NOW() WHERE salon_id=$1 AND id=$2`,
    [salonId, id, v.category, v.title, v.amount_month, v.month_from, v.month_to, v.note]);
  return r.rowCount > 0;
}
async function deleteFixedCost(salonId, id) { const r = await db.query('DELETE FROM fixed_costs WHERE salon_id=$1 AND id=$2', [salonId, id]); return r.rowCount > 0; }
/** Скопировать строки, действующие в месяце from, как новые строки месяца to (month_to = to). Возвращает число вставленных. */
async function copyFixedCosts(salonId, fromMonth, toMonth) {
  const r = await db.query(`
    INSERT INTO fixed_costs (salon_id, category, title, amount_month, month_from, month_to, note)
    SELECT salon_id, category, title, amount_month, $3::date, $3::date, note FROM fixed_costs
    WHERE salon_id = $1 AND month_from <= $2::date AND (month_to IS NULL OR month_to >= $2::date)
      AND NOT EXISTS (SELECT 1 FROM fixed_costs f2 WHERE f2.salon_id = fixed_costs.salon_id AND f2.category = fixed_costs.category AND f2.title = fixed_costs.title AND f2.month_from = $3::date)`,
    [salonId, fromMonth, toMonth]);
  return r.rowCount;
}
async function listEquipment(salonId) { return db.any(EQUIPMENT_SQL, [salonId]); }
async function insertEquipment(salonId, v) {
  const r = await db.one(`INSERT INTO equipment (salon_id, name, purchase_price, purchase_date, useful_life_months, residual_pct, maintenance_monthly, service_ids, is_active, note)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10) RETURNING id`,
    [salonId, v.name, v.purchase_price, v.purchase_date, v.useful_life_months, v.residual_pct, v.maintenance_monthly, JSON.stringify(v.service_ids), v.is_active, v.note]);
  return r.id;
}
async function updateEquipment(salonId, id, v) {
  const r = await db.query(`UPDATE equipment SET name=$3, purchase_price=$4, purchase_date=$5, useful_life_months=$6, residual_pct=$7, maintenance_monthly=$8, service_ids=$9::jsonb, is_active=$10, note=$11, updated_at=NOW()
    WHERE salon_id=$1 AND id=$2`, [salonId, id, v.name, v.purchase_price, v.purchase_date, v.useful_life_months, v.residual_pct, v.maintenance_monthly, JSON.stringify(v.service_ids), v.is_active, v.note]);
  return r.rowCount > 0;
}
async function deleteEquipment(salonId, id) { const r = await db.query('DELETE FROM equipment WHERE salon_id=$1 AND id=$2', [salonId, id]); return r.rowCount > 0; }
```
Экспортировать всё + `FIXED_CATEGORIES`.

- [ ] **Step 5: Парсеры и роуты (в `routes/economics.js`, перед `module.exports`)**

```js
const { FIXED_CATEGORIES } = store;
const { EQUIPMENT_SEED } = require('../services/economics/equipment-seed');
const { equipmentMonthly } = require('../services/economics/allocation');

function parseMonth(s) { return /^\d{4}-(0[1-9]|1[0-2])$/.test(String(s || '')) ? `${s}-01` : null; }
function parseFixedCost(b) {
  b = b || {};
  if (!FIXED_CATEGORIES.includes(b.category)) return { error: 'Неизвестная категория расходов' };
  const amount = Number(b.amountMonth);
  if (!Number.isFinite(amount) || amount < 0 || amount > 1e9) return { error: 'Сумма в месяц ≥ 0' };
  const mf = parseMonth(b.monthFrom); if (!mf) return { error: 'Месяц начала в формате YYYY-MM' };
  const mt = b.monthTo ? parseMonth(b.monthTo) : null; if (b.monthTo && !mt) return { error: 'Месяц окончания в формате YYYY-MM' };
  if (mt && mt < mf) return { error: 'Период: конец раньше начала' };
  return { value: { category: b.category, title: String(b.title || '').trim().slice(0, 255), amount_month: amount, month_from: mf, month_to: mt, note: String(b.note || '').slice(0, 500) } };
}
function parseEquipment(b) {
  b = b || {};
  const name = String(b.name || '').trim();
  if (!name || name.length > 255) return { error: 'Название 1–255 символов' };
  const price = Number(b.purchasePrice); if (!Number.isFinite(price) || price < 0 || price > 1e9) return { error: 'Цена покупки ≥ 0' };
  const pd = b.purchaseDate || null; if (pd && !isDate(pd)) return { error: 'Дата покупки YYYY-MM-DD' };
  const life = b.usefulLifeMonths === undefined ? 60 : Number(b.usefulLifeMonths);
  if (!Number.isInteger(life) || life < 1 || life > 240) return { error: 'Срок службы 1–240 месяцев' };
  const res = b.residualPct === undefined ? 0 : Number(b.residualPct); if (!Number.isFinite(res) || res < 0 || res > 100) return { error: 'Остаточная стоимость 0–100 %' };
  const mm = b.maintenanceMonthly === undefined ? 0 : Number(b.maintenanceMonthly); if (!Number.isFinite(mm) || mm < 0) return { error: 'ТО в месяц ≥ 0' };
  const ids = Array.isArray(b.serviceIds) ? b.serviceIds.map(optInt) : [];
  if (ids.some(x => !x || Number.isNaN(x))) return { error: 'service_ids — целые id услуг' };
  return { value: { name, purchase_price: price, purchase_date: pd, useful_life_months: life, residual_pct: res, maintenance_monthly: mm, service_ids: [...new Set(ids)], is_active: b.isActive !== false, note: String(b.note || '').slice(0, 500) } };
}

const crud = (prefix, { list, parse, insert, update, remove, decorate }) => {
  router.get(`/${prefix}`, async (req, res) => { try { const rows = await list(req.user.salonId); res.json({ rows: decorate ? rows.map(decorate) : rows }); } catch (e) { fail(res, prefix)(e); } });
  router.post(`/${prefix}`, async (req, res) => {
    const p = parse(req.body); if (p.error) return res.status(400).json({ error: p.error });
    try { const id = await insert(req.user.salonId, p.value); report.invalidate(req.user.salonId); res.json({ id }); } catch (e) { fail(res, prefix + ' create')(e); }
  });
  router.put(`/${prefix}/:id(\\d+)`, async (req, res) => {
    const p = parse(req.body); if (p.error) return res.status(400).json({ error: p.error });
    try { const ok = await update(req.user.salonId, Number(req.params.id), p.value); if (!ok) return res.status(404).json({ error: 'Не найдено' }); report.invalidate(req.user.salonId); res.json({ ok: true }); }
    catch (e) { fail(res, prefix + ' update')(e); }
  });
  router.delete(`/${prefix}/:id(\\d+)`, async (req, res) => {
    try { const ok = await remove(req.user.salonId, Number(req.params.id)); if (!ok) return res.status(404).json({ error: 'Не найдено' }); report.invalidate(req.user.salonId); res.json({ ok: true }); }
    catch (e) { fail(res, prefix + ' delete')(e); }
  });
};
// Статический путь /fixed-costs/copy объявлен ДО crud с /:id.
router.post('/fixed-costs/copy', async (req, res) => {
  const from = parseMonth(req.query.from), to = parseMonth(req.query.to);
  if (!from || !to) return res.status(400).json({ error: 'from и to в формате YYYY-MM' });
  try { const n = await store.copyFixedCosts(req.user.salonId, from, to); report.invalidate(req.user.salonId); res.json({ copied: n }); } catch (e) { fail(res, 'fixed copy')(e); }
});
crud('fixed-costs', { list: store.listFixedCosts, parse: parseFixedCost, insert: store.insertFixedCost, update: store.updateFixedCost, remove: store.deleteFixedCost });
router.get('/equipment/seed', (req, res) => res.json({ seed: EQUIPMENT_SEED }));
crud('equipment', { list: store.listEquipment, parse: parseEquipment, insert: store.insertEquipment, update: store.updateEquipment, remove: store.deleteEquipment,
  decorate: (e) => ({ ...e, monthly: equipmentMonthly(e) }) });

module.exports.parseFixedCost = parseFixedCost;
module.exports.parseEquipment = parseEquipment;
module.exports.parseMonth = parseMonth;
module.exports.FIXED_CATEGORIES = FIXED_CATEGORIES;
```

- [ ] **Step 6: Тесты и commit**

Run: `cd /root/loyalpro/backend && npx jest economics-routes 2>&1 | tail -5` → PASS.

```bash
cd /root/loyalpro && git add backend/routes/economics.js backend/services/economics/store.js backend/services/economics/equipment-seed.js backend/economics-routes.test.js && git commit -m "feat(economics): API бюджета постоянных расходов (с копированием месяца) и реестра аппаратов, сид §12"
```

---

### Task 20: Фронт — вкладки «Постоянные расходы» и «Аппараты»

**Модель: Sonnet (L1).**

**Files:**
- Modify: `frontend/js/pages/economics.js` (заменить заглушки `ecoLoadFixed`, `ecoLoadEquipment`), `frontend/js/pages/economics-table.js` (`ECO_FIXED_CATS`)

- [ ] **Step 1: Словарь категорий в `economics-table.js`**

```js
const ECO_FIXED_CATS = { rent: 'Аренда', admin: 'Администраторы (с налогами)', cleaning: 'Уборка', utilities: 'Коммунальные', software: 'ПО и подписки', marketing: 'Маркетинг', accounting: 'Бухгалтерия', medwaste: 'Медотходы и стерилизация', other: 'Прочее' };
```
Дописать в тест `economics-table.test.js`: `assert.strictEqual(Object.keys(plain(k('ECO_FIXED_CATS'))).length, 9);` и проверку паритета с бэкендом:
```js
test('ECO_FIXED_CATS совпадает с FIXED_CATEGORIES бэкенда', () => {
  const { FIXED_CATEGORIES } = require('../../../backend/services/economics/fixed-categories');
  assert.deepStrictEqual(Object.keys(plain(k('ECO_FIXED_CATS'))).sort(), [...FIXED_CATEGORIES].sort());
});
```
(Именно `fixed-categories.js`, а не `store.js`: тот тянет `db.js`, а фронтовый тест не должен поднимать пул БД — тот же приём, что `MSG_VERDICT_COLS` ↔ `dialog-verdicts/taxonomy`.)

- [ ] **Step 2: «Постоянные расходы»**

```js
async function ecoLoadFixed() {
  const el = document.getElementById('ecoFixed');
  try {
    const r = await api('GET', '/api/economics/fixed-costs');
    _eco.fixed = r.rows;
    const today = ecoTodayMsk().slice(0, 7);
    const months = [...new Set(r.rows.map(x => x.month_from.slice(0, 7)).concat([today]))].sort().reverse();
    const byMonth = (m) => r.rows.filter(x => x.month_from.slice(0, 7) <= m && (!x.month_to || x.month_to.slice(0, 7) >= m));
    const blocks = months.map(m => {
      const rows = byMonth(m);
      const total = rows.reduce((a, x) => a + Number(x.amount_month), 0);
      const tr = rows.map(x => `<tr><td>${esc(ECO_FIXED_CATS[x.category] || x.category)}</td><td>${esc(x.title)}</td><td class="num">${ecoMoney(x.amount_month)}</td><td>${esc(x.month_from.slice(0, 7))} — ${x.month_to ? esc(x.month_to.slice(0, 7)) : '…'}</td><td><button class="btn btn-sm" onclick="ecoEditFixed(${x.id})">Изменить</button> <button class="btn btn-sm" onclick="ecoDeleteFixed(${x.id})">Удалить</button></td></tr>`).join('');
      return `<div class="card" style="padding:0;margin-bottom:12px"><div class="bc-head" style="padding:12px 16px 0"><div class="bc-head-title">${esc(m)} · ${ecoMoney(total)} в месяц</div><button class="btn btn-sm" onclick="ecoCopyFixed('${m}')">Скопировать в следующий месяц</button></div>
        <div class="tw"><table class="mtbl eco-tbl"><thead><tr><th>Статья</th><th>Название</th><th class="num">В месяц</th><th>Действует</th><th></th></tr></thead><tbody>${tr || '<tr><td colspan="5" class="empty">Статей нет</td></tr>'}</tbody></table></div></div>`;
    }).join('');
    el.innerHTML = `<div class="bc-head"><div><div class="bc-head-title">🏢 Постоянные расходы</div><div class="bc-head-sub">Помесячный бюджет по статьям. В отчёте делится по минутам визитов (или поровну) с учётом доли дней месяца в периоде</div></div><button class="btn btn-sm btn-pri" onclick="ecoEditFixed(null)">+ Статья</button></div><div id="ecoFixedForm"></div>${blocks}`;
  } catch (e) { el.innerHTML = `<div class="empty">Ошибка: ${esc(e.message)}</div>`; }
}
function ecoEditFixed(id) {
  const x = id ? _eco.fixed.find(f => f.id === id) : { category: 'rent', title: '', amount_month: 0, month_from: ecoTodayMsk().slice(0, 7) + '-01', month_to: null };
  const cats = Object.entries(ECO_FIXED_CATS).map(([k, v]) => `<option value="${k}" ${x.category === k ? 'selected' : ''}>${esc(v)}</option>`).join('');
  document.getElementById('ecoFixedForm').innerHTML = `<div class="card" style="margin-bottom:12px"><div class="eco-form">
    <div class="fg"><label class="fl">Статья</label><select id="ecoFCat">${cats}</select></div>
    <div class="fg"><label class="fl">Название</label><input id="ecoFTitle" value="${escAttr(x.title)}" placeholder="Аренда, 2 этаж"></div>
    <div class="fg"><label class="fl">Сумма в месяц, ₽</label><input id="ecoFAmount" type="number" min="0" step="1" value="${esc(String(x.amount_month))}"></div>
    <div class="fg"><label class="fl">С месяца</label><input id="ecoFFrom" type="month" value="${esc(x.month_from.slice(0, 7))}"></div>
    <div class="fg"><label class="fl">По месяц (пусто = бессрочно)</label><input id="ecoFTo" type="month" value="${x.month_to ? esc(x.month_to.slice(0, 7)) : ''}"></div>
    </div><div style="margin-top:10px"><button class="btn btn-pri" onclick="ecoSaveFixed(${id || 'null'})">Сохранить</button> <button class="btn" onclick="document.getElementById('ecoFixedForm').innerHTML=''">Отмена</button></div></div>`;
}
async function ecoSaveFixed(id) {
  const v = (i) => document.getElementById(i).value;
  const body = { category: v('ecoFCat'), title: v('ecoFTitle'), amountMonth: Number(v('ecoFAmount')), monthFrom: v('ecoFFrom'), monthTo: v('ecoFTo') || null };
  try { await api(id ? 'PUT' : 'POST', id ? `/api/economics/fixed-costs/${id}` : '/api/economics/fixed-costs', body); _eco.report = null; notify('Сохранено'); ecoLoadFixed(); } catch (e) { notify('Ошибка: ' + e.message, 'err'); }
}
async function ecoDeleteFixed(id) { if (!confirm('Удалить статью?')) return; try { await api('DELETE', `/api/economics/fixed-costs/${id}`); _eco.report = null; ecoLoadFixed(); } catch (e) { notify('Ошибка: ' + e.message, 'err'); } }
async function ecoCopyFixed(month) {
  const [y, m] = month.split('-').map(Number); const next = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
  try { const r = await api('POST', `/api/economics/fixed-costs/copy?from=${month}&to=${next}`); _eco.report = null; notify(`Скопировано статей: ${r.copied} → ${next}`); ecoLoadFixed(); } catch (e) { notify('Ошибка: ' + e.message, 'err'); }
}
```

- [ ] **Step 3: «Аппараты»**

```js
async function ecoLoadEquipment() {
  const el = document.getElementById('ecoEquipment');
  try {
    const [r, d] = await Promise.all([api('GET', '/api/economics/equipment'), ecoDicts()]);
    _eco.equipment = r.rows;
    const svcNames = (ids) => (ids || []).map(id => ecoDictName(d.services, id)).join(', ') || '<span class="badge eco-badge-warn">не привязан</span>';
    const rows = r.rows.map(e => `<tr${e.is_active ? '' : ' style="opacity:.5"'}><td>${esc(e.name)}${e.note ? `<div class="eco-kpi-sub">${esc(e.note)}</div>` : ''}</td><td class="num">${ecoMoney(e.purchase_price)}</td><td>${esc(e.purchase_date || '—')}</td><td class="num">${e.useful_life_months}</td><td class="num">${ecoNum(e.residual_pct)}%</td><td class="num">${ecoMoney(e.maintenance_monthly)}</td><td class="num eco-strong">${ecoMoney(e.monthly.total)}</td><td>${svcNames(e.service_ids)}</td><td><button class="btn btn-sm" onclick="ecoEditEq(${e.id})">Изменить</button> <button class="btn btn-sm" onclick="ecoDeleteEq(${e.id})">Удалить</button></td></tr>`).join('');
    el.innerHTML = `<div class="bc-head"><div><div class="bc-head-title">🔬 Аппараты</div><div class="bc-head-sub">В месяц = (цена − остаточная) / срок + ТО. Делится только между визитами привязанных услуг. Насадки и картриджи — в техкартах, здесь не дублировать</div></div>
      <div style="display:flex;gap:8px">${r.rows.length ? '' : '<button class="btn btn-sm" onclick="ecoSeedEq()">Заполнить списком с сайта</button>'}<button class="btn btn-sm btn-pri" onclick="ecoEditEq(null)">+ Аппарат</button></div></div>
      <div id="ecoEqForm"></div>
      <div class="card" style="padding:0"><div class="tw"><table class="mtbl eco-tbl"><thead><tr><th>Аппарат</th><th class="num">Цена</th><th>Куплен</th><th class="num">Срок, мес</th><th class="num">Остаточная</th><th class="num">ТО/мес</th><th class="num">В месяц</th><th>Услуги</th><th></th></tr></thead><tbody>${rows || '<tr><td colspan="9" class="empty">Реестр пуст — нажмите «Заполнить списком с сайта» или добавьте аппарат</td></tr>'}</tbody></table></div></div>`;
  } catch (e) { el.innerHTML = `<div class="empty">Ошибка: ${esc(e.message)}</div>`; }
}
async function ecoSeedEq() {
  try {
    const { seed } = await api('GET', '/api/economics/equipment/seed');
    for (const s of seed) await api('POST', '/api/economics/equipment', { name: s.name, purchasePrice: s.purchase_price, usefulLifeMonths: s.useful_life_months, note: s.note, serviceIds: [] });
    notify(`Добавлено аппаратов: ${seed.length}. Проверьте цены и привяжите услуги`); ecoLoadEquipment();
  } catch (e) { notify('Ошибка: ' + e.message, 'err'); }
}
async function ecoEditEq(id) {
  const d = await ecoDicts();
  const x = id ? _eco.equipment.find(e => e.id === id) : { name: '', purchase_price: 0, purchase_date: '', useful_life_months: 60, residual_pct: 0, maintenance_monthly: 0, service_ids: [], is_active: true, note: '' };
  const opts = d.services.map(s => `<option value="${s.id}" ${(x.service_ids || []).map(String).includes(String(s.id)) ? 'selected' : ''}>${esc(s.title)}</option>`).join('');
  document.getElementById('ecoEqForm').innerHTML = `<div class="card" style="margin-bottom:12px"><div class="eco-form">
    <div class="fg"><label class="fl">Название</label><input id="ecoEName" value="${escAttr(x.name)}"></div>
    <div class="fg"><label class="fl">Цена покупки, ₽</label><input id="ecoEPrice" type="number" min="0" value="${esc(String(x.purchase_price))}"></div>
    <div class="fg"><label class="fl">Дата покупки</label><input id="ecoEDate" type="date" value="${esc(x.purchase_date || '')}"></div>
    <div class="fg"><label class="fl">Срок службы, мес</label><input id="ecoELife" type="number" min="1" max="240" value="${x.useful_life_months}"></div>
    <div class="fg"><label class="fl">Остаточная, %</label><input id="ecoERes" type="number" min="0" max="100" value="${esc(String(x.residual_pct))}"></div>
    <div class="fg"><label class="fl">ТО в месяц, ₽</label><input id="ecoEMaint" type="number" min="0" value="${esc(String(x.maintenance_monthly))}"></div>
    <div class="fg"><label class="fl">Активен</label><select id="ecoEActive"><option value="1" ${x.is_active ? 'selected' : ''}>да</option><option value="0" ${!x.is_active ? 'selected' : ''}>нет</option></select></div>
    <div class="fg" style="grid-column:1/-1"><label class="fl">Услуги (Ctrl/⌘ — несколько)</label><select id="ecoESvc" multiple size="8">${opts}</select></div>
    <div class="fg" style="grid-column:1/-1"><label class="fl">Заметка</label><input id="ecoENote" value="${escAttr(x.note || '')}"></div>
    </div><div style="margin-top:10px"><button class="btn btn-pri" onclick="ecoSaveEq(${id || 'null'})">Сохранить</button> <button class="btn" onclick="document.getElementById('ecoEqForm').innerHTML=''">Отмена</button></div></div>`;
}
async function ecoSaveEq(id) {
  const v = (i) => document.getElementById(i).value;
  const body = { name: v('ecoEName'), purchasePrice: Number(v('ecoEPrice')), purchaseDate: v('ecoEDate') || null, usefulLifeMonths: Number(v('ecoELife')), residualPct: Number(v('ecoERes')), maintenanceMonthly: Number(v('ecoEMaint')), isActive: v('ecoEActive') === '1', note: v('ecoENote'),
    serviceIds: [...document.getElementById('ecoESvc').selectedOptions].map(o => Number(o.value)) };
  try { await api(id ? 'PUT' : 'POST', id ? `/api/economics/equipment/${id}` : '/api/economics/equipment', body); _eco.report = null; notify('Сохранено'); ecoLoadEquipment(); } catch (e) { notify('Ошибка: ' + e.message, 'err'); }
}
async function ecoDeleteEq(id) { if (!confirm('Удалить аппарат?')) return; try { await api('DELETE', `/api/economics/equipment/${id}`); _eco.report = null; ecoLoadEquipment(); } catch (e) { notify('Ошибка: ' + e.message, 'err'); } }
```

- [ ] **Step 4: Проверка и commit**

Run: `cd /root/loyalpro && node --test frontend/js/pages/economics-table.test.js 2>&1 | tail -3` → PASS. Через `mcp__playwright__*`: добавить статью «Аренда 300 000 с 2026-01», заполнить сид аппаратов, привязать Lumecca к «Фотоомоложение Lumeca - лицо» — на «Услугах» у этой услуги появляются «Постоянные» и «Аппарат», в сводке — ставка минуты и простой.

Поднять `economics.js?v=2026-10-18e`, `economics-table.js?v=2026-10-18b`.

```bash
cd /root/loyalpro && git add frontend/js/pages/economics.js frontend/js/pages/economics-table.js frontend/js/pages/economics-table.test.js frontend/index.html && git commit -m "feat(economics): вкладки «Постоянные расходы» (по месяцам, копирование) и «Аппараты» (реестр, сид)"
```

> **РЕВЬЮ-ЧЕКПОИНТ 2 (Fable, инлайн):** `/code-review` по диффу задач 13–20 + полный `npx jest economics` + `node --test frontend/js/pages/*.test.js`. Особое внимание: порядок статических путей (`/fixed-costs/copy`, `/equipment/seed`) до `/:id`; `requireRole('owner')` на всём роутере; `escAttr` во всех `value=`; бамп `?v=`.

**Этап 2 завершён.**

---

## Этап 3. Контроль

### Task 21: Сверка оплаты врача с YClients (`payroll-check`)

**Модель: Sonnet (L1).**

`GET /company/{cid}/salary/period/staff/{staff_id}/?date_from&date_to` → `data.salary` (строка). Ничего не пересчитывает — только показывает расхождение.

**Files:**
- Modify: `backend/services/economics/sync.js` (`fetchStaffSalary`), `backend/services/economics/report.js` (`payrollCheck`), `backend/routes/economics.js`, `frontend/js/pages/economics.js`
- Test: `backend/economics-report.test.js` (дополнить)

- [ ] **Step 1: Падающий тест**

```js
test('payrollCheck: наша оплата по сотрудникам за месяц против salary YClients', async () => {
  const sync = require('./services/economics/sync');
  jest.spyOn(sync, 'fetchStaffSalary').mockResolvedValue({ salary: 150, working_hours_count: 20 });
  const c = await report.payrollCheck(SALON, '2026-09');
  expect(c.month).toBe('2026-09');
  expect(c.rows).toEqual([expect.objectContaining({ staff_yc_id: 5, staff_name: 'A', our_pay: 100, yc_salary: 150, diff: -50 })]);
  expect(sync.fetchStaffSalary).toHaveBeenCalledWith(SALON, 5, '2026-09-01', '2026-09-30');
});
```
(В моке модуля `./services/yclients` этого теста `ycGet` не объявлен — `fetchStaffSalary` замокан через `jest.spyOn`, поэтому экспортировать её нужно как свойство `module.exports`, а внутри `payrollCheck` звать `sync.fetchStaffSalary(...)`, а не деструктурированную копию.)

- [ ] **Step 2: Реализация**

`sync.js`:
```js
/** Итог зарплаты сотрудника за период по версии YClients (для сверки, не для расчёта). */
async function fetchStaffSalary(salon, staffYcId, dateFrom, dateTo) {
  const d = await withRateLimitRetry(() => ycGet(salon, `/company/${salon.yclients_company_id}/salary/period/staff/${staffYcId}/`, { date_from: dateFrom, date_to: dateTo }), RETRY);
  return { salary: Number(d && d.salary) || 0, working_hours_count: Number(d && d.working_hours_count) || 0, services_sum: Number(d && d.services_sum) || 0 };
}
```
(добавить в экспорт).

`report.js`:
```js
const sync = require('./sync');
const { daysInMonth } = require('./allocation');
/** Σ doctor_pay по сотруднику за месяц против salary/period YClients. */
async function payrollCheck(salon, month) {
  const from = `${month}-01`, to = `${month}-${String(daysInMonth(month)).padStart(2, '0')}`;
  const r = await buildReport(salon, from, to);
  const byStaff = calc.aggregate(r.rows.filter(x => x.staff_yc_id != null), x => x.staff_yc_id, x => x.staff_name);
  const rows = [];
  for (const g of byStaff) {
    let yc = null, error = null;
    try { yc = await sync.fetchStaffSalary(salon, g.key, from, to); } catch (e) { error = e.message; }
    rows.push({ staff_yc_id: g.key, staff_name: g.label, visits: g.visits, our_pay: g.doctor_pay, our_cost: g.doctor_cost,
      yc_salary: yc ? yc.salary : null, yc_hours: yc ? yc.working_hours_count : null, diff: yc ? g.doctor_pay - yc.salary : null, error });
  }
  return { month, from, to, rows: rows.sort((a, b) => b.our_pay - a.our_pay) };
}
```
(добавить в экспорт). Роут в `routes/economics.js`:
```js
router.get('/payroll-check', async (req, res) => {
  const m = parseMonth(req.query.month); if (!m) return res.status(400).json({ error: 'month в формате YYYY-MM' });
  try { res.json(await report.payrollCheck(await salonOf(req), m.slice(0, 7))); } catch (e) { fail(res, 'payroll-check')(e); }
});
```
Фронт — в конце `ecoLoadPay()` после рендера:
```js
    document.getElementById('ecoPayrollCheck').innerHTML = `<div class="card" style="margin-top:14px"><div class="bc-head"><div class="bc-head-title">Сверка с YClients</div><div><input type="month" id="ecoPcMonth" value="${ecoTodayMsk().slice(0, 7)}"> <button class="btn btn-sm" onclick="ecoPayrollCheck()">Сверить</button></div></div><div id="ecoPcBody" class="eco-kpi-sub">Наш расчёт оплаты по процедурам против итога «Расчёт зарплат» YClients за месяц. Ничего не пересчитывает.</div></div>`;
```
и функция:
```js
async function ecoPayrollCheck() {
  const el = document.getElementById('ecoPcBody'); el.innerHTML = 'Считаем… (по запросу на каждого сотрудника)';
  try {
    const r = await api('GET', `/api/economics/payroll-check?month=${document.getElementById('ecoPcMonth').value}`);
    el.innerHTML = `<div class="tw"><table class="mtbl eco-tbl"><thead><tr><th>Сотрудник</th><th class="num">Визитов</th><th class="num">Наш расчёт (на руки)</th><th class="num">YClients</th><th class="num">Разница</th></tr></thead><tbody>${r.rows.map(x => `<tr><td>${esc(x.staff_name)}</td><td class="num">${ecoNum(x.visits)}</td><td class="num">${ecoMoney(x.our_pay)}</td><td class="num">${x.error ? `<span class="badge eco-badge-err" title="${escAttr(x.error)}">ошибка</span>` : ecoMoney(x.yc_salary)}</td><td class="num ${x.diff < 0 ? 'eco-neg' : ''}">${ecoMoney(x.diff)}</td></tr>`).join('')}</tbody></table></div>`;
  } catch (e) { el.innerHTML = `Ошибка: ${esc(e.message)}`; }
}
```

- [ ] **Step 3: Тесты, живая проверка, commit**

Run: `cd /root/loyalpro/backend && npx jest economics-report 2>&1 | tail -3` → PASS. На деве: «Сверить» за сентябрь — таблица по сотрудникам (YClients может отдать `salary: 0`, если клиника не начисляет в YClients — это ожидаемо и показывается как есть).

Поднять `economics.js?v=2026-10-18f`.
```bash
cd /root/loyalpro && git add backend/services/economics/sync.js backend/services/economics/report.js backend/routes/economics.js backend/economics-report.test.js frontend/js/pages/economics.js frontend/index.html && git commit -m "feat(economics): сверка оплаты врача с salary/period YClients"
```

---

### Task 22: Предупреждения — визиты без списаний, товары без цены, скачок цены, перерасход

**Модель: Opus (L2).** Четыре правила над строками и приходами; формулировки должны быть честными (нет источника — нет предупреждения).

**Files:**
- Modify: `backend/services/economics/calc.js` (`warnings`), `backend/services/economics/report.js` (в `summary.warnings`), `frontend/js/pages/economics.js` (блок под сводкой)
- Test: `backend/economics-calc.test.js` (дополнить)

- [ ] **Step 1: Падающий тест**

```js
describe('warnings', () => {
  const base = { record_id: 1, visit_date: '2026-09-10', service_yc_id: 10, service_title: 'S', has_consumables: true, has_tech_card: true, materials_fact: 100, materials_norm: 100, no_price_goods: [] };
  test('визиты без списаний при наличии техкарты; перерасход > 20 % против нормы; товары без цены; скачок прихода > 20 %', () => {
    const rows = [
      { ...base, record_id: 1, has_consumables: false },
      { ...base, record_id: 2, materials_fact: 130 },
      { ...base, record_id: 3, no_price_goods: [7] },
      { ...base, record_id: 4, has_consumables: false, has_tech_card: false },
    ];
    const receiptsByGood = new Map([[7, [{ create_date: '2026-09-05', amount: 1, cost: 130, operation_unit_type: 2 }, { create_date: '2026-08-05', amount: 1, cost: 100, operation_unit_type: 2 }]],
      [8, [{ create_date: '2026-09-05', amount: 1, cost: 105, operation_unit_type: 2 }, { create_date: '2026-08-05', amount: 1, cost: 100, operation_unit_type: 2 }]]]);
    const catalogByGood = new Map([[7, { title: 'G7', unit_equals: 1 }], [8, { title: 'G8', unit_equals: 1 }]]);
    const w = C.warnings(rows, { receiptsByGood, catalogByGood, from: '2026-09-01', to: '2026-09-30' });
    expect(w.find(x => x.type === 'no_consumables')).toEqual({ type: 'no_consumables', service_yc_id: 10, service_title: 'S', count: 1, record_ids: [1] });
    expect(w.find(x => x.type === 'overrun')).toEqual({ type: 'overrun', service_yc_id: 10, service_title: 'S', record_id: 2, fact: 130, norm: 100, ratio: 1.3 });
    expect(w.find(x => x.type === 'no_price')).toEqual({ type: 'no_price', good_id: 7, good_title: 'G7', rows: 1 });
    expect(w.find(x => x.type === 'price_jump')).toEqual({ type: 'price_jump', good_id: 7, good_title: 'G7', prev: 100, last: 130, ratio: 1.3, at: '2026-09-05' });
    expect(w.filter(x => x.type === 'price_jump')).toHaveLength(1);        // G8: +5 % — не скачок
    expect(w.find(x => x.type === 'no_consumables' && x.record_ids.includes(4))).toBeUndefined(); // без техкарты — нет нормы, нечего сравнивать: считается в coverage, не тут
  });
  test('пусто → []', () => { expect(C.warnings([], { receiptsByGood: new Map(), catalogByGood: new Map(), from: '2026-09-01', to: '2026-09-30' })).toEqual([]); });
});
```

- [ ] **Step 2: Реализация в `calc.js`**

```js
const { receiptUnitPrice, mskDay } = require('./price');
const OVERRUN_RATIO = 1.2;
const PRICE_JUMP_RATIO = 1.2;

/** Предупреждения этапа 3. Только то, что доказуемо данными. */
function warnings(rows, { receiptsByGood, catalogByGood, from, to }) {
  const out = [];
  const noCons = new Map();
  const noPrice = new Map();
  for (const r of rows) {
    if (!r.has_consumables && r.has_tech_card) {
      const s = noCons.get(r.service_yc_id) || { type: 'no_consumables', service_yc_id: r.service_yc_id, service_title: r.service_title, count: 0, record_ids: [] };
      s.count++; s.record_ids.push(r.record_id); noCons.set(r.service_yc_id, s);
    }
    if (r.has_consumables && r.materials_norm > 0 && r.materials_fact > r.materials_norm * OVERRUN_RATIO) {
      out.push({ type: 'overrun', service_yc_id: r.service_yc_id, service_title: r.service_title, record_id: r.record_id, fact: r.materials_fact, norm: r.materials_norm, ratio: Math.round(r.materials_fact / r.materials_norm * 100) / 100 });
    }
    for (const gid of r.no_price_goods || []) { const g = noPrice.get(gid) || { type: 'no_price', good_id: gid, good_title: (catalogByGood.get(gid) || {}).title || `товар ${gid}`, rows: 0 }; g.rows++; noPrice.set(gid, g); }
  }
  out.push(...noCons.values(), ...noPrice.values());
  for (const [gid, receipts] of receiptsByGood) {
    const inPeriod = receipts.filter(r => { const d = mskDay(r.create_date); return d >= from && d <= to; })
      .sort((a, b) => String(mskDay(b.create_date)).localeCompare(String(mskDay(a.create_date))));
    if (!inPeriod.length) continue;
    const cat = catalogByGood.get(gid) || {};
    const last = inPeriod[0];
    const prevList = receipts.filter(r => mskDay(r.create_date) < mskDay(last.create_date)).sort((a, b) => String(mskDay(b.create_date)).localeCompare(String(mskDay(a.create_date))));
    if (!prevList.length) continue;
    const lp = receiptUnitPrice(last, cat.unit_equals), pp = receiptUnitPrice(prevList[0], cat.unit_equals);
    if (lp > 0 && pp > 0 && lp / pp >= PRICE_JUMP_RATIO) out.push({ type: 'price_jump', good_id: gid, good_title: cat.title || `товар ${gid}`, prev: pp, last: lp, ratio: Math.round(lp / pp * 100) / 100, at: mskDay(last.create_date) });
  }
  return out;
}
```
Добавить `warnings, OVERRUN_RATIO, PRICE_JUMP_RATIO` в экспорт. В `report.compute` после `summary`: `summary.warnings = calc.warnings(rows, { receiptsByGood: data.receiptsByGood, catalogByGood: data.catalogByGood, from, to });`.

- [ ] **Step 3: Фронт — блок под сводкой (в `ecoRenderSummary`, в конец)**

```js
  const w = s.warnings || [];
  if (w.length) {
    const label = (x) => x.type === 'no_consumables' ? `«${esc(x.service_title)}»: ${x.count} визитов без списаний при наличии техкарты`
      : x.type === 'overrun' ? `«${esc(x.service_title)}» визит ${x.record_id} (${x.visit_date || ''}): материалы ${ecoMoney(x.fact)} против нормы ${ecoMoney(x.norm)} (×${x.ratio})`
      : x.type === 'no_price' ? `Товар без цены: ${esc(x.good_title)} (${x.rows} строк)`
      : `Скачок цены поступления: ${esc(x.good_title)} ${ecoNum(x.prev, 2)} → ${ecoNum(x.last, 2)} (×${x.ratio}, ${x.at})`;
    el.insertAdjacentHTML('beforeend', `<div class="sc" style="grid-column:1/-1"><div><b>⚠️ Предупреждения (${w.length})</b></div><ul style="margin:6px 0 0 18px;font-size:12.5px">${w.slice(0, 30).map(x => `<li>${label(x)}</li>`).join('')}${w.length > 30 ? `<li>… и ещё ${w.length - 30}</li>` : ''}</ul></div>`);
  }
```

- [ ] **Step 4: Тесты, проверка, commit**

Run: `cd /root/loyalpro/backend && npx jest economics 2>&1 | tail -5` → PASS. На деве за сентябрь блок предупреждений показывает реальные «визиты без списаний» (ожидаемо много: покрытие 53 %).

Поднять `economics.js?v=2026-10-18g`.
```bash
cd /root/loyalpro && git add backend/services/economics/calc.js backend/services/economics/report.js backend/economics-calc.test.js frontend/js/pages/economics.js frontend/index.html && git commit -m "feat(economics): предупреждения — визиты без списаний, перерасход, товары без цены, скачок цены прихода"
```

**Этап 3 завершён.**

---

### Task 23: Документация — раздел в `CLAUDE.md` и ручная приёмка

**Модель: Sonnet (L1).**

**Files:**
- Modify: `CLAUDE.md` (новый раздел после «Уведомления YClients своими силами»)
- Create: `docs/2026-10-18-procedure-economics-acceptance.md`

- [ ] **Step 1: Раздел в `CLAUDE.md`**

```markdown
### Экономика процедур (с 2026-10, только владелец)
Спека `docs/superpowers/specs/2026-10-18-procedure-economics-design.md`, план `docs/superpowers/plans/2026-10-18-procedure-economics.md`, исследование `docs/2026-10-18-procedure-margin-research.md`. Модуль `services/economics/` (goods-events → price → pay-rules → allocation → tech-cards → calc → store → sync → report), роутер `/api/economics` (`requireRole('owner')`), страница «💰 Экономика» (`frontend/js/pages/economics.js` + чистый `economics-table.js` под `node --test`). Тесты — `npx jest economics`.
- Единица расчёта — строка «запись × услуга» состоявшегося визита (`records`, `attendance=1`, не удалена). Выручка = `cost_to_pay` − доля списанных бонусов (`loyalty_card_transactions` type=redemption по `record_id`). Материалы: факт = списания YClients (`goods_transactions` type_id=2 по `record_id`/`service_id`; без `service_id` — по доле цены), иначе норма техкарты (`estimated`), иначе 0 (`no_materials_data`). Цена единицы: последний приход ≤ даты визита (`cost/amount/unit_equals`) → ручная (`goods_price_overrides`) → `unit_actual_cost` каталога → 0 (`no_price`). Оплата врача — `staff_pay_rules` (услуга+сотрудник > услуга > категория+сотрудник > категория > сотрудник > салон; период действия) × `payroll_multiplier`. Эквайринг — процент по кассе из `revenue_operations.account_title`, без оплат — средняя доля периода (`acquiring_estimated`). Постоянные (`fixed_costs`, помесячно × доля дней) и аппараты (`equipment`, только по своим услугам) — по драйверу `minutes` (дефолт) или `visits`. УСН — оценка 15 % от положительной операционной прибыли.
- Данные: вебхуки `goods_operations_consumable|receipt|sale|stolen` → `economics.handleGoodsEvent` (delete ставит `deleted_at`, PII `client` не пишется); ночной крон `5 5 * * *` мск (`ECONOMICS_SYNC=false` гасит только крон): каталог `/goods/{cid}?count=100&page=N` (БЕЗ category_id), техкарты `/technological_cards/{cid}/`, сверка `/storages/transactions` по `changed_after=−2 дня`, обучение привязок по вчерашним записям со списаниями (`record_consumables`, ≤15 вызовов). Догон истории — ТОЛЬКО `scripts/economics-backfill-goods.js --from=…` (помесячно, идемпотентен). Привязки техкарт: `manual` > `lookup` > `learned`, с сотрудником > общая; `UNIQUE (salon, service, COALESCE(staff,0))`.
- ГОТЧИ: `/storages/transactions` отдаёт числа СТРОКАМИ — один парсер `goods-events.parseTransaction` на вебхук и API; приход в единице ПРОДАЖИ (`operation_unit_type=1`) делится на `unit_equals`, в единице списания (2) — нет; `splitByWeights` кладёт остаток копеек в последнюю долю (суммы сходятся); даты сравниваются по московскому дню (`price.mskDay`); отчёт считается на лету (кэш 60 с, `report.invalidate` на каждой мутации), живой EXPLAIN — `scripts/economics-explain.js`; e2e синка — `scripts/economics-sync-e2e.js` (пишет в дев-БД).
```

- [ ] **Step 2: Протокол ручной приёмки**

`docs/2026-10-18-procedure-economics-acceptance.md`:

```markdown
# Экономика процедур — ручная приёмка (сентябрь 2026, дев)

Период 2026-09-01..2026-09-30, salon 1. Заполнить таблицу фактами, расхождения — в задачи.

| Услуга | Визитов (Экономика) | Визитов («Записи», пришёл) | Материалы факт (Экономика) | Списания (YClients → Склад → Списания по услуге) | Оплата (наш расчёт) | salary/period YClients |
|---|---|---|---|---|---|---|
| Фотоомоложение Lumeca - лицо | | | | | | |
| Ботулинотерапия Лоб + межбровье | | | | | | |
| Комбинированная чистка (Christina/GIGI) | | | | | | |

Проверки:
1. Число визитов совпадает с «Записями» (фильтр по услуге, статус «пришёл»). Расхождение → сверить `attendance`/`deleted` в `records.raw_payload`.
2. Материалы факт = Σ `cost` списаний YClients ± расхождение из-за цены (мы берём последний приход, YClients — среднюю): колонка «себест. YClients» в детализации визита должна совпадать с YClients копейка в копейку.
3. Оплата врача за месяц ≈ `salary/period` (кнопка «Сверить»). Если YClients отдаёт 0 — клиника не начисляет в YClients, сверка невозможна (записать).
4. Сводка: ставка минуты при полной загрузке < фактической; простой ≥ 0.
5. Предупреждения: «визиты без списаний» только у услуг с техкартой.
```

- [ ] **Step 3: Commit**

```bash
cd /root/loyalpro && git add CLAUDE.md docs/2026-10-18-procedure-economics-acceptance.md && git commit -m "docs(economics): раздел CLAUDE.md и протокол ручной приёмки"
```

---

## Самопроверка плана (выполнена при написании)

**Покрытие спеки.** §3.1 выручка/бонусы — задача 10; §3.2 материалы и `unit_price` — 4, 7, 10; §3.3 оплата — 8, 10; сверка оплаты — 21; §3.4 эквайринг — 10, 13 (настройки по кассам), 18; §3.5 — 10; §3.6 постоянные/аппараты/драйверы/ставка при мощности/УСН/прибыль-час — 9, 10, 12, 19, 20; §3.7 агрегация и флаги — 10, 12; §4.1 вебхуки/сверка/догон — 2, 3, 6; §4.2 каталог и `last_receipt_price` — 3, 5; §4.3 техкарты, три источника привязки, подсказки, покрытие — 7, 12, 17; §4.4 — существующие таблицы, 11; §4.5 лимиты — 14 (один крон, ≤33 запроса); §5 схема — 1; §6 модули — 2–12; §7 API — 13, 19, 21; §8 UI семь вкладок — 15–18, 20, 21; §9 крон/флаг/ошибки — 14, 3, 12; §10 тесты/скрипты — во всех задачах + 11, 14; §11 этапы — структура плана; §12 сид — 19; §13 риски — отражены в подписях UI и в CLAUDE.md (23). Вне плана намеренно: SMS и всё из «не входит» §1.

**Известные допущения, которые исполнитель должен проверить живьём, а не тестами:**
- `GET /goods/{cid}?count=100&page=N` без `category_id` действительно отдаёт весь каталог с полями `unit_equals/service_unit_short_title/actual_amounts` (задача 5, шаг 5 e2e в задаче 14).
- `changed_after` у `/storages/transactions` работает (параметр есть в openapi; задача 6 шаг 6 проверяет на деве).
- `record_consumables` отдаёт `technological_cards[].id`, совпадающий с id из списка техкарт (задача 7; e2e задачи 14 печатает `linked`).
- `loyalty_card_transactions.amount` у `redemption` — положительное или отрицательное: SQL берёт `ABS()`, это безопасно в обе стороны.

**Типовая согласованность.** `store.loadPeriod` → `{records, cards, links, receiptsByGood, catalogByGood, overridesByGood, payRules, settings, fixedCosts, equipment, capacityMinutes}` используется в `report.buildCtx/compute` ровно с этими именами; `calc.buildRows(record, ctx)` ждёт `ctx.durations/categories/priceFn/techCardFor/payRules/settings` — их собирает `buildCtx`; `tech-cards.pickTechCard(links, serviceId, staffId)` и `normCost(card, priceFn, date)` вызываются из `report`/`calc` с теми же сигнатурами; `sync.runNightly/isRunning/syncTechCards/lookupTechCardForService/fetchStaffSalary` — экспорты, которые ждут роутер и `report.payrollCheck`; фронт читает `services[].coverage.{rows,with_consumables,with_tech_card,no_pay_rule,no_price_goods,acquiring_estimated}` и `summary.coverage.*` — ровно поля `calc.aggregate/summary`.
