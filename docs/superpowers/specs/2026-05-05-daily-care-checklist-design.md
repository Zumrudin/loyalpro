# Дизайн: Ежедневный чек-лист ухода (Daily Care Checklist)

**Дата:** 2026-05-05
**Статус:** Утверждён для реализации
**Затрагиваемые репозитории:** `/root/loyalpro` (бэкенд + админка), `/root/mobile` (моб. приложение)
**Зависит от:** `2026-04-16-prescriptions-design.md` (фича «Назначения»)

## 1. Обзор

### 1.1 Проблема

Сейчас врач выписывает пациенту назначения по домашнему уходу (`home_care_prescriptions` + `home_care_items`), и пациент видит их в моб. приложении как **статический справочник**. Нет привязки ко времени, нет сигнала «что наносить именно сегодня», нет обратной связи — врач не знает, выполняет пациент назначения или нет.

### 1.2 Решение

Добавить три слоя поверх существующих таблиц назначений:

1. **Расписание** — каждый item получает дни недели (Пн–Вс), а назначение в целом получает период курса (`start_date`/`end_date`).
2. **Лог выполнения** — пациент может отмечать каждый пункт как сделанный (галочка). Отметки хранятся как `(item_id, client_id, completion_date)`.
3. **UI:**
   - в моб. приложении — баннер «Уход сегодня» на главной + отдельный экран `TodayChecklist` с галочками + heatmap-календарь выполнения на странице назначения;
   - в админке врача — поля для дней недели и периода в форме назначения, колонка `% выполнения` в списке, модалка с heatmap-календарём и детализацией дня.

### 1.3 Ключевые продуктовые решения

| Решение | Значение |
|---|---|
| **Категории чек-листа** | только `morning` / `evening` / `additional` (домашний уход). `sheet_*` и `vitamins` остаются справочными — в чек-лист не попадают |
| **Расписание** | `start_date` обязательно, `end_date` опционально (NULL = бессрочно) — на prescription. `days_of_week` (массив 0..6, NULL/пусто = ежедневно) — на item. `0=Пн, …, 6=Вс` (ISO-неделя) |
| **Логика отметок** | можно ставить и снимать отметку **только в течение текущего дня**. После 00:00 запись становится фактом — изменить нельзя ни пациенту, ни врачу |
| **Утро / Вечер / Доп.** | три блока, видны на одном экране всегда. Текущая по времени секция чуть подсвечена |
| **Точка входа в моб.** | (1) баннер на HomeScreen «Уход сегодня · 1/5», только если есть что чекать сегодня; (2) экран `TodayChecklistScreen` под кнопкой кабинета «Уход сегодня» (доступна всегда) |
| **Сторона врача** | (1) в списке назначений — колонка `% выполнения` за текущий курс; (2) кнопка «Подробно» справа в строке → модалка с heatmap-календарём и детализацией дня |
| **Несколько активных prescription** | чек-лист агрегирует со всех активных prescription. Дубли по `product_name` НЕ схлопываем |
| **Push-уведомления** | в этой итерации не делаем. Отдельной фичей после релиза |
| **Legacy данные** | старые prescription без `start_date` получают `start_date = DATE(created_at)`, `end_date = NULL` (бессрочно) |

### 1.4 Что НЕ делаем (явные YAGNI)

- push-уведомления и расписание уведомлений;
- произвольные расписания («через день», «1 раз в 3 дня»);
- комментарии пациента к выполнению («нанесла, было раздражение»);
- стрик / напоминания о пропусках;
- редактирование лога после полуночи (ни врачом, ни пациентом);
- adherence как цвет на главном экране моб. (только цифра в heatmap);
- чек-лист по `vitamins` / `sheet_*`;
- onboarding-туториал;
- оффлайн-очередь отметок;
- экспорт heatmap в PDF/CSV;
- статистика по специалисту / салону.

---

## 2. Модель данных

### 2.1 `home_care_prescriptions` — расширение

```sql
ALTER TABLE home_care_prescriptions
  ADD COLUMN IF NOT EXISTS start_date DATE,
  ADD COLUMN IF NOT EXISTS end_date   DATE;

-- backfill для legacy
UPDATE home_care_prescriptions
   SET start_date = DATE(created_at)
 WHERE start_date IS NULL;

ALTER TABLE home_care_prescriptions
  ALTER COLUMN start_date SET NOT NULL;
```

