# «Документы»: дашборд подписей, страница пациента, анкета и автоматизация — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Раздел «📄 Документы» открывается дашбордом карточек пациентов по записям: цвет карточки — состояние договора, согласия на обработку ПД и акта, зелёная — всё обязательное подписано. Клик ведёт на страницу пациента: данные для документов — свёрнутый блок, красный и пульсирующий, пока полей не хватает; карточки документов с выбором на подпись и ручной правкой (акт — строки и суммы). Пациент сам вносит паспорт по ссылке-анкете (мессенджер или QR у стойки), бумажные документы отмечаются со сканом, договоры нумеруются автоматически, рутинные отправки можно поручить автоматике (по умолчанию выключена).

**Architecture:** Все правила состояния, цвета, подписи и главного действия — в чистом `backend/services/edocs/board.js` (без БД и сети); SQL доски — `board-store.js`; ручки — новый роутер `routes/edocs-board.js`, смонтированный ДО общего `/api/edocs`; фронт только рисует ответ сервера. Анкета: `forms.js` + `forms-store.js`, доставка ссылки `form-delivery.js` (каскад мессенджеров автоуведомлений), публичный роутер `public-anketa.js` без JWT и страница `frontend/anketa.html`. Автоматика — крон `automation.js` с журналом `edoc_auto_jobs` (действие застолбляется до выполнения — at-most-once). Номер договора — `counter.js` (счётчик `edoc_counters`), бумага — `paper.js`, защита дева — `test-phones.js` (`EDOCS_TEST_PHONES`). Фронт: оболочка `edocs.js`, дашборд `edocs-board.js`, страница пациента `edocs-client.js`, помощники `edocs-helpers.js`.

**Tech Stack:** Node.js 22 / Express, `pg` без ORM, НОВАЯ зависимость `qrcode@^1.5.4` (QR-код ссылки анкеты рисует сервер — тот же пакет, что в шлюзе мессенджеров), `multer`, `sharp`, S3 (`services/s3.js`), Jest (`cd backend && npx jest backend/edocs-…`), фронт vanilla JS + `node --test`, puppeteer + системный Chrome для визуального стенда.

**Спека:** `docs/superpowers/specs/2026-10-25-edocs-board-design.md` (решения владельца — §2, уточнена по прототипу), макет — `docs/superpowers/specs/2026-10-25-edocs-board-mockup/`. Основа — модуль «Документы» (F.Doc) по `docs/superpowers/specs/2026-10-24-fdoc-esign-design.md`: он на деве (merge `c054ab7`), на проде нет; F.Doc на деве не подключён.

**Проверено при подготовке плана (25.10.2026).** Весь код плана собран в прототипе (ветка `proto/edocs-board`, `/root/loyalpro-edocs-proto`) и прогнан: `npx jest backend/edocs-` — 316 тестов в 16 наборах; `node --test frontend/js/pages/edocs.test.js` — 21 тест; новые операторы миграции, все новые запросы и обработчики ручек доски выполнены на дев-БД в откатываемой транзакции на настоящих записях (неделя — 67 карточек: 12 красных, 55 оранжевых; запросы 1–11 мс); визуальный стенд прошёл в headless Chrome (две темы, 390 px, окна правки, анкета пациента, роль кассира), скриншоты просмотрены глазами. Сам план тоже проверен: все его шаги («Создать», «Заменить целиком», «найти → заменить», «Дописать в конец») механически применены к чистой копии ветки — получившиеся файлы совпали с прототипом байт в байт, тесты в этой копии зелёные, ожидаемые выводы команд взяты из этого прогона. По пути пойманы и учтены ловушки: голый шаблон `npx jest edocs-` в рабочей копии `/root/loyalpro-edocs-board` гонит ВЕСЬ репозиторий (путь копии содержит «edocs») — путь теста пишется с `backend/`; в откатываемой транзакции `NOW()` — время начала транзакции, и «истекла секунду назад» не истекает; две анкеты с одинаковым `created_at` выбирались случайно (тай-брейк — активная первой); число в `escAttr` роняло окно настроек; глобальный стиль растягивает чекбоксы окон во всю ширину; поле поиска в тёмной теме было белым. НЕ проверено: электронная отправка, автоакт и повтор ссылки живьём (F.Doc на деве не подключён), доставка анкеты в мессенджер живьём — задача 19, только на тестовый номер.

**Ветка и рабочая копия:** ветка `feat/edocs-board` от `c054ab7` (ветка дева `feat/notifications-own-module` с модулем F.Doc), рабочая копия `/root/loyalpro-edocs-board` — там уже спека, макет, этот план и `node_modules`; `.env` копируется из основного дерева (он в `.gitignore`). Все команды — из `/root/loyalpro-edocs-board`, если не сказано иное. На дев — слиянием в `feat/notifications-own-module` (задача 19, стоп-точка). Прод — вне плана: отдельное решение владельца вместе с самим модулем «Документы».

**Коммиты:** трейлер `Co-Authored-By` — модель, которая фактически выполняла задачу (в командах — исполнитель по раскладке ниже; при исполнении в основной сессии — её модель).

**Раскладка по моделям** (правило из памяти: механика — Sonnet, связное ядро — Opus, контрольные точки — основная сессия; Haiku не влезает в контекст репозитория). Код в задачах дан целиком и уже проверен, поэтому задачи — в основном перенос и прогон; Opus стоит там, где ошибка переноса дорогая: правила доски, деньги/номера, отправки живым пациентам, публичные ручки, большая связная страница. Дешевле всего — исполнение в основной сессии с механическим переносом блоков: применитель, которым проверялся план, лежит вне репозитория (`/root/plan-gen/apply.py <план> <копия> --task N`) и падает на любом неоднозначном фрагменте.

| Задача | Модель | Почему |
|---|---|---|
| 0. Рабочая копия и `qrcode` | Sonnet | команды |
| 1. Схема данных и переменные окружения | Sonnet | DDL по образцу, живой прогон SQL |
| 2. Правила дашборда `board.js` | Opus | ядро: состояния, цвета, подписи, действия |
| 3. Нумерация договоров | Opus | транзакция, гонки, приоритет номера |
| 4. Комплекты: вид, источник, номер, тестовые номера, опрос | Opus | правки рабочей отправки в F.Doc |
| 5. «Подписано на бумаге» | Sonnet | готовый модуль и тесты |
| 6. Доставка анкеты в мессенджер | Sonnet | готовый модуль, каскад по образцу уведомлений |
| 7. SQL доски и анкет | Opus | SQL без юнит-тестов (проверка — задача 12) |
| 8. Анкета пациента | Opus | публичная сторона, токены, ПДн |
| 9. Автоматика | Opus | at-most-once, отправки живым пациентам |
| 10. HTTP-ручки | Opus | роли, ручки без JWT, лимиты |
| 11. Страница анкеты | Sonnet | статическая страница |
| 12. Живая проверка SQL и ручек | Sonnet | скрипт, дев-БД, ROLLBACK |
| 13. Контрольная точка A | основная сессия | ревью бэкенда, полный jest против базы |
| 14. Фронт: оболочка, дашборд, страница пациента | Opus | большая связная часть в одной глобальной области |
| 15. Стили | Sonnet | блок CSS |
| 16. Визуальный стенд | Sonnet | готовый скрипт, скриншоты |
| 17. Контрольная точка B | основная сессия | скриншоты, тесты фронта |
| 18. Документация | Sonnet | текст дан |
| 19. Слияние в дев и живая проверка | основная сессия + стоп-точка | общая рабочая копия, рестарт дева |
| 20. Итоговое ревью и память | основная сессия | приёмка, отчёт владельцу |

**Порядок:** строго 0 → 20. Часть A — бэкенд (0–13), B — фронт (14–17), C — документация, дев, приёмка (18–20). Исполнение по одной задаче, короткий отчёт в чат после каждой, без фоновых агентов (предпочтение пользователя). Перед запуском исполнителей и перед задачей 19 контроллер вызывает `ListAgents`: другая сессия может работать в `/root/loyalpro` (там сейчас чужие незакоммиченные правки — их не трогать).

---

## Карта файлов

Создаются (бэкенд):
- `backend/services/edocs/board.js` — ЧИСТЫЕ правила: состояние вида документа, нужен ли акт, карточка «пациент × день» (цвет, подпись, плитки, главное действие, предупреждения), доска, периоды, сводка, страница пациента.
- `backend/services/edocs/counter.js` — номер договора: данные пациента → поле YClients → счётчик `edoc_counters`.
- `backend/services/edocs/test-phones.js` — `EDOCS_TEST_PHONES`: отправки пациентам только на разрешённые номера.
- `backend/services/edocs/paper.js` — «Подписано на бумаге»: комплект `paper`, скан в S3, снятие отметки, ссылка на скан.
- `backend/services/edocs/form-delivery.js` — ссылка анкеты в мессенджер каскадом автоуведомлений.
- `backend/services/edocs/board-store.js` — SQL доски и страницы пациента (без расшифровки паспорта).
- `backend/services/edocs/forms-store.js` — SQL анкет (`edoc_patient_forms`).
- `backend/services/edocs/forms.js` — анкета: создание, ссылка и QR, повтор, отзыв, публичный просмотр, приём, фото паспорта.
- `backend/services/edocs/automation-store.js` — выборки автоматики и журнал `edoc_auto_jobs`.
- `backend/services/edocs/automation.js` — крон: перед визитом, акт после оплаты, повторы, устаревание анкет.
- `backend/routes/edocs-board.js` — `/api/edocs`: доска, «Вся база», страница пациента, бумага, анкеты администратора.
- `backend/routes/public-anketa.js` — `/anketa/:token` и `/api/public/anketa/…` без JWT.
- `backend/scripts/edocs-board-smoke.js` — живая проверка SQL и ручек на дев-БД в откатываемой транзакции, `--explain`.
- Тесты: `backend/edocs-board.test.js`, `edocs-counter.test.js`, `edocs-paper.test.js`, `edocs-form-delivery.test.js`, `edocs-forms.test.js`, `edocs-automation.test.js`, `edocs-board-routes.test.js`.

Создаются (фронт):
- `frontend/js/pages/edocs-board.js` — дашборд и «Вся база».
- `frontend/js/pages/edocs-client.js` — страница пациента и её окна (правка акта и документа, бумага, анкета пациента).
- `frontend/anketa.html`, `frontend/js/anketa.js` — публичная анкета пациента.

Меняются:
- `backend/migrations.js` — `EDOCS_BOARD_DDL` (вне функции, экспортируется).
- `backend/config.js` — `EDOCS_TEST_PHONES`, `EDOCS_PUBLIC_URL`.
- `backend/services/edocs/placeholders.js` — `missingFor(…, { autoContractNo })`.
- `backend/services/edocs/store.js` — `insertPackage` (статус, источник, дата подписи, вид документа), `revokePaperPackage`, быстрая полоса `DUE_SQL`, колонки настроек.
- `backend/services/edocs/packages.js` — автонумерация, вид документа, источник, тестовые номера.
- `backend/routes/edocs-admin.js` — `GET/PUT /automation`, `parseAutomation`.
- `backend/routes/edocs.js` — `source` и `paper` в ответе комплекта.
- `backend/routes/index.js` — монтаж `public-anketa` (до проверки `/api`) и `edocs-board` (до общего `/api/edocs`).
- `backend/server.js` — опрос F.Doc раз в минуту, крон автоматики.
- `backend/scripts/edocs-store-smoke.js` — применяет `EDOCS_BOARD_DDL` в своей транзакции.
- `backend/scripts/edocs-visual.js` — переписан под дашборд, страницу пациента и анкету.
- `backend/edocs-packages.test.js` — вид документа, источник, номер договора, тестовые номера.
- `backend/package.json`, `backend/package-lock.json` — `qrcode`.
- `frontend/js/pages/edocs-helpers.js` — справочники подписей, адреса `#edocs/…`, помощники дашборда.
- `frontend/js/pages/edocs.js` — оболочка раздела, список и карточка комплекта, настройки и окно автоматизации, встройки (переписан; мастер «Оформить» уходит).
- `frontend/js/pages/edocs.test.js` — переписан.
- `frontend/index.html` — вкладки, контейнеры, шесть окон, скрипты с новым `?v=`.
- `frontend/css/features.css` — блок `edb-`/`edc-`.
- `CLAUDE.md` — раздел о модуле.

## Общие формы данных

Карточка дашборда — элемент `cards[]` ответа `GET /api/edocs/board` (считает `board.buildCard`, фронт только рисует):

```js
{
  key: '52:2026-10-25', clientId: 52, name: 'Тестова Анна Сергеевна', initials: 'ТА', phone: '79001234567',
  day: '2026-10-25', time: '10:30', visitAt: '2026-10-25T07:30:00.000Z', services: ['Биоревитализация'], staffName: 'Гаджиева Пери',
  visits: [{ recordId: 30252, time: '10:30', visitAt: '…', services: ['…'], staffName: '…', arrived: false, paid: false, act: { state: 'later' } }],
  docs: { contract: { state: 'signed', at: '…', paper: false, packageId: '…' }, consent_pd: { state: 'missing' }, act: { state: 'later' } },
  tiles: { contract: { text: '✓ 03.07', tone: 'ok' }, consent_pd: { text: 'нет', tone: 'no' }, act: { text: 'после визита', tone: 'na' } },
  color: 'red',                 // red | amber | blue | green | grey
  label: 'Нужно до визита',
  data: { exists: true, complete: false, missing: [{ key: 'passport_series', label: 'Серия паспорта' }] },
  form: null,                   // { id, status, createdAt, deliveredVia, deliveredAt, openedAt, submittedAt, packageId, error }
  action: { type: 'fill', label: 'Заполнить данные', form: true },  // send {kinds, recordId} | fill | remind {packageId, availableAt} | form_remind {formId} | null
  warnings: ['⏱ Первичный · через 40 мин', 'Нет данных: серия паспорта, номер паспорта'], hint: 'Данные неполные',
  tags: ['no_consent'],         // no_contract | no_consent | act | waiting | ready — для чипов
  firstVisit: true, arrived: false,
}
```

Состояние вида (`kindState`): `signed` (в том числе бумага) | `pending` | `problem` (`reason`: `fdoc_error` | `not_sent`) | `lapsed` (`reason`: `declined` | `expired` | `annulled`) | `missing`; у акта ещё `later` | `unpaid` | `off` (нет шаблона или визит до `acts_required_from`). «Плохие» — `missing`, `lapsed`, `problem`.

Ответ `GET /api/edocs/board?range=today|tomorrow|week|open`: `{ now, today, range, rangeCounts: {today, tomorrow, week, open}, summary: {total, red, amber, blue, green, grey}, chips: {all, no_contract, no_consent, act, waiting, ready}, cards, kinds: {contract|consent_pd|act: {id, title} | null}, module: {enabled, configured, encReady, me: {connected, broken}}, automation: {previsit: {on, hours, scope, form}, act: {on, delayMin}, remind: {on, hours}, senderName}, warnings: [{code: 'no_template', kind} | {code: 'org_missing', fields}], actsRequiredFrom }`.

Ответ `GET /api/edocs/clients/:id/page` — результат `board.buildClientPage` (`client`, `header` с `steps`, `data: {exists, complete, missing, required}`, `docs`, `visits`, `focusRecordId`, `form`, `warnings`, `kinds`) плюс `today`, `numbering: {auto, contractNo, yclientsNo, next}`, `identity` (сводка без шифротекста), `templates`, `packages`, `events`. Паспорт эта ручка не расшифровывает — расшифровку делает существующий `GET /clients/:id/identity` при раскрытии блока данных (с записью в журнал).

Настройки автоматики (`GET/PUT /api/edocs/admin/automation`): `{ senderUserId, previsit: {on, hours 2–168, scope 'first'|'all', form}, act: {on, delayMin 5–240}, remind: {on, hours 1–48}, formMessage (с {ссылка}), formTtlDays 1–30, contractAutonumber, contractNextNo, actsRequiredFrom }`.

## Часть A. Бэкенд

### Task 0: Рабочая копия и зависимость `qrcode` — **Sonnet**

Ветка `feat/edocs-board` уже создана от `c054ab7` в `/root/loyalpro-edocs-board`: в ней спека, макет и этот план. Здесь — `.env`, новая зависимость `qrcode` (QR-код ссылки анкеты рисует сервер и отдаёт data URL) и базовый прогон тестов модуля, с которым сравниваются следующие задачи.

- [ ] **Step 1: Проверить рабочую копию**

```bash
cd /root/loyalpro-edocs-board && git status --short && git log --oneline -3
```

Ожидается: пустой `status`; последние коммиты — план и спека (`docs(edocs): …`).

- [ ] **Step 2: Окружение и зависимости**

```bash
cd backend
cp /root/loyalpro/backend/.env .env                       # в .gitignore; нужен скриптам с БД (задачи 1, 4, 12)
PUPPETEER_SKIP_DOWNLOAD=1 npm ci --no-audit --no-fund     # в git лежит лишь часть node_modules; Chrome системный
npm install --no-audit --no-fund qrcode@^1.5.4
node -e "require('qrcode').toDataURL('x').then((u) => console.log(u.slice(0, 22)))"
git -C /root/loyalpro-edocs-board status --short
```

Ожидается: `data:image/png;base64,`; в статусе только `M backend/package.json` и `M backend/package-lock.json` (`.env` игнорируется). В `package.json` появилась строка `"qrcode": "^1.5.4",` между `puppeteer` и `sharp`.

- [ ] **Step 3: Базовый прогон тестов модуля**

```bash
cd backend && npx jest backend/edocs- 2>&1 | grep -E "^(Tests|Test Suites):"; cd .. && node --test frontend/js/pages/edocs.test.js 2>&1 | grep -E "^# (pass|fail)"
```

Ожидается: `Test Suites: 9 passed, 9 total`, `Tests: 216 passed, 216 total`; фронт — `# pass 17`, `# fail 0`.

- [ ] **Step 4: Коммит**

```bash
git add backend/package.json backend/package-lock.json
git commit -m "chore(edocs): зависимость qrcode для QR-кода анкеты пациента" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

### Task 1: Схема данных и переменные окружения — **Sonnet**

Все операторы — массив `EDOCS_BOARD_DDL` ВНЕ `runMigrations`: его же применяют в откатываемой транзакции проверочные скрипты (`edocs-store-smoke.js` — здесь, `edocs-board-smoke.js` — в задаче 12), так что новые запросы проверяются на настоящей схеме до выката. Только `IF NOT EXISTS`, ничего не удаляется (спека §10):
- `edoc_documents.kind` + заполнение из шаблонов — состояние «договор подписан» считается по виду ДОКУМЕНТА (в одном комплекте бывают договор и акт), и у документа удалённого потом шаблона вид не теряется;
- `edoc_packages.source` (`manual|auto|form|paper`);
- 13 колонок `edoc_settings` — автоматика (по умолчанию выключена, решение 3), анкета, автонумерация (по умолчанию включена, решение 6), `acts_required_from DATE DEFAULT CURRENT_DATE` — у существующей строки станет датой миграции, это и есть «акты обязательны с выката» (решение 9);
- таблицы `edoc_counters`, `edoc_auto_jobs` (UNIQUE `(salon_id, kind, ref)` — застолбление действия), `edoc_patient_forms` (в БД sha256 токена и его шифротекст, частичный уникальный индекс «одна активная анкета на пациента»).

Переменные: `EDOCS_TEST_PHONES` (решение 17: если задан — ЛЮБЫЕ отправки пациентам из модуля только на эти номера; дев получает реальные вебхуки клиники и держит боевые аккаунты мессенджеров) и `EDOCS_PUBLIC_URL` (адрес ссылки анкеты: у крона автоматики нет запроса, из которого его взять).

**Files:**
- Modify: `backend/migrations.js`, `backend/config.js`, `backend/scripts/edocs-store-smoke.js`

- [ ] **Step 1: `migrations.js`: цикл по `EDOCS_BOARD_DDL` в конце `runMigrations` и сам массив**

В `backend/migrations.js` найти:

```js
  await client.query(`CREATE INDEX IF NOT EXISTS idx_edoc_events_client ON edoc_events (salon_id, client_id, created_at DESC) WHERE client_id IS NOT NULL`).catch(() => {});
}

module.exports = { runMigrations };
```

заменить на:

```js
  await client.query(`CREATE INDEX IF NOT EXISTS idx_edoc_events_client ON edoc_events (salon_id, client_id, created_at DESC) WHERE client_id IS NOT NULL`).catch(() => {});

  // ── «Документы»: дашборд, анкета пациента, автоматика — операторы в EDOCS_BOARD_DDL (ниже, вне функции:
  // scripts/edocs-board-smoke.js гоняет их в откатываемой транзакции).
  for (const sql of EDOCS_BOARD_DDL) await client.query(sql).catch(() => {});
}

// ── «Документы»: дашборд, анкета пациента, автоматика (спека
// docs/superpowers/specs/2026-10-25-edocs-board-design.md §10). Только IF NOT EXISTS.
//  • Вид документа хранится в самой строке: у шаблона, удалённого позже, вид не теряется, а состояние
//    «договор подписан» считается по виду документа, а не комплекта (в одном комплекте бывают договор и акт).
//  • Автоматика по умолчанию выключена (решение владельца 25.10.2026). acts_required_from — с какой даты
//    визитам нужен акт: у существующей строки станет датой миграции, то есть датой выката, иначе каждый
//    прошлый визит без акта стал бы красным.
//  • edoc_counters: next_value — номер, который получит следующий договор.
//  • edoc_auto_jobs: строка «застолбляет» действие ДО его выполнения (UNIQUE) — at-most-once, как в
//    «Заботе» и уведомлениях: повтора не бывает, неудача остаётся с причиной.
//  • edoc_patient_forms: анкета по публичной ссылке; в БД — sha256 токена (поиск) и его шифротекст
//    (показать QR и переотправить ту же ссылку); сам токен в логи и журнал не пишется.
const EDOCS_BOARD_DDL = [
  'ALTER TABLE edoc_documents ADD COLUMN IF NOT EXISTS kind VARCHAR(20)',
  'UPDATE edoc_documents d SET kind = t.kind FROM edoc_templates t WHERE d.template_id = t.id AND d.kind IS NULL',
  "ALTER TABLE edoc_packages ADD COLUMN IF NOT EXISTS source VARCHAR(20) NOT NULL DEFAULT 'manual'",
  ...[
    'auto_sender_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL',
    'auto_previsit BOOLEAN NOT NULL DEFAULT FALSE',
    'auto_previsit_hours INTEGER NOT NULL DEFAULT 24',
    "auto_previsit_scope VARCHAR(10) NOT NULL DEFAULT 'first'",
    'auto_previsit_form BOOLEAN NOT NULL DEFAULT TRUE',
    'auto_act BOOLEAN NOT NULL DEFAULT FALSE',
    'auto_act_delay_min INTEGER NOT NULL DEFAULT 15',
    'auto_remind BOOLEAN NOT NULL DEFAULT FALSE',
    'auto_remind_hours INTEGER NOT NULL DEFAULT 2',
    'form_message TEXT',
    'form_ttl_days INTEGER NOT NULL DEFAULT 7',
    'contract_autonumber BOOLEAN NOT NULL DEFAULT TRUE',
    'acts_required_from DATE DEFAULT CURRENT_DATE',
  ].map((col) => `ALTER TABLE edoc_settings ADD COLUMN IF NOT EXISTS ${col}`),
  `CREATE TABLE IF NOT EXISTS edoc_counters (
    salon_id   INTEGER NOT NULL REFERENCES salons(id) ON DELETE CASCADE,
    kind       VARCHAR(20) NOT NULL,
    next_value BIGINT NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (salon_id, kind)
  )`,
  `CREATE TABLE IF NOT EXISTS edoc_auto_jobs (
    id         BIGSERIAL PRIMARY KEY,
    salon_id   INTEGER NOT NULL REFERENCES salons(id) ON DELETE CASCADE,
    kind       VARCHAR(20) NOT NULL,
    ref        VARCHAR(64) NOT NULL,
    client_id  INTEGER,
    record_id  INTEGER,
    package_id UUID,
    form_id    UUID,
    status     VARCHAR(20) NOT NULL DEFAULT 'claimed',
    reason     VARCHAR(300),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (salon_id, kind, ref)
  )`,
  'CREATE INDEX IF NOT EXISTS idx_edoc_auto_jobs_client ON edoc_auto_jobs (salon_id, client_id, created_at DESC)',
  `CREATE TABLE IF NOT EXISTS edoc_patient_forms (
    id              UUID PRIMARY KEY,
    salon_id        INTEGER NOT NULL REFERENCES salons(id) ON DELETE CASCADE,
    client_id       INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    record_id       INTEGER REFERENCES records(id) ON DELETE SET NULL,
    token_hash      VARCHAR(64) NOT NULL,
    token_enc       TEXT NOT NULL,
    status          VARCHAR(20) NOT NULL DEFAULT 'active',
    fields          JSONB NOT NULL DEFAULT '[]'::jsonb,
    kinds           JSONB NOT NULL DEFAULT '[]'::jsonb,
    send_docs       BOOLEAN NOT NULL DEFAULT FALSE,
    sender_user_id  INTEGER REFERENCES users(id) ON DELETE SET NULL,
    source          VARCHAR(20) NOT NULL DEFAULT 'manual',
    created_by      INTEGER REFERENCES users(id) ON DELETE SET NULL,
    expires_at      TIMESTAMPTZ NOT NULL,
    delivered_via   VARCHAR(20),
    delivered_at    TIMESTAMPTZ,
    opened_at       TIMESTAMPTZ,
    submitted_at    TIMESTAMPTZ,
    submit_attempts INTEGER NOT NULL DEFAULT 0,
    recognize_count INTEGER NOT NULL DEFAULT 0,
    consent         JSONB,
    package_id      UUID,
    last_error      VARCHAR(500),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  'CREATE UNIQUE INDEX IF NOT EXISTS idx_edoc_forms_token ON edoc_patient_forms (token_hash)',
  'CREATE INDEX IF NOT EXISTS idx_edoc_forms_client ON edoc_patient_forms (salon_id, client_id, created_at DESC)',
  "CREATE UNIQUE INDEX IF NOT EXISTS idx_edoc_forms_active ON edoc_patient_forms (client_id) WHERE status = 'active'",
];

module.exports = { runMigrations, EDOCS_BOARD_DDL };
```

- [ ] **Step 2: `config.js`: две переменные рядом с `EDOCS_DEMO_PHONES`**

В `backend/config.js` найти:

```js
  EDOCS_DEMO_PHONES: (process.env.EDOCS_DEMO_PHONES || '79200255591').split(',').map((s) => s.replace(/\D/g, '')).filter(Boolean),

  // Sync
```

заменить на:

```js
  EDOCS_DEMO_PHONES: (process.env.EDOCS_DEMO_PHONES || '79200255591').split(',').map((s) => s.replace(/\D/g, '')).filter(Boolean),
  // Если задан — ЛЮБЫЕ отправки пациентам из «Документов» (комплекты F.Doc, повторы ссылок, анкеты в
  // мессенджер, ручные и автоматические) уходят только на эти номера. Дев: получает реальные вебхуки
  // клиники и держит боевые аккаунты мессенджеров. Прод: НЕ задавать. Через запятую, канон 7XXXXXXXXXX.
  EDOCS_TEST_PHONES: (process.env.EDOCS_TEST_PHONES || '').split(',').map((s) => s.replace(/\D/g, '')).filter(Boolean),
  // Адрес, по которому пациент открывает анкету (`<адрес>/anketa/<токен>`), без «/» в конце.
  // Нужен автоматике: у крона нет запроса, из которого взять адрес.
  EDOCS_PUBLIC_URL: (process.env.EDOCS_PUBLIC_URL || '').trim().replace(/\/+$/, ''),

  // Sync
```

- [ ] **Step 3: `edocs-store-smoke.js`: новые колонки в той же транзакции**

`insertPackage` из задачи 4 пишет новые колонки, а миграция на дев-БД могла ещё не пройти — скрипт накатывает `EDOCS_BOARD_DDL` (без `REFERENCES`) в своей откатываемой транзакции.

В `backend/scripts/edocs-store-smoke.js` найти:

```js
    }
    await run(client);
```

заменить на:

```js
    }
    // Колонки дашборда (вид документа, источник комплекта, настройки автоматики) — в той же транзакции:
    // insertPackage их пишет, а миграция на этой БД могла ещё не пройти. IF NOT EXISTS — повтор безвреден.
    for (const sql of require('../migrations').EDOCS_BOARD_DDL) await client.query(sql.replace(REF_RE, ''));
    await run(client);
```

- [ ] **Step 4: Модуль миграций и конфиг грузятся**

```bash
cd backend && node -e "const m = require('./migrations'); console.log(m.EDOCS_BOARD_DDL.length, typeof m.runMigrations)" && node -e "const c = require('./config'); console.log(JSON.stringify([c.EDOCS_TEST_PHONES, c.EDOCS_PUBLIC_URL]))"
```

Ожидается: `23 function` и `[[],""]` (в `.env` рабочей копии переменных ещё нет).

- [ ] **Step 5: Живой прогон SQL «Документов» на дев-БД (транзакция откатывается)**

```bash
cd backend && node scripts/edocs-store-smoke.js 2>&1 | tail -2
```

Ожидается: последняя строка — `SQL «Документов» в порядке (транзакция откатывается)`.

- [ ] **Step 6: Коммит**

```bash
git add backend/migrations.js backend/config.js backend/scripts/edocs-store-smoke.js
git commit -m "feat(edocs): схема дашборда, анкеты и автоматики; EDOCS_TEST_PHONES, EDOCS_PUBLIC_URL" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

### Task 2: Правила дашборда — `board.js` — **Opus**

Сердце работы — чистый модуль без БД и сети (спека §3). Фронт ничего не вычисляет и только рисует ответ — цвет и подпись не могут разъехаться между сервером и браузером. Время — по Москве (`Intl` с `Europe/Moscow`), дни — строки `YYYY-MM-DD`.
- `kindState` (§3.2): подписанный документ (в том числе на бумаге) побеждает любой новый неудачный комплект; иначе решает последний по созданию; черновик без ошибки моложе 5 минут — «отправка идёт», старше или с ошибкой — «не ушло»; незнакомый статус — как ждущий (не терять из виду).
- `actPhase`: акт нужен, когда пациент пришёл (`attendance 1`) И визит оплачен полностью (`paid_full 1`), и не раньше `acts_required_from` (решения 8–9).
- `buildCard` (§3.4–3.5): карточка = пациент × день. Красный — акт нужен и «плохой», или договор/согласие «плохие» и визит срочный (день прошёл, пациент пришёл, до начала ≤ 2 часов — ровно 2 часа уже срочно); оранжевый — «плохие», визит позже; синий — что-то ждёт подписи или у пациента активная анкета; зелёный — всё нужное подписано; серый — шаблонов нет. Анкета у пациента переводит оранжевый в синий «Ждём анкету»; просроченная — снова «нужно» с предупреждением. Главное действие: «Отправить N док.» (данных хватает), «Заполнить данные» (не хватает), «Отправить акт», «Отправить снова», «Повторить ссылку» (не раньше 15 минут после отправки — `availableAt`), «Повторить анкету». Две записи в день — одна карточка, худший акт, акт отправляется по неподписанной записи. Предупреждения — первичный визит, недостающие поля, ошибка отправки, судьба анкеты, итог автоматики.
- `buildBoard`, `rangeBounds`/`windowBounds`/`sliceRange`/`rangeCounts`/`summarize`: окно выборки покрывает все периоды сразу, поэтому счётчики периодов считаются тем же правилом; «Незакрытые» — прошлые 30 дней, не раньше `acts_required_from`, только не зелёные; порядок — по дню, затем красные → оранжевые → синие → зелёные, затем по времени.
- `buildClientPage` (§5) строит страницу пациента теми же правилами (через `buildBoard`): шапка с четырьмя шагами, полнота данных и обязательные поля, визиты с актами, визит в фокусе.

Попутно `placeholders.missingFor` получает опцию `autoContractNo`: при автонумерации номер договора недостающим не считается (§3.3, §9).

**Files:**
- Create: `backend/services/edocs/board.js`
- Modify: `backend/services/edocs/placeholders.js`
- Test: `backend/edocs-board.test.js`

- [ ] **Step 1: Падающий тест**

Создать `backend/edocs-board.test.js`:

```js
'use strict';
// Состояния документов и цвет карточки дашборда (services/edocs/board.js — чистый модуль).
const b = require('./services/edocs/board');

const NOW = Date.parse('2026-10-25T10:00:00+03:00');
const TODAY = '2026-10-25';
const at = (s) => new Date(Date.parse(s)).toISOString();

const T = {
  contract: { id: 5, kind: 'contract', title: 'Договор', is_active: true, sort_order: 0, placeholders: ['fio', 'passport', 'address', 'contract_no'] },
  consent: { id: 6, kind: 'consent_pd', title: 'Согласие ПД', is_active: true, sort_order: 1, placeholders: ['fio', 'phone'] },
  act: { id: 7, kind: 'act', title: 'Акт', is_active: true, sort_order: 2, placeholders: ['fio', 'services', 'total_sum'] },
};
const TEMPLATES = [T.contract, T.consent, T.act];
const FULL_ID = { client_id: 52, last_name: 'Иванова', first_name: 'Анна', middle_name: null, phone: '79200255591', contract_no: '1859', secure_fields: ['passport_series', 'passport_number', 'address'] };
const NO_PASSPORT = { ...FULL_ID, secure_fields: [] };

function rec(over = {}) {
  return {
    id: 100, client_id: 52, client_name: 'Иванова Анна Сергеевна', client_phone: '+79200255591', visit_date: TODAY,
    visit_at: at('2026-10-25T10:40:00+03:00'), attendance: '0', paid_full: '0', has_prior_visit: false,
    services: [{ title: 'Биоревитализация' }], staff: { name: 'Гаджиева Пери' }, ...over,
  };
}
function doc(kind, status, over = {}) {
  return { client_id: 52, package_id: over.package_id || `p-${kind}-${status}`, package_status: status, kind, record_id: null,
    created_at: at('2026-10-25T09:00:00+03:00'), sent_at: at('2026-10-25T09:00:00+03:00'), signed_at: null, last_error: null, source: 'manual', ...over };
}
function board(records, { docs = [], identity = null, forms = [], notes = [], templates = TEMPLATES, settings = { actsRequiredFrom: '2026-10-01', autonumber: true } } = {}) {
  const identities = new Map(identity ? [[52, identity]] : []);
  return b.buildBoard({ records, docs, identities, templates, requisites: {}, forms, notes, settings, nowMs: NOW, today: TODAY });
}
const one = (records, opts) => { const r = board(records, opts); expect(r.cards).toHaveLength(1); return r.cards[0]; };

describe('kindState', () => {
  test('нет комплектов — missing; подписанный побеждает более новый неудачный', () => {
    expect(b.kindState([], 'contract', { nowMs: NOW })).toEqual({ state: 'missing' });
    const docs = [
      doc('contract', 'signed', { created_at: at('2026-07-03T12:00:00+03:00'), signed_at: at('2026-07-03T12:05:00+03:00') }),
      doc('contract', 'expired', { created_at: at('2026-10-20T12:00:00+03:00') }),
    ];
    expect(b.kindState(docs, 'contract', { nowMs: NOW })).toMatchObject({ state: 'signed', at: at('2026-07-03T12:05:00+03:00'), paper: false });
    expect(b.kindState([doc('contract', 'paper')], 'contract', { nowMs: NOW })).toMatchObject({ state: 'signed', paper: true });
  });

  test('последний неподписанный решает: sent → pending, error → problem, отказ/срок/аннулирован → lapsed', () => {
    expect(b.kindState([doc('consent_pd', 'sent')], 'consent_pd', { nowMs: NOW })).toMatchObject({ state: 'pending', packageId: 'p-consent_pd-sent' });
    expect(b.kindState([doc('consent_pd', 'error', { last_error: 'ERROR_SIGN' })], 'consent_pd', { nowMs: NOW })).toMatchObject({ state: 'problem', reason: 'fdoc_error' });
    for (const st of ['declined', 'expired', 'annulled']) {
      expect(b.kindState([doc('consent_pd', st)], 'consent_pd', { nowMs: NOW })).toMatchObject({ state: 'lapsed', reason: st });
    }
    const older = doc('consent_pd', 'expired', { created_at: at('2026-10-20T09:00:00+03:00') });
    expect(b.kindState([older, doc('consent_pd', 'sent')], 'consent_pd', { nowMs: NOW }).state).toBe('pending');
  });

  test('черновик: моложе 5 минут без ошибки — отправка идёт; с ошибкой или старше — не ушло', () => {
    const young = doc('contract', 'draft', { created_at: new Date(NOW - 60000).toISOString(), sent_at: null });
    expect(b.kindState([young], 'contract', { nowMs: NOW }).state).toBe('pending');
    expect(b.kindState([{ ...young, last_error: 'F.Doc 400' }], 'contract', { nowMs: NOW })).toMatchObject({ state: 'problem', reason: 'not_sent', error: 'F.Doc 400' });
    const stale = { ...young, created_at: new Date(NOW - 10 * 60000).toISOString() };
    expect(b.kindState([stale], 'contract', { nowMs: NOW })).toMatchObject({ state: 'problem', reason: 'not_sent' });
  });

  test('акт считается только по своей записи', () => {
    const docs = [doc('act', 'signed', { record_id: 100 }), doc('act', 'sent', { record_id: 101 })];
    expect(b.kindState(docs, 'act', { recordId: 100, nowMs: NOW }).state).toBe('signed');
    expect(b.kindState(docs, 'act', { recordId: 101, nowMs: NOW }).state).toBe('pending');
    expect(b.kindState(docs, 'act', { recordId: 102, nowMs: NOW }).state).toBe('missing');
  });
});

test('actPhase: не пришёл — later; пришёл и оплатил — required; не оплатил — unpaid; до старта актов — before_start', () => {
  expect(b.actPhase({ attendance: '0', paid_full: '1', visit_date: TODAY }, '2026-10-01')).toBe('later');
  expect(b.actPhase({ attendance: '1', paid_full: '1', visit_date: TODAY }, '2026-10-01')).toBe('required');
  expect(b.actPhase({ attendance: '1', paid_full: '0', visit_date: TODAY }, '2026-10-01')).toBe('unpaid');
  expect(b.actPhase({ attendance: '1', paid_full: '1', visit_date: '2026-09-30' }, '2026-10-01')).toBe('before_start');
  expect(b.actPhase({ attendance: '1', paid_full: '1', visit_date: '2026-09-30' }, null)).toBe('required');
});

describe('цвет, подпись, действие', () => {
  test('первичный через 40 минут без документов и паспорта — красный «Нужно до визита», «Заполнить данные»', () => {
    const c = one([rec()], { identity: NO_PASSPORT });
    expect(c).toMatchObject({ color: 'red', label: 'Нужно до визита', time: '10:40', firstVisit: true });
    expect(c.action).toEqual({ type: 'fill', label: 'Заполнить данные', form: true });
    expect(c.tiles).toEqual({ contract: { text: 'нет', tone: 'no' }, consent_pd: { text: 'нет', tone: 'no' }, act: { text: 'после визита', tone: 'na' } });
    expect(c.data.complete).toBe(false);
    expect(c.data.missing.map((x) => x.key)).toEqual(['address', 'passport_number', 'passport_series']);
    expect(c.warnings[0]).toBe('⏱ Первичный · через 40 мин');
    expect(c.warnings[1]).toBe('Нет данных: адрес регистрации, номер паспорта, серия паспорта');
    expect(c.hint).toBe('Данные неполные');
    expect(c.tags).toEqual(['no_contract', 'no_consent']);
  });

  test('данные есть — «Отправить 2 док.» с видами; один вид — его название', () => {
    expect(one([rec()], { identity: FULL_ID }).action).toEqual({ type: 'send', kinds: ['contract', 'consent_pd'], recordId: null, label: 'Отправить 2 док.' });
    const c = one([rec()], { identity: FULL_ID, docs: [doc('contract', 'signed')] });
    expect(c.action).toEqual({ type: 'send', kinds: ['consent_pd'], recordId: null, label: 'Отправить согласие' });
  });

  test('визит позже сегодня — оранжевый «Нужно до 16:30», завтра — «Нужно до 26.10»', () => {
    const later = one([rec({ visit_at: at('2026-10-25T16:30:00+03:00') })], { identity: FULL_ID });
    expect(later).toMatchObject({ color: 'amber', label: 'Нужно до 16:30' });
    expect(later.tiles.contract).toEqual({ text: 'нет', tone: 'soon' });
    const tomorrow = one([rec({ visit_date: '2026-10-26', visit_at: at('2026-10-26T11:00:00+03:00') })], { identity: FULL_ID });
    expect(tomorrow).toMatchObject({ color: 'amber', label: 'Нужно до 26.10' });
  });

  test('ровно 2 часа до начала — уже срочно', () => {
    expect(one([rec({ visit_at: at('2026-10-25T12:00:00+03:00') })], { identity: FULL_ID }).color).toBe('red');
    expect(one([rec({ visit_at: at('2026-10-25T12:01:00+03:00') })], { identity: FULL_ID }).color).toBe('amber');
  });

  test('пришёл и оплатил, договор и согласие есть, акта нет — «Акт не подписан», отправка акта по записи', () => {
    const docs = [doc('contract', 'signed', { signed_at: at('2025-07-03T12:00:00+03:00') }), doc('consent_pd', 'signed', { signed_at: at('2026-09-12T12:00:00+03:00') })];
    const c = one([rec({ attendance: '1', paid_full: '1', has_prior_visit: true })], { identity: FULL_ID, docs });
    expect(c).toMatchObject({ color: 'red', label: 'Акт не подписан', hint: 'Визит оплачен в YClients', tags: ['act'] });
    expect(c.action).toEqual({ type: 'send', kinds: ['act'], recordId: 100, label: 'Отправить акт' });
    expect(c.tiles).toEqual({ contract: { text: '✓ 2025', tone: 'ok' }, consent_pd: { text: '✓ 12.09', tone: 'ok' }, act: { text: 'нет', tone: 'no' } });
  });

  test('пришёл, не оплатил — акт «ждём оплату», карточка зелёная «Документы готовы»', () => {
    const docs = [doc('contract', 'signed'), doc('consent_pd', 'signed')];
    const c = one([rec({ attendance: '1', paid_full: '0', has_prior_visit: true })], { identity: FULL_ID, docs });
    expect(c).toMatchObject({ color: 'green', label: 'Документы готовы', hint: 'Акт — после оплаты визита', action: null, tags: ['ready'] });
    expect(c.tiles.act).toEqual({ text: 'ждём оплату', tone: 'na' });
    expect(c.tiles.contract).toEqual({ text: '✓ 09:00', tone: 'ok' });
  });

  test('всё подписано, включая акт — «Всё подписано», «Визит закрыт»', () => {
    const docs = [doc('contract', 'signed'), doc('consent_pd', 'signed'), doc('act', 'signed', { record_id: 100 })];
    expect(one([rec({ attendance: '1', paid_full: '1', has_prior_visit: true })], { identity: FULL_ID, docs }))
      .toMatchObject({ color: 'green', label: 'Всё подписано', hint: 'Визит закрыт' });
  });

  test('ждёт подписи — синий, «Повторить ссылку» не раньше 15 минут после отправки', () => {
    const sent = at('2026-10-25T09:50:00+03:00');
    const docs = [doc('contract', 'sent', { sent_at: sent, package_id: 'P1' }), doc('consent_pd', 'sent', { sent_at: sent, package_id: 'P1' })];
    const c = one([rec()], { identity: FULL_ID, docs });
    expect(c).toMatchObject({ color: 'blue', label: 'Ждём подпись', tags: ['waiting'] });
    expect(c.action).toEqual({ type: 'remind', label: 'Повторить ссылку', packageId: 'P1', ghost: true, availableAt: at('2026-10-25T10:05:00+03:00') });
    expect(c.tiles.contract).toEqual({ text: 'отправлен 10 мин', tone: 'wait' });
  });

  test('анкета у пациента: завтра — синий «Ждём анкету»; срочно — красный и «Заполнить данные»', () => {
    const form = { id: 'F1', client_id: 52, status: 'active', created_at: at('2026-10-25T09:00:00+03:00'), delivered_via: 'whatsapp',
      delivered_at: at('2026-10-25T09:00:00+03:00'), opened_at: null, submitted_at: null, expires_at: at('2026-11-01T09:00:00+03:00') };
    const tomorrow = one([rec({ visit_date: '2026-10-26', visit_at: at('2026-10-26T11:00:00+03:00') })], { identity: NO_PASSPORT, forms: [form] });
    expect(tomorrow).toMatchObject({ color: 'blue', label: 'Ждём анкету', hint: 'Ждём, пока пациент заполнит анкету' });
    expect(tomorrow.action).toEqual({ type: 'form_remind', label: 'Повторить анкету', formId: 'F1', ghost: true });
    expect(tomorrow.warnings).toContain('Анкета отправлена 09:00 в WhatsApp');
    const soon = one([rec()], { identity: NO_PASSPORT, forms: [form] });
    expect(soon).toMatchObject({ color: 'red', label: 'Нужно до визита' });
    expect(soon.action.type).toBe('fill');
  });

  test('просроченная анкета — не «ждём», а снова «нужно» с предупреждением', () => {
    const form = { id: 'F1', client_id: 52, status: 'active', created_at: at('2026-10-17T09:00:00+03:00'), expires_at: at('2026-10-24T09:00:00+03:00') };
    const c = one([rec({ visit_date: '2026-10-26', visit_at: at('2026-10-26T11:00:00+03:00') })], { identity: NO_PASSPORT, forms: [form] });
    expect(c.color).toBe('amber');
    expect(c.form.status).toBe('expired');
    expect(c.warnings).toContain('Анкета не заполнена — ссылка устарела');
  });

  test('срочная ссылка истекла — «Ссылка истекла», «Отправить снова»; отказ — «Пациент отказался»', () => {
    const exp = one([rec()], { identity: FULL_ID, docs: [doc('contract', 'expired'), doc('consent_pd', 'expired')] });
    expect(exp).toMatchObject({ color: 'red', label: 'Ссылка истекла' });
    expect(exp.action).toMatchObject({ type: 'send', label: 'Отправить снова' });
    expect(exp.tiles.contract).toEqual({ text: 'срок истёк', tone: 'no' });
    expect(one([rec()], { identity: FULL_ID, docs: [doc('contract', 'declined'), doc('consent_pd', 'signed')] }).label).toBe('Пациент отказался');
  });

  test('ошибка F.Doc — «Не ушло в F.Doc» и текст ошибки в предупреждениях', () => {
    const c = one([rec()], { identity: FULL_ID, docs: [doc('contract', 'draft', { last_error: 'F.Doc 400: файл', created_at: at('2026-10-25T08:00:00+03:00') }), doc('consent_pd', 'signed')] });
    expect(c).toMatchObject({ color: 'red', label: 'Не ушло в F.Doc' });
    expect(c.warnings).toContain('Ошибка отправки: F.Doc 400: файл');
  });

  test('пришёл без договора и согласия, акта тоже нет — «Нет договора, согласия и акта», три вида одной отправкой', () => {
    const c = one([rec({ attendance: '1', paid_full: '1', has_prior_visit: true })], { identity: FULL_ID });
    expect(c).toMatchObject({ color: 'red', label: 'Нет договора, согласия и акта' });
    expect(c.action).toEqual({ type: 'send', kinds: ['contract', 'consent_pd', 'act'], recordId: 100, label: 'Отправить 3 док.' });
  });

  test('прошлый день без договора — красный (визит прошёл без документа)', () => {
    const c = one([rec({ visit_date: '2026-10-20', visit_at: at('2026-10-20T11:00:00+03:00'), attendance: '1', paid_full: '1' })],
      { identity: FULL_ID, docs: [doc('act', 'signed', { record_id: 100 })] });
    expect(c).toMatchObject({ color: 'red', label: 'Нет договора и согласия' });
  });

  test('нет ни одного шаблона — серая «Шаблоны не настроены»; нет шаблона акта — акт не учитывается', () => {
    expect(one([rec()], { templates: [] })).toMatchObject({ color: 'grey', label: 'Шаблоны не настроены', action: null });
    const noAct = one([rec({ attendance: '1', paid_full: '1' })], { templates: [T.contract, T.consent], identity: FULL_ID,
      docs: [doc('contract', 'signed'), doc('consent_pd', 'signed')] });
    expect(noAct).toMatchObject({ color: 'green' });
    expect(noAct.tiles.act).toEqual({ text: '—', tone: 'na' });
  });

  test('визит до acts_required_from — акт не требуется', () => {
    const c = one([rec({ visit_date: '2026-09-20', visit_at: at('2026-09-20T11:00:00+03:00'), attendance: '1', paid_full: '1' })],
      { identity: FULL_ID, docs: [doc('contract', 'signed'), doc('consent_pd', 'signed')] });
    expect(c.color).toBe('green');
    expect(c.docs.act).toEqual({ state: 'off', reason: 'before_start' });
  });

  test('две записи в день — одна карточка, худший акт, отправка акта по неподписанной записи', () => {
    const docs = [doc('contract', 'signed'), doc('consent_pd', 'signed'), doc('act', 'signed', { record_id: 100 })];
    const c = one([
      rec({ id: 100, attendance: '1', paid_full: '1', visit_at: at('2026-10-25T09:00:00+03:00'), has_prior_visit: true }),
      rec({ id: 101, attendance: '1', paid_full: '1', visit_at: at('2026-10-25T09:30:00+03:00'), services: [{ title: 'Мезотерапия' }], has_prior_visit: true }),
    ], { identity: FULL_ID, docs });
    expect(c.visits.map((v) => [v.recordId, v.act.state])).toEqual([[100, 'signed'], [101, 'missing']]);
    expect(c).toMatchObject({ color: 'red', label: 'Акт не подписан', time: '09:00', services: ['Биоревитализация', 'Мезотерапия'] });
    expect(c.action).toMatchObject({ kinds: ['act'], recordId: 101 });
  });

  test('автонумерация: номер договора не считается недостающим', () => {
    const noNumber = { ...FULL_ID, contract_no: null };
    expect(one([rec()], { identity: noNumber }).data.complete).toBe(true);
    const c = one([rec()], { identity: noNumber, settings: { actsRequiredFrom: '2026-10-01', autonumber: false } });
    expect(c.data.missing.map((x) => x.key)).toEqual(['contract_no']);
  });

  test('заметка автоматики попадает в предупреждения', () => {
    const notes = [{ client_id: 52, record_id: 100, kind: 'previsit', status: 'failed', reason: 'нет учётки F.Doc', created_at: at('2026-10-25T09:00:00+03:00') }];
    expect(one([rec()], { identity: FULL_ID, notes }).warnings).toContain('Автоматика не отправила: нет учётки F.Doc');
  });
});

describe('периоды и сводка', () => {
  test('границы периодов; «Незакрытые» не раньше acts_required_from', () => {
    expect(b.rangeBounds('today', TODAY)).toEqual({ from: TODAY, to: TODAY });
    expect(b.rangeBounds('tomorrow', TODAY)).toEqual({ from: '2026-10-26', to: '2026-10-26' });
    expect(b.rangeBounds('week', TODAY)).toEqual({ from: TODAY, to: '2026-10-31' });
    expect(b.rangeBounds('open', TODAY, '2026-10-01')).toEqual({ from: '2026-10-01', to: '2026-10-24' });
    expect(b.rangeBounds('open', TODAY, '2026-01-01')).toEqual({ from: '2026-09-25', to: '2026-10-24' });
    expect(b.windowBounds(TODAY, '2026-10-01')).toEqual({ from: '2026-10-01', to: '2026-10-31' });
  });

  test('срезы, счётчики и чипы', () => {
    const records = [
      rec({ id: 1, client_id: 1, visit_date: '2026-10-20', visit_at: at('2026-10-20T11:00:00+03:00'), attendance: '1', paid_full: '1' }),
      rec({ id: 2, client_id: 2, visit_date: '2026-10-21', visit_at: at('2026-10-21T11:00:00+03:00'), attendance: '1', paid_full: '1' }),
      rec({ id: 3, client_id: 3 }),
      rec({ id: 4, client_id: 4, visit_date: '2026-10-26', visit_at: at('2026-10-26T11:00:00+03:00') }),
    ];
    const docs = ['contract', 'consent_pd'].map((k) => doc(k, 'signed', { client_id: 2 })).concat(doc('act', 'signed', { client_id: 2, record_id: 2 }));
    const { cards } = board(records, { docs });
    expect(b.sliceRange(cards, 'open', TODAY, '2026-10-01').map((c) => c.clientId)).toEqual([1]);
    expect(b.sliceRange(cards, 'today', TODAY).map((c) => c.clientId)).toEqual([3]);
    expect(b.rangeCounts(cards, TODAY, '2026-10-01')).toEqual({ today: 1, tomorrow: 1, week: 2, open: 1 });
    const { summary, chips } = b.summarize(b.sliceRange(cards, 'week', TODAY));
    expect(summary).toEqual({ total: 2, red: 1, amber: 1, blue: 0, green: 0, grey: 0 });
    expect(chips).toEqual({ all: 2, no_contract: 2, no_consent: 2, act: 0, waiting: 0, ready: 0 });
  });

  test('порядок: по дню, затем красные → оранжевые → синие → зелёные, затем по времени', () => {
    const records = [
      rec({ id: 1, client_id: 1, visit_at: at('2026-10-25T18:00:00+03:00') }),
      rec({ id: 2, client_id: 2, visit_at: at('2026-10-25T10:30:00+03:00') }),
      rec({ id: 3, client_id: 3, visit_at: at('2026-10-25T09:00:00+03:00'), attendance: '1', paid_full: '0' }),
    ];
    const docs = ['contract', 'consent_pd'].map((k) => doc(k, 'signed', { client_id: 3 }));
    expect(board(records, { docs }).cards.map((c) => [c.clientId, c.color])).toEqual([[2, 'red'], [1, 'amber'], [3, 'green']]);
  });
});

describe('страница пациента', () => {
  const CLIENT = { id: 52, name: 'Иванова Анна Сергеевна', phone: '+79200255591' };
  const page = (records, opts = {}) => b.buildClientPage({ client: CLIENT, identity: opts.identity || null, records, docs: opts.docs || [],
    templates: opts.templates || TEMPLATES, requisites: {}, forms: opts.forms || [], notes: [], settings: { actsRequiredFrom: '2026-10-01', autonumber: true },
    nowMs: NOW, today: TODAY, focusRecordId: opts.focus || null });

  test('сегодняшний визит без документов и данных: шапка красная, шаги, недостающие и обязательные поля', () => {
    const p = page([rec()]);
    expect(p.client).toEqual({ id: 52, name: 'Иванова Анна Сергеевна', phone: '+79200255591', initials: 'ИА' });
    expect(p.header).toMatchObject({ color: 'red', label: 'Нужно до визита', day: TODAY, time: '10:40', firstVisit: true });
    expect(p.header.steps).toEqual([{ key: 'data', tone: 'no' }, { key: 'contract', tone: 'no' }, { key: 'consent_pd', tone: 'no' }, { key: 'act', tone: 'none' }]);
    expect(p.data.complete).toBe(false);
    expect(p.data.missing.map((x) => x.key)).toEqual(['address', 'first_name', 'last_name', 'passport_number', 'passport_series', 'phone']);
    expect(p.data.required.sort()).toEqual(['address', 'first_name', 'last_name', 'passport_number', 'passport_series', 'phone']);
    expect(p.docs.contract).toMatchObject({ state: 'missing', tile: { text: 'нет', tone: 'no' } });
    expect(p.visits.map((v) => [v.recordId, v.day, v.act.state])).toEqual([[100, TODAY, 'later']]);
    expect(p.focusRecordId).toBeNull();
    expect(p.kinds.contract).toEqual({ id: 5, title: 'Договор' });
  });

  test('оплаченный визит без акта: он в фокусе, шаг «Акт» красный, данные считаются и для акта', () => {
    const docs = [doc('contract', 'signed'), doc('consent_pd', 'signed')];
    const p = page([rec({ attendance: '1', paid_full: '1', has_prior_visit: true })], { docs, identity: FULL_ID });
    expect(p.focusRecordId).toBe(100);
    expect(p.header).toMatchObject({ color: 'red', label: 'Акт не подписан' });
    expect(p.header.steps.map((s) => s.tone)).toEqual(['ok', 'ok', 'ok', 'no']);
    expect(p.data.complete).toBe(true);
  });

  test('визитов в окне нет: шапка по документам; выбранный визит из адреса', () => {
    expect(page([]).header).toMatchObject({ color: 'amber', label: 'Нет договора и согласия', day: null });
    expect(page([], { docs: [doc('contract', 'signed'), doc('consent_pd', 'sent')] }).header).toMatchObject({ color: 'blue', label: 'Ждём подпись' });
    const recs = [
      rec({ id: 100, attendance: '1', paid_full: '1', visit_date: '2026-10-20', visit_at: at('2026-10-20T11:00:00+03:00') }),
      rec({ id: 101, attendance: '1', paid_full: '1', visit_date: '2026-10-22', visit_at: at('2026-10-22T11:00:00+03:00') }),
    ];
    expect(page(recs).focusRecordId).toBe(101);
    expect(page(recs, { focus: 100 }).focusRecordId).toBe(100);
    expect(page(recs).visits.map((v) => v.recordId)).toEqual([101, 100]);
  });

  test('анкета: просроченная активная показывается как expired', () => {
    const form = { id: 'F1', client_id: 52, status: 'active', created_at: at('2026-10-10T09:00:00+03:00'), expires_at: at('2026-10-17T09:00:00+03:00') };
    expect(page([], { forms: [form] }).form).toMatchObject({ id: 'F1', status: 'expired' });
  });
});
```

- [ ] **Step 2: Убедиться, что тест падает**

```bash
cd backend && npx jest backend/edocs-board.test.js 2>&1 | grep -E "Cannot find module|^Tests:"
```

Ожидается: `Cannot find module './services/edocs/board' from 'edocs-board.test.js'`.

- [ ] **Step 3: `placeholders.js`: опция автонумерации в `missingFor`**

Правка 1 из 2. В `backend/services/edocs/placeholders.js` найти:

```js
 * identity — строка client_identity (или null), templates — [{ placeholders }].
 * @returns {{ identity: Array<{key,label}>, org: Array<{key,label}> }}
 */
function missingFor(identity, templates, requisites) {
  const have = new Set();
```

заменить на:

```js
 * identity — строка client_identity (или null), templates — [{ placeholders }].
 * opts.autoContractNo — номер договора присвоит автонумерация при отправке: его не требуем.
 * @returns {{ identity: Array<{key,label}>, org: Array<{key,label}> }}
 */
function missingFor(identity, templates, requisites, opts = {}) {
  const have = new Set();
```

Правка 2 из 2. В `backend/services/edocs/placeholders.js` найти:

```js
  }
  const req = requisites || {};
```

заменить на:

```js
  }
  if (opts && opts.autoContractNo) needIdentity.delete('contract_no');
  const req = requisites || {};
```

- [ ] **Step 4: Модуль правил**

Создать `backend/services/edocs/board.js`:

```js
'use strict';
// Дашборд «Документов»: состояние документов пациента и цвет карточки. ЧИСТЫЙ модуль — без БД
// и сети; единственное место правил (спека docs/superpowers/specs/2026-10-25-edocs-board-design.md
// §3): фронт ничего не вычисляет, только рисует ответ — иначе цвет и подпись разъехались бы.
//   Карточка = пациент × день. Договор и согласие ПД — до визита, один раз на пациента;
//   акт — после оплаченного визита, по каждой записи (с acts_required_from).
const { missingFor, FIELDS } = require('./placeholders');
const { doctorOf } = require('./act-lines');

const PRE_KINDS = ['contract', 'consent_pd'];
const ACT = 'act';
const KINDS = [...PRE_KINDS, ACT];
const URGENT_MS = 2 * 3600 * 1000;          // «визит скоро»: до начала меньше 2 часов
const FIRST_VISIT_SOON_MS = 3 * 3600 * 1000; // «через 40 мин» у первичного — в пределах 3 часов
const DRAFT_SENDING_MS = 5 * 60 * 1000;     // черновик без ошибки моложе 5 минут — отправка ещё идёт
const REMIND_AFTER_MS = 15 * 60 * 1000;     // «Повторить ссылку» — не раньше 15 минут после отправки
const OPEN_DAYS = 30;                       // «Незакрытые»: прошлые 30 дней
const WEEK_DAYS = 7;
const BAD = new Set(['missing', 'lapsed', 'problem']);
const COLOR_ORDER = { red: 0, amber: 1, blue: 2, green: 3, grey: 4 };
const GENITIVE = { contract: 'договора', consent_pd: 'согласия', act: 'акта' };
const SEND_LABEL = { contract: 'Отправить договор', consent_pd: 'Отправить согласие', act: 'Отправить акт' };
const LAPSED_LABEL = { expired: 'Ссылка истекла', declined: 'Пациент отказался', annulled: 'Аннулировано' };
const LAPSED_TILE = { expired: 'срок истёк', declined: 'отказ', annulled: 'аннулирован' };
const VIA = { tdlib: 'Telegram', whatsapp: 'WhatsApp', max: 'MAX' };
// Худший акт среди записей дня — для плитки карточки: «плохие» впереди, «нет шаблона» в конце.
const ACT_RANK = { lapsed: 0, problem: 1, missing: 2, pending: 3, unpaid: 4, later: 5, signed: 6, off: 7 };

const ms = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const t = typeof v === 'number' ? v : v instanceof Date ? v.getTime() : Date.parse(v);
  return Number.isFinite(t) ? t : null;
};
const iso = (v) => { const t = ms(v); return t === null ? null : new Date(t).toISOString(); };
const MSK_HM = new Intl.DateTimeFormat('ru-RU', { timeZone: 'Europe/Moscow', hour: '2-digit', minute: '2-digit' });
const MSK_DAY = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Moscow', year: 'numeric', month: '2-digit', day: '2-digit' });
/** «09:05» по Москве или ''. */
function hm(v) { const t = ms(v); return t === null ? '' : MSK_HM.format(new Date(t)); }
/** 'YYYY-MM-DD' по Москве. */
function mskDay(v) { const t = ms(v); return t === null ? '' : MSK_DAY.format(new Date(t)); }
/** 'YYYY-MM-DD' ± n дней (календарь, без часовых поясов). */
function addDays(day, n) { return new Date(Date.parse(`${day}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10); }
function dm(day) { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(day || '')); return m ? `${m[3]}.${m[2]}` : ''; }
/** «12 мин» / «3 ч» / «2 дн» — сколько прошло. */
function ago(atMs, nowMs) {
  const m = Math.max(0, Math.round((nowMs - atMs) / 60000));
  if (m < 60) return `${m} мин`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h} ч` : `${Math.floor(h / 24)} дн`;
}
/** «через 40 мин» / «через 1 ч 20 мин». */
function until(atMs, nowMs) {
  const m = Math.max(0, Math.round((atMs - nowMs) / 60000));
  if (m < 60) return `через ${m} мин`;
  const h = Math.floor(m / 60), rest = m % 60;
  return `через ${h} ч${rest ? ` ${rest} мин` : ''}`;
}
function joinRu(words) {
  if (words.length <= 1) return words.join('');
  return `${words.slice(0, -1).join(', ')} и ${words[words.length - 1]}`;
}
function initials(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  return (parts.slice(0, 2).map((w) => w[0]).join('') || '?').toUpperCase();
}
const bySort = (a, b) => (Number(a.sort_order) || 0) - (Number(b.sort_order) || 0) || a.id - b.id;

/**
 * Состояние вида документа у пациента (спека §3.2). docs — строки «документ × комплект» пациента:
 * { package_id, package_status, record_id, kind, created_at, sent_at, signed_at, last_error, source }.
 * Для акта учитываются только комплекты записи recordId. Подписанный когда-то документ побеждает
 * любой новый неудачный комплект; иначе решает последний по времени создания.
 */
function kindState(docs, kind, { recordId = null, nowMs = Date.now() } = {}) {
  const own = (docs || []).filter((d) => d && d.kind === kind && (kind !== ACT || Number(d.record_id) === Number(recordId)));
  const signed = own.filter((d) => d.package_status === 'signed' || d.package_status === 'paper')
    .sort((a, b) => (ms(b.signed_at) || ms(b.created_at) || 0) - (ms(a.signed_at) || ms(a.created_at) || 0))[0];
  if (signed) return { state: 'signed', at: iso(signed.signed_at || signed.created_at), paper: signed.package_status === 'paper', packageId: signed.package_id };
  const last = own.slice().sort((a, b) => (ms(b.created_at) || 0) - (ms(a.created_at) || 0))[0];
  if (!last) return { state: 'missing' };
  const base = { packageId: last.package_id, at: iso(last.sent_at || last.created_at), source: last.source || 'manual' };
  switch (last.package_status) {
    case 'sent': return { ...base, state: 'pending' };
    case 'draft': {
      const young = nowMs - (ms(last.created_at) || 0) < DRAFT_SENDING_MS;
      if (!last.last_error && young) return { ...base, state: 'pending' };
      return { ...base, state: 'problem', reason: 'not_sent', error: last.last_error || null };
    }
    case 'error': return { ...base, state: 'problem', reason: 'fdoc_error', error: last.last_error || null };
    case 'declined': case 'expired': case 'annulled': return { ...base, state: 'lapsed', reason: last.package_status };
    default: return { ...base, state: 'pending' };   // незнакомый статус — как ждущий: не терять из виду
  }
}

/** Нужен ли акт по записи: later — визит не состоялся; unpaid — пришёл, не оплачен; before_start — до acts_required_from. */
function actPhase(r, actsFrom) {
  if (String(r.attendance) !== '1') return 'later';
  if (actsFrom && String(r.visit_date) < String(actsFrom)) return 'before_start';
  return String(r.paid_full) === '1' ? 'required' : 'unpaid';
}

/** Текст и тон плитки документа. tone: ok | wait | no | soon | na. */
function tile(st, { urgent = true, nowMs, today }) {
  const at = ms(st.at);
  switch (st.state) {
    case 'signed': {
      if (st.paper) return { text: '✓ бумага', tone: 'ok' };
      const day = mskDay(at);
      const text = day === today ? hm(at) : day.slice(0, 4) === String(today).slice(0, 4) ? dm(day) : day.slice(0, 4);
      return { text: `✓ ${text}`, tone: 'ok' };
    }
    case 'pending': return { text: at === null ? 'отправлен' : `отправлен ${ago(at, nowMs)}`, tone: 'wait' };
    case 'problem': return { text: st.reason === 'fdoc_error' ? 'ошибка F.Doc' : 'не ушло', tone: urgent ? 'no' : 'soon' };
    case 'lapsed': return { text: LAPSED_TILE[st.reason] || 'срок истёк', tone: urgent ? 'no' : 'soon' };
    case 'missing': return { text: 'нет', tone: urgent ? 'no' : 'soon' };
    case 'later': return { text: 'после визита', tone: 'na' };
    case 'unpaid': return { text: 'ждём оплату', tone: 'na' };
    default: return { text: '—', tone: 'na' };
  }
}

function titlesOf(services) {
  return (Array.isArray(services) ? services : []).map((s) => String((s && s.title) || '').trim()).filter(Boolean);
}

/**
 * Одна карточка из записей пациента за день.
 * ctx: { docs, identity, form, notes, tplByKind, enabledKinds, requisites, settings, nowMs, today }
 */
function buildCard(recs, ctx) {
  const { tplByKind, nowMs, today, settings } = ctx;
  const r0 = recs[0];
  const day = String(r0.visit_date);
  const pre = {};
  for (const k of PRE_KINDS) pre[k] = tplByKind[k].length ? kindState(ctx.docs, k, { nowMs }) : { state: 'off' };
  const visits = recs.map((r) => {
    const phase = actPhase(r, settings.actsRequiredFrom);
    let act;
    if (!tplByKind[ACT].length) act = { state: 'off' };
    else if (phase === 'later') act = { state: 'later' };
    else if (phase === 'unpaid') act = { state: 'unpaid' };
    else if (phase === 'before_start') act = { state: 'off', reason: 'before_start' };
    else act = kindState(ctx.docs, ACT, { recordId: r.id, nowMs });
    return {
      recordId: r.id, time: hm(r.visit_at), visitAt: iso(r.visit_at), services: titlesOf(r.services),
      staffName: doctorOf(r.staff).name || '', arrived: String(r.attendance) === '1', paid: String(r.paid_full) === '1', act,
    };
  });
  const actWorst = visits.map((v) => v.act).sort((a, b) => ACT_RANK[a.state] - ACT_RANK[b.state])[0];
  const actBadVisits = visits.filter((v) => BAD.has(v.act.state));
  const preBad = PRE_KINDS.filter((k) => BAD.has(pre[k].state));
  const anyArrived = visits.some((v) => v.arrived);
  const startMs = ms(visits[0].visitAt);
  const past = day < today;
  const urgent = past || anyArrived || (day === today && startMs !== null && startMs - nowMs <= URGENT_MS);

  // Данные: хватает ли их на документы, которые сейчас «плохие» (§3.3). Реквизиты клиники — не про пациента.
  const needKinds = [...preBad, ...(actBadVisits.length ? [ACT] : [])];
  const needTemplates = needKinds.map((k) => tplByKind[k][0]).filter(Boolean);
  const missing = needTemplates.length
    ? missingFor(ctx.identity, needTemplates, ctx.requisites, { autoContractNo: !!settings.autonumber }).identity : [];
  const data = { exists: !!ctx.identity, complete: missing.length === 0, missing };

  let form = null;
  if (ctx.form) {
    const f = ctx.form;
    const status = f.status === 'active' && ms(f.expires_at) !== null && ms(f.expires_at) <= nowMs ? 'expired' : f.status;
    form = {
      id: f.id, status, createdAt: iso(f.created_at), deliveredVia: f.delivered_via || null, deliveredAt: iso(f.delivered_at),
      openedAt: iso(f.opened_at), submittedAt: iso(f.submitted_at), packageId: f.package_id || null, error: f.last_error || null,
    };
  }
  // Анкета у пациента, а данных ещё нет — договор и согласие ждём от него, а не от администратора.
  const formWaiting = !!(form && form.status === 'active' && !data.complete && preBad.length);
  const pendingStates = [...PRE_KINDS.map((k) => pre[k]), ...visits.map((v) => v.act)].filter((s) => s.state === 'pending');

  let color;
  if (!ctx.enabledKinds.length) color = 'grey';
  else if (actBadVisits.length || (preBad.length && urgent)) color = 'red';
  else if (preBad.length && !formWaiting) color = 'amber';
  else if (pendingStates.length || formWaiting) color = 'blue';
  else color = 'green';

  let label;
  if (color === 'grey') label = 'Шаблоны не настроены';
  else if (color === 'red') {
    const urgentBad = [...(urgent ? preBad.map((k) => pre[k]) : []), ...actBadVisits.map((v) => v.act)];
    const lapsed = urgentBad.find((s) => s.state === 'lapsed');
    if (lapsed) label = LAPSED_LABEL[lapsed.reason] || 'Ссылка истекла';
    else if (urgentBad.some((s) => s.state === 'problem')) label = 'Не ушло в F.Doc';
    else if (preBad.length && urgent && !anyArrived && !past) label = 'Нужно до визита';
    else if (preBad.length && urgent) label = `Нет ${joinRu([...preBad, ...(actBadVisits.length ? [ACT] : [])].map((k) => GENITIVE[k]))}`;
    else label = 'Акт не подписан';
  } else if (color === 'amber') label = day === today ? `Нужно до ${visits[0].time || 'визита'}` : `Нужно до ${dm(day)}`;
  else if (color === 'blue') label = formWaiting && !pendingStates.length ? 'Ждём анкету' : 'Ждём подпись';
  else label = visits.some((v) => v.act.state === 'signed') ? 'Всё подписано' : 'Документы готовы';

  // Главное действие (§3.5). Кнопки, которым нужен F.Doc, фронт сам заменит на «Открыть», если отправка
  // сейчас невозможна (модуль выключен, нет своей учётки) — это состояние пользователя, не пациента.
  let action = null;
  const sendAction = (kinds, recordId) => {
    const states = kinds.map((k) => (k === ACT ? (actBadVisits[0] || {}).act : pre[k])).filter(Boolean);
    const allLapsed = states.length && states.every((s) => s.state === 'lapsed');
    return {
      type: 'send', kinds, recordId: recordId || null,
      label: allLapsed ? 'Отправить снова' : kinds.length === 1 ? SEND_LABEL[kinds[0]] : `Отправить ${kinds.length} док.`,
    };
  };
  if (color !== 'grey' && color !== 'green') {
    if (preBad.length && !(formWaiting && !urgent)) {
      if (data.complete) action = sendAction([...preBad, ...(actBadVisits.length ? [ACT] : [])], actBadVisits.length ? actBadVisits[0].recordId : null);
      else action = { type: 'fill', label: 'Заполнить данные', form: true };
    } else if (actBadVisits.length) {
      action = data.complete ? sendAction([ACT], actBadVisits[0].recordId) : { type: 'fill', label: 'Заполнить данные', form: true };
    } else if (formWaiting) {
      action = { type: 'form_remind', label: 'Повторить анкету', formId: form.id, ghost: true };
    } else if (pendingStates.length) {
      const latest = pendingStates.slice().sort((a, b) => (ms(b.at) || 0) - (ms(a.at) || 0))[0];
      const at = ms(latest.at);
      action = { type: 'remind', label: 'Повторить ссылку', packageId: latest.packageId, ghost: true,
        availableAt: at === null ? null : new Date(at + REMIND_AFTER_MS).toISOString() };
    }
  }

  const warnings = [];
  if (!anyArrived && !past && !r0.has_prior_visit) {
    const soon = day === today && startMs !== null && startMs > nowMs && startMs - nowMs <= FIRST_VISIT_SOON_MS;
    warnings.push(`⏱ Первичный${soon ? ` · ${until(startMs, nowMs)}` : ''}`);
  }
  if (needKinds.length && !data.complete) {
    const labels = missing.map((x) => x.label.toLowerCase());
    warnings.push(`Нет данных: ${labels.slice(0, 3).join(', ')}${labels.length > 3 ? ` и ещё ${labels.length - 3}` : ''}`);
  }
  for (const s of [...PRE_KINDS.map((k) => pre[k]), ...visits.map((v) => v.act)]) {
    if (s.state === 'problem' && s.error) { warnings.push(`Ошибка отправки: ${String(s.error).slice(0, 80)}`); break; }
  }
  if (form) {
    if (form.status === 'active' && !data.complete) {
      warnings.push(`Анкета отправлена ${hm(form.deliveredAt || form.createdAt)}${form.deliveredVia ? ` в ${VIA[form.deliveredVia] || form.deliveredVia}` : ''}${form.openedAt ? ', пациент открыл' : ''}`);
    } else if (form.status === 'submitted' && form.error && !form.packageId) {
      warnings.push(`Анкета заполнена, документы не ушли: ${String(form.error).slice(0, 80)}`);
    } else if (form.status === 'expired' && !data.complete) {
      warnings.push('Анкета не заполнена — ссылка устарела');
    }
  }
  const note = (ctx.notes || []).slice().sort((a, b) => (ms(b.created_at) || 0) - (ms(a.created_at) || 0))[0];
  if (note) {
    if (note.status === 'done') warnings.push(`Автоматика ${hm(note.created_at)}: ${note.reason || 'отправлено'}`);
    else if (note.status === 'failed' || note.status === 'skipped') warnings.push(`Автоматика не отправила: ${note.reason || 'причина не записана'}`);
  }

  let hint = '';
  if (color === 'green') hint = visits.some((v) => v.act.state === 'signed') ? 'Визит закрыт' : visits.some((v) => v.act.state === 'unpaid') ? 'Акт — после оплаты визита' : 'Акт — после визита';
  else if (actBadVisits.length) hint = 'Визит оплачен в YClients';
  else if (formWaiting) hint = form.openedAt ? 'Пациент открыл анкету' : 'Ждём, пока пациент заполнит анкету';
  else if (pendingStates.length && color === 'blue') hint = 'Ждём подпись пациента';
  else if (needKinds.length && !data.complete) hint = 'Данные неполные';
  else if (needKinds.length) hint = 'Данные полные';

  const tiles = {};
  for (const k of PRE_KINDS) tiles[k] = tile(pre[k], { urgent, nowMs, today });
  tiles[ACT] = tile(actWorst || { state: 'off' }, { urgent: true, nowMs, today });

  const tags = [];
  if (BAD.has(pre.contract.state)) tags.push('no_contract');
  if (BAD.has(pre.consent_pd.state)) tags.push('no_consent');
  if (actBadVisits.length) tags.push('act');
  if (color === 'blue') tags.push('waiting');
  if (color === 'green') tags.push('ready');

  const services = [...new Set(visits.flatMap((v) => v.services))];
  return {
    key: `${r0.client_id}:${day}`, clientId: r0.client_id, name: r0.client_name || '—', initials: initials(r0.client_name), phone: r0.client_phone || null,
    day, time: visits[0].time, visitAt: visits[0].visitAt, services, staffName: visits[0].staffName, visits,
    docs: { contract: pre.contract, consent_pd: pre.consent_pd, act: actWorst || { state: 'off' } }, tiles,
    color, label, data, form, action, warnings, hint, tags, firstVisit: !r0.has_prior_visit, arrived: anyArrived,
  };
}

/**
 * Карточки по записям. input:
 *   records    — записи окна: { id, client_id, client_name, client_phone, visit_date 'YYYY-MM-DD', visit_at,
 *                attendance, paid_full, services, staff, has_prior_visit } (удалённые и неявки отсечены SQL);
 *   docs       — документы комплектов этих пациентов (kindState), с client_id;
 *   identities — Map client_id → строка client_identity без расшифровки (secure_fields — что заполнено);
 *   templates  — шаблоны салона; requisites — реквизиты клиники;
 *   forms      — последняя анкета пациента; notes — свежие строки edoc_auto_jobs;
 *   settings   — { actsRequiredFrom 'YYYY-MM-DD'|null, autonumber bool }; nowMs; today ('YYYY-MM-DD' по Москве).
 */
function buildBoard(input) {
  const { records = [], docs = [], identities = new Map(), templates = [], requisites = {}, forms = [], notes = [],
    settings = {}, nowMs = Date.now() } = input || {};
  const today = (input && input.today) || mskDay(nowMs);
  const active = (templates || []).filter((t) => t && t.is_active !== false);
  const tplByKind = {};
  for (const k of KINDS) tplByKind[k] = active.filter((t) => t.kind === k).sort(bySort);
  const enabledKinds = KINDS.filter((k) => tplByKind[k].length);
  const group = (list, key) => { const m = new Map(); for (const x of list || []) { const k = key(x); if (!m.has(k)) m.set(k, []); m.get(k).push(x); } return m; };
  const docsBy = group(docs, (d) => Number(d.client_id));
  const formsBy = new Map((forms || []).map((f) => [Number(f.client_id), f]));
  const notesBy = group(notes, (n) => Number(n.client_id));
  const days = group(records, (r) => `${r.client_id}:${r.visit_date}`);
  const cards = [];
  for (const recs of days.values()) {
    recs.sort((a, b) => (ms(a.visit_at) || 0) - (ms(b.visit_at) || 0) || a.id - b.id);
    const cid = Number(recs[0].client_id);
    const recIds = new Set(recs.map((r) => Number(r.id)));
    cards.push(buildCard(recs, {
      docs: docsBy.get(cid) || [], identity: identities.get(cid) || null, form: formsBy.get(cid) || null,
      notes: (notesBy.get(cid) || []).filter((n) => !n.record_id || recIds.has(Number(n.record_id))),
      tplByKind, enabledKinds, requisites, settings, nowMs, today,
    }));
  }
  cards.sort((a, b) => a.day.localeCompare(b.day) || COLOR_ORDER[a.color] - COLOR_ORDER[b.color]
    || (ms(a.visitAt) || 0) - (ms(b.visitAt) || 0) || String(a.name).localeCompare(String(b.name), 'ru'));
  const kinds = {};
  for (const k of KINDS) kinds[k] = tplByKind[k][0] ? { id: tplByKind[k][0].id, title: tplByKind[k][0].title } : null;
  return { cards, kinds, enabledKinds, today };
}

const STEP_TONE = { signed: 'ok', pending: 'wait', missing: 'no', lapsed: 'no', problem: 'no' };
/**
 * Страница пациента (спека §5): шапка (цвет, подпись, четыре шага), полнота данных, состояния
 * договора и согласия, визиты с актами, анкета. Те же правила, что у карточек, — через buildBoard.
 * input: { client, identity (строка client_identity без расшифровки), records, docs, templates, requisites,
 *          forms, notes, settings { actsRequiredFrom, autonumber }, nowMs, today, focusRecordId }
 */
function buildClientPage(input) {
  const { client, identity = null, records = [], docs = [], templates = [], requisites = {}, forms = [], notes = [], settings = {}, nowMs = Date.now() } = input;
  const today = input.today || mskDay(nowMs);
  const recs = records.map((r) => ({ ...r, client_id: client.id, client_name: client.name, client_phone: client.phone }));
  const built = buildBoard({ records: recs, docs, identities: new Map(identity ? [[client.id, identity]] : []), templates, requisites,
    forms, notes, settings, nowMs, today });
  const active = templates.filter((t) => t && t.is_active !== false);
  const tplOf = (k) => active.filter((t) => t.kind === k).sort(bySort)[0] || null;
  const pre = {};
  for (const k of PRE_KINDS) pre[k] = tplOf(k) ? kindState(docs, k, { nowMs }) : { state: 'off' };
  const visits = [];
  for (const c of built.cards) for (const v of c.visits) visits.push({ ...v, day: c.day, tile: tile(v.act, { urgent: true, nowMs, today }) });
  visits.sort((a, b) => (ms(b.visitAt) || 0) - (ms(a.visitAt) || 0) || b.recordId - a.recordId);
  const focusId = Number(input.focusRecordId) || null;
  const focus = (focusId && visits.find((v) => v.recordId === focusId))
    || visits.find((v) => BAD.has(v.act.state)) || visits.find((v) => v.arrived) || null;
  // Шапка — карточка сегодняшнего дня, иначе ближайшего будущего, иначе последнего прошлого.
  const cards = built.cards;
  const headCard = cards.find((c) => c.day === today) || cards.filter((c) => c.day > today).sort((a, b) => a.day.localeCompare(b.day))[0]
    || cards.filter((c) => c.day < today).sort((a, b) => b.day.localeCompare(a.day))[0] || null;
  // Данные: чего не хватает для документов, которые ещё не подписаны (и для акта выбранного визита).
  const needKinds = PRE_KINDS.filter((k) => pre[k].state !== 'signed' && pre[k].state !== 'off');
  if (focus && BAD.has(focus.act.state)) needKinds.push(ACT);
  const autoContractNo = !!settings.autonumber;
  const needTpl = needKinds.map(tplOf).filter(Boolean);
  const missing = needTpl.length ? missingFor(identity, needTpl, requisites, { autoContractNo }).identity : [];
  const allTpl = KINDS.map(tplOf).filter(Boolean);
  const required = new Set(allTpl.length ? ['last_name', 'first_name', 'phone'] : []);
  for (const t of allTpl) for (const name of t.placeholders || []) { const f = FIELDS[name]; if (f) for (const r of f.requires) required.add(r); }
  if (autoContractNo) required.delete('contract_no');
  let header;
  if (headCard) {
    header = { color: headCard.color, label: headCard.label, day: headCard.day, time: headCard.time, services: headCard.services,
      staffName: headCard.staffName, firstVisit: headCard.firstVisit, arrived: headCard.arrived };
  } else {
    const bad = PRE_KINDS.filter((k) => BAD.has(pre[k].state));
    const pending = PRE_KINDS.some((k) => pre[k].state === 'pending');
    header = { color: !built.enabledKinds.length ? 'grey' : bad.length ? 'amber' : pending ? 'blue' : 'green',
      label: !built.enabledKinds.length ? 'Шаблоны не настроены' : bad.length ? `Нет ${joinRu(bad.map((k) => GENITIVE[k]))}` : pending ? 'Ждём подпись' : 'Документы готовы',
      day: null, time: '', services: [], staffName: '', firstVisit: false, arrived: false };
  }
  header.steps = [
    { key: 'data', tone: missing.length ? 'no' : 'ok' },
    ...PRE_KINDS.map((k) => ({ key: k, tone: STEP_TONE[pre[k].state] || 'none' })),
    { key: ACT, tone: focus ? (STEP_TONE[focus.act.state] || 'none') : 'none' },
  ];
  const docsOut = {};
  for (const k of PRE_KINDS) docsOut[k] = { ...pre[k], tile: tile(pre[k], { urgent: headCard ? headCard.color === 'red' : false, nowMs, today }) };
  const f = forms[0] || null;
  return {
    client: { id: client.id, name: client.name, phone: client.phone || null, initials: initials(client.name) },
    header, data: { exists: !!identity, complete: !missing.length, missing, required: [...required] }, docs: docsOut, visits,
    focusRecordId: focus ? focus.recordId : null,
    form: f ? { id: f.id, status: f.status === 'active' && ms(f.expires_at) !== null && ms(f.expires_at) <= nowMs ? 'expired' : f.status,
      createdAt: iso(f.created_at), deliveredVia: f.delivered_via || null, deliveredAt: iso(f.delivered_at), openedAt: iso(f.opened_at),
      submittedAt: iso(f.submitted_at), expiresAt: iso(f.expires_at), packageId: f.package_id || null, error: f.last_error || null } : null,
    warnings: headCard ? headCard.warnings : [], kinds: built.kinds,
  };
}

/** Границы дней периода. open — прошлые 30 дней, не раньше acts_required_from. */
function rangeBounds(range, today, actsFrom) {
  if (range === 'tomorrow') return { from: addDays(today, 1), to: addDays(today, 1) };
  if (range === 'week') return { from: today, to: addDays(today, WEEK_DAYS - 1) };
  if (range === 'open') {
    const from = addDays(today, -OPEN_DAYS);
    return { from: actsFrom && actsFrom > from ? actsFrom : from, to: addDays(today, -1) };
  }
  return { from: today, to: today };
}
/** Окно выборки записей — все периоды сразу: счётчики периодов считаются тем же правилом. */
function windowBounds(today, actsFrom) {
  return { from: rangeBounds('open', today, actsFrom).from, to: addDays(today, WEEK_DAYS - 1) };
}
const inRange = (card, b) => card.day >= b.from && card.day <= b.to;
/** «Незакрытые» — только не зелёные (и не серые) карточки прошлых дней. */
function sliceRange(cards, range, today, actsFrom) {
  const b = rangeBounds(range, today, actsFrom);
  return cards.filter((c) => inRange(c, b) && (range !== 'open' || (c.color !== 'green' && c.color !== 'grey')));
}
function rangeCounts(cards, today, actsFrom) {
  const out = {};
  for (const r of ['today', 'tomorrow', 'week', 'open']) out[r] = sliceRange(cards, r, today, actsFrom).length;
  return out;
}
function summarize(cards) {
  const s = { total: cards.length, red: 0, amber: 0, blue: 0, green: 0, grey: 0 };
  const chips = { all: cards.length, no_contract: 0, no_consent: 0, act: 0, waiting: 0, ready: 0 };
  for (const c of cards) {
    s[c.color]++;
    for (const t of c.tags) chips[t]++;
  }
  return { summary: s, chips };
}

module.exports = {
  PRE_KINDS, ACT, KINDS, URGENT_MS, REMIND_AFTER_MS, OPEN_DAYS, BAD,
  kindState, actPhase, buildBoard, buildCard, buildClientPage, rangeBounds, windowBounds, sliceRange, rangeCounts, summarize, joinRu,
  addDays, mskDay, hm,
};
```

- [ ] **Step 5: Тест проходит, соседние наборы целы**

```bash
cd backend && npx jest backend/edocs-board.test.js 2>&1 | grep -E "^Tests:"; npx jest backend/edocs- 2>&1 | grep -E "^(Tests|Test Suites):"
```

Ожидается: `Tests: 31 passed, 31 total`; затем `Test Suites: 10 passed`, `Tests: 247 passed`.

- [ ] **Step 6: Коммит**

```bash
git add backend/edocs-board.test.js backend/services/edocs/board.js backend/services/edocs/placeholders.js
git commit -m "feat(edocs): правила дашборда подписей — состояния, цвет, подпись, действие карточки" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 3: Нумерация договоров — `counter.js` — **Opus**

Спека §9. Свой номер пациента главнее счётчика (решение 10): поле «Номер договора» в данных для документов → поле YClients `custom_fields['nomer-dogovra']` (номер переносится в данные пациента, дата договора — дата документа, если пуста) → следующий номер счётчика `edoc_counters`. Счётчик заводится при первом обращении: максимум числовых номеров салона (YClients и `client_identity`) + 1 — на деве это 1999 (решение 6). Номер, уже занятый кем-то из пациентов (выдан вручную в YClients), пропускается — не больше 50 подряд, дальше ошибка (явно что-то не так). Всё в одной транзакции с `FOR UPDATE` строки счётчика: два одновременных договора не получат один номер; номер пишется в данные пациента с условием «номер ещё пуст» — повтор отправки берёт уже присвоенный номер, дыр нет. Данных пациента нет вовсе — 400: сначала сохранить данные. `peek` (превью «будет присвоен: 1999») и `setNext` (владелец меняет следующий номер) — для страницы пациента и настроек. В YClients номер не пишется.

**Files:**
- Create: `backend/services/edocs/counter.js`
- Test: `backend/edocs-counter.test.js`

- [ ] **Step 1: Падающий тест**

Создать `backend/edocs-counter.test.js`:

```js
'use strict';
// Номера договоров (services/edocs/counter.js). SQL проверяется на дев-БД скриптом
// scripts/edocs-board-smoke.js; здесь — порядок источников номера и пропуск занятых.
const mockClient = { query: jest.fn() };
jest.mock('./db', () => ({
  db: { query: jest.fn(), oneOrNone: jest.fn() },
  withTransaction: jest.fn(async (fn) => fn(mockClient)),
}));
const { db } = require('./db');
const counter = require('./services/edocs/counter');

/** Ответы транзакции по тексту SQL: identity — строка client_identity, numbers — что вернёт UPDATE счётчика, taken — занятые номера. */
function script({ identity = { contract_no: null }, numbers = [1999], taken = [] } = {}) {
  const queue = numbers.slice();
  mockClient.query.mockImplementation(async (sql, params) => {
    if (/FROM client_identity WHERE salon_id=\$1 AND client_id=\$2 FOR UPDATE/.test(sql)) return { rows: identity ? [identity] : [] };
    if (/^INSERT INTO edoc_counters/.test(sql.trim())) return { rows: [] };
    if (/^UPDATE edoc_counters/.test(sql.trim())) return { rows: [{ no: queue.shift() }] };
    if (/UNION ALL SELECT 1 FROM client_identity/.test(sql)) return { rows: taken.includes(params[1]) ? [{ '?column?': 1 }] : [] };
    if (/^UPDATE client_identity SET contract_no/.test(sql.trim())) return { rows: [] };
    throw new Error(`неожиданный SQL: ${sql}`);
  });
}
const writes = () => mockClient.query.mock.calls.filter(([sql]) => /^UPDATE client_identity SET contract_no/.test(sql.trim())).map(([, p]) => p);

beforeEach(() => jest.clearAllMocks());

test('yclientsNumber: поле «Номер договора» карточки YClients', () => {
  expect(counter.yclientsNumber({ yclients_data: { custom_fields: { 'nomer-dogovra': ' 1859 ' } } })).toBe('1859');
  expect(counter.yclientsNumber({ yclients_data: { custom_fields: { 'nomer-dogovra': '' } } })).toBeNull();
  expect(counter.yclientsNumber({ yclients_data: {} })).toBeNull();
  expect(counter.yclientsNumber(null)).toBeNull();
});

test('номер уже в данных пациента — он и идёт, счётчик не трогается', async () => {
  script({ identity: { contract_no: '1739' } });
  expect(await counter.ensureContractNo({ salonId: 1, clientId: 52, client: {}, docDate: '2026-10-25' }))
    .toEqual({ contractNo: '1739', source: 'identity', assigned: false });
  expect(writes()).toEqual([]);
});

test('номер есть в YClients — переносится в данные пациента (дата договора = дата документа, если пуста)', async () => {
  script();
  const client = { yclients_data: { custom_fields: { 'nomer-dogovra': '1859' } } };
  expect(await counter.ensureContractNo({ salonId: 1, clientId: 52, client, docDate: '2026-10-25' }))
    .toEqual({ contractNo: '1859', source: 'yclients', assigned: true });
  expect(writes()).toEqual([[1, 52, '1859', '2026-10-25']]);
  expect(mockClient.query.mock.calls.some(([sql]) => /edoc_counters/.test(sql))).toBe(false);
});

test('номера нет нигде — следующий из счётчика (заводится по максимуму салона)', async () => {
  script({ numbers: [1999] });
  expect(await counter.ensureContractNo({ salonId: 1, clientId: 52, client: { yclients_data: {} }, docDate: '2026-10-25' }))
    .toEqual({ contractNo: '1999', source: 'counter', assigned: true });
  const insert = mockClient.query.mock.calls.find(([sql]) => /^INSERT INTO edoc_counters/.test(sql.trim()));
  expect(insert[0]).toMatch(/GREATEST/);
  expect(insert[0]).toMatch(/ON CONFLICT \(salon_id, kind\) DO NOTHING/);
  expect(writes()).toEqual([[1, 52, '1999', '2026-10-25']]);
});

test('занятый номер (выдан вручную в YClients) пропускается', async () => {
  script({ numbers: [1999, 2000, 2001], taken: ['1999', '2000'] });
  expect((await counter.ensureContractNo({ salonId: 1, clientId: 52, client: {}, docDate: null })).contractNo).toBe('2001');
  expect(writes()).toEqual([[1, 52, '2001', null]]);
});

test('данных пациента нет — 400: сначала сохранить данные', async () => {
  script({ identity: null });
  await expect(counter.ensureContractNo({ salonId: 1, clientId: 52, client: {}, docDate: null })).rejects.toMatchObject({ code: 'missing_fields', status: 400 });
});

test('setNext: целое от 1; peek — следующий без записи', async () => {
  await expect(counter.setNext(1, 0)).rejects.toMatchObject({ code: 'bad_counter' });
  await expect(counter.setNext(1, '1.5')).rejects.toMatchObject({ code: 'bad_counter' });
  expect(await counter.setNext(1, '2100')).toBe(2100);
  expect(db.query).toHaveBeenCalledWith(expect.stringMatching(/ON CONFLICT \(salon_id, kind\) DO UPDATE/), [1, 'contract', 2100]);
  db.oneOrNone.mockResolvedValueOnce(null);
  db.query.mockResolvedValueOnce({ rows: [{ max_used: '1998' }] });
  expect(await counter.peek(1)).toEqual({ next: 1999, maxUsed: 1998 });
  db.oneOrNone.mockResolvedValueOnce({ next_value: '2100' });
  db.query.mockResolvedValueOnce({ rows: [{ max_used: '1998' }] });
  expect(await counter.peek(1)).toEqual({ next: 2100, maxUsed: 1998 });
});
```

- [ ] **Step 2: Убедиться, что тест падает**

```bash
cd backend && npx jest backend/edocs-counter.test.js 2>&1 | grep -E "Cannot find module|^Tests:"
```

Ожидается: `Cannot find module './services/edocs/counter' from 'edocs-counter.test.js'`.

- [ ] **Step 3: Модуль нумерации**

Создать `backend/services/edocs/counter.js`:

```js
'use strict';
// Номера договоров (спека 2026-10-25 §9). Свой номер пациента главнее счётчика: поле данных для
// документов → поле YClients «Номер договора» (электронная версия того же договора идёт под
// прежним номером) → следующий номер счётчика edoc_counters. Счётчик заводится при первом
// обращении: максимум числовых номеров салона (YClients и client_identity) + 1. Номер, уже занятый
// кем-то из пациентов (его могли выдать вручную в YClients), пропускается.
const { db, withTransaction } = require('../../db');
const { EdocsError } = require('./errors');

const YC_FIELD = 'nomer-dogovra';
const KIND = 'contract';
const MAX_SKIP = 50;   // столько занятых номеров подряд пропускаем, дальше — ошибка (явно что-то не так)
const NUM_RE = '^[0-9]{1,15}$';

const MAX_USED_SQL = `SELECT GREATEST(
    COALESCE((SELECT max(trim(yclients_data->'custom_fields'->>'${YC_FIELD}')::bigint) FROM clients
               WHERE salon_id=$1 AND trim(yclients_data->'custom_fields'->>'${YC_FIELD}') ~ '${NUM_RE}'), 0),
    COALESCE((SELECT max(trim(contract_no)::bigint) FROM client_identity
               WHERE salon_id=$1 AND trim(contract_no) ~ '${NUM_RE}'), 0)
  ) AS max_used`;
const TAKEN_SQL = `SELECT 1 FROM clients WHERE salon_id=$1 AND trim(yclients_data->'custom_fields'->>'${YC_FIELD}')=$2
  UNION ALL SELECT 1 FROM client_identity WHERE salon_id=$1 AND trim(contract_no)=$2 LIMIT 1`;

/** Номер договора из карточки YClients или null. */
function yclientsNumber(client) {
  const custom = client && client.yclients_data && typeof client.yclients_data.custom_fields === 'object'
    ? client.yclients_data.custom_fields : null;
  const v = custom ? custom[YC_FIELD] : null;
  const s = v === null || v === undefined ? '' : String(v).trim();
  return s ? s.slice(0, 50) : null;
}

async function maxUsed(salonId, q = db) {
  const r = await q.query(MAX_USED_SQL, [salonId]);
  return Number((r.rows ? r.rows[0] : r).max_used) || 0;
}

/** Что покажет настройка: следующий номер (без записи в БД) и максимальный уже выданный. */
async function peek(salonId) {
  const row = await db.oneOrNone('SELECT next_value FROM edoc_counters WHERE salon_id=$1 AND kind=$2', [salonId, KIND]);
  const used = await maxUsed(salonId);
  return { next: row ? Number(row.next_value) : used + 1, maxUsed: used };
}

/** Владелец задаёт следующий номер. */
async function setNext(salonId, value) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 999999999999) throw new EdocsError('bad_counter', 'Следующий номер — целое число от 1', 400);
  await db.query(
    `INSERT INTO edoc_counters (salon_id, kind, next_value) VALUES ($1, $2, $3)
     ON CONFLICT (salon_id, kind) DO UPDATE SET next_value=EXCLUDED.next_value, updated_at=NOW()`,
    [salonId, KIND, n],
  );
  return n;
}

/**
 * Номер договора пациента к отправке. Вызывается ДО сборки DOCX; присвоенный номер сразу
 * пишется в client_identity (и дата договора, если пуста) — повтор отправки возьмёт его же.
 * @returns {{ contractNo: string, source: 'identity'|'yclients'|'counter', assigned: boolean }}
 */
async function ensureContractNo({ salonId, clientId, client, docDate }) {
  return withTransaction(async (c) => {
    const row = (await c.query(
      'SELECT contract_no FROM client_identity WHERE salon_id=$1 AND client_id=$2 FOR UPDATE', [salonId, clientId],
    )).rows[0];
    if (!row) throw new EdocsError('missing_fields', 'Сначала сохраните данные пациента', 400);
    const own = String(row.contract_no || '').trim();
    if (own) return { contractNo: own, source: 'identity', assigned: false };
    let no = yclientsNumber(client);
    let source = 'yclients';
    if (!no) {
      source = 'counter';
      await c.query(
        `INSERT INTO edoc_counters (salon_id, kind, next_value) SELECT $1, $2, (${MAX_USED_SQL}) + 1
         ON CONFLICT (salon_id, kind) DO NOTHING`,
        [salonId, KIND],
      );
      for (let i = 0; ; i++) {
        const r = (await c.query(
          `UPDATE edoc_counters SET next_value=next_value+1, updated_at=NOW() WHERE salon_id=$1 AND kind=$2 RETURNING next_value-1 AS no`,
          [salonId, KIND],
        )).rows[0];
        no = String(r.no);
        if (!(await c.query(TAKEN_SQL, [salonId, no])).rows.length) break;
        if (i >= MAX_SKIP) throw new EdocsError('counter_exhausted', `Номера договоров с ${no} заняты подряд — проверьте «Следующий номер» в настройках`, 409);
      }
    }
    await c.query(
      `UPDATE client_identity SET contract_no=$3, contract_date=COALESCE(contract_date, $4::date), updated_at=NOW()
       WHERE salon_id=$1 AND client_id=$2`,
      [salonId, clientId, no, docDate || null],
    );
    return { contractNo: no, source, assigned: true };
  });
}

module.exports = { yclientsNumber, maxUsed, peek, setNext, ensureContractNo, MAX_USED_SQL, YC_FIELD };
```

- [ ] **Step 4: Тест проходит**

```bash
cd backend && npx jest backend/edocs-counter.test.js 2>&1 | grep -E "^Tests:"
```

Ожидается: `Tests: 7 passed, 7 total`.

- [ ] **Step 5: Коммит**

```bash
git add backend/edocs-counter.test.js backend/services/edocs/counter.js
git commit -m "feat(edocs): автонумерация договоров — свой номер пациента, номер YClients, счётчик" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 4: Комплекты: вид документа, источник, номер договора, тестовые номера, быстрый опрос — **Opus**

Точечные правки рабочей отправки комплекта (`packages.js`) и слоя данных (`store.js`), спека §9–§11:
- `insertPackage` пишет `status` (по умолчанию `draft`; бумажный комплект — сразу `paper`), `source` (`manual|auto|form|paper`), `signed_at` и вид документа в строку документа (решение 11: договор, согласие и акт можно смешать в одном комплекте — одна SMS вместо двух).
- `prepare` считает полноту данных с `autoContractNo` — номер присвоит автонумерация, если она включена и шаблон договора из набора печатает `contract_no` (`usesAutoContractNo`); `send` присваивает номер ДО сборки DOCX (`assignContractNo` → `counter.ensureContractNo`, событие `contract_no`). Автонумерация выключена — номер снова обязателен.
- `test-phones.js` (решение 17): при заданном `EDOCS_TEST_PHONES` комплект и повтор ссылки на чужой номер — 409 `test_phone_blocked`, в F.Doc ничего не уходит. На проде переменная не задаётся — проверка пропускает всех.
- Быстрая полоса опроса F.Doc (решение 15): комплекты, отправленные за последние 2 часа, перечитываются раз в минуту (`store.DUE_SQL`), крон опроса — каждую минуту (интервалы по-прежнему задаёт SQL). Пациент подписывает у стойки — карточка зеленеет за минуту, а не за пять.

**Files:**
- Create: `backend/services/edocs/test-phones.js`
- Modify: `backend/services/edocs/store.js`, `backend/services/edocs/packages.js`, `backend/server.js`
- Test: `backend/edocs-packages.test.js`

- [ ] **Step 1: Тест: подмены конфига и счётчика, вид документа, новый блок**

Правка 1 из 4. В `backend/edocs-packages.test.js` найти:

```js
jest.mock('./logger', () => ({ createLogger: () => mockLog }));
jest.mock('./config', () => ({ EDOCS_DEMO_PHONES: ['79200255591'] }));

const store = require('./services/edocs/store');
const s3 = require('./services/s3');
```

заменить на:

```js
jest.mock('./logger', () => ({ createLogger: () => mockLog }));
jest.mock('./config', () => ({ EDOCS_DEMO_PHONES: ['79200255591'], EDOCS_TEST_PHONES: [] }));
jest.mock('./services/edocs/counter', () => ({ ensureContractNo: jest.fn() }));

const store = require('./services/edocs/store');
const config = require('./config');
const counter = require('./services/edocs/counter');
const s3 = require('./services/s3');
```

Правка 2 из 4. В `backend/edocs-packages.test.js` найти:

```js
  pk._reset();
  store.getSettings.mockResolvedValue(SETTINGS);
```

заменить на:

```js
  pk._reset();
  config.EDOCS_TEST_PHONES = [];
  store.getSettings.mockResolvedValue(SETTINGS);
```

Правка 3 из 4. В `backend/edocs-packages.test.js` найти:

```js
    expect(pkg.payload).toEqual({ templateIds: [10], docDate: '2026-10-24', act: null, patient: { fio: 'Иванова Анна Сергеевна', phone: '79200255591' } });
    expect(docs).toEqual([{ id: expect.any(String), template_id: 10, title: 'Договор', file_name: 'Договор.docx', sort_order: 0 }]);
    const [cfg, cred, body] = fdoc.sendPackage.mock.calls[0];
```

заменить на:

```js
    expect(pkg.payload).toEqual({ templateIds: [10], docDate: '2026-10-24', act: null, patient: { fio: 'Иванова Анна Сергеевна', phone: '79200255591' } });
    expect(docs).toEqual([{ id: expect.any(String), template_id: 10, kind: 'contract', title: 'Договор', file_name: 'Договор.docx', sort_order: 0 }]);
    expect(pkg.source).toBe('manual');
    const [cfg, cred, body] = fdoc.sendPackage.mock.calls[0];
```

Правка 4 из 4. В `backend/edocs-packages.test.js` найти:

```js
    expect(fdoc.recognize).not.toHaveBeenCalled();
  });
});
```

заменить на:

```js
    expect(fdoc.recognize).not.toHaveBeenCalled();
  });
});

describe('автонумерация договора, источник комплекта, тестовые номера (спека 2026-10-25)', () => {
  const T_NUMBERED = { ...T_CONTRACT, id: 12, placeholders: ['fio', 'passport', 'contract_no', 'contract_date'] };
  beforeEach(() => {
    store.getTemplatesByIds.mockImplementation(async (sid, ids) => [T_CONTRACT, T_ACT, T_NUMBERED].filter((t) => ids.includes(t.id)));
    s3.getObjectBuffer.mockImplementation(async (key) => (key === 'k/numbered.docx' ? FILES.numbered : FILES[key]));
    T_NUMBERED.file_key = 'k/numbered.docx';
    FILES.numbered = makeDocx({ body: p('Договор № {contract_no} от {contract_date} с {fio}') });
    counter.ensureContractNo.mockResolvedValue({ contractNo: '1999', source: 'counter', assigned: true });
  });

  test('нет номера, шаблон его печатает — номер присваивается ДО сборки и попадает в документ', async () => {
    store.getIdentityRow.mockResolvedValue({ ...IDENTITY, contract_no: null });
    const r = await pk.send({ salonId: 1, userId: 4, clientId: 52, templateIds: [12], docDate: '2026-10-25', source: 'auto' });
    expect(counter.ensureContractNo).toHaveBeenCalledWith({ salonId: 1, clientId: 52, client: CLIENT, docDate: '2026-10-25' });
    const body = fdoc.sendPackage.mock.calls[0][2];
    expect(docText(Buffer.from(body.documents[0].file, 'base64'))).toBe('Договор № 1999 от 25.10.2026 с Иванова Анна Сергеевна');
    expect(store.insertPackage.mock.calls[0][0].source).toBe('auto');
    expect(store.logEvent).toHaveBeenCalledWith(expect.objectContaining({ kind: 'contract_no', clientId: 52, payload: { contractNo: '1999', source: 'counter' } }));
    expect(r.packageId).toBeTruthy();
  });

  test('свой номер у пациента — счётчик не трогается; шаблон без номера — тоже', async () => {
    await pk.send({ salonId: 1, userId: 4, clientId: 52, templateIds: [12] });
    expect(counter.ensureContractNo).not.toHaveBeenCalled();
    store.getIdentityRow.mockResolvedValue({ ...IDENTITY, contract_no: null });
    await pk.send({ salonId: 1, userId: 4, clientId: 52, templateIds: [10] });
    expect(counter.ensureContractNo).not.toHaveBeenCalled();
  });

  test('автонумерация выключена — номер договора снова обязателен', async () => {
    store.getSettings.mockResolvedValue({ ...SETTINGS, contract_autonumber: false });
    store.getIdentityRow.mockResolvedValue({ ...IDENTITY, contract_no: null });
    await expect(pk.send({ salonId: 1, userId: 4, clientId: 52, templateIds: [12] })).rejects.toMatchObject({
      code: 'missing_fields', missing: { identity: [{ key: 'contract_no', label: 'Номер договора' }], org: [] },
    });
    expect((await pk.check({ salonId: 1, clientId: 52, templateIds: [12] })).missing.identity.map((x) => x.key)).toEqual(['contract_no']);
    store.getSettings.mockResolvedValue(SETTINGS);
    expect((await pk.check({ salonId: 1, clientId: 52, templateIds: [12] })).missing.identity).toEqual([]);
  });

  test('EDOCS_TEST_PHONES: чужой номер — 409, в F.Doc ничего; свой — уходит; повтор ссылки — тоже под защитой', async () => {
    config.EDOCS_TEST_PHONES = ['79000000000'];
    await expect(pk.send({ salonId: 1, userId: 4, clientId: 52, templateIds: [10] })).rejects.toMatchObject({ code: 'test_phone_blocked', status: 409 });
    expect(fdoc.sendPackage).not.toHaveBeenCalled();
    store.getPackage.mockResolvedValue({ id: 'p', salon_id: 1, client_id: 52, status: 'sent', sent_by: 4, payload: { patient: { phone: '79200255591' } } });
    await expect(pk.permalink({ salonId: 1, userId: 4, packageId: 'p' })).rejects.toMatchObject({ code: 'test_phone_blocked' });
    expect(fdoc.sendPermalink).not.toHaveBeenCalled();
    config.EDOCS_TEST_PHONES = ['79200255591'];
    await pk.send({ salonId: 1, userId: 4, clientId: 52, templateIds: [10] });
    expect(fdoc.sendPackage).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Убедиться, что новые проверки падают**

```bash
cd backend && npx jest backend/edocs-packages.test.js 2>&1 | grep -E "Cannot find module|^Tests:"
```

Ожидается: `Tests: 4 failed, 58 passed, 62 total` — падают первый тест `send` (в документе нет `kind`) и три новых; «свой номер — счётчик не трогается» проходит и до правки.

- [ ] **Step 3: Защита тестовых номеров**

Создать `backend/services/edocs/test-phones.js`:

```js
'use strict';
// Защита дева (спека 2026-10-25, решение 17): если задан EDOCS_TEST_PHONES, любые отправки
// пациентам из «Документов» — комплекты F.Doc, повторы ссылок, анкеты в мессенджер, ручные и
// автоматические — уходят только на эти номера. Дев получает реальные вебхуки клиники и держит
// боевые аккаунты мессенджеров. На проде переменная не задаётся — проверка пропускает всех.
const config = require('../../config');
const { normalizePhoneKey } = require('../agent-gate');
const { EdocsError } = require('./errors');

function list() { return Array.isArray(config.EDOCS_TEST_PHONES) ? config.EDOCS_TEST_PHONES : []; }
function isAllowed(phone) {
  const allowed = list();
  if (!allowed.length) return true;
  const key = normalizePhoneKey(String(phone || ''));
  return !!key && allowed.includes(key);
}
function assertAllowed(phone) {
  if (isAllowed(phone)) return;
  throw new EdocsError('test_phone_blocked', `Тестовый режим: отправка только на номера ${list().join(', ')} (EDOCS_TEST_PHONES)`, 409);
}

module.exports = { isAllowed, assertAllowed };
```

- [ ] **Step 4: `store.js`: вставка комплекта и быстрая полоса опроса**

Правка 1 из 2. В `backend/services/edocs/store.js` найти:

```js
// ── комплекты и документы ──────────────────────────────────────────────────
async function insertPackage(pkg, docs) {
  await withTransaction(async (c) => {
    await c.query(
      `INSERT INTO edoc_packages (id, salon_id, client_id, record_id, kind, title, payload, sent_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)`,
      [pkg.id, pkg.salon_id, pkg.client_id, pkg.record_id || null, pkg.kind, pkg.title, JSON.stringify(pkg.payload || {}), pkg.sent_by || null],
    );
    for (const d of docs) {
      await c.query(
        `INSERT INTO edoc_documents (id, package_id, salon_id, template_id, title, file_name, sort_order)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [d.id, pkg.id, pkg.salon_id, d.template_id || null, d.title, d.file_name, d.sort_order || 0],
      );
```

заменить на:

```js
// ── комплекты и документы ──────────────────────────────────────────────────
/**
 * Новый комплект с документами. status по умолчанию 'draft' (отправка в F.Doc впереди); бумажный
 * комплект вставляется сразу 'paper' с signed_at. source — откуда: manual | auto | form | paper.
 * Вид документа (kind) пишется в строку документа: состояние «договор подписан» считается по нему.
 */
async function insertPackage(pkg, docs) {
  await withTransaction(async (c) => {
    await c.query(
      `INSERT INTO edoc_packages (id, salon_id, client_id, record_id, kind, title, payload, sent_by, status, source, signed_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, $11::timestamptz)`,
      [pkg.id, pkg.salon_id, pkg.client_id, pkg.record_id || null, pkg.kind, pkg.title, JSON.stringify(pkg.payload || {}), pkg.sent_by || null,
        pkg.status || 'draft', pkg.source || 'manual', pkg.signed_at || null],
    );
    for (const d of docs) {
      await c.query(
        `INSERT INTO edoc_documents (id, package_id, salon_id, template_id, title, file_name, sort_order, kind)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [d.id, pkg.id, pkg.salon_id, d.template_id || null, d.title, d.file_name, d.sort_order || 0, d.kind || null],
      );
```

Правка 2 из 2. В `backend/services/edocs/store.js` найти:

```js
}
// Кого опросить фоном: незавершённые — каждые 5 минут первые 60 дней, дальше раз в сутки;
// подписанные — раз в сутки 30 дней (подписанный ещё может стать «аннулирован»);
// подписанные без PDF — каждые 5 минут, пока PDF не скачаны, но тоже не дольше 30 дней
// с подписи: PDF, который не скачивается, иначе опрашивался бы вечно.
const DUE_SQL = `
  SELECT p.* FROM edoc_packages p JOIN edoc_settings s ON s.salon_id=p.salon_id AND s.enabled
  WHERE (p.status IN ('sent', 'error') AND p.created_at > NOW() - INTERVAL '60 days'
          AND (p.last_status_check_at IS NULL OR p.last_status_check_at < NOW() - INTERVAL '5 minutes'))
```

заменить на:

```js
}
// Кого опросить фоном: отправленные за последние 2 часа — раз в минуту («быстрая полоса»: пациент
// подписывает у стойки, карточка дашборда должна позеленеть за минуту, а не за пять; крон — каждую
// минуту); прочие незавершённые — каждые 5 минут первые 60 дней, дальше раз в сутки;
// подписанные — раз в сутки 30 дней (подписанный ещё может стать «аннулирован»);
// подписанные без PDF — каждые 5 минут, пока PDF не скачаны, но тоже не дольше 30 дней
// с подписи: PDF, который не скачивается, иначе опрашивался бы вечно.
const DUE_SQL = `
  SELECT p.* FROM edoc_packages p JOIN edoc_settings s ON s.salon_id=p.salon_id AND s.enabled
  WHERE (p.status IN ('sent', 'error') AND p.sent_at > NOW() - INTERVAL '2 hours'
          AND (p.last_status_check_at IS NULL OR p.last_status_check_at < NOW() - INTERVAL '1 minute'))
     OR (p.status IN ('sent', 'error') AND p.created_at > NOW() - INTERVAL '60 days'
          AND (p.last_status_check_at IS NULL OR p.last_status_check_at < NOW() - INTERVAL '5 minutes'))
```

- [ ] **Step 5: `packages.js`: автонумерация, вид документа, источник, тестовые номера**

Правка 1 из 7. В `backend/services/edocs/packages.js` найти:

```js
const { buildSendBody, safeFileName, uniqueNames, fioOf } = require('./send-body');
const { fmtDate } = require('./format');
```

заменить на:

```js
const { buildSendBody, safeFileName, uniqueNames, fioOf } = require('./send-body');
const counter = require('./counter');
const testPhones = require('./test-phones');
const { fmtDate } = require('./format');
```

Правка 2 из 7. В `backend/services/edocs/packages.js` найти:

```js
  const requisites = (settingsRow && settingsRow.requisites) || {};
  const missing = missingFor(identityRow, templates, requisites);
  if (!allowMissing && (missing.identity.length || missing.org.length)) {
    throw new EdocsError('missing_fields', 'Не хватает данных для выбранных документов', 400, { missing });
  }
  const identity = decodeRow(identityRow, secretBox.box()) || { plain: {}, secure: {}, secure_fields: [] };
  return { salonId, userId, settingsRow: settingsRow || {}, cfg, cred, client, templates, isAct, act, record, identity, requisites, missing, docDate: input.docDate || todayMsk() };
}
```

заменить на:

```js
  const requisites = (settingsRow && settingsRow.requisites) || {};
  // Номер договора при включённой автонумерации присвоит send() (counter.ensureContractNo) —
  // его отсутствие отправку не блокирует.
  const autoContractNo = usesAutoContractNo(settingsRow, templates);
  const missing = missingFor(identityRow, templates, requisites, { autoContractNo });
  if (!allowMissing && (missing.identity.length || missing.org.length)) {
    throw new EdocsError('missing_fields', 'Не хватает данных для выбранных документов', 400, { missing });
  }
  const identity = decodeRow(identityRow, secretBox.box()) || { plain: {}, secure: {}, secure_fields: [] };
  return { salonId, userId, settingsRow: settingsRow || {}, cfg, cred, client, templates, isAct, act, record, identity, requisites, missing, autoContractNo, docDate: input.docDate || todayMsk() };
}

/** Автонумерация договоров включена (по умолчанию да; нет строки настроек — тоже да). */
function autonumberOn(settingsRow) { return !settingsRow || settingsRow.contract_autonumber !== false; }
/** Номер присвоит автонумерация: она включена, и номер печатает шаблон договора из набора. */
function usesAutoContractNo(settingsRow, templates) {
  return autonumberOn(settingsRow) && (templates || []).some((t) => t.kind === 'contract' && (t.placeholders || []).includes('contract_no'));
}

/**
 * В комплекте договор, а номера у пациента нет — присвоить ДО сборки DOCX (counter.ensureContractNo
 * сразу пишет его в данные пациента: повтор отправки возьмёт тот же номер, дыр в нумерации нет).
 */
async function assignContractNo(ctx) {
  if (!ctx.autoContractNo || String(ctx.identity.plain.contract_no || '').trim()) return;
  const r = await counter.ensureContractNo({ salonId: ctx.salonId, clientId: ctx.client.id, client: ctx.client, docDate: ctx.docDate });
  ctx.identity.plain.contract_no = r.contractNo;
  if (!ctx.identity.plain.contract_date) ctx.identity.plain.contract_date = ctx.docDate;
  if (r.assigned) {
    await store.logEvent({ salonId: ctx.salonId, clientId: ctx.client.id, kind: 'contract_no', userId: ctx.userId, payload: { contractNo: r.contractNo, source: r.source } });
  }
}
```

Правка 3 из 7. В `backend/services/edocs/packages.js` найти:

```js
// Демо-стенд F.Doc шлёт настоящие SMS, а в дев-БД — живые пациенты: туда только тестовые номера.
function assertDemoPhone(ctx) {
  let host = '';
```

заменить на:

```js
// Демо-стенд F.Doc шлёт настоящие SMS, а в дев-БД — живые пациенты: туда только тестовые номера.
// Плюс общий тестовый режим модуля (EDOCS_TEST_PHONES) — на любом стенде.
function assertDemoPhone(ctx) {
  testPhones.assertAllowed(ctx.identity.plain.phone);
  let host = '';
```

Правка 4 из 7. В `backend/services/edocs/packages.js` найти:

```js
  assertDemoPhone(ctx);
  const files = [];
  for (const t of ctx.templates) files.push(await renderTemplate(ctx, t));
  const packageId = crypto.randomUUID();
  const names = uniqueNames(ctx.templates.map((t) => safeFileName(t.title)));
  const docs = ctx.templates.map((t, i) => ({ id: crypto.randomUUID(), template_id: t.id, title: t.title, file_name: names[i], sort_order: i }));
  const title = `${ctx.isAct ? 'Акт' : 'Документы'} от ${fmtDate(ctx.docDate)}`;
  // Замок — уже на вставке: черновик сразу виден в списке, и «Повторить» не должно пойти параллельно.
  return exclusive(ctx.salonId, packageId, async () => {
    await store.insertPackage({
      id: packageId, salon_id: ctx.salonId, client_id: ctx.client.id, record_id: ctx.isAct ? ctx.record.id : null,
      kind: ctx.isAct ? 'act' : 'onboarding', title, sent_by: ctx.userId,
      payload: { templateIds: ctx.templates.map((t) => t.id), docDate: ctx.docDate, act: ctx.act, patient: { fio: fioOf(ctx.identity), phone: ctx.identity.plain.phone } },
```

заменить на:

```js
  assertDemoPhone(ctx);
  await assignContractNo(ctx);
  const files = [];
  for (const t of ctx.templates) files.push(await renderTemplate(ctx, t));
  const packageId = crypto.randomUUID();
  const names = uniqueNames(ctx.templates.map((t) => safeFileName(t.title)));
  const docs = ctx.templates.map((t, i) => ({ id: crypto.randomUUID(), template_id: t.id, kind: t.kind, title: t.title, file_name: names[i], sort_order: i }));
  const title = `${ctx.isAct ? 'Акт' : 'Документы'} от ${fmtDate(ctx.docDate)}`;
  // Замок — уже на вставке: черновик сразу виден в списке, и «Повторить» не должно пойти параллельно.
  return exclusive(ctx.salonId, packageId, async () => {
    await store.insertPackage({
      id: packageId, salon_id: ctx.salonId, client_id: ctx.client.id, record_id: ctx.isAct ? ctx.record.id : null,
      kind: ctx.isAct ? 'act' : 'onboarding', title, sent_by: ctx.userId, source: input.source || 'manual',
      payload: { templateIds: ctx.templates.map((t) => t.id), docDate: ctx.docDate, act: ctx.act, patient: { fio: fioOf(ctx.identity), phone: ctx.identity.plain.phone } },
```

Правка 5 из 7. В `backend/services/edocs/packages.js` найти:

```js
  if (pkg.status !== 'sent') throw new EdocsError('bad_status', 'Ссылку можно отправить только по комплекту, который ждёт подписи', 409);
  const cfg = fdocConfig(await store.getSettings(salonId));
```

заменить на:

```js
  if (pkg.status !== 'sent') throw new EdocsError('bad_status', 'Ссылку можно отправить только по комплекту, который ждёт подписи', 409);
  testPhones.assertAllowed((pkg.payload && pkg.payload.patient && pkg.payload.patient.phone) || pkg.client_phone);
  const cfg = fdocConfig(await store.getSettings(salonId));
```

Правка 6 из 7. В `backend/services/edocs/packages.js` найти:

```js
  const settingsRow = await store.getSettings(salonId);
  return { missing: missingFor(await store.getIdentityRow(salonId, clientId), templates, (settingsRow && settingsRow.requisites) || {}) };
}
```

заменить на:

```js
  const settingsRow = await store.getSettings(salonId);
  return { missing: missingFor(await store.getIdentityRow(salonId, clientId), templates, (settingsRow && settingsRow.requisites) || {},
    { autoContractNo: usesAutoContractNo(settingsRow, templates) }) };
}
```

Правка 7 из 7. В `backend/services/edocs/packages.js` найти:

```js
  send, resend, refreshRows, refreshDue, fetchPdfs, employeeUrl, permalink, annul, preview, check, recognize,
  fdocConfig, credFor, clearCredentialPause, MAX_DOCS, _reset,
};
```

заменить на:

```js
  send, resend, refreshRows, refreshDue, fetchPdfs, employeeUrl, permalink, annul, preview, check, recognize,
  fdocConfig, credFor, clearCredentialPause, autonumberOn, usesAutoContractNo, MAX_DOCS, _reset,
};
```

- [ ] **Step 6: `server.js`: опрос F.Doc каждую минуту**

В `backend/server.js` найти:

```js
// докачка подписанных PDF в S3. EDOCS_POLL=false гасит только опрос (вебхук работает).
// Подробности — services/edocs/packages.js (refreshDue).
if (process.env.EDOCS_POLL !== 'false') {
  cron.schedule('*/5 * * * *', async () => {
    try {
```

заменить на:

```js
// докачка подписанных PDF в S3. EDOCS_POLL=false гасит только опрос (вебхук работает).
// Крон — каждую минуту, а КАК ЧАСТО опрашивать комплект, решает SQL (store.DUE_SQL): отправленные
// за 2 часа — раз в минуту (пациент подписывает у стойки — карточка дашборда зеленеет за минуту),
// прочие — раз в 5 минут и реже. Подробности — services/edocs/packages.js (refreshDue).
if (process.env.EDOCS_POLL !== 'false') {
  cron.schedule('* * * * *', async () => {
    try {
```

- [ ] **Step 7: Тесты проходят**

```bash
cd backend && npx jest backend/edocs-packages.test.js 2>&1 | grep -E "^Tests:"; npx jest backend/edocs- 2>&1 | grep -E "^(Tests|Test Suites):"
```

Ожидается: `Tests: 62 passed, 62 total`; затем `Test Suites: 11 passed`, `Tests: 258 passed`.

- [ ] **Step 8: Живой SQL: вставка комплекта с видом документа и новый `DUE_SQL`**

```bash
cd backend && node --check server.js && node scripts/edocs-store-smoke.js 2>&1 | tail -2
```

Ожидается: последняя строка — `SQL «Документов» в порядке (транзакция откатывается)`.

- [ ] **Step 9: Коммит**

```bash
git add backend/edocs-packages.test.js backend/services/edocs/test-phones.js backend/services/edocs/store.js backend/services/edocs/packages.js backend/server.js
git commit -m "feat(edocs): вид документа и источник комплекта, номер договора при отправке, EDOCS_TEST_PHONES, быстрый опрос F.Doc" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 5: «Подписано на бумаге» — `paper.js` — **Sonnet**

Спека §8. Документ подписан вне F.Doc: комплект сразу `paper`/`paper` с видом документов; дата подписания — по умолчанию сегодня, не из будущего; необязательный скан JPG/PNG/PDF до 10 МБ — тип определяется по СОДЕРЖИМОМУ (`%PDF-` или `validateImageBuffer`), а не по расширению и Content-Type; скан — в S3 `edocs/<салон>/paper/<комплект>/<uuid>.<ext>`, в `payload.paper` — дата, комментарий, ключ, тип, размер; событие `paper`. Акт на бумаге — только по состоявшемуся визиту этого пациента. F.Doc не нужен: клиника ведёт учёт бумажных документов и до подключения сервиса (решение 14). Снять ошибочную отметку можно только у бумажного комплекта и с причиной (от 3 символов): комплект → `annulled` (`store.revokePaperPackage`), событие `paper_revoke`; кто может снимать — решает ручка (задача 10). Скан отдаётся presigned-ссылкой на 15 минут.

**Files:**
- Create: `backend/services/edocs/paper.js`
- Modify: `backend/services/edocs/store.js`
- Test: `backend/edocs-paper.test.js`

- [ ] **Step 1: Падающий тест**

Создать `backend/edocs-paper.test.js`:

```js
'use strict';
// «Подписано на бумаге» (services/edocs/paper.js).
jest.mock('./services/edocs/store', () => ({
  getClient: jest.fn(), getTemplatesByIds: jest.fn(), getRecord: jest.fn(), insertPackage: jest.fn(), logEvent: jest.fn(),
  getPackage: jest.fn(), revokePaperPackage: jest.fn(),
}));
jest.mock('./services/s3', () => ({ putObject: jest.fn(), presignGet: jest.fn() }));
const store = require('./services/edocs/store');
const s3 = require('./services/s3');
const paper = require('./services/edocs/paper');
const { todayMsk } = require('./utils/period');

const T_CONTRACT = { id: 5, kind: 'contract', title: 'Договор', is_active: true };
const T_CONSENT = { id: 6, kind: 'consent_pd', title: 'Согласие ПД', is_active: false };   // выключенный шаблон — отметить можно
const T_ACT = { id: 7, kind: 'act', title: 'Акт', is_active: true };
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]), Buffer.alloc(32)]);
const PDF = Buffer.from('%PDF-1.7\n%…\n', 'latin1');

beforeEach(() => {
  jest.clearAllMocks();
  store.getClient.mockResolvedValue({ id: 52, name: 'Иванова Анна' });
  store.getTemplatesByIds.mockImplementation(async (sid, ids) => [T_CONTRACT, T_CONSENT, T_ACT].filter((t) => ids.includes(t.id)));
  store.getRecord.mockResolvedValue({ id: 100, client_id: 52, attendance: '1', deleted: false });
});

test('договор и согласие на бумаге со сканом PDF: комплект paper/paper, вид документов, скан в S3, журнал', async () => {
  const r = await paper.markPaper({ salonId: 1, userId: 4, clientId: 52, templateIds: [5, 6], signedDate: '2026-07-03',
    note: ' подписано\nв клинике ', file: { buffer: PDF, originalname: 'scan.pdf' } });
  const [pkg, docs] = store.insertPackage.mock.calls[0];
  expect(pkg).toMatchObject({ id: r.packageId, salon_id: 1, client_id: 52, record_id: null, kind: 'onboarding', status: 'paper', source: 'paper',
    sent_by: 4, signed_at: '2026-07-03T12:00:00+03:00', title: 'На бумаге: Договор, Согласие ПД' });
  expect(pkg.payload.paper).toEqual({ signedDate: '2026-07-03', note: 'подписано в клинике',
    scan: { key: expect.stringMatching(new RegExp(`^edocs/1/paper/${r.packageId}/[0-9a-f-]{36}\\.pdf$`)), mime: 'application/pdf', size: PDF.length } });
  expect(docs.map((d) => [d.template_id, d.kind])).toEqual([[5, 'contract'], [6, 'consent_pd']]);
  expect(s3.putObject).toHaveBeenCalledWith(pkg.payload.paper.scan.key, PDF, 'application/pdf');
  expect(store.logEvent).toHaveBeenCalledWith({ salonId: 1, packageId: r.packageId, clientId: 52, kind: 'paper', userId: 4,
    payload: { templateIds: [5, 6], recordId: null, scan: true } });
});

test('без скана и даты — сегодняшняя дата, S3 не трогается', async () => {
  await paper.markPaper({ salonId: 1, userId: 4, clientId: 52, templateIds: [5] });
  const [pkg] = store.insertPackage.mock.calls[0];
  expect(pkg.payload.paper).toEqual({ signedDate: todayMsk(), note: '', scan: null });
  expect(s3.putObject).not.toHaveBeenCalled();
});

test('скан — по содержимому: PNG с расширением .png проходит, «PNG» с .pdf и чужой файл — нет', async () => {
  await paper.markPaper({ salonId: 1, userId: 4, clientId: 52, templateIds: [5], file: { buffer: PNG, originalname: 'photo.png' } });
  expect(s3.putObject.mock.calls[0][2]).toBe('image/png');
  await expect(paper.markPaper({ salonId: 1, userId: 4, clientId: 52, templateIds: [5], file: { buffer: PNG, originalname: 'photo.jpg' } }))
    .rejects.toMatchObject({ code: 'bad_scan', status: 400 });
  await expect(paper.markPaper({ salonId: 1, userId: 4, clientId: 52, templateIds: [5], file: { buffer: Buffer.from('<html>…</html>'), originalname: 'x.html' } }))
    .rejects.toMatchObject({ code: 'bad_scan' });
  expect(store.insertPackage).toHaveBeenCalledTimes(1);
});

test('акт на бумаге — только по состоявшемуся визиту этого пациента', async () => {
  await expect(paper.markPaper({ salonId: 1, userId: 4, clientId: 52, templateIds: [7] })).rejects.toMatchObject({ code: 'act_needs_record' });
  store.getRecord.mockResolvedValueOnce({ id: 100, client_id: 99, attendance: '1' });
  await expect(paper.markPaper({ salonId: 1, userId: 4, clientId: 52, templateIds: [7], recordId: 100 })).rejects.toMatchObject({ code: 'not_found' });
  store.getRecord.mockResolvedValueOnce({ id: 100, client_id: 52, attendance: '0' });
  await expect(paper.markPaper({ salonId: 1, userId: 4, clientId: 52, templateIds: [7], recordId: 100 })).rejects.toMatchObject({ code: 'act_visit_not_done' });
  await paper.markPaper({ salonId: 1, userId: 4, clientId: 52, templateIds: [7], recordId: 100 });
  expect(store.insertPackage.mock.calls[0][0]).toMatchObject({ kind: 'act', record_id: 100 });
});

test('проверки: пациент, шаблоны, дата из будущего', async () => {
  store.getClient.mockResolvedValueOnce(null);
  await expect(paper.markPaper({ salonId: 1, userId: 4, clientId: 52, templateIds: [5] })).rejects.toMatchObject({ code: 'not_found', status: 404 });
  await expect(paper.markPaper({ salonId: 1, userId: 4, clientId: 52, templateIds: [] })).rejects.toMatchObject({ code: 'bad_templates' });
  await expect(paper.markPaper({ salonId: 1, userId: 4, clientId: 52, templateIds: [999] })).rejects.toMatchObject({ code: 'bad_templates' });
  await expect(paper.markPaper({ salonId: 1, userId: 4, clientId: 52, templateIds: [5], signedDate: '2099-01-01' })).rejects.toMatchObject({ code: 'bad_date' });
});

test('снять отметку: только бумажный комплект, с причиной, в журнал', async () => {
  await expect(paper.revokePaper({ salonId: 1, userId: 4, packageId: 'p', reason: '' })).rejects.toMatchObject({ code: 'bad_reason' });
  store.getPackage.mockResolvedValueOnce({ id: 'p', client_id: 52, status: 'signed', source: 'manual' });
  await expect(paper.revokePaper({ salonId: 1, userId: 4, packageId: 'p', reason: 'ошиблись пациентом' })).rejects.toMatchObject({ code: 'bad_status' });
  store.getPackage.mockResolvedValueOnce({ id: 'p', client_id: 52, status: 'paper', source: 'paper' });
  store.revokePaperPackage.mockResolvedValueOnce(true);
  expect(await paper.revokePaper({ salonId: 1, userId: 4, packageId: 'p', reason: 'ошиблись пациентом' })).toEqual({ ok: true });
  expect(store.logEvent).toHaveBeenCalledWith({ salonId: 1, packageId: 'p', clientId: 52, kind: 'paper_revoke', userId: 4, payload: { reason: 'ошиблись пациентом' } });
});

test('ссылка на скан — presigned на 15 минут; скана нет — 404', async () => {
  store.getPackage.mockResolvedValueOnce({ id: 'p', payload: { paper: { scan: { key: 'edocs/1/paper/p/x.pdf' } } } });
  s3.presignGet.mockResolvedValueOnce('https://s3/x');
  expect(await paper.scanUrl({ salonId: 1, packageId: 'p' })).toEqual({ url: 'https://s3/x' });
  expect(s3.presignGet).toHaveBeenCalledWith('edocs/1/paper/p/x.pdf', 900);
  store.getPackage.mockResolvedValueOnce({ id: 'p', payload: {} });
  await expect(paper.scanUrl({ salonId: 1, packageId: 'p' })).rejects.toMatchObject({ code: 'not_found' });
});
```

- [ ] **Step 2: Убедиться, что тест падает**

```bash
cd backend && npx jest backend/edocs-paper.test.js 2>&1 | grep -E "Cannot find module|^Tests:"
```

Ожидается: `Cannot find module './services/edocs/paper' from 'edocs-paper.test.js'`.

- [ ] **Step 3: `store.js`: снятие отметки «на бумаге»**

Правка 1 из 2. В `backend/services/edocs/store.js` найти:

```js
}
async function touchStatusCheck(salonId, ids) {
```

заменить на:

```js
}
/** Снять отметку «Подписано на бумаге»: только бумажный комплект в статусе paper. true — снято. */
async function revokePaperPackage(salonId, id) {
  const r = await db.oneOrNone(
    `UPDATE edoc_packages SET status='annulled', updated_at=NOW()
     WHERE salon_id=$1 AND id=$2 AND status='paper' AND source='paper' RETURNING id`,
    [salonId, id],
  );
  return !!r;
}
async function touchStatusCheck(salonId, ids) {
```

Правка 2 из 2. В `backend/services/edocs/store.js` найти:

```js
  getRecord, listClientVisits, actStatusesForRecords,
  insertPackage, markSent, markSendError, setEmployeeUrl, applyStatus, touchStatusCheck, getPackage, findPackageByAnyId,
  listDocuments, getDocument, setDocumentPdf, listPackages, listClientPackages, listDuePackages, DUE_SQL,
```

заменить на:

```js
  getRecord, listClientVisits, actStatusesForRecords,
  insertPackage, markSent, markSendError, setEmployeeUrl, applyStatus, revokePaperPackage, touchStatusCheck, getPackage, findPackageByAnyId,
  listDocuments, getDocument, setDocumentPdf, listPackages, listClientPackages, listDuePackages, DUE_SQL,
```

- [ ] **Step 4: Модуль бумажных документов**

Создать `backend/services/edocs/paper.js`:

```js
'use strict';
// «Подписано на бумаге» (спека 2026-10-25 §8): документ подписан вне F.Doc — комплект сразу в
// статусе 'paper' (source 'paper'), со сканом в S3 или без. F.Doc не нужен: клиника ведёт учёт
// бумажных документов и до подключения сервиса. Ошибочную отметку снимает владелец/администратор.
const crypto = require('crypto');
const store = require('./store');
const s3 = require('../s3');
const { validateImageBuffer } = require('../../utils/upload-validator');
const { EdocsError } = require('./errors');
const { safeFileName } = require('./send-body');
const { isCalendarDate, todayMsk } = require('../../utils/period');

const MAX_SCAN_BYTES = 10 * 1024 * 1024;
const MAX_DOCS = 10;
const MIME = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif' };

/** Тип скана по СОДЕРЖИМОМУ: PDF по сигнатуре %PDF-, картинка — validateImageBuffer. */
function scanType(buf, name) {
  if (!Buffer.isBuffer(buf) || !buf.length) throw new EdocsError('bad_scan', 'Файл скана пустой', 400);
  if (buf.length > MAX_SCAN_BYTES) throw new EdocsError('bad_scan', 'Скан больше 10 МБ', 400);
  if (buf.slice(0, 5).toString('latin1') === '%PDF-') return { ext: 'pdf', mime: 'application/pdf' };
  const v = validateImageBuffer(buf, name);
  if (!v.ok) throw new EdocsError('bad_scan', `Скан: ${v.error} (подходят JPG, PNG, WEBP или PDF)`, 400);
  return { ext: v.ext.replace('.', '').replace('jpeg', 'jpg'), mime: MIME[v.ext] || 'application/octet-stream' };
}

async function markPaper({ salonId, userId, clientId, templateIds, recordId = null, signedDate = null, note = '', file = null }) {
  const client = await store.getClient(salonId, clientId);
  if (!client) throw new EdocsError('not_found', 'Пациент не найден', 404);
  const ids = [...new Set(templateIds || [])];
  if (!ids.length || ids.length > MAX_DOCS) throw new EdocsError('bad_templates', `Отметьте от 1 до ${MAX_DOCS} документов`, 400);
  const templates = await store.getTemplatesByIds(salonId, ids);
  if (templates.length !== ids.length) throw new EdocsError('bad_templates', 'Шаблон не найден', 400);
  const isAct = templates.some((t) => t.kind === 'act');
  let record = null;
  if (isAct) {
    if (!recordId) throw new EdocsError('act_needs_record', 'Для акта выберите визит', 400);
    record = await store.getRecord(salonId, recordId);
    if (!record || record.client_id !== client.id) throw new EdocsError('not_found', 'Визит не найден у этого пациента', 404);
    if (record.attendance !== '1' || record.deleted) throw new EdocsError('act_visit_not_done', 'Акт — только по состоявшемуся визиту', 409);
  }
  const today = todayMsk();
  const date = signedDate || today;
  if (!isCalendarDate(date) || date > today || date < '2000-01-01') throw new EdocsError('bad_date', 'Дата подписания — не позже сегодняшней', 400);
  const text = String(note || '').replace(/[\u0000-\u001F\u007F]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 300);
  const packageId = crypto.randomUUID();
  let scan = null;
  if (file && file.buffer) {
    const t = scanType(file.buffer, file.originalname);
    const key = `edocs/${salonId}/paper/${packageId}/${crypto.randomUUID()}.${t.ext}`;
    await s3.putObject(key, file.buffer, t.mime);
    scan = { key, mime: t.mime, size: file.buffer.length };
  }
  const docs = templates.map((t, i) => ({ id: crypto.randomUUID(), template_id: t.id, kind: t.kind, title: t.title, file_name: safeFileName(t.title), sort_order: i }));
  await store.insertPackage({
    id: packageId, salon_id: salonId, client_id: client.id, record_id: record ? record.id : null, kind: isAct ? 'act' : 'onboarding',
    title: `На бумаге: ${templates.map((t) => t.title).join(', ')}`.slice(0, 200), sent_by: userId, status: 'paper', source: 'paper',
    signed_at: `${date}T12:00:00+03:00`, payload: { templateIds: ids, paper: { signedDate: date, note: text, scan } },
  }, docs);
  await store.logEvent({ salonId, packageId, clientId: client.id, kind: 'paper', userId, payload: { templateIds: ids, recordId: record ? record.id : null, scan: !!scan } });
  return { packageId };
}

async function revokePaper({ salonId, userId, packageId, reason }) {
  const why = String(reason || '').replace(/\s+/g, ' ').trim().slice(0, 300);
  if (why.length < 3) throw new EdocsError('bad_reason', 'Укажите причину', 400);
  const pkg = await store.getPackage(salonId, packageId);
  if (!pkg) throw new EdocsError('not_found', 'Комплект не найден', 404);
  if (pkg.status !== 'paper' || pkg.source !== 'paper') throw new EdocsError('bad_status', 'Снять можно только отметку «Подписано на бумаге»', 409);
  if (!(await store.revokePaperPackage(salonId, pkg.id))) throw new EdocsError('bad_status', 'Отметку уже сняли', 409);
  await store.logEvent({ salonId, packageId: pkg.id, clientId: pkg.client_id, kind: 'paper_revoke', userId, payload: { reason: why } });
  return { ok: true };
}

async function scanUrl({ salonId, packageId }) {
  const pkg = await store.getPackage(salonId, packageId);
  const scan = pkg && pkg.payload && pkg.payload.paper && pkg.payload.paper.scan;
  if (!scan || !scan.key) throw new EdocsError('not_found', 'Скана нет', 404);
  return { url: await s3.presignGet(scan.key, 900) };
}

module.exports = { markPaper, revokePaper, scanUrl, scanType, MAX_SCAN_BYTES };
```

- [ ] **Step 5: Тест проходит**

```bash
cd backend && npx jest backend/edocs-paper.test.js 2>&1 | grep -E "^Tests:"
```

Ожидается: `Tests: 7 passed, 7 total`.

- [ ] **Step 6: Коммит**

```bash
git add backend/edocs-paper.test.js backend/services/edocs/paper.js backend/services/edocs/store.js
git commit -m "feat(edocs): отметка «Подписано на бумаге» со сканом и её снятие" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

### Task 6: Доставка ссылки анкеты в мессенджер — `form-delivery.js` — **Sonnet**

Спека §6.5. Каскад как у автоуведомлений: порядок мессенджеров и «сначала мессенджер последней переписки» — из `notification_settings` салона, адресаты — `notifications/cascade.recipientFor`, переписка — `notifications/rules.lastConversation` (не прочиталась — каскад по настройкам, без падения). К следующему мессенджеру — только после ОДНОЗНАЧНОГО отказа (`transport.isDefiniteRejection` или сбой соединения ДО запроса — `ECONNREFUSED`, `ENOTFOUND`, `EAI_AGAIN`); неоднозначный сбой — стоп: сообщение могло уйти, а дубль хуже. Своё исходящее помечается `authorship.remember(…, 'system')` ДО отправки — иначе эхо читается ответом администратора и ставит Милу на паузу (инцидент 04.08); после — `pendingReplies.remember` (Мила видит, на что отвечает пациент) и `persistWhatsappOutgoing` для WhatsApp (его эхо не приходит). Ошибки — коды `form_no_phone`, `test_phone_blocked`, `form_no_channels`, `form_delivery_unknown`, `form_not_delivered` (с шагами каскада).

**Files:**
- Create: `backend/services/edocs/form-delivery.js`
- Test: `backend/edocs-form-delivery.test.js`

- [ ] **Step 1: Падающий тест**

Создать `backend/edocs-form-delivery.test.js`:

```js
'use strict';
// Доставка ссылки на анкету в мессенджер (services/edocs/form-delivery.js).
jest.mock('./services/messaging/transport', () => ({
  sendMessage: jest.fn(),
  isDefiniteRejection: (e) => !!(e && Number(e.status) >= 400 && Number(e.status) < 500),
}));
jest.mock('./services/notifications/settings', () => ({ getSettings: jest.fn() }));
jest.mock('./services/notifications/rules', () => ({ lastConversation: jest.fn() }));
jest.mock('./services/outgoing-authorship', () => ({ remember: jest.fn() }));
jest.mock('./services/agent/pending-replies', () => ({ remember: jest.fn() }));
jest.mock('./services/chat-persist', () => ({ persistWhatsappOutgoing: jest.fn() }));
jest.mock('./config', () => ({ EDOCS_TEST_PHONES: [] }));
const mockLog = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
jest.mock('./logger', () => ({ createLogger: () => mockLog }));

const transport = require('./services/messaging/transport');
const notifSettings = require('./services/notifications/settings');
const { lastConversation } = require('./services/notifications/rules');
const authorship = require('./services/outgoing-authorship');
const pendingReplies = require('./services/agent/pending-replies');
const { persistWhatsappOutgoing } = require('./services/chat-persist');
const config = require('./config');
const { deliverText } = require('./services/edocs/form-delivery');

const TEXT = 'Здравствуйте, Анна! Заполните данные: https://dev.zumrudin.ru/anketa/abc';
const order = [];

beforeEach(() => {
  jest.clearAllMocks();
  order.length = 0;
  config.EDOCS_TEST_PHONES = [];
  notifSettings.getSettings.mockResolvedValue({ default_channels: ['tdlib', 'whatsapp', 'max'], prefer_last_channel: true });
  lastConversation.mockResolvedValue({ lastChannel: null, chats: { tdlib: '5245186003' } });
  authorship.remember.mockImplementation(async () => { order.push('authorship'); });
  transport.sendMessage.mockImplementation(async (sid, target) => { order.push(`send:${target.dispatchRouting[0]}`); return { id: 777, accountId: 8 }; });
});

test('первый мессенджер каскада принял: авторство «system» ДО отправки, Мила видит реплику', async () => {
  const r = await deliverText({ salonId: 1, phone: '+7 (920) 025-55-91', text: TEXT });
  expect(r).toEqual({ channel: 'tdlib', deliveryId: '777', steps: [] });
  expect(order).toEqual(['authorship', 'send:tdlib']);
  expect(authorship.remember).toHaveBeenCalledWith(1, '79200255591', TEXT, 'system');
  expect(transport.sendMessage.mock.calls[0][1]).toMatchObject({ text: TEXT, dispatchRouting: ['tdlib'] });
  expect(pendingReplies.remember).toHaveBeenCalledWith(1, '79200255591', TEXT);
  expect(persistWhatsappOutgoing).not.toHaveBeenCalled();
});

test('«сначала мессенджер последней переписки»: WhatsApp первым, строка в «Чат» с автором system', async () => {
  lastConversation.mockResolvedValue({ lastChannel: 'whatsapp', chats: {} });
  const r = await deliverText({ salonId: 1, phone: '79200255591', text: TEXT });
  expect(r.channel).toBe('whatsapp');
  expect(persistWhatsappOutgoing).toHaveBeenCalledWith(1, { delivery: { id: 777, accountId: 8 }, phone: '79200255591', chatId: null, text: TEXT, msgType: 'text', authoredBy: 'system' });
});

test('однозначный отказ — следующий мессенджер; неоднозначный — стоп без повтора', async () => {
  transport.sendMessage
    .mockRejectedValueOnce(Object.assign(new Error('422 нет аккаунта'), { status: 422 }))
    .mockResolvedValueOnce({ id: 9 });
  const r = await deliverText({ salonId: 1, phone: '79200255591', text: TEXT });
  expect(r).toEqual({ channel: 'whatsapp', deliveryId: '9', steps: ['tdlib=отказ'] });

  transport.sendMessage.mockReset();
  transport.sendMessage.mockRejectedValueOnce(Object.assign(new Error('timeout'), { code: 'ECONNABORTED' }));
  await expect(deliverText({ salonId: 1, phone: '79200255591', text: TEXT })).rejects.toMatchObject({ code: 'form_delivery_unknown', status: 502 });
  expect(transport.sendMessage).toHaveBeenCalledTimes(1);
});

test('сбой соединения ДО запроса (ECONNREFUSED) — однозначный, каскад идёт дальше', async () => {
  transport.sendMessage
    .mockRejectedValueOnce(Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }))
    .mockResolvedValueOnce({ id: 10 });
  expect((await deliverText({ salonId: 1, phone: '79200255591', text: TEXT })).channel).toBe('whatsapp');
});

test('все отказали — form_not_delivered с шагами; нет номера; нет мессенджеров; тестовый режим', async () => {
  transport.sendMessage.mockRejectedValue(Object.assign(new Error('400'), { status: 400 }));
  await expect(deliverText({ salonId: 1, phone: '79200255591', text: TEXT })).rejects.toMatchObject({
    code: 'form_not_delivered', steps: ['tdlib=отказ', 'whatsapp=отказ', 'max=отказ'] });
  await expect(deliverText({ salonId: 1, phone: '', text: TEXT })).rejects.toMatchObject({ code: 'form_no_phone' });
  notifSettings.getSettings.mockResolvedValueOnce({ default_channels: [], prefer_last_channel: true });
  await expect(deliverText({ salonId: 1, phone: '79200255591', text: TEXT })).rejects.toMatchObject({ code: 'form_no_channels' });
  config.EDOCS_TEST_PHONES = ['79000000000'];
  transport.sendMessage.mockClear();
  await expect(deliverText({ salonId: 1, phone: '79200255591', text: TEXT })).rejects.toMatchObject({ code: 'test_phone_blocked' });
  expect(transport.sendMessage).not.toHaveBeenCalled();
});

test('переписка не прочиталась — каскад по настройкам, без падения', async () => {
  lastConversation.mockRejectedValue(new Error('db down'));
  expect((await deliverText({ salonId: 1, phone: '79200255591', text: TEXT })).channel).toBe('tdlib');
});
```

- [ ] **Step 2: Убедиться, что тест падает**

```bash
cd backend && npx jest backend/edocs-form-delivery.test.js 2>&1 | grep -E "Cannot find module|^Tests:"
```

Ожидается: `Cannot find module './services/edocs/form-delivery' from 'edocs-form-delivery.test.js'`.

- [ ] **Step 3: Модуль доставки**

Создать `backend/services/edocs/form-delivery.js`:

```js
'use strict';
// Доставка ссылки на анкету пациенту в мессенджер (спека 2026-10-25 §6.5). Каскад — как у
// автоуведомлений: порядок мессенджеров и «сначала последняя переписка» из notification_settings
// салона, адресаты notifications/cascade.recipientFor. К следующему мессенджеру — только после
// ОДНОЗНАЧНОГО отказа (4xx/нет аккаунта или сбой соединения до запроса); неоднозначный сбой —
// стоп: сообщение могло уйти, а дубль хуже. Своё исходящее помечается ДО отправки (иначе эхо
// читается ответом администратора и ставит Милу на паузу — инцидент 04.08), после — pendingReplies
// (Мила видит, на что отвечает пациент) и запись в «Чат» для WhatsApp (его эхо не приходит).
const transport = require('../messaging/transport');
const notifSettings = require('../notifications/settings');
const { lastConversation } = require('../notifications/rules');
const { buildCascade, recipientFor, canonPhone } = require('../notifications/cascade');
const authorship = require('../outgoing-authorship');
const pendingReplies = require('../agent/pending-replies');
const { persistWhatsappOutgoing } = require('../chat-persist');
const testPhones = require('./test-phones');
const { EdocsError, shortError } = require('./errors');
const { createLogger } = require('../../logger');

const logger = createLogger('EdocsFormDelivery');
const CONNECT_FAIL_CODES = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN']);

/**
 * Отправить текст пациенту. @returns {{ channel, deliveryId, steps }}
 * Бросает EdocsError: form_no_phone, test_phone_blocked, form_no_channels, form_delivery_unknown, form_not_delivered.
 */
async function deliverText({ salonId, phone, text }) {
  const p = canonPhone(phone);
  if (!p) throw new EdocsError('form_no_phone', 'У пациента нет номера телефона', 409);
  testPhones.assertAllowed(p);
  const cfg = await notifSettings.getSettings(salonId);
  let conv = { lastChannel: null, chats: {} };
  try { conv = (await lastConversation(salonId, p)) || conv; } catch (e) { logger.warn(`переписка ${salonId}: ${shortError(e)} — каскад по настройкам`); }
  const cascade = buildCascade(cfg.default_channels, { preferLast: cfg.prefer_last_channel !== false, lastChannel: conv.lastChannel });
  if (!cascade.length) throw new EdocsError('form_no_channels', 'В настройках автоуведомлений не выбран ни один мессенджер', 409);
  try { await authorship.remember(salonId, p, text, 'system'); } catch (e) { logger.warn(`authorship ${salonId}: ${shortError(e)}`); }
  const steps = [];
  for (const ch of cascade) {
    const target = recipientFor(ch, p, conv.chats || {});
    if (!target) { steps.push(`${ch}=нет адресата`); continue; }
    let delivery;
    try {
      delivery = await transport.sendMessage(salonId, { ...target, text });
    } catch (e) {
      const definite = transport.isDefiniteRejection(e) || CONNECT_FAIL_CODES.has(e && e.code);
      if (!definite) {
        logger.warn(`анкета ${salonId}: ${ch} — неоднозначный сбой, каскад остановлен: ${shortError(e)}`);
        throw new EdocsError('form_delivery_unknown', `${ch}: мессенджер не подтвердил отправку — сообщение могло уйти, проверьте переписку`, 502, { steps });
      }
      steps.push(`${ch}=отказ`);
      continue;
    }
    try { pendingReplies.remember(salonId, p, text); } catch (e) { logger.warn(`pending ${salonId}: ${shortError(e)}`); }
    if (ch === 'whatsapp' && delivery) {
      try {
        await persistWhatsappOutgoing(salonId, { delivery, phone: p, chatId: null, text, msgType: 'text', authoredBy: 'system' });
      } catch (e) { logger.warn(`persist wa ${salonId}: ${shortError(e)}`); }
    }
    return { channel: ch, deliveryId: delivery && delivery.id != null ? String(delivery.id) : null, steps };
  }
  throw new EdocsError('form_not_delivered', `Ни один мессенджер не принял сообщение (${steps.join(', ') || 'нет адресатов'}) — покажите пациенту QR-код`, 502, { steps });
}

module.exports = { deliverText };
```

- [ ] **Step 4: Тест проходит**

```bash
cd backend && npx jest backend/edocs-form-delivery.test.js 2>&1 | grep -E "^Tests:"
```

Ожидается: `Tests: 6 passed, 6 total`.

- [ ] **Step 5: Коммит**

```bash
git add backend/edocs-form-delivery.test.js backend/services/edocs/form-delivery.js
git commit -m "feat(edocs): доставка ссылки анкеты в мессенджер каскадом автоуведомлений" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

### Task 7: SQL доски и анкет — `board-store.js`, `forms-store.js` — **Opus**

Два модуля запросов, всё ограничено `salon_id` (правило проекта Multi-salon).

`board-store.js` — записи окна доски (удалённые и неявки отсечены, «первичный» — у пациента нет состоявшейся записи раньше этой), документы комплектов пациентов с видом (у строк до миграции — вид шаблона), данные пациентов БЕЗ расшифровки (полнота считается по `secure_fields`), последняя анкета пациента (при равном `created_at` активная впереди — иначе выбор случаен), заметки автоматики, «Вся база» с фильтрами из белого списка `BASE_FILTERS`, визиты и история пациента, настройки доски и `ensureSettingsRow` (строка настроек заводится при первом открытии — иначе у салона без строки не было бы `acts_required_from`). DATE-колонки — через `to_char`: pg отдаёт DATE полуночью по Москве, а `toISOString()` дал бы вчерашний день (CLAUDE.md, раздел про Jest и TZ).

`forms-store.js` — анкеты: вставка с отзывом прежней активной в одной транзакции, поиск по sha256 токена, условные переходы статуса (одна анкета принимается один раз; отозванная и устаревшая не оживают), счётчики попыток и распознаваний, устаревание, ближайший визит пациента, название клиники.

Юнит-тесты модулей выше подменяют `db` и SQL не видят — настоящие запросы на дев-БД прогоняет задача 12.

**Files:**
- Create: `backend/services/edocs/board-store.js`, `backend/services/edocs/forms-store.js`

- [ ] **Step 1: SQL доски и страницы пациента**

Создать `backend/services/edocs/board-store.js`:

```js
'use strict';
// SQL дашборда «Документов» и страницы пациента. Всё ограничено salon_id. Паспорт здесь НЕ
// расшифровывается: полнота данных считается по secure_fields (какие поля заполнены).
// DATE-колонки — через to_char (pg отдаёт DATE полуночью по Москве, toISOString дал бы вчера).
const { db } = require('../../db');

// Удалённые записи и неявки на дашборд не попадают: документы им не нужны.
const LIVE_RECORD = `COALESCE(r.status, '') NOT IN ('deleted', 'no_show') AND NOT COALESCE((r.raw_payload->>'deleted')::boolean, false)`;
const RECORD_FIELDS = `r.id, r.client_id, r.yclients_record_id, r.services, r.staff, r.status,
  to_char(r.visit_date, 'YYYY-MM-DD') AS visit_date, r.visit_datetime AS visit_at,
  (r.raw_payload->>'attendance') AS attendance, (r.raw_payload->>'paid_full') AS paid_full`;
// Вид документа: из строки документа; у старых строк до миграции — из шаблона.
const DOC_SELECT = `SELECT p.client_id, d.package_id, COALESCE(d.kind, t.kind) AS kind, d.title, p.status AS package_status,
    p.record_id, p.source, p.created_at, p.sent_at, p.signed_at, p.last_error
  FROM edoc_documents d JOIN edoc_packages p ON p.id = d.package_id
  LEFT JOIN edoc_templates t ON t.id = d.template_id`;

/** Записи окна дашборда с пациентом; has_prior_visit — была ли у пациента состоявшаяся запись раньше этого дня. */
const BOARD_RECORDS_SQL = `
  SELECT ${RECORD_FIELDS}, c.name AS client_name, c.phone AS client_phone,
    EXISTS (SELECT 1 FROM records p WHERE p.salon_id = r.salon_id AND p.client_id = r.client_id
            AND p.status = 'arrived' AND p.visit_date < r.visit_date) AS has_prior_visit
  FROM records r JOIN clients c ON c.id = r.client_id AND c.salon_id = r.salon_id
  WHERE r.salon_id = $1 AND r.visit_date BETWEEN $2::date AND $3::date AND ${LIVE_RECORD}
  ORDER BY r.visit_datetime NULLS LAST, r.id`;
async function listBoardRecords(salonId, from, to) {
  return db.any(BOARD_RECORDS_SQL, [salonId, from, to]);
}

async function listDocsForClients(salonId, clientIds) {
  if (!clientIds.length) return [];
  return db.any(`${DOC_SELECT} WHERE p.salon_id = $1 AND p.client_id = ANY($2::int[])`, [salonId, clientIds]);
}

async function listIdentitiesForClients(salonId, clientIds) {
  if (!clientIds.length) return [];
  return db.any(
    `SELECT client_id, last_name, first_name, middle_name, to_char(birth_date, 'YYYY-MM-DD') AS birth_date, gender, phone, email,
            contract_no, to_char(contract_date, 'YYYY-MM-DD') AS contract_date, secure_fields
     FROM client_identity WHERE salon_id = $1 AND client_id = ANY($2::int[])`,
    [salonId, clientIds],
  );
}

/** Последняя анкета каждого пациента (при равном времени — действующая: она и есть текущая). */
async function listLatestForms(salonId, clientIds) {
  if (!clientIds.length) return [];
  return db.any(
    `SELECT DISTINCT ON (client_id) id, client_id, record_id, status, source, created_at, expires_at, delivered_via, delivered_at,
            opened_at, submitted_at, package_id, last_error
     FROM edoc_patient_forms WHERE salon_id = $1 AND client_id = ANY($2::int[])
     ORDER BY client_id, created_at DESC, (status = 'active') DESC`,
    [salonId, clientIds],
  );
}

/** Свежие (3 суток) строки журнала автоматики — по последней на пару «вид × запись». */
async function listAutoNotes(salonId, clientIds) {
  if (!clientIds.length) return [];
  return db.any(
    `SELECT DISTINCT ON (client_id, kind, record_id) client_id, record_id, kind, status, reason, created_at
     FROM edoc_auto_jobs WHERE salon_id = $1 AND client_id = ANY($2::int[]) AND created_at > NOW() - INTERVAL '3 days'
     ORDER BY client_id, kind, record_id, created_at DESC`,
    [salonId, clientIds],
  );
}

// «Вся база»: флаги по каждому пациенту. Незакрытые акты — состоявшиеся оплаченные визиты с
// acts_required_from без подписанного акта (того же правила, что и карточки дашборда).
const BASE_FILTERS = {
  all: '',
  no_contract: 'AND NOT COALESCE(dc.contract_signed, false)',
  no_consent: 'AND NOT COALESCE(dc.consent_signed, false)',
  open_acts: 'AND COALESCE(a.open_acts, 0) > 0',
  pending: 'AND COALESCE(dc.pending, false)',
  ready: 'AND COALESCE(dc.contract_signed, false) AND COALESCE(dc.consent_signed, false) AND COALESCE(a.open_acts, 0) = 0',
};
async function listBaseClients(salonId, { search = '', filter = 'all', actsFrom = null, limit = 50, offset = 0 } = {}) {
  const params = [salonId, actsFrom];
  let where = '';
  const s = String(search || '').trim();
  const digits = s.replace(/\D/g, '');
  if (digits.length >= 4) {
    params.push(`%${digits.slice(-10)}%`);
    where = `AND regexp_replace(COALESCE(c.phone, ''), '\\D', '', 'g') LIKE $${params.length}`;
  } else if (s.length >= 2) {
    params.push(`%${s.replace(/[\\%_]/g, (m) => `\\${m}`)}%`);
    where = `AND c.name ILIKE $${params.length}`;
  }
  params.push(limit, offset);
  return db.any(
    `WITH dc AS (
       SELECT p.client_id,
         bool_or(COALESCE(d.kind, t.kind) = 'contract' AND p.status IN ('signed', 'paper')) AS contract_signed,
         bool_or(COALESCE(d.kind, t.kind) = 'consent_pd' AND p.status IN ('signed', 'paper')) AS consent_signed,
         bool_or(p.status = 'sent') AS pending
       FROM edoc_packages p JOIN edoc_documents d ON d.package_id = p.id LEFT JOIN edoc_templates t ON t.id = d.template_id
       WHERE p.salon_id = $1 GROUP BY p.client_id
     ), a AS (
       SELECT r.client_id, count(*)::int AS open_acts FROM records r
       WHERE r.salon_id = $1 AND r.status = 'arrived' AND (r.raw_payload->>'paid_full') = '1'
         AND r.visit_date >= COALESCE($2::date, CURRENT_DATE) AND ${LIVE_RECORD}
         AND NOT EXISTS (SELECT 1 FROM edoc_packages p JOIN edoc_documents d ON d.package_id = p.id
                         LEFT JOIN edoc_templates t ON t.id = d.template_id
                         WHERE p.salon_id = r.salon_id AND p.record_id = r.id AND COALESCE(d.kind, t.kind) = 'act'
                           AND p.status IN ('signed', 'paper'))
       GROUP BY r.client_id
     )
     SELECT c.id, c.name, c.phone, c.last_visit_at,
       COALESCE(dc.contract_signed, false) AS contract_signed, COALESCE(dc.consent_signed, false) AS consent_signed,
       COALESCE(dc.pending, false) AS pending, COALESCE(a.open_acts, 0) AS open_acts, count(*) OVER () AS total
     FROM clients c LEFT JOIN dc ON dc.client_id = c.id LEFT JOIN a ON a.client_id = c.id
     WHERE c.salon_id = $1 ${where} ${BASE_FILTERS[filter] || ''}
     ORDER BY c.last_visit_at DESC NULLS LAST, c.id DESC
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );
}

/** Визиты пациента для страницы: от from до to (прошлые и будущие), без удалённых и неявок. */
async function listClientRecords(salonId, clientId, from, to) {
  return db.any(
    `SELECT ${RECORD_FIELDS},
       EXISTS (SELECT 1 FROM records p WHERE p.salon_id = r.salon_id AND p.client_id = r.client_id
               AND p.status = 'arrived' AND p.visit_date < r.visit_date) AS has_prior_visit
     FROM records r WHERE r.salon_id = $1 AND r.client_id = $2 AND r.visit_date BETWEEN $3::date AND $4::date AND ${LIVE_RECORD}
     ORDER BY r.visit_datetime NULLS LAST, r.id LIMIT 60`,
    [salonId, clientId, from, to],
  );
}

/** История пациента: журнал «Документов» по client_id (без паспортных данных — их там нет). */
async function listClientEvents(salonId, clientId, limit = 40) {
  return db.any(
    `SELECT e.id, e.kind, e.package_id, e.payload, e.created_at, u.name AS user_name
     FROM edoc_events e LEFT JOIN users u ON u.id = e.user_id
     WHERE e.salon_id = $1 AND e.client_id = $2 ORDER BY e.created_at DESC, e.id DESC LIMIT $3`,
    [salonId, clientId, limit],
  );
}

/** Настройки для дашборда; acts_required_from — строкой 'YYYY-MM-DD' (DATE через to_char, см. шапку). */
async function getBoardSettings(salonId) {
  return db.oneOrNone(
    `SELECT s.*, to_char(s.acts_required_from, 'YYYY-MM-DD') AS acts_from, u.name AS auto_sender_name
     FROM edoc_settings s LEFT JOIN users u ON u.id = s.auto_sender_user_id AND u.salon_id = s.salon_id
     WHERE s.salon_id = $1`,
    [salonId],
  );
}

/** Строка настроек есть всегда: acts_required_from = дата первого открытия, если модуль не настраивали. */
async function ensureSettingsRow(salonId) {
  await db.query('INSERT INTO edoc_settings (salon_id) VALUES ($1) ON CONFLICT (salon_id) DO NOTHING', [salonId]);
}

module.exports = {
  listBoardRecords, listDocsForClients, listIdentitiesForClients, listLatestForms, listAutoNotes,
  listBaseClients, listClientRecords, listClientEvents, getBoardSettings, ensureSettingsRow, BOARD_RECORDS_SQL, BASE_FILTERS,
};
```

- [ ] **Step 2: SQL анкет**

Создать `backend/services/edocs/forms-store.js`:

```js
'use strict';
// SQL анкет пациента (edoc_patient_forms). Запросы администратора ограничены salon_id; публичные
// ищут анкету по sha256 токена и дальше работают с её salon_id. Переходы статуса — условными
// UPDATE: одна анкета принимается один раз, отозванная/устаревшая не оживает.
const { db, withTransaction } = require('../../db');

const COLS = `id, salon_id, client_id, record_id, token_enc, status, fields, kinds, send_docs, sender_user_id, source, created_by,
  expires_at, delivered_via, delivered_at, opened_at, submitted_at, submit_attempts, recognize_count, package_id, last_error, created_at`;

/** Новая анкета; прежние активные анкеты пациента отзываются в той же транзакции. @returns {string[]} id отозванных */
async function insertForm(f) {
  return withTransaction(async (c) => {
    const revoked = (await c.query(
      `UPDATE edoc_patient_forms SET status='revoked', updated_at=NOW() WHERE salon_id=$1 AND client_id=$2 AND status='active' RETURNING id`,
      [f.salon_id, f.client_id],
    )).rows.map((r) => r.id);
    await c.query(
      `INSERT INTO edoc_patient_forms (id, salon_id, client_id, record_id, token_hash, token_enc, fields, kinds, send_docs,
         sender_user_id, source, created_by, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9, $10, $11, $12, $13)`,
      [f.id, f.salon_id, f.client_id, f.record_id || null, f.token_hash, f.token_enc, JSON.stringify(f.fields || []),
        JSON.stringify(f.kinds || []), !!f.send_docs, f.sender_user_id || null, f.source || 'manual', f.created_by || null, f.expires_at],
    );
    return revoked;
  });
}
async function getForm(salonId, id) {
  return db.oneOrNone(`SELECT ${COLS} FROM edoc_patient_forms WHERE salon_id=$1 AND id=$2`, [salonId, id]);
}
async function getFormByHash(tokenHash) {
  return db.oneOrNone(`SELECT ${COLS} FROM edoc_patient_forms WHERE token_hash=$1`, [tokenHash]);
}
async function setDelivered(id, via) {
  await db.query('UPDATE edoc_patient_forms SET delivered_via=$2, delivered_at=NOW(), updated_at=NOW() WHERE id=$1', [id, via]);
}
/** Первое открытие пациентом. true — это было первое. */
async function markOpened(id) {
  const r = await db.oneOrNone(`UPDATE edoc_patient_forms SET opened_at=NOW(), updated_at=NOW() WHERE id=$1 AND opened_at IS NULL RETURNING id`, [id]);
  return !!r;
}
/** Счётчик попыток отправки анкеты; возвращает новое значение. */
async function incAttempts(id) {
  const r = await db.oneOrNone(`UPDATE edoc_patient_forms SET submit_attempts=submit_attempts+1, updated_at=NOW() WHERE id=$1 RETURNING submit_attempts`, [id]);
  return r ? Number(r.submit_attempts) : 0;
}
/** Ещё одно распознавание, если лимит не исчерпан. true — можно распознавать. */
async function takeRecognize(id, limit) {
  const r = await db.oneOrNone(
    `UPDATE edoc_patient_forms SET recognize_count=recognize_count+1, updated_at=NOW()
     WHERE id=$1 AND status='active' AND recognize_count < $2 RETURNING recognize_count`, [id, limit]);
  return !!r;
}
/** Анкета принята (один раз): active → submitted. true — приняли мы. */
async function markSubmitted(id, consent) {
  const r = await db.oneOrNone(
    `UPDATE edoc_patient_forms SET status='submitted', submitted_at=NOW(), consent=$2::jsonb, updated_at=NOW()
     WHERE id=$1 AND status='active' AND expires_at > NOW() RETURNING id`, [id, JSON.stringify(consent || {})]);
  return !!r;
}
/** Данные не сохранились после приёма — вернуть анкету пациенту (повторит отправку). */
async function reopen(id) {
  await db.query(`UPDATE edoc_patient_forms SET status='active', submitted_at=NULL, consent=NULL, updated_at=NOW() WHERE id=$1 AND status='submitted'`, [id]);
}
async function setResult(id, { packageId = null, error = null }) {
  await db.query('UPDATE edoc_patient_forms SET package_id=COALESCE($2, package_id), last_error=$3, updated_at=NOW() WHERE id=$1',
    [id, packageId, error ? String(error).slice(0, 500) : null]);
}
async function revoke(salonId, id) {
  const r = await db.oneOrNone(`UPDATE edoc_patient_forms SET status='revoked', updated_at=NOW() WHERE salon_id=$1 AND id=$2 AND status='active' RETURNING id, client_id`, [salonId, id]);
  return r || null;
}
/** Устаревшие активные анкеты → expired (крон). @returns [{ id, salon_id, client_id }] */
async function expireDue() {
  return db.any(`UPDATE edoc_patient_forms SET status='expired', updated_at=NOW() WHERE status='active' AND expires_at <= NOW() RETURNING id, salon_id, client_id`);
}
/** Ближайший будущий визит пациента (для приветствия и текста сообщения). */
async function nextVisit(salonId, clientId) {
  return db.oneOrNone(
    `SELECT id, visit_datetime FROM records
     WHERE salon_id=$1 AND client_id=$2 AND visit_datetime > NOW() AND COALESCE(status, '') NOT IN ('deleted', 'no_show')
       AND NOT COALESCE((raw_payload->>'deleted')::boolean, false)
     ORDER BY visit_datetime LIMIT 1`, [salonId, clientId]);
}
async function recordVisit(salonId, recordId) {
  return db.oneOrNone('SELECT id, visit_datetime FROM records WHERE salon_id=$1 AND id=$2', [salonId, recordId]);
}
async function salonName(salonId) {
  const r = await db.oneOrNone('SELECT name FROM salons WHERE id=$1', [salonId]);
  return (r && r.name) || '';
}

module.exports = {
  insertForm, getForm, getFormByHash, setDelivered, markOpened, incAttempts, takeRecognize, markSubmitted, reopen, setResult, revoke,
  expireDue, nextVisit, recordVisit, salonName,
};
```

- [ ] **Step 3: Модули грузятся**

```bash
cd backend && node -e "require('./services/edocs/board-store'); require('./services/edocs/forms-store'); console.log('ok')"
```

Ожидается: `ok`.

- [ ] **Step 4: Коммит**

```bash
git add backend/services/edocs/board-store.js backend/services/edocs/forms-store.js
git commit -m "feat(edocs): SQL дашборда, страницы пациента и анкет" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 8: Анкета пациента — `forms.js` — **Opus**

Спека §6. Ссылка `<EDOCS_PUBLIC_URL>/anketa/<токен>` (при ручном создании без переменной — адрес из запроса), токен — 32 случайных байта base64url; в БД — sha256 (поиск) и шифротекст `secretBox` (показать QR и переотправить ТУ ЖЕ ссылку); сам токен не пишется ни в журнал, ни в лог. QR — data URL пакетом `qrcode`.
- Поля анкеты — под шаблоны видов, которые нужно отправить (`fieldsFor`), без телефона: номер для SMS F.Doc меняет только клиника. Новая анкета отзывает прежнюю активную (событие `form_revoked`). Отправка в мессенджер — `form-delivery.js`, итог — в ответе и журнале.
- Публичный просмотр (`publicView`) отдаёт только название клиники, личное имя для приветствия, дату визита и список полей — уже известные данные пациента не отдаются: у кого ссылка, тот паспорт не прочитает. Кривой токен — `not_found` без запроса в БД. Первое открытие — в журнал.
- Приём (`publicSubmit`): согласие обязательно; обязательные поля; та же проверка `identity.validateIdentity`; поле, которого нет в анкете, и телефон из тела не принимаются; слияние с прежними данными (присланное перезаписывает, остальное сохраняется), `source='patient_form'`; затем — если `send_docs` — ФОНОМ уходят только неподписанные документы учёткой `sender_user_id` (ответ пациенту F.Doc не ждёт, итог — в анкете и журнале). Данные не сохранились — анкета снова доступна. Лимит неверных отправок — 20.
- Фото паспорта: не больше 3 распознаваний на анкету (квота F.Doc), в ответ — только поля анкеты; без F.Doc недоступно.

**Files:**
- Create: `backend/services/edocs/forms.js`
- Test: `backend/edocs-forms.test.js`

- [ ] **Step 1: Падающий тест**

Создать `backend/edocs-forms.test.js`:

```js
'use strict';
// Анкета пациента (services/edocs/forms.js): создание, ссылка и QR, публичная сторона, приём данных.
jest.mock('./services/edocs/store', () => ({
  getClient: jest.fn(), getSettings: jest.fn(), listTemplates: jest.fn(), logEvent: jest.fn(), getIdentityRow: jest.fn(),
  upsertIdentity: jest.fn(), getCredentials: jest.fn(),
}));
jest.mock('./services/edocs/forms-store', () => ({
  insertForm: jest.fn(), getForm: jest.fn(), getFormByHash: jest.fn(), setDelivered: jest.fn(), markOpened: jest.fn(), incAttempts: jest.fn(),
  takeRecognize: jest.fn(), markSubmitted: jest.fn(), reopen: jest.fn(), setResult: jest.fn(), revoke: jest.fn(), expireDue: jest.fn(),
  nextVisit: jest.fn(), recordVisit: jest.fn(), salonName: jest.fn(),
}));
jest.mock('./services/edocs/board-store', () => ({ listDocsForClients: jest.fn() }));
jest.mock('./services/edocs/packages', () => ({ send: jest.fn(), recognize: jest.fn() }));
jest.mock('./services/edocs/form-delivery', () => ({ deliverText: jest.fn() }));
jest.mock('./utils/secret-box', () => ({
  box: () => ({
    encrypt: (x) => `enc:${x}`, decrypt: (x) => String(x).replace(/^enc:/, ''),
    encryptJson: (o) => `enc:${JSON.stringify(o)}`, decryptJson: (x) => JSON.parse(String(x).replace(/^enc:/, '')),
  }),
}));
jest.mock('./config', () => ({ EDOCS_PUBLIC_URL: 'https://dev.zumrudin.ru', CERT_REQUEST_POLICY_URL: '/privacy-policy.html' }));
jest.mock('sharp', () => () => ({ rotate: () => ({ resize: () => ({ jpeg: () => ({ toBuffer: async () => Buffer.from('JPEG') }) }) }) }));
const mockLog = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
jest.mock('./logger', () => ({ createLogger: () => mockLog }));

const crypto = require('crypto');
const store = require('./services/edocs/store');
const fstore = require('./services/edocs/forms-store');
const boardStore = require('./services/edocs/board-store');
const packages = require('./services/edocs/packages');
const delivery = require('./services/edocs/form-delivery');
const config = require('./config');
const forms = require('./services/edocs/forms');

const T_CONTRACT = { id: 5, kind: 'contract', title: 'Договор', sort_order: 0, placeholders: ['fio', 'passport', 'address', 'contract_no', 'phone'] };
const T_CONSENT = { id: 6, kind: 'consent_pd', title: 'Согласие', sort_order: 1, placeholders: ['fio', 'birth_date'] };
const T_ACT = { id: 7, kind: 'act', title: 'Акт', sort_order: 2, placeholders: ['fio', 'services'] };
const CLIENT = { id: 52, name: 'Иванова Анна Сергеевна', phone: '+79200255591', yclients_data: {} };
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const TOKEN = 'A'.repeat(43);
const FORM = {
  id: 'f-1', salon_id: 1, client_id: 52, record_id: null, token_enc: `enc:${TOKEN}`, status: 'active',
  fields: [{ key: 'last_name', required: true }, { key: 'first_name', required: true }, { key: 'middle_name', required: false },
    { key: 'passport_series', required: true }, { key: 'passport_number', required: true }, { key: 'address', required: true }],
  kinds: ['contract', 'consent_pd'], send_docs: true, sender_user_id: 4, source: 'manual', expires_at: new Date(Date.now() + 86400000).toISOString(),
  recognize_count: 0, created_at: new Date().toISOString(),
};
const SETTINGS = { enabled: true, corp_id: 'C1', form_ttl_days: 7, form_message: null };

beforeEach(() => {
  jest.clearAllMocks();
  config.EDOCS_PUBLIC_URL = 'https://dev.zumrudin.ru';
  store.getClient.mockResolvedValue(CLIENT);
  store.getSettings.mockResolvedValue(SETTINGS);
  store.listTemplates.mockResolvedValue([T_CONTRACT, T_CONSENT, T_ACT]);
  store.getIdentityRow.mockResolvedValue(null);
  store.getCredentials.mockResolvedValue({ user_id: 4, fail_count: 0 });
  fstore.insertForm.mockResolvedValue([]);
  fstore.salonName.mockResolvedValue('PERI CLINIC');
  fstore.nextVisit.mockResolvedValue({ id: 100, visit_datetime: '2026-10-26T08:00:00Z' });
  fstore.getFormByHash.mockResolvedValue(FORM);
  fstore.getForm.mockResolvedValue(FORM);
  fstore.incAttempts.mockResolvedValue(1);
  fstore.markSubmitted.mockResolvedValue(true);
  fstore.markOpened.mockResolvedValue(true);
  boardStore.listDocsForClients.mockResolvedValue([]);
  packages.send.mockResolvedValue({ packageId: 'pkg-1' });
  delivery.deliverText.mockResolvedValue({ channel: 'whatsapp', deliveryId: '9', steps: [] });
});

describe('createForm', () => {
  test('ссылка с токеном, хэш и шифротекст в БД, QR, поля под шаблоны договора и согласия', async () => {
    const r = await forms.createForm({ salonId: 1, userId: 4, clientId: 52 });
    const row = fstore.insertForm.mock.calls[0][0];
    const token = r.url.split('/anketa/')[1];
    expect(r.url).toMatch(/^https:\/\/dev\.zumrudin\.ru\/anketa\/[A-Za-z0-9_-]{43}$/);
    expect(row).toMatchObject({ salon_id: 1, client_id: 52, token_hash: sha(token), token_enc: `enc:${token}`, kinds: ['contract', 'consent_pd'],
      send_docs: true, sender_user_id: 4, source: 'manual', created_by: 4 });
    expect(row.fields.map((f) => f.key)).toEqual(['last_name', 'first_name', 'middle_name', 'birth_date', 'passport_series', 'passport_number', 'address']);
    expect(row.fields.find((f) => f.key === 'middle_name').required).toBe(false);
    expect(Date.parse(row.expires_at) - Date.now()).toBeGreaterThan(6.9 * 86400000);
    expect(r.qr).toMatch(/^data:image\/png;base64,/);
    expect(r.delivery).toBeNull();
    expect(store.logEvent).toHaveBeenCalledWith(expect.objectContaining({ kind: 'form_created', payload: expect.objectContaining({ formId: r.formId, kinds: ['contract', 'consent_pd'] }) }));
    expect(JSON.stringify(store.logEvent.mock.calls)).not.toContain(token);   // токен в журнал не попадает
  });

  test('в мессенджер: текст с именем, датой визита и ссылкой; итог доставки в ответе и журнале', async () => {
    const r = await forms.createForm({ salonId: 1, userId: 4, clientId: 52, deliver: 'messenger' });
    const { text, phone } = delivery.deliverText.mock.calls[0][0];
    expect(phone).toBe('+79200255591');
    expect(text).toBe(`Здравствуйте, Анна! Перед визитом в PERI CLINIC 26 октября в 11:00 заполните, пожалуйста, данные для договора — это займёт 2 минуты: ${r.url}`);
    expect(r.delivery).toEqual({ ok: true, channel: 'whatsapp' });
    expect(fstore.setDelivered).toHaveBeenCalledWith(r.formId, 'whatsapp');
    delivery.deliverText.mockRejectedValueOnce(Object.assign(new Error('Ни один мессенджер не принял'), { name: 'EdocsError', code: 'form_not_delivered' }));
    const r2 = await forms.createForm({ salonId: 1, userId: 4, clientId: 52, deliver: 'messenger' });
    expect(r2.delivery).toEqual({ ok: false, code: 'form_not_delivered', error: 'Ни один мессенджер не принял' });
    expect(store.logEvent).toHaveBeenCalledWith(expect.objectContaining({ kind: 'form_send_error' }));
  });

  test('прежняя активная анкета отзывается и пишется в журнал', async () => {
    fstore.insertForm.mockResolvedValueOnce(['f-old']);
    await forms.createForm({ salonId: 1, userId: 4, clientId: 52 });
    expect(store.logEvent).toHaveBeenCalledWith(expect.objectContaining({ kind: 'form_revoked', payload: { formId: 'f-old', reason: 'replaced' } }));
  });

  test('проверки: пациент, виды, акт без визита, нет шаблонов, нет адреса для ссылок', async () => {
    store.getClient.mockResolvedValueOnce(null);
    await expect(forms.createForm({ salonId: 1, clientId: 52 })).rejects.toMatchObject({ code: 'not_found', status: 404 });
    await expect(forms.createForm({ salonId: 1, clientId: 52, kinds: ['ids'] })).rejects.toMatchObject({ code: 'bad_kinds' });
    await expect(forms.createForm({ salonId: 1, clientId: 52, kinds: ['act'] })).rejects.toMatchObject({ code: 'act_needs_record' });
    store.listTemplates.mockResolvedValueOnce([]);
    await expect(forms.createForm({ salonId: 1, clientId: 52 })).rejects.toMatchObject({ code: 'no_templates', status: 409 });
    config.EDOCS_PUBLIC_URL = '';
    await expect(forms.createForm({ salonId: 1, clientId: 52 })).rejects.toMatchObject({ code: 'no_public_url' });
    const r = await forms.createForm({ salonId: 1, clientId: 52, publicBase: 'https://staff.example/' });
    expect(r.url.startsWith('https://staff.example/anketa/')).toBe(true);
  });
});

describe('ссылка, повтор, отзыв', () => {
  test('formLink и resendForm — тот же токен', async () => {
    const link = await forms.formLink({ salonId: 1, formId: 'f-1' });
    expect(link.url).toBe(`https://dev.zumrudin.ru/anketa/${TOKEN}`);
    await forms.resendForm({ salonId: 1, formId: 'f-1' });
    expect(delivery.deliverText.mock.calls[0][0].text).toContain(`/anketa/${TOKEN}`);
  });
  test('неактивная анкета — 409; отзыв — в журнал', async () => {
    fstore.getForm.mockResolvedValueOnce({ ...FORM, status: 'submitted' });
    await expect(forms.formLink({ salonId: 1, formId: 'f-1' })).rejects.toMatchObject({ code: 'form_inactive' });
    fstore.revoke.mockResolvedValueOnce({ id: 'f-1', client_id: 52 });
    expect(await forms.revokeForm({ salonId: 1, formId: 'f-1', userId: 4 })).toEqual({ ok: true });
    expect(store.logEvent).toHaveBeenCalledWith(expect.objectContaining({ kind: 'form_revoked', payload: { formId: 'f-1', reason: 'manual' } }));
    fstore.revoke.mockResolvedValueOnce(null);
    await expect(forms.revokeForm({ salonId: 1, formId: 'f-1' })).rejects.toMatchObject({ code: 'form_inactive' });
  });
});

describe('публичная сторона', () => {
  test('кривой токен — not_found без запроса в БД; устаревшая, принятая, отозванная — только статус', async () => {
    expect(await forms.publicView('../etc')).toEqual({ status: 'not_found' });
    expect(fstore.getFormByHash).not.toHaveBeenCalled();
    fstore.getFormByHash.mockResolvedValueOnce({ ...FORM, expires_at: new Date(Date.now() - 1000).toISOString() });
    expect(await forms.publicView(TOKEN)).toEqual({ status: 'expired' });
    fstore.getFormByHash.mockResolvedValueOnce({ ...FORM, status: 'submitted' });
    expect(await forms.publicView(TOKEN)).toEqual({ status: 'submitted' });
  });

  test('активная: клиника, личное имя, визит, поля с подписями; данные пациента не отдаются; первое открытие — в журнал', async () => {
    store.getIdentityRow.mockResolvedValue({ first_name: 'Анна', secure_enc: 'enc:{"passport_series":"4510"}', secure_fields: ['passport_series'] });
    const v = await forms.publicView(TOKEN);
    expect(v).toEqual({
      status: 'active', clinic: 'PERI CLINIC', greetingName: 'Анна',
      visit: { date: '2026-10-26', time: '11:00', label: '26 октября, 11:00', phrase: '26 октября в 11:00' },
      fields: [
        { key: 'last_name', label: 'Фамилия', type: 'text', required: true }, { key: 'first_name', label: 'Имя', type: 'text', required: true },
        { key: 'middle_name', label: 'Отчество (если есть)', type: 'text', required: false },
        { key: 'passport_series', label: 'Серия паспорта', type: 'digits', required: true }, { key: 'passport_number', label: 'Номер паспорта', type: 'digits', required: true },
        { key: 'address', label: 'Адрес регистрации', type: 'text', required: true },
      ],
      canRecognize: true, policyUrl: '/privacy-policy.html',
    });
    expect(JSON.stringify(v)).not.toContain('4510');
    expect(fstore.getFormByHash).toHaveBeenCalledWith(sha(TOKEN));
    expect(store.logEvent).toHaveBeenCalledWith(expect.objectContaining({ kind: 'form_opened' }));
    store.getSettings.mockResolvedValueOnce({ ...SETTINGS, enabled: false });
    expect((await forms.publicView(TOKEN)).canRecognize).toBe(false);
  });

  const BODY = { last_name: 'Иванова', first_name: 'Анна', middle_name: '', passport_series: '4510', passport_number: '123456', address: 'Москва, ул. Ленина, 1', consent: true };

  test('приём: слияние с прежними данными (паспорт перезаписан, e-mail сохранён), телефон из карточки, source patient_form', async () => {
    store.getIdentityRow.mockResolvedValue({ last_name: 'Иванова', first_name: 'Анна', email: 'anna@example.ru', phone: null,
      secure_enc: 'enc:{"passport_series":"1111","passport_number":"222222","birth_place":"Москва"}', secure_fields: ['passport_series', 'passport_number', 'birth_place'] });
    const r = await forms.publicSubmit(TOKEN, BODY, { ip: '1.2.3.4' });
    expect(r).toMatchObject({ ok: true, docs: 'sending' });
    const [sid, cid, saved] = store.upsertIdentity.mock.calls[0];
    expect([sid, cid, saved.source, saved.userId]).toEqual([1, 52, 'patient_form', null]);
    expect(saved.plain).toMatchObject({ last_name: 'Иванова', first_name: 'Анна', email: 'anna@example.ru', phone: '79200255591' });
    expect(JSON.parse(saved.secure_enc.replace(/^enc:/, ''))).toEqual({ passport_series: '4510', passport_number: '123456', birth_place: 'Москва', address: 'Москва, ул. Ленина, 1' });
    const consent = fstore.markSubmitted.mock.calls[0][1];
    expect(consent).toMatchObject({ accepted: true, version: 'anketa-v1', policyUrl: '/privacy-policy.html' });
    expect(consent.ipHash).toHaveLength(16);
    expect(await r._background).toBe('pkg-1');
    expect(packages.send).toHaveBeenCalledWith({ salonId: 1, userId: 4, clientId: 52, templateIds: [5, 6], recordId: null, source: 'form' });
    expect(fstore.setResult).toHaveBeenCalledWith('f-1', { packageId: 'pkg-1' });
  });

  test('после заполнения уходят только неподписанные документы; ошибка F.Doc — в анкету и журнал', async () => {
    boardStore.listDocsForClients.mockResolvedValue([{ kind: 'contract', package_status: 'signed', package_id: 'old', created_at: '2026-01-01' }]);
    const r = await forms.publicSubmit(TOKEN, BODY);
    await r._background;
    expect(packages.send.mock.calls[0][0].templateIds).toEqual([6]);
    packages.send.mockRejectedValueOnce(Object.assign(new Error('Подключите свою учётную запись F.Doc'), { code: 'fdoc_no_credentials' }));
    const r2 = await forms.publicSubmit(TOKEN, BODY);
    expect(await r2._background).toBeNull();
    expect(fstore.setResult).toHaveBeenCalledWith('f-1', { error: 'Подключите свою учётную запись F.Doc' });
    expect(store.logEvent).toHaveBeenCalledWith(expect.objectContaining({ kind: 'form_docs_error' }));
  });

  test('отказы: без согласия, пустые обязательные поля, неверная серия, повторная отправка, лимит попыток', async () => {
    await expect(forms.publicSubmit(TOKEN, { ...BODY, consent: 'yes' })).rejects.toMatchObject({ code: 'consent', status: 400 });
    await expect(forms.publicSubmit(TOKEN, { ...BODY, address: ' ', passport_number: '' })).rejects.toMatchObject({
      code: 'missing_fields', message: 'Заполните: номер паспорта, адрес регистрации' });
    await expect(forms.publicSubmit(TOKEN, { ...BODY, passport_series: '45' })).rejects.toMatchObject({ code: 'bad_field', message: 'Серия паспорта: 4 цифры' });
    fstore.markSubmitted.mockResolvedValueOnce(false);
    await expect(forms.publicSubmit(TOKEN, BODY)).rejects.toMatchObject({ code: 'form_submitted', status: 410 });
    fstore.incAttempts.mockResolvedValueOnce(21);
    await expect(forms.publicSubmit(TOKEN, BODY)).rejects.toMatchObject({ code: 'too_many_attempts', status: 429 });
    fstore.getFormByHash.mockResolvedValueOnce({ ...FORM, status: 'revoked' });
    await expect(forms.publicSubmit(TOKEN, BODY)).rejects.toMatchObject({ code: 'form_revoked', status: 410 });
    expect(store.upsertIdentity).not.toHaveBeenCalled();
  });

  test('поле, которого нет в анкете, не принимается; телефон из тела игнорируется', async () => {
    await forms.publicSubmit(TOKEN, { ...BODY, phone: '79001112233', email: 'x@y.ru' });
    const saved = store.upsertIdentity.mock.calls[0][2];
    expect(saved.plain.phone).toBe('79200255591');
    expect(saved.plain.email).toBeNull();
  });

  test('данные не сохранились — анкета снова доступна пациенту', async () => {
    store.upsertIdentity.mockRejectedValueOnce(new Error('db down'));
    await expect(forms.publicSubmit(TOKEN, BODY)).rejects.toThrow('db down');
    expect(fstore.reopen).toHaveBeenCalledWith('f-1');
  });

  test('без отправки документов — docs: none', async () => {
    fstore.getFormByHash.mockResolvedValue({ ...FORM, send_docs: false });
    const r = await forms.publicSubmit(TOKEN, BODY);
    expect(r).toMatchObject({ ok: true, docs: 'none', _background: null });
    expect(packages.send).not.toHaveBeenCalled();
  });

  test('фото паспорта: только поля анкеты, лимит распознаваний, недоступно без F.Doc', async () => {
    const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]), Buffer.alloc(16)]);
    fstore.takeRecognize.mockResolvedValue(true);
    packages.recognize.mockResolvedValue({ confidence: true, fields: {
      surname_nat: { value: 'ИВАНОВА' }, given_name_nat: { value: 'АННА' }, document_series: { value: '4510' }, document_number: { value: '123456' },
      birth_date: { value: '1983-03-21' }, authority_nat: { value: 'ОВД' } } });
    const r = await forms.publicPhoto(TOKEN, { buffer: PNG, originalname: 'p.png' });
    expect(r).toEqual({ recognized: true, confidence: true, fields: { last_name: 'Иванова', first_name: 'Анна', passport_series: '4510', passport_number: '123456' } });
    expect(packages.recognize).toHaveBeenCalledWith({ salonId: 1, userId: 4, imageBase64: Buffer.from('JPEG').toString('base64') });
    fstore.takeRecognize.mockResolvedValueOnce(false);
    await expect(forms.publicPhoto(TOKEN, { buffer: PNG, originalname: 'p.png' })).rejects.toMatchObject({ code: 'recognize_limit', status: 429 });
    store.getSettings.mockResolvedValueOnce({ ...SETTINGS, corp_id: null });
    await expect(forms.publicPhoto(TOKEN, { buffer: PNG, originalname: 'p.png' })).rejects.toMatchObject({ code: 'recognize_unavailable' });
    await expect(forms.publicPhoto(TOKEN, { buffer: Buffer.from('not an image at all'), originalname: 'p.png' })).rejects.toMatchObject({ code: 'bad_image' });
  });
});

test('expireForms: устаревшие → expired с записью в журнал', async () => {
  fstore.expireDue.mockResolvedValueOnce([{ id: 'f-9', salon_id: 1, client_id: 52 }]);
  expect(await forms.expireForms()).toBe(1);
  expect(store.logEvent).toHaveBeenCalledWith({ salonId: 1, clientId: 52, kind: 'form_expired', payload: { formId: 'f-9' } });
});
```

- [ ] **Step 2: Убедиться, что тест падает**

```bash
cd backend && npx jest backend/edocs-forms.test.js 2>&1 | grep -E "Cannot find module|^Tests:"
```

Ожидается: `Cannot find module './services/edocs/forms' from 'edocs-forms.test.js'`.

- [ ] **Step 3: Модуль анкеты**

Создать `backend/services/edocs/forms.js`:

```js
'use strict';
// Анкета пациента (спека 2026-10-25 §6): пациент сам вносит данные для договора по ссылке —
// в мессенджере или по QR-коду у стойки. Ссылка: <EDOCS_PUBLIC_URL>/anketa/<токен>; в БД — sha256
// токена (поиск) и его шифротекст (показать QR и переотправить ту же ссылку). Публичная сторона
// НИЧЕГО из уже известных данных пациента не показывает, кроме личного имени для приветствия:
// у кого ссылка, тот паспорт не прочитает. Телефон анкетой не меняется — на него F.Doc шлёт SMS.
const crypto = require('crypto');
const QRCode = require('qrcode');
const sharp = require('sharp');
const store = require('./store');
const fstore = require('./forms-store');
const boardStore = require('./board-store');
const packages = require('./packages');
const delivery = require('./form-delivery');
const identity = require('./identity');
const { kindState, BAD } = require('./board');
const secretBox = require('../../utils/secret-box');
const config = require('../../config');
const { FIELDS } = require('./placeholders');
const { resolveGivenName } = require('../../utils/person-name');
const { validateImageBuffer } = require('../../utils/upload-validator');
const { EdocsError, shortError } = require('./errors');
const { createLogger } = require('../../logger');

const logger = createLogger('EdocsForms');
const FIELD_ORDER = ['last_name', 'first_name', 'middle_name', 'birth_date', 'gender', 'passport_series', 'passport_number',
  'issue_date', 'authority_code', 'issued_by', 'birth_place', 'address', 'email'];
const ALWAYS = ['last_name', 'first_name', 'middle_name'];
const NEVER = new Set(['phone', 'contract_no', 'contract_date']);   // телефон — якорь SMS; договор — сторона клиники
const SECURE = new Set(identity.SECURE_KEYS);
const LABELS = {
  last_name: 'Фамилия', first_name: 'Имя', middle_name: 'Отчество (если есть)', birth_date: 'Дата рождения', gender: 'Пол',
  passport_series: 'Серия паспорта', passport_number: 'Номер паспорта', issue_date: 'Дата выдачи паспорта',
  authority_code: 'Код подразделения', issued_by: 'Кем выдан паспорт', birth_place: 'Место рождения', address: 'Адрес регистрации', email: 'E-mail',
};
const TYPES = { birth_date: 'date', issue_date: 'date', gender: 'gender', email: 'email', passport_series: 'digits', passport_number: 'digits', authority_code: 'code' };
const FORM_KINDS = ['contract', 'consent_pd', 'act'];
const RECOGNIZE_LIMIT = 3;
const ATTEMPT_LIMIT = 20;
const CONSENT_VERSION = 'anketa-v1';
const DEFAULT_MESSAGE = 'Здравствуйте, {имя}! Перед визитом в {клиника} {дата} заполните, пожалуйста, данные для договора — это займёт 2 минуты: {ссылка}';
const MONTHS = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
const MSK = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Moscow', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });

const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const bySort = (a, b) => (Number(a.sort_order) || 0) - (Number(b.sort_order) || 0) || a.id - b.id;
function clampInt(v, min, max, dflt) { const n = Number(v); return Number.isInteger(n) && n >= min && n <= max ? n : dflt; }
/** { date: 'YYYY-MM-DD', time: 'HH:MM', label: '26 октября, 11:00', phrase: '26 октября в 11:00' } по Москве или null. */
function visitInfo(ts) {
  const t = ts ? Date.parse(ts) : NaN;
  if (!Number.isFinite(t)) return null;
  const parts = Object.fromEntries(MSK.formatToParts(new Date(t)).map((p) => [p.type, p.value]));
  const date = `${parts.year}-${parts.month}-${parts.day}`;
  const time = `${parts.hour}:${parts.minute}`;
  const day = `${Number(parts.day)} ${MONTHS[Number(parts.month) - 1]}`;
  return { date, time, label: `${day}, ${time}`, phrase: `${day} в ${time}` };
}

/** Какие поля спрашивать: всё, что требуют шаблоны, + ФИО; без телефона и номера/даты договора. */
function fieldsFor(templates) {
  const need = new Set(ALWAYS);
  for (const t of templates || []) for (const name of t.placeholders || []) { const f = FIELDS[name]; if (f) for (const r of f.requires) need.add(r); }
  return FIELD_ORDER.filter((k) => need.has(k) && !NEVER.has(k)).map((k) => ({ key: k, required: k !== 'middle_name' }));
}

/** Шаблоны по умолчанию для видов (первый активный по порядку). */
async function templatesForKinds(salonId, kinds) {
  const active = await store.listTemplates(salonId, { activeOnly: true });
  return kinds.map((k) => active.filter((t) => t.kind === k).sort(bySort)[0]).filter(Boolean);
}

/** Текст сообщения со ссылкой. Нет имени — «Здравствуйте!», а не «Здравствуйте, !». */
function renderMessage(template, { name = '', clinic = '', date = '', url = '' }) {
  return String(template || DEFAULT_MESSAGE)
    .replace(/\{имя\}/g, () => name).replace(/\{клиника\}/g, () => clinic || 'клинику')
    .replace(/\{дата\}/g, () => date).replace(/\{ссылка\}/g, () => url)
    .replace(/,\s*!/g, '!').replace(/[ \t]{2,}/g, ' ').replace(/\s+([,.!?])/g, '$1').trim();
}

async function givenName(salonId, clientId, client) {
  const row = await store.getIdentityRow(salonId, clientId);
  return (row && row.first_name) || resolveGivenName(client && client.name) || '';
}

async function visitOf(form) {
  const r = form.record_id ? await fstore.recordVisit(form.salon_id, form.record_id) : await fstore.nextVisit(form.salon_id, form.client_id);
  return r ? visitInfo(r.visit_datetime) : null;
}

function publicBaseOr(publicBase) {
  const base = config.EDOCS_PUBLIC_URL || String(publicBase || '').replace(/\/+$/, '');
  if (!base) throw new EdocsError('no_public_url', 'Не задан адрес для ссылок анкеты (EDOCS_PUBLIC_URL)', 409);
  return base;
}

async function sendLink({ salonId, form, client, url, settings }) {
  const visit = await visitOf(form);
  const text = renderMessage(settings.form_message, {
    name: await givenName(salonId, form.client_id, client), clinic: await fstore.salonName(salonId), date: visit ? visit.phrase : '', url,
  });
  try {
    const r = await delivery.deliverText({ salonId, phone: client.phone, text });
    await fstore.setDelivered(form.id, r.channel);
    await store.logEvent({ salonId, clientId: form.client_id, kind: 'form_sent', payload: { formId: form.id, channel: r.channel } });
    return { ok: true, channel: r.channel };
  } catch (e) {
    await store.logEvent({ salonId, clientId: form.client_id, kind: 'form_send_error', payload: { formId: form.id, code: (e && e.code) || null, message: shortError(e) } });
    if (e && e.name === 'EdocsError') return { ok: false, code: e.code, error: e.message };
    logger.warn(`анкета ${form.id}: доставка: ${shortError(e)}`);
    return { ok: false, code: 'error', error: 'Не удалось отправить сообщение' };
  }
}

/**
 * Новая анкета. kinds — какие документы отправить после заполнения (по умолчанию договор и согласие);
 * deliver — 'messenger' | 'none' (только ссылка и QR). Прежняя активная анкета пациента отзывается.
 */
async function createForm({ salonId, userId = null, clientId, recordId = null, kinds = null, sendDocs = true, deliver = 'none', source = 'manual', senderUserId = null, publicBase = '' }) {
  const client = await store.getClient(salonId, clientId);
  if (!client) throw new EdocsError('not_found', 'Пациент не найден', 404);
  const wanted = Array.isArray(kinds) && kinds.length ? [...new Set(kinds)] : ['contract', 'consent_pd'];
  if (wanted.some((k) => !FORM_KINDS.includes(k))) throw new EdocsError('bad_kinds', 'Неизвестный вид документа', 400);
  if (wanted.includes('act') && !recordId) throw new EdocsError('act_needs_record', 'Для акта выберите визит', 400);
  const templates = await templatesForKinds(salonId, wanted);
  if (!templates.length) throw new EdocsError('no_templates', 'Нет активных шаблонов этих документов — загрузите их в настройках', 409);
  const base = publicBaseOr(publicBase);
  const settings = (await store.getSettings(salonId)) || {};
  const token = crypto.randomBytes(32).toString('base64url');
  const row = {
    id: crypto.randomUUID(), salon_id: salonId, client_id: client.id, record_id: recordId || null, token_hash: sha256(token),
    token_enc: secretBox.box().encrypt(token), fields: fieldsFor(templates), kinds: templates.map((t) => t.kind), send_docs: !!sendDocs,
    sender_user_id: senderUserId || userId || null, source, created_by: userId || null,
    expires_at: new Date(Date.now() + clampInt(settings.form_ttl_days, 1, 30, 7) * 86400000).toISOString(),
  };
  const revoked = await fstore.insertForm(row);
  for (const id of revoked) await store.logEvent({ salonId, clientId: client.id, kind: 'form_revoked', userId, payload: { formId: id, reason: 'replaced' } });
  await store.logEvent({ salonId, clientId: client.id, kind: 'form_created', userId, payload: { formId: row.id, source, kinds: row.kinds, sendDocs: row.send_docs, fields: row.fields.map((f) => f.key) } });
  const url = `${base}/anketa/${token}`;
  const out = { formId: row.id, url, qr: await QRCode.toDataURL(url, { margin: 1, width: 280 }), expiresAt: row.expires_at, delivery: null };
  if (deliver === 'messenger') out.delivery = await sendLink({ salonId, form: row, client, url, settings });
  return out;
}

async function activeForm(salonId, formId) {
  const form = await fstore.getForm(salonId, formId);
  if (!form) throw new EdocsError('not_found', 'Анкета не найдена', 404);
  if (form.status !== 'active' || Date.parse(form.expires_at) <= Date.now()) throw new EdocsError('form_inactive', 'Анкета уже не действует — создайте новую', 409);
  return form;
}

/** Ссылка и QR действующей анкеты (тот же токен). */
async function formLink({ salonId, formId, publicBase = '' }) {
  const form = await activeForm(salonId, formId);
  const url = `${publicBaseOr(publicBase)}/anketa/${secretBox.box().decrypt(form.token_enc)}`;
  return { formId: form.id, url, qr: await QRCode.toDataURL(url, { margin: 1, width: 280 }), expiresAt: new Date(form.expires_at).toISOString() };
}

/** Переотправить ту же ссылку в мессенджер (кнопка «Повторить анкету», автоматика). */
async function resendForm({ salonId, formId, publicBase = '' }) {
  const form = await activeForm(salonId, formId);
  const client = await store.getClient(salonId, form.client_id);
  if (!client) throw new EdocsError('not_found', 'Пациент не найден', 404);
  const url = `${publicBaseOr(publicBase)}/anketa/${secretBox.box().decrypt(form.token_enc)}`;
  return sendLink({ salonId, form, client, url, settings: (await store.getSettings(salonId)) || {} });
}

async function revokeForm({ salonId, formId, userId = null }) {
  const r = await fstore.revoke(salonId, formId);
  if (!r) throw new EdocsError('form_inactive', 'Анкета уже не действует', 409);
  await store.logEvent({ salonId, clientId: r.client_id, kind: 'form_revoked', userId, payload: { formId, reason: 'manual' } });
  return { ok: true };
}

/** Крон: устаревшие активные анкеты → expired. */
async function expireForms() {
  const rows = await fstore.expireDue();
  for (const r of rows) await store.logEvent({ salonId: r.salon_id, clientId: r.client_id, kind: 'form_expired', payload: { formId: r.id } });
  return rows.length;
}

// ── публичная сторона ──
async function findByToken(token) {
  if (!TOKEN_RE.test(String(token || ''))) return { form: null, state: 'not_found' };
  const form = await fstore.getFormByHash(sha256(token));
  if (!form) return { form: null, state: 'not_found' };
  if (form.status === 'active' && Date.parse(form.expires_at) <= Date.now()) return { form, state: 'expired' };
  return { form, state: form.status };
}
const GONE = {
  not_found: ['form_not_found', 'Ссылка не найдена', 404], submitted: ['form_submitted', 'Анкета уже заполнена — спасибо!', 410],
  revoked: ['form_revoked', 'Ссылка больше не действует — попросите клинику прислать новую', 410],
  expired: ['form_expired', 'Срок действия ссылки истёк — попросите клинику прислать новую', 410],
};
async function mustActive(token) {
  const r = await findByToken(token);
  if (r.state === 'active') return r.form;
  const [code, msg, st] = GONE[r.state] || GONE.not_found;
  throw new EdocsError(code, msg, st);
}

async function canRecognize(form, settings) {
  if (!settings || !settings.enabled || !settings.corp_id || !form.sender_user_id) return false;
  if (Number(form.recognize_count) >= RECOGNIZE_LIMIT) return false;
  const cred = await store.getCredentials(form.salon_id, form.sender_user_id);
  return !!(cred && cred.fail_count < 3);
}

/** Что показать пациенту. Состояние не «active» — только статус. */
async function publicView(token) {
  const { form, state } = await findByToken(token);
  if (state !== 'active') return { status: state };
  const client = await store.getClient(form.salon_id, form.client_id);
  const settings = await store.getSettings(form.salon_id);
  if (await fstore.markOpened(form.id)) await store.logEvent({ salonId: form.salon_id, clientId: form.client_id, kind: 'form_opened', payload: { formId: form.id } });
  return {
    status: 'active', clinic: await fstore.salonName(form.salon_id), greetingName: await givenName(form.salon_id, form.client_id, client),
    visit: await visitOf(form),
    fields: (form.fields || []).map((f) => ({ key: f.key, label: LABELS[f.key] || f.key, type: TYPES[f.key] || 'text', required: !!f.required })),
    canRecognize: await canRecognize(form, settings), policyUrl: config.CERT_REQUEST_POLICY_URL || '',
  };
}

/** Документы после заполнения: только те, что ещё не подписаны и не ждут подписи. Не бросает. */
async function sendDocsAfter(form) {
  try {
    const templates = await templatesForKinds(form.salon_id, form.kinds || []);
    const docs = await boardStore.listDocsForClients(form.salon_id, [form.client_id]);
    const need = templates.filter((t) => BAD.has(kindState(docs, t.kind, { recordId: form.record_id }).state));
    if (!need.length) return null;
    const r = await packages.send({ salonId: form.salon_id, userId: form.sender_user_id, clientId: form.client_id, templateIds: need.map((t) => t.id),
      recordId: need.some((t) => t.kind === 'act') ? form.record_id : null, source: 'form' });
    await fstore.setResult(form.id, { packageId: r.packageId });
    await store.logEvent({ salonId: form.salon_id, packageId: r.packageId, clientId: form.client_id, kind: 'form_docs_sent', payload: { formId: form.id } });
    return r.packageId;
  } catch (e) {
    try { await fstore.setResult(form.id, { error: shortError(e) }); } catch (_) { /* журнал ниже всё равно запишется */ }
    await store.logEvent({ salonId: form.salon_id, clientId: form.client_id, kind: 'form_docs_error', payload: { formId: form.id, code: (e && e.code) || null, message: shortError(e) } });
    logger.warn(`анкета ${form.id}: документы не отправлены: ${shortError(e)}`);
    return null;
  }
}

/**
 * Пациент отправил анкету. Поля — только из form.fields; телефон берётся из данных или карточки.
 * Возвращает { ok, docs: 'sending'|'none', _background } — _background (промис отправки документов)
 * только для тестов, роутер его не отдаёт.
 */
async function publicSubmit(token, body, { ip = '' } = {}) {
  const form = await mustActive(token);
  if ((await fstore.incAttempts(form.id)) > ATTEMPT_LIMIT) throw new EdocsError('too_many_attempts', 'Слишком много попыток — попросите клинику прислать новую ссылку', 429);
  const b = body || {};
  if (b.consent !== true) throw new EdocsError('consent', 'Подтвердите согласие на обработку персональных данных', 400);
  const sid = form.salon_id;
  const client = await store.getClient(sid, form.client_id);
  if (!client) throw new EdocsError('form_not_found', 'Ссылка не найдена', 404);
  const row = await store.getIdentityRow(sid, form.client_id);
  const cur = identity.decodeRow(row, row && row.secure_enc ? secretBox.box() : null) || { plain: {}, secure: {} };
  const merged = { ...cur.plain, secure: { ...cur.secure } };
  for (const f of form.fields || []) {
    const v = b[f.key] === undefined || b[f.key] === null ? '' : String(b[f.key]);
    if (SECURE.has(f.key)) merged.secure[f.key] = v; else merged[f.key] = v;
  }
  if (!merged.phone) merged.phone = client.phone || '';
  const v = identity.validateIdentity(merged);
  if (v.error) throw new EdocsError('bad_field', v.error, 400);
  const empty = (form.fields || []).filter((f) => f.required && !String((SECURE.has(f.key) ? v.value.secure[f.key] : v.value.plain[f.key]) || '').trim());
  if (empty.length) throw new EdocsError('missing_fields', `Заполните: ${empty.map((f) => (LABELS[f.key] || f.key).toLowerCase()).join(', ')}`, 400);
  const enc = identity.encodeSecure(v.value.secure, secretBox.box());
  const consent = { accepted: true, at: new Date().toISOString(), version: CONSENT_VERSION, policyUrl: config.CERT_REQUEST_POLICY_URL || '', ipHash: sha256(`${form.id}:${ip}`).slice(0, 16) };
  if (!(await fstore.markSubmitted(form.id, consent))) throw new EdocsError('form_submitted', 'Анкета уже заполнена — спасибо!', 410);
  try {
    await store.upsertIdentity(sid, form.client_id, { plain: v.value.plain, secure_enc: enc.secure_enc, secure_fields: enc.secure_fields, source: 'patient_form', userId: null });
  } catch (e) {
    try { await fstore.reopen(form.id); } catch (_) { /* исходная ошибка важнее */ }   // данные не сохранились — пусть пациент повторит
    throw e;
  }
  await store.logEvent({ salonId: sid, clientId: form.client_id, kind: 'identity_edit', payload: { source: 'patient_form', plain: Object.keys(v.value.plain).filter((k) => v.value.plain[k]), secure: enc.secure_fields } });
  await store.logEvent({ salonId: sid, clientId: form.client_id, kind: 'form_submitted', payload: { formId: form.id, fields: (form.fields || []).map((f) => f.key) } });
  const background = form.send_docs ? sendDocsAfter(form) : null;
  return { ok: true, docs: form.send_docs ? 'sending' : 'none', _background: background };
}

/** Фото паспорта с публичной страницы → поля для формы пациента (фото не сохраняется). */
async function publicPhoto(token, file) {
  const form = await mustActive(token);
  if (!file || !file.buffer) throw new EdocsError('bad_image', 'Приложите фото паспорта', 400);
  const check = validateImageBuffer(file.buffer, file.originalname);
  if (!check.ok) throw new EdocsError('bad_image', check.error, 400);
  const settings = await store.getSettings(form.salon_id);
  if (!(await canRecognize(form, settings))) throw new EdocsError('recognize_unavailable', 'Распознавание сейчас недоступно — введите данные вручную', 409);
  if (!(await fstore.takeRecognize(form.id, RECOGNIZE_LIMIT))) throw new EdocsError('recognize_limit', 'Распознать можно не больше 3 раз — введите данные вручную', 429);
  let jpeg;
  try {
    jpeg = await sharp(file.buffer).rotate().resize({ width: 2400, height: 2400, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 85 }).toBuffer();
  } catch (e) { throw new EdocsError('bad_image', 'Не удалось прочитать фото — снимите ещё раз', 400); }
  const result = await packages.recognize({ salonId: form.salon_id, userId: form.sender_user_id, imageBase64: jpeg.toString('base64') });
  await store.logEvent({ salonId: form.salon_id, clientId: form.client_id, kind: 'form_photo', payload: { formId: form.id, recognized: !!result } });
  if (!result) return { recognized: false, fields: {} };
  const r = identity.fromRecognized(result);
  const keys = new Set((form.fields || []).map((f) => f.key));
  const fields = {};
  for (const [k, v] of Object.entries({ ...r.plain, ...r.secure })) if (keys.has(k) && v) fields[k] = v;
  return { recognized: true, fields, confidence: r.confidence };
}

module.exports = {
  fieldsFor, renderMessage, visitInfo, createForm, formLink, resendForm, revokeForm, expireForms, sendLink,
  publicView, publicSubmit, publicPhoto, findByToken, LABELS, DEFAULT_MESSAGE, RECOGNIZE_LIMIT, ATTEMPT_LIMIT,
};
```

- [ ] **Step 4: Тест проходит**

```bash
cd backend && npx jest backend/edocs-forms.test.js 2>&1 | grep -E "^Tests:"
```

Ожидается: `Tests: 16 passed, 16 total`.

- [ ] **Step 5: Коммит**

```bash
git add backend/edocs-forms.test.js backend/services/edocs/forms.js
git commit -m "feat(edocs): анкета пациента — ссылка и QR, публичный просмотр, приём с отправкой документов" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 9: Автоматика — `automation.js`, `automation-store.js`, крон — **Opus**

Спека §7.2. Крон раз в минуту (`EDOCS_AUTOMATION=false` гасит его целиком), один прогон на процесс (второй параллельный — пропуск), салоны по очереди, сбой салона не останавливает остальных; у салона всё выключено, пока владелец не включит. Каждое действие сначала «застолбляется» строкой `edoc_auto_jobs` (`INSERT … ON CONFLICT DO NOTHING RETURNING id`, UNIQUE `(salon_id, kind, ref)`) — at-most-once, как в «Заботе» и уведомлениях: повтора нет, неудача остаётся с причиной и видна на карточке, дальше — человек. В тихие часы салона (настройки автоуведомлений) ничего не столбится — действие подберёт первый прогон после их окончания.
- Перед визитом (`previsit`): окно N часов, «только первичные» или все; данных хватает на ВСЕ недостающие виды — один комплект от имени сотрудника автоматики; не хватает — анкета в мессенджер (после заполнения уйдут все недостающие); анкета выключена — `skipped` с перечнем полей. F.Doc не готов, а данных хватает — ждём, не столбим; не хватает — анкета без отправки документов.
- Акт (`act`): через N минут после оплаты (момент оплаты не хранится — по `records.updated_at`), не раньше `acts_required_from` и не старше 3 дней; F.Doc не готов — кандидаты даже не читаются.
- Повторы (`remind`, `remind_form`): неподписанная ссылка — учёткой отправителя, без неё — учёткой автоматики; незаполненная анкета — та же ссылка.
- Настройка салона не готова (реквизиты клиники, нет `EDOCS_PUBLIC_URL`) — не столбим, WARN раз в час. Тестовые номера и уже застолблённое — пропуск. Просроченные анкеты переводятся в `expired`.

**Files:**
- Create: `backend/services/edocs/automation-store.js`, `backend/services/edocs/automation.js`
- Modify: `backend/server.js`
- Test: `backend/edocs-automation.test.js`

- [ ] **Step 1: Падающий тест**

Создать `backend/edocs-automation.test.js`:

```js
'use strict';
// Автоматика «Документов» (services/edocs/automation.js). SQL выборок — scripts/edocs-board-smoke.js.
jest.mock('./services/edocs/store', () => ({ getCredentials: jest.fn(), listTemplates: jest.fn(), getIdentityRow: jest.fn() }));
jest.mock('./services/edocs/board-store', () => ({ listDocsForClients: jest.fn(), listLatestForms: jest.fn() }));
jest.mock('./services/edocs/automation-store', () => ({
  listAutomationSalons: jest.fn(), previsitCandidates: jest.fn(), actCandidates: jest.fn(), remindPackages: jest.fn(), remindForms: jest.fn(),
  claim: jest.fn(), finish: jest.fn(),
}));
jest.mock('./services/edocs/packages', () => ({ send: jest.fn(), permalink: jest.fn(), usesAutoContractNo: jest.fn(() => false) }));
jest.mock('./services/edocs/forms', () => ({ createForm: jest.fn(), resendForm: jest.fn(), expireForms: jest.fn() }));
jest.mock('./services/notifications/settings', () => ({ getSettings: jest.fn() }));
jest.mock('./config', () => ({ EDOCS_PUBLIC_URL: 'https://dev.zumrudin.ru', EDOCS_TEST_PHONES: [] }));
const mockLog = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
jest.mock('./logger', () => ({ createLogger: () => mockLog }));

const store = require('./services/edocs/store');
const boardStore = require('./services/edocs/board-store');
const auto = require('./services/edocs/automation-store');
const packages = require('./services/edocs/packages');
const forms = require('./services/edocs/forms');
const notifSettings = require('./services/notifications/settings');
const config = require('./config');
const automation = require('./services/edocs/automation');

const NOW = Date.parse('2026-10-25T10:00:00+03:00');
const NIGHT = Date.parse('2026-10-25T22:30:00+03:00');
const SALON = { salon_id: 1, enabled: true, corp_id: 'C1', auto_sender_user_id: 4, auto_previsit: true, auto_previsit_hours: 24,
  auto_previsit_scope: 'first', auto_previsit_form: true, auto_act: true, auto_act_delay_min: 15, auto_remind: true, auto_remind_hours: 2,
  acts_required_from: '2026-10-24', requisites: { name: 'ООО «Пери Клиник»' } };
const T = [
  { id: 5, kind: 'contract', title: 'Договор', sort_order: 0, placeholders: ['fio', 'passport'] },
  { id: 6, kind: 'consent_pd', title: 'Согласие', sort_order: 1, placeholders: ['fio'] },
  { id: 7, kind: 'act', title: 'Акт', sort_order: 2, placeholders: ['fio', 'services'] },
];
const FULL = { last_name: 'Иванова', first_name: 'Анна', phone: '79200255591', secure_fields: ['passport_series', 'passport_number'] };
const NO_PASSPORT = { ...FULL, secure_fields: [] };
const CAND = { id: 100, client_id: 52, visit_datetime: '2026-10-26T08:00:00Z', phone: '+79200255591', name: 'Иванова Анна' };

beforeEach(() => {
  jest.clearAllMocks();
  automation._reset();
  config.EDOCS_PUBLIC_URL = 'https://dev.zumrudin.ru';
  config.EDOCS_TEST_PHONES = [];
  notifSettings.getSettings.mockResolvedValue({ quiet_from: '21:00', quiet_to: '09:00' });
  auto.listAutomationSalons.mockResolvedValue([SALON]);
  auto.previsitCandidates.mockResolvedValue([]);
  auto.actCandidates.mockResolvedValue([]);
  auto.remindPackages.mockResolvedValue([]);
  auto.remindForms.mockResolvedValue([]);
  auto.claim.mockResolvedValue(901);
  store.getCredentials.mockResolvedValue({ user_id: 4, fail_count: 0 });
  store.listTemplates.mockResolvedValue(T);
  store.getIdentityRow.mockResolvedValue(FULL);
  boardStore.listDocsForClients.mockResolvedValue([]);
  boardStore.listLatestForms.mockResolvedValue([]);
  packages.send.mockResolvedValue({ packageId: 'pkg-1' });
  forms.createForm.mockResolvedValue({ formId: 'f-1', delivery: { ok: true, channel: 'whatsapp' } });
  forms.expireForms.mockResolvedValue(0);
});

test('тихие часы — салон пропускается целиком, ничего не столбится', async () => {
  auto.previsitCandidates.mockResolvedValue([CAND]);
  expect(await automation.runSalon(SALON, NIGHT)).toEqual({ quiet: true });
  expect(auto.claim).not.toHaveBeenCalled();
});

describe('перед визитом', () => {
  beforeEach(() => { auto.previsitCandidates.mockResolvedValue([CAND]); });

  test('окно и «только первичные» уходят в выборку', async () => {
    await automation.runSalon(SALON, NOW);
    expect(auto.previsitCandidates).toHaveBeenCalledWith(1, new Date(NOW).toISOString(), new Date(NOW + 24 * 3600000).toISOString(), true);
    await automation.runSalon({ ...SALON, auto_previsit_scope: 'all', auto_previsit_hours: 999 }, NOW);
    expect(auto.previsitCandidates).toHaveBeenLastCalledWith(1, expect.any(String), new Date(NOW + 168 * 3600000).toISOString(), false);
  });

  test('данных хватает — один комплект из недостающих видов от имени сотрудника автоматики', async () => {
    boardStore.listDocsForClients.mockResolvedValue([{ kind: 'consent_pd', package_status: 'signed', package_id: 'old', created_at: '2026-01-01' }]);
    expect((await automation.runSalon(SALON, NOW)).previsit).toBe(1);
    expect(auto.claim).toHaveBeenCalledWith(1, 'previsit', 100, { clientId: 52, recordId: 100 });
    expect(packages.send).toHaveBeenCalledWith({ salonId: 1, userId: 4, clientId: 52, templateIds: [5], source: 'auto' });
    expect(auto.finish).toHaveBeenCalledWith(901, 'done', 'отправлено: договор', { packageId: 'pkg-1' });
  });

  test('данных не хватает — анкета в мессенджер, после заполнения уйдут все недостающие', async () => {
    store.getIdentityRow.mockResolvedValue(NO_PASSPORT);
    await automation.runSalon(SALON, NOW);
    expect(forms.createForm).toHaveBeenCalledWith({ salonId: 1, clientId: 52, recordId: 100, kinds: ['contract', 'consent_pd'], sendDocs: true,
      deliver: 'messenger', source: 'auto', senderUserId: 4 });
    expect(auto.finish).toHaveBeenCalledWith(901, 'done', 'анкета отправлена в WhatsApp', { formId: 'f-1' });
    forms.createForm.mockResolvedValueOnce({ formId: 'f-2', delivery: { ok: false, error: 'Ни один мессенджер не принял' } });
    auto.claim.mockResolvedValueOnce(902);
    await automation.runSalon(SALON, NOW);
    expect(auto.finish).toHaveBeenCalledWith(902, 'failed', 'анкета не доставлена: Ни один мессенджер не принял', { formId: 'f-2' });
  });

  test('F.Doc не готов: данных хватает — ждём (не столбим); не хватает — анкета без отправки документов', async () => {
    await automation.runSalon({ ...SALON, auto_sender_user_id: null }, NOW);
    expect(auto.claim).not.toHaveBeenCalled();
    store.getIdentityRow.mockResolvedValue(NO_PASSPORT);
    await automation.runSalon({ ...SALON, auto_sender_user_id: null }, NOW);
    expect(forms.createForm).toHaveBeenCalledWith(expect.objectContaining({ sendDocs: false, senderUserId: null }));
  });

  test('ничего не делаем: всё подписано/ждёт, анкета уже у пациента, тестовый номер, уже застолблено', async () => {
    boardStore.listDocsForClients.mockResolvedValueOnce(['contract', 'consent_pd'].map((k) => ({ kind: k, package_status: 'sent', package_id: 'p', created_at: '2026-10-25' })));
    await automation.runSalon(SALON, NOW);
    boardStore.listLatestForms.mockResolvedValueOnce([{ status: 'active', expires_at: '2026-11-01T00:00:00Z' }]);
    await automation.runSalon(SALON, NOW);
    expect(auto.claim).not.toHaveBeenCalled();
    config.EDOCS_TEST_PHONES = ['79000000000'];
    await automation.runSalon(SALON, NOW);
    expect(auto.claim).not.toHaveBeenCalled();
    config.EDOCS_TEST_PHONES = [];
    auto.claim.mockResolvedValueOnce(null);
    await automation.runSalon(SALON, NOW);
    expect(packages.send).not.toHaveBeenCalled();
  });

  test('настройка салона не готова (реквизиты, адрес ссылок) — не столбим, предупреждаем раз в час', async () => {
    await automation.runSalon({ ...SALON, requisites: {} }, NOW);
    expect(auto.claim).toHaveBeenCalled();   // реквизиты шаблонам этого теста не нужны
    auto.claim.mockClear();
    store.listTemplates.mockResolvedValue([{ ...T[0], placeholders: ['fio', 'org_inn'] }, T[1], T[2]]);
    await automation.runSalon({ ...SALON, requisites: {} }, NOW);
    expect(auto.claim).not.toHaveBeenCalled();
    store.listTemplates.mockResolvedValue(T);
    store.getIdentityRow.mockResolvedValue(NO_PASSPORT);
    config.EDOCS_PUBLIC_URL = '';
    await automation.runSalon(SALON, NOW);
    await automation.runSalon(SALON, NOW);
    expect(auto.claim).not.toHaveBeenCalled();
    expect(mockLog.warn.mock.calls.filter(([t]) => /EDOCS_PUBLIC_URL/.test(t))).toHaveLength(1);
  });

  test('анкета выключена, данных нет — skipped с перечнем; сбой отправки — failed с причиной', async () => {
    store.getIdentityRow.mockResolvedValue(NO_PASSPORT);
    await automation.runSalon({ ...SALON, auto_previsit_form: false }, NOW);
    expect(auto.finish).toHaveBeenCalledWith(901, 'skipped', 'нет данных пациента: номер паспорта, серия паспорта');
    store.getIdentityRow.mockResolvedValue(FULL);
    packages.send.mockRejectedValueOnce(new Error('F.Doc не принял комплект: 400'));
    await automation.runSalon(SALON, NOW);
    expect(auto.finish).toHaveBeenLastCalledWith(901, 'failed', 'F.Doc не принял комплект: 400');
  });
});

describe('акт после оплаты', () => {
  test('F.Doc готов — акт по записи; окно не раньше acts_required_from и не старше 3 дней', async () => {
    auto.actCandidates.mockResolvedValue([{ id: 200, client_id: 52, phone: '79200255591' }]);
    await automation.runSalon(SALON, NOW);
    expect(auto.actCandidates).toHaveBeenCalledWith(1, '2026-10-24', 15);
    expect(packages.send).toHaveBeenCalledWith({ salonId: 1, userId: 4, clientId: 52, templateIds: [7], recordId: 200, source: 'auto' });
    expect(auto.finish).toHaveBeenCalledWith(901, 'done', 'акт отправлен', { packageId: 'pkg-1' });
    await automation.runSalon({ ...SALON, acts_required_from: '2026-01-01', auto_act_delay_min: 1 }, NOW);
    expect(auto.actCandidates).toHaveBeenLastCalledWith(1, '2026-10-22', 5);
  });
  test('F.Doc не готов — автоакт ждёт, кандидаты не читаются', async () => {
    await automation.runSalon({ ...SALON, enabled: false }, NOW);
    expect(auto.actCandidates).not.toHaveBeenCalled();
  });
});

describe('повторы', () => {
  test('ссылка — учёткой отправителя, без неё — учёткой автоматики; анкета — та же ссылка', async () => {
    auto.remindPackages.mockResolvedValue([{ id: 'p-1', client_id: 52, sent_by: 9, payload: { patient: { phone: '79200255591' } } }]);
    packages.permalink.mockRejectedValueOnce(Object.assign(new Error('Подключите'), { code: 'fdoc_no_credentials' }));
    auto.remindForms.mockResolvedValue([{ id: 'f-1', client_id: 52, phone: '79200255591' }]);
    forms.resendForm.mockResolvedValue({ ok: true, channel: 'tdlib' });
    expect((await automation.runSalon(SALON, NOW)).remind).toBe(2);
    expect(packages.permalink.mock.calls.map((c) => c[0].userId)).toEqual([9, 4]);
    expect(auto.remindPackages).toHaveBeenCalledWith(1, 2);
    expect(auto.claim).toHaveBeenCalledWith(1, 'remind', 'p-1', { clientId: 52, packageId: 'p-1' });
    expect(auto.claim).toHaveBeenCalledWith(1, 'remind_form', 'f-1', { clientId: 52, formId: 'f-1' });
    expect(auto.finish).toHaveBeenCalledWith(901, 'done', 'ссылка на подпись отправлена повторно');
    expect(auto.finish).toHaveBeenCalledWith(901, 'done', 'анкета отправлена повторно в Telegram');
  });
});

test('runOnce: анкеты устаревают, сбой салона не останавливает остальных, второй прогон параллельно — пропуск', async () => {
  auto.listAutomationSalons.mockResolvedValue([{ ...SALON, salon_id: 1 }, { ...SALON, salon_id: 2 }]);
  notifSettings.getSettings.mockRejectedValueOnce(new Error('db down')).mockResolvedValue({ quiet_from: '21:00', quiet_to: '09:00' });
  auto.actCandidates.mockResolvedValue([{ id: 200, client_id: 52, phone: '79200255591' }]);
  const p = automation.runOnce({ nowMs: NOW });
  expect(await automation.runOnce({ nowMs: NOW })).toEqual({ skipped: true });
  expect(await p).toMatchObject({ errors: 1, act: 1 });
  expect(forms.expireForms).toHaveBeenCalledTimes(1);
});
```

- [ ] **Step 2: Убедиться, что тест падает**

```bash
cd backend && npx jest backend/edocs-automation.test.js 2>&1 | grep -E "Cannot find module|^Tests:"
```

Ожидается: `Cannot find module './services/edocs/automation-store' from 'edocs-automation.test.js'`.

- [ ] **Step 3: Выборки автоматики и журнал**

Создать `backend/services/edocs/automation-store.js`:

```js
'use strict';
// SQL автоматики «Документов»: кандидаты на действие и журнал edoc_auto_jobs. Кандидат, по
// которому уже есть строка журнала, в выборку не попадает — действие at-most-once.
const { db } = require('../../db');

const LIVE = `NOT COALESCE((r.raw_payload->>'deleted')::boolean, false)`;

async function listAutomationSalons() {
  return db.any('SELECT * FROM edoc_settings WHERE auto_previsit OR auto_act OR auto_remind ORDER BY salon_id');
}

/** Записи «ждёт/подтвердил» с началом в (from, to]; first — только первичные (ни одной состоявшейся раньше). */
const PREVISIT_SQL = `
  SELECT r.id, r.client_id, r.visit_datetime, c.phone, c.name
  FROM records r JOIN clients c ON c.id = r.client_id AND c.salon_id = r.salon_id
  WHERE r.salon_id = $1 AND r.visit_datetime > $2::timestamptz AND r.visit_datetime <= $3::timestamptz
    AND r.status IN ('waiting', 'confirmed') AND ${LIVE}
    AND NOT EXISTS (SELECT 1 FROM edoc_auto_jobs j WHERE j.salon_id = r.salon_id AND j.kind = 'previsit' AND j.ref = r.id::text)
    AND (NOT $4::boolean OR NOT EXISTS (SELECT 1 FROM records p WHERE p.salon_id = r.salon_id AND p.client_id = r.client_id
                                        AND p.status = 'arrived' AND p.visit_date < r.visit_date))
  ORDER BY r.visit_datetime LIMIT 50`;
async function previsitCandidates(salonId, fromIso, toIso, firstOnly) {
  return db.any(PREVISIT_SQL, [salonId, fromIso, toIso, !!firstOnly]);
}

/** Оплаченные состоявшиеся визиты с fromDate, изменённые не позже delayMin минут назад, без единого комплекта с актом. */
const ACT_SQL = `
  SELECT r.id, r.client_id, c.phone
  FROM records r JOIN clients c ON c.id = r.client_id AND c.salon_id = r.salon_id
  WHERE r.salon_id = $1 AND r.status = 'arrived' AND (r.raw_payload->>'paid_full') = '1' AND r.visit_date >= $2::date
    AND r.updated_at <= NOW() - make_interval(mins => $3::int) AND ${LIVE}
    AND NOT EXISTS (SELECT 1 FROM edoc_packages p JOIN edoc_documents d ON d.package_id = p.id
                    LEFT JOIN edoc_templates t ON t.id = d.template_id
                    WHERE p.salon_id = r.salon_id AND p.record_id = r.id AND COALESCE(d.kind, t.kind) = 'act')
    AND NOT EXISTS (SELECT 1 FROM edoc_auto_jobs j WHERE j.salon_id = r.salon_id AND j.kind = 'act' AND j.ref = r.id::text)
  ORDER BY r.visit_datetime LIMIT 50`;
async function actCandidates(salonId, fromDate, delayMin) {
  return db.any(ACT_SQL, [salonId, fromDate, delayMin]);
}

/** Комплекты, ждущие подписи дольше hours часов (но не дольше 3 суток), без повтора. */
const REMIND_PACKAGES_SQL = `
  SELECT p.id, p.client_id, p.sent_by, p.payload, c.phone AS client_phone
  FROM edoc_packages p JOIN clients c ON c.id = p.client_id
  WHERE p.salon_id = $1 AND p.status = 'sent' AND p.source <> 'paper'
    AND p.sent_at <= NOW() - make_interval(hours => $2::int) AND p.sent_at > NOW() - INTERVAL '3 days'
    AND NOT EXISTS (SELECT 1 FROM edoc_auto_jobs j WHERE j.salon_id = p.salon_id AND j.kind = 'remind' AND j.ref = p.id::text)
  ORDER BY p.sent_at LIMIT 50`;
async function remindPackages(salonId, hours) {
  return db.any(REMIND_PACKAGES_SQL, [salonId, hours]);
}

/** Активные анкеты, доставленные в мессенджер дольше hours часов назад и не заполненные, без повтора. */
const REMIND_FORMS_SQL = `
  SELECT f.id, f.client_id, c.phone
  FROM edoc_patient_forms f JOIN clients c ON c.id = f.client_id
  WHERE f.salon_id = $1 AND f.status = 'active' AND f.expires_at > NOW() AND f.delivered_via IS NOT NULL
    AND f.delivered_at <= NOW() - make_interval(hours => $2::int)
    AND NOT EXISTS (SELECT 1 FROM edoc_auto_jobs j WHERE j.salon_id = f.salon_id AND j.kind = 'remind_form' AND j.ref = f.id::text)
  ORDER BY f.delivered_at LIMIT 50`;
async function remindForms(salonId, hours) {
  return db.any(REMIND_FORMS_SQL, [salonId, hours]);
}

/** Застолбить действие. null — уже было (другой процесс или прошлый тик). */
async function claim(salonId, kind, ref, { clientId = null, recordId = null, packageId = null, formId = null } = {}) {
  const r = await db.oneOrNone(
    `INSERT INTO edoc_auto_jobs (salon_id, kind, ref, client_id, record_id, package_id, form_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (salon_id, kind, ref) DO NOTHING RETURNING id`,
    [salonId, kind, String(ref), clientId, recordId, packageId, formId],
  );
  return r ? r.id : null;
}
async function finish(id, status, reason, { packageId = null, formId = null } = {}) {
  await db.query(
    `UPDATE edoc_auto_jobs SET status=$2, reason=$3, package_id=COALESCE($4, package_id), form_id=COALESCE($5, form_id), updated_at=NOW() WHERE id=$1`,
    [id, status, reason ? String(reason).slice(0, 300) : null, packageId, formId],
  );
}

module.exports = {
  listAutomationSalons, previsitCandidates, actCandidates, remindPackages, remindForms, claim, finish,
  PREVISIT_SQL, ACT_SQL, REMIND_PACKAGES_SQL, REMIND_FORMS_SQL,
};
```

- [ ] **Step 4: Крон автоматики**

Создать `backend/services/edocs/automation.js`:

```js
'use strict';
// Автоматика «Документов» (спека 2026-10-25 §7), крон раз в минуту. По умолчанию выключена.
//   Перед визитом — договор и согласие (данных не хватает → анкета в мессенджер);
//   акт — через N минут после оплаты визита; повтор — неподписанная ссылка / незаполненная анкета.
// Каждое действие сначала «застолбляется» строкой edoc_auto_jobs (UNIQUE): повторов не бывает,
// неудача остаётся в журнале с причиной и видна на карточке дашборда — дальше человек.
// В тихие часы салона (настройки автоуведомлений) ничего не столбится и не шлётся: действие
// подберёт первый прогон после их окончания. Отправки F.Doc идут от имени выбранного сотрудника.
const store = require('./store');
const boardStore = require('./board-store');
const auto = require('./automation-store');
const packages = require('./packages');
const forms = require('./forms');
const testPhones = require('./test-phones');
const { kindState, BAD, PRE_KINDS, addDays, mskDay } = require('./board');
const { missingFor, KIND_LABELS } = require('./placeholders');
const notifSettings = require('../notifications/settings');
const { applyQuietHours } = require('../notifications/events');
const config = require('../../config');
const { shortError } = require('./errors');
const { createLogger } = require('../../logger');

const logger = createLogger('EdocsAuto');
const VIA = { tdlib: 'Telegram', whatsapp: 'WhatsApp', max: 'MAX' };
const ACT_LOOKBACK_DAYS = 3;
const WARN_EVERY_MS = 60 * 60 * 1000;
const warned = new Map();
function warnOnce(key, text) {
  const now = Date.now();
  if (warned.has(key) && now - warned.get(key) < WARN_EVERY_MS) return;
  warned.set(key, now);
  logger.warn(text);
}
const bySort = (a, b) => (Number(a.sort_order) || 0) - (Number(b.sort_order) || 0) || a.id - b.id;
const kindNames = (kinds) => kinds.map((k) => (KIND_LABELS[k] || k).toLowerCase()).join(', ');

/** Готов ли F.Doc для автоматики салона: модуль включён и проверен, выбран сотрудник с рабочей учёткой. */
async function fdocReady(s) {
  if (!s.enabled || !s.corp_id) return { ok: false, reason: 'модуль «Документы» выключен или F.Doc не подключён' };
  if (!s.auto_sender_user_id) return { ok: false, reason: 'не выбран сотрудник для автоотправки' };
  const cred = await store.getCredentials(s.salon_id, s.auto_sender_user_id);
  if (!cred || cred.fail_count >= 3) return { ok: false, reason: 'у сотрудника для автоотправки нет рабочей учётки F.Doc' };
  return { ok: true, userId: s.auto_sender_user_id };
}

async function previsit(ctx) {
  const { s, salonId, tplByKind, nowMs } = ctx;
  const hours = Math.min(168, Math.max(2, Number(s.auto_previsit_hours) || 24));
  const list = await auto.previsitCandidates(salonId, new Date(nowMs).toISOString(), new Date(nowMs + hours * 3600000).toISOString(), s.auto_previsit_scope !== 'all');
  let n = 0;
  for (const r of list) {
    if (!testPhones.isAllowed(r.phone)) continue;   // тестовый режим: чужих пациентов не трогаем и не столбим
    const docs = await boardStore.listDocsForClients(salonId, [r.client_id]);
    const bad = PRE_KINDS.filter((k) => tplByKind[k] && BAD.has(kindState(docs, k, { nowMs }).state));
    if (!bad.length) continue;   // всё подписано или ждёт подписи
    const latest = (await boardStore.listLatestForms(salonId, [r.client_id]))[0];
    if (latest && latest.status === 'active' && Date.parse(latest.expires_at) > nowMs) continue;   // анкета уже у пациента
    const templates = bad.map((k) => tplByKind[k]);
    const miss = missingFor(await store.getIdentityRow(salonId, r.client_id), templates, ctx.requisites,
      { autoContractNo: packages.usesAutoContractNo(s, templates) });
    // Проблемы настройки салона, а не пациента, действие не столбят: после исправления оно случится.
    if (miss.org.length) { warnOnce(`org:${salonId}`, `edocs auto: салон ${salonId} — не заполнены реквизиты клиники, автоотправка ждёт`); continue; }
    if (!miss.identity.length && !ctx.fdoc.ok) { warnOnce(`previsit:${salonId}`, `edocs auto: салон ${salonId} — отправка перед визитом ждёт: ${ctx.fdoc.reason}`); continue; }
    if (miss.identity.length && s.auto_previsit_form && !config.EDOCS_PUBLIC_URL) {
      warnOnce(`url:${salonId}`, `edocs auto: салон ${salonId} — не задан EDOCS_PUBLIC_URL, анкеты не отправляются`);
      continue;
    }
    const job = await auto.claim(salonId, 'previsit', r.id, { clientId: r.client_id, recordId: r.id });
    if (!job) continue;
    n++;
    try {
      if (!miss.identity.length) {
        const res = await packages.send({ salonId, userId: ctx.fdoc.userId, clientId: r.client_id, templateIds: templates.map((t) => t.id), source: 'auto' });
        await auto.finish(job, 'done', `отправлено: ${kindNames(bad)}`, { packageId: res.packageId });
      } else if (s.auto_previsit_form) {
        const f = await forms.createForm({ salonId, clientId: r.client_id, recordId: r.id, kinds: bad, sendDocs: ctx.fdoc.ok, deliver: 'messenger',
          source: 'auto', senderUserId: s.auto_sender_user_id || null });
        if (f.delivery && f.delivery.ok) await auto.finish(job, 'done', `анкета отправлена в ${VIA[f.delivery.channel] || f.delivery.channel}`, { formId: f.formId });
        else await auto.finish(job, 'failed', `анкета не доставлена: ${(f.delivery && f.delivery.error) || 'нет ответа'}`, { formId: f.formId });
      } else {
        await auto.finish(job, 'skipped', `нет данных пациента: ${miss.identity.map((x) => x.label.toLowerCase()).join(', ')}`);
      }
    } catch (e) {
      await auto.finish(job, 'failed', shortError(e));
    }
  }
  return n;
}

async function acts(ctx) {
  const { s, salonId, tplByKind, nowMs } = ctx;
  if (!tplByKind.act) return 0;
  if (!ctx.fdoc.ok) { warnOnce(`act:${salonId}`, `edocs auto: салон ${salonId} — автоакт ждёт: ${ctx.fdoc.reason}`); return 0; }
  const floor = addDays(mskDay(nowMs), -ACT_LOOKBACK_DAYS);
  const from = s.acts_required_from && String(s.acts_required_from) > floor ? String(s.acts_required_from) : floor;
  const delay = Math.min(240, Math.max(5, Number(s.auto_act_delay_min) || 15));
  let n = 0;
  for (const r of await auto.actCandidates(salonId, from, delay)) {
    if (!testPhones.isAllowed(r.phone)) continue;
    const job = await auto.claim(salonId, 'act', r.id, { clientId: r.client_id, recordId: r.id });
    if (!job) continue;
    n++;
    try {
      const res = await packages.send({ salonId, userId: ctx.fdoc.userId, clientId: r.client_id, templateIds: [tplByKind.act.id], recordId: r.id, source: 'auto' });
      await auto.finish(job, 'done', 'акт отправлен', { packageId: res.packageId });
    } catch (e) {
      await auto.finish(job, 'failed', shortError(e));
    }
  }
  return n;
}

const CRED_CODES = new Set(['fdoc_no_credentials', 'fdoc_credentials_invalid']);
async function reminders(ctx) {
  const { s, salonId } = ctx;
  const hours = Math.min(48, Math.max(1, Number(s.auto_remind_hours) || 2));
  let n = 0;
  if (ctx.fdoc.ok) {
    for (const p of await auto.remindPackages(salonId, hours)) {
      const phone = (p.payload && p.payload.patient && p.payload.patient.phone) || p.client_phone;
      if (!testPhones.isAllowed(phone)) continue;
      const job = await auto.claim(salonId, 'remind', p.id, { clientId: p.client_id, packageId: p.id });
      if (!job) continue;
      n++;
      try {
        // Комплект в F.Doc может быть виден только отправителю — сначала его учёткой, нет её — учёткой автоматики.
        try { await packages.permalink({ salonId, userId: p.sent_by || ctx.fdoc.userId, packageId: p.id }); } catch (e) {
          if (!e || !CRED_CODES.has(e.code) || !p.sent_by || p.sent_by === ctx.fdoc.userId) throw e;
          await packages.permalink({ salonId, userId: ctx.fdoc.userId, packageId: p.id });
        }
        await auto.finish(job, 'done', 'ссылка на подпись отправлена повторно');
      } catch (e) {
        await auto.finish(job, 'failed', shortError(e));
      }
    }
  }
  if (config.EDOCS_PUBLIC_URL) {
    for (const f of await auto.remindForms(salonId, hours)) {
      if (!testPhones.isAllowed(f.phone)) continue;
      const job = await auto.claim(salonId, 'remind_form', f.id, { clientId: f.client_id, formId: f.id });
      if (!job) continue;
      n++;
      try {
        const r = await forms.resendForm({ salonId, formId: f.id });
        if (r.ok) await auto.finish(job, 'done', `анкета отправлена повторно в ${VIA[r.channel] || r.channel}`);
        else await auto.finish(job, 'failed', `анкета не доставлена: ${r.error}`);
      } catch (e) {
        await auto.finish(job, 'failed', shortError(e));
      }
    }
  }
  return n;
}

async function runSalon(s, nowMs) {
  const salonId = s.salon_id;
  const cfg = await notifSettings.getSettings(salonId);
  if (applyQuietHours(nowMs, cfg) > nowMs) return { quiet: true };
  const tpls = (await store.listTemplates(salonId, { activeOnly: true })).sort(bySort);
  const tplByKind = {};
  for (const t of tpls) if (!tplByKind[t.kind]) tplByKind[t.kind] = t;
  const ctx = { s, salonId, tplByKind, nowMs, requisites: s.requisites || {}, fdoc: await fdocReady(s) };
  const out = { previsit: 0, act: 0, remind: 0 };
  if (s.auto_previsit) out.previsit = await previsit(ctx);
  if (s.auto_act) out.act = await acts(ctx);
  if (s.auto_remind) out.remind = await reminders(ctx);
  return out;
}

let running = false;
/** Один прогон на процесс; салоны по очереди, сбой салона не останавливает остальных. */
async function runOnce({ nowMs = Date.now() } = {}) {
  if (running) return { skipped: true };
  running = true;
  const out = { expired: 0, previsit: 0, act: 0, remind: 0, errors: 0 };
  try {
    try { out.expired = await forms.expireForms(); } catch (e) { warnOnce('expire', `edocs auto: анкеты не переведены в expired: ${shortError(e)}`); }
    for (const s of await auto.listAutomationSalons()) {
      try {
        const r = await runSalon(s, nowMs);
        for (const k of ['previsit', 'act', 'remind']) out[k] += r[k] || 0;
      } catch (e) {
        out.errors++;
        warnOnce(`salon:${s.salon_id}`, `edocs auto: салон ${s.salon_id}: ${shortError(e)}`);
      }
    }
    return out;
  } finally { running = false; }
}

function _reset() { warned.clear(); running = false; }

module.exports = { runOnce, runSalon, fdocReady, _reset };
```

- [ ] **Step 5: `server.js`: крон автоматики рядом с опросом F.Doc**

В `backend/server.js` найти:

```js
}

// ============================================================
// START
```

заменить на:

```js
}

// «Документы»: автоматика (перед визитом, акт после оплаты, повторы) и устаревание анкет —
// services/edocs/automation.js. По умолчанию у салона выключена (настройки «Автоматизация»);
// EDOCS_AUTOMATION=false гасит крон целиком.
if (process.env.EDOCS_AUTOMATION !== 'false') {
  cron.schedule('* * * * *', async () => {
    try {
      const r = await require('./services/edocs/automation').runOnce();
      if (r && (r.previsit || r.act || r.remind || r.errors)) {
        cronLogger.info(`edocs auto: перед визитом=${r.previsit}, акты=${r.act}, повторы=${r.remind}, ошибки салонов=${r.errors}`);
      }
    } catch (e) { cronLogger.error(`edocs auto: ${e.message}`); }
  }, { timezone: 'Europe/Moscow' });
}

// ============================================================
// START
```

- [ ] **Step 6: Тест проходит**

```bash
cd backend && npx jest backend/edocs-automation.test.js 2>&1 | grep -E "^Tests:"; node --check server.js && echo syntax-ok
```

Ожидается: `Tests: 12 passed, 12 total` и `syntax-ok`.

- [ ] **Step 7: Коммит**

```bash
git add backend/edocs-automation.test.js backend/services/edocs/automation-store.js backend/services/edocs/automation.js backend/server.js
git commit -m "feat(edocs): автоматика — документы перед визитом, акт после оплаты, повторы; крон" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 10: HTTP-ручки — **Opus**

Спека §6.4, §11.
- `routes/edocs-board.js` — `/api/edocs`, монтируется ДО общего `routes/edocs.js`; роли — владелец, администратор, кассир; JWT-поле салона — `req.user.salonId` (НЕ `salon_id`). `GET /board` (период из белого списка, неизвестный → сегодня; строки настроек нет → заводится), `GET /board/clients` («Вся база», фильтр из белого списка), `GET /clients/:id/page` (без расшифровки паспорта, превью номера договора), бумага (`POST /clients/:id/paper` multipart: шаблоны строкой или массивом, визит, дата, скан; `GET /packages/:id/scan`; `POST /packages/:id/paper-revoke` — только владелец и администратор), анкеты администратора (`POST /clients/:id/forms`, `GET /forms/:id/link`, `POST /forms/:id/send`, `POST /forms/:id/revoke`; ошибки модуля — их кодом).
- `routes/public-anketa.js` — БЕЗ JWT, монтируется ДО глобальной проверки `/api` (как `public-cert-request`): страница со строгим CSP, `Cache-Control: no-store`, `Referrer-Policy: no-referrer` (токен в адресе не должен утечь по ссылке на политику), `X-Robots-Tag: noindex`; лимиты в памяти процесса (`cert-request.makeRateLimiter`): просмотр 60 за 10 минут на IP, отправка 30 в час на IP и 10 в час на анкету, фото 10 в час на IP — ответ 429 с текстом; промис фоновой отправки документов наружу не отдаётся; ошибки — человеческим текстом, прочее — 500 без подробностей.
- `GET/PUT /api/edocs/admin/automation` — отдельная ручка, потому что форма подключения F.Doc (`/settings`) сохраняется целиком и сбрасывает проверку ключа. `parseAutomation`: флаги строго boolean, числа в границах, текст анкеты обязан содержать `{ссылка}`, включённая автоматика требует сотрудника, «акты требуются с» — не позже сегодня, «следующий номер договора» — целое от 1.
- `GET /packages/:id` дополнительно отдаёт `source` и `paper` (ключ S3 наружу не уходит); `store.SETTINGS_COLS` пополняется колонками автоматики (иначе `saveSettings` их не запишет).

**Files:**
- Create: `backend/routes/edocs-board.js`, `backend/routes/public-anketa.js`
- Modify: `backend/routes/edocs-admin.js`, `backend/services/edocs/store.js`, `backend/routes/edocs.js`, `backend/routes/index.js`
- Test: `backend/edocs-board-routes.test.js`

- [ ] **Step 1: Падающий тест**

Создать `backend/edocs-board-routes.test.js`:

```js
'use strict';
// Роутеры дашборда «Документов» (routes/edocs-board.js), публичной анкеты (routes/public-anketa.js)
// и настройки автоматики (routes/edocs-admin.js → parseAutomation).
jest.mock('./db', () => ({ db: { oneOrNone: jest.fn() }, pool: {}, withTransaction: jest.fn() }));
jest.mock('./logger', () => ({ createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }) }));
jest.mock('./middleware/auth', () => ({
  auth: (req, res, next) => { req.user = req.__user; next(); },
  requireRole: (...roles) => (req, res, next) => (roles.includes(req.user && req.user.role) ? next() : res.status(403).json({ error: 'Нет доступа' })),
}));
jest.mock('./services/edocs/store', () => ({
  getCredentials: jest.fn(), listTemplates: jest.fn(), getClient: jest.fn(), getIdentityRow: jest.fn(), listClientPackages: jest.fn(),
  getSettings: jest.fn(), saveSettings: jest.fn(), listUsersWithCredentials: jest.fn(),
}));
jest.mock('./services/edocs/board-store', () => ({
  BASE_FILTERS: { all: '', no_contract: '', no_consent: '', open_acts: '', pending: '', ready: '' },
  getBoardSettings: jest.fn(), ensureSettingsRow: jest.fn(), listBoardRecords: jest.fn(), listDocsForClients: jest.fn(),
  listIdentitiesForClients: jest.fn(), listLatestForms: jest.fn(), listAutoNotes: jest.fn(), listBaseClients: jest.fn(),
  listClientRecords: jest.fn(), listClientEvents: jest.fn(),
}));
jest.mock('./services/edocs/paper', () => ({ MAX_SCAN_BYTES: 10 * 1024 * 1024, markPaper: jest.fn(), revokePaper: jest.fn(), scanUrl: jest.fn() }));
jest.mock('./services/edocs/forms', () => ({
  createForm: jest.fn(), formLink: jest.fn(), resendForm: jest.fn(), revokeForm: jest.fn(),
  publicView: jest.fn(), publicSubmit: jest.fn(), publicPhoto: jest.fn(), DEFAULT_MESSAGE: 'Здравствуйте, {имя}! {ссылка}',
}));
jest.mock('./services/edocs/counter', () => ({ yclientsNumber: jest.fn(() => null), peek: jest.fn(async () => ({ next: 1999, maxUsed: 1998 })), setNext: jest.fn() }));
jest.mock('./services/edocs/packages', () => ({ MAX_DOCS: 10 }));
jest.mock('./services/fdoc/client', () => ({ client: {} }));
jest.mock('./services/s3', () => ({}));
jest.mock('./utils/secret-box', () => ({ isConfigured: jest.fn(() => true), box: () => ({}) }));
jest.mock('./config', () => ({ EDOCS_PUBLIC_URL: 'https://dev.zumrudin.ru', EDOCS_TEST_PHONES: [], CERT_REQUEST_POLICY_URL: '/privacy-policy.html' }));

const { Readable } = require('stream');
const store = require('./services/edocs/store');
const boardStore = require('./services/edocs/board-store');
const paper = require('./services/edocs/paper');
const forms = require('./services/edocs/forms');
const counter = require('./services/edocs/counter');
const { EdocsError } = require('./services/edocs/errors');
const boardRouter = require('./routes/edocs-board');
const anketaRouter = require('./routes/public-anketa');
const { parseAutomation } = require('./routes/edocs-admin');

function call(router, method, url, { user = { role: 'admin', salonId: 1, userId: 4 }, body, query, file, fields, ip = '10.0.0.1' } = {}) {
  return new Promise((resolve) => {
    const headers = {};
    const res = {
      statusCode: 200,
      setHeader(k, v) { headers[k.toLowerCase()] = v; },
      status(c) { this.statusCode = c; return this; },
      json(b) { resolve({ status: this.statusCode, body: b, headers }); return this; },
      sendFile(p) { resolve({ status: this.statusCode, file: p, headers }); },
      end() { resolve({ status: this.statusCode, body: null, headers }); return this; },
    };
    const common = { method, url, body, query: query || {}, __user: user, protocol: 'https', ip, get: (h) => (h === 'host' ? 'dev.zumrudin.ru' : undefined) };
    let req;
    if (file || fields) {
      const boundary = '----edocs-test';
      const parts = Object.entries(fields || {}).map(([k, v]) => Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
      if (file) parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${file.field}"; filename="${file.name}"\r\nContent-Type: ${file.type}\r\n\r\n`), file.buffer, Buffer.from('\r\n'));
      const payload = Buffer.concat([...parts, Buffer.from(`--${boundary}--\r\n`)]);
      req = Object.assign(Readable.from([payload]), common, {
        body: {}, headers: { host: 'dev.zumrudin.ru', 'content-type': `multipart/form-data; boundary=${boundary}`, 'content-length': String(payload.length) },
      });
    } else {
      req = { ...common, headers: { host: 'dev.zumrudin.ru' } };
    }
    router.handle(req, res, () => resolve({ status: 404, body: null, headers }));
  });
}
const UUID = '11111111-1111-4111-8111-111111111111';
const T = [{ id: 5, kind: 'contract', title: 'Договор', is_active: true, sort_order: 0, placeholders: ['fio'] },
  { id: 6, kind: 'consent_pd', title: 'Согласие', is_active: true, sort_order: 1, placeholders: ['fio', 'org_inn'] }];
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Moscow' }).format(new Date());

beforeEach(() => {
  jest.clearAllMocks();
  boardStore.getBoardSettings.mockResolvedValue({ salon_id: 1, enabled: false, acts_from: '2026-10-01', contract_autonumber: true, requisites: {},
    auto_previsit: true, auto_previsit_hours: 24, auto_sender_name: 'Ольга' });
  boardStore.listBoardRecords.mockResolvedValue([]);
  for (const f of ['listDocsForClients', 'listIdentitiesForClients', 'listLatestForms', 'listAutoNotes', 'listClientRecords', 'listClientEvents']) boardStore[f].mockResolvedValue([]);
  store.listTemplates.mockResolvedValue(T);
  store.getCredentials.mockResolvedValue(null);
  store.getClient.mockResolvedValue({ id: 52, name: 'Иванова Анна', phone: '+79200255591', yclients_data: {} });
  store.getIdentityRow.mockResolvedValue({ client_id: 52, last_name: 'Иванова', first_name: 'Анна', phone: '79200255591', secure_enc: 'enc:{"x":1}', secure_fields: [], source: 'manual' });
  store.listClientPackages.mockResolvedValue([]);
});

describe('GET /board', () => {
  test('сегодняшняя карточка, сводка, счётчики периодов, состояние модуля и автоматики, предупреждения', async () => {
    const d = today();
    boardStore.listBoardRecords.mockResolvedValue([{ id: 100, client_id: 52, client_name: 'Иванова Анна', client_phone: '+79200255591', visit_date: d,
      visit_at: new Date(Date.now() + 30 * 60000).toISOString(), attendance: '0', paid_full: '0', services: [{ title: 'Чистка' }], staff: {}, has_prior_visit: true }]);
    const r = await call(boardRouter, 'GET', '/board?range=today', { query: { range: 'today' } });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ range: 'today', today: d, rangeCounts: { today: 1, tomorrow: 0, week: 1 },
      summary: { total: 1, red: 1 }, chips: { no_contract: 1, no_consent: 1 },
      module: { enabled: false, configured: false, encReady: true, me: { connected: false, broken: false } },
      automation: { previsit: { on: true, hours: 24, scope: 'first', form: true }, act: { on: false }, remind: { on: false }, senderName: 'Ольга' },
      kinds: { contract: { id: 5, title: 'Договор' }, consent_pd: { id: 6, title: 'Согласие' }, act: null } });
    expect(r.body.cards[0]).toMatchObject({ clientId: 52, color: 'red', label: 'Нужно до визита' });
    expect(r.body.warnings).toEqual([{ code: 'no_template', kind: 'act' }, { code: 'org_missing', fields: ['ИНН'] }]);
    expect(boardStore.listBoardRecords.mock.calls[0][1]).toBe('2026-10-01');   // окно — с acts_required_from
  });

  test('неизвестный период — сегодня; строки настроек нет — заводится', async () => {
    boardStore.getBoardSettings.mockResolvedValueOnce(null).mockResolvedValueOnce({ salon_id: 1, acts_from: today(), requisites: {} });
    const r = await call(boardRouter, 'GET', '/board', { query: { range: 'year' } });
    expect(r.body.range).toBe('today');
    expect(boardStore.ensureSettingsRow).toHaveBeenCalledWith(1);
  });

  test('роли: специалисту — 403, кассиру — можно', async () => {
    expect((await call(boardRouter, 'GET', '/board', { user: { role: 'specialist', salonId: 1, userId: 9 } })).status).toBe(403);
    expect((await call(boardRouter, 'GET', '/board', { user: { role: 'admin_cashier', salonId: 1, userId: 9 } })).status).toBe(200);
  });
});

test('GET /board/clients — флаги «Вся база», фильтр из белого списка', async () => {
  boardStore.listBaseClients.mockResolvedValue([{ id: 52, name: 'Иванова', phone: '+7920', last_visit_at: null, contract_signed: true, consent_signed: false, pending: false, open_acts: 2, total: '120' }]);
  const r = await call(boardRouter, 'GET', '/board/clients', { query: { filter: 'evil', page: '2', search: 'Иван' } });
  expect(r.body).toEqual({ page: 2, filter: 'all', total: 120, rows: [{ id: 52, name: 'Иванова', phone: '+7920', lastVisitAt: null, contract: true, consent: false, pending: false, openActs: 2 }] });
  expect(boardStore.listBaseClients).toHaveBeenCalledWith(1, { search: 'Иван', filter: 'all', actsFrom: '2026-10-01', limit: 50, offset: 50 });
});

describe('GET /clients/:id/page', () => {
  test('страница без расшифровки паспорта; превью следующего номера договора', async () => {
    const r = await call(boardRouter, 'GET', '/clients/52/page');
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ client: { id: 52, initials: 'ИА' }, numbering: { auto: true, contractNo: null, yclientsNo: null, next: 1999 },
      identity: { exists: true, source: 'manual', secureFields: [] }, templates: [{ id: 5 }, { id: 6 }] });
    expect(JSON.stringify(r.body)).not.toContain('enc:');
    expect(boardStore.listClientRecords.mock.calls[0].slice(0, 2)).toEqual([1, 52]);
  });
  test('нет пациента — 404', async () => {
    store.getClient.mockResolvedValueOnce(null);
    expect((await call(boardRouter, 'GET', '/clients/52/page')).status).toBe(404);
    expect((await call(boardRouter, 'GET', '/clients/abc/page')).status).toBe(404);
  });
});

describe('бумага', () => {
  test('multipart: шаблоны строкой, визит, дата, скан', async () => {
    paper.markPaper.mockResolvedValue({ packageId: UUID });
    const r = await call(boardRouter, 'POST', '/clients/52/paper', { fields: { templateIds: '5,6', signedDate: '2026-07-03', note: 'в клинике' },
      file: { field: 'scan', name: 'scan.pdf', type: 'application/pdf', buffer: Buffer.from('%PDF-1.7') } });
    expect(r).toMatchObject({ status: 200, body: { packageId: UUID } });
    const arg = paper.markPaper.mock.calls[0][0];
    expect(arg).toMatchObject({ salonId: 1, userId: 4, clientId: 52, templateIds: [5, 6], recordId: null, signedDate: '2026-07-03', note: 'в клинике' });
    expect(arg.file.buffer.toString()).toBe('%PDF-1.7');
  });
  test('без шаблонов — 400; снять отметку кассиру нельзя, администратору — можно', async () => {
    expect((await call(boardRouter, 'POST', '/clients/52/paper', { fields: { templateIds: '' } })).status).toBe(400);
    expect((await call(boardRouter, 'POST', `/packages/${UUID}/paper-revoke`, { user: { role: 'admin_cashier', salonId: 1, userId: 9 }, body: { reason: 'ошибка' } })).status).toBe(403);
    paper.revokePaper.mockResolvedValue({ ok: true });
    expect((await call(boardRouter, 'POST', `/packages/${UUID}/paper-revoke`, { body: { reason: 'ошибка' } })).body).toEqual({ ok: true });
    expect(paper.revokePaper).toHaveBeenCalledWith({ salonId: 1, userId: 4, packageId: UUID, reason: 'ошибка' });
    expect((await call(boardRouter, 'GET', '/packages/123/scan')).status).toBe(404);
  });
});

describe('анкеты (администратор)', () => {
  test('создание: проверка тела, адрес из запроса как запасной, ошибки модуля — их кодом', async () => {
    expect((await call(boardRouter, 'POST', '/clients/52/forms', { body: { kinds: ['ids'] } })).status).toBe(400);
    expect((await call(boardRouter, 'POST', '/clients/52/forms', { body: { deliver: 'sms' } })).status).toBe(400);
    forms.createForm.mockResolvedValue({ formId: UUID, url: 'https://dev.zumrudin.ru/anketa/x', qr: 'data:', expiresAt: 'x', delivery: null });
    const r = await call(boardRouter, 'POST', '/clients/52/forms', { body: { kinds: ['contract'], deliver: 'messenger', recordId: 100 } });
    expect(r.body.formId).toBe(UUID);
    expect(forms.createForm).toHaveBeenCalledWith({ salonId: 1, userId: 4, clientId: 52, recordId: 100, kinds: ['contract'], sendDocs: true,
      deliver: 'messenger', source: 'manual', publicBase: 'https://dev.zumrudin.ru' });
    forms.createForm.mockRejectedValueOnce(new EdocsError('no_templates', 'Нет активных шаблонов', 409));
    expect(await call(boardRouter, 'POST', '/clients/52/forms', { body: {} })).toMatchObject({ status: 409, body: { code: 'no_templates' } });
  });
  test('ссылка, повтор, отзыв — по UUID', async () => {
    expect((await call(boardRouter, 'GET', '/forms/abc/link')).status).toBe(404);
    forms.formLink.mockResolvedValue({ url: 'u' });
    expect((await call(boardRouter, 'GET', `/forms/${UUID}/link`)).body).toEqual({ url: 'u' });
    forms.resendForm.mockResolvedValue({ ok: true, channel: 'tdlib' });
    expect((await call(boardRouter, 'POST', `/forms/${UUID}/send`)).body).toEqual({ ok: true, channel: 'tdlib' });
    forms.revokeForm.mockResolvedValue({ ok: true });
    await call(boardRouter, 'POST', `/forms/${UUID}/revoke`);
    expect(forms.revokeForm).toHaveBeenCalledWith({ salonId: 1, formId: UUID, userId: 4 });
  });
});

describe('публичная анкета', () => {
  const TOKEN = 'B'.repeat(43);
  test('страница: строгий CSP, без кэша и Referrer, noindex', async () => {
    const r = await call(anketaRouter, 'GET', `/anketa/${TOKEN}`, { user: null });
    expect(r.file).toMatch(/frontend\/anketa\.html$/);
    expect(r.headers['content-security-policy']).toMatch(/script-src 'self';/);
    expect(r.headers['content-security-policy']).toMatch(/frame-ancestors 'none'/);
    expect(r.headers).toMatchObject({ 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', 'x-robots-tag': 'noindex, nofollow' });
  });
  test('данные и отправка; промис фоновой отправки наружу не уходит; ошибки модуля — текстом', async () => {
    forms.publicView.mockResolvedValue({ status: 'active', fields: [] });
    expect((await call(anketaRouter, 'GET', `/api/public/anketa/${TOKEN}`, { user: null })).body).toEqual({ status: 'active', fields: [] });
    forms.publicSubmit.mockResolvedValue({ ok: true, docs: 'sending', _background: Promise.resolve('p') });
    const r = await call(anketaRouter, 'POST', `/api/public/anketa/${TOKEN}`, { user: null, body: { consent: true }, ip: '10.0.0.2' });
    expect(r.body).toEqual({ ok: true, docs: 'sending' });
    expect(forms.publicSubmit).toHaveBeenCalledWith(TOKEN, { consent: true }, { ip: '10.0.0.2' });
    forms.publicSubmit.mockRejectedValueOnce(new EdocsError('form_expired', 'Срок действия ссылки истёк', 410));
    expect(await call(anketaRouter, 'POST', `/api/public/anketa/${TOKEN}`, { user: null, body: {}, ip: '10.0.0.3' }))
      .toMatchObject({ status: 410, body: { error: 'Срок действия ссылки истёк', code: 'form_expired' } });
    forms.publicSubmit.mockRejectedValueOnce(new Error('SELECT … failed'));
    expect(await call(anketaRouter, 'POST', `/api/public/anketa/${TOKEN}`, { user: null, body: {}, ip: '10.0.0.4' }))
      .toMatchObject({ status: 500, body: { code: 'internal' } });
  });
  test('лимит: 11-я отправка одной анкеты за час — 429', async () => {
    forms.publicSubmit.mockResolvedValue({ ok: true, docs: 'none' });
    const tok = 'C'.repeat(43);
    for (let i = 0; i < 10; i++) expect((await call(anketaRouter, 'POST', `/api/public/anketa/${tok}`, { user: null, body: {}, ip: `10.1.0.${i}` })).status).toBe(200);
    expect((await call(anketaRouter, 'POST', `/api/public/anketa/${tok}`, { user: null, body: {}, ip: '10.1.0.99' })).status).toBe(429);
  });
  test('фото — multipart в publicPhoto', async () => {
    forms.publicPhoto.mockResolvedValue({ recognized: false, fields: {} });
    const r = await call(anketaRouter, 'POST', `/api/public/anketa/${TOKEN}/photo`, { user: null, ip: '10.2.0.1',
      file: { field: 'photo', name: 'p.jpg', type: 'image/jpeg', buffer: Buffer.from([0xFF, 0xD8, 0xFF, 0, 1, 2, 3, 4]) } });
    expect(r.body).toEqual({ recognized: false, fields: {} });
    expect(forms.publicPhoto.mock.calls[0][1].originalname).toBe('p.jpg');
  });
});

describe('parseAutomation', () => {
  test('пустое тело — всё выключено, значения по умолчанию', () => {
    expect(parseAutomation({}, { today: '2026-10-25' })).toEqual({ value: {
      auto_previsit: false, auto_previsit_hours: 24, auto_previsit_form: true, auto_previsit_scope: 'first', auto_act: false, auto_act_delay_min: 15,
      auto_remind: false, auto_remind_hours: 2, form_ttl_days: 7, contract_autonumber: true, auto_sender_user_id: null, form_message: null,
    }, nextNo: undefined });
  });
  test('включённая автоматика требует сотрудника; границы чисел; флаги строго boolean', () => {
    expect(parseAutomation({ act: { on: true } }).error).toMatch(/сотрудника/);
    expect(parseAutomation({ act: { on: true }, senderUserId: 4 }).value).toMatchObject({ auto_act: true, auto_sender_user_id: 4 });
    expect(parseAutomation({ previsit: { hours: 1 } }).error).toMatch(/от 2 до 168/);
    expect(parseAutomation({ act: { on: 'yes' } }).error).toMatch(/да или нет/);
    expect(parseAutomation({ previsit: { scope: 'vip' } }).error).toMatch(/первичным или всем/);
  });
  test('текст анкеты с {ссылка}, дата актов не в будущем, следующий номер', () => {
    expect(parseAutomation({ formMessage: 'Заполните анкету' }).error).toMatch(/\{ссылка\}/);
    expect(parseAutomation({ formMessage: ' Анкета: {ссылка} ' }).value.form_message).toBe('Анкета: {ссылка}');
    expect(parseAutomation({ actsRequiredFrom: '2026-12-01' }, { today: '2026-10-25' }).error).toMatch(/не позже сегодняшней/);
    expect(parseAutomation({ actsRequiredFrom: '2026-10-20' }, { today: '2026-10-25' }).value.acts_required_from).toBe('2026-10-20');
    expect(parseAutomation({ contractNextNo: '2100' }).nextNo).toBe(2100);
    expect(parseAutomation({ contractNextNo: '0' }).error).toMatch(/Следующий номер/);
  });
});
```

- [ ] **Step 2: Убедиться, что тест падает**

```bash
cd backend && npx jest backend/edocs-board-routes.test.js 2>&1 | grep -E "Cannot find module|^Tests:"
```

Ожидается: `Cannot find module './routes/edocs-board' from 'edocs-board-routes.test.js'`.

- [ ] **Step 3: Роутер дашборда, страницы пациента, бумаги и анкет**

Создать `backend/routes/edocs-board.js`:

```js
'use strict';
// /api/edocs — дашборд подписей, страница пациента, «Подписано на бумаге», анкеты пациента
// (спека docs/superpowers/specs/2026-10-25-edocs-board-design.md §11). Монтируется РАНЬШЕ общего
// роутера /api/edocs; роли те же: владелец, администратор, кассир (снять отметку «на бумаге» —
// только владелец/администратор). Все запросы ограничены req.user.salonId (НЕ salon_id).
const router = require('express').Router();
const multer = require('multer');
const { auth, requireRole } = require('../middleware/auth');
const store = require('../services/edocs/store');
const boardStore = require('../services/edocs/board-store');
const board = require('../services/edocs/board');
const paper = require('../services/edocs/paper');
const forms = require('../services/edocs/forms');
const counter = require('../services/edocs/counter');
const secretBox = require('../utils/secret-box');
const { missingFor } = require('../services/edocs/placeholders');
const { sendError } = require('../services/edocs/errors');
const { todayMsk } = require('../utils/period');
const { createLogger } = require('../logger');

const logger = createLogger('EdocsBoardAPI');
const RANGES = ['today', 'tomorrow', 'week', 'open'];
const BASE_FILTERS = Object.keys(boardStore.BASE_FILTERS);
const FORM_KINDS = ['contract', 'consent_pd', 'act'];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const scanUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: paper.MAX_SCAN_BYTES, files: 1 } });

const posInt = (v) => (/^\d{1,9}$/.test(String(v === undefined || v === null ? '' : v)) && Number(v) > 0 ? Number(v) : null);
const publicBase = (req) => `${req.protocol}://${req.get('host')}`;
const idList = (v) => (Array.isArray(v) ? v : String(v === undefined || v === null ? '' : v).split(',')).map(posInt);

router.use(auth, requireRole('owner', 'admin', 'admin_cashier'));

/** Настройки салона для дашборда: строка заводится при первом открытии (acts_required_from = этот день). */
async function boardSettings(salonId) {
  let s = await boardStore.getBoardSettings(salonId);
  if (!s) { await boardStore.ensureSettingsRow(salonId); s = await boardStore.getBoardSettings(salonId); }
  return s || {};
}
async function moduleState(req, s) {
  const c = await store.getCredentials(req.user.salonId, req.user.userId);
  return { enabled: !!s.enabled, configured: !!s.corp_id, encReady: secretBox.isConfigured(),
    me: { connected: !!c, broken: !!(c && c.fail_count >= 3) } };
}
function automationView(s) {
  return {
    previsit: { on: !!s.auto_previsit, hours: s.auto_previsit_hours || 24, scope: s.auto_previsit_scope || 'first', form: s.auto_previsit_form !== false },
    act: { on: !!s.auto_act, delayMin: s.auto_act_delay_min || 15 },
    remind: { on: !!s.auto_remind, hours: s.auto_remind_hours || 2 },
    senderName: s.auto_sender_name || null,
  };
}
/** Предупреждения шапки: шаблонов нет, реквизиты клиники не заполнены (сами карточки про них молчат). */
function boardWarnings(templates, requisites) {
  const out = [];
  const active = templates.filter((t) => t.is_active);
  for (const k of board.KINDS) if (!active.some((t) => t.kind === k)) out.push({ code: 'no_template', kind: k });
  const org = missingFor(null, active.filter((t) => board.KINDS.includes(t.kind)), requisites || {}).org;
  if (org.length) out.push({ code: 'org_missing', fields: org.map((x) => x.label) });
  return out;
}
const settingsForBoard = (s, today) => ({ actsRequiredFrom: s.acts_from || today, autonumber: s.contract_autonumber !== false });

// ── дашборд ──
router.get('/board', async (req, res) => {
  const range = RANGES.includes(req.query.range) ? req.query.range : 'today';
  const sid = req.user.salonId;
  try {
    const s = await boardSettings(sid);
    const today = todayMsk();
    const opts = settingsForBoard(s, today);
    const win = board.windowBounds(today, opts.actsRequiredFrom);
    const records = await boardStore.listBoardRecords(sid, win.from, win.to);
    const ids = [...new Set(records.map((r) => r.client_id))];
    const [docs, identities, formRows, notes, templates] = await Promise.all([
      boardStore.listDocsForClients(sid, ids), boardStore.listIdentitiesForClients(sid, ids), boardStore.listLatestForms(sid, ids),
      boardStore.listAutoNotes(sid, ids), store.listTemplates(sid),
    ]);
    const built = board.buildBoard({ records, docs, identities: new Map(identities.map((i) => [i.client_id, i])), templates, requisites: s.requisites,
      forms: formRows, notes, settings: opts, nowMs: Date.now(), today });
    const cards = board.sliceRange(built.cards, range, today, opts.actsRequiredFrom);
    const { summary, chips } = board.summarize(cards);
    res.json({
      now: new Date().toISOString(), today, range, rangeCounts: board.rangeCounts(built.cards, today, opts.actsRequiredFrom),
      summary, chips, cards, kinds: built.kinds, module: await moduleState(req, s), automation: automationView(s),
      warnings: boardWarnings(templates, s.requisites), actsRequiredFrom: opts.actsRequiredFrom,
    });
  } catch (e) { sendError(res, e, logger, 'edocs board'); }
});

router.get('/board/clients', async (req, res) => {
  const filter = BASE_FILTERS.includes(req.query.filter) ? req.query.filter : 'all';
  const page = posInt(req.query.page) || 1;
  const sid = req.user.salonId;
  try {
    const s = await boardSettings(sid);
    const rows = await boardStore.listBaseClients(sid, { search: String(req.query.search || '').slice(0, 100), filter,
      actsFrom: s.acts_from || todayMsk(), limit: 50, offset: (page - 1) * 50 });
    res.json({ page, filter, total: rows.length ? Number(rows[0].total) : 0, rows: rows.map((r) => ({
      id: r.id, name: r.name, phone: r.phone, lastVisitAt: r.last_visit_at || null,
      contract: !!r.contract_signed, consent: !!r.consent_signed, pending: !!r.pending, openActs: Number(r.open_acts) || 0,
    })) });
  } catch (e) { sendError(res, e, logger, 'edocs board clients'); }
});

// ── страница пациента ──
router.get('/clients/:id/page', async (req, res) => {
  const id = posInt(req.params.id);
  const sid = req.user.salonId;
  try {
    const client = id ? await store.getClient(sid, id) : null;
    if (!client) return res.status(404).json({ error: 'Пациент не найден' });
    const s = await boardSettings(sid);
    const today = todayMsk();
    const opts = settingsForBoard(s, today);
    const [identityRow, records, docs, formRows, notes, templates, packages, events] = await Promise.all([
      store.getIdentityRow(sid, id), boardStore.listClientRecords(sid, id, board.addDays(today, -90), board.addDays(today, 30)),
      boardStore.listDocsForClients(sid, [id]), boardStore.listLatestForms(sid, [id]), boardStore.listAutoNotes(sid, [id]),
      store.listTemplates(sid), store.listClientPackages(sid, id, 20), boardStore.listClientEvents(sid, id, 40),
    ]);
    // Паспорт здесь не расшифровывается: полнота — по secure_fields; шифротекст наружу не уходит.
    const identity = identityRow ? { ...identityRow, secure_enc: undefined } : null;
    const page = board.buildClientPage({ client, identity, records, docs, templates, requisites: s.requisites, forms: formRows, notes,
      settings: opts, nowMs: Date.now(), today, focusRecordId: posInt(req.query.record) });
    const ycNo = counter.yclientsNumber(client);
    let numbering = { auto: opts.autonumber, contractNo: (identityRow && identityRow.contract_no) || null, yclientsNo: ycNo, next: null };
    if (opts.autonumber && !numbering.contractNo && !ycNo) numbering.next = (await counter.peek(sid)).next;
    res.json({
      ...page, today, numbering, actsRequiredFrom: opts.actsRequiredFrom, module: await moduleState(req, s),
      identity: identityRow ? { exists: true, source: identityRow.source, updatedAt: identityRow.updated_at, secureFields: identityRow.secure_fields || [] } : { exists: false },
      templates: templates.filter((t) => t.is_active).map((t) => ({ id: t.id, kind: t.kind, title: t.title, placeholders: t.placeholders || [] })),
      packages: packages.map((p) => ({ id: p.id, kind: p.kind, title: p.title, status: p.status, recordId: p.record_id || null,
        createdAt: p.created_at, sentAt: p.sent_at || null, signedAt: p.signed_at || null, lastError: p.last_error || null })),
      events: events.map((e) => ({ kind: e.kind, packageId: e.package_id || null, payload: e.payload || {}, createdAt: e.created_at, userName: e.user_name || null })),
    });
  } catch (e) { sendError(res, e, logger, 'edocs client page'); }
});

// ── «Подписано на бумаге» ──
router.post('/clients/:id/paper', (req, res, next) => {
  scanUpload.single('scan')(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'Скан больше 10 МБ' : 'Не удалось принять файл' });
    return next();
  });
}, async (req, res) => {
  const id = posInt(req.params.id);
  const b = req.body || {};
  const templateIds = idList(b.templateIds);
  if (!id) return res.status(404).json({ error: 'Пациент не найден' });
  if (!templateIds.length || templateIds.some((x) => !x)) return res.status(400).json({ error: 'Отметьте документы' });
  const recordId = b.recordId ? posInt(b.recordId) : null;
  if (b.recordId && !recordId) return res.status(400).json({ error: 'Неверный визит' });
  try {
    res.json(await paper.markPaper({ salonId: req.user.salonId, userId: req.user.userId, clientId: id, templateIds, recordId,
      signedDate: b.signedDate ? String(b.signedDate) : null, note: b.note, file: req.file || null }));
  } catch (e) { sendError(res, e, logger, 'edocs paper'); }
});

router.get('/packages/:id/scan', async (req, res) => {
  if (!UUID_RE.test(String(req.params.id))) return res.status(404).json({ error: 'Комплект не найден' });
  try { res.json(await paper.scanUrl({ salonId: req.user.salonId, packageId: req.params.id })); }
  catch (e) { sendError(res, e, logger, 'edocs scan'); }
});

router.post('/packages/:id/paper-revoke', requireRole('owner', 'admin'), async (req, res) => {
  if (!UUID_RE.test(String(req.params.id))) return res.status(404).json({ error: 'Комплект не найден' });
  try { res.json(await paper.revokePaper({ salonId: req.user.salonId, userId: req.user.userId, packageId: req.params.id, reason: (req.body || {}).reason })); }
  catch (e) { sendError(res, e, logger, 'edocs paper revoke'); }
});

// ── анкета пациента ──
router.post('/clients/:id/forms', async (req, res) => {
  const id = posInt(req.params.id);
  const b = req.body || {};
  if (!id) return res.status(404).json({ error: 'Пациент не найден' });
  if (b.kinds !== undefined && (!Array.isArray(b.kinds) || b.kinds.some((k) => !FORM_KINDS.includes(k)))) return res.status(400).json({ error: 'Неверный список документов' });
  const recordId = b.recordId ? posInt(b.recordId) : null;
  if (b.recordId && !recordId) return res.status(400).json({ error: 'Неверный визит' });
  if (b.deliver !== undefined && !['messenger', 'none'].includes(b.deliver)) return res.status(400).json({ error: 'Способ доставки: messenger или none' });
  try {
    res.json(await forms.createForm({ salonId: req.user.salonId, userId: req.user.userId, clientId: id, recordId, kinds: b.kinds || null,
      sendDocs: b.sendDocs !== false, deliver: b.deliver || 'none', source: 'manual', publicBase: publicBase(req) }));
  } catch (e) { sendError(res, e, logger, 'edocs form create'); }
});

function formId(req, res) {
  if (UUID_RE.test(String(req.params.id))) return req.params.id;
  res.status(404).json({ error: 'Анкета не найдена' });
  return null;
}
router.get('/forms/:id/link', async (req, res) => {
  const fid = formId(req, res); if (!fid) return;
  try { res.json(await forms.formLink({ salonId: req.user.salonId, formId: fid, publicBase: publicBase(req) })); }
  catch (e) { sendError(res, e, logger, 'edocs form link'); }
});
router.post('/forms/:id/send', async (req, res) => {
  const fid = formId(req, res); if (!fid) return;
  try { res.json(await forms.resendForm({ salonId: req.user.salonId, formId: fid, publicBase: publicBase(req) })); }
  catch (e) { sendError(res, e, logger, 'edocs form send'); }
});
router.post('/forms/:id/revoke', async (req, res) => {
  const fid = formId(req, res); if (!fid) return;
  try { res.json(await forms.revokeForm({ salonId: req.user.salonId, formId: fid, userId: req.user.userId })); }
  catch (e) { sendError(res, e, logger, 'edocs form revoke'); }
});

module.exports = router;
```

- [ ] **Step 4: Публичный роутер анкеты**

Создать `backend/routes/public-anketa.js`:

```js
'use strict';
// Публичная анкета пациента (БЕЗ JWT) — спека 2026-10-25 §6.4. Монтируется ДО глобальной
// проверки /api (как public-cert-request). Токен — в адресе: страница и ответы не кэшируются,
// Referrer не уходит (иначе токен утёк бы по ссылке на политику), поисковикам — noindex.
// Лимиты — память процесса (cert-request.makeRateLimiter), ошибка лимита — 429 с текстом.
const path = require('path');
const router = require('express').Router();
const multer = require('multer');
const forms = require('../services/edocs/forms');
const { makeRateLimiter } = require('../services/cert-request');
const { createLogger } = require('../logger');

const logger = createLogger('AnketaPublic');
const viewLimit = makeRateLimiter({ max: 60, windowMs: 10 * 60 * 1000 });
const submitIpLimit = makeRateLimiter({ max: 30, windowMs: 60 * 60 * 1000 });
const submitFormLimit = makeRateLimiter({ max: 10, windowMs: 60 * 60 * 1000 });
const photoLimit = makeRateLimiter({ max: 10, windowMs: 60 * 60 * 1000 });
const photoUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024, files: 1 } });
const TOO_MANY = { error: 'Слишком много запросов — попробуйте позже', code: 'too_many_requests' };

function clientIp(req) { return req.ip || (req.socket && req.socket.remoteAddress) || 'unknown'; }
function privateHeaders(res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
}
/** Ошибки анкеты — человеческим текстом; прочее — 500 без подробностей (подробности в лог). */
function fail(res, e, label) {
  if (e && e.name === 'EdocsError') return res.status(e.status || 400).json({ error: e.message, code: e.code });
  logger.error(`${label}: ${(e && e.message) || e}`);
  return res.status(500).json({ error: 'Не получилось — попробуйте ещё раз или сообщите клинике', code: 'internal' });
}

router.get('/anketa/:token', (req, res) => {
  privateHeaders(res);
  res.setHeader('Content-Security-Policy',
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; " +
    "frame-ancestors 'none'; form-action 'self'; base-uri 'none'");
  res.sendFile(path.join(__dirname, '../../frontend/anketa.html'));
});

router.get('/api/public/anketa/:token', async (req, res) => {
  privateHeaders(res);
  if (!viewLimit(clientIp(req))) return res.status(429).json(TOO_MANY);
  try { res.json(await forms.publicView(req.params.token)); } catch (e) { fail(res, e, 'anketa view'); }
});

router.post('/api/public/anketa/:token', async (req, res) => {
  privateHeaders(res);
  if (!submitIpLimit(clientIp(req)) || !submitFormLimit(String(req.params.token).slice(0, 64))) return res.status(429).json(TOO_MANY);
  try {
    const r = await forms.publicSubmit(req.params.token, req.body || {}, { ip: clientIp(req) });
    res.json({ ok: r.ok, docs: r.docs });   // _background (промис отправки документов) наружу не отдаётся
  } catch (e) { fail(res, e, 'anketa submit'); }
});

router.post('/api/public/anketa/:token/photo', (req, res, next) => {
  privateHeaders(res);
  if (!photoLimit(clientIp(req))) return res.status(429).json(TOO_MANY);
  photoUpload.single('photo')(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'Фото больше 15 МБ' : 'Не удалось принять фото', code: 'bad_image' });
    return next();
  });
}, async (req, res) => {
  try { res.json(await forms.publicPhoto(req.params.token, req.file)); } catch (e) { fail(res, e, 'anketa photo'); }
});

module.exports = router;
```

- [ ] **Step 5: `edocs-admin.js`: настройки автоматики**

Правка 1 из 3. В `backend/routes/edocs-admin.js` найти:

```js
const { sendError } = require('../services/edocs/errors');
const { createLogger } = require('../logger');
```

заменить на:

```js
const { sendError } = require('../services/edocs/errors');
const counter = require('../services/edocs/counter');
const forms = require('../services/edocs/forms');
const config = require('../config');
const { db } = require('../db');
const { isCalendarDate, todayMsk } = require('../utils/period');
const { createLogger } = require('../logger');
```

Правка 2 из 3. В `backend/routes/edocs-admin.js` найти:

```js
});

// ── шаблоны ── (статические пути — ДО /templates/:id)
```

заменить на:

```js
});

// ── автоматика, анкета, нумерация договоров (спека 2026-10-25 §7, §9) ──
/**
 * Тело PUT /automation. Флаги — строго boolean; числа — в своих границах; текст анкеты обязан
 * содержать {ссылка} (без неё сообщение бесполезно), пустой — текст по умолчанию.
 */
function parseAutomation(b, { today = todayMsk() } = {}) {
  b = b || {};
  const int = (v, min, max, dflt, label) => {
    if (v === undefined || v === null || v === '') return { v: dflt };
    const n = typeof v === 'number' || typeof v === 'string' ? Number(v) : NaN;
    return Number.isInteger(n) && n >= min && n <= max ? { v: n } : { error: `${label}: целое от ${min} до ${max}` };
  };
  const flag = (v, label) => (v === undefined || v === true || v === false ? { v: v === true } : { error: `${label}: да или нет` });
  const pv = b.previsit || {}, act = b.act || {}, rm = b.remind || {};
  const checks = {
    auto_previsit: flag(pv.on, 'Перед визитом'), auto_previsit_hours: int(pv.hours, 2, 168, 24, 'Часов до визита'),
    auto_previsit_form: flag(pv.form === undefined ? true : pv.form, 'Анкета, если данных не хватает'),
    auto_act: flag(act.on, 'Акт после оплаты'), auto_act_delay_min: int(act.delayMin, 5, 240, 15, 'Минут после оплаты'),
    auto_remind: flag(rm.on, 'Повтор'), auto_remind_hours: int(rm.hours, 1, 48, 2, 'Часов до повтора'),
    form_ttl_days: int(b.formTtlDays, 1, 30, 7, 'Срок жизни анкеты'),
    contract_autonumber: flag(b.contractAutonumber === undefined ? true : b.contractAutonumber, 'Автонумерация договоров'),
  };
  const out = {};
  for (const [k, r] of Object.entries(checks)) { if (r.error) return { error: r.error }; out[k] = r.v; }
  out.auto_previsit_scope = pv.scope === 'all' ? 'all' : 'first';
  if (pv.scope !== undefined && !['all', 'first'].includes(pv.scope)) return { error: 'Кому: первичным или всем' };
  const sender = b.senderUserId === undefined || b.senderUserId === null || b.senderUserId === '' ? null : idParam(b.senderUserId);
  if (b.senderUserId && !sender) return { error: 'Неверный сотрудник' };
  if ((out.auto_previsit || out.auto_act || out.auto_remind) && !sender) return { error: 'Выберите сотрудника, от имени которого автоматика отправляет документы' };
  out.auto_sender_user_id = sender;
  const msg = b.formMessage === undefined || b.formMessage === null ? '' : String(b.formMessage).replace(/\r/g, '').trim();
  if (msg.length > 1000) return { error: 'Текст сообщения — до 1000 символов' };
  if (msg && !msg.includes('{ссылка}')) return { error: 'В тексте сообщения нужен {ссылка} — туда подставится адрес анкеты' };
  out.form_message = msg || null;
  if (b.actsRequiredFrom !== undefined && b.actsRequiredFrom !== null && b.actsRequiredFrom !== '') {
    const d = String(b.actsRequiredFrom);
    if (!isCalendarDate(d) || d < '2020-01-01' || d > today) return { error: 'Акты требуются с даты — не позже сегодняшней' };
    out.acts_required_from = d;
  }
  let nextNo;
  if (b.contractNextNo !== undefined && b.contractNextNo !== null && b.contractNextNo !== '') {
    const r = int(b.contractNextNo, 1, 999999999999, null, 'Следующий номер договора');
    if (r.error) return { error: r.error };
    nextNo = r.v;
  }
  return { value: out, nextNo };
}

router.get('/automation', async (req, res) => {
  const sid = req.user.salonId;
  try {
    const s = (await store.getSettings(sid)) || {};
    const [users, numbering, actsFrom] = await Promise.all([
      store.listUsersWithCredentials(sid), counter.peek(sid),
      db.oneOrNone(`SELECT to_char(acts_required_from, 'YYYY-MM-DD') AS d FROM edoc_settings WHERE salon_id=$1`, [sid]),
    ]);
    res.json({
      senderUserId: s.auto_sender_user_id || null,
      senders: users.filter((u) => u.is_active).map((u) => ({ id: u.id, name: u.name || u.email, role: u.role, connected: !!u.login, broken: (u.fail_count || 0) >= 3 })),
      previsit: { on: !!s.auto_previsit, hours: s.auto_previsit_hours || 24, scope: s.auto_previsit_scope || 'first', form: s.auto_previsit_form !== false },
      act: { on: !!s.auto_act, delayMin: s.auto_act_delay_min || 15 },
      remind: { on: !!s.auto_remind, hours: s.auto_remind_hours || 2 },
      formMessage: s.form_message || '', formMessageDefault: forms.DEFAULT_MESSAGE, formTtlDays: s.form_ttl_days || 7,
      contractAutonumber: s.contract_autonumber !== false, contractNext: numbering,
      actsRequiredFrom: (actsFrom && actsFrom.d) || null,
      publicUrlConfigured: !!config.EDOCS_PUBLIC_URL, testPhones: config.EDOCS_TEST_PHONES || [],
    });
  } catch (e) { sendError(res, e, logger, 'edocs automation get'); }
});

router.put('/automation', async (req, res) => {
  const p = parseAutomation(req.body);
  if (p.error) return res.status(400).json({ error: p.error });
  const sid = req.user.salonId;
  try {
    if (p.value.auto_sender_user_id) {
      const users = await store.listUsersWithCredentials(sid);
      if (!users.some((u) => u.id === p.value.auto_sender_user_id && u.is_active)) return res.status(400).json({ error: 'Сотрудник не найден' });
    }
    await store.saveSettings(sid, p.value);
    if (p.nextNo) await counter.setNext(sid, p.nextNo);
    res.json({ ok: true });
  } catch (e) { sendError(res, e, logger, 'edocs automation save'); }
});

// ── шаблоны ── (статические пути — ДО /templates/:id)
```

Правка 3 из 3. Дописать в конец `backend/routes/edocs-admin.js`:

```js
module.exports.parseAutomation = parseAutomation;
```

- [ ] **Step 6: `store.js`: колонки настроек автоматики**

В `backend/services/edocs/store.js` найти:

```js
const SETTINGS_COLS = ['enabled', 'base_url', 'api_key_enc', 'app_login', 'app_password_enc', 'app_code', 'corp_id',
  'qes_cert_alias', 'employee_position', 'requisites', 'unsign_days', 'webhook_secret'];

async function getSettings(salonId) {
```

заменить на:

```js
const SETTINGS_COLS = ['enabled', 'base_url', 'api_key_enc', 'app_login', 'app_password_enc', 'app_code', 'corp_id',
  'qes_cert_alias', 'employee_position', 'requisites', 'unsign_days', 'webhook_secret',
  // автоматика, анкета, нумерация (спека 2026-10-25 §7, §9)
  'auto_sender_user_id', 'auto_previsit', 'auto_previsit_hours', 'auto_previsit_scope', 'auto_previsit_form',
  'auto_act', 'auto_act_delay_min', 'auto_remind', 'auto_remind_hours', 'form_message', 'form_ttl_days',
  'contract_autonumber', 'acts_required_from'];

async function getSettings(salonId) {
```

- [ ] **Step 7: `edocs.js`: источник и бумага в ответе комплекта**

Правка 1 из 2. В `backend/routes/edocs.js` найти:

```js
    id: p.id, kind: p.kind, title: p.title, status: p.status, fdocStatus: p.fdoc_status || null,
    clientId: p.client_id, clientName: p.client_name || null, clientPhone: p.client_phone || null, recordId: p.record_id || null,
    sentAt: p.sent_at || null, signedAt: p.signed_at || null, sentByName: p.sent_by_name || null, lastError: p.last_error || null,
```

заменить на:

```js
    id: p.id, kind: p.kind, title: p.title, status: p.status, fdocStatus: p.fdoc_status || null,
    clientId: p.client_id, clientName: p.client_name || null, clientPhone: p.client_phone || null, recordId: p.record_id || null, source: p.source || 'manual',
    sentAt: p.sent_at || null, signedAt: p.signed_at || null, sentByName: p.sent_by_name || null, lastError: p.last_error || null,
```

Правка 2 из 2. В `backend/routes/edocs.js` найти:

```js
      patient: (p.payload && p.payload.patient) || null,
      documents: docs.map((d) => ({ id: d.id, title: d.title, fileName: d.file_name, fdocStatus: d.fdoc_status || null,
```

заменить на:

```js
      patient: (p.payload && p.payload.patient) || null,
      // «Подписано на бумаге»: дата, комментарий, есть ли скан (ключ S3 наружу не отдаётся).
      paper: p.payload && p.payload.paper ? { signedDate: p.payload.paper.signedDate || null, note: p.payload.paper.note || '',
        hasScan: !!(p.payload.paper.scan && p.payload.paper.scan.key) } : null,
      documents: docs.map((d) => ({ id: d.id, title: d.title, fileName: d.file_name, fdocStatus: d.fdoc_status || null,
```

- [ ] **Step 8: `routes/index.js`: монтаж роутеров**

Правка 1 из 2. В `backend/routes/index.js` найти:

```js
  app.use(require('./public-cert-request'));

  // ── Mobile App API (separate auth) ────────────────────────
```

заменить на:

```js
  app.use(require('./public-cert-request'));
  // Анкета пациента «Документов» (/anketa/<токен>, /api/public/anketa/…) — без JWT, ДО проверки /api.
  app.use(require('./public-anketa'));

  // ── Mobile App API (separate auth) ────────────────────────
```

Правка 2 из 2. В `backend/routes/index.js` найти:

```js
  app.use('/api/edocs/admin',       require('./edocs-admin'));
  app.use('/api/edocs',             require('./edocs'));
```

заменить на:

```js
  app.use('/api/edocs/admin',       require('./edocs-admin'));
  // Дашборд, страница пациента, бумага, анкеты — свой роутер, ДО общего (роли те же).
  app.use('/api/edocs',             require('./edocs-board'));
  app.use('/api/edocs',             require('./edocs'));
```

- [ ] **Step 9: Тесты проходят**

```bash
cd backend && npx jest backend/edocs-board-routes.test.js 2>&1 | grep -E "^Tests:"; npx jest backend/edocs- 2>&1 | grep -E "^(Tests|Test Suites):"
```

Ожидается: `Tests: 17 passed, 17 total`; затем `Test Suites: 16 passed, 16 total`, `Tests: 316 passed, 316 total`.

- [ ] **Step 10: Коммит**

```bash
git add backend/edocs-board-routes.test.js backend/routes/edocs-board.js backend/routes/public-anketa.js backend/routes/edocs-admin.js backend/services/edocs/store.js backend/routes/edocs.js backend/routes/index.js
git commit -m "feat(edocs): ручки дашборда, страницы пациента, бумаги, анкет; публичная анкета; настройки автоматики" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 11: Публичная страница анкеты — **Sonnet**

`frontend/anketa.html` + `frontend/js/anketa.js` — без зависимостей SPA и без JWT; стили внутри страницы (CSP разрешает только свои скрипты, инлайн-стили — да); мобильная вёрстка в цветах клиники, монограмма вместо логотипа. Токен берётся из адреса и проверяется по форме ДО запроса. Состояния: загрузка, «ссылка не действует» (устарела / отозвана / уже заполнена / не найдена — с понятным текстом), форма (фото паспорта — только если сервер разрешил распознавание; поля по группам; согласие со ссылкой на политику), «Спасибо» с текстом про SMS, если документы уходят на подпись. Пустые обязательные поля подсвечиваются, фокус — на первое; сбой сети — «Нет связи», лимит — текст сервера. Внешний вид проверяет визуальный стенд (задача 16).

**Files:**
- Create: `frontend/anketa.html`, `frontend/js/anketa.js`

- [ ] **Step 1: Страница**

Создать `frontend/anketa.html`:

```html
<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="robots" content="noindex,nofollow">
<meta name="referrer" content="no-referrer">
<title>Анкета пациента</title>
<style>
  /* Публичная анкета «Документов» (спека 2026-10-25 §6): страница пациента, цвета клиники. Скрипт —
     /js/anketa.js (CSP: только свои скрипты). Ничего из уже известных данных пациента страница не показывает. */
  :root{--bg:#F4EFE6;--card:#FFFCF8;--ink:#3f3832;--muted:#6C5F55;--line:#DED3C7;--accent:#806335;--accent-ink:#fff;--ok:#3F6B43;--bad:#A9442F;--bad-bg:#F7E4DD}
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.5 -apple-system,'Segoe UI',system-ui,sans-serif;-webkit-text-size-adjust:100%}
  main{max-width:560px;margin:0 auto;padding:22px 16px 40px}
  .brand{display:flex;align-items:center;gap:10px;margin-bottom:18px;color:var(--accent);letter-spacing:3px;font:600 13px Georgia,serif;text-transform:uppercase}
  .mono{width:34px;height:34px;border-radius:50%;border:1.5px solid var(--accent);display:grid;place-items:center;font:600 16px Georgia,serif;letter-spacing:0}
  h1{font:600 28px/1.15 Georgia,'Times New Roman',serif;margin:0 0 8px}
  .lead{color:var(--muted);margin:0 0 18px}
  .card{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:16px;margin-bottom:14px}
  .photo{display:flex;flex-wrap:wrap;gap:12px;align-items:center}
  .photo .t{flex:1 1 200px;font-size:14px;color:var(--muted)}
  .photo .file{flex:1 1 auto}
  .btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;min-height:48px;padding:0 18px;border-radius:12px;border:1px solid var(--accent);background:var(--accent);color:var(--accent-ink);font:600 16px inherit;cursor:pointer;width:100%}
  .btn.sec{background:transparent;color:var(--accent)}
  .btn[disabled]{opacity:.55;cursor:default}
  .file{position:relative;overflow:hidden;width:auto;white-space:nowrap}
  .file input{position:absolute;inset:0;opacity:0;cursor:pointer}
  .sect{font-size:11px;letter-spacing:1.6px;text-transform:uppercase;color:var(--muted);margin:6px 0 10px}
  .f{margin-bottom:14px}
  .f label{display:block;font-size:13px;font-weight:600;margin-bottom:5px}
  .f input,.f select{width:100%;min-height:48px;font:16px inherit;padding:10px 12px;border:1px solid var(--line);border-radius:10px;background:#fff;color:var(--ink)}
  .f.err input,.f.err select{border-color:var(--bad);background:var(--bad-bg)}
  .opt{color:var(--muted);font-weight:400}
  .consent{display:flex;gap:10px;align-items:flex-start;font-size:14px;color:var(--muted);margin:6px 0 16px}
  .consent input{width:22px;height:22px;flex:none;margin-top:1px}
  .consent a{color:var(--accent)}
  .msg{border-radius:12px;padding:12px 14px;font-size:14px;margin-bottom:14px}
  .msg.bad{background:var(--bad-bg);color:var(--bad)}
  .msg.info{background:#EFE6D8;color:var(--ink)}
  .done{text-align:center;padding:40px 10px}
  .done .ico{width:64px;height:64px;border-radius:50%;margin:0 auto 14px;display:grid;place-items:center;font-size:30px;background:#E3EEDF;color:var(--ok)}
  .done h1{font-size:26px}
  .small{font-size:12.5px;color:var(--muted);text-align:center;margin-top:18px}
  [hidden]{display:none!important}
</style>
</head>
<body>
<main>
  <div class="brand"><span class="mono" id="aMono">P</span><span id="aClinic">Клиника</span></div>
  <div id="aLoading" class="lead">Загружаем анкету…</div>
  <section id="aGone" hidden class="done"><div class="ico" id="aGoneIco">!</div><h1 id="aGoneTitle"></h1><p class="lead" id="aGoneText"></p></section>
  <section id="aForm" hidden>
    <h1 id="aHello">Здравствуйте!</h1>
    <p class="lead" id="aLead">Заполните, пожалуйста, данные для договора — это займёт пару минут.</p>
    <div class="card photo" id="aPhotoCard" hidden>
      <div class="t">Сфотографируйте разворот паспорта с фотографией — поля заполнятся сами, останется проверить.</div>
      <label class="btn sec file" id="aPhotoBtn">📷 Фото паспорта<input type="file" id="aPhoto" accept="image/*" capture="environment"></label>
    </div>
    <div id="aMsg"></div>
    <form id="aFields" class="card" novalidate></form>
    <label class="consent"><input type="checkbox" id="aConsent"><span>Даю согласие на обработку моих персональных данных для оформления договора и подтверждаю, что они верны. <a id="aPolicy" href="/privacy-policy.html" target="_blank" rel="noopener noreferrer">Политика обработки данных</a></span></label>
    <button class="btn" id="aSubmit" type="button">Отправить</button>
    <p class="small">Данные передаются по защищённому соединению и хранятся в зашифрованном виде.</p>
  </section>
  <section id="aDone" hidden class="done"><div class="ico">✓</div><h1>Спасибо!</h1><p class="lead" id="aDoneText"></p></section>
</main>
<script src="/js/anketa.js"></script>
</body>
</html>
```

- [ ] **Step 2: Скрипт страницы**

Создать `frontend/js/anketa.js`:

```js
// Публичная анкета пациента «Документов» (спека 2026-10-25 §6). Без зависимостей SPA и без JWT:
// токен — в адресе /anketa/<токен>. Сервер отдаёт только имя для приветствия, дату визита и список
// полей; уже известные данные пациента не приходят (у кого ссылка, тот паспорт не прочитает).
(function () {
  'use strict';
  var token = (location.pathname.split('/anketa/')[1] || '').split('/')[0];
  var api = '/api/public/anketa/' + encodeURIComponent(token);
  var fields = [];
  var $ = function (id) { return document.getElementById(id); };
  var GONE = {
    submitted: ['✓', 'Анкета уже заполнена', 'Спасибо! Данные переданы в клинику.'],
    expired: ['!', 'Срок действия ссылки истёк', 'Попросите клинику прислать новую ссылку.'],
    revoked: ['!', 'Ссылка больше не действует', 'Попросите клинику прислать новую ссылку.'],
    not_found: ['?', 'Ссылка не найдена', 'Проверьте, что ссылка открыта полностью, или попросите клинику прислать новую.'],
  };

  function show(id) { ['aLoading', 'aGone', 'aForm', 'aDone'].forEach(function (x) { $(x).hidden = x !== id; }); }
  function gone(status) {
    var g = GONE[status] || GONE.not_found;
    $('aGoneIco').textContent = g[0]; $('aGoneTitle').textContent = g[1]; $('aGoneText').textContent = g[2];
    show('aGone');
  }
  function msg(text, cls) { $('aMsg').innerHTML = ''; if (!text) return; var d = document.createElement('div'); d.className = 'msg ' + (cls || 'bad'); d.textContent = text; $('aMsg').appendChild(d); }
  function req(method, url, body, isForm) {
    var opts = { method: method, headers: {} };
    if (isForm) opts.body = body;
    else if (body !== undefined) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
    return fetch(url, opts).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) { return { ok: r.ok, status: r.status, body: j || {} }; });
    }, function () { return { ok: false, status: 0, body: { error: 'Нет связи — проверьте интернет и попробуйте ещё раз' } }; });
  }

  function input(f) {
    var w = document.createElement('div');
    w.className = 'f';
    w.id = 'aw-' + f.key;
    var l = document.createElement('label');
    l.setAttribute('for', 'af-' + f.key);
    l.textContent = f.label;
    if (!f.required) { var o = document.createElement('span'); o.className = 'opt'; o.textContent = ' — необязательно'; l.appendChild(o); }
    w.appendChild(l);
    var el;
    if (f.type === 'gender') {
      el = document.createElement('select');
      [['', 'Выберите'], ['F', 'Женский'], ['M', 'Мужской']].forEach(function (p) { var op = document.createElement('option'); op.value = p[0]; op.textContent = p[1]; el.appendChild(op); });
    } else {
      el = document.createElement('input');
      el.type = f.type === 'date' ? 'date' : f.type === 'email' ? 'email' : 'text';
      if (f.type === 'digits') { el.inputMode = 'numeric'; el.autocomplete = 'off'; }
      if (f.key === 'passport_series') el.maxLength = 5;
      if (f.key === 'passport_number') el.maxLength = 7;
      if (f.key === 'authority_code') { el.inputMode = 'numeric'; el.maxLength = 7; el.placeholder = '000-000'; }
      if (f.key === 'last_name') el.autocomplete = 'family-name';
      if (f.key === 'first_name') el.autocomplete = 'given-name';
      if (f.key === 'middle_name') el.autocomplete = 'additional-name';
      if (f.key === 'birth_date') el.autocomplete = 'bday';
      if (f.key === 'address') el.autocomplete = 'street-address';
    }
    el.id = 'af-' + f.key;
    el.addEventListener('input', function () { w.classList.remove('err'); });
    w.appendChild(el);
    return w;
  }

  function render(d) {
    $('aClinic').textContent = d.clinic || 'Клиника';
    $('aMono').textContent = String(d.clinic || 'К').trim().charAt(0).toUpperCase();
    document.title = 'Анкета — ' + (d.clinic || 'клиника');
    $('aHello').textContent = d.greetingName ? 'Здравствуйте, ' + d.greetingName + '!' : 'Здравствуйте!';
    $('aLead').textContent = (d.visit ? 'Перед визитом ' + d.visit.label + ' заполните' : 'Заполните') + ', пожалуйста, данные для договора — это займёт пару минут.';
    if (d.policyUrl) $('aPolicy').href = d.policyUrl;
    $('aPhotoCard').hidden = !d.canRecognize;
    fields = d.fields || [];
    var form = $('aFields');
    form.innerHTML = '';
    var groups = { last_name: 'Личные данные', passport_series: 'Паспорт РФ', address: 'Адрес регистрации', email: 'Для связи' };
    fields.forEach(function (f) {
      if (groups[f.key]) { var s = document.createElement('div'); s.className = 'sect'; s.textContent = groups[f.key]; form.appendChild(s); }
      form.appendChild(input(f));
    });
    show('aForm');
  }

  function values() {
    var out = {};
    fields.forEach(function (f) { out[f.key] = ($('af-' + f.key).value || '').trim(); });
    return out;
  }
  function markEmpty() {
    var first = null;
    fields.forEach(function (f) {
      var empty = f.required && !($('af-' + f.key).value || '').trim();
      $('aw-' + f.key).classList.toggle('err', empty);
      if (empty && !first) first = $('af-' + f.key);
    });
    if (first) first.focus();
    return !first;
  }

  function submit() {
    msg('');
    if (!markEmpty()) { msg('Заполните отмеченные поля'); return; }
    if (!$('aConsent').checked) { msg('Подтвердите согласие на обработку персональных данных'); return; }
    var body = values();
    body.consent = true;
    var btn = $('aSubmit');
    btn.disabled = true;
    btn.textContent = 'Отправляем…';
    req('POST', api, body).then(function (r) {
      btn.disabled = false;
      btn.textContent = 'Отправить';
      if (r.ok) {
        $('aDoneText').textContent = r.body.docs === 'sending'
          ? 'Данные получены. В течение пары минут придёт SMS со ссылкой на подписание документов — откройте её и подпишите кодом из SMS.'
          : 'Данные переданы в клинику.';
        show('aDone');
        return;
      }
      if (r.status === 410) { gone(r.body.code === 'form_submitted' ? 'submitted' : r.body.code === 'form_expired' ? 'expired' : 'revoked'); return; }
      msg(r.body.error || 'Не получилось отправить — попробуйте ещё раз');
    });
  }

  function photo(e) {
    var file = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!file) return;
    var fd = new FormData();
    fd.append('photo', file);
    msg('Распознаём паспорт…', 'info');
    $('aPhotoBtn').classList.add('busy');
    req('POST', api + '/photo', fd, true).then(function (r) {
      if (!r.ok) { msg(r.body.error || 'Не удалось распознать — введите данные вручную'); return; }
      if (!r.body.recognized) { msg('Паспорт на фото не нашёлся — снимите разворот целиком или введите данные вручную'); return; }
      Object.keys(r.body.fields || {}).forEach(function (k) { var el = $('af-' + k); if (el) el.value = r.body.fields[k]; });
      msg(r.body.confidence ? 'Поля заполнены по фото — проверьте их, пожалуйста' : 'Распознано не очень уверенно — внимательно проверьте каждое поле', 'info');
    });
  }

  $('aSubmit').addEventListener('click', submit);
  $('aPhoto').addEventListener('change', photo);
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) { gone('not_found'); return; }
  req('GET', api).then(function (r) {
    if (!r.ok) { if (r.status === 429) { $('aLoading').textContent = r.body.error || 'Слишком много запросов — попробуйте позже'; return; } gone('not_found'); return; }
    if (r.body.status !== 'active') { gone(r.body.status); return; }
    render(r.body);
  });
})();
```

- [ ] **Step 3: Синтаксис**

```bash
node --check frontend/js/anketa.js && echo syntax-ok
```

Ожидается: `syntax-ok`.

- [ ] **Step 4: Коммит**

```bash
git add frontend/anketa.html frontend/js/anketa.js
git commit -m "feat(edocs): публичная страница анкеты пациента" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

### Task 12: Живая проверка SQL и ручек на дев-БД — **Sonnet**

`scripts/edocs-board-smoke.js`: в ОДНОЙ транзакции применяет `EDOCS_BOARD_DDL` (без `REFERENCES`, чтобы не брать блокировки на `clients`/`records`/`users`), прогоняет все новые запросы `board-store`, `counter`, `forms-store`, `automation-store`, `store` (вставка комплекта с видом, бумага, быстрая полоса опроса) и настоящие обработчики `routes/edocs-board.js` на реальных записях дева, в конце ROLLBACK — в БД ничего не остаётся. Юнит-тесты подменяют `db` и не видят типов параметров, `to_char`, `DISTINCT ON`. `--explain` печатает EXPLAIN ANALYZE доски и выборок автоматики с РЕАЛЬНЫМИ bound-параметрами (правило проекта: параметризованный SQL проверяется самим загрузчиком, а не копией с литералами). Только дев-БД `loyalpro_test`.

**Files:**
- Create: `backend/scripts/edocs-board-smoke.js`

- [ ] **Step 1: Скрипт проверки**

Создать `backend/scripts/edocs-board-smoke.js`:

```js
'use strict';
// Проверка SQL дашборда «Документов» на настоящей схеме: новые операторы миграции (EDOCS_BOARD_DDL —
// без REFERENCES, чтобы не брать блокировки на clients/records/users) и все новые запросы board-store,
// counter, forms-store, automation-store, store (insertPackage с видом документа, бумага, быстрая
// полоса опроса) — в ОДНОЙ транзакции, в конце ROLLBACK: в БД ничего не остаётся. Юнит-тесты
// подменяют db и SQL не видят (типы параметров, to_char, DISTINCT ON). Только дев-БД (loyalpro_test).
//   node scripts/edocs-board-smoke.js            — проверки
//   node scripts/edocs-board-smoke.js --explain  — плюс EXPLAIN ANALYZE запросов дашборда и автоматики
const path = require('path');
const crypto = require('crypto');
const assert = require('assert/strict');

const REF_RE = /REFERENCES\s+\w+\(\w+\)(\s+ON\s+DELETE\s+(CASCADE|RESTRICT|SET\s+NULL))?/g;
const MODULES = ['store', 'board-store', 'counter', 'forms-store', 'automation-store'];

function bindDb(client) {
  // Один клиент на всю транзакцию, а ручки читают через Promise.all: запросы идут по очереди
  // (pg 8 предупреждает о query() на занятом клиенте, pg 9 это запретит). В бою у db — пул.
  let chain = Promise.resolve();
  const q = (sql, p) => { const r = chain.then(() => client.query(sql, p)); chain = r.catch(() => {}); return r; };
  const fakeDb = {
    query: q,
    one: async (sql, p) => (await q(sql, p)).rows[0] || null,
    oneOrNone: async (sql, p) => (await q(sql, p)).rows[0] || null,
    many: async (sql, p) => (await q(sql, p)).rows,
    any: async (sql, p) => (await q(sql, p)).rows,
  };
  let sp = 0;
  const withTransaction = async (fn) => {
    const name = `edocs_board_sp${++sp}`;
    await client.query(`SAVEPOINT ${name}`);
    try { const r = await fn(client); await client.query(`RELEASE SAVEPOINT ${name}`); return r; } catch (e) { await client.query(`ROLLBACK TO SAVEPOINT ${name}`); throw e; }
  };
  const dbPath = require.resolve('../db');
  const real = require.cache[dbPath] ? require.cache[dbPath].exports : {};
  require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: { ...real, db: fakeDb, withTransaction } };
  const mods = {};
  for (const m of MODULES) {
    const p = require.resolve(`../services/edocs/${m}`);
    delete require.cache[p];
  }
  for (const m of MODULES) mods[m] = require(`../services/edocs/${m}`);
  return mods;
}

async function run(client, { salonId = 1, explain = false } = {}) {
  const { store, 'board-store': bs, counter, 'forms-store': fs, 'automation-store': auto } = bindDb(client);
  const ok = (label, cond, extra) => { assert.ok(cond, `${label}: ${JSON.stringify(extra)}`); console.log(`ok  ${label}`); };
  const today = (await client.query(`SELECT to_char((NOW() AT TIME ZONE 'Europe/Moscow')::date, 'YYYY-MM-DD') AS d`)).rows[0].d;
  const shift = async (d, n) => (await client.query(`SELECT to_char($1::date + $2::int, 'YYYY-MM-DD') AS d`, [d, n])).rows[0].d;

  const rec = (await client.query(
    `SELECT r.id, r.client_id FROM records r JOIN clients c ON c.id=r.client_id WHERE r.salon_id=$1 AND r.status='arrived'
       AND (r.raw_payload->>'paid_full')='1' AND c.phone IS NOT NULL ORDER BY r.visit_datetime DESC LIMIT 1`, [salonId])).rows[0];
  const u = (await client.query("SELECT id FROM users WHERE salon_id=$1 AND role IN ('owner','admin') AND is_active ORDER BY id LIMIT 1", [salonId])).rows[0];
  assert.ok(rec && u, 'нет оплаченной состоявшейся записи или пользователя в салоне');
  const cid = rec.client_id;

  // ── настройки ──
  await bs.ensureSettingsRow(salonId);
  await store.saveSettings(salonId, { enabled: true, corp_id: 'SMOKE', auto_previsit: true, auto_act: true, auto_remind: true, auto_sender_user_id: u.id,
    acts_required_from: await shift(today, -10), contract_autonumber: true });
  const s = await bs.getBoardSettings(salonId);
  ok('getBoardSettings: acts_from строкой, флаги автоматики, имя сотрудника', /^\d{4}-\d{2}-\d{2}$/.test(s.acts_from) && s.auto_act === true && 'auto_sender_name' in s, s.acts_from);
  ok('listAutomationSalons видит салон', (await auto.listAutomationSalons()).some((x) => x.salon_id === salonId));

  // ── шаблоны и бумажный комплект ──
  const tid = {};
  for (const kind of ['contract', 'consent_pd', 'act']) {
    tid[kind] = await store.insertTemplate(salonId, { kind, title: `smoke ${kind}`, file_key: `smoke/${kind}`, file_size: 1, placeholders: ['fio'], created_by: u.id });
  }
  const paperId = crypto.randomUUID();
  await store.insertPackage({ id: paperId, salon_id: salonId, client_id: cid, record_id: null, kind: 'onboarding', title: 'smoke paper', sent_by: u.id,
    status: 'paper', source: 'paper', signed_at: `${today}T12:00:00+03:00`, payload: { paper: { signedDate: today } } },
  [{ id: crypto.randomUUID(), template_id: tid.contract, kind: 'contract', title: 'Договор', file_name: 'Договор.docx', sort_order: 0 }]);
  const actId = crypto.randomUUID();
  await store.insertPackage({ id: actId, salon_id: salonId, client_id: cid, record_id: rec.id, kind: 'act', title: 'smoke act', sent_by: u.id, source: 'auto' },
    [{ id: crypto.randomUUID(), template_id: tid.act, kind: 'act', title: 'Акт', file_name: 'Акт.docx', sort_order: 0 }]);
  await client.query(`UPDATE edoc_packages SET status='sent', sent_at=NOW() - INTERVAL '30 minutes', last_status_check_at=NOW() - INTERVAL '2 minutes' WHERE id=$1`, [actId]);
  const docs = await bs.listDocsForClients(salonId, [cid]);
  const pdoc = docs.find((d) => d.package_id === paperId);
  ok('listDocsForClients: вид документа, статус paper, источник', pdoc && pdoc.kind === 'contract' && pdoc.package_status === 'paper' && pdoc.source === 'paper', pdoc);
  ok('listDocsForClients: акт с record_id', docs.some((d) => d.package_id === actId && d.kind === 'act' && d.record_id === rec.id));
  ok('listDocsForClients чужого салона пуст', (await bs.listDocsForClients(-1, [cid])).length === 0);
  const due = await store.listDuePackages(500);
  ok('DUE_SQL: быстрая полоса — отправлен 30 мин назад, проверка 2 мин назад → в опросе', due.some((x) => x.id === actId));
  await client.query(`UPDATE edoc_packages SET last_status_check_at=NOW() - INTERVAL '10 seconds' WHERE id=$1`, [actId]);
  ok('DUE_SQL: проверка 10 с назад → не в опросе', !(await store.listDuePackages(500)).some((x) => x.id === actId));
  ok('revokePaperPackage: бумажный → true', (await store.revokePaperPackage(salonId, paperId)) === true);
  ok('revokePaperPackage: повторно → false; электронный → false', (await store.revokePaperPackage(salonId, paperId)) === false && (await store.revokePaperPackage(salonId, actId)) === false);

  // ── доска ──
  const win = { from: await shift(today, -10), to: await shift(today, 6) };
  const recs = await bs.listBoardRecords(salonId, win.from, win.to);
  ok('listBoardRecords: окно, visit_date строкой, has_prior_visit булев, нет удалённых', recs.length > 0 && recs.every((r) => /^\d{4}-\d{2}-\d{2}$/.test(r.visit_date)
    && typeof r.has_prior_visit === 'boolean' && r.status !== 'deleted' && r.status !== 'no_show'), recs.length);
  const ids = [...new Set(recs.map((r) => r.client_id))];
  ok('listIdentitiesForClients без secure_enc', (await bs.listIdentitiesForClients(salonId, ids)).every((x) => !('secure_enc' in x)));
  for (const f of Object.keys(bs.BASE_FILTERS)) {
    const rows = await bs.listBaseClients(salonId, { filter: f, actsFrom: win.from, limit: 5, offset: 0 });
    ok(`listBaseClients filter=${f}`, rows.every((r) => typeof r.contract_signed === 'boolean' && Number.isInteger(r.open_acts)) && (rows.length === 0 || Number(rows[0].total) >= rows.length));
  }
  ok('listBaseClients: поиск по цифрам и по имени', Array.isArray(await bs.listBaseClients(salonId, { search: '9200', actsFrom: win.from }))
    && Array.isArray(await bs.listBaseClients(salonId, { search: 'Ива', actsFrom: win.from })));
  const crecs = await bs.listClientRecords(salonId, cid, await shift(today, -90), await shift(today, 30));
  ok('listClientRecords: записи пациента', crecs.some((r) => r.id === rec.id));
  await store.logEvent({ salonId, clientId: cid, kind: 'paper', userId: u.id, payload: { smoke: true } });
  ok('listClientEvents: событие пациента с именем пользователя', (await bs.listClientEvents(salonId, cid)).some((e) => e.kind === 'paper' && 'user_name' in e));

  // ── номера договоров ──
  await store.upsertIdentity(salonId, cid, { plain: { last_name: 'Смоук', first_name: 'Тест', phone: '79200255591', contract_no: null }, secure_enc: null, secure_fields: [], source: 'manual', userId: u.id });
  const used = await counter.maxUsed(salonId);
  ok('maxUsed — число', Number.isInteger(used) && used >= 0, used);
  const peek = await counter.peek(salonId);
  ok('peek без строки счётчика — максимум + 1', peek.next === used + 1, peek);
  const crow = (await client.query('SELECT id, name, phone, yclients_data FROM clients WHERE id=$1', [cid])).rows[0];
  const r1 = await counter.ensureContractNo({ salonId, clientId: cid, client: { ...crow, yclients_data: {} }, docDate: today });
  ok('ensureContractNo из счётчика: номер записан пациенту', r1.source === 'counter' && r1.assigned
    && (await store.getIdentityRow(salonId, cid)).contract_no === r1.contractNo && (await store.getIdentityRow(salonId, cid)).contract_date === today, r1);
  ok('ensureContractNo повторно — тот же номер из данных', (await counter.ensureContractNo({ salonId, clientId: cid, client: crow, docDate: today })).contractNo === r1.contractNo);
  await counter.setNext(salonId, Number(r1.contractNo) + 100);
  ok('setNext / peek', (await counter.peek(salonId)).next === Number(r1.contractNo) + 100);

  // ── анкеты ──
  const formRow = (over = {}) => ({ id: crypto.randomUUID(), salon_id: salonId, client_id: cid, record_id: rec.id, token_hash: crypto.randomBytes(32).toString('hex'),
    token_enc: 'v1:a:b:c', fields: [{ key: 'last_name', required: true }], kinds: ['contract'], send_docs: true, sender_user_id: u.id, source: 'manual',
    created_by: u.id, expires_at: new Date(Date.now() + 86400000).toISOString(), ...over });
  const f1 = formRow();
  ok('insertForm: первая — ничего не отозвано', (await fs.insertForm(f1)).length === 0);
  const f2 = formRow();
  ok('insertForm: вторая отзывает первую', JSON.stringify(await fs.insertForm(f2)) === JSON.stringify([f1.id]));
  ok('getFormByHash / getForm', (await fs.getFormByHash(f2.token_hash)).id === f2.id && (await fs.getForm(salonId, f2.id)).status === 'active' && (await fs.getForm(-1, f2.id)) === null);
  ok('markOpened: первый раз true, второй false', (await fs.markOpened(f2.id)) === true && (await fs.markOpened(f2.id)) === false);
  ok('incAttempts', (await fs.incAttempts(f2.id)) === 1);
  ok('takeRecognize до лимита', (await fs.takeRecognize(f2.id, 1)) === true && (await fs.takeRecognize(f2.id, 1)) === false);
  await fs.setDelivered(f2.id, 'whatsapp');
  ok('listLatestForms: последняя анкета пациента', (await bs.listLatestForms(salonId, [cid]))[0].id === f2.id);
  ok('remindForms: доставлена только что — ещё не пора', !(await auto.remindForms(salonId, 2)).some((x) => x.id === f2.id));
  await client.query(`UPDATE edoc_patient_forms SET delivered_at = NOW() - INTERVAL '3 hours' WHERE id=$1`, [f2.id]);
  ok('remindForms: доставлена 3 ч назад — пора', (await auto.remindForms(salonId, 2)).some((x) => x.id === f2.id));
  ok('markSubmitted: один раз', (await fs.markSubmitted(f2.id, { accepted: true })) === true && (await fs.markSubmitted(f2.id, {})) === false);
  await fs.reopen(f2.id);
  ok('reopen → снова active', (await fs.getForm(salonId, f2.id)).status === 'active');
  await fs.setResult(f2.id, { packageId: actId });
  await fs.setResult(f2.id, { error: 'x' });
  ok('setResult: package_id не затирается ошибкой', (await fs.getForm(salonId, f2.id)).package_id === actId);
  ok('revoke: active → revoked; повторно — null', !!(await fs.revoke(salonId, f2.id)) && (await fs.revoke(salonId, f2.id)) === null);
  // NOW() в транзакции — время её НАЧАЛА: «просрочено секунду назад» по часам скрипта для SQL ещё в будущем.
  const f3 = formRow({ expires_at: '2020-01-01T00:00:00Z' });
  await fs.insertForm(f3);
  ok('markSubmitted просроченной — false', (await fs.markSubmitted(f3.id, {})) === false);
  ok('expireDue: просроченная → expired', (await fs.expireDue()).some((x) => x.id === f3.id) && (await fs.getForm(salonId, f3.id)).status === 'expired');
  ok('nextVisit / recordVisit / salonName', (await fs.recordVisit(salonId, rec.id)).id === rec.id && typeof (await fs.salonName(salonId)) === 'string'
    && ((await fs.nextVisit(salonId, cid)) === null || !!(await fs.nextVisit(salonId, cid)).visit_datetime));

  // ── автоматика ──
  const jobId = await auto.claim(salonId, 'act', rec.id, { clientId: cid, recordId: rec.id });
  ok('claim: первый раз — id, второй — null', !!jobId && (await auto.claim(salonId, 'act', rec.id, {})) === null);
  await auto.finish(jobId, 'failed', 'smoke: причина', { packageId: actId });
  const notes = await bs.listAutoNotes(salonId, [cid]);
  ok('listAutoNotes: последняя строка «вид × запись»', notes.some((n) => n.kind === 'act' && n.record_id === rec.id && n.status === 'failed' && n.reason === 'smoke: причина'));
  const nowIso = new Date().toISOString();
  ok('previsitCandidates (первичные и все)', Array.isArray(await auto.previsitCandidates(salonId, nowIso, new Date(Date.now() + 7 * 86400000).toISOString(), true))
    && Array.isArray(await auto.previsitCandidates(salonId, nowIso, new Date(Date.now() + 7 * 86400000).toISOString(), false)));
  ok('actCandidates: запись с актом и застолбленная — не кандидат', !(await auto.actCandidates(salonId, win.from, 0)).some((x) => x.id === rec.id));
  ok('remindPackages: отправлен 30 мин назад — при пороге 1 ч не пора', !(await auto.remindPackages(salonId, 1)).some((x) => x.id === actId));
  await client.query(`UPDATE edoc_packages SET sent_at = NOW() - INTERVAL '2 hours' WHERE id=$1`, [actId]);
  ok('remindPackages: 2 ч назад — пора', (await auto.remindPackages(salonId, 1)).some((x) => x.id === actId));

  // ── ручки дашборда и страницы пациента на настоящих данных (тот же db транзакции) ──
  const jwt = require('jsonwebtoken');
  const config = require('../config');
  for (const m of ['../routes/edocs-board', '../services/edocs/board']) delete require.cache[require.resolve(m)];
  const router = require('../routes/edocs-board');
  const token = jwt.sign({ role: 'owner', salonId, userId: u.id }, config.JWT_SECRET);
  const call = (url) => new Promise((resolve) => {
    const [pathPart, qs] = url.split('?');
    const query = Object.fromEntries(new URLSearchParams(qs || ''));
    const res = { statusCode: 200, status(c) { this.statusCode = c; return this; }, json(b) { resolve({ status: this.statusCode, body: b }); return this; } };
    router.handle({ method: 'GET', url, path: pathPart, query, headers: { authorization: `Bearer ${token}`, host: 'dev' }, protocol: 'https', get: () => 'dev' }, res,
      () => resolve({ status: 404, body: null }));
  });
  const week = await call('/board?range=week');
  ok('GET /board?range=week на настоящих записях: карточки, сводка, счётчики периодов', week.status === 200 && Array.isArray(week.body.cards)
    && week.body.summary.total === week.body.cards.length && typeof week.body.rangeCounts.open === 'number', week.status === 200 ? week.body.rangeCounts : week.body);
  ok('карточки: цвет, подпись, плитки трёх видов', week.body.cards.every((c) => ['red', 'amber', 'blue', 'green', 'grey'].includes(c.color) && c.label
    && c.tiles.contract && c.tiles.consent_pd && c.tiles.act));
  console.log(`    неделя: ${JSON.stringify(week.body.summary)}; периоды: ${JSON.stringify(week.body.rangeCounts)}`);
  const open = await call('/board?range=open');
  ok('GET /board?range=open: только не зелёные', open.status === 200 && open.body.cards.every((c) => c.color !== 'green' && c.color !== 'grey'));
  const pg = await call(`/clients/${cid}/page?record=${rec.id}`);
  ok('GET /clients/:id/page: шапка, шаги, данные, визиты, фокус на визите из адреса, без шифротекста', pg.status === 200 && pg.body.header && pg.body.header.steps.length === 4
    && Array.isArray(pg.body.visits) && pg.body.focusRecordId === rec.id && !JSON.stringify(pg.body).includes('secure_enc'), pg.status === 200 ? pg.body.header : pg.body);
  const base = await call('/board/clients?filter=no_contract&page=1');
  ok('GET /board/clients', base.status === 200 && Array.isArray(base.body.rows) && base.body.total >= base.body.rows.length);

  if (explain) {
    const show = async (label, sql, params) => {
      const r = await client.query(`EXPLAIN (ANALYZE, BUFFERS) ${sql}`, params);
      const lines = r.rows.map((x) => x['QUERY PLAN']);
      console.log(`\n── EXPLAIN ${label}\n${lines.join('\n')}`);
    };
    await show('доска (окно −30…+6 дней)', bs.BOARD_RECORDS_SQL, [salonId, await shift(today, -30), await shift(today, 6)]);
    await show('кандидаты «перед визитом»', auto.PREVISIT_SQL, [salonId, nowIso, new Date(Date.now() + 86400000).toISOString(), true]);
    await show('кандидаты «акт»', auto.ACT_SQL, [salonId, await shift(today, -3), 15]);
  }
}

async function main() {
  require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
  if (!/loyalpro_test/.test(process.env.DATABASE_URL || '') && !process.argv.includes('--allow-any-db')) {
    console.error('Не дев-БД (нет loyalpro_test в DATABASE_URL) — остановка. Флаг --allow-any-db снимает защиту.');
    process.exit(2);
  }
  const { EDOCS_BOARD_DDL } = require('../migrations');
  const { pool } = require('../db');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL lock_timeout = '5s'");
    for (const sql of EDOCS_BOARD_DDL) await client.query(sql.replace(REF_RE, ''));
    console.log(`миграция применена во временной транзакции: ${EDOCS_BOARD_DDL.length} операторов`);
    await run(client, { explain: process.argv.includes('--explain') });
    console.log('SQL дашборда «Документов» в порядке (транзакция откатывается)');
  } finally {
    await client.query('ROLLBACK').catch(() => {});
    client.release();
    await pool.end();
  }
}

if (require.main === module) main().catch((e) => { console.error(`ОШИБКА: ${e.message}`); process.exit(1); });
module.exports = { run };
```

- [ ] **Step 2: Прогон**

```bash
cd backend && node scripts/edocs-board-smoke.js > /tmp/edocs-board-smoke.txt 2>&1; grep -c "^ok " /tmp/edocs-board-smoke.txt; grep -E "неделя|в порядке|ОШИБКА" /tmp/edocs-board-smoke.txt
```

Ожидается: `52` (проверок `ok  …`), сводка недели вида `неделя: {"total":69,"red":14,"amber":55,…}; периоды: {"today":20,…}` (числа зависят от записей дева на сегодня) и строка `SQL дашборда «Документов» в порядке (транзакция откатывается)`; строки `ОШИБКА` нет.

- [ ] **Step 3: Планы запросов**

```bash
cd backend && node scripts/edocs-board-smoke.js --explain 2>&1 | grep -E "^── EXPLAIN|Execution Time"
```

Ожидается: три блока — `── EXPLAIN доска (окно −30…+6 дней)`, `── EXPLAIN кандидаты «перед визитом»`, `── EXPLAIN кандидаты «акт»` — каждый со строкой `Execution Time`, ни один не дольше 50 ms (в прогоне плана — 10, 1 и 1 ms).

- [ ] **Step 4: Коммит**

```bash
git add backend/scripts/edocs-board-smoke.js
git commit -m "test(edocs): живая проверка SQL и ручек дашборда на дев-БД в откатываемой транзакции" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

### Task 13: Контрольная точка A — **основная сессия**

Ревью бэкенда целиком и сравнение полного jest с базой `c054ab7` (известные падения чужих наборов не должны прибавиться). `primary-clients.test.js` исключается — известный флейк, роняющий соседние наборы (память проекта). Во временной копии базы лежит лишь отслеживаемая часть `node_modules` (так исторически в репозитории) — её заменяет ссылка на полный `node_modules` рабочей копии.

- [ ] **Step 1: Полный jest на ветке**

```bash
cd backend && npx jest --testPathIgnorePatterns primary-clients 2>&1 | grep -E "^FAIL|^(Tests|Test Suites):" | sort -u > /tmp/edocs-board-jest-after.txt; tail -2 /tmp/edocs-board-jest-after.txt
```

Ожидается: `Tests: 2 failed, 5149 passed, 5151 total` и `Test Suites: 11 failed, 210 passed, 221 total` — 11 давно падающих чужих наборов (`agent-booking`, `agent-tool-memory`, `patient-portfolio-pipeline`, `equipment`, `service-filter`, `cert-consent`, `cert-request`, `knowledge-base`, три `medical-cert-*`), список — в файле.

- [ ] **Step 2: Полный jest на базе и сравнение**

```bash
git worktree add /tmp/edocs-board-base c054ab7 && rm -rf /tmp/edocs-board-base/backend/node_modules && ln -s /root/loyalpro-edocs-board/backend/node_modules /tmp/edocs-board-base/backend/node_modules && cp backend/.env /tmp/edocs-board-base/backend/.env && (cd /tmp/edocs-board-base/backend && npx jest --testPathIgnorePatterns primary-clients 2>&1 | grep -E "^FAIL|^(Tests|Test Suites):" | sort -u > /tmp/edocs-board-jest-base.txt); diff <(grep ^FAIL /tmp/edocs-board-jest-base.txt) <(grep ^FAIL /tmp/edocs-board-jest-after.txt) && echo same-fails; git worktree remove --force /tmp/edocs-board-base
```

Ожидается: `same-fails` — набор падающих наборов тот же, что на базе.

- [ ] **Step 3: Ревью диффа бэкенда**

`git diff c054ab7 -- backend` по списку: каждый SQL ограничен `salon_id`; действие автоматики застолблено ДО выполнения и неудача пишется в журнал; ПДн и токен анкеты не попадают ни в логи, ни в события; все отправки пациентам проходят `test-phones` (комплект, повтор ссылки, анкета в мессенджер); публичные ручки — только то, что описано в спеке §6.4, ответы не раскрывают данных пациента; `db.one` трактуется как `oneOrNone` (CLAUDE.md). Найденное — исправить отдельным коммитом и прогнать тесты задач 2–12.

## Часть B. Фронт

### Task 14: Фронт: оболочка раздела, дашборд, страница пациента — **Opus**

Спека §4, §5, §12. Все `<script>` `index.html` делят ОДНУ глобальную область (тест грузит их одним `vm`), поэтому имена — с префиксами `ed`/`edb`/`edc`/`ED_`; повторное объявление верхнеуровневого `const` — SyntaxError, гасящий весь файл.
- `edocs-helpers.js` — справочники подписей (события журнала, виды, периоды, чипы, мессенджеры), адреса `#edocs/…` (`edParseTail`/`edTailOf`: дашборд и периоды, страница пациента `c/<пациент>[/<запись>]`, все комплекты, комплект, настройки; старые адреса мастера `new/<пациент>[/<запись>]` ведут на страницу пациента), чистые помощники дашборда (фильтр карточек, изменения между опросами для тоста и вспышки, «Повторить» через 15 минут, итоги акта).
- `edocs.js` переписан: оболочка (вкладки «Дашборд / Все комплекты / Настройки», hash-роутер, общий опрос `_ed.timer`, окно подтверждения `edConfirm`), список и карточка комплекта (у бумажного — «Скан» и «Снять отметку» вместо F.Doc), «Мой F.Doc», настройки и окно «Автоматизация» (с нумерацией договоров), встройки в карточку клиента и «Записи» — они ведут на страницу пациента. Мастер «Оформить» уходит.
- `edocs-board.js` — дашборд: сводка с кольцом, периоды со счётчиками (в hash, F5 сохраняет), поиск, чипы, строка автоматики, группы карточек, вспышка позеленевшей карточки и тост; опрос раз в 20 с только при видимой странице; «Вся база» — серверный поиск и страницы. Кнопки, которым нужен F.Doc, заменяются на «Открыть», если отправка сейчас невозможна (модуль выключен, нет своей учётки).
- `edocs-client.js` — страница пациента: шапка с шагами; блок данных (свёрнут; красный с пульсацией, пока не хватает полей; раскрытие расшифровывает данные существующей ручкой с записью в журнал); карточки документов с выбором и правкой (акт — строки и итог с предупреждением о расхождении с YClients, договор — номер и даты); липкая панель отправки (в одном комплекте — не больше одного акта); визиты и акты; история; окна «Подписано на бумаге» и «Анкета пациента» (ссылка, QR, мессенджер). Ответа на отправку нет (сеть, 502) — «комплект мог уйти», выбор не сбрасывается вслепую, страница перечитывается; второй клик второй комплект не шлёт. Опрос раз в 10 с, пока что-то ждёт подписи или анкеты.
- `index.html` — вкладки, контейнеры видов, шесть окон, скрипты и стили с новым `?v=` (без бампа браузеры держат старые файлы — nginx кэширует).

**Files:**
- Create: `frontend/js/pages/edocs-board.js`, `frontend/js/pages/edocs-client.js`
- Modify: `frontend/js/pages/edocs-helpers.js`, `frontend/js/pages/edocs.js` (целиком), `frontend/index.html`
- Test: `frontend/js/pages/edocs.test.js`

- [ ] **Step 1: Падающий тест**

Заменить `frontend/js/pages/edocs.test.js` целиком:

```js
// «📄 Документы» (edocs-helpers.js + edocs.js): общая глобальная область, чистые помощники,
// разметка ↔ скрипт, паритет справочников с бэкендом.
// Запуск: node --test frontend/js/pages/edocs.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const FRONT = path.join(__dirname, '..', '..');
const BACK = path.join(__dirname, '..', '..', '..', 'backend');

function browserContext(extra = {}) {
  const ctx = vm.createContext({ console, URLSearchParams, localStorage: { getItem: () => null, setItem() {}, removeItem() {} }, ...extra });
  ctx.window = ctx;
  return ctx;
}
function run(ctx, file, src) { vm.runInContext(src !== undefined ? src : fs.readFileSync(file, 'utf8'), ctx, { filename: file }); }
const plain = (x) => JSON.parse(JSON.stringify(x));

const ctx = browserContext();
const ED_FILES = ['js/core/utils.js', 'js/core/api.js', 'js/pages/edocs-helpers.js', 'js/pages/edocs.js', 'js/pages/edocs-board.js', 'js/pages/edocs-client.js'];
for (const f of ED_FILES) run(ctx, f, fs.readFileSync(path.join(FRONT, f), 'utf8'));
const k = (name) => vm.runInContext(name, ctx);
const ED_PAGE_SRC = ['edocs.js', 'edocs-board.js', 'edocs-client.js'].map((f) => fs.readFileSync(path.join(__dirname, f), 'utf8')).join('\n');

test('помощники, роутер, дашборд и страница пациента грузятся в одну область с core', () => {
  for (const name of ['loadEdocs', 'edocsOnHashArg', 'edGo', 'edStopPolling', 'edRenderClientBlock', 'edDecorateRecords', 'edParseTail', 'edTailOf', 'edActTotals', 'edOpenMe',
    'edbRender', 'edbRefresh', 'edcRender', 'edcRefresh', 'edFormOpen', 'edConfirm', 'edOpenAutomation', 'edFilterCards', 'edBoardChanges']) {
    assert.strictEqual(typeof ctx[name], 'function', `${name} не определена`);
  }
});

test('edParseTail и edTailOf: адреса страницы, старые адреса мастера', () => {
  const id = '11111111-1111-4111-8111-111111111111';
  const t = (x) => plain(k('edParseTail')(x));
  assert.deepStrictEqual(t(''), { view: 'board', range: 'today' });
  assert.deepStrictEqual(t('r/week'), { view: 'board', range: 'week' });
  assert.deepStrictEqual(t('r/open'), { view: 'board', range: 'open' });
  assert.deepStrictEqual(t('r/all'), { view: 'board', range: 'all' });
  assert.deepStrictEqual(t('r/year'), { view: 'board', range: 'today' });
  assert.deepStrictEqual(t('settings'), { view: 'settings' });
  assert.deepStrictEqual(t('packages'), { view: 'list' });
  assert.deepStrictEqual(t('c/52'), { view: 'client', clientId: 52, recordId: null });
  assert.deepStrictEqual(t('c/52/30252'), { view: 'client', clientId: 52, recordId: 30252 });
  assert.deepStrictEqual(t('c/abc'), { view: 'board', range: 'today' });
  assert.deepStrictEqual(t('new'), { view: 'board', range: 'all' });
  assert.deepStrictEqual(t('new/52/30252'), { view: 'client', clientId: 52, recordId: 30252, legacy: true });
  assert.deepStrictEqual(t('p/' + id.toUpperCase()), { view: 'package', packageId: id });
  assert.deepStrictEqual(t('p/123'), { view: 'board', range: 'today' });
  assert.deepStrictEqual(t('garbage'), { view: 'board', range: 'today' });
  for (const tail of ['', 'r/week', 'c/52', 'c/52/30252', 'packages', 'settings', 'p/' + id]) assert.strictEqual(k('edTailOf')(k('edParseTail')(tail)), tail);
});

test('дашборд: фильтр карточек, изменения между опросами, подписи дней, «Повторить» через 15 минут', () => {
  const cards = [
    { key: '1:d', name: 'Иванова Анна', phone: '+79200255591', color: 'red', tags: ['no_contract'], docs: { contract: { state: 'missing' }, consent_pd: { state: 'signed' }, act: { state: 'later' } } },
    { key: '2:d', name: 'Петрова Ольга', phone: '+79001112233', color: 'blue', tags: ['waiting'], docs: { contract: { state: 'pending' }, consent_pd: { state: 'pending' }, act: { state: 'later' } } },
  ];
  const f = (chip, color, q) => k('edFilterCards')(cards, chip, color, q).map((c) => c.key);
  assert.deepStrictEqual(f('', '', ''), ['1:d', '2:d']);
  assert.deepStrictEqual(f('waiting', '', ''), ['2:d']);
  assert.deepStrictEqual(f('', 'red', ''), ['1:d']);
  assert.deepStrictEqual(f('', '', 'петр'), ['2:d']);
  assert.deepStrictEqual(f('', '', '0255'), ['1:d']);
  const snap = k('edBoardSnapshot')(cards);
  assert.deepStrictEqual(plain(k('edBoardChanges')(null, cards)), []);
  const next = [cards[0], { ...cards[1], color: 'green', docs: { contract: { state: 'signed' }, consent_pd: { state: 'signed' }, act: { state: 'later' } } }];
  assert.deepStrictEqual(plain(k('edBoardChanges')(snap, next)), [{ key: '2:d', text: 'Петрова Ольга: подписаны договор, согласие пд' }]);
  assert.strictEqual(k('edDayLabel')('2026-10-25', '2026-10-25'), 'Сегодня');
  assert.strictEqual(k('edDayLabel')('2026-10-26', '2026-10-25'), 'Завтра');
  assert.strictEqual(k('edDayLabel')('2026-10-24', '2026-10-25'), 'Вчера');
  assert.strictEqual(k('edDayLabel')('2026-10-27', '2026-10-25'), 'вт, 27.10');
  assert.strictEqual(k('edRemindReady')({ availableAt: '2026-10-25T10:05:00Z' }, Date.parse('2026-10-25T10:04:00Z')), false);
  assert.strictEqual(k('edRemindReady')({ availableAt: '2026-10-25T10:05:00Z' }, Date.parse('2026-10-25T10:06:00Z')), true);
  assert.strictEqual(k('edRemindReady')(null), true);
  assert.deepStrictEqual([1, 2, 5, 11, 21, 22].map((n) => k('edPlural')(n, 'поле', 'поля', 'полей')), ['поле', 'поля', 'полей', 'полей', 'поле', 'поля']);
});

test('edMissingText', () => {
  assert.strictEqual(k('edMissingText')({ identity: [{ key: 'phone', label: 'Телефон' }, { key: 'passport_number', label: 'Номер паспорта' }], org: [{ key: 'inn', label: 'ИНН' }] }),
    'Не хватает данных пациента: Телефон, Номер паспорта. Не заполнены реквизиты клиники: ИНН');
  assert.strictEqual(k('edMissingText')({ identity: [], org: [] }), '');
  assert.strictEqual(k('edMissingText')(null), '');
});

test('edActTotals и edCollectActLines — как на сервере', () => {
  const rows = [
    { include: true, title: ' Чистка ', qty: '1', price: '17 500', sum: '15750', service_id: 5 },
    { include: false, title: 'Пилинг', qty: 1, price: 6000, sum: 6000 },
    { include: true, title: 'Ботокс', qty: '2', price: '8000,50', sum: 16001 },
  ];
  assert.deepStrictEqual(plain(k('edActTotals')(rows.filter((r) => r.include))), { total: 31751, discount: 1750 });
  assert.deepStrictEqual(plain(k('edCollectActLines')(rows)), { value: [
    { service_id: 5, title: 'Чистка', qty: 1, price: 17500, sum: 15750 },
    { service_id: null, title: 'Ботокс', qty: 2, price: 8000.5, sum: 16001 },
  ] });
  assert.match(k('edCollectActLines')([{ include: true, title: '', qty: 1, price: 1, sum: 1 }]).error, /Строка 1/);
  assert.match(k('edCollectActLines')([{ include: true, title: 'x', qty: 0, price: 1, sum: 1 }]).error, /количество/);
  assert.match(k('edCollectActLines')([{ include: false, title: 'x', qty: 1, price: 1, sum: 1 }]).error, /хотя бы одну/);
});

test('edIdentityBody собирает открытую и паспортную части', () => {
  const vals = { last_name: ' Иванова ', passport_series: '4510', address: 'Москва' };
  const body = plain(k('edIdentityBody')((key) => vals[key], 'recognize'));
  assert.strictEqual(body.last_name, 'Иванова');
  assert.strictEqual(body.secure.passport_series, '4510');
  assert.strictEqual(body.secure.address, 'Москва');
  assert.strictEqual(body.first_name, '');
  assert.strictEqual(body.source, 'recognize');
});

test('форматы: дата, деньги, телефон', () => {
  assert.strictEqual(k('edFmtDate')('2026-10-24'), '24.10.2026');
  assert.strictEqual(k('edFmtDate')(null), '—');
  assert.strictEqual(k('edPhone')('79001234567'), '+7 (900) 123-45-67');
  assert.match(k('edMoney')(12345.5), /^12\s345,50 ₽$/);
  assert.strictEqual(k('edStatusInfo')('signed').cls, 'bg');
  assert.strictEqual(k('edIsFinal')('annulled'), true);
  assert.strictEqual(k('edIsFinal')('sent'), false);
});

// ── все скрипты index.html одной областью ──
function indexScripts() {
  const html = fs.readFileSync(path.join(FRONT, 'index.html'), 'utf8');
  const out = [];
  const re = /<script\b([^>]*)>([\s\S]*?)<\/script>/g;
  let m;
  while ((m = re.exec(html))) {
    const src = /\bsrc="([^"]+)"/.exec(m[1]);
    if (src) {
      if (/^https?:|^\/\//.test(src[1]) || src[1].startsWith('vendor/')) continue;
      out.push({ name: src[1].replace(/\?.*$/, ''), code: fs.readFileSync(path.join(FRONT, src[1].replace(/\?.*$/, '')), 'utf8') });
    } else if (m[2].trim()) out.push({ name: 'index.html (inline)', code: m[2] });
  }
  return out;
}

test('все скрипты index.html грузятся в одну область без SyntaxError; edocs подключён после помощников', () => {
  const scripts = indexScripts();
  const names = scripts.map((s) => s.name);
  assert.ok(names.indexOf('js/pages/edocs-helpers.js') >= 0 && names.indexOf('js/pages/edocs.js') > names.indexOf('js/pages/edocs-helpers.js'));
  for (const f of ['js/pages/edocs-board.js', 'js/pages/edocs-client.js']) assert.ok(names.indexOf(f) > names.indexOf('js/pages/edocs-helpers.js'), f + ' не подключён');
  const all = browserContext();
  const bad = [];
  for (const s of scripts) { try { run(all, s.name, s.code); } catch (e) { if (e && e.name === 'SyntaxError') bad.push(`${s.name}: ${e.message}`); } }
  assert.deepStrictEqual(bad, []);
});

test('id разметки: каждый getElementById страницы есть в index.html или рисуется скриптом', () => {
  const html = fs.readFileSync(path.join(FRONT, 'index.html'), 'utf8');
  const src = ED_PAGE_SRC;
  const ids = new Set([...src.matchAll(/getElementById\('([A-Za-z0-9_-]+)'\)/g)].map((m) => m[1]));
  // Есть в разметке index.html или написан литералом id="…" в самом скрипте (рисует скрипт).
  const missing = [...ids].filter((id) => !html.includes(`id="${id}"`) && !src.includes(`id="${id}"`));
  assert.ok(ids.size >= 15, `getElementById не нашлись (${ids.size}) — регулярка устарела`);
  assert.deepStrictEqual(missing, []);
});

test('инлайн-обработчики edocs.js и разметки страницы ссылаются на существующие функции', () => {
  const html = fs.readFileSync(path.join(FRONT, 'index.html'), 'utf8');
  const from = html.indexOf('id="page-edocs"');
  const region = html.slice(from, html.indexOf('id="page-economics"', from)) + html.slice(html.indexOf('id="edMeModal"'), html.indexOf('id="notif"'));
  const script = ED_PAGE_SRC;
  const re = /on(?:click|change|input|toggle)=\\?"(?:if\(event\.target===this\))?(?:event\.(?:preventDefault|stopPropagation)\(\);)?([A-Za-z_]+)\(/g;
  const called = new Set([...region.matchAll(re), ...script.matchAll(re)].map((m) => m[1]));
  assert.ok(called.size >= 25, `обработчики не нашлись (${called.size}) — регулярка устарела`);
  const builtin = new Set(['closeModal', 'openModal']);
  const missing = [...called].filter((n) => !builtin.has(n) && typeof ctx[n] !== 'function');
  assert.deepStrictEqual(missing, []);
});

test('паритет справочников фронта с бэкендом', () => {
  const ph = require(path.join(BACK, 'services/edocs/placeholders.js'));
  const st = require(path.join(BACK, 'services/edocs/statuses.js'));
  const id = require(path.join(BACK, 'services/edocs/identity.js'));
  assert.deepStrictEqual(Object.keys(plain(k('ED_KIND_LABELS'))), ph.KINDS);
  assert.deepStrictEqual(plain(k('ED_ORG_FIELDS')).map((f) => f[0]), ph.ORG_KEYS);
  assert.deepStrictEqual(Object.keys(plain(k('ED_STATUS'))).sort(), [...st.STATUSES].sort());
  assert.deepStrictEqual(plain(k('ED_PLAIN_FIELDS')).map((f) => f[0]), id.PLAIN_KEYS);
  assert.deepStrictEqual(plain(k('ED_SECURE_FIELDS')).map((f) => f[0]).sort(), [...id.SECURE_KEYS].sort());
  // форма страницы пациента — ровно те же поля данных, что сохраняет сервер
  assert.deepStrictEqual(plain(k('EDC_FIELDS')).map((f) => f[0]).sort(), [...id.PLAIN_KEYS, ...id.SECURE_KEYS].sort());
  const board = require(path.join(BACK, 'services/edocs/board.js'));
  assert.deepStrictEqual(Object.keys(plain(k('ED_KIND_SHORT'))), board.KINDS);
});

// ── поведение страницы: заглушка DOM, location.hash, fetch и таймеры ──
// Элементы создаются по id при первом обращении; setInterval считается, а не запускается.
function pageContext({ fetch, confirm = () => true, hash = '#edocs' } = {}) {
  const els = new Map();
  const el = (id) => {
    if (!els.has(id)) {
      const cls = new Set();
      els.set(id, { id, style: {}, dataset: {}, value: '', textContent: '', innerHTML: '', disabled: false, checked: false, focus() {},
        classList: { add: (c) => cls.add(c), remove: (c) => cls.delete(c), contains: (c) => cls.has(c),
          toggle: (c, on) => ((on === undefined ? !cls.has(c) : on) ? cls.add(c) : cls.delete(c)) } });
    }
    return els.get(id);
  };
  const st = { hash, live: new Set(), timerSeq: 0, fetches: [], modals: [] };
  const ctx = browserContext({
    document: { getElementById: el, body: { dataset: {} }, querySelectorAll: () => [],
      createElement: () => ({ set textContent(v) { this.t = String(v); }, get innerHTML() { return this.t; } }) },
    location: { get hash() { return st.hash; }, set hash(v) { st.hash = String(v).startsWith('#') ? String(v) : '#' + v; } },
    history: { replaceState: (_a, _b, u) => { st.hash = u; } },
    setTimeout: (f, ms) => { const t = setTimeout(f, ms); if (t.unref) t.unref(); return t; }, clearTimeout,
    setInterval: () => { st.live.add(++st.timerSeq); return st.timerSeq; },
    clearInterval: (id) => { st.live.delete(id); },
    fetch: (url, o) => { st.fetches.push(url); return fetch(url, o); },
    confirm: () => confirm(),
    openModal: (id) => st.modals.push(id), closeModal() {},
  });
  for (const f of ED_FILES) run(ctx, f, fs.readFileSync(path.join(FRONT, f), 'utf8'));
  return { st, el, run: (code) => vm.runInContext(code, ctx), k: (name) => vm.runInContext(name, ctx) };
}
const res = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) });
const settle = () => new Promise((r) => setTimeout(r, 20));
const PID = '22222222-2222-4222-8222-222222222222';
const STATE = { enabled: true, configured: true, encReady: true, me: { connected: true, broken: false, login: 'admin' } };
// Страница пациента с готовым ответом /page и выбранным договором (id 10). Окно подтверждения в тестах
// отвечает «да» само: edConfirm — обычная глобальная функция, её можно подменить в контексте.
const PAGE = { client: { id: 52, name: 'Тестова Анна', phone: '79001234567', initials: 'ТА' }, today: '2026-10-25',
  header: { color: 'red', label: 'Нужно до визита', day: '2026-10-25', time: '10:40', services: ['Чистка'], staffName: 'Врач', firstVisit: true,
    steps: [{ key: 'data', tone: 'ok' }, { key: 'contract', tone: 'no' }, { key: 'consent_pd', tone: 'ok' }, { key: 'act', tone: 'none' }] },
  data: { exists: true, complete: true, missing: [], required: ['last_name', 'first_name', 'phone'] },
  docs: { contract: { state: 'missing', tile: { text: 'нет', tone: 'no' } }, consent_pd: { state: 'signed', at: '2026-07-03T09:00:00Z', tile: { text: '✓ 03.07', tone: 'ok' } } },
  visits: [], focusRecordId: null, form: null, warnings: [], kinds: { contract: { id: 10, title: 'Договор' }, consent_pd: { id: 11, title: 'Согласие' }, act: null },
  numbering: { auto: true, contractNo: null, yclientsNo: null, next: 1999 }, actsRequiredFrom: '2026-10-01', module: { enabled: true, configured: true, encReady: true, me: { connected: true, broken: false } },
  identity: { exists: true }, templates: [{ id: 10, kind: 'contract', title: 'Договор', placeholders: ['fio'] }, { id: 11, kind: 'consent_pd', title: 'Согласие', placeholders: ['fio'] }],
  packages: [], events: [] };
const CLIENT_PAGE = `edConfirm = async () => true; _ed.state = ${JSON.stringify({ enabled: true, configured: true, encReady: true, me: { connected: true, broken: false, login: 'admin' } })};
  _ed.route = { view: 'client', clientId: 52, recordId: null }; location.hash = '#edocs/c/52';
  _edc = { clientId: 52, recordId: null, page: ${JSON.stringify(PAGE)}, form: null, formLoaded: false, unsaved: false, source: 'manual', notes: [],
    selected: new Set([10]), act: null, actEdited: false, docDate: '', missingSel: { identity: [], org: [] }, checking: false };`;
const pageFetch = (handler) => async (url, o) => (/\/clients\/52\/page/.test(url) ? res(200, PAGE) : /packages\/check/.test(url) ? res(200, { missing: { identity: [], org: [] } }) : handler(url, o));

test('страница пациента: packageId вместе с ошибкой учётки — карточка комплекта, «Мой F.Doc» поверх, кнопка не включается', async () => {
  const p = pageContext({ fetch: pageFetch(async () => res(409, { error: 'F.Doc не принял логин или пароль — обновите их в «Мой F.Doc»', code: 'fdoc_credentials_invalid', packageId: PID })) });
  p.run(CLIENT_PAGE);
  await p.k('edcSend')();
  assert.strictEqual(p.st.hash, '#edocs/p/' + PID);
  assert.deepStrictEqual(p.st.modals, ['edMeModal']);
  assert.match(p.el('notif').textContent, /не принял логин или пароль/);
  assert.deepStrictEqual(p.st.fetches, ['/api/edocs/packages']);   // ни второй отправки, ни перечитывания
  assert.strictEqual(p.k('_ed').sending, false);
});

test('страница пациента: ответа нет (сеть, 502 прокси) — «комплект мог уйти», выбор не сбрасывается вслепую, страница перечитывается', async () => {
  const proxy502 = async () => ({ ok: false, status: 502, json: async () => { throw new SyntaxError('Unexpected token <'); } });
  for (const send of [() => Promise.reject(new TypeError('Failed to fetch')), proxy502]) {
    const p = pageContext({ fetch: pageFetch(send) });
    p.run(CLIENT_PAGE);
    await p.k('edcSend')();
    await settle();
    assert.strictEqual(p.st.hash, '#edocs/c/52');
    assert.match(p.el('notif').textContent, /комплект мог уйти/);
    assert.strictEqual(p.st.fetches.filter((u) => u === '/api/edocs/packages').length, 1);
    assert.ok(p.st.fetches.some((u) => /\/clients\/52\/page/.test(u)), 'страница не перечитана');
  }
});

test('страница пациента: пока идёт отправка, выбор документа кнопку не включает; второй клик не шлёт второй комплект', async () => {
  let release;
  const p = pageContext({ fetch: pageFetch((url) => (url === '/api/edocs/packages'
    ? new Promise((r) => { release = () => r(res(400, { error: 'Шаблон не прошёл проверку' })); }) : Promise.resolve(res(200, {})))) });
  p.run(CLIENT_PAGE);
  const sending = p.k('edcSend')();
  await settle();
  assert.strictEqual(p.k('_ed').sending, true);
  p.k('edcToggle')(11);
  await settle();
  assert.match(p.el('edcSend').innerHTML, /id="edcSendBtn" onclick="edcSend\(\)" disabled>Отправляем…</);
  await p.k('edcSend')();   // второй клик во время отправки
  release();
  await sending;
  await settle();
  assert.strictEqual(p.k('_ed').sending, false);
  assert.strictEqual(p.st.fetches.filter((u) => u === '/api/edocs/packages').length, 1);
  assert.match(p.el('notif').textContent, /Шаблон не прошёл проверку/);
  assert.doesNotMatch(p.el('edcSend').innerHTML, /Отправляем…/);
});

test('страница пациента: тело отправки — выбранные шаблоны, дата документа; нехватка данных блокирует кнопку', async () => {
  let body;
  const p = pageContext({ fetch: pageFetch(async (url, o) => { body = JSON.parse(o.body); return res(200, { packageId: PID }); }) });
  p.run(CLIENT_PAGE + " _edc.docDate = '2026-10-24';");
  await p.k('edcSend')();
  assert.deepStrictEqual(body, { clientId: 52, templateIds: [10], docDate: '2026-10-24' });
  assert.match(p.el('notif').textContent, /отправлены пациенту/);
  p.run("_edc.missingSel = { identity: [{ key: 'passport_number', label: 'Номер паспорта' }], org: [] }; _edc.selected = new Set([10]); edcSendRender();");
  assert.match(p.el('edcSend').innerHTML, /Не хватает данных пациента: Номер паспорта/);
  assert.match(p.el('edcSend').innerHTML, /id="edcSendBtn" onclick="edcSend\(\)" disabled>/);
});

test('старый адрес мастера #edocs/new/52/30252 переписывается на страницу пациента', async () => {
  const p = pageContext({ hash: '#edocs/new/52/30252', fetch: async (url) => res(200, /state$/.test(url) ? STATE
    : /\/page/.test(url) ? { ...PAGE, focusRecordId: null } : {}) });
  p.run("edRoute('new/52/30252')");
  await settle();
  assert.strictEqual(p.st.hash, '#edocs/c/52/30252');
  assert.deepStrictEqual(plain(p.k('_ed').route), { view: 'client', clientId: 52, recordId: 30252 });
  assert.ok(p.st.fetches.some((u) => u === '/api/edocs/clients/52/page?record=30252'));
});

const BOARD = { now: '2026-10-25T07:00:00Z', today: '2026-10-25', range: 'today', rangeCounts: { today: 2, tomorrow: 0, week: 2, open: 0 },
  summary: { total: 2, red: 1, amber: 0, blue: 0, green: 1, grey: 0 }, chips: { all: 2, no_contract: 1, no_consent: 0, act: 0, waiting: 0, ready: 1 },
  cards: [
    { key: '52:2026-10-25', clientId: 52, name: 'Тестова Анна', initials: 'ТА', phone: '79001234567', day: '2026-10-25', time: '10:40', services: ['Чистка'], staffName: 'Врач',
      visits: [{ recordId: 100 }], color: 'red', label: 'Нужно до визита', tags: ['no_contract'], warnings: ['⏱ Первичный · через 40 мин'], hint: 'Данные полные',
      tiles: { contract: { text: 'нет', tone: 'no' }, consent_pd: { text: '✓ 03.07', tone: 'ok' }, act: { text: 'после визита', tone: 'na' } },
      docs: { contract: { state: 'missing' }, consent_pd: { state: 'signed' }, act: { state: 'later' } }, action: { type: 'send', kinds: ['contract'], recordId: null, label: 'Отправить договор' } },
    { key: '53:2026-10-25', clientId: 53, name: 'Петрова Ольга', initials: 'ПО', phone: null, day: '2026-10-25', time: '12:00', services: [], staffName: '',
      visits: [{ recordId: 101 }], color: 'green', label: 'Документы готовы', tags: ['ready'], warnings: [], hint: 'Акт — после визита',
      tiles: { contract: { text: '✓ 2025', tone: 'ok' }, consent_pd: { text: '✓ 2025', tone: 'ok' }, act: { text: 'после визита', tone: 'na' } },
      docs: { contract: { state: 'signed' }, consent_pd: { state: 'signed' }, act: { state: 'later' } }, action: null },
  ],
  kinds: { contract: { id: 10, title: 'Договор' }, consent_pd: { id: 11, title: 'Согласие' }, act: null },
  module: { enabled: true, configured: true, encReady: true, me: { connected: true, broken: false } },
  automation: { previsit: { on: false, hours: 24, scope: 'first', form: true }, act: { on: false, delayMin: 15 }, remind: { on: false, hours: 2 }, senderName: null },
  warnings: [{ code: 'no_template', kind: 'act' }], actsRequiredFrom: '2026-10-01' };

test('дашборд: карточки по группам, цвет, плитки, кнопка действия; без F.Doc — «Открыть»; один опрос', async () => {
  const p = pageContext({ fetch: async (url) => res(200, /state$/.test(url) ? STATE : /\/board/.test(url) ? BOARD : {}) });
  p.run("loadEdocs(); edocsOnHashArg(null)");
  await settle();
  assert.deepStrictEqual(p.st.fetches, ['/api/edocs/state', '/api/edocs/board?range=today']);
  assert.strictEqual(p.st.live.size, 1);
  const html = p.el('edbCards').innerHTML;
  assert.match(html, /Требуют действия · 1[\s\S]*Готово · 1/);
  assert.match(html, /class="edb-card ed-c-red"/);
  assert.match(html, /<div class="edb-doc no"><b>Договор<\/b>нет<\/div>/);
  assert.match(html, /edbAct\('52:2026-10-25'\)">Отправить договор</);
  assert.match(p.el('edbWarns').innerHTML, /Не загружен шаблон «Акт оказанных услуг»/);
  assert.match(p.el('edbHead').innerHTML, /<span>1\/2<\/span>/);
  p.run("_ed.state = Object.assign({}, _ed.state, { me: { connected: false } }); edbCardsRender([])");
  assert.match(p.el('edbCards').innerHTML, />Открыть</);
  p.run("edbSetChip('ready')");
  assert.doesNotMatch(p.el('edbCards').innerHTML, /Тестова/);
  p.run('edStopPolling()');
  assert.strictEqual(p.st.live.size, 0);
});

test('дашборд: «Отправить договор» — подтверждение, тело запроса по шаблону вида, перечитывание', async () => {
  let body;
  const p = pageContext({ fetch: async (url, o) => {
    if (/state$/.test(url)) return res(200, STATE);
    if (/\/board/.test(url)) return res(200, BOARD);
    if (url === '/api/edocs/packages') { body = JSON.parse(o.body); return res(200, { packageId: PID }); }
    return res(200, {});
  } });
  p.run("loadEdocs()");
  await settle();
  p.run('edConfirm = async () => true');
  await p.k('edbAct')('52:2026-10-25');
  await settle();
  assert.deepStrictEqual(body, { clientId: 52, templateIds: [10], recordId: null });
  assert.strictEqual(p.st.fetches.filter((u) => /\/board/.test(u)).length, 2);
});

test('двойная загрузка: меню (loadEdocs + hashchange тем же хвостом) и «Назад» до конца загрузки — один опрос', async () => {
  const fetch = async (url) => res(200, /state$/.test(url) ? STATE : /\/board/.test(url) ? BOARD
    : url.includes('/packages/') ? { id: PID, title: 'Документы', status: 'sent', documents: [], events: [] } : { rows: [] });
  const p = pageContext({ fetch });
  p.run('loadEdocs(); edocsOnHashArg(null)');
  await settle();
  assert.strictEqual(p.st.live.size, 1);
  p.run(`edocsOnHashArg('p/${PID}'); edocsOnHashArg(null)`);   // карточка, и сразу «Назад» к дашборду
  await settle();
  assert.strictEqual(p.st.live.size, 1);
  assert.strictEqual(p.k('_ed').route.view, 'board');
  p.run("edRoute(''); edRoute('')");
  await settle();
  assert.strictEqual(p.st.live.size, 1);
  p.run("edGo('packages'); edocsOnHashArg('packages')");   // в браузере вторую половину делает hashchange
  await settle();
  assert.strictEqual(p.k('_ed').route.view, 'list');
  assert.strictEqual(p.st.live.size, 1);
  p.run('edStopPolling()');   // уход со страницы, выход
  assert.strictEqual(p.st.live.size, 0);
});

test('«Отправить ссылку ещё раз»: без подтверждения запроса нет; на время запроса кнопка заблокирована', async () => {
  let answer = false;
  let release;
  const p = pageContext({ confirm: () => answer, fetch: (url) => (url.endsWith('/permalink')
    ? new Promise((r) => { release = () => r(res(200, { ok: true })); })
    : Promise.resolve(res(200, { id: PID, title: 'Документы', status: 'sent', documents: [], events: [] }))) });
  const btn = { disabled: false };
  await p.k('edPkgAction')(PID, 'permalink', btn);
  assert.deepStrictEqual(p.st.fetches, []);
  answer = true;
  const first = p.k('edPkgAction')(PID, 'permalink', btn);
  await settle();
  assert.strictEqual(btn.disabled, true);
  await p.k('edPkgAction')(PID, 'permalink', btn);   // повторный клик, пока идёт запрос
  release();
  await first;
  assert.strictEqual(btn.disabled, false);
  assert.strictEqual(p.st.fetches.filter((u) => u.endsWith('/permalink')).length, 1);
});
test('встройки: карточка клиента и «Записи» зовут хуки «Документов», колонка «Акт» в таблице записей', () => {
  const clients = fs.readFileSync(path.join(__dirname, 'clients.js'), 'utf8');
  const records = fs.readFileSync(path.join(__dirname, 'records.js'), 'utf8');
  const html = fs.readFileSync(path.join(FRONT, 'index.html'), 'utf8');
  assert.match(clients, /<div id="edClientBlock_\$\{c\.id\}"><\/div>/);
  assert.match(clients, /typeof edRenderClientBlock === 'function'\) edRenderClientBlock\(c\.id\)/);
  assert.match(records, /class="r-act" data-rid="\$\{r\.id\}" data-cid="\$\{r\.client_id \|\| ''\}"/);
  assert.match(records, /typeof edDecorateRecords === 'function'\) edDecorateRecords\(d\.records\)/);
  assert.doesNotMatch(records, /colspan="9"/);
  assert.match(html, /<th>Статус<\/th><th>Источник<\/th><th><\/th><\/tr><\/thead>/);
  assert.match(html, /<td colspan="10" class="empty">Выберите период<\/td>/);
});
```

- [ ] **Step 2: Убедиться, что тест падает**

```bash
node --test frontend/js/pages/edocs.test.js 2>&1 | grep -E "ENOENT: no such file|^# (tests|pass|fail)"
```

Ожидается: `# Error: ENOENT: no such file or directory, open '…/frontend/js/pages/edocs-board.js'`, `# tests 1`, `# pass 0`, `# fail 1` — тест читает файлы страниц при загрузке.

- [ ] **Step 3: `edocs-helpers.js`: справочники и помощники дашборда**

Правка 1 из 3. В `frontend/js/pages/edocs-helpers.js` найти:

```js
  status: 'Статус изменился', webhook: 'Уведомление F.Doc', pdf: 'Подписанные PDF получены', permalink: 'Ссылка отправлена пациенту ещё раз',
  annul: 'Аннулирован',
};
const ED_ORG_FIELDS = [
```

заменить на:

```js
  status: 'Статус изменился', webhook: 'Уведомление F.Doc', pdf: 'Подписанные PDF получены', permalink: 'Ссылка отправлена пациенту ещё раз',
  annul: 'Аннулирован', paper: 'Отмечено: подписано на бумаге', paper_revoke: 'Отметка «на бумаге» снята',
  form_created: 'Создана анкета пациента', form_sent: 'Анкета отправлена пациенту', form_send_error: 'Анкета не доставлена',
  form_opened: 'Пациент открыл анкету', form_photo: 'Пациент распознал паспорт по фото', form_submitted: 'Пациент заполнил анкету',
  form_revoked: 'Анкета отозвана', form_expired: 'Срок анкеты истёк', form_docs_sent: 'Документы ушли после анкеты',
  form_docs_error: 'Документы после анкеты не ушли', contract_no: 'Присвоен номер договора', identity_edit: 'Данные пациента изменены',
  identity_view: 'Данные пациента просмотрены', identity_prefill: 'Данные подставлены из YClients', recognize: 'Паспорт распознан по фото',
  preview: 'Документ скачан для проверки', credentials: 'Учётная запись F.Doc',
};
// Дашборд и страница пациента (спека 2026-10-25): подписи видов, периодов, фильтров, мессенджеров.
const ED_KIND_SHORT = { contract: 'Договор', consent_pd: 'Согласие ПД', act: 'Акт' };
const ED_RANGES = [['today', 'Сегодня'], ['tomorrow', 'Завтра'], ['week', 'Неделя'], ['open', 'Незакрытые'], ['all', 'Вся база']];
const ED_CHIPS = [['', 'Все', 'all'], ['no_contract', 'Нет договора', 'no_contract'], ['no_consent', 'Нет согласия ПД', 'no_consent'],
  ['act', 'Акт не подписан', 'act'], ['waiting', 'Ждём подпись', 'waiting'], ['ready', 'Готово', 'ready']];
const ED_BASE_FILTERS = [['all', 'Все'], ['no_contract', 'Без договора'], ['no_consent', 'Без согласия'], ['open_acts', 'Незакрытые акты'], ['pending', 'Ждут подписи'], ['ready', 'Всё есть']];
const ED_COLOR_TITLE = { red: 'Срочно', amber: 'До визита', blue: 'Ждём подпись', green: 'Готово' };
const ED_VIA = { tdlib: 'Telegram', whatsapp: 'WhatsApp', max: 'MAX' };
const ED_ORG_FIELDS = [
```

Правка 2 из 3. В `frontend/js/pages/edocs-helpers.js` найти:

```js
function edIsFinal(status) { return ED_FINAL.indexOf(status) >= 0; }

/** Хвост адреса после «#edocs/» → что показать. */
function edParseTail(tail) {
  const parts = String(tail || '').split('/').filter(Boolean);
  if (!parts.length) return { view: 'list' };
  if (parts[0] === 'settings') return { view: 'settings' };
  if (parts[0] === 'p' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(parts[1] || '')) {
    return { view: 'package', packageId: parts[1].toLowerCase() };
  }
  if (parts[0] === 'new') {
    const clientId = /^\d{1,9}$/.test(parts[1] || '') ? Number(parts[1]) : null;
    const recordId = clientId && /^\d{1,9}$/.test(parts[2] || '') ? Number(parts[2]) : null;
    return { view: 'new', clientId, recordId };
  }
  return { view: 'list' };
}
```

заменить на:

```js
function edIsFinal(status) { return ED_FINAL.indexOf(status) >= 0; }

/**
 * Хвост адреса после «#edocs/» → что показать:
 *   '' — дашборд «Сегодня»; r/<tomorrow|week|open|all> — другой период; c/<пациент>[/<запись>] — страница
 *   пациента; packages — все комплекты; p/<uuid> — комплект; settings — настройки. Старые адреса мастера
 *   new/<пациент>[/<запись>] ведут на страницу пациента (legacy — переписать адрес), new — к поиску по базе.
 */
function edParseTail(tail) {
  const parts = String(tail || '').split('/').filter(Boolean);
  const board = (range) => ({ view: 'board', range });
  if (!parts.length) return board('today');
  if (parts[0] === 'r') return board(['tomorrow', 'week', 'open', 'all'].indexOf(parts[1]) >= 0 ? parts[1] : 'today');
  if (parts[0] === 'settings') return { view: 'settings' };
  if (parts[0] === 'packages') return { view: 'list' };
  if (parts[0] === 'p' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(parts[1] || '')) {
    return { view: 'package', packageId: parts[1].toLowerCase() };
  }
  if (parts[0] === 'c' || parts[0] === 'new') {
    const clientId = /^\d{1,9}$/.test(parts[1] || '') ? Number(parts[1]) : null;
    const recordId = clientId && /^\d{1,9}$/.test(parts[2] || '') ? Number(parts[2]) : null;
    if (!clientId) return board(parts[0] === 'new' ? 'all' : 'today');
    const r = { view: 'client', clientId, recordId };
    if (parts[0] === 'new') r.legacy = true;
    return r;
  }
  return board('today');
}
/** Адрес (хвост) маршрута — обратная операция к edParseTail. */
function edTailOf(route) {
  if (!route) return '';
  if (route.view === 'board') return route.range && route.range !== 'today' ? 'r/' + route.range : '';
  if (route.view === 'client') return 'c/' + route.clientId + (route.recordId ? '/' + route.recordId : '');
  if (route.view === 'package') return 'p/' + route.packageId;
  if (route.view === 'list') return 'packages';
  if (route.view === 'settings') return 'settings';
  return '';
}
```

Правка 3 из 3. В `frontend/js/pages/edocs-helpers.js` найти:

```js
  return body;
}
```

заменить на:

```js
  return body;
}

// ── дашборд и страница пациента ──
/** Карточки по фильтру-чипу (теги считает сервер), цвету плитки сводки и поиску по имени/телефону. */
function edFilterCards(cards, chip, color, search) {
  const q = String(search || '').trim().toLowerCase();
  const digits = q.replace(/\D/g, '');
  return (cards || []).filter((c) => {
    if (chip && (c.tags || []).indexOf(chip) < 0) return false;
    if (color && c.color !== color) return false;
    if (!q) return true;
    if (digits.length >= 3 && String(c.phone || '').replace(/\D/g, '').indexOf(digits) >= 0) return true;
    return String(c.name || '').toLowerCase().indexOf(q) >= 0;
  });
}
/** Снимок для сравнения между опросами: ключ карточки → цвет и состояния документов. */
function edBoardSnapshot(cards) {
  const m = {};
  for (const c of cards || []) m[c.key] = { color: c.color, contract: c.docs.contract.state, consent_pd: c.docs.consent_pd.state, act: c.docs.act.state, name: c.name };
  return m;
}
/**
 * Что изменилось с прошлого опроса — для всплывающего сообщения: подписанные документы и карточки,
 * ставшие зелёными. Первый опрос (prev = null) ничего не сообщает. @returns [{ key, text }]
 */
function edBoardChanges(prev, cards) {
  if (!prev) return [];
  const out = [];
  for (const c of cards || []) {
    const was = prev[c.key];
    if (!was) continue;
    const signed = ['contract', 'consent_pd', 'act'].filter((k) => c.docs[k].state === 'signed' && was[k] !== 'signed');
    if (signed.length) out.push({ key: c.key, text: c.name + ': подписан' + (signed.length > 1 ? 'ы ' : ' ') + signed.map((k) => ED_KIND_SHORT[k].toLowerCase()).join(', ') });
    else if (c.color === 'green' && was.color !== 'green') out.push({ key: c.key, text: c.name + ': документы готовы' });
  }
  return out;
}
/** «Сегодня» / «Завтра» / «Вчера» / «пн, 27.10» по дате 'YYYY-MM-DD' относительно today. */
function edDayLabel(day, today) {
  const d = Date.parse(String(day) + 'T00:00:00Z'), t = Date.parse(String(today) + 'T00:00:00Z');
  if (!isFinite(d) || !isFinite(t)) return '';
  const diff = Math.round((d - t) / 86400000);
  if (diff === 0) return 'Сегодня';
  if (diff === 1) return 'Завтра';
  if (diff === -1) return 'Вчера';
  const wd = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'][new Date(d).getUTCDay()];
  return wd + ', ' + String(day).slice(8, 10) + '.' + String(day).slice(5, 7);
}
/** «Повторить ссылку» доступна (сервер прислал availableAt — не раньше 15 минут после отправки). */
function edRemindReady(action, nowMs) {
  if (!action || !action.availableAt) return true;
  const t = Date.parse(action.availableAt);
  return !isFinite(t) || (nowMs === undefined ? Date.now() : nowMs) >= t;
}
/** 1 поле / 2 поля / 5 полей. */
function edPlural(n, one, few, many) {
  const a = Math.abs(n) % 100, b = a % 10;
  if (a > 10 && a < 20) return many;
  if (b > 1 && b < 5) return few;
  return b === 1 ? one : many;
}
```

- [ ] **Step 4: Оболочка раздела**

Заменить `frontend/js/pages/edocs.js` целиком:

```js
// ── «📄 ДОКУМЕНТЫ»: электронное подписание с пациентами через F.Doc ─────────────
// Адрес (хвост #edocs/…): '' и r/<период> — дашборд подписей (edocs-board.js); c/<пациент>[/<запись>] —
// страница пациента (edocs-client.js); packages — все комплекты; p/<комплект> — карточка; settings —
// настройки. Старые адреса мастера new/<пациент>[/<запись>] переписываются на c/… (на них ссылались
// карточка клиента, «Записи» и закладки). Состояние — в hash: F5 и «Назад» возвращают туда же (хук
// edocsOnHashArg в nav.js). Зависимости: api(), esc(), escAttr(), notify(), showLbar(), openModal()/
// closeModal(), помощники edocs-helpers.js. Глобальные имена — с префиксом ed/ED_ (общая область скриптов).
// loadSeq — номер загрузки: его увеличивают каждый маршрут, уход со страницы и выход; загрузка с
// устаревшим номером не рисует и не заводит опрос (иначе второй setInterval затирал handle первого и опрос
// жил до перезагрузки). Опрос у всех видов один — _ed.timer. sending — идёт отправка комплекта: кнопку
// «Отправить» до её итога не включает никто, иначе второй клик создал бы второй комплект тому же пациенту.
let _ed = { state: null, route: { view: 'board', range: 'today' }, timer: null, loadSeq: 0, sending: false, listStatus: '', listFrom: '', listTo: '', pkg: null };
const ED_POLL_MS = 30000;
const ED_VIEWS = ['board', 'client', 'list', 'package', 'settings'];

function edTail() { return (location.hash || '').slice(1).split('/').slice(1).map(decodeURIComponent).join('/'); }
function loadEdocs() { edRoute(edTail()); }
// Клик по меню: navTo пишет hash и сам зовёт loadEdocs, следом hashchange приносит тот же хвост —
// тот же маршрут второй раз не грузим (двойные запросы и второй опрос).
function edocsOnHashArg(arg) {
  const tail = arg || '';
  if (edSameRoute(edParseTail(tail), _ed.route)) return;
  edRoute(tail);
}
function edSameRoute(a, b) {
  return !!a && !!b && !a.legacy && a.view === b.view && (a.range || null) === (b.range || null) && (a.clientId || null) === (b.clientId || null)
    && (a.recordId || null) === (b.recordId || null) && (a.packageId || null) === (b.packageId || null);
}
function edGo(tail) {
  const h = tail ? 'edocs/' + tail : 'edocs';
  if ((location.hash || '').slice(1) === h) edRoute(tail || ''); else location.hash = h;
}
function edClearTimer() { if (_ed.timer) { clearInterval(_ed.timer); _ed.timer = null; } }
// Уход со страницы и выход (nav.js), новый маршрут: опрос гаснет, идущие загрузки устаревают.
function edStopPolling() { _ed.loadSeq++; edClearTimer(); }
function edIsAdmin() { return typeof ME !== 'undefined' && !!ME && (ME.role === 'owner' || ME.role === 'admin'); }
/** Отправлять в F.Doc сейчас можно: модуль включён и проверен, своя учётка подключена и не заперта. */
function edCanSend() { const s = _ed.state; return !!(s && s.enabled && s.configured && s.me && s.me.connected && !s.me.broken); }
/** Почему нельзя отправить (или ''). */
function edSendBlockReason() {
  const s = _ed.state;
  if (!s) return 'Нет связи с сервером';
  if (!s.enabled || !s.configured) return 'Модуль выключен: документы можно проверить, отправка — после подключения F.Doc';
  if (!s.me || !s.me.connected) return 'Подключите свою учётную запись F.Doc: кнопка «Мой F.Doc»';
  if (s.me.broken) return 'F.Doc не принимает ваш пароль — обновите его в «Мой F.Doc»';
  return '';
}

// fetch, который сохраняет всё тело ответа (api() оставляет только error): нужны
// packageId, missing, details. Файлы — FormData, JSON — opts.json. Сбой сети — не исключение,
// а status 0: вызывающий обязан показать ошибку (необработанный reject оставлял кнопки «в загрузке»).
async function edFetch(method, path, opts) {
  opts = opts || {};
  const headers = { Authorization: 'Bearer ' + localStorage.getItem('lp_tk') };
  let body;
  if (opts.form) body = opts.form;
  else if (opts.json !== undefined) { headers['Content-Type'] = 'application/json'; body = JSON.stringify(opts.json); }
  showLbar(true);
  try {
    let r;
    try { r = await fetch(path, { method: method, headers: headers, body: body }); } catch (e) {
      return { ok: false, status: 0, body: { error: 'Нет связи с сервером' } };
    }
    let j = {};
    try { j = (await r.json()) || {}; } catch (_) { /* пустое тело или HTML */ }
    return { ok: r.ok, status: r.status, body: j };
  } finally { showLbar(false); }
}

// Окно открываем ДО await: иначе блокировщик всплывающих окон съест window.open.
async function edOpenAsync(getUrl) {
  const win = window.open('about:blank', '_blank');
  try {
    const url = await getUrl();
    if (win) { win.opener = null; win.location.href = url; } else { window.location.href = url; }
  } catch (e) { if (win) win.close(); notify(e.message, 'err'); }
}

function edDownloadBase64(b64, name, mime) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const url = URL.createObjectURL(new Blob([bytes], { type: mime }));
  const a = document.createElement('a');
  a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

async function edRoute(tail) {
  edStopPolling();
  const seq = ++_ed.loadSeq;
  let route = edParseTail(tail);
  if (route.legacy) {
    route = { view: 'client', clientId: route.clientId, recordId: route.recordId };
    history.replaceState(null, '', '#edocs/' + edTailOf(route));
  }
  if (route.view === 'settings' && !edIsAdmin()) { history.replaceState(null, '', '#edocs'); route = { view: 'board', range: 'today' }; }
  _ed.route = route;
  for (const v of ED_VIEWS) {
    const el = document.getElementById('edView-' + v);
    if (el) el.style.display = v === route.view ? '' : 'none';
  }
  const tabOf = { board: 'board', client: 'board', list: 'list', package: 'list', settings: 'settings' };
  for (const t of ['board', 'list', 'settings']) {
    const b = document.getElementById('edTabBtn-' + t);
    if (b) b.classList.toggle('active', tabOf[route.view] === t);
  }
  const sb = document.getElementById('edTabBtn-settings');
  if (sb) sb.style.display = edIsAdmin() ? '' : 'none';
  await edLoadState();
  if (seq !== _ed.loadSeq) return;   // пока грузили, ушли: другой маршрут, другая страница, выход
  if (route.view === 'board') return edbRender(route, seq);
  if (route.view === 'client') return edcRender(route, seq);
  if (route.view === 'package') return edRenderPackage(route.packageId, seq);
  if (route.view === 'settings') return edRenderSettings();
  return edRenderList(seq);
}

/** Перерисовать текущий вид после смены состояния (подключили F.Doc, сменили настройки). */
function edRefreshView() {
  if (_ed.route.view === 'board' && typeof edbRefresh === 'function') edbRefresh(true);
  else if (_ed.route.view === 'client' && typeof edcRefresh === 'function') edcRefresh(true);
}

async function edLoadState() {
  try { _ed.state = await api('GET', '/api/edocs/state'); } catch (e) { _ed.state = null; }
  const s = _ed.state;
  const me = document.getElementById('edMeStatus');
  if (me) me.textContent = !s ? '' : s.me.connected ? (s.me.broken ? '⚠ F.Doc: обновите пароль' : 'F.Doc: ' + s.me.login) : 'F.Doc не подключён';
  const note = document.getElementById('edNotice');
  if (!note) return;
  const msgs = [];
  if (s && !s.encReady) msgs.push('На сервере не задан ключ шифрования EDOCS_ENC_KEY — данные пациентов сохранять нельзя.');
  if (s && !s.enabled) msgs.push(edIsAdmin()
    ? 'F.Doc не подключён: дашборд, данные пациентов, отметки «на бумаге» и анкеты работают, электронная отправка — после подключения (вкладка «Настройки»).'
    : 'F.Doc ещё не подключён: отметки «на бумаге» и анкеты работают, электронная отправка — после подключения (обратитесь к администратору).');
  else if (s && !s.me.connected) msgs.push('Чтобы отправлять документы, подключите свою учётную запись F.Doc: кнопка «Мой F.Doc».');
  note.innerHTML = msgs.map((m) => '<div class="ed-note">' + esc(m) + '</div>').join('');
}

// ── общее окно подтверждения (дашборд и страница пациента) ──
let _edConfirmResolve = null;
/** Окно с HTML-содержимым и кнопкой ok; Promise<boolean>. html собирает вызывающий (через esc). */
function edConfirm(opts) {
  if (_edConfirmResolve) _edConfirmResolve(false);
  document.getElementById('edConfirmTitle').textContent = opts.title || 'Подтвердите';
  document.getElementById('edConfirmBody').innerHTML = opts.html || '';
  document.getElementById('edConfirmOk').textContent = opts.ok || 'Отправить';
  openModal('edConfirmModal');
  return new Promise((resolve) => { _edConfirmResolve = resolve; });
}
function edConfirmDone(v) {
  closeModal('edConfirmModal');
  const r = _edConfirmResolve;
  _edConfirmResolve = null;
  if (r) r(!!v);
}

// Итог POST /packages (edFetch) — один на дашборд и страницу пациента. Комплект создан, но сбой уже после
// черновика — его карточка: «Повторить» там сначала спросит F.Doc, а повторная отправка отсюда создала бы
// второй комплект. Ответа нет (сеть, 5xx прокси) — комплект мог уйти. @returns 'sent'|'package'|'unknown'|'rejected'
const ED_SEND_UNKNOWN = 'Ответ сервера не получен — комплект мог уйти. Проверьте документы пациента, прежде чем отправлять снова';
function edSendOutcome(r) {
  const b = r.body || {};
  const credentials = b.code === 'fdoc_no_credentials' || b.code === 'fdoc_credentials_invalid';
  if (r.ok) { notify('Документы отправлены пациенту — он получит SMS со ссылкой'); return 'sent'; }
  if (b.packageId) {
    notify(b.error || ('Ошибка ' + r.status), 'err');
    edGo('p/' + b.packageId);
    if (credentials) edOpenMe();   // поверх карточки: после смены пароля — «Повторить отправку»
    return 'package';
  }
  if (!r.status || r.status >= 500) { notify(ED_SEND_UNKNOWN, 'err'); return 'unknown'; }
  notify(b.error || ('Ошибка ' + r.status), 'err');
  if (credentials) edOpenMe();
  return 'rejected';
}

// ── список комплектов ──
async function edRenderList(seq) {
  const box = document.getElementById('edView-list');
  if (!box) return;
  box.innerHTML = '<div class="ed-toolbar"><select id="edListStatus" onchange="edSetListStatus(this.value)"><option value="">Все статусы</option>'
    + Object.keys(ED_STATUS).map((k) => '<option value="' + k + '"' + (_ed.listStatus === k ? ' selected' : '') + '>' + esc(ED_STATUS[k].label) + '</option>').join('')
    + '</select><input type="date" id="edListFrom" value="' + escAttr(_ed.listFrom) + '" onchange="edSetListPeriod()" title="Создан с">'
    + '<input type="date" id="edListTo" value="' + escAttr(_ed.listTo) + '" onchange="edSetListPeriod()" title="Создан по"></div><div class="card ed-tbl-card"><div class="tw mtbl-wrap"><table class="mtbl"><thead><tr><th>Создан</th><th>Пациент</th><th>Комплект</th><th>Статус</th><th>Отправил</th></tr></thead>'
    + '<tbody id="edListBody"><tr><td colspan="5" class="empty">Загрузка…</td></tr></tbody></table></div></div>';
  await edLoadList();
  if (seq !== _ed.loadSeq) return;   // ушли, пока грузили, — опрос не заводим
  edClearTimer();
  _ed.timer = setInterval(edLoadList, ED_POLL_MS);
}
function edSetListStatus(v) { _ed.listStatus = v; edLoadList(); }
function edSetListPeriod() { _ed.listFrom = edVal('edListFrom'); _ed.listTo = edVal('edListTo'); edLoadList(); }
function edListQuery() {
  const q = [];
  if (_ed.listStatus) q.push('status=' + encodeURIComponent(_ed.listStatus));
  if (_ed.listFrom) q.push('from=' + encodeURIComponent(_ed.listFrom));
  if (_ed.listTo) q.push('to=' + encodeURIComponent(_ed.listTo));
  return q.length ? '?' + q.join('&') : '';
}
async function edLoadList() {
  const tb = document.getElementById('edListBody');
  if (!tb) return;
  try {
    const d = await api('GET', '/api/edocs/packages' + edListQuery());
    if (!d.rows.length) { tb.innerHTML = '<tr><td colspan="5" class="empty">Комплектов пока нет</td></tr>'; return; }
    tb.innerHTML = d.rows.map((p) => {
      const st = edStatusInfo(p.status);
      return '<tr class="ed-row" onclick="edGo(\'p/' + p.id + '\')">'
        + '<td data-label="Создан">' + esc(edFmtDateTime(p.createdAt)) + '</td>'
        + '<td class="mtbl-title"><strong>' + esc(p.clientName || '—') + '</strong> <span class="ed-sub">' + esc(edPhone(p.clientPhone)) + '</span></td>'
        + '<td data-label="Комплект">' + esc(p.title) + '</td>'
        + '<td data-label="Статус"><span class="badge ' + st.cls + '">' + esc(st.label) + '</span>'
        + (p.lastError && p.status === 'draft' ? '<div class="ed-err">' + esc(p.lastError) + '</div>' : '') + '</td>'
        + '<td data-label="Отправил">' + esc(p.sentByName || '—') + '</td></tr>';
    }).join('');
  } catch (e) { tb.innerHTML = '<tr><td colspan="5" class="empty">' + esc(e.message) + '</td></tr>'; }
}

// ── карточка комплекта ──
async function edRenderPackage(id, seq) {
  const box = document.getElementById('edView-package');
  if (!box) return;
  box.innerHTML = '<div class="empty">Загрузка…</div>';
  _ed.pkg = null;
  await edLoadPackage(id, false);
  if (seq !== _ed.loadSeq) return;   // ушли, пока грузили, — опрос не заводим
  edClearTimer();
  _ed.timer = setInterval(() => { if (_ed.pkg && !edIsFinal(_ed.pkg.status)) edLoadPackage(id, true); }, ED_POLL_MS);
}

async function edLoadPackage(id, quiet) {
  const box = document.getElementById('edView-package');
  let p;
  try { p = await api('GET', '/api/edocs/packages/' + id); } catch (e) { if (!quiet && box) box.innerHTML = '<div class="empty">' + esc(e.message) + '</div>'; return; }
  if (!box || _ed.route.view !== 'package' || _ed.route.packageId !== id) return;
  _ed.pkg = p;
  const st = edStatusInfo(p.status);
  box.innerHTML = '<div class="card mb"><div class="ed-pkg-head"><div><div class="ed-h">' + esc(p.title) + '</div>'
    + '<div class="ed-sub">' + esc(p.clientName || (p.patient && p.patient.fio) || '—') + ' · ' + esc(edPhone(p.clientPhone)) + '</div>'
    + '<div class="ed-sub">Отправил: ' + esc(p.sentByName || '—') + ' · ' + esc(edFmtDateTime(p.sentAt || p.createdAt))
    + (p.signedAt ? ' · подписан ' + esc(edFmtDateTime(p.signedAt)) : '') + '</div></div>'
    + '<span class="badge ' + st.cls + ' ed-badge-lg">' + esc(st.label) + '</span></div>'
    + (p.lastError && p.status === 'draft' ? '<div class="ed-err">' + esc(p.lastError) + '</div>' : '')
    + '<div class="ed-actions">' + edPackageActions(p) + '</div></div>'
    + '<div class="card mb"><div class="ed-h2">Документы</div><div class="tw mtbl-wrap"><table class="mtbl"><thead><tr><th>Документ</th><th>Подпись клиники</th><th>Подпись пациента</th><th></th></tr></thead><tbody>'
    + p.documents.map((d) => '<tr><td class="mtbl-title">' + esc(d.title) + '</td><td data-label="Клиника">' + esc(edFmtDateTime(d.corpSignedAt)) + '</td>'
      + '<td data-label="Пациент">' + esc(edFmtDateTime(d.clientSignedAt)) + '</td><td>' + (d.hasPdf ? '<button class="btn btn-sec btn-sm" onclick="edOpenPdf(\'' + d.id + '\')">PDF</button>' : '') + '</td></tr>').join('')
    + '</tbody></table></div></div>'
    + (p.act ? edActSummaryHtml(p.act) : '')
    + (p.paper ? '<div class="card mb"><div class="ed-h2">Подписано на бумаге</div><div class="ed-sub">Дата подписания: ' + esc(edFmtDate(p.paper.signedDate))
      + (p.paper.note ? ' · ' + esc(p.paper.note) : '') + (p.paper.hasScan ? '' : ' · скан не приложен') + '</div></div>' : '')
    + '<div class="card"><div class="ed-h2">Журнал</div>' + ((p.events || []).map((e) => '<div class="ed-event"><span class="ed-sub">' + esc(edFmtDateTime(e.createdAt)) + '</span> '
      + esc(ED_EVENT_LABELS[e.kind] || e.kind) + (e.kind === 'status' && e.payload ? ': ' + esc(edStatusInfo(e.payload.to).label) : '')
      + (e.userName ? ' · ' + esc(e.userName) : '') + '</div>').join('') || '<div class="ed-sub">Пусто</div>') + '</div>';
}

function edActSummaryHtml(act) {
  const t = edActTotals(act.lines || []);
  return '<div class="card mb"><div class="ed-h2">Строки акта · визит ' + esc(edFmtDate(act.visit_date)) + ' · ' + esc(act.doctor_name || '') + '</div><div class="tw"><table><thead><tr><th>Услуга</th><th>Кол-во</th><th>Цена</th><th>Сумма</th></tr></thead><tbody>'
    + (act.lines || []).map((l) => '<tr><td>' + esc(l.title) + '</td><td>' + esc(String(l.qty)) + '</td><td>' + esc(edMoney(l.price)) + '</td><td>' + esc(edMoney(l.sum)) + '</td></tr>').join('')
    + '</tbody></table></div><div class="ed-total">Итого: ' + esc(edMoney(t.total)) + '</div></div>';
}

function edPackageActions(p) {
  const b = [];
  const btn = (action, label, cls) => '<button class="btn ' + (cls || 'btn-sec') + ' btn-sm" onclick="edPkgAction(\'' + p.id + '\',\'' + action + '\',this)">' + label + '</button>';
  b.push('<button class="btn btn-sec btn-sm" onclick="edGo(\'c/' + p.clientId + '\')">Пациент</button>');
  if (p.source === 'paper') {
    if (p.paper && p.paper.hasScan) b.push('<button class="btn btn-sec btn-sm" onclick="edOpenScan(\'' + p.id + '\')">Скан</button>');
    if (p.status === 'paper' && edIsAdmin()) b.push('<button class="btn btn-sec btn-sm btn-dng" onclick="edRevokePaper(\'' + p.id + '\')">Снять отметку</button>');
    return b.join('');
  }
  if (p.status === 'draft') b.push(btn('resend', 'Повторить отправку', 'btn-pri'));
  if (p.status !== 'draft') b.push('<button class="btn btn-sec btn-sm" onclick="edOpenInFdoc(\'' + p.id + '\')">Открыть в F.Doc</button>');
  if (p.status === 'sent') b.push(btn('permalink', 'Отправить ссылку ещё раз'));
  if (p.status !== 'draft' && !edIsFinal(p.status)) b.push(btn('refresh', 'Обновить статус'));
  if (p.status === 'sent' || p.status === 'error') b.push(btn('annul', 'Аннулировать', 'btn-sec btn-dng'));
  // Отказ, аннулирование, истёкший срок — новый комплект на странице пациента (по тому же визиту для акта).
  if (['declined', 'annulled', 'expired'].indexOf(p.status) >= 0) {
    b.push('<button class="btn btn-pri btn-sm" onclick="edGo(\'c/' + p.clientId + (p.recordId ? '/' + p.recordId : '') + '\')">Оформить заново</button>');
  }
  return b.join('');
}

// btn — нажатая кнопка: заблокирована до ответа (двойной клик «Отправить ссылку ещё раз» = два SMS пациенту).
async function edPkgAction(id, action, btn) {
  if (btn && btn.disabled) return;   // запрос по этой кнопке уже идёт
  if (action === 'annul' && !confirm('Аннулировать комплект? Пациент больше не сможет его подписать.')) return;
  if (action === 'permalink' && !confirm('Отправить пациенту ссылку на подписание ещё раз? Он получит SMS.')) return;
  if (btn) btn.disabled = true;
  try {
    const r = await api('POST', '/api/edocs/packages/' + id + '/' + action);
    const msg = { resend: r && r.recovered ? 'Комплект уже был в F.Doc — отмечен отправленным' : 'Комплект отправлен', permalink: 'Ссылка отправлена пациенту', refresh: 'Статус обновлён', annul: 'Комплект аннулирован' };
    notify(msg[action] || 'Готово');
    await edLoadPackage(id, true);   // карточка перерисуется с новыми кнопками
  } catch (e) { notify(e.message, 'err'); if (/Мой F\.Doc/.test(e.message)) edOpenMe(); }
  finally { if (btn) btn.disabled = false; }
}
function edOpenInFdoc(id) { edOpenAsync(async () => (await api('POST', '/api/edocs/packages/' + id + '/employee-url')).url); }
function edOpenPdf(docId) { edOpenAsync(async () => (await api('GET', '/api/edocs/documents/' + docId + '/pdf')).url); }

function edOpenScan(id) { edOpenAsync(async () => (await api('GET', '/api/edocs/packages/' + id + '/scan')).url); }
async function edRevokePaper(id) {
  const reason = prompt('Почему снимаете отметку «Подписано на бумаге»? Причина попадёт в журнал.');
  if (reason === null) return;
  try {
    await api('POST', '/api/edocs/packages/' + id + '/paper-revoke', { reason: reason });
    notify('Отметка снята');
    await edLoadPackage(id, true);
  } catch (e) { notify(e.message, 'err'); }
}

// ── «Мой F.Doc»: учётная запись текущего пользователя ──
function edOpenMe() {
  const me = _ed.state && _ed.state.me;
  const info = document.getElementById('edMeInfo');
  if (info) info.textContent = !me ? '' : me.connected
    ? (me.broken ? 'F.Doc не принимает сохранённый пароль — введите новый' : 'Подключено: ' + me.login)
    : 'Логин и пароль выдаёт F.Doc при регистрации сотрудника. Документы будут уходить от вашего имени.';
  document.getElementById('edMeLogin').value = (me && me.login) || '';
  document.getElementById('edMePassword').value = '';
  openModal('edMeModal');
}
async function edSaveMe() {
  const login = document.getElementById('edMeLogin').value.trim();
  const password = document.getElementById('edMePassword').value;
  if (!login || !password) return notify('Введите логин и пароль F.Doc', 'err');
  try {
    await api('PUT', '/api/edocs/me/credentials', { login: login, password: password });
    notify('Учётная запись F.Doc подключена');
    closeModal('edMeModal');
    await edLoadState();
    edRefreshView();
  } catch (e) { notify(e.message, 'err'); }
}
async function edDeleteMe() {
  if (!confirm('Отключить вашу учётную запись F.Doc?')) return;
  try {
    await api('DELETE', '/api/edocs/me/credentials');
    notify('Учётная запись F.Doc отключена');
    closeModal('edMeModal');
    await edLoadState();
    edRefreshView();
  } catch (e) { notify(e.message, 'err'); }
}

// ── настройки (владелец, администратор) ──
async function edRenderSettings() {
  const box = document.getElementById('edView-settings');
  if (!box) return;
  box.innerHTML = '<div class="empty">Загрузка…</div>';
  let s, t, u, dict;
  try {
    [s, t, u, dict] = await Promise.all([
      api('GET', '/api/edocs/admin/settings'), api('GET', '/api/edocs/admin/templates'),
      api('GET', '/api/edocs/admin/users'), api('GET', '/api/edocs/admin/templates/dictionary'),
    ]);
  } catch (e) { box.innerHTML = '<div class="empty">' + esc(e.message) + '</div>'; return; }
  const v = (x) => escAttr(x === null || x === undefined ? '' : String(x));
  const f = (id, label, val, extra) => '<div class="fg"><label class="fl" for="' + id + '">' + esc(label) + '</label><input id="' + id + '" value="' + v(val) + '" ' + (extra || '') + '></div>';
  box.innerHTML = (s.encReady ? '' : '<div class="ed-note ed-note-bad">На сервере не задан ключ шифрования EDOCS_ENC_KEY: модуль не сможет сохранять пароли и паспортные данные.</div>')
    + '<div class="card mb"><div class="ed-h">Подключение к F.Doc</div><div class="ed-grid">'
    + f('edS-baseUrl', 'Адрес стенда', s.baseUrl, 'placeholder="https://demo.fdoc.ru"')
    + f('edS-apiKey', 'Ключ API организации', '', 'type="password" autocomplete="new-password" placeholder="' + (s.hasApiKey ? 'сохранён — введите, чтобы заменить' : '') + '"')
    + f('edS-appLogin', 'Логин приложения', s.appLogin)
    + f('edS-appPassword', 'Пароль приложения', '', 'type="password" autocomplete="new-password" placeholder="' + (s.hasAppPassword ? 'сохранён — введите, чтобы заменить' : '') + '"')
    + f('edS-appCode', 'Код приложения (app)', s.appCode)
    + f('edS-qesCertAlias', 'Алиас сертификата КЭП клиники', s.qesCertAlias, 'placeholder="пусто — штамп сотрудника"')
    + f('edS-employeePosition', 'Должность подписанта от клиники', s.employeePosition)
    + f('edS-unsignDays', 'Срок подписания, дней', s.unsignDays, 'type="number" min="1" max="90"')
    + '</div><label class="ed-switch"><input type="checkbox" id="edS-enabled"' + (s.enabled ? ' checked' : '') + '> Модуль включён</label>'
    + '<div class="ed-sub">Организация в F.Doc: ' + (s.corpId ? esc(s.corpId) : 'подключение не проверено') + '</div></div>'
    + '<div class="card mb"><div class="ed-h">Реквизиты клиники для документов</div><div class="ed-grid">'
    + ED_ORG_FIELDS.map((x) => f('edR-' + x[0], x[1], (s.requisites || {})[x[0]])).join('') + '</div>'
    + '<div class="ed-actions"><button class="btn btn-pri" onclick="edSaveSettings()">Сохранить настройки</button>'
    + '<button class="btn btn-sec" onclick="edVerify()">Проверить подключение</button><button class="btn btn-sec" onclick="edTariff()">Тариф</button>'
    + '<span id="edTariff" class="ed-sub"></span></div></div>'
    + '<div class="card mb"><div class="ed-h">Автоматизация, анкета и номера договоров</div>'
    + '<div class="ed-sub">Что отправлять без участия администратора, текст сообщения с анкетой, нумерация договоров, с какой даты нужны акты. По умолчанию автоматика выключена.</div>'
    + '<div class="ed-actions"><button class="btn btn-pri" onclick="edOpenAutomation()">⚙ Настроить</button></div></div>'
    + '<div class="card mb"><div class="ed-h">Уведомления F.Doc о статусах</div><div class="ed-sub">'
    + (s.webhookUrl ? 'Адрес: ' + esc(s.webhookUrl) : 'Не подключены — статусы проверяются опросом раз в 5 минут')
    + (s.lastWebhookAt ? ' · последнее уведомление ' + esc(edFmtDateTime(s.lastWebhookAt)) : '') + '</div>'
    + '<div class="ed-sub">Перед подпиской передайте менеджеру F.Doc IP-адрес сервера.</div>'
    + '<div class="ed-actions"><button class="btn btn-sec" onclick="edSubscribe()">' + (s.webhookUrl ? 'Подписаться заново' : 'Подписаться') + '</button></div></div>'
    + '<div class="card mb"><div class="ed-h">Шаблоны документов</div><div class="ed-upload">'
    + '<input id="edT-title" placeholder="Название документа"><select id="edT-kind">' + dict.kinds.map((k) => '<option value="' + k.kind + '">' + esc(k.label) + '</option>').join('') + '</select>'
    + '<input type="file" id="edT-file" accept=".docx"><button class="btn btn-pri btn-sm" onclick="edUploadTemplate()">Загрузить</button></div>'
    + '<div id="edTplErrors" class="ed-err"></div>'
    + '<div class="tw mtbl-wrap"><table class="mtbl"><thead><tr><th>Документ</th><th>Вид</th><th>Теги</th><th>Активен</th><th></th></tr></thead><tbody>'
    + (t.templates.length ? t.templates.map(edTemplateRow).join('') : '<tr><td colspan="5" class="empty">Шаблонов пока нет</td></tr>') + '</tbody></table></div>'
    + '<details class="ed-dict"><summary>Какие теги можно использовать в шаблоне</summary>'
    + '<div class="ed-sub">Тег пишется прямо в тексте Word в фигурных скобках: {fio}. Строки акта — внутри одной строки таблицы: {#services}{n} … {title} … {sum}{/services}.</div>'
    + '<table><tbody>' + dict.fields.map((x) => '<tr><td><code>{' + esc(x.loop ? '#' + x.tag : x.tag) + '}</code></td><td>' + esc(x.label) + (x.actOnly ? ' <span class="badge bgr">акт</span>' : '') + '</td></tr>').join('')
    + dict.serviceFields.map((x) => '<tr><td><code>{' + esc(x.tag) + '}</code></td><td>' + esc(x.label) + ' <span class="badge bgr">строка акта</span></td></tr>').join('')
    + '</tbody></table></details></div>'
    + '<div class="card"><div class="ed-h">Сотрудники и F.Doc</div><div class="tw mtbl-wrap"><table class="mtbl"><thead><tr><th>Сотрудник</th><th>Роль</th><th>Учётная запись F.Doc</th></tr></thead><tbody>'
    + u.users.map((x) => '<tr><td class="mtbl-title">' + esc(x.name || x.email) + '</td><td data-label="Роль">' + esc(x.role) + '</td><td data-label="F.Doc">' + (x.connected ? (x.broken ? '⚠ ' : '✓ ') + esc(x.login) : '<span class="ed-sub">не подключена</span>') + '</td></tr>').join('')
    + '</tbody></table></div></div>';
}

function edTemplateRow(x) {
  return '<tr><td data-label="Документ"><input class="ed-inline" id="edTt-' + x.id + '" value="' + escAttr(x.title) + '"></td>'
    + '<td data-label="Вид"><select id="edTk-' + x.id + '">' + Object.keys(ED_KIND_LABELS).map((k) => '<option value="' + k + '"' + (x.kind === k ? ' selected' : '') + '>' + esc(ED_KIND_LABELS[k]) + '</option>').join('') + '</select></td>'
    + '<td data-label="Теги" class="ed-sub">' + esc((x.placeholders || []).join(', ') || '—') + '</td>'
    + '<td data-label="Активен"><input type="checkbox" id="edTa-' + x.id + '"' + (x.is_active ? ' checked' : '') + '></td>'
    + '<td class="ed-row-actions"><button class="btn btn-sec btn-sm" onclick="edSaveTemplate(' + x.id + ')">Сохранить</button>'
    + '<button class="btn btn-sec btn-sm" onclick="edTemplateFile(' + x.id + ')">Скачать</button>'
    + '<label class="btn btn-sec btn-sm ed-file">Заменить файл<input type="file" accept=".docx" onchange="edReplaceTemplate(' + x.id + ',this)"></label>'
    + '<button class="btn btn-sec btn-sm btn-dng" onclick="edDeleteTemplate(' + x.id + ')">Удалить</button></td></tr>';
}

function edVal(id) { const el = document.getElementById(id); return el ? el.value : ''; }

async function edSaveSettings() {
  const body = {
    enabled: document.getElementById('edS-enabled').checked, baseUrl: edVal('edS-baseUrl').trim(), appLogin: edVal('edS-appLogin'),
    appCode: edVal('edS-appCode'), qesCertAlias: edVal('edS-qesCertAlias'), employeePosition: edVal('edS-employeePosition'),
    unsignDays: edVal('edS-unsignDays'), requisites: {},
  };
  // Пустое поле секрета — «не менять»: сервер трактует отсутствие поля как сохранение прежнего.
  if (edVal('edS-apiKey')) body.apiKey = edVal('edS-apiKey');
  if (edVal('edS-appPassword')) body.appPassword = edVal('edS-appPassword');
  for (const x of ED_ORG_FIELDS) body.requisites[x[0]] = edVal('edR-' + x[0]);
  try {
    const r = await api('PUT', '/api/edocs/admin/settings', body);
    notify(r.needVerify ? 'Сохранено. Данные F.Doc изменились — нажмите «Проверить подключение»' : 'Настройки сохранены');
    await edRenderSettings();
    edLoadState();
  } catch (e) { notify(e.message, 'err'); }
}
async function edVerify() {
  try { const r = await api('POST', '/api/edocs/admin/settings/verify'); notify('Подключение работает, организация ' + r.corpId); edRenderSettings(); }
  catch (e) { notify(e.message, 'err'); }
}
async function edTariff() {
  try {
    const r = await api('GET', '/api/edocs/admin/settings/tariff');
    const t = (r.tariffs || [])[0];
    const el = document.getElementById('edTariff');
    if (el) el.textContent = t ? (t.tariffName || 'Тариф') + ': осталось ' + (t.remainPages === undefined ? '—' : t.remainPages) + ' из ' + (t.count === undefined ? '—' : t.count) + ', до ' + edFmtDate(t.expiryDate) : 'Активного тарифа нет';
  } catch (e) { notify(e.message, 'err'); }
}
async function edSubscribe() {
  try { await api('POST', '/api/edocs/admin/settings/webhook'); notify('Подписка на уведомления оформлена'); edRenderSettings(); }
  catch (e) { notify(e.message, 'err'); }
}
async function edUploadTemplate() {
  const file = document.getElementById('edT-file').files[0];
  const title = edVal('edT-title').trim();
  const errs = document.getElementById('edTplErrors');
  errs.textContent = '';
  if (!title) return notify('Укажите название документа', 'err');
  if (!file) return notify('Выберите файл .docx', 'err');
  const fd = new FormData();
  fd.append('title', title); fd.append('kind', edVal('edT-kind')); fd.append('file', file);
  const r = await edFetch('POST', '/api/edocs/admin/templates', { form: fd });
  if (!r.ok) { errs.innerHTML = esc(r.body.error || 'Ошибка ' + r.status) + ((r.body.details || []).length ? '<br>' + r.body.details.map(esc).join('<br>') : ''); return; }
  notify('Шаблон загружен');
  edRenderSettings();
}
async function edSaveTemplate(id) {
  const body = { title: edVal('edTt-' + id), kind: edVal('edTk-' + id), isActive: document.getElementById('edTa-' + id).checked };
  const r = await edFetch('PUT', '/api/edocs/admin/templates/' + id, { json: body });
  if (!r.ok) {
    notify((r.body.error || 'Ошибка') + ((r.body.details || []).length ? ': ' + r.body.details.join('; ') : ''), 'err');
    // Отказ сервера (шаблон занят, вид не подходит): в строке не должно остаться несохранённого.
    // Без связи (status 0) перечитать нечего — только текст ошибки, форма остаётся.
    if (r.status) edRenderSettings();
    return;
  }
  notify('Шаблон сохранён');
}
function edTemplateFile(id) { edOpenAsync(async () => (await api('GET', '/api/edocs/admin/templates/' + id + '/file')).url); }
async function edReplaceTemplate(id, input) {
  const file = input.files && input.files[0];
  input.value = '';
  if (!file) return;
  const fd = new FormData();
  fd.append('file', file);
  const r = await edFetch('POST', '/api/edocs/admin/templates/' + id + '/file', { form: fd });
  if (!r.ok) return notify((r.body.error || 'Ошибка') + ((r.body.details || []).length ? ': ' + r.body.details.join('; ') : ''), 'err');
  notify('Файл шаблона заменён');
  edRenderSettings();
}
async function edDeleteTemplate(id) {
  if (!confirm('Удалить шаблон?')) return;
  try { await api('DELETE', '/api/edocs/admin/templates/' + id); notify('Шаблон удалён'); edRenderSettings(); }
  catch (e) { notify(e.message, 'err'); }
}

// ── автоматизация, анкета, номера договоров (окно — с дашборда и из настроек) ──
let _edAuto = null;
async function edOpenAutomation() {
  const box = document.getElementById('edAutoBody');
  box.innerHTML = '<div class="empty">Загрузка…</div>';
  openModal('edAutoModal');
  try { _edAuto = await api('GET', '/api/edocs/admin/automation'); } catch (e) { box.innerHTML = '<div class="empty">' + esc(e.message) + '</div>'; return; }
  edAutoRender();
}
function edTgl(btn) { btn.classList.toggle('on'); }
function edAutoRender() {
  const d = _edAuto;
  const box = document.getElementById('edAutoBody');
  if (!d || !box) return;
  const tgl = (id, on) => '<button type="button" class="ed-tgl' + (on ? ' on' : '') + '" id="' + id + '" onclick="edTgl(this)"></button>';
  const num = (id, v, min, max) => '<input type="number" id="' + id + '" value="' + escAttr(String(v)) + '" min="' + min + '" max="' + max + '" style="width:80px">';
  const opt = (v, label, cur) => '<option value="' + escAttr(String(v)) + '"' + (String(cur) === String(v) ? ' selected' : '') + '>' + esc(String(label)) + '</option>';
  const senders = d.senders.filter((u) => u.connected && !u.broken);
  box.innerHTML = (d.testPhones && d.testPhones.length ? '<div class="ed-note">Тестовый режим: пациентам уходят только отправки на ' + esc(d.testPhones.join(', ')) + ' (EDOCS_TEST_PHONES).</div>' : '')
    + (d.publicUrlConfigured ? '' : '<div class="ed-note ed-note-bad">Не задан адрес для ссылок анкеты (EDOCS_PUBLIC_URL) — автоматика не сможет отправлять анкеты.</div>')
    + '<div class="ed-sub" style="margin-bottom:6px">По умолчанию всё выключено. Ручная отправка со страницы пациента работает всегда. Ночью (тихие часы из настроек автоуведомлений) автоматика ждёт утра.</div>'
    + '<div class="fg"><label class="fl" for="edAu-sender">Отправлять от имени</label><select id="edAu-sender"><option value="">— выберите сотрудника с подключённым F.Doc —</option>'
    + senders.map((u) => opt(u.id, u.name, d.senderUserId)).join('') + '</select>'
    + (d.senders.length > senders.length ? '<div class="ed-sub">В списке только сотрудники, подключившие свою учётную запись F.Doc.</div>' : '') + '</div>'
    + '<div class="ed-au-row">' + tgl('edAu-previsit', d.previsit.on) + '<div class="grow"><h4>Договор и согласие перед визитом</h4>'
    + '<p>Если документа нет, пациент получит его заранее и подпишет дома. Не хватает паспорта — уйдёт анкета, а документы — сразу после её заполнения.</p>'
    + 'за ' + num('edAu-previsitHours', d.previsit.hours, 2, 168) + ' ч до визита · <select id="edAu-scope">' + opt('first', 'только первичным', d.previsit.scope) + opt('all', 'всем, у кого нет документов', d.previsit.scope) + '</select>'
    + '<label class="ed-switch"><input type="checkbox" id="edAu-form"' + (d.previsit.form ? ' checked' : '') + '> Если данных не хватает — отправить анкету</label></div></div>'
    + '<div class="ed-au-row">' + tgl('edAu-act', d.act.on) + '<div class="grow"><h4>Акт после оплаты визита</h4>'
    + '<p>Когда в YClients визит отмечен «пришёл» и оплачен, акт собирается из услуг записи и уходит пациенту.</p>'
    + 'через ' + num('edAu-actDelay', d.act.delayMin, 5, 240) + ' мин после оплаты</div></div>'
    + '<div class="ed-au-row">' + tgl('edAu-remind', d.remind.on) + '<div class="grow"><h4>Повтор, если не подписано</h4>'
    + '<p>Один раз: ссылка на подпись — SMS от F.Doc, анкета — повторно в мессенджер.</p>'
    + 'через ' + num('edAu-remindHours', d.remind.hours, 1, 48) + ' ч</div></div>'
    + '<div class="ed-au-row"><div class="grow"><h4>Сообщение с анкетой</h4><p>Подставляются {имя}, {клиника}, {дата}, {ссылка}. Пусто — текст по умолчанию.</p>'
    + '<textarea id="edAu-msg" placeholder="' + escAttr(d.formMessageDefault) + '">' + esc(d.formMessage || '') + '</textarea>'
    + 'Ссылка действует ' + num('edAu-ttl', d.formTtlDays, 1, 30) + ' дн.</div></div>'
    + '<div class="ed-au-row">' + tgl('edAu-autonum', d.contractAutonumber) + '<div class="grow"><h4>Номера договоров автоматически</h4>'
    + '<p>Свой номер пациента (в данных или в YClients) сохраняется; остальным — следующий по счёту. Уже выдан максимум: ' + esc(String(d.contractNext.maxUsed)) + '.</p>'
    + 'Следующий номер: ' + num('edAu-next', d.contractNext.next, 1, 999999999999) + '</div></div>'
    + '<div class="ed-au-row"><div class="grow"><h4>Акты нужны для визитов с</h4><p>Более ранние визиты дашборд не считает незакрытыми.</p>'
    + '<input type="date" id="edAu-actsFrom" value="' + escAttr(d.actsRequiredFrom || '') + '" style="width:auto"></div></div>'
    + '<div class="ed-actions"><button class="btn btn-pri" onclick="edSaveAutomation()">Сохранить</button><button class="btn btn-sec" onclick="closeModal(\'edAutoModal\')">Отмена</button></div>';
}
async function edSaveAutomation() {
  const on = (id) => document.getElementById(id).classList.contains('on');
  const d = _edAuto;
  const next = edVal('edAu-next');
  const body = {
    senderUserId: edVal('edAu-sender') || null,
    previsit: { on: on('edAu-previsit'), hours: edVal('edAu-previsitHours'), scope: edVal('edAu-scope'), form: document.getElementById('edAu-form').checked },
    act: { on: on('edAu-act'), delayMin: edVal('edAu-actDelay') },
    remind: { on: on('edAu-remind'), hours: edVal('edAu-remindHours') },
    formMessage: edVal('edAu-msg'), formTtlDays: edVal('edAu-ttl'), contractAutonumber: on('edAu-autonum'),
    actsRequiredFrom: edVal('edAu-actsFrom') || null,
  };
  if (d && String(next) !== String(d.contractNext.next)) body.contractNextNo = next;
  try {
    await api('PUT', '/api/edocs/admin/automation', body);
    notify('Настройки автоматизации сохранены');
    closeModal('edAutoModal');
    edRefreshView();
  } catch (e) { notify(e.message, 'err'); }
}

// ── встройки в другие страницы ──
// Карточка клиента (clients.js → openCD): блок «Документы», если модуль включён.
async function edRenderClientBlock(clientId) {
  const el = document.getElementById('edClientBlock_' + clientId);
  if (!el) return;
  let s;
  try { s = await api('GET', '/api/edocs/clients/' + clientId + '/summary'); } catch (e) { el.innerHTML = ''; return; }
  if (!s || !s.enabled) { el.innerHTML = ''; return; }
  const id = s.identity;
  el.innerHTML = '<div class="div"></div><div class="ed-cblock-head"><div style="font-size:13px;font-weight:700">Документы</div>'
    + '<button class="btn btn-pri btn-sm" onclick="edOpenClient(' + clientId + ')">Документы пациента</button></div>'
    + '<div class="ed-sub">' + (id.exists ? 'Данные для документов: ' + esc(id.fio || '—') + (id.passportMask ? ' · паспорт ' + esc(id.passportMask) : ' · паспорт не заполнен') : 'Данные для документов не заполнены') + '</div>'
    + (s.packages || []).map((p) => {
      const st = edStatusInfo(p.status);
      return '<div class="ed-crow" onclick="edOpenPackage(\'' + p.id + '\')"><span>' + esc(p.title) + '</span><span class="badge ' + st.cls + '">' + esc(st.label) + '</span></div>';
    }).join('');
}
function edOpenClient(clientId, recordId) {
  if (typeof closeModal === 'function') closeModal('clientModal');
  location.hash = 'edocs/c/' + clientId + (recordId ? '/' + recordId : '');
}
function edOpenPackage(id) {
  if (typeof closeModal === 'function') closeModal('clientModal');
  location.hash = 'edocs/p/' + id;
}
// Страница «Записи» (records.js): кнопка «Акт» у состоявшихся визитов или статус акта.
async function edDecorateRecords(records) {
  const ids = (records || []).filter((r) => r.status === 'arrived').map((r) => r.id);
  if (!ids.length) return;
  let res;
  try { res = await api('GET', '/api/edocs/records/act-status?ids=' + ids.join(',')); } catch (e) { return; }
  if (!res || !res.enabled) return;
  document.querySelectorAll('#rBody td.r-act').forEach((td) => {
    const rid = Number(td.dataset.rid), cid = Number(td.dataset.cid);
    if (ids.indexOf(rid) < 0 || !cid) return;
    const a = res.statuses[rid];
    td.innerHTML = a
      ? '<span class="badge ' + edStatusInfo(a.status).cls + ' ed-link" onclick="edOpenPackage(\'' + a.packageId + '\')">Акт: ' + esc(edStatusInfo(a.status).label) + '</span>'
      : '<button class="btn btn-sec btn-sm" onclick="edOpenClient(' + cid + ',' + rid + ')">📄 Акт</button>';
  });
}
```

- [ ] **Step 5: Дашборд**

Создать `frontend/js/pages/edocs-board.js`:

```js
// ── «📄 Документы»: дашборд подписей (спека 2026-10-25 §4) ───────────────────────────
// Карточки пациентов по записям периода. Цвет, подпись, плитки документов, предупреждения и главное
// действие считает сервер (services/edocs/board.js) — здесь только отрисовка, фильтры и действия.
// Опрос — раз в 20 с, пока вкладка видима; таймер общий с остальными видами (_ed.timer): уход со
// страницы и смена маршрута гасят его в edStopPolling. Глобальные имена — edb*/ED_*.
let _edb = { range: 'today', chip: '', color: '', search: '', data: null, snap: null, base: { filter: 'all', search: '', page: 1 }, busy: new Set() };
const ED_BOARD_POLL_MS = 20000;
let _edbSearchTimer = null;

function edbEl(id) { return document.getElementById(id); }

function edbRender(route, seq) {
  const box = edbEl('edView-board');
  if (!box) return;
  if (_edb.range !== route.range) { _edb.chip = ''; _edb.color = ''; _edb.snap = null; }
  _edb.range = route.range;
  if (route.range === 'all') return edbRenderBase(seq);
  box.innerHTML = '<div id="edbHead"></div><div id="edbBar"></div><div id="edbChips" class="edb-chips"></div><div id="edbAuto"></div>'
    + '<div id="edbWarns" class="edb-warns"></div><div id="edbCards"><div class="edb-grid">' + '<div class="edb-skel"></div>'.repeat(6) + '</div></div>';
  edbBarRender(true);
  return edbLoad(seq, false).then(() => {
    if (seq !== _ed.loadSeq) return;   // ушли, пока грузили, — опрос не заводим
    edClearTimer();
    _ed.timer = setInterval(() => edbRefresh(false), ED_BOARD_POLL_MS);
  });
}

async function edbLoad(seq, quiet) {
  let d;
  try { d = await api('GET', '/api/edocs/board?range=' + encodeURIComponent(_edb.range)); } catch (e) {
    const el = edbEl('edbCards');
    if (!quiet && seq === _ed.loadSeq && el) el.innerHTML = '<div class="edb-empty">' + esc(e.message) + '</div>';
    return;
  }
  if (seq !== _ed.loadSeq || _ed.route.view !== 'board' || d.range !== _edb.range) return;
  const changes = edBoardChanges(_edb.snap, d.cards);
  _edb.snap = edBoardSnapshot(d.cards);
  _edb.data = d;
  edbPaint(changes.map((c) => c.key));
  if (changes.length) notify(changes.slice(0, 2).map((c) => c.text).join(' · ') + (changes.length > 2 ? ' и ещё ' + (changes.length - 2) : ''));
}

/** Перечитать дашборд: по таймеру — только если вкладка видима; force — после действия. */
function edbRefresh(force) {
  if (_ed.route.view !== 'board') return;
  if (!force && typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
  if (_edb.range === 'all') { if (force) edbBaseLoad(_ed.loadSeq); return; }
  edbLoad(_ed.loadSeq, true);
}

function edbPaint(flashKeys) { edbHeadRender(); edbBarRender(false); edbChipsRender(); edbAutoRender(); edbWarnsRender(); edbCardsRender(flashKeys || []); }

function edbHeadRender() {
  const d = _edb.data;
  const el = edbEl('edbHead');
  if (!el || !d) return;
  const s = d.summary;
  const pct = s.total ? Math.round(s.green * 100 / s.total) : 0;
  const titles = { today: 'Готовы на сегодня', tomorrow: 'Готовы на завтра', week: 'Готовы на неделю', open: 'Незакрытые визиты' };
  const sub = _edb.range === 'open'
    ? 'Прошлые визиты, где не хватает акта или договора'
    : 'Все обязательные документы подписаны у ' + s.green + ' из ' + s.total + ' ' + edPlural(s.total, 'пациента', 'пациентов', 'пациентов');
  const tile = (color, note) => '<button class="edb-tile ed-c-' + color + (_edb.color === color ? ' on' : '') + '" onclick="edbSetColor(\'' + color + '\')">'
    + '<span class="edb-k">' + esc(ED_COLOR_TITLE[color]) + '</span><b>' + s[color] + '</b><small>' + esc(note) + '</small></button>';
  el.innerHTML = '<div class="edb-sum"><div class="edb-tile edb-ready"><div class="edb-ring" style="--p:' + pct + '"><span>' + s.green + '/' + s.total + '</span></div>'
    + '<div><h3>' + esc(titles[_edb.range] || '') + '</h3><small>' + esc(sub) + '</small></div></div>'
    + tile('red', 'визит скоро или акт после оплаты') + tile('amber', 'успеть до визита') + tile('blue', 'ссылка или анкета у пациента') + tile('green', 'всё подписано') + '</div>';
}

/** full — перерисовать панель целиком (смена периода); иначе обновить только счётчики (поиск не теряет фокус). */
function edbBarRender(full) {
  const el = edbEl('edbBar');
  if (!el) return;
  const counts = (_edb.data && _edb.data.rangeCounts) || {};
  if (full || !edbEl('edbSeg-today')) {
    el.innerHTML = '<div class="edb-bar"><div class="edb-seg">' + ED_RANGES.map((r) => '<button id="edbSeg-' + r[0] + '" class="' + (r[0] === _edb.range ? 'on' : '') + '" onclick="edbSetRange(\'' + r[0] + '\')">'
      + esc(r[1]) + '<i>' + (counts[r[0]] !== undefined ? counts[r[0]] : '') + '</i></button>').join('') + '</div>'
      + '<input type="search" class="edb-search" id="edbSearch" placeholder="' + (_edb.range === 'all' ? 'Поиск по всей базе: имя или телефон' : 'Поиск по имени или телефону') + '" value="'
      + escAttr(_edb.range === 'all' ? _edb.base.search : _edb.search) + '" oninput="edbSearch(this.value)">'
      + (edIsAdmin() ? '<button class="btn btn-sec btn-sm" onclick="edOpenAutomation()">⚙ Автоматизация</button>' : '') + '</div>';
    return;
  }
  for (const r of ED_RANGES) {
    const b = edbEl('edbSeg-' + r[0]);
    if (b && counts[r[0]] !== undefined) b.innerHTML = esc(r[1]) + '<i>' + counts[r[0]] + '</i>';
  }
}

function edbChipsRender() {
  const d = _edb.data;
  const el = edbEl('edbChips');
  if (!el || !d) return;
  const dot = { no_contract: 'red', no_consent: 'red', act: 'red', waiting: 'blue', ready: 'green' };
  el.innerHTML = ED_CHIPS.map((c) => '<button class="edb-chip' + (_edb.chip === c[0] && !_edb.color ? ' on' : '') + '" onclick="edbSetChip(\'' + c[0] + '\')">'
    + (dot[c[0]] ? '<span class="edb-dot ed-c-' + dot[c[0]] + '" style="background:var(--c)"></span>' : '') + esc(c[1]) + ' <i>' + (d.chips[c[2]] || 0) + '</i></button>').join('');
}

function edbAutoRender() {
  const d = _edb.data;
  const el = edbEl('edbAuto');
  if (!el || !d) return;
  const a = d.automation;
  const parts = [
    'договор и согласие — ' + (a.previsit.on ? 'за ' + a.previsit.hours + ' ч до визита' + (a.previsit.scope === 'first' ? ' (первичным)' : '') : 'вручную'),
    'акт — ' + (a.act.on ? 'через ' + a.act.delayMin + ' мин после оплаты' : 'вручную'),
    'повтор неподписанного — ' + (a.remind.on ? 'через ' + a.remind.hours + ' ч' : 'выключен'),
  ];
  if ((a.previsit.on || a.act.on || a.remind.on) && a.senderName) parts.push('от имени: ' + a.senderName);
  el.innerHTML = '<div class="edb-auto">🤖 <span><b>Автоматизация:</b> ' + esc(parts.join(' · ')) + '</span>'
    + (edIsAdmin() ? '<button class="btn btn-sec btn-sm" onclick="edOpenAutomation()">Настроить</button>' : '') + '</div>';
}

function edbWarnsRender() {
  const d = _edb.data;
  const el = edbEl('edbWarns');
  if (!el || !d) return;
  const link = edIsAdmin() ? ' <button class="btn btn-sec btn-sm" onclick="edGo(\'settings\')">Настройки</button>' : '';
  el.innerHTML = (d.warnings || []).map((w) => {
    if (w.code === 'no_template') return '<div class="ed-note">Не загружен шаблон «' + esc(ED_KIND_LABELS[w.kind] || w.kind) + '» — карточки этот документ не проверяют.' + link + '</div>';
    if (w.code === 'org_missing') return '<div class="ed-note ed-note-bad">Не заполнены реквизиты клиники: ' + esc(w.fields.join(', ')) + ' — документы с ними не отправить.' + link + '</div>';
    return '';
  }).join('');
}

const EDB_EMPTY = { today: 'На сегодня записей нет', tomorrow: 'На завтра записей нет', week: 'На неделю записей нет', open: 'Незакрытых визитов нет — все документы подписаны' };

function edbCardsRender(flashKeys) {
  const d = _edb.data;
  const el = edbEl('edbCards');
  if (!el || !d) return;
  if (!d.cards.length) { el.innerHTML = '<div class="edb-empty">' + esc(EDB_EMPTY[_edb.range] || 'Пусто') + '</div>'; return; }
  const list = edFilterCards(d.cards, _edb.chip, _edb.color, _edb.search);
  if (!list.length) { el.innerHTML = '<div class="edb-empty">Под этот фильтр никто не попал</div>'; return; }
  const flash = new Set(flashKeys || []);
  const multiDay = _edb.range === 'week' || _edb.range === 'open';
  const groups = [];
  if (multiDay) {
    for (const c of list) {
      const g = groups[groups.length - 1];
      if (g && g.key === c.day) g.cards.push(c); else groups.push({ key: c.day, title: edDayLabel(c.day, d.today), cards: [c] });
    }
  } else {
    for (const [title, colors] of [['Требуют действия', ['red', 'amber']], ['Ждём пациента', ['blue']], ['Готово', ['green', 'grey']]]) {
      const cards = list.filter((c) => colors.indexOf(c.color) >= 0);
      if (cards.length) groups.push({ title, cards });
    }
  }
  el.innerHTML = groups.map((g) => '<div class="edb-group">' + esc(g.title) + ' · ' + g.cards.length + '</div><div class="edb-grid">'
    + g.cards.map((c) => edbCardHtml(c, flash.has(c.key), multiDay)).join('') + '</div>').join('');
}

function edbCardHtml(c, flash, multiDay) {
  const tiles = ['contract', 'consent_pd', 'act'].map((k) => '<div class="edb-doc ' + c.tiles[k].tone + '"><b>' + esc(ED_KIND_SHORT[k]) + '</b>' + esc(c.tiles[k].text) + '</div>').join('');
  const services = c.services.slice(0, 2).join(', ') + (c.services.length > 2 ? '…' : '');
  const visit = [multiDay ? edDayLabel(c.day, _edb.data.today) : '', c.time, services, c.staffName].filter(Boolean).join(' · ')
    + (c.visits.length > 1 ? ' · ' + c.visits.length + ' ' + edPlural(c.visits.length, 'визит', 'визита', 'визитов') : '');
  const warns = c.warnings.map((w) => '<div class="edb-warn' + (c.color === 'red' && /^⏱/.test(w) ? ' hot' : '') + '">' + esc(w) + '</div>').join('');
  const rid = c.action && c.action.recordId ? c.action.recordId : 0;
  return '<article class="edb-card ed-c-' + c.color + (flash ? ' flash' : '') + '" onclick="edbOpen(' + c.clientId + ',' + rid + ')">'
    + '<div class="edb-ch"><div class="edb-av">' + esc(c.initials) + '</div><div class="edb-who"><span class="edb-st">' + esc(c.label) + '</span>'
    + '<div class="edb-nm">' + esc(c.name) + '</div><div class="edb-vs">' + esc(visit) + '</div></div></div>'
    + '<div class="edb-docs">' + tiles + '</div>' + warns
    + '<div class="edb-cf"><span>' + esc(c.hint || '') + '</span>' + edbActionHtml(c) + '</div></article>';
}

function edbActionHtml(c) {
  const a = c.action;
  if (!a) return '';
  const k = escAttr(c.key);
  if (_edb.busy.has(c.key)) return '<button class="btn btn-pri btn-sm" disabled>Отправляем…</button>';
  if (a.type === 'fill') {
    return '<button class="edb-mini" title="Пациент заполнит данные сам по ссылке" onclick="event.stopPropagation();edbForm(\'' + k + '\')">✉ Анкета</button>'
      + '<button class="btn btn-pri btn-sm" onclick="event.stopPropagation();edbAct(\'' + k + '\')">' + esc(a.label) + '</button>';
  }
  if ((a.type === 'send' || a.type === 'remind') && !edCanSend()) {
    return '<button class="btn btn-sec btn-sm" title="' + escAttr(edSendBlockReason()) + '" onclick="event.stopPropagation();edbOpen(' + c.clientId + ',0)">Открыть</button>';
  }
  const wait = a.type === 'remind' && !edRemindReady(a);
  return '<button class="btn btn-pri btn-sm' + (a.ghost ? ' edb-ghost' : '') + '"' + (wait ? ' disabled title="Повторить можно через 15 минут после отправки"' : '')
    + ' onclick="event.stopPropagation();edbAct(\'' + k + '\')">' + esc(a.label) + '</button>';
}

function edbCard(key) { return (_edb.data && _edb.data.cards.find((c) => c.key === key)) || null; }
function edbOpen(clientId, recordId) { edGo('c/' + clientId + (recordId ? '/' + recordId : '')); }
function edbSetRange(r) { edGo(r === 'today' ? '' : 'r/' + r); }
function edbSetChip(chip) { _edb.chip = chip; _edb.color = ''; edbHeadRender(); edbChipsRender(); edbCardsRender([]); }
function edbSetColor(color) { _edb.color = _edb.color === color ? '' : color; _edb.chip = ''; edbHeadRender(); edbChipsRender(); edbCardsRender([]); }
function edbSearch(v) {
  clearTimeout(_edbSearchTimer);
  if (_edb.range === 'all') {
    _edb.base.search = v;
    _edb.base.page = 1;
    _edbSearchTimer = setTimeout(() => edbBaseLoad(_ed.loadSeq), 300);
    return;
  }
  _edb.search = v;
  _edbSearchTimer = setTimeout(() => edbCardsRender([]), 120);
}

async function edbAct(key) {
  const c = edbCard(key);
  if (!c || !c.action || _edb.busy.has(key)) return;
  const a = c.action;
  if (a.type === 'fill') { _edcOpenData = true; return edbOpen(c.clientId, a.recordId || 0); }
  if (a.type === 'send') return edbSend(c);
  if (a.type === 'remind') return edbRemind(c);
  if (a.type === 'form_remind') return edbFormRemind(c);
}
function edbForm(key) { const c = edbCard(key); if (c) edFormOpen(c.clientId, { recordId: c.action && c.action.recordId }); }

async function edbSend(c) {
  const a = c.action;
  const d = _edb.data;
  const tpl = a.kinds.map((k) => d.kinds[k]).filter(Boolean);
  if (tpl.length !== a.kinds.length) return notify('Нет шаблона одного из документов — загрузите его в настройках', 'err');
  const withAct = a.kinds.indexOf('act') >= 0;
  let actHtml = '';
  if (withAct) {
    let dr;
    try { dr = await api('GET', '/api/edocs/records/' + a.recordId + '/act-draft'); } catch (e) { return notify(e.message, 'err'); }
    actHtml = '<div class="ed-sub" style="margin-top:6px">Акт: ' + dr.lines.map((l) => esc(l.title)).join(', ') + ' — итого ' + esc(edMoney(dr.totals.total_sum))
      + '. Поправить строки можно на странице пациента.</div>';
  }
  const ok = await edConfirm({ title: 'Отправить на подпись?', ok: 'Отправить',
    html: '<b>' + esc(c.name) + '</b> получит SMS со ссылкой и подпишет документы кодом из SMS.<ul style="margin:8px 0 0 18px">'
      + tpl.map((t) => '<li>' + esc(t.title) + '</li>').join('') + '</ul>' + actHtml });
  if (!ok) return;
  _edb.busy.add(c.key);
  _ed.sending = true;
  edbCardsRender([]);
  let r;
  try { r = await edFetch('POST', '/api/edocs/packages', { json: { clientId: c.clientId, templateIds: tpl.map((t) => t.id), recordId: withAct ? a.recordId : null } }); }
  finally { _ed.sending = false; _edb.busy.delete(c.key); }
  if (edSendOutcome(r) !== 'package') edbRefresh(true); else edbCardsRender([]);
}

async function edbRemind(c) {
  if (!edRemindReady(c.action)) return notify('Повторить ссылку можно через 15 минут после отправки', 'err');
  const ok = await edConfirm({ title: 'Отправить ссылку ещё раз?', ok: 'Отправить', html: '<b>' + esc(c.name) + '</b> получит SMS со ссылкой на подписание ещё раз.' });
  if (!ok) return;
  _edb.busy.add(c.key);
  edbCardsRender([]);
  try {
    await api('POST', '/api/edocs/packages/' + c.action.packageId + '/permalink');
    notify('Ссылка отправлена пациенту ещё раз');
  } catch (e) { notify(e.message, 'err'); if (/Мой F\.Doc/.test(e.message)) edOpenMe(); }
  finally { _edb.busy.delete(c.key); }
  edbRefresh(true);
}

async function edbFormRemind(c) {
  _edb.busy.add(c.key);
  edbCardsRender([]);
  try {
    const r = await api('POST', '/api/edocs/forms/' + c.action.formId + '/send');
    if (r.ok) notify('Анкета отправлена повторно в ' + (ED_VIA[r.channel] || r.channel));
    else notify('Анкета не доставлена: ' + (r.error || 'нет ответа') + ' — покажите пациенту QR-код', 'err');
  } catch (e) { notify(e.message, 'err'); }
  finally { _edb.busy.delete(c.key); }
  edbRefresh(true);
}

// ── «Вся база»: все пациенты с флагами документов, серверный поиск и фильтр ──
function edbRenderBase(seq) {
  const box = edbEl('edView-board');
  box.innerHTML = '<div id="edbBar"></div><div class="edb-chips" id="edbBaseFilters"></div><div class="card" id="edbBaseList" style="padding:0"><div class="empty">Загрузка…</div></div>';
  edbBarRender(true);
  edbBaseFiltersRender();
  return edbBaseLoad(seq);
}
function edbBaseFiltersRender() {
  const el = edbEl('edbBaseFilters');
  if (el) el.innerHTML = ED_BASE_FILTERS.map((f) => '<button class="edb-chip' + (_edb.base.filter === f[0] ? ' on' : '') + '" onclick="edbBaseFilter(\'' + f[0] + '\')">' + esc(f[1]) + '</button>').join('');
}
function edbBaseFilter(f) { _edb.base.filter = f; _edb.base.page = 1; edbBaseFiltersRender(); edbBaseLoad(_ed.loadSeq); }
function edbBasePage(n) { _edb.base.page = Math.max(1, n); edbBaseLoad(_ed.loadSeq); }
async function edbBaseLoad(seq) {
  const el = edbEl('edbBaseList');
  if (!el) return;
  const b = _edb.base;
  let d;
  try { d = await api('GET', '/api/edocs/board/clients?filter=' + encodeURIComponent(b.filter) + '&page=' + b.page + '&search=' + encodeURIComponent(b.search || '')); }
  catch (e) { if (seq === _ed.loadSeq) el.innerHTML = '<div class="empty">' + esc(e.message) + '</div>'; return; }
  if (seq !== _ed.loadSeq || _edb.range !== 'all') return;
  const yes = (v) => (v ? '<span class="edb-yes">✓ есть</span>' : '<span class="edb-no">нет</span>');
  const pages = Math.max(1, Math.ceil(d.total / 50));
  el.innerHTML = '<div class="edb-base-row edb-base-head"><span>Пациент</span><span>Договор</span><span>Согласие ПД</span><span class="edb-col-hide">Незакрытые акты</span><span class="edb-col-hide">Последний визит</span></div>'
    + (d.rows.length ? d.rows.map((r) => '<div class="edb-base-row" onclick="edbOpen(' + r.id + ',0)"><span><b>' + esc(r.name || '—') + '</b><br><span class="ed-sub">' + esc(edPhone(r.phone)) + '</span></span>'
      + '<span>' + yes(r.contract) + '</span><span>' + yes(r.consent) + (r.pending ? ' <span class="badge bb">ждёт</span>' : '') + '</span>'
      + '<span class="edb-col-hide">' + (r.openActs ? '<span class="edb-no">' + r.openActs + '</span>' : '—') + '</span>'
      + '<span class="edb-col-hide">' + esc(r.lastVisitAt ? edFmtDate(String(r.lastVisitAt).slice(0, 10)) : '—') + '</span></div>').join('')
      : '<div class="empty">Никого не нашли</div>')
    + '<div class="edb-pager" style="padding:8px 12px">Всего: ' + d.total + (pages > 1 ? ' · стр. ' + d.page + ' из ' + pages
      + ' <button class="btn btn-sec btn-sm" onclick="edbBasePage(' + (d.page - 1) + ')"' + (d.page <= 1 ? ' disabled' : '') + '>‹</button>'
      + '<button class="btn btn-sec btn-sm" onclick="edbBasePage(' + (d.page + 1) + ')"' + (d.page >= pages ? ' disabled' : '') + '>›</button>' : '') + '</div>';
}
```

- [ ] **Step 6: Страница пациента**

Создать `frontend/js/pages/edocs-client.js`:

```js
// ── «📄 Документы»: страница пациента (спека 2026-10-25 §5) ─────────────────────────
// Шапка с четырьмя шагами, свёрнутый блок данных (красный и пульсирует, пока не хватает полей для
// неподписанных документов), карточки документов с выбором на подпись и ручной правкой, панель
// отправки, визиты с актами и история. Состояния документов и полноту данных считает сервер
// (GET /clients/:id/page → services/edocs/board.js). Паспорт расшифровывается только при раскрытии
// блока данных (GET /clients/:id/identity — каждый показ в журнал). Глобальные имена — edc*/ed*.
let _edc = { clientId: null, recordId: null, page: null, form: null, formLoaded: false, unsaved: false, source: 'manual', notes: [],
  selected: new Set(), act: null, actEdited: false, docDate: '', missingSel: null, checking: false };
let _edcOpenData = false;   // «Заполнить данные» с дашборда: раскрыть блок данных сразу
let _edForm = null;         // открытое окно анкеты: { clientId, formId, url, qr, expiresAt }
const ED_CLIENT_POLL_MS = 10000;
// [ключ, подпись, тип, заголовок группы (с этого поля), класс ширины]
const EDC_FIELDS = [
  ['last_name', 'Фамилия', 'text', 'Личные данные'], ['first_name', 'Имя', 'text'], ['middle_name', 'Отчество', 'text'],
  ['birth_date', 'Дата рождения', 'date'], ['gender', 'Пол', 'gender'], ['phone', 'Телефон', 'tel'], ['email', 'E-mail', 'email'],
  ['passport_series', 'Серия паспорта', 'digits', 'Паспорт РФ'], ['passport_number', 'Номер паспорта', 'digits'], ['issue_date', 'Дата выдачи', 'date'],
  ['authority_code', 'Код подразделения', 'text'], ['issued_by', 'Кем выдан', 'text', null, 'wide'], ['birth_place', 'Место рождения', 'text'],
  ['address', 'Адрес регистрации', 'text', 'Адрес', 'full'],
  ['contract_no', 'Номер договора', 'text', 'Договор'], ['contract_date', 'Дата договора', 'date'],
];
const EDC_STEP_LABELS = { data: 'Данные', contract: 'Договор', consent_pd: 'Согласие', act: 'Акт' };

function edcEl(id) { return document.getElementById(id); }

async function edcRender(route, seq) {
  const box = edcEl('edView-client');
  if (!box) return;
  if (_edc.clientId !== route.clientId) {
    _edc = { clientId: route.clientId, recordId: route.recordId, page: null, form: null, formLoaded: false, unsaved: false, source: 'manual', notes: [],
      selected: new Set(), act: null, actEdited: false, docDate: '', missingSel: null, checking: false };
  }
  _edc.recordId = route.recordId;
  box.innerHTML = '<div class="empty">Загрузка…</div>';
  await edcLoad(seq, false);
  if (seq === _ed.loadSeq) edcSchedule();
}

function edcNeedsPolling() {
  const p = _edc.page;
  if (!p) return false;
  return p.docs.contract.state === 'pending' || p.docs.consent_pd.state === 'pending' || p.visits.some((v) => v.act.state === 'pending')
    || !!(p.form && p.form.status === 'active');
}
function edcSchedule() {
  edClearTimer();
  if (edcNeedsPolling()) _ed.timer = setInterval(() => edcRefresh(false), ED_CLIENT_POLL_MS);
}
function edcRefresh(force) {
  if (_ed.route.view !== 'client') return;
  if (!force && typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
  edcLoad(_ed.loadSeq, true).then(() => edcSchedule());
}

async function edcLoad(seq, quiet) {
  let p;
  try { p = await api('GET', '/api/edocs/clients/' + _edc.clientId + '/page' + (_edc.recordId ? '?record=' + _edc.recordId : '')); } catch (e) {
    const box = edcEl('edView-client');
    if (!quiet && seq === _ed.loadSeq && box) box.innerHTML = '<div class="empty">' + esc(e.message) + '</div>';
    return;
  }
  if (seq !== _ed.loadSeq || _ed.route.view !== 'client' || _ed.route.clientId !== p.client.id) return;
  const first = !_edc.page;
  _edc.page = p;
  if (p.focusRecordId && (!_edc.act || _edc.act.recordId !== p.focusRecordId)) await edcLoadAct(p.focusRecordId);
  if (first) edcDefaultSelection();
  edcPaint(first);
  edcCheck();
}

/** Строки акта выбранного визита по умолчанию (из записи YClients). */
async function edcLoadAct(recordId) {
  try {
    const d = await api('GET', '/api/edocs/records/' + recordId + '/act-draft');
    _edc.act = { recordId, visitDate: d.record.visitDate, actNo: d.record.actNo, doctor: d.doctor, defaultTotal: d.totals.total_sum,
      rows: d.lines.map((l) => Object.assign({ include: true }, l)) };
  } catch (e) { _edc.act = { recordId, error: e.message, rows: [] }; }
  _edc.actEdited = false;
}

const EDC_BAD = ['missing', 'lapsed', 'problem'];
/** Выбор по умолчанию: всё, чего не хватает (договор, согласие, акт выбранного визита). */
function edcDefaultSelection() {
  const p = _edc.page;
  _edc.selected = new Set();
  for (const k of ['contract', 'consent_pd']) if (p.kinds[k] && EDC_BAD.indexOf(p.docs[k].state) >= 0) _edc.selected.add(p.kinds[k].id);
  const focus = edcFocus();
  if (p.kinds.act && focus && EDC_BAD.indexOf(focus.act.state) >= 0) _edc.selected.add(p.kinds.act.id);
}
function edcFocus() { const p = _edc.page; return (p && p.visits.find((v) => v.recordId === p.focusRecordId)) || null; }

function edcPaint(first) {
  const box = edcEl('edView-client');
  if (!box) return;
  if (first || !edcEl('edcHead')) {
    box.innerHTML = '<button class="edc-back" onclick="edcBack()">← Документы</button><div id="edcHead"></div>'
      + '<details id="edcData" class="edc-data" ontoggle="edcDataToggle(this)"><summary id="edcDataSum"></summary><div class="edc-body" id="edcDataBody"></div></details>'
      + '<div class="edc-docs-head"><div><div class="ed-sub">Комплект на подпись</div><div class="ed-h" style="margin:0">Документы</div></div>'
      + '<span class="ed-sub">Нажмите на карточку, чтобы добавить документ в отправку</span></div>'
      + '<div id="edcDocs" class="edc-docs"></div><div id="edcSend" class="edc-send"></div>'
      + '<div class="edc-two"><div class="card"><div class="ed-h2" style="margin-top:0">Визиты и акты</div><ul class="edc-tl" id="edcVisits"></ul></div>'
      + '<div class="card"><div class="ed-h2" style="margin-top:0">История</div><ul class="edc-tl" id="edcHistory"></ul></div></div>';
  }
  edcHeadRender();
  edcDataSumRender();
  edcDocsRender();
  edcSendRender();
  edcVisitsRender();
  edcHistoryRender();
  if (first && _edcOpenData) { _edcOpenData = false; const d = edcEl('edcData'); if (d) d.open = true; }
  else if (_edc.formLoaded && !_edc.unsaved) edcMarkMissing();
}

function edcBack() { if (window.history && window.history.length > 1) window.history.back(); else edGo(''); }

function edcHeadRender() {
  const p = _edc.page;
  const h = p.header;
  const el = edcEl('edcHead');
  if (!el) return;
  const meta = [];
  if (h.day) meta.push('📅 ' + edDayLabel(h.day, p.today) + (h.time ? ', ' + h.time : ''));
  if (h.services && h.services.length) meta.push(h.services.join(', '));
  if (h.staffName) meta.push(h.staffName);
  if (p.client.phone) meta.push('📞 ' + edPhone(p.client.phone));
  el.innerHTML = '<div class="edc-head ed-c-' + h.color + '"><div class="edb-av">' + esc(p.client.initials) + '</div>'
    + '<div style="min-width:0"><div class="ed-sub">' + (h.firstVisit ? 'Первичный пациент' : 'Пациент') + '</div><div class="edc-name">' + esc(p.client.name) + '</div>'
    + '<div class="edc-meta">' + meta.map((m) => '<span>' + esc(m) + '</span>').join('') + '</div></div>'
    + '<div class="edc-overall"><span class="edb-st">' + esc(h.label) + '</span><div class="edc-steps">'
    + h.steps.map((s) => '<span class="' + s.tone + '" title="' + escAttr(EDC_STEP_LABELS[s.key]) + '"></span>').join('')
    + '</div><div class="edc-steps-l">Данные · Договор · Согласие · Акт</div></div></div>'
    + (p.warnings.length ? '<div class="ed-sub" style="margin:-4px 0 10px">' + p.warnings.map(esc).join(' · ') + '</div>' : '');
}

function edcDataSumRender() {
  const p = _edc.page;
  const d = p.data;
  const det = edcEl('edcData');
  const sum = edcEl('edcDataSum');
  if (!det || !sum) return;
  const n = d.missing.length;
  det.className = 'edc-data ed-c-' + (n ? 'red' : 'green');
  sum.innerHTML = '<span class="edc-ico">' + (n ? '!' : '✓') + '</span><div><b>'
    + (n ? 'Данные пациента: не хватает ' + n + ' ' + edPlural(n, 'поля', 'полей', 'полей') : 'Данные пациента заполнены') + '</b><small>'
    + esc(n ? d.missing.map((x) => x.label.toLowerCase()).join(', ') + ' — без них документы не отправить. Заполните сами или отправьте пациенту анкету.'
      : 'Всё, что нужно для документов, есть. Нажмите, чтобы посмотреть или поправить.') + '</small></div><span class="edc-chev">▾</span>';
}

function edcDataToggle(det) {
  if (!det.open) return;
  if (!_edc.formLoaded) edcLoadIdentity(); else edcDataBodyRender();
}

async function edcLoadIdentity() {
  const body = edcEl('edcDataBody');
  if (body) body.innerHTML = '<div class="empty">Загрузка…</div>';
  const id = _edc.clientId;
  try {
    const ident = await api('GET', '/api/edocs/clients/' + id + '/identity');
    if (ident.exists) {
      _edc.form = Object.assign({}, ident.plain, ident.secure);
      _edc.unsaved = false;
      _edc.notes = [];
    } else {
      const pre = await api('GET', '/api/edocs/clients/' + id + '/identity/prefill');
      _edc.form = Object.assign({}, pre.plain, pre.secure);
      _edc.notes = (pre.notes || []).slice();
      _edc.unsaved = true;
    }
    if (_edc.clientId !== id) return;
    _edc.formLoaded = true;
  } catch (e) { if (body) body.innerHTML = '<div class="empty">' + esc(e.message) + '</div>'; return; }
  edcDataBodyRender();
}

function edcFieldHtml(f) {
  const key = f[0], label = f[1], type = f[2], cls = f[4] || '';
  const p = _edc.page;
  const val = _edc.form[key] === null || _edc.form[key] === undefined ? '' : String(_edc.form[key]);
  const required = p.data.required.indexOf(key) >= 0;
  const lbl = '<label class="fl" for="edcF-' + key + '">' + esc(label) + (required ? ' · обязательно' : '') + '</label>';
  let input;
  if (type === 'gender') {
    input = '<select id="edcF-gender" onchange="edcFormChanged()"><option value=""></option><option value="F"' + (val === 'F' ? ' selected' : '') + '>женский</option>'
      + '<option value="M"' + (val === 'M' ? ' selected' : '') + '>мужской</option></select>';
  } else {
    const t = type === 'date' ? 'date' : type === 'tel' ? 'tel' : type === 'email' ? 'email' : 'text';
    input = '<input type="' + t + '" id="edcF-' + key + '" value="' + escAttr(val) + '"' + (type === 'digits' ? ' inputmode="numeric"' : '') + ' oninput="edcFormChanged()">';
  }
  let hint = '';
  if (key === 'contract_no') {
    const nb = p.numbering || {};
    if (!val && nb.yclientsNo) hint = 'В YClients: № ' + nb.yclientsNo + ' — он и пойдёт в договор';
    else if (!val && nb.auto && nb.next) hint = 'Пусто — номер присвоится при отправке: ' + nb.next;
  }
  return '<div class="fg edc-f ' + cls + '" id="edcW-' + key + '">' + lbl + input + (hint ? '<div class="ed-sub">' + esc(hint) + '</div>' : '') + '</div>';
}

function edcDataBodyRender() {
  const body = edcEl('edcDataBody');
  if (!body || !_edc.formLoaded) return;
  const id = _edc.clientId;
  let fields = '';
  for (const f of EDC_FIELDS) {
    if (f[3]) fields += '<div class="edc-sect">' + esc(f[3]) + '</div>';
    fields += edcFieldHtml(f);
  }
  body.innerHTML = '<div class="edc-tools"><label class="btn btn-sec btn-sm ed-file">📷 Распознать паспорт по фото<input type="file" accept="image/*" onchange="edcRecognize(this)"></label>'
    + '<button class="btn btn-sec btn-sm" onclick="edcPrefill()">↻ Подставить из YClients</button>'
    + '<button class="btn btn-sec btn-sm" onclick="edFormOpen(' + id + ')">✉ Анкета пациенту</button></div>'
    + (_edc.notes.length ? '<div class="ed-note">' + _edc.notes.map(esc).join('<br>') + '</div>' : '')
    + '<div class="edc-fields">' + fields + '</div>'
    + '<div class="ed-actions"><button class="btn btn-pri" id="edcSaveBtn" onclick="edcSaveIdentity()">Сохранить данные</button>'
    + '<span class="ed-sub" id="edcIdentityState">' + (_edc.unsaved ? 'Данные ещё не сохранены' : 'Сохранено') + '</span></div>';
  edcMarkMissing();
}

/** Подсветить недостающие обязательные поля по ТЕКУЩИМ значениям формы. */
function edcMarkMissing() {
  const p = _edc.page;
  if (!p || !_edc.formLoaded) return;
  const miss = new Set(p.data.missing.map((x) => x.key));
  for (const f of EDC_FIELDS) {
    const w = edcEl('edcW-' + f[0]);
    if (w) w.classList.toggle('miss', miss.has(f[0]) && !String(_edc.form[f[0]] || '').trim());
  }
}

function edcCaptureForm() {
  if (!_edc.form) return;
  for (const f of EDC_FIELDS) {
    const el = edcEl('edcF-' + f[0]);
    if (el) _edc.form[f[0]] = el.value;
  }
}
function edcFormChanged() {
  edcCaptureForm();
  _edc.unsaved = true;
  const s = edcEl('edcIdentityState');
  if (s) s.textContent = 'Есть несохранённые изменения';
  edcMarkMissing();
  edcSendRender();
}

async function edcSaveIdentity() {
  edcCaptureForm();
  const btn = edcEl('edcSaveBtn');
  if (btn) btn.disabled = true;
  try {
    await api('PUT', '/api/edocs/clients/' + _edc.clientId + '/identity', edIdentityBody((k) => _edc.form[k], _edc.source));
    _edc.unsaved = false;
    _edc.source = 'manual';
    _edc.notes = [];
    notify('Данные пациента сохранены');
    await edcLoad(_ed.loadSeq, true);
    edcDataBodyRender();
  } catch (e) { notify(e.message, 'err'); } finally { if (btn) btn.disabled = false; }
}

async function edcPrefill() {
  try {
    const pre = await api('GET', '/api/edocs/clients/' + _edc.clientId + '/identity/prefill');
    edcCaptureForm();
    let n = 0;
    for (const [k, v] of Object.entries(Object.assign({}, pre.plain, pre.secure))) {
      if (v && !String(_edc.form[k] || '').trim()) { _edc.form[k] = v; n++; }
    }
    _edc.notes = (pre.notes || []).slice();
    if (n) _edc.unsaved = true;
    edcDataBodyRender();
    notify(n ? 'Подставлено полей: ' + n + ' — проверьте и сохраните' : 'Пустых полей, которые знает YClients, нет');
  } catch (e) { notify(e.message, 'err'); }
}

async function edcRecognize(input) {
  const file = input.files && input.files[0];
  input.value = '';
  if (!file) return;
  const id = _edc.clientId;
  const fd = new FormData();
  fd.append('photo', file);
  notify('Распознаём паспорт…');
  const r = await edFetch('POST', '/api/edocs/clients/' + id + '/identity/recognize', { form: fd });
  if (!r.ok) { notify(r.body.error || 'Не удалось распознать', 'err'); if (r.body.code === 'fdoc_no_credentials' || r.body.code === 'fdoc_credentials_invalid') edOpenMe(); return; }
  if (_edc.clientId !== id) return;
  edcCaptureForm();
  Object.assign(_edc.form, r.body.plain || {}, r.body.secure || {});
  _edc.source = 'recognize';
  _edc.unsaved = true;
  _edc.notes = [r.body.confidence ? 'Поля заполнены по фото — проверьте их и нажмите «Сохранить данные»' : 'Распознано неуверенно — внимательно проверьте каждое поле'];
  if (r.body.spoofing && r.body.spoofing.length) _edc.notes.push('F.Doc сомневается в подлинности снимка (' + r.body.spoofing.join(', ') + ') — сверьте с оригиналом паспорта');
  edcDataBodyRender();
}

// ── карточки документов ──
function edcTone(st) {
  if (st.state === 'signed') return 'green';
  if (st.state === 'pending') return 'blue';
  if (EDC_BAD.indexOf(st.state) >= 0) return _edc.page.header.color === 'amber' ? 'amber' : 'red';
  return 'grey';
}
function edcDocCard(kind, tpl, st, visit) {
  const sel = _edc.selected.has(tpl.id);
  const icon = { contract: '📜', consent_pd: '🔒', act: '🧾', other: '📄' }[kind] || '📄';
  const title = kind === 'act' && visit ? tpl.title + ' · визит ' + edFmtDate(visit.day) : tpl.title;
  const neuter = kind === 'consent_pd';
  let cls = 'ed-c-' + edcTone(st), sub = '', status = '', acts = '', badge = '', selectable = false;
  const icons = (withEdit) => '<button class="edc-ib" title="Посмотреть документ (DOCX)" onclick="event.stopPropagation();edcPreview(' + tpl.id + ')">👁</button>'
    + (withEdit ? '<button class="edc-ib" title="Ручная правка" onclick="event.stopPropagation();edcEdit(\'' + kind + '\',' + tpl.id + ')">✎</button>' : '')
    + '<button class="edc-ib" title="Подписано на бумаге" onclick="event.stopPropagation();edcPaperOpen(' + tpl.id + ')">📎</button>';
  if (st.state === 'signed') {
    cls += ' done';
    badge = neuter ? 'Подписано' : 'Подписан';
    sub = badge + ' ' + edFmtDateTime(st.at).slice(0, 10) + (st.paper ? ' на бумаге' : ' по SMS');
    status = '✓ ' + badge;
    acts = st.packageId ? '<button class="edc-ib" title="Комплект" onclick="event.stopPropagation();edGo(\'p/' + st.packageId + '\')">📂</button>' : '';
  } else if (st.state === 'pending') {
    cls += ' done';
    badge = 'Ждём подпись';
    sub = 'Отправлен ' + edFmtDateTime(st.at) + ' — пациент подписывает по SMS-ссылке';
    status = '● Ждём подпись';
    acts = '<button class="edc-ib" title="Отправить ссылку ещё раз" onclick="event.stopPropagation();edcRemind(\'' + st.packageId + '\')">↻</button>'
      + '<button class="edc-ib" title="Комплект" onclick="event.stopPropagation();edGo(\'p/' + st.packageId + '\')">📂</button>';
  } else if (EDC_BAD.indexOf(st.state) >= 0) {
    selectable = true;
    sub = kind === 'act' ? (st.state === 'missing' ? 'Визит оплачен в YClients — нужен акт' : '')
      : (st.state === 'missing' ? 'Обязателен до визита' : '');
    if (st.state === 'lapsed') sub = 'Прошлая ссылка: ' + ({ expired: 'срок истёк', declined: 'пациент отказался', annulled: 'аннулирована' }[st.reason] || 'не действует');
    if (st.state === 'problem') sub = 'Прошлая отправка не ушла' + (st.error ? ': ' + st.error : '');
    status = '● ' + (neuter ? 'Не подписано' : 'Не подписан');
    acts = icons(true);
  } else if (kind === 'act' && (st.state === 'later' || st.state === 'unpaid')) {
    cls += ' na';
    sub = st.state === 'later' ? 'Визит ещё не состоялся — акт после оплаты' : 'Визит не оплачен в YClients — акт после оплаты';
    status = '○ После визита';
  } else if (kind === 'act' && st.state === 'off' && st.reason === 'before_start') {
    selectable = true;
    sub = 'Визит до ' + edFmtDate(_edc.page.actsRequiredFrom) + ' — акт не обязателен, но его можно отправить';
    status = '○ Не обязателен';
    acts = icons(true);
  } else {
    cls += ' na';
    sub = 'Нет шаблона';
  }
  if (selectable && sel) cls += ' sel';
  return '<article class="edc-doc ' + cls + '"' + (selectable ? ' onclick="edcToggle(' + tpl.id + ')"' : '') + '>'
    + (selectable ? '<span class="edc-chk">' + (sel ? '✓' : '') + '</span>' : (badge ? '<span class="edc-badge">' + esc(badge) + '</span>' : ''))
    + '<div class="edc-sheet">' + icon + '</div><h3>' + esc(title) + '</h3><div class="edc-dsub">' + esc(sub) + '</div>'
    + '<div class="edc-dst">' + esc(status) + '<span class="edc-dact">' + acts + '</span></div></article>';
}

function edcDocsRender() {
  const p = _edc.page;
  const el = edcEl('edcDocs');
  if (!el) return;
  const cards = [];
  const missingTpl = (label) => '<article class="edc-doc na"><div class="edc-sheet">📄</div><h3>' + esc(label) + '</h3><div class="edc-dsub">Шаблон не загружен'
    + (edIsAdmin() ? ' — <a href="#edocs/settings">загрузить в настройках</a>' : ' — обратитесь к администратору') + '</div></article>';
  for (const k of ['contract', 'consent_pd']) cards.push(p.kinds[k] ? edcDocCard(k, p.kinds[k], p.docs[k]) : missingTpl(ED_KIND_LABELS[k]));
  const focus = edcFocus();
  if (p.kinds.act) {
    if (focus) cards.push(edcDocCard('act', p.kinds.act, focus.act, focus));
    else cards.push('<article class="edc-doc na"><div class="edc-sheet">🧾</div><h3>' + esc(p.kinds.act.title) + '</h3><div class="edc-dsub">Появится после оплаченного визита</div></article>');
  }
  for (const t of p.templates.filter((x) => x.kind === 'other')) {
    const sel = _edc.selected.has(t.id);
    cards.push('<article class="edc-doc ed-c-grey' + (sel ? ' sel' : '') + '" onclick="edcToggle(' + t.id + ')"><span class="edc-chk">' + (sel ? '✓' : '') + '</span>'
      + '<div class="edc-sheet">📄</div><h3>' + esc(t.title) + '</h3><div class="edc-dsub">Дополнительный документ — по необходимости</div>'
      + '<div class="edc-dst">○ По необходимости<span class="edc-dact"><button class="edc-ib" title="Посмотреть документ (DOCX)" onclick="event.stopPropagation();edcPreview(' + t.id + ')">👁</button>'
      + '<button class="edc-ib" title="Подписано на бумаге" onclick="event.stopPropagation();edcPaperOpen(' + t.id + ')">📎</button></span></div></article>');
  }
  el.innerHTML = cards.join('');
}

function edcTemplate(id) { return (_edc.page && _edc.page.templates.find((t) => t.id === id)) || null; }
function edcSelectedTemplates() { return [..._edc.selected].map(edcTemplate).filter(Boolean); }
function edcToggle(id) {
  const t = edcTemplate(id);
  if (!t) return;
  if (_edc.selected.has(id)) _edc.selected.delete(id); else _edc.selected.add(id);
  _edc.missingSel = null;
  edcDocsRender();
  edcSendRender();
  edcCheck();
}

/** Проверка выбранного набора на сервере: каких данных не хватает именно ему. */
async function edcCheck() {
  const ids = [..._edc.selected];
  if (!ids.length || !_edc.page) { _edc.missingSel = null; edcSendRender(); return; }
  _edc.checking = true;
  try {
    const r = await api('POST', '/api/edocs/packages/check', { clientId: _edc.clientId, templateIds: ids });
    if (String([..._edc.selected]) !== String(ids)) return;   // выбор сменился, пока проверяли
    _edc.missingSel = r.missing;
  } catch (e) { _edc.missingSel = null; } finally { _edc.checking = false; }
  edcSendRender();
}

function edcBlockReason() {
  if (!_edc.selected.size) return 'Нажмите на карточку документа, чтобы добавить его в отправку';
  if (_edc.unsaved) return 'Сохраните данные пациента: документы заполняются из сохранённых данных';
  const t = edMissingText(_edc.missingSel);
  if (t) return t;
  return edSendBlockReason();
}

function edcSendRender() {
  const el = edcEl('edcSend');
  if (!el || !_edc.page) return;
  const sel = edcSelectedTemplates();
  const reason = edcBlockReason();
  const phone = _edc.page.client.phone ? edPhone(_edc.page.client.phone) : 'номер не указан';
  el.innerHTML = '<div class="grow">' + esc(sel.length ? 'Выбрано: ' + sel.map((t) => t.title).join(', ') : 'Ничего не выбрано')
    + '<small>' + esc(reason || ('SMS-ссылка F.Doc на ' + phone + ' · пациент подпишет кодом из SMS')) + '</small></div>'
    + '<button class="btn btn-sec btn-sm" onclick="edcPaperOpen()">Подписано на бумаге</button>'
    + '<button class="btn btn-sec btn-sm" onclick="edcPreviewSelected()">Предпросмотр</button>'
    + '<button class="btn btn-pri" id="edcSendBtn" onclick="edcSend()"' + (reason || _ed.sending ? ' disabled' : '') + '>' + (_ed.sending ? 'Отправляем…' : 'Отправить на подпись →') + '</button>';
}

/** Тело запроса к /packages и /packages/preview: визит и правленые строки, если в наборе акт. */
function edcActFields(body, templateIds) {
  const act = _edc.page.kinds.act;
  if (!act || templateIds.indexOf(act.id) < 0) return null;
  const focus = edcFocus();
  if (!focus) return 'Выберите визит для акта';
  body.recordId = focus.recordId;
  if (_edc.actEdited && _edc.act && _edc.act.recordId === focus.recordId) {
    const lines = edCollectActLines(_edc.act.rows);
    if (lines.error) return lines.error;
    body.actLines = lines.value;
  }
  return null;
}

async function edcSend() {
  if (_ed.sending || edcBlockReason()) return;
  const ids = [..._edc.selected];
  const body = { clientId: _edc.clientId, templateIds: ids, docDate: _edc.docDate || null };
  const err = edcActFields(body, ids);
  if (err) return notify(err, 'err');
  const titles = edcSelectedTemplates().map((t) => '<li>' + esc(t.title) + '</li>').join('');
  const actNote = body.recordId && _edc.act && _edc.act.rows ? '<div class="ed-sub" style="margin-top:6px">Акт: итого '
    + esc(edMoney(edActTotals(_edc.act.rows.filter((r) => r.include)).total)) + (_edc.actEdited ? ' (строки поправлены вручную)' : '') + '</div>' : '';
  const ok = await edConfirm({ title: 'Отправить на подпись?', ok: 'Отправить',
    html: '<b>' + esc(_edc.page.client.name) + '</b> получит SMS со ссылкой и подпишет документы кодом из SMS.<ul style="margin:8px 0 0 18px">' + titles + '</ul>' + actNote });
  if (!ok) return;
  _ed.sending = true;
  edcSendRender();
  let r;
  try { r = await edFetch('POST', '/api/edocs/packages', { json: body }); } finally { _ed.sending = false; }
  const out = edSendOutcome(r);
  if (out === 'package') return;
  if (out === 'rejected') {
    if (r.body && r.body.code === 'missing_fields') _edc.missingSel = r.body.missing;
    edcSendRender();
    return;
  }
  _edc.selected = new Set();
  _edc.actEdited = false;
  await edcLoad(_ed.loadSeq, true);
  edcSchedule();
}

async function edcPreview(templateId) {
  const body = { clientId: _edc.clientId, templateId: templateId, docDate: _edc.docDate || null };
  const err = edcActFields(body, [templateId]);
  if (err) return notify(err, 'err');
  try {
    const r = await api('POST', '/api/edocs/packages/preview', body);
    edDownloadBase64(r.base64, r.fileName, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    if (_edc.unsaved) notify('Документ собран по СОХРАНЁННЫМ данным — сохраните изменения, чтобы они попали в документ');
  } catch (e) { notify(e.message, 'err'); }
}
function edcPreviewSelected() {
  const ids = [..._edc.selected];
  if (!ids.length) return notify('Выберите документ', 'err');
  ids.slice(0, 3).forEach((id) => edcPreview(id));
}

async function edcRemind(packageId) {
  const ok = await edConfirm({ title: 'Отправить ссылку ещё раз?', ok: 'Отправить', html: 'Пациент получит SMS со ссылкой на подписание ещё раз.' });
  if (!ok) return;
  try { await api('POST', '/api/edocs/packages/' + packageId + '/permalink'); notify('Ссылка отправлена пациенту ещё раз'); }
  catch (e) { notify(e.message, 'err'); if (/Мой F\.Doc/.test(e.message)) edOpenMe(); }
}

// ── ручная правка ──
function edcEdit(kind, templateId) {
  if (kind === 'act') return edcActEdit();
  return edcDocEdit(kind, templateId);
}

function edcActEdit() {
  const a = _edc.act;
  const box = edcEl('edActBody');
  if (!box) return;
  if (!a || a.error) { notify((a && a.error) || 'Выберите визит для акта', 'err'); return; }
  const cell = (i, key, val, mode) => '<td><input type="text"' + (mode ? ' inputmode="decimal"' : '') + ' value="' + escAttr(String(val === null || val === undefined ? '' : val))
    + '" oninput="edcActCell(' + i + ',\'' + key + '\',this.value)"></td>';
  box.innerHTML = '<div class="ed-sub">Врач: ' + esc(a.doctor.name || '—') + (a.doctor.position ? ', ' + esc(a.doctor.position) : '') + ' · визит ' + esc(edFmtDate(a.visitDate))
    + ' · номер акта ' + esc(a.actNo) + '. Правка действует только для этого акта.</div>'
    + '<div class="tw mtbl-wrap"><table class="ed-act-edit mtbl"><thead><tr><th></th><th>Услуга</th><th>Кол-во</th><th>Цена</th><th>Сумма</th></tr></thead><tbody>'
    + a.rows.map((r, i) => '<tr class="' + (r.include ? '' : 'off') + '"><td><input type="checkbox"' + (r.include ? ' checked' : '') + ' onchange="edcActCell(' + i + ',\'include\',this.checked)"></td>'
      + cell(i, 'title', r.title) + cell(i, 'qty', r.qty, true) + cell(i, 'price', r.price, true) + cell(i, 'sum', r.sum, true) + '</tr>').join('')
    + '</tbody></table></div><div class="ed-actions"><button class="btn btn-sec btn-sm" onclick="edcActAdd()">＋ Строка</button>'
    + '<button class="btn btn-sec btn-sm" onclick="edcActReset()">↺ Как в YClients</button><span class="ed-total" id="edcActTotal"></span></div>'
    + '<div id="edcActDiff"></div><div class="ed-actions"><button class="btn btn-pri" onclick="edcActSave()">Сохранить</button>'
    + '<button class="btn btn-sec" onclick="edcPreviewAct()">Предпросмотр</button></div>';
  openModal('edActModal');
  edcActTotal();
}
function edcActCell(i, key, val) {
  _edc.act.rows[i][key] = val;
  if (key === 'include') edcActEdit(); else edcActTotal();
}
function edcActAdd() { _edc.act.rows.push({ include: true, title: '', qty: 1, price: 0, sum: 0, service_id: null }); edcActEdit(); }
async function edcActReset() { const id = _edc.act.recordId; await edcLoadAct(id); edcActEdit(); edcSendRender(); }
function edcActTotal() {
  const a = _edc.act;
  const total = edActTotals(a.rows.filter((r) => r.include)).total;
  const el = edcEl('edcActTotal');
  if (el) el.textContent = 'Итого: ' + edMoney(total);
  const diff = edcEl('edcActDiff');
  if (diff) diff.innerHTML = Math.abs(total - Number(a.defaultTotal || 0)) > 0.004
    ? '<div class="ed-diff">Итог отличается от записи YClients (' + esc(edMoney(a.defaultTotal)) + '). Проверьте строки перед отправкой.</div>' : '';
}
function edcActSave() {
  const lines = edCollectActLines(_edc.act.rows);
  if (lines.error) return notify(lines.error, 'err');
  _edc.actEdited = true;
  closeModal('edActModal');
  notify('Строки акта сохранены — они уйдут в документ при отправке');
  edcSendRender();
}
function edcPreviewAct() {
  const lines = edCollectActLines(_edc.act.rows);
  if (lines.error) return notify(lines.error, 'err');
  _edc.actEdited = true;
  edcPreview(_edc.page.kinds.act.id);
}

async function edcDocEdit(kind, templateId) {
  const box = edcEl('edDocBody');
  const t = edcTemplate(templateId);
  if (!box || !t) return;
  edcEl('edDocTitle').textContent = 'Правка: ' + t.title;
  let html = '<div class="ed-sub" style="margin-bottom:10px">Значения, которые подставятся в документ. Шаблон клиники не меняется.</div>';
  if (kind === 'contract') {
    if (!_edc.formLoaded) { box.innerHTML = '<div class="empty">Загрузка…</div>'; openModal('edDocModal'); await edcLoadIdentity(); }
    const nb = _edc.page.numbering || {};
    const ph = nb.yclientsNo ? 'из YClients: ' + nb.yclientsNo : nb.auto && nb.next ? 'присвоится при отправке: ' + nb.next : '';
    html += '<div class="fg"><label class="fl" for="edcE-no">Номер договора</label><input id="edcE-no" value="' + escAttr(_edc.form.contract_no || '') + '" placeholder="' + escAttr(ph) + '"></div>'
      + '<div class="fg"><label class="fl" for="edcE-date">Дата договора</label><input type="date" id="edcE-date" value="' + escAttr(_edc.form.contract_date || '') + '"></div>';
  }
  html += '<div class="fg"><label class="fl" for="edcE-doc">Дата документа (пусто — сегодня)</label><input type="date" id="edcE-doc" value="' + escAttr(_edc.docDate) + '"></div>'
    + '<div class="ed-actions"><button class="btn btn-pri" onclick="edcDocSave(\'' + kind + '\',' + templateId + ')">Сохранить</button>'
    + '<button class="btn btn-sec" onclick="edcDocSave(\'' + kind + '\',' + templateId + ',true)">Предпросмотр</button></div>';
  box.innerHTML = html;
  openModal('edDocModal');
}
async function edcDocSave(kind, templateId, preview) {
  _edc.docDate = edVal('edcE-doc');
  if (kind === 'contract') {
    const no = edVal('edcE-no').trim(), date = edVal('edcE-date');
    if (no !== String(_edc.form.contract_no || '') || date !== String(_edc.form.contract_date || '')) {
      _edc.form.contract_no = no;
      _edc.form.contract_date = date;
      try {
        await api('PUT', '/api/edocs/clients/' + _edc.clientId + '/identity', edIdentityBody((k) => _edc.form[k], 'manual'));
        _edc.unsaved = false;
      } catch (e) { return notify(e.message, 'err'); }
      await edcLoad(_ed.loadSeq, true);
      if (edcEl('edcData') && edcEl('edcData').open) edcDataBodyRender();
    }
  }
  if (preview) return edcPreview(templateId);
  closeModal('edDocModal');
  notify('Сохранено');
}

// ── «Подписано на бумаге» ──
function edcPaperOpen(templateId) {
  const p = _edc.page;
  const box = edcEl('edPaperBody');
  if (!box || !p) return;
  const focus = edcFocus();
  const pre = templateId ? new Set([templateId]) : new Set(_edc.selected);
  const opts = [];
  for (const k of ['contract', 'consent_pd']) if (p.kinds[k]) opts.push({ t: p.kinds[k], label: p.kinds[k].title });
  if (p.kinds.act && focus && focus.arrived) opts.push({ t: p.kinds.act, label: p.kinds.act.title + ' · визит ' + edFmtDate(focus.day) });
  for (const t of p.templates.filter((x) => x.kind === 'other')) opts.push({ t, label: t.title });
  box.innerHTML = '<div class="ed-sub" style="margin-bottom:8px">Документ будет считаться подписанным. Приложите фото или скан — он сохранится у пациента.</div>'
    + opts.map((o) => '<label class="ed-switch"><input type="checkbox" class="edcP-t" value="' + o.t.id + '"' + (pre.has(o.t.id) ? ' checked' : '') + '> ' + esc(o.label) + '</label>').join('')
    + '<div class="fg" style="margin-top:10px"><label class="fl" for="edcP-date">Дата подписания</label><input type="date" id="edcP-date" value="' + escAttr(p.today) + '"></div>'
    + '<div class="fg"><label class="fl" for="edcP-note">Комментарий</label><input id="edcP-note" placeholder="необязательно"></div>'
    + '<div class="fg"><label class="fl" for="edcP-file">Скан или фото (JPG, PNG, WEBP, PDF до 10 МБ)</label><input type="file" id="edcP-file" accept="image/jpeg,image/png,image/webp,application/pdf"></div>'
    + '<div class="ed-actions"><button class="btn btn-pri" id="edcP-btn" onclick="edcPaperSave()">Отметить подписанным</button><button class="btn btn-sec" onclick="closeModal(\'edPaperModal\')">Отмена</button></div>';
  openModal('edPaperModal');
}
async function edcPaperSave() {
  const ids = Array.from(document.querySelectorAll('.edcP-t')).filter((c) => c.checked).map((c) => Number(c.value));
  if (!ids.length) return notify('Отметьте документы', 'err');
  const fd = new FormData();
  fd.append('templateIds', ids.join(','));
  const act = _edc.page.kinds.act;
  const focus = edcFocus();
  if (act && ids.indexOf(act.id) >= 0 && focus) fd.append('recordId', String(focus.recordId));
  fd.append('signedDate', edVal('edcP-date'));
  fd.append('note', edVal('edcP-note'));
  const file = edcEl('edcP-file').files[0];
  if (file) fd.append('scan', file);
  const btn = edcEl('edcP-btn');
  if (btn) btn.disabled = true;
  const r = await edFetch('POST', '/api/edocs/clients/' + _edc.clientId + '/paper', { form: fd });
  if (btn) btn.disabled = false;
  if (!r.ok) return notify(r.body.error || ('Ошибка ' + r.status), 'err');
  closeModal('edPaperModal');
  notify('Отмечено: подписано на бумаге');
  for (const id of ids) _edc.selected.delete(id);
  await edcLoad(_ed.loadSeq, true);
}

// ── визиты и история ──
function edcVisitsRender() {
  const p = _edc.page;
  const el = edcEl('edcVisits');
  if (!el) return;
  if (!p.visits.length) { el.innerHTML = '<li class="ed-sub">Визитов за последние 90 дней и ближайший месяц нет</li>'; return; }
  const dot = { ok: 'green', wait: 'blue', no: 'red', soon: 'amber', na: 'grey' };
  el.innerHTML = p.visits.map((v) => '<li class="click' + (v.recordId === p.focusRecordId ? ' focus' : '') + '" onclick="edcSetFocus(' + v.recordId + ')">'
    + '<span class="edc-tdot ed-c-' + (dot[v.tile.tone] || 'grey') + '" style="background:var(--c)"></span><time>' + esc(edFmtDate(v.day).slice(0, 5) + (v.time ? ' · ' + v.time : '')) + '</time>'
    + '<span class="grow">' + esc(v.services.join(', ') || '—') + (v.staffName ? ' · ' + esc(v.staffName) : '') + ' — акт: ' + esc(v.tile.text) + '</span></li>').join('');
}
async function edcSetFocus(recordId) {
  if (!_edc.page || recordId === _edc.page.focusRecordId) return;
  _edc.recordId = recordId;
  _ed.route = { view: 'client', clientId: _edc.clientId, recordId };
  history.replaceState(null, '', '#edocs/' + edTailOf(_ed.route));
  const act = _edc.page.kinds.act;
  if (act) _edc.selected.delete(act.id);
  await edcLoad(_ed.loadSeq, true);
  const focus = edcFocus();
  if (act && focus && EDC_BAD.indexOf(focus.act.state) >= 0) { _edc.selected.add(act.id); edcDocsRender(); edcSendRender(); edcCheck(); }
}

function edcHistoryRender() {
  const p = _edc.page;
  const el = edcEl('edcHistory');
  if (!el) return;
  if (!p.events.length) { el.innerHTML = '<li class="ed-sub">Событий пока нет</li>'; return; }
  const color = (k) => (/error|revoke|expired/.test(k) ? 'red' : /sent|send|permalink|form_created|form_opened/.test(k) ? 'blue' : /paper|submitted|pdf|docs_sent/.test(k) ? 'green' : 'grey');
  el.innerHTML = p.events.map((e) => '<li' + (e.packageId ? ' class="click" onclick="edGo(\'p/' + e.packageId + '\')"' : '') + '>'
    + '<span class="edc-tdot ed-c-' + color(e.kind) + '" style="background:var(--c)"></span><time>' + esc(edFmtDateTime(e.createdAt)) + '</time><span class="grow">'
    + esc(ED_EVENT_LABELS[e.kind] || e.kind) + (e.kind === 'status' && e.payload && e.payload.to ? ': ' + esc(edStatusInfo(e.payload.to).label) : '')
    + (e.kind === 'contract_no' && e.payload && e.payload.contractNo ? ' № ' + esc(e.payload.contractNo) : '')
    + (e.payload && e.payload.channel ? ' (' + esc(ED_VIA[e.payload.channel] || e.payload.channel) + ')' : '')
    + (e.userName ? ' · ' + esc(e.userName) : '') + '</span></li>').join('');
}

// ── анкета пациента: окно с QR и ссылкой (страница пациента и дашборд) ──
async function edFormOpen(clientId, opts) {
  opts = opts || {};
  const box = edcEl('edFormBody');
  if (!box) return;
  box.innerHTML = '<div class="empty">Готовим ссылку…</div>';
  openModal('edFormModal');
  const page = _edc.page && _edc.page.client.id === clientId ? _edc.page : null;
  const active = opts.formId || (page && page.form && page.form.status === 'active' ? page.form.id : null);
  let f;
  try {
    f = active ? await api('GET', '/api/edocs/forms/' + active + '/link')
      : await api('POST', '/api/edocs/clients/' + clientId + '/forms', { deliver: 'none', sendDocs: edCanSend(), recordId: opts.recordId || null });
  } catch (e) { box.innerHTML = '<div class="empty">' + esc(e.message) + '</div>'; return; }
  _edForm = Object.assign({ clientId: clientId }, f);
  edFormRender('');
  if (!active) edRefreshView();
}
function edFormRender(note) {
  const f = _edForm;
  const box = edcEl('edFormBody');
  if (!box || !f) return;
  box.innerHTML = '<div class="ed-qr"><img src="' + escAttr(f.qr) + '" alt="QR-код анкеты"><div class="grow"><div style="font-size:13px;line-height:1.5">'
    + 'Пациент сканирует код своим телефоном и сам вносит паспорт — вводить ничего не нужно.' + (edCanSend() ? ' Сразу после заполнения документы уйдут на подпись.' : '')
    + '</div><div class="ed-urlbox">' + esc(f.url) + '</div><div class="ed-sub">Ссылка действует до ' + esc(edFmtDateTime(f.expiresAt)) + '</div></div></div>'
    + (note ? '<div class="ed-note" style="margin-top:10px">' + esc(note) + '</div>' : '')
    + '<div class="ed-actions"><button class="btn btn-pri" id="edFormSendBtn" onclick="edFormSend()">✉ Отправить в мессенджер</button>'
    + '<button class="btn btn-sec" onclick="edFormCopy()">Скопировать ссылку</button><button class="btn btn-sec btn-dng" onclick="edFormRevoke()">Отозвать</button>'
    + '<button class="btn btn-sec" onclick="closeModal(\'edFormModal\')">Готово</button></div>';
}
async function edFormSend() {
  const f = _edForm;
  if (!f) return;
  const btn = edcEl('edFormSendBtn');
  if (btn) btn.disabled = true;
  try {
    const r = await api('POST', '/api/edocs/forms/' + f.formId + '/send');
    edFormRender(r.ok ? 'Отправлено в ' + (ED_VIA[r.channel] || r.channel) + '. Как только пациент заполнит анкету, страница обновится сама.'
      : 'Не доставлено: ' + (r.error || 'нет ответа') + ' — покажите пациенту QR-код.');
  } catch (e) { edFormRender(e.message); }
  edRefreshView();
}
function edFormCopy() {
  const f = _edForm;
  if (!f) return;
  if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(f.url).then(() => notify('Ссылка скопирована'), () => notify('Не удалось скопировать — выделите ссылку вручную', 'err'));
  else notify('Выделите ссылку и скопируйте вручную', 'err');
}
async function edFormRevoke() {
  const f = _edForm;
  if (!f || !confirm('Отозвать анкету? Ссылка перестанет работать.')) return;
  try { await api('POST', '/api/edocs/forms/' + f.formId + '/revoke'); notify('Анкета отозвана'); closeModal('edFormModal'); _edForm = null; }
  catch (e) { notify(e.message, 'err'); }
  edRefreshView();
}
```

- [ ] **Step 7: `index.html`: вкладки, контейнеры, окна, версии скриптов**

Правка 1 из 5. В `frontend/index.html` найти:

```html
<link rel="stylesheet" href="css/base.css?v=2026-08-10-mobile">
<link rel="stylesheet" href="css/features.css?v=2026-10-24-edocs">
</head>
```

заменить на:

```html
<link rel="stylesheet" href="css/base.css?v=2026-08-10-mobile">
<link rel="stylesheet" href="css/features.css?v=2026-10-25-board">
</head>
```

Правка 2 из 5. В `frontend/index.html` найти:

```html
          <div class="bc-head-title">📄 Документы</div>
          <div class="bc-head-sub">Электронное подписание с пациентами через F.Doc</div>
        </div>
```

заменить на:

```html
          <div class="bc-head-title">📄 Документы</div>
          <div class="bc-head-sub">Договор и согласие — до визита, акт — сразу после оплаченного визита</div>
        </div>
```

Правка 3 из 5. В `frontend/index.html` найти:

```html
      <div class="tabs ed-tabs">
        <button class="tab active" id="edTabBtn-list" onclick="edGo('')">Комплекты</button>
        <button class="tab" id="edTabBtn-new" onclick="edGo('new')">Оформить</button>
        <button class="tab" id="edTabBtn-settings" onclick="edGo('settings')">Настройки</button>
      </div>
      <div id="edNotice"></div>
      <div id="edView-list"></div>
      <div id="edView-new" style="display:none"></div>
      <div id="edView-package" style="display:none"></div>
```

заменить на:

```html
      <div class="tabs ed-tabs">
        <button class="tab active" id="edTabBtn-board" onclick="edGo('')">Дашборд</button>
        <button class="tab" id="edTabBtn-list" onclick="edGo('packages')">Все комплекты</button>
        <button class="tab" id="edTabBtn-settings" onclick="edGo('settings')">Настройки</button>
      </div>
      <div id="edNotice"></div>
      <div id="edView-board"></div>
      <div id="edView-client" style="display:none"></div>
      <div id="edView-list" style="display:none"></div>
      <div id="edView-package" style="display:none"></div>
```

Правка 4 из 5. В `frontend/index.html` найти:

```html
</div>

<div class="notif" id="notif"></div>
```

заменить на:

```html
</div>

<!-- «Документы»: окна дашборда и страницы пациента; содержимое рисует JS (edocs-board.js, edocs-client.js). -->
<div class="ov" id="edConfirmModal" onclick="if(event.target===this)edConfirmDone(false)">
  <div class="modal">
    <div class="mh"><div class="mt" id="edConfirmTitle">Подтвердите</div><button class="mc" onclick="edConfirmDone(false)">✕</button></div>
    <div id="edConfirmBody" style="font-size:13px;line-height:1.5"></div>
    <div class="ed-actions"><button class="btn btn-pri" id="edConfirmOk" onclick="edConfirmDone(true)">Отправить</button><button class="btn btn-sec" onclick="edConfirmDone(false)">Отмена</button></div>
  </div>
</div>
<div class="ov ed-wide" id="edActModal" onclick="if(event.target===this)closeModal('edActModal')">
  <div class="modal">
    <div class="mh"><div class="mt">Акт оказанных услуг</div><button class="mc" onclick="closeModal('edActModal')">✕</button></div>
    <div id="edActBody"></div>
  </div>
</div>
<div class="ov" id="edDocModal" onclick="if(event.target===this)closeModal('edDocModal')">
  <div class="modal">
    <div class="mh"><div class="mt" id="edDocTitle">Документ</div><button class="mc" onclick="closeModal('edDocModal')">✕</button></div>
    <div id="edDocBody"></div>
  </div>
</div>
<div class="ov" id="edPaperModal" onclick="if(event.target===this)closeModal('edPaperModal')">
  <div class="modal">
    <div class="mh"><div class="mt">Подписано на бумаге</div><button class="mc" onclick="closeModal('edPaperModal')">✕</button></div>
    <div id="edPaperBody"></div>
  </div>
</div>
<div class="ov" id="edFormModal" onclick="if(event.target===this)closeModal('edFormModal')">
  <div class="modal">
    <div class="mh"><div class="mt">Анкета пациента</div><button class="mc" onclick="closeModal('edFormModal')">✕</button></div>
    <div id="edFormBody"></div>
  </div>
</div>
<div class="ov ed-wide" id="edAutoModal" onclick="if(event.target===this)closeModal('edAutoModal')">
  <div class="modal">
    <div class="mh"><div class="mt">Автоматизация документов</div><button class="mc" onclick="closeModal('edAutoModal')">✕</button></div>
    <div id="edAutoBody"></div>
  </div>
</div>

<div class="notif" id="notif"></div>
```

Правка 5 из 5. В `frontend/index.html` найти:

```html
<script src="js/pages/cert-requests.js?v=2026-06-19b"></script>
<script src="js/pages/edocs-helpers.js?v=2026-10-24a"></script>
<script src="js/pages/edocs.js?v=2026-10-24a"></script>
<script src="js/pages/medical-cert-coords-transform.js?v=2026-06-17b"></script>
```

заменить на:

```html
<script src="js/pages/cert-requests.js?v=2026-06-19b"></script>
<script src="js/pages/edocs-helpers.js?v=2026-10-25-board"></script>
<script src="js/pages/edocs.js?v=2026-10-25-board"></script>
<script src="js/pages/edocs-board.js?v=2026-10-25-board"></script>
<script src="js/pages/edocs-client.js?v=2026-10-25-board"></script>
<script src="js/pages/medical-cert-coords-transform.js?v=2026-06-17b"></script>
```

- [ ] **Step 8: Тест проходит**

```bash
node --test frontend/js/pages/edocs.test.js 2>&1 | grep -E "^# (pass|fail)"
```

Ожидается: `# pass 21`, `# fail 0`.

- [ ] **Step 9: Остальные тесты фронта целы**

```bash
for f in frontend/js/pages/*.test.js; do node --test "$f" >/dev/null 2>&1 || echo "FAIL $f"; done; echo done
```

Ожидается: только `done` — ни одного `FAIL`.

- [ ] **Step 10: Коммит**

```bash
git add frontend/js/pages/edocs.test.js frontend/js/pages/edocs-helpers.js frontend/js/pages/edocs.js frontend/js/pages/edocs-board.js frontend/js/pages/edocs-client.js frontend/index.html
git commit -m "feat(edocs): фронт — дашборд подписей, страница пациента, окна правки, бумаги, анкеты и автоматики" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 15: Стили — **Sonnet**

Блок в конце `features.css`: переменные цветов состояний (`--ed-red`/`amber`/`blue`/`green`/`grey` с фонами и рамками) для обеих тем; классы `edb-` (дашборд) и `edc-` (страница пациента); пульсирует только иконка блока данных и только без `prefers-reduced-motion` (решение 16); телефон ≤ 700 px — сводка 2×2, карточки в одну колонку, переключатель периода прокручивается, у карточек `min-width:0`; окна — чекбоксы не во всю ширину, колонки правки акта, поле поиска в тёмной теме. Остальное — общие токены админки, поэтому после ребрендинга страница сама получит новый вид. Версия CSS в `index.html` поднята в задаче 14.

**Files:**
- Modify: `frontend/css/features.css`

- [ ] **Step 1: Блок стилей**

В `frontend/css/features.css` найти:

```css
  .ed-act.mtbl tbody td input[type=text]{flex:1 1 150px;max-width:65%}
}
```

заменить на:

```css
  .ed-act.mtbl tbody td input[type=text]{flex:1 1 150px;max-width:65%}
}

/* ─── «📄 Документы»: дашборд подписей и страница пациента (спека 2026-10-25) ───
   Цвета состояний — переменные со значениями для обеих тем; остальное — общие токены админки,
   поэтому после ребрендинга страница сама получит новый вид. Пульсирует только иконка блока
   данных пациента, и только без prefers-reduced-motion. */
:root{
  --ed-red:#d6453d;--ed-red-bg:rgba(214,69,61,.08);--ed-red-bd:rgba(214,69,61,.38);
  --ed-amber:#b9740a;--ed-amber-bg:rgba(245,158,11,.11);--ed-amber-bd:rgba(245,158,11,.45);
  --ed-blue:#2f6fd6;--ed-blue-bg:rgba(59,130,246,.09);--ed-blue-bd:rgba(59,130,246,.38);
  --ed-green:#0e9a70;--ed-green-bg:rgba(0,200,150,.10);--ed-green-bd:rgba(0,200,150,.40);
  --ed-grey:#8b949e;--ed-grey-bg:rgba(139,148,158,.10);--ed-grey-bd:rgba(139,148,158,.38);
}
[data-theme="dark"]{
  --ed-red:#ff7b72;--ed-red-bg:rgba(255,123,114,.12);--ed-red-bd:rgba(255,123,114,.45);
  --ed-amber:#e3b341;--ed-amber-bg:rgba(227,179,65,.13);--ed-amber-bd:rgba(227,179,65,.45);
  --ed-blue:#79c0ff;--ed-blue-bg:rgba(121,192,255,.12);--ed-blue-bd:rgba(121,192,255,.42);
  --ed-green:#3fd6a5;--ed-green-bg:rgba(63,214,165,.12);--ed-green-bd:rgba(63,214,165,.42);
  --ed-grey:#8b949e;--ed-grey-bg:rgba(139,148,158,.14);--ed-grey-bd:rgba(139,148,158,.42);
}
.ed-c-red{--c:var(--ed-red);--cb:var(--ed-red-bg);--cl:var(--ed-red-bd)}
.ed-c-amber{--c:var(--ed-amber);--cb:var(--ed-amber-bg);--cl:var(--ed-amber-bd)}
.ed-c-blue{--c:var(--ed-blue);--cb:var(--ed-blue-bg);--cl:var(--ed-blue-bd)}
.ed-c-green{--c:var(--ed-green);--cb:var(--ed-green-bg);--cl:var(--ed-green-bd)}
.ed-c-grey{--c:var(--ed-grey);--cb:var(--ed-grey-bg);--cl:var(--ed-grey-bd)}

/* сводка */
.edb-sum{display:grid;grid-template-columns:1.3fr repeat(4,1fr);gap:12px;margin-bottom:14px}
.edb-tile{position:relative;overflow:hidden;background:var(--card);border:1px solid var(--bd);border-radius:12px;padding:14px 14px 12px;cursor:pointer;text-align:left;font:inherit;color:var(--t1)}
.edb-tile::before{content:"";position:absolute;left:0;top:0;bottom:0;width:4px;background:var(--c,var(--bd))}
.edb-tile:hover{border-color:var(--c,var(--a))}
.edb-tile.on{box-shadow:0 0 0 2px var(--c,var(--a)) inset}
.edb-tile .edb-k{font-size:10.5px;letter-spacing:1.4px;text-transform:uppercase;color:var(--t3)}
.edb-tile b{display:block;font-size:28px;line-height:1.1;margin:6px 0 2px;color:var(--c,var(--t1))}
.edb-tile small{font-size:11.5px;color:var(--t2);line-height:1.4}
.edb-ready{display:flex;gap:14px;align-items:center;cursor:default}
.edb-ready::before{display:none}
.edb-ring{--p:0;width:76px;height:76px;border-radius:50%;flex:none;display:grid;place-items:center;background:conic-gradient(var(--ed-green) calc(var(--p)*1%),var(--bd) 0)}
.edb-ring span{width:58px;height:58px;border-radius:50%;background:var(--card);display:grid;place-items:center;font-size:15px;font-weight:700}
.edb-ready h3{font-size:14px;margin-bottom:3px}
/* панель */
.edb-bar{display:flex;flex-wrap:wrap;gap:10px;align-items:center;margin-bottom:10px}
.edb-seg{display:inline-flex;flex-wrap:wrap;gap:2px;background:var(--card);border:1px solid var(--bd);border-radius:10px;padding:3px}
.edb-seg button{border:0;background:none;padding:7px 12px;border-radius:8px;font:inherit;font-size:12.5px;font-weight:600;color:var(--t2);cursor:pointer}
.edb-seg button.on{background:var(--as);color:var(--t1)}
.edb-seg button i{font-style:normal;font-weight:500;color:var(--t3);margin-left:4px}
.edb-search{flex:1 1 220px;max-width:320px}
.edb-chips{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:12px}
.edb-chip{display:inline-flex;align-items:center;gap:6px;border:1px solid var(--bd);background:var(--card);color:var(--t1);border-radius:999px;padding:5px 11px;font:inherit;font-size:12px;font-weight:600;cursor:pointer}
.edb-chip i{font-style:normal;font-size:11px;border-radius:999px;padding:0 6px;background:var(--bg);color:var(--t2)}
.edb-chip.on{background:var(--t1);color:var(--card);border-color:var(--t1)}
.edb-chip.on i{background:rgba(255,255,255,.2);color:inherit}
.edb-dot{width:7px;height:7px;border-radius:50%;background:var(--c,var(--t3))}
.edb-auto{display:flex;flex-wrap:wrap;gap:10px;align-items:center;border:1px dashed var(--bd);border-radius:10px;padding:9px 12px;margin-bottom:14px;font-size:12.5px;color:var(--t2)}
.edb-auto b{color:var(--t1)}
.edb-auto .btn{margin-left:auto}
.edb-warns .ed-note{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
/* карточки */
.edb-group{display:flex;align-items:center;gap:10px;margin:4px 0 10px;font-size:11px;letter-spacing:1.4px;text-transform:uppercase;color:var(--t3)}
.edb-group::after{content:"";flex:1;height:1px;background:var(--bd)}
.edb-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:12px;margin-bottom:18px}
.edb-card{position:relative;min-width:0;background:linear-gradient(180deg,var(--cb) 0,var(--card) 58px);border:1px solid var(--cl);border-radius:14px;padding:13px 13px 11px;cursor:pointer;transition:transform .15s,box-shadow .15s}
.edb-card:hover{transform:translateY(-2px);box-shadow:0 8px 22px -14px rgba(0,0,0,.45)}
.edb-card.flash{animation:edFlash 1.6s ease-out}
@keyframes edFlash{0%{box-shadow:0 0 0 0 var(--ed-green-bd)}100%{box-shadow:0 0 0 14px rgba(0,0,0,0)}}
.edb-ch{display:flex;gap:10px;align-items:flex-start}
.edb-av{width:38px;height:38px;border-radius:50%;display:grid;place-items:center;flex:none;font-size:13px;font-weight:700;background:var(--card);color:var(--c);border:2px solid var(--c)}
.edb-who{flex:1 1 auto;min-width:0}
.edb-nm{font-weight:700;font-size:13.5px;line-height:1.3;overflow-wrap:break-word}
.edb-vs{font-size:11.5px;color:var(--t2);margin-top:1px;overflow-wrap:break-word}
.edb-st{display:inline-block;font-size:10px;font-weight:700;letter-spacing:.4px;text-transform:uppercase;color:var(--c);background:var(--card);border:1px solid var(--cl);padding:3px 7px;border-radius:7px;white-space:nowrap}
.edb-who .edb-st{margin-bottom:5px}
.edb-docs{display:grid;grid-template-columns:repeat(3,1fr);gap:5px;margin:11px 0 9px}
.edb-doc{border-radius:8px;padding:6px 7px;font-size:11px;line-height:1.25;background:var(--bg);color:var(--t2);border:1px solid transparent;min-width:0;overflow-wrap:break-word}
.edb-doc b{display:block;font-size:11px;color:var(--t1);margin-bottom:2px}
.edb-doc.ok{background:var(--ed-green-bg);color:var(--ed-green)}
.edb-doc.wait{background:var(--ed-blue-bg);color:var(--ed-blue)}
.edb-doc.no{background:var(--ed-red-bg);color:var(--ed-red);border-color:var(--ed-red-bd)}
.edb-doc.soon{background:var(--ed-amber-bg);color:var(--ed-amber)}
.edb-doc.na{background:repeating-linear-gradient(135deg,var(--bg) 0 6px,transparent 6px 12px)}
.edb-warn{font-size:11px;color:var(--t2);margin:-2px 0 6px;line-height:1.4}
.edb-warn.hot{color:var(--ed-red)}
.edb-cf{display:flex;gap:6px;align-items:center;font-size:11px;color:var(--t3)}
.edb-cf .btn{margin-left:auto}
.edb-cf .btn.edb-ghost{background:transparent;color:var(--c);border:1px solid var(--cl);box-shadow:none}
.edb-cf .btn[disabled]{opacity:.55;cursor:default}
.edb-mini{padding:5px 9px;font-size:12px;border-radius:7px;border:1px solid var(--cl);background:var(--card);color:var(--c);cursor:pointer}
.edb-empty{padding:40px 16px;text-align:center;color:var(--t3);border:1px dashed var(--bd);border-radius:12px}
.edb-skel{height:150px;border-radius:14px;background:linear-gradient(90deg,var(--bg),var(--card),var(--bg));background-size:200% 100%;animation:edSkel 1.2s linear infinite}
@keyframes edSkel{to{background-position:-200% 0}}
/* вся база */
.edb-base-row{display:grid;grid-template-columns:1.6fr 1fr 1fr 1fr 1fr;gap:8px;align-items:center;padding:9px 12px;border-bottom:1px solid var(--bd);cursor:pointer;font-size:12.5px}
.edb-base-row:hover{background:var(--bg)}
.edb-base-head{font-size:10.5px;letter-spacing:1px;text-transform:uppercase;color:var(--t3);cursor:default}
.edb-base-head:hover{background:none}
.edb-yes{color:var(--ed-green);font-weight:600}.edb-no{color:var(--ed-red);font-weight:600}
.edb-pager{display:flex;gap:8px;align-items:center;justify-content:flex-end;margin-top:10px;font-size:12px;color:var(--t3)}

/* страница пациента */
.edc-back{display:inline-flex;gap:6px;font-size:12.5px;color:var(--a);cursor:pointer;margin-bottom:10px;background:none;border:0;padding:0;font:inherit}
.edc-head{position:relative;display:flex;flex-wrap:wrap;gap:14px;align-items:center;background:var(--card);border:1px solid var(--bd);border-radius:16px;padding:16px 18px;margin-bottom:12px}
.edc-head .edb-av{width:52px;height:52px;font-size:16px}
.edc-name{font-size:20px;font-weight:700;line-height:1.2}
.edc-meta{display:flex;flex-wrap:wrap;gap:4px 14px;font-size:12px;color:var(--t2);margin-top:4px}
.edc-overall{margin-left:auto;text-align:right}
.edc-overall .edb-st{display:inline-block}
.edc-steps{display:flex;gap:5px;margin-top:8px;justify-content:flex-end}
.edc-steps span{width:30px;height:6px;border-radius:4px;background:var(--bd)}
.edc-steps span.ok{background:var(--ed-green)}.edc-steps span.no{background:var(--ed-red)}.edc-steps span.wait{background:var(--ed-blue)}
.edc-steps-l{font-size:10.5px;color:var(--t3);margin-top:4px}
.edc-data{border:1px solid var(--cl);border-radius:14px;background:var(--card);margin-bottom:16px}
.edc-data>summary{display:flex;gap:12px;align-items:center;padding:13px 16px;cursor:pointer;border-radius:14px;background:var(--cb);list-style:none}
.edc-data[open]>summary{border-radius:14px 14px 0 0}
.edc-data>summary::-webkit-details-marker{display:none}
.edc-ico{width:32px;height:32px;border-radius:50%;display:grid;place-items:center;flex:none;background:var(--c);color:#fff;font-weight:700}
.edc-data.ed-c-red .edc-ico{animation:edPulse 1.8s ease-in-out infinite}
@keyframes edPulse{0%{box-shadow:0 0 0 0 var(--ed-red-bd)}70%{box-shadow:0 0 0 11px rgba(0,0,0,0)}100%{box-shadow:0 0 0 0 rgba(0,0,0,0)}}
.edc-data summary b{color:var(--c);font-size:13.5px}
.edc-data summary small{display:block;color:var(--t2);font-size:12px;margin-top:1px}
.edc-chev{margin-left:auto;color:var(--t3);transition:transform .2s}
.edc-data[open] .edc-chev{transform:rotate(180deg)}
.edc-body{padding:14px 16px 16px}
.edc-tools{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:12px}
.edc-fields{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:0 14px}
.edc-sect{grid-column:1/-1;font-size:10.5px;letter-spacing:1.4px;text-transform:uppercase;color:var(--t3);margin:6px 0 8px}
.edc-f.wide{grid-column:span 2}.edc-f.full{grid-column:1/-1}
.edc-f.miss input,.edc-f.miss select{border-color:var(--ed-red);background:var(--ed-red-bg)}
.edc-f.miss .fl{color:var(--ed-red)}
.edc-f .ed-sub{margin-top:4px;margin-bottom:0}
.edc-docs-head{display:flex;flex-wrap:wrap;align-items:flex-end;justify-content:space-between;gap:8px;margin-bottom:10px}
.edc-docs{display:grid;grid-template-columns:repeat(auto-fill,minmax(230px,1fr));gap:12px;margin-bottom:16px}
.edc-doc{position:relative;display:flex;flex-direction:column;min-height:170px;min-width:0;background:var(--card);border:1.5px solid var(--cl,var(--bd));border-radius:14px;padding:14px;cursor:pointer;transition:transform .15s,box-shadow .15s,border-color .15s}
.edc-doc:hover{transform:translateY(-2px);box-shadow:0 8px 22px -14px rgba(0,0,0,.45)}
.edc-doc.na,.edc-doc.done{cursor:default}
.edc-doc.na{opacity:.75}
.edc-doc.sel{border-color:var(--a);box-shadow:0 0 0 3px var(--as)}
.edc-sheet{width:38px;height:46px;border-radius:5px 12px 5px 5px;background:var(--cb,var(--bg));border:1px solid var(--cl,var(--bd));display:grid;place-items:center;font-size:18px;margin-bottom:10px}
.edc-doc h3{font-size:13.5px;line-height:1.35;margin:0 0 4px;overflow-wrap:break-word}
.edc-dsub{font-size:12px;color:var(--t2);line-height:1.45}
.edc-dst{margin-top:auto;padding-top:10px;display:flex;align-items:center;gap:6px;font-size:12px;font-weight:700;color:var(--c,var(--t2))}
.edc-dact{display:flex;gap:5px;margin-left:auto}
.edc-ib{width:30px;height:30px;border-radius:8px;border:1px solid var(--bd);background:var(--card);display:grid;place-items:center;font-size:13px;color:var(--t1);cursor:pointer;padding:0}
.edc-ib:hover{border-color:var(--a)}
.edc-chk{position:absolute;right:12px;top:12px;width:22px;height:22px;border-radius:7px;border:1.5px solid var(--bd);background:var(--card);display:grid;place-items:center;color:#fff;font-size:12px}
.edc-doc.sel .edc-chk{background:var(--a);border-color:var(--a)}
.edc-badge{position:absolute;right:12px;top:12px;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.4px;color:var(--c);background:var(--cb);border-radius:6px;padding:3px 7px}
.edc-add{border-style:dashed;align-items:center;justify-content:center;text-align:center;color:var(--t3);font-size:13px}
.edc-send{position:sticky;bottom:12px;z-index:5;display:flex;flex-wrap:wrap;gap:10px;align-items:center;background:#2b2f36;color:#fff;border-radius:14px;padding:11px 12px 11px 16px;box-shadow:0 18px 40px -20px rgba(0,0,0,.7);margin-bottom:16px}
[data-theme="dark"] .edc-send{background:#30363d}
.edc-send .grow{flex:1 1 260px;font-size:13px;min-width:0}
.edc-send small{display:block;font-size:11.5px;opacity:.75;margin-top:2px}
.edc-send .btn-sec{color:#fff;border-color:rgba(255,255,255,.35)}
.edc-send .btn-sec:hover{background:rgba(255,255,255,.08)}
.edc-send .btn-pri[disabled]{opacity:.45;cursor:default;box-shadow:none;transform:none}
.edc-two{display:grid;grid-template-columns:1.2fr 1fr;gap:14px}
.edc-tl{list-style:none;margin:0;padding:0}
.edc-tl li{display:flex;gap:10px;padding:8px 0;font-size:12.5px;border-bottom:1px solid var(--bd);align-items:flex-start}
.edc-tl li:last-child{border:0}
.edc-tl li.click{cursor:pointer}
.edc-tl li.click:hover{background:var(--bg)}
.edc-tl li.focus{background:var(--as);border-radius:8px}
.edc-tdot{width:9px;height:9px;border-radius:50%;margin-top:4px;flex:none;background:var(--c,var(--bd))}
.edc-tl time{color:var(--t3);width:92px;flex:none}
.edc-tl .grow{flex:1;min-width:0}
/* окна */
.ed-wide .modal{width:760px}
/* Глобальный стиль делает чекбоксы во всю ширину — в окнах «Документов» (вне #page-edocs) чиним свои. */
#edAutoModal input[type=checkbox],#edPaperModal input[type=checkbox],#edActModal input[type=checkbox]{width:auto;margin:0;flex-shrink:0}
.ed-act-edit th:first-child,.ed-act-edit td:first-child{width:36px}
.ed-act-edit th:nth-child(n+3),.ed-act-edit td:nth-child(n+3){width:110px}
[data-theme="dark"] #page-edocs input:not([type=checkbox]),[data-theme="dark"] #page-edocs select{background:var(--card);color:var(--t1);color-scheme:dark}
.ed-act-edit input{width:100%}
.ed-act-edit td:nth-child(n+3) input{text-align:right}
.ed-act-edit tr.off td{opacity:.45}
.ed-diff{font-size:12px;color:var(--ed-amber);background:var(--ed-amber-bg);border-radius:8px;padding:8px 10px;margin:8px 0}
.ed-qr{display:flex;flex-wrap:wrap;gap:16px;align-items:center}
.ed-qr img{width:200px;height:200px;border-radius:12px;border:1px solid var(--bd);background:#fff;padding:6px}
.ed-qr .grow{flex:1 1 240px;min-width:0}
.ed-urlbox{word-break:break-all;font-size:12px;color:var(--t2);background:var(--bg);border-radius:8px;padding:8px 10px;margin:6px 0}
.ed-au-row{display:flex;gap:12px;align-items:flex-start;padding:12px 0;border-bottom:1px solid var(--bd)}
.ed-au-row:last-of-type{border:0}
.ed-au-row h4{font-size:13.5px;margin:0 0 3px}
.ed-au-row p{font-size:12px;color:var(--t2);margin:0 0 6px;line-height:1.45}
.ed-au-row .grow{flex:1;min-width:0}
.ed-au-row select,.ed-au-row input[type=number]{width:auto;display:inline-block;margin:2px 6px 2px 0}
.ed-au-row textarea{width:100%;min-height:70px}
.ed-tgl{width:40px;height:22px;border-radius:999px;background:var(--bd);position:relative;flex:none;border:0;margin-top:2px;cursor:pointer;padding:0}
.ed-tgl::after{content:"";position:absolute;left:3px;top:3px;width:16px;height:16px;border-radius:50%;background:#fff;transition:left .15s}
.ed-tgl.on{background:var(--ed-green)}
.ed-tgl.on::after{left:21px}
@media(prefers-reduced-motion:reduce){.edc-data .edc-ico,.edb-card.flash,.edb-skel{animation:none!important}}
@media(max-width:1100px){.edb-sum{grid-template-columns:repeat(2,1fr)}.edb-ready{grid-column:1/-1}.edc-two{grid-template-columns:1fr}}
@media(max-width:700px){
  .edb-sum{gap:8px}.edb-tile b{font-size:24px}
  .edb-seg{width:100%;overflow-x:auto;flex-wrap:nowrap}.edb-seg button{white-space:nowrap}
  .edb-search{max-width:none}
  .edb-auto .btn{margin-left:0}
  .edb-grid,.edc-docs{grid-template-columns:minmax(0,1fr)}
  .edb-base-row{grid-template-columns:1.4fr 1fr 1fr}
  .edb-base-row .edb-col-hide{display:none}
  .edc-fields{grid-template-columns:minmax(0,1fr)}.edc-f.wide{grid-column:auto}
  .edc-overall{margin-left:0;text-align:left;width:100%}.edc-steps{justify-content:flex-start}
  .edc-send{bottom:6px}
  .ed-wide .modal{width:100%}
}
```

- [ ] **Step 2: Блок на месте**

```bash
grep -c "edb-\|edc-" frontend/css/features.css
```

Ожидается: `141`.

- [ ] **Step 3: Коммит**

```bash
git add frontend/css/features.css
git commit -m "feat(edocs): стили дашборда и страницы пациента — цвета состояний, обе темы, телефон" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

### Task 16: Визуальный стенд — **Sonnet**

`scripts/edocs-visual.js` переписан: изолированный express-стенд с настоящими `index.html`/CSS/JS и анкетой; ответы API дашборда и страницы пациента собирает НАСТОЯЩИЙ `services/edocs/board.js` из синтетических записей — стенд показывает ровно те цвета и подписи, что посчитает сервер. Ни БД, ни F.Doc, ни сессий, ни отправок; скриншоты — `/tmp/edocs-*.png`. Проверки: цвета и подписи дашборда, неделя, «Вся база», окно автоматики; страница пациента (красный блок данных, подсветка недостающего поля, окно анкеты с QR, акт по визиту, окно правки акта с предупреждением о расхождении, бумага, бумажный комплект без «Открыть в F.Doc»); настройки; тёмная тема; телефон 390 px без горизонтальной прокрутки; анкета на телефоне (приветствие по имени, подсветка пустых полей, «Спасибо»); кассир не видит «Настройки»; ни одной ошибки в консоли.

**Files:**
- Modify: `backend/scripts/edocs-visual.js` (целиком)

- [ ] **Step 1: Стенд**

Заменить `backend/scripts/edocs-visual.js` целиком:

```js
'use strict';
// Изолированная визуальная проверка «Документов»: настоящие разметка/CSS/JS страницы и анкеты пациента,
// подставные ответы API. Ответы дашборда и страницы пациента собирает НАСТОЯЩИЙ services/edocs/board.js
// из синтетических записей — стенд показывает ровно те цвета и подписи, что посчитает сервер.
// Ни БД, ни F.Doc, ни сессий, ни отправок. Скриншоты — /tmp/edocs-*.png.
//   node scripts/edocs-visual.js   (Chrome: CHROME_PATH или /usr/bin/google-chrome)
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const puppeteer = require('puppeteer');
const QRCode = require('qrcode');
const board = require('../services/edocs/board');
const { dictionary } = require('../services/edocs/placeholders');

const PKG = '11111111-1111-4111-8111-111111111111';
const FORM_ID = '33333333-3333-4333-8333-333333333333';
const TOKEN = 'T'.repeat(43);
const MIN = 60000;

function fixtures(nowMs) {
  const iso = (ms) => new Date(ms).toISOString();
  const templates = [
    { id: 1, kind: 'contract', title: 'Договор на оказание платных медицинских услуг', is_active: true, sort_order: 0, placeholders: ['fio', 'passport', 'address', 'contract_no'] },
    { id: 2, kind: 'consent_pd', title: 'Согласие на обработку персональных данных', is_active: true, sort_order: 1, placeholders: ['fio', 'phone'] },
    { id: 3, kind: 'act', title: 'Акт оказанных услуг', is_active: true, sort_order: 2, placeholders: ['fio', 'services', 'total_sum'] },
    { id: 4, kind: 'other', title: 'Памятка после процедуры', is_active: true, sort_order: 3, placeholders: ['fio'] },
  ];
  const people = [
    [1, 'Абдуллаева Карина Рашидовна', 40, '0', '0', false, 'Биоревитализация', 'Гаджиева Пери'],
    [2, 'Смирнова Ольга Викторовна', -90, '1', '1', true, 'Ботулинотерапия', 'Боташев Астемир'],
    [3, 'Мамедова Дина Эльдаровна', -150, '1', '1', true, 'Контурная пластика губ', 'Гаджиева Пери'],
    [4, 'Лебедева Анна Игоревна', 360, '0', '0', true, 'Чистка лица', 'Гатауллина Юлия'],
    [5, 'Соколова Виктория Андреевна', 480, '0', '0', false, 'Лазерная эпиляция', 'Палий Татьяна'],
    [6, 'Воронина Елена Сергеевна', 90, '0', '0', false, 'Лазерная эпиляция', 'Палий Татьяна'],
    [7, 'Ким Светлана Олеговна', -120, '1', '1', true, 'Микротоки', 'Гатауллина Юлия'],
    [8, 'Котова Мария Павловна', -200, '1', '1', true, 'Пилинг PRX-T33', 'Гатауллина Юлия'],
    [9, 'Павлова Ирина Алексеевна', -60, '1', '1', true, 'Мезотерапия', 'Гаджиева Пери'],
    [10, 'Орлова Наталья Дмитриевна', 180, '0', '0', true, 'Ботулинотерапия', 'Боташев Астемир'],
    [11, 'Белова Ксения Романовна', 1440 + 120, '0', '0', true, 'Фотоомоложение', 'Палий Татьяна'],
    [12, 'Захарова Алина Тимуровна', -1440 - 60, '1', '1', true, 'Чистка лица', 'Гатауллина Юлия'],
  ];
  const records = people.map(([id, name, offset, att, paid, prior, svc, staff]) => {
    const at = nowMs + offset * MIN;
    return { id: 100 + id, client_id: id, client_name: name, client_phone: '7920' + String(1000000 + id).slice(1), visit_date: board.mskDay(at), visit_at: iso(at),
      attendance: att, paid_full: paid, has_prior_visit: prior, services: [{ title: svc, amount: 1, first_cost: 9000, manual_cost: 9000 }], staff: { name: staff, position: { title: 'Врач-косметолог' } } };
  });
  let n = 0;
  const doc = (client, kind, status, over = {}) => ({ client_id: client, package_id: over.package_id || `aaaaaaaa-0000-4000-8000-${String(++n).padStart(12, '0')}`, kind,
    package_status: status, record_id: null, source: 'manual', created_at: iso(nowMs - 3 * 86400000), sent_at: iso(nowMs - 3 * 86400000),
    signed_at: status === 'signed' || status === 'paper' ? iso(nowMs - 3 * 86400000) : null, last_error: null, ...over });
  const signedPair = (c) => [doc(c, 'contract', 'signed'), doc(c, 'consent_pd', 'signed')];
  const docs = [
    ...signedPair(2), ...signedPair(3), doc(3, 'act', 'expired', { record_id: 103, created_at: iso(nowMs - 26 * 3600000) }),
    doc(4, 'contract', 'paper'), doc(5, 'consent_pd', 'signed'),
    doc(6, 'contract', 'sent', { sent_at: iso(nowMs - 12 * MIN), created_at: iso(nowMs - 12 * MIN) }), doc(6, 'consent_pd', 'sent', { sent_at: iso(nowMs - 12 * MIN), created_at: iso(nowMs - 12 * MIN) }),
    ...signedPair(7), doc(7, 'act', 'sent', { record_id: 107, sent_at: iso(nowMs - 100 * MIN), created_at: iso(nowMs - 100 * MIN) }),
    ...signedPair(8), doc(8, 'act', 'signed', { record_id: 108, signed_at: iso(nowMs - 150 * MIN) }),
    ...signedPair(9), doc(9, 'act', 'signed', { record_id: 109, signed_at: iso(nowMs - 30 * MIN) }),
    ...signedPair(10), ...signedPair(11), ...signedPair(12),
  ];
  const full = (id) => ({ client_id: id, last_name: 'Тестова', first_name: 'Анна', middle_name: null, phone: '79200000000', contract_no: null,
    secure_fields: ['passport_series', 'passport_number', 'issue_date', 'issued_by', 'authority_code', 'address'] });
  const identities = new Map(people.map(([id]) => [id, full(id)]));
  identities.set(1, { client_id: 1, last_name: 'Абдуллаева', first_name: 'Карина', middle_name: 'Рашидовна', phone: '79200000001', secure_fields: [] });
  identities.set(5, { client_id: 5, last_name: 'Соколова', first_name: 'Виктория', phone: '79200000005', secure_fields: [] });
  const forms = [{ id: FORM_ID, client_id: 5, status: 'active', created_at: iso(nowMs - 2 * 3600000), delivered_via: 'whatsapp', delivered_at: iso(nowMs - 2 * 3600000),
    opened_at: null, submitted_at: null, expires_at: iso(nowMs + 5 * 86400000), package_id: null, last_error: null }];
  const notes = [{ client_id: 2, record_id: 102, kind: 'act', status: 'failed', reason: 'у сотрудника для автоотправки нет рабочей учётки F.Doc', created_at: iso(nowMs - 40 * MIN) }];
  return { templates, records, docs, identities, forms, notes, people };
}

async function main() {
  const frontend = path.resolve(__dirname, '../../frontend');
  const index = fs.readFileSync(path.join(frontend, 'index.html'), 'utf8');
  const pageFrom = index.indexOf('<div class="page" id="page-edocs">');
  const page = index.slice(pageFrom, index.indexOf('<div class="page" id="page-economics">', pageFrom));
  const modalFrom = index.indexOf('<div class="ov" id="edMeModal"');
  const modal = index.slice(modalFrom, index.indexOf('<div class="notif" id="notif"></div>', modalFrom));
  assert.ok(pageFrom > 0 && modalFrom > 0, 'блоки «Документов» не найдены в index.html');
  const nowMs = Date.now();
  const fx = fixtures(nowMs);
  const today = board.mskDay(nowMs);
  const settings = { actsRequiredFrom: board.addDays(today, -10), autonumber: true };
  const state = { enabled: true, configured: true, encReady: true, role: 'owner', me: { connected: true, login: 'admin', broken: false, lastError: null } };
  const built = () => board.buildBoard({ records: fx.records, docs: fx.docs, identities: fx.identities, templates: fx.templates, requisites: {}, forms: fx.forms, notes: fx.notes, settings, nowMs: Date.now(), today });
  const app = express();
  app.use(express.json());
  app.get('/api/edocs/state', (_q, r) => r.json(state));
  app.get('/api/edocs/board', (q, r) => {
    const range = ['today', 'tomorrow', 'week', 'open'].includes(q.query.range) ? q.query.range : 'today';
    const b = built();
    const cards = board.sliceRange(b.cards, range, today, settings.actsRequiredFrom);
    r.json({ now: new Date().toISOString(), today, range, rangeCounts: board.rangeCounts(b.cards, today, settings.actsRequiredFrom), ...board.summarize(cards), cards, kinds: b.kinds,
      module: { enabled: state.enabled, configured: true, encReady: true, me: state.me },
      automation: { previsit: { on: true, hours: 24, scope: 'first', form: true }, act: { on: false, delayMin: 15 }, remind: { on: true, hours: 2 }, senderName: 'Администратор' },
      warnings: [], actsRequiredFrom: settings.actsRequiredFrom });
  });
  app.get('/api/edocs/board/clients', (_q, r) => r.json({ page: 1, filter: 'all', total: fx.people.length, rows: fx.people.map(([id, name], i) => ({
    id, name, phone: '79200000' + String(id).padStart(3, '0'), lastVisitAt: new Date(nowMs - i * 86400000).toISOString(), contract: i % 3 !== 0, consent: i % 4 !== 0, pending: i === 5, openActs: i === 1 ? 1 : 0 })) }));
  app.get('/api/edocs/clients/:id/page', (q, r) => {
    const id = Number(q.params.id);
    const person = fx.people.find((x) => x[0] === id);
    if (!person) return r.status(404).json({ error: 'Пациент не найден' });
    const recs = fx.records.filter((x) => x.client_id === id);
    const p = board.buildClientPage({ client: { id, name: person[1], phone: recs[0].client_phone }, identity: fx.identities.get(id), records: recs,
      docs: fx.docs.filter((d) => d.client_id === id), templates: fx.templates, requisites: {}, forms: fx.forms.filter((f) => f.client_id === id), notes: [], settings,
      nowMs: Date.now(), today, focusRecordId: Number(q.query.record) || null });
    r.json({ ...p, today, numbering: { auto: true, contractNo: null, yclientsNo: id === 2 ? '1859' : null, next: 1999 }, actsRequiredFrom: settings.actsRequiredFrom,
      module: { enabled: true, configured: true, encReady: true, me: state.me }, identity: { exists: true, secureFields: [] },
      templates: fx.templates.map((t) => ({ id: t.id, kind: t.kind, title: t.title, placeholders: t.placeholders })), packages: [],
      events: [{ kind: 'form_created', packageId: null, payload: {}, createdAt: new Date(nowMs - 3 * 3600000).toISOString(), userName: 'Администратор' },
        { kind: 'identity_edit', packageId: null, payload: {}, createdAt: new Date(nowMs - 2 * 3600000).toISOString(), userName: 'Администратор' }] });
  });
  app.get('/api/edocs/clients/:id/identity', (q, r) => (Number(q.params.id) === 1
    ? r.json({ exists: true, plain: { last_name: 'Абдуллаева', first_name: 'Карина', middle_name: 'Рашидовна', birth_date: '1991-03-14', gender: 'F', phone: '79200000001', email: '', contract_no: '', contract_date: '' }, secure: {} })
    : r.json({ exists: true, plain: { last_name: 'Тестова', first_name: 'Анна', birth_date: '1985-01-02', gender: 'F', phone: '79200000000' }, secure: { passport_series: '4500', passport_number: '000001', address: 'г. Москва' } })));
  app.get('/api/edocs/clients/:id/identity/prefill', (_q, r) => r.json({ plain: {}, secure: {}, notes: [] }));
  app.get('/api/edocs/records/:id/act-draft', (q, r) => r.json({ record: { id: Number(q.params.id), clientId: 2, visitDate: today, actNo: '2006141556' }, doctor: { name: 'Боташев Астемир', position: 'Врач-косметолог' },
    lines: [{ service_id: 1, title: 'Ботулинотерапия Ботулакс, лоб + межбровье', qty: 1, price: 17000, sum: 17000 }, { service_id: 2, title: 'Консультация врача-косметолога', qty: 1, price: 2000, sum: 2000 }],
    totals: { total_sum: 19000 } }));
  app.post('/api/edocs/packages/check', (q, r) => r.json({ missing: { identity: q.body.clientId === 1 && q.body.templateIds.includes(1)
    ? [{ key: 'address', label: 'Адрес регистрации' }, { key: 'passport_number', label: 'Номер паспорта' }, { key: 'passport_series', label: 'Серия паспорта' }] : [], org: [] } }));
  const formLink = async () => { const url = `https://dev.zumrudin.ru/anketa/${TOKEN}`; return { formId: FORM_ID, url, qr: await QRCode.toDataURL(url, { margin: 1, width: 280 }), expiresAt: new Date(nowMs + 7 * 86400000).toISOString() }; };
  app.post('/api/edocs/clients/:id/forms', async (_q, r) => r.json({ ...(await formLink()), delivery: null }));
  app.get('/api/edocs/forms/:id/link', async (_q, r) => r.json(await formLink()));
  app.post('/api/edocs/forms/:id/send', (_q, r) => r.json({ ok: true, channel: 'whatsapp' }));
  const pkg = { id: PKG, kind: 'onboarding', title: 'На бумаге: Договор на оказание платных медицинских услуг', status: 'paper', source: 'paper', fdocStatus: null, clientId: 4,
    clientName: 'Лебедева Анна Игоревна', clientPhone: '79200000004', recordId: null, sentAt: null, signedAt: new Date(nowMs - 86400000).toISOString(), sentByName: 'Администратор',
    lastError: null, createdAt: new Date(nowMs - 86400000).toISOString(), act: null, patient: null, paper: { signedDate: today, note: 'подписано в клинике', hasScan: true },
    documents: [{ id: 'bbbbbbbb-1111-4111-8111-111111111111', title: 'Договор на оказание платных медицинских услуг', fileName: 'Договор.docx', corpSignedAt: null, clientSignedAt: null, hasPdf: false }],
    events: [{ kind: 'paper', payload: {}, createdAt: new Date(nowMs - 86400000).toISOString(), userName: 'Администратор' }] };
  app.get('/api/edocs/packages', (_q, r) => r.json({ total: 1, page: 1, rows: [pkg] }));
  app.get('/api/edocs/packages/:id', (_q, r) => r.json(pkg));
  app.get('/api/edocs/admin/settings', (_q, r) => r.json({ enabled: true, baseUrl: 'https://demo.fdoc.ru', appLogin: 'app', appCode: 'crm', corpId: '12345', qesCertAlias: '', employeePosition: 'Администратор',
    unsignDays: 14, requisites: { name: 'ООО «Тестовая клиника»', inn: '0000000000', city: 'Москва' }, hasApiKey: true, hasAppPassword: true, webhookUrl: null, lastWebhookAt: null, encReady: true }));
  app.get('/api/edocs/admin/templates', (_q, r) => r.json({ templates: fx.templates }));
  app.get('/api/edocs/admin/users', (_q, r) => r.json({ users: [{ id: 4, name: 'Администратор', role: 'admin', connected: true, login: 'admin', broken: false }, { id: 5, name: 'Кассир', role: 'admin_cashier', connected: false }] }));
  app.get('/api/edocs/admin/templates/dictionary', (_q, r) => r.json(dictionary()));
  app.get('/api/edocs/admin/automation', (_q, r) => r.json({ senderUserId: 4, senders: [{ id: 4, name: 'Администратор', role: 'admin', connected: true, broken: false }, { id: 5, name: 'Кассир', role: 'admin_cashier', connected: false, broken: false }],
    previsit: { on: true, hours: 24, scope: 'first', form: true }, act: { on: false, delayMin: 15 }, remind: { on: true, hours: 2 }, formMessage: '',
    formMessageDefault: 'Здравствуйте, {имя}! Перед визитом в {клиника} {дата} заполните, пожалуйста, данные для договора — это займёт 2 минуты: {ссылка}', formTtlDays: 7,
    contractAutonumber: true, contractNext: { next: 1999, maxUsed: 1998 }, actsRequiredFrom: settings.actsRequiredFrom, publicUrlConfigured: true, testPhones: ['79200255591'] }));
  // публичная анкета
  app.get('/anketa/:token', (_q, r) => r.sendFile(path.join(frontend, 'anketa.html')));
  app.get('/api/public/anketa/:token', (_q, r) => r.json({ status: 'active', clinic: 'PERI CLINIC', greetingName: 'Карина', visit: { date: today, time: '11:00', label: '26 октября, 11:00' },
    fields: [['last_name', 'Фамилия', 'text', true], ['first_name', 'Имя', 'text', true], ['middle_name', 'Отчество (если есть)', 'text', false], ['birth_date', 'Дата рождения', 'date', true],
      ['passport_series', 'Серия паспорта', 'digits', true], ['passport_number', 'Номер паспорта', 'digits', true], ['issue_date', 'Дата выдачи паспорта', 'date', true],
      ['authority_code', 'Код подразделения', 'code', true], ['issued_by', 'Кем выдан паспорт', 'text', true], ['address', 'Адрес регистрации', 'text', true]]
      .map(([key, label, type, required]) => ({ key, label, type, required })), canRecognize: true, policyUrl: '/privacy-policy.html' }));
  app.post('/api/public/anketa/:token', (_q, r) => r.json({ ok: true, docs: 'sending' }));
  app.get('/', (_q, r) => r.type('html').send(`<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
    <link rel="stylesheet" href="/css/base.css"><link rel="stylesheet" href="/css/features.css"></head><body>
    <nav id="mainNav"><div class="tn" data-p="edocs">Документы</div></nav><main class="content" style="padding:16px;max-width:1300px;margin:auto">${page}</main>${modal}
    <div class="notif" id="notif"></div><div id="lbar" class="lbar"></div>
    <script src="/js/core/utils.js"></script><script src="/js/core/api.js"></script><script src="/js/core/nav.js"></script>
    <script src="/js/pages/edocs-helpers.js"></script><script src="/js/pages/edocs.js"></script><script src="/js/pages/edocs-board.js"></script><script src="/js/pages/edocs-client.js"></script>
    <script>var ME={role:localStorage.getItem('edRole')||'owner'};function openModal(id){document.getElementById(id).classList.add('open')}function closeModal(id){document.getElementById(id).classList.remove('open')}
    if(!location.hash) history.replaceState(null,'','#edocs'); navTo('edocs',{keepHash:true});</script></body></html>`));
  app.use(express.static(frontend));
  const server = await new Promise((res) => { const s = app.listen(0, '127.0.0.1', () => res(s)); });
  const base = `http://127.0.0.1:${server.address().port}/`;
  const pause = () => new Promise((r) => setTimeout(r, 700));   // переходы CSS (до 0,25 с) — кадр не посреди анимации
  let browser;
  try {
    browser = await puppeteer.launch({ headless: true, executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', args: ['--no-sandbox', '--disable-dev-shm-usage'] });
    const p = await browser.newPage();
    await p.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
    const errors = [];
    p.on('pageerror', (e) => errors.push(e.message));
    p.on('dialog', (d) => d.dismiss());
    await p.setViewport({ width: 1280, height: 900 });
    const overflow = () => p.evaluate(() => document.querySelector('main').scrollWidth - document.querySelector('main').clientWidth);

    // дашборд «Сегодня»
    await p.goto(base + '#edocs', { waitUntil: 'networkidle0' });
    await p.waitForSelector('#edbCards .edb-card');
    const colors = await p.$$eval('#edbCards .edb-card', (els) => els.map((e) => e.className.replace('edb-card ', '').replace(' flash', '')));
    assert.ok(colors.includes('ed-c-red') && colors.includes('ed-c-green') && colors.includes('ed-c-blue'), `цвета карточек: ${colors}`);
    const boardText = await p.$eval('#edbCards', (el) => el.textContent);
    for (const label of ['Нужно до визита', 'Акт не подписан', 'Ссылка истекла', 'Ждём подпись', 'Ждём анкету', 'Всё подписано', 'Документы готовы']) {
      assert.ok(boardText.includes(label), `на дашборде нет подписи «${label}»`);
    }
    await pause();
    await p.screenshot({ path: '/tmp/edocs-board.png', fullPage: true });
    await p.click('#edbSeg-week');
    await p.waitForFunction(() => location.hash === '#edocs/r/week' && document.querySelectorAll('#edbCards .edb-group').length >= 2);
    await pause();
    await p.screenshot({ path: '/tmp/edocs-week.png', fullPage: true });
    await p.click('#edbSeg-all');
    await p.waitForSelector('#edbBaseList .edb-base-row:not(.edb-base-head)');
    await pause();
    await p.screenshot({ path: '/tmp/edocs-base.png', fullPage: true });
    await p.goto(base + '#edocs', { waitUntil: 'networkidle0' });
    await p.waitForSelector('#edbCards .edb-card');
    await p.evaluate(() => edOpenAutomation());
    await p.waitForFunction(() => document.getElementById('edAutoModal').classList.contains('open') && !!document.getElementById('edAu-sender'), { timeout: 5000 })
      .catch(async (e) => { console.error('auto modal:', await p.evaluate(() => [document.getElementById('edAutoModal') && document.getElementById('edAutoModal').className, document.getElementById('edAutoBody') && document.getElementById('edAutoBody').innerHTML.slice(0, 300)]), errors); throw e; });
    await pause();
    await p.screenshot({ path: '/tmp/edocs-automation.png' });
    await p.evaluate(() => closeModal('edAutoModal'));

    // страница пациента: данные неполные, блок раскрыт с дашборда «Заполнить данные»
    await p.evaluate(() => {
      const btn = Array.from(document.querySelectorAll('#edbCards button.btn-pri')).find((x) => x.textContent === 'Заполнить данные');
      setTimeout(() => btn.click(), 0);   // клик вне evaluate: переход по hash посреди вызова подвешивал протокол
    });
    await p.waitForFunction(() => /^#edocs\/c\/1/.test(location.hash));
    await p.waitForSelector('#edcData[open] #edcF-passport_series');
    assert.equal(await p.$eval('#edcData', (el) => el.classList.contains('ed-c-red')), true);
    assert.ok(await p.$eval('#edcW-passport_series', (el) => el.classList.contains('miss')), 'недостающее поле не подсвечено');
    await p.waitForFunction(() => /Не хватает данных пациента/.test(document.getElementById('edcSend').textContent));
    await pause();
    await p.screenshot({ path: '/tmp/edocs-client.png', fullPage: true });
    await p.reload({ waitUntil: 'networkidle0' });
    await p.waitForSelector('#edcHead .edc-head');
    assert.match(await p.evaluate(() => location.hash), /^#edocs\/c\/1/);
    await p.evaluate(() => edFormOpen(1));
    await p.waitForSelector('#edFormModal.open .ed-qr img');
    await pause();
    await p.screenshot({ path: '/tmp/edocs-form-modal.png' });
    await p.evaluate(() => closeModal('edFormModal'));

    // страница пациента с оплаченным визитом: акт, правка строк, бумага
    await p.goto(base + '#edocs/new/2', { waitUntil: 'networkidle0' });   // старый адрес мастера
    await p.waitForSelector('#edcDocs .edc-doc');
    assert.equal(await p.evaluate(() => location.hash), '#edocs/c/2');
    assert.match(await p.$eval('#edcDocs', (el) => el.textContent), /Акт оказанных услуг · визит/);
    await pause();
    await p.screenshot({ path: '/tmp/edocs-client-act.png', fullPage: true });
    await p.evaluate(() => edcActEdit());
    await p.waitForSelector('#edActModal.open .ed-act-edit tbody tr');
    await p.evaluate(() => { const i = document.querySelectorAll('.ed-act-edit tbody tr td:nth-child(5) input')[1]; i.value = '1000'; i.dispatchEvent(new Event('input')); });
    assert.match(await p.$eval('#edcActDiff', (el) => el.textContent), /отличается/);
    await pause();
    await p.screenshot({ path: '/tmp/edocs-act-modal.png' });
    await p.evaluate(() => closeModal('edActModal'));
    await p.evaluate(() => edcPaperOpen());
    await p.waitForSelector('#edPaperModal.open .edcP-t');
    await pause();
    await p.screenshot({ path: '/tmp/edocs-paper-modal.png' });
    await p.evaluate(() => closeModal('edPaperModal'));

    // комплект «на бумаге», настройки
    await p.goto(base + `#edocs/p/${PKG}`, { waitUntil: 'networkidle0' });
    await p.waitForSelector('#edView-package .ed-pkg-head');
    const actions = await p.$$eval('#edView-package .ed-actions button', (els) => els.map((e) => e.textContent));
    assert.ok(actions.includes('Скан') && actions.includes('Снять отметку') && !actions.includes('Открыть в F.Doc'), `кнопки бумажного комплекта: ${actions}`);
    await pause();
    await p.screenshot({ path: '/tmp/edocs-package.png', fullPage: true });
    await p.goto(base + '#edocs/settings', { waitUntil: 'networkidle0' });
    await p.waitForSelector('#edS-baseUrl');
    await pause();
    await p.screenshot({ path: '/tmp/edocs-settings.png', fullPage: true });

    // тёмная тема
    await p.goto(base + '#edocs', { waitUntil: 'networkidle0' });
    await p.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));
    await p.waitForSelector('#edbCards .edb-card');
    await pause();
    await p.screenshot({ path: '/tmp/edocs-board-dark.png', fullPage: true });
    await p.goto(base + '#edocs/c/1', { waitUntil: 'networkidle0' });
    await p.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));
    await p.waitForSelector('#edcHead .edc-head');
    await pause();
    await p.screenshot({ path: '/tmp/edocs-client-dark.png', fullPage: true });
    await p.evaluate(() => document.documentElement.removeAttribute('data-theme'));

    // телефон
    await p.setViewport({ width: 390, height: 844, isMobile: true });
    await p.goto(base + '#edocs', { waitUntil: 'networkidle0' });
    await p.waitForSelector('#edbCards .edb-card');
    await pause();
    await p.screenshot({ path: '/tmp/edocs-board-mobile.png', fullPage: true });
    assert.ok((await overflow()) <= 1, `горизонтальная прокрутка дашборда на 390px: ${await overflow()}px`);
    await p.goto(base + '#edocs/c/2', { waitUntil: 'networkidle0' });
    await p.waitForSelector('#edcDocs .edc-doc');
    await pause();
    await p.screenshot({ path: '/tmp/edocs-client-mobile.png', fullPage: true });
    assert.ok((await overflow()) <= 1, `горизонтальная прокрутка страницы пациента на 390px: ${await overflow()}px`);

    // анкета пациента на телефоне
    const a = await browser.newPage();
    a.on('pageerror', (e) => errors.push('anketa: ' + e.message));
    await a.setViewport({ width: 390, height: 844, isMobile: true });
    await a.goto(base + `anketa/${TOKEN}`, { waitUntil: 'networkidle0' });
    await a.waitForSelector('#aForm:not([hidden]) #af-passport_series');
    assert.equal(await a.$eval('#aHello', (el) => el.textContent), 'Здравствуйте, Карина!');
    await pause();
    await a.screenshot({ path: '/tmp/edocs-anketa-mobile.png', fullPage: true });
    await a.click('#aSubmit');
    assert.match(await a.$eval('#aMsg', (el) => el.textContent), /Заполните отмеченные поля/);
    for (const [k, v] of [['last_name', 'Абдуллаева'], ['first_name', 'Карина'], ['birth_date', '1991-03-14'], ['passport_series', '4512'], ['passport_number', '123456'],
      ['issue_date', '2011-04-22'], ['authority_code', '770-093'], ['issued_by', 'ОВД района'], ['address', 'Москва, ул. Профсоюзная, 1']]) {
      await a.$eval('#af-' + k, (el, val) => { el.value = val; }, v);
    }
    await a.click('#aConsent');
    await a.click('#aSubmit');
    await a.waitForSelector('#aDone:not([hidden])');
    await pause();
    await a.screenshot({ path: '/tmp/edocs-anketa-done.png' });

    // роль кассира: настроек нет
    await p.evaluate(() => localStorage.setItem('edRole', 'admin_cashier'));
    await p.setViewport({ width: 1280, height: 900 });
    await p.goto(base + '?role=cashier#edocs/settings', { waitUntil: 'networkidle0' });   // полная загрузка: роль читается при старте
    await p.waitForSelector('#edbCards .edb-card');
    assert.equal(await p.evaluate(() => location.hash), '#edocs');
    assert.equal(await p.$eval('#edTabBtn-settings', (el) => el.style.display), 'none');

    assert.deepEqual(errors, []);
    console.log('OK: дашборд (сегодня, неделя, вся база), автоматизация, страница пациента (данные, анкета, акт, бумага, F5, старый адрес), комплект на бумаге, настройки, '
      + 'тёмная тема, 390px, анкета пациента, роль кассира. Скриншоты /tmp/edocs-*.png');
  } finally {
    if (browser) await browser.close();
    server.close();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
```

- [ ] **Step 2: Прогон**

```bash
cd backend && node scripts/edocs-visual.js 2>&1 | tail -2
```

Ожидается: `OK: дашборд (сегодня, неделя, вся база), автоматизация, страница пациента (данные, анкета, акт, бумага, F5, старый адрес), комплект на бумаге, настройки, тёмная тема, 390px, анкета пациента, роль кассира. Скриншоты /tmp/edocs-*.png`.

- [ ] **Step 3: Скриншоты — глазами**

Открыть `/tmp/edocs-board.png`, `/tmp/edocs-board-dark.png`, `/tmp/edocs-board-mobile.png`, `/tmp/edocs-client.png`, `/tmp/edocs-client-act.png`, `/tmp/edocs-act-modal.png`, `/tmp/edocs-form-modal.png`, `/tmp/edocs-paper-modal.png`, `/tmp/edocs-automation.png`, `/tmp/edocs-anketa-mobile.png`: текст не налезает, имена не рвутся посреди слова, кнопки не обрезаны, цвета состояний различимы в обеих темах, на 390 px нет горизонтальной прокрутки. Сравнить с макетом `docs/superpowers/specs/2026-10-25-edocs-board-mockup/`.

- [ ] **Step 4: Коммит**

```bash
git add backend/scripts/edocs-visual.js
git commit -m "test(edocs): визуальный стенд дашборда, страницы пациента и анкеты" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

### Task 17: Контрольная точка B — **основная сессия**

Скриншоты и тесты фронта целиком, ревью диффа фронта.

- [ ] **Step 1: Все тесты модуля**

```bash
cd backend && npx jest backend/edocs- 2>&1 | grep -E "^(Tests|Test Suites):"; cd .. && node --test frontend/js/pages/edocs.test.js 2>&1 | grep -E "^# (pass|fail)"
```

Ожидается: `Test Suites: 16 passed, 16 total`, `Tests: 316 passed, 316 total`; `# pass 21`, `# fail 0`.

- [ ] **Step 2: Ревью диффа фронта**

`git diff c054ab7 -- frontend`: пользовательские строки экранируются (`escHtml`/`escAttr`) везде, где попадают в `innerHTML`; опрос гаснет при уходе со страницы и выходе из аккаунта; адрес в hash и F5 возвращают на тот же вид; роль кассира не видит настроек и снятия отметки «на бумаге»; правка JS/CSS — с новым `?v=`.

## Часть C. Документация, дев, приёмка

### Task 18: Документация — **Sonnet**

Раздел в `CLAUDE.md` перед «Key constraints»: где живут правила, что обязательно и когда, нумерация, анкета, автоматика, бумага, дев-защита, готчи и проверочные скрипты. Раздела о самом модуле F.Doc в `CLAUDE.md` пока нет — новый раздел ссылается на его спеку.

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Раздел в `CLAUDE.md`**

В `CLAUDE.md` найти:

```markdown
## Key constraints
```

заменить на:

```markdown
### «Документы»: дашборд подписей, страница пациента, анкета, автоматика (с 2026-10-25)
Статус: на ветке `feat/edocs-board` поверх модуля F.Doc (`c054ab7`, на деве; на проде нет). Спека `docs/superpowers/specs/2026-10-25-edocs-board-design.md` (+ макет), план `docs/superpowers/plans/2026-10-25-edocs-board.md`, основа — `docs/superpowers/specs/2026-10-24-fdoc-esign-design.md`. F.Doc на деве не подключён: электронная отправка, автоакт и повтор ссылки живьём не проверены.
- Правила — ТОЛЬКО в чистом `services/edocs/board.js` (тесты `edocs-board.test.js`); фронт ничего не считает и рисует ответ `GET /api/edocs/board` и `/clients/:id/page`. Обязательны договор и согласие ПД (до визита, раз на пациента) и акт (по каждой записи, когда `attendance=1` И `paid_full=1`, не раньше `edoc_settings.acts_required_from` — по умолчанию дата миграции, то есть выкат). Подписанный (в том числе бумажный) документ побеждает любой новый неудачный комплект. Карточка = пациент × день, цвет красный/оранжевый/синий/зелёный/серый; срочно — день прошёл, пациент пришёл или до начала ≤ 2 ч. Вид документа хранится в `edoc_documents.kind` (в одном комплекте бывают договор и акт). Номер договора в YClients подписанным договором НЕ считается (решение владельца).
- Номер договора (`counter.js`): данные пациента → поле YClients `nomer-dogovra` → счётчик `edoc_counters` (старт — максимум номеров салона + 1, занятые пропускаются), присваивается в `packages.send` ДО сборки DOCX одной транзакцией, повтор берёт тот же номер; в YClients не пишется. При автонумерации `missingFor(…, { autoContractNo })` номер недостающим не считает.
- Анкета (`forms.js`, `forms-store.js`; публичный `routes/public-anketa.js` монтируется ДО проверки `/api`; страница `frontend/anketa.html`): токен 32 байта base64url, в БД sha256 и шифротекст (QR и повтор ТОЙ ЖЕ ссылки); публичная сторона не отдаёт известных данных пациента, кроме личного имени; телефон анкетой не меняется; приём сливает данные и ФОНОМ шлёт только неподписанные документы. Строгий CSP, `no-store`, `no-referrer`, `noindex`, лимиты в памяти процесса. Доставка ссылки — `form-delivery.js` (каскад и авторство `system` ДО отправки — как у автоуведомлений).
- Автоматика (`automation.js`, крон `* * * * *`, `EDOCS_AUTOMATION=false` гасит крон): у салона по умолчанию выключена; действие застолбляется строкой `edoc_auto_jobs` (UNIQUE salon+kind+ref) ДО выполнения — at-most-once, неудача видна на карточке; тихие часы — из `notification_settings`; отправки F.Doc — от имени `auto_sender_user_id`. Настройки — отдельная ручка `/api/edocs/admin/automation` (форма подключения F.Doc сохраняется целиком и сбрасывает проверку ключа).
- Бумага (`paper.js`): комплект `paper`/`paper`, скан по сигнатуре в S3, снять отметку — только владелец/администратор с причиной.
- Дев-защита: `EDOCS_TEST_PHONES` — если задан, ЛЮБАЯ отправка пациенту из модуля (комплект, повтор ссылки, анкета в мессенджер; вручную и автоматикой) только на эти номера (`test-phones.js`); на деве `79200255591`, на проде НЕ задавать. `EDOCS_PUBLIC_URL` — адрес ссылок анкеты (обязателен автоматике).
- Опрос F.Doc: крон каждую минуту, «быстрая полоса» `store.DUE_SQL` — отправленные за 2 часа перечитываются раз в минуту.
- ГОТЧИ: путь теста — `npx jest backend/edocs-…` (в рабочей копии, чьё имя содержит «edocs», голый шаблон гонит весь репозиторий); `listLatestForms` при равном `created_at` ставит активную анкету первой; в откатываемой транзакции `NOW()` — время её начала; фронт — глобальные `ed`/`edb`/`edc`/`ED_` в общей области, тест грузит все `<script>` `index.html` одним `vm`; правка JS/CSS — с бампом `?v=`. Проверки: `scripts/edocs-board-smoke.js [--explain]` (дев-БД, ROLLBACK), `scripts/edocs-visual.js` (стенд без БД, скриншоты `/tmp/edocs-*.png`).

## Key constraints
```

- [ ] **Step 2: Раздел на месте**

```bash
grep -n "дашборд подписей, страница пациента" CLAUDE.md
```

Ожидается: одна строка с заголовком раздела.

- [ ] **Step 3: Коммит**

```bash
git add CLAUDE.md
git commit -m "docs(edocs): раздел CLAUDE.md о дашборде подписей, анкете и автоматике" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

### Task 19: Слияние в дев и живая проверка без F.Doc — **основная сессия**

Дев (`pm2 loyalpro`, порт 3001, БД `loyalpro_test`) работает из общей рабочей копии `/root/loyalpro` на ветке `feat/notifications-own-module`; в ней бывают чужие незакоммиченные правки других сессий. Дев получает РЕАЛЬНЫЕ вебхуки клиники и держит боевые аккаунты мессенджеров — поэтому `EDOCS_TEST_PHONES` ставится ДО рестарта. Автоматика остаётся выключенной в настройках салона. Проверяется всё, кроме электронной отправки (F.Doc на деве не подключён).

- [ ] **Step 1: СТОП-ТОЧКА: подтверждение пользователя**

`ListAgents`, затем вопрос пользователю: «Сливаю `feat/edocs-board` в `feat/notifications-own-module`, добавляю `EDOCS_PUBLIC_URL` и `EDOCS_TEST_PHONES` в `backend/.env` дева, ставлю `qrcode` и перезапускаю `pm2 loyalpro`?» Без явного «да» дальше не идти.

- [ ] **Step 2: Основное дерево готово к слиянию**

```bash
cd /root/loyalpro && git status --short && git diff --name-only feat/notifications-own-module...feat/edocs-board
```

Ожидается: изменённые (`M`) файлы основного дерева НЕ пересекаются со списком файлов ветки. Пересечение — стоп: сообщить пользователю (чужие незакоммиченные правки не коммитить, не прятать в stash, не откатывать). На 25.10.2026 пересекается `CLAUDE.md` — незакоммиченная правка раздела «Экономика» другой сессией; варианты для пользователя: та сессия коммитит свою правку, либо слить сейчас без коммита документации (задача 18), а его — следом.

- [ ] **Step 3: Слияние**

```bash
cd /root/loyalpro && git merge --no-ff feat/edocs-board -m "Merge feat/edocs-board: дашборд подписей, страница пациента, анкета, автоматика (дев)" && git log --oneline -2
```

Ожидается: коммит слияния без конфликтов.

- [ ] **Step 4: Переменные окружения дева**

```bash
cd /root/loyalpro/backend
grep -q '^EDOCS_PUBLIC_URL=' .env || printf '\nEDOCS_PUBLIC_URL=https://dev.zumrudin.ru\n' >> .env   # ведущий \n: .env может не кончаться переводом строки
grep -q '^EDOCS_TEST_PHONES=' .env || printf 'EDOCS_TEST_PHONES=79200255591\n' >> .env
grep -E '^EDOCS_(PUBLIC_URL|TEST_PHONES)=' .env
```

Ожидается: `EDOCS_PUBLIC_URL=https://dev.zumrudin.ru` и `EDOCS_TEST_PHONES=79200255591`.

- [ ] **Step 5: Зависимости и перезапуск**

```bash
cd /root/loyalpro/backend && npm install --no-audit --no-fund && node -e "require('qrcode')" && PORT=3001 pm2 restart loyalpro && sleep 8 && pm2 logs loyalpro --lines 80 --nostream 2>&1 | grep -iE "error|edocs" | tail -10
```

Ожидается: без новых ошибок запуска и миграций. ВНИМАНИЕ: именно `PORT=3001 pm2 restart loyalpro`, без `--update-env` (память проекта: с ним дев-сервер ломается); `.env` перечитывается при старте сам.

- [ ] **Step 6: Схема на месте (MCP postgres, дев-БД)**

Через `mcp__postgres__query`:

```sql
SELECT (SELECT count(*) FROM information_schema.columns WHERE table_name = 'edoc_settings'
          AND column_name IN ('auto_previsit', 'auto_act', 'auto_remind', 'contract_autonumber', 'acts_required_from', 'form_ttl_days')) AS settings_cols,
       (SELECT count(*) FROM information_schema.tables WHERE table_name IN ('edoc_counters', 'edoc_auto_jobs', 'edoc_patient_forms')) AS tables,
       (SELECT count(*) FROM information_schema.columns WHERE table_name = 'edoc_documents' AND column_name = 'kind') AS doc_kind,
       (SELECT to_char(acts_required_from, 'YYYY-MM-DD') FROM edoc_settings WHERE salon_id = 1) AS acts_from;
```

Ожидается: `settings_cols = 6`, `tables = 3`, `doc_kind = 1`, `acts_from` — дата выката (миграции глотают ошибки — сверка обязательна, CLAUDE.md).

- [ ] **Step 7: SQL и ручки на живой схеме**

```bash
cd /root/loyalpro/backend && node scripts/edocs-board-smoke.js 2>&1 | grep -E "неделя|в порядке|ОШИБКА"
```

Ожидается: сводка недели и строка `SQL дашборда «Документов» в порядке (транзакция откатывается)`.

- [ ] **Step 8: Живьём в браузере (владелец или администратор)**

На https://dev.zumrudin.ru/#edocs (если у исполнителя нет учётки — попросить пользователя и дождаться ответа):
1. Дашборд «Сегодня» на реальных записях: карточки цветные, счётчики периодов, «Неделя» и «Вся база» открываются, поиск работает.
2. Карточка → страница пациента; F5 остаётся на ней; «← Документы» возвращает на дашборд.
3. Тестовый пациент `79200255591`: «✉ Анкета пациенту» → окно с QR-кодом и ссылкой → открыть ссылку на телефоне (или сканировать QR) → заполнить → «Спасибо»; на странице пациента блок данных позеленел, в истории «Пациент заполнил анкету».
4. Там же 📎 («Подписано на бумаге») на карточке согласия, со сканом (PDF или фото) → плитка «✓ бумага»; «Открыть комплект» → «Снять отметку» с причиной → плитка снова «нет».
5. «✉ Отправить в мессенджер» в окне анкеты того же тестового пациента — сообщение пришло в его мессенджер; для ДРУГОГО пациента отправка отказывает (тестовый режим `EDOCS_TEST_PHONES`) — анкету этому пациенту сразу «Отозвать».
6. «⚙ Автоматизация» открывается и сохраняется; автоматика остаётся выключенной.
Электронная отправка на подпись заблокирована, пока F.Doc не подключён, — ожидаемо.

- [ ] **Step 9: Стоп-точка: отчёт пользователю**

Ссылка на дев, что проверено живьём и что нет (F.Doc), открытые вопросы. Дальше — только по решению владельца (подключение F.Doc на демо-стенде, прод).

### Task 20: Итоговое ревью и память — **основная сессия**

Приёмка по спеке и запись в память проекта.

- [ ] **Step 1: Сверка со спекой**

Пройти спеку `docs/superpowers/specs/2026-10-25-edocs-board-design.md` по разделам 3–11 и отметить, что реализовано и проверено (тест, смоук, стенд, живьём), а что ждёт F.Doc. Расхождения — либо правка кода отдельным коммитом, либо правка спеки с объяснением.

- [ ] **Step 2: Память**

Обновить `/root/.claude/projects/-root-loyalpro/memory/edocs_ui_dashboard_mockup_2026_10_25.md`: статус «реализовано и слито в дев» с датой и коммитом слияния из задачи 19, что проверено живьём и что ждёт F.Doc; поправить строку в `MEMORY.md`.

## Самопроверка плана

- Спека §3 (состояния, цвет, подпись, действие) — задача 2; §4 (дашборд) — 10, 14, 15; §5 (страница пациента, правка акта и договора) — 10, 14; §6 (анкета, публичные ручки, доставка) — 6, 7, 8, 10, 11; §7 (автоматика) — 9, 10, 14; §8 (бумага) — 5, 10, 14; §9 (нумерация) — 3, 4, 10; §10 (данные) — 1; §11 (API) — 10; §12 (фронт) — 14, 15; §13 (тесты) — каждая задача, 12, 16; §14 (выкат на дев) — 19.
- Вне плана: прод (решение владельца вместе с самим модулем «Документы»), живая электронная отправка, автоакт и повтор ссылки (после подключения F.Doc на демо-стенде).
