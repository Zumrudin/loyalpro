'use strict';

// ── Чат (просмотр переписок chatpush) — read-only ───────────────
let _chatDialogs = [];
let _chatActiveKey = null;
let _chatSearch = '';
let _chatPollTimer = null;
let _chatWaitFilter = 'all';   // chat-wait-status.js: 'all'|'waiting'|'operator'|'no_response'
let _chatLoadSeq = 0;
let _chatDialogsReqSeq = 0;
let _chatDialogsAbort = null;

const CHAT_FETCH_TIMEOUT_MS = 15000;

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
// Для групп sender — автор последнего входящего (названия группы Chatpush не отдаёт).
function _chatTitle(d) {
  if (d.isGroup) return 'Группа · ' + (d.senderName || d.key.slice(2));
  if (d.client && d.client.name) return d.client.name;
  if (d.senderName) return d.senderName;
  return d.phone || d.key;
}

// ── Масштаб шрифта переписки (кнопки A−/A+, сохраняется в localStorage) ──
const CHAT_FS_MIN = 13, CHAT_FS_MAX = 26, CHAT_FS_DEF = 15;
function _chatFsRead() {
  const px = Number(localStorage.getItem('lp_chat_fs'));
  return px >= CHAT_FS_MIN && px <= CHAT_FS_MAX ? px : CHAT_FS_DEF;
}
function _chatFsApply(px) {
  const layout = document.querySelector('.chat-layout');
  if (layout) layout.style.setProperty('--chat-fs', px + 'px');
}
function chatFontStep(delta) {
  const px = Math.max(CHAT_FS_MIN, Math.min(CHAT_FS_MAX, _chatFsRead() + delta));
  localStorage.setItem('lp_chat_fs', px);
  _chatFsApply(px);
}

// ── Мобильный режим: на экране видна ОДНА панель — список ИЛИ переписка ──
// Ширина совпадает с общим мобильным брейкпоинтом приложения (base.css, 700px);
// при правке порога менять ОБА места — вёрстка и логика должны переключаться вместе.
const CHAT_MOBILE_MAX = 700;
const _chatIsNarrow = () => window.matchMedia('(max-width:' + CHAT_MOBILE_MAX + 'px)').matches;

// Показать/скрыть панель переписки. На узком экране класс переключает панели,
// на широком видны обе — класс лишь помечает состояние (им же прячется
// шапка страницы на мобильном, чтобы переписке досталась вся высота).
function _chatShowPane(on) {
  const layout = document.querySelector('.chat-layout');
  if (layout) layout.classList.toggle('chat-show-dialog', !!on);
  document.body.classList.toggle('chat-dialog-open', !!on);
}

// Открытый диалог держим в адресе: /#chat/<ключ>. Иначе «Назад» уводило со
// страницы целиком, а обновление страницы теряло переписку.
function _chatSetHash(key) {
  const want = 'chat' + (key ? '/' + encodeURIComponent(key) : '');
  if ((location.hash || '').slice(1) === want) return;
  location.hash = want;
}

// Закрыть переписку и вернуться к списку (кнопка «‹ К чатам» и «Назад» браузера).
function chatCloseDialog(opts) {
  _chatActiveKey = null;
  _chatMsgs = [];
  _chatShowPane(false);
  if (window.chatComposerSetDialog) chatComposerSetDialog(null);
  const headEl = document.getElementById('chat-header');
  if (headEl) { headEl._lastHtml = null; headEl.innerHTML = ''; headEl.classList.remove('active'); }
  const paneEl = document.getElementById('chat-messages');
  if (paneEl) { paneEl._lastHtml = null; paneEl.innerHTML = '<div class="empty">Выберите диалог</div>'; }
  renderChatDialogs();
  if (!(opts && opts.fromHash)) _chatSetHash(null);
}

// Хвост адреса изменился (кнопки «Назад»/«Вперёд») — зовёт роутер (core/nav.js).
function chatOnHashArg(key) {
  if (key) {
    if (key !== _chatActiveKey) openChatDialog(key, { fromHash: true });
    else _chatShowPane(true);
  } else if (_chatActiveKey) {
    chatCloseDialog({ fromHash: true });
  }
}

