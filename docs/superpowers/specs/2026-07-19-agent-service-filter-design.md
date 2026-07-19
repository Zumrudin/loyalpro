# Дизайн: слой фильтрации услуг ИИ-агента + статья «кто что делает»

**Дата:** 2026-07-19
**Статус:** согласован, ожидает плана реализации

## Проблема

Инструменты ИИ-агента (`list_services`, `get_available_slots`, `get_available_dates`,
`create_booking`) отдают **сырые данные YClients**. В YClients встречается «мусор»,
который агенту нельзя предлагать клиентам:

- технические услуги (служебные позиции CRM);
- услуги, которые салон больше не предоставляет, но не удалил из CRM;
- услуга, **ошибочно привязанная к конкретному мастеру** (мастер её по факту не делает).

Статья базы знаний это не чинит: KB-статья — текст для разговорных ответов ассистента,
а structured-инструменты всё равно вернут сырой YClients. Даже с идеальной статьёй агент
может дёрнуть `list_services`, получить техническую/устаревшую услугу и предложить или
забронировать её.

## Цель

1. **Второй слой подстраховки** — фильтр поверх сырого YClients внутри инструментов агента,
   чтобы скрытое не предлагалось и не бронировалось.
2. **Статья «кто что делает»** в базе знаний для разговорных ответов ассистента.

### Вне области (Non-goals)

- Ручной оверрайд цен — не делаем. Цены остаются из YClients.
- Фильтр НЕ затрагивает мобильное приложение и стафф-фронт — они показывают услуги
  независимо. Область строго — инструменты ИИ-агента.
- Автогенерация статьи «кто что делает» — не делаем. Статья пишется вручную.
- Whitelist на уровне пар услуга×мастер — не делаем (пары только скрываются).

## Решения по опросу

| Вопрос | Решение |
|---|---|
| Роль слоя | Фильтровать инструменты + статья «кто что делает» (не ручной прайс) |
| Модель фильтра | **Гибрид**: по умолчанию чёрный список; тумблер на салон → whitelist-режим |
| Источник статьи | **Ручная** статья в существующем редакторе KB |
| Где применять фильтр | **Общий хелпер + правила в БД**, применяется внутри каждого инструмента (подход A) |
| Админка | **Отдельный экран** «Услуги агента» |
| Прятать в `list_staff` мастера без услуг | Нет (YAGNI) |

Подход A выбран, потому что это тот же паттерн, что уже применён для гейта допуска номеров
(`agent_number_rules` + режим `all|whitelist`), и это единственный вариант, который реально
закрывает **бронирование**, а не только «витрину» `list_services`.

## Архитектура

### 1. Модель данных

Переиспользуем `agent_settings`, добавляем колонку под режим услуг (независимо от режима
допуска номеров, у которого своя колонка `mode`):

```sql
ALTER TABLE agent_settings
  ADD COLUMN IF NOT EXISTS service_mode VARCHAR(20) NOT NULL DEFAULT 'all';
  -- 'all' | 'allowlist'
```

Новая таблица правил (по образцу `agent_number_rules`):

```sql
CREATE TABLE IF NOT EXISTS agent_service_rules (
  id            SERIAL PRIMARY KEY,
  salon_id      INTEGER REFERENCES salons(id) ON DELETE CASCADE,
  yc_service_id BIGINT NOT NULL,
  yc_staff_id   BIGINT NULL,           -- NULL = услуга целиком; заполнен = пара услуга×мастер
  rule_type     VARCHAR(10) NOT NULL,  -- 'deny' | 'allow'
  note          TEXT,
  created_at    TIMESTAMP DEFAULT NOW()
);

-- NULL-ы Postgres считает различными в UNIQUE → нормализуем через COALESCE
CREATE UNIQUE INDEX IF NOT EXISTS agent_service_rules_uniq
  ON agent_service_rules (salon_id, yc_service_id, COALESCE(yc_staff_id, 0), rule_type);
CREATE INDEX IF NOT EXISTS agent_service_rules_salon_idx
  ON agent_service_rules (salon_id);
```

Все миграции — через `migrations.js` в стиле `IF NOT EXISTS` (никогда не деструктивно).

### 2. Логика фильтра — `services/agent/service-filter.js` (чистый модуль)

Чистые функции без БД/HTTP, по образцу `services/agent-gate.js`. Полностью юнит-тестируемо.

**Семантика (намеренно упрощённая, чтобы избежать путаницы allow+deny на всех уровнях):**

- **Уровень услуги** подчиняется режиму `service_mode`:
  - `all` → услуга видна, если **нет** правила `deny` на услугу целиком (`yc_staff_id IS NULL`);
  - `allowlist` → услуга видна, **только если** есть правило `allow` на услугу целиком.
