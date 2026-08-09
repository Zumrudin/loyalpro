'use strict';
// ── Экран «Услуги агента»: дерево категория → подкатегории → услуга → мастера ──
// Данные: GET /api/agent/services отдаёт { serviceMode, categories:[{ id, title,
//   services:[{yc_id,title,price_min,price_max,active,visible,subcategory_id,
//              staff:[{yc_id,name,hidden}]}],
//   subcategories:[{ id, title, subcategory:true, services:[...], subcategories:[...] }] }] }.
// Дерево рекурсивное: у категории и у каждой подкатегории есть свои services + subcategories.
const _asEsc = (s) => String(s ?? '').replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let _asData = { serviceMode: 'all', categories: [] };
let _asRules = [];
let _asShowAll = false;             // false → active + настроенные; true → весь каталог
const _asOpenCats = new Set();      // id раскрытых категорий (по умолчанию свёрнуты)
let _asPhotos = [];                 // фото прайса всех узлов салона
let _asPriceUrl = '';               // ссылка на прайс на сайте
let _asSettings = {};               // ПОЛНЫЙ ответ GET /api/agent/settings — PUT сохраняет его же
                                     // целиком с точечной правкой priceListUrl: PUT /settings трактует
                                     // отсутствие enabled/mode как false/'all' (см. agent-settings.js),
                                     // и отправка одного priceListUrl молча выключила бы агента.
let _asPriceNode = null;            // открытый в модалке узел { kind:'cat'|'sub', id, title }

async function loadAgentServices() {
  try {
    _asData = await api('GET', '/api/agent/services');
    const r = await api('GET', '/api/agent/service-rules');
    _asRules = r.rules || [];
    const ph = await api('GET', '/api/agent/price-photos');
    _asPhotos = ph.photos || [];
    _asSettings = await api('GET', '/api/agent/settings');
    _asPriceUrl = _asSettings.priceListUrl || '';
    renderAgentServices();
  } catch (e) { console.error('agent-services:', e); notify('Ошибка загрузки услуг', 'err'); }
}

// Фото узла (категория или подкатегория) в порядке администратора.
function _photosOf(kind, id) {
  return _asPhotos
    .filter(p => (kind === 'cat'
      ? String(p.ycCategoryId) === String(id)
      : String(p.subcategoryId) === String(id)))
    .sort((a, b) => (a.displayOrder - b.displayOrder) || (a.id - b.id));
}

function _priceBtn(kind, id, title) {
  const n = _photosOf(kind, id).length;
  return `<button type="button" class="as-mini as-price-btn" data-kind="${kind}" data-id="${id}" data-title="${_asEsc(title)}">🖼 Прайс${n ? ` (${n})` : ''}</button>`;
}

// Есть ли у услуги хоть какое-то правило — по нему решаем, показывать ли
// настроенную неактивную услугу в свёрнутом виде.
function _hasAnyRuleForSvc(svcId) {
  return _asRules.some(x => String(x.yc_service_id) === String(svcId));
}

// ── Рекурсивные обходы дерева (услуги живут и в категории, и в подкатегориях) ──

// Все услуги поддерева узла (категория/подкатегория), без фильтра showAll.
function _allServices(node) {
  let out = (node.services || []).slice();
  for (const sc of (node.subcategories || [])) out = out.concat(_allServices(sc));
  return out;
}

// Прямые услуги узла, видимые при текущем showAll-режиме.
function _shownDirect(node) {
  const svcs = node.services || [];
  if (_asShowAll) return svcs;
  return svcs.filter(s => s.active || _hasAnyRuleForSvc(s.yc_id));
}

// Все услуги поддерева, видимые при текущем showAll (рекурсивно) — для тумблера и счётчика.
function _shownAll(node) {
  let out = _shownDirect(node);
  for (const sc of (node.subcategories || [])) out = out.concat(_shownAll(sc));
  return out;
}

// Плоский поиск услуги по всему дереву (нужен active для тумблера).
function _findSvc(svcId) {
  const dig = (node) => {
    for (const s of (node.services || [])) if (String(s.yc_id) === String(svcId)) return s;
    for (const sc of (node.subcategories || [])) { const r = dig(sc); if (r) return r; }
    return null;
  };
  for (const c of (_asData.categories || [])) { const r = dig(c); if (r) return r; }
  return null;
}

