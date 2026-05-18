# Дашборд: расширение карточки «Выручка за период»

**Дата:** 2026-05-18
**Скоуп:** backend + frontend, прод
**Зависимости:** ранее реализованная фаза «период Сегодня/Неделя/Месяц/диапазон» (commit `be3e525`)

## 1. Цель

Карточка «Выручка за период» на дашборде сейчас показывает только выручку от услуг (`records.amount`). Расширить её так, чтобы:

- Крупной цифрой — суммарная выручка за период (услуги + товары + абонементы + сертификаты + пополнения счёта).
- Под ней — детализация в 5 строк по каждой категории.

## 2. Контекст и ключевые находки

YClients шлёт все финансовые события через webhook `resource_type='finances_operation'`. В пейлоаде есть поле `expense.title`, по которому одного типа события различаются:

| `expense.title` | sold_item_type | За 34 дня (тест-салон) |
|---|---|---|
| Оказание услуг | service | 637 событий, 6.6M ₽ |
| Продажа товаров | goods_transaction | 123 события, 842K ₽ |
| Продажа абонементов | goods_transaction | 5 событий, 196K ₽ |
| Продажа сертификатов | goods_transaction | 4 события, 45K ₽ |
| Пополнение счета | null | 6 событий, 1.7K ₽ |
| Закупка/Зарплата/Прочие расходы | null | расходы (amount<0), не выручка |

Это означает:
- Никаких новых типов webhook не нужно — все события уже принимаем.
- В `webhook_logs` лежит ~34 дня истории (с 21 марта 2026), которую можно перетянуть в новую таблицу.
- Для истории глубже — нужен бекфилл из YClients API `/finance_transactions/{company_id}`.

Депозиты (`Пополнение счета`) учитываем кассовым методом — выручкой в момент пополнения. Возможный двойной счёт при последующем списании депозита будет мониториться через логирование операций с `account.title='Лицевой счёт клиента'` (в текущих данных таких нет).

## 3. Архитектурное решение

**Единая таблица `revenue_operations` с полем `category`.**

```
                    ┌──────────────────────────┐
   YClients API ──► │  /finance_transactions   │ ──┐
                    │   (бекфилл за 1–2 года)  │   │
                    └──────────────────────────┘   │
                                                   ▼
                    ┌──────────────────────────┐   ┌────────────────────┐
   YClients webhook │ POST /yclients/webhook.v2│──►│ revenue_operations │
                    │ → processFinancesOperatn │   │  (новая таблица)   │
                    └──────────────────────────┘   └────────────────────┘
                                                             │
                                                             ▼
                    GET /api/analytics/dashboard?from=…&to=…
                    → агрегация GROUP BY category
                    → карточка «Выручка за период» (total + 5 строк)
```

`processFinancesOperation` остаётся точкой входа для всех финансовых событий. Получает побочную ответственность — записать строку в `revenue_operations`, если событие классифицировано как выручка (amount > 0 и известная категория). Логика кэшбэка (`finances_log`) не трогается.

## 4. Схема БД

```sql
CREATE TABLE IF NOT EXISTS revenue_operations (
  id                    SERIAL PRIMARY KEY,
  salon_id              INT NOT NULL REFERENCES salons(id) ON DELETE CASCADE,
  yclients_operation_id BIGINT NOT NULL,            -- payload.data.id
  category              VARCHAR(32) NOT NULL,        -- services|goods|abonement|certificate|deposit|other
  amount                NUMERIC(12,2) NOT NULL,      -- всегда > 0
  operation_date        DATE NOT NULL,               -- (date AT TZ Europe/Moscow)::date
  operation_at          TIMESTAMPTZ NOT NULL,        -- payload.data.date
  client_id             INT REFERENCES clients(id) ON DELETE SET NULL,
  yclients_client_id    BIGINT,
  yclients_record_id    BIGINT,                      -- 0 если не привязано к визиту
  expense_id            INT,
  expense_title         VARCHAR(128),
  sold_item_type        VARCHAR(32),
  account_title         VARCHAR(128),
  is_cash               BOOLEAN,
  raw_payload           JSONB,
  source                VARCHAR(16) NOT NULL,        -- webhook|webhook_logs_backfill|api_backfill
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(salon_id, yclients_operation_id)
);

CREATE INDEX IF NOT EXISTS idx_revenue_ops_salon_date
  ON revenue_operations(salon_id, operation_date);
CREATE INDEX IF NOT EXISTS idx_revenue_ops_salon_cat_date
  ON revenue_operations(salon_id, category, operation_date);
```

