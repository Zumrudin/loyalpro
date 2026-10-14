'use strict';
// Настройки → «Мессенджеры»: аккаунты салона и подключение Telegram, WhatsApp и MAX
// через свой шлюз (телефон → код → пароль 2FA; QR). Чистые помощники наверху — под node --test.
// API: GET /api/messaging/accounts, POST /accounts/{telegram|whatsapp|max},
// POST /accounts/:id/auth {phone|code|password}, GET /accounts/:id/status,
// POST /accounts/:id/logout, POST /accounts/:id/activate (routes/messaging-accounts.js).

const MSG_ACC_CHANNEL = { whatsapp: 'WhatsApp', tdlib: 'Telegram', telegram: 'Telegram-бот', max: 'MAX', max_bot: 'MAX-бот', notify: 'Notify (ВК/ОК)' };
const MSG_ACC_AUTH = { starting: 'запускается', wait_phone: 'ждёт номер', wait_code: 'ждёт код', wait_password: 'ждёт пароль', wait_qr: 'ждёт сканирования QR', ready: 'подключён', logged_out: 'отключён', error: 'ошибка' };
// Кнопки «Подключить … напрямую»: [id кнопки, канал, подпись].
const MSG_ACC_CONNECT_BUTTONS = [['msg-acc-connect-tg', 'tdlib', 'Telegram'], ['msg-acc-connect-wa', 'whatsapp', 'WhatsApp'], ['msg-acc-connect-max', 'max', 'MAX']];
function msgAccConnectLabel(channel) { return (MSG_ACC_CONNECT_BUTTONS.find(b => b[1] === channel) || [])[2] || channel; }
// Путь ручки POST /api/messaging/accounts/<path>.
function msgAccGatewayPath(channel) { return channel === 'tdlib' ? 'telegram' : channel; }
// Подпись над QR: где взять сканер в приложении.
function msgAccQrHint(channel) {
  if (channel === 'max') return 'Откройте MAX на телефоне клиники → Профиль → Устройства → Подключить устройство и отсканируйте QR:';
  return 'Откройте WhatsApp на телефоне клиники → Связанные устройства → Привязка устройства и отсканируйте QR:';
}

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
  if (authState === 'wait_qr') return 'qr';
  if (authState === 'ready' || authState === 'logged_out' || authState === 'error') return null;
  return 'wait';
}

let _msgAccPoll = null;
let _msgAccBusy = false;
let _msgAccStickyError = null;   // ошибка отправки шага; живёт, пока authState не изменится
let _msgAccLastState = null;
let _msgAccCurrent = null;   // id подключаемого gateway-аккаунта
let _msgAccStatus = null;    // status строки (active|pending) — от него зависит, можно ли «Запустить заново»
let _msgAccChannel = null;   // канал подключаемого аккаунта ('tdlib' | 'whatsapp' | 'max') — для «Запустить заново»

// «Запустить заново»: WhatsApp и MAX — просто повторный start (POST идемпотентен, logout не нужен и вреден);
// Telegram — logout+start, и только для pending: у active logout удалит рабочую сессию.
// MAX на шаге кода/пароля (SMS не пришло, номер ошибочный) — logout+start: шаги привязаны
// к соединению шлюза, повторный start вернул бы тот же шаг; токена входа ещё нет — сбрасывать нечего.
function msgAccRestartPlan(channel, status, authState) {
  if (channel === 'max' && (authState === 'wait_code' || authState === 'wait_password')) return { show: true, logout: true };
  if (channel === 'whatsapp' || channel === 'max') return { show: true, logout: false };
  if (channel === 'tdlib' && status === 'pending') return { show: true, logout: true };
  return { show: false, logout: false };
}

// Кнопка видна после ошибки (если план её разрешает), а у MAX — ещё и на шагах кода/пароля:
// иначе из «ждём код» нельзя было вернуться к QR.
function msgAccRestartVisible(channel, status, authState) {
  if (authState === 'error') return msgAccRestartPlan(channel, status, authState).show;
  return channel === 'max' && (authState === 'wait_code' || authState === 'wait_password');
}