// Плоский список подкатегорий поддерева топ-категории с глубиной (для select «переместить»).
function _flattenSubcats(subcats, depth, out) {
  for (const sc of (subcats || [])) {
    out.push({ id: sc.id, title: sc.title, depth });
    _flattenSubcats(sc.subcategories, depth + 1, out);
  }
  return out;
}

async function _setMode(mode) {
  try { await api('PUT', '/api/agent/service-settings', { serviceMode: mode }); await loadAgentServices(); }
  catch (e) { notify('Не удалось сменить режим', 'err'); }
}

// Тумблер видимости услуги целиком. Логика зависит от режима и флага active:
//   allowlist — видимость = наличие allow (active не важен).
//   all + active  — по умолчанию видна: скрыть = deny, показать = снять deny.
//   all + !active — по умолчанию скрыта: показать = allow, скрыть = снять allow.
// Всегда чистим противоположное правило, чтобы deny+allow не противоречили.
async function _toggleService(svcId, wantVisible) {
  const svc = _findSvc(svcId);
  const isActive = !!(svc && svc.active);
  const mode = _asData.serviceMode;
  try {
    if (mode === 'allowlist') {
      if (wantVisible) { await _addRule(svcId, null, 'allow'); }
      else { await _removeRuleFor(svcId, null, 'allow'); }
    } else if (wantVisible) {
      await _removeRuleFor(svcId, null, 'deny');
      if (!isActive) { await _addRule(svcId, null, 'allow'); }
    } else {
      await _removeRuleFor(svcId, null, 'allow');
      if (isActive) { await _addRule(svcId, null, 'deny'); }
    }
    await loadAgentServices();
  } catch (e) { notify('Не удалось изменить видимость', 'err'); }
}

// Массовый тумблер категории — одним запросом. Услуги собираются РЕКУРСИВНО по всему поддереву.
async function _toggleCategory(cat, wantVisible) {
  const items = _shownAll(cat).map(s => ({
    ycServiceId: s.yc_id, active: s.active, wantVisible,
  }));
  if (!items.length) return;
  try {
    await api('POST', '/api/agent/service-rules/bulk-visibility', { items });
    await loadAgentServices();
  } catch (e) { notify('Не удалось изменить категорию', 'err'); }
}

async function _addRule(svcId, staffId, ruleType) {
  const body = { ycServiceId: svcId, ruleType };
  if (staffId != null) body.ycStaffId = staffId;
  await api('POST', '/api/agent/service-rules', body);
}

async function _togglePair(svcId, staffId, wantHidden) {
  try {
    if (wantHidden) { await api('POST', '/api/agent/service-rules', { ycServiceId: svcId, ycStaffId: staffId, ruleType: 'deny' }); }
    else { await _removeRuleFor(svcId, staffId, 'deny'); }
    await loadAgentServices();
  } catch (e) { notify('Не удалось изменить пару', 'err'); }
}

async function _removeRuleFor(svcId, staffId, ruleType) {
  const rule = _asRules.find(x => String(x.yc_service_id) === String(svcId)
    && String(x.yc_staff_id ?? '') === String(staffId ?? '')
    && x.rule_type === ruleType);
  if (rule) await api('DELETE', `/api/agent/service-rules/${rule.id}`);
}

// ── Подкатегории: создание / переименование / удаление; перемещение услуги ──

async function _addSubcategory(ycCategoryId, parentId) {
  const title = (prompt('Название подкатегории:') || '').trim();
  if (!title) return;
  try {
    const body = { ycCategoryId, title };
    if (parentId != null) body.parentId = parentId;
    await api('POST', '/api/agent/service-subcategories', body);
    await loadAgentServices();
  } catch (e) { notify('Не удалось создать подкатегорию', 'err'); }
}

async function _renameSubcategory(id, current) {
  const title = (prompt('Новое название подкатегории:', current) || '').trim();
  if (!title) return;
  try {
    await api('PUT', `/api/agent/service-subcategories/${id}`, { title });
    await loadAgentServices();
  } catch (e) { notify('Не удалось переименовать', 'err'); }
}