`end_date IS NULL` означает «бессрочно». Проверка попадания в курс:

```sql
CURRENT_DATE BETWEEN start_date AND COALESCE(end_date, '9999-12-31')
```

### 2.2 `home_care_items` — расширение

```sql
ALTER TABLE home_care_items
  ADD COLUMN IF NOT EXISTS days_of_week SMALLINT[];
```

`0=Пн, 1=Вт, …, 6=Вс`. NULL или пустой массив = ежедневно. Проверка попадания на сегодня:

```sql
i.days_of_week IS NULL
  OR cardinality(i.days_of_week) = 0
  OR (EXTRACT(ISODOW FROM CURRENT_DATE)::int - 1) = ANY(i.days_of_week)
```

### 2.3 `home_care_completions` — новая таблица

```sql
CREATE TABLE IF NOT EXISTS home_care_completions (
  id              SERIAL PRIMARY KEY,
  item_id         INTEGER NOT NULL REFERENCES home_care_items(id) ON DELETE CASCADE,
  client_id       INTEGER NOT NULL REFERENCES clients(id)         ON DELETE CASCADE,
  completion_date DATE      NOT NULL,
  completed_at    TIMESTAMP NOT NULL DEFAULT NOW(),
  UNIQUE (item_id, client_id, completion_date)
);

CREATE INDEX IF NOT EXISTS idx_hcc_client_date
  ON home_care_completions (client_id, completion_date DESC);

CREATE INDEX IF NOT EXISTS idx_hcc_item_date
  ON home_care_completions (item_id, completion_date);
```

**Принципиальные решения по схеме:**

- `completion_date` — отдельная колонка, не вычисляется из `completed_at`. Это позволяет UNIQUE-индексу работать по «дню в часовом поясе клиента» без танцев с timezone (бэк считает день один раз и сохраняет).
- Снятие отметки = физический `DELETE`. Логика «после полуночи нельзя править» — на API-уровне (запрет операций с `completion_date != CURRENT_DATE`). Отдельный аудит-лог не ведём.
- `client_id` денормализован (можно вывести через `item_id → prescription → client_id`). Сделано намеренно для скорости запросов «лог пациента за период». Целостность поддерживается на бэке (при INSERT проверка `item.prescription.client_id == токен.clientId`).
- При удалении item (CASCADE) — отметки тоже удалятся. Это ОК: heatmap считается на лету, перевыпуск курса = новая история.

### 2.4 SQL «что в чек-листе сегодня»

```sql
SELECT
  i.id, i.time_of_day, i.product_name, i.instructions, i.sort_order,
  p.id AS prescription_id,
  EXISTS (
    SELECT 1 FROM home_care_completions c
     WHERE c.item_id = i.id
       AND c.client_id = $1
       AND c.completion_date = CURRENT_DATE
  ) AS completed
FROM home_care_items i
JOIN home_care_prescriptions p ON p.id = i.prescription_id
WHERE p.client_id = $1
  AND i.time_of_day IN ('morning','evening','additional')
  AND CURRENT_DATE BETWEEN p.start_date AND COALESCE(p.end_date, '9999-12-31')
  AND (
    i.days_of_week IS NULL
    OR cardinality(i.days_of_week) = 0
    OR (EXTRACT(ISODOW FROM CURRENT_DATE)::int - 1) = ANY(i.days_of_week)
  )
ORDER BY
  CASE i.time_of_day
    WHEN 'morning'    THEN 1
    WHEN 'evening'    THEN 2
    WHEN 'additional' THEN 3
  END,
  i.sort_order;
```

### 2.5 SQL adherence

**Числитель** — `COUNT(*)` из `home_care_completions` для prescription за период от `start_date` до `LEAST(end_date, CURRENT_DATE)`.

**Знаменатель** — для каждого item посчитать число дней в периоде, попадающих под его `days_of_week`. Один запрос:

```sql
WITH days AS (
  SELECT generate_series(
    p.start_date,
    LEAST(COALESCE(p.end_date, CURRENT_DATE), CURRENT_DATE),
    '1 day'::interval
  )::date AS d
  FROM home_care_prescriptions p WHERE p.id = $1
),
expected AS (
  SELECT COUNT(*) AS n
    FROM days d
    JOIN home_care_items i ON i.prescription_id = $1
                          AND i.time_of_day IN ('morning','evening','additional')
   WHERE i.days_of_week IS NULL
      OR cardinality(i.days_of_week) = 0
      OR (EXTRACT(ISODOW FROM d.d)::int - 1) = ANY(i.days_of_week)
),
done AS (
  SELECT COUNT(*) AS n
    FROM home_care_completions c
    JOIN home_care_items i ON i.id = c.item_id
   WHERE i.prescription_id = $1
     AND i.time_of_day IN ('morning','evening','additional')
     AND c.completion_date BETWEEN
       (SELECT start_date FROM home_care_prescriptions WHERE id = $1)
       AND LEAST(
         COALESCE((SELECT end_date FROM home_care_prescriptions WHERE id = $1), CURRENT_DATE),
         CURRENT_DATE
       )
)
SELECT
  expected.n AS expected,
  done.n     AS completed,
  CASE
    WHEN expected.n = 0 THEN NULL
    ELSE ROUND(100.0 * done.n / expected.n)::int
  END AS adherence_pct
FROM expected, done;
```

`adherence_pct = NULL` означает «нечего считать» (курс ещё не начался / `expected = 0`). Фронт отображает как «—».

### 2.6 SQL heatmap (по дням)

```sql
WITH days AS (
  SELECT generate_series($1::date, $2::date, '1 day'::interval)::date AS d
)
SELECT
  d.d AS date,
  (
    SELECT COUNT(*) FROM home_care_items i
     WHERE i.prescription_id = $3
       AND i.time_of_day IN ('morning','evening','additional')
       AND (i.days_of_week IS NULL
            OR cardinality(i.days_of_week) = 0
            OR (EXTRACT(ISODOW FROM d.d)::int - 1) = ANY(i.days_of_week))
  ) AS expected,
  (
    SELECT COUNT(*) FROM home_care_completions c
     JOIN home_care_items i ON i.id = c.item_id
     WHERE i.prescription_id = $3 AND c.completion_date = d.d
       AND i.time_of_day IN ('morning','evening','additional')
  ) AS completed
FROM days d
ORDER BY d.d;
```

`$1` = `start_date`, `$2` = `LEAST(end_date, CURRENT_DATE)`, `$3` = `prescription_id`.

---

## 3. Бэкенд (LoyalPro)

### 3.1 Изменения в `routes/home-care.js`

**`POST /api/home-care`** и **`PUT /api/home-care/:id`** — расширить парсинг тела:

```js
const {
  client_id, face_procedures, body_procedures, hair_procedures,
  vitamins, notes, items = [], record_id,
  start_date,             // обязательно
  end_date,               // опционально (null)
} = req.body;
```

`start_date` сохраняется в `home_care_prescriptions.start_date`, `end_date` в `home_care_prescriptions.end_date`. Каждый `item` теперь содержит `days_of_week: number[] | null`. Записывается в `home_care_items.days_of_week`.

Валидация: если `days_of_week` не null/массив — сбросить в `null`. Если массив — отфильтровать значения вне `[0..6]` и дубли. Никакой строгой 400-валидации, бэк прощает мусор и нормализует.

**`GET /api/home-care`** (список prescriptions в админке) — добавить `adherence_pct` (логика 2.5) к каждой строке.

**`GET /api/home-care/:id`** — добавить `start_date`, `end_date` к ответу, `days_of_week` к каждому item.

### 3.2 Новый эндпоинт админки: heatmap

```
GET /api/home-care/:id/adherence-history[?date=YYYY-MM-DD]
```

Без `date`:

```jsonc
{
  "prescription": {
    "id": 123,
    "start_date": "2026-04-15",
    "end_date":   "2026-05-15",
    "items_count": 4
  },
  "days": [
    { "date": "2026-04-15", "expected": 4, "completed": 4 },
    { "date": "2026-04-16", "expected": 3, "completed": 2 }
  ]
}
```

