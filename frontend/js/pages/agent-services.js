'use strict';
// ── Экран «Услуги агента»: режим фильтра + видимость услуг/пар (owner/admin) ──
const _asEsc = (s) => String(s ?? '').replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let _asData = { serviceMode: 'all', services: [] };
let _asRules = [];

async function loadAgentServices() {
  try {
    _asData = await api('GET', '/api/agent/services');
    const r = await api('GET', '/api/agent/service-rules');
    _asRules = r.rules || [];
    renderAgentServices();
  } catch (e) { console.error('agent-services:', e); notify('Ошибка загрузки услуг', 'err'); }
}

function _hasWholeDeny(svcId) {
  return _asRules.some(x => String(x.yc_service_id) === String(svcId)
    && x.yc_staff_id == null && x.rule_type === 'deny');
}
function _hasWholeAllow(svcId) {
  return _asRules.some(x => String(x.yc_service_id) === String(svcId)
    && x.yc_staff_id == null && x.rule_type === 'allow');
}

async function _setMode(mode) {
  try { await api('PUT', '/api/agent/service-settings', { serviceMode: mode }); await loadAgentServices(); }
  catch (e) { notify('Не удалось сменить режим', 'err'); }
}

// Тумблер видимости услуги целиком: в all-режиме создаём/снимаем deny,
// в allowlist-режиме — allow.
async function _toggleService(svcId, wantVisible) {
  const mode = _asData.serviceMode;
  try {
    if (mode === 'all') {
      if (wantVisible) { await _removeRuleFor(svcId, null, 'deny'); }
      else { await api('POST', '/api/agent/service-rules', { ycServiceId: svcId, ruleType: 'deny' }); }
    } else {
      if (wantVisible) { await api('POST', '/api/agent/service-rules', { ycServiceId: svcId, ruleType: 'allow' }); }
      else { await _removeRuleFor(svcId, null, 'allow'); }
    }
    await loadAgentServices();
  } catch (e) { notify('Не удалось изменить видимость', 'err'); }
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
  const rows = _asData.services.map(s => {
    const price = s.price_max ? `${s.price_min}–${s.price_max} ₽` : '';
    const staff = (s.staff || []).map(st =>
      `<label class="as-pair"><input type="checkbox" data-svc="${s.yc_id}" data-staff="${st.yc_id}" class="as-pair-cb" ${st.hidden ? '' : 'checked'}> ${_asEsc(st.name)}</label>`).join(' ');
    return `<div class="as-svc">
      <label class="as-svc-head"><input type="checkbox" class="as-svc-cb" data-svc="${s.yc_id}" ${s.visible ? 'checked' : ''}>
        <b>${_asEsc(s.title)}</b> <span class="muted">${price}</span></label>
      <div class="as-staff">${staff || '<span class="muted">нет мастеров</span>'}</div>
    </div>`;
  }).join('');
  root.innerHTML = `
    <div class="stg-section">
      <div class="fg"><div class="fl">Режим</div>${modeRadios}</div>
      <p class="muted">Отмеченная услуга видна агенту. Снимите галочку у мастера, чтобы скрыть ошибочную пару услуга×мастер.
        Описание «кто что делает» добавьте статьёй в Базе знаний.</p>
    </div>
    <div class="as-list">${rows || '<p class="muted">Нет активных услуг (или YClients не подключён).</p>'}</div>`;
  root.querySelectorAll('input[name="as-mode"]').forEach(r =>
    r.onchange = () => _setMode(r.value));
  root.querySelectorAll('.as-svc-cb').forEach(cb =>
    cb.onchange = () => _toggleService(cb.dataset.svc, cb.checked));
  root.querySelectorAll('.as-pair-cb').forEach(cb =>
    cb.onchange = () => _togglePair(cb.dataset.svc, cb.dataset.staff, !cb.checked));
}
