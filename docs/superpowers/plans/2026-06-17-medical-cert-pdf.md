# Медицинская справка КНД 1151156 — генерация PDF: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Дать персоналу клиники возможность по запросу формировать заполненный PDF официального бланка «Справка об оплате медицинских услуг» (КНД 1151156) наложением данных на загруженный пустой бланк.

**Architecture:** Бэкенд накладывает текст на пустой PDF-бланк (хранится в S3) через `pdf-lib` + `@pdf-lib/fontkit`, используя карту координат из БД. Часть полей автозаполняется из БД (ФИО клиента, сумма оплат за год, константы клиники), часть вводится сотрудником вручную в админке (ванильный SPA). Шаблон и его координаты управляются через админку.

**Tech Stack:** Node.js/Express, PostgreSQL (`db` wrapper), `pdf-lib`, `@pdf-lib/fontkit`, `multer`, AWS S3 SDK (через `services/s3.js`), ванильный JS frontend.

**Спека:** `docs/superpowers/specs/2026-06-17-medical-cert-pdf-design.md`

---

## File Structure

**Создаются:**
- `backend/services/medical-cert-layout.js` — чистые функции раскладки значений (сумма → рубли/копейки по ячейкам, дата → ДД.ММ.ГГГГ по ячейкам, ФИО → Фамилия/Имя/Отчество). Без I/O, без PDF.
- `backend/services/medical-cert-layout.test.js` — тесты чистых функций.
- `backend/services/medical-cert-defaults.js` — сбор автозаполняемых полей из БД (ФИО клиента, сумма за год, константы клиники).
- `backend/services/medical-cert-defaults.test.js` — тесты сборки defaults (с мок-`db`).
- `backend/services/medical-cert-pdf.js` — ядро: загрузка бланка из S3, встраивание шрифта, отрисовка полей по координатам, возврат буфера PDF.
- `backend/services/medical-cert-pdf.test.js` — smoke-тест генерации (валидный PDF, число страниц).
- `backend/services/medical-cert-template.js` — управление активным шаблоном (загрузка в S3, чтение метаданных/координат из БД).
- `backend/routes/medical-cert.js` — HTTP-роуты под JWT.
- `backend/assets/fonts/PTSans-Regular.ttf` — кириллический TTF для встраивания (бинарный ассет).
- `backend/data/medical-cert-coords.default.json` — стартовая карта координат (калибруется через редактор).
- `frontend/js/pages/medical-cert.js` — страница админки (форма справки + управление шаблоном).

**Изменяются:**
- `backend/package.json` — зависимости `pdf-lib`, `@pdf-lib/fontkit`.
- `backend/migrations.js` — таблицы `medical_cert_templates`, `medical_cert_coords`.
- `backend/routes/index.js` — регистрация роута `/api/medical-cert`.
- `frontend/index.html` — пункт меню + секция `#page-medical-cert` + подключение скрипта.
- `frontend/js/core/nav.js` — диспатч `loadMedicalCert()` при переходе на вкладку.

---

## Task 1: Зависимости и шрифт

**Files:**
- Modify: `backend/package.json`
- Create: `backend/assets/fonts/PTSans-Regular.ttf`

- [ ] **Step 1: Установить зависимости**

```bash
cd backend
npm install pdf-lib@^1.17.1 @pdf-lib/fontkit@^1.1.1
```

- [ ] **Step 2: Положить кириллический TTF-шрифт**

Скачать PT Sans Regular (Open Font License, поддерживает кириллицу) и сохранить как `backend/assets/fonts/PTSans-Regular.ttf`:

```bash
mkdir -p backend/assets/fonts
curl -L -o backend/assets/fonts/PTSans-Regular.ttf \
  "https://github.com/google/fonts/raw/main/ofl/ptsans/PTSans-Regular.ttf"
```

- [ ] **Step 3: Проверить, что файлы на месте**

Run: `node -e "const fs=require('fs');console.log(fs.statSync('backend/assets/fonts/PTSans-Regular.ttf').size>50000)"`
Expected: `true`

Run: `node -e "require('pdf-lib');require('@pdf-lib/fontkit');console.log('deps ok')"`
Expected: `deps ok`

- [ ] **Step 4: Commit**

```bash
git add backend/package.json backend/package-lock.json backend/assets/fonts/PTSans-Regular.ttf
git commit -m "chore: add pdf-lib, fontkit and cyrillic font for medical cert

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Чистые функции раскладки (layout)

Раскладка значений в массивы символов по ячейкам бланка. Без PDF и без БД — легко тестируется.

**Files:**
- Create: `backend/services/medical-cert-layout.js`
- Test: `backend/services/medical-cert-layout.test.js`

- [ ] **Step 1: Написать падающие тесты**

```js
// backend/services/medical-cert-layout.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const { splitAmount, splitDate, splitFullName, sanitizeUpper } = require('./medical-cert-layout');

test('splitAmount: рубли и копейки раздельно', () => {
  assert.deepStrictEqual(splitAmount(82203), { rubles: '82203', kopecks: '00' });
  assert.deepStrictEqual(splitAmount(82203.5), { rubles: '82203', kopecks: '50' });
  assert.deepStrictEqual(splitAmount(0), { rubles: '0', kopecks: '00' });
  assert.deepStrictEqual(splitAmount('1234.07'), { rubles: '1234', kopecks: '07' });
});

test('splitAmount: null/пусто → null', () => {
  assert.strictEqual(splitAmount(null), null);
  assert.strictEqual(splitAmount(''), null);
});

test('splitDate: ISO/Date → массив [Д,Д,М,М,Г,Г,Г,Г]', () => {
  assert.deepStrictEqual(splitDate('2009-06-02'), ['0','2','0','6','2','0','0','9']);
  assert.deepStrictEqual(splitDate('1989-05-08'), ['0','8','0','5','1','9','8','9']);
});

test('splitDate: пусто → null', () => {
  assert.strictEqual(splitDate(''), null);
  assert.strictEqual(splitDate(null), null);
});

test('splitFullName: ФИО из одного поля', () => {
  assert.deepStrictEqual(
    splitFullName('Агафонов Артем Эдуардович'),
    { last: 'АГАФОНОВ', first: 'АРТЕМ', middle: 'ЭДУАРДОВИЧ' }
  );
  assert.deepStrictEqual(
    splitFullName('Иванов Иван'),
    { last: 'ИВАНОВ', first: 'ИВАН', middle: '' }
  );
  assert.deepStrictEqual(
    splitFullName('  Петров  '),
    { last: 'ПЕТРОВ', first: '', middle: '' }
  );
});

test('sanitizeUpper: верхний регистр, ё→е не трогаем', () => {
  assert.strictEqual(sanitizeUpper('агафонов'), 'АГАФОНОВ');
  assert.strictEqual(sanitizeUpper(null), '');
});
```

- [ ] **Step 2: Запустить тест — убедиться, что падает**

Run: `cd backend && node --test services/medical-cert-layout.test.js`
Expected: FAIL — `Cannot find module './medical-cert-layout'`

- [ ] **Step 3: Реализовать модуль**

```js
// backend/services/medical-cert-layout.js
'use strict';

