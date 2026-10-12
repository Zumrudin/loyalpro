# WhatsApp через свой шлюз (Baileys) — дизайн

Дата: 2026-10-12. Автор: Claude Fable 5.1 по запросу владельца. Контекст: Telegram клиники с 12.10.2026 идёт через наш шлюз `gateway/` (план `docs/superpowers/plans/2026-10-08-telegram-gateway-multitenant.md`, живой прогон `docs/2026-10-12-gateway-telegram-live-test.md`). Задача — тем же способом подключить WhatsApp и уйти с Chatpush по второму каналу.

Сессия автономная, вопросов владельцу задать было нельзя — все решения ниже приняты по данным кода, БД и библиотеки и помечены как ДОПУЩЕНИЯ там, где владелец может решить иначе.

## 1. Что уже есть и переиспользуется без правок

- `messenger_accounts` (строка на салон+канал, `provider chatpush|gateway`, `status active|pending|disabled`), транзакционное переключение канала `activateAccount`/`promoteIfReady`, откат на Chatpush кнопкой «Сделать активным».
- `services/messaging/transport.js` выбирает аккаунт по салону и каналу — отправки из 9 мест бэкенда менять не надо.
- Вебхук `/gateway/webhook` (`routes/chatpush-webhook.js`): провайдер из пути, салон по `payload.customer_id`, гейт «сообщение разбираем только от провайдера активной строки канала» — дубли при одновременно подключённом Chatpush исключены.
- Публичный Chatpush-совместимый API шлюза (`/api/v1/delivery`, `/api/v1/send_file`, `/api/v1/delivery/:id`), внутренний API (`/internal/accounts/:id/{start,auth,status,logout}`), `gateway_deliveries` (`g<n>`), `webhook-sender` с повторами, PM2-процесс `loyalpro-gateway`.
- Бэкенд уже умеет WhatsApp Chatpush: персист своих исходящих при отправке (`chat-persist.persistWhatsappOutgoing`, `external_message_id = api:<delivery_id>`), дедуп эха по `delivery_id`, сторож доставки `agent_reply_deliveries` (подтверждение — любое событие в `chatpush_events` с `payload.payload.delivery_id`), группы по jid `@g.us` (`services/agent/group-chat.js`).

## 2. Библиотека

**`@whiskeysockets/baileys@6.7.24`** (dist-tag `legacy`, точная версия) + `qrcode` (QR в data-URL для админки) + `pino` (логгер, которого требует Baileys; у нас уровень `silent`).

Почему 6.7.24, а не 7.0.0-rc14: 7-я ветка — release candidate с нативной/WASM-зависимостью `whatsapp-rust-bridge`; 6.7.24 — чистый JS (единственная нестандартная зависимость — `libsignal` из git, на проде git есть). Проверено на деве установкой: экспорты `makeWASocket, useMultiFileAuthState, DisconnectReason, downloadMediaMessage, isJidGroup, isJidBroadcast, isJidStatusBroadcast, isJidNewsletter, isLidUser, getContentType, Browsers, WAMessageStatus`, `sock.requestPairingCode`, `sock.onWhatsApp`. Критично для нас: WhatsApp с 2025 адресует чаты LID-идентификаторами (в живых событиях Chatpush — `chat_lid`, `sender_id: …@lid`), и 6.7.24 кладёт номер отправителя в `key.senderPn` / `key.participantPn` (`Utils/decode-wa-message.js`), плюс событие `chats.phoneNumberShare {lid, jid}` — этого достаточно, чтобы восстановить телефон. Собственные отправки библиотека дублирует в `messages.upsert` с `type:'append'` — их надо дедупить по `key.id`.

ДОПУЩЕНИЕ/РИСК (решение владельца): Baileys — неофициальный клиент WhatsApp Web, как и Chatpush. WhatsApp может ограничить или заблокировать номер за автоматизированную рассылку. Класс риска тот же, что сегодня; смягчение — существующая пауза темпа (`send_interval_min`), дневной лимит плановых сообщений, `markOnlineOnConnect:false`, никаких массовых проверок номеров.

## 3. Архитектура

Тот же процесс `gateway/`. Новый класс `lib/whatsapp-client.js` с ТЕМ ЖЕ интерфейсом, который `server.js` и `registry.js` зовут у `TelegramClient`: `start()`, `authStep(step)`, `status()`, `sendText({text, phone})`, `sendFile({filePath, fileName, caption, type, phone})`, `logout()`, `close()`, поля `id`, `authState`, статический `dirsFor(config, id)`. `registry.js` выбирает класс по `account.channel` (`tdlib` → Telegram, `whatsapp` → WhatsApp). Общий код медиа (`EXT_BY_MIME`, `safeExt`, `MAX_MEDIA_BYTES`) выносится в `lib/media.js`; `telegram-client.js` его реэкспортирует.

