# Самозаявка на справку (Wix → LoyalPro) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Дать пациенту подать с сайта Wix заявку на налоговую справку (КНД 1151156), сразу скачать «Заявление», а данные — отправить в новый раздел LoyalPro, откуда сотрудник открывает существующий генератор справок с предзаполнением.

**Architecture:** Публичная страница-форма хостится в LoyalPro и встраивается в Wix через iframe (для неё переопределяем frame-заголовки). Публичный роутер монтируется ДО JWT-мидлвари. Данные → таблица `cert_requests`, пациент матчится по телефону в `clients`. Staff-раздел переиспользует генератор `medical-cert`.

**Tech Stack:** Node/Express, PostgreSQL (`pg`, миграции `IF NOT EXISTS`), pdf-lib + @pdf-lib/fontkit, ванильный JS, `node:test`.

**Спека:** [docs/superpowers/specs/2026-06-18-cert-request-self-service-design.md](../specs/2026-06-18-cert-request-self-service-design.md)

---

## Файловая структура

| Файл | Ответственность |
|---|---|
| `backend/migrations.js` (modify) | таблица `cert_requests`, колонка `salons.cert_request_slug` + бэкфилл |
| `backend/config.js` (modify) | `CERT_REQUEST_FRAME_ANCESTORS` (разрешённые домены для iframe) |
| `backend/services/cert-request.js` (create) | чистые хелперы (телефон, ИНН, rate-limit, токены), матчинг, сумма, PDF «Заявление» |
| `backend/services/cert-request.test.js` (create) | юнит-тесты сервиса |
| `backend/routes/public-cert-request.js` (create) | публичные роуты: страница формы, config, приём, скачивание заявления |
| `backend/routes/index.js` (modify) | монтирование публичного роутера ДО JWT-guard |
| `backend/routes/medical-cert.js` (modify) | staff-эндпоинты: list/detail/status/match/prefill |
| `frontend/cert-request.html` (create) | публичная страница-форма (для iframe) |
| `frontend/js/cert-request.js` (create) | логика формы |
| `frontend/js/pages/cert-requests.js` (create) | staff-раздел «Заявки на справки» |
| `frontend/js/pages/medical-cert.js` (modify) | `mcPrefillFromRequest()` — заполнить генератор из заявки |
| `frontend/index.html` (modify) | нав-пункт, страница раздела, подключение скрипта |
| `frontend/js/core/nav.js` (modify) | роутинг на новый раздел |
| `docs/cert-request-wix-embed.md` (create) | инструкция по встройке iframe в Wix |

---

## Task 1: Миграция БД — таблица заявок и slug салона

**Files:**
- Modify: `backend/migrations.js` (перед закрывающей `}` функции `runMigrations`, после блока `medical_cert_coords`)

- [ ] **Step 1: Добавить таблицу и колонку slug**

В `backend/migrations.js` сразу после блока создания `medical_cert_coords` (он заканчивается `).catch(() => {});`) и ПЕРЕД `}` функции добавить:

```js
  // ── Заявки на справку (самозаявка с сайта) ─────────────────────
  await client.query(`
    ALTER TABLE salons ADD COLUMN IF NOT EXISTS cert_request_slug VARCHAR(40)
  `).catch(() => {});
  // бэкфилл slug для салонов без значения: 'clinic-<id>'
  await client.query(`
    UPDATE salons SET cert_request_slug = 'clinic-' || id WHERE cert_request_slug IS NULL
  `).catch(() => {});
  await client.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS salons_cert_request_slug_uq
      ON salons(cert_request_slug)
  `).catch(() => {});

  await client.query(`
    CREATE TABLE IF NOT EXISTS cert_requests (
      id                        SERIAL PRIMARY KEY,
      salon_id                  INTEGER NOT NULL REFERENCES salons(id) ON DELETE CASCADE,
      status                    VARCHAR(20) NOT NULL DEFAULT 'new',
      report_year               INTEGER NOT NULL,
      payer_is_patient          BOOLEAN NOT NULL,
      payer_last                VARCHAR(120),
      payer_first               VARCHAR(120),
      payer_middle              VARCHAR(120),
      payer_birthdate           DATE,
      payer_inn                 VARCHAR(12),
      payer_doc_type_code       VARCHAR(2),
      payer_doc_serie_number    VARCHAR(20),
      payer_doc_issue_date      DATE,
      payer_phone               VARCHAR(20),
      payer_email               VARCHAR(190),
      patient_last              VARCHAR(120),
      patient_first             VARCHAR(120),
      patient_middle            VARCHAR(120),
      patient_birthdate         DATE,
      patient_inn               VARCHAR(12),
      patient_doc_type_code     VARCHAR(2),
      patient_doc_serie_number  VARCHAR(20),
      patient_doc_issue_date    DATE,
      patient_phone             VARCHAR(20),
      relationship              VARCHAR(20),
      matched_client_id         INTEGER REFERENCES clients(id) ON DELETE SET NULL,
      computed_amount           NUMERIC(12,2),
      consent_at                TIMESTAMPTZ NOT NULL,
      ip                        VARCHAR(64),
      user_agent                VARCHAR(400),
      created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at                TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `).catch(() => {});
  await client.query(`
    CREATE INDEX IF NOT EXISTS cert_requests_salon_status_idx
      ON cert_requests(salon_id, status, created_at DESC)
  `).catch(() => {});
  await client.query(`
    CREATE INDEX IF NOT EXISTS cert_requests_salon_match_idx
      ON cert_requests(salon_id, matched_client_id)
  `).catch(() => {});
```

- [ ] **Step 2: Прогнать миграции и проверить схему**

Run:
```bash
cd backend && node -e "require('./migrations').runMigrations().then(async()=>{const {db}=require('./db');const c=await db.any(\"SELECT column_name FROM information_schema.columns WHERE table_name='cert_requests' ORDER BY ordinal_position\");console.log(c.map(r=>r.column_name).join(','));const s=await db.oneOrNone(\"SELECT cert_request_slug FROM salons WHERE id=1\");console.log('slug salon1:',s&&s.cert_request_slug);process.exit(0)}).catch(e=>{console.error(e);process.exit(1)})"
```
Expected: печатает список колонок (включая `matched_client_id`, `consent_at`) и `slug salon1: clinic-1`.

- [ ] **Step 3: Commit**

```bash
git add backend/migrations.js
git commit -m "feat(cert-request): миграция cert_requests + salons.cert_request_slug"
```

---

## Task 2: Чистые хелперы сервиса (телефон, ИНН, rate-limit, токены)

**Files:**
- Create: `backend/services/cert-request.js`
- Create: `backend/services/cert-request.test.js`

- [ ] **Step 1: Написать падающие тесты**

Создать `backend/services/cert-request.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert');
const {
  normalizePhone, validateInn, makeRateLimiter, makeTokenStore,
} = require('./cert-request');

test('normalizePhone: только цифры, 8→7 не трогаем (оставляем как есть)', () => {
  assert.strictEqual(normalizePhone('+7 (912) 345-67-89'), '79123456789');
  assert.strictEqual(normalizePhone('8 912 345 67 89'), '89123456789');
  assert.strictEqual(normalizePhone(''), '');
  assert.strictEqual(normalizePhone(null), '');
});

test('validateInn: валидный 12-значный (физлицо)', () => {
  assert.strictEqual(validateInn('500100732259'), true);
  assert.strictEqual(validateInn('500100732258'), false); // битая контрольная
});

test('validateInn: валидный 10-значный (юрлицо)', () => {
  assert.strictEqual(validateInn('7830002293'), true);
  assert.strictEqual(validateInn('7830002292'), false);
});

