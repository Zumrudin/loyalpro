# Журнал записи: локальная работа и фоновая отправка — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** формы журнала (создание, перенос, подтверждение, отмена, оплата) закрываются мгновенно, данные сохраняются в LoyalPro и одним пакетом на сессию формы уходят в YClients фоном; день и окна открываются из локальных данных.

**Architecture:** чтение — из зеркала `records` (вебхуки + сверка), кэша справочников и графиков (`journal_reference_cache`, `journal_staff_schedule`) и наложения неотправленных пакетов. Запись — `POST /api/journal/sessions` проверяет по локальным данным и кладёт пакет в `journal_outbox`; фоновый обработчик исполняет шаги ТЕМ ЖЕ кодом, что сейчас (`service.mutate`, `payments.pay`), с повторами и пометкой сбоя. Спека: `docs/superpowers/specs/2026-11-10-journal-local-first-design.md`.

**Tech Stack:** Node.js/Express, PostgreSQL (`pg`, обёртка `db`), node-cron, Jest (`cd backend && npx jest backend/journal …`, TZ Europe/Moscow через globalSetup), фронт — ванильный JS в общей глобальной области, тесты фронта — `node --test`/jest с `vm`.

**Правила для исполнителей (обязательно):**
- Модуль журнала НЕ закоммичен и живёт на `main` вместе с чужими незакоммиченными правками — НЕ коммитить, НЕ делать `git stash`/`checkout`/`reset`. Только правка файлов.
- БД через `db` из `backend/db.js`: `db.one` == `db.oneOrNone` (возвращает null, не бросает).
- Всё скоупится `salon_id`. Даты — московские.
- Тесты гонять с путём: `cd /root/loyalpro/backend && npx jest backend/journal --silent` (голый шаблон гоняет весь репозиторий). Node — `export PATH=/root/.nvm/versions/node/v20.20.2/bin:$PATH`.
- Ошибки наружу — только `JournalError` (`m.fail`) с безопасным текстом; в логи — без персональных данных и тел ответов YClients.
- Не обращаться к живому YClients из тестов. Живые прогоны делает координатор.

---

## Карта файлов

| Файл | Задача | Ответственность |
|---|---|---|
| `backend/migrations.js` (+`JOURNAL_LOCAL_DDL`) | T1 | таблицы кэша, графиков, состояния зеркала, очереди |
| `backend/config.js` | T1 | `JOURNAL_LOCAL_FIRST`, `JOURNAL_OUTBOX` |
| `backend/services/journal/reference-cache.js` | T2 | справочники, графики, лимит бонусов |
| `backend/services/journal/mirror.js` | T3 | догон/сверка `records`, состояние |
| `backend/scripts/journal-mirror-backfill.js` | T3 | разовый догон |
| `backend/services/journal/overlay.js` | T4 | наложение пакетов на записи (чистый) |
| `backend/services/journal/sources.js` | T4 | источники данных live/local для дня и окон |
| `backend/services/journal/index.js` | T4 | `day`/`availability`/`detail` через источники |
| `backend/services/journal/payments-local.js` | T5 | локальная форма оплаты (чистый) + сборка |
| `backend/services/journal/sessions.js` | T6 | разбор, проверка, постановка пакета, retry/dismiss |
| `backend/routes/journal.js` | T5, T6 | новые ручки |
| `backend/services/journal/outbox-worker.js` | T7 | исполнение шагов, повторы, статусы |
| `backend/server.js` | T7 | кроны зеркала/кэша, старт обработчика |
| `frontend/js/pages/journal.js`, `frontend/index.html`, `frontend/css/journal.css` | T8 | сессия формы, мгновенное закрытие, значки, опрос |

---

### Task 1 (Sonnet): миграции и флаги

**Files:** Modify `backend/migrations.js`, `backend/config.js`; Test `backend/journal-local-ddl.test.js`

- [ ] **Step 1: тест**

