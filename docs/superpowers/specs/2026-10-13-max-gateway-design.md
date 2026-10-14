# MAX через свой шлюз (веб-протокол, QR) — дизайн

Дата: 2026-10-13. Автор: Claude Fable 5.1 по запросу владельца («риски беру на себя, будем реализовывать»). Контекст: Telegram (TDLib) и WhatsApp (Baileys) клиники уже идут через наш шлюз `gateway/`; MAX остаётся на Chatpush, который с 10.10.2026 в MAX ничего не доставляет. Исследование возможностей — `docs/2026-10-13-max-gateway-feasibility.md`: официального API для номерного аккаунта нет, остаётся неофициальный пользовательский протокол.

Сессия автономная, вопросов владельцу задать было нельзя — решения ниже приняты по данным кода, БД и трёх референсных клиентов протокола и помечены как ДОПУЩЕНИЯ там, где владелец может решить иначе.

## 1. Что уже есть и переиспользуется без правок

- `messenger_accounts` (строка на салон+канал, `provider chatpush|gateway`, `status active|pending|disabled`), транзакционное переключение канала `activateAccount`/`promoteIfReady`, откат на Chatpush кнопкой «Сделать активным».
- `services/messaging/transport.js` выбирает аккаунт по салону и каналу — отправки из всех мест бэкенда менять не надо. `services/chat.recipientParams('max')` уже отдаёт `phone` + `max_user_id` (= `chat_id` диалога), `FILE_CHANNELS` агента включает `max`.
- Вебхук `/gateway/webhook` (`routes/chatpush-webhook.js`): провайдер из пути, салон по `payload.customer_id`, гейт «сообщение разбираем только от провайдера активной строки канала»; `outgoing-authorship.classify` для `provider='gateway'` без `delivery_id` сверяет текст с шаблонами уведомлений (фикс 13.10) — работает для любого канала шлюза.
- Бэкенд уже разбирает ПЛОСКУЮ форму события `max_incoming_msg` (`chatpush.envelope()`: `payload.{direction, chat_id, chat_type, sender_phone_number, recipient_phone_number, message, timestamp, delivery_id, customer_id}`), группы MAX узнаёт по отрицательному `chat_id` (`services/chat.isGroupChatId`, `services/agent/group-chat.js`), метка канала в админке есть (`MSG_ACC_CHANNEL.max`).
- Публичный Chatpush-совместимый API шлюза (`/api/v1/delivery`, `/api/v1/send_file`, `/api/v1/delivery/:id`), внутренний (`/internal/accounts/:id/{start,auth,status,logout}`), `gateway_deliveries` (`g<n>`, колонка `provider_message_id`), `gateway_contacts` (`account_id, phone, user_id`), `webhook-sender` с повторами, `lib/media.js`, PM2-процесс `loyalpro-gateway`.
- Мастер подключения в админке (`frontend/js/pages/messaging-accounts.js`) уже умеет оба сценария, которые нужны MAX: QR-картинка (WhatsApp) и шаги номер → код → пароль (Telegram).

## 2. Протокол и библиотека

### 2.1 Что установлено по референсным клиентам и живой проверкой

Референсы (все MIT): `max-account-api` 0.1.1 (TypeScript, типы протокола из декомпилированного клиента), `MaxApiTeam/PyMax` (274★, самый живой), `webmaxsocket` 1.2.7. Живая проверка 13.10.2026 с дев-бокса (Хельсинки): `HELLO` → `{"phone-auth-enabled":true,"location":"FI",…}`, `QR_START` → `{qrLink:"https://max.ru/:auth/<trackId>", trackId, ttl:120000, pollingInterval:5000, expiresAt}`, `QR_POLL` → `{status:{ttl, expiresAt}}` — веб-протокол доступен без российского IP.