test('validateInn: неверная длина/нецифры → false', () => {
  assert.strictEqual(validateInn('12345'), false);
  assert.strictEqual(validateInn('abcdefghij'), false);
  assert.strictEqual(validateInn(''), false);
  assert.strictEqual(validateInn(null), false);
});

test('makeRateLimiter: пропускает до лимита, потом блокирует, окно сбрасывается', () => {
  let now = 1000;
  const rl = makeRateLimiter({ max: 2, windowMs: 100, now: () => now });
  assert.strictEqual(rl('1.1.1.1'), true);
  assert.strictEqual(rl('1.1.1.1'), true);
  assert.strictEqual(rl('1.1.1.1'), false);     // лимит исчерпан
  assert.strictEqual(rl('2.2.2.2'), true);       // другой IP — свой счётчик
  now += 101;                                     // окно прошло
  assert.strictEqual(rl('1.1.1.1'), true);
});

test('makeTokenStore: выдаёт токен, отдаёт значение в TTL, истекает после', () => {
  let now = 0;
  const store = makeTokenStore({ ttlMs: 100, now: () => now });
  const tok = store.put({ requestId: 7, salonId: 1 });
  assert.strictEqual(typeof tok, 'string');
  assert.deepStrictEqual(store.get(tok), { requestId: 7, salonId: 1 });
  now = 101;
  assert.strictEqual(store.get(tok), null);
});
```

- [ ] **Step 2: Запустить — убедиться, что падает**

Run: `cd backend && node --test services/cert-request.test.js`
Expected: FAIL — `Cannot find module './cert-request'` / функции не определены.

- [ ] **Step 3: Реализовать хелперы**

Создать `backend/services/cert-request.js`:

```js
// backend/services/cert-request.js
'use strict';

const crypto = require('crypto');

// Телефон → только цифры (нормализация для хранения и сравнения).
function normalizePhone(raw) {
  return (raw == null ? '' : String(raw)).replace(/\D/g, '');
}

// Контрольные цифры ИНН: 10 знаков (юрлицо) или 12 (физлицо).
function validateInn(raw) {
  const s = (raw == null ? '' : String(raw)).trim();
  if (!/^\d{10}$/.test(s) && !/^\d{12}$/.test(s)) return false;
  const d = s.split('').map(Number);
  const csum = (coeffs) => coeffs.reduce((a, c, i) => a + c * d[i], 0) % 11 % 10;
  if (s.length === 10) {
    return csum([2, 4, 10, 3, 5, 9, 4, 6, 8]) === d[9];
  }
  const n11 = csum([7, 2, 4, 10, 3, 5, 9, 4, 6, 8]);
  const n12 = csum([3, 7, 2, 4, 10, 3, 5, 9, 4, 6, 8]);
  return n11 === d[10] && n12 === d[11];
}

// In-memory rate-limit по ключу (IP). now() инъектируется для тестов.
function makeRateLimiter({ max, windowMs, now = () => Date.now() }) {
  const hits = new Map(); // key -> { count, resetAt }
  return function allow(key) {
    const t = now();
    const rec = hits.get(key);
    if (!rec || t >= rec.resetAt) { hits.set(key, { count: 1, resetAt: t + windowMs }); return true; }
    if (rec.count >= max) return false;
    rec.count += 1;
    return true;
  };
}

// In-memory короткоживущие токены (для скачивания «Заявления»).
function makeTokenStore({ ttlMs, now = () => Date.now() }) {
  const m = new Map(); // token -> { value, expiresAt }
  return {
    put(value) {
      const token = crypto.randomBytes(24).toString('hex');
      m.set(token, { value, expiresAt: now() + ttlMs });
      return token;
    },
    get(token) {
      const rec = m.get(token);
      if (!rec) return null;
      if (now() >= rec.expiresAt) { m.delete(token); return null; }
      return rec.value;
    },
  };
}

module.exports = { normalizePhone, validateInn, makeRateLimiter, makeTokenStore };
```

- [ ] **Step 4: Запустить — убедиться, что проходит**

Run: `cd backend && node --test services/cert-request.test.js`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add backend/services/cert-request.js backend/services/cert-request.test.js
git commit -m "feat(cert-request): чистые хелперы (телефон, ИНН, rate-limit, токены)"
```

---

## Task 3: Матчинг пациента и расчёт суммы за год

**Files:**
- Modify: `backend/services/cert-request.js`
- Modify: `backend/services/cert-request.test.js`

- [ ] **Step 1: Добавить падающие тесты**

В конец `backend/services/cert-request.test.js` добавить:

```js
const { matchPatient, computeYearAmount, resolveSalonBySlug } = require('./cert-request');

function fakeDb(responses) {
  // responses: массив значений, отдаём по очереди на каждый oneOrNone/one
  let i = 0;
  return {
    oneOrNone: async () => responses[i++],
    one: async () => responses[i++],
  };
}

test('matchPatient: находит клиента по нормализованному телефону', async () => {
  const db = fakeDb([{ id: 42 }]);
  const r = await matchPatient({ db, salonId: 1, phone: '+7 (912) 345-67-89' });
  assert.deepStrictEqual(r, { clientId: 42 });
});

test('matchPatient: нет совпадения → clientId null', async () => {
  const db = fakeDb([null]);
  const r = await matchPatient({ db, salonId: 1, phone: '79990000000' });
  assert.deepStrictEqual(r, { clientId: null });
});

test('matchPatient: пустой телефон → null без запроса', async () => {
  const r = await matchPatient({ db: fakeDb([]), salonId: 1, phone: '' });
  assert.deepStrictEqual(r, { clientId: null });
});

test('computeYearAmount: сумма из revenue_operations', async () => {
  const db = fakeDb([{ total: '12345.67' }]);
  const sum = await computeYearAmount({ db, salonId: 1, clientId: 42, year: 2025 });
  assert.strictEqual(sum, 12345.67);
});

test('computeYearAmount: clientId null → 0 без запроса', async () => {
  const sum = await computeYearAmount({ db: fakeDb([]), salonId: 1, clientId: null, year: 2025 });
  assert.strictEqual(sum, 0);
});

test('resolveSalonBySlug: находит салон', async () => {
  const db = fakeDb([{ id: 1, cert_request_slug: 'clinic-1' }]);
  const s = await resolveSalonBySlug({ db, slug: 'clinic-1' });
  assert.strictEqual(s.id, 1);
});
```

- [ ] **Step 2: Запустить — убедиться, что падает**

Run: `cd backend && node --test services/cert-request.test.js`
Expected: FAIL — `matchPatient`/`computeYearAmount`/`resolveSalonBySlug` не определены.

- [ ] **Step 3: Реализовать**

В `backend/services/cert-request.js` ДО `module.exports` добавить:

```js
// Поиск клиента салона по телефону (нормализуем обе стороны сравнения).
async function matchPatient({ db, salonId, phone }) {
  const norm = normalizePhone(phone);
  if (!norm) return { clientId: null };
  const row = await db.oneOrNone(
    `SELECT id FROM clients
       WHERE salon_id = $1
         AND regexp_replace(COALESCE(phone,''), '\\D', '', 'g') = $2
       LIMIT 1`,
    [salonId, norm]);
  return { clientId: row ? row.id : null };
}

// Сумма оплат клиента за отчётный год (Москва). 0, если клиент не сопоставлен.
async function computeYearAmount({ db, salonId, clientId, year }) {
  if (!clientId) return 0;
  const row = await db.one(
    `SELECT COALESCE(SUM(amount),0) AS total
       FROM revenue_operations
      WHERE salon_id=$1 AND client_id=$2
        AND EXTRACT(YEAR FROM operation_date)=$3`,
    [salonId, clientId, year]);
  return Number(row.total) || 0;
}

// Салон по публичному slug формы.
async function resolveSalonBySlug({ db, slug }) {
  if (!slug) return null;
  return db.oneOrNone(
    'SELECT id, cert_request_slug FROM salons WHERE cert_request_slug=$1',
    [slug]);
}
```