async function _removeSubcategory(id) {
  if (!confirm('Удалить подкатегорию? Услуги вернутся в родительскую категорию.')) return;
  try {
    await api('DELETE', `/api/agent/service-subcategories/${id}`);
    await loadAgentServices();
  } catch (e) { notify('Не удалось удалить подкатегорию', 'err'); }
}

async function _placeService(svcId, subcategoryId) {
  try {
    await api('POST', '/api/agent/service-placements', { ycServiceId: svcId, subcategoryId: subcategoryId || null });
    await loadAgentServices();
  } catch (e) { notify('Не удалось переместить услугу', 'err'); }
}

function _price(s) {
  const min = Number(s.price_min) || 0, max = Number(s.price_max) || 0;
  if (max > 0) {
    return String(min) === String(max) ? `${min} ₽` : `${min}–${max} ₽`;
  }
  if (min > 0) return `от ${min} ₽`;   // price_max=0 — стартовая цена без верхней границы
  return '';
}

// <select> «переместить»: все подкатегории топ-категории (с отступом по глубине) + корень.
function _moveSelect(s, subcatOptions) {
  const cur = s.subcategory_id == null ? '' : String(s.subcategory_id);
  let opts = `<option value=""${cur === '' ? ' selected' : ''}>↩︎ в корень категории</option>`;
  opts += subcatOptions.map(o => {
    const label = '— '.repeat(o.depth) + o.title;
    return `<option value="${o.id}"${String(o.id) === cur ? ' selected' : ''}>${_asEsc(label)}</option>`;
  }).join('');
  return `<select class="as-move" data-svc="${s.yc_id}">${opts}</select>`;
}

// Строка услуги (переиспользуется на всех уровнях дерева). subcatOptions — цели перемещения топ-категории.
function _svcRow(s, subcatOptions) {
  const inactive = s.active ? '' :
    ' <span class="muted" title="Услуга не выставлена в онлайн-запись YClients">(не в онлайн-записи)</span>';
  const staff = (s.staff || []).map(st =>
    `<label class="as-pair"><input type="checkbox" data-svc="${s.yc_id}" data-staff="${st.yc_id}" class="as-pair-cb" ${st.hidden ? '' : 'checked'}> ${_asEsc(st.name)}</label>`).join('');
  const move = (subcatOptions && subcatOptions.length)
    ? `<div class="as-move-wrap"><span class="muted">переместить:</span> ${_moveSelect(s, subcatOptions)}</div>`
    : '';
  return `<div class="as-svc">
    <label class="as-svc-head"><input type="checkbox" class="as-svc-cb" data-svc="${s.yc_id}" ${s.visible ? 'checked' : ''}>
      <b>${_asEsc(s.title)}</b> <span class="muted as-price">${_price(s)}</span>${inactive}</label>
    <div class="as-staff">${staff || '<span class="muted">нет привязанных мастеров</span>'}</div>
    ${move}
  </div>`;
}

// Рекурсивный рендер содержимого узла: прямые услуги (по showAll) + вложенные подкатегории.
function _renderNodeBody(node, topCatId, subcatOptions) {
  const svcHtml = _shownDirect(node).map(s => _svcRow(s, subcatOptions)).join('');
  const subHtml = (node.subcategories || []).map(sc => _renderSubcat(sc, topCatId, subcatOptions)).join('');
  return svcHtml + subHtml;
}

// Блок подкатегории: шапка (название + действия) + рекурсивное тело. Пустые подкатегории показываем.
function _renderSubcat(sc, topCatId, subcatOptions) {
  const body = _renderNodeBody(sc, topCatId, subcatOptions);
  return `<div class="as-subcat" data-subcat="${sc.id}">
    <div class="as-subcat-head">
      <span class="as-subcat-title">${_asEsc(sc.title)}</span>
      <span class="as-subcat-actions">
        ${_priceBtn('sub', sc.id, sc.title)}
        <button type="button" class="as-mini as-add-sub" data-cat="${topCatId}" data-parent="${sc.id}">＋ подкатегория</button>
        <button type="button" class="as-mini as-sub-rename" data-id="${sc.id}" data-title="${_asEsc(sc.title)}">переименовать</button>
        <button type="button" class="as-mini as-danger as-sub-del" data-id="${sc.id}">удалить</button>
      </span>
    </div>
    <div class="as-subcat-body">${body || '<span class="muted as-empty">пусто</span>'}</div>
  </div>`;
}

