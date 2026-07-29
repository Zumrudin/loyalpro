'use strict';
// ── Композер чата: текст + канал + эмодзи + файл ────────────────
// Отправка: POST /api/chat/dialogs/:key/send | /send-file.
// Оптимистичный пузырь рисует chat.js (chatAppendOptimistic/chatResolveOptimistic).

let _cmpDialog = null;   // {key, channels, defaultChannel, ...}
let _cmpFile = null;
let _cmpManualH = false;  // пользователь потянул «ручку» textarea → авто-рост выключен

// Авто-рост поля ввода по мере набора (до предела). Если пользователь вручную
// растянул поле — не трогаем его высоту.
function _cmpAutoGrow() {
  const ta = document.getElementById('chat-input');
  if (!ta || _cmpManualH) return;
  ta.style.height = 'auto';
  ta.style.height = Math.min(ta.scrollHeight, 400) + 'px';
}

const CHAT_EMOJIS = ['😀','😁','😂','🤣','😊','😍','😘','😉','🙂','🤗','🤔','😌','😎','🥰','😢','😭','😤','🙏','👍','👎','👏','🙌','💪','🤝','❤️','💕','🔥','✨','🎉','🥳','💐','🌸','☀️','⭐','✅','❌','⏰','📅','💇','💅','💆','🧖','💄','💋','🎁','☕','😇','🤩'];

// Файлы Chatpush умеет только в эти каналы (send_file: whatsapp|tdlib|max).
const CMP_FILE_CHANNELS = new Set(['whatsapp', 'tdlib', 'telegram_bot', 'max', 'max_bot']);

const CMP_CHANNEL_LABELS = {
  whatsapp: 'WhatsApp', tdlib: 'Telegram', telegram_bot: 'Telegram (бот)',
  max: 'MAX', max_bot: 'MAX (бот)',
};

// Каналы, доступные для ОТПРАВКИ по этому диалогу.
// WhatsApp и MAX адресуются по номеру телефона (recipientParams: out.phone),
// поэтому доступны для любого личного диалога с известным номером — даже если
// клиент туда не писал. Telegram (tdlib) требует chat_id из входящего, поэтому
// предлагается только когда он есть в истории. Группы адресуем лишь по истории.
const CMP_PHONE_CHANNELS = ['whatsapp', 'max'];
const CMP_CHANNEL_ORDER = ['whatsapp', 'max', 'max_bot', 'tdlib', 'telegram_bot'];

function _cmpSendableChannels(d) {
  const set = new Set((d.channels && d.channels.length) ? d.channels : (d.channel ? [d.channel] : []));
  if (!d.isGroup && d.phone) CMP_PHONE_CHANNELS.forEach(c => set.add(c));
  const rank = c => { const i = CMP_CHANNEL_ORDER.indexOf(c); return i < 0 ? 99 : i; };
  return [...set].sort((a, b) => rank(a) - rank(b));
}

// Вход при открытии диалога (зовёт openChatDialog из chat.js). d=null — скрыть.
function chatComposerSetDialog(d) {
  _cmpDialog = d;
  _cmpClearFile();
  const box = document.getElementById('chat-composer');
  if (!box) return;
  box.style.display = d ? '' : 'none';
  if (!d) return;
  const sel = document.getElementById('chat-chan-select');
  const chans = _cmpSendableChannels(d);
  sel.innerHTML = chans.map(c =>
    `<option value="${_chatEsc(c)}"${c === d.defaultChannel ? ' selected' : ''}>${_chatEsc(CMP_CHANNEL_LABELS[c] || c)}</option>`).join('');
  sel.disabled = !chans.length;
  document.getElementById('chat-input').focus();
}

function _cmpChannel() { return document.getElementById('chat-chan-select').value; }

