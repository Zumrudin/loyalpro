# Визуальный drag-редактор координат медсправки: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Дать админу клиники визуально откалибровать карту координат полей бланка КНД 1151156 — рендер реального бланка в браузере, перетаскивание полей мышью, доводка стрелками, правка параметров в боковой панели, сохранение в БД.

**Architecture:** Чисто фронтенд. Бэкенд не меняется — переиспользуем `GET /api/medical-cert/template` (presigned URL бланка), `GET/PUT /api/medical-cert/template/coords`. `pdf.js` (CDN, лениво) рендерит страницы в `<canvas>`; поверх — слой DOM-маркеров по карте координат. Чистые transform-функции pt↔px вынесены в отдельный тестируемый модуль.

**Tech Stack:** Ванильный JS, pdf.js (pdfjs-dist@3.11.174 с jsdelivr CDN), существующие хелперы `api()`, `notify()`, `esc()`, `escAttr()`, `openModal` паттерн.

**Спека:** `docs/superpowers/specs/2026-06-17-medical-cert-coords-editor-design.md`

---

## File Structure

**Создаются:**
- `frontend/js/pages/medical-cert-coords-transform.js` — чистые функции `mcPtToScreen`, `mcScreenToPt`, `mcSampleFor`. В браузере — глобальные функции; в Node — `module.exports` (для тестов). Без DOM.
- `frontend/js/pages/medical-cert-coords-transform.test.js` — тесты чистых функций (`node:test`).
- `frontend/js/pages/medical-cert-coords-editor.js` — UI: модалка, ленивый pdf.js, рендер страниц, маркеры, drag/клавиатура, боковая панель, сохранение.

**Изменяются:**
- `frontend/index.html` — разметка модалки `#mc-visual-editor`, CSS-блок, кнопка «Редактор координат (визуальный)», подключение двух скриптов.
- `frontend/js/pages/medical-cert.js` — переименование старой кнопки в «Редактор JSON» (fallback); визуальную кнопку добавляем в index.html, логика — в новом модуле.

---

## Task 1: Чистый модуль преобразования координат + тесты

Чистые функции pt↔px с инверсией Y и baseline-поправкой. Легко тестируются в Node.

**Files:**
- Create: `frontend/js/pages/medical-cert-coords-transform.js`
- Test: `frontend/js/pages/medical-cert-coords-transform.test.js`

- [ ] **Step 1: Написать падающие тесты**

```js
// frontend/js/pages/medical-cert-coords-transform.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const { mcPtToScreen, mcScreenToPt, mcSampleFor } = require('./medical-cert-coords-transform');

const ctx = { scale: 1.5, pageHeightPt: 842 };

test('mcPtToScreen: x*scale, инверсия Y, baseline-поправка', () => {
  const r = mcPtToScreen({ x: 130, y: 800, fontSize: 11 }, ctx);
  // left = 130*1.5 = 195
  assert.strictEqual(r.left, 195);
  // top = (842-800)*1.5 - 11*1.5 = 63 - 16.5 = 46.5
  assert.strictEqual(r.top, 46.5);
});

test('mcPtToScreen: fontSize по умолчанию 11', () => {
  const a = mcPtToScreen({ x: 0, y: 0 }, ctx);
  const b = mcPtToScreen({ x: 0, y: 0, fontSize: 11 }, ctx);
  assert.deepStrictEqual(a, b);
});

test('round-trip pt->screen->pt даёт исходные целые pt', () => {
  for (const f of [
    { x: 130, y: 800, fontSize: 11 },
    { x: 60, y: 250, fontSize: 12 },
    { x: 500, y: 352, fontSize: 11 },
    { x: 0, y: 0, fontSize: 9 },
  ]) {
    const s = mcPtToScreen(f, ctx);
    const back = mcScreenToPt(s.left, s.top, f.fontSize, ctx);
    assert.deepStrictEqual(back, { x: f.x, y: f.y });
  }
});

test('mcScreenToPt округляет до целых pt', () => {
  const r = mcScreenToPt(195.4, 46.9, 11, ctx);
  assert.strictEqual(Number.isInteger(r.x), true);
  assert.strictEqual(Number.isInteger(r.y), true);
});

test('mcSampleFor: известные поля и дефолты', () => {
  assert.strictEqual(mcSampleFor('payer_last', { type: 'text' }), 'АГАФОНОВ');
  assert.strictEqual(mcSampleFor('payer_birthdate', { type: 'cells', max: 8 }), '08051989');
  // неизвестное cells-поле → повтор '1' по max
  assert.strictEqual(mcSampleFor('unknown_x', { type: 'cells', max: 5 }), '11111');
  // неизвестное не-cells → имя поля
  assert.strictEqual(mcSampleFor('whatever', { type: 'text' }), 'whatever');
});
```

