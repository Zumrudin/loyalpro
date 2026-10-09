'use strict';
// Настройки → «Мессенджеры»: аккаунты салона и подключение Telegram через свой
// шлюз (телефон → код → пароль 2FA). Чистые помощники наверху — под node --test.
// API: GET /api/messaging/accounts, POST /accounts/telegram,
// POST /accounts/:id/auth {phone|code|password}, GET /accounts/:id/status,
// POST /accounts/:id/logout, POST /accounts/:id/activate (routes/messaging-accounts.js).

const MSG_ACC_CHANNEL = { whatsapp: 'WhatsApp', tdlib: 'Telegram', telegram: 'Telegram-бот', max: 'MAX', max_bot: 'MAX-бот', notify: 'Notify (ВК/ОК)' };
const MSG_ACC_AUTH = { starting: 'запускается', wait_phone: 'ждёт номер', wait_code: 'ждёт код', wait_password: 'ждёт пароль', ready: 'подключён', logged_out: 'отключён', error: 'ошибка' };

function msgAccStateLabel(a) {
  if (a.provider === 'chatpush') return 'Chatpush · ' + (a.status === 'active' ? 'активен' : 'отключён');
  const parts = ['Свой шлюз'];
  // pending: шлюз авторизуется, канал пока обслуживает прежний аккаунт.
  if (a.status === 'pending') return 'Свой шлюз · подключается · ' + (MSG_ACC_AUTH[a.auth_state] || a.auth_state);
  if (a.status !== 'active') { parts.push('отключён'); return parts.join(' · '); }
  parts.push(MSG_ACC_AUTH[a.auth_state] || a.auth_state || 'неизвестно');
  if (a.auth_state === 'ready' && a.phone) parts.push('+' + a.phone);
  if (a.auth_state === 'error' && a.auth_error) parts.push(a.auth_error);
  return parts.join(' · ');
}

function msgAccNextStep(authState) {
  if (authState === 'wait_phone') return 'phone';
  if (authState === 'wait_code') return 'code';
  if (authState === 'wait_password') return 'password';
  if (authState === 'ready' || authState === 'logged_out' || authState === 'error') return null;
  return 'wait';
}

let _msgAccPoll = null;
let _msgAccBusy = false;
let _msgAccStickyError = null;   // ошибка отправки шага; живёт, пока authState не изменится
let _msgAccLastState = null;
let _msgAccCurrent = null;   // id подключаемого gateway-аккаунта

async function loadMessagingAccounts() {
  const root = document.getElementById('msg-acc-list');
  if (!root) return;
  root.textContent = 'Загрузка…';
  try {
    const r = await api('GET', '/api/messaging/accounts');
    root.replaceChildren();
    for (const a of r.accounts) {
      const row = document.createElement('div');
      row.className = 'msg-acc-row';
      row.style.margin = '6px 0';
      const ch = document.createElement('b'); ch.textContent = MSG_ACC_CHANNEL[a.channel] || a.channel;
      const st = document.createElement('span'); st.textContent = ' — ' + msgAccStateLabel(a);
      row.append(ch, st);
      const live = a.status === 'active' || a.status === 'pending';
      if (a.provider === 'gateway' && live) {
        const btn = document.createElement('button'); btn.className = 'btn btn-sec'; btn.textContent = 'Отключить';
        btn.onclick = () => msgAccLogout(a.id);
        row.append(' ', btn);
        // pending+ready (шлюз вошёл, пока страница была закрыта): тик /status продвинет строку.
        if (a.status === 'pending' || a.auth_state !== 'ready') { _msgAccCurrent = a.id; msgAccStartPolling(); }
      }
      if (!live) {
        const btn = document.createElement('button'); btn.className = 'btn btn-sec'; btn.textContent = 'Сделать активным';
        btn.onclick = () => msgAccActivate(a.id);
        row.append(' ', btn);
      }
      root.appendChild(row);
    }
    if (!r.accounts.length) root.textContent = 'Аккаунтов нет.';
    const connectBtn = document.getElementById('msg-acc-connect-tg');
    if (connectBtn) {
      const busy = r.accounts.some(a => a.provider === 'gateway' && (a.status === 'active' || a.status === 'pending'));
      connectBtn.disabled = !r.gatewayConfigured || busy;
      connectBtn.title = busy ? 'Telegram уже подключается через свой шлюз' : '';
    }
    const note = document.getElementById('msg-acc-gw-note');
    if (note) note.textContent = r.gatewayConfigured ? '' : 'Свой шлюз не настроен на сервере (MESSAGING_GATEWAY_URL).';
  } catch (e) {
    root.textContent = 'Не удалось загрузить: ' + e.message;
  }
}

