'use strict';
let _agentModelState = null;

function agentModelStatusText(s) {
  const health = { ok: 'Работает', unverified: 'Ожидает следующего запроса', error: 'Последний запрос завершился ошибкой' };
  return `${s.model} · ${s.channel || ''} · ${health[s.health] || s.health}`;
}

async function loadAgentModel() {
  const root = document.getElementById('agent-model-current');
  const select = document.getElementById('agent-model-select');
  const button = document.getElementById('agent-model-save');
  button.disabled = true;
  try {
    const s = await api('GET', '/api/agent/model');
    _agentModelState = s;
    root.textContent = agentModelStatusText(s);
    select.replaceChildren();
    for (const choice of s.choices) {
      const option = document.createElement('option');
      option.value = choice.id;
      option.textContent = `${choice.title} · ${choice.channel}`;
      select.appendChild(option);
    }
    if (!s.choices.some(c => c.id === s.active)) {
      const option = document.createElement('option');
      option.value = s.active; option.textContent = s.model; option.disabled = true;
      select.appendChild(option);
    }
    select.value = s.active;
    button.disabled = false;
  } catch (_) {
    _agentModelState = null;
    root.textContent = 'Не удалось загрузить состояние. Нажмите «Обновить».';
  }
}

async function saveAgentModel() {
  if (!_agentModelState) return;
  const button = document.getElementById('agent-model-save');
  button.disabled = true;
  try {
    await api('PUT', '/api/agent/model', {
      active: document.getElementById('agent-model-select').value,
      revision: _agentModelState.revision,
    });
    notify('Модель выбрана. Переключение действует со следующего запроса.');
  } catch (e) { notify(e.message || 'Не удалось переключить модель', 'err'); }
  await loadAgentModel();
}

async function checkAgentModelNotice() {
  document.getElementById('agent-model-notice')?.remove();
  if (!['owner', 'admin'].includes(ME?.role)) return;
  const currentUser = ME;
  try {
    const s = await api('GET', '/api/agent/model');
    if (ME !== currentUser || !s.notice) return;
    const n = s.notice;
    const overlay = document.createElement('div');
    overlay.id = 'agent-model-notice'; overlay.className = 'ov open';
    overlay.setAttribute('role', 'dialog'); overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-label', 'Мила автоматически переключила модель');
    const panel = document.createElement('div'); panel.className = 'modal';
    panel.style.cssText = 'max-width:520px;padding:24px';
    const title = document.createElement('h3'); title.textContent = 'Мила автоматически переключила модель';
    const detail = document.createElement('p');
    const when = new Date(n.at).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' });
    detail.textContent = `${n.fromTitle} → ${n.toTitle}. ${n.reason}. ${when} (МСК).`;
    const current = document.createElement('p'); current.textContent = 'Сейчас: ' + agentModelStatusText(s);
    const error = document.createElement('p'); error.setAttribute('role', 'alert');
    const settings = document.createElement('button'); settings.className = 'btn btn-sec';
    settings.textContent = 'Настройки модели';
    settings.onclick = () => {
      navTo('settings');
      navStg('agent-model', document.querySelector('[data-sec="agent-model"]'));
      overlay.remove(); // Not acknowledged: show again at next login.
    };
    const ack = document.createElement('button'); ack.className = 'btn btn-pri'; ack.textContent = 'Понятно';
    ack.onclick = async () => {
      ack.disabled = true;
      try {
        await api('POST', '/api/agent/model/acknowledge', { revision: n.revision });
        overlay.remove();
      } catch (_) { error.textContent = 'Не удалось подтвердить. Попробуйте ещё раз.'; ack.disabled = false; }
    };
    panel.append(title, detail, current, error, settings, ack); overlay.appendChild(panel);
    document.body.appendChild(overlay); ack.focus();
  } catch (_) { /* A status endpoint failure must not prevent login. */ }
}