```js
'use strict';
jest.mock('./config', () => ({ JWT_SECRET: 'x' }));
test('local-first DDL is additive and tenant-scoped', () => {
  const { JOURNAL_LOCAL_DDL } = require('./migrations');
  for (const t of ['journal_staff_schedule', 'journal_reference_cache', 'journal_mirror_state', 'journal_outbox'])
    expect(JOURNAL_LOCAL_DDL).toContain(`CREATE TABLE IF NOT EXISTS ${t}`);
  expect(JOURNAL_LOCAL_DDL).toContain('UNIQUE(salon_id,session_id)');
  expect(JOURNAL_LOCAL_DDL).toMatch(/status IN \('queued','running','done','failed','cancelled'\)/);
  expect(JOURNAL_LOCAL_DDL).not.toMatch(/DROP|TRUNCATE|DELETE FROM/);
});
test('flags default on and switch off only by the string false', () => {
  jest.resetModules(); jest.unmock('./config');
  const prev = { a: process.env.JOURNAL_LOCAL_FIRST, b: process.env.JOURNAL_OUTBOX };
  process.env.JOURNAL_LOCAL_FIRST = 'false'; delete process.env.JOURNAL_OUTBOX;
  const c = require('./config');
  expect(c.JOURNAL_LOCAL_FIRST).toBe(false); expect(c.JOURNAL_OUTBOX).toBe(true);
  process.env.JOURNAL_LOCAL_FIRST = prev.a; process.env.JOURNAL_OUTBOX = prev.b;
});
```

- [ ] **Step 2:** `npx jest backend/journal-local-ddl` → FAIL (нет экспорта).
- [ ] **Step 3: реализация.** В `migrations.js` рядом с `JOURNAL_FINANCE_DDL`:

```js
const JOURNAL_LOCAL_DDL = `
CREATE TABLE IF NOT EXISTS journal_staff_schedule (
 salon_id INTEGER NOT NULL REFERENCES salons(id) ON DELETE CASCADE,
 staff_id BIGINT NOT NULL, date DATE NOT NULL, is_working BOOLEAN NOT NULL,
 slots JSONB NOT NULL DEFAULT '[]', fetched_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 PRIMARY KEY(salon_id,staff_id,date)
);
CREATE TABLE IF NOT EXISTS journal_reference_cache (
 salon_id INTEGER NOT NULL REFERENCES salons(id) ON DELETE CASCADE,
 kind TEXT NOT NULL, payload JSONB NOT NULL, fetched_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 PRIMARY KEY(salon_id,kind)
);
CREATE TABLE IF NOT EXISTS journal_mirror_state (
 salon_id INTEGER PRIMARY KEY REFERENCES salons(id) ON DELETE CASCADE,
 last_ok_at TIMESTAMPTZ, last_error TEXT, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS journal_outbox (
 id BIGSERIAL PRIMARY KEY,
 salon_id INTEGER NOT NULL REFERENCES salons(id) ON DELETE CASCADE,
 session_id UUID NOT NULL, user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
 request_hash VARCHAR(64) NOT NULL, yclients_record_id BIGINT,
 status TEXT NOT NULL CHECK(status IN ('queued','running','done','failed','cancelled')),
 steps JSONB NOT NULL, overlay JSONB NOT NULL,
 failed_step INTEGER, error_code TEXT, error_text TEXT,
 attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 UNIQUE(salon_id,session_id)
);
CREATE INDEX IF NOT EXISTS journal_outbox_due ON journal_outbox(next_attempt_at,id) WHERE status='queued';
CREATE INDEX IF NOT EXISTS journal_outbox_record ON journal_outbox(salon_id,yclients_record_id);
CREATE INDEX IF NOT EXISTS journal_outbox_open ON journal_outbox(salon_id,status) WHERE status IN ('queued','running','failed');
`;
```

В `runMigrations` после `await client.query(JOURNAL_FINANCE_DDL);` добавить `await client.query(JOURNAL_LOCAL_DDL);`; добавить в `module.exports`. В `config.js` рядом с `JOURNAL_ACCOUNT_PAYMENTS_ENABLED`:

```js
  JOURNAL_LOCAL_FIRST: process.env.JOURNAL_LOCAL_FIRST !== 'false',
  JOURNAL_OUTBOX: process.env.JOURNAL_OUTBOX !== 'false',
```

- [ ] **Step 4:** тест PASS; `npx jest backend/journal --silent` — всё зелёное.

---

### Task 2 (Sonnet): кэш справочников и графиков

**Files:** Create `backend/services/journal/reference-cache.js`; Test `backend/journal-reference-cache.test.js`

Интерфейс (экспорт):
- `KINDS = ['staff','services','resources','accounts']`
- `async refreshReference(salon)` — для каждого вида: `staff` ← `yc.list(salon, '/staff/{cid}')`; `services` ← `yc.list(salon, '/company/{cid}/services/')`; `resources` ← `yc.list(salon, '/resources/{cid}')`; `accounts` ← `yc.list(salon, '/accounts/{cid}')` (живой ответ 09.11: `[{id,title,type,type_slug:'cash'|'cashless',is_acquiring}]`). Каждый вид пишется отдельно `INSERT … ON CONFLICT (salon_id,kind) DO UPDATE SET payload=EXCLUDED.payload, fetched_at=NOW()`; сбой одного вида — WARN и следующий (прежнее значение остаётся). Возвращает `{ok:[kinds], failed:[kinds]}`.
- `async refreshSchedules(salon, from, to)` — по сотрудникам из кэша `staff` (не `fired`, не администраторы — `m.isAdministrator`), один запрос `yc.list(salon, '/schedule/{cid}/{staffId}/{from}/{to}')` на сотрудника, последовательно; каждый день ответа → upsert `journal_staff_schedule (salon_id, staff_id, date, is_working, slots, fetched_at)`; `is_working = [true,1,'1'].includes(day.is_working)`, `slots` — `day.slots` как есть (массив `{from,to}`). Сбой сотрудника — WARN, дальше.
- `async getReference(salonId, kind)` → `payload` или `null`.
- `async getSchedule(salonId, staffId, date)` → `null` если строки нет; иначе массив в формате YClients, понятном `m.staffSchedule`/`m.workRanges`: `[{date, is_working: row.is_working ? 1 : 0, slots: row.slots}]` (`date` — `YYYY-MM-DD` по Москве: `to_char(date,'YYYY-MM-DD')` в SQL).
- `async getBonusPercent(salonId)` → число или `null` (вид `bonus_rule`, `{percent}`).
- `async learnBonusPercent(salonId, sale)` — из живого `sale`: метод `loyalty_card` с `applicable_amount>0` и `loyalty_card.balance > applicable_amount` (ограничил процент, а не баланс); `total = Σ state.items[].cost_to_pay_total`; `percent = Math.round(applicable*100/total)`, только если `total>0` и `1<=percent<=100`; пишет `bonus_rule` `{percent}`. Иначе ничего. Никогда не бросает (try/catch → WARN).

- [ ] **Step 1: тесты** (мок `./db`, `./services/journal/yclients` (`list`), `./logger`): (a) `refreshReference` пишет 4 вида, сбой `resources` не мешает остальным и попадает в `failed`; (b) `refreshSchedules` — два сотрудника, один администратор/уволенный пропущен, upsert вызван на каждый день, `is_working` нормализован; (c) `getSchedule` → `null` без строки и `[{date:'2026-11-20',is_working:1,slots:[…]}]` со строкой; (d) `learnBonusPercent`: `applicable 3000, balance 5000, items 30000` → 10; `applicable=balance` → не пишет; `total 0` → не пишет; бросающий `db.query` не пробрасывается.
- [ ] **Step 2:** FAIL → **Step 3:** реализация → **Step 4:** PASS + весь `backend/journal`.

---

### Task 3 (Sonnet): зеркало записей и разовый догон

**Files:** Create `backend/services/journal/mirror.js`, `backend/scripts/journal-mirror-backfill.js`; Test `backend/journal-mirror.test.js`

Интерфейс:
- `async syncWindow(salon, from, to)` → `{upserted, deleted, moved}`:
  1. `list = await yc.records(salon, from, to)` (уже постранично, бросает при неполноте);
  2. для каждой `r`: `dbClientId = (await db.oneOrNone('SELECT id FROM clients WHERE salon_id=$1 AND yclients_client_id=$2',[salon.id, r.client?.id]))?.id || null` (только если `r.client?.id`); `await loyalty.upsertRecordFromYc(salon.id, r, dbClientId, 'journal_mirror')`;
  3. локальные живые записи окна, которых нет в `list`: `SELECT yclients_record_id FROM records WHERE salon_id=$1 AND visit_date BETWEEN $2 AND $3 AND status<>'deleted'`; по каждой — `yc.getRecord(salon, id)`: ответ с `deleted` → upsert (статус станет `deleted`), счётчик `deleted`; живая с другой датой → upsert, счётчик `moved`; `JournalError` 404 → upsert `{...raw_payload из БД, deleted:true}`; иное исключение — WARN, запись не трогаем (пропажа без подтверждения ничего не удаляет);
  4. `INSERT INTO journal_mirror_state(salon_id,last_ok_at,last_error,updated_at) VALUES($1,NOW(),NULL,NOW()) ON CONFLICT (salon_id) DO UPDATE SET last_ok_at=NOW(), last_error=NULL, updated_at=NOW()`. При исключении шага 1 — `last_error` = `'records_unavailable'` (без текста YClients), исключение пробрасывается.
- `async freshness(salonId)` → `{mirrorOkAt: ISO|null}`.
- Константы: `NEAR_DAYS = 14`, `FAR_DAYS = 120`; `windowFor(kind)` → `{from: сегодня−1, to: сегодня+N}` по Москве (используй `new Date().toLocaleDateString('sv-SE',{timeZone:'Europe/Moscow'})` и сдвиг суток в UTC-полдень, как `shiftDate` в `index.js`).
- Скрипт `journal-mirror-backfill.js --salon=1 [--days=120] [--write]`: без `--write` только считает расхождения (`yc.records` против `records`), с `--write` зовёт `syncWindow` кусками по 14 дней; печатает агрегаты, без персональных данных; `pool.end()` в конце.

- [ ] **Step 1: тесты** (моки `./db`, `./services/journal/yclients`, `./services/loyalty`): новая запись апсертится с `'journal_mirror'`; пропавшая и удалённая в YClients → upsert с `deleted`; пропавшая, но живая на другой дате → `moved`; 404 → `deleted:true` поверх сохранённой; сбой `getRecord` (5xx) → ничего не апсертится; сбой `yc.records` → `last_error='records_unavailable'` и исключение; `windowFor('near')` даёт 15/16-дневное окно от вчера.
- [ ] **Step 2–4:** FAIL → реализация → PASS + весь `backend/journal`.

---

### Task 4 (Opus): источники данных и наложение; день и окна из локальных данных

**Files:** Create `backend/services/journal/overlay.js`, `backend/services/journal/sources.js`; Modify `backend/services/journal/index.js`, `backend/services/journal/model.js` (`normalizeRecord` + `sync`); Test `backend/journal-overlay.test.js`, `backend/journal-sources.test.js`; существующие тесты `backend/journal-*.test.js` обязаны остаться зелёными.

**overlay.js** (чистый):
- `applyOverlay(records, rows, now = Date.now())`: `records` — YClients-формы записей (без удалённых); `rows` — строки `journal_outbox` со статусами `queued|running|failed` (+ `done` моложе 5 минут, чья запись ещё не в `records`). Для каждой строки `sync = {outboxId: row.id, status: row.status, errorText: row.error_text, errorCode: row.error_code, failedStep: row.failed_step}`:
  - `row.overlay.kind === 'create'` и записи `row.yclients_record_id` нет в `records` → добавить синтетическую запись `{id: row.yclients_record_id || -row.id, datetime: '<date>T<time>:00+03:00', seance_length: duration*60, staff_id, services: [{id,title,cost}], client:{name, phone}, comment, attendance: row.overlay.attendance ?? 0, deleted:false, _sync: sync}`;
  - иначе запись с `id === row.yclients_record_id` найдена → копия с полями из `row.overlay.patch` (`datetime`, `staff_id`, `seance_length`, `attendance`), `_sync = sync`; `patch.cancel === true` → `attendance:-1`;
  - статус `cancelled` и `done` старше 5 минут не накладываются.
- `model.normalizeRecord` дополнить: `sync: r._sync || null` (и `id` может быть отрицательным).

**sources.js**:
- `live(salon)` — объект `{ kind:'live', staff(), services(), resources(), accounts(), schedule(staffId, date), records(from, to) }` поверх текущих вызовов (`yc.list`, `yc.records`).
- `local(salon)` — те же методы: справочники из `reference-cache.getReference` (нет вида → бросить `JournalError(503,'Справочники журнала ещё не загружены.','cache_cold')`); `schedule` → `getSchedule`, а при `null` — живой `yc.list` для этого дня (и только его); `records(from,to)` → `SELECT raw_payload FROM records WHERE salon_id=$1 AND visit_date BETWEEN $2::date AND $3::date AND status<>'deleted'` → `raw_payload`, затем `applyOverlay` по строкам очереди салона (`SELECT * FROM journal_outbox WHERE salon_id=$1 AND (status IN ('queued','running','failed') OR (status='done' AND updated_at > NOW()-interval '5 minutes'))`).
- `async forSalon(salon)` → `config.JOURNAL_LOCAL_FIRST ? local(salon) : live(salon)`; при `cache_cold` в `local` — тихий откат на `live` (WARN один раз на процесс).

**index.js**:
- `catalog(salon, src)`, `day(salonId, date, src?)`, `availability(salon, draft, record, src?)`, `slots(salonId, draft, src?)`, `detail(salonId, id)`: заменить прямые `yc.list`/`yc.records` на методы `src` (по умолчанию `await sources.forSalon(salon)`); логика `slotsFor`, проверки сотрудника/услуг, длительность, ресурсы — без изменений. `day` добавляет `freshness: await mirror.freshness(salonId)` и `source: src.kind`. Графики в `day` — `src.schedule` (локально без лимита конкуренции; для `live` оставить пул из 3).
- `detail(salonId, id)`: `id < 0` → данные из строки `journal_outbox` (`overlay`) + `sync`; иначе при `local` — `raw_payload` из `records` (нет → живой `yc.getRecord`) и наложение.
- `mutate`/`prepare` (используются обработчиком очереди) НЕ переводить на локальный источник: перед реальной записью окно проверяется по живому YClients, как сейчас.

- [ ] **Step 1: тесты overlay** — создание без id → синтетическая запись с отрицательным id и `sync.status`; создание с id, запись уже пришла вебхуком → не дублируется; перенос → поля заменены; отмена → `attendance:-1`; `cancelled` и старый `done` игнорируются; `normalizeRecord` отдаёт `sync`.
- [ ] **Step 2: тесты sources/day** (моки db, reference-cache, yclients): `day` в local-режиме не вызывает `yc.records` и `yc.list('/staff…')`; график без строки кэша → один живой запрос только для этого сотрудника; `slots` в local-режиме даёт те же окна, что live на одинаковых данных (один и тот же набор записей/графика через оба источника); холодный кэш → откат на live.
- [ ] **Step 3:** реализация → **Step 4:** PASS + весь `backend/journal` (в старых тестах при необходимости мокнуть `sources.forSalon` → `live`).

---

### Task 5 (Opus): локальная форма оплаты

**Files:** Create `backend/services/journal/payments-local.js`; Modify `backend/routes/journal.js`, `backend/services/journal/payments.js` (в `options` — `reference.learnBonusPercent(salonId, c.sale)` best-effort); Test `backend/journal-payments-local.test.js`

Чистое ядро `localOptions({ recordId, record, ledger, queued, accounts, card, bonusPercent })`:
- `record` — YClients-форма (зеркало/наложение); `items = record.services.map(s=>({title, quantity: Number(s.amount)||1, total: Number(s.cost)||0}))`; `total = Σ items.total` (копейки — целые);
- `ledger` — строки `journal_financial_transactions` визита в `confirmed`: `paid = payments − removes` по `external_ids`; `queued` — оплаты из незавершённых пакетов (`{method, methodId, amount}`, удаления — отрицательные);
- `due = max(0, total − paid − queued)`;
- `methods`: кассы из `accounts` без `is_acquiring` → `{method:'account', id, title, cash: type_slug==='cash', available: due>0, limit: due, requiresArrivalConfirmation: Number(record.attendance)===0, balance:null, unavailableReason:null}`; бонусы при `card` (`{id: yclients_card_id, balance}`) → `limit = min(balance, due, bonusPercent ? floor(total*bonusPercent/100) − уже_бонусами : Infinity)`, `available: limit>0`;
- результат `{local:true, recordId, clientName, items, due, paid:[…как в live: {id,method,methodId,amount,title}], methods, pending:[], history:[], version:null}`.

Сборка `async localPaymentOptions(salonId, recordId)`: запись — `records.raw_payload` (или строка очереди для `recordId<0`); `ledger` — `journal_financial_transactions` по `yclients_record_id`; `queued` — шаги `pay`/`remove_payment` незавершённых пакетов этой записи; `accounts` — `reference.getReference(salonId,'accounts')`; карта — `clients.yclients_card_id`, `clients.yclients_card_balance` по `yclients_client_id` записи; `bonusPercent` — `reference.getBonusPercent`.

Маршрут: `GET /api/journal/payments/:id?local=1` → `localPaymentOptions` (разрешить отрицательный id: `Number.isSafeInteger(n) && n !== 0`); без `local` — прежний живой `payments.options` (только для положительных id).

- [ ] **Step 1: тесты ядра** — счёт и остаток; оплаты журнала и удаления; поставленные в очередь уменьшают остаток; эквайринг не показан; бонусы ограничены балансом, остатком и процентом (10 % от 30 000 при балансе 5 000 → 3 000; после списанных 1 000 → 2 000); нет карты → бонусов нет; `requiresArrivalConfirmation` только при `attendance 0`.
- [ ] **Step 2–4:** FAIL → реализация → PASS + весь `backend/journal`.

---

### Task 6 (Opus): сессии формы — проверка и постановка пакета

**Files:** Create `backend/services/journal/sessions.js`; Modify `backend/routes/journal.js`; Test `backend/journal-sessions.test.js`

Тело `POST /api/journal/sessions` и `POST /api/journal/sessions/validate`:

```json
{ "sessionId": "uuid-v4",
  "recordId": 2129160940,
  "create": { "date": "2026-11-20", "time": "15:00", "staffId": 3356928, "serviceSource": "internal",
              "serviceIds": [12], "lines": [...], "clientName": "…", "clientPhone": "+7…", "comment": "" },
  "move": { "date": "2026-11-21", "time": "12:00", "staffId": 3356928 },
  "status": "confirm" | "cancel",
  "payments": [ { "method": "loyalty_card", "methodId": 112435557, "amount": 1 },
                { "method": "account", "methodId": 1355178, "amount": 1, "confirmArrival": true } ],
  "removePayments": [ { "transactionId": 871657060, "method": "loyalty_card", "methodId": 112435557, "amount": 1 } ] }
```

Правила разбора (`parseSession`): ровно одно из `recordId` (>0) и `create`; `move` и `status` только с `recordId`; `create`/`move` разбираются существующим `m.parseDraft({...x, operationId: sessionId}, 'create'|'move')` (переиспользовать валидацию, `operationId` потом заменяется на id шага); суммы — `pricing.money`, > 0; не больше 10 оплат и 10 удалений; `confirmArrival` — только `true` и только у `account`. Пустая сессия (нет ни одного действия) → 400.

`validate(salonId, session)` (без записи в БД, без YClients):
- `create`/`move` → `index.availability(salon, draft, record, local)` и `slots.includes(time)`, иначе `409 'Время уже занято. Выберите другое.' code 'busy'`;
- оплаты по `localOptions` (для `create` — по записи, собранной из `create`, с `attendance 0`): последовательно уменьшать остаток; сумма > лимита способа → 409 с названием способа; касса при `attendance 0` без `confirmArrival` → 409 `arrival_confirmation_required`;
- удаления — транзакция есть в `paid` локальных данных и сумма совпадает;
- возвращает `{steps, overlay, options}`.

Шаги (`buildSteps`), каждый `{kind, opId: crypto.randomUUID(), params, state:'pending'}`, порядок: `create|move` → `confirm|cancel` → `pay` (сначала все `loyalty_card`, потом `account`) → `remove_payment`. `overlay`: для `create` — `{kind:'create', date,time,staffId,duration,services:[{id,title,cost}],client:{name,phone},comment,attendance:0}`; для существующей — `{kind:'patch', patch:{datetime?,staff_id?,seance_length?,attendance? ,cancel?}}`; плюс `payments` для локальной формы.

`enqueue(salonId, userId, session)`: `request_hash = m.fingerprint(session)`; `INSERT … ON CONFLICT (salon_id,session_id) DO NOTHING RETURNING id`; не вставилось → прочитать строку: другой хэш → 409 `'Ключ формы уже использован.'`; тот же → вернуть прежний `{outboxId, recordId}`. Ответ: `{outboxId, recordId: session.recordId ?? -outboxId}`. Запрет: новая сессия по `recordId<0`.

`retry(salonId, outboxId)`: только `status='failed'` и `error_code<>'uncertain'` → `status='queued', attempts=0, next_attempt_at=NOW(), error_*=NULL`, шаг `failed_step` → `state:'pending'`. `dismiss(salonId, outboxId)`: только `failed` → `cancelled`.

Маршруты (в `routes/journal.js`, роли owner/admin как у всего роутера; `dismiss`/`retry` для `uncertain` недоступны — сверка через существующие `operations/review`/`payments/review`):
`POST /sessions/validate`, `POST /sessions`, `POST /sessions/:id/retry`, `POST /sessions/:id/dismiss`.

- [ ] **Step 1: тесты** — разбор (взаимоисключения, лимиты, `confirmArrival`), порядок шагов, идемпотентность `sessionId` (тот же хэш → тот же ответ, другой → 409), занятое по локальным данным время → 409 без вставки, сумма больше остатка → 409, касса при ожидании без согласия → 409, `retry` недоступен для `uncertain`, `dismiss` только из `failed`, ни одного вызова YClients (мок `yclients` бросает при любом вызове).
- [ ] **Step 2–4:** FAIL → реализация → PASS + весь `backend/journal`.

---

### Task 7 (Opus): обработчик очереди, кроны

**Files:** Create `backend/services/journal/outbox-worker.js`; Modify `backend/server.js`; Test `backend/journal-outbox-worker.test.js`

- Тик 2 с, защита от наслоения тиков (`_inFlight`), старт: `UPDATE journal_outbox SET status='queued', updated_at=NOW() WHERE status='running'` (шаги безопасно переисполняются: `mutate`/`pay` идемпотентны по `operationId`).
- Аренда одной строки:

```sql
UPDATE journal_outbox SET status='running', attempts=attempts+1, updated_at=NOW()
WHERE id = (
  SELECT o.id FROM journal_outbox o
  WHERE o.status='queued' AND o.next_attempt_at<=NOW()
    AND NOT EXISTS (SELECT 1 FROM journal_outbox p WHERE p.salon_id=o.salon_id AND p.status='running')
    AND NOT EXISTS (SELECT 1 FROM journal_outbox e WHERE e.salon_id=o.salon_id AND e.id<o.id
                    AND e.status IN ('queued','running') AND e.yclients_record_id IS NOT NULL
                    AND e.yclients_record_id=o.yclients_record_id)
  ORDER BY o.next_attempt_at, o.id LIMIT 1 FOR UPDATE SKIP LOCKED)
RETURNING *;
```

- Исполнение шагов по порядку; `done`-шаги пропускаются; после каждого шага — `UPDATE journal_outbox SET steps=$2, yclients_record_id=COALESCE($3,yclients_record_id), updated_at=NOW()`:
  - `create` → `service.mutate(salonId, userId, {...params, operationId: opId, action:'create'})` → `yclients_record_id = result.recordId`;
  - `move`/`confirm`/`cancel` → `rec = yc.getRecord(salon, id)`; `service.mutate(salonId, userId, {operationId: opId, action, recordId:id, version: m.revision(rec), ...params})`;
  - `pay` → `c = payments.context(salonId, id)`; `payments.pay(salonId, userId, payments.parse({operationId: opId, recordId:id, method, methodId, amount, version:c.version, ...(method==='account' && Number(c.record.attendance)===0 && params.confirmArrival ? {confirmArrival:true}:{})}))`; затем `reference.learnBonusPercent(salonId, c.sale)`;
  - `remove_payment` → то же с `action:'remove', transactionId`.
- `classify(e)`: `JournalError` с кодом `uncertain` → `'uncertain'`; кодом `busy`/`stale`, статусом 502/503, или 409 без кода с текстом «не готов» → `'retry'`; остальные `JournalError` → `'fail'`; не-`JournalError`: нет `response` (сеть) / 429 / 5xx → `'retry'`, иначе `'fail'`.
- Итог: все шаги `done` → `status='done'`. `'retry'` и `attempts < 6` → `status='queued', next_attempt_at = NOW() + [5,30,120,600,600][attempts-1] секунд`; иначе `failed`. `'fail'` → `failed`; `'uncertain'` → шаг `state:'uncertain'`, `failed`, `error_code='uncertain'`. `failed_step` = индекс шага, `error_text` = `e.message` для `JournalError`, иначе `'YClients не ответил. Повторите позже.'`.
- `start()` экспорт; `server.js`: в `app.listen` → `if (config.JOURNAL_OUTBOX) require('./services/journal/outbox-worker').start()`.
- Кроны в `server.js` (если `config.JOURNAL_LOCAL_FIRST`, салоны `SELECT * FROM salons WHERE yclients_company_id IS NOT NULL AND is_active=TRUE`, последовательно, ошибки в `cronLogger`):
  - `*/10 * * * *` — `mirror.syncWindow(salon, …windowFor('near'))`;
  - `20 3 * * *` — `windowFor('far')`;
  - `*/30 * * * *` — `reference.refreshReference(salon)`, затем `refreshSchedules(salon, сегодня, сегодня+60)`;
  - после старта сервера — один раз `refreshReference` (без ожидания, catch → WARN).

- [ ] **Step 1: тесты** (моки `service.mutate`, `payments.*`, `yc.getRecord`, db): пакет создание+бонусы+касса — порядок вызовов, `recordId` из создания уходит в оплаты, `confirmArrival` только при ожидании и согласии; перезапуск: `done`-шаги не повторяются; `busy` → повтор с паузой 5 с; 6-я неудача → `failed`; `uncertain` → `failed`, повтора нет; однозначный отказ → `failed` сразу с `failed_step`; сброс `running` на старте.
- [ ] **Step 2–4:** FAIL → реализация → PASS + весь `backend/journal`.

---

### Task 8 (Opus): фронт — сессия формы и мгновенное закрытие

**Files:** Modify `frontend/js/pages/journal.js`, `frontend/index.html` (бамп `?v=` у `journal.js` и `journal.css`), `frontend/css/journal.css`; Test — расширить `backend/journal-ui.test.js` (тот же `vm`-подход, что сейчас).

Поведение:
1. **Сессия.** `journal.session = {sessionId, recordId?|create?, move?, status?, payments:[], removePayments:[]}` создаётся при открытии формы создания/переноса, подтверждения/отмены или формы оплаты.
2. **Создание/перенос/подтверждение/отмена без оплаты:** «Создать запись»/«Сохранить перенос»/«Подтвердить»/«Да, отменить» → `POST sessions` → форма закрывается, `loadJournal()`, `notify('Сохранено')`. Ошибка проверки (409) — текст в форме, форма открыта.
3. **Создание с оплатой** (кнопки «Карта»/«Наличные»/«Все способы / бонусы»): `POST sessions/validate` с `create` → при успехе открыть форму оплаты в режиме сессии по `options` из ответа; выбор способа добавляет оплату в `journal.session.payments` и пересчитывает остаток локально (`due`, лимиты), без запросов; касса при ожидании — прежний блок «Оплатить и отметить приход», ставит `confirmArrival:true`. Кнопка «Готово» (и закрытие окна, если в сессии есть действия) → `POST sessions` → закрыть.
4. **Оплата существующей записи:** открыть сразу по `payments/:id?local=1`; параллельно `payments/:id` (живой, только `id>0`) — когда придёт, тихо заменить суммы, если в сессии ещё нет действий; дальше как п. 3. Удаление оплаты — в `removePayments`.
5. **Убрать** тексты и блоки сверки из форм: «Повторное проведение заблокировано», «ожидает сверки», `jrPaymentRecovery`, «Проверить результат / повторить», «Перед сохранением повторно проверим время…», «Запись сохранена в YClients». Кнопка «Сверка операций» для владельца остаётся в шапке.
6. **Карточки:** `r.sync?.status` `queued|running` → значок «⏳» и класс `jr-visit-syncing`; `failed` → класс `jr-visit-failed` и строка «Не передано в YClients» (title — `errorText`). Открытие записи с `failed` — блок вверху карточки: причина, шаг, кнопки «Повторить отправку» (`POST sessions/:outboxId/retry`, скрыта при `errorCode==='uncertain'`), «Убрать из журнала» (только для созданных `id<0`, `dismiss`), «Изменить» (для созданных — новая форма создания, предзаполненная из записи, старый пакет `dismiss` после успешной отправки новой сессии). Для `uncertain` — текст «Нужна сверка в YClients» и подсказка про «Сверку операций».
7. **Опрос:** пока на экране есть записи с `sync.status` `queued|running`, `loadJournal({silent:true})` раз в 5 с (без «Загружаем расписание…» и без сброса сетки); остановка при уходе со страницы.
8. **Свежесть:** `data.freshness.mirrorOkAt` старше 30 мин → в `jrState` «Данные YClients обновлены ЧЧ:ММ».
9. Глобальные имена — с префиксом `jr`; общий `vm`-тест грузит все `<script>` `index.html`.

- [ ] **Step 1: тесты UI** (по образцу существующих в `journal-ui.test.js`): создание без оплаты → один `POST sessions`, окно закрыто; создание с «Карта» → `validate`, затем выбор способа не делает запросов, «Готово» → один `POST sessions` с `create` и `payments`; касса при ожидании → `confirmArrival:true`; карточка с `sync.status='failed'` показывает «Не передано в YClients» и кнопку повтора, для `uncertain` кнопки повтора нет; опрос стартует при `queued` и останавливается без них; тексты сверки отсутствуют в разметке формы оплаты.
- [ ] **Step 2–4:** FAIL → реализация → PASS + `npx jest backend/journal --silent`.

---

### Task 9 (координатор): выкладка на дев и живая проверка

- [ ] Перезапуск: `cd /root/loyalpro/backend && PORT=3001 pm2 restart loyalpro`; миграции применились (SELECT по 4 таблицам).
- [ ] Догон: `node scripts/journal-mirror-backfill.js --salon=1` (сухой) → `--write`; повтор сухого — расхождений 0.
- [ ] Кэш: ручной `refreshReference` + `refreshSchedules` (сегодня…+60); проверить строки.
- [ ] Замер: `GET /api/journal/day` и `/slots` — ни одного запроса к YClients (временный счётчик в логе `ycGet` или по nginx-логу api.yclients отсутствует), время ответа.
- [ ] Живой прогон на клиенте 79200255591 (по разрешению владельца): одна сессия «создать + бонусы 1 + касса 1 с приходом» → пакет `done`, оплаты в YClients; занятое время (запись в то же окно, созданная напрямую в YClients после проверки формы) → пакет `failed` «время занято»; удаление тестовых записей и операций.
- [ ] Спека/CLAUDE.md: раздел про журнал (локальный режим, очередь, кроны, рычаги).
