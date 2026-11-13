# Финансовые операции, детализация оплаты, баланс бонусов в LoyalPro — 12.11.2026

Запрос владельца (12.11.2026, дев):
1. При повторном открытии формы оплаты нет детализации: сколько оплачено, сколько бонусов списано, скидка и т. д.
2. Оплата в журнале «фактически не списала бонусы в нашей системе».
3. Нужна таблица финансовых операций по аналогии с YClients: приходы, оплаты, списания и т. д.

Решения владельца: баланс бонусов ведёт LoyalPro («наш баланс — главный»), YClients — копия; таблица + страница; перенести всю имеющуюся историю.

Только дев (`loyalpro_test`). Прод не затрагивается. Снимок до правок: `/root/loyalpro-deploy-backups/finance-ops-before-20261112/` (`files.tgz` — код, `tables.dump` — clients, loyalty_card_transactions, revenue_operations, journal_financial_transactions, journal_outbox).

## Диагноз (12.11.2026)

- Пакет outbox 39 (09:42 мск): `pay` бонусы 6 500 (`loyalty_card`) + `pay` карта 58 500 (`account`), дочерний к созданию 36 (новая запись, не отправлена). С 10.11 автоотправки нет — пакет `queued`, `released_at IS NULL`. В YClients ничего не ушло, а `clients.bonus_balance` у нас только копирует баланс карты YClients (присваивается в `loyalty.js`, `linkClientCard`, сверке) — поэтому «не списалось».
- `payments-local.localOptions`: оплаты из очереди вычитаются из `due`, но в `paid` попадают только `confirmed` строки `journal_financial_transactions`; строки счёта несут только итог (`total`), без цены/количества/скидки. Отсюда «нет детализации».
- Сводной таблицы нет: `revenue_operations` (кассовые операции из вебхука `finances_operation`, с 04.11), `loyalty_card_transactions` (бонусы, с 04.11, `yclients_txn_id` всегда NULL), `journal_financial_transactions` (аудит наших оплат журнала, только отправленные).

## Этап 1 — детализация формы оплаты

Только чтение, ничего не пишет ни в БД, ни в YClients.

`localOptions` дополнительно отдаёт:
- `items[]`: `title, quantity, unitPrice, gross (= цена×кол-во), discountPercent, discount (₽), total`. Источник — `services[]` записи YClients (`cost_per_unit`, `amount`, `first_cost`, `discount`, `cost`) или строки `lines` черновика создания. Нет `first_cost` → `gross = cost_per_unit×amount`, нет и его → `gross = total`, скидка 0.
- `summary`: `gross, discount, total, paidConfirmed, paidQueued, bonusSpent, due` (рубли, считаются в копейках).
- `payments[]`: единый список — подтверждённые (как сейчас `paid`, `status:'confirmed'`) + шаги очереди `pay` со статусом `queued` (пакет ждёт отправки), `sending` (`released_at` есть, пакет `queued`/`running`), `failed`; удаление оплаты из очереди — строка `kind:'remove_payment'` со статусом. Поля: `method, methodId, title, amount, status, outboxId`.
- бонусный метод: `balance` = баланс карты, `balanceAfter` = баланс минус бонусы в очереди этого визита (до этапа 3; после этапа 3 — баланс из нашего журнала, см. ниже).
- `paid` остаётся как есть (фронт по индексу `paid[i]` удаляет оплаты — не ломать).

Фронт (`jrPaymentShow`/`jrPaymentBreakdown`, `journal.js`): счёт = строки услуг «цена × кол-во, скидка −N ₽ (P %), итог»; блок итогов «Без скидки / Скидка / Итого»; блок «Оплаты» — каждая строка со статусом-плашкой («Проведено в YClients», «Ждёт отправки в YClients», «Передаётся», «Ошибка»); «Бонусов списано», «Остаток к оплате», «Баланс бонусов после оплаты». Экранирование — `jrEscape`. Версия статики `?v=` бампается.

## Этап 2 — таблица `finance_operations` и страница «Финансовые операции»

### Схема (аддитивная миграция в `migrations.js`, `IF NOT EXISTS`)

