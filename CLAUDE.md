# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

LoyalPro — loyalty program platform for beauty salons integrated with YClients CRM. Three components share one repo:

- **`backend/`** — Node.js/Express API server (port 3001). Serves both the staff web frontend and the mobile client app.
- **`frontend/`** — Vanilla JS single-page app for salon staff. Served as static files by the backend.
- **`mobile/`** — Expo/React Native app for end clients (loyalty card, bonus balance).

## Commands

### Backend
```bash
# Development (auto-reload)
cd backend && npm run dev

# Production via PM2
pm2 start ecosystem.config.js

# Restart production
pm2 restart loyalpro

# View logs
pm2 logs loyalpro
# or
tail -f backend/logs/*.log
```

### Mobile
```bash
cd mobile && npm install
npx expo start
```

### Tests (backend)
```bash
cd backend
node clients-api.test.js
node homecare-tree.test.js
node test-auth-integration.js   # integration, requires running server
```

## Architecture

### Backend structure
- `server.js` — entry point: sets up Express, mounts routes, starts cron jobs
- `config.js` — all env vars and constants in one place
- `db.js` — two PostgreSQL pools: `pool`/`db` (main app DB) and `botPool`/`botDb` (Telegram bot DB on Beget)
- `migrations.js` — runs `ALTER TABLE … ADD COLUMN IF NOT EXISTS` style safe migrations on startup
- `routes/index.js` — mounts all routers; handles JWT auth inline for `/api/*` routes
- `routes/webhook.js` — YClients webhook at `/yclients/webhook.v2/:companyId` (no JWT, responds 200 immediately then processes async)
- `services/loyalty.js` — cashback calculation, sync from YClients, bonus accrual logic
- `services/yclients.js` — all YClients REST API calls; has in-memory cache for product/service trees
- `services/home-care.js` — "домашний уход" (home care) goods catalog sync
- `services/segments.js` — client segmentation refresh
- `services/staff.js` — staff data sync
- `services/portfolio.js` — pure helpers (filename templating, reorder validation, URL absolutize) shared by admin route + mobile API. No DB/HTTP — unit-tested in `portfolio.test.js`

### Auth & roles
JWT in `Authorization: Bearer <token>` header (or `?token=` for downloads). Roles: `owner > admin > specialist`. Specialists can only access `/api/home-care`, `/api/auth`, `/api/template-settings`. Public routes (no JWT): `/api/auth/login`, `/api/auth/register`, `/api/app-settings`.

Mobile clients use a separate auth path: `routes/mobile-auth.js` + `routes/mobile-client.js` under `/api/mobile/`.

### CORS
Managed in `server.js`. The whitelist is set via `ALLOWED_ORIGINS` env var (comma-separated) or falls back to hardcoded defaults. To add an origin, set `ALLOWED_ORIGINS` in the environment — do not edit the hardcoded list unless adding a permanent default.

### Cron jobs (all TZ: Europe/Moscow)
- `0 10 * * *` — birthday bonuses
- `0 */3 * * *` — YClients sync + goods categories sync
- `0 * * * *` — staff data sync

### Database
PostgreSQL (Beget cloud, SSL). Uses `pg` pool directly — no ORM. Helper `db` object wraps pool with `.query`, `.one`, `.many`, `.any`, `.oneOrNone`. All schema changes go through `migrations.js` using `IF NOT EXISTS` / `DO NOTHING` patterns — never destructive.

### Frontend (staff SPA)
`frontend/js/app.js` — entry, router, init  
`frontend/js/core/` — api.js, auth.js, nav.js, theme.js, utils.js  
`frontend/js/pages/` — one file per page (dashboard, clients, records, staff, segments, settings, home-care, users, portfolio)

API calls go through `core/api.js` which attaches JWT from localStorage automatically.

### Multi-salon
All DB tables have `salon_id` FK to `salons`. Every API route resolves the salon from `req.user.salon_id`. Never run queries without scoping to `salon_id`.

## Tools

### Database queries
Always use the **MCP PostgreSQL server** (`mcp__postgres__query`) for direct DB queries — do not run `psql` via bash.

### Browser / UI testing
Always use the **MCP Playwright server** (`mcp__playwright__*`) for browser automation and UI testing — do not spawn Playwright via bash scripts.