function renderAgentServices() {
  const root = document.getElementById('agent-services-root');
  if (!root) return;
  const mode = _asData.serviceMode;
  const cats = _asData.categories || [];
  const modeRadios = ['all', 'allowlist'].map(m =>
    `<label class="as-radio"><input type="radio" name="as-mode" value="${m}" ${m === mode ? 'checked' : ''}> ${m === 'all' ? 'Всё, кроме скрытого' : 'Только разрешённые'}</label>`).join(' ');

  // Сколько услуг скрыто под showAll (неактивные без правил) — рекурсивно по всему дереву.
  let hiddenCount = 0;
  for (const c of cats) hiddenCount += _allServices(c).length - _shownAll(c).length;

  // Категории с учётом showAll: показываем, если есть видимые услуги в поддереве ИЛИ есть подкатегории (ими надо управлять).
  const visCats = cats.map(c => ({
    cat: c,
    shown: _shownAll(c),
    hasSub: (c.subcategories || []).length > 0,
  })).filter(x => x.shown.length || x.hasSub);

  const catHtml = visCats.map(({ cat, shown }) => {
    const open = _asOpenCats.has(String(cat.id));
    const vis = shown.filter(s => s.visible).length;
    const subcatOptions = _flattenSubcats(cat.subcategories, 0, []);
    const canAddSub = cat.id != null && String(cat.id) !== 'null';
    const addBtn = canAddSub
      ? `<button type="button" class="as-mini as-add-sub as-cat-add" data-cat="${cat.id}">＋ подкатегория</button>`
      : '';
    const body = open ? _renderNodeBody(cat, cat.id, subcatOptions) : '';
    return `<div class="as-cat" data-cat="${cat.id}">
      <div class="as-cat-head">
        <input type="checkbox" class="as-cat-cb" data-cat="${cat.id}">
        <button type="button" class="as-cat-toggle" data-cat="${cat.id}">
          <span class="as-caret">${open ? '▾' : '▸'}</span>
          <span class="as-cat-title">${_asEsc(cat.title)}</span>
          <span class="muted as-cat-count">${vis}/${shown.length}</span>
        </button>
        ${canAddSub ? _priceBtn('cat', cat.id, cat.title) : ''}
        ${addBtn}
      </div>
      <div class="as-cat-body" ${open ? '' : 'hidden'}>${body}</div>
    </div>`;
  }).join('');

  root.innerHTML = `
    <div class="stg-section active">
      <div class="fg"><div class="fl">Режим</div><div class="as-radios">${modeRadios}</div></div>
      <label class="as-showall">
        <input type="checkbox" id="as-showall-cb" ${_asShowAll ? 'checked' : ''}>
        Показать весь каталог${hiddenCount > 0 ? ` <span class="muted">(+${hiddenCount} скрыто)</span>` : ''}</label>
      <div class="fg"><div class="fl">Ссылка на прайс на сайте</div>
        <input type="url" id="as-price-url" placeholder="https://…" value="${_asEsc(_asPriceUrl)}">
        <button type="button" class="btn-pri" id="as-price-url-save">Сохранить</button></div>
      <p class="muted">Отмеченная услуга видна агенту. Чекбокс категории показывает/скрывает все услуги
        внутри (включая подкатегории) сразу. Услуги «не в онлайн-записи» по умолчанию скрыты — включите нужные вручную.
        Снимите галочку у мастера, чтобы скрыть ошибочную пару услуга×мастер.
        Кнопкой «＋ подкатегория» стройте вложенное дерево; списком «переместить» кладите услугу в подкатегорию.</p>
    </div>
    <div class="as-cats">${catHtml || '<p class="muted">Нет услуг с ценой (или YClients не подключён).</p>'}</div>`;

  // Tri-state чекбоксы категорий (indeterminate ставится только из JS) — по рекурсивной сумме.
  visCats.forEach(({ cat, shown }) => {
    const cb = root.querySelector(`.as-cat-cb[data-cat="${cat.id}"]`);
    if (!cb) return;
    const vis = shown.filter(s => s.visible).length;
    cb.checked = shown.length > 0 && vis === shown.length;
    cb.indeterminate = vis > 0 && vis < shown.length;
  });

  const showAllCb = root.querySelector('#as-showall-cb');
  if (showAllCb) showAllCb.onchange = () => { _asShowAll = showAllCb.checked; renderAgentServices(); };
  root.querySelectorAll('input[name="as-mode"]').forEach(r =>
    r.onchange = () => _setMode(r.value));
  root.querySelectorAll('.as-cat-toggle').forEach(btn =>
    btn.onclick = () => {
      const id = String(btn.dataset.cat);
      if (_asOpenCats.has(id)) _asOpenCats.delete(id); else _asOpenCats.add(id);
      renderAgentServices();
    });
  root.querySelectorAll('.as-cat-cb').forEach(cb =>
    cb.onchange = () => {
      const cat = (_asData.categories || []).find(c => String(c.id) === String(cb.dataset.cat));
      if (cat) _toggleCategory(cat, cb.checked);
    });
  root.querySelectorAll('.as-svc-cb').forEach(cb =>
    cb.onchange = () => _toggleService(cb.dataset.svc, cb.checked));
  root.querySelectorAll('.as-pair-cb').forEach(cb =>
    cb.onchange = () => _togglePair(cb.dataset.svc, cb.dataset.staff, !cb.checked));
  root.querySelectorAll('.as-move').forEach(sel =>
    sel.onchange = () => _placeService(sel.dataset.svc, sel.value || null));
  root.querySelectorAll('.as-add-sub').forEach(btn =>
    btn.onclick = () => _addSubcategory(btn.dataset.cat, btn.dataset.parent || null));
  root.querySelectorAll('.as-sub-rename').forEach(btn =>
    btn.onclick = () => _renameSubcategory(btn.dataset.id, btn.dataset.title));
  root.querySelectorAll('.as-sub-del').forEach(btn =>
    btn.onclick = () => _removeSubcategory(btn.dataset.id));

  const urlSave = root.querySelector('#as-price-url-save');
  if (urlSave) urlSave.onclick = async () => {
    const v = (root.querySelector('#as-price-url').value || '').trim();
    try {
      // Шлём ВЕСЬ известный набор настроек, а не одно поле: PUT /api/agent/settings
      // трактует отсутствие enabled/mode как false/'all' (agent-settings.js) —
      // точечная отправка {priceListUrl} молча выключила бы агента и сбросила режим.
      await api('PUT', '/api/agent/settings', { ..._asSettings, priceListUrl: v });
      _asPriceUrl = v;
      _asSettings = { ..._asSettings, priceListUrl: v };
      notify('Ссылка сохранена', 'ok');
    } catch (e) { notify('Не удалось сохранить ссылку', 'err'); }
  };
  root.querySelectorAll('.as-price-btn').forEach(btn =>
    btn.onclick = () => _openPriceModal(btn.dataset.kind, btn.dataset.id, btn.dataset.title));
}