И расширить экспорт:

```js
module.exports = {
  normalizePhone, validateInn, makeRateLimiter, makeTokenStore,
  matchPatient, computeYearAmount, resolveSalonBySlug,
};
```

- [ ] **Step 4: Запустить — убедиться, что проходит**

Run: `cd backend && node --test services/cert-request.test.js`
Expected: PASS (12 tests).

- [ ] **Step 5: Commit**

```bash
git add backend/services/cert-request.js backend/services/cert-request.test.js
git commit -m "feat(cert-request): матчинг пациента по телефону + сумма за год + slug"
```

---

## Task 4: PDF «Заявление»

**Files:**
- Modify: `backend/services/cert-request.js`
- Modify: `backend/services/cert-request.test.js`

- [ ] **Step 1: Добавить падающий тест**

В конец `backend/services/cert-request.test.js` добавить:

```js
const { buildApplicationPdf, RELATIONSHIP_LABELS } = require('./cert-request');

test('RELATIONSHIP_LABELS покрывает все коды', () => {
  assert.deepStrictEqual(Object.keys(RELATIONSHIP_LABELS).sort(),
    ['child', 'parent', 'spouse', 'ward']);
});

test('buildApplicationPdf: возвращает непустой PDF (за себя)', async () => {
  const buf = await buildApplicationPdf({
    payer_last: 'АГАФОНОВ', payer_first: 'АРТЕМ', payer_middle: 'ЭДУАРДОВИЧ',
    payer_inn: '500100732259', payer_doc_serie_number: '1234567890',
    payer_doc_issue_date: '2015-03-25', payer_phone: '79123456789',
    report_year: 2025, payer_is_patient: true,
    clinic_name: 'ООО Клиника',
  });
  assert.ok(Buffer.isBuffer(buf) && buf.length > 800);
  assert.strictEqual(buf.slice(0, 5).toString(), '%PDF-');
});

test('buildApplicationPdf: за пациента — тоже валидный PDF', async () => {
  const buf = await buildApplicationPdf({
    payer_last: 'ИВАНОВ', payer_first: 'ИВАН', payer_middle: 'ИВАНОВИЧ',
    payer_inn: '500100732259', payer_phone: '79123456789',
    report_year: 2024, payer_is_patient: false,
    patient_last: 'ИВАНОВА', patient_first: 'МАРИЯ', patient_middle: 'ИВАНОВНА',
    relationship: 'child', clinic_name: 'ООО Клиника',
  });
  assert.strictEqual(buf.slice(0, 5).toString(), '%PDF-');
});
```

- [ ] **Step 2: Запустить — убедиться, что падает**

Run: `cd backend && node --test services/cert-request.test.js`
Expected: FAIL — `buildApplicationPdf`/`RELATIONSHIP_LABELS` не определены.

- [ ] **Step 3: Реализовать**

В начало `backend/services/cert-request.js` (после `const crypto = ...`) добавить импорты:

```js
const fs = require('fs');
const path = require('path');
const { PDFDocument, rgb } = require('pdf-lib');
const fontkit = require('@pdf-lib/fontkit');

const FONT_PATH = path.join(__dirname, '../assets/fonts/PTSans-Regular.ttf');
const RELATIONSHIP_LABELS = {
  spouse: 'супругом(ой)', parent: 'родителем', child: 'ребёнком', ward: 'подопечным',
};
```

Перед `module.exports` добавить:

```js
// «Заявление» — A4-PDF с переносом по ширине.
async function buildApplicationPdf(r) {
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const font = await doc.embedFont(fs.readFileSync(FONT_PATH), { subset: false });
  const page = doc.addPage([595, 842]); // A4 в pt
  const black = rgb(0, 0, 0);
  const left = 60, right = 535, size = 12, lh = 18;
  let y = 770;

  const fio = (l, f, m) => [l, f, m].filter(Boolean).join(' ');
  const payerFio = fio(r.payer_last, r.payer_first, r.payer_middle);
  const patientFio = fio(r.patient_last, r.patient_first, r.patient_middle);
  const rel = RELATIONSHIP_LABELS[r.relationship] || 'родственником';

  const purpose = r.payer_is_patient
    ? `за оказанные мне медицинские услуги.`
    : `за медицинские услуги, оказанные ${patientFio}, являющемуся(ейся) мне ${rel}.`;

  const body =
    `Я, ${payerFio}` +
    (r.payer_doc_serie_number ? `, паспорт ${r.payer_doc_serie_number}` : '') +
    (r.payer_doc_issue_date ? `, выдан ${r.payer_doc_issue_date}` : '') +
    (r.payer_inn ? `, ИНН ${r.payer_inn}` : '') +
    `, прошу подготовить справку об оплате медицинских услуг для представления ` +
    `в налоговый орган за ${r.report_year} год ${purpose} ` +
    `Контактный телефон: ${r.payer_phone || '—'}.`;

  // Заголовок
  const title = 'Заявление';
  page.drawText(title, { x: (595 - font.widthOfTextAtSize(title, 16)) / 2, y, size: 16, font, color: black });
  y -= lh * 2;
  if (r.clinic_name) {
    page.drawText(`Кому: ${r.clinic_name}`, { x: left, y, size, font, color: black });
    y -= lh * 2;
  }

  // Тело с переносом по словам
  const words = body.split(/\s+/);
  let line = '';
  const flush = () => { if (line) { page.drawText(line, { x: left, y, size, font, color: black }); y -= lh; line = ''; } };
  for (const w of words) {
    const trial = line ? line + ' ' + w : w;
    if (font.widthOfTextAtSize(trial, size) > (right - left) && line) { flush(); line = w; }
    else line = trial;
  }
  flush();

  y -= lh * 2;
  page.drawText('Дата: «___» ____________ 20__ г.', { x: left, y, size, font, color: black });
  page.drawText('Подпись: _______________', { x: right - 200, y, size, font, color: black });

  return Buffer.from(await doc.save());
}
```

Обновить экспорт (добавить два имени):

```js
module.exports = {
  normalizePhone, validateInn, makeRateLimiter, makeTokenStore,
  matchPatient, computeYearAmount, resolveSalonBySlug,
  buildApplicationPdf, RELATIONSHIP_LABELS,
};
```

- [ ] **Step 4: Запустить — убедиться, что проходит**

Run: `cd backend && node --test services/cert-request.test.js`
Expected: PASS (15 tests).

- [ ] **Step 5: Commit**

```bash
git add backend/services/cert-request.js backend/services/cert-request.test.js
git commit -m "feat(cert-request): серверный PDF «Заявление» (за себя / за пациента)"
```

---

## Task 5: Конфиг разрешённых доменов для iframe

**Files:**
- Modify: `backend/config.js:51` (рядом с `MEDICAL_CERT_CLINIC`)

- [ ] **Step 1: Добавить настройку frame-ancestors**

В `backend/config.js` внутри `module.exports = {` перед `MEDICAL_CERT_CLINIC` добавить:

```js
  // Домены, которым разрешено встраивать публичную форму заявки в iframe (Wix и т.п.).
  // Через запятую в env CERT_REQUEST_FRAME_ANCESTORS, иначе дефолт ниже.
  CERT_REQUEST_FRAME_ANCESTORS: (process.env.CERT_REQUEST_FRAME_ANCESTORS
    ? process.env.CERT_REQUEST_FRAME_ANCESTORS.split(',').map(s => s.trim()).filter(Boolean)
    : ['https://*.wixsite.com', 'https://*.editorx.io', 'https://*.wix.com', 'https://zumrudin.ru', 'https://www.zumrudin.ru']),
```