- [ ] **Step 2: Запустить тест — убедиться, что падает**

Run: `cd /root/loyalpro/frontend && node --test js/pages/medical-cert-coords-transform.test.js`
Expected: FAIL — `Cannot find module './medical-cert-coords-transform'`

- [ ] **Step 3: Реализовать модуль**

```js
// frontend/js/pages/medical-cert-coords-transform.js
// Чистые функции преобразования координат бланка PDF (pt) ↔ экран (px).
// В браузере функции глобальные; в Node экспортируются для тестов.
'use strict';

// PDF: origin внизу-слева, y растёт вверх. drawText рисует от базовой линии.
// Маркер привязываем к базовой линии: top = (H - y)*scale - fontSize*scale.
function mcPtToScreen(field, ctx) {
  const fs = (field.fontSize || 11) * ctx.scale;
  return {
    left: field.x * ctx.scale,
    top: (ctx.pageHeightPt - field.y) * ctx.scale - fs,
  };
}

// Обратное к mcPtToScreen; возвращает целые pt.
function mcScreenToPt(left, top, fontSize, ctx) {
  return {
    x: Math.round(left / ctx.scale),
    y: Math.round(ctx.pageHeightPt - (top + (fontSize || 11) * ctx.scale) / ctx.scale),
  };
}

// Образцовое содержимое для отрисовки «следа» поля.
const MC_SAMPLES = {
  cert_number: '6', correction_number: '0', report_year: '2025',
  org_name: 'ООО КЛИНИКА ЭСТЕТИЧЕСКОЙ МЕДИЦИНЫ', org_inn: '972406039200', org_kpp: '772401001',
  payer_last: 'АГАФОНОВ', payer_first: 'АРТЕМ', payer_middle: 'ЭДУАРДОВИЧ',
  payer_inn: '583605353756', payer_birthdate: '08051989',
  doc_type_code: '21', doc_serie_number: '5608852813', doc_issue_date: '02062009',
  payer_is_patient: '1', amount1_rub: '82203', amount1_kop: '00',
  amount2_rub: '0', amount2_kop: '00',
  signer_last: 'ГАДЖИЕВА', signer_first: 'ПЕРИ', signer_middle: 'ИСАМУДИНОВНА',
  sign_date: '13012026', pages_count: '2',
  patient_last: 'АГАФОНОВ', patient_first: 'АРТЕМ', patient_middle: 'ЭДУАРДОВИЧ',
  patient_inn: '583605353756', patient_birthdate: '08051989',
  patient_doc_type: '21', patient_doc_serie: '5608852813', patient_doc_date: '02062009',
};

function mcSampleFor(name, field) {
  if (MC_SAMPLES[name] != null) return MC_SAMPLES[name];
  if (field && field.type === 'cells') return '1'.repeat(field.max || 4);
  return name;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { mcPtToScreen, mcScreenToPt, mcSampleFor };
}
```

- [ ] **Step 4: Запустить тесты — убедиться, что проходят**

Run: `cd /root/loyalpro/frontend && node --test js/pages/medical-cert-coords-transform.test.js`
Expected: PASS (5 тестов)

- [ ] **Step 5: Commit**

