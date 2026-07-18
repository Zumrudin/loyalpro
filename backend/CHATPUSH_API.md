# Chatpush API — справочник

Мессенджер-платформа для **двусторонней** переписки: отправка и приём сообщений
через WhatsApp, номерной Telegram (tdlib), Telegram Bot, MAX, MAX Bot, ВК/ОК
(notify), Avito, SMS.

- Клиентская дока (отправка): <https://docs2.chatpush.ru/>
- Девелоперская дока (инстансы, webhooks, авторизация): <https://dev.docs2.chatpush.ru/>
- Base URL: `https://api.chatpush.ru`

> ⚠️ **Секреты — только в env**, не в коде/репозитории. HTTP-токен даёт полный доступ
> к отправке от лица аккаунта и тратит баланс. Если токен где-то засветился — перевыпустить в ЛК.

---

## Авторизация (две разные!)

| Тип | Header | Для чего |
|-----|--------|----------|
| **Bearer token инстанса** | `Authorization: Bearer <token>` | Отправка, приём, webhooks, `/api/v1/*`, `/account` |
| **api_key девелопера** (мастер-токен) | `Authorization: <api_key>` | Управление инстансами (мультиаккаунт), `/developer/v1/*` |

При невалидности — HTTP 401 `{"meta":{"status":"fail","message":"Not authorized!","code":401}}`.

Env-переменные (см. `config.js` → `CHATPUSH`):
```
CHATPUSH_API_BASE=https://api.chatpush.ru
CHATPUSH_API_KEY=<developer master token>
CHATPUSH_INSTANCE_TOKEN=<bearer token инстанса>
CHATPUSH_WEBHOOK_SECRET=<произвольный секрет для ?key= в URL вебхука>
```

---

## Проверка инстанса

`GET /api/v1/account` (Bearer). Возвращает статусы авторизации мессенджеров и доступные каналы:

```bash
curl -X GET https://api.chatpush.ru/api/v1/account -H "Authorization: Bearer <token>"
```
```json
{
  "meta": { "code": 200, "status": "success" },
  "account": {
    "customer_id": 46594,
    "dispatch_routing": ["tdlib", "max", "whatsapp"],
    "whatsapp_session": 1,          // 0 = не авторизован, 1 = авторизован
    "tdlib_session": 3,             // 3 = авторизован (см. коды ниже)
    "max_session": 2,               // 2 = авторизован (см. коды ниже)
    "sender_names": ["push46594", "PUSHSMS.RU"],
    "subscription_status": "active",
    "subscription_paid_until": "2026-08-01"
  }
}
```

Коды сессий:
- **whatsapp_session**: 0 не авторизован · 1 авторизован.
- **tdlib_session**: 0 ожидание телефона · 1 ожидание SMS-кода · 2 ожидание 2FA · 3 авторизован · 4 ожидание QR · 5 заблокирован.
- **max_session**: 0 ожидание телефона · 1 ожидание SMS-кода · 2 авторизован · 3 ожидание QR · 4 приостановлен · 5 ожидание 2FA.

---

## Отправка сообщений

### `POST /api/v1/delivery` — одно сообщение (Bearer)

Параметры (в query-string или form-body; массивы — повторяющимся ключом `k[]=v`):

| Параметр | Обяз. | Описание |
|----------|-------|----------|
| `text` | да | Текст. До 3500 симв. для мессенджеров; SMS 160 лат./70 не-лат. |
| `phone` | да | `79991112233` или `89991112233` |
| `dispatch_routing[]` | нет | Каналы и порядок: `whatsapp`, `tdlib`, `telegram`, `notify` (ВК/ОК), `max`, `max_bot` |
| `sender_name` | нет | Имя отправителя SMS (по умолч. `PUSHSMS.RU`) |
| `scheduled_at` | нет | Отложенная отправка, UTC+0, `ГГГГ-ММ-ДД ЧЧ:ММ:СС` (от 1 мин до 1 мес) |
| `external_id` | нет | Свой ID для идемпотентности |
| `callback_url` | нет | URL для колбэков об изменении статуса |
| `utm_mark` | нет | Метка |
| `priority` | нет | `high` / `medium` / `low` |
| `reply_to_message_id` | нет | Цитирование сообщения |
| `username` | нет | Только для `tdlib`: `username` / `@username` |
| `tdlib_user_id` | нет | ID tdlib-клиента (личка > 0, группа < 0) |
| `simulate_typing` | нет | Дефолт `true` — имитация набора в WhatsApp перед отправкой |
| `whatsapp_lid` | нет | lid-id клиента в WhatsApp |
| `max_user_id` | нет | id клиента в MAX / MAX Bot |
| `avito_chat_id` | нет | chat_id клиента в Avito |