С `?date=2026-04-17` — добавляется поле `items_for_day`:

```jsonc
{
  "prescription": { /* как выше */ },
  "days": [ /* как выше */ ],
  "items_for_day": [
    { "id": 12, "time_of_day": "morning", "product_name": "Крем 6", "instructions": "тонким слоем", "completed": false, "completed_at": null },
    { "id": 13, "time_of_day": "morning", "product_name": "Тоник Aqua", "instructions": "ватный диск", "completed": true,  "completed_at": "2026-04-17T08:23:14Z" }
  ]
}
```

Период диапазона: `start_date` → `LEAST(end_date, CURRENT_DATE)`. Дни с `expected = 0` всё равно возвращаются (фронт рисует нейтральным цветом — иначе на heatmap появляются дыры).

### 3.3 Новые мобильные эндпоинты в `routes/mobile-client.js`

#### A) Чек-лист на сегодня

```
GET /api/mobile/client/today-checklist
```

Ответ:

```jsonc
{
  "success": true,
  "date": "2026-05-05",
  "sections": {
    "morning":    [
      { "id": 12, "productName": "Крем 6", "instructions": "тонким слоем",
        "completed": false, "prescriptionId": 8 }
    ],
    "evening":    [ /* ... */ ],
    "additional": [ /* ... */ ]
  },
  "summary": { "total": 5, "completed": 1 }
}
```

Реализация — SQL из 2.4, группировка по `time_of_day` на стороне бэка. `summary` нужен баннеру на главной (один fetch для счётчика).

#### B) Отметить выполнение

```
POST /api/mobile/client/today-checklist/items/:itemId/complete
```

Тело пустое. Логика:

1. SELECT `i.prescription_id`, `p.client_id`, `p.start_date`, `p.end_date`, `i.time_of_day`, `i.days_of_week` для `itemId`. 404 если не найден.
2. Проверка `p.client_id == req.client.clientId`. Иначе 403.
3. Проверка `i.time_of_day IN ('morning','evening','additional')`. Иначе 400 «нельзя отметить пункт не из чек-листа».
4. Проверка `CURRENT_DATE BETWEEN p.start_date AND COALESCE(p.end_date, '9999-12-31')`. Иначе 400 «вне периода курса».
5. Проверка попадания на день недели (как в 2.4). Иначе 400 «не на сегодня».
6. `INSERT INTO home_care_completions (item_id, client_id, completion_date) VALUES ($1, $2, CURRENT_DATE) ON CONFLICT DO NOTHING`.
7. Ответ: `{ success: true, completed: true }`.

#### C) Снять отметку

```
DELETE /api/mobile/client/today-checklist/items/:itemId/complete
```

```sql
DELETE FROM home_care_completions
 WHERE item_id = $1 AND client_id = $2 AND completion_date = CURRENT_DATE
```

`completion_date = CURRENT_DATE` в WHERE гарантирует «нельзя править прошлое». Ответ всегда `{ success: true, completed: false }`, даже если ничего не удалили (идемпотентность).

#### D) Heatmap пациента

```
GET /api/mobile/client/prescriptions/:id/adherence
```

Симметричный 3.2, без `items_for_day`. Фильтр по `client_id = req.client.clientId`. 404 если prescription не пациента.

```jsonc
{
  "success": true,
  "prescription": {
    "id": 123,
    "startDate": "2026-04-15",
    "endDate":   "2026-05-15",
    "adherencePct": 72,
    "completed": 84,
    "expected": 117
  },
  "days": [
    { "date": "2026-04-15", "expected": 4, "completed": 4 }
  ]
}
```

### 3.4 Изменения в `GET /api/mobile/client/prescriptions/:id`

К существующему ответу добавить:

- top-level: `startDate`, `endDate`;
- к каждому item: `daysOfWeek: number[] | null`, `completedToday: boolean` (только для homecare-категорий — для остальных всегда `false`).

Это позволяет показать «дни применения» точками на карточке item и быстрые галочки прямо в детали назначения, без перехода на чек-лист.

### 3.5 Контракты и авторизация