function _chatAbortDialogsRequest() {
  if (_chatDialogsAbort) {
    _chatDialogsAbort.abort();
    _chatDialogsAbort = null;
  }
}

async function _chatFetchJson(path, { signal } = {}) {
  showLbar(true);
  try {
    const headers = { 'Content-Type': 'application/json' };
    const tok = localStorage.getItem('lp_tk');
    if (tok) headers.Authorization = 'Bearer ' + tok;
    const r = await fetch(path, { method: 'GET', headers, signal });
    if (!r.ok) {
      try {
        const j = await r.json();
        throw new Error(j.error || 'HTTP ' + r.status);
      } catch (e) {
        if (e instanceof SyntaxError) throw new Error('Ошибка сервера (HTTP ' + r.status + ')');
        throw e;
      }
    }
    if (r.status === 204) return null;
    const text = await r.text();
    return text ? JSON.parse(text) : null;
  } finally { showLbar(false); }
}

// Вход на страницу: первичная загрузка + запуск живого обновления.
async function loadChat() {
  const loadSeq = ++_chatLoadSeq;
  _chatFsApply(_chatFsRead());
  _chatShowPane(!!_chatActiveKey);
  // Администратор-кассир видит чат, но не управляет настройками ИИ-агента.
  const agentBtn = document.getElementById('chat-agent-settings-btn');
  if (agentBtn) agentBtn.style.display = (typeof ME !== 'undefined' && ME && ME.role === 'admin_cashier') ? 'none' : '';
  const s = document.getElementById('chat-search');
  if (s) s.value = _chatSearch;
  // Подсказка про Enter/Shift+Enter — про физическую клавиатуру: на телефоне она
  // не про что и не влезала в поле, обрезаясь на полуслове.
  const ta = document.getElementById('chat-input');
  if (ta) ta.placeholder = _chatIsNarrow()
    ? 'Сообщение…' : 'Сообщение… (Enter — отправить, Shift+Enter — перенос)';
  const loaded = await refreshChatDialogs(false);
  if (loadSeq !== _chatLoadSeq || document.body.dataset.page !== 'chat') return;
  if (!loaded) {
    startChatLive();
    return;
  }
  // Deep-link /#chat/<ключ> — открыть диалог сразу после загрузки списка.
  // Хвост адреса ГЛАВНЕЕ памяти модуля: клик по «Чат» в меню перезаписывает hash
  // без хвоста и обязан вернуть человека к списку, а не к прошлому диалогу.
  const fromHash = !window._deepLinkArg;
  const arg = window._deepLinkArg || _chatHashArg();
  window._deepLinkArg = null;
  if (arg) {
    // Переоткрываем ПРИНУДИТЕЛЬНО, даже если этот диалог уже помечен активным:
    // hashchange мог открыть его, пока список ещё грузился, — тогда композер
    // получил заглушку без каналов и отправить из него было нечего.
    _chatActiveKey = null;
    await openChatDialog(arg, { fromHash });
    if (loadSeq !== _chatLoadSeq || document.body.dataset.page !== 'chat') return;
  } else {
    chatCloseDialog({ fromHash: true });
  }
  startChatLive();
}

// Ключ диалога из адреса (/#chat/<ключ>), либо null.
function _chatHashArg() {
  const raw = (location.hash || '').slice(1);
  const [page, ...rest] = raw.split('/');
  if (page !== 'chat' || !rest.length) return null;
  try { return decodeURIComponent(rest.join('/')); } catch { return null; }
}