- **Уровень пары услуга×мастер — всегда только `deny`**, независимо от режима. Пара скрывается,
  если есть правило `deny` с заполненным `yc_staff_id`. Whitelist на парах не поддерживается
  (покрывает кейс «услуга ошибочно у мастера» без лишней сложности).

Экспорт (сигнатуры финализируются при реализации):

- `decideServiceVisible({ mode, denyServices, allowServices }, ycServiceId) → boolean`
- `filterServiceStaff({ denyPairs }, ycServiceId, staffIds[]) → staffIds[]` (убирает deny-пары)

Где `denyServices/allowServices` — `Set` строковых `yc_service_id`; `denyPairs` — `Set` ключей
вида `` `${serviceId}:${staffId}` ``.

### 3. Сервис-слой — дополняем `services/agent-settings.js`

- `getServiceMode(salonId)` / `updateServiceMode(salonId, mode)`
- `listServiceRules(salonId)` / `addServiceRule(salonId, {...})` / `removeServiceRule(salonId, id)`
- `loadServiceFilter(salonId)` →
  `{ mode, denyServices:Set, allowServices:Set, denyPairs:Set }` — единый загрузчик для инструментов.

### 4. Интеграция в инструменты

- **`list-services.js`** — после сборки `active`: фильтруем услуги через `decideServiceVisible`,
  затем `staff[]` каждой услуги через `filterServiceStaff` (убираем deny-пары).
- **`get-available-slots.js`** / **`get-available-dates.js`** — гард: если запрошенная
  услуга/пара скрыта, возвращаем пустой мягкий ответ (не «технические сложности»).
- **`create-booking.js`** — **гард**: отказ бронировать скрытую услугу или скрытую пару
  услуга×мастер (мягкая ошибка/эскалация к оператору).
- **`list-staff.js`** — не трогаем (мастера уже курируются `is_active` + `show_in_app`).

### 5. Fail-safe

Если запрос правил из БД падает — **fail-open**: инструмент отдаёт нефильтрованный YClients + лог.

**Обоснование:** временный сбой БД не должен ломать агента целиком. Отображение единичного
«мусора» — меньшее зло, чем полностью неработающий агент/бронирование. Это осознанно
**отличается** от гейта допуска номеров (`agent-gate`), который fail-**closed**: там на кону
приватность (нельзя случайно ответить чужому номеру), а здесь — качество витрины. Гард в
`create_booking` тоже fail-open, чтобы транзиентный сбой БД не блокировал реальную бронь.

### 6. Админка — отдельный экран «Услуги агента»

**API** (`routes/agent-settings.js`, `/api/agent`, `requireRole('owner','admin')`):

- `GET /service-settings` → `{ serviceMode }`
- `PUT /service-settings { serviceMode }`
- `GET /services` → живой список услуг YClients с их мастерами + аннотация текущей видимости
  (переиспользует вызов `ycGet` из `list-services`, чтобы админ видел ровно то, что видит агент).
- `GET /service-rules` → `{ rules: [...] }`
- `POST /service-rules { ycServiceId, ycStaffId?, ruleType, note }`
- `DELETE /service-rules/:id`

**Фронт:** `frontend/js/pages/agent-services.js` + пункт навигации. Тумблер режима
`all | allowlist`, список услуг YClients с чекбоксом видимости, раскрытие мастеров услуги
с per-пара тумблером «скрыть». Стиль — по существующим страницам (`core/api.js`, классы `stg-*`).

### 7. Статья «кто что делает»

Нового кода нет. Статья пишется вручную в существующем редакторе базы знаний, сущности
привязываются через `kb_article_links` (`entity_type='service'|'staff'`), RAG её найдёт
(`agent-rag.buildKnowledgeContext`). В спеку/PR приложить готовый шаблон текста; на экране
«Услуги агента» добавить подсказку-ссылку на редактор KB.

### 8. Тесты

- `services/agent/service-filter.test.js` — чистая логика: режимы `all`/`allowlist`,
  `deny` услуги, `deny` пары, комбинации, fail-safe-ветка.
- Расширить `backend/agent-tools.test.js` — фильтрация в `list_services` и гард в `create_booking`.

## Мультисалонность

Все таблицы и запросы scoped по `salon_id` (правило проекта). `loadServiceFilter` всегда
принимает `salonId`; без него — трактуем как пустой фильтр (нет правил → в `all`-режиме
видно всё, в `allowlist` — ничего; но `salonId` в инструментах всегда присутствует).

## Поток данных

```
YClients /services/{cid}  ──►  list-services active[]  ──►  service-filter  ──►  агенту
                                                              ▲
                          agent_service_rules + service_mode ─┘  (loadServiceFilter)

create_booking(serviceId, staffId) ──►  guard (loadServiceFilter) ──► YClients book | soft-refuse
```
