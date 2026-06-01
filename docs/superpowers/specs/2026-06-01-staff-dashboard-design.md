# Personal Staff Dashboard — Design Spec

**Дата:** 2026-06-01
**Статус:** Brainstormed, awaiting user review.
**Связанные модули:** `routes/api.js#/analytics/dashboard` (клинический дашборд — НЕ трогаем), `staff_members` (справочник YClients-сотрудников), `users` (логины).

## 1. Цель

Дать сотрудникам с ролью `specialist` (мастерам клиники) собственный личный дашборд: те же типы показателей, что у владельца, но **отфильтрованные «по мне»**. Владелец/админ при этом видят только клинический (агрегированный) дашборд, без возможности «посмотреть личный любого мастера» — приватность между мастерами.

## 2. Решения (зафиксировано в брейнсторме)

| # | Решение |
|---|---|
| Q1 | Привязка `users.staff_member_id` → `staff_members.id`, проставляется вручную владельцем/админом в карточке пользователя |
| Q2 | Скоуп v1 — минимум KPI: визиты, моя выручка (с разбивкой), уник. клиенты, первичные, средний чек, топ-5 услуг, дневной график. **Бонусов нет.** |
| Q3 | Детализация выручки тремя строками: **Услуги · Косметика · Абонементы** |
| Q4 | Видимость: специалист → только себя; admin/owner → только клинический дашборд; cross-view нет |
| Q5 | «Мой первичный пациент» = клиент, у которого **первый-в-салоне** оплаченный визит был **в выбранном периоде** и его мастером был **я** |
| Архитектура | Отдельный эндпоинт `/api/analytics/staff-dashboard`, отдельная страница `staff-dashboard.js`. Существующий `/dashboard` не трогаем |

## 3. Архитектура

```
[Specialist login]
       │ JWT { userId, salonId, role:'specialist' }
       ▼
[GET /api/analytics/staff-dashboard?from&to]
       │
       ▼
[Auth middleware]    role==='specialist' (иначе 403)
       │
       ▼
[Route handler]
   1. SELECT u JOIN staff_members → yclients_staff_id, staff_name
      └ если NULL → return { unlinked: true }
   2. Promise.all([
        revenue + count of visits        (WHERE r.staff->0->>'id'=staff_yc),
        revenue_operations by category   (services/goods/abonement),
        COUNT DISTINCT client_id          (unique clients),
        первичные (CTE по client_id, MIN visit, first_staff=staff_yc),
        top-5 услуг (jsonb_array_elements),
        дневной график (GROUP BY visit_date),
      ])
       │
       ▼
[Response] {
  stats: { staffName, periodRecords, periodRevenue,
           revenueByCategory:{services,goods,abonement}, uniqueClients,
           newClients, avgCheck },
  topServices: [...], dailyRevenue: [...], period: {from,to}
}
       │
       ▼
[frontend/js/pages/staff-dashboard.js]
   nav «Дашборд» при role=specialist → этот файл.
   Если unlinked — плашка «обратитесь к админу».
```

**Ключевые свойства:**
- `/api/analytics/dashboard` остаётся неизменным (владелец/админ туда ходят, как и сейчас).
- `SPECIALIST_ALLOWED_PREFIXES` пополняется `'/api/analytics/staff-dashboard'`.
- Все агрегации скоупятся по `salon_id` + `(r.raw_payload->'staff'->0->>'id')::int = yclients_staff_id`.
- Период — тот же селектор что у клинического (`from/to` или `period=N`).

## 4. Модель данных

Одна миграция, идемпотентно в `backend/migrations.js`:

```sql
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS staff_member_id INTEGER
    REFERENCES staff_members(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_users_staff_member ON users (staff_member_id)
  WHERE staff_member_id IS NOT NULL;
```

- `staff_member_id` — ссылка на нашу таблицу `staff_members`, не на YClients-id напрямую (потому что YClients-id живёт в JOIN-таблице с `salon_id`).
- `ON DELETE SET NULL` — удалили мастера из справочника, логин остался, привязка обнулилась.
- Опциональное поле: owner/admin без привязки — нормально, у них своя ветка nav.