- **Стиль JSON:** camelCase в моб. API (`startDate`, `daysOfWeek`, `productName`, `completedToday`) — соответствует существующему `mobile-client.js`. snake_case в админ-API (`start_date`, `days_of_week`) — соответствует существующему `home-care.js`. Преобразование — в SELECT-алиасах.
- **Auth:** `mobileAuth` для всего `/api/mobile/client/*`. Проверка `client_id = req.client.clientId` в каждом запросе. Стандартный `authMiddleware` для `/api/home-care/*`, фильтр по `salon_id = req.user.salonId`.
- **Перезапуск бэка** после миграции — стандартный `pm2 restart loyalpro`.

---

## 4. Мобильное приложение

### 4.1 `TodayChecklistScreen` — новый экран

**Путь:** `src/screens/TodayChecklistScreen.js`. Дизайн-система: «Liquid Glass & Silk» (pearl `#F5F3F0`, champagne `#D4AF37`, stone `#4A4540`, BlurView + LinearGradient).

**Структура экрана:**

- **Шапка:** заголовок «Уход сегодня», под ним текущая дата прописью (`5 мая, понедельник`), большой счётчик `1 / 5`, тонкий прогресс-бар (заливка champagne).
- **Тело:** до трёх секций — _Утро_ / _Вечер_ / _Дополнительно_. Секция показывается только если в ней есть item на сегодня. Текущая по времени секция (06:00–11:59 → утро, 18:00–04:59 → вечер, остальное → нет подсветки) имеет:
  - чуть более яркий бордер champagne;
  - бейдж «Сейчас» рядом с заголовком.
- **Item-строка:** круглый чекбокс 28×28 слева (бордер `champGlow`, при completed → заливка champagne + белая галочка), справа — название продукта (15px, при completed — strike-through `stoneFaint`), под ним инструкция (12px `stoneMid`). Тап по всей строке = тап по чекбоксу.
- **Низ экрана:** bottom-padding `tabBar + safeAreaInsets.bottom`. Когда `summary.completed === summary.total` и `total > 0` — под прогресс-баром появляется надпись курсивом champagne: «Сегодня всё выполнено · так держать».
- **Пустое состояние** (`total === 0`): иконка и текст «На сегодня нет уходовых процедур». Не «нет назначений вообще» — формулировка важна, чтобы пациент с прошедшим курсом понимал, что делать ничего не нужно именно сегодня.

**UX отметки:**

1. Тап по чекбоксу → optimistic update в zustand (item.completed переворачивается, summary.completed ±1) → лёгкий haptic (`Haptics.selectionAsync()`) → POST/DELETE на бэк.
2. Анимация чекбокса: `withSpring(scale, { damping: 12, stiffness: 220 })` (микро-bounce), `withTiming` на цвет.
3. На ошибке API — откат optimistic update в catch, `Alert.alert('Не удалось сохранить', 'Попробуйте ещё раз')`.

**Pull-to-refresh** перезагружает весь чек-лист. На фокусе экрана (`useFocusEffect`) — также перезагрузка (на случай если пациент открыл приложение спустя несколько часов и не закрывал его).

### 4.2 Баннер «Уход сегодня» на `HomeScreen`

Появляется выше всех существующих секций (но ниже шапки приветствия) **только если** `summary.total > 0`. Иначе — главная как сейчас, без пустых блоков.

```
┌──────────────────────────────────────────────┐
│ 🌿  Уход сегодня              1 / 5    →    │
│     ▰▰▰▱▱▱▱▱▱▱  20%                         │
│     Утро 1/3 · Вечер 0/2                    │
└──────────────────────────────────────────────┘
```

- Тап → `navigation.navigate('TodayChecklist')`.
- При `summary.completed === 0`: фон чуть мягче (`champGlow`).
- При `summary.completed === summary.total`: фон зеленоватый, текст «Сегодня всё выполнено», иконка чек-марка вместо листочка.
- Под счётчиком — строка распределения по секциям («Утро 1/3 · Вечер 0/2 · Доп 0/0»). Секции с 0 пунктов скрываются из этой строки.

Данные из `useClientStore(s => s.todayChecklist)`. На монтировании `HomeScreen` и на `useFocusEffect` — `fetchTodayChecklist()`.

### 4.3 Кнопка «Уход сегодня» в кабинете

