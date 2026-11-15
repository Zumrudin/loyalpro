// Журнал записи: вкладка «Чат» в панели клиента карточки записи (13.11.2026).
// Общая глобальная область с journal.js (префикс jrCh). Переписка — та же, что
// на странице «Чат» (/api/chat, ключ диалога = номер клиента 7XXXXXXXXXX);
// ответ уходит тем же POST /dialogs/:key/send, что ручной ответ оператора, и
// так же ставит Милу на паузу. Новые сообщения догружаются опросом, пока вкладка
// открыта; закрытие карточки (modalRequest++) останавливает опрос сам.
const JR_CH_LABELS = { whatsapp: 'WhatsApp', tdlib: 'Telegram', telegram_bot: 'Telegram (бот)', max: 'MAX', max_bot: 'MAX (бот)' };
// WhatsApp и MAX адресуются по номеру — доступны и без переписки; Telegram — только
// если клиент сам писал (нужен chat_id из входящего), как в chat-composer.js.
const JR_CH_PHONE_CHANNELS = ['whatsapp', 'max'];
const JR_CH_ORDER = ['whatsapp', 'max', 'max_bot', 'tdlib', 'telegram_bot'];
const JR_CH_POLL_MS = 5000;

async function jrChatApi(path, body) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30000);
  try {
    const response = await fetch('/api/chat/' + path, {
      signal: controller.signal, method: body ? 'POST' : 'GET', cache: 'no-store',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + TOKEN },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    let data;
    try { data = await response.json(); } catch (_) { throw new Error('Сервер не ответил.'); }
    if (!response.ok) throw new Error(data.error || 'Не удалось выполнить действие.');
    return data;
  } catch (e) { if (e.name === 'AbortError') throw new Error('Время ожидания истекло.'); throw e; }
  finally { clearTimeout(timer); }
}
// Ключ личного диалога — номер в каноне (так его пишет вебхук). Нет номера → null.
function jrChatKey(record) {
  let d = String(record?.clientPhone || '').replace(/\D/g, '');
  if (d.length === 11 && d[0] === '8') d = '7' + d.slice(1);
  if (d.length === 10) d = '7' + d;
  return /^\d{11,15}$/.test(d) ? d : null;
}
function jrChatChannels(messages) {
  const set = new Set((messages || []).filter(m => m.direction === 'incoming' && m.channel).map(m => m.channel));
  JR_CH_PHONE_CHANNELS.forEach(c => set.add(c));
  const rank = c => { const i = JR_CH_ORDER.indexOf(c); return i < 0 ? 99 : i; };
  return [...set].filter(c => JR_CH_LABELS[c]).sort((a, b) => rank(a) - rank(b));
}
// Отвечаем туда, куда клиент писал последним; без входящих — канал последнего сообщения.
function jrChatDefaultChannel(messages, channels) {
  const list = (messages || []).filter(m => !m._local);
  const last = [...list].reverse().find(m => m.direction === 'incoming' && channels.includes(m.channel))
    || [...list].reverse().find(m => channels.includes(m.channel));
  return last ? last.channel : channels[0] || '';
}
const jrChatTime = ts => {
  const n = Number(ts);
  if (!Number.isFinite(n) || n <= 0) return '';
  return new Date(n * 1000).toLocaleString('ru', { timeZone: 'Europe/Moscow', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
};
function jrChatSafeUrl(u) {
  const s = String(u || '');
  return /^https?:\/\//i.test(s) || /^\/uploads\//.test(s) ? s : null;
}
function jrChatMsgHtml(m) {
  const side = m.direction === 'outgoing' ? 'out' : 'in';
  const isText = !m.msg_type || String(m.msg_type).toLowerCase().includes('text');
  const url = jrChatSafeUrl(m.file_url);
  const body = isText ? jrEscape(m.text || '')
    : (url ? `<a href="${jrEscape(url)}" target="_blank" rel="noopener">📎 Вложение</a>` : '📎 Вложение') + (m.text ? `<div>${jrEscape(m.text)}</div>` : '');
  const state = m._local ? (m._state === 'failed' ? ` <span class="jr-chat-err">⚠ ${jrEscape(m._error || 'не отправлено')}</span>` : ' ⏳') : '';
  return `<div class="chat-msg chat-msg-${side}${m._local ? ' jr-chat-local' : ''}"><div class="chat-bubble">${body}</div><div class="chat-msg-time">${m.channel ? `<span class="jr-chat-chan">${jrEscape(JR_CH_LABELS[m.channel] || m.channel)}</span>` : ''}${jrEscape(jrChatTime(m.msg_ts))}${state}</div></div>`;
}
function jrChatRenderMessages() {
  const box = jrEl('jrChatMessages'), c = journal.chat;
  if (!box || !c) return;
  const atBottom = !box.innerHTML || box.scrollHeight - box.scrollTop - box.clientHeight < 60;
  box.innerHTML = c.messages.length ? c.messages.map(jrChatMsgHtml).join('')
    : '<p class="jr-hint jr-chat-empty">Переписки с клиентом пока нет. Можно написать первым — в WhatsApp или MAX по номеру.</p>';
  if (atBottom) box.scrollTop = box.scrollHeight;
}
function jrChatRenderStatus() {
  const box = jrEl('jrChatStatus'), c = journal.chat;
  if (!box || !c) return;
  box.innerHTML = c.agent === 'escalated'
    ? '<span>Мила на паузе — отвечает администратор.</span><button type="button" class="jr-link-btn" id="jrChatToBot">Вернуть боту</button>'
    : c.agent === 'bot' ? '<span>Отвечает Мила. Ваш ответ поставит её на паузу.</span>' : '';
  const back = jrEl('jrChatToBot');
  if (back) back.onclick = () => jrChatSetAgent('bot');
}
function jrChatRenderChannels() {
  const sel = jrEl('jrChatChannel'), c = journal.chat;
  if (!sel || !c) return;
  const channels = jrChatChannels(c.messages);
  const current = sel.value && channels.includes(sel.value) ? sel.value : jrChatDefaultChannel(c.messages, channels);
  sel.innerHTML = channels.map(ch => `<option value="${jrEscape(ch)}"${ch === current ? ' selected' : ''}>${jrEscape(JR_CH_LABELS[ch])}</option>`).join('');
  sel.disabled = !channels.length;
}
// The card's client panel: tabs switch panes without re-rendering the card
// (unsaved card edits survive a look at the chat).
function jrChatShowTab(record, tab) {
  const chat = tab === 'chat';
  const pane = jrEl('jrChatPane'), client = jrEl('jrClientPane');
  if (!pane || !client) return;
  pane.hidden = !chat; client.hidden = chat;
  for (const id of ['jrTabClient', 'jrTabChat']) {
    const el = jrEl(id);
    const on = (id === 'jrTabChat') === chat;
    el?.classList?.toggle('is-active', on);
    el?.setAttribute?.('aria-selected', String(on));
  }
  if (chat) return jrChatOpen(record);
  jrChatStop();
}
async function jrChatOpen(record) {
  const pane = jrEl('jrChatPane');
  const key = jrChatKey(record);
  if (!key) { pane.innerHTML = '<p class="jr-hint">Телефон клиента неизвестен — переписку не найти.</p>'; return false; }
  const request = journal.modalRequest;
  const kept = journal.chat?.request === request && journal.chat.key === key ? journal.chat : null;
  journal.chat = kept || { request, key, messages: [], agent: null, timer: null, seq: 0, record };
  pane.innerHTML = `<div class="jr-chat-head"><div id="jrChatStatus" class="jr-chat-status"></div><button type="button" class="jr-link-btn" id="jrChatOpenPage" title="Открыть переписку на странице «Чат»">Открыть в «Чате» ›</button></div>
    <div id="jrChatMessages" class="jr-chat-messages" aria-live="polite">${kept ? '' : '<p class="jr-hint">Загрузка переписки…</p>'}</div>
    <div class="jr-chat-composer"><select id="jrChatChannel" aria-label="Мессенджер"></select><textarea id="jrChatInput" rows="2" maxlength="3500" placeholder="Сообщение клиенту…" title="Enter — отправить, Shift+Enter — новая строка"></textarea><button type="button" class="btn btn-pri" id="jrChatSend">Отправить</button></div>`;
  jrEl('jrChatSend').onclick = () => jrChatSend();
  jrEl('jrChatInput').onkeydown = e => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); jrChatSend(); } };
  jrEl('jrChatOpenPage').onclick = () => jrChatOpenPage(key);
  if (kept) { jrChatRenderMessages(); jrChatRenderChannels(); jrChatRenderStatus(); }
  await jrChatLoad(!kept);
  return true;
}
async function jrChatLoad(full) {
  const c = journal.chat;
  if (!c || c.request !== journal.modalRequest) return;
  clearTimeout(c.timer); c.timer = null;
  try {
    const last = c.messages.filter(m => !m._local).reduce((max, m) => Math.max(max, Number(m.msg_ts) || 0), 0);
    const [data, agent] = await Promise.all([
      jrChatApi(`dialogs/${encodeURIComponent(c.key)}/messages${!full && last ? '?after=' + last : ''}`),
      jrChatApi(`dialogs/${encodeURIComponent(c.key)}/agent`).catch(() => null),
    ]);
    if (journal.chat !== c || c.request !== journal.modalRequest) return;
    if (full) c.messages = (data.messages || []).slice();
    else for (const m of data.messages || []) jrChatMerge(m);
    if (agent) c.agent = agent.status;
    jrChatRenderMessages(); jrChatRenderChannels(); jrChatRenderStatus();
  } catch (e) {
    if (journal.chat !== c) return;
    if (full && jrEl('jrChatMessages')) jrEl('jrChatMessages').innerHTML = `<p class="jr-hint">Не удалось загрузить переписку: ${jrEscape(e.message)}</p>`;
  }
  jrChatSchedule();
}
// New message from the server; the echo of our own send replaces its optimistic bubble.
function jrChatMerge(m) {
  const c = journal.chat;
  if (m.id != null && c.messages.some(x => !x._local && x.id === m.id)) return;
  if (m.direction === 'outgoing') {
    const local = c.messages.findIndex(x => x._local && x._state !== 'failed' && (x.text || '') === (m.text || ''));
    if (local >= 0) { c.messages[local] = m; return; }
  }
  c.messages.push(m);
}
function jrChatSchedule() {
  const c = journal.chat;
  if (!c) return;
  clearTimeout(c.timer);
  c.timer = setTimeout(() => {
    const live = journal.chat === c && c.request === journal.modalRequest && jrEl('jrModal')?.open && jrEl('jrChatPane') && !jrEl('jrChatPane').hidden;
    if (!live) { c.timer = null; return; }
    if (typeof document !== 'undefined' && document.hidden) return jrChatSchedule();
    jrChatLoad(false);
  }, JR_CH_POLL_MS);
}
function jrChatStop() {
  if (journal.chat) { clearTimeout(journal.chat.timer); journal.chat.timer = null; }
}
async function jrChatSend() {
  const c = journal.chat, input = jrEl('jrChatInput'), channel = jrEl('jrChatChannel')?.value;
  if (!c || !input || c.sending) return false;
  const text = String(input.value || '').trim();
  if (!text) return false;
  if (!channel) { notify('Выберите мессенджер.', 'err'); return false; }
  const local = { _local: ++c.seq, _state: 'pending', direction: 'outgoing', channel, msg_type: 'text', text, msg_ts: Math.floor(Date.now() / 1000) };
  c.messages.push(local); c.sending = true;
  input.value = '';
  jrChatRenderMessages();
  try {
    await jrChatApi(`dialogs/${encodeURIComponent(c.key)}/send`, { text, channel });
    if (journal.chat !== c) return true;
    local._state = 'sent'; c.agent = 'escalated'; // the server pauses Mila on an operator reply
    jrChatRenderMessages(); jrChatRenderStatus();
    return true;
  } catch (e) {
    local._state = 'failed'; local._error = e.message;
    if (journal.chat === c) jrChatRenderMessages();
    return false;
  } finally { c.sending = false; }
}
async function jrChatSetAgent(status) {
  const c = journal.chat;
  if (!c) return;
  try {
    await jrChatApi(`dialogs/${encodeURIComponent(c.key)}/agent`, { status });
    if (journal.chat !== c) return;
    c.agent = status; jrChatRenderStatus();
    notify(status === 'bot' ? 'Диалог возвращён Миле.' : 'Мила на паузе.');
  } catch (e) { notify(e.message, 'err'); }
}
// «Открыть в «Чате»»: the journal dialog is modal, close it first (unsaved edits ask, as on ✕).
function jrChatOpenPage(key) {
  const kind = jrUnsavedKind();
  if (kind) return jrAskClose(kind);
  if (typeof navTo !== 'function') return;
  jrClose(true);
  window._deepLinkArg = key;
  location.hash = '#chat/' + key;
  navTo('chat');
}