| Факт | Значение | Источник |
|---|---|---|
| Транспорт веб-клиента | `wss://ws-api.oneme.ru/websocket`, заголовки `User-Agent` (десктопный Chrome) и `Origin: https://web.max.ru` | max-account-api, PyMax, живая проверка |
| Кадр | JSON `{ver:11, cmd, seq, opcode, payload?}`; `cmd` 0 запрос, 1 ответ, 3 ошибка (`payload.error`, `payload.message`); push сервера — `cmd:0` со своим `seq` | max-account-api `transport.ts`, PyMax `protocol/ws` |
| Бинарный msgpack+LZ4 | ТОЛЬКО мобильный TCP-путь (`api.oneme.ru:443`), нам не нужен | max-account-api `opcodes.ts` |
| HELLO (6) | `{userAgent:{deviceType:'WEB', locale, deviceLocale, osVersion, deviceName, headerUserAgent, appVersion, screen, timezone}, deviceId:<uuid>}` | все три |
| QR | 288 `QR_START` → `{qrLink, trackId, ttl, pollingInterval, expiresAt}`; 289 `QR_POLL {trackId}` → `{status:{loginAvailable?}}`; 291 `QR_LOGIN {trackId}` → `{tokenAttrs:{LOGIN:{token}}, profile?}` либо `{passwordChallenge:{trackId, hint}}` → 115 `{trackId, password}` → `{tokenAttrs}` | max-account-api `auth.ts`, PyMax `auth/qr.py` |
| Номер + SMS на веб-транспорте | 17 `AUTH_REQUEST {phone, type:'START_AUTH'}` → `{token, codeLength}`; 18 `AUTH {token, verifyCode, authTokenType:'CHECK_CODE'}` → `{tokenAttrs}` либо `{passwordChallenge}` → 115 | PyMax `auth/sms.py`, `api/auth` (для WEB `mode` не шлётся) |
| LOGIN (19) | `{token, chatsCount:40, interactive:true, chatsSync:0, contactsSync:0, presenceSync:-1, draftsSync:0}` → `{profile:{contact:{id, phone?, names:[{name}]}}, chats:[…], contacts:[…], token?, messages}`; `token` в ответе может быть новым — сохранять | max-account-api, PyMax `WebSyncPayload` |
| Отзыв токена | ошибка LOGIN с `error`/`message` ∈ {`FAIL_LOGIN_TOKEN`, `FAIL_LOGOUT_ALL`} | PyMax `app._is_invalid_login_token_error` |
| Keepalive | 1 `PING {interactive:true}` каждые 30 с | все три (PyMax `ExtraConfig.interactive=True`) |
| Входящие | push 128 `NOTIF_MESSAGE {chatId, message:{id:<строка int64>, sender:<userId>, time:<мс>, text, type:'USER'|'SYSTEM'|'CONTROL', attaches:[{_type:'PHOTO'|'FILE'|'VIDEO'|'AUDIO'|'STICKER'|'CONTACT'|'SHARE'|'CALL'|'CONTROL', …}], status?:'EDITED'|'REMOVED', link?}, unread, mark}`; квитируется `cmd:1` с тем же `opcode`/`seq` и `payload:{chatId, messageId}` | max-account-api `types.ts`/`client.ts`; PyMax push не квитирует |
| Чат | `{id, type:'DIALOG'|'CHAT'|'CHANNEL', title?, participants:{<userId>:<ts>}}`; push 135 `NOTIF_CHAT {chat}`; 48 `CHAT_INFO {chatIds}` → `{chats}` | max-account-api, PyMax |
| Id личного диалога | `chatId = myId XOR peerId` (группы и каналы — отрицательные id) | PyMax `UserService.get_chat_id` |
| Контакт | 32 `CONTACT_INFO {contactIds}` → `{contacts:[{id, phone?, names:[{name,firstName,lastName}], …}]}`; 46 `CONTACT_INFO_BY_PHONE {phone}` → `{contact}` (ошибка — номера нет в MAX или закрыт приватностью) | все три |
| Отправка | 64 `MSG_SEND {chatId, message:{text, cid:<мс, монотонно>, elements:[], attaches:[…], link?:{type:'REPLY', messageId}}, notify:true}` → `{chatId, message:{id, time, …}}`; ошибка `attachment.not.ready` — повторить | PyMax `messages/service.py`, max-account-api |
| Фото исходящее | 80 `PHOTO_UPLOAD {count:1}` → `{url}` → HTTPS POST multipart поле `file` → `{photos:{<id>:{token}}}` → attach `{_type:'PHOTO', photoToken}` | max-account-api `media.ts` |
| Файл исходящий | 87 `FILE_UPLOAD {count:1}` → `{info:[{url, fileId, token}]}` → HTTPS POST сырых байт с `content-disposition: attachment; filename=<percent-encoded>` и `content-range: 0-<n-1>/<n>` → push 136 `NOTIF_ATTACH {fileId}` → attach `{_type:'FILE', fileId}` | max-account-api `media.ts`, PyMax `uploads` |
| Фото входящее | attach `PHOTO {baseUrl, width, height, photoId, photoToken}` — скачивать по `baseUrl` | PyMax `attachments/photo.py` |
| Файл входящий | attach `FILE {fileId, name, size, token}` → 88 `FILE_DOWNLOAD {fileId, chatId, messageId}` → `{url, unsafe}` | PyMax, max-account-api |
| Голосовое | attach `AUDIO {url?, duration, token}`; видео `VIDEO {thumbnail, token, videoId}` (прямой URL — только через 83) | PyMax |
| Разлогин | 20 `LOGOUT` | все три |

