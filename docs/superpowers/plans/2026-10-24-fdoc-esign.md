# «Документы»: электронное подписание с пациентами через F.Doc — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Модуль «📄 Документы»: администратор выбирает пациента, проверяет и дополняет его данные (паспорт хранится у нас шифрованно), выбирает DOCX-шаблоны — договор, согласие на обработку ПДн, акт по визиту, — система заполняет их и отправляет комплект в F.Doc; клиника подписывает КЭП организации автоматически, пациент — по SMS-ссылке и коду; статусы и подписанные PDF видны в LoyalPro.

**Architecture:** Документы собираются у нас из DOCX-шаблонов салона (docxtemplater) и уходят в F.Doc готовыми файлами через `POST /paperless-gateway/api/v1/document/withSigners` под учётной записью F.Doc конкретного сотрудника. Чистые модули `backend/services/edocs/*` (словарь тегов, DOCX, ФИО и данные пациента, строки акта, заполнение, статусы, тело запроса), HTTP-клиент `services/fdoc/client.js`, SQL `store.js`, оркестрация `packages.js`; роутеры `/api/edocs/admin` и `/api/edocs`, вебхук `/fdoc/webhook/<секрет>` и крон-опрос статусов; страница `frontend/js/pages/edocs.js` с адресом в hash. Секреты — AES-256-GCM (`utils/secret-box.js`, ключ `EDOCS_ENC_KEY`).

**Tech Stack:** Node.js 22 / Express, `pg` без ORM, НОВЫЕ зависимости `docxtemplater@3.71.1` + `pizzip@3.3.0`, `axios`, `multer`, `sharp`, S3 (`services/s3.js`), Jest (`npx jest edocs`), фронт vanilla JS + `node --test`, puppeteer + системный Chrome для визуального стенда.

**Спека:** `docs/superpowers/specs/2026-10-24-fdoc-esign-design.md` (решения владельца — §2, уточнена по прототипу). Исследование API F.Doc — `docs/2026-10-24-fdoc-esign-feasibility.md`.

**Проверено при подготовке плана (24.10.2026).** Весь код плана собран и прогнан во временной копии репозитория от `072c1b9`: `npx jest edocs` — 151 тест в 9 наборах; `node --test frontend/js/pages/edocs.test.js` — 11 тестов, прочие фронт-тесты проекта зелёные; весь SQL `store.js` выполнен на дев-БД в откатываемой транзакции (`scripts/edocs-store-smoke.js --create-tables`, 25 проверок); визуальный стенд прошёл в headless Chrome (две темы, 390 px, F5, роль кассира, скриншоты просмотрены глазами); скрипт демо-стенда достучался до настоящего `https://demo.fdoc.ru` (401 на поддельный ключ). По пути пойманы и учтены ловушки: `InspectModule` docxtemplater падает без lodash (берём штатный `doc.getTags()`), экспорт вебхука с именем `handle` ломал express.Router, глобальный стиль делает чекбоксы во всю ширину, а активную вкладку тёмной темы — белой. Сам план тоже проверен: все его шаги («Создать», «найти → заменить», «дописать») механически применены к чистой копии `072c1b9` — получившиеся файлы совпали с прототипом байт в байт, тесты в этой копии зелёные. НЕ проверено: живой обмен с F.Doc (нет доступов) — задача 20.

**Ветка и рабочая копия:** новая ветка `feat/fdoc-esign` от `feat/notifications-own-module` (ветка дева), рабочая копия `/root/loyalpro-fdoc` со своими `node_modules`; `.env` копируется из основного дерева (он в `.gitignore`). Все команды плана — из `/root/loyalpro-fdoc`, если не сказано иное. На дев модуль попадает слиянием в `feat/notifications-own-module` (задача 18, со стоп-точкой). На прод — отдельным решением владельца по runbook (задача 19).

**Блокеры:** демо-доступы F.Doc (API Key, логин/пароль/код приложения, учётная запись сотрудника) и регистрация IP для вебхуков нужны только задаче 20. Всё остальное выполняется без них.

**Коммиты:** трейлер `Co-Authored-By` — модель-исполнитель задачи (указан в командах).

**Раскладка по моделям** (правило из памяти: механика — Sonnet, связное ядро — Opus, контрольные точки — Fable в основной сессии; Haiku не влезает в контекст репозитория). Код в задачах дан целиком и уже проверен, поэтому задачи — в основном перенос и прогон; Opus стоит там, где ошибка переноса дорогая: внешний API, деньги и секреты, большая страница.

| Задача | Модель | Почему |
|---|---|---|
| 0. Рабочая копия, зависимости, документы | Sonnet | команды |
| 1. Шифрование секретов | Sonnet | готовый код и тесты |
| 2. Миграции и чтение из S3 | Sonnet | блок `CREATE TABLE IF NOT EXISTS` по образцу |
| 3. Сумма прописью и форматы | Sonnet | чистые функции |
| 4. Словарь тегов и DOCX | Sonnet | чистые модули, библиотека проверена |
| 5. ФИО и данные пациента | Sonnet | чистые модули |
| 6. Строки акта, заполнение, статусы, ошибки | Sonnet | чистые модули |
| 7. Клиент F.Doc | Opus | токены, single-flight, повторы, утечка ключа в логах |
| 8. Слой данных и проверка SQL | Opus | SQL + живая проверка на дев-БД |
| 9. Оркестрация комплектов | Opus | ядро: отправка, повтор без дубля, статусы, PDF |
| 10. Роутер настроек и шаблонов | Opus | секреты, загрузка файлов, валидация |
| 11. Роутер оформления, вебхук, проводка | Opus | роли, вебхук без JWT, крон |
| 12. Контрольная точка A | Fable | ревью бэкенда, сравнение полного jest с базой |
| 13. Чистые помощники фронта | Sonnet | готовый код |
| 14. Страница «Документы» | Opus | большая страница, разметка, роутер hash |
| 15. Встройки в «Клиентов» и «Записи» | Sonnet | точечные правки |
| 16. Визуальный стенд | Sonnet | готовый скрипт |
| 17. Контрольная точка B | Fable | скриншоты, тесты |
| 18. Слияние в дев и проверка без F.Doc | Sonnet + стоп-точка | merge, `.env`, рестарт, смоук |
| 19. Документация | Sonnet | тексты даны |
| 20. Живой F.Doc на демо-стенде | Opus | блокер: доступы; выводы могут потребовать правок |
| 21. Итоговое ревью | Fable | приёмка, отчёт |

**Порядок:** строго 0 → 21. Часть A — бэкенд (0–12), B — фронт (13–17), C — дев и живой F.Doc (18–21). Исполнение по одной задаче, короткий отчёт в чат после каждой, без фоновых агентов (предпочтение пользователя). Перед запуском исполнителей контроллер вызывает `ListAgents`: вторая сессия в `/root/loyalpro` может вести этот же план.

---

## Карта файлов

Создаются (бэкенд):
- `backend/utils/secret-box.js` — AES-256-GCM, ключ `EDOCS_ENC_KEY` из config, fail-closed.
- `backend/utils/money-words.js` — сумма прописью для актов.
- `backend/services/edocs/format.js` — даты дд.мм.гггг, деньги, телефон, видимый пропуск «________».
- `backend/services/edocs/placeholders.js` — словарь тегов, проверка шаблона, полнота данных под набор шаблонов.
- `backend/services/edocs/docx.js` — разбор (`doc.getTags()`) и заполнение DOCX.
- `backend/services/edocs/__fixtures__/docx.js` — сборка DOCX кодом для тестов и скриптов (без бинарных фикстур).
- `backend/services/edocs/fio.js` — разбор ФИО одной строкой.
- `backend/services/edocs/identity.js` — данные пациента: проверка формы, шифрование паспорта, маска, предзаполнение, распознавание.
- `backend/services/edocs/act-lines.js` — строки акта из записи и после правок.
- `backend/services/edocs/fill.js` — данные для рендера по словарю.
- `backend/services/edocs/statuses.js` — статусы F.Doc → наши, разбор ответа о подписантах.
- `backend/services/edocs/errors.js` — `EdocsError`, `shortError`, `sendError` (HTTP-ответ на ошибку).
- `backend/services/edocs/send-body.js` — тело `withSigners`, имена файлов.
- `backend/services/edocs/store.js` — весь SQL модуля, ограничен `salon_id`.
- `backend/services/edocs/packages.js` — отправка, повтор, статусы, PDF, действия.
- `backend/services/fdoc/client.js` — HTTP-клиент F.Doc с кэшем токенов.
- `backend/routes/edocs-admin.js`, `backend/routes/edocs.js`, `backend/routes/fdoc-webhook.js`.
- Тесты `backend/edocs-{secret-box,format,docx,identity,fill,fdoc-client,packages,admin-routes,routes}.test.js`.
- Скрипты `backend/scripts/edocs-store-smoke.js`, `edocs-visual.js`, `edocs-sample-templates.js`, `edocs-fdoc-e2e.js`.

Создаются (фронт и доки):
- `frontend/js/pages/edocs-helpers.js`, `frontend/js/pages/edocs.js`, `frontend/js/pages/edocs.test.js`.
- `docs/2026-10-24-edocs-acceptance.md`, `docs/2026-10-24-edocs-runbook.md`.

Меняются:
- `backend/package.json`, `backend/package-lock.json` — docxtemplater, pizzip.
- `backend/config.js` — `EDOCS_ENC_KEY`, `EDOCS_DEMO_PHONES`, префикс `/api/edocs` для администратора-кассира.
- `backend/migrations.js` — 7 таблиц в конце `runMigrations`.
- `backend/services/s3.js` — `getObjectBuffer`.
- `backend/utils/person-name.js` — экспорт регэкспов отчества.
- `backend/routes/index.js` — вебхук и два роутера.
- `backend/server.js` — крон опроса статусов.
- `frontend/index.html` — пункт меню (оба меню), страница, модалка «Мой F.Doc», скрипты, колонка «Акт» в «Записях», бамп `?v=`.
- `frontend/js/core/nav.js` — загрузка страницы, хвост hash, остановка опроса.
- `frontend/js/pages/clients.js`, `frontend/js/pages/records.js` — встройки.
- `frontend/css/features.css` — стили страницы.
- `CLAUDE.md` — раздел модуля.

## Общие формы данных

```js
// Данные пациента (identity.decodeRow):
{ plain:  { last_name, first_name, middle_name, birth_date: 'YYYY-MM-DD'|null, gender: 'F'|'M'|null,
            phone: '7XXXXXXXXXX'|null, email, contract_no, contract_date },
  secure: { passport_series: '4510', passport_number: '123456', issued_by, issue_date: 'YYYY-MM-DD',
            authority_code: '770-001', birth_place, address },        // только заполненные поля
  secure_fields: ['passport_series', 'passport_number'] }              // без расшифровки
// Шаблон (edoc_templates): { id, kind: 'contract'|'consent_pd'|'act'|'other', title, file_key, placeholders: ['fio', …], is_active }
// Строка акта: { service_id: number|null, title, qty, price, sum }   // скидка = qty × price − sum, не меньше 0
// Акт в payload комплекта: { act_no, visit_date, doctor_name, doctor_position, lines: [строки акта] }
// Параметры клиента F.Doc (packages.fdocConfig): { baseUrl, apiKey, appLogin, appPassword, appCode, corpId }
// Учётка сотрудника (packages.credFor): { userId, login, password, failCount }
// Статусы комплекта: draft | sent | signed | declined | annulled | expired | paper | error
// Ошибка модуля: EdocsError { code, message, status, missing?, packageId? } → errors.sendError → HTTP
```

---

## Часть A. Бэкенд

### Task 0: Рабочая копия, зависимости, документы — **Sonnet**

**Files:**
- Modify: `backend/package.json`, `backend/package-lock.json`
- Create (копии из основного дерева): `docs/2026-10-24-fdoc-esign-feasibility.md`, `docs/superpowers/specs/2026-10-24-fdoc-esign-design.md`, `docs/superpowers/plans/2026-10-24-fdoc-esign.md`

- [ ] **Step 1: Создать ветку и рабочую копию**

```bash
cd /root/loyalpro && git worktree add -b feat/fdoc-esign /root/loyalpro-fdoc feat/notifications-own-module && git -C /root/loyalpro-fdoc log --oneline -1
```

Ожидается: строка последнего коммита ветки дева; `/root/loyalpro-fdoc` создан. Незакоммиченные правки основного дерева в рабочую копию не попадают — так и надо.

- [ ] **Step 2: Окружение и зависимости**

```bash
cd /root/loyalpro-fdoc/backend
cp /root/loyalpro/backend/.env .env                       # в .gitignore; нужен скриптам с БД (задачи 8, 18)
PUPPETEER_SKIP_DOWNLOAD=1 npm ci --no-audit --no-fund     # Chrome системный: /usr/bin/google-chrome
npm install --no-audit --no-fund docxtemplater@3.71.1 pizzip@3.3.0
node -e "console.log(require('docxtemplater/package.json').version, require('pizzip/package.json').version)"
git -C /root/loyalpro-fdoc status --short
```

Ожидается: `3.71.1 3.3.0`; в статусе только `M backend/package.json` и `M backend/package-lock.json` (`.env` игнорируется).

- [ ] **Step 3: Базовая линия тестов до правок**

```bash
cd /root/loyalpro-fdoc/backend && npx jest agent-person-name 2>&1 | grep -E "Tests:"
cd /root/loyalpro-fdoc && node --test frontend/js/pages/notifications.test.js 2>&1 | grep -E "^# (pass|fail)"
```

Ожидается: `Tests: 28 passed`; `# pass 39`, `# fail 0`.

- [ ] **Step 4: Документы модуля — в ветку**

```bash
cd /root/loyalpro-fdoc && mkdir -p docs/superpowers/specs docs/superpowers/plans
cp /root/loyalpro/docs/2026-10-24-fdoc-esign-feasibility.md docs/
cp /root/loyalpro/docs/superpowers/specs/2026-10-24-fdoc-esign-design.md docs/superpowers/specs/
cp /root/loyalpro/docs/superpowers/plans/2026-10-24-fdoc-esign.md docs/superpowers/plans/
```

Ожидается: три файла скопированы. Копии в основном дереве пока остаются (неотслеживаемые) — их уберёт задача 18 перед слиянием.

- [ ] **Step 5: Commit**

```bash
cd /root/loyalpro-fdoc && git add backend/package.json backend/package-lock.json docs/2026-10-24-fdoc-esign-feasibility.md docs/superpowers/specs/2026-10-24-fdoc-esign-design.md docs/superpowers/plans/2026-10-24-fdoc-esign.md && git commit -m "chore(edocs): зависимости docxtemplater и pizzip, исследование F.Doc, спека и план «Документов»

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 1: Шифрование секретов — **Sonnet**

Паспорт, пароли F.Doc сотрудников, ключ API и пароль приложения хранятся шифротекстом AES-256-GCM. Нет ключа — модуль бросает `SecretBoxError` с кодом `no_key`, роутеры отвечают 503 (задачи 10–11). Ключ читается из `config` лениво: модуль можно подключить без ключа. Здесь же в `config.js` добавляется `EDOCS_DEMO_PHONES` — список номеров, на которые разрешена отправка с демо-стенда F.Doc (используется в задаче 9).

**Files:**
- Create: `backend/utils/secret-box.js`
- Modify: `backend/config.js` (рядом с `S3_URL_TTL_SECONDS`)
- Test: `backend/edocs-secret-box.test.js`

- [ ] **Step 1: Написать падающий тест**

Создать `backend/edocs-secret-box.test.js`:

```js
'use strict';
const KEY = Buffer.alloc(32, 7).toString('base64');
jest.mock('./config', () => ({ EDOCS_ENC_KEY: Buffer.alloc(32, 7).toString('base64') }));
const { makeBox, box, isConfigured, SecretBoxError } = require('./utils/secret-box');

describe('secret-box', () => {
  const b = makeBox(KEY);

  test('шифрует и расшифровывает строку с кириллицей', () => {
    const enc = b.encrypt('Паспорт 4510 123456, кем выдан: ОВД «Тверской»');
    expect(enc.startsWith('v1:')).toBe(true);
    expect(enc).not.toContain('4510');
    expect(b.decrypt(enc)).toBe('Паспорт 4510 123456, кем выдан: ОВД «Тверской»');
  });

  test('одно и то же значение даёт разный шифротекст (случайный IV)', () => {
    expect(b.encrypt('x')).not.toBe(b.encrypt('x'));
  });

  test('JSON туда и обратно', () => {
    const o = { passport_series: '4510', passport_number: '123456' };
    expect(b.decryptJson(b.encryptJson(o))).toEqual(o);
  });

  test('подмена данных ловится проверкой тега', () => {
    const enc = b.encrypt('секрет');
    const parts = enc.split(':');
    const data = Buffer.from(parts[3], 'base64'); data[0] ^= 1; parts[3] = data.toString('base64');
    expect(() => b.decrypt(parts.join(':'))).toThrow(SecretBoxError);
    try { b.decrypt(parts.join(':')); } catch (e) { expect(e.code).toBe('bad_box'); }
  });

  test('чужой ключ не расшифровывает', () => {
    const other = makeBox(Buffer.alloc(32, 9).toString('base64'));
    expect(() => other.decrypt(b.encrypt('секрет'))).toThrow(/чужой ключ/);
  });

  test('битый формат — bad_box', () => {
    for (const bad of ['', 'v1:abc', 'v2:a:b:c', null, undefined]) {
      expect(() => b.decrypt(bad)).toThrow(SecretBoxError);
    }
  });

  test('нет ключа или ключ не 32 байта — no_key', () => {
    for (const k of ['', null, undefined, Buffer.alloc(16).toString('base64')]) {
      try { makeBox(k); throw new Error('не бросил'); } catch (e) { expect(e.code).toBe('no_key'); }
    }
  });

  test('box() берёт ключ из config, isConfigured() — true', () => {
    expect(isConfigured()).toBe(true);
    expect(box().decrypt(b.encrypt('из config'))).toBe('из config');
  });
});
```

- [ ] **Step 2: Убедиться, что тест падает**

```bash
cd /root/loyalpro-fdoc/backend && npx jest edocs-secret-box
```

Ожидается: FAIL с `Cannot find module './utils/secret-box'`.

- [ ] **Step 3: Реализация**

Создать `backend/utils/secret-box.js`:

```js
'use strict';
// Шифрование секретов модуля «Документы» (AES-256-GCM): паспортные данные
// пациентов, пароли F.Doc сотрудников, ключ API и пароль приложения F.Doc.
// Ключ — env EDOCS_ENC_KEY (32 байта в base64). Ключа нет — бросаем
// (fail-closed): открытым текстом эти данные не пишутся никогда.
// Формат: v1:<iv>:<tag>:<данные> (base64) — версия оставляет место для ротации ключа.
// ВНИМАНИЕ: потеря ключа = потеря всех зашифрованных данных; у дева и прода ключи разные.
const crypto = require('crypto');

const VERSION = 'v1';

class SecretBoxError extends Error {
  constructor(code, message) { super(message); this.name = 'SecretBoxError'; this.code = code; }
}

function parseKey(raw) {
  const s = String(raw || '').trim();
  const key = s ? Buffer.from(s, 'base64') : Buffer.alloc(0);
  if (key.length !== 32) throw new SecretBoxError('no_key', 'EDOCS_ENC_KEY не задан или не 32 байта в base64');
  return key;
}

function makeBox(rawKey) {
  const key = parseKey(rawKey);
  function encrypt(plain) {
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv('aes-256-gcm', key, iv);
    const data = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
    return [VERSION, iv.toString('base64'), c.getAuthTag().toString('base64'), data.toString('base64')].join(':');
  }
  function decrypt(box) {
    const parts = String(box || '').split(':');
    if (parts.length !== 4 || parts[0] !== VERSION) throw new SecretBoxError('bad_box', 'Повреждённый шифротекст');
    try {
      const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(parts[1], 'base64'));
      d.setAuthTag(Buffer.from(parts[2], 'base64'));
      return Buffer.concat([d.update(Buffer.from(parts[3], 'base64')), d.final()]).toString('utf8');
    } catch (e) {
      throw new SecretBoxError('bad_box', 'Шифротекст не прошёл проверку: чужой ключ или подмена');
    }
  }
  return {
    encrypt,
    decrypt,
    encryptJson: (obj) => encrypt(JSON.stringify(obj)),
    decryptJson: (box) => JSON.parse(decrypt(box)),
  };
}

// Ключ читается из config лениво: модуль можно подключить и без ключа, а бросит
// он только при попытке зашифровать или расшифровать.
let cached = null;
function box() {
  if (!cached) cached = makeBox(require('../config').EDOCS_ENC_KEY);
  return cached;
}
function isConfigured() {
  try { parseKey(require('../config').EDOCS_ENC_KEY); return true; } catch { return false; }
}

module.exports = { makeBox, box, isConfigured, SecretBoxError };
```

- [ ] **Step 4: Ключи в config**

В `backend/config.js` найти:

```js
  S3_FORCE_PATH_STYLE: process.env.S3_FORCE_PATH_STYLE === 'true',
  S3_URL_TTL_SECONDS: parseInt(process.env.S3_URL_TTL_SECONDS, 10) || 900,

  // Sync
```

заменить на:

```js
  S3_FORCE_PATH_STYLE: process.env.S3_FORCE_PATH_STYLE === 'true',
  S3_URL_TTL_SECONDS: parseInt(process.env.S3_URL_TTL_SECONDS, 10) || 900,

  // «Документы» (F.Doc): ключ AES-256-GCM для паспортных данных и паролей F.Doc —
  // 32 байта в base64 (`node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`).
  // Пусто — модуль не сохраняет ни паспорт, ни пароли (503). Потеря ключа = потеря данных.
  EDOCS_ENC_KEY: process.env.EDOCS_ENC_KEY || '',
  // На ДЕМО-стенде F.Doc (demo.*) отправка разрешена только на эти номера: в дев-БД живые
  // пациенты, а демо-контур шлёт настоящие SMS. Через запятую, канон 7XXXXXXXXXX.
  EDOCS_DEMO_PHONES: (process.env.EDOCS_DEMO_PHONES || '79200255591').split(',').map((s) => s.replace(/\D/g, '')).filter(Boolean),

  // Sync
```

- [ ] **Step 5: Тест проходит**

```bash
cd /root/loyalpro-fdoc/backend && npx jest edocs-secret-box 2>&1 | grep -E "Tests:"
```

Ожидается: `Tests: 8 passed, 8 total`.

- [ ] **Step 6: Commit**

```bash
cd /root/loyalpro-fdoc && git add backend/utils/secret-box.js backend/config.js backend/edocs-secret-box.test.js && git commit -m "feat(edocs): AES-256-GCM для паспорта и паролей F.Doc, ключи EDOCS_ENC_KEY и EDOCS_DEMO_PHONES

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Миграции и чтение из S3 — **Sonnet**

Семь таблиц модуля (спека §4.1) в конце `runMigrations`, все `IF NOT EXISTS` с `.catch(() => {})`, как соседние блоки. `client_identity` — CASCADE с клиентом (персональные данные уходят вместе с карточкой), `edoc_packages.client_id` — RESTRICT (след юридически значимого документа). Шифротексты — `TEXT`. В `services/s3.js` — чтение объекта в Buffer (шаблоны DOCX лежат в S3). SQL этих таблиц проверяется живьём в задаче 8 (`--create-tables`), поэтому здесь только синтаксис.

**Files:**
- Modify: `backend/migrations.js` (перед закрывающей скобкой `runMigrations`)
- Modify: `backend/services/s3.js`

- [ ] **Step 1: Таблицы «Документов»**

В `backend/migrations.js` найти:

```js
    )
  `).catch(() => {});
}
```

заменить на:

```js
    )
  `).catch(() => {});

  // ── «Документы»: электронное подписание с пациентами через F.Doc (спека
  // docs/superpowers/specs/2026-10-24-fdoc-esign-design.md). Секреты (ключ API, пароли,
  // паспорт) хранятся шифротекстом utils/secret-box (TEXT 'v1:…'), открытым — никогда.
  await client.query(`
    CREATE TABLE IF NOT EXISTS edoc_settings (
      salon_id          INTEGER PRIMARY KEY REFERENCES salons(id) ON DELETE CASCADE,
      enabled           BOOLEAN NOT NULL DEFAULT FALSE,
      base_url          VARCHAR(200) NOT NULL DEFAULT 'https://demo.fdoc.ru',
      api_key_enc       TEXT,
      app_login         VARCHAR(200),
      app_password_enc  TEXT,
      app_code          VARCHAR(100),
      corp_id           VARCHAR(100),
      qes_cert_alias    VARCHAR(200),
      employee_position VARCHAR(200),
      requisites        JSONB NOT NULL DEFAULT '{}'::jsonb,
      unsign_days       INTEGER NOT NULL DEFAULT 14,
      webhook_secret    VARCHAR(64),
      last_webhook_at   TIMESTAMPTZ,
      updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `).catch(() => {});
  await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_edoc_settings_webhook ON edoc_settings (webhook_secret) WHERE webhook_secret IS NOT NULL`).catch(() => {});

  // Учётная запись F.Doc у каждого пользователя своя (решение владельца 24.10.2026):
  // в журнале F.Doc виден отправитель. Токены — только в памяти процесса.
  await client.query(`
    CREATE TABLE IF NOT EXISTS edoc_user_credentials (
      user_id       INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      salon_id      INTEGER NOT NULL REFERENCES salons(id) ON DELETE CASCADE,
      login         VARCHAR(200) NOT NULL,
      password_enc  TEXT NOT NULL,
      fail_count    INTEGER NOT NULL DEFAULT 0,
      last_ok_at    TIMESTAMPTZ,
      last_error    VARCHAR(300),
      updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `).catch(() => {});

  // Данные пациента для документов. Паспортная часть — одним шифротекстом secure_enc,
  // secure_fields — какие поля в нём заполнены (проверка полноты без расшифровки).
  await client.query(`
    CREATE TABLE IF NOT EXISTS client_identity (
      client_id     INTEGER PRIMARY KEY REFERENCES clients(id) ON DELETE CASCADE,
      salon_id      INTEGER NOT NULL REFERENCES salons(id) ON DELETE CASCADE,
      last_name     VARCHAR(100),
      first_name    VARCHAR(100),
      middle_name   VARCHAR(100),
      birth_date    DATE,
      gender        VARCHAR(1),
      phone         VARCHAR(20),
      email         VARCHAR(200),
      contract_no   VARCHAR(50),
      contract_date DATE,
      secure_enc    TEXT,
      secure_fields JSONB NOT NULL DEFAULT '[]'::jsonb,
      source        VARCHAR(20) NOT NULL DEFAULT 'manual',
      updated_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `).catch(() => {});
  await client.query(`CREATE INDEX IF NOT EXISTS idx_client_identity_salon ON client_identity (salon_id)`).catch(() => {});

  await client.query(`
    CREATE TABLE IF NOT EXISTS edoc_templates (
      id           SERIAL PRIMARY KEY,
      salon_id     INTEGER NOT NULL REFERENCES salons(id) ON DELETE CASCADE,
      kind         VARCHAR(20) NOT NULL,
      title        VARCHAR(200) NOT NULL,
      file_key     VARCHAR(300) NOT NULL,
      file_size    INTEGER NOT NULL DEFAULT 0,
      placeholders JSONB NOT NULL DEFAULT '[]'::jsonb,
      is_active    BOOLEAN NOT NULL DEFAULT TRUE,
      sort_order   INTEGER NOT NULL DEFAULT 0,
      created_by   INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `).catch(() => {});
  await client.query(`CREATE INDEX IF NOT EXISTS idx_edoc_templates_salon ON edoc_templates (salon_id, is_active, sort_order)`).catch(() => {});

  // Комплект: id — наш UUID, он же package.id в F.Doc. client_id — RESTRICT: строка
  // комплекта — след юридически значимого документа, молча исчезать с клиентом не должна.
  await client.query(`
    CREATE TABLE IF NOT EXISTS edoc_packages (
      id                   UUID PRIMARY KEY,
      salon_id             INTEGER NOT NULL REFERENCES salons(id) ON DELETE CASCADE,
      client_id            INTEGER NOT NULL REFERENCES clients(id) ON DELETE RESTRICT,
      record_id            INTEGER REFERENCES records(id) ON DELETE SET NULL,
      kind                 VARCHAR(20) NOT NULL,
      title                VARCHAR(200) NOT NULL,
      status               VARCHAR(20) NOT NULL DEFAULT 'draft',
      fdoc_status          VARCHAR(40),
      fdoc_package_guid    VARCHAR(100),
      payload              JSONB NOT NULL DEFAULT '{}'::jsonb,
      employee_url         TEXT,
      employee_url_at      TIMESTAMPTZ,
      sent_by              INTEGER REFERENCES users(id) ON DELETE SET NULL,
      sent_at              TIMESTAMPTZ,
      signed_at            TIMESTAMPTZ,
      last_error           VARCHAR(500),
      last_status_check_at TIMESTAMPTZ,
      created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `).catch(() => {});
  await client.query(`CREATE INDEX IF NOT EXISTS idx_edoc_packages_salon_status ON edoc_packages (salon_id, status)`).catch(() => {});
  await client.query(`CREATE INDEX IF NOT EXISTS idx_edoc_packages_salon_client ON edoc_packages (salon_id, client_id, created_at DESC)`).catch(() => {});
  await client.query(`CREATE INDEX IF NOT EXISTS idx_edoc_packages_record ON edoc_packages (salon_id, record_id) WHERE record_id IS NOT NULL`).catch(() => {});

  await client.query(`
    CREATE TABLE IF NOT EXISTS edoc_documents (
      id                 UUID PRIMARY KEY,
      package_id         UUID NOT NULL REFERENCES edoc_packages(id) ON DELETE CASCADE,
      salon_id           INTEGER NOT NULL REFERENCES salons(id) ON DELETE CASCADE,
      template_id        INTEGER REFERENCES edoc_templates(id) ON DELETE SET NULL,
      title              VARCHAR(200) NOT NULL,
      file_name          VARCHAR(250) NOT NULL,
      sort_order         INTEGER NOT NULL DEFAULT 0,
      fdoc_document_guid VARCHAR(100),
      fdoc_status        VARCHAR(40),
      client_signed_at   TIMESTAMPTZ,
      corp_signed_at     TIMESTAMPTZ,
      pdf_key            VARCHAR(300),
      pdf_fetched_at     TIMESTAMPTZ,
      created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `).catch(() => {});
  await client.query(`CREATE INDEX IF NOT EXISTS idx_edoc_documents_package ON edoc_documents (package_id)`).catch(() => {});

  // Журнал: отправки, статусы, вебхуки (тело целиком, кроме секрета), просмотры и
  // правки паспортных данных (кто и когда — без значений).
  await client.query(`
    CREATE TABLE IF NOT EXISTS edoc_events (
      id         BIGSERIAL PRIMARY KEY,
      salon_id   INTEGER NOT NULL REFERENCES salons(id) ON DELETE CASCADE,
      package_id UUID,
      client_id  INTEGER,
      kind       VARCHAR(30) NOT NULL,
      user_id    INTEGER,
      payload    JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `).catch(() => {});
  await client.query(`CREATE INDEX IF NOT EXISTS idx_edoc_events_package ON edoc_events (salon_id, package_id, created_at DESC)`).catch(() => {});
  await client.query(`CREATE INDEX IF NOT EXISTS idx_edoc_events_client ON edoc_events (salon_id, client_id, created_at DESC) WHERE client_id IS NOT NULL`).catch(() => {});
}
```

- [ ] **Step 2: Чтение объекта из S3**

В `backend/services/s3.js` найти:

```js
}

module.exports = { client, putObject, deleteObjects, presignGet };
```

заменить на:

```js
}

async function getObjectBuffer(key) {
  const obj = await client.send(new GetObjectCommand({ Bucket: cfg.S3_BUCKET, Key: key }));
  return Buffer.from(await obj.Body.transformToByteArray());
}

module.exports = { client, putObject, deleteObjects, presignGet, getObjectBuffer };
```

- [ ] **Step 3: Проверка синтаксиса и состава**

```bash
cd /root/loyalpro-fdoc/backend && node --check migrations.js && node --check services/s3.js && grep -cE "CREATE TABLE IF NOT EXISTS (edoc_|client_identity)" migrations.js
```

Ожидается: без ошибок синтаксиса; число `7`.

- [ ] **Step 4: Commit**

```bash
cd /root/loyalpro-fdoc && git add backend/migrations.js backend/services/s3.js && git commit -m "feat(edocs): таблицы модуля «Документы» и чтение объекта из S3

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Сумма прописью и форматы — **Sonnet**

Акт печатает итог прописью («Девяносто три тысячи пятьсот рублей 00 копеек»: тысячи — женского рода, копейки цифрами). Форматы документов: дд.мм.гггг, деньги с неразрывным пробелом, телефон `+7 (900) 123-45-67`, пустое значение — видимый пропуск `________`.

**Files:**
- Create: `backend/utils/money-words.js`, `backend/services/edocs/format.js`
- Test: `backend/edocs-format.test.js`

- [ ] **Step 1: Написать падающий тест**

Создать `backend/edocs-format.test.js`:

```js
'use strict';
const { rublesInWords, integerWords, plural } = require('./utils/money-words');
const { fmtDate, fmtMoney, fmtQty, fmtPhone, NBSP } = require('./services/edocs/format');

describe('rublesInWords', () => {
  test.each([
    [0, 'Ноль рублей 00 копеек'],
    [1, 'Один рубль 00 копеек'],
    [2, 'Два рубля 00 копеек'],
    [5, 'Пять рублей 00 копеек'],
    [11, 'Одиннадцать рублей 00 копеек'],
    [21, 'Двадцать один рубль 00 копеек'],
    [112, 'Сто двенадцать рублей 00 копеек'],
    [1000, 'Одна тысяча рублей 00 копеек'],
    [2000, 'Две тысячи рублей 00 копеек'],
    [5000, 'Пять тысяч рублей 00 копеек'],
    [11000, 'Одиннадцать тысяч рублей 00 копеек'],
    [21000, 'Двадцать одна тысяча рублей 00 копеек'],
    [93500, 'Девяносто три тысячи пятьсот рублей 00 копеек'],
    [1001.5, 'Одна тысяча один рубль 50 копеек'],
    [1000000, 'Один миллион рублей 00 копеек'],
    [2003004, 'Два миллиона три тысячи четыре рубля 00 копеек'],
    [0.01, 'Ноль рублей 01 копейка'],
    [0.02, 'Ноль рублей 02 копейки'],
    [7737.61, 'Семь тысяч семьсот тридцать семь рублей 61 копейка'],
  ])('%p → %s', (n, s) => expect(rublesInWords(n)).toBe(s));

  test('копейки округляются', () => expect(rublesInWords(10.005)).toBe('Десять рублей 01 копейка'));
  test('отрицательное, NaN и триллион — RangeError', () => {
    for (const bad of [-1, NaN, 'abc', 1e12]) expect(() => rublesInWords(bad)).toThrow(RangeError);
  });
  test('integerWords и plural', () => {
    expect(integerWords(40)).toBe('сорок');
    expect(plural(14, ['a', 'b', 'c'])).toBe('c');
    expect(plural(22, ['a', 'b', 'c'])).toBe('b');
  });
});

describe('форматы', () => {
  test('fmtDate', () => {
    expect(fmtDate('2026-10-24')).toBe('24.10.2026');
    expect(fmtDate('')).toBe('');
    expect(fmtDate(null)).toBe('');
    expect(fmtDate('24.10.2026')).toBe('');
  });
  test('fmtMoney', () => {
    expect(fmtMoney(12345.5)).toBe(`12${NBSP}345,50`);
    expect(fmtMoney(0)).toBe('0,00');
    expect(fmtMoney(1234567)).toBe(`1${NBSP}234${NBSP}567,00`);
    expect(fmtMoney(-5)).toBe('-5,00');
  });
  test('fmtQty', () => {
    expect(fmtQty(2)).toBe('2');
    expect(fmtQty(1.5)).toBe('1,5');
  });
  test('fmtPhone', () => {
    expect(fmtPhone('79001234567')).toBe('+7 (900) 123-45-67');
    expect(fmtPhone('+7 900 123-45-67')).toBe('+7 (900) 123-45-67');
    expect(fmtPhone('12345')).toBe('12345');
  });
});
```

- [ ] **Step 2: Убедиться, что тест падает**

```bash
cd /root/loyalpro-fdoc/backend && npx jest edocs-format
```

Ожидается: FAIL с `Cannot find module './utils/money-words'`.

- [ ] **Step 3: Сумма прописью**

Создать `backend/utils/money-words.js`:

```js
'use strict';
// Сумма прописью для актов: 93500 → «Девяносто три тысячи пятьсот рублей 00 копеек».
// Тысячи — женского рода («одна тысяча», «две тысячи»), рубли и миллионы — мужского.
const ONES_M = ['', 'один', 'два', 'три', 'четыре', 'пять', 'шесть', 'семь', 'восемь', 'девять'];
const ONES_F = ['', 'одна', 'две', 'три', 'четыре', 'пять', 'шесть', 'семь', 'восемь', 'девять'];
const TEENS = ['десять', 'одиннадцать', 'двенадцать', 'тринадцать', 'четырнадцать', 'пятнадцать',
  'шестнадцать', 'семнадцать', 'восемнадцать', 'девятнадцать'];
const TENS = ['', '', 'двадцать', 'тридцать', 'сорок', 'пятьдесят', 'шестьдесят', 'семьдесят', 'восемьдесят', 'девяносто'];
const HUNDREDS = ['', 'сто', 'двести', 'триста', 'четыреста', 'пятьсот', 'шестьсот', 'семьсот', 'восемьсот', 'девятьсот'];
const SCALES = [
  { forms: null, fem: false },
  { forms: ['тысяча', 'тысячи', 'тысяч'], fem: true },
  { forms: ['миллион', 'миллиона', 'миллионов'], fem: false },
  { forms: ['миллиард', 'миллиарда', 'миллиардов'], fem: false },
];

/** Форма слова по числу: forms = [для 1, для 2–4, для 5–20]. */
function plural(n, forms) {
  const n100 = n % 100, n10 = n % 10;
  if (n100 >= 11 && n100 <= 19) return forms[2];
  if (n10 === 1) return forms[0];
  if (n10 >= 2 && n10 <= 4) return forms[1];
  return forms[2];
}

function triad(n, fem) {
  const out = [];
  const h = Math.floor(n / 100), t = Math.floor(n / 10) % 10, o = n % 10;
  if (h) out.push(HUNDREDS[h]);
  if (t === 1) out.push(TEENS[o]);
  else {
    if (t) out.push(TENS[t]);
    if (o) out.push((fem ? ONES_F : ONES_M)[o]);
  }
  return out;
}

/** Целое неотрицательное число словами (мужской род единиц). */
function integerWords(n) {
  if (n === 0) return 'ноль';
  const parts = [];
  let scale = 0;
  while (n > 0) {
    const tri = n % 1000;
    if (tri) {
      const words = triad(tri, SCALES[scale].fem);
      if (SCALES[scale].forms) words.push(plural(tri, SCALES[scale].forms));
      parts.unshift(words.join(' '));
    }
    n = Math.floor(n / 1000);
    scale++;
  }
  return parts.join(' ');
}

/** «Одна тысяча один рубль 50 копеек». Копейки — цифрами, как принято в актах. */
function rublesInWords(amount) {
  const num = Number(amount);
  if (!Number.isFinite(num) || num < 0 || num >= 1e12) throw new RangeError('Сумма вне диапазона 0 … 999 999 999 999,99');
  const kop = Math.round(num * 100);
  const rub = Math.floor(kop / 100), k = kop % 100;
  const s = `${integerWords(rub)} ${plural(rub, ['рубль', 'рубля', 'рублей'])} `
    + `${String(k).padStart(2, '0')} ${plural(k, ['копейка', 'копейки', 'копеек'])}`;
  return s.charAt(0).toUpperCase() + s.slice(1);
}

module.exports = { rublesInWords, integerWords, plural };
```

- [ ] **Step 4: Форматы**

Создать `backend/services/edocs/format.js`:

```js
'use strict';
// Форматы значений в документах: даты дд.мм.гггг, деньги «12 345,50», телефон.
const NBSP = ' ';
const EMPTY = '________';   // пропуск, видимый в документе: «undefined» в договоре хуже

/** 'YYYY-MM-DD' → 'DD.MM.YYYY'; всё прочее → ''. */
function fmtDate(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ''));
  return m ? `${m[3]}.${m[2]}.${m[1]}` : '';
}

/** 12345.5 → '12 345,50' (разделитель тысяч — неразрывный пробел). */
function fmtMoney(n) {
  const v = Math.round(Number(n || 0) * 100) / 100;
  const [int, frac] = Math.abs(v).toFixed(2).split('.');
  return (v < 0 ? '-' : '') + int.replace(/\B(?=(\d{3})+(?!\d))/g, NBSP) + ',' + frac;
}

/** Количество: 2 → '2', 1.5 → '1,5'. */
function fmtQty(n) {
  const v = Math.round(Number(n || 0) * 1000) / 1000;
  return String(v).replace('.', ',');
}

/** '79001234567' → '+7 (900) 123-45-67'; не 11 цифр с 7 в начале — как есть. */
function fmtPhone(p) {
  const d = String(p || '').replace(/\D/g, '');
  if (!/^7\d{10}$/.test(d)) return String(p || '');
  return `+7 (${d.slice(1, 4)}) ${d.slice(4, 7)}-${d.slice(7, 9)}-${d.slice(9)}`;
}

module.exports = { NBSP, EMPTY, fmtDate, fmtMoney, fmtQty, fmtPhone };
```

- [ ] **Step 5: Тест проходит**

```bash
cd /root/loyalpro-fdoc/backend && npx jest edocs-format 2>&1 | grep -E "Tests:"
```

Ожидается: `Tests: 26 passed, 26 total`.

- [ ] **Step 6: Commit**

```bash
cd /root/loyalpro-fdoc && git add backend/utils/money-words.js backend/services/edocs/format.js backend/edocs-format.test.js && git commit -m "feat(edocs): сумма прописью и форматы значений в документах

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Словарь тегов и DOCX — **Sonnet**

Словарь тегов — единственный источник истины: по нему проверяется загруженный шаблон (неизвестные теги, теги акта вне акта, чужие теги в цикле), строится подсказка в настройках и считается, каких данных не хватает (без расшифровки паспорта — по `secure_fields`). `docx.js` берёт теги штатным `doc.getTags()` (документ и колонтитулы одним объектом) — **НЕ** `InspectModule`: он делает `require('lodash')`, которого нет в зависимостях docxtemplater. `errorLogging: false` — иначе библиотека печатает ошибки шаблона в stdout. Тестовые DOCX собираются кодом (`__fixtures__/docx.js`), бинарных фикстур в git нет.

**Files:**
- Create: `backend/services/edocs/__fixtures__/docx.js` (тестовая опора, нужна до теста)
- Create: `backend/services/edocs/placeholders.js`, `backend/services/edocs/docx.js`
- Test: `backend/edocs-docx.test.js`

- [ ] **Step 1: Сборщик тестовых DOCX**

Создать `backend/services/edocs/__fixtures__/docx.js`:

```js
'use strict';
// Минимальные DOCX для тестов и живых скриптов — без бинарных фикстур в git.
// makeDocx({ body, header }) собирает word/document.xml (и колонтитул) из XML-кусков;
// p('текст') — абзац, table([['№','Услуга'], …]) — таблица по строкам.
const PizZip = require('pizzip');

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const p = (text) => `<w:p><w:r><w:t xml:space="preserve">${esc(text)}</w:t></w:r></w:p>`;
const table = (rows) => `<w:tbl>${rows.map((cells) => `<w:tr>${cells.map((c) => `<w:tc>${p(c)}</w:tc>`).join('')}</w:tr>`).join('')}</w:tbl>`;

function makeDocx({ body = '', header = null } = {}) {
  const zip = new PizZip();
  zip.file('[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
    + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
    + '<Default Extension="xml" ContentType="application/xml"/>'
    + '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
    + (header ? '<Override PartName="/word/header1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"/>' : '')
    + '</Types>');
  zip.file('_rels/.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>'
    + '</Relationships>');
  let sect = '';
  if (header) {
    zip.file('word/_rels/document.xml.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
      + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
      + '<Relationship Id="rIdH1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/header" Target="header1.xml"/>'
      + '</Relationships>');
    zip.file('word/header1.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:hdr xmlns:w="${W}" xmlns:r="${R}">${header}</w:hdr>`);
    sect = '<w:sectPr><w:headerReference w:type="default" r:id="rIdH1"/></w:sectPr>';
  }
  zip.file('word/document.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="${W}" xmlns:r="${R}"><w:body>${body}${sect}</w:body></w:document>`);
  return zip.generate({ type: 'nodebuffer' });
}

/** Текст части документа без разметки (сущности XML раскрыты) — для проверок в тестах. */
function docText(buffer, part = 'word/document.xml') {
  return new PizZip(buffer).file(part).asText()
    .replace(/<w:br\/>/g, '\n').replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}

module.exports = { makeDocx, docText, p, table };
```

- [ ] **Step 2: Написать падающий тест**

Создать `backend/edocs-docx.test.js`:

```js
'use strict';
const { makeDocx, docText, p, table } = require('./services/edocs/__fixtures__/docx');
const { inspect, render, TemplateError } = require('./services/edocs/docx');
const { validateTags, missingFor, dictionary } = require('./services/edocs/placeholders');

const actTemplate = () => makeDocx({
  body: p('Акт № {act_no} от {doc_date}. Пациент: {fio}')
    + table([['№', 'Услуга', 'Сумма'], ['{#services}{n}', '{title}', '{sum}{/services}']])
    + p('Итого: {total_sum} ({total_sum_words})'),
  header: p('Договор № {contract_no}'),
});

describe('docx.inspect', () => {
  test('теги документа, цикла и колонтитула', () => {
    expect(inspect(actTemplate())).toEqual({
      act_no: {}, doc_date: {}, fio: {}, services: { n: {}, title: {}, sum: {} }, total_sum: {}, total_sum_words: {}, contract_no: {},
    });
  });
  test('тег, разбитый Word на несколько фрагментов текста, собирается целиком', () => {
    const buf = makeDocx({ body: '<w:p><w:r><w:t>Пациент: {fi</w:t></w:r><w:r><w:rPr><w:b/></w:rPr><w:t>o}</w:t></w:r></w:p>' });
    expect(inspect(buf)).toEqual({ fio: {} });
  });
  test('незакрытый тег — TemplateError с пояснением', () => {
    expect(() => inspect(makeDocx({ body: p('Пациент: {fio') }))).toThrow(/unclosed/i);
    try { inspect(makeDocx({ body: p('{fio') })); } catch (e) { expect(e).toBeInstanceOf(TemplateError); expect(e.details.length).toBe(1); }
  });
  test('не DOCX, битый ZIP, ZIP без документа', () => {
    expect(() => inspect(Buffer.from('просто текст'))).toThrow(/не DOCX/);
    expect(() => inspect(Buffer.from([0x50, 0x4B, 0x03, 0x04, 1, 2, 3]))).toThrow(/повреждён/);
    const PizZip = require('pizzip'); const z = new PizZip(); z.file('a.txt', 'x');
    expect(() => inspect(z.generate({ type: 'nodebuffer' }))).toThrow(/word\/document.xml/);
    expect(() => inspect(null)).toThrow(/пустой/);
  });
});

describe('docx.render', () => {
  test('подставляет значения, размножает строки таблицы, экранирует XML', () => {
    const out = render(actTemplate(), {
      act_no: '2056697734', doc_date: '24.10.2026', fio: 'Иванова Анна Сергеевна', contract_no: 'Д-17 «А&Б»',
      services: [{ n: 1, title: 'Чистка <лица>', sum: '1 000,00' }, { n: 2, title: 'Пилинг', sum: '2 500,00' }],
      total_sum: '3 500,00', total_sum_words: 'Три тысячи пятьсот рублей 00 копеек',
    });
    const text = docText(out);
    expect(text).toContain('Акт № 2056697734 от 24.10.2026. Пациент: Иванова Анна Сергеевна');
    expect(text).toContain('1Чистка <лица>1 000,00');
    expect(text).toContain('2Пилинг2 500,00');
    expect(docText(out, 'word/header1.xml')).toBe('Договор № Д-17 «А&Б»');
  });
  test('нет значения у простого тега — видимый пропуск; нет строк цикла — пусто', () => {
    const out = render(makeDocx({ body: p('Паспорт: {passport}') + table([['{#services}{title}{/services}']]) }), {});
    expect(docText(out)).toBe('Паспорт: ________');
  });
  test('перенос строки в значении становится переносом в Word', () => {
    const out = render(makeDocx({ body: p('{address}') }), { address: 'г. Москва\nул. Ленина, 1' });
    expect(docText(out)).toBe('г. Москва\nул. Ленина, 1');
  });
});

describe('placeholders.validateTags', () => {
  test('акт с циклом — ок; список тегов отсортирован', () => {
    const r = validateTags(inspect(actTemplate()), 'act');
    expect(r.ok).toBe(true);
    expect(r.placeholders).toEqual(['act_no', 'contract_no', 'doc_date', 'fio', 'services', 'total_sum', 'total_sum_words']);
  });
  test('теги акта в договоре, неизвестный тег, чужой тег в цикле, вложенность не в цикле', () => {
    const r = validateTags({ fio: {}, total_sum: {}, passprt: {}, services: { cost: {} }, phone: { x: {} } }, 'contract');
    expect(r.ok).toBe(false);
    expect(r.errors).toEqual(expect.arrayContaining([
      'Неизвестный тег {passprt}',
      'Тег {total_sum} разрешён только в шаблоне акта',
      'Тег {services} разрешён только в шаблоне акта',
      'Неизвестный тег {cost} внутри цикла {#services}',
      'Тег {phone} — не цикл: внутри {#phone}…{/phone} тегов быть не может',
    ]));
  });
  test('шаблон без тегов законен (документ «на подпись», без подстановок)', () => {
    expect(validateTags({}, 'other')).toEqual({ ok: true, errors: [], placeholders: [] });
  });
  test('неизвестный вид документа', () => {
    expect(validateTags({}, 'ids').errors).toEqual(['Неизвестный вид документа: ids']);
  });
});

describe('placeholders.missingFor', () => {
  const contract = { placeholders: ['fio', 'passport', 'passport_issued_by', 'org_inn', 'doc_city'] };
  test('ФИО и телефон нужны всегда, паспорт — по тегам, проверка без расшифровки', () => {
    const identity = { last_name: 'Иванова', first_name: '', phone: '79001234567', secure_fields: ['passport_series'] };
    expect(missingFor(identity, [contract], { inn: '9724060392' })).toEqual({
      identity: [{ key: 'first_name', label: 'Имя' }, { key: 'issued_by', label: 'Кем выдан паспорт' }, { key: 'passport_number', label: 'Номер паспорта' }],
      org: [{ key: 'city', label: 'Город' }],
    });
  });
  test('нет данных пациента вовсе', () => {
    expect(missingFor(null, [], {}).identity.map((x) => x.key)).toEqual(['first_name', 'last_name', 'phone']);
  });
  test('словарь для подсказки содержит все теги и поля строки акта', () => {
    const d = dictionary();
    expect(d.fields.find((f) => f.tag === 'services')).toEqual({ tag: 'services', label: expect.any(String), actOnly: true, loop: true });
    expect(d.serviceFields.map((f) => f.tag)).toEqual(['n', 'title', 'qty', 'price', 'discount', 'sum']);
    expect(d.kinds.map((k) => k.kind)).toEqual(['contract', 'consent_pd', 'act', 'other']);
  });
});
```

- [ ] **Step 3: Убедиться, что тест падает**

```bash
cd /root/loyalpro-fdoc/backend && npx jest edocs-docx
```

Ожидается: FAIL с `Cannot find module './services/edocs/docx'`.

- [ ] **Step 4: Словарь тегов**

Создать `backend/services/edocs/placeholders.js`:

```js
'use strict';
// Словарь тегов DOCX-шаблонов «Документов» — ЕДИНСТВЕННЫЙ источник истины: по нему
// проверяется загруженный шаблон, строится подсказка в настройках и считается,
// каких данных не хватает перед отправкой. Новый тег — сюда и в fill.js.
//   requires — ключи данных пациента (client_identity), без которых тег не заполнить;
//   org      — ключ реквизитов клиники (edoc_settings.requisites);
//   actOnly  — тег разрешён только в шаблоне вида «акт»; loop — цикл строк акта.
const KINDS = ['contract', 'consent_pd', 'act', 'other'];
const KIND_LABELS = {
  contract: 'Договор', consent_pd: 'Согласие на обработку ПДн', act: 'Акт оказанных услуг', other: 'Другой документ',
};

const FIELDS = {
  fio:                     { label: 'ФИО пациента полностью', requires: ['last_name', 'first_name'] },
  fio_short:               { label: 'Фамилия и инициалы', requires: ['last_name', 'first_name'] },
  last_name:               { label: 'Фамилия', requires: ['last_name'] },
  first_name:              { label: 'Имя', requires: ['first_name'] },
  middle_name:             { label: 'Отчество (может отсутствовать)', requires: [] },
  birth_date:              { label: 'Дата рождения', requires: ['birth_date'] },
  gender:                  { label: 'Пол: «женский» / «мужской»', requires: ['gender'] },
  phone:                   { label: 'Телефон', requires: ['phone'] },
  email:                   { label: 'E-mail', requires: ['email'] },
  passport:                { label: 'Паспорт: серия и номер', requires: ['passport_series', 'passport_number'] },
  passport_series:         { label: 'Паспорт: серия', requires: ['passport_series'] },
  passport_number:         { label: 'Паспорт: номер', requires: ['passport_number'] },
  passport_issued_by:      { label: 'Паспорт: кем выдан', requires: ['issued_by'] },
  passport_issue_date:     { label: 'Паспорт: дата выдачи', requires: ['issue_date'] },
  passport_authority_code: { label: 'Паспорт: код подразделения', requires: ['authority_code'] },
  birth_place:             { label: 'Место рождения', requires: ['birth_place'] },
  address:                 { label: 'Адрес регистрации', requires: ['address'] },
  contract_no:             { label: 'Номер договора', requires: ['contract_no'] },
  contract_date:           { label: 'Дата договора (пусто — дата документа)', requires: [] },
  doc_date:                { label: 'Дата документа', requires: [] },
  doc_city:                { label: 'Город', requires: [], org: 'city' },
  org_name:                { label: 'Клиника: полное наименование', requires: [], org: 'name' },
  org_inn:                 { label: 'Клиника: ИНН', requires: [], org: 'inn' },
  org_kpp:                 { label: 'Клиника: КПП', requires: [], org: 'kpp' },
  org_ogrn:                { label: 'Клиника: ОГРН', requires: [], org: 'ogrn' },
  org_address:             { label: 'Клиника: адрес', requires: [], org: 'address' },
  org_license:             { label: 'Клиника: лицензия', requires: [], org: 'license' },
  org_phone:               { label: 'Клиника: телефон', requires: [], org: 'phone' },
  org_bank:                { label: 'Клиника: банковские реквизиты', requires: [], org: 'bank' },
  org_signer_position:     { label: 'Клиника: должность подписанта', requires: [], org: 'signer_position' },
  org_signer_name:         { label: 'Клиника: ФИО подписанта', requires: [], org: 'signer_name' },
  act_no:                  { label: 'Номер акта', requires: [], actOnly: true },
  visit_date:              { label: 'Дата визита', requires: [], actOnly: true },
  doctor_name:             { label: 'Врач', requires: [], actOnly: true },
  doctor_position:         { label: 'Должность врача', requires: [], actOnly: true },
  total_sum:               { label: 'Итого, ₽', requires: [], actOnly: true },
  total_sum_words:         { label: 'Итого прописью', requires: [], actOnly: true },
  services:                { label: 'Строки акта: {#services}…{/services}', requires: [], actOnly: true, loop: true },
};
const SERVICE_FIELDS = {
  n: '№ строки', title: 'Услуга', qty: 'Количество', price: 'Цена за единицу', discount: 'Скидка, ₽', sum: 'Сумма',
};

const ORG_KEYS = ['name', 'inn', 'kpp', 'ogrn', 'address', 'license', 'phone', 'bank', 'signer_position', 'signer_name', 'city'];
const ORG_LABELS = {
  name: 'Полное наименование', inn: 'ИНН', kpp: 'КПП', ogrn: 'ОГРН', address: 'Адрес', license: 'Лицензия',
  phone: 'Телефон', bank: 'Банковские реквизиты', signer_position: 'Должность подписанта',
  signer_name: 'ФИО подписанта', city: 'Город',
};
const IDENTITY_LABELS = {
  last_name: 'Фамилия', first_name: 'Имя', middle_name: 'Отчество', birth_date: 'Дата рождения', gender: 'Пол',
  phone: 'Телефон', email: 'E-mail', contract_no: 'Номер договора', contract_date: 'Дата договора',
  passport_series: 'Серия паспорта', passport_number: 'Номер паспорта', issued_by: 'Кем выдан паспорт',
  issue_date: 'Дата выдачи паспорта', authority_code: 'Код подразделения', birth_place: 'Место рождения',
  address: 'Адрес регистрации',
};
// Без этого подписант не уйдёт в F.Doc вовсе (ФИО и телефон клиента обязательны).
const ALWAYS_REQUIRED = ['last_name', 'first_name', 'phone'];

/**
 * Проверка тегов шаблона. tags — теги всего документа одним объектом
 * (docx.inspect): { fio: {}, services: { n: {}, title: {} } }.
 * @returns {{ ok: boolean, errors: string[], placeholders: string[] }}
 */
function validateTags(tags, kind) {
  const errors = [];
  if (!KINDS.includes(kind)) errors.push(`Неизвестный вид документа: ${kind}`);
  const names = Object.keys(tags || {});
  for (const name of names) {
    const f = FIELDS[name];
    if (!f) { errors.push(`Неизвестный тег {${name}}`); continue; }
    if (f.actOnly && kind !== 'act') errors.push(`Тег {${name}} разрешён только в шаблоне акта`);
    const inner = Object.keys(tags[name] || {});
    if (f.loop) {
      for (const s of inner) if (!SERVICE_FIELDS[s]) errors.push(`Неизвестный тег {${s}} внутри цикла {#services}`);
    } else if (inner.length) {
      errors.push(`Тег {${name}} — не цикл: внутри {#${name}}…{/${name}} тегов быть не может`);
    }
  }
  return { ok: errors.length === 0, errors, placeholders: names.filter((n) => FIELDS[n]).sort() };
}

/**
 * Каких данных не хватает для набора шаблонов. Работает БЕЗ расшифровки паспорта:
 * заполненность секретных полей — по identity.secure_fields.
 * identity — строка client_identity (или null), templates — [{ placeholders }].
 * @returns {{ identity: Array<{key,label}>, org: Array<{key,label}> }}
 */
function missingFor(identity, templates, requisites) {
  const have = new Set();
  for (const [k, v] of Object.entries(identity || {})) {
    if (k !== 'secure_fields' && v !== null && v !== undefined && String(v).trim() !== '') have.add(k);
  }
  for (const k of (identity && identity.secure_fields) || []) have.add(k);
  const needIdentity = new Set(ALWAYS_REQUIRED);
  const needOrg = new Set();
  for (const t of templates || []) {
    for (const name of t.placeholders || []) {
      const f = FIELDS[name];
      if (!f) continue;
      for (const r of f.requires) needIdentity.add(r);
      if (f.org) needOrg.add(f.org);
    }
  }
  const req = requisites || {};
  return {
    identity: [...needIdentity].filter((k) => !have.has(k)).sort().map((key) => ({ key, label: IDENTITY_LABELS[key] || key })),
    org: [...needOrg].filter((k) => !String(req[k] || '').trim()).sort().map((key) => ({ key, label: ORG_LABELS[key] || key })),
  };
}

/** Словарь для подсказки в настройках: [{ tag, label, actOnly, loop }] + поля строки акта. */
function dictionary() {
  return {
    fields: Object.entries(FIELDS).map(([tag, f]) => ({ tag, label: f.label, actOnly: !!f.actOnly, loop: !!f.loop })),
    serviceFields: Object.entries(SERVICE_FIELDS).map(([tag, label]) => ({ tag, label })),
    kinds: KINDS.map((k) => ({ kind: k, label: KIND_LABELS[k] })),
  };
}

module.exports = {
  KINDS, KIND_LABELS, FIELDS, SERVICE_FIELDS, ORG_KEYS, ORG_LABELS, IDENTITY_LABELS, ALWAYS_REQUIRED,
  validateTags, missingFor, dictionary,
};
```

- [ ] **Step 5: Разбор и заполнение DOCX**

Создать `backend/services/edocs/docx.js`:

```js
'use strict';
// Разбор и заполнение DOCX-шаблонов «Документов» (docxtemplater, теги в { }).
// Теги берём штатным doc.getTags() (есть с 3.4x): InspectModule требует lodash,
// которого нет в зависимостях docxtemplater, и падает на require.
// errorLogging:false — иначе библиотека печатает каждую ошибку шаблона в stdout.
const PizZip = require('pizzip');
const Docxtemplater = require('docxtemplater');
const { EMPTY } = require('./format');

const MAX_TEMPLATE_BYTES = 10 * 1024 * 1024;   // как у F.Doc для шаблонов
const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

class TemplateError extends Error {
  constructor(message, details = []) { super(message); this.name = 'TemplateError'; this.details = details; }
}

function asTemplateError(e) {
  const list = e && e.properties && Array.isArray(e.properties.errors) ? e.properties.errors : [e];
  const details = list.map((x) => (x && x.properties && x.properties.explanation) || (x && x.message) || String(x));
  return new TemplateError(`Ошибка в разметке шаблона: ${details.join('; ')}`, details);
}

function open(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 4) throw new TemplateError('Файл пустой');
  if (buffer.length > MAX_TEMPLATE_BYTES) throw new TemplateError('Шаблон больше 10 МБ');
  if (buffer[0] !== 0x50 || buffer[1] !== 0x4B) throw new TemplateError('Это не DOCX: нужен файл Word (.docx)');
  let zip;
  try { zip = new PizZip(buffer); } catch (e) { throw new TemplateError('Файл повреждён: не удалось распаковать DOCX'); }
  if (!zip.file('word/document.xml')) throw new TemplateError('Это не документ Word: внутри нет word/document.xml');
  try {
    return new Docxtemplater(zip, {
      paragraphLoop: true,
      linebreaks: true,
      errorLogging: false,
      // Пустой простой тег — видимый пропуск; пустой цикл/условие — ничего.
      nullGetter: (part) => (part && part.module ? '' : EMPTY),
    });
  } catch (e) { throw asTemplateError(e); }
}

function mergeTags(into, tags) {
  for (const [k, v] of Object.entries(tags || {})) { into[k] = into[k] || {}; mergeTags(into[k], v); }
  return into;
}

/** Теги документа и колонтитулов одним объектом: { fio: {}, services: { title: {} } }. */
function inspect(buffer) {
  const t = open(buffer).getTags();
  const all = {};
  if (t.document) mergeTags(all, t.document.tags);
  for (const part of [...(t.headers || []), ...(t.footers || [])]) mergeTags(all, part.tags);
  return all;
}

/** Заполненный DOCX (Buffer). */
function render(buffer, data) {
  const doc = open(buffer);
  try { doc.render(data); } catch (e) { throw asTemplateError(e); }
  return doc.getZip().generate({ type: 'nodebuffer', compression: 'DEFLATE' });
}

module.exports = { inspect, render, TemplateError, MAX_TEMPLATE_BYTES, DOCX_MIME };
```

- [ ] **Step 6: Тест проходит**

```bash
cd /root/loyalpro-fdoc/backend && npx jest edocs-docx 2>&1 | grep -E "Tests:"
```

Ожидается: `Tests: 14 passed, 14 total`.

- [ ] **Step 7: Commit**

```bash
cd /root/loyalpro-fdoc && git add backend/services/edocs/__fixtures__/docx.js backend/services/edocs/placeholders.js backend/services/edocs/docx.js backend/edocs-docx.test.js && git commit -m "feat(edocs): словарь тегов шаблонов и разбор/заполнение DOCX через doc.getTags()

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 5: ФИО и данные пациента — **Sonnet**

В YClients у 89 % карточек ФИО одной строкой, порядок не гарантирован. Позицию доказывает отчество — то же правило, что `utils/person-name.splitFio`, поэтому регэкспы отчества экспортируются оттуда (правило одно на оба модуля; поведение Милы не меняется). Без отчества разбор помечается неуверенным, форма просит проверить. `identity.js`: недоверчивая проверка формы (управляющие и bidi-символы вырезаются — в XML документа им не место), шифрование паспортной части, маска `45** ****56`, предзаполнение (раздельные поля YClients главнее строки `name`; пол по `sex_id`; номер договора из `custom_fields['nomer-dogovra']`; паспорт из последней заявки на справку этого пациента) и разбор ответа распознавания паспорта F.Doc.

**Files:**
- Modify: `backend/utils/person-name.js` (экспорт)
- Create: `backend/services/edocs/fio.js`, `backend/services/edocs/identity.js`
- Test: `backend/edocs-identity.test.js`

- [ ] **Step 1: Экспорт регэкспов отчества**

В `backend/utils/person-name.js` найти:

```js
}

module.exports = { resolveGivenName, splitFio, normalizeName };
```

заменить на:

```js
}

// Регэкспы отчества экспортируются для разбора ФИО в «Документах» (services/edocs/fio.js):
// правило «что считать отчеством» одно на оба модуля.
module.exports = { resolveGivenName, splitFio, normalizeName, PATRONYMIC_RE, TURKIC_PATRONYMIC_RE };
```

- [ ] **Step 2: Написать падающий тест**

Создать `backend/edocs-identity.test.js`:

```js
'use strict';
const { splitFullName } = require('./services/edocs/fio');
const { validateIdentity, encodeSecure, decodeRow, maskPassport, prefillFrom } = require('./services/edocs/identity');
const { makeBox } = require('./utils/secret-box');

describe('splitFullName', () => {
  test.each([
    ['Белоглазова Ольга викторовна', { last_name: 'Белоглазова', first_name: 'Ольга', middle_name: 'Викторовна', confident: true }],
    ['Алина Игоревна Милькова', { last_name: 'Милькова', first_name: 'Алина', middle_name: 'Игоревна', confident: true }],
    ['Мамедов Рашад Октай Оглы', { last_name: 'Мамедов', first_name: 'Рашад', middle_name: 'Октай Оглы', confident: true }],
    ['Анна Сергеевна', { last_name: '', first_name: 'Анна', middle_name: 'Сергеевна', confident: false }],
    ['Айнур Алиева', { last_name: 'Айнур', first_name: 'Алиева', middle_name: '', confident: false }],
    ['иванова-петрова мария', { last_name: 'Иванова-Петрова', first_name: 'Мария', middle_name: '', confident: false }],
    ['Мария', { last_name: '', first_name: 'Мария', middle_name: '', confident: false }],
    ['79001234567', { last_name: '', first_name: '', middle_name: '', confident: false }],
    ['', { last_name: '', first_name: '', middle_name: '', confident: false }],
  ])('%p', (name, expected) => expect(splitFullName(name)).toEqual(expected));
});

describe('validateIdentity', () => {
  const ok = {
    last_name: ' Иванова ', first_name: 'Анна', middle_name: '', birth_date: '1983-03-21', gender: 'f', phone: '8 (900) 123-45-67',
    email: 'a@b.ru', contract_no: ' 1739 ', contract_date: '',
    secure: { passport_series: '45 10', passport_number: '123456', issued_by: 'ОВД  «Тверской»‮', issue_date: '2015-05-01', authority_code: '770001', birth_place: 'г. Москва', address: '' },
  };
  test('нормализует и раскладывает на открытую и паспортную части', () => {
    expect(validateIdentity(ok, '2026-10-24')).toEqual({ value: {
      plain: { last_name: 'Иванова', first_name: 'Анна', middle_name: '', birth_date: '1983-03-21', gender: 'F', phone: '79001234567', email: 'a@b.ru', contract_no: '1739', contract_date: null },
      secure: { passport_series: '4510', passport_number: '123456', issued_by: 'ОВД «Тверской»', issue_date: '2015-05-01', authority_code: '770-001', birth_place: 'г. Москва' },
    } });
  });
  test('пустая форма законна', () => {
    expect(validateIdentity({}, '2026-10-24').value.secure).toEqual({});
  });
  test.each([
    [{ last_name: 'Иванова1' }, /Фамилия/],
    [{ birth_date: '2030-01-01' }, /Дата рождения/],
    [{ birth_date: '1983-02-30' }, /Дата рождения/],
    [{ gender: 'X' }, /Пол/],
    [{ phone: '12345' }, /Телефон/],
    [{ email: 'a@b' }, /E-mail/],
    [{ secure: { passport_series: '451' } }, /Серия/],
    [{ secure: { passport_number: '12345' } }, /Номер паспорта/],
    [{ secure: { issue_date: '2099-01-01' } }, /Дата выдачи/],
    [{ secure: { authority_code: '77-001' } }, /Код подразделения/],
  ])('%p → ошибка', (body, re) => expect(validateIdentity(body, '2026-10-24').error).toMatch(re));
});

describe('шифрование и маска', () => {
  const box = makeBox(Buffer.alloc(32, 3).toString('base64'));
  test('encodeSecure/decodeRow: туда и обратно, список полей без расшифровки', () => {
    const enc = encodeSecure({ passport_series: '4510', passport_number: '123456', address: '' }, box);
    expect(enc.secure_fields).toEqual(['passport_series', 'passport_number']);
    expect(enc.secure_enc).not.toContain('4510');
    const row = { last_name: 'Иванова', first_name: 'Анна', secure_enc: enc.secure_enc, secure_fields: enc.secure_fields };
    expect(decodeRow(row, box).secure).toEqual({ passport_series: '4510', passport_number: '123456' });
    expect(decodeRow(row, box).plain.middle_name).toBeNull();
  });
  test('пустой паспорт — без шифротекста', () => {
    expect(encodeSecure({}, box)).toEqual({ secure_enc: null, secure_fields: [] });
    expect(decodeRow(null, box)).toBeNull();
  });
  test('maskPassport', () => {
    expect(maskPassport({ passport_series: '4510', passport_number: '123456' })).toBe('45** ****56');
    expect(maskPassport({ passport_number: '123456' })).toBe('****56');
    expect(maskPassport({})).toBe('');
  });
});

describe('prefillFrom', () => {
  test('раздельные поля YClients главнее строки name; пол по sex_id; номер договора', () => {
    const r = prefillFrom({
      name: 'Иванова Анна Сергеевна', phone: '+79001234567', email: '', birthday_iso: '1983-03-21',
      yclients_data: { surname: 'иванова', name: 'анна', patronymic: 'сергеевна', sex_id: 2, custom_fields: { 'nomer-dogovra': 1739 } },
    }, null);
    expect(r.plain).toEqual({ last_name: 'Иванова', first_name: 'Анна', middle_name: 'Сергеевна', birth_date: '1983-03-21', gender: 'F', phone: '79001234567', email: null, contract_no: '1739', contract_date: null });
    expect(r.confident).toBe(true);
    expect(r.notes).toEqual([]);
  });
  test('ФИО одной строкой без отчества — пометка «проверьте»', () => {
    const r = prefillFrom({ name: 'Айнур Алиева', phone: '79001234567', yclients_data: { sex_id: 0 } }, null);
    expect(r.confident).toBe(false);
    expect(r.notes[0]).toMatch(/проверьте/);
    expect(r.plain.gender).toBeNull();
  });
  test('паспорт из заявки на справку: пациент сам плательщик', () => {
    const r = prefillFrom({ name: 'Иванова Анна Сергеевна', phone: '79001234567', yclients_data: {} }, {
      payer_is_patient: true, payer_doc_type_code: '21', payer_doc_serie_number: '4510 123456', payer_doc_issue_date_iso: '2015-05-01',
      payer_birthdate_iso: '1983-03-21', created_date: '01.10.2026',
    });
    expect(r.secure).toEqual({ passport_series: '4510', passport_number: '123456', issue_date: '2015-05-01' });
    expect(r.plain.birth_date).toBe('1983-03-21');
    expect(r.notes.join(' ')).toMatch(/заявки на справку от 01\.10\.2026/);
  });
  test('свидетельство о рождении (не паспорт) не подставляется', () => {
    const r = prefillFrom({ name: 'X', phone: '', yclients_data: {} }, {
      payer_is_patient: false, patient_doc_type_code: '03', patient_doc_serie_number: 'IVМЮ123456',
    });
    expect(r.secure).toEqual({});
  });
});

describe('fromRecognized', () => {
  const { fromRecognized } = require('./services/edocs/identity');
  test('поля распознавания паспорта РФ → форма', () => {
    const r = fromRecognized({
      confidence: true, doc_type: 'rus.passport.national',
      fields: {
        surname_nat: { value: 'ИВАНОВА' }, given_name_nat: { value: 'АННА' }, patronymic_nat: { value: 'СЕРГЕЕВНА' },
        birth_date: { value: '1983-03-21' }, sex: { value: 'F' }, document_series: { value: '45 10' }, document_number: { value: '123456' },
        issue_date: { value: '2015-05-01' }, authority_nat: { value: 'ОВД ТВЕРСКОЙ Г. МОСКВЫ' }, authority_code: { value: '770-001' },
        birth_place_nat: { value: 'Г. МОСКВА' }, address: { locality: 'г. Москва', street: 'ул. Ленина', house: '1', apartment: '5', area: null },
      },
      spoofing_reasons: [{ kind: 'screen_photo', fields: [] }],
    });
    expect(r).toEqual({
      plain: { last_name: 'Иванова', first_name: 'Анна', middle_name: 'Сергеевна', birth_date: '1983-03-21', gender: 'F' },
      secure: { passport_series: '4510', passport_number: '123456', issue_date: '2015-05-01', issued_by: 'ОВД ТВЕРСКОЙ Г. МОСКВЫ', authority_code: '770-001', birth_place: 'Г. МОСКВА', address: 'г. Москва, ул. Ленина, д. 1, кв. 5' },
      confidence: true, spoofing: ['screen_photo'],
    });
  });
  test('пустой или кривой ответ — пустые поля', () => {
    expect(fromRecognized(null)).toEqual({ plain: {}, secure: {}, confidence: false, spoofing: [] });
    expect(fromRecognized({ fields: { document_number: { value: '12' }, birth_date: { value: '21.03.1983' } } }).secure).toEqual({});
  });
});
```

- [ ] **Step 3: Убедиться, что тест падает**

```bash
cd /root/loyalpro-fdoc/backend && npx jest edocs-identity
```

Ожидается: FAIL с `Cannot find module './services/edocs/fio'`.

- [ ] **Step 4: Разбор ФИО**

Создать `backend/services/edocs/fio.js`:

```js
'use strict';
// Разложение ФИО одной строкой на фамилию, имя и отчество для документов.
// В YClients у 89 % карточек всё ФИО лежит в поле name, порядок слов не гарантирован.
// Позицию доказывает ОТЧЕСТВО (то же правило, что utils/person-name.splitFio):
// имя стоит вплотную перед отчеством, остальное — фамилия. Без отчества порядок не
// доказан — confident:false, и форма просит администратора проверить поля.
const { PATRONYMIC_RE, TURKIC_PATRONYMIC_RE, normalizeName } = require('../../utils/person-name');

const WORD_RE = /^[\p{L}][\p{L}'-]*$/u;

/** «иванова-петрова» → «Иванова-Петрова». */
function cap(w) {
  return String(w || '').toLowerCase().replace(/(^|-)(\p{L})/gu, (_, sep, ch) => sep + ch.toUpperCase());
}

// Слова до первого «несловесного» (телефон, «Тест 2», «4.» обрывают разбор).
function words(name) {
  const out = [];
  for (const w of String(name || '').trim().split(/\s+/)) {
    if (!w) continue;
    if (!WORD_RE.test(w)) break;
    out.push(w);
  }
  return out;
}

/** @returns {{ last_name: string, first_name: string, middle_name: string, confident: boolean }} */
function splitFullName(name) {
  const t = words(name);
  const n = t.length;
  if (!n) return { last_name: '', first_name: '', middle_name: '', confident: false };
  if (n >= 3 && TURKIC_PATRONYMIC_RE.test(normalizeName(t[n - 1]))) {
    return {
      last_name: t.slice(0, n - 3).map(cap).join(' '),
      first_name: cap(t[n - 3]),
      middle_name: `${cap(t[n - 2])} ${cap(t[n - 1])}`,
      confident: n >= 4,
    };
  }
  const i = t.findIndex((w) => PATRONYMIC_RE.test(normalizeName(w)));
  if (i >= 1) {
    const rest = [...t.slice(0, i - 1), ...t.slice(i + 1)];
    return { last_name: rest.map(cap).join(' '), first_name: cap(t[i - 1]), middle_name: cap(t[i]), confident: rest.length === 1 };
  }
  if (n === 1) return { last_name: '', first_name: cap(t[0]), middle_name: '', confident: false };
  return { last_name: cap(t[0]), first_name: cap(t[1]), middle_name: t.slice(2).map(cap).join(' '), confident: false };
}

module.exports = { splitFullName, cap };
```

- [ ] **Step 5: Данные пациента**

Создать `backend/services/edocs/identity.js`:

```js
'use strict';
// Данные пациента для документов: проверка формы, шифрование паспортной части,
// маска для экранов и предзаполнение из карточки YClients и заявки на справку.
// Чистый модуль: БД — в store.js, ключ шифрования — снаружи (box).
const { isCalendarDate, todayMsk } = require('../../utils/period');
const { normalizePhoneKey } = require('../agent-gate');
const { splitFullName, cap } = require('./fio');

const PLAIN_KEYS = ['last_name', 'first_name', 'middle_name', 'birth_date', 'gender', 'phone', 'email', 'contract_no', 'contract_date'];
const SECURE_KEYS = ['passport_series', 'passport_number', 'issued_by', 'issue_date', 'authority_code', 'birth_place', 'address'];

// Управляющие символы недопустимы в XML документа, bidi — подмена порядка текста.
const CONTROL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F‪-‮⁦-⁩]/g;
const NAME_RE = /^[\p{L}][\p{L}' .-]*$/u;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function clean(v, max) {
  return String(v === null || v === undefined ? '' : v).replace(CONTROL_RE, '').replace(/\s+/g, ' ').trim().slice(0, max);
}

/**
 * Проверка тела PUT /clients/:id/identity. Пустые поля законны: полноту под конкретные
 * шаблоны проверяет placeholders.missingFor перед отправкой.
 * @returns {{ value: { plain: object, secure: object } } | { error: string }}
 */
function validateIdentity(body, today = todayMsk()) {
  const b = body || {};
  const plain = {};
  for (const [key, label] of [['last_name', 'Фамилия'], ['first_name', 'Имя'], ['middle_name', 'Отчество']]) {
    const v = clean(b[key], 100);
    if (v && !NAME_RE.test(v)) return { error: `${label}: только буквы, пробел, дефис и апостроф` };
    plain[key] = v;
  }
  const date = (key, label, { past = true } = {}) => {
    const v = clean(b[key], 10);
    if (!v) return { v: null };
    if (!isCalendarDate(v) || v < '1900-01-01' || (past && v > today)) return { error: `${label}: неверная дата` };
    return { v };
  };
  for (const [key, label, past] of [['birth_date', 'Дата рождения', true], ['contract_date', 'Дата договора', false]]) {
    const r = date(key, label, { past }); if (r.error) return r; plain[key] = r.v;
  }
  const g = clean(b.gender, 1).toUpperCase();
  if (g && g !== 'F' && g !== 'M') return { error: 'Пол: F или M' };
  plain.gender = g || null;
  const phoneRaw = clean(b.phone, 30);
  const phone = phoneRaw ? normalizePhoneKey(phoneRaw) : '';
  if (phone && !/^7\d{10}$/.test(phone)) return { error: 'Телефон: 11 цифр, начиная с 7 или 8' };
  plain.phone = phone || null;
  const email = clean(b.email, 200);
  if (email && !EMAIL_RE.test(email)) return { error: 'E-mail: неверный формат' };
  plain.email = email || null;
  plain.contract_no = clean(b.contract_no, 50) || null;

  const s = b.secure || {};
  const secure = {};
  const digits = (v) => clean(v, 20).replace(/\D/g, '');
  const series = digits(s.passport_series);
  if (series && series.length !== 4) return { error: 'Серия паспорта: 4 цифры' };
  if (series) secure.passport_series = series;
  const number = digits(s.passport_number);
  if (number && number.length !== 6) return { error: 'Номер паспорта: 6 цифр' };
  if (number) secure.passport_number = number;
  const issuedBy = clean(s.issued_by, 300); if (issuedBy) secure.issued_by = issuedBy;
  const issue = clean(s.issue_date, 10);
  if (issue) {
    if (!isCalendarDate(issue) || issue < '1900-01-01' || issue > today) return { error: 'Дата выдачи паспорта: неверная дата' };
    secure.issue_date = issue;
  }
  const code = digits(s.authority_code);
  if (code && code.length !== 6) return { error: 'Код подразделения: 6 цифр' };
  if (code) secure.authority_code = `${code.slice(0, 3)}-${code.slice(3)}`;
  const place = clean(s.birth_place, 300); if (place) secure.birth_place = place;
  const address = clean(s.address, 500); if (address) secure.address = address;
  return { value: { plain, secure } };
}

/** Колонки для UPSERT client_identity: паспортная часть одним шифротекстом. */
function encodeSecure(secure, box) {
  const keys = SECURE_KEYS.filter((k) => secure && secure[k]);
  if (!keys.length) return { secure_enc: null, secure_fields: [] };
  const obj = {}; for (const k of keys) obj[k] = secure[k];
  return { secure_enc: box.encryptJson(obj), secure_fields: keys };
}

/** Строка client_identity → { plain, secure } (secure расшифровывается). */
function decodeRow(row, box) {
  if (!row) return null;
  const plain = {};
  for (const k of PLAIN_KEYS) plain[k] = row[k] === undefined ? null : row[k];
  const secure = row.secure_enc ? box.decryptJson(row.secure_enc) : {};
  return { plain, secure, secure_fields: row.secure_fields || [] };
}

/** «45** ****56» — серия и номер для экранов, где полный паспорт не нужен. */
function maskPassport(secure) {
  const s = (secure && secure.passport_series) || '', n = (secure && secure.passport_number) || '';
  const parts = [];
  if (s) parts.push(`${s.slice(0, 2)}**`);
  if (n) parts.push(`****${n.slice(-2)}`);
  return parts.join(' ');
}

/**
 * Кандидаты для пустой формы — ничего не сохраняет.
 * client — строка clients с birthday_iso ('YYYY-MM-DD' через to_char: DATE из pg в
 * TZ Москвы, toISOString дал бы вчерашний день) и yclients_data.
 * cert — последняя заявка на справку этого пациента (даты тоже через to_char) или null.
 */
function prefillFrom(client, cert) {
  const c = client || {};
  const yc = c.yclients_data || {};
  const notes = [];
  let fio;
  if (String(yc.surname || '').trim()) {
    fio = { last_name: cap(yc.surname), first_name: cap(yc.name), middle_name: cap(yc.patronymic || ''), confident: true };
  } else {
    fio = splitFullName(c.name);
    if (!fio.confident && (fio.last_name || fio.first_name)) {
      notes.push(`ФИО разложено по карточке «${clean(c.name, 120)}» без уверенности — проверьте фамилию и имя`);
    }
  }
  const sex = Number(yc.sex_id);
  const custom = yc.custom_fields && typeof yc.custom_fields === 'object' ? yc.custom_fields : {};
  const contract = custom['nomer-dogovra'];
  const plain = {
    last_name: fio.last_name || '', first_name: fio.first_name || '', middle_name: fio.middle_name || '',
    birth_date: c.birthday_iso || null,
    gender: sex === 2 ? 'F' : sex === 1 ? 'M' : null,
    phone: normalizePhoneKey(c.phone) || null,
    email: clean(c.email || yc.email, 200) || null,
    contract_no: contract !== undefined && contract !== null && String(contract).trim() ? clean(contract, 50) : null,
    contract_date: null,
  };
  const secure = {};
  if (cert) {
    const payer = !!cert.payer_is_patient;
    const type = payer ? cert.payer_doc_type_code : cert.patient_doc_type_code;
    const sn = String((payer ? cert.payer_doc_serie_number : cert.patient_doc_serie_number) || '').replace(/\D/g, '');
    if (type === '21' && sn.length === 10) {
      secure.passport_series = sn.slice(0, 4);
      secure.passport_number = sn.slice(4);
      const issue = payer ? cert.payer_doc_issue_date_iso : cert.patient_doc_issue_date_iso;
      if (issue) secure.issue_date = issue;
      notes.push(`Серия и номер паспорта${issue ? ' и дата выдачи' : ''} — из заявки на справку от ${cert.created_date || '—'}`);
    }
    if (!plain.birth_date) plain.birth_date = (payer ? cert.payer_birthdate_iso : cert.patient_birthdate_iso) || null;
  }
  return { plain, secure, notes, confident: !!fio.confident };
}

/**
 * Ответ распознавания паспорта F.Doc (RecognizedDocumentResult) → поля формы.
 * Ничего не сохраняет: администратор проверяет поля глазами и жмёт «Сохранить».
 */
function fromRecognized(r) {
  const f = (r && r.fields) || {};
  const val = (k) => (f[k] && typeof f[k].value === 'string' ? clean(f[k].value, 300) : '');
  const iso = (k) => (/^\d{4}-\d{2}-\d{2}$/.test(val(k)) ? val(k) : '');
  const plain = {};
  const secure = {};
  if (val('surname_nat')) plain.last_name = cap(val('surname_nat'));
  if (val('given_name_nat')) plain.first_name = cap(val('given_name_nat'));
  if (val('patronymic_nat')) plain.middle_name = cap(val('patronymic_nat'));
  if (iso('birth_date')) plain.birth_date = iso('birth_date');
  const sex = val('sex').toUpperCase();
  if (sex.startsWith('F') || sex.startsWith('Ж')) plain.gender = 'F';
  else if (sex.startsWith('M') || sex.startsWith('М')) plain.gender = 'M';
  const series = val('document_series').replace(/\D/g, '');
  if (series.length === 4) secure.passport_series = series;
  const number = val('document_number').replace(/\D/g, '');
  if (number.length === 6) secure.passport_number = number;
  if (iso('issue_date')) secure.issue_date = iso('issue_date');
  if (val('authority_nat')) secure.issued_by = val('authority_nat');
  const code = val('authority_code').replace(/\D/g, '');
  if (code.length === 6) secure.authority_code = `${code.slice(0, 3)}-${code.slice(3)}`;
  if (val('birth_place_nat')) secure.birth_place = val('birth_place_nat');
  const a = f.address && typeof f.address === 'object' ? f.address : null;
  if (a) {
    const parts = [a.area, a.region, a.locality, a.street, a.house && `д. ${a.house}`, a.housing && `корп. ${a.housing}`,
      a.building && `стр. ${a.building}`, a.apartment && `кв. ${a.apartment}`].filter((x) => x && String(x).trim());
    if (parts.length) secure.address = clean(parts.join(', '), 500);
  }
  return {
    plain, secure,
    confidence: !!(r && r.confidence),
    spoofing: ((r && r.spoofing_reasons) || []).map((x) => x && x.kind).filter(Boolean),
  };
}

module.exports = { PLAIN_KEYS, SECURE_KEYS, validateIdentity, encodeSecure, decodeRow, maskPassport, prefillFrom, fromRecognized };
```

- [ ] **Step 6: Тесты проходят, имя для Милы не сломано**

```bash
cd /root/loyalpro-fdoc/backend && npx jest edocs-identity agent-person-name 2>&1 | grep -E "Tests:"
```

Ожидается: `Tests: 58 passed, 58 total` (30 + 28).

- [ ] **Step 7: Commit**

```bash
cd /root/loyalpro-fdoc && git add backend/utils/person-name.js backend/services/edocs/fio.js backend/services/edocs/identity.js backend/edocs-identity.test.js && git commit -m "feat(edocs): разбор ФИО, проверка и шифрование данных пациента, предзаполнение и распознавание паспорта

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Строки акта, заполнение, статусы, ошибки — **Sonnet**

Сумма строки акта — `manual_cost`: цена после скидки, но ДО оплаты бонусами (проверено на данных PERI: `first_cost` 17500, `discount` 10 %, `manual_cost` 15750, `cost` 7737.61 — бонус YClients вычел прямо из `cost`). `discount` — процент. `fill.js` даёт значение КАЖДОМУ тегу словаря (на это тест). `statuses.js` переводит статусы F.Doc в наши и сопоставляет документы ответа с нашими: по id (мы отправляем свои UUID), затем по имени файла, затем по порядку — только при совпадении количества. `errors.js` — общая ошибка модуля и HTTP-ответ на неё (наружу только понятный текст и код).

**Files:**
- Create: `backend/services/edocs/act-lines.js`, `backend/services/edocs/fill.js`, `backend/services/edocs/statuses.js`, `backend/services/edocs/errors.js`
- Test: `backend/edocs-fill.test.js`

- [ ] **Step 1: Написать падающий тест**

Создать `backend/edocs-fill.test.js`:

```js
'use strict';
const { linesFromRecord, normalizeLines, actTotals, doctorOf } = require('./services/edocs/act-lines');
const { buildRenderData } = require('./services/edocs/fill');
const { FIELDS, SERVICE_FIELDS } = require('./services/edocs/placeholders');
const { mapStatus, isFinal, applyWorkflow } = require('./services/edocs/statuses');
const { NBSP } = require('./services/edocs/format');

// Реальная форма records.services (запись 2056697734 и строки со скидкой/бонусом, дев 24.10.2026).
const SERVICES = [
  { id: 9536663, cost: 48000, title: 'Revi strong 2 ml', amount: 2, discount: 0, first_cost: 48000, cost_to_pay: 48000, manual_cost: 48000, cost_per_unit: 24000 },
  { id: 15394152, cost: 7737.61, title: 'Фотоомоложение Lumeca - лицо', amount: 1, discount: 10, first_cost: 17500, cost_to_pay: 7737.61, manual_cost: 15750, cost_per_unit: 17500 },
  { id: 1, cost: 0, title: 'Консультация', amount: 1, discount: 100, first_cost: 5000, cost_to_pay: 0, manual_cost: 0, cost_per_unit: 5000 },
  { id: 2, title: '  Пилинг   PRX ', amount: 1, discount: 30, first_cost: 6000, cost_per_unit: 6000 },
];

describe('act-lines', () => {
  test('строки из записи: сумма — manual_cost (бонусы не уменьшают), без него — по проценту скидки', () => {
    expect(linesFromRecord(SERVICES)).toEqual([
      { service_id: 9536663, title: 'Revi strong 2 ml', qty: 2, price: 24000, sum: 48000 },
      { service_id: 15394152, title: 'Фотоомоложение Lumeca - лицо', qty: 1, price: 17500, sum: 15750 },
      { service_id: 1, title: 'Консультация', qty: 1, price: 5000, sum: 0 },
      { service_id: 2, title: 'Пилинг PRX', qty: 1, price: 6000, sum: 4200 },
    ]);
    expect(linesFromRecord(null)).toEqual([]);
  });
  test('итог и скидка строки', () => {
    const t = actTotals(linesFromRecord(SERVICES));
    expect(t.total_sum).toBe(67950);
    expect(t.lines.map((l) => [l.n, l.discount])).toEqual([[1, 0], [2, 1750], [3, 5000], [4, 1800]]);
    expect(t.total_discount).toBe(8550);
  });
  test('normalizeLines: строки из формы, запятая в числе, ошибки по строкам', () => {
    expect(normalizeLines([{ title: ' Чистка ', qty: '1', price: '3 500,50', sum: 3500.5, service_id: '7' }]))
      .toEqual({ value: [{ service_id: 7, title: 'Чистка', qty: 1, price: 3500.5, sum: 3500.5 }] });
    expect(normalizeLines([]).error).toMatch(/1–50/);
    expect(normalizeLines([{ title: '', qty: 1, price: 1, sum: 1 }]).error).toMatch(/Строка 1: название/);
    expect(normalizeLines([{ title: 'a', qty: 0, price: 1, sum: 1 }]).error).toMatch(/количество/);
    expect(normalizeLines([{ title: 'a', qty: [5], price: 1, sum: 1 }]).error).toMatch(/количество/);
    expect(normalizeLines([{ title: 'a', qty: 1, price: -1, sum: 1 }]).error).toMatch(/цена/);
    expect(normalizeLines([{ title: 'a', qty: 1, price: 1, sum: 'x' }]).error).toMatch(/сумма/);
    expect(normalizeLines([{ title: 'a', qty: 1, price: 1, sum: 1, service_id: 1.5 }]).error).toMatch(/id услуги/);
  });
  test('doctorOf', () => {
    expect(doctorOf({ name: 'Гаджиева Пери', position: { title: 'Врач-косметолог' } })).toEqual({ name: 'Гаджиева Пери', position: 'Врач-косметолог' });
    expect(doctorOf({ name: 'Юлия', specialization: 'Косметолог' })).toEqual({ name: 'Юлия', position: 'Косметолог' });
    expect(doctorOf(null)).toEqual({ name: '', position: '' });
  });
});

describe('fill.buildRenderData', () => {
  const identity = {
    plain: { last_name: 'Иванова', first_name: 'Анна', middle_name: 'Сергеевна', birth_date: '1983-03-21', gender: 'F', phone: '79001234567', email: null, contract_no: '1739', contract_date: null },
    secure: { passport_series: '4510', passport_number: '123456', issued_by: 'ОВД', issue_date: '2015-05-01', authority_code: '770-001' },
  };
  const requisites = { name: 'ООО «Пери Клиник»', inn: '9724060392', city: 'Москва' };

  test('каждый тег словаря получает значение (без акта — все, кроме тегов акта)', () => {
    const data = buildRenderData({ identity, requisites, docDate: '2026-10-24' });
    for (const [tag, f] of Object.entries(FIELDS)) {
      if (f.actOnly) expect(data).not.toHaveProperty(tag);
      else expect(typeof data[tag]).toBe('string');
    }
  });
  test('значения и форматы; пустое — видимый пропуск, отчество — пусто', () => {
    const data = buildRenderData({ identity, requisites, docDate: '2026-10-24' });
    expect(data).toMatchObject({
      fio: 'Иванова Анна Сергеевна', fio_short: 'Иванова А. С.', birth_date: '21.03.1983', gender: 'женский', phone: '+7 (900) 123-45-67',
      email: '________', passport: '4510 123456', passport_issue_date: '01.05.2015', birth_place: '________',
      contract_no: '1739', contract_date: '24.10.2026', doc_date: '24.10.2026', doc_city: 'Москва', org_kpp: '________',
    });
    const noMiddle = buildRenderData({ identity: { plain: { last_name: 'Ким', first_name: 'Ли' }, secure: {} }, requisites: {}, docDate: '2026-10-24' });
    expect(noMiddle.middle_name).toBe('');
    expect(noMiddle.fio).toBe('Ким Ли');
  });
  test('акт: все теги акта и поля строки, суммы прописью', () => {
    const act = { act_no: '2056697734', visit_date: '2026-10-23', doctor_name: 'Гаджиева Пери', doctor_position: 'Врач-косметолог', lines: linesFromRecord(SERVICES.slice(0, 2)) };
    const data = buildRenderData({ identity, requisites, docDate: '2026-10-24', act });
    for (const [tag, f] of Object.entries(FIELDS)) if (f.actOnly) expect(data).toHaveProperty(tag);
    expect(Object.keys(data.services[0]).sort()).toEqual(Object.keys(SERVICE_FIELDS).sort());
    expect(data.services[1]).toEqual({ n: '2', title: 'Фотоомоложение Lumeca - лицо', qty: '1', price: `17${NBSP}500,00`, discount: `1${NBSP}750,00`, sum: `15${NBSP}750,00` });
    expect(data.total_sum).toBe(`63${NBSP}750,00`);
    expect(data.total_sum_words).toBe('Шестьдесят три тысячи семьсот пятьдесят рублей 00 копеек');
    expect(data.visit_date).toBe('23.10.2026');
  });
});

describe('statuses', () => {
  test('mapStatus и isFinal', () => {
    expect(mapStatus('WAIT_SIGN')).toBe('sent');
    expect(mapStatus('signed')).toBe('signed');
    expect(mapStatus('CANCELED')).toBe('declined');
    expect(mapStatus('SIGNING_EXPIRED')).toBe('expired');
    expect(mapStatus('NEW_THING')).toBeNull();
    expect(isFinal('annulled')).toBe(true);
    expect(isFinal('signed')).toBe(false);
  });
  const pkg = { id: 'p-1', status: 'sent', signed_at: null, fdoc_package_guid: null };
  const docs = [{ id: 'd-1', file_name: 'Договор.docx', title: 'Договор' }, { id: 'd-2', file_name: 'Согласие.docx', title: 'Согласие' }];
  test('подписан: время подписи клиента и сотрудника, сопоставление по id', () => {
    const r = applyWorkflow(pkg, docs, { id: 'p-1', status: 'SIGNED', documents: [
      { id: 'd-2', status: 'SIGNED', clientSigners: [{ isSigned: true, dateSignOrCancel: '2026-10-24T10:05:00+03:00' }], employeeSigners: [{ isSigned: true, dateSignOrCancel: '2026-10-24T10:00:00+03:00' }] },
      { id: 'd-1', status: 'SIGNED', clientSigners: [{ isSigned: true, dateSignOrCancel: '2026-10-24T10:04:00+03:00' }], employeeSigners: [] },
    ] });
    expect(r.package).toEqual({ status: 'signed', fdoc_status: 'SIGNED', fdoc_package_guid: null, signed_at: '2026-10-24T07:05:00.000Z', unknownStatus: false });
    expect(r.documents).toEqual([
      { id: 'd-1', fdoc_document_guid: null, fdoc_status: 'SIGNED', client_signed_at: '2026-10-24T07:04:00.000Z', corp_signed_at: null },
      { id: 'd-2', fdoc_document_guid: null, fdoc_status: 'SIGNED', client_signed_at: '2026-10-24T07:05:00.000Z', corp_signed_at: '2026-10-24T07:00:00.000Z' },
    ]);
  });
  test('свои GUID у F.Doc: сопоставление по имени файла, GUID запоминается', () => {
    const r = applyWorkflow(pkg, docs, { id: 'G-PKG', status: 'WAIT_SIGN', documents: [
      { id: 'G-2', name: 'согласие.docx', status: 'WAIT_SIGN' }, { id: 'G-1', name: 'Договор', status: 'WAIT_SIGN' },
    ] });
    expect(r.package.fdoc_package_guid).toBe('G-PKG');
    expect(r.documents.map((d) => [d.id, d.fdoc_document_guid])).toEqual([['d-1', 'G-1'], ['d-2', 'G-2']]);
  });
  test('незнакомый статус не теряет комплект; черновик становится отправленным', () => {
    expect(applyWorkflow(pkg, [], { id: 'p-1', status: 'SOMETHING_NEW' }).package).toMatchObject({ status: 'sent', unknownStatus: true });
    expect(applyWorkflow({ ...pkg, status: 'draft' }, [], { id: 'p-1', status: 'SOMETHING_NEW' }).package.status).toBe('sent');
  });
  test('по порядку — только при совпадении количества', () => {
    const r = applyWorkflow(pkg, docs, { id: 'p-1', status: 'WAIT_SIGN', documents: [{ id: 'X', name: 'Чужое', status: 'WAIT_SIGN' }] });
    expect(r.documents).toEqual([]);
  });
});
```

- [ ] **Step 2: Убедиться, что тест падает**

```bash
cd /root/loyalpro-fdoc/backend && npx jest edocs-fill
```

Ожидается: FAIL с `Cannot find module './services/edocs/act-lines'`.

- [ ] **Step 3: Строки акта**

Создать `backend/services/edocs/act-lines.js`:

```js
'use strict';
// Строки акта: из услуг записи YClients и после правок администратора.
// Сумма строки — manual_cost: цена после скидки, но ДО оплаты бонусами. Бонусы —
// способ оплаты и стоимость услуги в акте не уменьшают, а YClients иногда вычитает
// их прямо из cost (данные PERI 24.10.2026: first_cost 17500, discount 10 %,
// manual_cost 15750, cost 7737.61). Нет manual_cost — first_cost × (1 − discount/100);
// discount в YClients — ПРОЦЕНТ (10 % от 60000 → cost 54000).
const MAX_LINES = 50;
const CONTROL_RE = /[\u0000-\u001F\u007F‪-‮⁦-⁩]/g;

const round2 = (n) => Math.round(Number(n) * 100) / 100;
// Только число или строка: Number([5]) === 5 — массив не должен проходить как число.
function num(v) {
  if (typeof v === 'number') return v;
  if (typeof v === 'string' && v.trim() !== '') return Number(v.replace(/[\s ]/g, '').replace(',', '.'));
  return NaN;
}

/** Строки по умолчанию из records.services. */
function linesFromRecord(services) {
  return (Array.isArray(services) ? services : []).map((s) => {
    const qty = num(s.amount) > 0 ? num(s.amount) : 1;
    const first = num(s.first_cost);
    const full = Number.isFinite(first) ? first : (Number.isFinite(num(s.cost_per_unit)) ? num(s.cost_per_unit) : 0) * qty;
    const manual = num(s.manual_cost);
    const disc = Number.isFinite(num(s.discount)) ? num(s.discount) : 0;
    const sum = Number.isFinite(manual) ? manual : full * (1 - disc / 100);
    return {
      service_id: Number.isInteger(num(s.id)) && num(s.id) > 0 ? num(s.id) : null,
      title: String(s.title || 'Услуга').replace(CONTROL_RE, '').replace(/\s+/g, ' ').trim().slice(0, 300),
      qty,
      price: round2(full / qty),
      sum: round2(Math.max(0, sum)),
    };
  });
}

/** Проверка строк, присланных администратором. @returns {{value}|{error}} */
function normalizeLines(input) {
  if (!Array.isArray(input) || !input.length || input.length > MAX_LINES) return { error: `Строки акта — список из 1–${MAX_LINES}` };
  const out = [];
  for (const [i, l] of input.entries()) {
    const n = i + 1;
    if (!l || typeof l !== 'object') return { error: `Строка ${n}: неверный формат` };
    const title = String(l.title || '').replace(CONTROL_RE, '').replace(/\s+/g, ' ').trim();
    if (!title || title.length > 300) return { error: `Строка ${n}: название — 1–300 символов` };
    const qty = num(l.qty), price = num(l.price), sum = num(l.sum);
    if (!(qty > 0 && qty <= 1000)) return { error: `Строка ${n}: количество — больше 0 и не больше 1000` };
    if (!(price >= 0 && price <= 10000000)) return { error: `Строка ${n}: цена — от 0 до 10 000 000` };
    if (!(sum >= 0 && sum <= 10000000)) return { error: `Строка ${n}: сумма — от 0 до 10 000 000` };
    const sid = l.service_id === null || l.service_id === undefined || l.service_id === '' ? null : num(l.service_id);
    if (sid !== null && !(Number.isInteger(sid) && sid > 0)) return { error: `Строка ${n}: неверный id услуги` };
    out.push({ service_id: sid, title, qty: Math.round(qty * 1000) / 1000, price: round2(price), sum: round2(sum) });
  }
  return { value: out };
}

/** Номера строк, скидка строки (qty × price − sum, не меньше 0) и итог. */
function actTotals(lines) {
  const rows = (lines || []).map((l, i) => ({ ...l, n: i + 1, discount: round2(Math.max(0, l.qty * l.price - l.sum)) }));
  return {
    lines: rows,
    total_sum: round2(rows.reduce((a, l) => a + l.sum, 0)),
    total_discount: round2(rows.reduce((a, l) => a + l.discount, 0)),
  };
}

/** Врач и должность из records.staff (объект YClients). */
function doctorOf(staff) {
  const s = staff && typeof staff === 'object' && !Array.isArray(staff) ? staff : {};
  return {
    name: String(s.name || '').trim(),
    position: String((s.position && s.position.title) || s.specialization || '').trim(),
  };
}

module.exports = { MAX_LINES, linesFromRecord, normalizeLines, actTotals, doctorOf };
```

- [ ] **Step 4: Данные для рендера**

Создать `backend/services/edocs/fill.js`:

```js
'use strict';
// Данные для рендера DOCX: данные пациента, реквизиты клиники, дата документа, акт.
// Пустое значение — видимый пропуск «________» (кроме отчества: его законно нет).
// Каждый тег словаря placeholders.FIELDS обязан получить здесь значение — на это тест.
const { EMPTY, fmtDate, fmtMoney, fmtQty, fmtPhone } = require('./format');
const { rublesInWords } = require('../../utils/money-words');
const { actTotals } = require('./act-lines');

const v = (x) => (x === null || x === undefined || String(x).trim() === '' ? EMPTY : String(x));
const has = (x) => x !== null && x !== undefined && String(x).trim() !== '';

/**
 * identity — { plain, secure } (identity.decodeRow), requisites — edoc_settings.requisites,
 * docDate — 'YYYY-MM-DD', act — { act_no, visit_date, doctor_name, doctor_position, lines } или null.
 */
function buildRenderData({ identity, requisites, docDate, act = null }) {
  const p = (identity && identity.plain) || {};
  const s = (identity && identity.secure) || {};
  const r = requisites || {};
  const fio = [p.last_name, p.first_name, p.middle_name].filter(has).map((x) => String(x).trim()).join(' ');
  const initials = [p.first_name, p.middle_name].filter(has).map((w) => `${String(w).trim()[0].toUpperCase()}.`).join(' ');
  const data = {
    fio: v(fio),
    fio_short: v(has(p.last_name) ? `${String(p.last_name).trim()} ${initials}`.trim() : ''),
    last_name: v(p.last_name),
    first_name: v(p.first_name),
    middle_name: has(p.middle_name) ? String(p.middle_name).trim() : '',
    birth_date: v(fmtDate(p.birth_date)),
    gender: v(p.gender === 'F' ? 'женский' : p.gender === 'M' ? 'мужской' : ''),
    phone: v(fmtPhone(p.phone)),
    email: v(p.email),
    passport: v(has(s.passport_series) && has(s.passport_number) ? `${s.passport_series} ${s.passport_number}` : ''),
    passport_series: v(s.passport_series),
    passport_number: v(s.passport_number),
    passport_issued_by: v(s.issued_by),
    passport_issue_date: v(fmtDate(s.issue_date)),
    passport_authority_code: v(s.authority_code),
    birth_place: v(s.birth_place),
    address: v(s.address),
    contract_no: v(p.contract_no),
    contract_date: v(fmtDate(p.contract_date || docDate)),
    doc_date: v(fmtDate(docDate)),
    doc_city: v(r.city),
    org_name: v(r.name),
    org_inn: v(r.inn),
    org_kpp: v(r.kpp),
    org_ogrn: v(r.ogrn),
    org_address: v(r.address),
    org_license: v(r.license),
    org_phone: v(r.phone),
    org_bank: v(r.bank),
    org_signer_position: v(r.signer_position),
    org_signer_name: v(r.signer_name),
  };
  if (act) {
    const t = actTotals(act.lines || []);
    Object.assign(data, {
      act_no: v(act.act_no),
      visit_date: v(fmtDate(act.visit_date)),
      doctor_name: v(act.doctor_name),
      doctor_position: v(act.doctor_position),
      total_sum: fmtMoney(t.total_sum),
      total_sum_words: rublesInWords(t.total_sum),
      services: t.lines.map((l) => ({
        n: String(l.n), title: l.title, qty: fmtQty(l.qty), price: fmtMoney(l.price), discount: fmtMoney(l.discount), sum: fmtMoney(l.sum),
      })),
    });
  }
  return data;
}

module.exports = { buildRenderData };
```

- [ ] **Step 5: Статусы F.Doc**

Создать `backend/services/edocs/statuses.js`:

```js
'use strict';
// Статусы F.Doc → статусы комплекта у нас (спека §4.4) и разбор ответа
// «статусы в разрезе маршрута подписания» (POST /portal/api/v1/documents/workflow/signing/status).
const MAP = {
  PREPARED: 'sent', CREATED_FROM_TEMPLATE: 'sent', SEND_LINK: 'sent', WAIT_FILL: 'sent', WAIT_SIGN: 'sent', ERROR_SEND: 'sent',
  SIGNED: 'signed',
  CANCELED: 'declined',
  ANNULED: 'annulled',
  SIGNING_EXPIRED: 'expired', DELETED: 'expired',
  SIGNED_PAPER: 'paper',
  ERROR_SIGN: 'error', ERROR_ANNUL: 'error',
};
const FINAL = new Set(['declined', 'annulled', 'expired', 'paper']);
const STATUSES = ['draft', 'sent', 'signed', 'declined', 'annulled', 'expired', 'paper', 'error'];

/** Наш статус по статусу F.Doc или null, если статус незнакомый. */
function mapStatus(fdoc) { return MAP[String(fdoc || '').toUpperCase()] || null; }
function isFinal(status) { return FINAL.has(status); }

function iso(ts) { const t = Date.parse(ts); return Number.isFinite(t) ? new Date(t).toISOString() : null; }
function lastSigned(signers) {
  const list = (signers || []).filter((x) => x && x.isSigned).map((x) => iso(x.dateSignOrCancel)).filter(Boolean).sort();
  return list.length ? list[list.length - 1] : null;
}
const norm = (s) => String(s || '').trim().toLowerCase().replace(/\.(docx?|pdf)$/i, '');

// Документ F.Doc для нашего: по id (мы отправляем свои UUID), затем по имени файла,
// затем по порядку — только если количество документов совпадает.
function matchDoc(doc, list, idx, used) {
  const free = (i) => !used.has(i);
  let i = list.findIndex((x, k) => free(k) && x && (x.id === doc.id || (doc.fdoc_document_guid && x.id === doc.fdoc_document_guid)));
  if (i < 0) i = list.findIndex((x, k) => free(k) && x && norm(x.name) && (norm(x.name) === norm(doc.file_name) || norm(x.name) === norm(doc.title)));
  if (i < 0 && free(idx) && list[idx]) i = idx;
  if (i < 0) return null;
  used.add(i);
  return list[i];
}

/**
 * Обновления по ответу F.Doc для одного комплекта.
 * pkg — строка edoc_packages; docs — её edoc_documents (по sort_order);
 * wf — { id, name, status, documents: [{ id, name, status, clientSigners, employeeSigners }] }.
 */
function applyWorkflow(pkg, docs, wf, now = new Date()) {
  const mapped = mapStatus(wf && wf.status);
  const status = mapped || (pkg.status === 'draft' ? 'sent' : pkg.status);   // незнакомый статус: комплект не теряем
  const list = (wf && Array.isArray(wf.documents)) ? wf.documents : [];
  const sameCount = list.length === docs.length;
  const used = new Set();
  const documents = [];
  docs.forEach((d, idx) => {
    const w = matchDoc(d, list, sameCount ? idx : -1, used);
    if (!w) return;
    documents.push({
      id: d.id,
      fdoc_document_guid: w.id && w.id !== d.id ? String(w.id) : (d.fdoc_document_guid || null),
      fdoc_status: w.status || null,
      client_signed_at: lastSigned(w.clientSigners),
      corp_signed_at: lastSigned(w.employeeSigners),
    });
  });
  let signedAt = null;
  if (status === 'signed') {
    const times = documents.map((x) => x.client_signed_at).filter(Boolean).sort();
    signedAt = pkg.signed_at ? new Date(pkg.signed_at).toISOString() : (times.length ? times[times.length - 1] : now.toISOString());
  }
  return {
    package: {
      status,
      fdoc_status: (wf && wf.status) || null,
      fdoc_package_guid: wf && wf.id && wf.id !== pkg.id ? String(wf.id) : (pkg.fdoc_package_guid || null),
      signed_at: signedAt,
      unknownStatus: !mapped,
    },
    documents,
  };
}

module.exports = { STATUSES, mapStatus, isFinal, applyWorkflow };
```

- [ ] **Step 6: Ошибки модуля**

Создать `backend/services/edocs/errors.js`:

```js
'use strict';
// Ошибка модуля «Документы» с HTTP-статусом для роутера: code — машинный код
// (фронт по нему открывает «Мой F.Doc» и т.п.), message — текст для человека.
class EdocsError extends Error {
  constructor(code, message, status = 400, extra = {}) {
    super(message);
    this.name = 'EdocsError';
    this.code = code;
    this.status = status;
    Object.assign(this, extra);
  }
}
/** Короткий текст ошибки для журнала и ответа (без переводов строк, до 300 символов). */
function shortError(e) { return String((e && e.message) || e || '').replace(/\s+/g, ' ').trim().slice(0, 300); }

/**
 * Ответ роутера на ошибку модуля. Наружу — только понятный текст и машинный код;
 * текст SQL и стек — в лог (правило проекта для API).
 */
function sendError(res, e, logger, label) {
  if (e && e.name === 'EdocsError') {
    const body = { error: e.message, code: e.code };
    if (e.missing) body.missing = e.missing;
    if (e.packageId) body.packageId = e.packageId;
    return res.status(e.status || 400).json(body);
  }
  if (e && e.name === 'SecretBoxError') {
    if (e.code === 'no_key') {
      return res.status(503).json({ error: 'На сервере не задан ключ шифрования EDOCS_ENC_KEY — обратитесь к администратору сервера', code: 'enc_not_configured' });
    }
    logger.error(`${label}: ${e.message}`);
    return res.status(500).json({ error: 'Не удалось расшифровать сохранённые данные', code: 'enc_failed' });
  }
  if (e && e.name === 'TemplateError') return res.status(400).json({ error: e.message, details: e.details || [] });
  if (e && e.name === 'FdocError') {
    logger.warn(`${label}: ${e.message}`);
    return res.status(502).json({ error: e.message, code: e.code });
  }
  logger.error(`${label}: ${(e && e.message) || e}`);
  return res.status(500).json({ error: 'Внутренняя ошибка' });
}

module.exports = { EdocsError, shortError, sendError };
```

- [ ] **Step 7: Тест проходит**

```bash
cd /root/loyalpro-fdoc/backend && npx jest edocs-fill 2>&1 | grep -E "Tests:"
```

Ожидается: `Tests: 12 passed, 12 total`.

- [ ] **Step 8: Commit**

```bash
cd /root/loyalpro-fdoc && git add backend/services/edocs/act-lines.js backend/services/edocs/fill.js backend/services/edocs/statuses.js backend/services/edocs/errors.js backend/edocs-fill.test.js && git commit -m "feat(edocs): строки акта (manual_cost), данные для шаблонов, статусы F.Doc и ошибки модуля

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Клиент F.Doc — **Opus**

Три вида учётных данных: Basic логин:пароль приложения (проверка ключа, тариф, вебхуки), ключ организации `apiKey` в параметрах/теле и bearer-токен сотрудника для всего остального. Токены — только в памяти, ключ `corpId:userId`; срок — `exp` из JWT, если он в будущем, но не дальше 3 минут (часы F.Doc могут расходиться с нашими); протух — вход по refreshToken, отказ — паролем; одновременные запросы одного сотрудника делят один вход (refreshToken ротируется при каждом входе). 401 на рабочем вызове — один повтор с новым входом. Повторы при сети/5xx — только для чтений; отправка комплекта вслепую не повторяется (мог быть принят). В текст ошибки идут метод и путь, но НЕ параметры (там `apiKey`).

**Files:**
- Create: `backend/services/fdoc/client.js`
- Test: `backend/edocs-fdoc-client.test.js`

- [ ] **Step 1: Написать падающий тест**

Создать `backend/edocs-fdoc-client.test.js`:

```js
'use strict';
const { makeClient, FdocError, jwtExpMs, PATHS } = require('./services/fdoc/client');

const S = { baseUrl: 'https://demo.fdoc.ru', apiKey: 'KEY-SECRET', appLogin: 'app', appPassword: 'apppw', appCode: 'crm', corpId: 'C1' };
const CRED = { userId: 7, login: 'ivanova', password: 'pw' };
const jwt = (expSec) => `h.${Buffer.from(JSON.stringify({ exp: expSec })).toString('base64')}.s`;
const httpErr = (status, data) => Object.assign(new Error('x'), { response: { status, data } });

function setup(handler) {
  let t = 1_000_000;
  const calls = [];
  const http = { request: jest.fn(async (conf) => { calls.push(conf); return handler(conf, calls.length); }) };
  const c = makeClient({ http, now: () => t, sleep: async () => {} });
  return { c, http, calls, tick: (ms) => { t += ms; } };
}
const tokenResponse = (n) => ({ data: { accessToken: jwt(1000 + 180), refreshToken: { value: `R${n}`, exp: new Date(1_000_000 + 3600_000).toISOString() } } });

describe('jwtExpMs', () => {
  test('exp числом и строкой ISO; мусор — null', () => {
    expect(jwtExpMs(jwt(1700000000))).toBe(1700000000000);
    expect(jwtExpMs(`h.${Buffer.from(JSON.stringify({ exp: '2021-09-30T14:07:53+07:00' })).toString('base64')}.s`)).toBe(Date.parse('2021-09-30T14:07:53+07:00'));
    expect(jwtExpMs('garbage')).toBeNull();
  });
});

describe('verifyApiKey и Basic-вызовы', () => {
  test('Basic приложения + apiKey в параметрах; corpId строкой', async () => {
    const { c, calls } = setup(() => ({ data: { corpId: 12345 } }));
    expect(await c.verifyApiKey(S)).toBe('12345');
    expect(calls[0]).toMatchObject({ method: 'get', url: 'https://demo.fdoc.ru' + PATHS.verify, params: { apiKey: 'KEY-SECRET' }, auth: { username: 'app', password: 'apppw' } });
  });
  test('текст ошибки — метод, путь, статус, сообщение F.Doc, но без ключа', async () => {
    const { c } = setup(() => { throw httpErr(401, { message: 'Неверный ключ' }); });
    await expect(c.verifyApiKey(S)).rejects.toMatchObject({ status: 401, code: 'fdoc_unauthorized' });
    try { await c.verifyApiKey(S); } catch (e) {
      expect(e.message).toBe('F.Doc GET /paperless-gateway/api/v1/verifyApiKey 401: Неверный ключ');
      expect(e.message).not.toContain('KEY-SECRET');
    }
  });
  test('putWebhooks: событие SetStatus, канал API, промежуточные статусы', async () => {
    const { c, calls } = setup(() => ({ data: {} }));
    await c.putWebhooks(S, 'https://h/fdoc/webhook/abc');
    expect(calls[0]).toMatchObject({ method: 'put', auth: { username: 'app' }, data: { apiKey: 'KEY-SECRET', events: [{ url: 'https://h/fdoc/webhook/abc', code: 'SetStatus' }], channelTypeCode: 'API', sendIntermediateStatuses: true } });
  });
});

describe('токен сотрудника', () => {
  test('вход паролем: grant = base64(login:password), app и corpId; токен переиспользуется', async () => {
    const { c, calls } = setup((conf) => (conf.url.endsWith(PATHS.token) ? tokenResponse(1) : { data: { packages: [], failures: [] } }));
    await c.workflowStatuses(S, CRED, ['p1']);
    await c.workflowStatuses(S, CRED, ['p2']);
    const logins = calls.filter((x) => x.url.endsWith(PATHS.token));
    expect(logins).toHaveLength(1);
    expect(logins[0].data).toEqual({ apiKey: 'KEY-SECRET', grant: Buffer.from('ivanova:pw').toString('base64'), grantType: 'password', app: 'crm', corpId: 'C1' });
    expect(calls[1].headers.Authorization).toBe(`Bearer ${jwt(1180)}`);
    expect(calls[1].data).toEqual({ ids: ['p1'], idType: 'package', corpId: 'C1', app: 'crm' });
  });
  test('протух accessToken — вход по refreshToken; refresh отвергнут — паролем', async () => {
    let n = 0;
    const { c, calls, tick } = setup((conf) => {
      if (!conf.url.endsWith(PATHS.token)) return { data: {} };
      n++;
      if (conf.data.grantType === 'refreshToken' && n === 3) throw httpErr(400, { message: 'refresh expired' });
      return tokenResponse(n);
    });
    await c.employeeUrl(S, CRED, 'p1');
    tick(200_000);
    await c.employeeUrl(S, CRED, 'p1');
    expect(calls.filter((x) => x.url.endsWith(PATHS.token)).map((x) => x.data.grantType)).toEqual(['password', 'refreshToken']);
    tick(200_000);
    await c.employeeUrl(S, CRED, 'p1');
    expect(calls.filter((x) => x.url.endsWith(PATHS.token)).map((x) => x.data.grantType)).toEqual(['password', 'refreshToken', 'refreshToken', 'password']);
  });
  test('неверный пароль — fdoc_credentials_invalid', async () => {
    const { c } = setup(() => { throw httpErr(401, { message: 'bad credentials' }); });
    await expect(c.checkCredentials(S, CRED)).rejects.toMatchObject({ code: 'fdoc_credentials_invalid', status: 401 });
  });
  test('два параллельных вызова делят один вход', async () => {
    const { c, calls } = setup(async (conf) => (conf.url.endsWith(PATHS.token) ? tokenResponse(1) : { data: { url: 'u' } }));
    await Promise.all([c.employeeUrl(S, CRED, 'a'), c.employeeUrl(S, CRED, 'b')]);
    expect(calls.filter((x) => x.url.endsWith(PATHS.token))).toHaveLength(1);
  });
  test('401 на рабочем вызове — новый вход и один повтор', async () => {
    let work = 0;
    const { c, calls } = setup((conf) => {
      if (conf.url.endsWith(PATHS.token)) return tokenResponse(calls.length);
      work++;
      if (work === 1) throw httpErr(401, { message: 'token revoked' });
      return { data: { url: 'ok' } };
    });
    expect(await c.employeeUrl(S, CRED, 'p')).toBe('ok');
    expect(work).toBe(2);
  });
});

describe('повторы и ответы', () => {
  test('чтение статусов повторяется на 5xx, отправка комплекта — нет', async () => {
    let wf = 0, send = 0;
    const { c } = setup((conf) => {
      if (conf.url.endsWith(PATHS.token)) return tokenResponse(1);
      if (conf.url.endsWith(PATHS.workflow)) { wf++; if (wf < 3) throw httpErr(502, 'Bad Gateway'); return { data: { packages: [{ id: 'p' }] } }; }
      send++; throw httpErr(503, 'down');
    });
    expect((await c.workflowStatuses(S, CRED, ['p'])).packages).toEqual([{ id: 'p' }]);
    expect(wf).toBe(3);
    await expect(c.sendPackage(S, CRED, {})).rejects.toMatchObject({ code: 'fdoc_server', status: 503 });
    expect(send).toBe(1);
  });
  test('сетевой сбой — fdoc_network', async () => {
    const { c } = setup(() => { throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }); });
    await expect(c.verifyApiKey(S)).rejects.toMatchObject({ code: 'fdoc_network', status: null });
  });
  test('downloadPdf: Buffer с %PDF; иначе ошибка; тело ошибки из arraybuffer читается', async () => {
    let n = 0;
    const { c } = setup((conf) => {
      if (conf.url.endsWith(PATHS.token)) return tokenResponse(1);
      n++;
      if (n === 1) return { data: Buffer.from('%PDF-1.7 ...') };
      if (n === 2) return { data: Buffer.from('<html>') };
      throw httpErr(404, Buffer.from(JSON.stringify({ message: 'Документ не найден' })));
    });
    expect((await c.downloadPdf(S, CRED, 'p', 'd')).slice(0, 4).toString()).toBe('%PDF');
    await expect(c.downloadPdf(S, CRED, 'p', 'd')).rejects.toThrow(/не PDF/);
    await expect(c.downloadPdf(S, CRED, 'p', 'd')).rejects.toThrow(/404: Документ не найден/);
  });
  test('recognize: первый результат или null', async () => {
    const { c } = setup((conf) => (conf.url.endsWith(PATHS.token) ? tokenResponse(1) : { data: { result: [{ confidence: true }] } }));
    expect(await c.recognize(S, CRED, 'AAA', 'jpg')).toEqual({ confidence: true });
  });
  test('FdocError экспортируется', () => expect(new FdocError('x')).toBeInstanceOf(Error));
});
```

- [ ] **Step 2: Убедиться, что тест падает**

```bash
cd /root/loyalpro-fdoc/backend && npx jest edocs-fdoc-client
```

Ожидается: FAIL с `Cannot find module './services/fdoc/client'`.

- [ ] **Step 3: Реализация**

Создать `backend/services/fdoc/client.js`:

```js
'use strict';
// HTTP-клиент F.Doc OpenAPI 1.2 (спека https://demo.fdoc.ru/spec/). Три вида учётных данных:
//   • Basic логин:пароль ПРИЛОЖЕНИЯ — verifyApiKey, тариф, подписка на вебхуки;
//   • ключ организации apiKey — в параметрах/теле этих же вызовов и при входе сотрудника;
//   • bearer-токен СОТРУДНИКА (accessToken живёт 3 минуты) — всё остальное.
// Токены — только в памяти процесса (рестарт = новый вход паролем), ключ corpId:userId.
// Одновременные запросы одного сотрудника делят один вход (single-flight): refreshToken
// ротируется при каждом входе, параллельные обновления испортили бы друг друга.
// В текст ошибки не попадают параметры запроса (там apiKey) — только метод и путь.
const axios = require('axios');

const TIMEOUT_MS = 30000;
const SEND_TIMEOUT_MS = 120000;        // комплект до 50 МБ в base64
const PDF_TIMEOUT_MS = 60000;
const TOKEN_MARGIN_MS = 20000;         // токен, которому жить меньше 20 с, не используем
const DEFAULT_ACCESS_MS = 3 * 60 * 1000;
const P = {
  verify: '/paperless-gateway/api/v1/verifyApiKey',
  token: '/paperless-gateway/api/v1/operator/accessToken',
  send: '/paperless-gateway/api/v1/document/withSigners',
  workflow: '/paperless-gateway/portal/api/v1/documents/workflow/signing/status',
  employeeUrl: '/paperless-gateway/api/v1/document',
  permalink: '/paperless-gateway/portal/api/v1/permalink/send',
  decline: '/paperless-gateway/api/v1/employee/decline/package',
  pdf: '/paperless-gateway/portal/api/v1/document',
  recognize: '/additional-opengate/api/v1/docs/by/client/recognize',
  tariff: '/paperless-gateway/api/v1/corp/tariff/active/info',
  webhooks: '/paperless-gateway/api/v1/corp/webhooks',
};

class FdocError extends Error {
  constructor(message, { status = null, code = 'fdoc_error' } = {}) {
    super(message); this.name = 'FdocError'; this.status = status; this.code = code;
  }
}

/** Срок жизни JWT (мс): exp числом (секунды) или строкой ISO, как в примере спеки F.Doc. */
function jwtExpMs(token) {
  try {
    const part = String(token).split('.')[1];
    const json = JSON.parse(Buffer.from(part.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
    if (typeof json.exp === 'number') return json.exp * 1000;
    const t = Date.parse(json.exp);
    return Number.isFinite(t) ? t : null;
  } catch (e) { return null; }
}

function errorText(data) {
  if (data === null || data === undefined) return '';
  let d = data;
  if (Buffer.isBuffer(d) || d instanceof ArrayBuffer) d = Buffer.from(d).toString('utf8');
  if (typeof d === 'string') {
    try { d = JSON.parse(d); } catch (e) { return d.replace(/\s+/g, ' ').trim().slice(0, 300); }
  }
  return String(d.message || d.error || d.details || JSON.stringify(d)).replace(/\s+/g, ' ').trim().slice(0, 300);
}

function toFdocError(e, conf) {
  const status = e && e.response ? e.response.status : null;
  const path = String(conf.url || '').replace(/^https?:\/\/[^/]+/, '').split('?')[0];
  const text = e && e.response ? errorText(e.response.data) : ((e && (e.code || e.message)) || 'network error');
  const code = status === 401 ? 'fdoc_unauthorized'
    : status === 403 ? 'fdoc_forbidden'
      : status === 404 ? 'fdoc_not_found'
        : status && status < 500 ? 'fdoc_rejected'
          : status ? 'fdoc_server' : 'fdoc_network';
  return new FdocError(`F.Doc ${String(conf.method || 'get').toUpperCase()} ${path} ${status || 'network'}: ${text}`, { status, code });
}

function makeClient({ http = axios, now = () => Date.now(), sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  const tokens = new Map();     // corpId:userId → { access, accessExp, refresh, refreshExp }
  const inflight = new Map();   // corpId:userId → Promise<access>

  // retries — только для идемпотентных чтений: повтор при сетевой ошибке или 5xx.
  async function request(conf, { retries = 0 } = {}) {
    for (let attempt = 0; ; attempt++) {
      try {
        const res = await http.request({ timeout: TIMEOUT_MS, ...conf });
        return res.data;
      } catch (e) {
        const st = e && e.response ? e.response.status : null;
        if ((st !== null && st < 500) || attempt >= retries) throw toFdocError(e, conf);
        await sleep(1000);
      }
    }
  }
  const at = (s, path) => `${s.baseUrl}${path}`;
  const basic = (s) => ({ username: s.appLogin, password: s.appPassword });
  const key = (s, cred) => `${s.corpId}:${cred.userId}`;

  async function login(s, grant, grantType) {
    const data = await request({ method: 'post', url: at(s, P.token), data: { apiKey: s.apiKey, grant, grantType, app: s.appCode, corpId: s.corpId } });
    if (!data || !data.accessToken) throw new FdocError('F.Doc: в ответе на вход сотрудника нет accessToken', { code: 'fdoc_bad_response' });
    const t = now();
    const refresh = (data.refreshToken && data.refreshToken.value) || null;
    const refreshExp = refresh ? (Date.parse(data.refreshToken.exp) || t + 60 * 60 * 1000) : 0;
    // exp из JWT принимаем, только если он в будущем (часы F.Doc могут расходиться с нашими),
    // и не дальше 3 минут: протухший раньше токен поймает повтор по 401 в authed().
    const jwtExp = jwtExpMs(data.accessToken);
    const accessExp = jwtExp && jwtExp > t + TOKEN_MARGIN_MS ? Math.min(jwtExp, t + DEFAULT_ACCESS_MS) : t + DEFAULT_ACCESS_MS;
    return { access: data.accessToken, accessExp, refresh, refreshExp };
  }
  async function passwordLogin(s, cred) {
    try {
      return await login(s, Buffer.from(`${cred.login}:${cred.password}`).toString('base64'), 'password');
    } catch (e) {
      if (e.status && e.status < 500) {
        throw new FdocError(`F.Doc не принял логин или пароль сотрудника: ${e.message}`, { status: 401, code: 'fdoc_credentials_invalid' });
      }
      throw e;
    }
  }
  async function freshToken(s, cred) {
    const cur = tokens.get(key(s, cred));
    let t = null;
    if (cur && cur.refresh && cur.refreshExp - TOKEN_MARGIN_MS > now()) {
      try { t = await login(s, cur.refresh, 'refreshToken'); } catch (e) { if (!e.status || e.status >= 500) throw e; }
    }
    if (!t) t = await passwordLogin(s, cred);
    tokens.set(key(s, cred), t);
    return t.access;
  }
  async function token(s, cred, force = false) {
    const k = key(s, cred);
    const cur = tokens.get(k);
    if (!force && cur && cur.accessExp - TOKEN_MARGIN_MS > now()) return cur.access;
    if (inflight.has(k)) return inflight.get(k);
    const p = freshToken(s, cred).finally(() => inflight.delete(k));
    inflight.set(k, p);
    return p;
  }
  // Вызов под токеном сотрудника. 401 на рабочем вызове — токен отозван: один повтор с новым входом.
  async function authed(s, cred, conf, opts) {
    const run = async (force) => request({ ...conf, headers: { ...(conf.headers || {}), Authorization: `Bearer ${await token(s, cred, force)}` } }, opts);
    try { return await run(false); } catch (e) {
      if (e.status !== 401 || e.code === 'fdoc_credentials_invalid') throw e;
      const cur = tokens.get(key(s, cred));
      if (cur) tokens.set(key(s, cred), { ...cur, accessExp: 0 });
      return run(true);
    }
  }

  return {
    /** corpId организации по ключу API (Basic приложения). */
    async verifyApiKey(s) {
      const data = await request({ method: 'get', url: at(s, P.verify), params: { apiKey: s.apiKey }, auth: basic(s) });
      if (!data || !data.corpId) throw new FdocError('F.Doc: в ответе проверки ключа нет corpId', { code: 'fdoc_bad_response' });
      return String(data.corpId);
    },
    /** Проверка логина и пароля сотрудника: вход паролем мимо кэша, токен кэшируется. */
    async checkCredentials(s, cred) {
      const t = await passwordLogin(s, cred);
      tokens.set(key(s, cred), t);
      return true;
    },
    /** POST document/withSigners — повтор вслепую НЕ делаем: комплект мог быть принят. */
    async sendPackage(s, cred, body) {
      return authed(s, cred, { method: 'post', url: at(s, P.send), data: body, timeout: SEND_TIMEOUT_MS, maxBodyLength: Infinity, maxContentLength: Infinity });
    },
    /** Статусы комплектов по подписантам (до 10 id за запрос). */
    async workflowStatuses(s, cred, ids) {
      const data = await authed(s, cred, { method: 'post', url: at(s, P.workflow), data: { ids, idType: 'package', corpId: s.corpId, app: s.appCode } }, { retries: 2 });
      return { packages: (data && data.packages) || [], failures: (data && data.failures) || [] };
    },
    /** Ссылка на окно сотрудника по комплекту (живёт 30 минут). */
    async employeeUrl(s, cred, packageGuid) {
      const data = await authed(s, cred, { method: 'get', url: at(s, P.employeeUrl), params: { id: packageGuid, idType: 'package' } }, { retries: 2 });
      return (data && data.url) || null;
    },
    async sendPermalink(s, cred, packageGuid, clientIds) {
      await authed(s, cred, { method: 'post', url: at(s, P.permalink), data: { packageGuid, clientExternalIds: clientIds } });
    },
    async declinePackage(s, cred, packageGuid) {
      await authed(s, cred, { method: 'post', url: at(s, P.decline), data: { packageGuid, declineType: 'DECLINE' } });
    },
    /** PDF подписанного документа со штампом. */
    async downloadPdf(s, cred, packageGuid, documentGuid) {
      const data = await authed(s, cred, {
        method: 'get', url: at(s, P.pdf), params: { packageGuid, documentGuid, download: true }, responseType: 'arraybuffer', timeout: PDF_TIMEOUT_MS,
      }, { retries: 2 });
      const buf = Buffer.from(data || []);
      if (buf.slice(0, 4).toString('latin1') !== '%PDF') throw new FdocError('F.Doc вернул не PDF', { code: 'fdoc_bad_response' });
      return buf;
    },
    /** Распознавание паспорта по фото (base64 ≤ 6 МБ): первый результат или null. */
    async recognize(s, cred, base64, ext) {
      const data = await authed(s, cred, { method: 'post', url: at(s, P.recognize), data: { documentsPhoto: base64, fileExtension: ext } });
      return (data && Array.isArray(data.result) && data.result[0]) || null;
    },
    async tariffInfo(s) {
      const data = await request({ method: 'get', url: at(s, P.tariff), params: { apiKey: s.apiKey }, auth: basic(s) }, { retries: 1 });
      return Array.isArray(data) ? data : [];
    },
    async putWebhooks(s, hookUrl) {
      await request({ method: 'put', url: at(s, P.webhooks), auth: basic(s), data: {
        apiKey: s.apiKey, events: [{ url: hookUrl, code: 'SetStatus' }], channelTypeCode: 'API', sendIntermediateStatuses: true,
      } });
    },
    async getWebhooks(s) {
      return request({ method: 'get', url: at(s, P.webhooks), params: { apiKey: s.apiKey }, auth: basic(s) });
    },
    /** Забыть токены сотрудника (сменил пароль, отключился). */
    forget(corpId, userId) { tokens.delete(`${corpId}:${userId}`); },
  };
}

const client = makeClient();
module.exports = { makeClient, client, FdocError, jwtExpMs, PATHS: P };
```

- [ ] **Step 4: Тест проходит**

```bash
cd /root/loyalpro-fdoc/backend && npx jest edocs-fdoc-client 2>&1 | grep -E "Tests:"
```

Ожидается: `Tests: 14 passed, 14 total`.

- [ ] **Step 5: Commit**

```bash
cd /root/loyalpro-fdoc && git add backend/services/fdoc/client.js backend/edocs-fdoc-client.test.js && git commit -m "feat(edocs): клиент F.Doc — токены сотрудника в памяти, single-flight, повторы чтений

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Слой данных и проверка SQL — **Opus**

Весь SQL модуля в одном файле, каждый запрос ограничен `salon_id` (без него — только кросс-салонная выборка фонового опроса и поиск салона по секрету вебхука). DATE-колонки читаются через `to_char` — pg отдаёт DATE полуночью по Москве, и `toISOString()` дал бы вчерашний день. Юнит-тесты подменяют `db` и SQL не проверяют, поэтому тест слоя — живой скрипт: все функции выполняются на дев-БД в ОДНОЙ транзакции с `ROLLBACK` в конце. Ключ `--create-tables` создаёт таблицы модуля из `migrations.js` прямо в этой транзакции и без внешних ключей — проверка работает до миграции дева и не берёт блокировок на `clients`/`records`/`users`. Скрипт отказывается работать не на `loyalpro_test`.

**Files:**
- Create: `backend/scripts/edocs-store-smoke.js` (тест слоя)
- Create: `backend/services/edocs/store.js`

- [ ] **Step 1: Написать проверку SQL**

Создать `backend/scripts/edocs-store-smoke.js`:

```js
'use strict';
// Проверка SQL «Документов» на настоящей схеме ПОСЛЕ миграции: каждая функция store.js
// выполняется в ОДНОЙ транзакции, в конце — ROLLBACK (в БД ничего не остаётся).
// Юнит-тесты подменяют db и SQL не проверяют — этот скрипт ловит опечатки в SQL, типы
// параметров и to_char дат. Только дев-БД (loyalpro_test), если не передан --allow-any-db.
// node scripts/edocs-store-smoke.js                  — после миграции (таблицы уже есть)
// node scripts/edocs-store-smoke.js --create-tables  — до миграции: таблицы «Документов» из
//   migrations.js создаются в той же транзакции БЕЗ внешних ключей (чтобы не брать блокировки
//   на clients/records/users) и исчезают вместе с ROLLBACK.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const assert = require('assert/strict');

const REF_RE = /REFERENCES\s+\w+\(\w+\)(\s+ON\s+DELETE\s+(CASCADE|RESTRICT|SET\s+NULL))?/g;
/** CREATE-операторы «Документов» из migrations.js (таблицы и индексы), без REFERENCES. */
function edocsDdl() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'migrations.js'), 'utf8');
  return [...src.matchAll(/client\.query\(`([\s\S]*?)`\)/g)].map((m) => m[1])
    .filter((sql) => /CREATE (TABLE|UNIQUE INDEX|INDEX) IF NOT EXISTS (edoc_|client_identity|idx_edoc_|idx_client_identity)/.test(sql))
    .map((sql) => sql.replace(REF_RE, ''));
}

async function run(client, { salonId = 1 } = {}) {
  const fakeDb = {
    query: (sql, p) => client.query(sql, p),
    one: async (sql, p) => (await client.query(sql, p)).rows[0] || null,
    oneOrNone: async (sql, p) => (await client.query(sql, p)).rows[0] || null,
    many: async (sql, p) => (await client.query(sql, p)).rows,
    any: async (sql, p) => (await client.query(sql, p)).rows,
  };
  let sp = 0;
  const withTransaction = async (fn) => {
    const name = `edocs_sp${++sp}`;
    await client.query(`SAVEPOINT ${name}`);
    try { const r = await fn(client); await client.query(`RELEASE SAVEPOINT ${name}`); return r; } catch (e) { await client.query(`ROLLBACK TO SAVEPOINT ${name}`); throw e; }
  };
  const dbPath = require.resolve('../db');
  const real = require.cache[dbPath] ? require.cache[dbPath].exports : {};
  require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: { ...real, db: fakeDb, withTransaction } };
  delete require.cache[require.resolve('../services/edocs/store')];
  const store = require('../services/edocs/store');
  const ok = (label, cond, extra) => { assert.ok(cond, `${label}: ${JSON.stringify(extra)}`); console.log(`ok  ${label}`); };

  const c = (await client.query('SELECT id FROM clients WHERE salon_id=$1 ORDER BY last_visit_at DESC NULLS LAST LIMIT 1', [salonId])).rows[0];
  const u = (await client.query("SELECT id FROM users WHERE salon_id=$1 AND role IN ('owner','admin') ORDER BY id LIMIT 1", [salonId])).rows[0];
  const rec = (await client.query("SELECT id, client_id FROM records WHERE salon_id=$1 AND raw_payload->>'attendance'='1' AND client_id IS NOT NULL ORDER BY visit_datetime DESC LIMIT 1", [salonId])).rows[0];
  assert.ok(c && u && rec, 'нет клиента, пользователя или состоявшейся записи в салоне');

  const secret = crypto.randomBytes(24).toString('hex');
  await store.saveSettings(salonId, { enabled: true, base_url: 'https://demo.fdoc.ru', api_key_enc: 'v1:a:b:c', app_login: 'app', requisites: { city: 'Москва' }, webhook_secret: secret });
  await store.saveSettings(salonId, { corp_id: 'C1' });
  const st = await store.getSettings(salonId);
  ok('settings upsert + частичное обновление', st.enabled === true && st.corp_id === 'C1' && st.requisites.city === 'Москва', st);
  ok('findSalonByWebhookSecret', (await store.findSalonByWebhookSecret(secret)) === salonId);
  await store.touchWebhook(salonId);

  await store.saveCredentials(salonId, u.id, 'smoke', 'v1:x:y:z');
  await store.markCredentialsFail(u.id, 'bad');
  ok('credentials + счётчик отказов', (await store.getCredentials(salonId, u.id)).fail_count === 1);
  ok('pickCredentials', (await store.pickCredentials(salonId, u.id)).user_id === u.id);
  await store.markCredentialsOk(u.id);
  ok('listUsersWithCredentials', (await store.listUsersWithCredentials(salonId)).some((x) => x.login === 'smoke'));

  const tId = await store.insertTemplate(salonId, { kind: 'contract', title: 'Smoke договор', file_key: 'smoke/k1', file_size: 1, placeholders: ['fio'], created_by: u.id });
  const aId = await store.insertTemplate(salonId, { kind: 'act', title: 'Smoke акт', file_key: 'smoke/k2', file_size: 1, placeholders: ['services'] });
  ok('templates list/byIds', (await store.getTemplatesByIds(salonId, [tId, aId])).length === 2 && (await store.listTemplates(salonId, { activeOnly: true })).length >= 2);
  ok('updateTemplateMeta', await store.updateTemplateMeta(salonId, tId, { title: 'Smoke 2', kind: 'contract', is_active: true, sort_order: 1 }));
  ok('replaceTemplateFile → прежний ключ', (await store.replaceTemplateFile(salonId, tId, { file_key: 'smoke/k3', file_size: 2, placeholders: ['fio'] })) === 'smoke/k1');

  ok('searchClients', Array.isArray(await store.searchClients(salonId, 'а')));
  const cl = await store.getClient(salonId, c.id);
  ok('getClient: дата рождения строкой', cl && (cl.birthday_iso === null || /^\d{4}-\d{2}-\d{2}$/.test(cl.birthday_iso)), cl && cl.birthday_iso);
  await store.getLatestCertRequest(salonId, c.id);
  await store.upsertIdentity(salonId, c.id, { plain: { last_name: 'Смоук', first_name: 'Тест', middle_name: '', birth_date: '1990-01-15', gender: 'F', phone: '79000000000', email: null, contract_no: '1', contract_date: '2026-10-24' },
    secure_enc: 'v1:a:b:c', secure_fields: ['passport_series'], source: 'manual', userId: u.id });
  const idr = await store.getIdentityRow(salonId, c.id);
  ok('identity: даты строками, поля паспорта', idr.birth_date === '1990-01-15' && idr.contract_date === '2026-10-24' && idr.secure_fields[0] === 'passport_series', idr);

  const r1 = await store.getRecord(salonId, rec.id);
  ok('getRecord', r1 && r1.attendance === '1' && /^\d{4}-\d{2}-\d{2}$/.test(r1.visit_date) && Array.isArray(r1.services), r1 && r1.visit_date);

  const pkgId = crypto.randomUUID(), d1 = crypto.randomUUID();
  await store.insertPackage({ id: pkgId, salon_id: salonId, client_id: rec.client_id, record_id: rec.id, kind: 'act', title: 'Smoke акт', payload: { templateIds: [aId] }, sent_by: u.id },
    [{ id: d1, template_id: aId, title: 'Smoke акт', file_name: 'Smoke.docx', sort_order: 0 }]);
  ok('deleteTemplate занятого → busy', (await store.deleteTemplate(salonId, aId)) === 'busy');
  await store.markSendError(salonId, pkgId, 'smoke error');
  await store.markSent(salonId, pkgId, { employeeUrl: 'https://demo.fdoc.ru/x', userId: u.id });
  let pk = await store.getPackage(salonId, pkgId);
  ok('markSent', pk.status === 'sent' && pk.employee_url === 'https://demo.fdoc.ru/x' && pk.last_error === null, pk);
  ok('actStatusesForRecords', (await store.actStatusesForRecords(salonId, [rec.id])).some((x) => x.package_id === pkgId));
  ok('listClientVisits со статусом акта', (await store.listClientVisits(salonId, rec.client_id)).some((x) => x.act_package_id === pkgId));
  await store.applyStatus(salonId, pkgId, { package: { status: 'signed', fdoc_status: 'SIGNED', fdoc_package_guid: null, signed_at: '2026-10-24T07:05:00.000Z' },
    documents: [{ id: d1, fdoc_document_guid: null, fdoc_status: 'SIGNED', client_signed_at: '2026-10-24T07:05:00.000Z', corp_signed_at: null }] });
  pk = await store.getPackage(salonId, pkgId);
  ok('applyStatus', pk.status === 'signed' && !!pk.signed_at && !!pk.last_status_check_at, pk);
  await client.query("UPDATE edoc_packages SET last_status_check_at = NOW() - INTERVAL '2 days' WHERE id=$1", [pkgId]);
  ok('listDuePackages видит подписанный без PDF', (await store.listDuePackages(500)).some((x) => x.id === pkgId));
  await store.setDocumentPdf(d1, 'smoke/x.pdf');
  ok('getDocument', (await store.getDocument(salonId, d1)).pdf_key === 'smoke/x.pdf');
  ok('findPackageByAnyId', !!(await store.findPackageByAnyId(salonId, pkgId)));
  ok('listPackages', (await store.listPackages(salonId, { status: 'signed', from: '2020-01-01', to: '2099-12-31' })).rows.some((x) => x.id === pkgId));
  ok('listClientPackages', (await store.listClientPackages(salonId, rec.client_id)).some((x) => x.id === pkgId));
  await store.touchStatusCheck([pkgId]);
  await store.setEmployeeUrl(salonId, pkgId, 'https://demo.fdoc.ru/y');
  await store.logEvent({ salonId, packageId: pkgId, clientId: rec.client_id, kind: 'send', userId: u.id, payload: { documents: 1 } });
  ok('listEvents', (await store.listEvents(salonId, pkgId)).length === 1);
  ok('deleteTemplate после подписи → удалён', (await store.deleteTemplate(salonId, aId)).fileKey === 'smoke/k2');
  await store.deleteCredentials(salonId, u.id);
  ok('deleteCredentials', (await store.getCredentials(salonId, u.id)) === null);
}

async function main() {
  require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
  if (!/loyalpro_test/.test(process.env.DATABASE_URL || '') && !process.argv.includes('--allow-any-db')) {
    console.error('Не дев-БД (нет loyalpro_test в DATABASE_URL) — остановка. Флаг --allow-any-db снимает защиту.');
    process.exit(2);
  }
  const { pool } = require('../db');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL lock_timeout = '5s'");
    if (process.argv.includes('--create-tables')) {
      const ddl = edocsDdl();
      assert.ok(ddl.length >= 14, `в migrations.js не нашлись таблицы «Документов» (${ddl.length})`);
      for (const sql of ddl) await client.query(sql);
      console.log(`таблицы созданы во временной транзакции: ${ddl.length} операторов`);
    }
    await run(client);
    console.log('SQL «Документов» в порядке (транзакция откатывается)');
  } finally {
    await client.query('ROLLBACK').catch(() => {});
    client.release();
    await pool.end();
  }
}

if (require.main === module) main().catch((e) => { console.error(`ОШИБКА: ${e.message}`); process.exit(1); });
module.exports = { run, edocsDdl };
```

- [ ] **Step 2: Убедиться, что проверка падает**

```bash
cd /root/loyalpro-fdoc/backend && node scripts/edocs-store-smoke.js --create-tables
```

Ожидается: `ОШИБКА: Cannot find module '../services/edocs/store'` (после строки «таблицы созданы во временной транзакции: 16 операторов»).

- [ ] **Step 3: Реализация**

Создать `backend/services/edocs/store.js`:

```js
'use strict';
// SQL модуля «Документы». Каждый запрос ограничен salon_id (правило мультисалона);
// без salon_id — только кросс-салонные выборки фонового опроса и поиск салона по
// секрету вебхука. DATE-колонки читаются через to_char: pg отдаёт DATE полуночью
// по Москве, и toISOString() дал бы вчерашний день (готча из CLAUDE.md).
const { db, withTransaction } = require('../../db');
const { createLogger } = require('../../logger');

const logger = createLogger('EdocsStore');

// ── настройки салона ────────────────────────────────────────────────────────
const SETTINGS_COLS = ['enabled', 'base_url', 'api_key_enc', 'app_login', 'app_password_enc', 'app_code', 'corp_id',
  'qes_cert_alias', 'employee_position', 'requisites', 'unsign_days', 'webhook_secret'];

async function getSettings(salonId) {
  return db.oneOrNone('SELECT * FROM edoc_settings WHERE salon_id=$1', [salonId]);
}
/** UPSERT только переданных колонок из белого списка. */
async function saveSettings(salonId, patch) {
  const cols = Object.keys(patch || {}).filter((k) => SETTINGS_COLS.includes(k));
  if (!cols.length) return;
  const vals = cols.map((k) => (k === 'requisites' ? JSON.stringify(patch[k] || {}) : patch[k]));
  const names = ['salon_id', ...cols];
  const sets = cols.map((c) => `${c}=EXCLUDED.${c}`).concat('updated_at=NOW()');
  await db.query(
    `INSERT INTO edoc_settings (${names.join(', ')}) VALUES (${names.map((_, i) => `$${i + 1}`).join(', ')})
     ON CONFLICT (salon_id) DO UPDATE SET ${sets.join(', ')}`,
    [salonId, ...vals],
  );
}
async function findSalonByWebhookSecret(secret) {
  const r = await db.oneOrNone('SELECT salon_id FROM edoc_settings WHERE webhook_secret=$1 AND enabled', [secret]);
  return r ? r.salon_id : null;
}
async function touchWebhook(salonId) {
  await db.query('UPDATE edoc_settings SET last_webhook_at=NOW() WHERE salon_id=$1', [salonId]);
}

// ── учётные данные F.Doc сотрудников ───────────────────────────────────────
async function getCredentials(salonId, userId) {
  return db.oneOrNone('SELECT * FROM edoc_user_credentials WHERE user_id=$1 AND salon_id=$2', [userId, salonId]);
}
async function saveCredentials(salonId, userId, login, passwordEnc) {
  await db.query(
    `INSERT INTO edoc_user_credentials (user_id, salon_id, login, password_enc, fail_count, last_ok_at)
     VALUES ($1, $2, $3, $4, 0, NOW())
     ON CONFLICT (user_id) DO UPDATE SET salon_id=EXCLUDED.salon_id, login=EXCLUDED.login, password_enc=EXCLUDED.password_enc,
       fail_count=0, last_ok_at=NOW(), last_error=NULL, updated_at=NOW()`,
    [userId, salonId, login, passwordEnc],
  );
}
async function deleteCredentials(salonId, userId) {
  await db.query('DELETE FROM edoc_user_credentials WHERE user_id=$1 AND salon_id=$2', [userId, salonId]);
}
async function markCredentialsOk(userId) {
  await db.query('UPDATE edoc_user_credentials SET fail_count=0, last_ok_at=NOW(), last_error=NULL, updated_at=NOW() WHERE user_id=$1', [userId]);
}
async function markCredentialsFail(userId, error) {
  await db.query('UPDATE edoc_user_credentials SET fail_count=fail_count+1, last_error=$2, updated_at=NOW() WHERE user_id=$1', [userId, String(error || '').slice(0, 300)]);
}
/** Рабочие учётные данные салона: сначала preferUserId, иначе последние удачные. */
async function pickCredentials(salonId, preferUserId) {
  return db.oneOrNone(
    `SELECT * FROM edoc_user_credentials WHERE salon_id=$1 AND fail_count < 3
     ORDER BY (user_id = $2) DESC, last_ok_at DESC NULLS LAST LIMIT 1`,
    [salonId, preferUserId || 0],
  );
}
async function listUsersWithCredentials(salonId) {
  return db.any(
    `SELECT u.id, u.name, u.email, u.role, u.is_active, c.login, c.last_ok_at, c.last_error, c.fail_count
     FROM users u LEFT JOIN edoc_user_credentials c ON c.user_id=u.id AND c.salon_id=u.salon_id
     WHERE u.salon_id=$1 AND u.role IN ('owner', 'admin', 'admin_cashier')
     ORDER BY u.is_active DESC, u.name`,
    [salonId],
  );
}

// ── шаблоны ────────────────────────────────────────────────────────────────
async function listTemplates(salonId, { activeOnly = false } = {}) {
  return db.any(
    `SELECT id, kind, title, file_size, placeholders, is_active, sort_order, created_at, updated_at
     FROM edoc_templates WHERE salon_id=$1 ${activeOnly ? 'AND is_active' : ''} ORDER BY sort_order, id`,
    [salonId],
  );
}
async function getTemplate(salonId, id) {
  return db.oneOrNone('SELECT * FROM edoc_templates WHERE salon_id=$1 AND id=$2', [salonId, id]);
}
async function getTemplatesByIds(salonId, ids) {
  return db.any('SELECT * FROM edoc_templates WHERE salon_id=$1 AND id = ANY($2::int[]) ORDER BY sort_order, id', [salonId, ids]);
}
async function insertTemplate(salonId, t) {
  const r = await db.oneOrNone(
    `INSERT INTO edoc_templates (salon_id, kind, title, file_key, file_size, placeholders, sort_order, created_by)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8) RETURNING id`,
    [salonId, t.kind, t.title, t.file_key, t.file_size, JSON.stringify(t.placeholders || []), t.sort_order || 0, t.created_by || null],
  );
  return r && r.id;
}
async function updateTemplateMeta(salonId, id, t) {
  const r = await db.oneOrNone(
    `UPDATE edoc_templates SET title=$3, kind=$4, is_active=$5, sort_order=$6, updated_at=NOW()
     WHERE salon_id=$1 AND id=$2 RETURNING id`,
    [salonId, id, t.title, t.kind, t.is_active, t.sort_order],
  );
  return !!r;
}
/** Замена файла шаблона; возвращает прежний ключ S3 (удаляет вызывающий) или null. */
async function replaceTemplateFile(salonId, id, t) {
  return withTransaction(async (c) => {
    const old = (await c.query('SELECT file_key FROM edoc_templates WHERE salon_id=$1 AND id=$2 FOR UPDATE', [salonId, id])).rows[0];
    if (!old) return null;
    await c.query(
      `UPDATE edoc_templates SET file_key=$3, file_size=$4, placeholders=$5::jsonb, updated_at=NOW() WHERE salon_id=$1 AND id=$2`,
      [salonId, id, t.file_key, t.file_size, JSON.stringify(t.placeholders || [])],
    );
    return old.file_key;
  });
}
/** 'busy' — шаблон в неотправленном/неподписанном комплекте; 'missing'; иначе { fileKey }. */
async function deleteTemplate(salonId, id) {
  return withTransaction(async (c) => {
    const busy = (await c.query(
      `SELECT 1 FROM edoc_documents d JOIN edoc_packages p ON p.id=d.package_id
       WHERE p.salon_id=$1 AND d.template_id=$2 AND p.status IN ('draft', 'sent', 'error') LIMIT 1`,
      [salonId, id],
    )).rows[0];
    if (busy) return 'busy';
    const r = (await c.query('DELETE FROM edoc_templates WHERE salon_id=$1 AND id=$2 RETURNING file_key', [salonId, id])).rows[0];
    return r ? { fileKey: r.file_key } : 'missing';
  });
}

// ── пациенты ───────────────────────────────────────────────────────────────
async function searchClients(salonId, q, limit = 20) {
  const s = String(q || '').trim();
  const digits = s.replace(/\D/g, '');
  const cols = `SELECT c.id, c.name, c.phone, (ci.client_id IS NOT NULL) AS has_identity
    FROM clients c LEFT JOIN client_identity ci ON ci.client_id=c.id AND ci.salon_id=c.salon_id WHERE c.salon_id=$1`;
  if (digits.length >= 4) {
    return db.any(`${cols} AND regexp_replace(COALESCE(c.phone, ''), '\\D', '', 'g') LIKE $2
      ORDER BY c.last_visit_at DESC NULLS LAST, c.id DESC LIMIT $3`, [salonId, `%${digits.slice(-10)}%`, limit]);
  }
  const like = `%${s.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
  return db.any(`${cols} AND c.name ILIKE $2 ORDER BY c.last_visit_at DESC NULLS LAST, c.id DESC LIMIT $3`, [salonId, like, limit]);
}
async function getClient(salonId, id) {
  return db.oneOrNone(
    `SELECT id, name, phone, email, yclients_client_id, yclients_data, to_char(birthday, 'YYYY-MM-DD') AS birthday_iso
     FROM clients WHERE salon_id=$1 AND id=$2`,
    [salonId, id],
  );
}
/** Последняя заявка на справку, сопоставленная с пациентом (для паспорта в предзаполнении). */
async function getLatestCertRequest(salonId, clientId) {
  return db.oneOrNone(
    `SELECT payer_is_patient, payer_doc_type_code, payer_doc_serie_number,
            to_char(payer_doc_issue_date, 'YYYY-MM-DD') AS payer_doc_issue_date_iso,
            to_char(payer_birthdate, 'YYYY-MM-DD') AS payer_birthdate_iso,
            patient_doc_type_code, patient_doc_serie_number,
            to_char(patient_doc_issue_date, 'YYYY-MM-DD') AS patient_doc_issue_date_iso,
            to_char(patient_birthdate, 'YYYY-MM-DD') AS patient_birthdate_iso,
            to_char(created_at AT TIME ZONE 'Europe/Moscow', 'DD.MM.YYYY') AS created_date
     FROM cert_requests WHERE salon_id=$1 AND matched_client_id=$2 ORDER BY created_at DESC LIMIT 1`,
    [salonId, clientId],
  );
}
async function getIdentityRow(salonId, clientId) {
  return db.oneOrNone(
    `SELECT client_id, salon_id, last_name, first_name, middle_name, to_char(birth_date, 'YYYY-MM-DD') AS birth_date,
            gender, phone, email, contract_no, to_char(contract_date, 'YYYY-MM-DD') AS contract_date,
            secure_enc, secure_fields, source, updated_by, updated_at
     FROM client_identity WHERE salon_id=$1 AND client_id=$2`,
    [salonId, clientId],
  );
}
async function upsertIdentity(salonId, clientId, v) {
  const p = v.plain;
  await db.query(
    `INSERT INTO client_identity (client_id, salon_id, last_name, first_name, middle_name, birth_date, gender, phone, email,
       contract_no, contract_date, secure_enc, secure_fields, source, updated_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb, $14, $15)
     ON CONFLICT (client_id) DO UPDATE SET last_name=EXCLUDED.last_name, first_name=EXCLUDED.first_name,
       middle_name=EXCLUDED.middle_name, birth_date=EXCLUDED.birth_date, gender=EXCLUDED.gender, phone=EXCLUDED.phone,
       email=EXCLUDED.email, contract_no=EXCLUDED.contract_no, contract_date=EXCLUDED.contract_date,
       secure_enc=EXCLUDED.secure_enc, secure_fields=EXCLUDED.secure_fields, source=EXCLUDED.source,
       updated_by=EXCLUDED.updated_by, updated_at=NOW()
     WHERE client_identity.salon_id = EXCLUDED.salon_id`,
    [clientId, salonId, p.last_name || null, p.first_name || null, p.middle_name || null, p.birth_date, p.gender, p.phone, p.email,
      p.contract_no, p.contract_date, v.secure_enc, JSON.stringify(v.secure_fields || []), v.source || 'manual', v.userId || null],
  );
}

// ── записи YClients (для акта) ─────────────────────────────────────────────
const RECORD_COLS = `r.id, r.client_id, r.yclients_record_id, r.services, r.staff, r.amount,
  to_char(COALESCE((r.visit_datetime AT TIME ZONE 'Europe/Moscow')::date, r.visit_date), 'YYYY-MM-DD') AS visit_date,
  (r.raw_payload->>'attendance') AS attendance,
  (COALESCE(r.status, '') = 'deleted' OR COALESCE((r.raw_payload->>'deleted')::boolean, false)) AS deleted`;
async function getRecord(salonId, recordId) {
  return db.oneOrNone(`SELECT ${RECORD_COLS} FROM records r WHERE r.salon_id=$1 AND r.id=$2`, [salonId, recordId]);
}
/** Последние состоявшиеся визиты пациента и статус последнего акта по каждому. */
async function listClientVisits(salonId, clientId, limit = 20) {
  return db.any(
    `SELECT ${RECORD_COLS}, a.id AS act_package_id, a.status AS act_status
     FROM records r
     LEFT JOIN LATERAL (SELECT p.id, p.status FROM edoc_packages p
       WHERE p.salon_id=r.salon_id AND p.record_id=r.id AND p.kind='act' ORDER BY p.created_at DESC LIMIT 1) a ON true
     WHERE r.salon_id=$1 AND r.client_id=$2 AND (r.raw_payload->>'attendance')='1'
       AND COALESCE(r.status, '') <> 'deleted' AND NOT COALESCE((r.raw_payload->>'deleted')::boolean, false)
     ORDER BY r.visit_datetime DESC NULLS LAST, r.id DESC LIMIT $3`,
    [salonId, clientId, limit],
  );
}
/** Статус последнего акта по каждой записи из списка (страница «Записи»). */
async function actStatusesForRecords(salonId, recordIds) {
  return db.any(
    `SELECT DISTINCT ON (record_id) record_id, id AS package_id, status
     FROM edoc_packages WHERE salon_id=$1 AND kind='act' AND record_id = ANY($2::int[])
     ORDER BY record_id, created_at DESC`,
    [salonId, recordIds],
  );
}

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
    }
  });
}
async function markSent(salonId, id, { employeeUrl = null, userId = null } = {}) {
  await db.query(
    `UPDATE edoc_packages SET status='sent', sent_at=NOW(), sent_by=COALESCE($3, sent_by), last_error=NULL,
       employee_url=COALESCE($4, employee_url), employee_url_at=CASE WHEN $4::text IS NULL THEN employee_url_at ELSE NOW() END,
       updated_at=NOW()
     WHERE salon_id=$1 AND id=$2`,
    [salonId, id, userId, employeeUrl],
  );
}
async function markSendError(salonId, id, error) {
  await db.query('UPDATE edoc_packages SET last_error=$3, updated_at=NOW() WHERE salon_id=$1 AND id=$2', [salonId, id, String(error || '').slice(0, 500)]);
}
async function setEmployeeUrl(salonId, id, url) {
  await db.query('UPDATE edoc_packages SET employee_url=$3, employee_url_at=NOW() WHERE salon_id=$1 AND id=$2', [salonId, id, url]);
}
/** Применить statuses.applyWorkflow(): комплект и его документы одной транзакцией. */
async function applyStatus(salonId, id, upd) {
  await withTransaction(async (c) => {
    const p = upd.package;
    await c.query(
      `UPDATE edoc_packages SET status=$3, fdoc_status=$4, fdoc_package_guid=COALESCE($5, fdoc_package_guid),
         signed_at=COALESCE(signed_at, $6::timestamptz), last_status_check_at=NOW(), updated_at=NOW()
       WHERE salon_id=$1 AND id=$2`,
      [salonId, id, p.status, p.fdoc_status, p.fdoc_package_guid, p.signed_at],
    );
    for (const d of upd.documents || []) {
      await c.query(
        `UPDATE edoc_documents SET fdoc_document_guid=COALESCE($3, fdoc_document_guid), fdoc_status=$4,
           client_signed_at=COALESCE($5::timestamptz, client_signed_at), corp_signed_at=COALESCE($6::timestamptz, corp_signed_at),
           updated_at=NOW()
         WHERE package_id=$1 AND id=$2`,
        [id, d.id, d.fdoc_document_guid, d.fdoc_status, d.client_signed_at, d.corp_signed_at],
      );
    }
  });
}
async function touchStatusCheck(ids) {
  if (!ids.length) return;
  await db.query('UPDATE edoc_packages SET last_status_check_at=NOW() WHERE id = ANY($1::uuid[])', [ids]);
}
const PACKAGE_SELECT = `SELECT p.*, c.name AS client_name, c.phone AS client_phone, u.name AS sent_by_name
  FROM edoc_packages p JOIN clients c ON c.id=p.client_id LEFT JOIN users u ON u.id=p.sent_by`;
async function getPackage(salonId, id) {
  return db.oneOrNone(`${PACKAGE_SELECT} WHERE p.salon_id=$1 AND p.id=$2`, [salonId, id]);
}
async function findPackageByAnyId(salonId, anyId) {
  return db.oneOrNone('SELECT * FROM edoc_packages WHERE salon_id=$1 AND (id::text=$2 OR fdoc_package_guid=$2) LIMIT 1', [salonId, anyId]);
}
async function listDocuments(packageId) {
  return db.any('SELECT * FROM edoc_documents WHERE package_id=$1 ORDER BY sort_order, created_at', [packageId]);
}
async function getDocument(salonId, id) {
  return db.oneOrNone(
    `SELECT d.*, p.status AS package_status, p.client_id FROM edoc_documents d JOIN edoc_packages p ON p.id=d.package_id
     WHERE d.salon_id=$1 AND d.id=$2`,
    [salonId, id],
  );
}
async function setDocumentPdf(docId, key) {
  await db.query('UPDATE edoc_documents SET pdf_key=$2, pdf_fetched_at=NOW(), updated_at=NOW() WHERE id=$1', [docId, key]);
}
/** Список комплектов салона с фильтрами; from/to — даты создания по Москве. */
async function listPackages(salonId, { status = null, clientId = null, from = null, to = null, limit = 50, offset = 0 } = {}) {
  const where = ['p.salon_id=$1']; const params = [salonId];
  const add = (sql, v) => { params.push(v); where.push(sql.replace('?', `$${params.length}`)); };
  if (status) add('p.status=?', status);
  if (clientId) add('p.client_id=?', clientId);
  if (from) add(`(p.created_at AT TIME ZONE 'Europe/Moscow')::date >= ?::date`, from);
  if (to) add(`(p.created_at AT TIME ZONE 'Europe/Moscow')::date <= ?::date`, to);
  const w = where.join(' AND ');
  const total = Number((await db.oneOrNone(`SELECT COUNT(*) AS n FROM edoc_packages p WHERE ${w}`, params)).n);
  const rows = await db.any(
    `${PACKAGE_SELECT} WHERE ${w} ORDER BY p.created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, limit, offset],
  );
  return { total, rows };
}
async function listClientPackages(salonId, clientId, limit = 20) {
  return db.any(
    `SELECT p.id, p.kind, p.title, p.status, p.record_id, p.created_at, p.sent_at, p.signed_at, p.last_error
     FROM edoc_packages p WHERE p.salon_id=$1 AND p.client_id=$2 ORDER BY p.created_at DESC LIMIT $3`,
    [salonId, clientId, limit],
  );
}
// Кого опросить фоном: незавершённые — каждые 5 минут первые 60 дней, дальше раз в сутки;
// подписанные — раз в сутки 30 дней (подписанный ещё может стать «аннулирован»);
// подписанные без PDF — каждые 5 минут, пока PDF не скачаны.
const DUE_SQL = `
  SELECT p.* FROM edoc_packages p JOIN edoc_settings s ON s.salon_id=p.salon_id AND s.enabled
  WHERE (p.status IN ('sent', 'error') AND p.created_at > NOW() - INTERVAL '60 days'
          AND (p.last_status_check_at IS NULL OR p.last_status_check_at < NOW() - INTERVAL '5 minutes'))
     OR (p.status IN ('sent', 'error') AND p.created_at <= NOW() - INTERVAL '60 days'
          AND (p.last_status_check_at IS NULL OR p.last_status_check_at < NOW() - INTERVAL '1 day'))
     OR (p.status = 'signed' AND p.signed_at > NOW() - INTERVAL '30 days'
          AND (p.last_status_check_at IS NULL OR p.last_status_check_at < NOW() - INTERVAL '1 day'))
     OR (p.status = 'signed' AND EXISTS (SELECT 1 FROM edoc_documents d WHERE d.package_id=p.id AND d.pdf_key IS NULL)
          AND (p.last_status_check_at IS NULL OR p.last_status_check_at < NOW() - INTERVAL '5 minutes'))
  ORDER BY p.last_status_check_at NULLS FIRST, p.created_at
  LIMIT $1`;
async function listDuePackages(limit = 200) {
  return db.any(DUE_SQL, [limit]);
}

// ── журнал ─────────────────────────────────────────────────────────────────
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Запись журнала — best-effort: сбой журнала не должен ронять отправку или вебхук. */
async function logEvent({ salonId, packageId = null, clientId = null, kind, userId = null, payload = {} }) {
  try {
    await db.query(
      `INSERT INTO edoc_events (salon_id, package_id, client_id, kind, user_id, payload) VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
      [salonId, packageId && UUID_RE.test(packageId) ? packageId : null, clientId, kind, userId, JSON.stringify(payload || {})],
    );
  } catch (e) { logger.warn(`edoc_events ${kind}: ${e.message}`); }
}
async function listEvents(salonId, packageId, limit = 30) {
  return db.any(
    `SELECT e.id, e.kind, e.payload, e.created_at, u.name AS user_name FROM edoc_events e LEFT JOIN users u ON u.id=e.user_id
     WHERE e.salon_id=$1 AND e.package_id=$2 ORDER BY e.created_at DESC LIMIT $3`,
    [salonId, packageId, limit],
  );
}

module.exports = {
  getSettings, saveSettings, findSalonByWebhookSecret, touchWebhook,
  getCredentials, saveCredentials, deleteCredentials, markCredentialsOk, markCredentialsFail, pickCredentials, listUsersWithCredentials,
  listTemplates, getTemplate, getTemplatesByIds, insertTemplate, updateTemplateMeta, replaceTemplateFile, deleteTemplate,
  searchClients, getClient, getLatestCertRequest, getIdentityRow, upsertIdentity,
  getRecord, listClientVisits, actStatusesForRecords,
  insertPackage, markSent, markSendError, setEmployeeUrl, applyStatus, touchStatusCheck, getPackage, findPackageByAnyId,
  listDocuments, getDocument, setDocumentPdf, listPackages, listClientPackages, listDuePackages, DUE_SQL,
  logEvent, listEvents, UUID_RE,
};
```

- [ ] **Step 4: Проверка проходит, в БД ничего не осталось**

```bash
cd /root/loyalpro-fdoc/backend && node scripts/edocs-store-smoke.js --create-tables 2>&1 | tail -3
```

Ожидается: 25 строк `ok …`, последняя — «SQL «Документов» в порядке (транзакция откатывается)». Таблицы `edoc_*` в дев-БД НЕ появились (через MCP postgres: `SELECT to_regclass('edoc_packages')` → `null`).

- [ ] **Step 5: Commit**

```bash
cd /root/loyalpro-fdoc && git add backend/services/edocs/store.js backend/scripts/edocs-store-smoke.js && git commit -m "feat(edocs): SQL слоя данных и живая проверка в откатываемой транзакции

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: Оркестрация комплектов — **Opus**

`send`: настройки и учётка сотрудника → пациент, шаблоны (1–10, активные), для акта — состоявшийся визит этого пациента → полнота данных (`missingFor`, иначе 400 со списком и ничего не создаётся) → DOCX из шаблонов S3 → строки `edoc_packages`/`edoc_documents` (`draft`) → `withSigners` → `sent` + журнал → сразу перечитать статус (автоподпись клиники могла сдвинуть его). Отказ F.Doc — черновик с `last_error`, 502 с `packageId`; неверный пароль — счётчик отказов и 409. `resend` сначала спрашивает F.Doc, нет ли уже такого комплекта (ответ мог потеряться), и только потом отправляет заново с ТЕМИ ЖЕ id. `refreshRows` опрашивает пачками по 10 под учёткой отправителя (иначе — любой рабочей в салоне), пишет смену статуса в журнал и докачивает PDF подписанных в S3. Демо-стенд (`demo.*`) шлёт настоящие SMS, а в дев-БД живые пациенты — `assertDemoPhone` пропускает только `EDOCS_DEMO_PHONES`. Тело запроса и имена файлов вынесены в чистый `send-body.js` (его же использует скрипт демо-стенда без БД).

**Files:**
- Create: `backend/services/edocs/send-body.js`, `backend/services/edocs/packages.js`
- Test: `backend/edocs-packages.test.js`

- [ ] **Step 1: Написать падающий тест**

Создать `backend/edocs-packages.test.js`:

```js
'use strict';
jest.mock('./services/edocs/store', () => ({
  getSettings: jest.fn(), getCredentials: jest.fn(), pickCredentials: jest.fn(), markCredentialsOk: jest.fn(), markCredentialsFail: jest.fn(),
  getClient: jest.fn(), getTemplatesByIds: jest.fn(), getRecord: jest.fn(), getIdentityRow: jest.fn(),
  insertPackage: jest.fn(), markSent: jest.fn(), markSendError: jest.fn(), logEvent: jest.fn(), getPackage: jest.fn(),
  listDocuments: jest.fn(), applyStatus: jest.fn(), touchStatusCheck: jest.fn(), setDocumentPdf: jest.fn(), setEmployeeUrl: jest.fn(),
  listDuePackages: jest.fn(),
}));
jest.mock('./services/s3', () => ({ getObjectBuffer: jest.fn(), putObject: jest.fn() }));
jest.mock('./services/fdoc/client', () => ({
  client: { sendPackage: jest.fn(), workflowStatuses: jest.fn(), downloadPdf: jest.fn(), employeeUrl: jest.fn(), sendPermalink: jest.fn(), declinePackage: jest.fn() },
}));
jest.mock('./utils/secret-box', () => ({
  box: () => ({ decrypt: (x) => String(x).replace(/^enc:/, ''), decryptJson: (x) => JSON.parse(String(x).replace(/^enc:/, '')) }),
}));
jest.mock('./logger', () => ({ createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }) }));
jest.mock('./config', () => ({ EDOCS_DEMO_PHONES: ['79200255591'] }));

const store = require('./services/edocs/store');
const s3 = require('./services/s3');
const { client: fdoc } = require('./services/fdoc/client');
const pk = require('./services/edocs/packages');
const { makeDocx, docText, p, table } = require('./services/edocs/__fixtures__/docx');

const SETTINGS = { salon_id: 1, enabled: true, base_url: 'https://demo.fdoc.ru', api_key_enc: 'enc:KEY', app_login: 'app', app_password_enc: 'enc:APW', app_code: 'crm', corp_id: 'C1', qes_cert_alias: 'peri-qes', employee_position: 'Администратор', unsign_days: 7, requisites: { name: 'ООО «Пери Клиник»', inn: '9724060392', city: 'Москва' } };
const CLIENT = { id: 52, name: 'Иванова Анна Сергеевна', phone: '+79200255591', yclients_data: {} };
const IDENTITY = { client_id: 52, last_name: 'Иванова', first_name: 'Анна', middle_name: 'Сергеевна', birth_date: '1983-03-21', gender: 'F', phone: '79200255591', email: null, contract_no: '1739', contract_date: null,
  secure_enc: 'enc:' + JSON.stringify({ passport_series: '4510', passport_number: '123456' }), secure_fields: ['passport_series', 'passport_number'] };
const T_CONTRACT = { id: 10, kind: 'contract', title: 'Договор', is_active: true, file_key: 'k/contract.docx', placeholders: ['fio', 'passport', 'org_name'] };
const T_ACT = { id: 11, kind: 'act', title: 'Акт', is_active: true, file_key: 'k/act.docx', placeholders: ['fio', 'services', 'total_sum'] };
const RECORD = { id: 30252, client_id: 52, yclients_record_id: 2056697734, attendance: '1', deleted: false, visit_date: '2026-10-23',
  staff: { name: 'Гаджиева Пери', position: { title: 'Врач-косметолог' } },
  services: [{ id: 1, title: 'Чистка', amount: 1, discount: 0, first_cost: 3500, manual_cost: 3500, cost: 3500 }] };
const FILES = {
  'k/contract.docx': makeDocx({ body: p('Договор с {fio}, паспорт {passport}, исполнитель {org_name}') }),
  'k/act.docx': makeDocx({ body: p('Акт: {fio}') + table([['{#services}{title}', '{sum}{/services}']]) + p('Итого {total_sum}') }),
};

beforeEach(() => {
  jest.clearAllMocks();
  store.getSettings.mockResolvedValue(SETTINGS);
  store.getCredentials.mockResolvedValue({ user_id: 4, login: 'ivanova', password_enc: 'enc:pw', fail_count: 0 });
  store.getClient.mockResolvedValue(CLIENT);
  store.getIdentityRow.mockResolvedValue(IDENTITY);
  store.getTemplatesByIds.mockImplementation(async (sid, ids) => [T_CONTRACT, T_ACT].filter((t) => ids.includes(t.id)));
  store.getRecord.mockResolvedValue(RECORD);
  store.getPackage.mockImplementation(async (sid, id) => ({ id, salon_id: 1, client_id: 52, status: 'sent', sent_by: 4, title: 'Документы', payload: {} }));
  store.listDocuments.mockResolvedValue([]);
  s3.getObjectBuffer.mockImplementation(async (key) => FILES[key]);
  fdoc.sendPackage.mockResolvedValue({ url: 'https://demo.fdoc.ru/employee/xyz' });
  fdoc.workflowStatuses.mockResolvedValue({ packages: [], failures: [] });
});

describe('send', () => {
  test('собирает DOCX с данными, вставляет комплект, отправляет с маршрутом «клиника → пациент»', async () => {
    const r = await pk.send({ salonId: 1, userId: 4, clientId: 52, templateIds: [10], docDate: '2026-10-24' });
    expect(r.packageId).toMatch(/^[0-9a-f-]{36}$/);
    const [pkg, docs] = store.insertPackage.mock.calls[0];
    expect(pkg).toMatchObject({ id: r.packageId, salon_id: 1, client_id: 52, record_id: null, kind: 'onboarding', title: 'Документы от 24.10.2026', sent_by: 4 });
    expect(pkg.payload).toEqual({ templateIds: [10], docDate: '2026-10-24', act: null, patient: { fio: 'Иванова Анна Сергеевна', phone: '79200255591' } });
    expect(docs).toEqual([{ id: expect.any(String), template_id: 10, title: 'Договор', file_name: 'Договор.docx', sort_order: 0 }]);
    const [cfg, cred, body] = fdoc.sendPackage.mock.calls[0];
    expect(cfg).toEqual({ baseUrl: 'https://demo.fdoc.ru', apiKey: 'KEY', appLogin: 'app', appPassword: 'APW', appCode: 'crm', corpId: 'C1' });
    expect(cred).toMatchObject({ userId: 4, login: 'ivanova', password: 'pw' });
    expect(body.package).toEqual({ id: r.packageId, name: 'Документы от 24.10.2026', objectId: 'client:52', signers: [
      { type: 'corp', priority: 1, operatorAutoSign: true, qesCertAlias: 'peri-qes', employeePosition: 'Администратор' },
      { type: 'client', priority: 2, id: '52', name: 'Иванова Анна Сергеевна', phone: '+79200255591' },
    ] });
    expect(body.documents[0]).toMatchObject({ id: docs[0].id, name: 'Договор.docx', unsignExpiredDate: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/) });
    expect(docText(Buffer.from(body.documents[0].file, 'base64'))).toBe('Договор с Иванова Анна Сергеевна, паспорт 4510 123456, исполнитель ООО «Пери Клиник»');
    expect(store.markSent).toHaveBeenCalledWith(1, r.packageId, { employeeUrl: 'https://demo.fdoc.ru/employee/xyz', userId: 4 });
    expect(fdoc.workflowStatuses).toHaveBeenCalledWith(expect.anything(), expect.anything(), [r.packageId]);
  });

  test('не хватает данных — 400 со списком, в F.Doc ничего не уходит', async () => {
    store.getIdentityRow.mockResolvedValue({ ...IDENTITY, secure_enc: null, secure_fields: [] });
    await expect(pk.send({ salonId: 1, userId: 4, clientId: 52, templateIds: [10] })).rejects.toMatchObject({
      code: 'missing_fields', status: 400, missing: { identity: [{ key: 'passport_number', label: 'Номер паспорта' }, { key: 'passport_series', label: 'Серия паспорта' }], org: [] },
    });
    expect(store.insertPackage).not.toHaveBeenCalled();
    expect(fdoc.sendPackage).not.toHaveBeenCalled();
  });

  test('модуль выключен, F.Doc не подключён, нет учётки сотрудника — 409', async () => {
    store.getSettings.mockResolvedValueOnce({ ...SETTINGS, enabled: false });
    await expect(pk.send({ salonId: 1, userId: 4, clientId: 52, templateIds: [10] })).rejects.toMatchObject({ code: 'not_enabled', status: 409 });
    store.getSettings.mockResolvedValueOnce({ ...SETTINGS, corp_id: null });
    await expect(pk.send({ salonId: 1, userId: 4, clientId: 52, templateIds: [10] })).rejects.toMatchObject({ code: 'not_configured' });
    store.getCredentials.mockResolvedValueOnce(null);
    await expect(pk.send({ salonId: 1, userId: 4, clientId: 52, templateIds: [10] })).rejects.toMatchObject({ code: 'fdoc_no_credentials', status: 409 });
  });

  test('F.Doc отверг комплект — черновик с ошибкой, 502 с id комплекта', async () => {
    fdoc.sendPackage.mockRejectedValue(Object.assign(new Error('F.Doc POST /x 400: Файл повреждён'), { name: 'FdocError', code: 'fdoc_rejected', status: 400 }));
    const e = await pk.send({ salonId: 1, userId: 4, clientId: 52, templateIds: [10] }).catch((x) => x);
    expect(e).toMatchObject({ code: 'fdoc_send_failed', status: 502, packageId: expect.any(String) });
    expect(store.markSendError).toHaveBeenCalledWith(1, e.packageId, 'F.Doc POST /x 400: Файл повреждён');
    expect(store.markSent).not.toHaveBeenCalled();
    expect(store.logEvent).toHaveBeenCalledWith(expect.objectContaining({ kind: 'send_error' }));
  });

  test('F.Doc не принял пароль сотрудника — счётчик отказов и 409', async () => {
    fdoc.sendPackage.mockRejectedValue(Object.assign(new Error('bad'), { code: 'fdoc_credentials_invalid', status: 401 }));
    await expect(pk.send({ salonId: 1, userId: 4, clientId: 52, templateIds: [10] })).rejects.toMatchObject({ code: 'fdoc_credentials_invalid', status: 409 });
    expect(store.markCredentialsFail).toHaveBeenCalledWith(4, 'bad');
  });

  test('акт: строки из записи, привязка к визиту, номер акта — id записи YClients', async () => {
    const r = await pk.send({ salonId: 1, userId: 4, clientId: 52, templateIds: [11], recordId: 30252, docDate: '2026-10-24' });
    const [pkg] = store.insertPackage.mock.calls[0];
    expect(pkg).toMatchObject({ kind: 'act', record_id: 30252, title: 'Акт от 24.10.2026' });
    expect(pkg.payload.act).toEqual({ act_no: '2056697734', visit_date: '2026-10-23', doctor_name: 'Гаджиева Пери', doctor_position: 'Врач-косметолог',
      lines: [{ service_id: 1, title: 'Чистка', qty: 1, price: 3500, sum: 3500 }] });
    const body = fdoc.sendPackage.mock.calls[0][2];
    expect(docText(Buffer.from(body.documents[0].file, 'base64'))).toBe('Акт: Иванова Анна СергеевнаЧистка3 500,00Итого 3 500,00');
    expect(r.packageId).toBe(pkg.id);
  });

  test('акт по несостоявшемуся визиту — 409; без визита — 400; чужой визит — 404', async () => {
    store.getRecord.mockResolvedValueOnce({ ...RECORD, attendance: '2' });
    await expect(pk.send({ salonId: 1, userId: 4, clientId: 52, templateIds: [11], recordId: 30252 })).rejects.toMatchObject({ code: 'act_visit_not_done', status: 409 });
    await expect(pk.send({ salonId: 1, userId: 4, clientId: 52, templateIds: [11] })).rejects.toMatchObject({ code: 'act_needs_record', status: 400 });
    store.getRecord.mockResolvedValueOnce({ ...RECORD, client_id: 99 });
    await expect(pk.send({ salonId: 1, userId: 4, clientId: 52, templateIds: [11], recordId: 30252 })).rejects.toMatchObject({ status: 404 });
  });

  test('демо-стенд: отправка только на тестовые номера; боевой стенд — без ограничения', async () => {
    store.getIdentityRow.mockResolvedValue({ ...IDENTITY, phone: '79001112233' });
    await expect(pk.send({ salonId: 1, userId: 4, clientId: 52, templateIds: [10] })).rejects.toMatchObject({ code: 'demo_phone_blocked', status: 409 });
    expect(store.insertPackage).not.toHaveBeenCalled();
    store.getSettings.mockResolvedValue({ ...SETTINGS, base_url: 'https://fdoc.ru' });
    await expect(pk.send({ salonId: 1, userId: 4, clientId: 52, templateIds: [10] })).resolves.toMatchObject({ packageId: expect.any(String) });
  });

  test('правленые строки акта проверяются', async () => {
    await expect(pk.send({ salonId: 1, userId: 4, clientId: 52, templateIds: [11], recordId: 30252, actLines: [{ title: '', qty: 1, price: 1, sum: 1 }] }))
      .rejects.toMatchObject({ code: 'bad_act_lines', status: 400 });
  });

  test('выключенный или чужой шаблон, больше 10 документов', async () => {
    store.getTemplatesByIds.mockResolvedValueOnce([{ ...T_CONTRACT, is_active: false }]);
    await expect(pk.send({ salonId: 1, userId: 4, clientId: 52, templateIds: [10] })).rejects.toMatchObject({ code: 'bad_templates' });
    await expect(pk.send({ salonId: 1, userId: 4, clientId: 52, templateIds: [10, 999] })).rejects.toMatchObject({ code: 'bad_templates' });
    await expect(pk.send({ salonId: 1, userId: 4, clientId: 52, templateIds: Array.from({ length: 11 }, (_, i) => i + 1) })).rejects.toMatchObject({ code: 'bad_templates' });
  });
});

describe('resend', () => {
  const DRAFT = { id: '11111111-1111-4111-8111-111111111111', salon_id: 1, client_id: 52, status: 'draft', sent_by: 4, title: 'Документы от 24.10.2026', record_id: null, payload: { templateIds: [10], docDate: '2026-10-24' } };
  test('F.Doc уже знает комплект — отмечаем отправленным без повторной отправки', async () => {
    store.getPackage.mockResolvedValue(DRAFT);
    fdoc.workflowStatuses.mockResolvedValue({ packages: [{ id: DRAFT.id, status: 'WAIT_SIGN', documents: [] }], failures: [] });
    expect(await pk.resend({ salonId: 1, userId: 4, packageId: DRAFT.id })).toEqual({ packageId: DRAFT.id, recovered: true });
    expect(fdoc.sendPackage).not.toHaveBeenCalled();
    expect(store.markSent).toHaveBeenCalledWith(1, DRAFT.id, { userId: 4 });
  });
  test('F.Doc комплекта не знает — повторная отправка с теми же id', async () => {
    store.getPackage.mockResolvedValue(DRAFT);
    store.listDocuments.mockResolvedValue([{ id: 'd-1', template_id: 10, title: 'Договор', file_name: 'Договор.docx', sort_order: 0 }]);
    fdoc.workflowStatuses.mockResolvedValue({ packages: [], failures: [{ id: DRAFT.id, code: 'NOT_FOUND' }] });
    await pk.resend({ salonId: 1, userId: 4, packageId: DRAFT.id });
    const body = fdoc.sendPackage.mock.calls[0][2];
    expect(body.package.id).toBe(DRAFT.id);
    expect(body.documents.map((d) => d.id)).toEqual(['d-1']);
  });
  test('уже отправленный — 409', async () => {
    store.getPackage.mockResolvedValue({ ...DRAFT, status: 'sent' });
    await expect(pk.resend({ salonId: 1, userId: 4, packageId: DRAFT.id })).rejects.toMatchObject({ code: 'already_sent', status: 409 });
  });
});

describe('refreshRows и refreshDue', () => {
  const ROW = { id: '22222222-2222-4222-8222-222222222222', salon_id: 1, client_id: 52, status: 'sent', sent_by: 4, fdoc_package_guid: null };
  test('статус меняется — журнал; подписан — PDF в S3', async () => {
    store.listDocuments.mockResolvedValue([{ id: 'd-1', file_name: 'Договор.docx', title: 'Договор', pdf_key: null }]);
    fdoc.workflowStatuses.mockResolvedValue({ packages: [{ id: ROW.id, status: 'SIGNED', documents: [{ id: 'd-1', status: 'SIGNED', clientSigners: [{ isSigned: true, dateSignOrCancel: '2026-10-24T10:00:00+03:00' }] }] }] });
    store.getPackage.mockResolvedValue({ ...ROW, status: 'signed' });
    fdoc.downloadPdf.mockResolvedValue(Buffer.from('%PDF-1.7'));
    expect(await pk.refreshRows(1, [ROW])).toEqual({ checked: 1, changed: 1 });
    expect(store.applyStatus).toHaveBeenCalledWith(1, ROW.id, expect.objectContaining({ package: expect.objectContaining({ status: 'signed' }) }));
    expect(store.logEvent).toHaveBeenCalledWith(expect.objectContaining({ kind: 'status', payload: { from: 'sent', to: 'signed', fdoc: 'SIGNED' } }));
    expect(fdoc.downloadPdf).toHaveBeenCalledWith(expect.anything(), expect.anything(), ROW.id, 'd-1');
    expect(s3.putObject).toHaveBeenCalledWith(`edocs/1/packages/${ROW.id}/d-1.pdf`, Buffer.from('%PDF-1.7'), 'application/pdf');
    expect(store.setDocumentPdf).toHaveBeenCalledWith('d-1', `edocs/1/packages/${ROW.id}/d-1.pdf`);
    expect(store.touchStatusCheck).toHaveBeenCalledWith([ROW.id]);
  });
  test('учётки отправителя нет — берётся любая рабочая в салоне', async () => {
    store.getCredentials.mockResolvedValue(null);
    store.pickCredentials.mockResolvedValue({ user_id: 9, login: 'admin2', password_enc: 'enc:pw2', fail_count: 0 });
    await pk.refreshRows(1, [ROW]);
    expect(fdoc.workflowStatuses.mock.calls[0][1]).toMatchObject({ userId: 9, login: 'admin2' });
  });
  test('ни одной рабочей учётки — опрос пропущен без исключения', async () => {
    store.getCredentials.mockResolvedValue(null);
    store.pickCredentials.mockResolvedValue(null);
    expect(await pk.refreshRows(1, [ROW])).toEqual({ checked: 0, changed: 0 });
    expect(fdoc.workflowStatuses).not.toHaveBeenCalled();
  });
  test('refreshDue раскладывает по салонам; сбой салона не останавливает остальные', async () => {
    store.listDuePackages.mockResolvedValue([{ ...ROW, salon_id: 1 }, { ...ROW, id: '33333333-3333-4333-8333-333333333333', salon_id: 2 }]);
    store.getSettings.mockImplementation(async (sid) => (sid === 2 ? null : SETTINGS));
    const r = await pk.refreshDue();
    expect(r).toEqual({ checked: 0, changed: 0 });
    expect(store.touchStatusCheck).toHaveBeenCalledWith(['33333333-3333-4333-8333-333333333333']);
  });
});

describe('действия', () => {
  test('ссылка в окно сотрудника — под учёткой текущего пользователя', async () => {
    fdoc.employeeUrl.mockResolvedValue('https://demo.fdoc.ru/w/1');
    expect(await pk.employeeUrl({ salonId: 1, userId: 4, packageId: 'p' })).toEqual({ url: 'https://demo.fdoc.ru/w/1' });
    expect(store.setEmployeeUrl).toHaveBeenCalledWith(1, 'p', 'https://demo.fdoc.ru/w/1');
  });
  test('аннулировать подписанный нельзя', async () => {
    store.getPackage.mockResolvedValue({ id: 'p', status: 'signed', client_id: 52 });
    await expect(pk.annul({ salonId: 1, userId: 4, packageId: 'p' })).rejects.toMatchObject({ code: 'bad_status', status: 409 });
    expect(fdoc.declinePackage).not.toHaveBeenCalled();
  });
  test('ссылку повторно — только по ожидающему подписи', async () => {
    await pk.permalink({ salonId: 1, userId: 4, packageId: 'p' });
    expect(fdoc.sendPermalink).toHaveBeenCalledWith(expect.anything(), expect.anything(), 'p', ['52']);
  });
  test('preview: без F.Doc и с пропусками', async () => {
    store.getSettings.mockResolvedValue(null);
    store.getIdentityRow.mockResolvedValue(null);
    const r = await pk.preview({ salonId: 1, userId: 4, clientId: 52, templateId: 10, docDate: '2026-10-24' });
    expect(r.fileName).toBe('Договор.docx');
    expect(docText(Buffer.from(r.base64, 'base64'))).toBe('Договор с ________, паспорт ________, исполнитель ________');
  });
  test('check: чего не хватает', async () => {
    store.getIdentityRow.mockResolvedValue(null);
    const r = await pk.check({ salonId: 1, clientId: 52, templateIds: [10] });
    expect(r.missing.identity.map((x) => x.key)).toEqual(['first_name', 'last_name', 'passport_number', 'passport_series', 'phone']);
  });
  test('имена файлов: запрещённые символы и дубли', () => {
    const { safeFileName, uniqueNames } = require('./services/edocs/send-body');
    expect(safeFileName('Договор №1 / копия: "А"')).toBe('Договор №1 копия А.docx');
    expect(safeFileName('')).toBe('Документ.docx');
    expect(uniqueNames(['А.docx', 'а.docx', 'Б.docx'])).toEqual(['А.docx', 'а (2).docx', 'Б.docx']);
  });
});
```

- [ ] **Step 2: Убедиться, что тест падает**

```bash
cd /root/loyalpro-fdoc/backend && npx jest edocs-packages
```

Ожидается: FAIL с `Cannot find module './services/edocs/packages'`.

- [ ] **Step 3: Тело запроса и имена файлов**

Создать `backend/services/edocs/send-body.js`:

```js
'use strict';
// Тело POST /paperless-gateway/api/v1/document/withSigners и имена файлов — чистые функции
// (без БД и сети): их же использует живой скрипт scripts/edocs-fdoc-e2e.js.
// Маршрут: клиника подписывает первой и автоматически (operatorAutoSign; КЭП организации —
// qesCertAlias из настроек салона), пациент — вторым, по SMS-ссылке и коду.
const DAY_MS = 24 * 60 * 60 * 1000;

function safeFileName(title) {
  const base = String(title || 'Документ').replace(/[\u0000-\u001F\u007F/\\:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120) || 'Документ';
  return `${base}.docx`;
}

/** Одинаковые имена в комплекте → «Акт.docx», «Акт (2).docx». */
function uniqueNames(names) {
  const seen = new Map();
  return names.map((n) => {
    const k = n.toLowerCase();
    const c = (seen.get(k) || 0) + 1;
    seen.set(k, c);
    return c === 1 ? n : n.replace(/\.docx$/, ` (${c}).docx`);
  });
}

const fioOf = (identity) => [identity.plain.last_name, identity.plain.first_name, identity.plain.middle_name]
  .filter((x) => x && String(x).trim()).map((x) => String(x).trim()).join(' ');

function buildSendBody({ packageId, title, clientId, docs, files, identity, settings, now = new Date() }) {
  const unsignDays = Number(settings.unsign_days) > 0 ? Number(settings.unsign_days) : 14;
  const expires = new Date(now.getTime() + unsignDays * DAY_MS).toISOString();
  const corp = { type: 'corp', priority: 1, operatorAutoSign: true };
  if (settings.qes_cert_alias) corp.qesCertAlias = settings.qes_cert_alias;
  if (settings.employee_position) corp.employeePosition = settings.employee_position;
  return {
    documents: docs.map((d, i) => ({ id: d.id, name: d.file_name, file: files[i].toString('base64'), unsignExpiredDate: expires })),
    package: {
      id: packageId,
      name: title,
      objectId: `client:${clientId}`,
      signers: [corp, { type: 'client', priority: 2, id: String(clientId), name: fioOf(identity), phone: `+${identity.plain.phone}` }],
    },
  };
}

module.exports = { buildSendBody, safeFileName, uniqueNames, fioOf };
```

- [ ] **Step 4: Оркестрация**

Создать `backend/services/edocs/packages.js`:

```js
'use strict';
// Комплекты «Документов»: сборка DOCX, отправка в F.Doc, повтор без дубля, статусы,
// подписанные PDF и действия по комплекту. Источник истины по статусу — ответ F.Doc
// под нашим токеном; вебхук лишь просит перечитать (routes/fdoc-webhook.js).
// Подписант от клиники — организация (operatorAutoSign + qesCertAlias), отправитель —
// сотрудник под своей учётной записью F.Doc (решение владельца 24.10.2026).
const crypto = require('crypto');
const store = require('./store');
const s3 = require('../s3');
const { client: fdoc } = require('../fdoc/client');
const secretBox = require('../../utils/secret-box');
const docx = require('./docx');
const { missingFor } = require('./placeholders');
const { decodeRow } = require('./identity');
const { buildRenderData } = require('./fill');
const { linesFromRecord, normalizeLines, doctorOf } = require('./act-lines');
const { applyWorkflow } = require('./statuses');
const { EdocsError, shortError } = require('./errors');
const { buildSendBody, safeFileName, uniqueNames, fioOf } = require('./send-body');
const { fmtDate } = require('./format');
const { todayMsk } = require('../../utils/period');
const { createLogger } = require('../../logger');
const config = require('../../config');

const logger = createLogger('Edocs');
const MAX_DOCS = 10;          // предел F.Doc: 10 файлов на комплект
const STATUS_CHUNK = 10;      // предел F.Doc: 10 комплектов в запросе статусов

/** Настройки салона → параметры клиента F.Doc (секреты расшифрованы). */
function fdocConfig(row, { requireCorp = true, requireEnabled = true } = {}) {
  if (requireEnabled && (!row || !row.enabled)) throw new EdocsError('not_enabled', 'Модуль «Документы» выключен в настройках', 409);
  if (!row || !row.api_key_enc || !row.app_login || !row.app_password_enc || !row.app_code) {
    throw new EdocsError('not_configured', 'F.Doc не подключён: заполните ключ API и данные приложения в настройках', 409);
  }
  if (requireCorp && !row.corp_id) throw new EdocsError('not_configured', 'Проверьте подключение к F.Doc в настройках', 409);
  const box = secretBox.box();
  return {
    baseUrl: row.base_url, apiKey: box.decrypt(row.api_key_enc), appLogin: row.app_login,
    appPassword: box.decrypt(row.app_password_enc), appCode: row.app_code, corpId: row.corp_id || null,
  };
}

/** Учётные данные F.Doc пользователя; fallback — любые рабочие в салоне (фоновый опрос). */
async function credFor(salonId, userId, { fallback = false } = {}) {
  let row = userId ? await store.getCredentials(salonId, userId) : null;
  if (fallback && (!row || row.fail_count >= 3)) row = await store.pickCredentials(salonId, userId);
  if (!row) throw new EdocsError('fdoc_no_credentials', 'Подключите свою учётную запись F.Doc: кнопка «Мой F.Doc»', 409);
  if (row.fail_count >= 3) throw new EdocsError('fdoc_credentials_invalid', 'F.Doc трижды не принял ваш пароль — обновите его в «Мой F.Doc»', 409);
  return { userId: row.user_id, login: row.login, password: secretBox.box().decrypt(row.password_enc), failCount: row.fail_count };
}

// Неверный пароль — счётчик отказов (после трёх учётка не используется) и 409 для фронта.
async function withCred(cred, fn) {
  try {
    const r = await fn();
    if (cred.failCount > 0) { await store.markCredentialsOk(cred.userId); cred.failCount = 0; }
    return r;
  } catch (e) {
    if (e && e.code === 'fdoc_credentials_invalid') {
      await store.markCredentialsFail(cred.userId, shortError(e));
      throw new EdocsError('fdoc_credentials_invalid', 'F.Doc не принял логин или пароль — обновите их в «Мой F.Doc»', 409);
    }
    throw e;
  }
}

/** Всё, что нужно для заполнения: настройки, пациент, шаблоны, акт, данные; проверка полноты. */
async function prepare(input, { needFdoc = true, allowMissing = false } = {}) {
  const { salonId, userId, clientId } = input;
  const settingsRow = await store.getSettings(salonId);
  const cfg = needFdoc ? fdocConfig(settingsRow) : null;
  const cred = needFdoc ? await credFor(salonId, userId) : null;
  const client = await store.getClient(salonId, clientId);
  if (!client) throw new EdocsError('not_found', 'Пациент не найден', 404);
  const ids = [...new Set(input.templateIds || [])];
  if (!ids.length || ids.length > MAX_DOCS) throw new EdocsError('bad_templates', `Выберите от 1 до ${MAX_DOCS} документов`, 400);
  const templates = await store.getTemplatesByIds(salonId, ids);
  if (templates.length !== ids.length || templates.some((t) => !t.is_active)) throw new EdocsError('bad_templates', 'Шаблон не найден или выключен', 400);
  const isAct = templates.some((t) => t.kind === 'act');
  let act = null;
  let record = null;
  if (isAct) {
    if (!input.recordId) throw new EdocsError('act_needs_record', 'Для акта выберите визит', 400);
    record = await store.getRecord(salonId, input.recordId);
    if (!record || record.client_id !== client.id) throw new EdocsError('not_found', 'Визит не найден у этого пациента', 404);
    if (record.attendance !== '1' || record.deleted) throw new EdocsError('act_visit_not_done', 'Акт оформляется только по состоявшемуся визиту', 409);
    const lines = input.actLines ? normalizeLines(input.actLines) : { value: linesFromRecord(record.services) };
    if (lines.error) throw new EdocsError('bad_act_lines', lines.error, 400);
    if (!lines.value.length) throw new EdocsError('bad_act_lines', 'В акте нет ни одной строки', 400);
    const doctor = doctorOf(record.staff);
    act = {
      act_no: String(record.yclients_record_id || record.id), visit_date: record.visit_date,
      doctor_name: doctor.name, doctor_position: doctor.position, lines: lines.value,
    };
  }
  const identityRow = await store.getIdentityRow(salonId, client.id);
  const requisites = (settingsRow && settingsRow.requisites) || {};
  const missing = missingFor(identityRow, templates, requisites);
  if (!allowMissing && (missing.identity.length || missing.org.length)) {
    throw new EdocsError('missing_fields', 'Не хватает данных для выбранных документов', 400, { missing });
  }
  const identity = decodeRow(identityRow, secretBox.box()) || { plain: {}, secure: {}, secure_fields: [] };
  return { salonId, userId, settingsRow: settingsRow || {}, cfg, cred, client, templates, isAct, act, record, identity, requisites, missing, docDate: input.docDate || todayMsk() };
}

async function renderTemplate(ctx, t) {
  const buf = await s3.getObjectBuffer(t.file_key);
  return docx.render(buf, buildRenderData({ identity: ctx.identity, requisites: ctx.requisites, docDate: ctx.docDate, act: t.kind === 'act' ? ctx.act : null }));
}

async function transmit(ctx, packageId, body) {
  try {
    const res = await withCred(ctx.cred, () => fdoc.sendPackage(ctx.cfg, ctx.cred, body));
    await store.markSent(ctx.salonId, packageId, { employeeUrl: (res && res.url) || null, userId: ctx.userId });
    await store.logEvent({ salonId: ctx.salonId, packageId, clientId: ctx.client.id, kind: 'send', userId: ctx.userId, payload: { documents: body.documents.length } });
  } catch (e) {
    await store.markSendError(ctx.salonId, packageId, shortError(e));
    await store.logEvent({ salonId: ctx.salonId, packageId, clientId: ctx.client.id, kind: 'send_error', userId: ctx.userId,
      payload: { code: e.code || null, status: e.status || null, message: shortError(e) } });
    if (e.name === 'EdocsError') { e.packageId = packageId; throw e; }
    throw new EdocsError('fdoc_send_failed', `F.Doc не принял комплект: ${shortError(e)}`, 502, { packageId });
  }
  // Автоподпись клиники могла уже сдвинуть статус — перечитываем сразу; сбой не страшен, догонит опрос.
  try { await refreshRows(ctx.salonId, [await store.getPackage(ctx.salonId, packageId)]); } catch (e) { logger.warn(`edocs refresh after send ${packageId}: ${shortError(e)}`); }
  return { packageId };
}

// Демо-стенд F.Doc шлёт настоящие SMS, а в дев-БД — живые пациенты: туда только тестовые номера.
function assertDemoPhone(ctx) {
  let host = '';
  try { host = new URL(ctx.cfg.baseUrl).hostname; } catch (e) { host = ''; }
  if (!host.startsWith('demo.')) return;
  const allowed = config.EDOCS_DEMO_PHONES || [];
  if (!allowed.includes(String(ctx.identity.plain.phone || ''))) {
    throw new EdocsError('demo_phone_blocked', `Демо-стенд F.Doc: отправка только на тестовые номера (${allowed.join(', ') || 'не заданы'}) — переменная EDOCS_DEMO_PHONES`, 409);
  }
}

/** Собрать комплект из шаблонов и отправить на подписание. */
async function send(input) {
  const ctx = await prepare(input);
  assertDemoPhone(ctx);
  const files = [];
  for (const t of ctx.templates) files.push(await renderTemplate(ctx, t));
  const packageId = crypto.randomUUID();
  const names = uniqueNames(ctx.templates.map((t) => safeFileName(t.title)));
  const docs = ctx.templates.map((t, i) => ({ id: crypto.randomUUID(), template_id: t.id, title: t.title, file_name: names[i], sort_order: i }));
  const title = `${ctx.isAct ? 'Акт' : 'Документы'} от ${fmtDate(ctx.docDate)}`;
  await store.insertPackage({
    id: packageId, salon_id: ctx.salonId, client_id: ctx.client.id, record_id: ctx.isAct ? ctx.record.id : null,
    kind: ctx.isAct ? 'act' : 'onboarding', title, sent_by: ctx.userId,
    payload: { templateIds: ctx.templates.map((t) => t.id), docDate: ctx.docDate, act: ctx.act, patient: { fio: fioOf(ctx.identity), phone: ctx.identity.plain.phone } },
  }, docs);
  return transmit(ctx, packageId, buildSendBody({ packageId, title, clientId: ctx.client.id, docs, files, identity: ctx.identity, settings: ctx.settingsRow }));
}

/** Повтор отправки черновика: сначала спросить F.Doc — ответ мог потеряться, а комплект дойти. */
async function resend({ salonId, userId, packageId }) {
  const pkg = await mustPackage(salonId, packageId);
  if (pkg.status !== 'draft') throw new EdocsError('already_sent', 'Комплект уже принят F.Doc', 409);
  const cfg = fdocConfig(await store.getSettings(salonId));
  const cred = await credFor(salonId, userId);
  const known = await withCred(cred, () => fdoc.workflowStatuses(cfg, cred, [pkg.id]));
  const wf = known.packages.find((x) => x && x.id === pkg.id) || (known.packages.length === 1 ? known.packages[0] : null);
  if (wf) {
    await store.markSent(salonId, pkg.id, { userId });
    await applyOne(salonId, { ...pkg, status: 'sent' }, wf);
    await store.logEvent({ salonId, packageId: pkg.id, clientId: pkg.client_id, kind: 'send_recovered', userId, payload: { fdoc: wf.status || null } });
    return { packageId: pkg.id, recovered: true };
  }
  const docs = await store.listDocuments(pkg.id);
  if (docs.some((d) => !d.template_id)) throw new EdocsError('template_gone', 'Шаблон документа удалён — оформите комплект заново', 409);
  const p = pkg.payload || {};
  const ctx = await prepare({ salonId, userId, clientId: pkg.client_id, templateIds: docs.map((d) => d.template_id), recordId: pkg.record_id, actLines: p.act ? p.act.lines : null, docDate: p.docDate });
  assertDemoPhone(ctx);
  const byId = new Map(ctx.templates.map((t) => [t.id, t]));
  const files = [];
  for (const d of docs) files.push(await renderTemplate(ctx, byId.get(d.template_id)));
  return transmit(ctx, pkg.id, buildSendBody({ packageId: pkg.id, title: pkg.title, clientId: pkg.client_id, docs, files, identity: ctx.identity, settings: ctx.settingsRow }));
}

async function applyOne(salonId, row, wf) {
  const docs = await store.listDocuments(row.id);
  const upd = applyWorkflow(row, docs, wf);
  await store.applyStatus(salonId, row.id, upd);
  if (upd.package.unknownStatus) logger.warn(`edocs: незнакомый статус F.Doc «${wf.status}» у комплекта ${row.id}`);
  if (upd.package.status === row.status) return false;
  await store.logEvent({ salonId, packageId: row.id, clientId: row.client_id, kind: 'status', payload: { from: row.status, to: upd.package.status, fdoc: wf.status || null } });
  return true;
}

/** PDF подписанных документов → S3 (только те, что ещё не скачаны). */
async function fetchPdfs(salonId, pkg, cfg) {
  const docs = (await store.listDocuments(pkg.id)).filter((d) => !d.pdf_key);
  if (!docs.length) return 0;
  const cred = await credFor(salonId, pkg.sent_by, { fallback: true });
  let n = 0;
  for (const d of docs) {
    const buf = await withCred(cred, () => fdoc.downloadPdf(cfg, cred, pkg.fdoc_package_guid || pkg.id, d.fdoc_document_guid || d.id));
    const key = `edocs/${salonId}/packages/${pkg.id}/${d.id}.pdf`;
    await s3.putObject(key, buf, 'application/pdf');
    await store.setDocumentPdf(d.id, key);
    n++;
  }
  await store.logEvent({ salonId, packageId: pkg.id, clientId: pkg.client_id, kind: 'pdf', payload: { documents: n } });
  return n;
}

/** Перечитать статусы комплектов одного салона (под учёткой отправителя, иначе любой рабочей). */
async function refreshRows(salonId, rows) {
  const list = (rows || []).filter(Boolean);
  if (!list.length) return { checked: 0, changed: 0 };
  const cfg = fdocConfig(await store.getSettings(salonId));
  let checked = 0, changed = 0;
  const groups = new Map();
  for (const r of list) { const k = r.sent_by || 0; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(r); }
  for (const [userId, group] of groups) {
    let cred;
    try { cred = await credFor(salonId, userId, { fallback: true }); } catch (e) {
      logger.warn(`edocs: в салоне ${salonId} нет рабочих учётных данных F.Doc — статусы не проверены`);
      continue;
    }
    for (let i = 0; i < group.length; i += STATUS_CHUNK) {
      const chunk = group.slice(i, i + STATUS_CHUNK);
      const res = await withCred(cred, () => fdoc.workflowStatuses(cfg, cred, chunk.map((r) => r.fdoc_package_guid || r.id)));
      for (const wf of res.packages) {
        const row = chunk.find((r) => wf && (r.id === wf.id || (r.fdoc_package_guid && r.fdoc_package_guid === wf.id))) || (chunk.length === 1 ? chunk[0] : null);
        if (!row) { logger.warn(`edocs: F.Doc вернул комплект ${wf && wf.id}, которого нет в запросе`); continue; }
        checked++;
        if (await applyOne(salonId, row, wf)) changed++;
      }
      await store.touchStatusCheck(chunk.map((r) => r.id));
    }
  }
  for (const r of list) {
    const fresh = await store.getPackage(salonId, r.id);
    if (fresh && fresh.status === 'signed') await fetchPdfs(salonId, fresh, cfg).catch((e) => logger.warn(`edocs PDF ${r.id}: ${shortError(e)}`));
  }
  return { checked, changed };
}

let pollRunning = false;
/** Фоновый опрос (крон каждые 5 минут): страховка к потерянным вебхукам и докачка PDF. */
async function refreshDue() {
  if (pollRunning) return { skipped: true };
  pollRunning = true;
  try {
    const rows = await store.listDuePackages(200);
    const bySalon = new Map();
    for (const r of rows) { if (!bySalon.has(r.salon_id)) bySalon.set(r.salon_id, []); bySalon.get(r.salon_id).push(r); }
    let checked = 0, changed = 0;
    for (const [salonId, list] of bySalon) {
      try {
        const r = await refreshRows(salonId, list);
        checked += r.checked; changed += r.changed;
      } catch (e) {
        logger.warn(`edocs poll salon ${salonId}: ${shortError(e)}`);
        // Сломанные настройки салона не должны опрашиваться каждый тик подряд.
        try { await store.touchStatusCheck(list.map((x) => x.id)); } catch (_) { /* повторит следующий тик */ }
      }
    }
    return { checked, changed };
  } finally { pollRunning = false; }
}

async function mustPackage(salonId, packageId) {
  const pkg = await store.getPackage(salonId, packageId);
  if (!pkg) throw new EdocsError('not_found', 'Комплект не найден', 404);
  return pkg;
}

/** Ссылка в окно сотрудника — под учёткой ТЕКУЩЕГО пользователя (живёт 30 минут). */
async function employeeUrl({ salonId, userId, packageId }) {
  const pkg = await mustPackage(salonId, packageId);
  if (pkg.status === 'draft') throw new EdocsError('not_sent', 'Комплект ещё не принят F.Doc', 409);
  const cfg = fdocConfig(await store.getSettings(salonId));
  const cred = await credFor(salonId, userId);
  const url = await withCred(cred, () => fdoc.employeeUrl(cfg, cred, pkg.fdoc_package_guid || pkg.id));
  if (!url) throw new EdocsError('fdoc_no_url', 'F.Doc не вернул ссылку', 502);
  await store.setEmployeeUrl(salonId, pkg.id, url);
  return { url };
}

async function permalink({ salonId, userId, packageId }) {
  const pkg = await mustPackage(salonId, packageId);
  if (pkg.status !== 'sent') throw new EdocsError('bad_status', 'Ссылку можно отправить только по комплекту, который ждёт подписи', 409);
  const cfg = fdocConfig(await store.getSettings(salonId));
  const cred = await credFor(salonId, userId);
  await withCred(cred, () => fdoc.sendPermalink(cfg, cred, pkg.fdoc_package_guid || pkg.id, [String(pkg.client_id)]));
  await store.logEvent({ salonId, packageId: pkg.id, clientId: pkg.client_id, kind: 'permalink', userId });
  return { ok: true };
}

async function annul({ salonId, userId, packageId }) {
  const pkg = await mustPackage(salonId, packageId);
  if (!['sent', 'error'].includes(pkg.status)) {
    throw new EdocsError('bad_status', 'Здесь аннулируется только неподписанный комплект; подписанный — в окне F.Doc (нужно соглашение с пациентом)', 409);
  }
  const cfg = fdocConfig(await store.getSettings(salonId));
  const cred = await credFor(salonId, userId);
  await withCred(cred, () => fdoc.declinePackage(cfg, cred, pkg.fdoc_package_guid || pkg.id));
  await store.logEvent({ salonId, packageId: pkg.id, clientId: pkg.client_id, kind: 'annul', userId });
  await refreshRows(salonId, [pkg]).catch((e) => logger.warn(`edocs refresh after annul ${pkg.id}: ${shortError(e)}`));
  return { ok: true };
}

/** Заполненный DOCX без отправки (пропуски видны как «________»). F.Doc не нужен. */
async function preview(input) {
  const ctx = await prepare({ ...input, templateIds: [input.templateId] }, { needFdoc: false, allowMissing: true });
  const t = ctx.templates[0];
  const buf = await renderTemplate(ctx, t);
  return { fileName: safeFileName(t.title), base64: buf.toString('base64') };
}

/** Чего не хватает пациенту для набора шаблонов (без исключения — для формы). */
async function check({ salonId, clientId, templateIds }) {
  const client = await store.getClient(salonId, clientId);
  if (!client) throw new EdocsError('not_found', 'Пациент не найден', 404);
  const templates = await store.getTemplatesByIds(salonId, [...new Set(templateIds || [])]);
  const settingsRow = await store.getSettings(salonId);
  return { missing: missingFor(await store.getIdentityRow(salonId, clientId), templates, (settingsRow && settingsRow.requisites) || {}) };
}

module.exports = {
  send, resend, refreshRows, refreshDue, fetchPdfs, employeeUrl, permalink, annul, preview, check,
  fdocConfig, credFor, MAX_DOCS,
};
```

- [ ] **Step 5: Тест проходит**

```bash
cd /root/loyalpro-fdoc/backend && npx jest edocs-packages 2>&1 | grep -E "Tests:"
```

Ожидается: `Tests: 23 passed, 23 total`.

- [ ] **Step 6: Commit**

```bash
cd /root/loyalpro-fdoc && git add backend/services/edocs/send-body.js backend/services/edocs/packages.js backend/edocs-packages.test.js && git commit -m "feat(edocs): отправка комплектов, повтор без дубля, статусы, PDF в S3, защита демо-стенда

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: Роутер настроек и шаблонов — **Opus**

`/api/edocs/admin` — только владелец и администратор. Секреты наружу не отдаются (только «сохранён»); в теле `PUT /settings` отсутствие поля секрета — «не менять», пустая строка — «очистить». Адрес стенда — только https на домене fdoc.ru: туда уходят пароли сотрудников. Смена стенда, ключа или приложения сбрасывает `corp_id`; включить модуль без проверенного подключения нельзя. Шаблон: multipart `.docx` ≤ 10 МБ → разбор → проверка тегов под вид документа → S3 `edocs/<салон>/templates/<uuid>.docx`. Статический `/templates/dictionary` объявлен ДО `/templates/:id`.

**Files:**
- Create: `backend/routes/edocs-admin.js`
- Test: `backend/edocs-admin-routes.test.js`

- [ ] **Step 1: Написать падающий тест**

Создать `backend/edocs-admin-routes.test.js`:

```js
'use strict';
// /api/edocs/admin — настройки F.Doc, реквизиты, шаблоны (владелец и администратор).
jest.mock('./db', () => ({ db: {}, pool: {}, withTransaction: jest.fn() }));
jest.mock('./logger', () => ({ createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }) }));
jest.mock('./middleware/auth', () => ({
  auth: (req, res, next) => { req.user = req.__user; next(); },
  requireRole: (...roles) => (req, res, next) => (roles.includes(req.user && req.user.role) ? next() : res.status(403).json({ error: 'Нет доступа' })),
}));
jest.mock('./services/edocs/store', () => ({
  UUID_RE: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
  getSettings: jest.fn(), saveSettings: jest.fn(), getCredentials: jest.fn(), saveCredentials: jest.fn(), deleteCredentials: jest.fn(),
  listUsersWithCredentials: jest.fn(), listTemplates: jest.fn(), getTemplate: jest.fn(), updateTemplateMeta: jest.fn(), deleteTemplate: jest.fn(),
  searchClients: jest.fn(), getClient: jest.fn(), getIdentityRow: jest.fn(), upsertIdentity: jest.fn(), getLatestCertRequest: jest.fn(),
  listClientPackages: jest.fn(), listClientVisits: jest.fn(), actStatusesForRecords: jest.fn(), getRecord: jest.fn(),
  listPackages: jest.fn(), getPackage: jest.fn(), listDocuments: jest.fn(), listEvents: jest.fn(), getDocument: jest.fn(),
  logEvent: jest.fn(), touchWebhook: jest.fn(), findSalonByWebhookSecret: jest.fn(), findPackageByAnyId: jest.fn(),
}));
jest.mock('./services/edocs/packages', () => ({
  MAX_DOCS: 10, send: jest.fn(), resend: jest.fn(), refreshRows: jest.fn(), employeeUrl: jest.fn(), permalink: jest.fn(), annul: jest.fn(),
  preview: jest.fn(), check: jest.fn(), credFor: jest.fn(),
  fdocConfig: jest.fn(() => ({ baseUrl: 'https://demo.fdoc.ru', apiKey: 'K', appLogin: 'a', appPassword: 'p', appCode: 'c', corpId: 'C1' })),
}));
jest.mock('./services/fdoc/client', () => ({ client: { verifyApiKey: jest.fn(), checkCredentials: jest.fn(), forget: jest.fn(), tariffInfo: jest.fn(), putWebhooks: jest.fn(), recognize: jest.fn() } }));
jest.mock('./services/s3', () => ({ presignGet: jest.fn(async (k) => `https://s3/${k}?sig`), putObject: jest.fn(), deleteObjects: jest.fn(async () => ({})) }));
jest.mock('./utils/secret-box', () => ({
  isConfigured: jest.fn(() => true),
  box: () => ({ encrypt: (x) => `enc:${x}`, decrypt: (x) => String(x).slice(4), encryptJson: (o) => `enc:${JSON.stringify(o)}`, decryptJson: (x) => JSON.parse(String(x).slice(4)) }),
}));

const store = require('./services/edocs/store');
const { client: fdoc } = require('./services/fdoc/client');
const admin = require('./routes/edocs-admin');

function call(router, method, url, { user = { role: 'admin', salonId: 1, userId: 4 }, body, query } = {}) {
  return new Promise((resolve) => {
    const res = {
      statusCode: 200,
      status(c) { this.statusCode = c; return this; },
      json(b) { resolve({ status: this.statusCode, body: b }); return this; },
      end() { resolve({ status: this.statusCode, body: null }); return this; },
    };
    const req = { method, url, headers: { host: 'dev.zumrudin.ru' }, body, query: query || {}, __user: user, protocol: 'https', get: (h) => (h === 'host' ? 'dev.zumrudin.ru' : undefined) };
    router.handle(req, res, () => resolve({ status: 404, body: null }));
  });
}
beforeEach(() => jest.clearAllMocks());

describe('parseSettings', () => {
  const { parseSettings } = admin;
  test('домен только fdoc.ru по https; секреты: нет поля — не менять, пустая строка — очистить', () => {
    expect(parseSettings({ baseUrl: 'https://demo.fdoc.ru/', appLogin: ' app ', unsignDays: '7', requisites: { inn: ' 9724060392 ', junk: 'x' } }).value)
      .toEqual({ enabled: false, base_url: 'https://demo.fdoc.ru', app_login: 'app', app_code: null, qes_cert_alias: null, employee_position: null, unsign_days: 7, requisites: { inn: '9724060392' } });
    expect(parseSettings({ apiKey: '', appPassword: ' s3cr3t ' }).value).toMatchObject({ api_key: '', app_password: 's3cr3t' });
    for (const bad of ['http://demo.fdoc.ru', 'https://fdoc.ru.evil.com', 'https://evil.com', 'https://demo.fdoc.ru/api', 'https://u:p@demo.fdoc.ru', 'https://demo.fdoc.ru:8443', 'not a url']) {
      expect(parseSettings({ baseUrl: bad }).error).toMatch(/fdoc\.ru/);
    }
    expect(parseSettings({ unsignDays: 0 }).error).toMatch(/Срок/);
    expect(parseSettings({ unsignDays: [7] }).error).toMatch(/Срок/);
    expect(parseSettings({ apiKey: 123 }).error).toMatch(/Ключ API/);
  });
});

describe('/api/edocs/admin', () => {
  test('специалист и кассир — 403', async () => {
    expect((await call(admin, 'GET', '/settings', { user: { role: 'admin_cashier', salonId: 1, userId: 5 } })).status).toBe(403);
    expect((await call(admin, 'GET', '/settings', { user: { role: 'specialist', salonId: 1, userId: 5 } })).status).toBe(403);
  });
  test('GET /settings не отдаёт секреты, отдаёт признак и URL вебхука', async () => {
    store.getSettings.mockResolvedValue({ enabled: true, base_url: 'https://demo.fdoc.ru', api_key_enc: 'enc:K', app_password_enc: 'enc:P', app_login: 'a', webhook_secret: 'ab'.repeat(24), corp_id: 'C1', requisites: {} });
    const r = await call(admin, 'GET', '/settings');
    expect(r.body).toMatchObject({ hasApiKey: true, hasAppPassword: true, corpId: 'C1', webhookUrl: `https://dev.zumrudin.ru/fdoc/webhook/${'ab'.repeat(24)}`, encReady: true });
    expect(JSON.stringify(r.body)).not.toMatch(/enc:/);
  });
  test('PUT /settings: смена ключа сбрасывает corpId; включить без проверки нельзя', async () => {
    store.getSettings.mockResolvedValue({ base_url: 'https://demo.fdoc.ru', app_login: 'a', app_code: 'c', corp_id: 'C1' });
    let r = await call(admin, 'PUT', '/settings', { body: { baseUrl: 'https://demo.fdoc.ru', appLogin: 'a', appCode: 'c', apiKey: 'NEW' } });
    expect(r.body).toEqual({ ok: true, needVerify: true });
    expect(store.saveSettings.mock.calls[0][1]).toMatchObject({ api_key_enc: 'enc:NEW', corp_id: null, enabled: false });
    r = await call(admin, 'PUT', '/settings', { body: { enabled: true, baseUrl: 'https://demo.fdoc.ru', appLogin: 'a', appCode: 'c', apiKey: 'NEW2' } });
    expect(r.status).toBe(400);
    r = await call(admin, 'PUT', '/settings', { body: { enabled: true, baseUrl: 'https://demo.fdoc.ru', appLogin: 'a', appCode: 'c' } });
    expect(r.body).toEqual({ ok: true, needVerify: false });
    expect(store.saveSettings.mock.calls[1][1]).not.toHaveProperty('corp_id');
  });
  test('POST /settings/verify сохраняет corpId; ошибка F.Doc — 502 с текстом', async () => {
    store.getSettings.mockResolvedValue({});
    fdoc.verifyApiKey.mockResolvedValueOnce('777');
    expect((await call(admin, 'POST', '/settings/verify')).body).toEqual({ corpId: '777' });
    expect(store.saveSettings).toHaveBeenCalledWith(1, { corp_id: '777' });
    fdoc.verifyApiKey.mockRejectedValueOnce(Object.assign(new Error('F.Doc GET /x 401: Неверный ключ'), { name: 'FdocError', code: 'fdoc_unauthorized' }));
    expect(await call(admin, 'POST', '/settings/verify')).toEqual({ status: 502, body: { error: 'F.Doc GET /x 401: Неверный ключ', code: 'fdoc_unauthorized' } });
  });
  test('POST /settings/webhook создаёт секрет один раз и подписывается', async () => {
    store.getSettings.mockResolvedValue({ webhook_secret: null });
    const r = await call(admin, 'POST', '/settings/webhook');
    const secret = store.saveSettings.mock.calls[0][1].webhook_secret;
    expect(secret).toMatch(/^[a-f0-9]{48}$/);
    expect(r.body.url).toBe(`https://dev.zumrudin.ru/fdoc/webhook/${secret}`);
    expect(fdoc.putWebhooks).toHaveBeenCalledWith(expect.anything(), r.body.url);
  });
  test('шаблоны: смена вида проверяет теги; удаление занятого — 409', async () => {
    store.getTemplate.mockResolvedValue({ id: 3, kind: 'act', placeholders: ['fio', 'services'] });
    let r = await call(admin, 'PUT', '/templates/3', { body: { title: 'Акт', kind: 'contract', isActive: true, sortOrder: 1 } });
    expect(r.status).toBe(400);
    expect(r.body.details).toEqual(['Тег {services} разрешён только в шаблоне акта']);
    r = await call(admin, 'PUT', '/templates/3', { body: { title: 'Акт', kind: 'act', isActive: 'false', sortOrder: '2' } });
    expect(store.updateTemplateMeta).toHaveBeenCalledWith(1, 3, { title: 'Акт', kind: 'act', is_active: false, sort_order: 2 });
    store.deleteTemplate.mockResolvedValueOnce('busy');
    expect((await call(admin, 'DELETE', '/templates/3')).status).toBe(409);
    store.deleteTemplate.mockResolvedValueOnce({ fileKey: 'edocs/1/templates/x.docx' });
    expect((await call(admin, 'DELETE', '/templates/3')).body).toEqual({ ok: true });
  });
  test('словарь тегов — статический путь раньше :id', async () => {
    const r = await call(admin, 'GET', '/templates/dictionary');
    expect(r.body.fields.length).toBeGreaterThan(30);
  });
});
```

- [ ] **Step 2: Убедиться, что тест падает**

```bash
cd /root/loyalpro-fdoc/backend && npx jest edocs-admin-routes
```

Ожидается: FAIL с `Cannot find module './routes/edocs-admin'`.

- [ ] **Step 3: Реализация**

Создать `backend/routes/edocs-admin.js`:

```js
'use strict';
// /api/edocs/admin — подключение F.Doc, реквизиты клиники, шаблоны документов.
// Только владелец и администратор. Секреты (ключ API, пароль приложения) наружу не
// отдаются никогда — только признак «сохранён». Парсеры экспортируются ради тестов.
// ВНИМАНИЕ: поля JWT — req.user.salonId и req.user.userId (НЕ salon_id).
const router = require('express').Router();
const crypto = require('crypto');
const multer = require('multer');
const { auth, requireRole } = require('../middleware/auth');
const store = require('../services/edocs/store');
const packages = require('../services/edocs/packages');
const docx = require('../services/edocs/docx');
const s3 = require('../services/s3');
const secretBox = require('../utils/secret-box');
const { client: fdoc } = require('../services/fdoc/client');
const { KINDS, ORG_KEYS, validateTags, dictionary } = require('../services/edocs/placeholders');
const { sendError } = require('../services/edocs/errors');
const { createLogger } = require('../logger');

const logger = createLogger('EdocsAdminAPI');
const URL_ERR = 'Адрес F.Doc — https://… на домене fdoc.ru';
const CONTROL_RE = /[\u0000-\u001F\u007F]/g;
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: docx.MAX_TEMPLATE_BYTES, files: 1 } });

const str = (v, max) => String(v === undefined || v === null ? '' : v).replace(CONTROL_RE, '').trim().slice(0, max);
const idParam = (v) => (/^\d{1,9}$/.test(String(v)) ? Number(v) : null);
const publicBase = (req) => `${req.protocol}://${req.get('host')}`;

/**
 * Тело PUT /settings. Секреты: undefined/null — не менять, '' — очистить, строка — заменить.
 * Адрес стенда — только https на домене fdoc.ru: туда уходят пароли сотрудников.
 */
function parseSettings(b) {
  b = b || {};
  const out = { enabled: b.enabled === true };
  let u;
  try { u = new URL(String(b.baseUrl || 'https://demo.fdoc.ru').trim()); } catch (e) { return { error: URL_ERR }; }
  if (u.protocol !== 'https:' || !(u.hostname === 'fdoc.ru' || u.hostname.endsWith('.fdoc.ru'))
    || u.username || u.password || u.port || u.search || u.hash || (u.pathname && u.pathname !== '/')) return { error: URL_ERR };
  out.base_url = u.origin;
  for (const [field, col, label] of [['apiKey', 'api_key', 'Ключ API'], ['appPassword', 'app_password', 'Пароль приложения']]) {
    const v = b[field];
    if (v === undefined || v === null) continue;
    if (typeof v !== 'string' || v.length > 500) return { error: `${label}: строка до 500 символов` };
    out[col] = v.trim();
  }
  out.app_login = str(b.appLogin, 200) || null;
  out.app_code = str(b.appCode, 100) || null;
  out.qes_cert_alias = str(b.qesCertAlias, 200) || null;
  out.employee_position = str(b.employeePosition, 200) || null;
  const raw = b.unsignDays;
  const days = raw === undefined || raw === null || raw === '' ? 14 : (typeof raw === 'number' || typeof raw === 'string' ? Number(raw) : NaN);
  if (!Number.isInteger(days) || days < 1 || days > 90) return { error: 'Срок подписания — от 1 до 90 дней' };
  out.unsign_days = days;
  const r = b.requisites && typeof b.requisites === 'object' && !Array.isArray(b.requisites) ? b.requisites : {};
  out.requisites = {};
  for (const k of ORG_KEYS) {
    const v = str(r[k], ['name', 'address', 'bank'].includes(k) ? 500 : 200);
    if (v) out.requisites[k] = v;
  }
  return { value: out };
}

/** title + kind (+ isActive/sortOrder для PUT). Поля multipart приходят строками. */
function parseTemplateMeta(b, { full = false } = {}) {
  b = b || {};
  const title = String(b.title || '').replace(CONTROL_RE, '').replace(/\s+/g, ' ').trim();
  if (!title || title.length > 200) return { error: 'Название — 1–200 символов' };
  if (!KINDS.includes(b.kind)) return { error: 'Вид документа: договор, согласие, акт или другой' };
  const out = { title, kind: b.kind };
  if (full) {
    out.is_active = !(b.isActive === false || b.isActive === 'false');
    const so = b.sortOrder === undefined || b.sortOrder === null || b.sortOrder === '' ? 0 : Number(b.sortOrder);
    if (!Number.isInteger(so) || so < 0 || so > 9999) return { error: 'Порядок — целое от 0 до 9999' };
    out.sort_order = so;
  }
  return { value: out };
}

function uploadDocx(req, res, next) {
  upload.single('file')(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'Шаблон больше 10 МБ' : 'Не удалось принять файл' });
    if (!req.file) return res.status(400).json({ error: 'Приложите файл .docx' });
    if (!/\.docx$/i.test(req.file.originalname || '')) return res.status(400).json({ error: 'Нужен файл Word в формате .docx' });
    return next();
  });
}

router.use(auth, requireRole('owner', 'admin'));

// ── подключение и реквизиты ──
router.get('/settings', async (req, res) => {
  try {
    const s = (await store.getSettings(req.user.salonId)) || {};
    res.json({
      enabled: !!s.enabled, baseUrl: s.base_url || 'https://demo.fdoc.ru', appLogin: s.app_login || '', appCode: s.app_code || '',
      corpId: s.corp_id || null, qesCertAlias: s.qes_cert_alias || '', employeePosition: s.employee_position || '',
      unsignDays: s.unsign_days || 14, requisites: s.requisites || {},
      hasApiKey: !!s.api_key_enc, hasAppPassword: !!s.app_password_enc,
      webhookUrl: s.webhook_secret ? `${publicBase(req)}/fdoc/webhook/${s.webhook_secret}` : null,
      lastWebhookAt: s.last_webhook_at || null, encReady: secretBox.isConfigured(),
    });
  } catch (e) { sendError(res, e, logger, 'edocs settings get'); }
});

router.put('/settings', async (req, res) => {
  const p = parseSettings(req.body);
  if (p.error) return res.status(400).json({ error: p.error });
  const sid = req.user.salonId;
  const v = p.value;
  try {
    const cur = (await store.getSettings(sid)) || {};
    const patch = {
      enabled: v.enabled, base_url: v.base_url, app_login: v.app_login, app_code: v.app_code, qes_cert_alias: v.qes_cert_alias,
      employee_position: v.employee_position, unsign_days: v.unsign_days, requisites: v.requisites,
    };
    if (v.api_key !== undefined) patch.api_key_enc = v.api_key ? secretBox.box().encrypt(v.api_key) : null;
    if (v.app_password !== undefined) patch.app_password_enc = v.app_password ? secretBox.box().encrypt(v.app_password) : null;
    // Сменился стенд, ключ или приложение — прежний corpId недействителен: нужна новая проверка.
    const reverify = v.base_url !== (cur.base_url || null) || v.api_key !== undefined || v.app_password !== undefined
      || v.app_login !== (cur.app_login || null) || v.app_code !== (cur.app_code || null);
    if (reverify) patch.corp_id = null;
    if (v.enabled && (reverify || !cur.corp_id)) return res.status(400).json({ error: 'Включить модуль можно после успешной проверки подключения' });
    await store.saveSettings(sid, patch);
    res.json({ ok: true, needVerify: reverify });
  } catch (e) { sendError(res, e, logger, 'edocs settings save'); }
});

router.post('/settings/verify', async (req, res) => {
  const sid = req.user.salonId;
  try {
    const cfg = packages.fdocConfig(await store.getSettings(sid), { requireCorp: false, requireEnabled: false });
    const corpId = await fdoc.verifyApiKey(cfg);
    await store.saveSettings(sid, { corp_id: corpId });
    res.json({ corpId });
  } catch (e) { sendError(res, e, logger, 'edocs verify'); }
});

router.get('/settings/tariff', async (req, res) => {
  try {
    const cfg = packages.fdocConfig(await store.getSettings(req.user.salonId), { requireEnabled: false });
    res.json({ tariffs: await fdoc.tariffInfo(cfg) });
  } catch (e) { sendError(res, e, logger, 'edocs tariff'); }
});

// Подписка на вебхук SetStatus. Перед ней F.Doc должен зарегистрировать IP сервера.
router.post('/settings/webhook', async (req, res) => {
  const sid = req.user.salonId;
  try {
    const row = await store.getSettings(sid);
    const cfg = packages.fdocConfig(row, { requireEnabled: false });
    const secret = row.webhook_secret || crypto.randomBytes(24).toString('hex');
    if (!row.webhook_secret) await store.saveSettings(sid, { webhook_secret: secret });
    const url = `${publicBase(req)}/fdoc/webhook/${secret}`;
    await fdoc.putWebhooks(cfg, url);
    res.json({ url });
  } catch (e) { sendError(res, e, logger, 'edocs webhook subscribe'); }
});

router.get('/users', async (req, res) => {
  try {
    const rows = await store.listUsersWithCredentials(req.user.salonId);
    res.json({ users: rows.map((u) => ({
      id: u.id, name: u.name, email: u.email, role: u.role, active: u.is_active,
      connected: !!u.login, login: u.login || null, lastOkAt: u.last_ok_at || null, broken: (u.fail_count || 0) >= 3, lastError: u.last_error || null,
    })) });
  } catch (e) { sendError(res, e, logger, 'edocs users'); }
});

// ── шаблоны ── (статические пути — ДО /templates/:id)
router.get('/templates/dictionary', (req, res) => res.json(dictionary()));

router.get('/templates', async (req, res) => {
  try { res.json({ templates: await store.listTemplates(req.user.salonId) }); }
  catch (e) { sendError(res, e, logger, 'edocs templates'); }
});

router.post('/templates', uploadDocx, async (req, res) => {
  const m = parseTemplateMeta(req.body);
  if (m.error) return res.status(400).json({ error: m.error });
  const sid = req.user.salonId;
  try {
    const v = validateTags(docx.inspect(req.file.buffer), m.value.kind);
    if (!v.ok) return res.status(400).json({ error: 'Шаблон не прошёл проверку', details: v.errors });
    const key = `edocs/${sid}/templates/${crypto.randomUUID()}.docx`;
    await s3.putObject(key, req.file.buffer, docx.DOCX_MIME);
    const id = await store.insertTemplate(sid, { ...m.value, file_key: key, file_size: req.file.size, placeholders: v.placeholders, created_by: req.user.userId });
    res.json({ id, placeholders: v.placeholders });
  } catch (e) { sendError(res, e, logger, 'edocs template upload'); }
});

router.put('/templates/:id', async (req, res) => {
  const id = idParam(req.params.id);
  const m = parseTemplateMeta(req.body, { full: true });
  if (!id) return res.status(404).json({ error: 'Шаблон не найден' });
  if (m.error) return res.status(400).json({ error: m.error });
  const sid = req.user.salonId;
  try {
    const t = await store.getTemplate(sid, id);
    if (!t) return res.status(404).json({ error: 'Шаблон не найден' });
    const v = validateTags(Object.fromEntries((t.placeholders || []).map((n) => [n, {}])), m.value.kind);
    if (!v.ok) return res.status(400).json({ error: 'Вид документа не подходит к тегам шаблона', details: v.errors });
    await store.updateTemplateMeta(sid, id, m.value);
    res.json({ ok: true });
  } catch (e) { sendError(res, e, logger, 'edocs template update'); }
});

router.post('/templates/:id/file', uploadDocx, async (req, res) => {
  const id = idParam(req.params.id);
  if (!id) return res.status(404).json({ error: 'Шаблон не найден' });
  const sid = req.user.salonId;
  try {
    const t = await store.getTemplate(sid, id);
    if (!t) return res.status(404).json({ error: 'Шаблон не найден' });
    const v = validateTags(docx.inspect(req.file.buffer), t.kind);
    if (!v.ok) return res.status(400).json({ error: 'Шаблон не прошёл проверку', details: v.errors });
    const key = `edocs/${sid}/templates/${crypto.randomUUID()}.docx`;
    await s3.putObject(key, req.file.buffer, docx.DOCX_MIME);
    const old = await store.replaceTemplateFile(sid, id, { file_key: key, file_size: req.file.size, placeholders: v.placeholders });
    if (old) await s3.deleteObjects([old]).catch((e) => logger.warn(`edocs old template file ${old}: ${e.message}`));
    res.json({ ok: true, placeholders: v.placeholders });
  } catch (e) { sendError(res, e, logger, 'edocs template replace'); }
});

router.get('/templates/:id/file', async (req, res) => {
  const id = idParam(req.params.id);
  try {
    const t = id ? await store.getTemplate(req.user.salonId, id) : null;
    if (!t) return res.status(404).json({ error: 'Шаблон не найден' });
    res.json({ url: await s3.presignGet(t.file_key, 900) });
  } catch (e) { sendError(res, e, logger, 'edocs template file'); }
});

router.delete('/templates/:id', async (req, res) => {
  const id = idParam(req.params.id);
  if (!id) return res.status(404).json({ error: 'Шаблон не найден' });
  try {
    const r = await store.deleteTemplate(req.user.salonId, id);
    if (r === 'busy') return res.status(409).json({ error: 'Шаблон в неподписанном комплекте — дождитесь подписи или аннулируйте комплект' });
    if (r === 'missing') return res.status(404).json({ error: 'Шаблон не найден' });
    await s3.deleteObjects([r.fileKey]).catch((e) => logger.warn(`edocs template file ${r.fileKey}: ${e.message}`));
    res.json({ ok: true });
  } catch (e) { sendError(res, e, logger, 'edocs template delete'); }
});

module.exports = router;
module.exports.parseSettings = parseSettings;
module.exports.parseTemplateMeta = parseTemplateMeta;
```

- [ ] **Step 4: Тест проходит**

```bash
cd /root/loyalpro-fdoc/backend && npx jest edocs-admin-routes 2>&1 | grep -E "Tests:"
```

Ожидается: `Tests: 8 passed, 8 total`.

- [ ] **Step 5: Commit**

```bash
cd /root/loyalpro-fdoc && git add backend/routes/edocs-admin.js backend/edocs-admin-routes.test.js && git commit -m "feat(edocs): /api/edocs/admin — подключение F.Doc, реквизиты, шаблоны DOCX

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 11: Роутер оформления, вебхук, проводка в сервер — **Opus**

`/api/edocs` — владелец, администратор и администратор-кассир (префикс добавляется в `CASHIER_ALLOWED_PREFIXES`; `/api/edocs/admin` кассиру закрывает сам admin-роутер). Поиск пациентов свой: `/api/clients` кассиру закрыт. Паспорт расшифровывается только для формы (просмотр — в журнал); при отсутствии ключа — 503. id комплекта проверяется как UUID до SQL. Сводка по пациенту отдаётся и при выключенном модуле: мастер работает без F.Doc, блокируется только отправка. Вебхук `POST /fdoc/webhook/<секрет>` без JWT: неизвестный секрет — 404 без тела, известный — 200 сразу, затем журнал (только известные поля) и перечитывание статуса. **Обработчик вебхука нельзя экспортировать под именем `handle`** — это внутренний метод `express.Router`, перезапись глушит весь роутер (поймано тестом при подготовке плана). Крон `*/5` — опрос статусов (`EDOCS_POLL=false` гасит).

**Files:**
- Create: `backend/routes/edocs.js`, `backend/routes/fdoc-webhook.js`
- Modify: `backend/config.js`, `backend/routes/index.js`, `backend/server.js`
- Test: `backend/edocs-routes.test.js`

- [ ] **Step 1: Написать падающий тест**

Создать `backend/edocs-routes.test.js`:

```js
'use strict';
// /api/edocs — оформление документов (+ администратор-кассир) и вебхук F.Doc.
jest.mock('./db', () => ({ db: {}, pool: {}, withTransaction: jest.fn() }));
jest.mock('./logger', () => ({ createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }) }));
jest.mock('./middleware/auth', () => ({
  auth: (req, res, next) => { req.user = req.__user; next(); },
  requireRole: (...roles) => (req, res, next) => (roles.includes(req.user && req.user.role) ? next() : res.status(403).json({ error: 'Нет доступа' })),
}));
jest.mock('./services/edocs/store', () => ({
  UUID_RE: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
  getSettings: jest.fn(), saveSettings: jest.fn(), getCredentials: jest.fn(), saveCredentials: jest.fn(), deleteCredentials: jest.fn(),
  listUsersWithCredentials: jest.fn(), listTemplates: jest.fn(), getTemplate: jest.fn(), updateTemplateMeta: jest.fn(), deleteTemplate: jest.fn(),
  searchClients: jest.fn(), getClient: jest.fn(), getIdentityRow: jest.fn(), upsertIdentity: jest.fn(), getLatestCertRequest: jest.fn(),
  listClientPackages: jest.fn(), listClientVisits: jest.fn(), actStatusesForRecords: jest.fn(), getRecord: jest.fn(),
  listPackages: jest.fn(), getPackage: jest.fn(), listDocuments: jest.fn(), listEvents: jest.fn(), getDocument: jest.fn(),
  logEvent: jest.fn(), touchWebhook: jest.fn(), findSalonByWebhookSecret: jest.fn(), findPackageByAnyId: jest.fn(),
}));
jest.mock('./services/edocs/packages', () => ({
  MAX_DOCS: 10, send: jest.fn(), resend: jest.fn(), refreshRows: jest.fn(), employeeUrl: jest.fn(), permalink: jest.fn(), annul: jest.fn(),
  preview: jest.fn(), check: jest.fn(), credFor: jest.fn(),
  fdocConfig: jest.fn(() => ({ baseUrl: 'https://demo.fdoc.ru', apiKey: 'K', appLogin: 'a', appPassword: 'p', appCode: 'c', corpId: 'C1' })),
}));
jest.mock('./services/fdoc/client', () => ({ client: { verifyApiKey: jest.fn(), checkCredentials: jest.fn(), forget: jest.fn(), tariffInfo: jest.fn(), putWebhooks: jest.fn(), recognize: jest.fn() } }));
jest.mock('./services/s3', () => ({ presignGet: jest.fn(async (k) => `https://s3/${k}?sig`), putObject: jest.fn(), deleteObjects: jest.fn(async () => ({})) }));
jest.mock('./utils/secret-box', () => ({
  isConfigured: jest.fn(() => true),
  box: () => ({ encrypt: (x) => `enc:${x}`, decrypt: (x) => String(x).slice(4), encryptJson: (o) => `enc:${JSON.stringify(o)}`, decryptJson: (x) => JSON.parse(String(x).slice(4)) }),
}));

const store = require('./services/edocs/store');
const packages = require('./services/edocs/packages');
const { client: fdoc } = require('./services/fdoc/client');
const { EdocsError } = require('./services/edocs/errors');
const ops = require('./routes/edocs');
const webhook = require('./routes/fdoc-webhook');

function call(router, method, url, { user = { role: 'admin', salonId: 1, userId: 4 }, body, query } = {}) {
  return new Promise((resolve) => {
    const res = {
      statusCode: 200,
      status(c) { this.statusCode = c; return this; },
      json(b) { resolve({ status: this.statusCode, body: b }); return this; },
      end() { resolve({ status: this.statusCode, body: null }); return this; },
    };
    const req = { method, url, headers: { host: 'dev.zumrudin.ru' }, body, query: query || {}, __user: user, protocol: 'https', get: (h) => (h === 'host' ? 'dev.zumrudin.ru' : undefined) };
    router.handle(req, res, () => resolve({ status: 404, body: null }));
  });
}
const PKG_ID = '11111111-1111-4111-8111-111111111111';

beforeEach(() => jest.clearAllMocks());

describe('parsePackageBody', () => {
  const { parsePackageBody } = ops;
  test('валидное тело и ошибки', () => {
    expect(parsePackageBody({ clientId: '52', templateIds: [10, '11', 10], docDate: '2026-10-24' }, { today: '2026-10-24' }).value)
      .toEqual({ clientId: 52, templateIds: [10, 11], recordId: null, docDate: '2026-10-24', actLines: null });
    expect(parsePackageBody({ templateIds: [1] }).error).toMatch(/пациент/);
    expect(parsePackageBody({ clientId: 1, templateIds: [] }).error).toMatch(/от 1 до 10/);
    expect(parsePackageBody({ clientId: 1, templateIds: [1, 'x'] }).error).toMatch(/шаблон/);
    expect(parsePackageBody({ clientId: 1, templateIds: [1], recordId: 'abc' }).error).toMatch(/визит/);
    expect(parsePackageBody({ clientId: 1, templateIds: [1], docDate: '2027-01-01' }, { today: '2026-10-24' }).error).toMatch(/Дата/);
    expect(parsePackageBody({ clientId: 1, templateIds: [1], actLines: 'x' }).error).toMatch(/Строки/);
    expect(parsePackageBody({ clientId: 1, templateId: 7 }, { single: true }).value.templateIds).toEqual([7]);
  });
});

describe('/api/edocs', () => {
  test('кассир допущен, специалист — нет', async () => {
    store.getSettings.mockResolvedValue({ enabled: true, corp_id: 'C1' });
    store.getCredentials.mockResolvedValue(null);
    expect((await call(ops, 'GET', '/state', { user: { role: 'admin_cashier', salonId: 1, userId: 5 } })).body)
      .toEqual({ enabled: true, configured: true, encReady: true, role: 'admin_cashier', me: { connected: false, login: null, broken: false, lastError: null } });
    expect((await call(ops, 'GET', '/state', { user: { role: 'specialist', salonId: 1, userId: 6 } })).status).toBe(403);
  });
  test('PUT /me/credentials: проверка входом до сохранения; неверный пароль — 400', async () => {
    store.getSettings.mockResolvedValue({ corp_id: 'C1' });
    fdoc.checkCredentials.mockRejectedValueOnce(Object.assign(new Error('x'), { code: 'fdoc_credentials_invalid' }));
    expect((await call(ops, 'PUT', '/me/credentials', { body: { login: 'ivanova', password: 'bad' } })).status).toBe(400);
    expect(store.saveCredentials).not.toHaveBeenCalled();
    fdoc.checkCredentials.mockResolvedValueOnce(true);
    expect((await call(ops, 'PUT', '/me/credentials', { body: { login: ' ivanova ', password: 'pw' } })).body).toEqual({ ok: true });
    expect(store.saveCredentials).toHaveBeenCalledWith(1, 4, 'ivanova', 'enc:pw');
    expect((await call(ops, 'PUT', '/me/credentials', { body: { login: 'x' } })).status).toBe(400);
  });
  test('GET identity расшифровывает и пишет просмотр в журнал', async () => {
    store.getClient.mockResolvedValue({ id: 52 });
    store.getIdentityRow.mockResolvedValue({ last_name: 'Иванова', first_name: 'Анна', secure_enc: `enc:${JSON.stringify({ passport_series: '4510' })}`, secure_fields: ['passport_series'], source: 'manual' });
    const r = await call(ops, 'GET', '/clients/52/identity');
    expect(r.body).toMatchObject({ exists: true, plain: { last_name: 'Иванова' }, secure: { passport_series: '4510' } });
    expect(store.logEvent).toHaveBeenCalledWith({ salonId: 1, clientId: 52, kind: 'identity_view', userId: 4 });
  });
  test('PUT identity: ошибка формы — 400, иначе шифротекст и журнал правки без значений', async () => {
    store.getClient.mockResolvedValue({ id: 52 });
    expect((await call(ops, 'PUT', '/clients/52/identity', { body: { secure: { passport_series: '1' } } })).status).toBe(400);
    const r = await call(ops, 'PUT', '/clients/52/identity', { body: { last_name: 'Иванова', phone: '89200255591', secure: { passport_series: '4510', passport_number: '123456' } } });
    expect(r.body).toEqual({ ok: true });
    const saved = store.upsertIdentity.mock.calls[0][2];
    expect(saved.secure_enc).toBe(`enc:${JSON.stringify({ passport_series: '4510', passport_number: '123456' })}`);
    expect(saved.plain.phone).toBe('79200255591');
    expect(store.logEvent).toHaveBeenCalledWith(expect.objectContaining({ kind: 'identity_edit', payload: { plain: ['last_name', 'phone'], secure: ['passport_series', 'passport_number'], source: 'manual' } }));
    expect(JSON.stringify(store.logEvent.mock.calls)).not.toContain('123456');
  });
  test('нет ключа шифрования — 503 с понятным текстом', async () => {
    const sb = require('./utils/secret-box');
    const orig = sb.box;
    sb.box = () => { const e = new Error('no key'); e.name = 'SecretBoxError'; e.code = 'no_key'; throw e; };
    store.getClient.mockResolvedValue({ id: 52 });
    const r = await call(ops, 'PUT', '/clients/52/identity', { body: { last_name: 'Иванова' } });
    sb.box = orig;
    expect(r).toMatchObject({ status: 503, body: { code: 'enc_not_configured' } });
  });
  test('POST /packages: нехватка данных уходит списком; F.Doc-ошибка — 502 с id комплекта', async () => {
    packages.send.mockRejectedValueOnce(new EdocsError('missing_fields', 'Не хватает данных', 400, { missing: { identity: [{ key: 'phone', label: 'Телефон' }], org: [] } }));
    let r = await call(ops, 'POST', '/packages', { body: { clientId: 52, templateIds: [10] } });
    expect(r).toEqual({ status: 400, body: { error: 'Не хватает данных', code: 'missing_fields', missing: { identity: [{ key: 'phone', label: 'Телефон' }], org: [] } } });
    packages.send.mockRejectedValueOnce(new EdocsError('fdoc_send_failed', 'F.Doc не принял комплект: x', 502, { packageId: PKG_ID }));
    r = await call(ops, 'POST', '/packages', { body: { clientId: 52, templateIds: [10] } });
    expect(r.body).toMatchObject({ code: 'fdoc_send_failed', packageId: PKG_ID });
    packages.send.mockResolvedValueOnce({ packageId: PKG_ID });
    r = await call(ops, 'POST', '/packages', { body: { clientId: 52, templateIds: [10] } });
    expect(packages.send).toHaveBeenLastCalledWith({ salonId: 1, userId: 4, clientId: 52, templateIds: [10], recordId: null, docDate: null, actLines: null });
  });
  test('комплект по не-UUID — 404 без запроса в БД; карточка с документами', async () => {
    expect((await call(ops, 'GET', '/packages/123')).status).toBe(404);
    expect(store.getPackage).not.toHaveBeenCalled();
    store.getPackage.mockResolvedValue({ id: PKG_ID, kind: 'onboarding', title: 'Документы', status: 'signed', client_id: 52, payload: { patient: { fio: 'Иванова Анна' } } });
    store.listDocuments.mockResolvedValue([{ id: 'd', title: 'Договор', file_name: 'Договор.docx', pdf_key: 'k' }]);
    store.listEvents.mockResolvedValue([]);
    const r = await call(ops, 'GET', `/packages/${PKG_ID}`);
    expect(r.body).toMatchObject({ id: PKG_ID, status: 'signed', patient: { fio: 'Иванова Анна' }, documents: [{ id: 'd', title: 'Договор', fileName: 'Договор.docx', hasPdf: true }] });
  });
  test('действия по комплекту передают salonId/userId', async () => {
    packages.annul.mockResolvedValue({ ok: true });
    await call(ops, 'POST', `/packages/${PKG_ID}/annul`);
    expect(packages.annul).toHaveBeenCalledWith({ salonId: 1, userId: 4, packageId: PKG_ID });
  });
  test('PDF: нет ещё — 409; есть — ссылка на 15 минут', async () => {
    store.getDocument.mockResolvedValueOnce({ id: 'd', pdf_key: null });
    expect((await call(ops, 'GET', `/documents/${PKG_ID}/pdf`)).status).toBe(409);
    store.getDocument.mockResolvedValueOnce({ id: 'd', pdf_key: 'edocs/1/p/d.pdf' });
    expect((await call(ops, 'GET', `/documents/${PKG_ID}/pdf`)).body).toEqual({ url: 'https://s3/edocs/1/p/d.pdf?sig' });
  });
  test('сводка по пациенту отдаётся и при выключенном модуле (мастер работает без F.Doc)', async () => {
    store.getSettings.mockResolvedValue({ enabled: false });
    store.getClient.mockResolvedValue({ id: 52, name: 'Иванова Анна', phone: '79200255591' });
    store.getIdentityRow.mockResolvedValue(null);
    store.listClientPackages.mockResolvedValue([]);
    expect((await call(ops, 'GET', '/clients/52/summary')).body).toEqual({
      enabled: false, client: { id: 52, name: 'Иванова Анна', phone: '79200255591' }, identity: { exists: false }, packages: [],
    });
  });
  test('статусы актов по записям', async () => {
    store.getSettings.mockResolvedValue({ enabled: true });
    store.actStatusesForRecords.mockResolvedValue([{ record_id: 30252, package_id: PKG_ID, status: 'sent' }]);
    const r = await call(ops, 'GET', '/records/act-status', { query: { ids: '30252,abc,30253' } });
    expect(store.actStatusesForRecords).toHaveBeenCalledWith(1, [30252, 30253]);
    expect(r.body).toEqual({ enabled: true, statuses: { 30252: { packageId: PKG_ID, status: 'sent' } } });
  });
  test('черновик акта: только по состоявшемуся визиту', async () => {
    store.getRecord.mockResolvedValueOnce({ id: 1, attendance: '2', deleted: false });
    expect((await call(ops, 'GET', '/records/1/act-draft')).status).toBe(409);
    store.getRecord.mockResolvedValueOnce({ id: 1, client_id: 52, yclients_record_id: 99, attendance: '1', deleted: false, visit_date: '2026-10-23',
      staff: { name: 'Пери', position: { title: 'Врач' } }, services: [{ id: 5, title: 'Чистка', amount: 1, first_cost: 3500, manual_cost: 3500 }] });
    const r = await call(ops, 'GET', '/records/1/act-draft');
    expect(r.body).toMatchObject({ record: { id: 1, clientId: 52, actNo: '99' }, doctor: { name: 'Пери', position: 'Врач' }, totals: { total_sum: 3500 } });
  });
});

describe('вебхук F.Doc', () => {
  test('неизвестный или кривой секрет — 404 без тела', async () => {
    expect((await call(webhook, 'POST', '/webhook/short')).status).toBe(404);
    store.findSalonByWebhookSecret.mockResolvedValueOnce(null);
    expect((await call(webhook, 'POST', `/webhook/${'a'.repeat(48)}`)).status).toBe(404);
  });
  test('известный секрет — 200 сразу, затем журнал и перечитывание статуса', async () => {
    store.findSalonByWebhookSecret.mockResolvedValue(1);
    store.findPackageByAnyId.mockResolvedValue({ id: PKG_ID, salon_id: 1 });
    packages.refreshRows.mockResolvedValue({ checked: 1, changed: 1 });
    const r = await call(webhook, 'POST', `/webhook/${'a'.repeat(48)}`, { body: { packageId: PKG_ID, status: 'SIGNED', documentIds: [PKG_ID], evil: 'x'.repeat(10) } });
    expect(r).toEqual({ status: 200, body: { ok: true } });
    await new Promise((s) => setImmediate(s));
    await new Promise((s) => setImmediate(s));
    expect(store.logEvent).toHaveBeenCalledWith({ salonId: 1, packageId: PKG_ID, kind: 'webhook', payload: { packageId: PKG_ID, status: 'SIGNED', documentIds: [PKG_ID] } });
    expect(packages.refreshRows).toHaveBeenCalledWith(1, [{ id: PKG_ID, salon_id: 1 }]);
  });
  test('processWebhook: чужой комплект — без перечитывания', async () => {
    store.findPackageByAnyId.mockResolvedValue(null);
    await webhook.processWebhook(1, { packageId: 'foreign' });
    expect(packages.refreshRows).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Убедиться, что тест падает**

```bash
cd /root/loyalpro-fdoc/backend && npx jest edocs-routes
```

Ожидается: FAIL с `Cannot find module './routes/edocs'`.

- [ ] **Step 3: Роутер оформления**

Создать `backend/routes/edocs.js`:

```js
'use strict';
// /api/edocs — оформление документов: пациент, его данные, комплекты, акты.
// Роли: владелец, администратор, администратор-кассир (ресепшен; префикс открыт ему в
// config.CASHIER_ALLOWED_PREFIXES). Паспорт расшифровывается только для формы данных
// (каждый показ — в журнал edoc_events) и для заполнения документов.
// ВНИМАНИЕ: поля JWT — req.user.salonId и req.user.userId (НЕ salon_id).
const router = require('express').Router();
const multer = require('multer');
const sharp = require('sharp');
const { auth, requireRole } = require('../middleware/auth');
const store = require('../services/edocs/store');
const packages = require('../services/edocs/packages');
const identity = require('../services/edocs/identity');
const s3 = require('../services/s3');
const secretBox = require('../utils/secret-box');
const { client: fdoc } = require('../services/fdoc/client');
const { linesFromRecord, doctorOf, actTotals } = require('../services/edocs/act-lines');
const { STATUSES } = require('../services/edocs/statuses');
const { EdocsError, sendError } = require('../services/edocs/errors');
const { validateImageBuffer } = require('../utils/upload-validator');
const { isCalendarDate, todayMsk } = require('../utils/period');
const { createLogger } = require('../logger');

const logger = createLogger('EdocsAPI');
const photoUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024, files: 1 } });
const MAX_RECOGNIZE_B64 = 6 * 1024 * 1024;   // предел F.Doc на base64 фото

const posInt = (v) => (/^\d{1,9}$/.test(String(v === undefined || v === null ? '' : v)) && Number(v) > 0 ? Number(v) : null);
const addDays = (iso, n) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);

/** Тело POST /packages, /packages/preview (single), /packages/check. */
function parsePackageBody(b, { single = false, today = todayMsk() } = {}) {
  b = b || {};
  const clientId = posInt(b.clientId);
  if (!clientId) return { error: 'Не выбран пациент' };
  let templateIds;
  if (single) {
    const t = posInt(b.templateId);
    if (!t) return { error: 'Не выбран шаблон' };
    templateIds = [t];
  } else {
    if (!Array.isArray(b.templateIds) || !b.templateIds.length || b.templateIds.length > packages.MAX_DOCS) return { error: `Выберите от 1 до ${packages.MAX_DOCS} документов` };
    templateIds = b.templateIds.map(posInt);
    if (templateIds.some((x) => !x)) return { error: 'Неверный шаблон' };
    templateIds = [...new Set(templateIds)];
  }
  let recordId = null;
  if (b.recordId !== undefined && b.recordId !== null && b.recordId !== '') {
    recordId = posInt(b.recordId);
    if (!recordId) return { error: 'Неверный визит' };
  }
  let docDate = null;
  if (b.docDate !== undefined && b.docDate !== null && b.docDate !== '') {
    docDate = String(b.docDate);
    if (!isCalendarDate(docDate) || docDate < addDays(today, -366) || docDate > addDays(today, 30)) return { error: 'Дата документа: от года назад до 30 дней вперёд' };
  }
  if (b.actLines !== undefined && b.actLines !== null && !Array.isArray(b.actLines)) return { error: 'Строки акта — список' };
  return { value: { clientId, templateIds, recordId, docDate, actLines: b.actLines || null } };
}

function packageView(p) {
  return {
    id: p.id, kind: p.kind, title: p.title, status: p.status, fdocStatus: p.fdoc_status || null,
    clientId: p.client_id, clientName: p.client_name || null, clientPhone: p.client_phone || null, recordId: p.record_id || null,
    sentAt: p.sent_at || null, signedAt: p.signed_at || null, sentByName: p.sent_by_name || null, lastError: p.last_error || null,
    createdAt: p.created_at, lastStatusCheckAt: p.last_status_check_at || null,
  };
}

router.use(auth, requireRole('owner', 'admin', 'admin_cashier'));

// ── состояние модуля и учётная запись F.Doc текущего пользователя ──
router.get('/state', async (req, res) => {
  try {
    const s = await store.getSettings(req.user.salonId);
    const c = await store.getCredentials(req.user.salonId, req.user.userId);
    res.json({
      enabled: !!(s && s.enabled), configured: !!(s && s.corp_id), encReady: secretBox.isConfigured(), role: req.user.role,
      me: { connected: !!c, login: c ? c.login : null, broken: !!(c && c.fail_count >= 3), lastError: (c && c.last_error) || null },
    });
  } catch (e) { sendError(res, e, logger, 'edocs state'); }
});

router.put('/me/credentials', async (req, res) => {
  const b = req.body || {};
  const login = typeof b.login === 'string' ? b.login.trim() : '';
  const password = typeof b.password === 'string' ? b.password : '';
  if (!login || login.length > 200 || !password || password.length > 200) return res.status(400).json({ error: 'Укажите логин и пароль F.Doc' });
  const sid = req.user.salonId;
  try {
    const cfg = packages.fdocConfig(await store.getSettings(sid), { requireEnabled: false });
    try {
      await fdoc.checkCredentials(cfg, { userId: req.user.userId, login, password });
    } catch (e) {
      if (e && e.code === 'fdoc_credentials_invalid') return res.status(400).json({ error: 'F.Doc не принял логин или пароль', code: e.code });
      throw e;
    }
    await store.saveCredentials(sid, req.user.userId, login, secretBox.box().encrypt(password));
    await store.logEvent({ salonId: sid, kind: 'credentials', userId: req.user.userId, payload: { action: 'save', login } });
    res.json({ ok: true });
  } catch (e) { sendError(res, e, logger, 'edocs credentials save'); }
});

router.delete('/me/credentials', async (req, res) => {
  const sid = req.user.salonId;
  try {
    const s = await store.getSettings(sid);
    await store.deleteCredentials(sid, req.user.userId);
    if (s && s.corp_id) fdoc.forget(s.corp_id, req.user.userId);
    await store.logEvent({ salonId: sid, kind: 'credentials', userId: req.user.userId, payload: { action: 'delete' } });
    res.json({ ok: true });
  } catch (e) { sendError(res, e, logger, 'edocs credentials delete'); }
});

router.get('/templates', async (req, res) => {
  try {
    const rows = await store.listTemplates(req.user.salonId, { activeOnly: true });
    res.json({ templates: rows.map((t) => ({ id: t.id, kind: t.kind, title: t.title, placeholders: t.placeholders || [] })) });
  } catch (e) { sendError(res, e, logger, 'edocs templates'); }
});

// ── пациенты и их данные ──
router.get('/clients', async (req, res) => {
  const q = String(req.query.search || '').trim().slice(0, 100);
  if (q.length < 2) return res.json({ clients: [] });
  try {
    const rows = await store.searchClients(req.user.salonId, q, 20);
    res.json({ clients: rows.map((c) => ({ id: c.id, name: c.name, phone: c.phone, hasIdentity: !!c.has_identity })) });
  } catch (e) { sendError(res, e, logger, 'edocs clients search'); }
});

// Сводка по пациенту. Отдаётся и при выключенном модуле: мастер оформления работает без
// F.Doc (данные, проверка документов), блокируется только отправка; блок в карточке
// клиента сам прячется по enabled:false.
router.get('/clients/:id/summary', async (req, res) => {
  const id = posInt(req.params.id);
  const sid = req.user.salonId;
  try {
    const s = await store.getSettings(sid);
    const client = id ? await store.getClient(sid, id) : null;
    if (!client) return res.status(404).json({ error: 'Пациент не найден' });
    const row = await store.getIdentityRow(sid, id);
    let passportMask = '';
    if (row && row.secure_enc) {
      try { passportMask = identity.maskPassport(secretBox.box().decryptJson(row.secure_enc)); } catch (e) { passportMask = '— не расшифровано'; }
    }
    res.json({
      enabled: !!(s && s.enabled),
      client: { id: client.id, name: client.name, phone: client.phone },
      identity: row ? {
        exists: true, fio: [row.last_name, row.first_name, row.middle_name].filter(Boolean).join(' '), birthDate: row.birth_date,
        passportMask, secureFields: row.secure_fields || [], updatedAt: row.updated_at,
      } : { exists: false },
      packages: (await store.listClientPackages(sid, id, 10)).map((p) => ({ id: p.id, kind: p.kind, title: p.title, status: p.status, createdAt: p.created_at, signedAt: p.signed_at })),
    });
  } catch (e) { sendError(res, e, logger, 'edocs client summary'); }
});

router.get('/clients/:id/identity', async (req, res) => {
  const id = posInt(req.params.id);
  const sid = req.user.salonId;
  try {
    const client = id ? await store.getClient(sid, id) : null;
    if (!client) return res.status(404).json({ error: 'Пациент не найден' });
    const row = await store.getIdentityRow(sid, id);
    if (!row) return res.json({ exists: false });
    const decoded = identity.decodeRow(row, row.secure_enc ? secretBox.box() : null);
    if (row.secure_enc) await store.logEvent({ salonId: sid, clientId: id, kind: 'identity_view', userId: req.user.userId });
    res.json({ exists: true, plain: decoded.plain, secure: decoded.secure, source: row.source, updatedAt: row.updated_at });
  } catch (e) { sendError(res, e, logger, 'edocs identity get'); }
});

router.get('/clients/:id/identity/prefill', async (req, res) => {
  const id = posInt(req.params.id);
  const sid = req.user.salonId;
  try {
    const client = id ? await store.getClient(sid, id) : null;
    if (!client) return res.status(404).json({ error: 'Пациент не найден' });
    const r = identity.prefillFrom(client, await store.getLatestCertRequest(sid, id));
    if (Object.keys(r.secure).length) await store.logEvent({ salonId: sid, clientId: id, kind: 'identity_prefill', userId: req.user.userId });
    res.json(r);
  } catch (e) { sendError(res, e, logger, 'edocs identity prefill'); }
});

router.put('/clients/:id/identity', async (req, res) => {
  const id = posInt(req.params.id);
  const v = identity.validateIdentity(req.body);
  if (v.error) return res.status(400).json({ error: v.error });
  const sid = req.user.salonId;
  try {
    const client = id ? await store.getClient(sid, id) : null;
    if (!client) return res.status(404).json({ error: 'Пациент не найден' });
    const enc = identity.encodeSecure(v.value.secure, secretBox.box());
    const source = req.body && req.body.source === 'recognize' ? 'recognize' : 'manual';
    await store.upsertIdentity(sid, id, { plain: v.value.plain, secure_enc: enc.secure_enc, secure_fields: enc.secure_fields, source, userId: req.user.userId });
    await store.logEvent({ salonId: sid, clientId: id, kind: 'identity_edit', userId: req.user.userId, payload: {
      plain: Object.keys(v.value.plain).filter((k) => v.value.plain[k]), secure: enc.secure_fields, source,
    } });
    res.json({ ok: true });
  } catch (e) { sendError(res, e, logger, 'edocs identity save'); }
});

// Фото паспорта → поля формы через F.Doc. Фото у нас не сохраняется.
router.post('/clients/:id/identity/recognize', (req, res, next) => {
  photoUpload.single('photo')(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'Фото больше 15 МБ' : 'Не удалось принять фото' });
    if (!req.file) return res.status(400).json({ error: 'Приложите фото паспорта' });
    return next();
  });
}, async (req, res) => {
  const id = posInt(req.params.id);
  const sid = req.user.salonId;
  try {
    const client = id ? await store.getClient(sid, id) : null;
    if (!client) return res.status(404).json({ error: 'Пациент не найден' });
    const check = validateImageBuffer(req.file.buffer, req.file.originalname);
    if (!check.ok) return res.status(400).json({ error: check.error });
    const jpeg = await sharp(req.file.buffer).rotate().resize({ width: 2400, height: 2400, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 85 }).toBuffer();
    const b64 = jpeg.toString('base64');
    if (b64.length > MAX_RECOGNIZE_B64) return res.status(400).json({ error: 'Фото слишком большое даже после сжатия' });
    const cfg = packages.fdocConfig(await store.getSettings(sid));
    const cred = await packages.credFor(sid, req.user.userId);
    const result = await fdoc.recognize(cfg, cred, b64, 'jpg');
    await store.logEvent({ salonId: sid, clientId: id, kind: 'recognize', userId: req.user.userId, payload: { recognized: !!result } });
    if (!result) return res.status(422).json({ error: 'F.Doc не распознал документ на фото — сфотографируйте разворот целиком' });
    res.json(identity.fromRecognized(result));
  } catch (e) { sendError(res, e, logger, 'edocs recognize'); }
});

// ── визиты и акты ──
router.get('/clients/:id/records', async (req, res) => {
  const id = posInt(req.params.id);
  try {
    const client = id ? await store.getClient(req.user.salonId, id) : null;
    if (!client) return res.status(404).json({ error: 'Пациент не найден' });
    const rows = await store.listClientVisits(req.user.salonId, id, 20);
    res.json({ records: rows.map((r) => ({
      id: r.id, visitDate: r.visit_date, staffName: doctorOf(r.staff).name,
      services: (Array.isArray(r.services) ? r.services : []).map((s) => s.title).filter(Boolean),
      total: actTotals(linesFromRecord(r.services)).total_sum,
      act: r.act_package_id ? { packageId: r.act_package_id, status: r.act_status } : null,
    })) });
  } catch (e) { sendError(res, e, logger, 'edocs client records'); }
});

router.get('/records/act-status', async (req, res) => {
  const ids = String(req.query.ids || '').split(',').map(posInt).filter(Boolean).slice(0, 200);
  const sid = req.user.salonId;
  try {
    const s = await store.getSettings(sid);
    if (!s || !s.enabled) return res.json({ enabled: false, statuses: {} });
    const rows = ids.length ? await store.actStatusesForRecords(sid, ids) : [];
    res.json({ enabled: true, statuses: Object.fromEntries(rows.map((r) => [r.record_id, { packageId: r.package_id, status: r.status }])) });
  } catch (e) { sendError(res, e, logger, 'edocs act statuses'); }
});

router.get('/records/:id/act-draft', async (req, res) => {
  const id = posInt(req.params.id);
  try {
    const r = id ? await store.getRecord(req.user.salonId, id) : null;
    if (!r) return res.status(404).json({ error: 'Визит не найден' });
    if (r.attendance !== '1' || r.deleted) return res.status(409).json({ error: 'Акт оформляется только по состоявшемуся визиту' });
    const lines = linesFromRecord(r.services);
    res.json({
      record: { id: r.id, clientId: r.client_id, visitDate: r.visit_date, actNo: String(r.yclients_record_id || r.id) },
      doctor: doctorOf(r.staff), lines, totals: actTotals(lines),
    });
  } catch (e) { sendError(res, e, logger, 'edocs act draft'); }
});

// ── комплекты ── (статические пути — ДО /packages/:id)
router.post('/packages/check', async (req, res) => {
  const p = parsePackageBody(req.body);
  if (p.error) return res.status(400).json({ error: p.error });
  try { res.json(await packages.check({ salonId: req.user.salonId, clientId: p.value.clientId, templateIds: p.value.templateIds })); }
  catch (e) { sendError(res, e, logger, 'edocs check'); }
});

router.post('/packages/preview', async (req, res) => {
  const p = parsePackageBody(req.body, { single: true });
  if (p.error) return res.status(400).json({ error: p.error });
  try {
    res.json(await packages.preview({ salonId: req.user.salonId, userId: req.user.userId, clientId: p.value.clientId, templateId: p.value.templateIds[0],
      recordId: p.value.recordId, actLines: p.value.actLines, docDate: p.value.docDate }));
  } catch (e) { sendError(res, e, logger, 'edocs preview'); }
});

router.post('/packages', async (req, res) => {
  const p = parsePackageBody(req.body);
  if (p.error) return res.status(400).json({ error: p.error });
  try { res.json(await packages.send({ salonId: req.user.salonId, userId: req.user.userId, ...p.value })); }
  catch (e) { sendError(res, e, logger, 'edocs send'); }
});

router.get('/packages', async (req, res) => {
  const q = req.query || {};
  const status = STATUSES.includes(q.status) ? q.status : null;
  const clientId = posInt(q.clientId);
  const from = isCalendarDate(q.from) ? q.from : null;
  const to = isCalendarDate(q.to) ? q.to : null;
  const page = posInt(q.page) || 1;
  try {
    const r = await store.listPackages(req.user.salonId, { status, clientId, from, to, limit: 50, offset: (page - 1) * 50 });
    res.json({ total: r.total, page, rows: r.rows.map(packageView) });
  } catch (e) { sendError(res, e, logger, 'edocs packages list'); }
});

// id комплекта — UUID: иначе pg бросит «invalid input syntax for type uuid» вместо 404.
function validPackageId(req, res) {
  if (store.UUID_RE.test(String(req.params.id))) return true;
  res.status(404).json({ error: 'Комплект не найден' });
  return false;
}

router.get('/packages/:id', async (req, res) => {
  if (!validPackageId(req, res)) return;
  const sid = req.user.salonId;
  try {
    const p = await store.getPackage(sid, req.params.id);
    if (!p) return res.status(404).json({ error: 'Комплект не найден' });
    const [docs, events] = await Promise.all([store.listDocuments(p.id), store.listEvents(sid, p.id, 30)]);
    res.json({
      ...packageView(p),
      act: (p.payload && p.payload.act) || null,
      patient: (p.payload && p.payload.patient) || null,
      documents: docs.map((d) => ({ id: d.id, title: d.title, fileName: d.file_name, fdocStatus: d.fdoc_status || null,
        clientSignedAt: d.client_signed_at || null, corpSignedAt: d.corp_signed_at || null, hasPdf: !!d.pdf_key })),
      events: events.map((e) => ({ kind: e.kind, payload: e.payload, createdAt: e.created_at, userName: e.user_name || null })),
    });
  } catch (e) { sendError(res, e, logger, 'edocs package get'); }
});

for (const [action, fn] of [['resend', packages.resend], ['employee-url', packages.employeeUrl], ['permalink', packages.permalink], ['annul', packages.annul]]) {
  router.post(`/packages/:id/${action}`, async (req, res) => {
    if (!validPackageId(req, res)) return;
    try { res.json(await fn({ salonId: req.user.salonId, userId: req.user.userId, packageId: req.params.id })); }
    catch (e) { sendError(res, e, logger, `edocs ${action}`); }
  });
}

router.post('/packages/:id/refresh', async (req, res) => {
  if (!validPackageId(req, res)) return;
  const sid = req.user.salonId;
  try {
    const p = await store.getPackage(sid, req.params.id);
    if (!p) return res.status(404).json({ error: 'Комплект не найден' });
    if (p.status === 'draft') throw new EdocsError('not_sent', 'Комплект ещё не принят F.Doc — повторите отправку', 409);
    res.json(await packages.refreshRows(sid, [p]));
  } catch (e) { sendError(res, e, logger, 'edocs refresh'); }
});

router.get('/documents/:id/pdf', async (req, res) => {
  if (!store.UUID_RE.test(String(req.params.id))) return res.status(404).json({ error: 'Документ не найден' });
  try {
    const d = await store.getDocument(req.user.salonId, req.params.id);
    if (!d) return res.status(404).json({ error: 'Документ не найден' });
    if (!d.pdf_key) return res.status(409).json({ error: 'Подписанный PDF ещё не получен — он скачается после подписи пациента' });
    res.json({ url: await s3.presignGet(d.pdf_key, 900) });
  } catch (e) { sendError(res, e, logger, 'edocs pdf'); }
});

module.exports = router;
module.exports.parsePackageBody = parsePackageBody;
```

- [ ] **Step 4: Вебхук F.Doc**

Создать `backend/routes/fdoc-webhook.js`:

```js
'use strict';
// Вебхук F.Doc SetStatus: POST /fdoc/webhook/<секрет салона>. Без JWT: F.Doc не умеет
// заголовок авторизации, поэтому секрет — часть URL (рекомендация самого F.Doc).
// Тело НЕ доверяется: это лишь сигнал «перечитай статус комплекта», статус берём из
// API под нашим токеном. Ответ 200 сразу (как routes/webhook.js), обработка — асинхронно
// и идемпотентно: недоставленный вебхук F.Doc повторяет до 10 раз.
const router = require('express').Router();
const store = require('../services/edocs/store');
const packages = require('../services/edocs/packages');
const { createLogger } = require('../logger');

const logger = createLogger('FdocWebhook');
const SECRET_RE = /^[a-f0-9]{32,64}$/;
const FIELDS = ['employeeId', 'clientId', 'packageId', 'actionStatus', 'status', 'statusName', 'comment'];

// В журнал — только известные поля, строки обрезаны: тело присылает внешняя сторона.
function pick(body) {
  const out = {};
  for (const k of FIELDS) if (typeof body[k] === 'string') out[k] = body[k].slice(0, 300);
  if (Array.isArray(body.documentIds)) out.documentIds = body.documentIds.filter((x) => typeof x === 'string').slice(0, 20).map((x) => x.slice(0, 100));
  return out;
}

// ВНИМАНИЕ: не называть экспорт `handle` — это внутренний метод express.Router,
// перезапись ломает весь роутер (поймано тестом при подготовке плана).
async function processWebhook(salonId, body) {
  await store.touchWebhook(salonId);
  const b = body && typeof body === 'object' ? body : {};
  const packageId = typeof b.packageId === 'string' ? b.packageId.slice(0, 100) : null;
  await store.logEvent({ salonId, packageId, kind: 'webhook', payload: pick(b) });
  if (!packageId) return;
  const row = await store.findPackageByAnyId(salonId, packageId);
  if (!row) { logger.info(`fdoc webhook: комплект ${packageId} не наш (салон ${salonId})`); return; }
  await packages.refreshRows(salonId, [row]);
}

router.post('/webhook/:secret', async (req, res) => {
  const secret = String(req.params.secret || '');
  if (!SECRET_RE.test(secret)) return res.status(404).end();
  let salonId;
  try { salonId = await store.findSalonByWebhookSecret(secret); } catch (e) {
    logger.warn(`fdoc webhook: ${e.message}`);
    return res.status(503).end();
  }
  if (!salonId) return res.status(404).end();
  res.status(200).json({ ok: true });
  processWebhook(salonId, req.body).catch((e) => logger.warn(`fdoc webhook salon ${salonId}: ${e.message}`));
});

module.exports = router;
module.exports.processWebhook = processWebhook;
```

- [ ] **Step 5: Тест проходит**

```bash
cd /root/loyalpro-fdoc/backend && npx jest edocs-routes 2>&1 | grep -E "Tests:"
```

Ожидается: `Tests: 16 passed, 16 total`.

- [ ] **Step 6: Кассиру — префикс модуля**

В `backend/config.js` найти:

```js
  SPECIALIST_ALLOWED_PREFIXES,
  // Администратор-кассир: те же права, что у специалиста, плюс доступ к чату.
  CASHIER_ALLOWED_PREFIXES: [...SPECIALIST_ALLOWED_PREFIXES, '/api/chat'],

  // S3 (patient photo cases — Yandex Object Storage / S3-compatible)
```

заменить на:

```js
  SPECIALIST_ALLOWED_PREFIXES,
  // Администратор-кассир: те же права, что у специалиста, плюс доступ к чату.
  // и к «Документам» (оформление на ресепшене; /api/edocs/admin закрыт ему самим роутером).
  CASHIER_ALLOWED_PREFIXES: [...SPECIALIST_ALLOWED_PREFIXES, '/api/chat', '/api/edocs'],

  // S3 (patient photo cases — Yandex Object Storage / S3-compatible)
```

- [ ] **Step 7: Монтирование: вебхук до guard**

В `backend/routes/index.js` найти:

```js
  // свой секрет (GATEWAY_WEBHOOK_SECRET), салон — по messenger_accounts.
  app.use('/gateway', require('./chatpush-webhook'));

  // ── Публичная форма заявки на справку (БЕЗ JWT — монтируем до guard) ──
```

заменить на:

```js
  // свой секрет (GATEWAY_WEBHOOK_SECRET), салон — по messenger_accounts.
  app.use('/gateway', require('./chatpush-webhook'));

  // ── F.Doc — вебхук статусов «Документов» (no JWT, секрет салона в URL) ──
  app.use('/fdoc', require('./fdoc-webhook'));

  // ── Публичная форма заявки на справку (БЕЗ JWT — монтируем до guard) ──
```

- [ ] **Step 8: Монтирование: admin-роутер раньше общего**

В `backend/routes/index.js` найти:

```js
  app.use('/api/medical-cert',      require('./medical-cert'));
  app.use('/api/economics',         require('./economics'));

  app.use('/api/analytics/messengers/verdicts', require('./dialog-verdicts'));
```

заменить на:

```js
  app.use('/api/medical-cert',      require('./medical-cert'));
  app.use('/api/economics',         require('./economics'));
  // «Документы»: admin-роутер ДО общего — иначе /api/edocs поймал бы и /api/edocs/admin/*.
  app.use('/api/edocs/admin',       require('./edocs-admin'));
  app.use('/api/edocs',             require('./edocs'));

  app.use('/api/analytics/messengers/verdicts', require('./dialog-verdicts'));
```

- [ ] **Step 9: Крон опроса статусов**

В `backend/server.js` найти:

```js
}, { timezone: 'Europe/Moscow' });

// ============================================================
// START
```

заменить на:

```js
}, { timezone: 'Europe/Moscow' });

// «Документы» (F.Doc): опрос статусов комплектов — страховка к вебхуку SetStatus и
// докачка подписанных PDF в S3. EDOCS_POLL=false гасит только опрос (вебхук работает).
// Подробности — services/edocs/packages.js (refreshDue).
if (process.env.EDOCS_POLL !== 'false') {
  cron.schedule('*/5 * * * *', async () => {
    try {
      const r = await require('./services/edocs/packages').refreshDue();
      if (r && r.changed) cronLogger.info(`edocs: проверено комплектов=${r.checked}, изменился статус=${r.changed}`);
    } catch (e) { cronLogger.error(`edocs poll: ${e.message}`); }
  }, { timezone: 'Europe/Moscow' });
}

// ============================================================
// START
```

- [ ] **Step 10: Роутеры монтируются, весь модуль зелёный**

```bash
cd /root/loyalpro-fdoc/backend && timeout 30 node -e "
const app = require('express')(); require('./routes/index')(app);
console.log(app._router.stack.filter(l => l.name === 'router' && /edocs|fdoc/.test(String(l.regexp))).map(l => String(l.regexp)).join('\n'));
process.exit(0)" && node --check server.js && npx jest edocs 2>&1 | grep -E "Tests:|Suites:"
```

Ожидается: три строки: `/^\/fdoc\/?…`, `/^\/api\/edocs\/admin\/?…`, `/^\/api\/edocs\/?…`; `Test Suites: 9 passed`; `Tests: 151 passed, 151 total`.

- [ ] **Step 11: Commit**

```bash
cd /root/loyalpro-fdoc && git add backend/routes/edocs.js backend/routes/fdoc-webhook.js backend/edocs-routes.test.js backend/config.js backend/routes/index.js backend/server.js && git commit -m "feat(edocs): /api/edocs для оформления, вебхук F.Doc, крон опроса статусов

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 12: Контрольная точка A — **Fable** (основная сессия)

Бэкенд готов. Ревью — инлайн, без фоновых агентов.

- [ ] **Step 1: Модуль и соседи зелёные**

```bash
cd /root/loyalpro-fdoc/backend && npx jest edocs agent-person-name 2>&1 | grep -E "Tests:|Suites:"
```

Ожидается: `Test Suites: 10 passed`; `Tests: 179 passed`.

- [ ] **Step 2: Полный jest: падения те же, что на базе**

```bash
cd /root/loyalpro-fdoc/backend && npx jest --testPathIgnorePatterns primary-clients 2>&1 | grep -E "^FAIL" | sed -E 's/ \(.*\)$//' | sort -u > /tmp/edocs-branch-fails.txt
cd /root/loyalpro/backend && npx jest --testPathIgnorePatterns primary-clients 2>&1 | grep -E "^FAIL" | sed -E 's/ \(.*\)$//' | sort -u > /tmp/edocs-base-fails.txt
diff /tmp/edocs-base-fails.txt /tmp/edocs-branch-fails.txt && echo "падения совпадают с базой"
```

Ожидается: «падения совпадают с базой». `primary-clients` исключён: известный флейк (`process.exit(1)` и висящий pg ломают соседний набор). Если в основном дереве есть незакоммиченные правки, база сравнения — это они; расхождение только в наборах `edocs-*` — дефект ветки.

- [ ] **Step 3: Ревью диффа**

```bash
cd /root/loyalpro-fdoc && git diff feat/notifications-own-module...HEAD --stat && git diff feat/notifications-own-module...HEAD -- backend/ | grep -nE "console\.log|apiKey|password" | grep -v test | head -40
```

Проверить глазами: каждый SQL ограничен `salon_id`; пароли, ключ API и паспорт не попадают в логи и ответы (только маска и признаки); тело вебхука не используется как статус; повтор отправки идёт с теми же id. Итог — короткий отчёт пользователю в чат.

---

## Часть B. Фронт

### Task 13: Чистые помощники фронта — **Sonnet**

Без DOM: подписи и цвета статусов (классы существующих бейджей `bg`/`bb`/`bo`/`br`/`bgr`), разбор хвоста адреса, форматы, текст «чего не хватает», итоги и сбор строк акта (зеркало серверной проверки), тело формы данных. Глобальные имена — с префиксом `ed`/`ED_`: все скрипты страницы делят одну область, и верхнеуровневый `const` с занятым именем гасит весь файл. Тест в этой задаче — промежуточный (7 тестов); задача 14 заменит его итоговой версией.

**Files:**
- Create: `frontend/js/pages/edocs-helpers.js`
- Test: `frontend/js/pages/edocs.test.js` (промежуточная версия)

- [ ] **Step 1: Написать падающий тест**

Создать `frontend/js/pages/edocs.test.js`:

```js
// «📄 Документы»: чистые помощники edocs-helpers.js и паритет справочников с бэкендом.
// (Задача 14 плана заменит файл итоговой версией с проверками страницы и разметки.)
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
for (const f of ['js/core/utils.js', 'js/core/api.js', 'js/pages/edocs-helpers.js']) run(ctx, f, fs.readFileSync(path.join(FRONT, f), 'utf8'));
const k = (name) => vm.runInContext(name, ctx);

test('edocs-helpers.js грузится в одну область с core', () => {
  for (const name of ['edParseTail', 'edActTotals', 'edCollectActLines', 'edIdentityBody', 'edMissingText', 'edStatusInfo']) {
    assert.strictEqual(typeof ctx[name], 'function', `${name} не определена`);
  }
});

test('edParseTail: адреса страницы', () => {
  const id = '11111111-1111-4111-8111-111111111111';
  assert.deepStrictEqual(plain(k('edParseTail')('')), { view: 'list' });
  assert.deepStrictEqual(plain(k('edParseTail')('settings')), { view: 'settings' });
  assert.deepStrictEqual(plain(k('edParseTail')('new')), { view: 'new', clientId: null, recordId: null });
  assert.deepStrictEqual(plain(k('edParseTail')('new/52')), { view: 'new', clientId: 52, recordId: null });
  assert.deepStrictEqual(plain(k('edParseTail')('new/52/30252')), { view: 'new', clientId: 52, recordId: 30252 });
  assert.deepStrictEqual(plain(k('edParseTail')('new/abc/1')), { view: 'new', clientId: null, recordId: null });
  assert.deepStrictEqual(plain(k('edParseTail')('p/' + id.toUpperCase())), { view: 'package', packageId: id });
  assert.deepStrictEqual(plain(k('edParseTail')('p/123')), { view: 'list' });
  assert.deepStrictEqual(plain(k('edParseTail')('garbage')), { view: 'list' });
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

test('паритет справочников фронта с бэкендом', () => {
  const ph = require(path.join(BACK, 'services/edocs/placeholders.js'));
  const st = require(path.join(BACK, 'services/edocs/statuses.js'));
  const id = require(path.join(BACK, 'services/edocs/identity.js'));
  assert.deepStrictEqual(Object.keys(plain(k('ED_KIND_LABELS'))), ph.KINDS);
  assert.deepStrictEqual(plain(k('ED_ORG_FIELDS')).map((f) => f[0]), ph.ORG_KEYS);
  assert.deepStrictEqual(Object.keys(plain(k('ED_STATUS'))).sort(), [...st.STATUSES].sort());
  assert.deepStrictEqual(plain(k('ED_PLAIN_FIELDS')).map((f) => f[0]), id.PLAIN_KEYS);
  assert.deepStrictEqual(plain(k('ED_SECURE_FIELDS')).map((f) => f[0]).sort(), [...id.SECURE_KEYS].sort());
});
```

- [ ] **Step 2: Убедиться, что тест падает**

```bash
cd /root/loyalpro-fdoc && node --test frontend/js/pages/edocs.test.js 2>&1 | tail -5
```

Ожидается: `# fail` больше 0: `ENOENT … edocs-helpers.js`.

- [ ] **Step 3: Реализация**

Создать `frontend/js/pages/edocs-helpers.js`:

```js
// ── «📄 ДОКУМЕНТЫ»: чистые помощники без DOM ─────────────────────────────────────
// Тесты: node --test frontend/js/pages/edocs.test.js (грузит этот файл вместе со всеми
// скриптами index.html в один vm-контекст — общая глобальная область браузера).
// Имена — с префиксом ed/ED_: верхнеуровневый const с занятым именем гасит весь файл.

const ED_STATUS = {
  draft:    { label: 'Не отправлен',       cls: 'bgr' },
  sent:     { label: 'Ждёт подписи',       cls: 'bb' },
  signed:   { label: 'Подписан',           cls: 'bg' },
  paper:    { label: 'Подписан на бумаге', cls: 'bg' },
  error:    { label: 'Ошибка F.Doc',       cls: 'bo' },
  declined: { label: 'Пациент отказался',  cls: 'br' },
  annulled: { label: 'Аннулирован',        cls: 'br' },
  expired:  { label: 'Срок истёк',         cls: 'br' },
};
const ED_FINAL = ['declined', 'annulled', 'expired', 'paper'];
const ED_KIND_LABELS = { contract: 'Договор', consent_pd: 'Согласие на обработку ПДн', act: 'Акт оказанных услуг', other: 'Другой документ' };
const ED_PLAIN_FIELDS = [
  ['last_name', 'Фамилия'], ['first_name', 'Имя'], ['middle_name', 'Отчество'], ['birth_date', 'Дата рождения'],
  ['gender', 'Пол'], ['phone', 'Телефон'], ['email', 'E-mail'], ['contract_no', 'Номер договора'], ['contract_date', 'Дата договора'],
];
const ED_SECURE_FIELDS = [
  ['passport_series', 'Серия'], ['passport_number', 'Номер'], ['issue_date', 'Дата выдачи'], ['authority_code', 'Код подразделения'],
  ['issued_by', 'Кем выдан'], ['birth_place', 'Место рождения'], ['address', 'Адрес регистрации'],
];
const ED_EVENT_LABELS = {
  send: 'Отправлен в F.Doc', send_error: 'F.Doc не принял комплект', send_recovered: 'Найден в F.Doc после сбоя связи',
  status: 'Статус изменился', webhook: 'Уведомление F.Doc', pdf: 'Подписанные PDF получены', permalink: 'Ссылка отправлена пациенту ещё раз',
  annul: 'Аннулирован',
};
const ED_ORG_FIELDS = [
  ['name', 'Полное наименование'], ['inn', 'ИНН'], ['kpp', 'КПП'], ['ogrn', 'ОГРН'], ['address', 'Адрес'], ['license', 'Лицензия'],
  ['phone', 'Телефон'], ['bank', 'Банковские реквизиты'], ['signer_position', 'Должность подписанта'], ['signer_name', 'ФИО подписанта'], ['city', 'Город'],
];

function edStatusInfo(status) { return ED_STATUS[status] || { label: status || '—', cls: 'bgr' }; }
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

function edFmtDate(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ''));
  return m ? m[3] + '.' + m[2] + '.' + m[1] : '—';
}
function edFmtDateTime(ts) {
  if (!ts) return '—';
  const d = new Date(ts);
  if (isNaN(d)) return '—';
  return d.toLocaleString('ru-RU', { timeZone: 'Europe/Moscow', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }).replace(',', '');
}
function edMoney(n) {
  const v = Math.round(Number(n || 0) * 100) / 100;
  return v.toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' ₽';
}
function edPhone(p) {
  const d = String(p || '').replace(/\D/g, '');
  if (!/^7\d{10}$/.test(d)) return String(p || '');
  return '+7 (' + d.slice(1, 4) + ') ' + d.slice(4, 7) + '-' + d.slice(7, 9) + '-' + d.slice(9);
}
/** Число из поля ввода: «3 500,50» → 3500.5; пусто или мусор → NaN. */
function edNum(v) {
  if (typeof v === 'number') return v;
  const s = String(v === undefined || v === null ? '' : v).replace(/[\s ]/g, '').replace(',', '.');
  return s === '' ? NaN : Number(s);
}

/** Ответ сервера { identity: [{key,label}], org: [...] } → строка для формы. */
function edMissingText(missing) {
  if (!missing) return '';
  const parts = [];
  if (missing.identity && missing.identity.length) parts.push('Не хватает данных пациента: ' + missing.identity.map((x) => x.label).join(', '));
  if (missing.org && missing.org.length) parts.push('Не заполнены реквизиты клиники: ' + missing.org.map((x) => x.label).join(', '));
  return parts.join('. ');
}

/** Итоги акта как на сервере (act-lines.actTotals): скидка строки = qty × price − sum, не меньше 0. */
function edActTotals(lines) {
  let total = 0, discount = 0;
  for (const l of lines || []) {
    const qty = edNum(l.qty), price = edNum(l.price), sum = edNum(l.sum);
    if (!(qty > 0) || !(price >= 0) || !(sum >= 0)) continue;
    total += sum;
    discount += Math.max(0, qty * price - sum);
  }
  return { total: Math.round(total * 100) / 100, discount: Math.round(discount * 100) / 100 };
}

/** Строки акта из формы → тело запроса; ошибка — с номером строки (сервер проверит ещё раз). */
function edCollectActLines(rows) {
  const out = [];
  for (let i = 0; i < (rows || []).length; i++) {
    const r = rows[i];
    if (!r.include) continue;
    const title = String(r.title || '').replace(/\s+/g, ' ').trim();
    const qty = edNum(r.qty), price = edNum(r.price), sum = edNum(r.sum);
    if (!title) return { error: 'Строка ' + (i + 1) + ': пустое название' };
    if (!(qty > 0)) return { error: 'Строка ' + (i + 1) + ': количество больше 0' };
    if (!(price >= 0) || !(sum >= 0)) return { error: 'Строка ' + (i + 1) + ': цена и сумма — числа от 0' };
    out.push({ service_id: r.service_id || null, title: title, qty: qty, price: price, sum: sum });
  }
  if (!out.length) return { error: 'Отметьте хотя бы одну услугу' };
  return { value: out };
}

/** Тело PUT /clients/:id/identity из значений формы; get(key) возвращает значение поля. */
function edIdentityBody(get, source) {
  const body = { secure: {} };
  for (const f of ED_PLAIN_FIELDS) body[f[0]] = String(get(f[0]) || '').trim();
  for (const f of ED_SECURE_FIELDS) body.secure[f[0]] = String(get(f[0]) || '').trim();
  if (source) body.source = source;
  return body;
}
```

- [ ] **Step 4: Тест проходит**

```bash
cd /root/loyalpro-fdoc && node --test frontend/js/pages/edocs.test.js 2>&1 | grep -E "^# (pass|fail)"
```

Ожидается: `# pass 7`, `# fail 0`.

- [ ] **Step 5: Commit**

```bash
cd /root/loyalpro-fdoc && git add frontend/js/pages/edocs-helpers.js frontend/js/pages/edocs.test.js && git commit -m "feat(edocs): чистые помощники страницы «Документы»

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 14: Страница «Документы» — **Opus**

Адрес в hash (как у чата): `#edocs` — список комплектов, `#edocs/new[/<клиент>[/<запись>]]` — оформление (с записью — акт), `#edocs/p/<комплект>` — карточка, `#edocs/settings` — настройки (только владелец и администратор; остальным адрес возвращается на список). Хвост читается из `location.hash` — `nav.js` получает два крючка: `loadEdocs()` при входе на страницу и `edocsOnHashArg()` при смене хвоста; опрос статусов (30 с) гасится при уходе со страницы и выходе. `api()` проекта теряет поля ответа кроме `error`, поэтому отправка, загрузка шаблонов и распознавание идут через `edFetch` — он сохраняет `packageId`, `missing`, `details`. Окно F.Doc и PDF открываются заранее открытой вкладкой (`edOpenAsync`), иначе блокировщик всплывающих окон съест `window.open` после `await`. Таблицы на телефоне — карточки (`.mtbl` проекта), чекбоксам — `width:auto` (глобальный стиль растягивает их во всю ширину), тёмной теме — своя активная вкладка (глобальная белая).

**Files:**
- Create: `frontend/js/pages/edocs.js`
- Modify: `frontend/index.html`, `frontend/js/core/nav.js`, `frontend/css/features.css`
- Test: `frontend/js/pages/edocs.test.js` (итоговая версия без проверки встроек — её добавит задача 15)

- [ ] **Step 1: Тест страницы: заменить файл целиком**

Перезаписать `frontend/js/pages/edocs.test.js`:

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
for (const f of ['js/core/utils.js', 'js/core/api.js', 'js/pages/edocs-helpers.js', 'js/pages/edocs.js']) run(ctx, f, fs.readFileSync(path.join(FRONT, f), 'utf8'));
const k = (name) => vm.runInContext(name, ctx);

test('edocs-helpers.js и edocs.js грузятся в одну область с core', () => {
  for (const name of ['loadEdocs', 'edocsOnHashArg', 'edGo', 'edStopPolling', 'edRenderClientBlock', 'edDecorateRecords', 'edParseTail', 'edActTotals', 'edOpenMe']) {
    assert.strictEqual(typeof ctx[name], 'function', `${name} не определена`);
  }
});

test('edParseTail: адреса страницы', () => {
  const id = '11111111-1111-4111-8111-111111111111';
  assert.deepStrictEqual(plain(k('edParseTail')('')), { view: 'list' });
  assert.deepStrictEqual(plain(k('edParseTail')('settings')), { view: 'settings' });
  assert.deepStrictEqual(plain(k('edParseTail')('new')), { view: 'new', clientId: null, recordId: null });
  assert.deepStrictEqual(plain(k('edParseTail')('new/52')), { view: 'new', clientId: 52, recordId: null });
  assert.deepStrictEqual(plain(k('edParseTail')('new/52/30252')), { view: 'new', clientId: 52, recordId: 30252 });
  assert.deepStrictEqual(plain(k('edParseTail')('new/abc/1')), { view: 'new', clientId: null, recordId: null });
  assert.deepStrictEqual(plain(k('edParseTail')('p/' + id.toUpperCase())), { view: 'package', packageId: id });
  assert.deepStrictEqual(plain(k('edParseTail')('p/123')), { view: 'list' });
  assert.deepStrictEqual(plain(k('edParseTail')('garbage')), { view: 'list' });
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
  const all = browserContext();
  const bad = [];
  for (const s of scripts) { try { run(all, s.name, s.code); } catch (e) { if (e && e.name === 'SyntaxError') bad.push(`${s.name}: ${e.message}`); } }
  assert.deepStrictEqual(bad, []);
});

test('id разметки: каждый getElementById edocs.js есть в index.html или рисуется скриптом', () => {
  const html = fs.readFileSync(path.join(FRONT, 'index.html'), 'utf8');
  const src = fs.readFileSync(path.join(__dirname, 'edocs.js'), 'utf8');
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
  const script = fs.readFileSync(path.join(__dirname, 'edocs.js'), 'utf8');
  const re = /on(?:click|change|input)=\\?"(?:if\(event\.target===this\))?(?:event\.preventDefault\(\);)?([A-Za-z_]+)\(/g;
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
});
```

- [ ] **Step 2: Убедиться, что тест падает**

```bash
cd /root/loyalpro-fdoc && node --test frontend/js/pages/edocs.test.js 2>&1 | grep -E "^# (pass|fail)"
```

Ожидается: `# fail` больше 0 (`ENOENT … edocs.js`).

- [ ] **Step 3: Скрипт страницы**

Создать `frontend/js/pages/edocs.js`:

```js
// ── «📄 ДОКУМЕНТЫ»: электронное подписание с пациентами через F.Doc ─────────────
// Адрес: #edocs — комплекты; #edocs/new[/<клиент>[/<запись>]] — оформление (с записью — акт);
// #edocs/p/<комплект> — карточка; #edocs/settings — настройки (владелец, администратор).
// Состояние — в hash: F5 и «Назад» возвращают туда же (хук edocsOnHashArg в nav.js).
// Зависимости: api(), esc(), escAttr(), notify(), showLbar(), openModal()/closeModal(),
// помощники edocs-helpers.js. Глобальные имена — с префиксом ed/ED_ (общая область скриптов).
let _ed = { state: null, route: { view: 'list' }, timer: null, listStatus: '', listFrom: '', listTo: '', w: null, pkg: null };
const ED_POLL_MS = 30000;
let _edSearchTimer = null;
let _edSearchSeq = 0;

function edTail() { return (location.hash || '').slice(1).split('/').slice(1).map(decodeURIComponent).join('/'); }
function loadEdocs() { edRoute(edTail()); }
function edocsOnHashArg(arg) { edRoute(arg || ''); }
function edGo(tail) {
  const h = tail ? 'edocs/' + tail : 'edocs';
  if ((location.hash || '').slice(1) === h) edRoute(tail || ''); else location.hash = h;
}
function edStopPolling() { if (_ed.timer) { clearInterval(_ed.timer); _ed.timer = null; } }
function edIsAdmin() { return typeof ME !== 'undefined' && !!ME && (ME.role === 'owner' || ME.role === 'admin'); }

// fetch, который сохраняет всё тело ответа (api() оставляет только error): нужны
// packageId, missing, details. Файлы — FormData, JSON — opts.json.
async function edFetch(method, path, opts) {
  opts = opts || {};
  const headers = { Authorization: 'Bearer ' + localStorage.getItem('lp_tk') };
  let body;
  if (opts.form) body = opts.form;
  else if (opts.json !== undefined) { headers['Content-Type'] = 'application/json'; body = JSON.stringify(opts.json); }
  showLbar(true);
  try {
    const r = await fetch(path, { method: method, headers: headers, body: body });
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
  let route = edParseTail(tail);
  if (route.view === 'settings' && !edIsAdmin()) { history.replaceState(null, '', '#edocs'); route = { view: 'list' }; }
  _ed.route = route;
  for (const v of ['list', 'new', 'package', 'settings']) {
    const el = document.getElementById('edView-' + v);
    if (el) el.style.display = v === route.view ? '' : 'none';
  }
  for (const t of ['list', 'new', 'settings']) {
    const b = document.getElementById('edTabBtn-' + t);
    if (b) b.classList.toggle('active', t === route.view || (t === 'list' && route.view === 'package'));
  }
  const sb = document.getElementById('edTabBtn-settings');
  if (sb) sb.style.display = edIsAdmin() ? '' : 'none';
  await edLoadState();
  if (route.view === 'new') return edRenderNew(route);
  if (route.view === 'package') return edRenderPackage(route.packageId);
  if (route.view === 'settings') return edRenderSettings();
  return edRenderList();
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
  if (s && !s.enabled) msgs.push(edIsAdmin() ? 'Модуль выключен. Подключите F.Doc во вкладке «Настройки».' : 'Модуль ещё не настроен — обратитесь к администратору.');
  else if (s && !s.me.connected) msgs.push('Чтобы отправлять документы, подключите свою учётную запись F.Doc: кнопка «Мой F.Doc».');
  note.innerHTML = msgs.map((m) => '<div class="ed-note">' + esc(m) + '</div>').join('');
}

// ── список комплектов ──
async function edRenderList() {
  const box = document.getElementById('edView-list');
  if (!box) return;
  box.innerHTML = '<div class="ed-toolbar"><select id="edListStatus" onchange="edSetListStatus(this.value)"><option value="">Все статусы</option>'
    + Object.keys(ED_STATUS).map((k) => '<option value="' + k + '"' + (_ed.listStatus === k ? ' selected' : '') + '>' + esc(ED_STATUS[k].label) + '</option>').join('')
    + '</select><input type="date" id="edListFrom" value="' + escAttr(_ed.listFrom) + '" onchange="edSetListPeriod()" title="Создан с">'
    + '<input type="date" id="edListTo" value="' + escAttr(_ed.listTo) + '" onchange="edSetListPeriod()" title="Создан по"></div><div class="card ed-tbl-card"><div class="tw mtbl-wrap"><table class="mtbl"><thead><tr><th>Создан</th><th>Пациент</th><th>Комплект</th><th>Статус</th><th>Отправил</th></tr></thead>'
    + '<tbody id="edListBody"><tr><td colspan="5" class="empty">Загрузка…</td></tr></tbody></table></div></div>';
  await edLoadList();
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

// ── оформление: пациент → данные → документы → отправка ──
function edSearchClients(q) {
  clearTimeout(_edSearchTimer);
  _edSearchTimer = setTimeout(() => edDoSearch(q), 300);
}
async function edDoSearch(q) {
  const box = document.getElementById('edClientResults');
  if (!box) return;
  const seq = ++_edSearchSeq;
  const query = String(q || '').trim();
  if (query.length < 2) { box.innerHTML = ''; return; }
  try {
    const d = await api('GET', '/api/edocs/clients?search=' + encodeURIComponent(query));
    if (seq !== _edSearchSeq) return;   // запоздалый ответ на прежний ввод
    box.innerHTML = d.clients.length ? d.clients.map((c) => '<div class="ed-result" onclick="edGo(\'new/' + c.id + '\')"><span><strong>' + esc(c.name)
      + '</strong> <span class="ed-sub">' + esc(edPhone(c.phone)) + '</span></span>' + (c.hasIdentity ? '<span class="badge bg">данные есть</span>' : '') + '</div>').join('')
      : '<div class="ed-sub">Никого не нашли</div>';
  } catch (e) { box.innerHTML = '<div class="ed-err">' + esc(e.message) + '</div>'; }
}

async function edRenderNew(route) {
  const box = document.getElementById('edView-new');
  if (!box) return;
  if (!route.clientId) {
    _ed.w = null;
    box.innerHTML = '<div class="card"><div class="ed-h">Пациент</div><input type="text" id="edClientSearch" placeholder="Фамилия, имя или телефон" autocomplete="off" oninput="edSearchClients(this.value)">'
      + '<div id="edClientResults" class="ed-results"></div></div>';
    const inp = document.getElementById('edClientSearch');
    if (inp) inp.focus();
    return;
  }
  box.innerHTML = '<div class="empty">Загрузка…</div>';
  const w = { clientId: route.clientId, recordId: route.recordId, selected: new Set(), source: 'manual', docDate: '', notes: [], unsaved: false, act: null, visits: [] };
  _ed.w = w;
  try {
    const res = await Promise.all([
      api('GET', '/api/edocs/clients/' + w.clientId + '/summary'),
      api('GET', '/api/edocs/clients/' + w.clientId + '/identity'),
      api('GET', '/api/edocs/templates'),
    ]);
    const summary = res[0], ident = res[1];
    w.client = summary.client;
    w.templates = res[2].templates;
    if (ident.exists) {
      w.form = Object.assign({}, ident.plain, ident.secure);
    } else {
      const pre = await api('GET', '/api/edocs/clients/' + w.clientId + '/identity/prefill');
      w.form = Object.assign({}, pre.plain, pre.secure);
      w.notes = (pre.notes || []).slice();
      w.unsaved = true;
    }
    if (w.recordId) {
      const d = await api('GET', '/api/edocs/records/' + w.recordId + '/act-draft');
      if (d.record.clientId !== w.clientId) throw new Error('Визит не принадлежит этому пациенту');
      w.act = { visitDate: d.record.visitDate, actNo: d.record.actNo, doctor: d.doctor, rows: d.lines.map((l) => Object.assign({ include: true }, l)) };
      const actTpl = w.templates.find((t) => t.kind === 'act');
      if (actTpl) w.selected.add(actTpl.id);
    } else {
      w.visits = (await api('GET', '/api/edocs/clients/' + w.clientId + '/records')).records;
    }
  } catch (e) { box.innerHTML = '<div class="empty">' + esc(e.message) + '</div>'; return; }
  if (_ed.w !== w) return;   // пока грузили, ушли в другой раздел
  edRenderWizard();
}

function edField(key, label, type, extra) {
  const w = _ed.w;
  const val = w.form[key] === null || w.form[key] === undefined ? '' : String(w.form[key]);
  return '<div class="fg ed-f-' + key + '"><label class="fl" for="edF-' + key + '">' + esc(label) + '</label><input type="' + (type || 'text') + '" id="edF-' + key
    + '" value="' + escAttr(val) + '" ' + (extra || '') + ' oninput="edFormChanged()"></div>';
}

function edRenderWizard() {
  const w = _ed.w;
  const box = document.getElementById('edView-new');
  if (!w || !box) return;
  const tpls = w.templates.filter((t) => (w.act ? true : t.kind !== 'act'));
  box.innerHTML = '<div class="card mb ed-patient"><div><div class="ed-h">' + esc(w.client.name) + '</div><div class="ed-sub">' + esc(edPhone(w.client.phone)) + '</div></div>'
    + '<button class="btn btn-sec btn-sm" onclick="edGo(\'new\')">Другой пациент</button></div>'
    + '<div class="card mb"><div class="ed-h">1. Данные пациента для документов</div>'
    + (w.notes.length ? '<div class="ed-note">' + w.notes.map(esc).join('<br>') + '</div>' : '')
    + '<div class="ed-grid">' + edField('last_name', 'Фамилия') + edField('first_name', 'Имя') + edField('middle_name', 'Отчество')
    + edField('birth_date', 'Дата рождения', 'date')
    + '<div class="fg"><label class="fl" for="edF-gender">Пол</label><select id="edF-gender" onchange="edFormChanged()"><option value=""></option>'
    + '<option value="F"' + (w.form.gender === 'F' ? ' selected' : '') + '>женский</option><option value="M"' + (w.form.gender === 'M' ? ' selected' : '') + '>мужской</option></select></div>'
    + edField('phone', 'Телефон', 'tel') + edField('email', 'E-mail', 'email') + edField('contract_no', 'Номер договора') + edField('contract_date', 'Дата договора', 'date') + '</div>'
    + '<div class="ed-h2">Паспорт РФ</div><div class="ed-grid">'
    + edField('passport_series', 'Серия', 'text', 'inputmode="numeric" maxlength="5"') + edField('passport_number', 'Номер', 'text', 'inputmode="numeric" maxlength="7"')
    + edField('issue_date', 'Дата выдачи', 'date') + edField('authority_code', 'Код подразделения', 'text', 'maxlength="7"') + '</div>'
    + edField('issued_by', 'Кем выдан') + edField('birth_place', 'Место рождения') + edField('address', 'Адрес регистрации')
    + '<div class="ed-actions"><button class="btn btn-pri" id="edSaveIdentity" onclick="edSaveIdentity()">Сохранить данные</button>'
    + '<label class="btn btn-sec ed-file">📷 Распознать по фото паспорта<input type="file" accept="image/*" onchange="edRecognize(this)"></label>'
    + '<span id="edIdentityState" class="ed-sub">' + (w.unsaved ? 'Данные ещё не сохранены' : 'Сохранено') + '</span></div></div>'
    + '<div class="card mb"><div class="ed-h">2. ' + (w.act ? 'Акт по визиту ' + esc(edFmtDate(w.act.visitDate)) : 'Документы') + '</div>'
    + (w.act ? edActTableHtml() : edVisitsHtml())
    + '<div class="ed-tpls">' + (tpls.length ? tpls.map((t) => '<label class="ed-tpl"><input type="checkbox"' + (w.selected.has(t.id) ? ' checked' : '')
      + ' onchange="edToggleTpl(' + t.id + ',this.checked)"><span class="ed-tpl-name">' + esc(t.title) + ' <span class="ed-sub">' + esc(ED_KIND_LABELS[t.kind] || t.kind) + '</span></span>'
      + '<button class="btn btn-sec btn-sm" onclick="event.preventDefault();edPreview(' + t.id + ')">Проверить</button></label>').join('')
      : '<div class="empty">Нет активных шаблонов — загрузите их во вкладке «Настройки»</div>') + '</div>'
    + '<div class="fg ed-date"><label class="fl" for="edDocDate">Дата документа (пусто — сегодня)</label><input type="date" id="edDocDate" value="' + escAttr(w.docDate) + '" onchange="edSetDocDate(this.value)"></div>'
    + '<div id="edMissing" class="ed-missing"></div>'
    + '<div class="ed-actions"><button class="btn btn-pri" id="edSendBtn" onclick="edSend()" disabled>Отправить на подписание</button>'
    + '<span class="ed-sub">Пациент получит SMS со ссылкой и подпишет документы кодом из SMS</span></div></div>';
  if (w.act) edActTotalRender();
  edCheckMissing();
}

function edActTableHtml() {
  const a = _ed.w.act;
  const cell = (i, key, val, label, mode) => '<td data-label="' + label + '"><input type="text"' + (mode ? ' inputmode="decimal"' : '') + ' value="' + escAttr(String(val === null || val === undefined ? '' : val))
    + '" oninput="edActEdit(' + i + ',\'' + key + '\',this.value)"></td>';
  return '<div class="ed-sub">Врач: ' + esc(a.doctor.name || '—') + (a.doctor.position ? ', ' + esc(a.doctor.position) : '') + ' · номер акта ' + esc(a.actNo) + '</div>'
    + '<div class="tw mtbl-wrap"><table class="ed-act mtbl"><thead><tr><th></th><th>Услуга</th><th>Кол-во</th><th>Цена</th><th>Сумма</th></tr></thead><tbody>'
    + a.rows.map((r, i) => '<tr><td data-label="В акте"><input type="checkbox"' + (r.include ? ' checked' : '') + ' onchange="edActEdit(' + i + ',\'include\',this.checked)"></td>'
      + cell(i, 'title', r.title, 'Услуга') + cell(i, 'qty', r.qty, 'Кол-во', true) + cell(i, 'price', r.price, 'Цена', true) + cell(i, 'sum', r.sum, 'Сумма', true) + '</tr>').join('')
    + '</tbody></table></div><div class="ed-actions"><button class="btn btn-sec btn-sm" onclick="edActAdd()">+ Строка</button><span class="ed-total" id="edActTotal"></span></div>';
}
function edActEdit(i, key, val) { _ed.w.act.rows[i][key] = val; edActTotalRender(); }
function edActAdd() { edCaptureForm(); _ed.w.act.rows.push({ include: true, title: '', qty: 1, price: 0, sum: 0, service_id: null }); edRenderWizard(); }
function edActTotalRender() {
  const el = document.getElementById('edActTotal');
  if (el) el.textContent = 'Итого: ' + edMoney(edActTotals(_ed.w.act.rows.filter((r) => r.include)).total);
}

function edVisitsHtml() {
  const v = _ed.w.visits || [];
  if (!v.length) return '';
  return '<details class="ed-visits"><summary>Оформить акт по визиту (' + v.length + ')</summary>' + v.map((r) => {
    const act = r.act ? edStatusInfo(r.act.status) : null;
    return '<div class="ed-visit"><span>' + esc(edFmtDate(r.visitDate)) + ' · ' + esc(r.services.join(', ') || '—') + (r.staffName ? ' · ' + esc(r.staffName) : '') + '</span>'
      + (act ? '<span class="badge ' + act.cls + '">Акт: ' + esc(act.label) + '</span>' : '')
      + '<button class="btn btn-sec btn-sm" onclick="edGo(\'new/' + _ed.w.clientId + '/' + r.id + '\')">Оформить акт</button></div>';
  }).join('') + '</details>';
}

function edToggleTpl(id, on) { if (on) _ed.w.selected.add(id); else _ed.w.selected.delete(id); edCheckMissing(); }
function edSetDocDate(v) { _ed.w.docDate = v; }

function edCaptureForm() {
  const w = _ed.w;
  if (!w) return;
  for (const f of ED_PLAIN_FIELDS.concat(ED_SECURE_FIELDS)) {
    const el = document.getElementById('edF-' + f[0]);
    if (el) w.form[f[0]] = el.value;
  }
}
function edFormChanged() {
  edCaptureForm();
  _ed.w.unsaved = true;
  const s = document.getElementById('edIdentityState');
  if (s) s.textContent = 'Есть несохранённые изменения';
  edCheckMissing();
}

async function edSaveIdentity() {
  const w = _ed.w;
  edCaptureForm();
  const btn = document.getElementById('edSaveIdentity');
  if (btn) btn.disabled = true;
  try {
    await api('PUT', '/api/edocs/clients/' + w.clientId + '/identity', edIdentityBody((k) => w.form[k], w.source));
    w.unsaved = false;
    w.source = 'manual';
    const s = document.getElementById('edIdentityState');
    if (s) s.textContent = 'Сохранено';
    notify('Данные пациента сохранены');
    edCheckMissing();
  } catch (e) { notify(e.message, 'err'); } finally { if (btn) btn.disabled = false; }
}

async function edRecognize(input) {
  const file = input.files && input.files[0];
  input.value = '';
  if (!file) return;
  const w = _ed.w;
  const fd = new FormData();
  fd.append('photo', file);
  notify('Распознаём паспорт…');
  const r = await edFetch('POST', '/api/edocs/clients/' + w.clientId + '/identity/recognize', { form: fd });
  if (!r.ok) { notify(r.body.error || 'Не удалось распознать', 'err'); if (r.body.code === 'fdoc_no_credentials' || r.body.code === 'fdoc_credentials_invalid') edOpenMe(); return; }
  if (_ed.w !== w) return;
  edCaptureForm();
  Object.assign(w.form, r.body.plain || {}, r.body.secure || {});
  w.source = 'recognize';
  w.unsaved = true;
  w.notes = [r.body.confidence ? 'Поля заполнены по фото — проверьте их и нажмите «Сохранить данные»' : 'Распознано неуверенно — внимательно проверьте каждое поле'];
  if (r.body.spoofing && r.body.spoofing.length) w.notes.push('F.Doc сомневается в подлинности снимка (' + r.body.spoofing.join(', ') + ') — сверьте с оригиналом паспорта');
  edRenderWizard();
}

async function edCheckMissing() {
  const w = _ed.w;
  const el = document.getElementById('edMissing');
  const btn = document.getElementById('edSendBtn');
  if (!w || !el || !btn) return;
  btn.disabled = true;
  if (w.unsaved) { el.textContent = 'Сохраните данные пациента: документы заполняются из сохранённых данных'; return; }
  if (!w.selected.size) { el.textContent = 'Отметьте документы для подписания'; return; }
  try {
    const r = await api('POST', '/api/edocs/packages/check', { clientId: w.clientId, templateIds: Array.from(w.selected) });
    if (_ed.w !== w) return;
    const text = edMissingText(r.missing);
    const st = _ed.state;
    const ready = st && st.enabled && st.me && st.me.connected && !st.me.broken;
    el.textContent = text || (ready ? '' : st && !st.enabled
      ? 'Модуль выключен: документы можно проверить кнопкой «Проверить», отправка — после подключения F.Doc'
      : 'Подключите свою учётную запись F.Doc: кнопка «Мой F.Doc»');
    btn.disabled = !!text || !ready;
  } catch (e) { el.textContent = e.message; }
}

function edActBody(body) {
  const w = _ed.w;
  if (!w.act) return null;
  const lines = edCollectActLines(w.act.rows);
  if (lines.error) return lines.error;
  body.recordId = w.recordId;
  body.actLines = lines.value;
  return null;
}

async function edPreview(templateId) {
  const w = _ed.w;
  const body = { clientId: w.clientId, templateId: templateId, docDate: w.docDate || null };
  const err = edActBody(body);
  if (err) return notify(err, 'err');
  try {
    const r = await api('POST', '/api/edocs/packages/preview', body);
    edDownloadBase64(r.base64, r.fileName, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    if (w.unsaved) notify('Документ собран по СОХРАНЁННЫМ данным — сохраните изменения, чтобы они попали в документ');
  } catch (e) { notify(e.message, 'err'); }
}

async function edSend() {
  const w = _ed.w;
  const btn = document.getElementById('edSendBtn');
  const body = { clientId: w.clientId, templateIds: Array.from(w.selected), docDate: w.docDate || null };
  const err = edActBody(body);
  if (err) return notify(err, 'err');
  if (!confirm('Отправить документы пациенту на подписание? Он получит SMS со ссылкой.')) return;
  btn.disabled = true;
  btn.textContent = 'Отправляем…';
  const r = await edFetch('POST', '/api/edocs/packages', { json: body });
  btn.textContent = 'Отправить на подписание';
  if (r.ok) { notify('Документы отправлены пациенту'); edGo('p/' + r.body.packageId); return; }
  btn.disabled = false;
  const b = r.body || {};
  if (b.code === 'missing_fields') { const el = document.getElementById('edMissing'); if (el) el.textContent = edMissingText(b.missing); }
  notify(b.error || ('Ошибка ' + r.status), 'err');
  if (b.code === 'fdoc_no_credentials' || b.code === 'fdoc_credentials_invalid') edOpenMe();
  else if (b.packageId) edGo('p/' + b.packageId);   // черновик создан — повтор из карточки
}

// ── карточка комплекта ──
async function edRenderPackage(id) {
  const box = document.getElementById('edView-package');
  if (!box) return;
  box.innerHTML = '<div class="empty">Загрузка…</div>';
  _ed.pkg = null;
  await edLoadPackage(id, false);
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
  const btn = (action, label, cls) => '<button class="btn ' + (cls || 'btn-sec') + ' btn-sm" onclick="edPkgAction(\'' + p.id + '\',\'' + action + '\')">' + label + '</button>';
  if (p.status === 'draft') b.push(btn('resend', 'Повторить отправку', 'btn-pri'));
  if (p.status !== 'draft') b.push('<button class="btn btn-sec btn-sm" onclick="edOpenInFdoc(\'' + p.id + '\')">Открыть в F.Doc</button>');
  if (p.status === 'sent') b.push(btn('permalink', 'Отправить ссылку ещё раз'));
  if (p.status !== 'draft' && !edIsFinal(p.status)) b.push(btn('refresh', 'Обновить статус'));
  if (p.status === 'sent' || p.status === 'error') b.push(btn('annul', 'Аннулировать', 'btn-sec btn-dng'));
  // Отказ, аннулирование, истёкший срок — новый комплект тому же пациенту (и по тому же визиту для акта).
  if (['declined', 'annulled', 'expired'].indexOf(p.status) >= 0) {
    b.push('<button class="btn btn-pri btn-sm" onclick="edGo(\'new/' + p.clientId + (p.recordId ? '/' + p.recordId : '') + '\')">Оформить заново</button>');
  }
  return b.join('');
}

async function edPkgAction(id, action) {
  if (action === 'annul' && !confirm('Аннулировать комплект? Пациент больше не сможет его подписать.')) return;
  try {
    const r = await api('POST', '/api/edocs/packages/' + id + '/' + action);
    const msg = { resend: r && r.recovered ? 'Комплект уже был в F.Doc — отмечен отправленным' : 'Комплект отправлен', permalink: 'Ссылка отправлена пациенту', refresh: 'Статус обновлён', annul: 'Комплект аннулирован' };
    notify(msg[action] || 'Готово');
    edLoadPackage(id, true);
  } catch (e) { notify(e.message, 'err'); if (/Мой F\.Doc/.test(e.message)) edOpenMe(); }
}
function edOpenInFdoc(id) { edOpenAsync(async () => (await api('POST', '/api/edocs/packages/' + id + '/employee-url')).url); }
function edOpenPdf(docId) { edOpenAsync(async () => (await api('GET', '/api/edocs/documents/' + docId + '/pdf')).url); }

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
    edCheckMissing();
  } catch (e) { notify(e.message, 'err'); }
}
async function edDeleteMe() {
  if (!confirm('Отключить вашу учётную запись F.Doc?')) return;
  try {
    await api('DELETE', '/api/edocs/me/credentials');
    notify('Учётная запись F.Doc отключена');
    closeModal('edMeModal');
    await edLoadState();
    edCheckMissing();
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
  if (!r.ok) return notify((r.body.error || 'Ошибка') + ((r.body.details || []).length ? ': ' + r.body.details.join('; ') : ''), 'err');
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
    + '<button class="btn btn-pri btn-sm" onclick="edOpenWizard(' + clientId + ')">Оформить документы</button></div>'
    + '<div class="ed-sub">' + (id.exists ? 'Данные для документов: ' + esc(id.fio || '—') + (id.passportMask ? ' · паспорт ' + esc(id.passportMask) : ' · паспорт не заполнен') : 'Данные для документов не заполнены') + '</div>'
    + (s.packages || []).map((p) => {
      const st = edStatusInfo(p.status);
      return '<div class="ed-crow" onclick="edOpenPackage(\'' + p.id + '\')"><span>' + esc(p.title) + '</span><span class="badge ' + st.cls + '">' + esc(st.label) + '</span></div>';
    }).join('');
}
function edOpenWizard(clientId, recordId) {
  if (typeof closeModal === 'function') closeModal('clientModal');
  location.hash = 'edocs/new/' + clientId + (recordId ? '/' + recordId : '');
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
      : '<button class="btn btn-sec btn-sm" onclick="edOpenWizard(' + cid + ',' + rid + ')">📄 Акт</button>';
  });
}
```

- [ ] **Step 4: index.html: Пункт меню в обоих меню (десктоп и drawer)**

В `frontend/index.html` найти (фрагмент встречается 2 раза — заменить ВСЕ вхождения):

```html
      <div class="tn" data-p="cert-requests" data-roles="owner,admin,specialist,admin_cashier" onclick="nav(this)">Справки</div>
```

заменить на:

```html
      <div class="tn" data-p="cert-requests" data-roles="owner,admin,specialist,admin_cashier" onclick="nav(this)">Справки</div>
      <div class="tn" data-p="edocs" data-roles="owner,admin,admin_cashier" onclick="nav(this)">📄 Документы</div>
```

- [ ] **Step 5: index.html: Разметка страницы — перед страницей «Экономики»**

В `frontend/index.html` найти:

```html
    <div class="page" id="page-economics">
```

заменить на:

```html
    <div class="page" id="page-edocs">
      <div class="bc-head">
        <div>
          <div class="bc-head-title">📄 Документы</div>
          <div class="bc-head-sub">Электронное подписание с пациентами через F.Doc</div>
        </div>
        <div class="ed-head-actions">
          <span id="edMeStatus" class="ed-me"></span>
          <button class="btn btn-sec btn-sm" onclick="edOpenMe()">Мой F.Doc</button>
        </div>
      </div>
      <div class="tabs ed-tabs">
        <button class="tab active" id="edTabBtn-list" onclick="edGo('')">Комплекты</button>
        <button class="tab" id="edTabBtn-new" onclick="edGo('new')">Оформить</button>
        <button class="tab" id="edTabBtn-settings" onclick="edGo('settings')">Настройки</button>
      </div>
      <div id="edNotice"></div>
      <div id="edView-list"></div>
      <div id="edView-new" style="display:none"></div>
      <div id="edView-package" style="display:none"></div>
      <div id="edView-settings" style="display:none"></div>
    </div>

    <div class="page" id="page-economics">
```

- [ ] **Step 6: index.html: Модалка «Мой F.Doc» — перед блоком уведомлений**

В `frontend/index.html` найти:

```html
<div class="notif" id="notif"></div>
```

заменить на:

```html
<div class="ov" id="edMeModal" onclick="if(event.target===this)closeModal('edMeModal')">
  <div class="modal">
    <div class="mh"><div class="mt">Мой F.Doc</div><button class="mc" onclick="closeModal('edMeModal')">✕</button></div>
    <div class="ed-sub" id="edMeInfo" style="margin-bottom:12px"></div>
    <div class="fg"><label class="fl" for="edMeLogin">Логин F.Doc</label><input type="text" id="edMeLogin" autocomplete="username"></div>
    <div class="fg"><label class="fl" for="edMePassword">Пароль F.Doc</label><input type="password" id="edMePassword" autocomplete="current-password"></div>
    <div style="display:flex;gap:8px;flex-wrap:wrap">
      <button class="btn btn-pri" onclick="edSaveMe()">Проверить и сохранить</button>
      <button class="btn btn-sec btn-dng" onclick="edDeleteMe()">Отключить</button>
      <button class="btn btn-sec" onclick="closeModal('edMeModal')">Закрыть</button>
    </div>
  </div>
</div>

<div class="notif" id="notif"></div>
```

- [ ] **Step 7: index.html: Скрипты страницы — после «Справок»**

В `frontend/index.html` найти:

```html
<script src="js/pages/cert-requests.js?v=2026-06-19b"></script>
```

заменить на:

```html
<script src="js/pages/cert-requests.js?v=2026-06-19b"></script>
<script src="js/pages/edocs-helpers.js?v=2026-10-24a"></script>
<script src="js/pages/edocs.js?v=2026-10-24a"></script>
```

- [ ] **Step 8: index.html: Бамп версии nav.js**

В `frontend/index.html` найти:

```html
<script src="js/core/nav.js?v=2026-10-19-eco"></script>
```

заменить на:

```html
<script src="js/core/nav.js?v=2026-10-24-edocs"></script>
```

- [ ] **Step 9: index.html: Бамп версии features.css**

В `frontend/index.html` найти:

```html
<link rel="stylesheet" href="css/features.css?v=2026-10-19-eco7-notify1">
```

заменить на:

```html
<link rel="stylesheet" href="css/features.css?v=2026-10-24-edocs">
```

- [ ] **Step 10: nav.js: остановка опроса при любом переходе**

В `frontend/js/core/nav.js` найти:

```js
  if (typeof stopChatPolling === 'function') stopChatPolling();
```

заменить на:

```js
  if (typeof stopChatPolling === 'function') stopChatPolling();
  // Опрос статусов «Документов» жив только на своей странице.
  if (typeof edStopPolling === 'function') edStopPolling();
```

- [ ] **Step 11: nav.js: загрузка страницы**

В `frontend/js/core/nav.js` найти:

```js
  if (p === 'economics')      loadEconomics();
```

заменить на:

```js
  if (p === 'economics')      loadEconomics();
  if (p === 'edocs')          loadEdocs();
```

- [ ] **Step 12: nav.js: хвост hash на той же странице**

В `frontend/js/core/nav.js` найти:

```js
    if (page === 'chat' && typeof chatOnHashArg === 'function') chatOnHashArg(arg);
```

заменить на:

```js
    if (page === 'chat' && typeof chatOnHashArg === 'function') chatOnHashArg(arg);
    if (page === 'edocs' && typeof edocsOnHashArg === 'function') edocsOnHashArg(arg);
```

- [ ] **Step 13: nav.js: комментарий к хвосту**

В `frontend/js/core/nav.js` найти:

```js
    // Тот же раздел — сменился только хвост. Хвост есть у чата и у дашборда.
```

заменить на:

```js
    // Тот же раздел — сменился только хвост. Хвост есть у чата, дашборда и «Документов».
```

- [ ] **Step 14: nav.js: остановка опроса при выходе**

В `frontend/js/core/nav.js` найти:

```js
function showLogin() {
  if (typeof vdStop === 'function') vdStop();
```

заменить на:

```js
function showLogin() {
  if (typeof vdStop === 'function') vdStop();
  if (typeof edStopPolling === 'function') edStopPolling();
```

- [ ] **Step 15: Стили страницы — дописать в конец `frontend/css/features.css`**

```css

/* ─── «📄 Документы» (F.Doc) ─── */
.ed-head-actions{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.ed-tabs{max-width:520px}
.ed-me{font-size:12px;color:var(--t3)}
.ed-note{padding:10px 12px;border-radius:8px;background:var(--as);color:var(--t1);font-size:12.5px;margin-bottom:12px;line-height:1.45}
.ed-note-bad{background:rgba(232,84,84,.1)}
.ed-h{font-size:15px;font-weight:700;margin-bottom:10px}
.ed-h2{font-size:13px;font-weight:700;margin:12px 0 8px}
.ed-sub{font-size:12px;color:var(--t3)}
.ed-err{font-size:12px;color:var(--danger);margin-top:4px}
.ed-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:0 12px}
#page-edocs input[type=checkbox],#edMeModal input[type=checkbox]{width:auto;margin:0;flex-shrink:0}
.ed-actions{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-top:10px}
.ed-file{position:relative;overflow:hidden;cursor:pointer}
.ed-file input[type=file]{position:absolute;inset:0;opacity:0;cursor:pointer;width:100%}
.ed-results{margin-top:10px;display:flex;flex-direction:column;gap:6px}
.ed-result{display:flex;justify-content:space-between;align-items:center;gap:8px;padding:8px 10px;border:1px solid var(--bd);border-radius:8px;cursor:pointer}
.ed-result:hover,.ed-row:hover,.ed-crow:hover{background:var(--bg)}
.ed-row,.ed-link{cursor:pointer}
.ed-patient{display:flex;justify-content:space-between;align-items:center;gap:10px}
.ed-tpls{display:flex;flex-direction:column;gap:6px;margin:10px 0}
.ed-tpl{display:flex;flex-wrap:wrap;align-items:center;gap:8px;font-size:13px}
.ed-tpl-name{flex:1 1 200px;min-width:0}
.ed-date{max-width:220px}
.ed-missing{font-size:12.5px;color:var(--warn);min-height:18px}
.ed-act th:first-child,.ed-act td:first-child{width:36px}
.ed-act th:nth-child(n+3),.ed-act td:nth-child(n+3){width:120px}
.ed-act td:nth-child(n+3) input{text-align:right}
.ed-total{font-weight:700;margin-left:auto}
.ed-visits{margin:6px 0 10px;font-size:13px}
.ed-visit{display:flex;flex-wrap:wrap;gap:8px;align-items:center;justify-content:space-between;padding:6px 0;border-bottom:1px solid var(--bd);font-size:12.5px}
.ed-pkg-head{display:flex;justify-content:space-between;gap:12px;align-items:flex-start}
.ed-badge-lg{font-size:12.5px;padding:4px 12px}
.ed-event{font-size:12.5px;padding:4px 0;border-bottom:1px dashed var(--bd)}
.ed-upload{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-bottom:8px}
.ed-upload input,.ed-upload select{width:auto;flex:1 1 180px}
.ed-inline{min-width:160px}
.ed-row-actions{white-space:nowrap}
.ed-row-actions .btn{margin:2px}
.ed-dict{margin-top:12px;font-size:12.5px}
.ed-dict code{font-size:12px}
.ed-switch{display:flex;align-items:center;gap:8px;font-size:13px;margin:6px 0}
.ed-cblock-head{display:flex;justify-content:space-between;align-items:center;margin-bottom:6px}
.ed-crow{display:flex;justify-content:space-between;align-items:center;gap:8px;padding:6px 8px;border-radius:6px;cursor:pointer;font-size:12.5px}
.ed-toolbar{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:10px}
.ed-toolbar select,.ed-toolbar input[type=date]{width:auto}
/* Тёмная тема: глобальный .tab.active белый (см. заметку у «Рассылок») — чиним свои вкладки. */
[data-theme="dark"] .ed-tabs .tab.active{background:var(--bd);color:var(--t1)}
/* «Записи» в карточном режиме: пустая ячейка «Акт» (модуль выключен, визит не состоялся) не нужна. */
@media(max-width:700px){
  #page-records tbody td.r-act:empty{display:none}
  .ed-patient,.ed-pkg-head{flex-direction:column;align-items:stretch}
  .ed-row-actions{white-space:normal}
  #page-edocs .card{min-width:0}
  .ed-tbl-card{padding:0;background:transparent;border:none;box-shadow:none}
  .ed-act th:first-child,.ed-act td:first-child,.ed-act th:nth-child(n+3),.ed-act td:nth-child(n+3){width:auto}
  .ed-act.mtbl tbody td input[type=text]{flex:1 1 150px;max-width:65%}
}
```

- [ ] **Step 16: Тесты фронта проходят**

```bash
cd /root/loyalpro-fdoc && node --test frontend/js/pages/edocs.test.js 2>&1 | grep -E "^# (pass|fail)"
for f in frontend/js/pages/*.test.js; do printf '%s ' "$f"; node --test "$f" 2>&1 | grep -E "^# fail"; done
```

Ожидается: для `edocs.test.js` — `# pass 10`, `# fail 0`; у каждого из остальных тестов страниц — `# fail 0`.

- [ ] **Step 17: Commit**

```bash
cd /root/loyalpro-fdoc && git add frontend/js/pages/edocs.js frontend/js/pages/edocs.test.js frontend/index.html frontend/js/core/nav.js frontend/css/features.css && git commit -m "feat(edocs): страница «📄 Документы» — комплекты, оформление, акт, карточка, настройки, «Мой F.Doc»

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 15: Встройки в «Клиентов» и «Записи» — **Sonnet**

Карточка клиента получает блок «Документы» (данные, маска паспорта, комплекты, «Оформить документы»), таблица записей — колонку с кнопкой «📄 Акт» у пришедших визитов или статусом акта. Обе встройки зовут функции `edocs.js` через `typeof … === 'function'` и рисуются отдельным запросом ПОСЛЕ основной отрисовки: ядро `GET /api/records` не меняется, сбой модуля не ломает список записей; при выключенном модуле встройки пусты. Версии `clients.js` и `records.js` в `index.html` бампаются — без `?v=` правка не доезжает до браузеров (nginx кэширует).

**Files:**
- Modify: `frontend/js/pages/clients.js`, `frontend/js/pages/records.js`, `frontend/index.html`
- Test: `frontend/js/pages/edocs.test.js` (дописать тест встроек)

- [ ] **Step 1: Дописать падающий тест в конец `frontend/js/pages/edocs.test.js`**

```js
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
cd /root/loyalpro-fdoc && node --test frontend/js/pages/edocs.test.js 2>&1 | grep -E "^# (pass|fail)"
```

Ожидается: `# pass 10`, `# fail 1`.

- [ ] **Step 3: clients.js: место под блок в карточке**

В `frontend/js/pages/clients.js` найти:

```js
      <div id="cardTxnsBlock_${c.id}"></div>`;
```

заменить на:

```js
      <div id="cardTxnsBlock_${c.id}"></div>
      <div id="edClientBlock_${c.id}"></div>`;
```

- [ ] **Step 4: clients.js: вызов блока после открытия карточки**

В `frontend/js/pages/clients.js` найти:

```js
    openModal('clientModal');
  } catch(e) { notify(e.message, 'err'); }
}

async function doSyncCard
```

заменить на:

```js
    openModal('clientModal');
    // «Документы» (edocs.js): блок рисуется, только если модуль включён в салоне.
    if (typeof edRenderClientBlock === 'function') edRenderClientBlock(c.id);
  } catch(e) { notify(e.message, 'err'); }
}

async function doSyncCard
```

- [ ] **Step 5: records.js: пустая таблица на 10 колонок**

В `frontend/js/pages/records.js` найти:

```js
if (!d.records?.length) { tb.innerHTML = '<tr><td colspan="9" class="empty">Записей нет</td></tr>'; renderRecordsPager(d); return; }
```

заменить на:

```js
if (!d.records?.length) { tb.innerHTML = '<tr><td colspan="10" class="empty">Записей нет</td></tr>'; renderRecordsPager(d); return; }
```

- [ ] **Step 6: records.js: ячейка «Акт» в строке**

В `frontend/js/pages/records.js` найти:

```js
        <td data-label="Источник"><span class="badge bgr" style="font-size:10px">${esc({sync:'Синхр.',webhook:'Hook'}[r.source] || r.source || '—')}</span></td>
      </tr>`;
```

заменить на:

```js
        <td data-label="Источник"><span class="badge bgr" style="font-size:10px">${esc({sync:'Синхр.',webhook:'Hook'}[r.source] || r.source || '—')}</span></td>
        <td data-label="Акт" class="r-act" data-rid="${r.id}" data-cid="${r.client_id || ''}"></td>
      </tr>`;
```

- [ ] **Step 7: records.js: украшение после отрисовки**

В `frontend/js/pages/records.js` найти:

```js
    }).join('');
    renderRecordsPager(d);
```

заменить на:

```js
    }).join('');
    renderRecordsPager(d);
    // «Документы» (edocs.js): кнопка «Акт» у состоявшихся визитов, если модуль включён.
    if (typeof edDecorateRecords === 'function') edDecorateRecords(d.records);
```

- [ ] **Step 8: index.html: колонка в шапке таблицы записей**

В `frontend/index.html` найти:

```html
<th>Статус</th><th>Источник</th></tr></thead>
```

заменить на:

```html
<th>Статус</th><th>Источник</th><th></th></tr></thead>
```

- [ ] **Step 9: index.html: стартовая пустая строка на 10 колонок**

В `frontend/index.html` найти:

```html
<tbody id="rBody"><tr><td colspan="9" class="empty">Выберите период</td></tr></tbody>
```

заменить на:

```html
<tbody id="rBody"><tr><td colspan="10" class="empty">Выберите период</td></tr></tbody>
```

- [ ] **Step 10: index.html: бамп версии records.js**

В `frontend/index.html` найти:

```html
<script src="js/pages/records.js"></script>
```

заменить на:

```html
<script src="js/pages/records.js?v=2026-10-24-edocs"></script>
```

- [ ] **Step 11: index.html: бамп версии clients.js**

В `frontend/index.html` найти:

```html
<script src="js/pages/clients.js"></script>
```

заменить на:

```html
<script src="js/pages/clients.js?v=2026-10-24-edocs"></script>
```

- [ ] **Step 12: Тесты фронта проходят**

```bash
cd /root/loyalpro-fdoc && for f in frontend/js/pages/*.test.js; do printf '%s ' "$f"; node --test "$f" 2>&1 | grep -E "^# (pass|fail)" | tr '\n' ' '; echo; done
```

Ожидается: у `edocs.test.js` — `# pass 11 # fail 0`; у остальных — `# fail 0`.

- [ ] **Step 13: Commit**

```bash
cd /root/loyalpro-fdoc && git add frontend/js/pages/clients.js frontend/js/pages/records.js frontend/index.html frontend/js/pages/edocs.test.js && git commit -m "feat(edocs): блок «Документы» в карточке клиента и кнопка «Акт» в «Записях»

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 16: Визуальный стенд и образцы шаблонов — **Sonnet**

Изолированная проверка по образцу `scripts/dialog-verdicts-visual.js`: настоящие разметка, CSS и JS страницы, подставные ответы API, ни БД, ни F.Doc. Сценарии: список → клик в карточку (hash), «Оформить заново» у истёкшего комплекта ведёт в мастер акта, мастер с данными, отметка шаблона включает отправку, F5 внутри мастера, акт (строки и итог), настройки, тёмная тема, 390 px без горизонтальной прокрутки, роль кассира (настроек нет, адрес возвращается на список), ни одной ошибки страницы.

Второй скрипт — образцы DOCX-шаблонов со ВСЕМИ тегами словаря (договор, согласие, акт): ими проверяется модуль на деве и демо-стенде (задачи 18, 20), и с них клиника может начать свои шаблоны.

**Files:**
- Create: `backend/scripts/edocs-visual.js`, `backend/scripts/edocs-sample-templates.js`

- [ ] **Step 1: Скрипт стенда**

Создать `backend/scripts/edocs-visual.js`:

```js
'use strict';
// Изолированная визуальная проверка «Документов»: настоящие разметка/CSS/JS страницы,
// подставные ответы API. Ни БД, ни F.Doc, ни сессий. Скриншоты — /tmp/edocs-*.png.
// node scripts/edocs-visual.js   (Chrome: CHROME_PATH или /usr/bin/google-chrome)
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const puppeteer = require('puppeteer');
const { dictionary } = require('../services/edocs/placeholders');

const PKG = '11111111-1111-4111-8111-111111111111';
const PKG2 = '22222222-2222-4222-8222-222222222222';

function fixtures() {
  const identity = { exists: true, plain: { last_name: 'Тестова', first_name: 'Анна', middle_name: 'Сергеевна', birth_date: '1990-01-15', gender: 'F', phone: '79000000001', email: '', contract_no: '17', contract_date: '' },
    secure: { passport_series: '4500', passport_number: '000001', issue_date: '2015-05-01', authority_code: '770-001', issued_by: 'Тестовое отделение', birth_place: 'г. Москва', address: 'г. Москва, ул. Тестовая, д. 1' } };
  const templates = [{ id: 1, kind: 'contract', title: 'Договор на оказание медицинских услуг', placeholders: ['fio', 'passport'] },
    { id: 2, kind: 'consent_pd', title: 'Согласие на обработку персональных данных', placeholders: ['fio'] },
    { id: 3, kind: 'act', title: 'Акт оказанных услуг', placeholders: ['fio', 'services', 'total_sum'] }];
  const pkg = { id: PKG, kind: 'onboarding', title: 'Документы от 24.10.2026', status: 'sent', fdocStatus: 'WAIT_SIGN', clientId: 52, clientName: 'Тестова Анна Сергеевна',
    clientPhone: '79000000001', recordId: null, sentAt: '2026-10-24T08:00:00Z', signedAt: null, sentByName: 'Администратор', lastError: null, createdAt: '2026-10-24T08:00:00Z',
    act: null, patient: { fio: 'Тестова Анна Сергеевна', phone: '79000000001' },
    documents: [{ id: 'aaaaaaaa-1111-4111-8111-111111111111', title: 'Договор на оказание медицинских услуг', fileName: 'Договор.docx', corpSignedAt: '2026-10-24T08:00:05Z', clientSignedAt: null, hasPdf: false },
      { id: 'bbbbbbbb-1111-4111-8111-111111111111', title: 'Согласие на обработку персональных данных', fileName: 'Согласие.docx', corpSignedAt: '2026-10-24T08:00:05Z', clientSignedAt: null, hasPdf: false }],
    events: [{ kind: 'send', payload: { documents: 2 }, createdAt: '2026-10-24T08:00:00Z', userName: 'Администратор' }] };
  return { identity, templates, pkg };
}

async function main() {
  const frontend = path.resolve(__dirname, '../../frontend');
  const index = fs.readFileSync(path.join(frontend, 'index.html'), 'utf8');
  const pageFrom = index.indexOf('<div class="page" id="page-edocs">');
  const page = index.slice(pageFrom, index.indexOf('<div class="page" id="page-economics">', pageFrom));
  const modalFrom = index.indexOf('<div class="ov" id="edMeModal"');
  const modal = index.slice(modalFrom, index.indexOf('<div class="notif" id="notif"></div>', modalFrom));
  assert.ok(pageFrom > 0 && modalFrom > 0, 'блоки «Документов» не найдены в index.html');
  const fx = fixtures();
  const role = { value: 'owner' };
  const app = express();
  app.use(express.json());
  app.get('/api/edocs/state', (_q, r) => r.json({ enabled: true, configured: true, encReady: true, role: role.value, me: { connected: true, login: 'admin', broken: false, lastError: null } }));
  app.get('/api/edocs/packages', (_q, r) => r.json({ total: 2, page: 1, rows: [fx.pkg, { ...fx.pkg, id: PKG2, title: 'Акт от 23.10.2026', kind: 'act', status: 'signed', signedAt: '2026-10-23T12:00:00Z' }] }));
  app.get('/api/edocs/packages/:id', (q, r) => r.json(q.params.id === PKG2 ? { ...fx.pkg, id: PKG2, status: 'expired', title: 'Акт от 23.10.2026', recordId: 30252 } : fx.pkg));
  app.get('/api/edocs/clients', (_q, r) => r.json({ clients: [{ id: 52, name: 'Тестова Анна Сергеевна', phone: '79000000001', hasIdentity: true }] }));
  app.get('/api/edocs/clients/:id/summary', (_q, r) => r.json({ enabled: true, client: { id: 52, name: 'Тестова Анна Сергеевна', phone: '79000000001' }, identity: { exists: true, fio: 'Тестова Анна Сергеевна', passportMask: '45** ****01' }, packages: [] }));
  app.get('/api/edocs/clients/:id/identity', (_q, r) => r.json(fx.identity));
  app.get('/api/edocs/clients/:id/identity/prefill', (_q, r) => r.json({ plain: fx.identity.plain, secure: {}, notes: [] }));
  app.get('/api/edocs/clients/:id/records', (_q, r) => r.json({ records: [{ id: 30252, visitDate: '2026-10-23', staffName: 'Тестовый врач', services: ['Чистка лица', 'Пилинг'], total: 9500, act: null }] }));
  app.get('/api/edocs/templates', (_q, r) => r.json({ templates: fx.templates }));
  app.get('/api/edocs/records/:id/act-draft', (_q, r) => r.json({ record: { id: 30252, clientId: 52, visitDate: '2026-10-23', actNo: '2056697734' }, doctor: { name: 'Тестовый врач', position: 'Врач-косметолог' },
    lines: [{ service_id: 1, title: 'Чистка лица', qty: 1, price: 3500, sum: 3500 }, { service_id: 2, title: 'Фотоомоложение — лицо', qty: 1, price: 17500, sum: 15750 }], totals: { total_sum: 19250 } }));
  app.post('/api/edocs/packages/check', (_q, r) => r.json({ missing: { identity: [], org: [] } }));
  app.get('/api/edocs/admin/settings', (_q, r) => r.json({ enabled: true, baseUrl: 'https://demo.fdoc.ru', appLogin: 'app', appCode: 'crm', corpId: '12345', qesCertAlias: '', employeePosition: 'Администратор',
    unsignDays: 14, requisites: { name: 'ООО «Тестовая клиника»', inn: '0000000000', city: 'Москва' }, hasApiKey: true, hasAppPassword: true, webhookUrl: null, lastWebhookAt: null, encReady: true }));
  app.get('/api/edocs/admin/templates', (_q, r) => r.json({ templates: fx.templates.map((t) => ({ ...t, is_active: true })) }));
  app.get('/api/edocs/admin/users', (_q, r) => r.json({ users: [{ id: 4, name: 'Администратор', role: 'admin', connected: true, login: 'admin', broken: false }, { id: 5, name: 'Кассир', role: 'admin_cashier', connected: false }] }));
  app.get('/api/edocs/admin/templates/dictionary', (_q, r) => r.json(dictionary()));
  app.get('/', (_q, r) => r.type('html').send(`<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
    <link rel="stylesheet" href="/css/base.css"><link rel="stylesheet" href="/css/features.css"></head><body>
    <nav id="mainNav"><div class="tn" data-p="edocs">Документы</div></nav><main class="content" style="padding:16px;max-width:1300px;margin:auto">${page}</main>${modal}
    <div class="notif" id="notif"></div><div id="lbar" class="lbar"></div>
    <script src="/js/core/utils.js"></script><script src="/js/core/api.js"></script><script src="/js/core/nav.js"></script>
    <script src="/js/pages/edocs-helpers.js"></script><script src="/js/pages/edocs.js"></script>
    <script>var ME={role:localStorage.getItem('edRole')||'owner'};function openModal(id){document.getElementById(id).classList.add('open')}function closeModal(id){document.getElementById(id).classList.remove('open')}
    if(!location.hash) history.replaceState(null,'','#edocs'); navTo('edocs',{keepHash:true});</script></body></html>`));
  app.use(express.static(frontend));
  const server = await new Promise((res) => { const s = app.listen(0, '127.0.0.1', () => res(s)); });
  const base = `http://127.0.0.1:${server.address().port}/`;
  let browser;
  try {
    browser = await puppeteer.launch({ headless: true, executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', args: ['--no-sandbox', '--disable-dev-shm-usage'] });
    const p = await browser.newPage();
    const errors = [];
    p.on('pageerror', (e) => errors.push(e.message));
    p.on('dialog', (d) => d.dismiss());
    await p.setViewport({ width: 1280, height: 900 });

    await p.goto(base + '#edocs', { waitUntil: 'networkidle0' });
    await p.waitForSelector('#edListBody .ed-row');
    assert.equal(await p.$$eval('#edListBody .ed-row', (els) => els.length), 2);
    await p.screenshot({ path: '/tmp/edocs-list.png', fullPage: true });

    await p.click('#edListBody .ed-row');
    await p.waitForSelector('#edView-package .ed-pkg-head');
    assert.match(await p.evaluate(() => location.hash), new RegExp(`#edocs/p/${PKG}`));
    assert.equal(await p.$$eval('#edView-package tbody tr', (els) => els.length), 2);
    await p.screenshot({ path: '/tmp/edocs-package.png', fullPage: true });

    await p.goto(base + `#edocs/p/${PKG2}`, { waitUntil: 'networkidle0' });
    await p.waitForSelector('#edView-package .ed-pkg-head');
    const again = await p.$$eval('#edView-package .ed-actions button', (els) => els.map((e) => e.textContent));
    assert.ok(again.includes('Оформить заново'), `у истёкшего комплекта нет «Оформить заново»: ${again}`);
    await p.click('#edView-package .ed-actions .btn-pri');
    await p.waitForSelector('.ed-act tbody tr');
    assert.match(await p.evaluate(() => location.hash), /#edocs\/new\/52\/30252$/);

    await p.goto(base + '#edocs/new/52', { waitUntil: 'networkidle0' });
    await p.waitForSelector('#edF-last_name');
    assert.equal(await p.$eval('#edF-last_name', (el) => el.value), 'Тестова');
    await p.waitForFunction(() => !document.getElementById('edSendBtn').disabled === false || true);
    await p.click('.ed-tpl input[type=checkbox]');
    await p.waitForFunction(() => document.getElementById('edSendBtn') && !document.getElementById('edSendBtn').disabled);
    await p.screenshot({ path: '/tmp/edocs-wizard.png', fullPage: true });
    await p.reload({ waitUntil: 'networkidle0' });
    await p.waitForSelector('#edF-last_name');
    assert.match(await p.evaluate(() => location.hash), /#edocs\/new\/52$/);

    await p.goto(base + '#edocs/new/52/30252', { waitUntil: 'networkidle0' });
    await p.waitForSelector('.ed-act tbody tr');
    assert.equal(await p.$$eval('.ed-act tbody tr', (els) => els.length), 2);
    assert.match(await p.$eval('#edActTotal', (el) => el.textContent), /19\s250,00 ₽/);
    await p.screenshot({ path: '/tmp/edocs-act.png', fullPage: true });

    await p.goto(base + '#edocs/settings', { waitUntil: 'networkidle0' });
    await p.waitForSelector('#edS-baseUrl');
    assert.equal(await p.$$eval('#edView-settings tbody tr', (els) => els.length) >= 3, true);
    await p.screenshot({ path: '/tmp/edocs-settings.png', fullPage: true });

    await p.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));
    await p.goto(base + `#edocs/p/${PKG}`, { waitUntil: 'networkidle0' });
    await p.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));
    await p.waitForSelector('#edView-package .ed-pkg-head');
    await p.screenshot({ path: '/tmp/edocs-package-dark.png', fullPage: true });

    await p.setViewport({ width: 390, height: 844, isMobile: true });
    await p.goto(base + '#edocs/new/52/30252', { waitUntil: 'networkidle0' });
    await p.waitForSelector('.ed-act tbody tr');
    const overflow = await p.evaluate(() => document.querySelector('main').scrollWidth - document.querySelector('main').clientWidth);
    await p.screenshot({ path: '/tmp/edocs-mobile.png', fullPage: true });
    assert.ok(overflow <= 1, `горизонтальная прокрутка страницы на 390px: ${overflow}px`);

    await p.evaluate(() => localStorage.setItem('edRole', 'admin_cashier'));
    await p.setViewport({ width: 1280, height: 900 });
    await p.goto(base + '#edocs/settings', { waitUntil: 'networkidle0' });
    await p.waitForSelector('#edListBody');
    assert.equal(await p.evaluate(() => location.hash), '#edocs');
    assert.equal(await p.$eval('#edTabBtn-settings', (el) => el.style.display), 'none');

    assert.deepEqual(errors, []);
    console.log('OK: список, карточка, «Оформить заново», оформление, F5, акт, настройки, тёмная тема, 390px, роль кассира. Скриншоты /tmp/edocs-*.png');
  } finally {
    if (browser) await browser.close();
    server.close();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
```

- [ ] **Step 2: Прогон**

```bash
cd /root/loyalpro-fdoc/backend && timeout 180 node scripts/edocs-visual.js
```

Ожидается: `OK: список, карточка, «Оформить заново», оформление, F5, акт, настройки, тёмная тема, 390px, роль кассира. Скриншоты /tmp/edocs-*.png`.

- [ ] **Step 3: Скриншоты глазами**

Открыть `/tmp/edocs-list.png`, `/tmp/edocs-wizard.png`, `/tmp/edocs-act.png`, `/tmp/edocs-package.png`, `/tmp/edocs-package-dark.png`, `/tmp/edocs-settings.png`, `/tmp/edocs-mobile.png`. Проверить: активная вкладка в тёмной теме читается; на телефоне строки акта — карточки с подписями «Услуга/Кол-во/Цена/Сумма», галочка шаблона стоит рядом с названием; чекбоксы не растянуты.

- [ ] **Step 4: Скрипт образцов шаблонов**

Создать `backend/scripts/edocs-sample-templates.js`:

```js
'use strict';
// Образцы DOCX-шаблонов «Документов» со ВСЕМИ тегами словаря — для демо-стенда F.Doc и
// как отправная точка для клиники (откройте в Word и замените текст своим).
// node scripts/edocs-sample-templates.js [папка]   (по умолчанию /tmp/edocs-samples)
const fs = require('fs');
const path = require('path');
const { makeDocx, p, table } = require('../services/edocs/__fixtures__/docx');
const { inspect } = require('../services/edocs/docx');
const { validateTags } = require('../services/edocs/placeholders');

const dir = process.argv[2] || '/tmp/edocs-samples';
fs.mkdirSync(dir, { recursive: true });

const samples = {
  'Договор на оказание медицинских услуг.docx': ['contract', makeDocx({
    header: p('{org_name} · Договор № {contract_no} от {contract_date}'),
    body: p('ДОГОВОР № {contract_no} на оказание платных медицинских услуг')
      + p('г. {doc_city}, {doc_date}')
      + p('{org_name} (ИНН {org_inn}, КПП {org_kpp}, ОГРН {org_ogrn}, лицензия {org_license}, адрес: {org_address}, тел. {org_phone}), '
        + 'в лице {org_signer_position} {org_signer_name}, и {fio}, {birth_date} г. р., пол {gender}, паспорт {passport_series} {passport_number}, '
        + 'выдан {passport_issued_by} {passport_issue_date}, код подразделения {passport_authority_code}, место рождения {birth_place}, '
        + 'адрес регистрации: {address}, телефон {phone}, e-mail {email}, заключили настоящий договор.')
      + p('Реквизиты исполнителя: {org_bank}')
      + p('Пациент: {last_name} {first_name} {middle_name} / {fio_short}'),
  })],
  'Согласие на обработку персональных данных.docx': ['consent_pd', makeDocx({
    body: p('СОГЛАСИЕ на обработку персональных данных')
      + p('Я, {fio}, паспорт {passport}, выдан {passport_issued_by} {passport_issue_date}, даю согласие {org_name} (ИНН {org_inn}) на обработку моих персональных данных.')
      + p('Дата: {doc_date}'),
  })],
  'Акт оказанных услуг.docx': ['act', makeDocx({
    body: p('АКТ № {act_no} от {doc_date} об оказании медицинских услуг')
      + p('Исполнитель: {org_name}. Пациент: {fio}. Визит: {visit_date}. Врач: {doctor_name}, {doctor_position}.')
      + table([['№', 'Услуга', 'Кол-во', 'Цена', 'Скидка', 'Сумма'], ['{#services}{n}', '{title}', '{qty}', '{price}', '{discount}', '{sum}{/services}']])
      + p('Итого: {total_sum} руб. ({total_sum_words}). Услуги оказаны полностью, претензий нет.'),
  })],
};

for (const [name, [kind, buf]] of Object.entries(samples)) {
  const v = validateTags(inspect(buf), kind);
  if (!v.ok) throw new Error(`${name}: ${v.errors.join('; ')}`);
  fs.writeFileSync(path.join(dir, name), buf);
  console.log(`${path.join(dir, name)} — вид ${kind}, тегов ${v.placeholders.length}`);
}
```

- [ ] **Step 5: Образцы собираются и проходят проверку тегов**

```bash
cd /root/loyalpro-fdoc/backend && node scripts/edocs-sample-templates.js /tmp/edocs-samples
```

Ожидается: три строки: договор — вид contract, тегов 30; согласие — consent_pd, 7; акт — act, 10.

- [ ] **Step 6: Commit**

```bash
cd /root/loyalpro-fdoc && git add backend/scripts/edocs-visual.js backend/scripts/edocs-sample-templates.js && git commit -m "test(edocs): визуальный стенд страницы и образцы DOCX-шаблонов со всеми тегами

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 17: Контрольная точка B — **Fable** (основная сессия)

- [ ] **Step 1: Всё зелёное**

```bash
cd /root/loyalpro-fdoc/backend && npx jest edocs 2>&1 | grep -E "Tests:" && timeout 180 node scripts/edocs-visual.js
cd /root/loyalpro-fdoc && for f in frontend/js/pages/*.test.js; do node --test "$f" 2>&1 | grep -E "^# fail [1-9]" && echo "  ← $f"; done; echo "фронт проверен"
```

Ожидается: `Tests: 151 passed`; строка `OK: …` стенда; «фронт проверен» без строк с `# fail N`.

- [ ] **Step 2: Ревью интерфейса**

Просмотреть скриншоты задачи 16 и дифф `frontend/`: тексты кнопок и подсказок по-русски и без жаргона; при выключенном модуле мастер показывает «Модуль выключен…», отправка недоступна, «Проверить» работает. Короткий отчёт пользователю.

---

## Часть C. Дев и живой F.Doc

### Task 18: Слияние в дев и проверка без F.Doc — **Sonnet** + стоп-точка

Дев (`pm2 loyalpro`, порт 3001, БД `loyalpro_test`) работает из `/root/loyalpro` на ветке `feat/notifications-own-module`. Модуль попадает туда слиянием; до доступов F.Doc проверяется всё, кроме отправки: таблицы, SQL на настоящей схеме, настройки, шаблоны, данные пациента, «Проверить».

- [ ] **Step 1: СТОП-ТОЧКА: подтверждение пользователя**

Контроллер спрашивает пользователя: «Сливаю `feat/fdoc-esign` в `feat/notifications-own-module`, добавляю `EDOCS_ENC_KEY` в `backend/.env` дева и перезапускаю `pm2 loyalpro`?» Без явного «да» дальше не идти.

- [ ] **Step 2: Основное дерево готово к слиянию**

```bash
cd /root/loyalpro && git status --short && git diff --name-only feat/notifications-own-module...feat/fdoc-esign
```

Ожидается: изменённые (`M`) файлы основного дерева НЕ пересекаются со списком файлов ветки. Пересечение — стоп: сообщить пользователю (чужие незакоммиченные правки не коммитить, не прятать в stash, не откатывать).

- [ ] **Step 3: Убрать неотслеживаемые копии документов, совпадающие с веткой**

```bash
cd /root/loyalpro && for f in docs/2026-10-24-fdoc-esign-feasibility.md docs/superpowers/specs/2026-10-24-fdoc-esign-design.md docs/superpowers/plans/2026-10-24-fdoc-esign.md; do
  git show feat/fdoc-esign:"$f" | cmp -s - "$f" && rm "$f" && echo "убран дубль $f" || echo "РАЗЛИЧАЕТСЯ $f — стоп, спросить пользователя"
done
```

Ожидается: три строки «убран дубль …». Иначе `git merge` откажется перезаписывать неотслеживаемые файлы, а различие значит, что документ правили после задачи 0.

- [ ] **Step 4: Слияние**

```bash
cd /root/loyalpro && git merge --no-ff feat/fdoc-esign -m "Merge feat/fdoc-esign: модуль «Документы» (F.Doc) на дев" && git log --oneline -3
```

Ожидается: коммит слияния без конфликтов.

- [ ] **Step 5: Ключ шифрования дева**

```bash
cd /root/loyalpro/backend && if grep -q '^EDOCS_ENC_KEY=' .env; then echo "ключ уже есть — не трогать"; else
  printf '\nEDOCS_ENC_KEY=%s\n' "$(node -e "console.log(require('crypto').randomBytes(32).toString('base64'))")" >> .env; fi   # ведущий \n: .env может не кончаться переводом строки
grep -c '^EDOCS_ENC_KEY=' .env
```

Ожидается: `1`. Сообщить пользователю: ключ дева лежит в `/root/loyalpro/backend/.env`, копию сохранить вне сервера; потеря ключа = потеря сохранённых паспортов и паролей F.Doc. Значение ключа в чат НЕ выводить.

- [ ] **Step 6: Зависимости и перезапуск**

```bash
cd /root/loyalpro/backend && npm install --no-audit --no-fund && PORT=3001 pm2 restart loyalpro && sleep 8 && pm2 logs loyalpro --lines 60 --nostream | grep -iE "error|edoc" | head -20
```

Ожидается: без ошибок миграций. ВНИМАНИЕ: именно `PORT=3001 pm2 restart loyalpro`, без `--update-env` (память проекта: с ним дев-сервер ломается). `.env` перечитывается при старте сам.

- [ ] **Step 7: Таблицы на месте**

Через MCP postgres (`mcp__postgres__query`):

```sql
SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name IN ('edoc_settings','edoc_user_credentials','client_identity','edoc_templates','edoc_packages','edoc_documents','edoc_events') ORDER BY 1;
```

Ожидается: 7 строк.

- [ ] **Step 8: SQL на настоящей схеме**

```bash
cd /root/loyalpro/backend && node scripts/edocs-store-smoke.js 2>&1 | tail -3
```

Ожидается: 25 строк `ok`, последняя — «SQL «Документов» в порядке (транзакция откатывается)». Без `--create-tables`: таблицы теперь настоящие, с внешними ключами.

- [ ] **Step 9: Проверка в интерфейсе (владелец, без F.Doc)**

```bash
cd /root/loyalpro/backend && node scripts/edocs-sample-templates.js /tmp/edocs-samples
```

Ожидается: три образца в `/tmp/edocs-samples`.

Дальше — руками в браузере под владельцем на https://dev.zumrudin.ru (если у исполнителя нет учётки — попросить пользователя и дождаться ответа):
1. «📄 Документы» видны в меню; уведомление «Модуль выключен…».
2. «Настройки» → «Реквизиты клиники» → заполнить «Полное наименование», «ИНН», «Город» → «Сохранить настройки» (модуль не включается — это правильно, подключение не проверено).
3. «Шаблоны документов» → загрузить три файла из `/tmp/edocs-samples` с видами «Договор», «Согласие на обработку ПДн», «Акт оказанных услуг» → в таблице видны теги, ошибок нет.
4. «Оформить» → найти тестового пациента `9200255591` → заполнить ФИО и паспорт (выдуманные) → «Сохранить данные».
5. Отметить договор → «Проверить» скачивает DOCX с подставленными данными и реквизитами; отправка недоступна, текст «Модуль выключен: документы можно проверить…».
6. «Записи»: кнопок «Акт» нет; карточка клиента: блока «Документы» нет — при выключенном модуле встройки скрыты.
7. Через MCP postgres: в `edoc_events` есть `identity_edit` для этого клиента; в `client_identity.secure_enc` — строка, начинающаяся с `v1:`, без цифр паспорта открытым текстом.

- [ ] **Step 10: Отчёт**

Короткий отчёт пользователю: что слито, что проверено, что ждёт доступов F.Doc (задача 20).

---

### Task 19: Документация — **Sonnet**

Раздел в `CLAUDE.md` (перед `## Key constraints`), чек-лист приёмки и runbook выката на прод. Выполняется в рабочей копии ветки.

**Files:**
- Modify: `CLAUDE.md`
- Create: `docs/2026-10-24-edocs-acceptance.md`, `docs/2026-10-24-edocs-runbook.md`

- [ ] **Step 1: Раздел модуля в CLAUDE.md**

В `/root/loyalpro-fdoc/CLAUDE.md` найти строку `## Key constraints` и вставить ПЕРЕД ней (с пустой строкой после раздела):

```markdown
### «Документы»: электронное подписание с пациентами через F.Doc (с 2026-10)
Статус: ветка `feat/fdoc-esign`, на проде нет; модуль салона выключен (`edoc_settings.enabled`), пока не проверено подключение к F.Doc. Спека `docs/superpowers/specs/2026-10-24-fdoc-esign-design.md`, план `docs/superpowers/plans/2026-10-24-fdoc-esign.md`, исследование API `docs/2026-10-24-fdoc-esign-feasibility.md`, приёмка `docs/2026-10-24-edocs-acceptance.md`, выкат на прод `docs/2026-10-24-edocs-runbook.md`. Модуль `services/edocs/` (placeholders → docx → fio/identity → act-lines → fill → statuses → send-body → store → packages), клиент `services/fdoc/client.js`, роутеры `routes/edocs-admin.js` (`/api/edocs/admin`, owner/admin, смонтирован раньше общего) и `routes/edocs.js` (`/api/edocs`, + admin_cashier через `CASHIER_ALLOWED_PREFIXES`), вебхук `routes/fdoc-webhook.js` (`POST /fdoc/webhook/<секрет салона>`), страница «📄 Документы» (`frontend/js/pages/edocs.js` + чистые `edocs-helpers.js`, адрес в hash: `#edocs`, `#edocs/new/<клиент>[/<запись>]`, `#edocs/p/<комплект>`, `#edocs/settings`). Тесты: `npx jest edocs` (9 наборов), `node --test frontend/js/pages/edocs.test.js`.
- Решения владельца 24.10.2026: ИДС пока на бумаге; паспорт хранится у нас; подпись от клиники одна — КЭП организации (`qesCertAlias` + `operatorAutoSign`), но учётная запись F.Doc у каждого пользователя своя (отправитель виден в журнале F.Doc); SMS на каждый акт допустима.
- Документы собираем САМИ из DOCX-шаблонов салона (docxtemplater, теги `{fio}`, строки акта — `{#services}…{/services}` в строке таблицы) и отправляем готовым DOCX в `POST /paperless-gateway/api/v1/document/withSigners`; шаблоны F.Doc не используем (паспорт вводит администратор у нас, таблицу акта параметры F.Doc не выражают). Словарь тегов — единственный источник истины (`placeholders.FIELDS`): каждому тегу обязано соответствовать значение в `fill.js` (на это тест), пустое — «________». ГОТЧА: `InspectModule` docxtemplater падает на `require('lodash')` (нет в его зависимостях) — теги берём штатным `doc.getTags()`; `errorLogging:false`, иначе библиотека печатает ошибки шаблона в stdout.
- Секреты: `utils/secret-box.js` (AES-256-GCM, `v1:iv:tag:data`), ключ `EDOCS_ENC_KEY` (32 байта base64). Ключа нет — 503, открытым текстом ничего не пишется. Шифруются паспортная часть (`client_identity.secure_enc`; `secure_fields` — какие поля заполнены, полнота проверяется без расшифровки), ключ API и пароль приложения F.Doc, пароли сотрудников. Токены F.Doc — только в памяти процесса (accessToken живёт 3 минуты; на сотрудника один вход за раз — refreshToken ротируется при каждом входе). Ключи дева и прода разные; потеря ключа = потеря паспортов и паролей. Просмотр и правка паспорта — в `edoc_events` (`identity_view`/`identity_edit`, без значений).
- Статус комплекта — только из ответа F.Doc под НАШИМ токеном. Вебхук без заголовка авторизации (секрет — в URL) лишь запускает перечитывание; страховка — крон `*/5` (`packages.refreshDue`, `EDOCS_POLL=false` гасит). Подписанные PDF — в S3 `edocs/<салон>/packages/<комплект>/<документ>.pdf`, наружу presigned-ссылкой на 15 минут; `frontend/uploads` для них нельзя (раздаётся всем).
- ГОТЧА, пойманная тестом прототипа: экспорт роутера с именем `handle` перезаписывает внутренний метод `express.Router` — роутер перестаёт отвечать (обработчик вебхука поэтому `processWebhook`).
- Акт: строки из `records.services`, сумма строки — `manual_cost` (после скидки, ДО оплаты бонусами: YClients иногда вычитает бонус прямо из `cost`), `discount` — процент, номер акта — `yclients_record_id`, только визит с `attendance=1` и не удалённый. Администратор правит строки перед отправкой; сумма прописью — `utils/money-words.js`.
- Отправка вслепую не повторяется: черновик с `last_error` повторяется кнопкой, и `resend` сначала спрашивает F.Doc, нет ли уже такого комплекта (ответ мог потеряться). id комплекта и документов — наши UUID. Демо-стенд (`demo.*`) шлёт настоящие SMS, а в дев-БД живые пациенты — отправка туда только на `EDOCS_DEMO_PHONES` (по умолчанию тестовый 79200255591).
- Мастер оформления работает и при выключенном модуле (данные пациента, «Проверить» — заполненный DOCX без отправки), блокируется только отправка; блок в карточке клиента и кнопки «Акт» в «Записях» при выключенном модуле скрыты.
- Живые проверки: `scripts/edocs-store-smoke.js` (весь SQL в откатываемой транзакции, `--create-tables` — до миграции), `scripts/edocs-visual.js` (изолированный стенд: две темы, 390px, F5, роль кассира), `scripts/edocs-sample-templates.js` (образцы DOCX со всеми тегами), `scripts/edocs-fdoc-e2e.js` (демо-стенд F.Doc, ответы на вопросы спеки §13).
```

- [ ] **Step 2: Чек-лист приёмки**

Создать `docs/2026-10-24-edocs-acceptance.md`:

```markdown
# «Документы» (F.Doc) — чек-лист приёмки

Дата: 2026-10-24. Спека `docs/superpowers/specs/2026-10-24-fdoc-esign-design.md`. Отмечать на деве (демо-стенд F.Doc) и повторить сокращённо на проде (раздел «Прод» в конце). Отправка — только на тестовый номер 79200255591 или телефоны сотрудников.

## Подготовка
- [ ] В `backend/.env` задан `EDOCS_ENC_KEY` (32 байта base64), копия ключа сохранена вне сервера.
- [ ] После рестарта в БД есть таблицы `edoc_settings`, `edoc_user_credentials`, `client_identity`, `edoc_templates`, `edoc_packages`, `edoc_documents`, `edoc_events`; `node scripts/edocs-store-smoke.js` — все строки `ok`.
- [ ] «📄 Документы» → «Настройки»: адрес стенда, ключ API, логин/пароль/код приложения сохранены; «Проверить подключение» показывает номер организации; «Тариф» показывает остаток.
- [ ] Реквизиты клиники заполнены; загружены шаблоны (договор, согласие ПДн, акт) — теги распознаны, неизвестных нет.
- [ ] Каждый администратор подключил «Мой F.Doc» — в «Сотрудники и F.Doc» стоит ✓.

## Сценарии
1. [ ] **Первичный пакет.** Пациент из поиска → данные (по фото паспорта или вручную) → «Сохранить данные» → отметить договор и согласие → «Проверить» скачивает DOCX с данными → «Отправить» → карточка комплекта «Ждёт подписи», клиника уже подписала.
2. [ ] **Подпись пациентом.** SMS пришла на телефон, документы подписаны кодом → в течение 5 минут (или сразу при вебхуке) статус «Подписан», время подписи пациента заполнено, кнопки «PDF» открывают документы со штампом.
3. [ ] **Акт по визиту.** «Записи» → у пришедшего визита «📄 Акт» → строки из записи (сумма = после скидки, до бонусов) → снять одну строку, поправить сумму → итог пересчитан → отправка → в «Записях» значок «Акт: Ждёт подписи».
4. [ ] **Нехватка данных.** Шаблон с паспортом, у пациента нет серии → «Отправить» заблокирована, текст «Не хватает данных пациента: Серия паспорта…».
5. [ ] **Повтор после сбоя.** (Имитация: неверный адрес стенда / отключённая сеть.) Комплект остаётся «Не отправлен» с текстом ошибки → «Повторить отправку» после восстановления — один комплект в F.Doc, не два.
6. [ ] **Аннулирование.** Комплект «Ждёт подписи» → «Аннулировать» → статус «Аннулирован», ссылка у пациента больше не подписывает.
7. [ ] **Повторная ссылка.** «Отправить ссылку ещё раз» → пациенту пришла SMS.
8. [ ] **Неверный пароль F.Doc.** Сменить пароль в F.Doc → отправка даёт «обновите пароль в «Мой F.Doc»», окно открывается само.
9. [ ] **Администратор-кассир.** Видит «📄 Документы», оформляет и отправляет; вкладки «Настройки» нет, `#edocs/settings` возвращает на список.
10. [ ] **Карточка клиента.** Блок «Документы»: ФИО, маска паспорта, комплекты, кнопка «Оформить документы».
11. [ ] **Журнал.** В `edoc_events` есть `identity_view` при открытии формы с паспортом и `identity_edit` при сохранении — без значений паспорта.
12. [ ] **Демо-защита.** На демо-стенде отправка на номер не из `EDOCS_DEMO_PHONES` — ошибка «Демо-стенд F.Doc: отправка только на тестовые номера».
13. [ ] **Вебхук.** После «Подписаться» (IP зарегистрирован у F.Doc) в настройках видно время последнего уведомления; статус меняется без ожидания опроса.
14. [ ] **Телефон 390 px.** Мастер и карточка комплекта без горизонтальной прокрутки; строки акта — карточками.

## Прод
- [ ] Сценарии 1–3 и 13 на телефоне сотрудника; затем сценарий 1 на первом реальном пациенте с его согласия.
```

- [ ] **Step 3: Runbook выката на прод**

Создать `docs/2026-10-24-edocs-runbook.md`:

````markdown
# «Документы» (F.Doc) — выкат на прод

Дата: 2026-10-24. Предусловия: ветка `feat/fdoc-esign` слита в ветку, которая идёт на прод; приёмка на деве пройдена (`docs/2026-10-24-edocs-acceptance.md`); у клиники заключён договор с F.Doc и выданы ПРОД-доступы (ключ API, логин/пароль/код приложения, учётные записи сотрудников, алиас КЭП организации).

## 1. Ключ шифрования
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```
- Добавить в прод `backend/.env` строку `EDOCS_ENC_KEY=<ключ>`. Ключ прода НЕ совпадает с ключом дева.
- Сохранить ключ в менеджере паролей владельца. Без него паспортные данные и пароли F.Doc невосстановимы.
- `EDOCS_DEMO_PHONES` на проде не нужен (действует только на стенде `demo.*`).

## 2. Код и зависимости
```bash
cd /root/loyalpro_new/backend && git pull && npm install && pm2 restart loyalpro && pm2 logs loyalpro --lines 50
```
- В логах нет ошибок миграций; таблицы на месте:
```sql
SELECT table_name FROM information_schema.tables WHERE table_name IN ('edoc_settings','edoc_user_credentials','client_identity','edoc_templates','edoc_packages','edoc_documents','edoc_events');
```
- S3 настроен (`S3_*` в `.env`) — подписанные PDF и шаблоны лежат там.

## 3. F.Doc
- Передать менеджеру F.Doc IP прод-сервера для вебхуков (`dig +short <домен прода>`) и исходящий IP (`curl -s ifconfig.me`).
- «📄 Документы» → «Настройки»: адрес боевого стенда (уточнить у F.Doc), ключ API, логин/пароль/код приложения, алиас КЭП клиники, должность подписанта → «Сохранить» → «Проверить подключение» → «Тариф».
- Реквизиты клиники; загрузить утверждённые клиникой шаблоны (договор, согласие ПДн, акт).
- Каждый администратор: «Мой F.Doc» → логин/пароль своей учётной записи F.Doc.
- После регистрации IP — «Подписаться» на уведомления.

## 4. Пробный запуск
- Включить модуль, отправить первичный пакет и акт на телефон сотрудника, подписать, открыть PDF.
- Проверить журнал: `SELECT kind, created_at FROM edoc_events ORDER BY id DESC LIMIT 20;`

## 5. Откат
- «Настройки» → снять «Модуль включён» — оформление и отправка блокируются, данные и PDF остаются.
- `EDOCS_POLL=false` в `.env` + `pm2 restart loyalpro` — гасит только фоновый опрос F.Doc.
- Таблицы и объекты S3 не удалять (правило проекта «никогда деструктивно»).
````

- [ ] **Step 4: Commit**

```bash
cd /root/loyalpro-fdoc && git add CLAUDE.md docs/2026-10-24-edocs-acceptance.md docs/2026-10-24-edocs-runbook.md && git commit -m "docs(edocs): раздел «Документы» в CLAUDE.md, чек-лист приёмки и runbook выката

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 5: Слить в дев (если можно)**

Повторить шаги 2 и 4 задачи 18. Если в основном дереве не закоммичен изменённый `CLAUDE.md` (на 24.10.2026 там чужая правка) — НЕ сливать: сообщить пользователю, что документация ждёт, пока владелец той правки её закоммитит.

---

### Task 20: Живой F.Doc на демо-стенде — **Opus** (блокер: доступы F.Doc)

Начинать, когда пользователь передаст демо-доступы: API Key, логин/пароль/код приложения, логин/пароль учётной записи сотрудника. Это секреты: только в переменных окружения сессии и в форме настроек, не в файлах репозитория и не в чате дословно. Отправка — только на тестовый номер 79200255591 (на демо-стенде код и так не пустит другие номера). Скрипт отвечает на открытые вопросы спеки §13; если ответы расходятся с допущениями кода, правка делается в рабочей копии ветки по TDD и сливается в дев.

**Files:**
- Create: `backend/scripts/edocs-fdoc-e2e.js`
- Возможно Modify (по итогам спайка): `backend/services/edocs/statuses.js` (сопоставление документов), `backend/services/edocs/send-body.js` (формат срока подписания), их тесты; `CLAUDE.md`

- [ ] **Step 1: Скрипт живой проверки**

Создать `backend/scripts/edocs-fdoc-e2e.js`:

```js
'use strict';
// Живая проверка клиента F.Doc на ДЕМО-стенде (контур без юридической силы). В БД ничего
// не пишет. Отвечает на открытые вопросы спеки §13: принимает ли F.Doc наш DOCX с кириллицей
// и таблицей, возвращает ли в статусах НАШИ id комплекта и документов, какой формат срока
// подписания понимает, ставится ли автоподпись клиники.
// Переменные окружения:
//   FDOC_E2E_BASE (по умолчанию https://demo.fdoc.ru), FDOC_E2E_API_KEY, FDOC_E2E_APP_LOGIN,
//   FDOC_E2E_APP_PASSWORD, FDOC_E2E_APP_CODE, FDOC_E2E_LOGIN, FDOC_E2E_PASSWORD,
//   FDOC_E2E_PHONE (по умолчанию 79200255591 — тестовый номер), FDOC_E2E_QES (алиас КЭП клиники).
// Режимы:
//   node scripts/edocs-fdoc-e2e.js --dry          вход, тариф, сборка DOCX — без отправки
//   node scripts/edocs-fdoc-e2e.js                отправка комплекта + опрос статуса 90 с
//   node scripts/edocs-fdoc-e2e.js --status <id>  статус комплекта (сырой ответ)
//   node scripts/edocs-fdoc-e2e.js --pdf <id>     PDF подписанных документов → /tmp/edocs-e2e-<doc>.pdf
//   node scripts/edocs-fdoc-e2e.js --annul <id>   аннулировать неподписанный комплект
const crypto = require('crypto');
const fs = require('fs');
const { makeClient } = require('../services/fdoc/client');
const { makeDocx, p, table } = require('../services/edocs/__fixtures__/docx');
const docx = require('../services/edocs/docx');
const { buildRenderData } = require('../services/edocs/fill');
const { buildSendBody } = require('../services/edocs/send-body');

const env = (k, d) => (process.env[k] || d || '').trim();
const S = {
  baseUrl: env('FDOC_E2E_BASE', 'https://demo.fdoc.ru'), apiKey: env('FDOC_E2E_API_KEY'), appLogin: env('FDOC_E2E_APP_LOGIN'),
  appPassword: env('FDOC_E2E_APP_PASSWORD'), appCode: env('FDOC_E2E_APP_CODE'), corpId: null,
};
const CRED = { userId: 1, login: env('FDOC_E2E_LOGIN'), password: env('FDOC_E2E_PASSWORD') };
const PHONE = env('FDOC_E2E_PHONE', '79200255591');
const args = process.argv.slice(2);
const arg = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };

const missing = ['FDOC_E2E_API_KEY', 'FDOC_E2E_APP_LOGIN', 'FDOC_E2E_APP_PASSWORD', 'FDOC_E2E_APP_CODE', 'FDOC_E2E_LOGIN', 'FDOC_E2E_PASSWORD'].filter((k) => !env(k));
if (missing.length) {
  console.error(`Нет переменных: ${missing.join(', ')} — их выдаёт F.Doc вместе с демо-доступом.`);
  process.exit(2);
}

const show = (label, x) => console.log(`${label}:`, JSON.stringify(x, null, 2));

async function main() {
  const fdoc = makeClient();
  S.corpId = await fdoc.verifyApiKey(S);
  console.log(`corpId: ${S.corpId}`);
  await fdoc.checkCredentials(S, CRED);
  console.log('вход сотрудника: ок');
  show('тариф', await fdoc.tariffInfo(S).catch((e) => `ошибка: ${e.message}`));

  if (arg('--status')) return show('статус', await fdoc.workflowStatuses(S, CRED, [arg('--status')]));
  if (arg('--annul')) { await fdoc.declinePackage(S, CRED, arg('--annul')); return console.log('аннулирован'); }
  if (arg('--pdf')) {
    const id = arg('--pdf');
    const st = await fdoc.workflowStatuses(S, CRED, [id]);
    const pkg = st.packages[0];
    if (!pkg) return show('комплект не найден', st);
    for (const d of pkg.documents || []) {
      const buf = await fdoc.downloadPdf(S, CRED, pkg.id, d.id);
      fs.writeFileSync(`/tmp/edocs-e2e-${d.id}.pdf`, buf);
      console.log(`/tmp/edocs-e2e-${d.id}.pdf — ${buf.length} байт`);
    }
    return null;
  }

  const identity = { plain: { last_name: 'Тестова', first_name: 'Анна', middle_name: 'Сергеевна', birth_date: '1990-01-15', gender: 'F', phone: PHONE, email: null, contract_no: 'E2E-1', contract_date: null },
    secure: { passport_series: '4500', passport_number: '000001', issued_by: 'Тестовое отделение «Пример»', issue_date: '2015-05-01', authority_code: '770-001' } };
  const requisites = { name: 'ООО «Тестовая клиника»', inn: '0000000000', city: 'Москва' };
  const act = { act_no: 'E2E', visit_date: '2026-10-23', doctor_name: 'Тестовый врач', doctor_position: 'Врач-косметолог',
    lines: [{ title: 'Чистка лица комбинированная', qty: 1, price: 3500, sum: 3500 }, { title: 'Фотоомоложение — лицо', qty: 1, price: 17500, sum: 15750 }] };
  const contract = docx.render(makeDocx({ body: p('Договор № {contract_no} от {doc_date}, г. {doc_city}') + p('{org_name} и {fio}, паспорт {passport}, выдан {passport_issued_by} {passport_issue_date}.') }),
    buildRenderData({ identity, requisites, docDate: '2026-10-24' }));
  const actDoc = docx.render(makeDocx({ body: p('Акт № {act_no} от {doc_date}. Пациент: {fio}. Врач: {doctor_name}.')
    + table([['№', 'Услуга', 'Кол-во', 'Цена', 'Сумма'], ['{#services}{n}', '{title}', '{qty}', '{price}', '{sum}{/services}']]) + p('Итого: {total_sum} ({total_sum_words})') }),
    buildRenderData({ identity, requisites, docDate: '2026-10-24', act }));
  console.log(`DOCX собраны: договор ${contract.length} байт, акт ${actDoc.length} байт`);
  if (args.includes('--dry')) return null;

  const packageId = crypto.randomUUID();
  const docs = [{ id: crypto.randomUUID(), file_name: 'Договор E2E.docx' }, { id: crypto.randomUUID(), file_name: 'Акт E2E.docx' }];
  const body = buildSendBody({ packageId, title: 'E2E LoyalPro', clientId: 999999, docs, files: [contract, actDoc], identity,
    settings: { unsign_days: 1, qes_cert_alias: env('FDOC_E2E_QES') || null, employee_position: 'Администратор' } });
  console.log(`отправляю комплект ${packageId}: документы ${docs.map((d) => d.id).join(', ')}, срок ${body.documents[0].unsignExpiredDate}`);
  show('ответ на отправку', await fdoc.sendPackage(S, CRED, body));
  for (let i = 0; i < 9; i++) {
    await new Promise((r) => setTimeout(r, 10000));
    const st = await fdoc.workflowStatuses(S, CRED, [packageId]);
    show(`статус через ${(i + 1) * 10} с`, st);
    const pkg = st.packages[0];
    if (pkg) {
      console.log(`наш id комплекта ${pkg.id === packageId ? 'СОВПАЛ' : `НЕ совпал (F.Doc: ${pkg.id})`}; `
        + `id документов ${(pkg.documents || []).every((d) => docs.some((x) => x.id === d.id)) ? 'СОВПАЛИ' : 'НЕ совпали'}`);
      if (pkg.status && pkg.status !== 'PREPARED') break;
    }
  }
  console.log(`Дальше: подпишите на телефоне ${PHONE} и запустите --pdf ${packageId}; или --annul ${packageId}.`);
  return null;
}

main().catch((e) => { console.error(`ОШИБКА: ${e.message}`); process.exit(1); });
```

- [ ] **Step 2: Без доступов скрипт честно отказывается**

```bash
cd /root/loyalpro-fdoc/backend && node scripts/edocs-fdoc-e2e.js --dry; echo "exit=$?"
```

Ожидается: строка «Нет переменных: FDOC_E2E_API_KEY, …» и `exit=2`.

- [ ] **Step 3: Commit**

```bash
cd /root/loyalpro-fdoc && git add backend/scripts/edocs-fdoc-e2e.js && git commit -m "test(edocs): живая проверка клиента F.Doc на демо-стенде

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 4: Вход и сборка без отправки**

```bash
cd /root/loyalpro-fdoc/backend && export FDOC_E2E_API_KEY=… FDOC_E2E_APP_LOGIN=… FDOC_E2E_APP_PASSWORD=… FDOC_E2E_APP_CODE=… FDOC_E2E_LOGIN=… FDOC_E2E_PASSWORD=…
node scripts/edocs-fdoc-e2e.js --dry
```

Ожидается: `corpId: …`, «вход сотрудника: ок», ответ о тарифе, «DOCX собраны…». Ошибка входа — сверить доступы с F.Doc, код не трогать.

- [ ] **Step 5: Отправка комплекта и ответы на вопросы спеки**

```bash
cd /root/loyalpro-fdoc/backend && node scripts/edocs-fdoc-e2e.js 2>&1 | tee /tmp/edocs-e2e-send.log | tail -40
```

Ожидается: ответ на отправку со ссылкой окна сотрудника; через 10–90 с статус не `PREPARED`; строка «наш id комплекта СОВПАЛ; id документов СОВПАЛИ».

Записать в отчёт: (1) совпали ли id — если F.Doc вернул свои, `statuses.applyWorkflow` сопоставит по имени файла и запомнит GUID (так задумано), но проверить, что `--status <id>` по НАШЕМУ id работает; если нет — пакетный опрос в `packages.refreshRows` надо переключить на `fdoc_package_guid`; (2) принят ли срок `unsignExpiredDate` в формате ISO (`toISOString()`); если 400 из-за формата — поменять в `send-body.buildSendBody` и дописать тест; (3) поставилась ли автоподпись клиники (подпись сотрудника в статусе по `employeeSigners`); (4) какие статусы реально пришли.

- [ ] **Step 6: Подпись и PDF**

```bash
cd /root/loyalpro-fdoc/backend && node scripts/edocs-fdoc-e2e.js --pdf <id из шага 5>
```

Ожидается: на телефоне 79200255591 пришла SMS, документы подписаны; после этого — файлы `/tmp/edocs-e2e-<документ>.pdf`.

Открыть PDF глазами: кириллица, таблица акта, сумма прописью, штамп подписи. Плохой рендер DOCX у F.Doc — резерв из спеки §10 (акт в PDF у себя на `pdf-lib`) обсудить с пользователем, не делать молча.

- [ ] **Step 7: Дев целиком**

На https://dev.zumrudin.ru под владельцем: «Настройки» → адрес `https://demo.fdoc.ru`, ключ API, логин/пароль/код приложения, должность подписанта → «Сохранить» → «Проверить подключение» (номер организации) → «Тариф» → «Модуль включён» → «Сохранить». «Мой F.Doc» → учётка сотрудника. Пройти сценарии 1–12 и 14 из `docs/2026-10-24-edocs-acceptance.md` на тестовом пациенте 79200255591. Отметить пройденное в чек-листе (в рабочей копии ветки).

- [ ] **Step 8: Вебхук**

Передать менеджеру F.Doc IP дева для вебхуков (`dig +short dev.zumrudin.ru`) и исходящий IP (`curl -s ifconfig.me`). После регистрации: «Настройки» → «Подписаться» → отправить ещё один комплект → в «Уведомлениях F.Doc о статусах» появилось время последнего уведомления, в `edoc_events` — строки `webhook` (сценарий 13).

- [ ] **Step 9: Итоги спайка — в документацию**

В `CLAUDE.md` (раздел «Документы») дописать проверенные факты: совпадают ли id, формат срока, какие статусы приходят, работает ли автоподпись КЭП, задержка вебхука. Правки кода, если были, — отдельными коммитами с тестами. Commit:

```bash
cd /root/loyalpro-fdoc && git add CLAUDE.md docs/2026-10-24-edocs-acceptance.md && git commit -m "docs(edocs): итоги живой проверки F.Doc на демо-стенде

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

Затем слить ветку в дев (шаги 2 и 4 задачи 18) и перезапустить `PORT=3001 pm2 restart loyalpro`, если менялся код.

---

### Task 21: Итоговое ревью — **Fable** (основная сессия)

- [ ] **Step 1: Сверка со спекой**

Пройти спеку разделы 3–8 и убедиться, что каждое требование покрыто кодом или осознанно отложено (раздел 11 спеки). Свериться с чек-листом приёмки: что отмечено, что ждёт F.Doc.

- [ ] **Step 2: Тесты**

```bash
cd /root/loyalpro-fdoc/backend && npx jest edocs 2>&1 | grep -E "Tests:" && timeout 180 node scripts/edocs-visual.js && cd /root/loyalpro-fdoc && node --test frontend/js/pages/edocs.test.js 2>&1 | grep -E "^# (pass|fail)"
```

Ожидается: `Tests: 151 passed` (больше, если задача 20 добавила тесты); `OK: …`; `# pass 11`, `# fail 0`.

- [ ] **Step 3: Отчёт и решение о проде**

Отчёт пользователю: что работает на деве, что проверено на демо-стенде F.Doc, что осталось (договор с F.Doc, прод-доступы, КЭП организации, тексты шаблонов от клиники). Выкат на прод — только по решению владельца, по `docs/2026-10-24-edocs-runbook.md`; ветку дальше ведёт навык superpowers:finishing-a-development-branch. Обновить память проекта: статус модуля и путь к плану. План выполнен — сказать это явно и закрыть задачи.