// Загрузка/обновление списка диалогов. silent=true — фоновой опрос без спиннера.
async function refreshChatDialogs(silent) {
  const listEl = document.getElementById('chat-dialogs');
  if (!listEl) return false;
  const reqSeq = ++_chatDialogsReqSeq;
  _chatAbortDialogsRequest();
  const ctrl = new AbortController();
  _chatDialogsAbort = ctrl;
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    ctrl.abort();
  }, CHAT_FETCH_TIMEOUT_MS);
  if (!silent) {
    listEl._lastHtml = null;
    listEl.innerHTML = '<div class="empty">Загрузка…</div>';
  }
  try {
    const data = await _chatFetchJson('/api/chat/dialogs', { signal: ctrl.signal });
    if (reqSeq !== _chatDialogsReqSeq) return false;
    _chatDialogs = data.dialogs || [];
    renderChatDialogs();
    return true;
  } catch (e) {
    if (reqSeq !== _chatDialogsReqSeq) return false;
    if (e && e.name === 'AbortError' && !timedOut) return false;
    console.error('chat:', e);
    if (!silent) {
      const msg = timedOut
        ? 'Сервер не ответил за 15 секунд. Нажмите «Обновить».'
        : 'Ошибка загрузки диалогов';
      listEl._lastHtml = null;
      listEl.innerHTML = '<div class="empty">' + msg + '</div>';
    }
    return false;
  } finally {
    clearTimeout(timer);
    if (_chatDialogsAbort === ctrl) _chatDialogsAbort = null;
  }
}

// Фильтр списка по имени/номеру. Цифры сравниваем отдельно, игнорируя +, пробелы, скобки.
// Порядок списка: диалоги на операторе — сверху (chat-dialog-sort.js).
// Фильтр по статусу ожидания (chat-wait-status.js) применяется ДО поискового —
// он сужает набор диалогов, поиск ищет уже внутри этого набора.
function _chatFilter() {
  const term = _chatSearch;
  const sorted = chatSortDialogs(_chatDialogs)
    .filter(d => chatWaitMatches(d, _chatWaitFilter));
  if (!term) return sorted;
  const digits = term.replace(/\D/g, '');
  return sorted.filter(d => {
    const name = _chatTitle(d).toLowerCase();
    const phone = (d.phone || d.key || '');
    if (name.includes(term)) return true;
    if (phone.toLowerCase().includes(term)) return true;
    if (digits && phone.replace(/\D/g, '').includes(digits)) return true;
    return false;
  });
}

// Панель фильтров по статусу ожидания над списком диалогов. Счётчики — по
// ВСЕМ загруженным диалогам (не по уже отфильтрованным), иначе выбор одного
// фильтра обнулил бы счётчики соседних чипов.
function renderChatWaitFilters() {
  const el = document.getElementById('chat-wait-filters');
  if (!el) return;
  const counts = { all: _chatDialogs.length, waiting: 0, operator: 0, no_response: 0 };
  for (const d of _chatDialogs) {
    for (const key of ['waiting', 'operator', 'no_response']) {
      if (chatWaitMatches(d, key)) counts[key]++;
    }
  }
  const html = CHAT_WAIT_FILTERS.map(f => {
    const active = f.key === _chatWaitFilter ? ' active' : '';
    return `<button type="button" class="chat-wait-filter${active}" data-wf="${f.key}">` +
      `${_chatEsc(f.label)} <span class="chat-wait-filter-count">${counts[f.key]}</span></button>`;
  }).join('');
  if (el._lastHtml === html) return;
  el._lastHtml = html;
  el.innerHTML = html;
  el.onclick = (e) => {
    const btn = e.target.closest('.chat-wait-filter');
    if (!btn) return;
    _chatWaitFilter = btn.dataset.wf;
    renderChatWaitFilters();
    renderChatDialogs();
  };
}