В существующий массив `cabinetItems` в `HomeScreen.js` после кнопки «Назначения»:

```js
{ icon: 'checkmark-done-outline', label: 'Уход сегодня', nav: 'TodayChecklist', delay: 740 }
```

Это вторая, постоянно доступная точка входа — независимо от того, есть ли активные назначения.

### 4.4 `PrescriptionDetailScreen` — расширения

Применяются только если у prescription есть items с `time_of_day in (morning|evening|additional)`. Иначе экран как сейчас.

1. **Под шапкой** — текстовый блок с курсом: «Курс: 5 мая → 4 июня» или «Курс: с 5 мая · бессрочно» (если `endDate` null). Если курс ещё не начался → бейдж «Старт через 3 дня». Если закончился → серый «Курс завершён».
2. **В item-строках** секции «Домашний уход» — справа от названия маленькая полоска из 7 точек (Пн–Вс): активные дни — champagne, неактивные — `stoneFaint`. Если `daysOfWeek` null/пуст — не рисуем (= ежедневно, очевидно из контекста).
3. **Над секцией «Домашний уход»** — компактный adherence-блок: цифра `72%` крупно слева, справа — горизонтальная heatmap-полоса (квадратики 8×8, цвета по логике 5.3 ниже). Окно полосы: до 30 дней, заканчивающихся на `MIN(endDate, today)` и не уходящих раньше `startDate`. Если в курсе пока меньше 30 дней — рисуем столько, сколько есть, выровнено по правому краю (пустое место слева). Тап по блоку → `navigation.navigate('AdherenceCalendar', { prescriptionId })`.

Если курс ещё не начался (`adherencePct === null`) — adherence-блок не показывается.

### 4.5 `AdherenceCalendarScreen` — новый экран

**Путь:** `src/screens/AdherenceCalendarScreen.js`. Принимает `prescriptionId` через `route.params`.

Классический месячный календарь (грид 7 столбцов, начало недели — Пн). Каждая ячейка дня окрашена по `(completed/expected)`. Стрелки листания месяцев — ограничены диапазоном курса (за `start_date` назад и за `end_date` вперёд листать нельзя).

Внизу — общий процент за весь курс крупно + легенда цветов. Тап по дню НИЧЕГО не делает (детализация дня — только в админке). Цель экрана — мотивация пациента увидеть «свою серию».

### 4.6 Расширения `clientStore.js`

Новые поля:

```js
todayChecklist: null,         // { date, sections, summary }
todayChecklistLoading: false,

adherenceData: null,          // { prescription, days[] }
adherenceLoading: false,
```

Новые экшны:

- `fetchTodayChecklist()` — стандартный fetch + set.
- `toggleItemCompletion(itemId, currentlyCompleted)`:
  1. Optimistic flip в `state.todayChecklist` (найти item в одной из секций, перевернуть `completed`, скорректировать `summary.completed` ± 1).
  2. Вызов API: `markItemCompleted(id)` если был `false`, `unmarkItemCompleted(id)` если был `true`.
  3. На ошибке — откат изменения, `set({ error })`.
- `fetchAdherence(prescriptionId)` — стандартный fetch + set.

`toggleItemCompletion` живёт именно в store (а не в компоненте), чтобы баннер на `HomeScreen` мгновенно обновлялся при отметке на `TodayChecklistScreen` — оба подписаны на одно состояние.

### 4.7 `client-data.js` API

В существующий `clientDataAPI`:

```js
getTodayChecklist:        ()    => apiClient.get('/mobile/client/today-checklist'),
markItemCompleted:        (id)  => apiClient.post(`/mobile/client/today-checklist/items/${id}/complete`),
unmarkItemCompleted:      (id)  => apiClient.delete(`/mobile/client/today-checklist/items/${id}/complete`),
getPrescriptionAdherence: (id)  => apiClient.get(`/mobile/client/prescriptions/${id}/adherence`),
```

### 4.8 Навигация

В соответствующий per-tab stack в `App.js` (HomeStack — туда же, где `Prescriptions` и `BookingDetail`) добавить:

```jsx
<HomeStack.Screen name="TodayChecklist"    component={TodayChecklistScreen}    options={{ headerShown: false }} />
<HomeStack.Screen name="AdherenceCalendar" component={AdherenceCalendarScreen} options={{ headerShown: false }} />
```