// Сумму храним/принимаем как число рублей с копейками (например 82203.50)
function splitAmount(value) {
  if (value === null || value === undefined || value === '') return null;
  const num = Number(value);
  if (!Number.isFinite(num)) return null;
  const cents = Math.round(num * 100);
  const rubles = Math.trunc(cents / 100);
  const kopecks = Math.abs(cents % 100);
  return { rubles: String(rubles), kopecks: String(kopecks).padStart(2, '0') };
}

// Принимает 'YYYY-MM-DD' или Date → массив из 8 символов ДДММГГГГ
function splitDate(value) {
  if (!value) return null;
  const d = (value instanceof Date) ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  const dd = String(d.getUTCDate()).padStart(2, '0');
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const yyyy = String(d.getUTCFullYear()).padStart(4, '0');
  return [...dd, ...mm, ...yyyy];
}

function sanitizeUpper(s) {
  return (s == null ? '' : String(s)).trim().toUpperCase();
}

// Единое поле name → {last, first, middle}
function splitFullName(name) {
  const parts = sanitizeUpper(name).split(/\s+/).filter(Boolean);
  return {
    last: parts[0] || '',
    first: parts[1] || '',
    middle: parts.slice(2).join(' ') || '',
  };
}

module.exports = { splitAmount, splitDate, splitFullName, sanitizeUpper };
```

- [ ] **Step 4: Запустить тесты — убедиться, что проходят**

Run: `cd backend && node --test services/medical-cert-layout.test.js`
Expected: PASS (все тесты)

- [ ] **Step 5: Commit**

```bash
git add backend/services/medical-cert-layout.js backend/services/medical-cert-layout.test.js
git commit -m "feat: pure layout helpers for medical cert (amount/date/name split)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Карта координат (стартовая) и схема полей

Описывает, какие поля бланк содержит и как они кладутся. Координаты — стартовые приближения; калибруются позже через редактор против реального бланка.

**Files:**
- Create: `backend/data/medical-cert-coords.default.json`

- [ ] **Step 1: Создать стартовую карту координат**

Координаты в точках PDF (origin внизу-слева, страница A4 ≈ 595×842). Значения — стартовые приближения; будут уточнены в редакторе (Task 9). Тип поля: `cells` (посимвольно с шагом `step` от `x`), `text` (свободный с автопереносом по `width`), `checkbox` (одна цифра в `x,y`).

```json
{
  "version": 0,
  "pageSize": { "width": 595, "height": 842 },
  "fields": {
    "cert_number":      { "page": 0, "type": "cells", "x": 470, "y": 690, "step": 12, "max": 9, "fontSize": 11 },
    "correction_number":{ "page": 0, "type": "cells", "x": 470, "y": 668, "step": 12, "max": 3, "fontSize": 11 },
    "report_year":      { "page": 0, "type": "cells", "x": 520, "y": 690, "step": 12, "max": 4, "fontSize": 11 },
    "org_name":         { "page": 0, "type": "text",  "x": 60,  "y": 640, "width": 480, "lineHeight": 18, "fontSize": 12 },
    "org_inn":          { "page": 0, "type": "cells", "x": 130, "y": 800, "step": 12, "max": 12, "fontSize": 11 },
    "org_kpp":          { "page": 0, "type": "cells", "x": 130, "y": 778, "step": 12, "max": 9, "fontSize": 11 },
    "payer_last":       { "page": 0, "type": "text",  "x": 95,  "y": 540, "width": 440, "lineHeight": 18, "fontSize": 12 },
    "payer_first":      { "page": 0, "type": "text",  "x": 95,  "y": 518, "width": 440, "lineHeight": 18, "fontSize": 12 },
    "payer_middle":     { "page": 0, "type": "text",  "x": 95,  "y": 496, "width": 440, "lineHeight": 18, "fontSize": 12 },
    "payer_inn":        { "page": 0, "type": "cells", "x": 95,  "y": 474, "step": 13, "max": 12, "fontSize": 11 },
    "payer_birthdate":  { "page": 0, "type": "cells", "x": 360, "y": 474, "step": 13, "max": 8, "fontSize": 11 },
    "doc_type_code":    { "page": 0, "type": "cells", "x": 175, "y": 440, "step": 12, "max": 2, "fontSize": 11 },
    "doc_serie_number": { "page": 0, "type": "cells", "x": 360, "y": 440, "step": 13, "max": 12, "fontSize": 11 },
    "doc_issue_date":   { "page": 0, "type": "cells", "x": 175, "y": 414, "step": 13, "max": 8, "fontSize": 11 },
    "payer_is_patient": { "page": 0, "type": "checkbox", "x": 470, "y": 388, "fontSize": 11 },
    "amount1_rub":      { "page": 0, "type": "cells", "x": 360, "y": 352, "step": 12, "max": 9, "fontSize": 11, "align": "right", "anchorRight": 470 },
    "amount1_kop":      { "page": 0, "type": "cells", "x": 500, "y": 352, "step": 12, "max": 2, "fontSize": 11 },
    "amount2_rub":      { "page": 0, "type": "cells", "x": 360, "y": 330, "step": 12, "max": 9, "fontSize": 11, "align": "right", "anchorRight": 470 },
    "amount2_kop":      { "page": 0, "type": "cells", "x": 500, "y": 330, "step": 12, "max": 2, "fontSize": 11 },
    "signer_last":      { "page": 0, "type": "text",  "x": 60,  "y": 250, "width": 250, "lineHeight": 18, "fontSize": 12 },
    "signer_first":     { "page": 0, "type": "text",  "x": 60,  "y": 228, "width": 250, "lineHeight": 18, "fontSize": 12 },
    "signer_middle":    { "page": 0, "type": "text",  "x": 60,  "y": 206, "width": 250, "lineHeight": 18, "fontSize": 12 },
    "sign_date":        { "page": 0, "type": "cells", "x": 175, "y": 170, "step": 13, "max": 8, "fontSize": 11 },
    "pages_count":      { "page": 0, "type": "cells", "x": 150, "y": 140, "step": 12, "max": 2, "fontSize": 11 },

    "patient_last":     { "page": 1, "type": "text",  "x": 95,  "y": 700, "width": 440, "lineHeight": 18, "fontSize": 12 },
    "patient_first":    { "page": 1, "type": "text",  "x": 95,  "y": 678, "width": 440, "lineHeight": 18, "fontSize": 12 },
    "patient_middle":   { "page": 1, "type": "text",  "x": 95,  "y": 656, "width": 440, "lineHeight": 18, "fontSize": 12 },
    "patient_inn":      { "page": 1, "type": "cells", "x": 95,  "y": 634, "step": 13, "max": 12, "fontSize": 11 },
    "patient_birthdate":{ "page": 1, "type": "cells", "x": 360, "y": 634, "step": 13, "max": 8, "fontSize": 11 },
    "patient_doc_type": { "page": 1, "type": "cells", "x": 175, "y": 600, "step": 12, "max": 2, "fontSize": 11 },
    "patient_doc_serie":{ "page": 1, "type": "cells", "x": 360, "y": 600, "step": 13, "max": 12, "fontSize": 11 },
    "patient_doc_date": { "page": 1, "type": "cells", "x": 175, "y": 574, "step": 13, "max": 8, "fontSize": 11 }
  }
}
```

