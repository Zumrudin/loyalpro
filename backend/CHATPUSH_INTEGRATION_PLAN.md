# План интеграции Chatpush — диалоги и агент

Цель: полноценная работа с перепиской клиентов через Chatpush — приём **всех**
входящих, хранение диалогов, авто-ответы ИИ-агента, интерфейс «Чат» для персонала.

Связано с прошлой попыткой на YClients: `MESSAGES_MODULE_PLAN.md`,
`MESSAGES_DB_SCHEMA.sql`. Chatpush заменяет YClients как источник (у него есть
webhooks на входящие). Справочник API: `CHATPUSH_API.md`.

Статус на 2026-07-17: отправка проверена (WhatsApp #369095460, Telegram #369096052 —
доставлены). Есть скаффолд: `services/chatpush.js`, `services/chatpush-agent.js`,
`routes/chatpush-webhook.js`, блок `CHATPUSH` в `config.js`.

---

## ▶ Фаза 1 (ПЕРВЫМ ДЕЛОМ): приём ВСЕХ входящих

Задача: поднять сервис, который принимает и **сохраняет все** входящие события
Chatpush. Авто-ответ пока ВЫКЛючен — сначала убедимся, что всё долетает и пишется.

### 1.1 Env и подписка
- [ ] Прописать env: `CHATPUSH_API_KEY` (девелоперский, если есть), `CHATPUSH_INSTANCE_TOKEN`,
      `CHATPUSH_WEBHOOK_SECRET` (сгенерировать), `CHATPUSH_API_BASE`.
- [ ] Публичный HTTPS-URL вебхука. Прод: `https://<host>/chatpush/webhook?key=<secret>`.
      Для локального теста — туннель (ngrok/cloudflared) или дев-хост.

### 1.2 Таблицы (через `migrations.js`, паттерн IF NOT EXISTS)
- [ ] `chatpush_events` — СЫРОЙ лог всех вебхуков (аудит, реиграбельность):
      `id, salon_id, type, direction, external_message_id, phone, payload JSONB,
      processed BOOL, error TEXT, received_at`.
- [ ] `chatpush_messages` — нормализованные сообщения (входящие + исходящие):
      `id, salon_id, client_id (nullable), channel, direction, external_message_id,
      reply_to_message_id, msg_type, text, file_url, sender_name, phone, chat_id,
      msg_ts, created_at`. Уникальность по `(salon_id, external_message_id)` — идемпотентность.
      (Адаптировать идеи из `MESSAGES_DB_SCHEMA.sql`, но phone-based: `client_id` может быть NULL,
      если клиент ещё не сматчен.)

### 1.3 Приём и запись
- [ ] Регистрация вебхука: одноразовый скрипт `chatpush.createWebhook(url, [все *_incoming_msg + whatsapp_status_msg + log_in/out])`.
- [ ] В `routes/chatpush-webhook.js`: писать КАЖДЫЙ вебхук в `chatpush_events` ДО обработки.
      `parseIncomingMessage` → писать нормализованное в `chatpush_messages` (и incoming, и outgoing-эхо).
- [ ] Идемпотентность: `ON CONFLICT (salon_id, external_message_id) DO NOTHING` — Chatpush может ретраить.
- [ ] **Авто-ответ ВЫКЛ**: временно не звать `generateReply`/`sendMessage` (флаг `CHATPUSH_AGENT_ENABLED=false`).
- [ ] Мэппинг инстанс→салон: пока single-tenant (customer_id 46594 = один салон);
      резолвить по `payload.instance.customer_id`. Позже — колонка `salons.chatpush_customer_id`.

### 1.4 Проверка (Definition of Done)
- [ ] Написать самому себе в WhatsApp и Telegram → строки появились в `chatpush_events` и `chatpush_messages`.
- [ ] Отправить исходящее через API → пришло `whatsapp_status_msg` и `direction=outgoing`, тоже записалось.
- [ ] Файл/картинка → сохранился `file_url`.
- [ ] Дубликат вебхука не создаёт дубль строки.

---

## Фаза 2: диалоги (conversations)
- [ ] Группировка сообщений в диалоги по `(salon_id, phone/chat_id)`.
- [ ] Матчинг с `clients` по телефону (нормализация номера) → проставить `client_id`.
- [ ] Счётчик непрочитанных, `last_message_at`, статус диалога.

## Фаза 3: ИИ-агент (авто-ответ)
- [ ] `generateReply(msg)`: подтянуть историю диалога (Фаза 2) → вызвать **Claude**
      (`@anthropic-ai/sdk`, модель `claude-opus-4-8` / `claude-sonnet-4-6`).
      Опереться на существующий паттерн LLM в KB-ассистенте (`services/knowledge-base`).
- [ ] Системный промпт под салон (услуги, цены — можно связать с базой знаний / YClients).
- [ ] Guard-rails: не отвечать на исходящие/статусы; антизацикливание; таймауты; логирование стоимости.
- [ ] Ответ через `chatpush.sendMessage` в тот же канал (`replyRoutingFor`) с цитированием.
- [ ] Флаги: включение агента по салону/каналу; режим «черновик для оператора» vs «авто-отправка».

## Фаза 4: интерфейс «Чат» (персонал)
- [ ] Страница `frontend/js/pages/chat.js` — список диалогов + переписка (как в прошлом плане «вкладка Чат»).
- [ ] API `/api/chatpush/conversations`, `/conversations/:id/messages`, `POST /send` (ручной ответ оператора).
- [ ] Ролевой доступ (owner/admin), real-time обновление (polling/SSE).

## Фаза 5: надёжность и мультисалон
- [ ] `salons.chatpush_customer_id` + мэппинг инстанс→салон.
- [ ] Ретраи/очередь на отправку, идемпотентность по `external_id`.
- [ ] Обработка `whatsapp_log_out` (уведомить владельца — сессия отвалилась, нужна повторная авторизация).
- [ ] Мониторинг `whatsapp_queue_size/limit`.

---

## Заметки по безопасности
- Токены только в env; засветившийся `CHATPUSH_INSTANCE_TOKEN` — перевыпустить в ЛК.
- Вебхук проверяет `?key=` (timing-safe); без секрета — legacy-режим (принимает, но логирует warning).
- `download_url` медиа временные — если нужно хранить, перекладывать в свой S3 (уже есть `S3_*` в config).