// ── Модалка «Прайс раздела»: сетка фото, загрузка, порядок, удаление ──
// Разметка создаётся из JS (на странице «Услуги агента» нет статического модального
// контейнера) по образцу существующей agent-settings-modal: обёртка .ov + .modal,
// показ/скрытие — classList('open'), а не style.display (см. frontend/js/pages/agent-settings.js).
function _priceModalEl() {
  let el = document.getElementById('as-price-modal');
  if (el) return el;
  el = document.createElement('div');
  el.id = 'as-price-modal';
  el.className = 'ov';
  el.onclick = (ev) => { if (ev.target === el) _closePriceModal(); };
  el.innerHTML = `<div class="modal">
    <div class="mh">
      <div class="mt" id="as-price-modal-title"></div>
      <button type="button" class="mc" id="as-price-close">✕</button>
    </div>
    <div id="as-price-grid" class="as-price-grid"></div>
    <div class="fg">
      <div class="fl">Добавить фото (JPEG/PNG/WebP)</div>
      <input type="file" id="as-price-file" accept="image/jpeg,image/png,image/webp" multiple>
    </div>
  </div>`;
  document.body.appendChild(el);
  el.querySelector('#as-price-close').onclick = () => _closePriceModal();
  el.querySelector('#as-price-file').onchange = (ev) => _uploadPricePhotos(ev.target.files);
  return el;
}