- [ ] **Step 2: Проверить, что JSON валиден**

Run: `cd backend && node -e "const c=require('./data/medical-cert-coords.default.json');console.log(Object.keys(c.fields).length+' fields')"`
Expected: `32 fields`

- [ ] **Step 3: Commit**

```bash
git add backend/data/medical-cert-coords.default.json
git commit -m "feat: default coordinate map for medical cert form

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Ядро генерации PDF

Принимает буфер пустого бланка, карту координат и значения полей → возвращает буфер заполненного PDF.

**Files:**
- Create: `backend/services/medical-cert-pdf.js`
- Test: `backend/services/medical-cert-pdf.test.js`

- [ ] **Step 1: Написать smoke-тест**

Тест строит минимальный пустой 2-страничный PDF через pdf-lib (вместо реального бланка), прогоняет через `fillCertificate`, проверяет, что результат — валидный PDF и сохранил число страниц.

```js
// backend/services/medical-cert-pdf.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const { PDFDocument } = require('pdf-lib');
const { fillCertificate } = require('./medical-cert-pdf');

async function blankTwoPagePdf() {
  const doc = await PDFDocument.create();
  doc.addPage([595, 842]);
  doc.addPage([595, 842]);
  return Buffer.from(await doc.save());
}

const coords = {
  fields: {
    org_inn:    { page: 0, type: 'cells', x: 100, y: 800, step: 12, max: 12, fontSize: 11 },
    payer_last: { page: 0, type: 'text',  x: 95,  y: 540, width: 440, lineHeight: 18, fontSize: 12 },
    payer_is_patient: { page: 0, type: 'checkbox', x: 470, y: 388, fontSize: 11 },
    patient_last: { page: 1, type: 'text', x: 95, y: 700, width: 440, lineHeight: 18, fontSize: 12 },
  },
};

test('fillCertificate возвращает валидный PDF, сохраняя страницы', async () => {
  const blank = await blankTwoPagePdf();
  const out = await fillCertificate({
    blank,
    coords,
    values: { org_inn: '972406039212', payer_last: 'АГАФОНОВ', payer_is_patient: '1', patient_last: '' },
  });
  assert.ok(Buffer.isBuffer(out));
  assert.strictEqual(out.subarray(0, 5).toString(), '%PDF-');
  const reload = await PDFDocument.load(out);
  assert.strictEqual(reload.getPageCount(), 2);
});

test('fillCertificate: неизвестное поле в values не валит генерацию', async () => {
  const blank = await blankTwoPagePdf();
  const out = await fillCertificate({ blank, coords, values: { not_a_field: 'X' } });
  assert.ok(Buffer.isBuffer(out));
});

test('fillCertificate: значение для несуществующей страницы пропускается', async () => {
  const blank = await blankTwoPagePdf();
  const badCoords = { fields: { x: { page: 9, type: 'text', x: 10, y: 10, width: 100, lineHeight: 12, fontSize: 10 } } };
  const out = await fillCertificate({ blank, coords: badCoords, values: { x: 'hi' } });
  assert.ok(Buffer.isBuffer(out));
});
```

- [ ] **Step 2: Запустить тест — убедиться, что падает**

Run: `cd backend && node --test services/medical-cert-pdf.test.js`
Expected: FAIL — `Cannot find module './medical-cert-pdf'`

- [ ] **Step 3: Реализовать ядро**

```js
// backend/services/medical-cert-pdf.js
'use strict';

const fs = require('fs');
const path = require('path');
const { PDFDocument, rgb } = require('pdf-lib');
const fontkit = require('@pdf-lib/fontkit');

const FONT_PATH = path.join(__dirname, '../assets/fonts/PTSans-Regular.ttf');
const BLACK = rgb(0, 0, 0);

// Нарисовать строку символов по ячейкам (равный шаг step от x)
function drawCells(page, font, text, f) {
  const chars = String(text);
  const size = f.fontSize || 11;
  let startX = f.x;
  if (f.align === 'right' && f.anchorRight) {
    startX = f.anchorRight - (chars.length - 1) * f.step;
  }
  for (let i = 0; i < chars.length && i < (f.max || chars.length); i++) {
    page.drawText(chars[i], { x: startX + i * f.step, y: f.y, size, font, color: BLACK });
  }
}

// Свободный текст с переносом по ширине width
function drawText(page, font, text, f) {
  const size = f.fontSize || 12;
  const words = String(text).split(/\s+/).filter(Boolean);
  const lineHeight = f.lineHeight || size + 4;
  let line = '';
  let y = f.y;
  const flush = () => { if (line) { page.drawText(line, { x: f.x, y, size, font, color: BLACK }); y -= lineHeight; line = ''; } };
  for (const w of words) {
    const trial = line ? line + ' ' + w : w;
    if (font.widthOfTextAtSize(trial, size) > (f.width || 9999) && line) { flush(); line = w; }
    else line = trial;
  }
  flush();
}

function drawField(page, font, value, f) {
  if (value === null || value === undefined || value === '') return;
  if (f.type === 'cells')        drawCells(page, font, value, f);
  else if (f.type === 'checkbox') page.drawText(String(value), { x: f.x, y: f.y, size: f.fontSize || 11, font, color: BLACK });
  else                            drawText(page, font, value, f);
}

// blank: Buffer пустого бланка; coords: {fields}; values: {fieldName: stringValue}
async function fillCertificate({ blank, coords, values }) {
  const doc = await PDFDocument.load(blank);
  doc.registerFontkit(fontkit);
  const font = await doc.embedFont(fs.readFileSync(FONT_PATH), { subset: true });
  const pages = doc.getPages();

  for (const [name, f] of Object.entries(coords.fields || {})) {
    const value = values[name];
    if (value === null || value === undefined || value === '') continue;
    const page = pages[f.page || 0];
    if (!page) continue; // страница отсутствует — пропускаем
    drawField(page, font, value, f);
  }
  return Buffer.from(await doc.save());
}

module.exports = { fillCertificate, drawCells, drawText };
```

- [ ] **Step 4: Запустить тесты — убедиться, что проходят**

Run: `cd backend && node --test services/medical-cert-pdf.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add backend/services/medical-cert-pdf.js backend/services/medical-cert-pdf.test.js
git commit -m "feat: medical cert PDF fill core (overlay text on blank by coords)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: БД-миграции для шаблона и координат