**Уникальность привязки** на уровне БД не накладываем (UNIQUE), потому что юзер может быть `is_active=false`. Уникальность проверяет UI: при выборе уже-занятого `staff_member_id` показываем подсказку «уже привязан к X».

## 5. API

### 5.1 Новый эндпоинт

**`GET /api/analytics/staff-dashboard?from=YYYY-MM-DD&to=YYYY-MM-DD`**
- Auth: JWT, role=`specialist` (иначе 403). Owner/admin сюда не пускаем — у них главный.
- Если `users.staff_member_id IS NULL` → `200 { unlinked: true }`.
- Иначе:
  ```json
  {
    "stats": {
      "staffName": "Иванова А.А.",
      "periodRecords": 47,
      "periodRevenue": 123456,
      "revenueByCategory": { "services": 90000, "goods": 15000, "abonement": 18456 },
      "uniqueClients": 31,
      "newClients": 4,
      "avgCheck": 2627
    },
    "topServices": [ { "service_name": "Чистка лица", "cnt": 12, "total_amount": 36000 }, ... ],
    "dailyRevenue": [ { "d": "2026-06-01", "records": 5, "revenue": 12500 }, ... ],
    "period": { "from": "2026-05-25", "to": "2026-06-01" }
  }
  ```

### 5.2 SQL (ключевые куски)

```sql
-- 1. Выручка + кол-во визитов
SELECT COUNT(*) AS rc, COALESCE(SUM(amount),0) AS rv
FROM records r
WHERE r.salon_id=$1 AND r.status IN ('completed','arrived')
  AND COALESCE((r.visit_datetime AT TIME ZONE 'Europe/Moscow')::date, r.visit_date::date)
      BETWEEN $2 AND $3
  AND (r.raw_payload->'staff'->0->>'id')::int = $4

-- 2. Разбивка выручки по категориям из revenue_operations
SELECT category, COALESCE(SUM(amount),0) AS total
FROM revenue_operations
WHERE salon_id=$1
  AND operation_date BETWEEN $2 AND $3
  AND (raw_payload->'staff'->0->>'id')::int = $4
  AND category IN ('services','goods','abonement')
GROUP BY category

-- 3. Уникальные клиенты
SELECT COUNT(DISTINCT client_id) AS n FROM records r
WHERE r.salon_id=$1 AND r.status IN ('completed','arrived')
  AND COALESCE(...visit_date...) BETWEEN $2 AND $3
  AND (r.raw_payload->'staff'->0->>'id')::int = $4

-- 4. «Мои первичные» — CTE
WITH client_first AS (
  SELECT client_id,
         MIN(COALESCE((visit_datetime AT TIME ZONE 'Europe/Moscow')::date, visit_date::date)) AS d,
         (ARRAY_AGG((raw_payload->'staff'->0->>'id') ORDER BY visit_date))[1]::int AS first_staff
  FROM records
  WHERE salon_id=$1 AND status IN ('completed','arrived')
    AND (raw_payload->>'paid_full')::int = 1
  GROUP BY client_id
)
SELECT COUNT(*) AS n FROM client_first
WHERE d BETWEEN $2 AND $3 AND first_staff = $4

-- 5. Топ-5 услуг
SELECT svc->>'title' AS service_name, COUNT(DISTINCT r.id) AS cnt,
       SUM((svc->>'cost_to_pay')::numeric) AS total_amount
FROM records r, jsonb_array_elements(COALESCE(r.services,'[]'::jsonb)) svc
WHERE r.salon_id=$1 AND r.status IN ('completed','arrived')
  AND COALESCE(...visit_date...) BETWEEN $2 AND $3
  AND (r.raw_payload->'staff'->0->>'id')::int = $4
  AND svc->>'title' IS NOT NULL
GROUP BY 1 ORDER BY total_amount DESC LIMIT 5

-- 6. Дневной график выручки
SELECT COALESCE((r.visit_datetime AT TIME ZONE 'Europe/Moscow')::date, r.visit_date::date)::text AS d,
       COUNT(*) AS records, COALESCE(SUM(amount),0) AS revenue
FROM records r
WHERE r.salon_id=$1 AND r.status IN ('completed','arrived')
  AND COALESCE(...visit_date...) BETWEEN $2 AND $3
  AND (r.raw_payload->'staff'->0->>'id')::int = $4
GROUP BY 1 ORDER BY 1
```