async function msgAccConnectTelegram() {
  if (!confirm('Подключить Telegram салона к своему шлюзу? Канал переключится с Chatpush, когда вход будет подтверждён. Продолжить?')) return;
  try {
    const r = await api('POST', '/api/messaging/accounts/telegram');
    _msgAccCurrent = r.id;
    msgAccRenderStep(r.authState, null);
    msgAccStartPolling();
    await loadMessagingAccounts();
  } catch (e) { alert('Не удалось начать подключение: ' + e.message); }
}

function msgAccRenderStep(authState, error) {
  const box = document.getElementById('msg-acc-wizard');
  if (!box) return;
  const step = msgAccNextStep(authState);
  const err = document.getElementById('msg-acc-error');
  if (err) err.textContent = error || '';
  box.querySelectorAll('[data-step]').forEach(el => { el.style.display = el.dataset.step === step ? '' : 'none'; });
  // Ошибку показываем, даже когда шагов ввода больше нет (error/logged_out).
  box.style.display = (step || error) ? '' : 'none';
  if (!step && _msgAccPoll) { clearInterval(_msgAccPoll); _msgAccPoll = null; }
}

async function msgAccSendStep(field) {
  const input = document.getElementById('msg-acc-' + field);
  const value = input ? input.value : '';
  if (!value || !_msgAccCurrent) return;
  try {
    const r = await api('POST', `/api/messaging/accounts/${_msgAccCurrent}/auth`, { [field]: value });
    if (input && field !== 'phone') input.value = '';
    _msgAccStickyError = null;
    _msgAccLastState = r.authState;
    msgAccRenderStep(r.authState, r.error);
    if (r.authState === 'ready') await loadMessagingAccounts();
  } catch (e) {
    _msgAccStickyError = e.message;   // шаг не сбрасываем — можно повторить ввод
    const err = document.getElementById('msg-acc-error');
    if (err) err.textContent = e.message;
  } finally {
    if (field === 'password' && input) input.value = '';
  }
}

function msgAccStartPolling() {
  if (_msgAccPoll) clearInterval(_msgAccPoll);
  _msgAccPoll = setInterval(async () => {
    const sec = document.getElementById('stg-messengers');
    if (!_msgAccCurrent || document.body.dataset.page !== 'settings' || !sec || !sec.classList.contains('active')) {
      clearInterval(_msgAccPoll); _msgAccPoll = null; return;
    }
    if (_msgAccBusy) return;
    _msgAccBusy = true;
    try {
      const s = await api('GET', `/api/messaging/accounts/${_msgAccCurrent}/status`);
      if (s.authState !== _msgAccLastState) { _msgAccStickyError = null; _msgAccLastState = s.authState; }
      msgAccRenderStep(s.authState, _msgAccStickyError || s.error);
      if (s.authState === 'ready') await loadMessagingAccounts();
    } catch (_) { /* следующий тик */ }
    finally { _msgAccBusy = false; }
  }, 2000);
}

async function msgAccLogout(id) {
  if (!confirm('Отключить Telegram от своего шлюза? Сессия будет удалена.')) return;
  try { await api('POST', `/api/messaging/accounts/${id}/logout`); await loadMessagingAccounts(); }
  catch (e) { alert('Не удалось отключить: ' + e.message); }
}

async function msgAccActivate(id) {
  if (!confirm('Сделать этот аккаунт активным для его канала? Текущий активный будет отключён.')) return;
  try { await api('POST', `/api/messaging/accounts/${id}/activate`); await loadMessagingAccounts(); }
  catch (e) { alert('Не удалось: ' + e.message); }
}