```bash
cd /root/loyalpro
git add frontend/js/pages/medical-cert-coords-transform.js frontend/js/pages/medical-cert-coords-transform.test.js
git commit -m "feat: pure pt<->screen transform helpers for coords editor

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: UI-модуль редактора (модалка, pdf.js, маркеры, drag, панель)

Логика редактора. Глобальные функции (вызовы из inline-`onclick`, как в остальном SPA). Зависит от `mcPtToScreen/mcScreenToPt/mcSampleFor` (Task 1) и хелперов `api()`, `notify()`, `esc()`.

**Files:**
- Create: `frontend/js/pages/medical-cert-coords-editor.js`

- [ ] **Step 1: Реализовать модуль**

```js
// frontend/js/pages/medical-cert-coords-editor.js
// Визуальный редактор координат бланка медсправки.
// Зависимости: api(), notify(), esc(); mcPtToScreen/mcScreenToPt/mcSampleFor (transform.js).

const MC_PDFJS_VER = '3.11.174';
const mcVE = { coords: null, baseScale: 1.5, selected: null, showGrid: false, dragging: null };

// Лениво подгрузить pdf.js (как html2pdf в staff.js).
function mcLoadPdfJs() {
  if (window.pdfjsLib) return Promise.resolve(window.pdfjsLib);
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = `https://cdn.jsdelivr.net/npm/pdfjs-dist@${MC_PDFJS_VER}/build/pdf.min.js`;
    s.onload = () => {
      window.pdfjsLib.GlobalWorkerOptions.workerSrc =
        `https://cdn.jsdelivr.net/npm/pdfjs-dist@${MC_PDFJS_VER}/build/pdf.worker.min.js`;
      resolve(window.pdfjsLib);
    };
    s.onerror = () => reject(new Error('pdfjs load failed'));
    document.head.appendChild(s);
  });
}

async function mcOpenVisualEditor() {
  let meta;
  try { meta = await api('GET', '/api/medical-cert/template'); } catch { meta = null; }
  if (!meta || !meta.url) return notify('Сначала загрузите бланк', 'err');
  try {
    mcVE.coords = await api('GET', '/api/medical-cert/template/coords');
  } catch { return notify('Не удалось загрузить координаты', 'err'); }

  document.getElementById('mc-visual-editor').style.display = 'flex';
  document.getElementById('mc-ve-pages').innerHTML = 'Загрузка бланка…';
  try {
    const pdfjsLib = await mcLoadPdfJs();
    const pdf = await pdfjsLib.getDocument(meta.url).promise;
    await mcRenderAllPages(pdf);
    mcRenderPanel();
  } catch (e) {
    mcCloseVisualEditor();
    notify('Не удалось открыть бланк (pdf.js). Используйте JSON-редактор.', 'err');
  }
}

function mcCloseVisualEditor() {
  document.getElementById('mc-visual-editor').style.display = 'none';
  mcVE.selected = null;
}

async function mcRenderAllPages(pdf) {
  const host = document.getElementById('mc-ve-pages');
  host.innerHTML = '';
  for (let p = 0; p < pdf.numPages; p++) {
    const page = await pdf.getPage(p + 1);
    const base = page.getViewport({ scale: 1 });
    const scale = mcVE.baseScale;
    const vp = page.getViewport({ scale });

    const wrap = document.createElement('div');
    wrap.className = 'mc-ve-page';
    wrap.style.width = vp.width + 'px';
    wrap.style.height = vp.height + 'px';

    const canvas = document.createElement('canvas');
    canvas.width = vp.width; canvas.height = vp.height;
    wrap.appendChild(canvas);
    await page.render({ canvasContext: canvas.getContext('2d'), viewport: vp }).promise;

    const ctx = { scale, pageHeightPt: base.height };
    if (mcVE.showGrid) mcDrawGrid(wrap, ctx, base);
    mcBuildMarkers(p, wrap, ctx);
    host.appendChild(wrap);
  }
}

function mcDrawGrid(wrap, ctx, base) {
  for (let yPt = 0; yPt <= base.height; yPt += 50) {
    const line = document.createElement('div');
    line.className = 'mc-ve-grid-h';
    line.style.top = ((base.height - yPt) * ctx.scale) + 'px';
    const lbl = document.createElement('span'); lbl_set(lbl, yPt); line.appendChild(lbl);
    wrap.appendChild(line);
  }
  for (let xPt = 0; xPt <= base.width; xPt += 50) {
    const line = document.createElement('div');
    line.className = 'mc-ve-grid-v';
    line.style.left = (xPt * ctx.scale) + 'px';
    wrap.appendChild(line);
  }
  function lbl_set(el, v) { el.textContent = v; el.className = 'mc-ve-grid-lbl'; }
}

