# Админ-страница «Чат» (просмотр переписок chatpush) — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Добавить read-only страницу «Чат» в веб-интерфейсе персонала для просмотра диалогов и истории сообщений, приходящих через chatpush.

**Architecture:** Двухпанельный мессенджер поверх существующей таблицы `chatpush_messages`. Бэкенд — 2 GET-эндпоинта под `/api/chat` (owner/admin), диалоги группируются по `COALESCE(NULLIF(phone,''), chat_id)`. Фронтенд — новый модуль страницы в ванильном SPA. Ничего не отправляется и не пишется в БД.

**Tech Stack:** Node.js/Express, PostgreSQL (`pg` через `db`), Jest (юнит-тесты чистых хелперов), ванильный JS + CSS-переменные фронтенда.

**Spec:** `docs/superpowers/specs/2026-07-18-admin-chat-page-design.md`

---

### Task 1: Чистые хелперы форматирования + юнит-тесты

Чистые функции (без БД/HTTP), разделяемые роутом и тестируемые Jest — по образцу `services/portfolio.js` + `portfolio.test.js`.

**Files:**
- Create: `backend/services/chat.js`
- Test: `backend/chat.test.js`

- [ ] **Step 1: Написать падающий тест**

Создать `backend/chat.test.js`:

```js
'use strict';
const { dialogKey, isMedia, mediaLabel, messagePreview } = require('./services/chat');

describe('dialogKey', () => {
  test('prefers phone', () => {
    expect(dialogKey({ phone: '+79991234567', chat_id: 'c1' })).toBe('+79991234567');
  });
  test('falls back to chat_id when phone empty/blank', () => {
    expect(dialogKey({ phone: '', chat_id: 'c1' })).toBe('c1');
    expect(dialogKey({ phone: '   ', chat_id: 'c1' })).toBe('c1');
  });
  test('empty string when neither present', () => {
    expect(dialogKey({})).toBe('');
  });
});

describe('isMedia', () => {
  test('text types are not media', () => {
    expect(isMedia('text')).toBe(false);
    expect(isMedia('formattedText')).toBe(false);
    expect(isMedia('')).toBe(false);
  });
  test('non-text types are media', () => {
    expect(isMedia('document')).toBe(true);
    expect(isMedia('image')).toBe(true);
  });
});

describe('mediaLabel', () => {
  test('maps known types', () => {
    expect(mediaLabel('image')).toBe('📎 Фото');
    expect(mediaLabel('video')).toBe('📎 Видео');
    expect(mediaLabel('voice')).toBe('📎 Аудио');
    expect(mediaLabel('document')).toBe('📎 Документ');
  });
  test('falls back to generic attachment', () => {
    expect(mediaLabel('sticker')).toBe('📎 Вложение');
  });
});

describe('messagePreview', () => {
  test('returns trimmed text for text messages', () => {
    expect(messagePreview({ msg_type: 'text', text: '  привет  ' })).toBe('привет');
  });
  test('returns attachment label for media', () => {
    expect(messagePreview({ msg_type: 'document', text: '' })).toBe('📎 Документ');
  });
  test('empty for null', () => {
    expect(messagePreview(null)).toBe('');
  });
});
```

- [ ] **Step 2: Запустить тест — убедиться, что падает**

Run: `cd backend && npx jest chat.test.js`
Expected: FAIL — `Cannot find module './services/chat'`.

- [ ] **Step 3: Реализовать хелперы**

Создать `backend/services/chat.js`:

```js
'use strict';
// ============================================================
// Chat — чистые хелперы форматирования (без БД/HTTP).
// Разделяются routes/chat.js; юнит-тесты в backend/chat.test.js.
// ============================================================

// Ключ диалога: сначала phone, иначе chat_id. Зеркалит SQL-выражение
// COALESCE(NULLIF(phone,''), chat_id) в routes/chat.js — фронт и бэк
// одинаково понимают «один диалог».
function dialogKey(row) {
  const phone = row && row.phone ? String(row.phone).trim() : '';
  if (phone) return phone;
  return row && row.chat_id ? String(row.chat_id) : '';
}

// Медиа (вложение), а не текст? Текстовые типы chatpush: text, formattedText.
function isMedia(msgType) {
  const t = String(msgType || '').toLowerCase();
  if (!t) return false;
  return !t.includes('text');
}

// Человекочитаемая метка (RU) для вложения, с эмодзи-скрепкой.
function mediaLabel(msgType) {
  const t = String(msgType || '').toLowerCase();
  if (t.includes('image') || t.includes('photo')) return '📎 Фото';
  if (t.includes('video')) return '📎 Видео';
  if (t.includes('audio') || t.includes('voice')) return '📎 Аудио';
  if (t.includes('document') || t.includes('file')) return '📎 Документ';
  return '📎 Вложение';
}

// Однострочный превью для списка диалогов: текст для текстовых сообщений,
// метка вложения — для медиа.
function messagePreview(msg) {
  if (!msg) return '';
  if (isMedia(msg.msg_type)) return mediaLabel(msg.msg_type);
  return String(msg.text || '').trim();
}

module.exports = { dialogKey, isMedia, mediaLabel, messagePreview };
```

