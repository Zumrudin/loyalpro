# Разовые рассылки через мессенджеры клиники — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** разовая рассылка по фильтрам или по списку «имя+телефон» с картинкой, каскадом мессенджеров клиники (Telegram-TDLib / WhatsApp / MAX), паузой и лимитом на мессенджер и live-монитором.

**Architecture:** расширяем `broadcasts`/`broadcast_recipients` полем `transport`; старый бот-воркер берёт только `telegram_bot`. Новый каталог `backend/services/broadcast-messengers/`: чистые `list-parse`, `render`, `scheduler`, `forecast`; `audience` (БД), `sender` (одна отправка), `worker` (тик), `service` (CRUD/монитор). Каскад, адресаты и отправка — переиспользуются из `notifications/cascade.js`, `notifications/rules.lastConversation`, `messaging/transport.js`.

**Tech Stack:** Node 20, Express, `pg`, Jest (`TZ=Europe/Moscow` через globalSetup), vanilla JS фронт, `node --test`, новая зависимость `exceljs`.

**Спека:** `docs/superpowers/specs/2026-11-01-broadcast-messengers-design.md` — читать перед любой задачей.

---

## Исполнители и порядок

Задачи раздаются по сложности (решение владельца 01.11: младшие модели, ревью — оркестратор Opus). Haiku не влезает в контекст репозитория (CLAUDE.md), не использовать.

| # | Задача | Модель | Зависит от |
|---|--------|--------|-----------|
| 0 | Worktree и ветка | оркестратор | — |
| 1 | Миграции + фильтр бот-воркера | sonnet | 0 |
| 2 | `list-parse.js` | sonnet | 0 |
| 3 | `render.js` | sonnet | 0 |
| 4 | `scheduler.js` | sonnet | 0 |
| 5 | `forecast.js` | sonnet | 4 |
| 6 | `audience.js` | sonnet | 2, 3 |
| 7 | `sender.js` | **opus** | 3 |
| 8 | `worker.js` + запуск в server.js | **opus** | 1, 4, 7 |
| 9 | `service.js` + роуты | sonnet | 5, 6, 7, 8 |
| 10 | Фронт: форма создания | sonnet | 9 |
| 11 | Фронт: live-монитор | sonnet | 9 |
| 12 | e2e-скрипт, EXPLAIN, CLAUDE.md | sonnet | 10, 11 |

Задачи 1–4 независимы — запускать ПОСЛЕДОВАТЕЛЬНО (решение 16.10: без фоновых агентов, отчёт после каждой), ревью оркестратора после каждой. Ревью — один проход по diff задачи против спеки и этого плана; полный `npx jest broadcast` перед каждым коммитом.

**Общие правила для исполнителя (включать в промпт каждой задачи):**
- работать ТОЛЬКО в `/root/loyalpro-broadcasts` (worktree), в основной копии чужие незакоммиченные правки экономики;
- тесты: `cd /root/loyalpro-broadcasts/backend && npx jest broadcast-messengers-<имя>`;
- БД — только через MCP `mcp__postgres__query` (дев-БД `loyalpro_test`), не psql;
- не трогать `services/broadcast.js` кроме явно указанного в задаче 1;
- комментарии и сообщения коммитов — по-русски, в стиле файла; коммит заканчивается строкой `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

---

### Task 0: Worktree (оркестратор)

- [ ] Проверить параллельные сессии: `ListAgents` — нет ли другой сессии, работающей с рассылками.
- [ ] Создать worktree:

```bash
cd /root/loyalpro && git worktree add -b feat/broadcast-messengers /root/loyalpro-broadcasts HEAD
cd /root/loyalpro-broadcasts/backend && npm ci --silent && npx jest broadcast 2>&1 | tail -3
```

Ожидаемо: worktree создан, имеющиеся тесты (если есть) зелёные.

---

### Task 1: Миграции и фильтр бот-воркера (sonnet)

**Files:**
- Modify: `backend/migrations.js` — сразу после блока `uq_broadcast_recipient` (≈ строка 845)
- Modify: `backend/services/broadcast.js` — `processOneTick` (аренда) и `createBroadcast` (INSERT)

- [ ] **Step 1: Добавить миграции** (каждый запрос — отдельный `await client.query(...).catch(() => {})`, как соседние):

```js
  // ── Рассылки через мессенджеры клиники (спека 2026-11-01) ──────
  // transport: telegram_bot — прежний бот-путь (services/broadcast.js), messengers —
  // services/broadcast-messengers/. Получатели мессенджеров адресуются телефоном,
  // telegram_chat_id у них NULL (старый уникальный индекс NULL не сравнивает).
  await client.query(`
    ALTER TABLE broadcasts
      ADD COLUMN IF NOT EXISTS transport        VARCHAR(20) NOT NULL DEFAULT 'telegram_bot',
      ADD COLUMN IF NOT EXISTS audience_source  VARCHAR(10) NOT NULL DEFAULT 'filters',
      ADD COLUMN IF NOT EXISTS image_url        TEXT,
      ADD COLUMN IF NOT EXISTS cascade_enabled  BOOLEAN NOT NULL DEFAULT TRUE,
      ADD COLUMN IF NOT EXISTS channel_settings JSONB NOT NULL DEFAULT '{}'::jsonb,
      ADD COLUMN IF NOT EXISTS on_limit         VARCHAR(12) NOT NULL DEFAULT 'next_channel',
      ADD COLUMN IF NOT EXISTS paused           BOOLEAN NOT NULL DEFAULT FALSE,
      ADD COLUMN IF NOT EXISTS pause_reason     TEXT,
      ADD COLUMN IF NOT EXISTS skipped          INTEGER NOT NULL DEFAULT 0
  `).catch(() => {});

  await client.query(`ALTER TABLE broadcast_recipients ALTER COLUMN telegram_chat_id DROP NOT NULL`).catch(() => {});

  await client.query(`
    ALTER TABLE broadcast_recipients
      ADD COLUMN IF NOT EXISTS phone           VARCHAR(20),
      ADD COLUMN IF NOT EXISTS cascade         TEXT[],
      ADD COLUMN IF NOT EXISTS step            SMALLINT NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS channel         VARCHAR(16),
      ADD COLUMN IF NOT EXISTS reason          TEXT,
      ADD COLUMN IF NOT EXISTS delivery_id     TEXT,
      ADD COLUMN IF NOT EXISTS account_id      INTEGER,
      ADD COLUMN IF NOT EXISTS delivery_status VARCHAR(20),
      ADD COLUMN IF NOT EXISTS checked_at      TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS cascade_log     JSONB NOT NULL DEFAULT '[]'::jsonb,
      ADD COLUMN IF NOT EXISTS sort_order      INTEGER NOT NULL DEFAULT 0
  `).catch(() => {});

  await client.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_broadcast_recipient_phone
      ON broadcast_recipients (broadcast_id, phone) WHERE phone IS NOT NULL
  `).catch(() => {});

  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_broadcast_recipients_queue
      ON broadcast_recipients (broadcast_id, status, channel, sort_order)
  `).catch(() => {});