### Portfolio module (До/После)
"Before/after" gallery for the mobile client app, managed by salon admins under Settings → Mobile App → Портфолио работ.

**Tables (`migrations.js`):**
- `portfolio_categories` — `id, salon_id, title, cover_photo_url, display_order, is_published, created_at, updated_at`. `cover_photo_url DEFAULT ''` is a sentinel — categories created without a cover are publishable only after upload.
- `portfolio_items` — `id, salon_id, category_id, staff_id (nullable, ON DELETE SET NULL), title, description, photo_after_url (NOT NULL), photo_before_url (nullable), display_order, created_at, updated_at`.
- Indexes: `(salon_id, display_order)` on categories, `(salon_id, category_id, display_order)` on items, partial `(salon_id, staff_id) WHERE staff_id IS NOT NULL` on items.

**Admin API (`routes/portfolio.js`, mounted at `/api/portfolio`, `requireRole('owner','admin')`):**
- `GET/POST/PUT/DELETE /categories[/:id]` — list with `items_count`, create (empty cover sentinel), update title/`isPublished` (refuses publish without cover), cascade-delete with file cleanup.
- `POST /categories/:id/cover` — multipart cover upload, replaces old file on success.
- `PUT /categories/reorder` — batch `display_order` (declared **before** `:id` to avoid path-matcher collision).
- `GET /categories/:id/items`, `POST /items` (multipart `after` required + `before` optional), `PUT /items/:id` (text only), `POST /items/:id/photos` (replace either or both), `DELETE /items/:id/before` (clear before-photo), `DELETE /items/:id` (cascade files).
- `PUT /items/reorder` — same-category guard (Set over `category_id`); also declared **before** `/items/:id`.

**Mobile API (`routes/mobile-client.js`, `mobileAuth`):**
- `GET /api/mobile/client/portfolio/categories` — published categories with items_count > 0, scoped to client's salon. URLs absolutized.
- `GET /api/mobile/client/portfolio/categories/:id` — items in a published category, embeds `specialist:{id,name,photoUrl}|null`. Photo precedence: `custom_photo_url` (trimmed) > `avatar_url` > null.
- `GET /api/mobile/client/portfolio/by-staff/:staffId` — items attributed to a staff member, only from published categories, ordered `created_at DESC`.

**Multer config:** `memoryStorage()` (so the row id can be embedded in the filename), 5 MB cap, image-only filter. Files written to `frontend/uploads/portfolio_{cat,item}_<id>[_(after|before)]_<ts>.<ext>`. `safeUnlink` swallows ENOENT and only acts on `/uploads/...` paths.

**Frontend:** `frontend/js/pages/portfolio.js` — two-level admin SPA (categories grid → items grid in a category) with HTML5 drag-drop reorder on both levels and create/edit modals. Stub `staff-profile-modal` shape reused via shared classes (`stg-section`, `btn-pri`, `fg`/`fl`).