```
finance_operations (
  id bigserial PK,
  salon_id int NOT NULL → salons,
  occurred_at timestamptz NOT NULL,          -- когда произошло (для очереди — момент «Готово»)
  op_date date NOT NULL,                     -- московская дата occurred_at
  kind text NOT NULL,                        -- см. ниже
  method text,                               -- cash | card | bonus | other
  amount numeric(12,2) NOT NULL,             -- со знаком: + приход денег / начисление бонусов, − расход / списание
  status text NOT NULL,                      -- queued | sending | confirmed | cancelled | failed
  origin text NOT NULL,                      -- journal | yclients | loyalpro | staff | backfill | opening
  account_id bigint, account_title text,     -- касса YClients
  client_id int → clients ON DELETE SET NULL,
  yclients_client_id bigint,
  yclients_record_id bigint,
  outbox_id bigint, step_op_id uuid,         -- шаг журнала (pay/remove_payment)
  journal_operation_id uuid,                 -- journal_financial_transactions.operation_id
  revenue_operation_id int,                  -- revenue_operations.id
  loyalty_txn_id int,                        -- loyalty_card_transactions.id
  yclients_operation_id bigint,              -- id финансовой операции YClients
  user_id int, title text, comment text,
  created_at, updated_at timestamptz
)
UNIQUE (salon_id, step_op_id)              WHERE step_op_id IS NOT NULL
UNIQUE (salon_id, revenue_operation_id)    WHERE revenue_operation_id IS NOT NULL
UNIQUE (salon_id, loyalty_txn_id)          WHERE loyalty_txn_id IS NOT NULL
UNIQUE (salon_id, journal_operation_id)    WHERE journal_operation_id IS NOT NULL
INDEX (salon_id, op_date), (salon_id, client_id), (salon_id, yclients_record_id)
```

`kind`: `visit_payment` (оплата визита деньгами), `payment_reversal` (удаление оплаты), `bonus_redemption`, `bonus_accrual` (кэшбэк, ДР, приветственные, начисления YClients), `bonus_adjustment` (ручные правки), `bonus_opening` (входящий остаток, этап 3), `goods_sale`, `certificate_sale`, `abonement_sale`, `deposit`, `other_income`. Классификация `revenue_operations.category` → `services`→`visit_payment`, `goods`→`goods_sale`, `certificate`→`certificate_sale`, `abonement`→`abonement_sale`, `deposit`→`deposit`, прочее → `other_income`; `is_cash` → `method` cash/card.

### Модуль `services/finance-ops.js` (единственный писатель)

Идемпотентные upsert-функции по уникальным ключам (`ON CONFLICT … DO UPDATE` только статуса/ссылок, сумма не перезаписывается):
- `recordJournalStep(row, step)` — из `POST /api/journal/sessions` для каждого шага `pay`/`remove_payment`: `origin=journal`, `status=queued`. `loyalty_card` → `kind=bonus_redemption, method=bonus, amount=−X`; `account` → `kind=visit_payment`, method по кассе из кэша `accounts` (cash/card), `amount=+X`; `remove_payment` → `kind=payment_reversal` (бонус — `amount=+X`, деньги — `−X`).
- `markStep(salonId, stepOpId, status, {journalOperationId})` — из `outbox-worker`: выпуск пакета (`dispatch`) → `sending`; шаг `done` → `confirmed` + ссылка на `journal_financial_transactions`; пакет `failed`/`cancelled` → `failed`/`cancelled`.
- `recordRevenueOp(revenueRow)` — вызывается из `revenue.recordRevenueOperation` после вставки и при удалении операции (`status=cancelled`). Если это кассовая операция по визиту, совпадающая с нашей `confirmed` оплатой журнала (тот же визит, сумма, касса, ±1 сутки, ещё не связанной), — не новая строка, а ссылка `revenue_operation_id` на строку журнала (иначе выручка задвоится).
- `recordLoyaltyTxn(lctRow)` — вызывается после КАЖДОЙ вставки в `loyalty_card_transactions` (loyalty.js, routes/clients.js, routes/staff.js, routes/api.js). Списание по визиту, совпадающее с нашей подтверждённой бонусной оплатой журнала (клиент, визит, сумма), — ссылка, не новая строка.

Сбой записи в `finance_operations` не должен ронять денежный путь: `try/catch` + `logger.warn` + догон ночной сверкой (`finance-ops.reconcile`, крон `50 4 * * *` — проходит последние 7 дней трёх источников и outbox, добавляет недостающее теми же upsert).

