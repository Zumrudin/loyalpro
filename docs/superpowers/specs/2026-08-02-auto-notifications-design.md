# Автоуведомления по событиям (v1: создание записи)

Дата: 2026-08-02 · Статус: утверждено пользователем

## Цель

Расширить модуль рассылки: постоянные (событийные) уведомления клиентам по правилам.
Первый тип триггера — «создание записи» в YClients. Правило фильтрует запись по
специалисту / категории / услугам (условия объединяются И или ИЛИ) и шлёт заготовленный
текст через Chatpush в канал, откуда клиент писал в последний раз, либо каскадом.

## Решения (утверждены)

- Триггер — ТОЛЬКО первое создание записи (`payload.status === 'create'`); изменения записи ничего не шлют. Дедуп на пару (правило, запись).
- Конструктор условий — плоский список: правило = список условий (каждое: тип `staff|category|service` + набор id, внутри набора всегда ИЛИ) + один переключатель И/ИЛИ между условиями. Пустой список = любая запись.
- Каскад каналов настраивается в правиле (порядок, дефолт `telegram → whatsapp`). Если клиент писал — его последний канал ставится первым автоматически (`prefer_last_channel`).
- UI — вкладка «Автоуведомления» на существующей странице «Рассылки».

## Архитектура: очередь + воркер (по образцу broadcast-воркера)

Вебхук лишь дёшево оценивает правила и кладёт задание в таблицу; воркер отправляет,
ретраит и ведёт журнал. Дедуп повторных доставок вебхука — UNIQUE-констрейнтом.

### Таблицы (migrations.js, IF NOT EXISTS)

`notification_rules`:
- `id, salon_id, title, is_enabled BOOL DEFAULT TRUE`
- `trigger_type VARCHAR DEFAULT 'record_created'` (задел под будущие типы)
- `conditions JSONB` — `{ "logic": "and"|"or", "items": [{"type":"staff","ids":[…]}, …] }`
- `message_template TEXT` — плейсхолдеры `{name} {first_name} {date} {time} {services} {staff} {salon}`
- `channels JSONB` — порядок каскада, значения = `dispatch_routing` Chatpush (`telegram`, `whatsapp`, …)
- `prefer_last_channel BOOL DEFAULT TRUE`
- `created_by, created_at, updated_at`

`notification_sends` (очередь + журнал):
- `id, salon_id, rule_id FK, yclients_record_id BIGINT, client_id, phone`
- `status: pending|sent|failed|skipped`, `attempts INT`, `error TEXT`
- `rendered_text TEXT`, `routing JSONB`, `channel_used`, `delivery_id`
- `UNIQUE (rule_id, yclients_record_id)`
- `created_at, sent_at`

### services/notifications.js

Чистая часть (юнит-тесты без БД):
- `evaluateRule(conditions, ctx)`, `ctx = {staffId, serviceIds, categoryIds}`
- `renderTemplate(text, recordCtx)`

Категорий в payload записи нет (только `services[].id`) — маппинг `serviceId → categoryId`
строится из booking-каталога YClients (`ycGet /services/{cid}`, полный список без фильтра
по цене, свой кэш TTL ~10 мин).

Инфраструктура:
- `handleRecordCreated(salon, payload)` — из `routes/webhook.js` после `processRecordEvent`,
  только при `status === 'create'`, в своём try/catch. Совпавшие правила → строка `pending`
  (`ON CONFLICT DO NOTHING`). Нет телефона / клиент в чёрном списке → `skipped` с причиной.
- `startNotificationWorker()` — тик ~3 с, `FOR UPDATE SKIP LOCKED`, отправка через
  `chatpush.sendMessage(config.CHATPUSH.instanceToken, …)`.

Выбор канала:
1. Последний входящий: `chatpush_messages` (salon, норм. phone, `direction='incoming'`,
   свежайший `msg_ts`) → routing через `replyRoutingFor` (`telegram_bot → telegram`).
2. Нашли и `prefer_last_channel` → `dispatch_routing = [последний, …каналы правила без него]`.
3. Не писал → `dispatch_routing = channels` правила. Каскад исполняет сам Chatpush.

Ошибка отправки → `attempts+1`, ретрай со следующего тика, после 3 попыток `failed`.

Форматирование: текст как есть (эмодзи — юникод). Разметка в v1 не конвертируется под
канал; UI подсказывает WhatsApp-стиль.

### API `routes/notification-rules.js` → `/api/notification-rules` (owner/admin)

- `GET /` — правила со счётчиками sent/failed
- `POST /`, `PUT /:id`, `DELETE /:id`, `POST /:id/toggle`
- `GET /:id/sends` — журнал отправок
- `GET /dictionaries` — специалисты + категории/услуги для пикеров

### Фронт

Вкладки на странице «Рассылки»: «Разовые рассылки» (текущее) и «Автоуведомления»
(новый файл `frontend/js/pages/broadcast-rules.js`): список правил (тумблер, счётчики,
журнал), модалка: название, строки условий (тип + мультиселект), переключатель И/ИЛИ,
текст, chips каналов с порядком. Бамп версии ассетов обязателен.

## Тесты

- `notifications.test.js`: `evaluateRule` (И/ИЛИ, пустые условия, категория через маппинг),
  `renderTemplate`.
- Смоук на деве: создать запись в YClients на тестовый номер → доставка + журнал.

## Известные ограничения v1

- Записи, созданные Милой, тоже триггерят уведомление (возможен дубль с её подтверждением
  в диалоге). Надёжного признака «кто создал» в payload нет; при необходимости — per-rule
  флаг позже.
- Разметка не адаптируется под канал.
