'use strict';
// ── Экран «Услуги агента»: дерево категория → услуга → мастера (owner/admin) ──
// Данные: GET /api/agent/services отдаёт { serviceMode, categories:[{id,title,
// services:[{yc_id,title,price_min,price_max,active,visible,staff:[{yc_id,name,hidden}]}]}] }.
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

// Плоский поиск услуги по всем категориям (нужен active для тумблера).
function _findSvc(svcId) {
  for (const c of (_asData.categories || [])) {
    const s = c.services.find(x => String(x.yc_id) === String(svcId));
    if (s) return s;
  }
  return null;
}

// Услуги категории, видимые при текущем showAll-режиме.
function _shownServices(cat) {
  if (_asShowAll) return cat.services;
  return cat.services.filter(s => s.active || _hasAnyRuleForSvc(s.yc_id));
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

// Массовый тумблер категории — одним запросом на бэкенд.
async function _toggleCategory(cat, wantVisible) {
  const items = _shownServices(cat).map(s => ({
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

function _price(s) {
  if (!(Number(s.price_max) > 0)) return '';
  return String(s.price_min) === String(s.price_max)
    ? `${s.price_min} ₽` : `${s.price_min}–${s.price_max} ₽`;
}

function _svcRow(s) {
  const inactive = s.active ? '' :
    ' <span class="muted" title="Услуга не выставлена в онлайн-запись YClients">(не в онлайн-записи)</span>';
  const staff = (s.staff || []).map(st =>
    `<label class="as-pair"><input type="checkbox" data-svc="${s.yc_id}" data-staff="${st.yc_id}" class="as-pair-cb" ${st.hidden ? '' : 'checked'}> ${_asEsc(st.name)}</label>`).join('');
  return `<div class="as-svc">
    <label class="as-svc-head"><input type="checkbox" class="as-svc-cb" data-svc="${s.yc_id}" ${s.visible ? 'checked' : ''}>
      <b>${_asEsc(s.title)}</b> <span class="muted as-price">${_price(s)}</span>${inactive}</label>
    <div class="as-staff">${staff || '<span class="muted">нет привязанных мастеров</span>'}</div>
  </div>`;
}

function renderAgentServices() {
  const root = document.getElementById('agent-services-root');
  if (!root) return;
  const mode = _asData.serviceMode;
  const cats = _asData.categories || [];
  const modeRadios = ['all', 'allowlist'].map(m =>
    `<label class="as-radio"><input type="radio" name="as-mode" value="${m}" ${m === mode ? 'checked' : ''}> ${m === 'all' ? 'Всё, кроме скрытого' : 'Только разрешённые'}</label>`).join(' ');

  // Сколько услуг скрыто под showAll (неактивные без правил).
  let hiddenCount = 0;
  for (const c of cats) hiddenCount += c.services.length - _shownServices(c).length;

  // Категории с учётом showAll (пустые прячем).
  const visCats = cats.map(c => ({ cat: c, shown: _shownServices(c) })).filter(x => x.shown.length);

  const catHtml = visCats.map(({ cat, shown }) => {
    const open = _asOpenCats.has(String(cat.id));
    const vis = shown.filter(s => s.visible).length;
    const rows = open ? shown.map(_svcRow).join('') : '';
    return `<div class="as-cat" data-cat="${cat.id}">
      <div class="as-cat-head">
        <input type="checkbox" class="as-cat-cb" data-cat="${cat.id}">
        <button type="button" class="as-cat-toggle" data-cat="${cat.id}">
          <span class="as-caret">${open ? '▾' : '▸'}</span>
          <span class="as-cat-title">${_asEsc(cat.title)}</span>
          <span class="muted as-cat-count">${vis}/${shown.length}</span>
        </button>
      </div>
      <div class="as-cat-body" ${open ? '' : 'hidden'}>${rows}</div>
    </div>`;
  }).join('');

  root.innerHTML = `
    <div class="stg-section active">
      <div class="fg"><div class="fl">Режим</div><div class="as-radios">${modeRadios}</div></div>
      <label class="as-showall">
        <input type="checkbox" id="as-showall-cb" ${_asShowAll ? 'checked' : ''}>
        Показать весь каталог${hiddenCount > 0 ? ` <span class="muted">(+${hiddenCount} скрыто)</span>` : ''}</label>
      <p class="muted">Отмеченная услуга видна агенту. Чекбокс категории показывает/скрывает все услуги
        внутри сразу. Услуги «не в онлайн-записи» по умолчанию скрыты — включите нужные вручную.
        Снимите галочку у мастера, чтобы скрыть ошибочную пару услуга×мастер.</p>
    </div>
    <div class="as-cats">${catHtml || '<p class="muted">Нет услуг с ценой (или YClients не подключён).</p>'}</div>`;

  // Tri-state чекбоксы категорий (indeterminate ставится только из JS).
  visCats.forEach(({ cat, shown }) => {
    const cb = root.querySelector(`.as-cat-cb[data-cat="${cat.id}"]`);
    if (!cb) return;
    const vis = shown.filter(s => s.visible).length;
    cb.checked = vis === shown.length;
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
}