function mcBuildMarkers(pageIndex, wrap, ctx) {
  for (const [name, f] of Object.entries(mcVE.coords.fields || {})) {
    if ((f.page || 0) !== pageIndex) continue;
    const m = document.createElement('div');
    m.className = 'mc-ve-marker';
    m.tabIndex = 0;
    m.dataset.field = name;
    m.title = name;
    m.style.fontSize = ((f.fontSize || 11) * ctx.scale) + 'px';
    mcPositionMarker(m, f, ctx);
    mcFillMarker(m, name, f, ctx);

    m.addEventListener('pointerdown', (ev) => mcMarkerDown(ev, m, f, ctx));
    m.addEventListener('keydown', (ev) => mcMarkerKey(ev, m, f, ctx));
    m.addEventListener('click', () => mcSelect(name));
    wrap.appendChild(m);
  }
}

function mcPositionMarker(m, f, ctx) {
  const pos = mcPtToScreen(f, ctx);
  m.style.left = pos.left + 'px';
  m.style.top = pos.top + 'px';
}

function mcFillMarker(m, name, f, ctx) {
  m.innerHTML = '';
  const sample = mcSampleFor(name, f);
  if (f.type === 'cells') {
    const n = f.max || sample.length || 4;
    for (let i = 0; i < n; i++) {
      const c = document.createElement('span');
      c.className = 'mc-ve-cell';
      c.textContent = sample[i] || '·';
      c.style.left = (i * (f.step || 12) * ctx.scale) + 'px';
      m.appendChild(c);
    }
  } else if (f.type === 'checkbox') {
    m.textContent = sample || '1';
  } else {
    m.textContent = sample;
    if (f.width) m.style.maxWidth = (f.width * ctx.scale) + 'px';
  }
}

function mcMarkerDown(ev, m, f, ctx) {
  ev.preventDefault();
  mcSelect(m.dataset.field);
  const startX = ev.clientX, startY = ev.clientY;
  const origLeft = parseFloat(m.style.left), origTop = parseFloat(m.style.top);
  function move(e) {
    const nl = origLeft + (e.clientX - startX);
    const nt = origTop + (e.clientY - startY);
    m.style.left = nl + 'px'; m.style.top = nt + 'px';
    const pt = mcScreenToPt(nl, nt, f.fontSize, ctx);
    f.x = pt.x; f.y = pt.y;
    mcSyncPanel();
  }
  function up() { document.removeEventListener('pointermove', move); document.removeEventListener('pointerup', up); }
  document.addEventListener('pointermove', move);
  document.addEventListener('pointerup', up);
}

function mcMarkerKey(ev, m, f, ctx) {
  const d = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, 1], ArrowDown: [0, -1] }[ev.key];
  if (!d) return;
  ev.preventDefault();
  f.x += d[0]; f.y += d[1];
  mcPositionMarker(m, f, ctx);
  mcSyncPanel();
}

function mcSelect(name) {
  mcVE.selected = name;
  document.querySelectorAll('.mc-ve-marker').forEach(el =>
    el.classList.toggle('sel', el.dataset.field === name));
  mcRenderPanel();
}

const MC_PANEL_FIELDS = ['x', 'y', 'step', 'fontSize', 'width', 'max', 'align', 'anchorRight'];

function mcRenderPanel() {
  const panel = document.getElementById('mc-ve-panel');
  if (!mcVE.selected) { panel.innerHTML = '<div style="color:#9ca3af">Выберите поле на бланке</div>'; return; }
  const f = mcVE.coords.fields[mcVE.selected];
  let html = `<div style="font-weight:600;margin-bottom:8px">${esc(mcVE.selected)}</div>
    <div style="font-size:12px;color:#9ca3af;margin-bottom:8px">стр. ${(f.page || 0) + 1}, тип ${esc(f.type)}</div>`;
  for (const k of MC_PANEL_FIELDS) {
    const val = f[k] == null ? '' : f[k];
    html += `<div class="fg" style="margin-bottom:6px"><label class="fl">${k}</label>
      <input id="mc-ve-in-${k}" value="${esc(String(val))}" oninput="mcPanelEdit('${k}')"></div>`;
  }
  panel.innerHTML = html;
}