### AI-агент: управление и гейт допуска
- `services/agent-gate.js` — чистые хелперы: `normalizePhoneKey` (РФ `8→7`), `decideGate` (порядок: enabled → чёрный список → режим/белый). Юнит-тесты `agent-gate.test.js`.
- Расписание: `agent_settings.schedule_enabled/schedule_start/schedule_end` ('HH:MM', мск). Окно **только сужает** допуск — вне окна режим принудительно `whitelist` (reason `outside-schedule`), внутри действует выбранный режим. Окно через полночь поддержано (`start > end`), начало включительно, конец исключительно; битые границы → расписание игнорируется (fail-open). Отсечка жёсткая по часам: диалог, начатый в окне, после его конца бот не продолжает.
- `services/agent-settings.js` — настройки (`agent_settings`) и списки номеров (`agent_number_rules`); `isAllowed(salonId, phone)` объединяет их через `decideGate` (fail-closed без `salonId`). Номера хранятся каноничными (нормализуются при записи в `addNumberRule`).
- `routes/agent-settings.js` (`/api/agent`, owner/admin) — тумблер, режим `all|whitelist`, CRUD номеров.
- `routes/chatpush-webhook.js` зовёт `isAllowed` перед авто-ответом. Два уровня: env `CHATPUSH_AGENT_ENABLED` (глобальный kill-switch) И per-salon настройки из админки.
- Фронт: модалка «⚙️ Агент» на странице «Чат» (`frontend/js/pages/agent-settings.js`).
- Диалоги на операторе (`agent_dialogs.status='escalated'` — и эскалация Милы, и ручная пауза `operator_reply`) в списке чатов подсвечены красным и закреплены СВЕРХУ; внутри группы порядок обычный, по свежести. `GET /api/chat/dialogs` отдаёт `agentStatus`/`escalatedReason`; смена статуса рассылается SSE-событием `agent_status` (`chat-events.emitAgentStatus`) из трёх мест: `tools/escalate-to-operator.js`, `pauseAgent` и `POST /dialogs/:key/agent`. Порядок списка считает ТОЛЬКО фронт (`frontend/js/pages/chat-dialog-sort.js`, чистый модуль + `node --test`) — список перестраивается локально по SSE, и второй экземпляр правила в `ORDER BY` пришлось бы чинить в двух местах. Живые проверки: `scripts/chat-escalation-e2e.js` (контракт+SSE), `scripts/chat-escalation-visual.js` (headless-Chrome: всплытие и подсветка без перезагрузки, скриншоты обеих тем).
- Минимальный срок до визита (`services/agent/lead-time.js`, чистый модуль, тесты `agent-lead-time.test.js`): день в день — старт не раньше now+2ч; заявка в 22:00+ (мск) на завтра — старт не раньше 12:00; ночная заявка (00:00–06:59) на сегодня — тоже не раньше 12:00. Применяется в выдаче слотов (`get_available_slots`/`get_parallel_slots`/`get_sequential_slots`; в якорном режиме фильтруются только добавляемые звенья) И write-guard'ом в `create_booking`/`reschedule_booking` (ответ `too_soon` с корректирующим hint — иначе клиент обошёл бы фильтр, назвав раннее время сам). `book_chain` наследует guard через хендлер create-booking. Промпт-правило «МИНИМАЛЬНЫЙ СРОК ДО ВИЗИТА» в Сценарии 2.
- Слот всегда считается под КОНКРЕТНУЮ услугу: `service_yc_id` в `get_available_slots` **обязателен** (как в parallel/sequential). Без него длительность неизвестна и старты считались сеткой 30 мин — инцидент 2026-07-31: предложено 11:30 перед чужой записью в 12:00, а записывалась 60-минутная услуга → YClients «Выбранное время недоступно» уже ПОСЛЕ согласования с пациентом. Провал записи именно по времени (`TIME_UNAVAILABLE_RE` в `tools/create-booking.js`) детерминированно перезапрашивает слоты и кладёт в ответ `slot_unavailable:true` + `available_slots` (свежие реальные старты этой услуги) — модель предлагает альтернативу только оттуда, а не из устаревшей выдачи. Промпт больше НЕ диктует причину отказа: фраза «это время только что заняли» была прописана в правиле и уходила пациенту как выдумка (причина отказа системе неизвестна).
- Альтернативный специалист при пустых слотах: если у запрошенного мастера на дату слотов нет, `get_available_slots` САМ проверяет других исполнителей этой услуги (из `staffList` каталога, до 3, минус скрытые парами `service-filter`) и возвращает `alternative_staff:[{staff_yc_id,name,slots}]` + `hint`; если проверены ВСЕ и пусто у всех — `no_alternative_staff:true`. Промпт-правило «АЛЬТЕРНАТИВНЫЙ СПЕЦИАЛИСТ»: не отвечать «времени нет», а в том же сообщении предложить имя+время альтернативы; «нет ни у кого» — только при `no_alternative_staff:true`. Инцидент 2026-08-01: «Голливуд» на завтра — проверена только Юлия, «окошек нет», хотя у Татьяны было 14:00 (клиент сам спросил «а почему к Тане не предлагаешь?»). Тесты `agent-slots-alternative-staff.test.js`; альтернативы проходят те же lead-time/оборудование (общий `computeStaffSlots`).
- Обобщённые услуги (`GENERIC_SERVICE_TITLES` в `services/agent/catalog-data.js`): «Биоревитализация», «Увеличение губ», «Контурная пластика», «Ботулинотерапия Ботулакс 1 ед» — на них промпт записывает, когда пациент не назвал препарат/филлер (для ботулинотерапии — зону; ответ «как врач порекомендует» — НЕ повод сводить к консультации, правило «ЗАПРОС НА ПРОЦЕДУРУ ≠ КОНСУЛЬТАЦИЯ»). В YClients они `active=0` (как и почти весь каталог PERI: активны 4 услуги из 317), поэтому в каталог агента попадают ТОЛЬКО явной галочкой (`allow`-правило в `agent_service_rules`). Без галочки правило «препарат не уточняем» невыполнимо и модель молча запишет на конкретный препарат — инцидент 2026-07-31 («Revi Silk 1 ml» вместо «Биоревитализации»). Отсутствие такой услуги теперь пишется в лог WARN один раз на процесс; список названий связан с промптом тестом в `agent-system-prompt.test.js`. Сопоставление названий — `matchesGenericTitle` (схлопывание пробелов + допустимый хвост в скобках: в YClients «Ботулинотерапия  Ботулакс 1 ед ( 30 минут )»). Цена Ботулакса — за 1 единицу (370 ₽): промпт запрещает называть её пациенту; на вопрос цены ботокса — «проводится по зонам» + диапазон направления. При негативе промпт предписывает явную смену тона (теплее/эмпатичнее, без продаж) — ШАГ А Сценария 4.
- Должность специалиста в переписке звучит один раз за диалог (правило «ДОЛЖНОСТЬ НАЗЫВАЙ ОДИН РАЗ»), дальше только имя — иначе «косметолог-эстетист Юлия» в каждом сообщении подряд.
- Лог вызова инструмента содержит аргументы: `tool get_available_slots(staff_yc_id=…,service_yc_id=…,date=…) 1695ms ok` (`summarizeToolInput`, PII-поля `client_phone/client_name/comment` не логируются). Без них разбор инцидентов упирается в «неизвестно, что модель спрашивала».
- `book_chain` (`tools/book-chain.js`) оформляет выбранный вариант `get_sequential_slots` по `option_id` (кэш `sequential-offers.js`, TTL 30 мин, in-memory на процесс); `reply-guard.js` линтует финальную реплику (лог + одно переписывание при утечке внутренней кухни).
- Витрина активных вариантов: результаты инструментов между ходами не персистятся (транскрипт собирается из текстов `chatpush_messages`), поэтому живые варианты `get_sequential_slots` дописываются блоком «АКТИВНЫЕ ВАРИАНТЫ СТЫКОВКИ» в САМЫЙ хвост промпта (`sequential-offers.peek/renderOffers`) — иначе на ходу «давайте первый вариант» у модели нет валидного `option_id`. Хвост обязателен: промпт без блока должен остаться префиксом промпта с блоком (кэш провайдера). Вариант рендерится только целиком, внутренние id не показываются, оформленные (`markBooked`) и прошедшие не рекламируются. Повторяемая проверка — `scripts/agent-sequential-e2e.js` (два хода в одном процессе: кэш in-memory).
- Серия сообщений подряд — три уровня защиты от дубль-ответов: дебаунс `AGENT_DEBOUNCE_MS` (5с) в `dispatcher.enqueue`; перегенерация в оркестраторе при входящем во время прогона (`hasIncomingAfter`, до `MAX_REGEN=2`, только без side-effect); отложенный прогон (`rerun`) после завершения. Черновик, устаревший ДО отправки (rerun-флаг взведён, ход без side-effect), выбрасывается — клиент получает один ответ на всю серию. `services/agent/pending-replies.js` держит свежеотправленные реплики до прихода эха Chatpush (TTL 30 мин, in-memory), `history.loadTranscript` подмешивает их в транскрипт с дедупом по тексту — иначе повторный прогон не видел только что отправленный ответ (эхо запаздывает на минуты, WhatsApp не шлёт вовсе) и отвечал на серию заново с повторным приветствием (инцидент 2026-07-31).
- Медицинские границы (промпт, раздел «МЕДИЦИНСКИЕ ГРАНИЦЫ», заменил правила 3/6): водораздел — общий вопрос или персональный. Уровень 1 — общие факты/подготовка/уход только из search_knowledge_base; уровень 2 — общие показания/противопоказания ДОСЛОВНО из статьи КБ + оговорка «решает врач на консультации» (нет статьи → уровень 3, по памяти НИКОГДА); уровень 3 — персональное «можно ли мне» (беременность, диабет, лекарства…) — ни «да» ни «нет», маршрут в консультацию врача (НЕ эскалация; эскалация только при отказе от консультации). Осложнение после процедуры («покраснело», «отёк») — немедленный escalate_to_operator без советов. Чек-лист статей КБ (утверждает врач!) — `docs/kb-medical-content-checklist.md`; без статей уровни 1–2 fail-safe проваливаются в консультацию.
- Окно администратора (`services/agent/admin-hours.js`, env `AGENT_ADMIN_HOURS`, дефолт `09:00-21:00` мск, полночь поддержана, битое → fail-open «на месте»): вне окна фразы эскалации не обещают «с минуты на минуту» — и в промпте (opts.adminOffHours → ШАГ Б), и в детерминированных страховках диспетчера (handoverText/silentFallbackText считаются в момент отправки). Промпт получает два стабильных варианта (день/ночь) — каждый кэшируется отдельно.
- Анти-абьюз записей на чужие номера (`services/agent/third-party-limit.js`): не больше 3 РАЗНЫХ посторонних client_phone за сутки на диалог (по номерам, не по записям — book_chain одному гостю лимит не съедает); тратят только успешные не-дубли; сверх лимита `third_party_limit` с маршрутом на администратора. In-memory на процесс. `book_chain` наследует через хендлер create-booking.
- `sanitizeName` (`sanitize.js`): имя клиента из карточки — единственное клиент-контролируемое значение в системном промпте; в промпт проходят только «словесные» слова (буквы/дефис/точка/апостроф, ≤3 слов, ≤40 симв.), первое несловесное обрывает, мусор (телефон вместо имени) → null и ветка «имени не знаем».
- Сценарий 3 на канале без номера НЕ просит продиктовать номер (list_client_bookings берёт номер только из вебхука — продиктованный игнорируется, был тупик) — сразу вежливый перевод на администратора, симметрично защите Сценария 5.
- Тон: образцы промпта — ориентир, не текст для копирования; «Подскажите» не в каждом вопросе; не каждое сообщение заканчивается вопросом/смайликом (эмодзи не чаще каждого 2–3-го); процедура — словами пациента, полное каталожное название один раз при подтверждении. Отказ в мужской эпиляции — только при уверенном поле (унисекс-имена Саша/Женя/Валя → сначала «для кого процедура?»).
- Цена процедуры зависит от МАСТЕРА и от ПОЛА пациента — два независимых источника, оба чинились 2026-08-01 (инцидент: на вопрос «сколько стоит комплекс ботокс 5в1 у Пери» пациенту-мужчине названы 19 000 ₽ — женская базовая цена; у главного врача она 23 000 ₽, а мужская — 29 900 ₽):
  - Персональные цены мастеров живут ТОЛЬКО в management-каталоге `/company/{cid}/services/` (`staff[].price`) — их собирает `staffPricesFromServices` и отдаёт `ycGetServiceMeta`. Booking-эндпоинт `/services/{cid}?staff_id=` отдаёт ВСЕМ базовую цену услуги (там их брали раньше — отсюда 19 000 ₽ у главврача). В карту попадают только реальные переопределения: у мастера без ключа действует базовая цена услуги целиком (обе границы, без смешивания). На живых данных PERI это 132 услуги из 224 с разными ценами по мастерам. Одного диапазона «X-Y» в строке каталога МАЛО: модель его не разворачивала — не звала `get_service_masters` и называла пациенту нижнюю границу как цену главврача (повтор инцидента уже после первого фикса). Поэтому при расхождении цен колонка мастеров рендерится как `id=цена` (`1910274=23000,5708379=19000`, `fmtStaffCell` в catalog-block.js) — точная сумма лежит прямо в строке, инструмент нужен только как запасной путь. Живая проверка — `scripts/agent-price-probe.js` (синтетические номера, реальный LLM, чистит за собой).
  - Мужской прайс — ОТДЕЛЬНЫЕ услуги каталога с приставкой «Муж.» в начале названия (не наценка!): «Муж. Комплекс 5в1 …» 24 700 ₽ против женской «5в1Лоб+брови…» 19 000 ₽. Чистый модуль `services/agent/male-services.js` (`isMaleService`, `hasMalePriceList` — направление сравнивается ПОЛНЫМ `category_path`), промпт-правило «МУЖСКОЙ ПРАЙС» + детерминированные подсказки `for_men`/`men_price_list` в ответе `get_service_masters` (приходят ровно в момент, когда модель берёт цену). Пол неочевиден → сначала «для кого процедура?», как в правиле мужской эпиляции; запрет мужской лазерной эпиляции приставкой НЕ отменяется.