- [ ] **Step 2: Проверить загрузку конфига**

Run: `cd backend && node -e "console.log(require('./config').CERT_REQUEST_FRAME_ANCESTORS)"`
Expected: печатает массив доменов (по умолчанию с `https://*.wixsite.com`).

- [ ] **Step 3: Commit**

```bash
git add backend/config.js
git commit -m "feat(cert-request): config CERT_REQUEST_FRAME_ANCESTORS для iframe"
```

---

## Task 6: Публичный роутер — страница формы + config + монтирование

**Files:**
- Create: `backend/routes/public-cert-request.js`
- Modify: `backend/routes/index.js:8-10` (монтирование ДО `/api`-guard)

- [ ] **Step 1: Создать роутер с config и страницей**

Создать `backend/routes/public-cert-request.js`:

```js
// backend/routes/public-cert-request.js
// Публичный роутер (БЕЗ JWT) — форма заявки на справку для встройки в Wix.
'use strict';

const path = require('path');
const router = require('express').Router();
const cfg = require('../config');
const { db } = require('../db');
const { createLogger } = require('../logger');
const svc = require('../services/cert-request');

const logger = createLogger('CertRequestPublic');

// Доступные отчётные годы: текущий и 2 предыдущих (TZ Москвы — сервер уже в ней).
function availableYears() {
  const y = new Date().getFullYear();
  return [y, y - 1, y - 2];
}

// Страница-форма: разрешаем встраивание в iframe для доменов из конфига.
router.get('/cert-request/:slug', async (req, res) => {
  const salon = await svc.resolveSalonBySlug({ db, slug: req.params.slug });
  if (!salon) return res.status(404).send('Форма не найдена');
  res.removeHeader('X-Frame-Options');
  const ancestors = ["'self'", ...cfg.CERT_REQUEST_FRAME_ANCESTORS].join(' ');
  res.setHeader('Content-Security-Policy',
    `default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; ` +
    `img-src 'self' data:; connect-src 'self'; font-src 'self' data:; frame-ancestors ${ancestors}`);
  res.setHeader('Cache-Control', 'no-store');
  res.sendFile(path.join(__dirname, '../../frontend/cert-request.html'));
});

// Конфиг формы (публичный): название клиники, годы, степени родства, ссылка на политику.
router.get('/api/public/cert-requests/:slug/config', async (req, res) => {
  try {
    const salon = await svc.resolveSalonBySlug({ db, slug: req.params.slug });
    if (!salon) return res.status(404).json({ error: 'not_found' });
    res.json({
      clinicName: cfg.MEDICAL_CERT_CLINIC.org_name,
      years: availableYears(),
      relationships: Object.entries(svc.RELATIONSHIP_LABELS).map(([code, label]) => ({ code, label })),
      policyUrl: '/privacy-policy.html',
    });
  } catch (e) { logger.error(e.message); res.status(500).json({ error: 'config_failed' }); }
});

module.exports = router;
```

- [ ] **Step 2: Смонтировать роутер ДО JWT-guard**

В `backend/routes/index.js` сразу после строки `app.use('/yclients', require('./webhook'));` (строка 10) добавить:

```js
  // ── Публичная форма заявки на справку (БЕЗ JWT — монтируем до guard) ──
  app.use(require('./public-cert-request'));
```

- [ ] **Step 3: Перезапустить и проверить страницу + config + заголовки**

Run:
```bash
pm2 restart loyalpro && sleep 1
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3001/cert-request/clinic-1
curl -s -D - -o /dev/null http://localhost:3001/cert-request/clinic-1 | grep -iE "x-frame-options|frame-ancestors"
curl -s http://localhost:3001/api/public/cert-requests/clinic-1/config
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3001/cert-request/nope
```
Expected: `200`; строка с `frame-ancestors ... wixsite.com` и БЕЗ `x-frame-options` (он удалён); JSON с `clinicName`/`years`/`relationships`; последний — `404`. (Страница вернёт 200 даже без файла на этом шаге, файл создадим в Task 8 — проверяем код 200 и заголовки; тело может быть «not found» от sendFile — это ок, заголовки выставляются до отправки.)

> Примечание: если `sendFile` ругается на отсутствующий файл до Task 8, временно проверьте только `/config` и `404`-ветку; страницу перепроверите после Task 8.

- [ ] **Step 4: Commit**

```bash
git add backend/routes/public-cert-request.js backend/routes/index.js
git commit -m "feat(cert-request): публичный роутер (страница формы + config, iframe-заголовки)"
```

---

## Task 7: Публичный приём заявки + скачивание «Заявления»

**Files:**
- Modify: `backend/routes/public-cert-request.js`

- [ ] **Step 1: Добавить rate-limiter, token-store, POST и GET application**

В `backend/routes/public-cert-request.js` после `const logger = ...` добавить инстансы:

```js
// Анти-спам: не более 5 заявок/час на IP. Токены заявления живут 30 минут.
const rateLimit = svc.makeRateLimiter({ max: 5, windowMs: 60 * 60 * 1000 });
const appTokens = svc.makeTokenStore({ ttlMs: 30 * 60 * 1000 });

function clientIp(req) {
  return (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || 'unknown';
}

// Дата 'YYYY-MM-DD' или '' → null; иначе строка (для DATE-колонок).
function dateOrNull(s) { return /^\d{4}-\d{2}-\d{2}$/.test(s || '') ? s : null; }
```

После роутера `/config` (перед `module.exports`) добавить:

```js
// Приём заявки.
router.post('/api/public/cert-requests/:slug', async (req, res) => {
  try {
    const salon = await svc.resolveSalonBySlug({ db, slug: req.params.slug });
    if (!salon) return res.status(404).json({ error: 'not_found' });

    const b = req.body || {};
    // Honeypot: скрытое поле должно быть пустым у людей.
    if (b.website) return res.json({ ok: true }); // тихо игнорируем бота

    const ip = clientIp(req);
    if (!rateLimit(ip)) return res.status(429).json({ error: 'too_many_requests' });

    // Валидация.
    const errors = [];
    const samePerson = b.payer_is_patient === true || b.payer_is_patient === '1';
    const year = Number(b.report_year);
    if (!availableYears().includes(year)) errors.push('report_year');
    if (!b.consent) errors.push('consent');
    if (!b.payer_last || !b.payer_first) errors.push('payer_name');
    if (b.payer_inn && !svc.validateInn(b.payer_inn)) errors.push('payer_inn');
    const payerPhone = svc.normalizePhone(b.payer_phone);
    if (payerPhone.length < 10) errors.push('payer_phone');

    let patientPhone = '';
    if (!samePerson) {
      if (!b.patient_last || !b.patient_first) errors.push('patient_name');
      if (b.patient_inn && !svc.validateInn(b.patient_inn)) errors.push('patient_inn');
      patientPhone = svc.normalizePhone(b.patient_phone);
      if (patientPhone.length < 10) errors.push('patient_phone');
      if (!svc.RELATIONSHIP_LABELS[b.relationship]) errors.push('relationship');
    }
    if (errors.length) return res.status(400).json({ error: 'validation', fields: errors });

    // Матчинг: всегда по телефону ПАЦИЕНТА (== плательщика, если одно лицо).
    const matchPhone = samePerson ? payerPhone : patientPhone;
    const { clientId } = await svc.matchPatient({ db, salonId: salon.id, phone: matchPhone });
    const amount = await svc.computeYearAmount({ db, salonId: salon.id, clientId, year });

    const row = await db.one(
      `INSERT INTO cert_requests (
         salon_id, status, report_year, payer_is_patient,
         payer_last, payer_first, payer_middle, payer_birthdate, payer_inn,
         payer_doc_type_code, payer_doc_serie_number, payer_doc_issue_date, payer_phone, payer_email,
         patient_last, patient_first, patient_middle, patient_birthdate, patient_inn,
         patient_doc_type_code, patient_doc_serie_number, patient_doc_issue_date, patient_phone,
         relationship, matched_client_id, computed_amount, consent_at, ip, user_agent
       ) VALUES (
         $1,'new',$2,$3,
         $4,$5,$6,$7,$8,
         $9,$10,$11,$12,$13,
         $14,$15,$16,$17,$18,
         $19,$20,$21,$22,
         $23,$24,$25, now(), $26, $27
       ) RETURNING id`,
      [
        salon.id, year, samePerson,
        b.payer_last, b.payer_first, b.payer_middle || null, dateOrNull(b.payer_birthdate), b.payer_inn || null,
        b.payer_doc_type_code || null, b.payer_doc_serie_number || null, dateOrNull(b.payer_doc_issue_date), payerPhone, b.payer_email || null,
        samePerson ? null : b.patient_last, samePerson ? null : b.patient_first, samePerson ? null : (b.patient_middle || null),
        samePerson ? null : dateOrNull(b.patient_birthdate), samePerson ? null : (b.patient_inn || null),
        samePerson ? null : (b.patient_doc_type_code || null), samePerson ? null : (b.patient_doc_serie_number || null),
        samePerson ? null : dateOrNull(b.patient_doc_date), samePerson ? null : patientPhone,
        samePerson ? null : b.relationship, clientId, amount, ip, String(req.headers['user-agent'] || '').slice(0, 400),
      ]);

    const token = appTokens.put({ requestId: row.id, salonId: salon.id });
    res.json({ ok: true, applicationToken: token });
  } catch (e) { logger.error(e.message); res.status(500).json({ error: 'submit_failed' }); }
});

// Скачивание «Заявления» по короткоживущему токену.
router.get('/api/public/cert-requests/:slug/application/:token', async (req, res) => {
  try {
    const salon = await svc.resolveSalonBySlug({ db, slug: req.params.slug });
    if (!salon) return res.status(404).json({ error: 'not_found' });
    const ref = appTokens.get(req.params.token);
    if (!ref || ref.salonId !== salon.id) return res.status(404).json({ error: 'expired' });

    const r = await db.oneOrNone('SELECT * FROM cert_requests WHERE id=$1 AND salon_id=$2', [ref.requestId, salon.id]);
    if (!r) return res.status(404).json({ error: 'not_found' });

    const pdf = await svc.buildApplicationPdf({
      ...r,
      payer_birthdate: r.payer_birthdate ? r.payer_birthdate.toISOString().slice(0, 10) : '',
      payer_doc_issue_date: r.payer_doc_issue_date ? r.payer_doc_issue_date.toISOString().slice(0, 10) : '',
      clinic_name: cfg.MEDICAL_CERT_CLINIC.org_name,
    });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'attachment; filename="zayavlenie.pdf"');
    res.setHeader('Cache-Control', 'no-store');
    res.send(pdf);
  } catch (e) { logger.error(e.message); res.status(500).json({ error: 'application_failed' }); }
});
```

- [ ] **Step 2: Перезапустить и проверить приём + скачивание + анти-спам**

Run:
```bash
pm2 restart loyalpro && sleep 1
# валидная заявка «за себя»
RESP=$(curl -s -X POST http://localhost:3001/api/public/cert-requests/clinic-1 \
  -H 'Content-Type: application/json' \
  -d '{"report_year":2025,"payer_is_patient":true,"payer_last":"Тест","payer_first":"Тест","payer_phone":"+7 912 000 00 00","consent":true}')
echo "$RESP"
TOKEN=$(echo "$RESP" | node -e "process.stdin.on('data',d=>console.log(JSON.parse(d).applicationToken||''))")
curl -s -o /tmp/zay.pdf -w "pdf:%{http_code} size:%{size_download}\n" "http://localhost:3001/api/public/cert-requests/clinic-1/application/$TOKEN"
head -c5 /tmp/zay.pdf; echo
# невалидная (нет согласия) → 400
curl -s -X POST http://localhost:3001/api/public/cert-requests/clinic-1 -H 'Content-Type: application/json' -d '{"report_year":2025,"payer_is_patient":true,"payer_last":"A","payer_first":"B","payer_phone":"+79120000000"}' -w "\n%{http_code}\n"
# honeypot → ok:true без записи
curl -s -X POST http://localhost:3001/api/public/cert-requests/clinic-1 -H 'Content-Type: application/json' -d '{"website":"bot","report_year":2025,"payer_is_patient":true,"payer_last":"X","payer_first":"Y","payer_phone":"+79120000000","consent":true}'
echo
```
Expected: первый `{"ok":true,"applicationToken":"..."}`; `pdf:200` и `%PDF-`; невалидная → JSON `validation` + код `400`; honeypot → `{"ok":true}` (без токена).

- [ ] **Step 3: Проверить запись в БД (через MCP postgres, не psql)**

Использовать `mcp__postgres__query`:
```sql
SELECT id, status, report_year, payer_is_patient, payer_last, payer_phone, matched_client_id, computed_amount, consent_at
FROM cert_requests ORDER BY id DESC LIMIT 3;
```
Expected: видна валидная заявка (и НЕТ honeypot-записи).

- [ ] **Step 4: Commit**

```bash
git add backend/routes/public-cert-request.js
git commit -m "feat(cert-request): приём заявки (валидация, honeypot, rate-limit, матчинг) + PDF заявления"
```

---

## Task 8: Фронт — публичная страница-форма

**Files:**
- Create: `frontend/cert-request.html`
- Create: `frontend/js/cert-request.js`

- [ ] **Step 1: Создать HTML-страницу**

Создать `frontend/cert-request.html`:

```html
<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Заявка на справку об оплате медицинских услуг</title>
  <style>
    :root { --b:#2563eb; --bd:#d1d5db; --err:#dc2626; }
    * { box-sizing: border-box; }
    body { font-family: system-ui, Arial, sans-serif; margin:0; padding:16px; color:#111; background:#fff; }
    .wrap { max-width: 640px; margin: 0 auto; }
    h1 { font-size: 20px; margin: 0 0 4px; }
    .sub { color:#6b7280; font-size:13px; margin-bottom:16px; }
    .fg { margin-bottom: 12px; }
    label.fl { display:block; font-size:13px; margin-bottom:4px; }
    input, select { width:100%; padding:8px 10px; border:1px solid var(--bd); border-radius:8px; font-size:14px; }
    .row { display:flex; gap:12px; flex-wrap:wrap; }
    .row > .fg { flex:1; min-width:140px; }
    .chk { display:flex; align-items:flex-start; gap:8px; font-size:13px; }
    .chk input { width:auto; margin-top:2px; }
    fieldset { border:1px solid var(--bd); border-radius:10px; padding:12px; margin:0 0 16px; }
    legend { font-size:13px; font-weight:600; padding:0 6px; }
    button { background:var(--b); color:#fff; border:0; border-radius:10px; padding:12px 18px; font-size:15px; cursor:pointer; width:100%; }
    button:disabled { opacity:.6; cursor:default; }
    .hp { position:absolute; left:-9999px; }
    .err { color:var(--err); font-size:12px; margin-top:4px; }
    .ok { text-align:center; padding:24px 8px; }
    .hidden { display:none; }
    .note { font-size:12px; color:#6b7280; }
  </style>
</head>
<body>
  <div class="wrap">
    <div id="cr-form-view">
      <h1>Заявка на справку об оплате медицинских услуг</h1>
      <div class="sub" id="cr-clinic"></div>

      <form id="cr-form" autocomplete="on" novalidate>
        <div class="fg">
          <label class="fl">Отчётный год *</label>
          <select id="cr-report_year"></select>
        </div>

        <fieldset>
          <legend>Получатель справки (налогоплательщик)</legend>
          <div class="row">
            <div class="fg"><label class="fl">Фамилия *</label><input id="cr-payer_last"></div>
            <div class="fg"><label class="fl">Имя *</label><input id="cr-payer_first"></div>
            <div class="fg"><label class="fl">Отчество</label><input id="cr-payer_middle"></div>
          </div>
          <div class="row">
            <div class="fg"><label class="fl">Дата рождения</label><input id="cr-payer_birthdate" type="date"></div>
            <div class="fg"><label class="fl">ИНН</label><input id="cr-payer_inn" inputmode="numeric"></div>
          </div>
          <div class="row">
            <div class="fg"><label class="fl">Код вида документа</label><input id="cr-payer_doc_type_code" placeholder="21"></div>
            <div class="fg"><label class="fl">Серия и номер паспорта</label><input id="cr-payer_doc_serie_number" inputmode="numeric"></div>
            <div class="fg"><label class="fl">Дата выдачи</label><input id="cr-payer_doc_issue_date" type="date"></div>
          </div>
          <div class="row">
            <div class="fg"><label class="fl">Телефон *</label><input id="cr-payer_phone" inputmode="tel" placeholder="+7 ..."></div>
            <div class="fg"><label class="fl">Email</label><input id="cr-payer_email" type="email"></div>
          </div>
        </fieldset>

        <div class="fg chk">
          <input type="checkbox" id="cr-payer_is_patient" checked>
          <label for="cr-payer_is_patient">Пациент — это я (услуги оказаны мне)</label>
        </div>

        <fieldset id="cr-patient-block" class="hidden">
          <legend>Пациент (кому оказаны услуги)</legend>
          <div class="note" style="margin-bottom:8px">Укажите телефон пациента — по нему мы найдём оплаты в нашей базе.</div>
          <div class="row">
            <div class="fg"><label class="fl">Фамилия *</label><input id="cr-patient_last"></div>
            <div class="fg"><label class="fl">Имя *</label><input id="cr-patient_first"></div>
            <div class="fg"><label class="fl">Отчество</label><input id="cr-patient_middle"></div>
          </div>
          <div class="row">
            <div class="fg"><label class="fl">Дата рождения</label><input id="cr-patient_birthdate" type="date"></div>
            <div class="fg"><label class="fl">ИНН</label><input id="cr-patient_inn" inputmode="numeric"></div>
          </div>
          <div class="row">
            <div class="fg"><label class="fl">Код вида документа</label><input id="cr-patient_doc_type_code"></div>
            <div class="fg"><label class="fl">Серия и номер</label><input id="cr-patient_doc_serie_number" inputmode="numeric"></div>
            <div class="fg"><label class="fl">Дата выдачи</label><input id="cr-patient_doc_date" type="date"></div>
          </div>
          <div class="row">
            <div class="fg"><label class="fl">Телефон пациента *</label><input id="cr-patient_phone" inputmode="tel"></div>
            <div class="fg"><label class="fl">Степень родства *</label><select id="cr-relationship"></select></div>
          </div>
        </fieldset>

        <div class="fg chk">
          <input type="checkbox" id="cr-consent">
          <label for="cr-consent">Я согласен(на) на обработку персональных данных в соответствии с
            <a id="cr-policy" href="#" target="_blank">политикой</a> (152-ФЗ) *</label>
        </div>

        <!-- honeypot: скрыто от людей -->
        <input class="hp" id="cr-website" tabindex="-1" autocomplete="off" placeholder="Не заполняйте">

        <div id="cr-error" class="err"></div>
        <button id="cr-submit" type="submit">Отправить заявку</button>
      </form>
    </div>

    <div id="cr-ok-view" class="ok hidden">
      <h1>Заявка принята ✅</h1>
      <p>Скачайте заявление и принесите его в клинику.</p>
      <p><a id="cr-download" href="#"><button type="button">Скачать заявление (PDF)</button></a></p>
      <p class="note">Ссылка действует 30 минут.</p>
    </div>
  </div>
  <script src="js/cert-request.js"></script>
</body>
</html>
```

- [ ] **Step 2: Создать логику формы**

Создать `frontend/js/cert-request.js`:

```js
// frontend/js/cert-request.js — публичная форма заявки на справку (в iframe).
(function () {
  // slug из пути /cert-request/<slug>
  const slug = location.pathname.split('/').filter(Boolean).pop();
  const base = `/api/public/cert-requests/${encodeURIComponent(slug)}`;
  const $ = (id) => document.getElementById(id);

  const TEXT_FIELDS = [
    'payer_last', 'payer_first', 'payer_middle', 'payer_birthdate', 'payer_inn',
    'payer_doc_type_code', 'payer_doc_serie_number', 'payer_doc_issue_date', 'payer_phone', 'payer_email',
    'patient_last', 'patient_first', 'patient_middle', 'patient_birthdate', 'patient_inn',
    'patient_doc_type_code', 'patient_doc_serie_number', 'patient_doc_date', 'patient_phone',
  ];

  function togglePatient() {
    const same = $('cr-payer_is_patient').checked;
    $('cr-patient-block').classList.toggle('hidden', same);
  }

  async function init() {
    try {
      const cfg = await (await fetch(`${base}/config`)).json();
      $('cr-clinic').textContent = cfg.clinicName || '';
      $('cr-policy').href = cfg.policyUrl || '#';
      $('cr-report_year').innerHTML = cfg.years.map((y) => `<option value="${y}">${y}</option>`).join('');
      $('cr-relationship').innerHTML =
        '<option value="">—</option>' + cfg.relationships.map((r) => `<option value="${r.code}">${r.label}</option>`).join('');
    } catch {
      $('cr-error').textContent = 'Не удалось загрузить форму. Обновите страницу.';
    }
    $('cr-payer_is_patient').addEventListener('change', togglePatient);
    togglePatient();
    $('cr-form').addEventListener('submit', submit);
  }

  async function submit(ev) {
    ev.preventDefault();
    $('cr-error').textContent = '';
    const same = $('cr-payer_is_patient').checked;
    const body = { report_year: Number($('cr-report_year').value), payer_is_patient: same,
      consent: $('cr-consent').checked, relationship: $('cr-relationship').value, website: $('cr-website').value };
    for (const f of TEXT_FIELDS) body[f] = $('cr-' + f).value.trim();

    if (!body.consent) { $('cr-error').textContent = 'Поставьте согласие на обработку данных.'; return; }
    const btn = $('cr-submit'); btn.disabled = true; btn.textContent = 'Отправка…';
    try {
      const resp = await fetch(base, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok) {
        $('cr-error').textContent = data.error === 'validation'
          ? 'Проверьте поля: ' + (data.fields || []).join(', ')
          : (data.error === 'too_many_requests' ? 'Слишком много заявок, попробуйте позже.' : 'Ошибка отправки.');
        return;
      }
      $('cr-form-view').classList.add('hidden');
      $('cr-ok-view').classList.remove('hidden');
      if (data.applicationToken) $('cr-download').href = `${base}/application/${data.applicationToken}`;
    } catch {
      $('cr-error').textContent = 'Сеть недоступна. Повторите попытку.';
    } finally { btn.disabled = false; btn.textContent = 'Отправить заявку'; }
  }

  init();
})();
```

- [ ] **Step 3: Проверить страницу вручную (Playwright MCP)**

Через `mcp__playwright__*`: открыть `http://localhost:3001/cert-request/clinic-1`, убедиться что форма отрисована, год/родство заполнены, тумблер «Пациент — это я» прячет/показывает блок пациента; заполнить минимум (год, ФИО, телефон, согласие), отправить → появляется экран «Заявка принята» с кнопкой скачивания.