### 5.3 Изменения в users-API

В `routes/users.js` (или эквивалентном) в формах POST/PUT/GET добавить поле `staff_member_id`. Доступ — только `requireRole('owner','admin')`. На GET-листе пользователей возвращать `staff_member_id` + JOIN с `staff_members.name` для отображения «привязан к X».

### 5.4 Список staff-кандидатов для UI

Эндпоинт **`GET /api/staff-members?salon=current`** (если уже нет такого) — возвращает массив `{id, name, yclients_staff_id, is_active, linked_to_user_id}`. Поле `linked_to_user_id` — JOIN c users по `users.staff_member_id`. Нужно для UI: пометить уже-привязанные.

### 5.5 Конфиг

```js
// backend/config.js
SPECIALIST_ALLOWED_PREFIXES: [
  '/api/home-care', '/api/auth', '/api/template-settings',
  '/api/patient-portfolio',
  '/api/analytics/staff-dashboard',   // ← новое
],
```

## 6. Фронтенд

### 6.1 Новая страница `frontend/js/pages/staff-dashboard.js`

Структура (по решениям Q2+Q3):

```
┌── Период: [Сегодня] [Неделя] [Месяц] [Произвольный] ──┐

┌── Моя выручка за период ────────┐  ┌── Визиты ──┐  ┌── Клиенты ──┐
│ ₽ 123 456                        │  │  47         │  │  31           │
│ Услуги:     ₽ 90 000             │  └─────────────┘  └───────────────┘
│ Косметика:  ₽ 15 000
│ Абонементы: ₽ 18 456
└──────────────────────────────────┘  ┌── Средний чек ┐  ┌── Первичных ┐
                                      │  ₽ 2 627      │  │  4           │
                                      └───────────────┘  └──────────────┘

┌── Дневной график выручки ─────────────────────────┐
│  [bar chart]                                       │
└────────────────────────────────────────────────────┘

┌── Топ-5 услуг ────────────────────────────────────┐
│ Услуга            Кол-во    Выручка                │
│ Чистка лица       12        ₽ 36 000               │
└────────────────────────────────────────────────────┘
```

Если ответ `{unlinked: true}` — на странице плашка:
> «Ваш профиль не привязан к мастеру YClients. Обратитесь к администратору клиники, чтобы посмотреть свою статистику.»

CSS — переиспользуем существующие классы дашборда (`.sc`, `.sg`, `.sl`, `.sv`, `.sd`). Никакой новой темы.

### 6.2 Изменения в nav

В `frontend/js/core/nav.js` пункт «Дашборд» становится role-aware:
- `role in ('owner','admin')` → `#dashboard` (existing)
- `role === 'specialist'` → `#staff-dashboard` (new)

Существующая логика «специалист видит только home-care» — расширяем: добавляем «Дашборд» в список доступных для роли specialist (если эта логика реализована во фронте).

### 6.3 UI привязки в карточке пользователя

В **Пользователи → Создать/Редактировать**:
- Если выбрана роль «Специалист» — показывается селектор «Сотрудник YClients» (грузится из `GET /api/staff-members`).
- Уже-привязанные к другим юзерам опции помечены серым с подписью «привязан к: Иван И.» — выбирать можно, но появляется warning «Перезапишет привязку».
- Сохранение — обычный PUT/POST пользователя с полем `staff_member_id`.

## 7. Обработка ошибок