function renderChatDialogs() {
  const listEl = document.getElementById('chat-dialogs');
  if (!listEl) return;
  renderChatWaitFilters();   // счётчики зависят от _chatDialogs — держим панель свежей
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
    const initial = d.isGroup ? '👥' : _chatEsc((title || '?').trim().charAt(0).toUpperCase());
    // Бот молчит, диалог ждёт администратора — красная карточка (отдельно от
    // чипа: подсветка держится на chatIsEscalated, чип — на chatWaitStatus,
    // который эскалацию тоже учитывает, но приоритетом, а не тем же полем).
    const esc = chatIsEscalated(d) ? ' chat-dialog-escalated' : '';
    const waitSt = chatWaitStatus(d);
    const waitBadge = waitSt
      ? `<span class="chat-badge ${_chatEsc(waitSt.cls)}" title="${_chatEsc(waitSt.title)}">${_chatEsc(waitSt.label)}</span>`
      : '';
    return `
      <div class="chat-dialog${active}${esc}" data-key="${_chatEsc(d.key)}">
        <div class="chat-avatar ${ch.cls}" title="${_chatEsc(ch.label)}">${initial}</div>
        <div class="chat-dialog-body">
          <div class="chat-dialog-top">
            <span class="chat-dialog-name">${_chatEsc(title)}</span>
            ${waitBadge}
            <span class="chat-dialog-time">${_chatTime(d.lastTs)}</span>
          </div>
          ${phone ? `<div class="chat-dialog-phone">${_chatEsc(phone)}</div>` : ''}
          <div class="chat-dialog-preview">${d.lastDirection === 'outgoing' ? '↩ ' : ''}${_chatEsc(d.lastText)}</div>
        </div>
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

async function openChatDialog(key, opts) {
  _chatActiveKey = key;
  _chatShowPane(true);                 // на телефоне переписка занимает весь экран
  if (!(opts && opts.fromHash)) _chatSetHash(key);
  renderChatDialogs();
  const d = _chatDialogs.find(x => x.key === key);
  if (window.chatComposerSetDialog) chatComposerSetDialog(d || { key, channels: [], defaultChannel: null });
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

// ── Хранилище сообщений открытого диалога + инкрементальный рендер ──
let _chatMsgs = [];
let _chatLocalSeq = 0;   // id оптимистичных пузырей (data-local)

const _chatIsGroup = () => String(_chatActiveKey || '').startsWith('g:');

function _chatMsgHtml(m, isGroup) {
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
  // Тег мессенджера под каждым сообщением (если канал известен) —
  // оператор всегда видит, откуда пришло и куда ушло сообщение.
  const ch = _chatChannel(m.channel);
  const chanTag = m.channel
    ? `<span class="chat-chan-tag ${ch.cls}">${_chatEsc(ch.label)}</span>`
    : '';
  const sender = (isGroup && m.direction !== 'outgoing' && m.sender_name)
    ? `<div class="chat-msg-sender">${_chatEsc(m.sender_name)}</div>` : '';
  const pending = m._local ? ` chat-msg-${m._state || 'pending'}` : '';
  const status = m._local ? `<span class="chat-msg-status${m._state === 'failed' ? ' err' : ''}" data-status>${m._state === 'failed' ? '⚠' : '⏳'}</span>` : '';
  return `
    <div class="chat-msg chat-msg-${side}${pending}"${m._local ? ` data-local="${m._local}"` : ''}>
      ${sender}<div class="chat-bubble">${body}</div>
      <div class="chat-msg-time">${chanTag}${status}${_chatTime(m.msg_ts)}</div>
    </div>`;
}

// Полный рендер истории (при открытии диалога / полном обновлении).
function renderChatMessages(messages) {
  const paneEl = document.getElementById('chat-messages');
  if (!paneEl) return;
  _chatMsgs = messages;
  if (!messages.length) {
    paneEl._lastHtml = null;
    paneEl.innerHTML = '<div class="empty">Нет сообщений</div>';
    return;
  }
  const isGroup = _chatIsGroup();
  const html = messages.map(m => _chatMsgHtml(m, isGroup)).join('');
  // Без изменений — не трогаем DOM (сохраняем позицию прокрутки).
  if (paneEl._lastHtml === html) return;
  // Автопрокрутка вниз, только если пользователь и так был у низа переписки.
  const atBottom = paneEl.scrollHeight - paneEl.scrollTop - paneEl.clientHeight < 60;
  const wasEmpty = !paneEl._lastHtml || paneEl._lastHtml.indexOf('chat-msg') === -1;
  paneEl._lastHtml = html;
  paneEl.innerHTML = html;
  if (atBottom || wasEmpty) paneEl.scrollTop = paneEl.scrollHeight;
}

// Дописать одно сообщение в открытый диалог (SSE/доопрос) без перерисовки
// всей истории. Эхо нашей отправки заменяет оптимистичный пузырь с тем же текстом.
function chatAppendMessage(m) {
  const paneEl = document.getElementById('chat-messages');
  if (!paneEl) return;
  if (m.id != null && _chatMsgs.some(x => !x._local && x.id === m.id)) return; // дубль
  if (m.direction === 'outgoing') {
    const local = _chatMsgs.find(x => x._local && (x.text || '') === (m.text || ''));
    if (local) {
      const el = paneEl.querySelector(`[data-local="${local._local}"]`);
      _chatMsgs[_chatMsgs.indexOf(local)] = m;
      if (el) { el.outerHTML = _chatMsgHtml(m, _chatIsGroup()); return; }
    }
  }
  _chatMsgs.push(m);
  if (paneEl.querySelector('.empty')) paneEl.innerHTML = '';
  const atBottom = paneEl.scrollHeight - paneEl.scrollTop - paneEl.clientHeight < 60;
  paneEl.insertAdjacentHTML('beforeend', _chatMsgHtml(m, _chatIsGroup()));
  if (atBottom || m.direction === 'outgoing') paneEl.scrollTop = paneEl.scrollHeight;
}

// ── Оптимистичные пузыри отправки (контракт с chat-composer.js) ──
function chatAppendOptimistic({ text, channel, file }) {
  const id = ++_chatLocalSeq;
  const m = {
    _local: id, _state: 'pending', direction: 'outgoing', channel,
    msg_type: file ? 'document' : 'text',
    text: file && !text ? '📎 ' + file : text,
    msg_ts: Math.floor(Date.now() / 1000),
  };
  _chatMsgs.push(m);
  const paneEl = document.getElementById('chat-messages');
  if (!paneEl) return id;
  if (paneEl.querySelector('.empty')) paneEl.innerHTML = '';
  paneEl.insertAdjacentHTML('beforeend', _chatMsgHtml(m, _chatIsGroup()));
  paneEl.scrollTop = paneEl.scrollHeight;
  return id;
}

function chatResolveOptimistic(id, state, err) {
  const m = _chatMsgs.find(x => x._local === id);
  if (!m) return;
  m._state = state;
  const el = document.querySelector(`#chat-messages [data-local="${id}"]`);
  if (!el) return;
  el.classList.remove('chat-msg-pending', 'chat-msg-failed');
  if (state === 'failed') el.classList.add('chat-msg-failed');
  const st = el.querySelector('[data-status]');
  if (st) {
    st.textContent = state === 'failed' ? ('⚠ ' + (err || 'не отправлено')) : '✓';
    st.classList.toggle('err', state === 'failed');
  }
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
  // На телефоне подпись короткая: полная занимала две строки и выдавливала
  // переписку вниз (шапка и так уже съедает экран кнопкой возврата).
  const label = _chatIsNarrow()
    ? (escalated ? '👤 Оператор' : '🤖 Бот')
    : (escalated ? '👤 Отвечает оператор (бот молчит)' : '🤖 Отвечает бот');
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
    // Не ждём эха собственного SSE — иначе карточка полсекунды висит не в той группе.
    const d = _chatDialogs.find(x => x.key === key);
    if (d) { d.agentStatus = nextStatus; renderChatDialogs(); }
    const headEl = document.getElementById('chat-header');
    if (headEl) headEl._lastHtml = null;   // форсируем перерисовку после смены статуса
    await renderChatHeader(key);
  } catch (e) {
    console.error('chat agent toggle:', e);
    alert('Не удалось переключить режим');
  }
}