function _closePriceModal() {
  const el = document.getElementById('as-price-modal');
  if (el) el.classList.remove('open');
}

function _openPriceModal(kind, id, title) {
  _asPriceNode = { kind, id, title };
  const el = _priceModalEl();
  el.querySelector('#as-price-modal-title').textContent = `Прайс: ${title}`;
  _renderPriceGrid();
  el.classList.add('open');
}

function _renderPriceGrid() {
  const el = _priceModalEl();
  const grid = el.querySelector('#as-price-grid');
  const list = _photosOf(_asPriceNode.kind, _asPriceNode.id);
  grid.innerHTML = list.length ? list.map((p, i) => `
    <div class="as-price-item">
      <img src="${_asEsc(p.fileUrl)}" alt="">
      <div class="as-price-item-actions">
        <button type="button" class="as-mini as-price-up" data-id="${p.id}" ${i === 0 ? 'disabled' : ''}>↑</button>
        <button type="button" class="as-mini as-price-down" data-id="${p.id}" ${i === list.length - 1 ? 'disabled' : ''}>↓</button>
        <button type="button" class="as-mini as-danger as-price-del" data-id="${p.id}">удалить</button>
      </div>
    </div>`).join('') : '<p class="muted">Фото прайса пока нет. Если их нет и у родительского раздела, Мила отправит ссылку на сайт.</p>';
  grid.querySelectorAll('.as-price-up').forEach(b => b.onclick = () => _movePricePhoto(b.dataset.id, -1));
  grid.querySelectorAll('.as-price-down').forEach(b => b.onclick = () => _movePricePhoto(b.dataset.id, +1));
  grid.querySelectorAll('.as-price-del').forEach(b => b.onclick = () => _removePricePhoto(b.dataset.id));
}

async function _uploadPricePhotos(files) {
  for (const f of Array.from(files || [])) {
    const fd = new FormData();
    fd.append('file', f);
    if (_asPriceNode.kind === 'cat') fd.append('ycCategoryId', _asPriceNode.id);
    else fd.append('subcategoryId', _asPriceNode.id);
    try {
      const r = await fetch('/api/agent/price-photos', {
        method: 'POST',
        // Ключ токена — 'lp_tk' (как в core/api.js), не 'token'.
        headers: { Authorization: `Bearer ${localStorage.getItem('lp_tk')}` },
        body: fd,
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || 'ошибка загрузки');
    } catch (e) { notify(e.message, 'err'); break; }
  }
  await loadAgentServices();
  _renderPriceGrid();
}

async function _movePricePhoto(id, dir) {
  const list = _photosOf(_asPriceNode.kind, _asPriceNode.id);
  const i = list.findIndex(p => String(p.id) === String(id));
  const j = i + dir;
  if (i < 0 || j < 0 || j >= list.length) return;
  const reordered = list.slice();
  [reordered[i], reordered[j]] = [reordered[j], reordered[i]];
  try {
    await api('PUT', '/api/agent/price-photos/reorder',
      { items: reordered.map((p, k) => ({ id: p.id, displayOrder: k + 1 })) });
    await loadAgentServices();
    _renderPriceGrid();
  } catch (e) { notify('Не удалось изменить порядок', 'err'); }
}

async function _removePricePhoto(id) {
  if (!confirm('Удалить фото прайса?')) return;
  try {
    await api('DELETE', `/api/agent/price-photos/${id}`);
    await loadAgentServices();
    _renderPriceGrid();
  } catch (e) { notify('Не удалось удалить фото', 'err'); }
}