### 2.2 Решение: свой клиент, без библиотеки

Веб-протокол — JSON поверх `ws`; весь нужный нам набор — 14 опкодов из таблицы. Обе Node-библиотеки — тонкие обёртки над ним: `max-account-api` — ESM, печатает QR и учётные данные в stdout, хранит сессию в `process.cwd()`, тянет `msgpackr`/`lz4js` ради мобильного пути; `webmaxsocket` — `console.log` в бою, сессии в `process.cwd()/sessions`, 3,5 тыс. строк под все сценарии юзербота. Нам нужны: сессия в `data/acc-<id>/max`, наш логгер, детерминированный реконнект, инъекция зависимостей для тестов без сети — как у `WhatsappClient`. Поэтому: `gateway/lib/max/transport.js` (~150 строк: кадры, корреляция `opcode:seq`, таймаут запроса, PING, push-события, закрытие) + `gateway/lib/max-client.js` + чистый `gateway/lib/max-mapper.js`. Единственная новая зависимость — `ws` (уже есть транзитивно у Baileys; в `package.json` фиксируется явно). Референсы перечислены в шапке клиента; при изменении протокола сверяемся с PyMax.

ДОПУЩЕНИЕ (риск, принят владельцем 13.10.2026): клиент неофициальный; MAX блокирует сторонние клиенты, протокол меняется без предупреждения. Смягчение: веб-сессия, привязанная QR с телефона клиники, ведёт себя как официальный web.max.ru (тот же транспорт, те же опкоды); `appVersion` веб-клиента вынесен в `MAX_WEB_APP_VERSION` (дефолт `26.5.5` — принят сервером 13.10.2026); ответ HELLO логируется (поле `app-update-type`, если придёт); пауза темпа и дневные лимиты бэкенда действуют как для WhatsApp; никаких массовых проверок номеров (поиск по номеру — только при отправке и с кэшем).

## 3. Архитектура

Тот же процесс `gateway/`. `MaxClient` реализует интерфейс `TelegramClient`/`WhatsappClient`: `start()`, `authStep(step)`, `status()`, `sendText({text, phone, maxUserId, replyToMessageId})`, `sendFile({filePath, fileName, caption, type, phone, maxUserId, mimeType})`, `logout()`, `close()`, поля `id`, `authState`, `closed`, статический `dirsFor(config, id)` → `{max: data/acc-<id>/max, base}`. `registry.clientClassFor` получает ветку `channel === 'max'`, `registry.logout` проверяет каталог `max` наряду с `db`/`wa`, `accounts-repo.listActive` — `channel IN ('tdlib','whatsapp','max')`.

### 3.1 Транспорт (`lib/max/transport.js`)

