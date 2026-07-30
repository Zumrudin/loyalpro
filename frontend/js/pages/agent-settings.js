'use strict';
// ── Настройки ИИ-агента (модалка на странице «Чат») — owner/admin ──
let _agentRules = { allow: [], block: [] };

const _agEsc = (s) => String(s ?? '').replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

async function openAgentSettings() {
  document.getElementById('agent-settings-modal').classList.add('open');
  try {
    const s = await api('GET', '/api/agent/settings');
    document.getElementById('agent-enabled').checked = !!s.enabled;
    document.querySelectorAll('input[name="agent-mode"]').forEach(r => {
      r.checked = r.value === (s.mode || 'all');
    });
    document.getElementById('agent-schedule-enabled').checked = !!s.scheduleEnabled;
    document.getElementById('agent-schedule-start').value = s.scheduleStart || '22:00';
    document.getElementById('agent-schedule-end').value = s.scheduleEnd || '09:30';
    agentToggleSchedule();
    document.querySelectorAll('input[name="agent-mode"]').forEach(r => {
      r.onchange = _agentToggleAllowSection;
    });
    await loadAgentRules();
  } catch (e) { console.error('agent settings:', e); notify('Ошибка загрузки настроек', 'err'); }
}

function closeAgentSettings() {
  document.getElementById('agent-settings-modal').classList.remove('open');
}

function _agentMode() {
  const r = document.querySelector('input[name="agent-mode"]:checked');
  return r ? r.value : 'all';
}

function _agentToggleAllowSection() {
  // Белый список значим в режиме whitelist, а также при включённом расписании:
  // вне окна гейт сам сужает режим до whitelist (services/agent-gate.decideGate).
  const scheduleOn = document.getElementById('agent-schedule-enabled').checked;
  const active = _agentMode() === 'whitelist' || scheduleOn;
  const sec = document.getElementById('agent-allow-section');
  sec.style.opacity = active ? '1' : '0.5';
  sec.style.pointerEvents = active ? '' : 'none';
}

function agentToggleSchedule() {
  const on = document.getElementById('agent-schedule-enabled').checked;
  const box = document.getElementById('agent-schedule-fields');
  box.style.opacity = on ? '1' : '0.5';
  box.style.pointerEvents = on ? '' : 'none';
  _agentToggleAllowSection();
}

async function loadAgentRules() {
  const data = await api('GET', '/api/agent/number-rules');
  const rules = data.rules || [];
  _agentRules.allow = rules.filter(r => r.rule_type === 'allow');
  _agentRules.block = rules.filter(r => r.rule_type === 'block');
  _renderAgentList('allow');
  _renderAgentList('block');
}

function _renderAgentList(type) {
  const el = document.getElementById(`agent-${type}-list`);
  const rows = _agentRules[type];
  if (!rows.length) { el.innerHTML = '<div class="empty">Пусто</div>'; return; }
  el.innerHTML = rows.map(r => `
    <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;padding:4px 0">
      <span>${_agEsc(r.phone)}${r.note ? ` — ${_agEsc(r.note)}` : ''}</span>
      <button class="btn btn-sec" onclick="removeAgentNumber(${r.id})">✕</button>
    </div>`).join('');
}

async function addAgentNumber(type) {
  const input = document.getElementById(`agent-${type}-input`);
  const phone = input.value.trim();
  if (!phone) return;
  try {
    await api('POST', '/api/agent/number-rules', { phone, ruleType: type, note: '' });
    input.value = '';
    await loadAgentRules();
  } catch (e) { console.error(e); notify('Не удалось добавить номер', 'err'); }
}

async function removeAgentNumber(id) {
  try { await api('DELETE', '/api/agent/number-rules/' + id); await loadAgentRules(); }
  catch (e) { console.error(e); notify('Не удалось удалить номер', 'err'); }
}

async function saveAgentSettings() {
  try {
    await api('PUT', '/api/agent/settings', {
      enabled: document.getElementById('agent-enabled').checked,
      mode: _agentMode(),
      scheduleEnabled: document.getElementById('agent-schedule-enabled').checked,
      scheduleStart: document.getElementById('agent-schedule-start').value,
      scheduleEnd: document.getElementById('agent-schedule-end').value,
    });
    notify('Настройки агента сохранены');
    closeAgentSettings();
  } catch (e) { console.error(e); notify('Ошибка сохранения', 'err'); }
}

window.openAgentSettings = openAgentSettings;
window.closeAgentSettings = closeAgentSettings;
window.addAgentNumber = addAgentNumber;
window.removeAgentNumber = removeAgentNumber;
window.saveAgentSettings = saveAgentSettings;
window.agentToggleSchedule = agentToggleSchedule;