Expected: форма работает, после отправки виден экран успеха, кнопка ведёт на `/application/<token>`.

- [ ] **Step 4: Перепроверить заголовки страницы (Task 6 Step 3 повтор)**

Run: `curl -s -D - -o /dev/null http://localhost:3001/cert-request/clinic-1 | grep -iE "content-security-policy|x-frame-options"`
Expected: есть `frame-ancestors ... wixsite.com`, нет `x-frame-options`.

- [ ] **Step 5: Commit**

```bash
git add frontend/cert-request.html frontend/js/cert-request.js
git commit -m "feat(cert-request): публичная форма заявки (для встройки в Wix iframe)"
```

---

## Task 9: Staff-эндпоинты (list/detail/status/match/prefill)

**Files:**
- Modify: `backend/routes/medical-cert.js` (после блока `/template/coords`, перед `module.exports`)

- [ ] **Step 1: Добавить staff-роуты заявок**

В `backend/routes/medical-cert.js` перед `module.exports = router;` добавить:

```js
// ── Заявки на справки (самозаявка с сайта) ──────────────────────
const { computeYearAmount, matchPatient } = require('../services/cert-request');

const ALLOWED_STATUS = ['new', 'in_progress', 'done', 'rejected'];

// Список заявок салона (+ счётчик новых).
router.get('/requests', adminOnly, async (req, res) => {
  try {
    const status = ALLOWED_STATUS.includes(req.query.status) ? req.query.status : null;
    const rows = await db.any(
      `SELECT id, status, report_year, payer_is_patient,
              payer_last, payer_first, payer_middle, payer_phone,
              patient_last, patient_first, patient_phone,
              matched_client_id, computed_amount, created_at
         FROM cert_requests
        WHERE salon_id=$1 ${status ? 'AND status=$2' : ''}
        ORDER BY created_at DESC`,
      status ? [salonOf(req), status] : [salonOf(req)]);
    const newCount = await db.one(
      `SELECT COUNT(*)::int AS n FROM cert_requests WHERE salon_id=$1 AND status='new'`, [salonOf(req)]);
    res.json({ items: rows, newCount: newCount.n });
  } catch (e) { logger.error(e.message); res.status(500).json({ error: 'requests_list_failed' }); }
});

// Полная заявка.
router.get('/requests/:id', adminOnly, async (req, res) => {
  try {
    const r = await db.oneOrNone('SELECT * FROM cert_requests WHERE id=$1 AND salon_id=$2', [Number(req.params.id), salonOf(req)]);
    if (!r) return res.status(404).json({ error: 'not_found' });
    res.json(r);
  } catch (e) { logger.error(e.message); res.status(500).json({ error: 'request_get_failed' }); }
});

// Смена статуса.
router.put('/requests/:id/status', adminOnly, async (req, res) => {
  try {
    const status = req.body && req.body.status;
    if (!ALLOWED_STATUS.includes(status)) return res.status(400).json({ error: 'bad_status' });
    const r = await db.oneOrNone(
      `UPDATE cert_requests SET status=$1, updated_at=now() WHERE id=$2 AND salon_id=$3 RETURNING id`,
      [status, Number(req.params.id), salonOf(req)]);
    if (!r) return res.status(404).json({ error: 'not_found' });
    res.json({ ok: true });
  } catch (e) { logger.error(e.message); res.status(500).json({ error: 'status_failed' }); }
});

// Ручная привязка клиента + пересчёт суммы.
router.put('/requests/:id/match', adminOnly, async (req, res) => {
  try {
    const clientId = req.body && req.body.clientId ? Number(req.body.clientId) : null;
    const r = await db.oneOrNone('SELECT id, report_year FROM cert_requests WHERE id=$1 AND salon_id=$2', [Number(req.params.id), salonOf(req)]);
    if (!r) return res.status(404).json({ error: 'not_found' });
    const amount = await computeYearAmount({ db, salonId: salonOf(req), clientId, year: r.report_year });
    await db.query(`UPDATE cert_requests SET matched_client_id=$1, computed_amount=$2, updated_at=now() WHERE id=$3`,
      [clientId, amount, r.id]);
    res.json({ ok: true, computed_amount: amount });
  } catch (e) { logger.error(e.message); res.status(500).json({ error: 'match_failed' }); }
});

// Предзаполнение генератора справки из заявки (значения в ключах формы генератора).
router.get('/requests/:id/prefill', adminOnly, async (req, res) => {
  try {
    const r = await db.oneOrNone('SELECT * FROM cert_requests WHERE id=$1 AND salon_id=$2', [Number(req.params.id), salonOf(req)]);
    if (!r) return res.status(404).json({ error: 'not_found' });
    const d = (x) => (x ? x.toISOString().slice(0, 10) : '');
    res.json({
      clientId: r.matched_client_id || null,
      report_year: String(r.report_year),
      payer_is_patient: r.payer_is_patient ? '1' : '0',
      payer_last: r.payer_last || '', payer_first: r.payer_first || '', payer_middle: r.payer_middle || '',
      payer_inn: r.payer_inn || '', payer_birthdate: d(r.payer_birthdate),
      doc_type_code: r.payer_doc_type_code || '', doc_serie_number: r.payer_doc_serie_number || '', doc_issue_date: d(r.payer_doc_issue_date),
      patient_last: r.patient_last || '', patient_first: r.patient_first || '', patient_middle: r.patient_middle || '',
      patient_inn: r.patient_inn || '', patient_birthdate: d(r.patient_birthdate),
      patient_doc_type: r.patient_doc_type_code || '', patient_doc_serie: r.patient_doc_serie_number || '', patient_doc_date: d(r.patient_doc_issue_date),
      amount1: r.computed_amount != null ? String(r.computed_amount) : '',
    });
  } catch (e) { logger.error(e.message); res.status(500).json({ error: 'prefill_failed' }); }
});
```

- [ ] **Step 2: Перезапустить и проверить staff-эндпоинты (нужен JWT админа)**

Run (подставить реальный токен админа в `TK`):
```bash
pm2 restart loyalpro && sleep 1
TK="<JWT_админа>"
curl -s -H "Authorization: Bearer $TK" "http://localhost:3001/api/medical-cert/requests" | head -c 400; echo
# взять id последней заявки и проверить prefill
ID=$(curl -s -H "Authorization: Bearer $TK" "http://localhost:3001/api/medical-cert/requests" | node -e "process.stdin.on('data',d=>{const j=JSON.parse(d);console.log(j.items[0]&&j.items[0].id||'')})")
curl -s -H "Authorization: Bearer $TK" "http://localhost:3001/api/medical-cert/requests/$ID/prefill"; echo
```
Expected: список с `items`/`newCount`; `prefill` с ключами `report_year`, `payer_last`, `amount1` и т.д. Без токена — `401`.

- [ ] **Step 3: Commit**

```bash
git add backend/routes/medical-cert.js
git commit -m "feat(cert-request): staff-эндпоинты заявок (list/detail/status/match/prefill)"
```

---

## Task 10: Staff-раздел «Заявки на справки» + предзаполнение генератора

**Files:**
- Create: `frontend/js/pages/cert-requests.js`
- Modify: `frontend/js/pages/medical-cert.js` (добавить `mcPrefillFromRequest`)
- Modify: `frontend/index.html` (нав-пункт, страница раздела, подключение скрипта)
- Modify: `frontend/js/core/nav.js` (роутинг)

- [ ] **Step 1: Добавить функцию предзаполнения в генератор**

В `frontend/js/pages/medical-cert.js` в конец файла добавить:

```js
// Предзаполнить форму генератора значениями из заявки (объект /prefill).
function mcPrefillFromRequest(p) {
  const same = p.payer_is_patient === '1';
  const setV = (k, v) => { const el = document.getElementById('mc-f-' + k); if (el && v !== undefined && v !== null) el.value = v; };
  for (const [k] of MC_FIELDS) if (p[k] !== undefined) setV(k, p[k]);
  for (const [k] of MC_PATIENT_FIELDS) if (p[k] !== undefined) setV(k, p[k]);
  const cb = document.getElementById('mc-f-payer_is_patient');
  if (cb) { cb.checked = same; mcTogglePatient(); }
  if (p.clientId) { const ci = document.getElementById('mc-client-id'); if (ci) ci.value = p.clientId; }
  if (typeof notify === 'function') notify('Данные заявки загружены в генератор');
}
```

- [ ] **Step 2: Создать страницу раздела заявок**

Создать `frontend/js/pages/cert-requests.js`:

```js
// frontend/js/pages/cert-requests.js — раздел «Заявки на справки» (owner/admin)
// Зависимости: api(), notify(), esc(), nav(); mcPrefillFromRequest() (medical-cert.js)

const CR_STATUS_LABEL = { new: 'Новая', in_progress: 'В работе', done: 'Готово', rejected: 'Отклонена' };

async function loadCertRequests() {
  const host = document.getElementById('page-cert-requests');
  host.innerHTML = '<h2 style="margin-bottom:12px">Заявки на справки</h2><div id="cr-list">Загрузка…</div>';
  try {
    const data = await api('GET', '/api/medical-cert/requests');
    crRenderList(data.items || []);
  } catch (e) { document.getElementById('cr-list').textContent = 'Ошибка загрузки'; }
}

function crFio(l, f, m) { return [l, f, m].filter(Boolean).join(' '); }

function crRenderList(items) {
  const el = document.getElementById('cr-list');
  if (!items.length) { el.innerHTML = '<div style="color:#9ca3af">Заявок нет</div>'; return; }
  el.innerHTML = `<table style="width:100%;border-collapse:collapse">
    <thead><tr style="text-align:left;color:#6b7280;font-size:13px">
      <th>Дата</th><th>Год</th><th>Получатель</th><th>Пациент</th><th>Сопоставлен</th><th>Статус</th><th></th></tr></thead>
    <tbody>${items.map(crRow).join('')}</tbody></table>`;
}

function crRow(r) {
  const date = new Date(r.created_at).toLocaleDateString('ru-RU');
  const payer = esc(crFio(r.payer_last, r.payer_first, r.payer_middle) + ' · ' + (r.payer_phone || ''));
  const patient = r.payer_is_patient ? '— (он же)' : esc(crFio(r.patient_last, r.patient_first, '') + ' · ' + (r.patient_phone || ''));
  const matched = r.matched_client_id ? '✅' : '—';
  return `<tr style="border-top:1px solid #eee;font-size:14px">
    <td>${date}</td><td>${r.report_year}</td><td>${payer}</td><td>${patient}</td>
    <td>${matched}${r.computed_amount != null ? ' · ' + esc(String(r.computed_amount)) + '₽' : ''}</td>
    <td>${esc(CR_STATUS_LABEL[r.status] || r.status)}</td>
    <td><button class="btn-pri" onclick="crOpenInGenerator(${r.id})">Создать справку</button></td>
  </tr>`;
}

async function crOpenInGenerator(id) {
  try {
    const p = await api('GET', `/api/medical-cert/requests/${id}/prefill`);
    nav(document.querySelector('.tn[data-p="medical-cert"]')); // переключиться на генератор
    setTimeout(() => { if (typeof mcPrefillFromRequest === 'function') mcPrefillFromRequest(p); }, 50);
    await api('PUT', `/api/medical-cert/requests/${id}/status`, { status: 'in_progress' });
  } catch (e) { notify('Не удалось открыть заявку', 'err'); }
}
```

- [ ] **Step 3: Добавить нав-пункт, страницу и скрипт в index.html**

В `frontend/index.html`:

а) Рядом с КАЖДЫМ из двух нав-пунктов «Справки» (строки ~98 и ~138, `data-p="medical-cert"`) добавить сразу после него:
```html
      <div class="tn" data-p="cert-requests" data-roles="owner,admin" onclick="nav(this)">Заявки на справки</div>
```

б) После блока `<div class="page" id="page-medical-cert"> ... </div>` (начинается на строке ~1107) добавить новый контейнер страницы:
```html
    <div class="page" id="page-cert-requests"></div>
```

в) Рядом со строкой подключения `js/pages/medical-cert.js` (строка ~1840) добавить:
```html
<script src="js/pages/cert-requests.js?v=2026-06-18"></script>
```

- [ ] **Step 4: Добавить роутинг в nav.js**

В `frontend/js/core/nav.js` рядом со строкой `if (p === 'medical-cert') loadMedicalCert();` (строка 28) добавить:
```js
  if (p === 'cert-requests')  loadCertRequests();
```

- [ ] **Step 5: Проверить раздел и предзаполнение (Playwright MCP)**

Через `mcp__playwright__*`: залогиниться админом, открыть раздел «Заявки на справки» → виден список с тестовой заявкой; нажать «Создать справку» → переключение на «Справки», поля генератора (год, ФИО плательщика, сумма) заполнены; статус заявки стал «В работе».

Expected: список рендерится, кнопка предзаполняет генератор, статус меняется.

- [ ] **Step 6: Commit**

```bash
git add frontend/js/pages/cert-requests.js frontend/js/pages/medical-cert.js frontend/index.html frontend/js/core/nav.js
git commit -m "feat(cert-request): staff-раздел «Заявки на справки» + предзаполнение генератора"
```

---

## Task 11: Документация по встройке в Wix

**Files:**
- Create: `docs/cert-request-wix-embed.md`

- [ ] **Step 1: Написать инструкцию**

Создать `docs/cert-request-wix-embed.md`:

```markdown
# Встройка формы заявки на справку в сайт Wix

Форма хостится в LoyalPro и встраивается в страницу Wix через iframe.

## Шаги
1. URL формы: `https://<домен-LoyalPro>/cert-request/<slug-клиники>`.
   Slug клиники = значение `salons.cert_request_slug` (по умолчанию `clinic-<id>`).
2. В редакторе Wix: **Добавить → Встраивание (Embed) → Встроить HTML (iframe)**.
3. Вставить:
   ```html
   <iframe src="https://<домен-LoyalPro>/cert-request/clinic-1"
           style="width:100%;height:1200px;border:0" loading="lazy"></iframe>
   ```
4. Подогнать `height` под форму (фикс. высота — ограничение iframe).
5. Убедиться, что домен Wix входит в `CERT_REQUEST_FRAME_ANCESTORS`
   (env-переменная на бэке, через запятую). Иначе браузер заблокирует iframe.

## Проверка
- Открыть страницу Wix → форма отображается, отправляется, «Заявление» скачивается.
- Заявка появляется в LoyalPro → «Заявки на справки».
```

- [ ] **Step 2: Commit**

```bash
git add docs/cert-request-wix-embed.md
git commit -m "docs(cert-request): инструкция встройки формы в Wix"
```

---

## Финальная проверка (после всех задач)

- [ ] Прогнать все тесты: `cd backend && node --test services/cert-request.test.js services/medical-cert-layout.test.js services/medical-cert-pdf.test.js` — все PASS.
- [ ] E2E вручную: открыть `/cert-request/clinic-1` → подать заявку «за пациента» (другой телефон) → скачать заявление → в LoyalPro увидеть заявку → «Создать справку» → сгенерировать КНД-PDF.
- [ ] Проверить, что несопоставленная заявка (телефон не из базы) принимается и помечена «—», staff может привязать клиента кнопкой match.
- [ ] Использовать superpowers:finishing-a-development-branch для завершения ветки.
