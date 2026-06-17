// frontend/js/pages/medical-cert-coords-editor.js
// Визуальный редактор координат бланка медсправки.
// Зависимости: api(), notify(), esc(); mcPtToScreen/mcScreenToPt/mcSampleFor (transform.js).

const mcVE = { coords: null, baseScale: 1.5, selected: null, showGrid: false, dragging: null };

// Лениво подгрузить вендоренный pdf.js (same-origin — CSP connect-src 'self' ок,
// без зависимости от CDN; worker тоже локальный).
function mcLoadPdfJs() {
  if (window.pdfjsLib) return Promise.resolve(window.pdfjsLib);
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = '/js/vendor/pdfjs/pdf.min.js';
    s.onload = () => {
      window.pdfjsLib.GlobalWorkerOptions.workerSrc = '/js/vendor/pdfjs/pdf.worker.min.js';
      resolve(window.pdfjsLib);
    };
    s.onerror = () => reject(new Error('pdfjs load failed'));
    document.head.appendChild(s);
  });
}

// Скачать байты активного бланка с того же origin (прокси-роут бэка).
async function mcFetchBlankBytes() {
  const resp = await fetch('/api/medical-cert/template/blank', {
    headers: { 'Authorization': 'Bearer ' + localStorage.getItem('lp_tk') },
  });
  if (!resp.ok) throw new Error((await resp.json().catch(() => ({}))).error || resp.status);
  return await resp.arrayBuffer();
}

async function mcOpenVisualEditor() {
  try {
    mcVE.coords = await api('GET', '/api/medical-cert/template/coords');
  } catch { return notify('Не удалось загрузить координаты', 'err'); }

  document.getElementById('mc-visual-editor').style.display = 'flex';
  document.getElementById('mc-ve-pages').innerHTML = 'Загрузка бланка…';
  try {
    const pdfjsLib = await mcLoadPdfJs();
    const bytes = await mcFetchBlankBytes();
    const pdf = await pdfjsLib.getDocument({ data: bytes }).promise;
    await mcRenderAllPages(pdf);
    mcRenderPanel();
  } catch (e) {
    mcCloseVisualEditor();
    const msg = (e && (e.message === '409' || e.message === 'no_active_template'))
      ? 'Сначала загрузите бланк'
      : 'Не удалось открыть бланк (pdf.js). Используйте JSON-редактор.';
    notify(msg, 'err');
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
    const lbl = document.createElement('span'); lbl.textContent = yPt; lbl.className = 'mc-ve-grid-lbl';
    line.appendChild(lbl);
    wrap.appendChild(line);
  }
  for (let xPt = 0; xPt <= base.width; xPt += 50) {
    const line = document.createElement('div');
    line.className = 'mc-ve-grid-v';
    line.style.left = (xPt * ctx.scale) + 'px';
    wrap.appendChild(line);
  }
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
    const ctx = { scale, pageHeightPt: wrap.clientHeight / scale };
    m.style.fontSize = ((f.fontSize || 11) * scale) + 'px';
    mcPositionMarker(m, f, ctx);
    mcFillMarker(m, mcVE.selected, f, ctx);
  }
}

async function mcToggleGrid() {
  mcVE.showGrid = !mcVE.showGrid;
  try {
    const bytes = await mcFetchBlankBytes();
    const pdf = await window.pdfjsLib.getDocument({ data: bytes }).promise;
    await mcRenderAllPages(pdf);
    if (mcVE.selected) mcSelect(mcVE.selected);
  } catch (e) { notify('Не удалось перерисовать бланк', 'err'); }
}

async function mcSaveVisualCoords() {
  try {
    await api('PUT', '/api/medical-cert/template/coords', mcVE.coords);
    notify('Координаты сохранены');
    mcCloseVisualEditor();
  } catch (e) { notify('Ошибка сохранения: ' + e.message, 'err'); }
}