- [ ] **Step 4: Запустить тест — убедиться, что проходит**

Run: `cd backend && npx jest chat.test.js`
Expected: PASS — все тесты зелёные.

- [ ] **Step 5: Коммит**

```bash
git add backend/services/chat.js backend/chat.test.js
git commit -m "feat(chat): чистые хелперы форматирования диалогов + юнит-тесты"
```

---

### Task 2: Бэкенд-роут `/api/chat` (2 GET-эндпоинта) + монтирование

Read-only роут: список диалогов и история одного диалога. Доступ owner/admin (`specialist` отсекается guard'ом). Скоуп по `req.user.salonId`.

**Files:**
- Create: `backend/routes/chat.js`
- Modify: `backend/routes/index.js:58` (добавить строку монтирования после `/api/portfolio`)

- [ ] **Step 1: Создать роут**

Создать `backend/routes/chat.js`:

```js
'use strict';
// ============================================================
// Chat (read-only) — просмотр переписок chatpush.
// ------------------------------------------------------------
// Диалоги неявно группируются по (salon_id, phone|chat_id) поверх таблицы
// chatpush_messages (её наполняет routes/chatpush-webhook.js). Только чтение:
// ни отправки, ни записи в БД. Доступ — owner/admin.
// ============================================================
const router = require('express').Router();
const { db } = require('../db');
const { auth, requireRole } = require('../middleware/auth');
const { messagePreview } = require('../services/chat');
const { createLogger } = require('../logger');
const logger = createLogger('Chat');

const adminOnly = [auth, requireRole('owner', 'admin')];

// GET /api/chat/dialogs — список диалогов салона (последнее сообщение + счётчик).
router.get('/dialogs', adminOnly, async (req, res) => {
  try {
    const salonId = req.user.salonId;
    const { rows } = await db.query(`
      SELECT d.dialog_key, d.channel, d.sender_name,
             d.direction  AS last_direction,
             d.msg_type   AS last_msg_type,
             d.text       AS last_text,
             d.msg_ts     AS last_ts,
             d.client_id, cl.name AS client_name,
             c.cnt        AS messages_count
      FROM (
        SELECT DISTINCT ON (COALESCE(NULLIF(phone,''), chat_id))
               COALESCE(NULLIF(phone,''), chat_id) AS dialog_key,
               channel, sender_name, direction, msg_type, text, msg_ts, client_id
        FROM chatpush_messages
        WHERE salon_id = $1
        ORDER BY COALESCE(NULLIF(phone,''), chat_id), msg_ts DESC
      ) d
      JOIN (
        SELECT COALESCE(NULLIF(phone,''), chat_id) AS dialog_key, COUNT(*) AS cnt
        FROM chatpush_messages
        WHERE salon_id = $1
        GROUP BY COALESCE(NULLIF(phone,''), chat_id)
      ) c ON c.dialog_key = d.dialog_key
      LEFT JOIN clients cl ON cl.id = d.client_id AND cl.salon_id = $1
      ORDER BY d.msg_ts DESC
    `, [salonId]);

    const dialogs = rows.map(r => ({
      key:           r.dialog_key,
      channel:       r.channel,
      senderName:    r.sender_name,
      lastDirection: r.last_direction,
      lastText:      messagePreview({ msg_type: r.last_msg_type, text: r.last_text }),
      lastTs:        r.last_ts,
      messagesCount: Number(r.messages_count) || 0,
      client:        r.client_id ? { id: r.client_id, name: r.client_name } : null,
    }));
    res.json({ dialogs });
  } catch (e) {
    logger.error(`dialogs failed: ${e.message}`);
    res.status(500).json({ error: 'Не удалось загрузить диалоги' });
  }
});

// GET /api/chat/dialogs/:key/messages — история одного диалога (по возрастанию).
router.get('/dialogs/:key/messages', adminOnly, async (req, res) => {
  try {
    const salonId = req.user.salonId;
    const key = String(req.params.key || '');
    if (!key) return res.status(400).json({ error: 'Пустой ключ диалога' });
    const { rows } = await db.query(`
      SELECT id, direction, channel, msg_type, text, file_url, mime_type,
             sender_name, msg_ts
      FROM chatpush_messages
      WHERE salon_id = $1 AND COALESCE(NULLIF(phone,''), chat_id) = $2
      ORDER BY msg_ts ASC
    `, [salonId, key]);
    res.json({ messages: rows });
  } catch (e) {
    logger.error(`messages failed: ${e.message}`);
    res.status(500).json({ error: 'Не удалось загрузить сообщения' });
  }
});

module.exports = router;
```

- [ ] **Step 2: Смонтировать роут**

В `backend/routes/index.js` после строки 58 (`app.use('/api/portfolio', require('./portfolio'));`) добавить:

```js
  app.use('/api/chat',              require('./chat'));
```

(Важно: строка должна стоять ВЫШЕ wildcard-роутеров `app.use('/api', require('./staff'))` и `app.use('/api', require('./api'))` на строках 68/71 — иначе `/api/chat` перехватит wildcard. Место среди «specific prefix routes» это гарантирует.)

- [ ] **Step 3: Проверить, что сервер стартует без ошибок**

Run: `cd backend && node -e "require('./routes/chat'); console.log('route loads OK')"`
Expected: `route loads OK` (модуль подключается без синтаксических ошибок и без падения на require зависимостей).

- [ ] **Step 4: Дымовой тест эндпоинта (dev-сервер уже поднят на :3001)**

Получить рабочий JWT owner/admin из локального входа и дёрнуть эндпоинт. Замените `<TOKEN>` на актуальный (можно взять из localStorage `lp_tk` в браузере dev-стенда или через `/api/auth/login`):

Run:
```bash
curl -s -H "Authorization: Bearer <TOKEN>" http://localhost:3001/api/chat/dialogs
```
Expected: HTTP 200, JSON вида `{"dialogs":[...]}` (массив может быть пустым — это нормально, если сообщений ещё нет). Без токена — `{"error":"Unauthorized"}`.

- [ ] **Step 5: Коммит**

```bash
git add backend/routes/chat.js backend/routes/index.js
git commit -m "feat(chat): read-only API /api/chat/dialogs и история диалога"
```

---

### Task 3: Фронтенд — модуль страницы `chat.js`

Логика страницы: список диалогов слева, история справа. По образцу `frontend/js/pages/portfolio.js` (module state, локальный `_esc`, экспорт в `window`).

**Files:**
- Create: `frontend/js/pages/chat.js`

- [ ] **Step 1: Создать модуль страницы**

Создать `frontend/js/pages/chat.js`:

```js
'use strict';

// ── Чат (просмотр переписок chatpush) — read-only ───────────────
let _chatDialogs = [];
let _chatActiveKey = null;

const _chatEsc = (s) => String(s ?? '').replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

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
      <div class="chat-dialog${active}" onclick="openChatDialog('${_chatEsc(d.key)}')">
        <div class="chat-dialog-top">
          <span class="chat-badge ${ch.cls}">${_chatEsc(ch.label)}</span>
          <span class="chat-dialog-name">${_chatEsc(title)}</span>
          <span class="chat-dialog-time">${_chatTime(d.lastTs)}</span>
        </div>
        <div class="chat-dialog-preview">${_chatEsc(d.lastText)}</div>
      </div>`;
  }).join('');
}