// ── Живое обновление: SSE-push + страховочный опрос раз в 30 сек ──
let _chatES = null;

function startChatLive() {
  stopChatLive();
  const tok = localStorage.getItem('lp_tk');
  try {
    // EventSource не умеет заголовки — токен в query (роут authOrQuery).
    _chatES = new EventSource('/api/chat/stream?token=' + encodeURIComponent(tok || ''));
    _chatES.onmessage = (ev) => {
      let data; try { data = JSON.parse(ev.data); } catch { return; }
      if (data.type === 'message') onChatLiveMessage(data);
      else if (data.type === 'agent_status') onChatAgentStatus(data);
      else if (data.type === 'followup_status') onChatFollowupStatus(data);
    };
  } catch (e) { console.error('chat SSE:', e); }
  // Страховка на случай упавшего SSE: редкий инкрементальный доопрос.
  _chatPollTimer = setInterval(pollChat, 30000);
}

function stopChatLive() {
  _chatLoadSeq++;
  _chatAbortDialogsRequest();
  if (_chatES) { _chatES.close(); _chatES = null; }
  if (_chatPollTimer) { clearInterval(_chatPollTimer); _chatPollTimer = null; }
}

// Пришло сообщение по SSE: дописываем в открытый диалог и обновляем карточку
// в списке локально — без запроса на сервер.
function onChatLiveMessage({ dialogKey, message }) {
  if (dialogKey === _chatActiveKey) chatAppendMessage(message);
  const d = _chatDialogs.find(x => x.key === dialogKey);
  if (d) {
    const isText = !message.msg_type || String(message.msg_type).toLowerCase().includes('text');
    d.lastText = isText ? (message.text || '') : '📎 Вложение';
    d.lastTs = message.msg_ts;
    d.lastDirection = message.direction;
    if (message.direction === 'incoming') {
      d.senderName = message.sender_name || d.senderName;
      d.channel = message.channel || d.channel;
      d.defaultChannel = message.channel || d.defaultChannel;
      if (d.channels && message.channel && !d.channels.includes(message.channel)) {
        d.channels.push(message.channel);
      }
    }
    renderChatDialogs();   // порядок пересчитает _chatFilter (chatSortDialogs)
  } else {
    refreshChatDialogs(true);   // новый диалог — перечитать список
  }
}