async function _cmpSend() {
  if (!_cmpDialog) return;
  const ta = document.getElementById('chat-input');
  const text = ta.value.trim();
  const channel = _cmpChannel();
  if (!text && !_cmpFile) return;
  if (!channel) { alert('Не выбран канал отправки'); return; }
  const file = _cmpFile;
  ta.value = '';
  if (!_cmpManualH) ta.style.height = 'auto';   // ручную высоту после отправки сохраняем
  _cmpClearFile();
  const localId = chatAppendOptimistic({ text, channel, file: file ? file.name : null });
  try {
    if (file) {
      const fd = new FormData();
      fd.append('file', file);
      if (text) fd.append('text', text);
      fd.append('channel', channel);
      const r = await fetch('/api/chat/dialogs/' + encodeURIComponent(_cmpDialog.key) + '/send-file', {
        method: 'POST', headers: { Authorization: 'Bearer ' + localStorage.getItem('lp_tk') }, body: fd,
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || 'HTTP ' + r.status);
    } else {
      await api('POST', '/api/chat/dialogs/' + encodeURIComponent(_cmpDialog.key) + '/send', { text, channel });
    }
    chatResolveOptimistic(localId, 'sent');
    // Ручной ответ авто-паузит бота — обновляем баннер шапки.
    if (typeof renderChatHeader === 'function') {
      const headEl = document.getElementById('chat-header');
      if (headEl) headEl._lastHtml = null;
      renderChatHeader(_cmpDialog.key);
    }
  } catch (e) {
    console.error('composer send:', e);
    chatResolveOptimistic(localId, 'failed', e.message);
  }
}

function _cmpClearFile() {
  _cmpFile = null;
  const p = document.getElementById('chat-attach-preview');
  if (p) { p.style.display = 'none'; p.innerHTML = ''; }
  const inp = document.getElementById('chat-file-input');
  if (inp) inp.value = '';
}

function _cmpPickFile(file) {
  if (!file) return;
  if (file.size > 25 * 1024 * 1024) { alert('Файл больше 25 МБ'); return; }
  if (!CMP_FILE_CHANNELS.has(_cmpChannel())) { alert('Файлы можно отправить только в WhatsApp, Telegram или MAX'); return; }
  _cmpFile = file;
  const p = document.getElementById('chat-attach-preview');
  p.innerHTML = `📎 ${_chatEsc(file.name)} <span style="color:var(--t3)">(${(file.size / 1024 / 1024).toFixed(1)} МБ)</span>
    <button class="chat-tool-btn" style="font-size:14px" type="button" onclick="_cmpClearFile()">✕</button>`;
  p.style.display = 'flex';
}

function _cmpToggleEmoji() {
  const pop = document.getElementById('chat-emoji-pop');
  if (pop.style.display === 'none') {
    if (!pop.innerHTML) pop.innerHTML = CHAT_EMOJIS.map(e => `<button type="button">${e}</button>`).join('');
    pop.style.display = 'grid';
  } else pop.style.display = 'none';
}

function _cmpInsertEmoji(emoji) {
  const ta = document.getElementById('chat-input');
  const s = ta.selectionStart, e = ta.selectionEnd;
  ta.value = ta.value.slice(0, s) + emoji + ta.value.slice(e);
  ta.selectionStart = ta.selectionEnd = s + emoji.length;
  ta.focus();
}

// Одноразовая привязка обработчиков (SPA — DOM чата живёт всегда).
document.addEventListener('DOMContentLoaded', () => {
  const ta = document.getElementById('chat-input');
  if (!ta) return;
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); _cmpSend(); }
  });
  ta.addEventListener('input', _cmpAutoGrow);
  // Ручное растягивание нативной «ручкой» textarea: если после mousedown→mouseup
  // высота изменилась — пользователь потянул ручку, выключаем авто-рост.
  let _downH = 0;
  ta.addEventListener('mousedown', () => { _downH = ta.offsetHeight; });
  window.addEventListener('mouseup', () => {
    if (_downH && ta.offsetHeight !== _downH) _cmpManualH = true;
    _downH = 0;
  });
  document.getElementById('chat-send-btn').onclick = _cmpSend;
  document.getElementById('chat-emoji-btn').onclick = _cmpToggleEmoji;
  document.getElementById('chat-emoji-pop').onclick = (e) => {
    if (e.target.tagName === 'BUTTON') _cmpInsertEmoji(e.target.textContent);
  };
  document.getElementById('chat-attach-btn').onclick = () =>
    document.getElementById('chat-file-input').click();
  document.getElementById('chat-file-input').onchange = (e) => _cmpPickFile(e.target.files[0]);
  document.addEventListener('click', (e) => {
    const pop = document.getElementById('chat-emoji-pop');
    if (pop && pop.style.display !== 'none'
        && !pop.contains(e.target) && e.target.id !== 'chat-emoji-btn') pop.style.display = 'none';
  });
});

window.chatComposerSetDialog = chatComposerSetDialog;
window._cmpClearFile = _cmpClearFile;