// Занят ли шлюз ЭТИМ каналом (кнопки Telegram, WhatsApp и MAX независимы).
function msgAccGatewayBusy(rows, channel) {
  return rows.some(a => a.provider === 'gateway' && a.channel === channel && (a.status === 'active' || a.status === 'pending'));
}

// В <img src> пускаем только PNG data-URL: строка приходит с сервера.
function msgAccQrSrc(qr) {
  return (typeof qr === 'string' && /^data:image\/png;base64,[A-Za-z0-9+\/=]+$/.test(qr)) ? qr : null;
}

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
        btn.onclick = () => msgAccLogout(a.id, a.channel);
        row.append(' ', btn);
        // pending+ready (шлюз вошёл, пока страница была закрыта): тик /status продвинет строку.
        if (a.status === 'pending' || a.auth_state !== 'ready') { _msgAccCurrent = a.id; _msgAccChannel = a.channel; _msgAccStatus = a.status; msgAccStartPolling(); }
      }
      if (!live && a.auth_state !== 'logged_out') {
        const btn = document.createElement('button'); btn.className = 'btn btn-sec'; btn.textContent = 'Сделать активным';
        btn.onclick = () => msgAccActivate(a.id);
        row.append(' ', btn);
      }
      root.appendChild(row);
    }
    if (!r.accounts.length) root.textContent = 'Аккаунтов нет.';
    for (const [btnId, channel, label] of MSG_ACC_CONNECT_BUTTONS) {
      const connectBtn = document.getElementById(btnId);
      if (!connectBtn) continue;
      const busy = msgAccGatewayBusy(r.accounts, channel);
      connectBtn.disabled = !r.gatewayConfigured || busy;
      connectBtn.title = busy ? `${label} уже подключается через свой шлюз` : '';
    }
    const note = document.getElementById('msg-acc-gw-note');
    if (note) note.textContent = r.gatewayConfigured ? '' : 'Свой шлюз не настроен на сервере (MESSAGING_GATEWAY_URL).';
  } catch (e) {
    root.textContent = 'Не удалось загрузить: ' + e.message;
  }
}

async function msgAccConnect(channel) {
  const label = msgAccConnectLabel(channel);
  if (!confirm(`Подключить ${label} салона к своему шлюзу? Канал переключится с Chatpush, когда вход будет подтверждён. Продолжить?`)) return;
  await msgAccStart(channel);
}
async function msgAccStart(channel) {
  try {
    const r = await api('POST', `/api/messaging/accounts/${msgAccGatewayPath(channel)}`);
    _msgAccCurrent = r.id;
    _msgAccChannel = channel;
    _msgAccStatus = r.status;
    _msgAccStickyError = null;
    _msgAccLastState = r.authState;
    msgAccRenderStep(r.authState, null, { qr: null, pairingCode: null });
    msgAccStartPolling();
    await loadMessagingAccounts();
  } catch (e) { alert('Не удалось начать подключение: ' + e.message); }
}
function msgAccConnectTelegram() { return msgAccConnect('tdlib'); }
function msgAccConnectWhatsapp() { return msgAccConnect('whatsapp'); }
function msgAccConnectMax() { return msgAccConnect('max'); }

// После ошибки (например «QR не отсканирован») — отключить зависший аккаунт и начать заново.
async function msgAccRestart() {
  const id = _msgAccCurrent, channel = _msgAccChannel;
  const plan = msgAccRestartPlan(channel, _msgAccStatus, _msgAccLastState);
  if (!id || !channel || !plan.show) return;
  if (plan.logout) {
    if (!confirm('Сбросить неудавшуюся попытку подключения и начать заново?')) return;
    try { await api('POST', `/api/messaging/accounts/${id}/logout`); }
    catch (e) { alert('Не удалось сбросить прежнюю попытку: ' + e.message); return; }
  }
  await msgAccStart(channel);
}