Миграция добавляется в `backend/migrations.js` по паттерну `CREATE TABLE IF NOT EXISTS`.

## 5. Маппинг `expense.title` → `category`

Реализуется как чистая функция `classifyExpense(expenseTitle: string) -> category | null` в `backend/services/loyalty.js`:

| expense.title | category |
|---|---|
| Оказание услуг | `services` |
| Продажа товаров | `goods` |
| Продажа абонементов | `abonement` |
| Продажа сертификатов | `certificate` |
| Пополнение счета | `deposit` |
| Закупка материалов, Закупка товаров, Зарплата персонала, Прочие расходы | `null` (не пишем) |
| Любое другое | `other` (пишем с warning-логом) |

Дополнительный фильтр: операции с `amount <= 0` не пишутся в таблицу вообще.

Категория `other` пишется в таблицу, но в карточку «Выручка за период» **не входит**. Цель — поймать новые типы операций, появляющиеся у YClients, через логи.

## 6. Изменения backend

### 6.1 `services/loyalty.js`
- Добавить `classifyExpense(title)` — pure function.
- Расширить `processFinancesOperation`: после обработки кэшбэка вызвать `recordRevenueOperation(payload, salon, source='webhook')`. Метод выполняет идемпотентный INSERT через `ON CONFLICT (salon_id, yclients_operation_id) DO NOTHING`.

### 6.2 `services/yclients.js`
- Добавить `listFinanceTransactions(salon, { dateFrom, dateTo, page, count })` — обёртка над `GET /finance_transactions/{company_id}`. Возвращает массив операций.
- **Допущение:** точное имя query-параметров (`date_from`/`date_to` vs `from`/`to`) уточнить экспериментально при написании скрипта — официальная док-я YClients местами расходится с реальной API. Если эндпоинт не существует, fallback — использовать `/kassa` или агрегировать через `/document/{cid}`.

### 6.3 `routes/api.js`
- Заменить текущий подзапрос `revenue` (читавший из `records`) на агрегацию из `revenue_operations`:
  ```sql
  SELECT category, COALESCE(SUM(amount),0) AS sum, COUNT(*) AS cnt
  FROM revenue_operations
  WHERE salon_id=$1
    AND operation_date BETWEEN $2::date AND $3::date
    AND category IN ('services','goods','abonement','certificate','deposit')
  GROUP BY category
  ```
- В ответе `stats` добавить:
  ```js
  periodRevenueByCategory: {
    total, services, goods, abonement, certificate, deposit
  }
  ```
- Старое поле `periodRevenue` оставить, оно теперь равно `total`. Производные метрики (`avgCheck`, ROI) считаются от `services` (для среднего чека на визит логично оставить только услуги — сейчас так и есть фактически).

### 6.4 Бекфилл-скрипты
- `backend/scripts/backfill-revenue-from-webhook-logs.js` — читает `webhook_logs` где `event_type='finances_operation'`, классифицирует и пишет в `revenue_operations` с `source='webhook_logs_backfill'`. Идемпотентен.
- `backend/scripts/backfill-revenue-from-yclients.js` — CLI: `--from YYYY-MM-DD --to YYYY-MM-DD --salon-id N [--rate-limit-ms 200]`. Постранично тянет `/finance_transactions`, классифицирует и пишет с `source='api_backfill'`. По окончании печатает сверку: `SUM(records.amount) за период vs SUM(revenue_operations.amount WHERE category='services') за тот же период`.

## 7. Изменения frontend

### 7.1 `frontend/index.html`
Карточка `Выручка за период` обновляется:

```html
<div class="sc sc-revenue">
  <div class="sl">Выручка за период</div>
  <div class="sv" id="ds3">—</div>
  <div class="sd" id="ds3s"></div>
  <div class="rev-breakdown" id="ds3b">
    <div class="rev-row"><span class="rev-lbl">Услуги</span><span class="rev-val" id="rev-services">—</span></div>
    <div class="rev-row"><span class="rev-lbl">Косметика и товары</span><span class="rev-val" id="rev-goods">—</span></div>
    <div class="rev-row"><span class="rev-lbl">Абонементы</span><span class="rev-val" id="rev-abonement">—</span></div>
    <div class="rev-row"><span class="rev-lbl">Сертификаты</span><span class="rev-val" id="rev-certificate">—</span></div>
    <div class="rev-row"><span class="rev-lbl">Пополнения счёта</span><span class="rev-val" id="rev-deposit">—</span></div>
  </div>
</div>
```