```

- [ ] **Step 2: Бот-воркер берёт только свои рассылки.** В `processOneTick` во внутреннем `SELECT id FROM broadcasts WHERE status IN ('pending','in_progress') AND cancel_requested = FALSE` добавить `AND transport = 'telegram_bot'`. В `createBroadcast` INSERT колонку не трогать (DEFAULT `telegram_bot`).

- [ ] **Step 3: Применить и сверить на дев-БД.** Перезапустить миграции: `cd /root/loyalpro-broadcasts/backend && node -e "require('./migrations').runMigrations ? require('./migrations').runMigrations().then(()=>process.exit(0)) : process.exit(1)"` — если экспорт называется иначе, найти его `grep -n "module.exports" migrations.js` и вызвать его. Затем MCP:

```sql
SELECT column_name, is_nullable FROM information_schema.columns
 WHERE table_name IN ('broadcasts','broadcast_recipients')
   AND column_name IN ('transport','channel_settings','skipped','telegram_chat_id','phone','cascade','sort_order','cascade_log')
 ORDER BY table_name, column_name;
```

Ожидаемо: 8 строк, `telegram_chat_id` — `is_nullable = YES`.

- [ ] **Step 4: Commit** `feat(broadcasts): схема рассылок через мессенджеры клиники; бот-воркер берёт только telegram_bot`

---

### Task 2: Разбор списка `list-parse.js` (sonnet)

**Files:**
- Create: `backend/services/broadcast-messengers/list-parse.js`
- Test: `backend/broadcast-messengers-list-parse.test.js`

Контракт: `parseText(text) → result`, `parseRows(rows: string[][]) → result`, `parseCsv(text) → string[][]`; `result = { rows:[{name, phone, line}], invalid:[{line, raw}], duplicates: number }`. Телефон — `canonPhone` из `../notifications/cascade` (канон `7XXXXXXXXXX`, иначе null). Кап `MAX_ROWS = 5000` (лишнее → `invalid` с `raw:'превышен лимит 5000 строк'` один раз и обрезка).

- [ ] **Step 1: Тест**

```js
'use strict';
const lp = require('./services/broadcast-messengers/list-parse');

describe('parseText', () => {
  test('разные формы номера и порядок имя/номер', () => {
    const r = lp.parseText('Анна 89161234567\n+7 (916) 765-43-21;Ольга Петрова\n9031112233, Ирина');
    expect(r.rows).toEqual([
      { name: 'Анна', phone: '79161234567', line: 1 },
      { name: 'Ольга Петрова', phone: '79167654321', line: 2 },
      { name: 'Ирина', phone: '79031112233', line: 3 },
    ]);
    expect(r.invalid).toEqual([]);
  });
  test('табы из Excel и пустые строки', () => {
    const r = lp.parseText('Имя\tТелефон\nАнна\t8 916 123 45 67\n\n');
    expect(r.rows).toEqual([{ name: 'Анна', phone: '79161234567', line: 2 }]);
  });
  test('битый номер и номер без имени', () => {
    const r = lp.parseText('Анна 12345\n89161234567');
    expect(r.invalid).toEqual([{ line: 1, raw: 'Анна 12345' }]);
    expect(r.rows).toEqual([{ name: '', phone: '79161234567', line: 2 }]);
  });
  test('дубли по номеру: остаётся первый, считаются', () => {
    const r = lp.parseText('Анна 89161234567\nАня +79161234567');
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0].name).toBe('Анна');
    expect(r.duplicates).toBe(1);
  });
});

describe('parseRows / parseCsv', () => {
  test('заголовок определяет колонки', () => {
    const r = lp.parseRows([['Телефон', 'ФИО'], ['89161234567', 'Анна Иванова']]);
    expect(r.rows).toEqual([{ name: 'Анна Иванова', phone: '79161234567', line: 2 }]);
  });
  test('без заголовка — колонка с телефоном находится сама', () => {
    const r = lp.parseRows([['Анна', '89161234567', 'VIP']]);
    expect(r.rows).toEqual([{ name: 'Анна', phone: '79161234567', line: 1 }]);
  });
  test('CSV с кавычками и ; ', () => {
    expect(lp.parseCsv('"Петрова; Анна";89161234567\nОля;89167654321'))
      .toEqual([['Петрова; Анна', '89161234567'], ['Оля', '89167654321']]);
  });
  test('числа из XLSX', () => {
    const r = lp.parseRows([['Анна', 79161234567]]);
    expect(r.rows[0].phone).toBe('79161234567');
  });
  test('кап строк', () => {
    const rows = Array.from({ length: 5002 }, (_, i) => ['x', String(79000000000 + i)]);
    const r = lp.parseRows(rows);
    expect(r.rows).toHaveLength(5000);
    expect(r.invalid.some(x => /лимит/.test(x.raw))).toBe(true);
  });
});
```

- [ ] **Step 2:** `npx jest broadcast-messengers-list-parse` → FAIL (модуля нет).

- [ ] **Step 3: Реализация**

```js
'use strict';
// Разбор списка «имя + телефон» для разовой рассылки (спека 2026-11-01 §3). Чистый модуль: текст
// (строка на человека, разделители ; , таб или пробел), CSV и строки XLSX (массив массивов). Номер —
// общий канон cascade.canonPhone (7XXXXXXXXXX): правило канонизации одно на модуль уведомлений и рассылки.
const { canonPhone } = require('../notifications/cascade');

const MAX_ROWS = 5000;
const NAME_HDR = /^(имя|name|фио|клиент|пациент)$/i;
const PHONE_HDR = /^(телефон|phone|номер|тел\.?|мобильный)$/i;

function cellStr(v) { return v == null ? '' : String(v).trim(); }

// Ячейка — телефон, только если после чистки в ней нет букв: «Анна 8916…» телефоном не считается.
function asPhone(v) {
  const s = cellStr(v);
  if (!s || /\p{L}/u.test(s)) return null;
  return canonPhone(s);
}

function finish(items, invalid) {
  const seen = new Set();
  const rows = [];
  let duplicates = 0;
  let capped = false;
  for (const it of items) {
    if (seen.has(it.phone)) { duplicates++; continue; }
    if (rows.length >= MAX_ROWS) { capped = true; continue; }
    seen.add(it.phone);
    rows.push(it);
  }
  if (capped) invalid.push({ line: null, raw: `превышен лимит ${MAX_ROWS} строк` });
  return { rows, invalid, duplicates };
}