Класс `MaxTransport({url, headers, requestTimeoutMs, pingIntervalMs, ws, now})`: `connect()`, `request(opcode, payload)` → промис ответа (`cmd:3` → `Error` с полями `code = payload.error`, `message`, `opcode`), `ack(frame, payload)`, `close()`, события `push(frame)`, `close(code, reason)`, `error`. Реконнект транспорт НЕ делает — им управляет клиент (после переподключения нужен новый HELLO + LOGIN). PING шлёт сам с `{interactive:true}`, как оба референса: с «неактивной вкладкой» сервер мог бы перестать слать push. Полуоткрытое соединение (TCP жив, сервер молчит) транспорт рвёт сам: `maxPingFailures`=2 таймаутов PING подряд → `ws.terminate()` → событие `close` → клиент переподключается; ответ на PING даже ошибкой (`cmd:3`) счётчик обнуляет. Рукопожатие ограничено `handshakeTimeout` 15 с — без него зависший TCP-connect вешал бы `start()` навсегда. Ошибка `transport_closed` несёт `sent`: `false` — кадр не уходил (отправку можно отдать другому каналу), `true` — ушёл, ответа нет (исход неизвестен). `'error'` эмитится только при наличии слушателя: у снятого транспорта клиент оставляет заглушку, иначе позднее событие сокета уронило бы процесс вместе с Telegram/WhatsApp. Тесты — фейковый `ws`-объект, без сети.

### 3.2 Сессия и авторизация

Файл `data/acc-<id>/max/session.json`: `{deviceId, loginToken, ownerId, phone, displayName}` — пишется атомарно (tmp + rename), `deviceId` создаётся один раз (к нему привязан токен). Состояния `auth_state`: `starting → wait_qr → ready`, с ответвлениями `wait_code → wait_password` (вход по номеру), `logged_out`, `error`.

- `start()`: каталог, `setAuth('starting')`, HELLO. Есть `loginToken` → LOGIN → `ready`. Нет → QR-раунд: `QR_START`, QR-картинка `qrcode.toDataURL(qrLink)` в `status().qr`, `wait_qr`; опрос `QR_POLL` каждые `pollingInterval` (не чаще 2 с); `loginAvailable` → `QR_LOGIN` → токен (или `passwordChallenge` → `wait_password`) → LOGIN → `ready`. QR истёк (`expiresAt`) — новый `QR_START`, после `MAX_QR_ROUNDS`=5 раундов без входа — `error` «QR не отсканирован», клиент закрыт; «Подключить» из админки запускает заново (тот же приём, что у WhatsApp). `QR_START` отвергнут сервером (не обрыв: лимит, устаревший клиент, таймаут) — сразу `error` с текстом ошибки, ждать нечего.
- Первое подключение не удалось (сеть, MAX недоступен) — `start()` НЕ бросает, а запускает фоновый реконнект: `registry.startAllActive` зовёт `start()` один раз при старте процесса, и сдавшийся клиент не поднялся бы до следующего рестарта шлюза.
- `authStep({phone})` в `wait_qr` — `AUTH_REQUEST` → `wait_code` (+ `codeLength` в статусе), QR-опрос останавливается; `authStep({code})` в `wait_code` — `AUTH` → токен или `wait_password`; `authStep({password})` в `wait_password` — op 115. Ошибка сервера (например, `verify.code.wrong`, региональный отказ) возвращается текстом в ответе и в `auth_error`, состояние не меняется; из `wait_code` без кода можно вернуться к QR повторным «Подключить». ДОПУЩЕНИЕ: вход по номеру на веб-транспорте повторяет PyMax и живьём не проверялся — QR остаётся основным путём, кнопка в мастере подписана «если QR недоступен».
- LOGIN: `chatsCount` 40, как оба референса (большее значение живьём не проверено, а отказ LOGIN стоил бы входа; снимок чатов нужен только для участников, есть запасной путь XOR; история из `messages` ответа НЕ форвардится — только push), `ownerId`/`phone`/`displayName` из `profile.contact` (`names[0].name`; телефон — `normalizePhone`), ротация `token` → в файл, контакты ответа — в `gateway_contacts` ОДНОЙ пачкой (`rememberContacts`), `setAuth('ready', {phone, displayName})`, `deliveries.failStale`. LOGIN упал уже ПОСЛЕ выдачи токена (QR/код приняты, токен сохранён) — не новый QR и не повтор кода, а фоновый реконнект и вход по сохранённому токену.
- LOGIN отверг токен (`FAIL_LOGIN_TOKEN`/`FAIL_LOGOUT_ALL`, в том числе после реконнекта) → `logged_out`: файл сессии удалён, `closed=true`, реконнекта нет — как `loggedOut` у WhatsApp.
- Обрыв сокета в любом другом случае → реконнект с бэкоффом 2 с → 60 с (`RECONNECT_MS` как у WhatsApp): новый транспорт, HELLO, LOGIN по токену; в `wait_qr`/`wait_code` — новый QR-раунд (старый `trackId` привязан к старому соединению). Пока соединения нет, отправка — 422 ДО создания доставки.
- `logout()`: `LOGOUT` best-effort, закрытие, удаление каталога `max`, `logged_out`. `close()`: `closed=true`, транспорт закрыт, таймеры сняты.