Сессия WhatsApp — `useMultiFileAuthState(data/acc-<id>/wa)`, переживает рестарт (как TDLib-каталог).

### Авторизация

Состояния `auth_state`: `starting → wait_qr → ready`, `logged_out`, `error`. В `wait_qr` внутренний `/status` отдаёт `qr` (data-URL PNG, Baileys обновляет QR каждые ~20 с — фронт и так опрашивает статус раз в 2 с) и, если запрошен, `pairingCode`. Шаг `authStep({phone})` в `wait_qr` → `sock.requestPairingCode(phone)` → ответ `{authState:'wait_qr', pairingCode:'ABCD-EFGH'}` (код вводится на телефоне клиники: «Связанные устройства → Привязать по номеру»). ЗАЧЕМ оба способа: администраторы PERI работают с телефона, а QR на том же телефоне не отсканировать. `{code}`/`{password}` для WhatsApp → `{error:'не применимо к WhatsApp'}`.

Соединение: `connection.update` → `qr` → `wait_qr`; `open` → `ready` (свой номер из `sock.user.id`), `close` с `DisconnectReason.loggedOut` (401) → `logged_out`, каталог сессии удаляется, без реконнекта; любая другая причина → реконнект с бэкоффом 2 с → 60 с (`restartRequired` 515 после первой авторизации — штатно).

### Входящие → вебхук

Форма — **вложенная WhatsApp-форма Chatpush** (`type:'whatsapp_incoming_msg'`, `payload.new_message.{direction, chat_id, chat_phone, sender_phone_number, recipient_phone_number, pushname, message}`), `payload.customer_id = messenger_accounts.id`, `payload.provider='gateway'`, `payload.delivery_id`. Её уже разбирает `chatpush.envelope()` (ветка `new_message`), `customer_id` берётся из `payload` — ничего в бэкенде менять не нужно.

- `chat_id`: личный с известным номером → `<phone>@c.us` (как Chatpush; `isGroupChatId` его личным и считает); группа → `<id>@g.us`; личный без номера (LID без `senderPn` и без кэша) → `<lid>@lid`, `chat_phone:null` — диалог живёт по `chat_id`, ответить в него бэкенд не сможет (`recipientParams('whatsapp')` требует номер) — известное ограничение, см. §6.
- Телефон собеседника: `remoteJid` вида `…@s.whatsapp.net` → цифры; иначе `key.senderPn` (личка) / `key.participantPn` (группа); иначе кэш `gateway_contacts` (`user_id` = числовая часть LID, `phone`; пополняется, когда в одном сообщении видны и `senderLid`, и `senderPn`, и из `chats.phoneNumberShare`); иначе `null`.
- `message.id` — составной `${fromMe?'true':'false'}_${remoteJid}_${key.id}` (та же идея, что у Chatpush `true_<lid>_<id>`; `key.id` уникален только вместе с чатом).
- Типы `message.type` как у Chatpush: `text`, `image`, `document`, `voice` (ptt), `audio`, `video`, `sticker`, прочее — имя контента без суффикса `Message` в нижнем регистре; `protocolMessage`/`reactionMessage`/`senderKeyDistributionMessage` и пустое `message` — пропускаются. Медиа в личке качается `downloadMediaMessage` → `frontend/uploads/gateway/<accountId>/<ts>_<hex><ext по MIME>` (кап 20 МБ, расширение ТОЛЬКО из белого списка), в группах не качается — как в Telegram.
- Пропускаем: `messages.upsert` с `type !== 'notify'` (история, `append` чужих устройств — кроме дедупа своих отправок), `status@broadcast`, `@newsletter`, `@broadcast`, сообщения старше 6 ч (`messageTimestamp`), `messaging-history.set` целиком (`syncFullHistory:false`, `shouldSyncHistoryMessage: () => false`).
- Исходящее, набранное на телефоне (`fromMe`, без нашей доставки) → эхо с `delivery_id:null` → бэкенд ставит `authored_by='operator'` и паузу Милы — ровно как в Telegram.

### Отправка

`POST /api/v1/delivery` с `dispatch_routing[]=whatsapp` и `phone`. jid получателя `<phone>@s.whatsapp.net`; перед отправкой `onWhatsApp(phone)`: `exists:false` → 422 «номер не в WhatsApp» (transport уйдёт на следующий аккаунт/канал); ошибка самой проверки → шлём всё равно (fail-open, лог) — в WhatsApp отправка несуществующему номеру не бросает, но at-most-once важнее. Результат `exists:true` кэшируется в памяти на 24 ч. `reply_to_message_id` для WhatsApp игнорируется (бэкенд ставит его ради tdlib со скрытым номером; для цитирования Baileys нужен оригинал сообщения, которого мы не храним — YAGNI).