function parseRows(table) {
  const items = [];
  const invalid = [];
  let start = 0;
  let nameCol = null;
  let phoneCol = null;
  const head = (table[0] || []).map(cellStr);
  const hp = head.findIndex(h => PHONE_HDR.test(h));
  if (hp >= 0) {
    phoneCol = hp;
    const hn = head.findIndex(h => NAME_HDR.test(h));
    nameCol = hn >= 0 ? hn : null;
    start = 1;
  }
  for (let i = start; i < table.length; i++) {
    const cells = (table[i] || []).map(cellStr);
    if (!cells.some(Boolean)) continue;
    const line = i + 1;
    let pIdx = phoneCol;
    if (pIdx == null) pIdx = cells.findIndex(c => asPhone(c));
    const phone = pIdx != null && pIdx >= 0 ? asPhone(cells[pIdx]) : null;
    if (!phone) { invalid.push({ line, raw: cells.filter(Boolean).join(' ') }); continue; }
    const name = nameCol != null
      ? cells[nameCol] || ''
      : cells.filter((c, j) => j !== pIdx && c && /\p{L}/u.test(c))[0] || '';
    items.push({ name: name.slice(0, 120), phone, line });
  }
  return finish(items, invalid);
}

// Строка текста: таб/; → ячейки как есть; иначе телефон — самый длинный хвост/голова из цифр и
// символов номера, остальное — имя («Анна 8 916 123-45-67», «+7 916… , Ирина»).
const PHONE_RUN = /\+?\d[\d\s()\-]{8,}\d/;
function splitLine(raw) {
  if (/[\t;]/.test(raw)) return raw.split(/[\t;]/);
  const m = raw.match(PHONE_RUN);
  if (!m) return [raw];
  const rest = (raw.slice(0, m.index) + ' ' + raw.slice(m.index + m[0].length)).replace(/[,]/g, ' ').trim();
  return [rest, m[0]];
}

function parseText(text) {
  const lines = String(text || '').split(/\r?\n/);
  const table = lines.map(l => (l.trim() ? splitLine(l.trim()) : []));
  const r = parseRows(table);
  // В тексте «битая» строка показывается целиком, как её вставили.
  r.invalid = r.invalid.map(x => (x.line ? { line: x.line, raw: lines[x.line - 1].trim() } : x));
  return r;
}

