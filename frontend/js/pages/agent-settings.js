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
    document.getElementById('agent-followup-delay1').value = s.followupDelay1Min || 0;
    document.getElementById('agent-followup-delay2').value = s.followupDelay2Min ?? 60;
    document.getElementById('agent-followup-latest').value = s.followupLatestTime || '';
    document.getElementById('agent-followup-text').value = s.followupFinalText || '';
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
  const scheduleEnabled = document.getElementById('agent-schedule-enabled').checked;
  const scheduleStart = document.getElementById('agent-schedule-start').value;
  const scheduleEnd = document.getElementById('agent-schedule-end').value;
  // Пустое время из <input type="time"> сервер отклонит целиком — проверяем на клиенте
  if (scheduleEnabled && (!scheduleStart || !scheduleEnd)) {
    notify('Укажите начало и конец окна расписания', 'err');
    return;
  }
  // Пустая строка уходит на сервер КАК ЕСТЬ (не 0!) — сервер трактует '' как
  // «не передано, оставить текущее» (pickDelay в services/agent-settings.js).
  // Number('')||0 стёр бы это состояние: администратор, случайно очистивший
  // поле, молча выключил бы напоминания. Тот же приём — frontend/js/pages/reminders.js.
  const rawDelay1 = document.getElementById('agent-followup-delay1').value.trim();
  const rawDelay2 = document.getElementById('agent-followup-delay2').value.trim();
  const followupDelay1Min = rawDelay1 === '' ? '' : Number(rawDelay1);
  const followupDelay2Min = rawDelay2 === '' ? '' : Number(rawDelay2);
  const followupLatestTime = document.getElementById('agent-followup-latest').value;
  const followupFinalText = document.getElementById('agent-followup-text').value;
  // Целое и в диапазоне 0..1440 (тот же потолок, что FOLLOWUP_DELAY_MAX на сервере) —
  // дробное или вне диапазона ловим на клиенте, а не отдаём сырую ошибку сервера.
  for (const [label, v] of [['Первое напоминание', followupDelay1Min], ['Финальное сообщение', followupDelay2Min]]) {
    if (v !== '' && (!Number.isInteger(v) || v < 0 || v > 1440)) {
      notify(`«${label}»: введите целое число минут от 0 до 1440`, 'err');
      return;
    }
  }
  // Проверку «второй больше первого» имеет смысл делать, только когда оба поля
  // заполнены числом: пустое поле сохранит текущее значение на сервере, и клиент
  // не знает, каким оно окажется.
  if (followupDelay1Min !== '' && followupDelay2Min !== '' && followupDelay1Min > 0
      && !(followupDelay2Min > followupDelay1Min)) {
    notify('Финальное сообщение должно уходить позже первого напоминания', 'err');
    return;
  }
  try {
    await api('PUT', '/api/agent/settings', {
      enabled: document.getElementById('agent-enabled').checked,
      mode: _agentMode(),
      scheduleEnabled,
      scheduleStart,
      scheduleEnd,
      followupDelay1Min,
      followupDelay2Min,
      followupLatestTime,
      followupFinalText,
    });
    notify('Настройки агента сохранены');
    closeAgentSettings();
  } catch (e) { console.error(e); notify(e.message || 'Ошибка сохранения', 'err'); }
}

window.openAgentSettings = openAgentSettings;
window.closeAgentSettings = closeAgentSettings;
window.addAgentNumber = addAgentNumber;
window.removeAgentNumber = removeAgentNumber;
window.saveAgentSettings = saveAgentSettings;
window.agentToggleSchedule = agentToggleSchedule;