// Обновить только значения инпутов (без перерисовки структуры) — при drag/клавишах.
function mcSyncPanel() {
  if (!mcVE.selected) return;
  const f = mcVE.coords.fields[mcVE.selected];
  for (const k of ['x', 'y']) {
    const el = document.getElementById('mc-ve-in-' + k);
    if (el) el.value = f[k] == null ? '' : f[k];
  }
}

function mcPanelEdit(k) {
  const f = mcVE.coords.fields[mcVE.selected];
  const raw = document.getElementById('mc-ve-in-' + k).value.trim();
  if (k === 'align') { f.align = raw || undefined; }
  else if (raw === '') { delete f[k]; }
  else { const n = Number(raw); f[k] = Number.isFinite(n) ? n : raw; }
  // Перерисовать маркер выбранного поля
  const m = document.querySelector(`.mc-ve-marker[data-field="${CSS.escape(mcVE.selected)}"]`);
  if (m) {
    const wrap = m.closest('.mc-ve-page');
    const scale = mcVE.baseScale;
    // pageHeightPt вычисляем из высоты wrap (px) и scale
    const ctx = { scale, pageHeightPt: wrap.clientHeight / scale };
    m.style.fontSize = ((f.fontSize || 11) * scale) + 'px';
    mcPositionMarker(m, f, ctx);
    mcFillMarker(m, mcVE.selected, f, ctx);
  }
}

async function mcToggleGrid() {
  mcVE.showGrid = !mcVE.showGrid;
  // Перерендер: проще переоткрыть страницы. Перезагружаем PDF из meta.
  let meta; try { meta = await api('GET', '/api/medical-cert/template'); } catch { meta = null; }
  if (!meta || !meta.url) return;
  const pdf = await window.pdfjsLib.getDocument(meta.url).promise;
  await mcRenderAllPages(pdf);
  if (mcVE.selected) mcSelect(mcVE.selected);
}

async function mcSaveVisualCoords() {
  try {
    await api('PUT', '/api/medical-cert/template/coords', mcVE.coords);
    notify('Координаты сохранены');
    mcCloseVisualEditor();
  } catch (e) { notify('Ошибка сохранения: ' + e.message, 'err'); }
}
```

- [ ] **Step 2: Проверить синтаксис JS**

Run: `cd /root/loyalpro && node --check frontend/js/pages/medical-cert-coords-editor.js && echo "syntax ok"`
Expected: `syntax ok`

- [ ] **Step 3: Commit**

```bash
cd /root/loyalpro
git add frontend/js/pages/medical-cert-coords-editor.js
git commit -m "feat: visual coords editor module (pdf.js render, drag markers, panel)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Разметка модалки, CSS, кнопка и подключение скриптов

**Files:**
- Modify: `frontend/index.html`
- Modify: `frontend/js/pages/medical-cert.js`

- [ ] **Step 1: Добавить CSS редактора в index.html**

Найти существующий блок `<style>` (внутри `<head>`). В конец его содержимого (перед `</style>`) добавить:

```css
#mc-visual-editor { display:none; position:fixed; inset:0; background:rgba(0,0,0,.5); z-index:1100; }
#mc-visual-editor .mc-ve-shell { position:absolute; inset:24px; background:#fff; border-radius:12px; display:flex; flex-direction:column; overflow:hidden; }
#mc-visual-editor .mc-ve-head { display:flex; gap:8px; align-items:center; padding:10px 14px; border-bottom:1px solid #e5e7eb; }
#mc-visual-editor .mc-ve-body { flex:1; display:flex; min-height:0; }
#mc-ve-pages { flex:1; overflow:auto; background:#94a3b8; padding:16px; display:flex; flex-direction:column; gap:16px; align-items:center; }
#mc-ve-panel { width:240px; border-left:1px solid #e5e7eb; padding:12px; overflow:auto; }
.mc-ve-page { position:relative; background:#fff; box-shadow:0 2px 8px rgba(0,0,0,.3); }
.mc-ve-page canvas { display:block; }
.mc-ve-marker { position:absolute; color:#1d4ed8; line-height:1; white-space:nowrap; cursor:move; outline:none; user-select:none; }
.mc-ve-marker.sel { background:rgba(29,78,216,.15); box-shadow:0 0 0 1px #1d4ed8; }
.mc-ve-marker:focus { box-shadow:0 0 0 2px #f59e0b; }
.mc-ve-cell { position:absolute; top:0; }
.mc-ve-grid-h { position:absolute; left:0; right:0; height:1px; background:rgba(220,38,38,.35); }
.mc-ve-grid-v { position:absolute; top:0; bottom:0; width:1px; background:rgba(220,38,38,.2); }
.mc-ve-grid-lbl { position:absolute; left:2px; top:-10px; font-size:9px; color:#dc2626; }
```

- [ ] **Step 2: Добавить разметку модалки в index.html**

Найти секцию `<div class="page" id="page-medical-cert">` и её закрывающий `</div>` (страница оканчивается перед `<div class="page" id="page-users">`). Сразу ПОСЛЕ закрывающего `</div>` страницы `page-medical-cert` (то есть как сосед страницы, не внутри) вставить:

```html
<div id="mc-visual-editor">
  <div class="mc-ve-shell">
    <div class="mc-ve-head">
      <strong>Редактор координат</strong>
      <button class="btn" onclick="mcToggleGrid()">Сетка</button>
      <button class="btn btn-primary" onclick="mcSaveVisualCoords()" style="margin-left:auto">Сохранить</button>
      <button class="btn" onclick="mcCloseVisualEditor()">Отмена</button>
    </div>
    <div class="mc-ve-body">
      <div id="mc-ve-pages"></div>
      <div id="mc-ve-panel"></div>
    </div>
  </div>
</div>
```

- [ ] **Step 3: Добавить визуальную кнопку в блок «Шаблон бланка»**

В index.html в секции `#page-medical-cert`, в карточке «Шаблон бланка», найти строку:

```html
    <button class="btn" onclick="mcOpenCoordsEditor()">Редактор координат</button>
```

Заменить её на две кнопки:

```html
    <button class="btn btn-primary" onclick="mcOpenVisualEditor()">Редактор координат (визуальный)</button>
    <button class="btn" onclick="mcOpenCoordsEditor()">Редактор JSON</button>
```

- [ ] **Step 4: Подключить скрипты в index.html**

Найти строку `<script src="js/pages/medical-cert.js"></script>` и сразу ПОСЛЕ неё добавить (порядок важен: transform до editor):

```html
<script src="js/pages/medical-cert-coords-transform.js"></script>
<script src="js/pages/medical-cert-coords-editor.js"></script>
```

- [ ] **Step 5: Проверить синтаксис изменённого medical-cert.js (он не менялся логически, но проверим, что файл цел)**

Run: `cd /root/loyalpro && node --check frontend/js/pages/medical-cert.js && echo "ok"`
Expected: `ok`

- [ ] **Step 6: Проверить, что сервер отдаёт новые ассеты**

Run: `pm2 restart loyalpro >/dev/null 2>&1; sleep 1; for f in medical-cert-coords-transform.js medical-cert-coords-editor.js; do curl -s -o /dev/null -w "%{http_code} $f\n" "http://localhost:3001/js/pages/$f"; done`
Expected: `200 medical-cert-coords-transform.js` и `200 medical-cert-coords-editor.js`

Run: `curl -s http://localhost:3001/ | grep -c "medical-cert-coords-editor.js"`
Expected: `1`

- [ ] **Step 7: Commit**

```bash
cd /root/loyalpro
git add frontend/index.html
git commit -m "feat: wire visual coords editor modal, css, button and scripts

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Smoke-проверка в браузере (Playwright/ручная)

Автотестов на pdf.js-рендер не делаем (требует реального бланка + DOM). Проверяем вручную через MCP Playwright по запущенному dev (`http://localhost:3001`).