**Пример (проверено — доставлено):**
```bash
curl -X POST "https://api.chatpush.ru/api/v1/delivery" \
  -H "Authorization: Bearer <token>" \
  --data-urlencode "text=Привет!" \
  --data-urlencode "phone=79200255591" \
  --data-urlencode "dispatch_routing[]=whatsapp"
```
```json
{
  "meta": { "code": 200, "status": "success" },
  "delivery": {
    "id": 369095460, "phone": "+79200255591", "dispatch_routing": ["whatsapp"],
    "status_id": 6, "status_description": "Принято", "simulate_typing": true, "total_sms": 2
  }
}
```

> `status_id: 6 "Принято"` — это постановка в очередь. Далее статус меняется:
> «Передано оператору» → «Доставлено». Проверяется через `GET /api/v1/delivery/:id`.

### `POST /api/v1/bulk_delivery` — массовая (Bearer)

`text` (обяз.), `phones_numbers[]` (обяз., массив), опц.: `sender_name`, `scheduled_at`,
`utm_mark`, `dispatch_routing[]`, `usernames[]`.

### `GET /api/v1/delivery/:id` — статус (Bearer)

```json
{ "delivery": { "id": 369095460,
  "status": { "description": "Доставлено", "status_id": 2 },
  "operator": { "brand_name": "Мегафон", "slug": "megafon" } } }
```

---

## Webhooks — приём входящих

Для **одного аккаунта** — под **Bearer-токеном инстанса** (api_key НЕ нужен, подтверждено
поддержкой). Параметры create/update в **query-string**, `types[]` повторяющимся ключом
(в curl — флаг `-g`, чтобы не съедались скобки).

| Метод | URL | Описание |
|-------|-----|----------|
| POST | `/api/v1/webhooks?url=<URL>&types[]=<event>` | Создать. Можно несколько с разными url |
| GET | `/api/v1/webhooks` | Все записи |
| GET | `/api/v1/webhooks/:id` | Одна запись |
| PUT | `/api/v1/webhooks/:id?url=...&types[]=...` | Изменить |
| DELETE | `/api/v1/webhooks/:id` | Удалить |

```bash
curl -g -X POST "https://api.chatpush.ru/api/v1/webhooks?url=https%3A%2F%2Fdev.zumrudin.ru%2Fchatpush%2Fwebhook%3Fkey%3D<secret>&types[]=whatsapp_incoming_msg" \
  -H "Authorization: Bearer <instance token>"
```

Ответ create/update: `{ "meta": {...}, "webhook": { "id": 57, "url": "...", "types": [...] } }`.

> Мультиаккаунт (управление webhooks нескольких инстансов из одного мастер-токена) —
> под `api_key` на `/developer/v1/webhooks[/:id]`. Для LoyalPro (один салон) не используется.

### События (`type`)

| type | что приходит |
|------|--------------|
| `whatsapp_incoming_msg` | входящие **и** исходящие сообщения WhatsApp |
| `tdlib_incoming_msg` | номерной Telegram |
| `telegram_bot_incoming_msg` | Telegram Bot |
| `max_incoming_msg` / `max_bot_incoming_msg` | MAX / MAX Bot |
| `whatsapp_status_msg` | статусы исходящих (sent/received/read/failed…) |
| `whatsapp_log_in` / `whatsapp_log_out` | авторизация/деавторизация аккаунта |
| `whatsapp_call` | входящий звонок |

> ⚠️ События `*_incoming_msg` содержат и **исходящие** копии наших отправок
> (`direction: "outgoing"`) — их нужно фильтровать, иначе агент ответит сам себе.

### Payload входящего сообщения

> ⚠️ **Две разные формы payload** (проверено на живом трафике 2026-07-18).
> `parseMessageEvent` в `services/chatpush.js` приводит обе к единому виду —
> при интеграции опирайся на его выход, а не на конкретную форму.

**Форма A — вложенная** (в доках; наблюдалась у WhatsApp): всё под `payload.new_message`,
`customer_id` в `payload.instance`:
```json
{
  "type": "whatsapp_incoming_msg",
  "payload": {
    "instance": { "id": 6329, "customer_id": 2707 },
    "new_message": {
      "direction": "incoming",
      "message": { "id": "false_79123456789@c.us_3B55...", "type": "text",
                   "text": "Входящее", "timestamp": 1764069562, "reply_to_message_id": null },
      "chat_id": "79123456789@c.us", "chat_phone": "79123456789",
      "sender_phone_number": "79123456789", "pushname": "Test", "sender_name": "+79123456789"
    },
    "delivery_id": null
  }
}
```