Регистрация именно в HomeStack обязательна — иначе нижняя tab-bar плашка с блюром исчезнет на детальных экранах (см. CLAUDE.md о per-tab stacks).

---

## 5. Админка LoyalPro (frontend)

Все изменения — в существующем `/root/loyalpro/frontend/js/pages/home-care.js` (vanilla JS, ~605 строк).

### 5.1 Форма создания/редактирования назначения

**Блок «Период курса»** добавляется выше существующих секций (Утро / Вечер / …), сразу под полями выбора клиента и заметок:

```html
<div class="hc-period">
  <h3>Период курса</h3>
  <label>Начало:    <input type="date" id="hcStartDate" required></label>
  <label>Окончание: <input type="date" id="hcEndDate"></label>
  <label><input type="checkbox" id="hcOpenEnded"> Бессрочно</label>
</div>
```

Поведение:
- При нажатии «Бессрочно» — поле «Окончание» дизейблится и чистится. На сохранении посылается `end_date: null`.
- Валидация на клиенте: `end_date >= start_date`. Бэк делает финальную проверку.
- Дефолт `start_date = today` для нового назначения.

**Дни недели на каждом item:** существующая строка `hcAddItem` сейчас содержит два input (`product_name`, `instructions`) и кнопку удаления. Расширяется ниже строки на дополнительный ряд кнопок-таблеток:

```html
<div class="hc-days">
  <button class="hc-day active" data-day="0">Пн</button>
  <button class="hc-day active" data-day="1">Вт</button>
  …
  <button class="hc-day active" data-day="6">Вс</button>
  <button class="hc-day-all">Каждый день</button>
</div>
```

- Каждая кнопка-день — toggle (active по классу `.active`). Active — фон champagne, inactive — серый бордер.
- «Каждый день» — включает все 7 (или, если все включены, никаких изменений; visual hint: подсветка кнопки во время «всё активно»).
- По умолчанию у нового item все 7 активны.
- Ряд дней показывается только для `time_of_day in (morning|evening|additional)`. Для `sheet_*` и `vitamins` — не рендерится.

При сохранении: если все 7 active или ни одного — `days_of_week: null` (= ежедневно). Иначе массив `[0..6]`.

### 5.2 Список назначений: колонка adherence

В рендер списка prescriptions (там, где сейчас выводятся карточки/строки с датой и врачом) добавляется колонка:

```
┌──────────────────────────────────────────────────────────────────┐
│ 05.05.2026 · Иванова О.А.    Уход на 30 дн.   72%   [Подробно]  │
└──────────────────────────────────────────────────────────────────┘
```

- `72%` — `adherence_pct` из ответа API (3.1).
- Цвет цифры: ≥ 80% — зелёный, 50–79% — янтарный, < 50% — красный, `null` — серое «—».
- Кнопка «Подробно» открывает модалку heatmap (5.3). Если `adherence_pct === null` — кнопка disabled.
- Дополнительная подстрока: «Курс: 5 мая → 4 июня» или «Курс: с 5 мая · бессрочно».

### 5.3 Модалка heatmap

Открывается из «Подробно» в строке prescription. Структура:

```
┌─ Назначение № 123 — Иванова О.А. ──────────────── × ┐
│ Курс: 5 мая → 4 июня · 4 пункта                    │
│ Выполнено: 72%  (84 из 117)                        │
│                                                    │
│   Пн Вт Ср Чт Пт Сб Вс                             │
│   ▢  ▢  ▢  ▢  ◼  ◼  ◼     ← неделя 1              │
│   ◼  ▦  ◼  ◼  ◼  ▦  ▢                              │
│   …                                                │
│                                                    │
│  ◻ нет назначений · ▢ 0% · ▦ частично · ◼ 100%    │
│                                                    │
│  ┌─ День: 17 апреля ─────────────────────────┐    │
│  │ Утро · Крем 6              ✗ Не выполнено │    │
│  │ Утро · Тоник Aqua          ✓ 08:23        │    │
│  │ Вечер · Маска ночная       ✗ Не выполнено │    │
│  └────────────────────────────────────────────┘    │
└────────────────────────────────────────────────────┘
```