- Каталог услуг в промпте (флаг `AGENT_CATALOG_IN_PROMPT=true`): вместо инструмента `list_services` компактный текстовый каталог вшивается в системный промпт ДО волатильных частей (кэшируемый префикс, ~6k токенов против ~28k JSON). Общий загрузчик `services/agent/catalog-data.js`, рендерер `services/agent/catalog-block.js`, per-master цены — инструмент `get_service_masters`, реестр — `tools/index.js` `catalogMode`. Сбой сборки блока → авто-откат в legacy-режим. Блок каталога обязан быть детерминированным (сортировка по yc_id) — иначе не работает префикс-кэш.

### «Отдел заботы» (care-программы)
Плановые касания после состоявшегося визита («как самочувствие», Т+N дней): салон описывает программу (условия И/ИЛИ по мастеру/категории/услуге — тот же `evaluateRule` из notifications) и цепочку касаний; текст каждого касания пишет Мила одним LLM-вызовом без инструментов.

- Таблицы (`migrations.js`): `care_programs` (conditions jsonb) → `care_touches` (delay_days, send_time, intent_text) → `care_enrollments` (статусы `active|completed|declined|escalated|superseded|stopped`) → `care_touch_sends` — очередь+журнал в одной таблице (статусы `scheduled|sent|skipped|cancelled|failed`). DELETE программы каскадом уносит enrollments и весь журнал.
- Зачисление (`services/care/enroll.js`, хук в `routes/webhook.js` на resource=record): визит состоялся = `attendance=1` ИЛИ `paid_full=1` — НЕ кэшбэчный критерий «оплачено деньгами»: визит с оплатой бонусами тоже заслуживает заботы. `classifyRecordEvent` ПЕРВЫМ проверяет un-enroll (`status='delete'` / `deleted` / `attendance=-1` — предоплаченная неявка несёт `paid_full=1` одновременно с `attendance=-1`) → гасит активные цепочки записи. Повторный подходящий визит supersede'ит прежний активный enrollment той же программы по ДАТЕ ВИЗИТА, а не по порядку вебхуков (правка старой записи может перевыстрелить вебхук годы спустя — без сравнения `visit_at` она глушила бы живую цепочку). Дедуп — UNIQUE (program_id, yclients_record_id); self-heal: ретрай вебхука дозаполняет касания enrollment'а, вставленного до падения процесса. Телефон нормализуется `normalizePhoneKey`, ЧС клиента блокирует зачисление.
- Воркер (`services/care/worker.js`, тик 15с, guard от наслоения тиков — медленный прогон не пускает следующий): LEASE_SQL арендует до 5 due-строк `FOR UPDATE SKIP LOCKED` + attempts при аренде; колонки касания берутся СКАЛЯРНЫМИ ПОДЗАПРОСАМИ в RETURNING — JOIN на цель UPDATE в PG запрещён («invalid reference to FROM-clause entry»), юнит-моки db.any валидность SQL не проверяют → после правок LEASE_SQL обязателен живой EXPLAIN на дев-БД (SQL экспортируется именно для этого). Порядок детерминированных проверок до LLM: enrollment активен → программа включена → env-гейт агента → `isAllowed` (ОБЩИЙ гейт Милы: ЧС/режим/расписание) → диалог не на операторе → анти-спам «1 касание в день» (сдвиг scheduled_at на +24ч от max(scheduled_at, now()), не skip) → повторный визит по условиям программы (fail-open при сбое YClients) → care-проход. Таймаут LLM 60с (< backoff аренды 120с); maxTokens — дефолт провайдера `AGENT_MAX_TOKENS` (инцидент 2026-08-03: ручной бюджет 1200 съедался reasoning-токенами gemini, JSON обрезался finish=length → `llm_no_json` и ВСЕ касания молча скипались).
- ФИКС 2026-08-03 (интеграционное ревью): env kill-switch (`CHATPUSH_AGENT_ENABLED`) выключен и гейт Милы вернул `reason='outside-schedule'` (окно расписания сузило допуск — оно проектировалось для ВХОДЯЩИХ, не для исходящих касаний) — оба случая ОТКЛАДЫВАЮТ касание на сутки тем же механизмом, что анти-спам (`deferTouch`: сдвиг scheduled_at, attempts=0), а НЕ терминальный skip: иначе цепочка молча сгорала бы навсегда (at-most-once, второго шанса нет), пока админ держит Милу выключенной на проде. Прочие причины гейта (whitelist/blacklist/disabled per-salon) — это «клиенту/салону нельзя», а не «сейчас нельзя», остаются терминальным skip как раньше. РЕШЕНИЕ: enrollment, остановленный эскалацией (`status='escalated'`), после «Вернуть боту» НЕ возобновляется — новая цепочка начнётся только со следующего подходящего визита.
- Доставка AT-MOST-ONCE (пропущенное касание дешевле дубля живому пациенту): mark-before-send — sent-маркер пишется ДО отправки условным `UPDATE … WHERE status='scheduled'`; условие — ФИНАЛЬНЫЙ гейт: арендованный enrollment_status в LIMIT-5 батче устаревает (stop_program по строке A уже отменил строку B того же enrollment). Флаги `delivered`/`terminalWritten` в catch: доставлено → статус НЕ откатывается никогда; терминальный skipped/cancelled записан → не перезаписывается; отправки не было → откат в scheduled с чисткой sent_at, после 3 попыток — failed. Любой терминальный исход последнего касания завершает enrollment (`maybeCompleteChain`) — иначе зомби-active в дашборде.
- care-проход: `buildCarePrompt` (`care-prompt.js`) — транскрипт и имя клиента КЛИЕНТ-КОНТРОЛИРУЕМЫ, всё проходит `sanitizeLine`/`sanitizeName` покомпонентно (перевод строки в сообщении пациента не может подделать реплику «Мила: …» отдельной строкой). `parseCareDecision` (`decision.js`) fail-safe: не-JSON / нестроковый `text` (массив коэрсился бы в правдоподобный текст) / пусто / >1500 символов / bidi-контролы → skip, не отправка. Действие `escalate` — осложнение в переписке: касание не шлём, диалог на оператора (зеркало `tools/escalate-to-operator.js`: upsert agent_dialogs + `emitAgentStatus`), эскалация ДО остановки цепочки — если упала, ретрай её повторит, а не потеряет. Ответы пациента на касание обрабатывает ОСНОВНОЙ агент (обычный вебхук-путь со всеми мед-границами); `rememberPending` подмешивает касание в транскрипт до эха Chatpush, для whatsapp — persist-on-send в chatpush_messages.
- API `/api/care` (`routes/care.js`, owner/admin; JWT-поля `req.user.salonId`/`userId` — НЕ `salon_id`!): programs CRUD+toggle, дашборд `GET /enrollments` (next_touch_at/last_sent_at), журнал `GET /enrollments/:id/sends` (LEFT JOIN care_touches — touch_id NULL после удаления касания из программы), `POST /enrollments/:id/stop`. Фронт — `frontend/js/pages/care.js` (страница «Забота»). Живые проверки: `scripts/care-e2e.js` (реальный LLM + РЕАЛЬНАЯ отправка на номер; чистка уносит sent-журнал каскадом, поэтому повторный прогон в тот же день отправит ещё раз — анти-спам свой прошлый прогон не увидит) и `scripts/care-ui-e2e.js` (UI).

## Key constraints

- **Webhook handler must respond 200 immediately** before any async processing — YClients retries on timeout.
- **Advisory locks** are used in `processRecordEvent` to prevent race conditions on duplicate webhook deliveries — do not remove them.
- **Cashback accrual rule** — бонусы начисляются **только** если визит оплачен полностью деньгами: без применения бонусов и без скидок. Если клиент использовал бонусы или скидку — кэшбэк не начисляется (`finances_operation` type check в loyalty service).
- **`db.one` vs `db.oneOrNone`** — both exist; `one` throws if not found, `oneOrNone` returns null. Use `oneOrNone` for lookups that may miss.
- **Timezone** — server runs TZ=Europe/Moscow. All date arithmetic must be Moscow-local. Use `AT TIME ZONE 'Europe/Moscow'` in SQL when comparing dates.
