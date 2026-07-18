'use strict';

// ── Чат (просмотр переписок chatpush) — read-only ───────────────
let _chatDialogs = [];
let _chatActiveKey = null;

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

async function loadChat() {
  const listEl = document.getElementById('chat-dialogs');
  listEl.innerHTML = '<div class="empty">Загрузка…</div>';
  try {
    const data = await api('GET', '/api/chat/dialogs');
    _chatDialogs = data.dialogs || [];
    renderChatDialogs();
  } catch (e) {
    console.error('chat:', e);
    listEl.innerHTML = '<div class="empty">Ошибка загрузки диалогов</div>';
  }
}

function renderChatDialogs() {
  const listEl = document.getElementById('chat-dialogs');
  if (!_chatDialogs.length) {
    listEl.innerHTML = '<div class="empty">Пока нет сообщений</div>';
    return;
  }
  listEl.innerHTML = _chatDialogs.map(d => {
    const ch = _chatChannel(d.channel);
    const title = d.client ? d.client.name : (d.senderName || d.key);
    const active = d.key === _chatActiveKey ? ' active' : '';
    return `
      <div class="chat-dialog${active}" data-key="${_chatEsc(d.key)}">
        <div class="chat-dialog-top">
          <span class="chat-badge ${ch.cls}">${_chatEsc(ch.label)}</span>
          <span class="chat-dialog-name">${_chatEsc(title)}</span>
          <span class="chat-dialog-time">${_chatTime(d.lastTs)}</span>
        </div>
        <div class="chat-dialog-preview">${_chatEsc(d.lastText)}</div>
      </div>`;
  }).join('');
  listEl.onclick = (e) => {
    const el = e.target.closest('.chat-dialog');
    if (el && el.dataset.key != null) openChatDialog(el.dataset.key);
  };
}

async function openChatDialog(key) {
  _chatActiveKey = key;
  renderChatDialogs();
  const paneEl = document.getElementById('chat-messages');
  paneEl.innerHTML = '<div class="empty">Загрузка…</div>';
  try {
    const data = await api('GET', '/api/chat/dialogs/' + encodeURIComponent(key) + '/messages');
    renderChatMessages(data.messages || []);
    await renderAgentBanner(key);
  } catch (e) {
    console.error('chat:', e);
    paneEl.innerHTML = '<div class="empty">Ошибка загрузки сообщений</div>';
  }
}

function renderChatMessages(messages) {
  const paneEl = document.getElementById('chat-messages');
  if (!messages.length) {
    paneEl.innerHTML = '<div class="empty">Нет сообщений</div>';
    return;
  }
  // Если переписка собрана из разных каналов (Telegram + WhatsApp и т.п.) —
  // подписываем каждое сообщение каналом. Для одноканального диалога не мусорим.
  const channelLabels = new Set(messages.map(m => _chatChannel(m.channel).label));
  const multiChannel = channelLabels.size > 1;
  paneEl.innerHTML = messages.map(m => {
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
  paneEl.scrollTop = paneEl.scrollHeight;
}

// Баннер режима агента над перепиской: показывает bot/escalated + кнопку переключения.
async function renderAgentBanner(key) {
  const paneEl = document.getElementById('chat-messages');
  if (!paneEl) return;
  let status = 'bot';
  try {
    const data = await api('GET', '/api/chat/dialogs/' + encodeURIComponent(key) + '/agent');
    status = data.status || 'bot';
  } catch (e) { console.error('chat agent status:', e); return; }

  const escalated = status === 'escalated';
  const label = escalated ? '👤 Отвечает оператор (бот молчит)' : '🤖 Отвечает бот';
  const btnLabel = escalated ? 'Вернуть боту' : 'Передать оператору';
  const nextStatus = escalated ? 'bot' : 'escalated';

  const bar = document.createElement('div');
  bar.className = 'chat-agent-banner' + (escalated ? ' chat-agent-escalated' : '');
  bar.innerHTML =
    '<span class="chat-agent-state">' + _chatEsc(label) + '</span>' +
    '<button class="btn-pri chat-agent-toggle">' + _chatEsc(btnLabel) + '</button>';
  bar.querySelector('.chat-agent-toggle').onclick = () => toggleAgent(key, nextStatus);
  paneEl.prepend(bar);
}

// Переключить режим диалога и перерисовать переписку.
async function toggleAgent(key, nextStatus) {
  try {
    await api('POST', '/api/chat/dialogs/' + encodeURIComponent(key) + '/agent', { status: nextStatus });
    openChatDialog(key);
  } catch (e) {
    console.error('chat agent toggle:', e);
    alert('Не удалось переключить режим');
  }
}

window.loadChat = loadChat;
window.openChatDialog = openChatDialog;
