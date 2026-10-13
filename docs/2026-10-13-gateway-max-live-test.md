# MAX через свой шлюз — живая проверка (дев)

Дата: 2026-10-13. Ветка `feat/messenger-gateway`, коммиты `c783eba … 561e058` поверх прода `ab8fa5f`. Спека `docs/superpowers/specs/2026-10-13-max-gateway-design.md`, план `docs/superpowers/plans/2026-10-13-max-gateway.md`.

## Что проверено без аккаунта (13.10.2026, ~17:10 мск, дев-бокс в Хельсинки)

Юнит-тесты: шлюз `node --test` — 213/213 (из них MAX: protocol 3, transport 7, mapper 10, session 2, media 3, client 25, контракт с парсером бэкенда 1 + правки registry/server/accounts-repo); бэкенд `npx jest chatpush-webhook-route messaging-accounts-routes` — 38/38; фронт `node --test messaging-accounts.test.js` — 12/12.

Живьём, через боевой путь «админ-API → бэкенд → шлюз → сервер MAX» (dev-токен владельца, `POST /api/messaging/accounts/max`):

| Шаг | Результат |
|---|---|
| `POST /api/messaging/accounts/max` | `{"id":10,"authState":"wait_qr","status":"pending"}`; строка `messenger_accounts` #10: `provider=gateway, channel=max, external_id=10, status=pending, auth_state=wait_qr, display_name=«MAX (свой шлюз)»` |
| Лог шлюза | `[MAX#10] HELLO: location=FI phone-auth=true` → `QR-раунд 1/5: ждём сканирования` → `клиент запущен` |
| `GET /api/messaging/accounts/10/status` | `authState=wait_qr`, `qr` — валидный PNG data-URL (2413 байт, заголовок PNG), `pairingCode=null`, `codeLength=null`, `error=null` |
| Истечение QR | через 121 с: `QR-раунд 2/5: ждём сканирования`, статус снова отдаёт новый QR — опрос `QR_POLL` и переиздание `QR_START` работают против живого сервера |
| `GET /health` шлюза | `{"ok":true,"accounts":[{"id":10,"authState":"wait_qr"}]}` |
| Админка | дев отдаёт кнопку `#msg-acc-connect-max`, блок `#msg-acc-qr-max-only`, скрипт `messaging-accounts.js?v=2026-10-13` |
| `scripts/max-spike.js` | за 15 с доходит до QR (`/tmp/max-spike-qr.png`, 2439 байт), ничего не пишет в БД |

Ожидаемое продолжение без сканирования: после 5 раундов (≈10 мин) аккаунт #10 уходит в `error` «QR не отсканирован…», клиент закрыт; в админке появится «Запустить заново» (повторный start без logout, как у WhatsApp).

## Что проверяет ТОЛЬКО владелец (нужен телефон с тестовым номером +79200255591)

1. Дев-админка → Настройки → Мессенджеры → «Подключить MAX напрямую» (или «Запустить заново» у строки MAX) → на телефоне MAX → Профиль → Устройства → Подключить устройство → сканировать QR. Ожидание: строка `ready` с номером и именем, лог шлюза `готов: 79200255591 (…, id N)`, канал `max` салона переключился на шлюз (`messenger_accounts` #10 `active`, Chatpush `max` #3 `disabled`).
2. С номера клиники 79250177778 написать текст в MAX → в «Чате» входящее; лог шлюза: строка «диалог …: участник …, XOR даёт … — совпадает/НЕ совпадает» (проверка формулы id диалога) и есть ли номер собеседника (`sender_phone_number`).
3. Прислать фото и файл → `file_data` в вебхуке, файлы в `frontend/uploads/gateway/10/`.
4. Ответить из «Чата» текстом и файлом на 79250177778 → доставка `g<n>` «Отправлено», эхо с `delivery_id` в «Чате», на телефоне 79250177778 сообщение пришло.
5. Набрать ответ руками на телефоне +79200255591 → в `chatpush_messages` `authored_by='operator'`, диалог на паузе («ответил оператор»).
6. `pm2 restart loyalpro-gateway` → аккаунт снова `ready` без QR.
7. Альтернативно/дополнительно — `cd gateway && node scripts/max-spike.js --to 79250177778 --file /tmp/a.jpg` (сырые push-кадры в лог; сессия `data/spike-max`, удалить после).

Записать сюда дословные строки лога по каждому пункту; при расхождениях — см. план, Task 11 Step 3 (что менять при «XOR НЕ совпадает», скрытых номерах, отсутствии push на свои сообщения, отсутствии `NOTIF_ATTACH`).

## Не проверено и не проверяется на деве

Вход по номеру + SMS (веб-транспорт по PyMax; дев в Финляндии — SMS может не прийти по гео), поведение при 5 раундах QR на проде, автоуведомления YClients (идут через Chatpush, классификация по шаблонам — фикс 13.10).