// Диалог передали оператору или вернули боту (эскалация Милы, ручной ответ,
// кнопка в шапке — в т.ч. из соседней вкладки). Красим/раскрашиваем карточку и
// пересортировываем список; открытому диалогу обновляем баннер в шапке.
function onChatAgentStatus({ dialogKey, status, reason }) {
  const d = _chatDialogs.find(x => x.key === dialogKey);
  if (!d) { refreshChatDialogs(true); return; }   // диалога ещё нет в списке
  if (d.agentStatus === status) return;
  d.agentStatus = status;
  d.escalatedReason = reason || null;
  renderChatDialogs();
  if (dialogKey === _chatActiveKey) {
    const headEl = document.getElementById('chat-header');
    if (headEl) headEl._lastHtml = null;   // форсируем перерисовку баннера
    renderChatHeader(dialogKey);
  }
}

// Смена стадии ожидания ответа клиента (agent_followups): чип и счётчики
// панели фильтров обязаны обновиться без F5 — тот же приём, что onChatAgentStatus.
function onChatFollowupStatus({ dialogKey, status, stage }) {
  const d = _chatDialogs.find(x => x.key === dialogKey);
  if (!d) { refreshChatDialogs(true); return; }   // диалога ещё нет в списке
  if (d.followupStatus === status && d.followupStage === stage) return;
  d.followupStatus = status;
  d.followupStage = stage == null ? null : Number(stage);
  renderChatDialogs();
}

async function pollChat() {
  if (document.hidden) return;             // вкладка неактивна — не дёргаем сервер
  await refreshChatDialogs(true);
  if (_chatActiveKey) {
    const key = _chatActiveKey;
    const last = _chatMsgs.filter(m => !m._local)
      .reduce((mx, m) => Math.max(mx, Number(m.msg_ts) || 0), 0);
    try {
      const data = await api('GET', '/api/chat/dialogs/' + encodeURIComponent(key) + '/messages?after=' + last);
      if (_chatActiveKey !== key) return;
      for (const m of (data.messages || [])) chatAppendMessage(m);
    } catch (e) { console.error('chat poll:', e); }
    await renderChatHeader(key);
  }
}

window.loadChat = loadChat;
window.openChatDialog = openChatDialog;
window.chatCloseDialog = chatCloseDialog;
window.chatOnHashArg = chatOnHashArg;   // зовёт роутер на hashchange (core/nav.js)
window.onChatSearch = onChatSearch;
window.stopChatPolling = stopChatLive;   // имя сохранено — его зовёт роутер при уходе со страницы
window.chatAppendOptimistic = chatAppendOptimistic;
window.chatResolveOptimistic = chatResolveOptimistic;
window.chatFontStep = chatFontStep;