// CSV: разделитель ; или , (по первой строке), кавычки "…" с "" внутри.
function parseCsv(text) {
  const src = String(text || '').replace(/^﻿/, '');
  const first = src.split(/\r?\n/)[0] || '';
  const sep = (first.match(/;/g) || []).length >= (first.match(/,/g) || []).length && first.includes(';') ? ';' : ',';
  const out = [];
  let row = [];
  let cell = '';
  let q = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (q) {
      if (ch === '"' && src[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') q = false;
      else cell += ch;
    } else if (ch === '"') q = true;
    else if (ch === sep) { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      row.push(cell); out.push(row); row = []; cell = '';
    } else cell += ch;
  }
  if (cell || row.length) { row.push(cell); out.push(row); }
  return out;
}

module.exports = { parseText, parseRows, parseCsv, MAX_ROWS };
```

Смешанные разделители в одном CSV не поддерживаются: разделитель определяется по первой строке.

- [ ] **Step 4:** тест зелёный. **Step 5: Commit** `feat(broadcasts): разбор списка имя+телефон (текст, CSV, строки XLSX)`

---

### Task 3: Подстановки `render.js` (sonnet)

**Files:** Create `backend/services/broadcast-messengers/render.js`; Test `backend/broadcast-messengers-render.test.js`

Контракт: `renderText(template, ctx) → string`, где `ctx = {name, bonus_balance, salon_name, phone}`; `{first_name}` — `resolveGivenName(name)` из `../../utils/person-name` (null → пусто, затем схлопнуть осиротевшую «, » в начале строки так же, как `services/notifications.js renderTemplate` — найти там регэксп `grep -n "replace" services/notifications.js` и повторить его); `{name}` — как есть; `{bonuses}` — `Math.round(bonus_balance||0)`; `{salon}`, `{phone}`. `splitCaption(text, hasImage) → {caption, followText}`: без картинки `{caption:null, followText:text}`; с картинкой и `text.length <= CAPTION_MAX (1024)` → `{caption:text, followText:null}`; длиннее → `{caption:'', followText:text}`.

- [ ] **Step 1: Тест**

```js
'use strict';
const r = require('./services/broadcast-messengers/render');

test('подстановки', () => {
  expect(r.renderText('{first_name}, у вас {bonuses} бонусов в {salon}', { name: 'Иванова Анна Сергеевна', bonus_balance: 512.6, salon_name: 'PERI CLINIC' }))
    .toBe('Анна, у вас 513 бонусов в PERI CLINIC');
});
test('имени нет — без осиротевшей запятой', () => {
  expect(r.renderText('{first_name}, здравствуйте!', { name: '' })).toBe('Здравствуйте!');
});
test('splitCaption', () => {
  expect(r.splitCaption('abc', false)).toEqual({ caption: null, followText: 'abc' });
  expect(r.splitCaption('abc', true)).toEqual({ caption: 'abc', followText: null });
  const long = 'x'.repeat(1025);
  expect(r.splitCaption(long, true)).toEqual({ caption: '', followText: long });
});
```

Если схлопывание в `notifications.js` не капитализирует следующее слово, ожидание второго теста привести к фактическому поведению общего правила (`'здравствуйте!'`) — правило одно на оба модуля, своё не изобретать.

- [ ] **Step 2–4:** FAIL → реализация → PASS. **Step 5: Commit** `feat(broadcasts): подстановки текста и разбиение подписи картинки`

---

### Task 4: Планировщик `scheduler.js` (sonnet; код дан целиком — не менять логику без согласования)

**Files:** Create `backend/services/broadcast-messengers/scheduler.js`; Test `backend/broadcast-messengers-scheduler.test.js`

- [ ] **Step 1: Тест**

```js
'use strict';
const s = require('./services/broadcast-messengers/scheduler');
const at = (h, m = 0) => new Date(2026, 10, 2, h, m, 0).getTime(); // мск (TZ jest)

describe('inSendWindow', () => {
  test('09:00 включительно, 21:00 исключительно', () => {
    expect(s.inSendWindow(at(8, 59))).toBe(false);
    expect(s.inSendWindow(at(9, 0))).toBe(true);
    expect(s.inSendWindow(at(20, 59))).toBe(true);
    expect(s.inSendWindow(at(21, 0))).toBe(false);
  });
});

describe('channelStates', () => {
  const settings = { whatsapp: { enabled: true, delay_sec: 180, limit: 2 }, tdlib: { enabled: true, delay_sec: 60, limit: null }, max: { enabled: false } };
  test('пауза, лимит, выключен', () => {
    const st = s.channelStates(settings, { whatsapp: { lastSentAt: at(10, 0), sentCount: 1 }, tdlib: { lastSentAt: at(9, 58), sentCount: 5 } }, at(10, 1));
    expect(st.whatsapp).toEqual({ state: 'paused', pausedUntil: at(10, 3), sent: 1, limit: 2 });
    expect(st.tdlib).toEqual({ state: 'free', pausedUntil: null, sent: 5, limit: null });
    expect(st.max.state).toBe('disabled');
  });
  test('лимит исчерпан главнее паузы', () => {
    const st = s.channelStates(settings, { whatsapp: { lastSentAt: at(10, 0), sentCount: 2 } }, at(10, 1));
    expect(st.whatsapp.state).toBe('limit');
  });
});

describe('pickSends', () => {
  test('по одному на свободный мессенджер, первые в очереди', () => {
    const states = { whatsapp: { state: 'free' }, tdlib: { state: 'paused' }, max: { state: 'free' } };
    const heads = { whatsapp: { id: 3 }, tdlib: { id: 1 }, max: null };
    expect(s.pickSends(states, heads)).toEqual([{ id: 3, channel: 'whatsapp' }]);
  });
});

describe('nextStep', () => {
  test('следующий незаблокированный шаг', () => {
    expect(s.nextStep(['whatsapp', 'tdlib', 'max'], 0, new Set(['tdlib']))).toEqual({ step: 2, channel: 'max' });
    expect(s.nextStep(['whatsapp'], 0, new Set())).toBeNull();
  });
});

describe('limitAction', () => {
  test('next_channel → advance или skip, skip → skip', () => {
    const blocked = new Set(['whatsapp']);
    expect(s.limitAction({ cascade: ['whatsapp', 'tdlib'], step: 0 }, 'next_channel', blocked)).toEqual({ action: 'advance', step: 1, channel: 'tdlib' });
    expect(s.limitAction({ cascade: ['whatsapp'], step: 0 }, 'next_channel', blocked)).toEqual({ action: 'skip', reason: 'limit' });
    expect(s.limitAction({ cascade: ['whatsapp', 'tdlib'], step: 0 }, 'skip', blocked)).toEqual({ action: 'skip', reason: 'limit' });
  });
});
```

- [ ] **Step 2:** FAIL.

- [ ] **Step 3: Реализация**

```js
'use strict';
// Планировщик разовой рассылки через мессенджеры — чистая часть, без БД и сети (спека 2026-11-01 §5).
// Получатель ждёт СВОЙ мессенджер (решение владельца): за тик уходит не больше одного сообщения в
// каждый свободный мессенджер — первому в очереди этого мессенджера. Пауза и лимит считаются по
// отправкам ЭТОЙ рассылки; лимит исчерпан → по on_limit получатель идёт дальше по своему каскаду или
// пропускается. Окно 09:00–21:00 мск (конец исключающий, как у паузы темпа напоминаний).
const CHANNELS = ['tdlib', 'whatsapp', 'max'];
const WINDOW_START_MIN = 9 * 60;
const WINDOW_END_MIN = 21 * 60;

// Процесс и jest живут в Europe/Moscow — локальные часы = мск.
function inSendWindow(nowMs) {
  const d = new Date(nowMs);
  const m = d.getHours() * 60 + d.getMinutes();
  return m >= WINDOW_START_MIN && m < WINDOW_END_MIN;
}

/** settings — broadcasts.channel_settings; stats — {ch:{lastSentAt(ms|null), sentCount}}. */
function channelStates(settings, stats, nowMs) {
  const out = {};
  for (const ch of CHANNELS) {
    const cfg = (settings && settings[ch]) || {};
    const st = (stats && stats[ch]) || {};
    const sent = Number(st.sentCount) || 0;
    const limit = cfg.limit == null || cfg.limit === '' ? null : Number(cfg.limit);
    if (!cfg.enabled) { out[ch] = { state: 'disabled', pausedUntil: null, sent, limit }; continue; }
    if (limit != null && sent >= limit) { out[ch] = { state: 'limit', pausedUntil: null, sent, limit }; continue; }
    const until = st.lastSentAt ? st.lastSentAt + (Number(cfg.delay_sec) || 0) * 1000 : null;
    if (until != null && nowMs < until) { out[ch] = { state: 'paused', pausedUntil: until, sent, limit }; continue; }
    out[ch] = { state: 'free', pausedUntil: null, sent, limit };
  }
  return out;
}

/** heads — {ch: первый ожидающий получатель этого мессенджера | null}. */
function pickSends(states, heads) {
  const out = [];
  for (const ch of CHANNELS) {
    const h = heads && heads[ch];
    if (h && states[ch] && states[ch].state === 'free') out.push({ id: h.id, channel: ch });
  }
  return out;
}

/** Следующий шаг каскада после step, мессенджер которого не в blocked. */
function nextStep(cascade, step, blocked) {
  const list = Array.isArray(cascade) ? cascade : [];
  for (let k = step + 1; k < list.length; k++) {
    if (!blocked.has(list[k])) return { step: k, channel: list[k] };
  }
  return null;
}

/** Что делать с получателем, чей текущий мессенджер упёрся в лимит. blocked — limit + disabled. */
function limitAction(rec, onLimit, blocked) {
  if (onLimit === 'next_channel') {
    const n = nextStep(rec.cascade, rec.step, blocked);
    if (n) return { action: 'advance', step: n.step, channel: n.channel };
  }
  return { action: 'skip', reason: 'limit' };
}

module.exports = { CHANNELS, inSendWindow, channelStates, pickSends, nextStep, limitAction, WINDOW_START_MIN, WINDOW_END_MIN };
```

- [ ] **Step 4:** PASS. **Step 5: Commit** `feat(broadcasts): планировщик — пауза и лимит на мессенджер, окно 09–21`

---

### Task 5: Прогноз `forecast.js` (sonnet)

**Files:** Create `backend/services/broadcast-messengers/forecast.js`; Test `backend/broadcast-messengers-forecast.test.js`

Контракт: `forecast({ firstSteps: [{cascade:[...]}], settings, onLimit, nowMs }) → { byChannel:{tdlib,whatsapp,max,none}, durationMin, finishAt (ms), nextDay (bool) }`.
Алгоритм (оценка, не симуляция тиков):
1. Каждому получателю — первый шаг `cascade[0]`; распределяем по счётчикам в порядке списка. Если мессенджер достиг `limit`: при `next_channel` — следующий шаг его каскада, у которого лимит ещё не достигнут; нет такого — `none`; при `skip` — `none`.
2. Длительность мессенджера = `(n − 1) × delay_sec` (n ≥ 1), общая `active = max` по мессенджерам, в секундах.
3. Время с учётом окна: старт `nowMs`, если вне окна — ближайшие 09:00; дальше расходуем `active` только внутри окон 09:00–21:00, переходя через ночь. `finishAt` — момент конца; `nextDay = дата(finishAt) ≠ дата(nowMs)`; `durationMin = round((finishAt − nowMs)/60000)`.

- [ ] **Step 1: Тест**

```js
'use strict';
const f = require('./services/broadcast-messengers/forecast');
const at = (d, h, m = 0) => new Date(2026, 10, d, h, m, 0).getTime();
const set = { whatsapp: { enabled: true, delay_sec: 180, limit: 2 }, tdlib: { enabled: true, delay_sec: 60, limit: null }, max: { enabled: true, delay_sec: 60, limit: null } };

test('распределение с лимитом next_channel', () => {
  const r = f.forecast({ firstSteps: [['whatsapp', 'tdlib'], ['whatsapp', 'tdlib'], ['whatsapp', 'tdlib'], ['whatsapp']].map(c => ({ cascade: c })), settings: set, onLimit: 'next_channel', nowMs: at(2, 10) });
  expect(r.byChannel).toEqual({ whatsapp: 2, tdlib: 1, max: 0, none: 1 });
  expect(r.durationMin).toBe(3);
  expect(r.nextDay).toBe(false);
});
test('переход через ночь', () => {
  const steps = Array.from({ length: 21 }, () => ({ cascade: ['whatsapp'] }));
  const r = f.forecast({ firstSteps: steps, settings: { whatsapp: { enabled: true, delay_sec: 600, limit: null } }, onLimit: 'skip', nowMs: at(2, 20, 0) });
  // 20 пауз × 10 мин = 200 мин: 60 мин сегодня, 140 мин завтра с 09:00 → 11:20
  expect(r.finishAt).toBe(at(3, 11, 20));
  expect(r.nextDay).toBe(true);
});
test('старт ночью — с 09:00', () => {
  const r = f.forecast({ firstSteps: [{ cascade: ['tdlib'] }], settings: set, onLimit: 'skip', nowMs: at(2, 23) });
  expect(r.finishAt).toBe(at(3, 9));
});
```

- [ ] **Step 2–4:** FAIL → реализация (использовать `inSendWindow`, `WINDOW_START_MIN`, `WINDOW_END_MIN` из `scheduler.js`, не копировать границы) → PASS.
- [ ] **Step 5: Commit** `feat(broadcasts): прогноз распределения и длительности рассылки`

---

### Task 6: Аудитория `audience.js` (sonnet)

**Files:** Create `backend/services/broadcast-messengers/audience.js`; Test `backend/broadcast-messengers-audience.test.js` (jest.mock `../../db`, `../notifications/settings`, `../notifications/rules`).

Контракт:
- `resolveAudience(salonId, { source:'filters'|'list', filters, list:[{name,phone}], channelSettings, cascadeEnabled }) → { recipients:[{client_id|null, name, phone, bonus_balance, salon_name, cascade:[ch], sort_order}], skipped:{ blacklist:n, no_recipient:n } }`.
- **filters:** SQL по `clients` салона: `c.id, c.name, c.phone, c.bonus_balance, c.birthday, c.gender, c.last_visit_at, EXTRACT(EPOCH FROM (NOW()-c.last_visit_at))/86400 AS days_since_visit, cs.segment_key, COALESCE(NULLIF(s.template_logo_line1,''), s.name) AS salon_name` с теми же JOIN, что `resolveAudience` в `services/broadcast.js` (скопировать FROM/JOIN), `WHERE c.salon_id=$1 AND COALESCE(c.is_blacklisted,FALSE)=FALSE AND c.phone IS NOT NULL`. Фильтрация в JS — та же семантика, что в `services/broadcast.js` строки «── фильтры ──» (сегменты, bonusMin/Max, lastVisitDays, birthMonth, gender, phone-фрагмент): вынести её в экспортируемую чистую `matchesFilters(c, filters)` в `audience.js` (старый файл не трогаем — расхождение бот/мессенджеры допустимо, бот-путь заморожен). Номер — `canonPhone`; негодный → пропуск без счёта.
- **list:** клиенты салона по номерам списка одним запросом: `WHERE c.salon_id=$1 AND regexp_replace(COALESCE(c.phone,''),'\D','','g') = ANY($2::text[])` где `$2` — для каждого канона формы `7…` и `8…` (10-значное ядро c `7`/`8`); сопоставить по `canonPhone(c.phone)`. Найден и `is_blacklisted` → `skipped.blacklist++`. Имя: из списка, если непустое, иначе `c.name`. Не найден → `client_id:null, bonus_balance:0`, `salon_name` — отдельный запрос салона.
- **Каскад:** `cfg = await notifSettings.getSettings(salonId)`; для каждого получателя `conv = await lastConversation(salonId, phone)` (ошибка → `{lastChannel:null, chats:{}}`); `buildCascade(cfg.default_channels, { preferLast: cfg.prefer_last_channel !== false, lastChannel: conv.lastChannel })`, затем оставить только мессенджеры с `channelSettings[ch].enabled` и `recipientFor(ch, phone, conv.chats) != null`; `cascadeEnabled === false` → только первый элемент. Пустой → `skipped.no_recipient++`, получатель не включается. `lastConversation` звать пачками по 8 параллельно (`Promise.all` по срезам) — 5 000 номеров иначе минуты.
- `sort_order` — порядковый индекс (порядок списка; для фильтров — `ORDER BY c.id`).

Тесты (минимум): фильтр по сегменту/бонусам через `matchesFilters`; список — имя из списка главнее карточки, номер не из базы → `client_id null`, ЧС считается; `cascadeEnabled=false` → один шаг; выключенный мессенджер выпадает из каскада; ни одного адресата → `no_recipient`; последняя переписка переставляет первым. Моки: `db.any` возвращает клиентов, `notifSettings.getSettings` → `{default_channels:['tdlib','whatsapp','max'], prefer_last_channel:true}`, `rules.lastConversation` → по номеру.

- [ ] Steps: тест → FAIL → реализация → PASS → Commit `feat(broadcasts): аудитория рассылки по фильтрам и по списку с каскадом`

---

### Task 7: Отправка одному получателю `sender.js` (opus)

**Files:** Create `backend/services/broadcast-messengers/sender.js`; Test `backend/broadcast-messengers-sender.test.js` (jest.mock transport, rules, authorship, pending-replies, chat-persist, fs).

Контракт: `sendToRecipient({ salonId, phone, channel, text, imageUrl }) → { ok:true, delivery } | { ok:false, kind:'rejected'|'unreachable'|'ambiguous', error }`. НИКОГДА не бросает.

Порядок (спека §5.3):
1. `conv = await lastConversation(salonId, phone)` (ошибка → пустой); `target = recipientFor(channel, phone, conv.chats)`; null → `{ok:false, kind:'rejected', error:'нет адресата'}`.
2. `await authorship.remember(salonId, phone, text, 'system')` в try/catch (лог) — ДО отправки.
3. Картинка: `imageUrl` → файл `path.join(__dirname,'../../../frontend/uploads', path.basename(imageUrl))`; нет файла/ошибка чтения → `{kind:'rejected'}` (локальный отказ, как `notifications/worker.deliver`). `{caption, followText} = splitCaption(text, !!imageUrl)`. С картинкой: `transport.sendFile(salonId, {...target, fileName, caption, type:'image'}, buf, mime)`; MIME по расширению (`.jpg/.jpeg` image/jpeg, `.png` image/png, `.webp` image/webp). `followText` → затем `transport.sendMessage(salonId, {...target, text: followText})`; сбой ВТОРОГО сообщения — `ok:true` (картинка ушла) с логом WARN, не откат.
4. Классификация ошибки первой отправки: `CONNECT_FAIL_CODES = new Set(['ECONNREFUSED','ENOTFOUND','EAI_AGAIN'])` → `unreachable` (ПРОВЕРЯТЬ ПЕРВЫМ: у таких ошибок есть `code`); `transport.isDefiniteRejection(e)` → `rejected`; иначе `ambiguous`. `error` — первые 300 символов `e.message`.
5. Успех: `pendingReplies.remember(salonId, phone, text)`; whatsapp → `persistWhatsappOutgoing(salonId, { delivery, phone, chatId:null, text, msgType: imageUrl?'image':'text', fileUrl: imageUrl||null, mimeType, authoredBy:'system' })`. Оба в try/catch.

Тесты: порядок вызовов (authorship раньше transport — проверять `mock.invocationCallOrder`); три вида ошибок; длинный текст → sendFile с `caption:''` + sendMessage; сбой второго → ok:true; whatsapp persist; tdlib без номера, но с chat id из `lastConversation` → `tdlib_user_id` в payload; файла нет → rejected без вызова transport.

- [ ] Steps: тест → FAIL → реализация → PASS → Commit `feat(broadcasts): отправка получателю — картинка с подписью, классификация отказов`

---

### Task 8: Воркер `worker.js` (opus)

**Files:** Create `backend/services/broadcast-messengers/worker.js`; Modify `backend/server.js` (рядом с `startBroadcastWorker()` ≈ стр. 384); Test `backend/broadcast-messengers-worker.test.js`.

Экспорт: `start()`, `tick(nowMs = Date.now())`, `processBroadcast(b, nowMs)`, `closeStaleSending()`, `checkDeliveries()`, SQL-константы `ACTIVE_SQL`, `STATS_SQL`, `HEADS_SQL` (для EXPLAIN в задаче 12).

```js
const ACTIVE_SQL = `
  SELECT DISTINCT ON (salon_id) *
    FROM broadcasts
   WHERE transport = 'messengers' AND status IN ('pending','in_progress')
   ORDER BY salon_id, (status = 'in_progress') DESC, created_at ASC, id ASC`;
const STATS_SQL = `
  SELECT channel, extract(epoch FROM max(sent_at)) * 1000 AS last_ms, count(*)::int AS n
    FROM broadcast_recipients
   WHERE broadcast_id = $1 AND status IN ('sent','sending')
   GROUP BY channel`;
const HEADS_SQL = `
  SELECT DISTINCT ON (channel) id, phone, channel, cascade, step, personalized_text
    FROM broadcast_recipients
   WHERE broadcast_id = $1 AND status = 'pending' AND channel = ANY($2::text[])
   ORDER BY channel, sort_order, id`;
```

`processBroadcast(b, now)`:
1. `cancel_requested` → `UPDATE broadcast_recipients SET status='cancelled' WHERE broadcast_id=$1 AND status='pending'`, рассылка `cancelled, finished_at=NOW()`; return.
2. `status='pending'` → `in_progress, started_at=COALESCE(started_at,NOW())`.
3. `paused` или `!inSendWindow(now)` → return.
4. `states = channelStates(b.channel_settings, statsFromRows, now)`.
5. Лимит: `limitChs` = мессенджеры со state `limit`; `blocked` = limit ∪ disabled. Для `SELECT id, cascade, step FROM broadcast_recipients WHERE broadcast_id=$1 AND status='pending' AND channel = ANY($2)` (limitChs) — `limitAction`: `advance` → `UPDATE … SET step=$2, channel=$3, cascade_log = cascade_log || $4::jsonb WHERE id=$1 AND status='pending'` (запись `{at, from, to, why:'limit'}`); `skip` → `status='skipped', reason='limit'` + `broadcasts.skipped += 1`.
6. `heads` по свободным мессенджерам (HEADS_SQL c `$2` = free), `sends = pickSends(states, heads)`.
7. Для каждого send (последовательно):
   - захват `UPDATE broadcast_recipients SET status='sending', sent_at=NOW() WHERE id=$1 AND status='pending' RETURNING id`; не легло → continue;
   - `r = await sender.sendToRecipient({ salonId:b.salon_id, phone, channel, text: personalized_text, imageUrl: b.image_url })`;
   - `ok` → `status='sent', delivery_id, account_id, delivery_status='accepted', cascade_log || {at, channel, ok:true}`, `broadcasts.sent += 1`;
   - `rejected` → `nextStep(cascade, step, blocked)`: есть → `status='pending', sent_at=NULL, step, channel, cascade_log || {…why:'rejected', error}`; нет → `status='failed', reason='all_rejected', error`, `failed += 1`;
   - `unreachable` → `status='pending', sent_at=NULL` (тот же шаг), рассылка `paused=TRUE, pause_reason='gateway_unreachable'`, лог WARN; прервать цикл sends;
   - `ambiguous` → `status='failed', reason='ambiguous_failure', error`, `failed += 1`.
   Каждый UPDATE после отправки — в своём try/catch с логом (at-most-once: строка не должна вернуться в pending после реальной отправки).
8. Если `SELECT 1 … WHERE broadcast_id=$1 AND status IN ('pending','sending') LIMIT 1` пусто → `completed, finished_at=NOW()`.

`closeStaleSending()` — при старте: `UPDATE broadcast_recipients SET status='failed', reason='ambiguous_failure', error='процесс перезапущен во время отправки' WHERE status='sending' AND sent_at < NOW() - interval '2 minutes'` и инкремент `failed` по рассылкам (одним `UPDATE broadcasts b SET failed = failed + x.n FROM (… GROUP BY broadcast_id) x WHERE b.id=x.broadcast_id` через CTE `WITH upd AS (... RETURNING broadcast_id)`).

`checkDeliveries()` — каждый тик: до 20 строк `status='sent' AND delivery_status='accepted' AND delivery_id IS NOT NULL AND sent_at < NOW() - interval '120 seconds'` (JOIN broadcasts за `salon_id`); `st = await transport.getDeliveryStatus(salon_id, channel, delivery_id, { accountId: account_id })`; `sid = st && st.status && Number(st.status.status_id)`; `sid===5 && !/исход неизвестен/i.test(String(st.error||''))` → `undeliverable`; `sid===5` → `unknown`; иначе `delivered` при `sid` 2/3/4, прочее — оставить `accepted` до `sent_at < NOW()-10 min`, затем `unknown`. Ошибка чтения → `unknown`. Пишется `checked_at=NOW()`. Каскад НЕ продолжается.

`tick()` — guard `_inFlight` (как `_tickInFlight` у напоминаний); `ACTIVE_SQL` → `processBroadcast` по каждой (ошибка одной — лог и дальше); затем `checkDeliveries()`. `start()` — `transport.configured()` false → WARN и return; `closeStaleSending()`; `setInterval(tick, 5000)`; env `BROADCAST_MESSENGERS=false` гасит запуск.

server.js: `require('./services/broadcast-messengers/worker').start();` рядом с `startBroadcastWorker()`.

Тесты (моки db/sender/transport, `now` передаётся): вне окна — ничего; пауза — ничего; одна отправка на свободный мессенджер; rejected → следующий шаг; rejected на последнем → failed; unreachable → pending + paused; ambiguous → failed; лимит skip/next_channel; отмена гасит pending; завершение; checkDeliveries статус 5 с «исход неизвестен» → unknown.

- [ ] Steps: тест → FAIL → реализация → PASS → Commit `feat(broadcasts): воркер рассылок через мессенджеры (пауза, лимит, каскад, сверка доставки)`

---

### Task 9: Сервис и роуты (sonnet)

**Files:** Create `backend/services/broadcast-messengers/service.js`; Modify `backend/routes/broadcasts.js`; `cd backend && npm i exceljs --save`; Test `backend/broadcast-messengers-routes.test.js` (supertest уже есть? `grep supertest package.json` — если нет, тестировать `parseCreateBody` и сервис напрямую, без HTTP).

`service.js`:
- `parseCreateBody(body) → {ok, value|error}` — чистая валидация (экспорт для теста): `transport==='messengers'`; `audienceSource ∈ filters|list`; `list` — массив ≤ 5000 `{name, phone}` с `canonPhone` (повторно канонизировать, клиенту не верить); `messageTemplate` строка 1–4000; `imageUrl` null или `/^\/uploads\/broadcast_\d+_\d+\.(jpg|jpeg|png|webp)$/`; `channelSettings[ch]` для `tdlib|whatsapp|max`: `enabled` boolean, `delay_sec` целое 0–3600, `limit` null/'' или целое 1–10000; хотя бы один enabled; `onLimit ∈ next_channel|skip`; `cascadeEnabled` boolean.
- `createBroadcast(salonId, userId, value)` — `audience.resolveAudience`; 0 получателей → ошибка 400 «Нет получателей»; проверка аккаунтов: хотя бы для одного включённого мессенджера `messaging/accounts.credentialsFor(salonId, ch)` не null, иначе 400; транзакция (как в `services/broadcast.js createBroadcast`): INSERT broadcasts (`transport='messengers'`, `total`, `skipped` = сумма audience.skipped, все новые поля), получатели пачками по 500: `(broadcast_id, client_id, client_name, phone, cascade, step=0, channel=cascade[0], personalized_text=renderText(...), sort_order)`.
- `forecastBroadcast(salonId, value)` — `resolveAudience` + `forecast` + `skipped`.
- `testSend(salonId, value, testPhone)` — первый мессенджер каскада тестового номера (через `resolveAudience` со списком из одного номера); `sender.sendToRecipient`; возвращает `{channel, ok, kind, error}`.
- `monitor(salonId, id)` — рассылка (scope salon), `states = channelStates(...)` по `STATS_SQL`, счётчики `SELECT channel, status, delivery_status, count(*) … GROUP BY 1,2,3`, `advancedFrom` — `SELECT e->>'from' ch, count(*) FROM broadcast_recipients, jsonb_array_elements(cascade_log) e WHERE broadcast_id=$1 AND e ? 'to' GROUP BY 1`, `waiting` — 20 первых `pending` `ORDER BY sort_order, id`, `inWindow`, `paused`, `pause_reason`.
- `recipients(salonId, id, {status, channel, q, offset, limit≤100})`.
- `pause/resume` (resume снимает `paused, pause_reason`), `retryDraft(salonId, id)` → `[{name, phone}]` по `status IN ('skipped','failed','cancelled')`.

Роуты (`routes/broadcasts.js`, ВСЕ статические ДО `/:id`):
- `POST /list/parse` — `multer({ storage: memoryStorage(), limits:{fileSize: 2*1024*1024} }).single('file')`; файл `.csv` → `parseRows(parseCsv(buf.toString('utf8')))`; `.xlsx` → `exceljs` `wb.xlsx.load(buf)`, первый лист, `row.values.slice(1)` (у exceljs 1-индекс), значения-объекты (`{text}`, `{result}`) → строка; иначе `{text}` в body → `parseText`. Ответ + `inBase`/`blacklisted`: один запрос клиентов салона по номерам.
- `POST /image` — multer `memoryStorage`, 5 МБ, `imageFileFilter`; `validateImageBuffer(buf, originalname)` → 400 при `!ok`; запись `frontend/uploads/broadcast_<salonId>_<Date.now()>.<ext>`; `{imageUrl}`.
- `POST /forecast`, `POST /test` (`testPhone` → `canonPhone`, иначе 400), `POST /` — ветка `transport==='messengers'` → сервис, иначе прежний код без изменений.
- `GET /:id/monitor`, `GET /:id/recipients`, `POST /:id/pause`, `POST /:id/resume`, `POST /:id/retry-draft`. `POST /:id/cancel` — существующий (работает для обоих транспортов).
- Ошибки — `res.status(e.status || 500).json({ error: e.message })`; тексты SQL наружу не отдавать (для 500 — `'Внутренняя ошибка'`, подробности в лог).

Тест: `parseCreateBody` — все ветки отказа и одна валидная; порядок маршрутов (`router.stack` — `/list/parse` индексом раньше `/:id`).

- [ ] Steps: тест → FAIL → реализация → PASS → Commit `feat(broadcasts): API рассылок через мессенджеры (список, картинка, прогноз, тест, монитор)`

---

### Task 10: Фронт — форма создания (sonnet)

**Files:** Modify `frontend/index.html` (модалка `#bcComposerOv` ≈ стр. 1201–1290, бамп `?v=` у `js/pages/broadcasts.js` ≈ стр. 2828), `frontend/js/pages/broadcasts.js`; Create `frontend/js/pages/broadcasts-form.js` (чистые помощники) + `frontend/js/pages/broadcasts-form.test.js` (`node --test`, грузит файл в `vm`).

Глобальные имена только с префиксом `bc`/`BC_` (общая глобальная область с остальными страницами).

Разметка в модалку, ДО блока фильтров:
- чипы `#bcTransport` — `data-v="messengers"` «💬 Мессенджеры клиники» (по умолчанию) / `data-v="telegram_bot"` «🤖 Telegram-бот»; бот → показывать прежнюю форму, скрыть новые блоки (`.bc-msg-only`);
- чипы `#bcSource` — «По фильтрам» / «По списку»; список → `<textarea id="bcListText">`, `<input type="file" id="bcListFile" accept=".csv,.xlsx">`, кнопка «Разобрать», `#bcListReport` (сводка + раскрываемые битые строки);
- `#bcImageBlock`: `<input type="file" id="bcImageFile" accept="image/jpeg,image/png,image/webp">`, превью `#bcImagePreview`, кнопка «убрать»;
- `#bcDelivery`: тумблер `#bcCascade` (подпись «Каскад: последняя переписка → порядок из настроек автоуведомлений»), таблица 3 строки (`tdlib` «Telegram», `whatsapp` «WhatsApp», `max` «MAX») — чекбокс `bcCh-<ch>-on`, `bcCh-<ch>-delay` (по умолчанию whatsapp 180, остальные 60), `bcCh-<ch>-limit` (пусто); select `#bcOnLimit` («в следующий мессенджер» / «не отправлять»);
- `#bcForecast` — строка прогноза;
- поле `#bcTestPhone` (значение в `localStorage.bcTestPhone`) и кнопка «🧪 Тест на мой номер».

Помощники `broadcasts-form.js` (тестируемые): `bcCollectChannelSettings(read)` (read — функция `id → value`), `bcFormatForecast(r)` → «Telegram 40 · WhatsApp 50 · MAX 8 · без мессенджера 2 · ≈ 4 ч 10 мин, закончится сегодня в 17:40» / «… завтра в 11:20»; `bcValidateMessengerForm(v)` → массив ошибок (как серверный `parseCreateBody`, но тексты по-русски).
Поток: изменения полей → дебаунс 500 мс → `POST /api/broadcasts/forecast` (список отправляется только после «Разобрать»: хранить `_bcList` = `rows` ответа). Картинка — `POST /api/broadcasts/image` (FormData, через `fetch` с JWT как в других загрузках: `grep -n "FormData" frontend/js/pages/*.js | head` — взять существующий приём) сразу при выборе файла. Отправка — `POST /api/broadcasts` с телом спеки §6. Подсказка «В режиме списка у номеров не из базы {bonuses} = 0», если в тексте есть `{bonuses}`.

Тест `broadcasts-form.test.js`: форматирование прогноза (сегодня/завтра), сбор настроек (пустой лимит → null), валидация (ни одного мессенджера → ошибка) + загрузка ВСЕХ `<script src="js/...">` из `index.html` в один `vm`-контекст без ошибки синтаксиса (образец — `frontend/js/pages/notifications.test.js`, скопировать его загрузчик).

- [ ] Steps: тест → FAIL → реализация → PASS (`node --test frontend/js/pages/broadcasts-form.test.js`) → живая проверка формы через MCP Playwright на дев-стенде (`https://dev.zumrudin.ru`, вход владельцем; ничего не отправлять — только «Разобрать» и прогноз) → Commit `feat(broadcasts): форма рассылки через мессенджеры — список, картинка, каскад, пауза и лимит`

---

### Task 11: Фронт — live-монитор (sonnet)

**Files:** Create `frontend/js/pages/broadcasts-monitor.js` (+ `broadcasts-monitor.test.js`), Modify `frontend/index.html` (подключить скрипт, панель `#bcMonitorOv`), `frontend/js/pages/broadcasts.js` (клик по строке истории мессенджерной рассылки → `bcOpenMonitor(id)`; в истории значок канала 💬/🤖).

Панель: шапка (статус: «Идёт» / «Ночная пауза до 09:00» (`!inWindow`) / «Пауза: шлюз недоступен» / «Пауза» / «Завершена» / «Отменена»), прогресс `(sent+failed+skipped)/total`, кнопки «Пауза» / «Продолжить» / «Отменить остаток»; три карточки мессенджеров: состояние (🟢 отправляет / ⏸ пауза до ЧЧ:ММ:СС с обратным отсчётом раз в секунду от `pausedUntil` / 🔴 лимит n/N / ⚪ выключен), счётчики ушло · доставлено · не доставлено · ждут · отказ, «перешли дальше по каскаду: N»; блок «Сейчас ждут» (20); таблица получателей (`GET /:id/recipients`) с фильтрами статус/мессенджер и поиском по номеру, пагинация 100; итог — кнопка «Новая рассылка по пропущенным» → `POST /:id/retry-draft` → открыть форму в режиме «По списку» с заполненным `_bcList`.
Polling `GET /:id/monitor` каждые 5 с; останавливать при закрытии панели, уходе со страницы (по образцу `bcStartPolling`/остановки в `broadcasts.js`) и выходе из аккаунта; запоздалый ответ закрытой панели не рисовать (счётчик поколений).

Помощники (тест `node --test`): `bcMonState(b)`, `bcChannelLabel(state, nowMs)` (форматирование отсчёта), `bcStatusText(r)` (статусы и причины: `limit` «лимит мессенджера», `no_recipient` «нет адресата», `ambiguous_failure` «мессенджер не подтвердил — могло уйти», `all_rejected` «все мессенджеры отказали»), `bcCascadePath(log)` → «tdlib=отказ → whatsapp».

- [ ] Steps: тест → FAIL → реализация → PASS → бамп `?v=` у изменённых скриптов → Commit `feat(broadcasts): live-монитор рассылки по мессенджерам`

---

### Task 12: e2e, EXPLAIN, документация (sonnet)

**Files:** Create `backend/scripts/broadcast-messengers-e2e.js`, `backend/scripts/broadcast-messengers-explain.js`; Modify `CLAUDE.md` (новый раздел после «Уведомления YClients своими силами»).

- e2e: создаёт рассылку через `service.createBroadcast` по списку `--phones` (по умолчанию `79200255591`) с картинкой из `frontend/uploads/notify_seed/` (первый файл) и каскадом; без `--send` подменяет `sender.sendToRecipient` стабом `{ok:true, delivery:{id:'e2e'}}` и прогоняет `worker.processBroadcast` в цикле с ускоренным `now` (пауза истекает), печатает итоговый монитор; `--send` — реальная отправка, но отказывается, если в списке есть номер вне `--phones`. В конце удаляет созданную рассылку (`DELETE FROM broadcasts WHERE id=$1`, каскад уносит получателей). Запуск: `cd backend && node scripts/broadcast-messengers-e2e.js`.
- explain: `EXPLAIN (ANALYZE, BUFFERS)` для `ACTIVE_SQL`, `STATS_SQL`, `HEADS_SQL` с РЕАЛЬНЫМИ bound-параметрами (правило проекта: параметризованный SQL проверять самим загрузчиком) на последней мессенджерной рассылке дев-БД.
- CLAUDE.md: раздел «### Разовые рассылки через мессенджеры клиники (с 2026-11-..)» — ссылки на спеку и план, модули, решения владельца (ждёт свой мессенджер, лимит на рассылку + on_limit, окно 09–21, пауза/лимит только по рассылкам), at-most-once и ECONNREFUSED → пауза рассылки, «Невозможно доставить» только в монитор, бот-путь не тронут, рычаг `BROADCAST_MESSENGERS=false`, e2e/explain.

- [ ] Steps: прогнать e2e (без `--send`) и explain → вывод в отчёт задачи → полный `npx jest broadcast` и `node --test frontend/js/pages/broadcasts-*.test.js` → Commit `docs(broadcasts): e2e/explain и раздел CLAUDE.md`

---

## Финал (оркестратор)

- [ ] Ревью итогового diff ветки против спеки (один проход, без фоновых агентов).
- [ ] Отчёт владельцу: что сделано, результаты тестов/e2e/EXPLAIN, что НЕ проверено живьём (реальная отправка `--send` только по согласию владельца), предложение по выкату на дев.