function msgAccRenderStep(authState, error, extra) {
  const box = document.getElementById('msg-acc-wizard');
  if (!box) return;
  const step = msgAccNextStep(authState);
  const err = document.getElementById('msg-acc-error');
  if (err) err.textContent = error || '';
  box.querySelectorAll('[data-step]').forEach(el => { el.style.display = el.dataset.step === step ? '' : 'none'; });
  // Ошибку показываем, даже когда шагов ввода больше нет (error/logged_out).
  box.style.display = (step || error) ? '' : 'none';
  const restart = document.getElementById('msg-acc-restart');
  if (restart) restart.style.display = (_msgAccCurrent && msgAccRestartVisible(_msgAccChannel, _msgAccStatus, authState)) ? '' : 'none';
  if (extra && step === 'qr') {
    const hint = document.getElementById('msg-acc-qr-hint');
    if (hint) hint.textContent = msgAccQrHint(_msgAccChannel);
    const waOnly = document.getElementById('msg-acc-qr-wa-only');
    if (waOnly) waOnly.style.display = _msgAccChannel === 'whatsapp' ? '' : 'none';
    const maxOnly = document.getElementById('msg-acc-qr-max-only');
    if (maxOnly) maxOnly.style.display = _msgAccChannel === 'max' ? '' : 'none';
    // qr === undefined — поле не пришло (ответ /auth), оставляем как есть; null — идёт переподключение.
    const img = document.getElementById('msg-acc-qr-img');
    const wait = document.getElementById('msg-acc-qr-wait');
    if (extra.qr !== undefined) {
      const src = msgAccQrSrc(extra.qr);
      if (img) { if (src) { img.src = src; img.style.display = ''; } else { img.removeAttribute('src'); img.style.display = 'none'; } }
      if (wait) wait.style.display = src ? 'none' : '';
    }
    const pc = document.getElementById('msg-acc-pairing-code');
    if (pc && extra.pairingCode !== undefined) pc.textContent = extra.pairingCode ? 'Код для ввода на телефоне: ' + extra.pairingCode : '';
  }
  if (!step && _msgAccPoll) { clearInterval(_msgAccPoll); _msgAccPoll = null; }
}

async function msgAccSendStep(field) {
  const input = document.getElementById('msg-acc-' + field);
  const bodyKey = (field === 'wa-phone' || field === 'max-phone') ? 'phone' : field;
  const value = input ? input.value : '';
  if (!value || !_msgAccCurrent) return;
  try {
    const r = await api('POST', `/api/messaging/accounts/${_msgAccCurrent}/auth`, { [bodyKey]: value });
    if (input && bodyKey !== 'phone') input.value = '';
    _msgAccStickyError = null;
    _msgAccLastState = r.authState;
    msgAccRenderStep(r.authState, r.error, { pairingCode: r.pairingCode });
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
      msgAccRenderStep(s.authState, _msgAccStickyError || s.error, s);
      if (s.authState === 'ready') await loadMessagingAccounts();
    } catch (_) { /* следующий тик */ }
    finally { _msgAccBusy = false; }
  }, 2000);
}

async function msgAccLogout(id, channel) {
  if (!confirm(`Отключить ${MSG_ACC_CHANNEL[channel] || 'аккаунт'} от своего шлюза? Сессия будет удалена.`)) return;
  try { await api('POST', `/api/messaging/accounts/${id}/logout`); await loadMessagingAccounts(); }
  catch (e) { alert('Не удалось отключить: ' + e.message); }
}

async function msgAccActivate(id) {
  if (!confirm('Сделать этот аккаунт активным для его канала? Текущий активный будет отключён.')) return;
  try { await api('POST', `/api/messaging/accounts/${id}/activate`); await loadMessagingAccounts(); }
  catch (e) { alert('Не удалось: ' + e.message); }
}