### 3.3 Входящие → вебхук

Форма — ПЛОСКАЯ `max_incoming_msg` Chatpush (`type:'max_incoming_msg'`, `payload.{customer_id:<accountId>, provider:'gateway', direction, chat_id, chat_type, chat_name, sender_id, sender_name, sender_phone_number, recipient_id, recipient_name, recipient_phone_number, delivery_id, timestamp:<секунды>, message:{id, type, text, file_data?:{download_url, mime_type, file_name, caption}}}`). Собирает чистый `max-mapper.buildWebhookBody`.

- Только `cmd:0` push 128; квитируем сразу. Пропускаем: `message.status` (правки/надгробия), `type !== 'USER'`, чат с собой (`chatId === 0` или участник только я), `CHANNEL`, вложения `CALL`/`CONTROL` без текста, старше `MAX_MESSAGE_AGE_S` (6 ч, по `message.time`), id из `ownSends` (своя отправка — эхо уже синтезировано).
- Личка: `chat_type:'person'`, `chat_id` = id собеседника (как у Chatpush: диалоги без номера ключуются им, 24 таких в истории). Собеседник = второй участник чата из кэша, иначе `chatId XOR ownerId`; расхождение кэша и XOR пишется в лог один раз (проверка формулы живым трафиком). Группа (`CHAT`, отрицательный id): `chat_type:'group'`, `chat_id` = id чата, `chat_name` = `title`, `sender_phone_number` — номер участника из кэша контактов, иначе null; медиа в группах не качаем — как Telegram/WhatsApp.
- Направление: `message.sender === ownerId` → `outgoing` (набрано в приложении на телефоне или другим устройством) → эхо без `delivery_id` → бэкенд ставит `authored_by='operator'` и паузу Милы, ровно как в Telegram; иначе `incoming`.
- Номер и имя собеседника: кэш контактов (из `LOGIN.contacts`, push 135/159 и ответов 32/46) → `gateway_contacts` (`user_id` = id пользователя MAX) → при промахе один запрос `CONTACT_INFO` (32) с кэшированием (и записью номера в `gateway_contacts`, если виден). Номер может быть скрыт приватностью → `sender_phone_number:null`, диалог живёт по `chat_id`; когда номер всплывёт текстом, его подхватит `chat-persist.adoptPhoneForChat` (тот же путь, что Telegram).
- `message.type` и файлы: без вложений → `text`; `PHOTO` → `image`, качаем `baseUrl`, MIME — по СИГНАТУРЕ файла (JPEG/PNG/WEBP/GIF), а не по Content-Type CDN: тот живьём не проверен, и `application/octet-stream` дал бы `.bin` вместо картинки; `FILE` → `document`, URL через 88, имя/размер из attach; `AUDIO` с `url` → `audio` (так Chatpush типизировал аудио MAX во всей истории БД — 3 из 3; бэкенд показывает и `audio`, и `voice` как «Аудио»); `VIDEO` → `video` без файла (ссылка только через отдельный запрос 83 — YAGNI); `STICKER` → `sticker` без файла; `CONTACT` → `contact`; `SHARE` (превью ссылки) — текст. Скачивание: кап `MAX_MEDIA_BYTES` (20 МБ, заявленный `size` — ранний отказ, факт — по байтам), дедлайн 90 с, расширение ТОЛЬКО из `EXT_BY_MIME` (для `FILE` — по MIME из расширения имени через обратную карту, иначе `.bin`), путь `frontend/uploads/gateway/<accountId>/<ts>_<hex><ext>` — как у WhatsApp. Файл не скачан → сообщение уходит без `file_data`, WARN в лог.
- Порядок: обработка по чату сериализуется очередью (`enqueueChat`), как у других клиентов.
- Своё сообщение, пришедшее push'ем РАНЬШЕ ответа на `MSG_SEND` (сервер рассылает его всем сессиям): если в этот чат есть отправка в пути, ждём её (не дольше 30 с) и сверяемся с `ownSends` снова. Иначе своя отправка ушла бы в бэкенд «набранной на телефоне» без `delivery_id`, а журнал авторства мог ещё не лечь — ложная пауза Милы на её же реплике (тот же приём, что `waitInflight` у WhatsApp).

