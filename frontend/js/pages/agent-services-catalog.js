'use strict';
// ── Экран «Услуги агента»: режим фильтра + видимость услуг/пар (owner/admin) ──
const _asEsc = (s) => String(s ?? '').replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let _asData = { serviceMode: 'all', services: [] };
let _asRules = [];
let _asShowAll = false;   // false → только active + уже настроенные; true → весь каталог

async function loadAgentServices() {
  try {
    _asData = await api('GET', '/api/agent/services');
    const r = await api('GET', '/api/agent/service-rules');
    _asRules = r.rules || [];
    renderAgentServices();
  } catch (e) { console.error('agent-services:', e); notify('Ошибка загрузки услуг', 'err'); }
}

// Есть ли у услуги хоть какое-то правило (услуга целиком или пара) — по нему
// решаем, показывать ли настроенную неактивную услугу в свёрнутом виде.
function _hasAnyRuleForSvc(svcId) {
  return _asRules.some(x => String(x.yc_service_id) === String(svcId));
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
  const svc = (_asData.services || []).find(x => String(x.yc_id) === String(svcId));
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

function renderAgentServices() {
  const root = document.getElementById('agent-services-root');
  if (!root) return;
  const mode = _asData.serviceMode;
  const modeRadios = ['all', 'allowlist'].map(m =>
    `<label><input type="radio" name="as-mode" value="${m}" ${m === mode ? 'checked' : ''}> ${m === 'all' ? 'Всё, кроме скрытого' : 'Только разрешённые'}</label>`).join(' ');
  const all = _asData.services || [];
  // По умолчанию не вываливаем весь каталог: показываем услуги из онлайн-записи
  // (active) и те, что уже настроены правилами. Остальное — под «весь каталог».
  const shown = _asShowAll ? all : all.filter(s => s.active || _hasAnyRuleForSvc(s.yc_id));
  const hiddenCount = all.length - shown.length;
  const rows = shown.map(s => {
    const price = s.price_max ? `${s.price_min}–${s.price_max} ₽` : '';
    const inactive = s.active ? '' : ' <span class="muted" title="Услуга не выставлена в онлайн-запись YClients">(не в онлайн-записи)</span>';
    const staff = (s.staff || []).map(st =>
      `<label class="as-pair"><input type="checkbox" data-svc="${s.yc_id}" data-staff="${st.yc_id}" class="as-pair-cb" ${st.hidden ? '' : 'checked'}> ${_asEsc(st.name)}</label>`).join(' ');
    return `<div class="as-svc">
      <label class="as-svc-head"><input type="checkbox" class="as-svc-cb" data-svc="${s.yc_id}" ${s.visible ? 'checked' : ''}>
        <b>${_asEsc(s.title)}</b> <span class="muted">${price}</span>${inactive}</label>
      <div class="as-staff">${staff || '<span class="muted">нет мастеров</span>'}</div>
    </div>`;
  }).join('');
  root.innerHTML = `
    <div class="stg-section active">
      <div class="fg"><div class="fl">Режим</div>${modeRadios}</div>
      <label class="as-showall" style="display:block;margin:8px 0">
        <input type="checkbox" id="as-showall-cb" ${_asShowAll ? 'checked' : ''}>
        Показать весь каталог${hiddenCount > 0 ? ` <span class="muted">(+${hiddenCount} скрыто)</span>` : ''}</label>
      <p class="muted">Отмеченная услуга видна агенту. Услуги «не в онлайн-записи» по умолчанию скрыты —
        включите нужные вручную. Снимите галочку у мастера, чтобы скрыть ошибочную пару услуга×мастер.
        Описание «кто что делает» добавьте статьёй в Базе знаний.</p>
    </div>
    <div class="as-list">${rows || '<p class="muted">Нет услуг с ценой (или YClients не подключён).</p>'}</div>`;
  const showAllCb = root.querySelector('#as-showall-cb');
  if (showAllCb) showAllCb.onchange = () => { _asShowAll = showAllCb.checked; renderAgentServices(); };
  root.querySelectorAll('input[name="as-mode"]').forEach(r =>
    r.onchange = () => _setMode(r.value));
  root.querySelectorAll('.as-svc-cb').forEach(cb =>
    cb.onchange = () => _toggleService(cb.dataset.svc, cb.checked));
  root.querySelectorAll('.as-pair-cb').forEach(cb =>
    cb.onchange = () => _togglePair(cb.dataset.svc, cb.dataset.staff, !cb.checked));
}