async function openChatDialog(key) {
  _chatActiveKey = key;
  renderChatDialogs();
  const paneEl = document.getElementById('chat-messages');
  paneEl.innerHTML = '<div class="empty">Загрузка…</div>';
  try {
    const data = await api('GET', '/api/chat/dialogs/' + encodeURIComponent(key) + '/messages');
    renderChatMessages(data.messages || []);
  } catch (e) {
    paneEl.innerHTML = '<div class="empty">Ошибка загрузки сообщений</div>';
  }
}

function renderChatMessages(messages) {
  const paneEl = document.getElementById('chat-messages');
  if (!messages.length) {
    paneEl.innerHTML = '<div class="empty">Нет сообщений</div>';
    return;
  }
  paneEl.innerHTML = messages.map(m => {
    const side = m.direction === 'outgoing' ? 'out' : 'in';
    const isText = !m.msg_type || String(m.msg_type).toLowerCase().includes('text');
    let body;
    if (isText) {
      body = _chatEsc(m.text || '');
    } else if (m.file_url) {
      body = `<a href="${_chatEsc(m.file_url)}" target="_blank" rel="noopener">📎 Вложение</a>` +
             (m.text ? `<div>${_chatEsc(m.text)}</div>` : '');
    } else {
      body = '📎 Вложение';
    }
    return `
      <div class="chat-msg chat-msg-${side}">
        <div class="chat-bubble">${body}</div>
        <div class="chat-msg-time">${_chatTime(m.msg_ts)}</div>
      </div>`;
  }).join('');
  paneEl.scrollTop = paneEl.scrollHeight;
}