### 3.4 Отправка

`POST /api/v1/delivery` с `dispatch_routing[]=max`: получатель — `max_user_id` (приоритет: это id диалога из нашей БД; отрицательный → id группы как есть; положительный → `chatId = ownerId XOR userId`), иначе `phone` → кэш контактов/`gateway_contacts` → `CONTACT_INFO_BY_PHONE` (46; результат кэшируется в памяти и `gateway_contacts`). Номера нет в MAX или он закрыт приватностью (ошибка 46) → 422 (transport уйдёт на следующий канал каскада); иная ошибка/таймаут → 503.

Текст: доставка `gateway_deliveries` создаётся ДО `MSG_SEND`; `cid` — миллисекунды, монотонно (PyMax); `reply_to_message_id` → `link:{type:'REPLY', messageId}` только если id числовой (id MAX — строка цифр; чужой формат игнорируется); ответ → `provider_message_id` = `message.id`, статус `2 Отправлено` условным переходом из «Принято», `ownSends` запоминает id (TTL 30 мин), эхо СИНТЕЗИРУЕТСЯ из ответа (`direction:'outgoing'`, `delivery_id:'g<n>'`) тем же `emitMessage`; `MSG_SEND` бросил → `5 Невозможно доставить` + 422 наружу (текст ошибки сервера, 429 при `rate|limit|too.many`); таймаут или обрыв ПОСЛЕ отправки кадра → 503 (исход неизвестен, каскад на другой канал не идёт), обрыв ДО отправки (`sent:false`) → 422.

Защита от отправки не тому человеку: при `max_user_id` И номере диалога клиент сверяет видимый номер контакта (кэш → `CONTACT_INFO` → `gateway_contacts`). Номер расходится — id указывает на другого человека (например, если id эпохи Chatpush окажутся из другого пространства) → отправка по номеру + WARN; номер скрыт приватностью → доверяем id, как Chatpush. Данные Chatpush подтверждают допущение «`chat_id` лички = id собеседника»: `sender_id = chat_id` у всех 1240 входящих и `recipient_id = chat_id` у всех 1934 исходящих.

Файлы: читаем временный файл, удаляем его сразу (как WhatsApp); `type=image` и MIME `image/*` → фото (80 + multipart), иначе документ (87 + сырой POST + ожидание 136 не дольше `FILE_READY_TIMEOUT_MS`=60 с); `attachment.not.ready` → одна пауза 2 с и повтор `MSG_SEND`; подпись — `text` сообщения. Пока грузился файл, соединение могло упасть — готовность проверяется ещё раз ДО создания доставки (422, ничего не ушло). HTTP наружу — `axios` (уже зависимость), инжектируется в тестах.

Статусы: `1 Принято` при создании, `2 Отправлено` по ответу `MSG_SEND`, `5` при ошибке; `3/4` не пишем (бэкенду нужны только 2 и 5). Повторная отправка/правка не поддерживаются.

### 3.5 Бэкенд и админка

