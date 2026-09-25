# Замена планового синка YClients — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Убрать 3-часовой полный `runSync` из крона, заменив его событийным сохранением полей `client`-вебхука и лёгкой ночной сверкой по `changed_after`; полный синк остаётся ручным с рабочим ретраем на лимите.

**Architecture:** Чистый разбор полей клиента YClients — `services/client-upsert.js` (одно правило для вебхука и сверки). Ночная сверка — `services/yclients-reconcile.js` (записи за 2 дня → активные клиенты → карточка/карта/баланс → `last_visit_at` и `record_id` транзакций → строка `sync_logs`). Общие SQL хвоста синка (upsert записи, `last_visit_at`, привязка `record_id`) выносятся из `runSync` в экспортируемые функции `loyalty.js`, чтобы правило было одно. Кэшбэк сверка НЕ начисляет.

**Tech Stack:** Node.js, pg, node-cron, jest (моки `./db`, `./services/yclients`, `./logger` как в `loyalty-card-link.test.js`).

Спека: `docs/superpowers/specs/2026-09-25-yclients-sync-replacement-design.md`.

---

### Task 1: `services/client-upsert.js` — поля клиента из объекта YClients

**Files:**
- Create: `backend/services/client-upsert.js`
- Test: `backend/client-upsert.test.js`

- [ ] **Step 1: тест** (`clientFieldsFromYc`: `spent` главнее `paid`, пустое → 0, уровень по `levels`, без `levels` → `null`; `upsertClientFromYc` пишет `total_spent/visits_count/yclients_data/loyalty_level` одним SQL с `ON CONFLICT (salon_id,yclients_client_id)`, `bonus_balance` и карту не трогает).
- [ ] **Step 2: запуск, красный** — `npx jest client-upsert`.
- [ ] **Step 3: реализация** — `clientFieldsFromYc(yc, levels)` → `{name, phone, email, birthday, totalSpent, visitsCount, level, ycData}`; `upsertClientFromYc(salonId, yc, settings)` → `db.one(INSERT … ON CONFLICT DO UPDATE … RETURNING *)`.
- [ ] **Step 4: зелёный.**
- [ ] **Step 5: commit** `feat(clients): client-upsert — одно правило разбора карточки YClients`.

### Task 2: `client`-вебхук сохраняет `spent`/`visits`/`yclients_data`/уровень

**Files:**
- Modify: `backend/routes/webhook.js` (ветка `resourceType === 'client'`)
- Test: `backend/webhook-client-upsert.test.js` (грузит роутер с моками, дёргает handler напрямую)

- [ ] **Step 1: тест** — на `client`-вебхук с `spent=1373824, visits=55` в SQL уходят эти значения и `yclients_data`.
- [ ] **Step 2: красный.** **Step 3:** заменить inline-INSERT на `upsertClientFromYc(salon.id, ycRec, settings)`. **Step 4: зелёный.** **Step 5: commit** `feat(webhook): client-вебхук пишет траты, визиты, уровень и yclients_data`.

### Task 3: хвост синка в функции `loyalty.js`

**Files:**
- Modify: `backend/services/loyalty.js` (runSync: per-record upsert → `upsertRecordFromYc`, bulk-SQL → `refreshLastVisitAt`, `linkCardTransactionsToRecords`; Step 1 → `withRateLimitRetry({retries:3, delayMs:60_000})`)
- Test: `backend/loyalty-sync-helpers.test.js`

- [ ] **Step 1: тест** — `upsertRecordFromYc` INSERT при отсутствии / UPDATE при наличии, `source` параметром; `refreshLastVisitAt`/`linkCardTransactionsToRecords` зовут SQL с `salon_id`; страница `/records` при «Превышен лимит» повторяется после паузы 60 с (fake timers).
- [ ] **Step 2: красный.** **Step 3: реализация** (чистый вынос кода, поведение runSync прежнее). **Step 4: зелёный** + `npx jest loyalty` (все сьюты loyalty зелёные). **Step 5: commit** `refactor(loyalty): хвост runSync в функции; ретрай /records ждёт 60 с`.

### Task 4: `services/yclients-reconcile.js`

**Files:**
- Create: `backend/services/yclients-reconcile.js`
- Test: `backend/yclients-reconcile.test.js`

- [ ] **Step 1: тесты** — `changedAfterDate(now, 2)`; `reconcileDaily(salon, deps)`: постраничный `/records?changed_after`, `upsertRecordFromYc(..., 'reconcile')` на каждую, множество клиентов без дублей, WARN «вебхук по записи N потерян» при `attendance=1 && paid_full=1` без строки `finances_log`, `processCompletedRecord` НЕ зовётся, ошибка одного клиента не роняет прогон, `linkClientCard` при пустой карте, обновление баланса при привязанной, `sync_logs` success/error с `sync_type='daily'`; `closeStaleSyncRuns()`; `warnIfRepeatedFailures` при 3 подряд error.
- [ ] **Step 2: красный.** **Step 3: реализация.** **Step 4: зелёный.** **Step 5: commit** `feat(sync): ночная сверка YClients по changed_after`.

### Task 5: крон, старт, ручной синк

**Files:**
- Modify: `backend/server.js` (крон `35 4 * * *` мск → `reconcileDaily`; `runSync` убрать из `0 */3`; `syncGoodsCategories` → `10 */3 * * *`; при старте `closeStaleSyncRuns()`)
- Modify: `backend/routes/api.js` `POST /sync` → 409 при `status='running'` моложе 2 ч.

- [ ] **Step 1:** правки. **Step 2:** `node -e "require('./server.js')"` не нужен — проверка `PORT=3001 pm2 restart loyalpro` на деве и строка крона в логе. **Step 3: commit** `feat(sync): runSync только вручную; ночная сверка в кроне; зависшие running → error`.

### Task 6: живая проверка и документация

**Files:**
- Create: `backend/scripts/yclients-reconcile-e2e.js` (реальный YClients салона 1 на деве, печатает счётчики; денег не пишет по построению)
- Modify: `CLAUDE.md` (Cron jobs + пункт про синк), `docs/2026-09-25-cashback-accrual-bugs.md` (пункт 1 → ИСПРАВЛЕНО)

- [ ] **Step 1:** прогон скрипта на деве, `sync_logs` содержит `daily/success`. **Step 2:** полный `npx jest` (кроме `primary-clients`) зелёный. **Step 3: commit** `docs(sync): CLAUDE.md и план багов — синк заменён`.