**Календарь:** грид по неделям, начиная с понедельника, содержащего `start_date`. До недели, содержащей `MIN(end_date, today)`. Дни вне курса в этих неделях — пустые ячейки.

**Цвета ячеек** по `(completed/expected)`:
- `expected = 0` → нейтрально-серый (никаких процедур по дню недели);
- `completed = 0` → светло-красный;
- `< 50%` → жёлтый;
- `< 100%` → оранжевый;
- `100%` → зелёный.

**Тап по ячейке** → `GET /api/home-care/:id/adherence-history?date=YYYY-MM-DD` → панель с детализацией дня (`items_for_day` из ответа) появляется под календарём.

**Закрытие:** крестик / клик по затемнённому фону / Esc.

### 5.4 Что НЕ делаем в админке

- Ручное редактирование лога выполнения врачом (нет «✓ за пациента»).
- Фильтр списка prescription по adherence (например «< 50%»).
- Экспорт календаря в PDF/CSV.
- Комментарии пациента к выполнению.
- Средний adherence по специалисту/салону.

---

## 6. План работ (высокоуровнево)

Детальный план с задачами и шагами — в отдельном файле `docs/superpowers/plans/2026-05-05-daily-care-checklist.md`, который будет создан после утверждения этого дизайна. Высокоуровневая последовательность:

1. **Бэкенд: миграции** — `start_date`, `end_date`, `days_of_week`, таблица `home_care_completions` + индексы.
2. **Бэкенд: расширение `home-care.js`** — приём новых полей в POST/PUT, отдача `adherence_pct` в GET-списке, отдача `days_of_week` в GET-detail.
3. **Бэкенд: новый эндпоинт `GET /api/home-care/:id/adherence-history`** — для модалки heatmap в админке.
4. **Бэкенд: 4 новых мобильных эндпоинта** — `today-checklist` (GET/POST/DELETE) + `prescriptions/:id/adherence`.
5. **Бэкенд: расширение `GET /api/mobile/client/prescriptions/:id`** — `startDate`, `endDate`, `daysOfWeek`, `completedToday`.
6. **Моб.: API клиент** — 4 метода в `clientDataAPI`.
7. **Моб.: store** — поля + 3 экшна, optimistic update.
8. **Моб.: `TodayChecklistScreen`** — основной экран с галочками.
9. **Моб.: `AdherenceCalendarScreen`** — календарь для пациента.
10. **Моб.: расширение `PrescriptionDetailScreen`** — даты курса, точки дней недели, adherence-блок.
11. **Моб.: баннер на `HomeScreen`** + кнопка «Уход сегодня» в кабинете.
12. **Моб.: навигация** — регистрация двух новых экранов в HomeStack.
13. **Админка LoyalPro: форма** — блок «Период курса» + ряды дней недели в каждом item.
14. **Админка LoyalPro: список** — колонка `% выполнения` + кнопка «Подробно».
15. **Админка LoyalPro: модалка heatmap** — календарь + детали дня.

## 7. Критерии приёмки

Фича считается готовой, когда:

- [ ] Врач может в форме назначения указать период курса (с/до) и для каждого пункта домашнего ухода — дни недели.
- [ ] Пациент видит баннер «Уход сегодня» на главной, если на сегодня есть пункты для выполнения.
- [ ] Тап по баннеру открывает экран с галочками; галочки ставятся/снимаются и сохраняются на бэке.
- [ ] После 00:00 пункты сегодняшнего дня уже не отметишь — приходит 400 ответ от бэка.
- [ ] В детали назначения у пациента видна полоска adherence + цветной мини-heatmap последних 30 дней.
- [ ] В админке в списке назначений у каждого видна цифра `% выполнения`.
- [ ] Кнопка «Подробно» в строке открывает модалку с цветным календарём; тап на день показывает детализацию.
- [ ] Старые prescription без расписания корректно мигрировали (start_date = created_at, end_date = null) и попадают в чек-лист пациента.
- [ ] Push-уведомления НЕ реализованы (явно вне скоупа).

---

## 8. Открытые вопросы

Нет. Все архитектурные решения зафиксированы в секции 1.3.