**Форма B — плоская** (реально приходит у `tdlib`): поля прямо в `payload`, без
`new_message`/`instance`; `message.type = "formattedText"`; номер клиента —
`sender_phone_number` (для incoming) либо `recipient_phone_number` (для outgoing).
В **групповых** чатах Telegram `chat_id < 0`, а `*_phone_number` = `null` — тогда
идентификатор клиента только `sender_id` + `sender_name` (телефон недоступен).
```json
{
  "type": "tdlib_incoming_msg",
  "payload": {
    "chat_id": 773250619, "chat_type": "person", "direction": "incoming",
    "message": { "id": 40254832640, "type": "formattedText",
                 "text": "Здравствуйте", "timestamp": 1784357874, "reply_to_message_id": null },
    "customer_id": 46594, "sender_id": 5240356278, "sender_name": "Ксения",
    "sender_phone_number": "79266180121", "recipient_phone_number": "79250177778",
    "recipient_username": "periclinic", "delivery_id": null
  }
}
```

**Файл/картинка (входящее):** `message.type = "document"`, медиа как ссылка:
```json
"message": { "type": "document", "file_data": {
    "mime_type": "image/jpeg", "caption": "подпись",
    "download_url": "https://production-docs.storage.yandexcloud.net/…" } }
```
Chatpush сам забирает медиа и отдаёт временную `download_url`.

**Статусы исходящих (`whatsapp_status_msg`):** `payload.message_status.{id,status,chat_id,chat_phone}`.
Статусы: `sent` (на сервер WhatsApp), `received` (на устройство), `read`, `played`,
`failed`, `expired`, `content_gone`, `content_too_big`, `content_unuploadable`, `inactive`.

**Входящий звонок (`whatsapp_call`):** `payload.incoming_call.{call:{id,timestamp,type,is_group},direction,sender_id,chat_id,chat_phone,sender_phone_number}`.

### Безопасность вебхука

Chatpush **не подписывает** тело запроса. Единственное, что контролируем, — URL.
Поэтому секрет вози в query: регистрируй URL как
`https://<host>/chatpush/webhook?key=<CHATPUSH_WEBHOOK_SECRET>` и сверяй `?key=` (timing-safe).
Реализовано в `routes/chatpush-webhook.js` (тот же приём, что и в yclients-вебхуке).

---

## Управление инстансами (api_key)

| Метод | URL | Описание |
|-------|-----|----------|
| POST | `https://chatpush.ru/api/tmp/instances` | Создать инстанс (клиента) |
| GET | `/developer/v1/instances/:customer_id` | Инфо по customer_id |
| GET | `/developer/v1/instances?external_id=&page=&per_page=` | Поиск по external_id (пагинация) |

Создание: JSON body `{ "instance": { email, phone, password, plan, dispatch_routing, external_id, renew_subscription } }`.
Тарифы (`plan`): `jet_w` (whatsapp), `jet_t` (tdlib+telegram), `jet_m` (max),
`jet_wt`, `jet_wm`, `jet_tm`, `jet_wtm`. Ответ: `instance.{id,customer_id,token,plan,…}`.

`GET instance` возвращает статусы сессий (whatsapp/tdlib/max), `whatsapp_queue_size/limit`,
`subscription_*`, `plan`, `token`.

---

## Авторизация мессенджеров (разовая, владельцем)

Получение QR / кода авторизации WhatsApp/tdlib/MAX — два пути:
1. **iFrame** (проще): `POST Авторизация WhatsApp и TDlib через iFrame` — отдаёт ссылку/встраиваемый iFrame, где владелец сканирует QR.
2. **WSS (Phoenix-каналы)**: коннект `wss://api.chatpush.ru/socket/websocket?token=<клиентский токен>&vsn=2.0.0`,
   join канала (напр. `room:v1:max:auth`) через `phx_join`; статус авторизации пушится каждые ~5 сек.
   Origin (домен/IP источника запросов) нужно заранее передать Chatpush.

Прогресс авторизации виден и через `GET /api/v1/account` / `GET instance` (поля `*_session`).

---

## Реализация в LoyalPro

| Файл | Назначение |
|------|-----------|
| `services/chatpush.js` | `sendMessage`, `getDeliveryStatus`, webhook-CRUD, `getInstanceByCustomerId`, `parseIncomingMessage`, `replyRoutingFor`, `qs` |
| `services/chatpush-agent.js` | `generateReply(msg)` — сюда подключается LLM (пока заглушка) |
| `routes/chatpush-webhook.js` | `POST /chatpush/webhook` — ACK 200 сразу, `?key=` secret, фильтр входящих |
| `config.js` → `CHATPUSH` | env-конфиг |
| `routes/index.js` | монтирование `/chatpush` до JWT-guard |

### Проверенные тесты (2026-07-17)

| Канал | dispatch_routing | Delivery ID | Итог |
|-------|------------------|-------------|------|
| WhatsApp | `whatsapp` | 369095460 | ✅ Доставлено |
| Telegram | `tdlib` | 369096052 | ✅ Доставлено |