### Перенос истории

`scripts/finance-ops-backfill.js --salon=1 [--write]` — сухой прогон по умолчанию (печатает счётчики по kind/status/origin и суммы), `--write` — те же upsert-функции: `revenue_operations` (все), `loyalty_card_transactions` (все), `journal_financial_transactions` (все `confirmed`/`pending`), открытые и выполненные шаги `journal_outbox`. Старые таблицы только читаются. Повторный запуск ничего не дублирует.

### API и страница

- `GET /api/finance/operations?from&to&kind&method&status&clientId&account&q&limit&offset` (owner/admin, `salon_id` из JWT, период ≤ 366 дней) → `{rows, total, summary:{income, expense, bonusRedeemed, bonusAccrued, queued}}`.
- `GET /api/finance/operations/export.csv` — тот же фильтр (необязательно, если не дороже часа).
- Фронт `frontend/js/pages/finance.js` + пункт меню «Финансы» (owner/admin): период (сегодня/неделя/месяц/свой), фильтры, таблица (дата, тип, способ, касса, клиент, визит, сумма, статус, источник, кто), итоги сверху, пагинация; клик по визиту открывает его в журнале. Стиль — как прочие страницы (Ivory & Brass), тёмная тема, телефон 390 px.

## Этап 3 — баланс бонусов из `finance_operations`

Включается флагом `BONUS_LEDGER_PRIMARY` (по умолчанию `false`; на деве — `true` после сухого прогона и подтверждения владельца).

- `bonus_balance(client) = SUM(amount) FROM finance_operations WHERE client_id AND method='bonus' AND status IN ('queued','sending','confirmed')`. Единственная функция `bonusLedger.recompute(clientId)` пишет `clients.bonus_balance`; вызывается после каждого бонусного upsert/смены статуса. Остальные читатели (`mobile-client`, Мила, рассылки, карточка клиента, форма оплаты) читают `bonus_balance` как сейчас.
- Входящий остаток: `scripts/bonus-ledger-opening.js [--write]` — для каждого клиента с картой `bonus_opening = yclients_card_balance − SUM(бонусных строк из истории, кроме queued/sending)`, дата — начало истории. После него сумма = баланс карты + неотправленные списания журнала. Сухой прогон печатает число клиентов и суммы; ничего не трогает.
- Синхронизации больше не присваивают `bonus_balance`: `loyalty.js` (FinOp create/delete, кэшбэк, возврат), `linkClientCard`, `yclients-reconcile` пишут только `yclients_card_balance`; дельта для «новой операции YClients» считается от `yclients_card_balance` (не от `bonus_balance`, который включает очередь), и строка `loyalty_card_transactions` → `finance_operations` через `recordLoyaltyTxn`. При флаге `false` поведение прежнее.
- Расхождение = `bonus_balance − (неотправленные бонусные операции) ≠ yclients_card_balance` (порог 1 ₽). Ночная сверка — WARN со счётчиком; на странице — фильтр/плашка «Расхождения с YClients» (список клиентов, наш баланс, YClients, разница). Автоматических правок нет.
- Лимит бонусов в форме оплаты считается от нашего баланса.

## Проверки

- Jest: юниты `finance-ops.test.js`, `bonus-ledger.test.js`, расширение `journal-payments-local.test.js`, `journal-ui.test.js`; весь набор `npx jest journal finance bonus --silent`.
- Сухие прогоны переноса и входящего остатка на `loyalpro_test` с печатью агрегатов; затем `--write`; повторный запуск = 0 новых строк.
- Рестарт только дев-процесса loyalpro (порт 3001), smoke API 200/401.
- Реальных оплат/списаний агент не делает; живой тест — владелец на клиенте 79200255591.

## Откат

Этап 1 — восстановить `payments-local.js`/`journal.js` из снимка. Этап 2 — таблица аддитивная, вызовы обёрнуты в try/catch; откат кода оставляет таблицу неиспользуемой. Этап 3 — `BONUS_LEDGER_PRIMARY=false` + рестарт: синхронизации снова присваивают `bonus_balance` из YClients при следующем событии; для мгновенного возврата — `UPDATE clients SET bonus_balance=yclients_card_balance WHERE yclients_card_id IS NOT NULL` (только по решению владельца).