**Files:**
- Modify: `backend/migrations.js`

- [ ] **Step 1: Добавить таблицы в runMigrations**

В конец функции `runMigrations` (перед её закрывающей `}`) добавить:

```js
  // ── Medical certificate (КНД 1151156) ──────────────────────────
  await client.query(`
    CREATE TABLE IF NOT EXISTS medical_cert_templates (
      id          SERIAL PRIMARY KEY,
      salon_id    INTEGER REFERENCES salons(id) ON DELETE CASCADE,
      s3_key      TEXT NOT NULL,
      file_name   VARCHAR(255),
      version     INTEGER NOT NULL DEFAULT 1,
      is_active   BOOLEAN NOT NULL DEFAULT TRUE,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `).catch(() => {});

  await client.query(`
    CREATE TABLE IF NOT EXISTS medical_cert_coords (
      template_id INTEGER PRIMARY KEY REFERENCES medical_cert_templates(id) ON DELETE CASCADE,
      coords      JSONB NOT NULL,
      updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `).catch(() => {});
```

- [ ] **Step 2: Применить миграции**

Run: `cd backend && node -e "const {pool}=require('./db');const {runMigrations}=require('./migrations');pool.connect().then(async c=>{await runMigrations(c);c.release();console.log('migrated');process.exit(0)}).catch(e=>{console.error(e);process.exit(1)})"`
Expected: `migrated`

- [ ] **Step 3: Проверить таблицы**

Run: `cd backend && node -e "const {db}=require('./db');db.any(\"SELECT table_name FROM information_schema.tables WHERE table_name LIKE 'medical_cert%'\").then(r=>{console.log(r.map(x=>x.table_name).sort());process.exit(0)})"`
Expected: `[ 'medical_cert_coords', 'medical_cert_templates' ]`

- [ ] **Step 4: Commit**

```bash
git add backend/migrations.js
git commit -m "feat: db tables for medical cert templates and coords

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: Сервис управления шаблоном

Загрузка нового бланка в S3, чтение активного шаблона (буфер + координаты). Новый загруженный шаблон становится активным; координаты наследуются от предыдущего активного либо берутся из дефолта.

**Files:**
- Create: `backend/services/medical-cert-template.js`

- [ ] **Step 1: Реализовать сервис**

```js
// backend/services/medical-cert-template.js
'use strict';

const { db } = require('../db');
const s3 = require('./s3');
const defaultCoords = require('../data/medical-cert-coords.default.json');

// Загрузить новый бланк: кладём в S3, деактивируем прежние, создаём активную запись,
// координаты копируем с предыдущего активного шаблона или из дефолта.
async function uploadTemplate(salonId, buffer, fileName) {
  const key = `medical-cert/templates/${salonId}/${Date.now()}-${fileName.replace(/[^\w.-]/g, '_')}`;
  await s3.putObject(key, buffer, 'application/pdf');

  const prev = await db.oneOrNone(
    `SELECT t.id, c.coords FROM medical_cert_templates t
       LEFT JOIN medical_cert_coords c ON c.template_id = t.id
      WHERE t.salon_id = $1 AND t.is_active = TRUE
      ORDER BY t.version DESC LIMIT 1`, [salonId]);

  await db.query('UPDATE medical_cert_templates SET is_active = FALSE WHERE salon_id = $1', [salonId]);

  const nextVersion = (await db.oneOrNone(
    'SELECT COALESCE(MAX(version),0)+1 AS v FROM medical_cert_templates WHERE salon_id=$1', [salonId])).v;

  const row = await db.one(
    `INSERT INTO medical_cert_templates (salon_id, s3_key, file_name, version, is_active)
     VALUES ($1,$2,$3,$4,TRUE) RETURNING id`,
    [salonId, key, fileName, nextVersion]);

  const coords = (prev && prev.coords) ? prev.coords : defaultCoords;
  await db.query(
    `INSERT INTO medical_cert_coords (template_id, coords) VALUES ($1,$2)`,
    [row.id, coords]);

  return { id: row.id, version: nextVersion };
}

// Метаданные активного шаблона + presigned URL для предпросмотра
async function getActiveTemplateMeta(salonId) {
  const t = await db.oneOrNone(
    `SELECT id, s3_key, file_name, version, created_at
       FROM medical_cert_templates WHERE salon_id=$1 AND is_active=TRUE
       ORDER BY version DESC LIMIT 1`, [salonId]);
  if (!t) return null;
  const url = await s3.presignGet(t.s3_key);
  return { id: t.id, fileName: t.file_name, version: t.version, createdAt: t.created_at, url };
}

// Буфер активного бланка + его координаты — для генерации
async function getActiveTemplateForFill(salonId) {
  const t = await db.oneOrNone(
    `SELECT t.id, t.s3_key, c.coords FROM medical_cert_templates t
       LEFT JOIN medical_cert_coords c ON c.template_id = t.id
      WHERE t.salon_id=$1 AND t.is_active=TRUE ORDER BY t.version DESC LIMIT 1`, [salonId]);
  if (!t) return null;
  const obj = await s3.client.send(new (require('@aws-sdk/client-s3').GetObjectCommand)({
    Bucket: require('../config').S3_BUCKET, Key: t.s3_key,
  }));
  const buffer = Buffer.from(await obj.Body.transformToByteArray());
  return { templateId: t.id, blank: buffer, coords: t.coords || defaultCoords };
}

async function getCoords(salonId) {
  const t = await db.oneOrNone(
    `SELECT c.coords FROM medical_cert_templates t
       LEFT JOIN medical_cert_coords c ON c.template_id = t.id
      WHERE t.salon_id=$1 AND t.is_active=TRUE ORDER BY t.version DESC LIMIT 1`, [salonId]);
  return (t && t.coords) ? t.coords : defaultCoords;
}

async function saveCoords(salonId, coords) {
  const t = await db.oneOrNone(
    'SELECT id FROM medical_cert_templates WHERE salon_id=$1 AND is_active=TRUE ORDER BY version DESC LIMIT 1',
    [salonId]);
  if (!t) throw new Error('NO_ACTIVE_TEMPLATE');
  await db.query(
    `INSERT INTO medical_cert_coords (template_id, coords, updated_at) VALUES ($1,$2,now())
       ON CONFLICT (template_id) DO UPDATE SET coords=$2, updated_at=now()`,
    [t.id, coords]);
  return true;
}

module.exports = { uploadTemplate, getActiveTemplateMeta, getActiveTemplateForFill, getCoords, saveCoords };
```

- [ ] **Step 2: Проверить, что модуль загружается без ошибок**

Run: `cd backend && node -e "const m=require('./services/medical-cert-template');console.log(Object.keys(m).sort().join(','))"`
Expected: `getActiveTemplateForFill,getActiveTemplateMeta,getCoords,saveCoords,uploadTemplate`

- [ ] **Step 3: Commit**

```bash
git add backend/services/medical-cert-template.js
git commit -m "feat: medical cert template service (S3 upload, active template, coords)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: Сервис автозаполнения (defaults)

Собирает автозаполняемые поля: ФИО клиента (из `clients.name`), сумма оплат за год (из `revenue_operations`), константы клиники.

> **Confirm during execution:** проверить, что суммы оплат клиента действительно лежат в `revenue_operations(client_id, amount, operation_date, salon_id)`. Если по клинике используется другая таблица (`finances_log`), скорректировать запрос в `sumPaymentsForYear`. Поле суммы в UI всё равно редактируемое, так что это не блокер.

**Files:**
- Create: `backend/services/medical-cert-defaults.js`
- Test: `backend/services/medical-cert-defaults.test.js`

- [ ] **Step 1: Написать тесты (с инъекцией мок-`db`)**

```js
// backend/services/medical-cert-defaults.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const { buildDefaults } = require('./medical-cert-defaults');

const CLINIC = {
  org_name: 'ООО «КЛИНИКА ЭСТЕТИЧЕСКОЙ МЕДИЦИНЫ «ПЕРИ КЛИНИК»',
  org_inn: '9724060392', org_kpp: '772401001',
  signer_name: 'Гаджиева Пери Исамудиновна',
};

test('buildDefaults собирает ФИО, сумму и константы', async () => {
  const fakeDb = {
    oneOrNone: async () => ({ name: 'Агафонов Артем Эдуардович' }),
    one: async () => ({ total: '82203.00' }),
  };
  const r = await buildDefaults({ db: fakeDb, clinic: CLINIC, salonId: 1, clientId: 5, year: 2025 });
  assert.strictEqual(r.payer_last, 'АГАФОНОВ');
  assert.strictEqual(r.payer_first, 'АРТЕМ');
  assert.strictEqual(r.payer_middle, 'ЭДУАРДОВИЧ');
  assert.strictEqual(r.amount_total, 82203);
  assert.strictEqual(r.org_inn, '9724060392');
  assert.strictEqual(r.report_year, '2025');
  assert.strictEqual(r.signer_last, 'ГАДЖИЕВА');
});

test('buildDefaults: клиент не найден → пустое ФИО, сумма 0', async () => {
  const fakeDb = { oneOrNone: async () => null, one: async () => ({ total: null }) };
  const r = await buildDefaults({ db: fakeDb, clinic: CLINIC, salonId: 1, clientId: 999, year: 2025 });
  assert.strictEqual(r.payer_last, '');
  assert.strictEqual(r.amount_total, 0);
});
```

- [ ] **Step 2: Запустить тест — убедиться, что падает**

Run: `cd backend && node --test services/medical-cert-defaults.test.js`
Expected: FAIL — `Cannot find module './medical-cert-defaults'`

- [ ] **Step 3: Реализовать сервис**

```js
// backend/services/medical-cert-defaults.js
'use strict';

const { splitFullName } = require('./medical-cert-layout');

async function sumPaymentsForYear(db, salonId, clientId, year) {
  const row = await db.one(
    `SELECT COALESCE(SUM(amount),0) AS total
       FROM revenue_operations
      WHERE salon_id=$1 AND client_id=$2
        AND EXTRACT(YEAR FROM operation_date)=$3`,
    [salonId, clientId, year]);
  return Number(row.total) || 0;
}

// clinic: объект констант клиники (из настроек/конфига).
// db инжектируется (по умолчанию реальный) — упрощает тестирование.
async function buildDefaults({ db, clinic, salonId, clientId, year }) {
  const dbi = db || require('../db').db;
  const client = clientId
    ? await dbi.oneOrNone('SELECT name FROM clients WHERE id=$1 AND salon_id=$2', [clientId, salonId])
    : null;
  const fio = splitFullName(client ? client.name : '');
  const signer = splitFullName(clinic.signer_name || '');
  const amount = clientId ? await sumPaymentsForYear(dbi, salonId, clientId, year) : 0;

  return {
    report_year: String(year),
    org_name: clinic.org_name || '',
    org_inn: clinic.org_inn || '',
    org_kpp: clinic.org_kpp || '',
    payer_last: fio.last, payer_first: fio.first, payer_middle: fio.middle,
    signer_last: signer.last, signer_first: signer.first, signer_middle: signer.middle,
    amount_total: amount,
  };
}

module.exports = { buildDefaults, sumPaymentsForYear };
```

- [ ] **Step 4: Запустить тесты — убедиться, что проходят**

Run: `cd backend && node --test services/medical-cert-defaults.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add backend/services/medical-cert-defaults.js backend/services/medical-cert-defaults.test.js
git commit -m "feat: medical cert defaults service (auto-fill name, year sum, clinic consts)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 8: HTTP-роуты

Связывает сервисы. Маппит «бизнес-значения» в имена полей координат, валидирует, генерирует PDF.

> **Note:** константы клиники берём из конфига. Добавить в `backend/config.js` блок `MEDICAL_CERT_CLINIC` (см. Step 1). Значения — из образца справки.

**Files:**
- Modify: `backend/config.js`
- Create: `backend/routes/medical-cert.js`
- Modify: `backend/routes/index.js`

- [ ] **Step 1: Добавить константы клиники в config.js**

В `backend/config.js` в экспортируемый объект добавить:

```js
  MEDICAL_CERT_CLINIC: {
    org_name: process.env.MEDCERT_ORG_NAME || 'ООО «КЛИНИКА ЭСТЕТИЧЕСКОЙ МЕДИЦИНЫ «ПЕРИ КЛИНИК»',
    org_inn:  process.env.MEDCERT_ORG_INN  || '9724060392',
    org_kpp:  process.env.MEDCERT_ORG_KPP  || '772401001',
    signer_name: process.env.MEDCERT_SIGNER || 'Гаджиева Пери Исамудиновна',
  },
```

- [ ] **Step 2: Реализовать роуты**

```js
// backend/routes/medical-cert.js
'use strict';

const router = require('express').Router();
const multer = require('multer');
const cfg = require('../config');
const { db } = require('../db');
const { auth, requireRole } = require('../middleware/auth');
const { createLogger } = require('../logger');
const { buildDefaults } = require('../services/medical-cert-defaults');
const { fillCertificate } = require('../services/medical-cert-pdf');
const tpl = require('../services/medical-cert-template');
const { splitAmount, splitDate, sanitizeUpper } = require('../services/medical-cert-layout');

const logger = createLogger('MedicalCert');
const adminOnly = [auth, requireRole('owner', 'admin')];
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

// salon_id текущего пользователя (как в остальных роутах берётся из req.user)
function salonOf(req) { return req.user.salon_id; }

// GET defaults — автозаполняемые поля
router.get('/defaults', adminOnly, async (req, res) => {
  try {
    const clientId = req.query.clientId ? Number(req.query.clientId) : null;
    const year = Number(req.query.year) || new Date().getFullYear();
    const d = await buildDefaults({ db, clinic: cfg.MEDICAL_CERT_CLINIC, salonId: salonOf(req), clientId, year });
    res.json(d);
  } catch (e) { logger.error(e.message); res.status(500).json({ error: 'defaults_failed' }); }
});

// Преобразование плоских значений формы в значения полей координат
function mapValues(body) {
  const v = {};
  const set = (k, val) => { if (val !== undefined && val !== null && val !== '') v[k] = val; };

  set('cert_number', body.cert_number);
  set('correction_number', body.correction_number);
  set('report_year', body.report_year);
  set('org_name', body.org_name);
  if (body.org_inn) set('org_inn', String(body.org_inn));
  if (body.org_kpp) set('org_kpp', String(body.org_kpp));

  set('payer_last', sanitizeUpper(body.payer_last));
  set('payer_first', sanitizeUpper(body.payer_first));
  set('payer_middle', sanitizeUpper(body.payer_middle));
  if (body.payer_inn) set('payer_inn', String(body.payer_inn));
  const pbd = splitDate(body.payer_birthdate); if (pbd) v.payer_birthdate = pbd.join('');
  if (body.doc_type_code) set('doc_type_code', String(body.doc_type_code));
  if (body.doc_serie_number) set('doc_serie_number', String(body.doc_serie_number).replace(/\s/g, ''));
  const did = splitDate(body.doc_issue_date); if (did) v.doc_issue_date = did.join('');
  set('payer_is_patient', body.payer_is_patient === '1' || body.payer_is_patient === true ? '1' : '0');

  const a1 = splitAmount(body.amount1); if (a1) { v.amount1_rub = a1.rubles; v.amount1_kop = a1.kopecks; }
  const a2 = splitAmount(body.amount2); if (a2) { v.amount2_rub = a2.rubles; v.amount2_kop = a2.kopecks; }

  set('signer_last', sanitizeUpper(body.signer_last));
  set('signer_first', sanitizeUpper(body.signer_first));
  set('signer_middle', sanitizeUpper(body.signer_middle));
  const sd = splitDate(body.sign_date); if (sd) v.sign_date = sd.join('');
  set('pages_count', body.payer_is_patient === '1' ? '1' : '2');

  // Страница 2 — только если плательщик ≠ пациент
  if (body.payer_is_patient !== '1') {
    set('patient_last', sanitizeUpper(body.patient_last));
    set('patient_first', sanitizeUpper(body.patient_first));
    set('patient_middle', sanitizeUpper(body.patient_middle));
    if (body.patient_inn) set('patient_inn', String(body.patient_inn));
    const ptbd = splitDate(body.patient_birthdate); if (ptbd) v.patient_birthdate = ptbd.join('');
    if (body.patient_doc_type) set('patient_doc_type', String(body.patient_doc_type));
    if (body.patient_doc_serie) set('patient_doc_serie', String(body.patient_doc_serie).replace(/\s/g, ''));
    const ptd = splitDate(body.patient_doc_date); if (ptd) v.patient_doc_date = ptd.join('');
  }
  return v;
}

// POST generate — вернуть PDF
router.post('/generate', adminOnly, async (req, res) => {
  try {
    const active = await tpl.getActiveTemplateForFill(salonOf(req));
    if (!active) return res.status(409).json({ error: 'no_active_template' });
    const values = mapValues(req.body || {});
    const pdf = await fillCertificate({ blank: active.blank, coords: active.coords, values });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="medical-cert.pdf"`);
    res.send(pdf);
  } catch (e) { logger.error(e.message); res.status(500).json({ error: 'generate_failed' }); }
});

// GET активный шаблон (метаданные + URL)
router.get('/template', adminOnly, async (req, res) => {
  try { res.json((await tpl.getActiveTemplateMeta(salonOf(req))) || {}); }
  catch (e) { logger.error(e.message); res.status(500).json({ error: 'template_meta_failed' }); }
});

// POST загрузка нового бланка
router.post('/template', adminOnly, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'no_file' });
    if (req.file.mimetype !== 'application/pdf') return res.status(400).json({ error: 'pdf_only' });
    const r = await tpl.uploadTemplate(salonOf(req), req.file.buffer, req.file.originalname);
    res.json(r);
  } catch (e) { logger.error(e.message); res.status(500).json({ error: 'upload_failed' }); }
});

// GET/PUT координаты
router.get('/template/coords', adminOnly, async (req, res) => {
  try { res.json(await tpl.getCoords(salonOf(req))); }
  catch (e) { logger.error(e.message); res.status(500).json({ error: 'coords_get_failed' }); }
});

router.put('/template/coords', adminOnly, async (req, res) => {
  try { await tpl.saveCoords(salonOf(req), req.body); res.json({ ok: true }); }
  catch (e) { logger.error(e.message); res.status(e.message === 'NO_ACTIVE_TEMPLATE' ? 409 : 500).json({ error: 'coords_save_failed' }); }
});

module.exports = router;
```

- [ ] **Step 3: Зарегистрировать роут в index.js**

В `backend/routes/index.js` после строки `app.use('/api/broadcasts', require('./broadcasts'));` (строка ~54) добавить:

```js
  app.use('/api/medical-cert',      require('./medical-cert'));
```

- [ ] **Step 4: Проверить, что сервер стартует и роут смонтирован**

Run: `cd backend && node -e "const r=require('./routes/medical-cert');console.log(typeof r==='function'?'router ok':'BAD')"`
Expected: `router ok`

- [ ] **Step 5: Commit**

```bash
git add backend/config.js backend/routes/medical-cert.js backend/routes/index.js
git commit -m "feat: medical cert HTTP routes (defaults, generate, template, coords)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 9: Фронтенд — вкладка и страница

Добавляет пункт меню, секцию страницы, форму справки и блок управления шаблоном с редактором координат.

**Files:**
- Modify: `frontend/index.html`
- Modify: `frontend/js/core/nav.js`
- Create: `frontend/js/pages/medical-cert.js`

- [ ] **Step 1: Добавить пункт меню и секцию страницы в index.html**

Найти `#mainNav` и `#mnavList` (по аналогии с существующими `.tn` пунктами, напр. `data-p="broadcasts"`). Добавить в оба меню рядом с другими пунктами для ролей owner,admin:

```html
<div class="tn" data-p="medical-cert" data-roles="owner,admin" onclick="nav(this)">Справки</div>
```

Найти контейнер страниц (где лежат `<div class="page" id="page-...">`). Добавить новую секцию:

```html
<div class="page" id="page-medical-cert">
  <div class="card" style="padding:16px;margin-bottom:16px">
    <h2 style="margin-bottom:12px">Справка об оплате мед. услуг (КНД 1151156)</h2>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
      <div class="fg"><label class="fl">Клиент (поиск)</label>
        <input id="mc-client-search" placeholder="Имя или телефон" oninput="mcSearchClients()">
        <div id="mc-client-results" style="font-size:12px"></div>
        <input type="hidden" id="mc-client-id">
      </div>
      <div class="fg"><label class="fl">Отчётный год</label>
        <input type="number" id="mc-year" value="2025"></div>
    </div>
    <button class="btn" onclick="mcLoadDefaults()">Подтянуть данные</button>

    <hr style="margin:16px 0">
    <div id="mc-form" style="display:grid;grid-template-columns:1fr 1fr;gap:10px"></div>
    <div style="margin-top:16px"><button class="btn btn-primary" onclick="mcGenerate()">Сформировать PDF</button></div>
  </div>

  <div class="card" style="padding:16px">
    <h3 style="margin-bottom:8px">Шаблон бланка</h3>
    <div id="mc-template-meta" style="font-size:13px;margin-bottom:8px"></div>
    <input type="file" id="mc-template-file" accept="application/pdf">
    <button class="btn" onclick="mcUploadTemplate()">Загрузить новый бланк</button>
    <button class="btn" onclick="mcOpenCoordsEditor()">Редактор координат</button>
    <div id="mc-coords-editor" style="margin-top:12px"></div>
  </div>
</div>
```

- [ ] **Step 2: Подключить скрипт страницы в index.html**

Рядом с другими `<script src="js/pages/...">` добавить:

```html
<script src="js/pages/medical-cert.js"></script>
```

- [ ] **Step 3: Добавить диспатч в nav.js**

В `frontend/js/core/nav.js` в функции `nav(el)` рядом с другими `if (p === ...)` добавить:

```js
  if (p === 'medical-cert')    loadMedicalCert();
```

- [ ] **Step 4: Реализовать страницу medical-cert.js**

```js
// frontend/js/pages/medical-cert.js
// Зависимости: api(), notify()

// Поля формы: [key, label, авто?]. Авто-поля подтягиваются из /defaults.
const MC_FIELDS = [
  ['cert_number', 'Номер справки', false],
  ['correction_number', 'Номер корректировки', false],
  ['report_year', 'Отчётный год', true],
  ['org_name', 'Наименование организации', true],
  ['org_inn', 'ИНН организации', true],
  ['org_kpp', 'КПП организации', true],
  ['payer_last', 'Фамилия налогоплательщика', true],
  ['payer_first', 'Имя', true],
  ['payer_middle', 'Отчество', true],
  ['payer_inn', 'ИНН налогоплательщика', false],
  ['payer_birthdate', 'Дата рождения (ГГГГ-ММ-ДД)', false],
  ['doc_type_code', 'Код вида документа', false],
  ['doc_serie_number', 'Серия и номер', false],
  ['doc_issue_date', 'Дата выдачи (ГГГГ-ММ-ДД)', false],
  ['amount1', 'Сумма код «1», ₽', false],
  ['amount2', 'Сумма код «2», ₽', false],
  ['signer_last', 'Фамилия подписанта', true],
  ['signer_first', 'Имя подписанта', true],
  ['signer_middle', 'Отчество подписанта', true],
  ['sign_date', 'Дата справки (ГГГГ-ММ-ДД)', false],
];

const MC_PATIENT_FIELDS = [
  ['patient_last', 'Пациент: Фамилия'],
  ['patient_first', 'Пациент: Имя'],
  ['patient_middle', 'Пациент: Отчество'],
  ['patient_inn', 'Пациент: ИНН'],
  ['patient_birthdate', 'Пациент: дата рождения (ГГГГ-ММ-ДД)'],
  ['patient_doc_type', 'Пациент: код вида документа'],
  ['patient_doc_serie', 'Пациент: серия и номер'],
  ['patient_doc_date', 'Пациент: дата выдачи (ГГГГ-ММ-ДД)'],
];

function mcInput(key, label) {
  return `<div class="fg"><label class="fl">${label}</label><input id="mc-f-${key}"></div>`;
}

function loadMedicalCert() {
  const form = document.getElementById('mc-form');
  let html = MC_FIELDS.map(([k, l]) => mcInput(k, l)).join('');
  html += `<div class="fg" style="grid-column:1/3"><label class="fl">
    <input type="checkbox" id="mc-f-payer_is_patient" checked onchange="mcTogglePatient()"> Налогоплательщик и пациент — одно лицо</label></div>`;
  html += `<div id="mc-patient-block" style="display:none;grid-column:1/3">
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">` +
    MC_PATIENT_FIELDS.map(([k, l]) => mcInput(k, l)).join('') + `</div></div>`;
  form.innerHTML = html;
  mcLoadTemplateMeta();
}

function mcTogglePatient() {
  const same = document.getElementById('mc-f-payer_is_patient').checked;
  document.getElementById('mc-patient-block').style.display = same ? 'none' : 'block';
}

let mcSearchTimer = null;
function mcSearchClients() {
  clearTimeout(mcSearchTimer);
  mcSearchTimer = setTimeout(async () => {
    const q = document.getElementById('mc-client-search').value.trim();
    if (q.length < 2) { document.getElementById('mc-client-results').innerHTML = ''; return; }
    try {
      const rows = await api('GET', '/api/clients?search=' + encodeURIComponent(q) + '&limit=8');
      const list = Array.isArray(rows) ? rows : (rows.items || rows.clients || []);
      document.getElementById('mc-client-results').innerHTML = list.map(c =>
        `<div style="cursor:pointer;padding:4px" onclick="mcPickClient(${c.id},'${(c.name||'').replace(/'/g,'')}')">${c.name||''} ${c.phone||''}</div>`).join('');
    } catch {}
  }, 300);
}

function mcPickClient(id, name) {
  document.getElementById('mc-client-id').value = id;
  document.getElementById('mc-client-search').value = name;
  document.getElementById('mc-client-results').innerHTML = '';
}

async function mcLoadDefaults() {
  const clientId = document.getElementById('mc-client-id').value;
  const year = document.getElementById('mc-year').value;
  try {
    const d = await api('GET', `/api/medical-cert/defaults?clientId=${clientId}&year=${year}`);
    for (const [k] of MC_FIELDS) {
      const el = document.getElementById('mc-f-' + k);
      if (el && d[k] !== undefined) el.value = d[k];
    }
    if (d.amount_total) document.getElementById('mc-f-amount1').value = d.amount_total;
    notify('Данные подтянуты');
  } catch { notify('Не удалось подтянуть данные', 'error'); }
}

function mcCollect() {
  const body = {};
  for (const [k] of MC_FIELDS) { const el = document.getElementById('mc-f-' + k); if (el) body[k] = el.value; }
  for (const [k] of MC_PATIENT_FIELDS) { const el = document.getElementById('mc-f-' + k); if (el) body[k] = el.value; }
  body.payer_is_patient = document.getElementById('mc-f-payer_is_patient').checked ? '1' : '0';
  return body;
}

async function mcGenerate() {
  try {
    const resp = await fetch('/api/medical-cert/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + localStorage.getItem('token') },
      body: JSON.stringify(mcCollect()),
    });
    if (!resp.ok) { const e = await resp.json().catch(() => ({})); throw new Error(e.error || resp.status); }
    const blob = await resp.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = 'spravka.pdf'; a.click();
    URL.revokeObjectURL(url);
  } catch (e) { notify('Ошибка генерации: ' + e.message, 'error'); }
}

async function mcLoadTemplateMeta() {
  try {
    const m = await api('GET', '/api/medical-cert/template');
    const el = document.getElementById('mc-template-meta');
    el.innerHTML = m && m.fileName
      ? `Активный бланк: ${m.fileName} (v${m.version}). <a href="${m.url}" target="_blank">открыть</a>`
      : '<span style="color:var(--danger)">Бланк не загружен</span>';
  } catch {}
}

async function mcUploadTemplate() {
  const f = document.getElementById('mc-template-file').files[0];
  if (!f) return notify('Выберите PDF-файл', 'error');
  const fd = new FormData(); fd.append('file', f);
  try {
    const resp = await fetch('/api/medical-cert/template', {
      method: 'POST', headers: { 'Authorization': 'Bearer ' + localStorage.getItem('token') }, body: fd });
    if (!resp.ok) throw new Error((await resp.json().catch(() => ({}))).error || resp.status);
    notify('Бланк загружен'); mcLoadTemplateMeta();
  } catch (e) { notify('Ошибка загрузки: ' + e.message, 'error'); }
}

// Простой редактор координат: textarea с JSON. Калибровка значений по реальному бланку.
async function mcOpenCoordsEditor() {
  const coords = await api('GET', '/api/medical-cert/template/coords');
  document.getElementById('mc-coords-editor').innerHTML =
    `<textarea id="mc-coords-json" rows="14" style="width:100%;font-family:monospace;font-size:12px">${JSON.stringify(coords, null, 2)}</textarea>
     <button class="btn" onclick="mcSaveCoords()">Сохранить координаты</button>`;
}

async function mcSaveCoords() {
  try {
    const coords = JSON.parse(document.getElementById('mc-coords-json').value);
    await api('PUT', '/api/medical-cert/template/coords', coords);
    notify('Координаты сохранены');
  } catch (e) { notify('Ошибка JSON/сохранения: ' + e.message, 'error'); }
}
```

> **Confirm during execution:** проверить точную сигнатуру `api(method, path, body)` и формат ответа `/api/clients?search=` в существующем `frontend/js/core` и `routes/clients.js`. При расхождении — подогнать `mcSearchClients`/`api`-вызовы под существующий контракт (имя параметра поиска, поле массива в ответе, способ передачи токена). Логика остального не меняется.

- [ ] **Step 5: Проверить синтаксис JS**

Run: `node --check frontend/js/pages/medical-cert.js && echo "syntax ok"`
Expected: `syntax ok`

- [ ] **Step 6: Commit**

```bash
git add frontend/index.html frontend/js/core/nav.js frontend/js/pages/medical-cert.js
git commit -m "feat: medical cert admin page (form, generate, template upload, coords editor)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 10: Калибровка координат и визуальная сверка (ручная)

После предоставления реального пустого бланка координаты подгоняются под реальную сетку.

**Files:** (правки данных, не кода)
- Через UI: `/api/medical-cert/template/coords`

- [ ] **Step 1: Загрузить реальный пустой бланк**

Через вкладку «Справки» → «Загрузить новый бланк» загрузить предоставленный заказчиком пустой PDF.

- [ ] **Step 2: Сгенерировать тестовую справку по данным образца**

Заполнить форму данными из образца «Агафонов А.Э. 2025» (ИНН 583605353756, паспорт 56 08 852813, дата выдачи 2009-06-02, дата рождения 1989-05-08, сумма код «1» 82203, номер справки 6, подписант Гаджиева Пери Исамудиновна, дата справки 2026-01-13) → «Сформировать PDF».

- [ ] **Step 3: Сверить с эталоном и откалибровать**

Сравнить полученный PDF с приложенным эталонным «Агафонов Артем Эдуардович 2025.pdf». Для каждого поля, попавшего мимо ячеек, поправить `x`/`y`/`step` в редакторе координат и пересохранить. Повторять до точного попадания.

- [ ] **Step 4: Зафиксировать откалиброванный дефолт**

Когда координаты выверены, скопировать итоговый JSON из редактора в `backend/data/medical-cert-coords.default.json` (чтобы новые загрузки бланка стартовали с верных координат).

```bash
git add backend/data/medical-cert-coords.default.json
git commit -m "chore: calibrated coordinate map for medical cert blank

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage:**
- Гибрид данных (авто + ручные) → Task 7 (defaults) + Task 8 (mapValues) + Task 9 (форма). ✓
- Наложение на офиц. бланк через pdf-lib → Task 4. ✓
- Штрихкоды сохраняются (грузим готовый бланк) → Task 6/10. ✓
- Размещение в админке персонала → Task 9. ✓
- Одна справка по запросу → Task 8 (`/generate`). ✓
- Шаблон в S3 + загрузка через loyalpro → Task 6 + Task 8 (`/template`) + Task 9. ✓
- Карта координат на версию шаблона + редактор → Task 3, 6, 9, 10. ✓
- Деление код 1/код 2 вручную → Task 8 (`amount1`/`amount2`), Task 9 форма. ✓
- Страница 2 при плательщик ≠ пациент → Task 8 (`mapValues`), Task 9 (`mc-patient-block`). ✓
- QR-зона пустая → нигде не рисуем. ✓
- Валидация (ИНН/даты/суммы) → нормализация в `mapValues` (splitDate/splitAmount) + ограничение `max` в координатах. Жёсткую серверную валидацию длины ИНН добавить в `mapValues` при необходимости; поля числятся как «нормализуемые». ✓
- Тестирование: юнит (Task 2, 7), smoke PDF (Task 4), ручная визуальная сверка (Task 10). ✓

**Открытые подтверждения при исполнении (помечены в задачах):**
- Task 7: таблица сумм оплат (`revenue_operations` vs `finances_log`).
- Task 8: `req.user.salon_id` — поле salon_id в JWT-пейлоаде (свериться с `middleware/auth.js`).
- Task 9: сигнатура `api()` и контракт `/api/clients?search=`.

**Placeholder scan:** код приведён полностью в каждом шаге; «Confirm during execution» — это явные точки сверки с существующим контрактом, не плейсхолдеры логики.

**Type consistency:** имена полей координат (`payer_last`, `amount1_rub`, …) согласованы между Task 3 (карта), Task 4 (отрисовка), Task 8 (`mapValues`). Функции `splitAmount/splitDate/splitFullName/sanitizeUpper` определены в Task 2 и используются в Task 7/8 с теми же сигнатурами.