window.loadChat = loadChat;
window.openChatDialog = openChatDialog;
```

- [ ] **Step 2: Коммит**

```bash
git add frontend/js/pages/chat.js
git commit -m "feat(chat): фронтенд-модуль страницы чата (список диалогов + история)"
```

---

### Task 4: Фронтенд — интеграция в SPA (HTML, роутер, подключение скрипта)

Пункт меню, блок страницы, ветка роутера и подключение скрипта.

**Files:**
- Modify: `frontend/index.html:97` и `:138` (пункты меню), вставка блока страницы перед `:1126`, подключение скрипта после `:1884`
- Modify: `frontend/js/core/nav.js:27` (ветка роутера)

- [ ] **Step 1: Пункт меню в десктоп-навигацию**

В `frontend/index.html` после строки 97 (`<div class="tn" data-p="broadcasts" ...>📨 Рассылка</div>` в `#mainNav`) добавить:

```html
      <div class="tn" data-p="chat" data-roles="owner,admin" onclick="nav(this)">💬 Чат</div>
```

- [ ] **Step 2: Пункт меню в мобильную навигацию**

В `frontend/index.html` после строки 138 (тот же `broadcasts`-пункт, но в `#mnavList`) добавить ту же строку:

```html
      <div class="tn" data-p="chat" data-roles="owner,admin" onclick="nav(this)">💬 Чат</div>
```

- [ ] **Step 3: Блок страницы**

В `frontend/index.html` непосредственно перед строкой 1126 (`<div class="page" id="page-cert-requests"></div>`) вставить:

```html
    <!-- ═══ ЧАТ (просмотр переписок chatpush) ═══ -->
    <div class="page" id="page-chat">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px">
        <div style="font-size:16px;font-weight:700">💬 Чат</div>
        <button class="btn btn-sec" onclick="loadChat()">↻ Обновить</button>
      </div>
      <div class="chat-layout">
        <div class="chat-sidebar" id="chat-dialogs">
          <div class="empty">Загрузка…</div>
        </div>
        <div class="chat-main" id="chat-messages">
          <div class="empty">Выберите диалог</div>
        </div>
      </div>
    </div>
```

- [ ] **Step 4: Подключить скрипт страницы**

В `frontend/index.html` после строки 1884 (`<script src="js/pages/portfolio.js"></script>`) добавить:

```html
<script src="js/pages/chat.js"></script>
```

(Должно оставаться ВЫШЕ `<script src="js/app.js"></script>` на строке 1897 — `app.js` подключается последним.)

- [ ] **Step 5: Ветка роутера**

В `frontend/js/core/nav.js` после строки 27 (`if (p === 'broadcasts')      loadBroadcasts();`) добавить:

```js
  if (p === 'chat')            loadChat();
```

- [ ] **Step 6: Коммит**

```bash
git add frontend/index.html frontend/js/core/nav.js
git commit -m "feat(chat): пункт меню, страница и роутинг чата в SPA"
```

---

### Task 5: Фронтенд — стили чата

Стили двухпанельного layout, списка диалогов, пузырей и бейджей каналов. Используем существующие CSS-переменные темы (`--a`, `--bd`, `--card`, `--bg`, `--t1/2/3`, `--r`).

**Files:**
- Modify: `frontend/css/features.css` (добавить в конец файла)

- [ ] **Step 1: Добавить CSS**

В конец `frontend/css/features.css` добавить:

```css
/* ── Чат (просмотр переписок chatpush) ─────────────────────── */
.chat-layout { display:flex; gap:12px; height:calc(100vh - 200px); min-height:420px; }
.chat-sidebar { flex:0 0 300px; overflow-y:auto; border:1px solid var(--bd); border-radius:var(--r); background:var(--card); }
.chat-main { flex:1; overflow-y:auto; border:1px solid var(--bd); border-radius:var(--r); background:var(--card); padding:14px; display:flex; flex-direction:column; gap:8px; }
.chat-dialog { padding:10px 12px; border-bottom:1px solid var(--bd); cursor:pointer; }
.chat-dialog:hover { background:var(--bg); }
.chat-dialog.active { background:var(--bg); border-left:3px solid var(--a); }
.chat-dialog-top { display:flex; align-items:center; gap:6px; }
.chat-dialog-name { font-weight:600; font-size:13px; flex:1; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.chat-dialog-time { font-size:11px; color:var(--t3); white-space:nowrap; }
.chat-dialog-preview { font-size:12px; color:var(--t2); margin-top:3px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.chat-badge { font-size:10px; padding:1px 6px; border-radius:8px; color:#fff; white-space:nowrap; }
.chan-wa  { background:#25d366; }
.chan-tg  { background:#28a8e9; }
.chan-max { background:#8b5cf6; }
.chan-def { background:#8b949e; }
.chat-msg { display:flex; flex-direction:column; max-width:75%; }
.chat-msg-in  { align-self:flex-start; align-items:flex-start; }
.chat-msg-out { align-self:flex-end;   align-items:flex-end; }
.chat-bubble { padding:8px 12px; border-radius:12px; font-size:13px; white-space:pre-wrap; word-break:break-word; }
.chat-msg-in  .chat-bubble { background:var(--bg); color:var(--t1); border-bottom-left-radius:3px; }
.chat-msg-out .chat-bubble { background:var(--a);  color:#fff;      border-bottom-right-radius:3px; }
.chat-bubble a { color:inherit; text-decoration:underline; }
.chat-msg-time { font-size:10px; color:var(--t3); margin-top:2px; }
@media (max-width:640px) {
  .chat-layout { flex-direction:column; height:auto; }
  .chat-sidebar { flex:0 0 auto; max-height:240px; }
  .chat-main { min-height:320px; }
}
```

- [ ] **Step 2: Коммит**

```bash
git add frontend/css/features.css
git commit -m "feat(chat): стили страницы чата (layout, пузыри, бейджи каналов)"
```

---

### Task 6: Ручная проверка в браузере (MCP Playwright)

Проверить страницу целиком на dev-стенде (PM2 `loyalpro`, :3001, отдаёт фронт статикой — правки применяются на перезагрузке).

**Files:** нет (только проверка)

- [ ] **Step 1: Перезагрузить бэкенд, чтобы подхватить новый роут**

Run: `pm2 restart loyalpro && sleep 2 && pm2 logs loyalpro --lines 20 --nostream`
Expected: сервис `online`, в логах нет ошибок старта.

- [ ] **Step 2: Открыть SPA и войти**

Через MCP Playwright (`mcp__playwright__*`): открыть `http://localhost:3001`, войти под owner/admin.
Expected: успешный вход, виден основной интерфейс.

- [ ] **Step 3: Проверить пункт меню и страницу**

Кликнуть пункт меню `💬 Чат`.
Expected:
- страница `#page-chat` становится активной (двухпанельный layout виден);
- если сообщений нет — слева «Пока нет сообщений», справа «Выберите диалог»;
- если диалоги есть — список слева, клик по диалогу открывает историю справа (входящие слева, исходящие справа);
- в консоли браузера нет JS-ошибок (`browser_console_messages`).

- [ ] **Step 4: Проверить ролевую видимость (по возможности)**

Если есть учётка `specialist`: войти под ней — пункт `💬 Чат` в меню отсутствует; прямой запрос `GET /api/chat/dialogs` возвращает 403.
Expected: специалист не видит и не имеет доступа к чату.

- [ ] **Step 5: Финальный коммит (если были правки по итогам проверки)**

Если проверка потребовала мелких исправлений — закоммитить их:

```bash
git add -A
git commit -m "fix(chat): правки по итогам ручной проверки"
```

Если правок не было — задача завершена без коммита.

---

## Итоговый список затрагиваемых файлов

| Файл | Действие |
|------|----------|
| `backend/services/chat.js` | создать (чистые хелперы) |
| `backend/chat.test.js` | создать (Jest) |
| `backend/routes/chat.js` | создать (2 GET-эндпоинта) |
| `backend/routes/index.js` | 1 строка монтирования |
| `frontend/js/pages/chat.js` | создать (логика страницы) |
| `frontend/index.html` | меню ×2, блок страницы, подключение скрипта |
| `frontend/js/core/nav.js` | 1 строка (ветка роутера) |
| `frontend/css/features.css` | стили чата |
