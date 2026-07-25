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

async function loadAgentServices() {
  try {
    _asData = await api('GET', '/api/agent/services');
    const r = await api('GET', '/api/agent/service-rules');
    _asRules = r.rules || [];
    renderAgentServices();
  } catch (e) { console.error('agent-services:', e); notify('Ошибка загрузки услуг', 'err'); }
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
}