CSS (минимум, в `frontend/styles.css` или встроенный блок):
```css
.rev-breakdown { margin-top:12px; display:flex; flex-direction:column; gap:6px; font-size:13px; }
.rev-row { display:flex; justify-content:space-between; color:var(--t2); }
.rev-val { color:var(--t1); font-variant-numeric:tabular-nums; }
.rev-row.zero { opacity:.5; }
```

### 7.2 `frontend/js/pages/dashboard.js`
В `loadDashboard` после получения `s = data.stats`:
- Total: `animateCount('ds3', s.periodRevenueByCategory.total, { suffix:' ₽' })`.
- Для каждой категории: `animateCount('rev-<cat>', s.periodRevenueByCategory[cat], { suffix:' ₽' })`. Строки с нулём получают класс `zero`.
- Существующая логика `s.periodRevenue` остаётся как fallback (на случай старого ответа API).

## 8. Тестирование и верификация

- **Unit:** новый тест-файл `backend/revenue-classify.test.js` — кейсы для всех expense.title (включая «другое» и расходы).
- **Интеграционный:** ручная проверка через `mcp__postgres__query` после миграции — выборка с группировкой по `category`.
- **Сверка бекфилла:** сравнение `SUM(records.amount)` за период (текущий источник, услуги) с `SUM(revenue_operations.amount WHERE category='services')` за тот же период. Ожидается ≈совпадение, но точное равенство не гарантировано: `records.amount` агрегирует услуги по визиту, а `finances_operation` шлёт отдельную операцию на каждый sold_item. Расхождение >5% — повод для расследования.
- **Smoke:** Playwright (`mcp__playwright__*`) на дашборде с пресетами «Сегодня / Неделя / Месяц» — проверить, что все 5 строк отрисованы, total = сумма строк.

## 9. Раскатка

Последовательность (на dev → потом на прод):

1. **Миграция:** автоматически на старте сервера (`migrations.js`).
2. **Бекфилл из `webhook_logs`:** запускается вручную сразу после рестарта, ~секунды. После этого таблица содержит ~34 дня данных.
3. **API ответ:** деплоится одновременно с миграцией, начинает отдавать `periodRevenueByCategory`. За последние 34 дня цифры полные, за более ранний период — частичные (только то, что успело прилететь webhook-ами до миграции — фактически 0).
4. **Frontend** деплоится одновременно с API. Карточка показывает данные начиная с 21 марта 2026.
5. **Бекфилл из YClients API:** вручную в фоне с `--from 2025-01-01`. Может занять часы; не блокирует продакшн (новые webhook-и продолжают писать в таблицу с `ON CONFLICT DO NOTHING`).
6. **Сверка:** после завершения API-бекфилла — выполнить запрос-сравнение из секции 8 и убедиться, что `periodRevenueByCategory.services` ≈ `records.amount`.

`periodRevenue` (старое скалярное поле) сохраняется в ответе API навсегда (синоним total). Это гарантирует, что любой клиент со старой версией фронта (или внешний потребитель) не сломается.

## 10. Риски

| Риск | Митигация |
|---|---|
| Двойной счёт услуг, оплаченных абонементом | Фильтр `amount > 0`. Сверка с `records.amount` после бекфилла. Логирование операций с `account.title='Лицевой счёт клиента'` для будущего разбора. |
| Двойной счёт депозита (пополнение + списание) | Текущие данные: 0 событий списания. Когда появятся — категория `other` или отдельная категория. Логируем для разбора. |
| Рейт-лимит YClients API при бекфилле | `sleep(200ms)` между страницами, ретрай 429 с экспоненциальным back-off. CLI флаг `--rate-limit-ms`. |
| Падение карточки на старом фронте после обновления API | Сохраняем поле `periodRevenue` (число = total) ради совместимости. |
| Появление нового expense.title | Категория `other` пишется в таблицу с warning-логом, видно в `pm2 logs`. |

## 11. Объём работ (оценочно)

| Слой | Файлы | Сложность |
|---|---|---|
| Миграция | `migrations.js` | 5 мин |
| Маппинг + handler | `services/loyalty.js` | 30 мин |
| Метод YClients API | `services/yclients.js` | 15 мин |
| Бекфилл webhook_logs | новый скрипт | 30 мин |
| Бекфилл YClients API | новый скрипт | 1.5 ч |
| API endpoint | `routes/api.js` | 15 мин |
| Frontend (HTML/CSS/JS) | `index.html`, `dashboard.js`, `styles.css` | 30 мин |
| Тесты + смоук | unit + Playwright | 30 мин |
| **Итого** | | **~4–5 ч** |