Эхо своей отправки шлюз **синтезирует сам** из результата `sock.sendMessage` (тот же путь `emitMessage`, `deliveryId='g<n>'`), а `append`-апсерт этого же `key.id` пропускает — так эхо не зависит от поведения библиотеки. Бэкенд уже персистит исходящее WhatsApp при отправке (`api:g<n>`) и дедупит эхо; единственная правка — в `routes/chatpush-webhook.js` ветка дедупа берёт `msg.deliveryId` (есть и у Chatpush, и у нас), а `deliveryIdFromWhatsappEchoId` остаётся запасным путём (у шлюза id `g12`, регэксп `_d(\d+)THISISBOT` его не ловит).

Статусы `gateway_deliveries`: `sendMessage` бросил → `5 Невозможно доставить`; `messages.update` со `status ≥ SERVER_ACK(2)` по нашему `key.id` → `2 Отправлено`. Связка «key.id → доставка» — в памяти и в новой колонке `gateway_deliveries.provider_message_id VARCHAR(64)` (как `tdlib_temp_id`, но id строковый), `failStale` на `ready` — как в Telegram. Файлы: `type=image` → `{image: buffer, caption}`, иначе `{document: buffer, mimetype, fileName, caption}`; временный файл удаляется сразу после `sendMessage` (Baileys читает файл синхронно до ответа, в отличие от TDLib).

### Бэкенд и админка

- `routes/messaging-accounts.js`: `createTelegramAccount(salonId)` обобщается в `createGatewayAccount(salonId, channel)` (`channel ∈ {tdlib, whatsapp}`, `display_name` по каналу), новый маршрут `POST /api/messaging/accounts/whatsapp`; `/auth` и `/status` прозрачно отдают `qr`/`pairingCode` из ответа шлюза. Переключение канала и откат — те же `promoteIfReady`/`activateAccount`/`logout`.
- `gateway/lib/accounts-repo.listActive` — `channel IN ('tdlib','whatsapp')`; `server.js` — `channel` в ответе `accepted()` из строки аккаунта, `/internal/accounts/:id/status` отдаёт `qr`/`pairingCode`.
- Фронт `messaging-accounts.js`: кнопка «Подключить WhatsApp напрямую», шаг `qr` мастера — `<img>` с QR и форма «или по номеру телефона → код для ввода на телефоне»; метки состояний `wait_qr`.

## 4. Данные

- `gateway_deliveries.provider_message_id VARCHAR(64)` (+ индекс `(account_id, provider_message_id)`), `ADD COLUMN IF NOT EXISTS` в `backend/migrations.js`.
- `gateway_contacts`: индекс `(account_id, user_id)` для обратного поиска LID → телефон. Таблица общая с Telegram (там `user_id` — id пользователя TDLib); аккаунты разных каналов — разные `account_id`, пересечения нет.

## 5. Переключение и откат

Как у Telegram: строка `pending` → шлюз `ready` → `activateAccount` в транзакции гасит Chatpush whatsapp; после — выйти из WhatsApp в кабинете Chatpush (WhatsApp разрешает до 4 связанных устройств, оба получают всё; гейт провайдера дубли не пустит, но лишние события и риск двух «операторов» ни к чему). Откат — «Сделать активным» у строки Chatpush whatsapp (перед этим снова связать Chatpush).

## 6. Известные ограничения (осознанно)

- Диалог без номера (LID, пока телефон не раскрылся) — только читать, ответить нельзя; как только номер раскроется, `chat-persist.adoptPhoneForChat` склеит переписку (тот же путь, что для Telegram со скрытым номером).
- `reply_to` не поддержан; цитирования в WhatsApp не будет.
- Статусы «доставлено/прочитано» (3/4) в `gateway_deliveries` не пишутся — бэкенду важно только 2 и 5.
- Звонки, реакции, опросы, статусы-истории — не форвардятся.
- Один аккаунт WhatsApp = один салон (строка). Многосалонность — строками, как у Telegram.

## 7. Проверка

Юнит: `gateway/test/wa-mapper.test.js`, `whatsapp-client.test.js` (фейковый сокет, без сети), правки `server.test.js`/`deliveries.test.js`; бэкенд `messaging-accounts-routes.test.js`, `chatpush-webhook-route.test.js`; фронт `messaging-accounts.test.js`. Живьём: спайк `gateway/scripts/whatsapp-spike.js` на деве с реальным аккаунтом (подтверждает поля `senderPn`, `append`-эхо, статусы, медиа — ДО написания клиента), затем `backend/scripts/gateway-whatsapp-e2e.js` (отправка через transport → эхо → статус → событие для сторожа) и ручной чек-лист (входящее с телефона, ответ с телефона → пауза, фото, гейт второго провайдера, рестарт без QR).