| Кейс | Что возвращает API / показывает UI |
|---|---|
| owner/admin на /staff-dashboard | 403 — у них клинический |
| specialist без привязки | 200 `{unlinked: true}` → плашка |
| specialist на /analytics/dashboard | 403 — уже сейчас (не в allow-list) |
| `staff_member_id` указывает на удалённого мастера | `ON DELETE SET NULL` → unlinked |
| Период без визитов | Все цифры 0, графики пустые, «нет данных» в топ-5 |
| Визит с 2+ staff в `r.staff` | Считаем по `staff->0` (primary, как в моб. API). Документируем. |
| `paid_full=0` визит | В «визиты/выручку» попадает, в «первичные» — нет (там фильтр paid_full=1, как и на главном) |
| Ошибка SQL (синтаксис/таймаут) | 500 — общий handler |

## 8. Тестирование

### 8.1 Unit (Jest, чистые функции)

Если выделим pure-helpers в `services/staff-dashboard.js`:
- `aggregateRevenueByCategory(rows)` — {services,goods,abonement} с дефолтами.
- `computeAvgCheck(count, sum)` — деление с защитой от 0.
- `mergeDaily(rows, fromDate, toDate)` — заполнение пустых дней нулями (опционально).

### 8.2 Smoke (на dev-сервере)

`backend/scripts/staff-dashboard-smoke.js`:
1. Подмонтировать существующего specialist-юзера (или создать тестового).
2. Создать ему `users.staff_member_id` на реальный staff_member.
3. Через сессию + JWT дернуть `/api/analytics/staff-dashboard?from=...&to=...`.
4. Проверить shape: `stats.periodRecords` int, `revenueByCategory.services` ≥ 0, и т.д.
5. Дополнительно — кейс `unlinked: true`.

### 8.3 Manual checklist (после деплоя)

- [ ] Создать в проде/деве пользователя role=specialist без привязки → залогиниться → плашка «обратитесь к админу».
- [ ] Привязать в карточке → плашка исчезает, цифры показываются.
- [ ] Сравнить с DB-выгрузкой: моя выручка по записям сходится.
- [ ] Сменить период → данные обновляются.
- [ ] Owner идёт на `/#staff-dashboard` (если кто-то напрямую URL впишет) → 403 / редирект на главный.

## 9. Безопасность

- Все запросы — JWT-auth + session check + `req.user.salonId`.
- `staff_member_id` на чтение/запись — только role∈(owner,admin) через users-API.
- specialist не может изменить свой `staff_member_id` сам.
- SQL — параметризованные запросы (`$1..$N`).
- В ответе `staffName` — только для отображения «Это вы: …», не служит идентификатором.

## 10. Открытые вопросы / предположения

- Предполагается, что `records.raw_payload->'staff'->0->>'id'` всегда есть для completed/arrived визитов (YClients staff_id). Если для каких-то записей `staff` пустой массив или null — попадание в фильтр будет нулевым, специалист просто их не увидит — это корректно.
- **Разбивка выручки по категориям через `revenue_operations`** требует, чтобы в `revenue_operations.raw_payload` присутствовал `staff` (он приходит из YClients `finances_operation` webhook). Услуги обычно его несут; товары и абонементы — не всегда (могут быть проданы кассиром/админом без привязки к мастеру). Если в проде увидим много нулей по этим строкам — это **по дизайну**, а не баг. Альтернатива (фолбэк): `services` можно дополнительно агрегировать из `records.amount`, но это смешает «выручка YClients» и «выручка наша» — не делаем в v1.
- Если визит делят несколько мастеров (редко) — мы считаем только по primary (`staff->0`). Для v1 ОК. Если станет проблемой — отдельная задача «распределение выручки между мастерами».
- Никаких бонусов в v1 не отображаем (по решению пользователя).
- `unlinked: true` ответ не считается ошибкой — это валидное состояние. Фронт не показывает «ошибку», просто плашку с инструкцией.
- Локальное хранение период-селектора (last selected period) — наследуем поведение основного дашборда, никаких отдельных настроек.