- `routes/messaging-accounts.js`: `GATEWAY_CHANNELS.max = 'MAX (свой шлюз)'`, маршрут `POST /api/messaging/accounts/max`; `/auth` и `/status` — без изменений (прозрачно отдают `qr`, `codeLength`, `error`).
- `gateway/server.js`: `/api/v1/delivery` и `/api/v1/send_file` пробрасывают `max_user_id` (`maxUserId`) в клиент; `/internal/accounts/:id/status` отдаёт `qr` для любого канала (уже так).
- Фронт `messaging-accounts.js`: кнопка «Подключить MAX напрямую», мастер: шаг `qr` — QR-картинка и подпись «MAX на телефоне клиники → Профиль → Устройства → Подключить устройство», ниже свёрнутая форма «если QR недоступен: номер → код из SMS → пароль», состояния `wait_code`/`wait_password` используют существующие шаги Telegram. Правки JS — с бампом `?v=`.

## 4. Данные

Новых таблиц и колонок нет: `gateway_deliveries.provider_message_id` (строковый id MAX), `gateway_contacts` (`user_id` = id пользователя MAX, аккаунты разных каналов — разные `account_id`). Файлы сессии — в `data/acc-<id>/max/`.

## 5. Переключение и откат

Как у WhatsApp: строка `pending` → шлюз `ready` → `activateAccount` гасит Chatpush `max`; затем выйти из MAX в кабинете Chatpush (иначе две сессии и лишние события; гейт провайдера дубли в «Чат» не пустит). Откат — «Сделать активным» у строки Chatpush `max`. Автоуведомления YClients по-прежнему идут через Chatpush и придут эхом без `delivery_id` — их классифицирует фикс 13.10 (`isKnownNotificationTemplate`); та же оговорка, что у Telegram/WhatsApp.

## 6. Известные ограничения (осознанно)

- Не проверено живым трафиком до привязки тестового номера: форма push 128 для СВОИХ сообщений с телефона, формула XOR, видимость номера собеседника, вход по SMS на веб-транспорте, заголовки загрузки файлов, квитирование push. Для каждого пункта в клиенте есть диагностический лог (один раз на процесс), а спайк `gateway/scripts/max-spike.js` печатает сырые push-кадры — первым делом после привязки.
- Общее пространство id с Chatpush проверяется на привязке тестового номера: в данных Chatpush у +79200255591 (сообщения в группе администраторов) `sender_id = 62232990`; id из ответа LOGIN нашего клиента для того же номера обязан совпасть (спайк: `--expect-owner 62232990`). Совпало — отправка по `max_user_id` старых диалогов безопасна; нет — выкат на прод останавливается до правки.
- Группы: `sender_phone_number` только для участников из кэша контактов; Мила в группах и так молчит.
- Видео и стикеры — без файла; реакции, правки, удаления, звонки, опросы — не форвардятся.
- `reply_to` работает только на id MAX; статусы «доставлено/прочитано» не пишутся.
- Один аккаунт MAX = один салон (строка). Поиск по номеру — только при отправке.
- Фингерпринт веб-клиента (`appVersion`) надо обновлять вслед за web.max.ru, если сервер начнёт отвечать «Приложение устарело»: env `MAX_WEB_APP_VERSION` без правки кода.

## 7. Проверка

Юнит (`node --test` в `gateway/`): `max-transport.test.js` (кадры, корреляция, ошибка `cmd:3`, таймаут, PING, push/ack, закрытие), `max-mapper.test.js` (контент, направление, XOR, тело вебхука — контракт с `backend/services/chatpush.envelope()` проверяется тестом, грузящим бэкендовый `envelope` как `mapper-contract.test.js`), `max-client.test.js` (фейковый транспорт: QR-раунды и лимит, вход по номеру, LOGIN/ротация токена/отзыв, реконнект, фильтры входящих, медиа, отправка текста/фото/файла с эхом и статусами, поиск по номеру с 422, logout/close), правки `registry.test.js`/`server.test.js`/`accounts-repo.test.js`; бэкенд `messaging-accounts-routes.test.js`; фронт `messaging-accounts.test.js`. Живьём: `gateway/scripts/max-spike.js` на деве с тестовым номером 79200255591 (QR в терминал/файл, сырые push в лог, `--send` одно сообщение), затем подключение из админки, `backend/scripts/gateway-whatsapp-e2e.js`-подобная проверка отправки через transport → эхо → статус, ручной чек-лист (входящее с телефона, ответ с телефона → пауза, фото в обе стороны, рестарт без QR).
