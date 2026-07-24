'use strict';

// ── Чат (просмотр переписок chatpush) — read-only ───────────────
let _chatDialogs = [];
let _chatActiveKey = null;
let _chatSearch = '';
let _chatPollTimer = null;

const _chatEsc = (s) => String(s ?? '').replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Разрешаем только http(s) и относительные пути — блокируем javascript:/data: и пр.
function _chatSafeUrl(u) {
  const s = String(u || '').trim();
  if (/^https?:\/\//i.test(s)) return s;
  if (s.startsWith('//')) return '';   // protocol-relative → off-origin, блокируем
  if (s.startsWith('/')) return s;
  return '';
}

const CHAT_CHANNELS = {
  whatsapp:     { label: 'WhatsApp', cls: 'chan-wa' },
  tdlib:        { label: 'Telegram', cls: 'chan-tg' },
  telegram_bot: { label: 'Telegram', cls: 'chan-tg' },
  max:          { label: 'MAX',      cls: 'chan-max' },
  max_bot:      { label: 'MAX',      cls: 'chan-max' },
};
function _chatChannel(ch) {
  return CHAT_CHANNELS[ch] || { label: ch || '—', cls: 'chan-def' };
}

// msg_ts — Unix seconds (chatpush). Показываем как локальную дату/время.
function _chatTime(ts) {
  const n = Number(ts);
  if (!n) return '';
  const d = new Date(n * 1000);
  return d.toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}

// Отображаемое имя диалога: клиент → sender → номер → ключ.
function _chatTitle(d) {
  if (d.client && d.client.name) return d.client.name;
  if (d.senderName) return d.senderName;
  return d.phone || d.key;
}

// Вход на страницу: первичная загрузка + запуск живого обновления.
async function loadChat() {
  const s = document.getElementById('chat-search');
  if (s) s.value = _chatSearch;
  await refreshChatDialogs(false);
  startChatPolling();
}

// Загрузка/обновление списка диалогов. silent=true — фоновой опрос без спиннера.
async function refreshChatDialogs(silent) {
  const listEl = document.getElementById('chat-dialogs');
  if (!listEl) return;
  if (!silent) listEl.innerHTML = '<div class="empty">Загрузка…</div>';
  try {
    const data = await api('GET', '/api/chat/dialogs');
    _chatDialogs = data.dialogs || [];
    renderChatDialogs();
  } catch (e) {
    console.error('chat:', e);
    if (!silent) listEl.innerHTML = '<div class="empty">Ошибка загрузки диалогов</div>';
  }
}

// Фильтр списка по имени/номеру. Цифры сравниваем отдельно, игнорируя +, пробелы, скобки.
function _chatFilter() {
  const term = _chatSearch;
  if (!term) return _chatDialogs;
  const digits = term.replace(/\D/g, '');
  return _chatDialogs.filter(d => {
    const name = _chatTitle(d).toLowerCase();
    const phone = (d.phone || d.key || '');
    if (name.includes(term)) return true;
    if (phone.toLowerCase().includes(term)) return true;
    if (digits && phone.replace(/\D/g, '').includes(digits)) return true;
    return false;
  });
}

function renderChatDialogs() {
  const listEl = document.getElementById('chat-dialogs');
  if (!listEl) return;
  const list = _chatFilter();
  if (!list.length) {
    const msg = _chatSearch ? 'Ничего не найдено' : 'Пока нет сообщений';
    const html = '<div class="empty">' + msg + '</div>';
    if (listEl._lastHtml !== html) { listEl._lastHtml = html; listEl.innerHTML = html; }
    return;
  }
  const html = list.map(d => {
    const ch = _chatChannel(d.channel);
    const title = _chatTitle(d);
    const phone = d.phone && d.phone !== title ? d.phone : '';
    const active = d.key === _chatActiveKey ? ' active' : '';
    return `
      <div class="chat-dialog${active}" data-key="${_chatEsc(d.key)}">
        <div class="chat-dialog-top">
          <span class="chat-badge ${ch.cls}">${_chatEsc(ch.label)}</span>
          <span class="chat-dialog-name">${_chatEsc(title)}</span>
          <span class="chat-dialog-time">${_chatTime(d.lastTs)}</span>
        </div>
        ${phone ? `<div class="chat-dialog-phone">${_chatEsc(phone)}</div>` : ''}
        <div class="chat-dialog-preview">${_chatEsc(d.lastText)}</div>
      </div>`;
  }).join('');
  // Ре-рендерим только при реальном изменении — иначе фоновой опрос дёргал бы скролл списка.
  if (listEl._lastHtml === html) return;
  listEl._lastHtml = html;
  listEl.innerHTML = html;
  listEl.onclick = (e) => {
    const el = e.target.closest('.chat-dialog');
    if (el && el.dataset.key != null) openChatDialog(el.dataset.key);
  };
}

// Ввод в поиске — только фильтруем уже загруженные диалоги, без запроса на сервер.
function onChatSearch(v) {
  _chatSearch = String(v || '').trim().toLowerCase();
  renderChatDialogs();
}

async function openChatDialog(key) {
  _chatActiveKey = key;
  renderChatDialogs();
  await renderChatHeader(key);
  await refreshChatMessages(key, false);
}

// Обновление сообщений открытого диалога. silent — фоновой опрос (без спиннера, без скачка скролла).
async function refreshChatMessages(key, silent) {
  const paneEl = document.getElementById('chat-messages');
  if (!paneEl) return;
  if (!silent) paneEl.innerHTML = '<div class="empty">Загрузка…</div>';
  try {
    const data = await api('GET', '/api/chat/dialogs/' + encodeURIComponent(key) + '/messages');
    if (_chatActiveKey !== key) return;   // диалог переключили, пока грузились сообщения
    renderChatMessages(data.messages || []);
  } catch (e) {
    console.error('chat:', e);
    if (!silent) paneEl.innerHTML = '<div class="empty">Ошибка загрузки сообщений</div>';
  }
}

function renderChatMessages(messages) {
  const paneEl = document.getElementById('chat-messages');
  if (!paneEl) return;
  if (!messages.length) {
    const html = '<div class="empty">Нет сообщений</div>';
    if (paneEl._lastHtml !== html) { paneEl._lastHtml = html; paneEl.innerHTML = html; }
    return;
  }
  // Если переписка собрана из разных каналов (Telegram + WhatsApp и т.п.) —
  // подписываем каждое сообщение каналом. Для одноканального диалога не мусорим.
  const channelLabels = new Set(messages.map(m => _chatChannel(m.channel).label));
  const multiChannel = channelLabels.size > 1;
  const html = messages.map(m => {
    const side = m.direction === 'outgoing' ? 'out' : 'in';
    const isText = !m.msg_type || String(m.msg_type).toLowerCase().includes('text');
    let body;
    const safeUrl = _chatSafeUrl(m.file_url);
    if (isText) {
      body = _chatEsc(m.text || '');
    } else if (safeUrl) {
      body = `<a href="${_chatEsc(safeUrl)}" target="_blank" rel="noopener">📎 Вложение</a>` +
             (m.text ? `<div>${_chatEsc(m.text)}</div>` : '');
    } else {
      body = '📎 Вложение' + (m.text ? `<div>${_chatEsc(m.text)}</div>` : '');
    }
    const ch = _chatChannel(m.channel);
    const chanTag = multiChannel
      ? `<span class="chat-chan-tag ${ch.cls}">${_chatEsc(ch.label)}</span>`
      : '';
    return `
      <div class="chat-msg chat-msg-${side}">
        <div class="chat-bubble">${body}</div>
        <div class="chat-msg-time">${chanTag}${_chatTime(m.msg_ts)}</div>
      </div>`;
  }).join('');
  // Без изменений — не трогаем DOM (сохраняем позицию прокрутки при фоновом опросе).
  if (paneEl._lastHtml === html) return;
  // Автопрокрутка вниз, только если пользователь и так был у низа переписки.
  const atBottom = paneEl.scrollHeight - paneEl.scrollTop - paneEl.clientHeight < 60;
  const wasEmpty = !paneEl._lastHtml || paneEl._lastHtml.indexOf('chat-msg') === -1;
  paneEl._lastHtml = html;
  paneEl.innerHTML = html;
  if (atBottom || wasEmpty) paneEl.scrollTop = paneEl.scrollHeight;
}

// Закреплённая шапка диалога: имя + телефон клиента и переключатель бот/оператор.
async function renderChatHeader(key) {
  const headEl = document.getElementById('chat-header');
  if (!headEl) return;
  const d = _chatDialogs.find(x => x.key === key);
  const name = d ? _chatTitle(d) : key;
  const phone = d ? (d.phone || '') : '';
  let status = 'bot';
  try {
    const data = await api('GET', '/api/chat/dialogs/' + encodeURIComponent(key) + '/agent');
    status = data.status || 'bot';
  } catch (e) { console.error('chat agent status:', e); }

  if (_chatActiveKey !== key) return;   // диалог переключили, пока грузился статус — чужую шапку не рисуем
  const escalated = status === 'escalated';
  const label = escalated ? '👤 Отвечает оператор (бот молчит)' : '🤖 Отвечает бот';
  const btnLabel = escalated ? 'Вернуть боту' : 'Передать оператору';
  const nextStatus = escalated ? 'bot' : 'escalated';

  const html =
    '<div class="chat-header-info">' +
      '<div class="chat-header-name">' + _chatEsc(name) + '</div>' +
      (phone ? '<div class="chat-header-phone">' + _chatEsc(phone) + '</div>' : '') +
    '</div>' +
    '<div class="chat-agent-banner' + (escalated ? ' chat-agent-escalated' : '') + '">' +
      '<span class="chat-agent-state">' + _chatEsc(label) + '</span>' +
      '<button class="btn-pri chat-agent-toggle">' + _chatEsc(btnLabel) + '</button>' +
    '</div>';
  if (headEl._lastHtml === html) return;   // без изменений — не перерисовываем (не сбрасываем кнопку)
  headEl._lastHtml = html;
  headEl.innerHTML = html;
  headEl.classList.add('active');
  const btn = headEl.querySelector('.chat-agent-toggle');
  if (btn) btn.onclick = () => toggleAgent(key, nextStatus);
}

// Переключить режим диалога и обновить шапку + переписку.
async function toggleAgent(key, nextStatus) {
  try {
    await api('POST', '/api/chat/dialogs/' + encodeURIComponent(key) + '/agent', { status: nextStatus });
    const headEl = document.getElementById('chat-header');
    if (headEl) headEl._lastHtml = null;   // форсируем перерисовку после смены статуса
    await renderChatHeader(key);
  } catch (e) {
    console.error('chat agent toggle:', e);
    alert('Не удалось переключить режим');
  }
}

// ── Живое обновление: опрос каждые 5 секунд ──────────────────────
function startChatPolling() {
  stopChatPolling();
  _chatPollTimer = setInterval(pollChat, 5000);
}
function stopChatPolling() {
  if (_chatPollTimer) { clearInterval(_chatPollTimer); _chatPollTimer = null; }
}
async function pollChat() {
  if (document.hidden) return;             // вкладка неактивна — не дёргаем сервер
  await refreshChatDialogs(true);
  if (_chatActiveKey) {
    await refreshChatMessages(_chatActiveKey, true);
    await renderChatHeader(_chatActiveKey);
  }
}

window.loadChat = loadChat;
window.openChatDialog = openChatDialog;
window.onChatSearch = onChatSearch;
window.stopChatPolling = stopChatPolling;