> **Note:** Требуется логин под owner/admin и загруженный активный бланк. Если бланк не загружен — сначала загрузить PDF через «Загрузить новый бланк».

- [ ] **Step 1: Открыть приложение, залогиниться, перейти на вкладку «Справки»**

Через `mcp__playwright__browser_navigate` на `http://localhost:3001`, авторизоваться, кликнуть пункт меню «Справки».

- [ ] **Step 2: Открыть визуальный редактор**

Нажать «Редактор координат (визуальный)». Ожидание: модалка `#mc-visual-editor` видна, бланк отрендерен в `<canvas>`, видны маркеры `.mc-ve-marker`.

Проверка наличия маркеров (browser_evaluate): `document.querySelectorAll('.mc-ve-marker').length > 0` → `true`.

- [ ] **Step 3: Проверить выбор и панель**

Кликнуть по маркеру → у него класс `sel`, в `#mc-ve-panel` появились инпуты `x`,`y`,`step`,…

- [ ] **Step 4: Проверить drag и сохранение**

Перетащить маркер (или изменить `x` в панели) → значение в БД меняется после «Сохранить». Проверка: после «Сохранить» — `notify` «Координаты сохранены», затем `GET /api/medical-cert/template/coords` (через сеть/в БД через `mcp__postgres__query` к `medical_cert_coords`) отражает новое значение.

- [ ] **Step 5: Зафиксировать результат**

Если всё работает — ничего коммитить не нужно (код уже закоммичен в Task 1-3). Зафиксировать вывод проверки в отчёте.

---

## Self-Review

**Spec coverage:**
- Переиспользование эндпоинтов без изменений бэка → Task 2 (`mcOpenVisualEditor`, `mcSaveVisualCoords`). ✓
- pdf.js с CDN лениво → Task 2 (`mcLoadPdfJs`). ✓
- Transform pt↔px с инверсией Y и baseline → Task 1 (`mcPtToScreen/mcScreenToPt`) + тесты round-trip. ✓
- Маркеры с реальным следом (cells/text/checkbox) → Task 2 (`mcFillMarker`, `mcSampleFor`). ✓
- Drag + доводка стрелками ±1pt → Task 2 (`mcMarkerDown`, `mcMarkerKey`). ✓
- Боковая панель (x,y,step,fontSize,width,max,align,anchorRight) → Task 2 (`mcRenderPanel`, `mcPanelEdit`). ✓
- Полноэкранная модалка по паттерну staff-profile-modal + JSON fallback остаётся → Task 3. ✓
- Тумблер «Сетка» → Task 2 (`mcToggleGrid`, `mcDrawGrid`) + Task 3 (кнопка). ✓
- Граничные: нет бланка / pdf.js не загрузился / поле без page → Task 2 (ранние выходы, `f.page||0`). ✓
- Тестирование: юнит transform (Task 1), smoke в браузере (Task 4). ✓

**Placeholder scan:** код приведён полностью в каждом шаге. «Note» в Task 4 — условие окружения (логин/бланк), не плейсхолдер логики.

**Type consistency:** `mcPtToScreen(field,ctx)`, `mcScreenToPt(left,top,fontSize,ctx)`, `mcSampleFor(name,field)` определены в Task 1 и вызываются в Task 2 с теми же сигнатурами. Объект `ctx={scale,pageHeightPt}` единообразен. Имена DOM-id (`mc-visual-editor`, `mc-ve-pages`, `mc-ve-panel`, `mc-ve-in-<k>`) согласованы между Task 2 (JS) и Task 3 (HTML/CSS). `mcVE.baseScale` используется в рендере и в `mcPanelEdit`.

**Открытые подтверждения при исполнении:**
- Task 3: точные строки в index.html (кнопка `mcOpenCoordsEditor`, скрипт `medical-cert.js`, блок `<style>`, граница страницы `page-medical-cert`) — сверить при редактировании (Read перед Edit).
- Task 2: версия `pdfjs-dist@3.11.174` — при недоступности зафиксировать другую стабильную с того же CDN.
