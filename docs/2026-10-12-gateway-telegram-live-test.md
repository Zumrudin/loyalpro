# Живой прогон своего Telegram-шлюза на деве — 2026-10-12

План: `docs/superpowers/plans/2026-10-08-telegram-gateway-multitenant.md`, Task 14. Ветка `feat/messenger-gateway`, HEAD на момент прогона `3c8e1ac` (+ ключи Telegram в `gateway/.env`).

## Окружение
- Дев-бэкенд `loyalpro` (127.0.0.1:3001), дев-шлюз `loyalpro-gateway` (127.0.0.1:3002), БД `loyalpro_test`.
- Ключи `TG_API_ID=37287998` / `TG_API_HASH` (my.telegram.org, аккаунт владельца).
- Аккаунт шлюза: +79200255591 («Zumrudin»), строка `messenger_accounts` #8. «Пациент»: +79250177778 (аккаунт клиники, писал владелец с телефона).

## Что проверено — PASS
| Шаг | Результат |
|---|---|
| Спайк `gateway/scripts/tdlib-spike.js` | TDLib 1.8.67; `WaitTdlibParameters` → `WaitPhoneNumber` без ручного `setTdlibParameters` (tdl 8 шлёт сам) |
| Подключение из админки (Настройки → Мессенджеры) | `starting` → `wait_phone` (12:53:42) → `wait_code` (12:53:55) → `ready` (12:54:10); 2FA не спрашивался |
| Переключение канала | строка #8 стала `active`, Chatpush tdlib (#2) — `disabled` в одной транзакции (15:54:07 по БД), только после `ready` |
| Входящее «TEST» с 79250177778 | `chatpush_events` #25952 `provider=gateway`, `chatpush_messages` #20134: `channel=tdlib`, `phone=79250177778`, `chat_id=5240356278`, `external_message_id=5240356278:192937984`, клиент #1318 сматчен; диспетчер: `gate skip (disabled)` — Мила на деве выключена, это штатно |
| Ответ с телефона «Тест 2» (набран руками) | эхо без `delivery_id` → `authored_by='operator'`, `agent paused 79250177778` — пауза бота на ответ человека работает |
| Защита от второго провайдера | 15:55:26 входящее по tdlib ИЗ CHATPUSH (общий инстанс 46594) пропущено: «канал салона 1 обслуживает gateway (аккаунт #8) — событие сохранено, сообщение не разбираем» |
| `scripts/gateway-telegram-e2e.js --phone 79250177778` | delivery `g1` (accountId 8), эхо #20136 `authored_by='agent'`, `provider='gateway'`, составной id, статус по аккаунту `2 «Отправлено»`, событие #25955 с `delivery_id=g1` в `chatpush_events` (сторож доставки подтвердит) |
| Рестарт `pm2 restart loyalpro-gateway` | сессия поднялась без кода: `Closed` → `WaitTdlibParameters` → `Ready` за ~1 с, `/health` → `accounts:[{id:8, ready}]` |

## Не проверено (руками, нужен UI/JWT)
- Отправка файла из «Чата» в этот диалог (`send_file` → `inputMessageDocument`/`inputMessagePhoto`).
- Входящее фото от пациента → `/uploads/gateway/8/…jpg` в «Чате».
- Ответ в диалог со скрытым номером (`tdlib_user_id`), в т.ч. тому, кто не писал после входа шлюза (`loadChats`).
- Входящее во время `pm2 restart loyalpro` (повторы вебхука ~2,5 мин).

## Наблюдения
- Дев получает вебхуки Chatpush прод-инстанса (customer 46594): после переключения tdlib на шлюз эти сообщения на деве в «Чат» не попадают (гейт провайдера) — на деве это ожидаемо, на проде после переключения из Chatpush нужно выйти (Task 15, шаг 4.3).
- На рестарте шлюза `auth_state` строки кратко проходит через `logged_out` (`Closing`/`Closed`) и возвращается в `ready` — в админке это может мигнуть как «отключён» на секунду.
- Старая строка #7 (`disabled`, `wait_phone`, попытка 09.10) осталась в БД — безвредна, удалять не нужно.
