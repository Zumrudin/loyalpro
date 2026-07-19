# AI Booking Agent — Runtime (Phase 2b) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire the Phase-2a toolbox into the live webhook so the agent actually holds a conversation — debounce a message burst, run a Claude ReAct loop over the salon-scoped tools, echo-and-confirm before booking, discard-and-regenerate when the client keeps typing, escalate to a human, and reply back through chatpush.

**Architecture:** A per-process **dispatcher** (`services/agent/dispatcher.js`) debounces a burst per `dialog_key`, checks the admin allow-gate, serializes runs, and sends replies. The **orchestrator** (`services/agent/orchestrator.js`) composes the existing `claude.createMessage` + `tools/index.js` registry into a bounded ReAct loop, threads `dialogKey` into every tool `ctx`, and re-checks a `msg_ts` watermark to throw away a stale draft and regenerate. Dialog transcript and state come from two thin readers (`history.js`, `dialog-state.js`) over the tables already created in 2a. Consent-before-booking lives in the **system prompt** (`system-prompt.js`), not in code. The webhook stops calling the `generateReply` stub and hands each incoming to the dispatcher.

**Tech Stack:** Node.js/Express, PostgreSQL (`pg`, no ORM), `@anthropic-ai/sdk` (Claude `claude-opus-4-8`, tool use), Jest. Reuses all of Phase 2a (`services/agent/claude.js`, `services/agent/tools/*`, `services/agent/booking.js`) and Phase 1 RAG.

**Spec:** `docs/superpowers/specs/2026-07-18-ai-booking-agent-design.md` — components [2] dispatcher/debouncer, [3] orchestrator ReAct loop, [6] reply pipeline, the **consent** half of the `create_booking` gate, the escalation operator-toggle UI, concurrency (watermark/dirty, discard-and-regenerate), and the webhook wiring.

**Scope:** Phase 2b only. Everything in 2a (`docs/superpowers/plans/2026-07-18-ai-booking-agent-foundation.md`) is done: the Claude client, YClients booking helpers, the seven tools, the booking executor (advisory-lock + idempotency), the `agent_dialogs`/`agent_events` tables, and the admin gate (`agent-settings`, `agent-gate`, `routes/agent-settings.js`, the «⚙️ Агент» modal). This plan does **not** add vector search, multi-process orchestration, `AbortController` mid-flight cancel, or payment/refund escalation triggers (all YAGNI per the spec).

---

## Prerequisites (verify before Task 1)

- [ ] **Dependencies installed.** Run: `cd backend && npm install`
  Expected: `node_modules/@anthropic-ai/sdk` and `node_modules/.bin/jest` both exist (2a added `@anthropic-ai/sdk`; `jest ^30` is already in `devDependencies`). If `npx jest --version` prints a version, you are good.
- [ ] **2a suite is green.** Run: `cd backend && npx jest agent-claude.test.js agent-tools.test.js agent-booking.test.js agent-gate.test.js`
  Expected: PASS. If not, fix 2a before starting 2b — this plan builds directly on those modules.

**Verified facts (from codebase, 2026-07-18):**
- `services/agent/claude.js` exports `{ makeClient, createMessage, splitContent, toolResultBlock }`. `createMessage({system, messages, tools}, {client, model, maxTokens})` → raw Anthropic message. `splitContent(message)` → `{ text, toolUses, stopReason }` where each `toolUse` is a raw block `{type:'tool_use', id, name, input}`. `toolResultBlock(toolUseId, result, isError)` → `{type:'tool_result', tool_use_id, content: JSON.stringify(result)[, is_error]}`.
- `services/agent/tools/index.js` exports `{ schemas: [...], handlers: {name → run} }`. Every `run(salonId, input, ctx)` returns a JSON-serializable object. `create_booking` and `escalate_to_operator` read `ctx.dialogKey`.
- `services/agent-settings.js` exports `isAllowed(salonId, phone) → { allow, reason }` (fail-closed on missing `salonId`; `enabled` → block-list → mode/allow-list order).
- `services/chatpush.js`: `parseMessageEvent(body)` → `{ channel, direction, customerId, messageId, replyToMessageId, type, text, fileUrl, mimeType, timestamp, chatId, phone, senderName }` or null. `sendMessage(instanceToken, {text, phone, dispatchRouting, replyToMessageId})`. `replyRoutingFor(channel)` (`telegram_bot → telegram`).
- `chatpush_messages` columns: `salon_id, client_id, customer_id, channel, direction, external_message_id, reply_to_message_id, msg_type, text, file_url, mime_type, sender_name, phone, chat_id, msg_ts, created_at`. Dialog key across the codebase = `COALESCE(NULLIF(phone,''), chat_id)` (see `routes/chat.js`). Index `idx_chatpush_messages_dialogkey (salon_id, COALESCE(NULLIF(phone,''), chat_id), msg_ts DESC)` exists.
- `agent_dialogs` columns (2a): `id, salon_id, dialog_key, status ('bot'|'escalated'|'closed'), collected jsonb, watermark_ts bigint, dirty bool, escalated_reason, assigned_operator, last_activity, created_at, updated_at`, `UNIQUE (salon_id, dialog_key)`.
- `config.js`: `CHATPUSH.{instanceToken, agentEnabled, salonId, customerId}`, `AGENT_LLM_MODEL`, `AGENT_MAX_TOKENS`, `AGENT_DEBOUNCE_MS` (default 5000).
- `routes/chat.js` uses `req.user.salonId` and `const adminOnly = [auth, requireRole('owner','admin')]` from `middleware/auth`.
- `routes/chatpush-webhook.js` resolves `salonId` via `resolveSalonId(customerId)` and already stores the incoming message **before** the agent block runs.
- `frontend/js/pages/chat.js`: `api(method, url[, body])` helper, `_chatEsc(s)`, module-level `_chatActiveKey`, `openChatDialog(key)` loads `/api/chat/dialogs/:key/messages` into `#chat-messages`. `window.loadChat`/`window.openChatDialog` exported.

---

## File Structure

- **Create** `backend/services/agent/system-prompt.js` — `buildSystemPrompt(opts)`: pure Russian system prompt (role, «не выдумывай — только из инструментов», consent-before-`create_booking`, escalation rule, hours, today).
- **Create** `backend/services/agent/history.js` — `loadTranscript(salonId, dialogKey, opts)` → `{ messages, watermark }` (chatpush_messages → Claude turns); `hasIncomingAfter(salonId, dialogKey, watermark)` → bool.
- **Create** `backend/services/agent/dialog-state.js` — `getOrCreate`, `get`, `setWatermark`, `setStatus` over `agent_dialogs`.
- **Create** `backend/services/agent/orchestrator.js` — `runDialog(salonId, dialogKey, opts)` → `{ replies, escalated, sideEffect }`: bounded ReAct loop + watermark discard-and-regenerate.
- **Create** `backend/services/agent/dispatcher.js` — `enqueue(salonId, dialogKey, meta, opts)` + internal `process(...)`: debounce, gate, per-process serialization, send.
- **Modify** `backend/routes/chatpush-webhook.js` — replace the `generateReply` block with `dispatcher.enqueue(...)`; drop the now-unused `chatpush-agent`/`agentSettings` requires.
- **Delete** `backend/services/chatpush-agent.js` — the echo stub, now dead.
- **Modify** `backend/routes/chat.js` — add `GET /dialogs/:key/agent` (status) and `POST /dialogs/:key/agent` (bot↔operator toggle).
- **Modify** `backend/routes/index.js` — no change expected (`/api/chat` and `/chatpush` already mounted); verify only.
- **Modify** `frontend/js/pages/chat.js` — render an escalation banner + «Вернуть боту / Передать оператору» toggle when a dialog is open.
- **Create** tests: `backend/agent-system-prompt.test.js`, `backend/agent-history.test.js`, `backend/agent-dialog-state.test.js`, `backend/agent-orchestrator.test.js`, `backend/agent-dispatcher.test.js`.

---

### Task 1: System prompt (`services/agent/system-prompt.js`)

**Files:**
- Create: `backend/services/agent/system-prompt.js`
- Test: `backend/agent-system-prompt.test.js`

- [ ] **Step 1: Write the failing test**

Create `backend/agent-system-prompt.test.js`:

```javascript
'use strict';

const { buildSystemPrompt } = require('./services/agent/system-prompt');

describe('buildSystemPrompt', () => {
  test('подставляет имя салона и часы', () => {
    const p = buildSystemPrompt({ salonName: 'PERI CLINIC', workingHours: '09:00–21:00', today: '2026-07-18' });
    expect(p).toContain('PERI CLINIC');
    expect(p).toContain('09:00–21:00');
    expect(p).toContain('2026-07-18');
  });

  test('запрещает выдумывать факты и требует инструменты', () => {
    const p = buildSystemPrompt({});
    expect(p).toMatch(/НИКОГДА не выдумыв/i);
    expect(p).toContain('search_knowledge_base');
  });

  test('требует согласие перед create_booking', () => {
    const p = buildSystemPrompt({});
    expect(p).toContain('create_booking');
    expect(p).toMatch(/подтвер|соглас/i);
  });

  test('описывает правило эскалации', () => {
    const p = buildSystemPrompt({});
    expect(p).toContain('escalate_to_operator');
  });

  test('без опций не падает и даёт дефолтное имя', () => {
    const p = buildSystemPrompt();
    expect(typeof p).toBe('string');
    expect(p.length).toBeGreaterThan(50);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && npx jest agent-system-prompt.test.js`
Expected: FAIL — "Cannot find module './services/agent/system-prompt'".

- [ ] **Step 3: Write minimal implementation**

Create `backend/services/agent/system-prompt.js`:

```javascript
'use strict';

// ── Системный промпт агента-администратора. Чистая функция — легко тестируется. ──
// Consent-гейт на create_booking живёт здесь (правило поведения), а не в коде.
// Спека: docs/superpowers/specs/2026-07-18-ai-booking-agent-design.md (Guardrails).

function buildSystemPrompt(opts = {}) {
  const salonName = opts.salonName || 'салон красоты';
  const hours = opts.workingHours || 'уточняй по базе знаний';
  const today = opts.today || '';

  return [
    `Ты — вежливый администратор салона «${salonName}». Пиши по-русски, тепло и кратко.`,
    `Твоя задача — консультировать клиентов по услугам и мастерам и доводить их до записи.`,
    ``,
    `ЖЁСТКИЕ ПРАВИЛА:`,
    `1. Факты — цены, услуги, мастеров, свободные слоты — бери ТОЛЬКО из инструментов. НИКОГДА не выдумывай.`,
    `   Прежде чем ответить по существу, вызови search_knowledge_base, list_services, list_staff или get_available_slots.`,
    `2. Запись оформляй инструментом create_booking ТОЛЬКО после того, как повторил клиенту детали`,
    `   (услуга, мастер, дата и время) и получил однозначное согласие словами («да», «записывайте»).`,
    `   Пока клиент не подтвердил — create_booking не вызывай.`,
    `3. Если клиент просит человека, жалуется или конфликтует, ЛИБО база знаний не даёт ответа и ты не уверен —`,
    `   вызови escalate_to_operator и больше ничего не пиши. Не выдумывай ответ вместо эскалации.`,
    `4. Часы работы: ${hours}. Часовой пояс — Europe/Moscow.${today ? ` Сегодня ${today}.` : ''}`,
    `5. Отвечай коротко (1–4 предложения), без обещаний, которые не подтверждены инструментами.`,
  ].join('\n');
}

module.exports = { buildSystemPrompt };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && npx jest agent-system-prompt.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/services/agent/system-prompt.js backend/agent-system-prompt.test.js
git commit -m "feat(agent): системный промпт (роль, запрет галлюцинаций, consent-гейт, эскалация)"
```

---

### Task 2: Dialog transcript reader (`services/agent/history.js`)

**Files:**
- Create: `backend/services/agent/history.js`
- Test: `backend/agent-history.test.js`

- [ ] **Step 1: Write the failing test**

Create `backend/agent-history.test.js`:

```javascript
'use strict';

jest.mock('./db', () => ({ db: { any: jest.fn(), oneOrNone: jest.fn() } }));

const { db } = require('./db');
const history = require('./services/agent/history');

beforeEach(() => jest.clearAllMocks());

describe('loadTranscript', () => {
  test('incoming→user, outgoing→assistant, серия склеивается, watermark = max incoming ts', async () => {
    // db.any возвращает по msg_ts DESC (как в SQL) — модуль сам развернёт.
    db.any.mockResolvedValue([
      { direction: 'incoming', msg_type: 'text', text: 'и педикюр тоже', msg_ts: 300 },
      { direction: 'incoming', msg_type: 'text', text: 'хочу маникюр',   msg_ts: 200 },
      { direction: 'outgoing', msg_type: 'text', text: 'Здравствуйте!',  msg_ts: 100 },
    ]);
    const { messages, watermark } = await history.loadTranscript(1, '79001112233');
    expect(messages).toEqual([
      { role: 'assistant', content: 'Здравствуйте!' },
      { role: 'user', content: 'хочу маникюр\nи педикюр тоже' },
    ]);
    expect(watermark).toBe(300);
    expect(db.any.mock.calls[0][1]).toEqual([1, '79001112233', 20]);
  });

  test('ведущие assistant-реплики срезаются (Claude требует user первым)', async () => {
    db.any.mockResolvedValue([
      { direction: 'incoming', msg_type: 'text', text: 'привет', msg_ts: 50 },
      { direction: 'outgoing', msg_type: 'text', text: 'Чем помочь?', msg_ts: 10 },
    ]);
    const { messages } = await history.loadTranscript(1, 'k');
    expect(messages[0].role).toBe('user');
  });

  test('пустой диалог → пустые messages, watermark 0', async () => {
    db.any.mockResolvedValue([]);
    const { messages, watermark } = await history.loadTranscript(1, 'k');
    expect(messages).toEqual([]);
    expect(watermark).toBe(0);
  });
});

describe('hasIncomingAfter', () => {
  test('true, если есть входящее новее watermark', async () => {
    db.oneOrNone.mockResolvedValue({ '?column?': 1 });
    const out = await history.hasIncomingAfter(1, 'k', 200);
    expect(out).toBe(true);
    expect(db.oneOrNone.mock.calls[0][1]).toEqual([1, 'k', 200]);
  });
  test('false, если нет', async () => {
    db.oneOrNone.mockResolvedValue(null);
    expect(await history.hasIncomingAfter(1, 'k', 200)).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && npx jest agent-history.test.js`
Expected: FAIL — "Cannot find module './services/agent/history'".

- [ ] **Step 3: Write minimal implementation**

Create `backend/services/agent/history.js`:

```javascript
'use strict';

const { db } = require('../../db');

// Ключ диалога в chatpush_messages — тот же, что во всём коде (routes/chat.js):
// телефон, либо chat_id для каналов без телефона (Telegram/MAX).
const DIALOG_KEY_SQL = `COALESCE(NULLIF(phone,''), chat_id)`;

// Транскрипт диалога для Claude Messages API.
//  incoming → {role:'user'}, outgoing (наши эхо-ответы) → {role:'assistant'}.
// Возвращает { messages, watermark }, где watermark = max(msg_ts) входящих.
async function loadTranscript(salonId, dialogKey, opts = {}) {
  const limit = opts.limit || 20;
  const rows = await db.any(
    `SELECT direction, msg_type, text, msg_ts
       FROM chatpush_messages
      WHERE salon_id = $1 AND ${DIALOG_KEY_SQL} = $2
        AND text IS NOT NULL AND text <> ''
      ORDER BY msg_ts DESC, id DESC
      LIMIT $3`,
    [salonId, dialogKey, limit]);

  rows.reverse();   // из DESC (свежие сверху) → в хронологический порядок

  const messages = [];
  let watermark = 0;
  for (const r of rows) {
    if (r.direction === 'incoming' && Number(r.msg_ts) > watermark) watermark = Number(r.msg_ts);
    const role = r.direction === 'outgoing' ? 'assistant' : 'user';
    const last = messages[messages.length - 1];
    if (last && last.role === role) last.content += `\n${r.text}`;   // склейка серии
    else messages.push({ role, content: r.text });
  }
  // Claude требует, чтобы первым шёл user — срезаем ведущие assistant-реплики.
  while (messages.length && messages[0].role === 'assistant') messages.shift();
  return { messages, watermark };
}

// Пришло ли входящее новее watermark (во время прогона агента)?
async function hasIncomingAfter(salonId, dialogKey, watermark) {
  const row = await db.oneOrNone(
    `SELECT 1 FROM chatpush_messages
      WHERE salon_id = $1 AND ${DIALOG_KEY_SQL} = $2
        AND direction = 'incoming' AND msg_ts > $3
      LIMIT 1`,
    [salonId, dialogKey, watermark || 0]);
  return !!row;
}

module.exports = { loadTranscript, hasIncomingAfter };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && npx jest agent-history.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/services/agent/history.js backend/agent-history.test.js
git commit -m "feat(agent): транскрипт диалога для Claude + watermark-проверка новых входящих"
```

---

### Task 3: Dialog state store (`services/agent/dialog-state.js`)

**Files:**
- Create: `backend/services/agent/dialog-state.js`
- Test: `backend/agent-dialog-state.test.js`

- [ ] **Step 1: Write the failing test**

Create `backend/agent-dialog-state.test.js`:

```javascript
'use strict';

jest.mock('./db', () => ({ db: { one: jest.fn(), oneOrNone: jest.fn(), query: jest.fn() } }));

const { db } = require('./db');
const state = require('./services/agent/dialog-state');

beforeEach(() => jest.clearAllMocks());

describe('getOrCreate', () => {
  test('апсертит строку диалога и возвращает её', async () => {
    db.one.mockResolvedValue({ id: 1, status: 'bot', watermark_ts: 0, dirty: false });
    const row = await state.getOrCreate(1, '79001112233');
    expect(row.status).toBe('bot');
    const sql = db.one.mock.calls[0][0];
    expect(sql).toMatch(/INSERT INTO agent_dialogs/i);
    expect(sql).toMatch(/ON CONFLICT \(salon_id, dialog_key\)/i);
    expect(db.one.mock.calls[0][1]).toEqual([1, '79001112233']);
  });
});

describe('setWatermark', () => {
  test('пишет watermark_ts и сбрасывает dirty', async () => {
    db.query.mockResolvedValue({ rows: [] });
    await state.setWatermark(1, 'k', 300);
    const [sql, params] = db.query.mock.calls[0];
    expect(sql).toMatch(/UPDATE agent_dialogs/i);
    expect(sql).toMatch(/watermark_ts\s*=\s*\$3/i);
    expect(sql).toMatch(/dirty\s*=\s*false/i);
    expect(params).toEqual([1, 'k', 300]);
  });
});

describe('setStatus', () => {
  test('меняет статус диалога', async () => {
    db.query.mockResolvedValue({ rows: [] });
    await state.setStatus(1, 'k', 'escalated', 'жалоба');
    const [sql, params] = db.query.mock.calls[0];
    expect(sql).toMatch(/UPDATE agent_dialogs/i);
    expect(sql).toMatch(/status\s*=\s*\$3/i);
    expect(params).toEqual([1, 'k', 'escalated', 'жалоба']);
  });
});

describe('get', () => {
  test('возвращает строку или null', async () => {
    db.oneOrNone.mockResolvedValue(null);
    expect(await state.get(1, 'k')).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && npx jest agent-dialog-state.test.js`
Expected: FAIL — "Cannot find module './services/agent/dialog-state'".

- [ ] **Step 3: Write minimal implementation**

Create `backend/services/agent/dialog-state.js`:

```javascript
'use strict';

const { db } = require('../../db');

// ── Состояние диалога агента (agent_dialogs). Тонкие обёртки над SQL. ──

// Гарантированно вернуть строку диалога (создать при первом обращении).
async function getOrCreate(salonId, dialogKey) {
  return db.one(
    `INSERT INTO agent_dialogs (salon_id, dialog_key)
     VALUES ($1, $2)
     ON CONFLICT (salon_id, dialog_key)
       DO UPDATE SET last_activity = now()
     RETURNING id, salon_id, dialog_key, status, collected, watermark_ts, dirty`,
    [salonId, dialogKey]);
}

async function get(salonId, dialogKey) {
  return db.oneOrNone(
    `SELECT id, status, collected, watermark_ts, dirty, escalated_reason
       FROM agent_dialogs WHERE salon_id = $1 AND dialog_key = $2`,
    [salonId, dialogKey]);
}

// Зафиксировать прочитанную водяную метку и сбросить dirty после успешного хода.
async function setWatermark(salonId, dialogKey, watermark) {
  await db.query(
    `UPDATE agent_dialogs
        SET watermark_ts = $3, dirty = false, updated_at = now()
      WHERE salon_id = $1 AND dialog_key = $2`,
    [salonId, dialogKey, watermark || 0]);
}

// Сменить статус (bot ↔ escalated ↔ closed). reason — для escalated.
async function setStatus(salonId, dialogKey, status, reason = null) {
  await db.query(
    `UPDATE agent_dialogs
        SET status = $3, escalated_reason = $4, updated_at = now()
      WHERE salon_id = $1 AND dialog_key = $2`,
    [salonId, dialogKey, status, reason]);
}

module.exports = { getOrCreate, get, setWatermark, setStatus };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && npx jest agent-dialog-state.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/services/agent/dialog-state.js backend/agent-dialog-state.test.js
git commit -m "feat(agent): dialog-state — состояние диалога (getOrCreate/watermark/status)"
```

---

### Task 4: Orchestrator ReAct loop (`services/agent/orchestrator.js`)

The orchestrator composes `claude.createMessage` + the tool registry into a bounded loop, threads `dialogKey` into every tool `ctx`, and implements the concurrency rule from the spec: after building a draft, if a new incoming arrived (`hasIncomingAfter(watermark)`) **and** no writing tool ran, throw the draft away and regenerate with full context; if a booking already happened, keep it and let the next turn handle the new message.

**Files:**
- Create: `backend/services/agent/orchestrator.js`
- Test: `backend/agent-orchestrator.test.js`

- [ ] **Step 1: Write the failing test**

Create `backend/agent-orchestrator.test.js`:

```javascript
'use strict';

// Реальный claude нужен только для splitContent/toolResultBlock; createMessage мокаем.
const realClaude = require('./services/agent/claude');

const orchestrator = require('./services/agent/orchestrator');

function makeDeps(overrides = {}) {
  return {
    claude: {
      splitContent: realClaude.splitContent,
      toolResultBlock: realClaude.toolResultBlock,
      createMessage: jest.fn(),
      ...overrides.claude,
    },
    registry: {
      schemas: [{ name: 'get_available_slots' }, { name: 'escalate_to_operator' }, { name: 'create_booking' }],
      handlers: {
        get_available_slots: jest.fn(async () => ({ slots: [{ time: '10:00' }] })),
        escalate_to_operator: jest.fn(async () => ({ escalated: true, reason: 'жалоба' })),
        create_booking: jest.fn(async () => ({ created: true, record_id: 999 })),
        ...(overrides.handlers || {}),
      },
    },
    history: {
      loadTranscript: jest.fn(async () => ({ messages: [{ role: 'user', content: 'привет' }], watermark: 100 })),
      hasIncomingAfter: jest.fn(async () => false),
      ...overrides.history,
    },
    state: {
      getOrCreate: jest.fn(async () => ({ status: 'bot' })),
      setWatermark: jest.fn(async () => {}),
      ...overrides.state,
    },
  };
}

const textMsg = (t) => ({ stop_reason: 'end_turn', content: [{ type: 'text', text: t }] });
const toolMsg = (name, input, id = 'tu_1', text = '') => ({
  stop_reason: 'tool_use',
  content: [...(text ? [{ type: 'text', text }] : []), { type: 'tool_use', id, name, input }],
});

describe('runDialog', () => {
  test('только текст → возвращает реплику, инструменты не звались', async () => {
    const deps = makeDeps();
    deps.claude.createMessage.mockResolvedValueOnce(textMsg('Здравствуйте! Чем помочь?'));
    const out = await orchestrator.runDialog(1, 'k', { deps, today: '2026-07-18' });
    expect(out.replies).toEqual(['Здравствуйте! Чем помочь?']);
    expect(out.escalated).toBe(false);
    expect(out.sideEffect).toBe(false);
    expect(deps.claude.createMessage).toHaveBeenCalledTimes(1);
    expect(deps.state.setWatermark).toHaveBeenCalledWith(1, 'k', 100);
  });

  test('tool_use → выполняет инструмент с ctx.dialogKey, скармливает результат, финализирует', async () => {
    const deps = makeDeps();
    deps.claude.createMessage
      .mockResolvedValueOnce(toolMsg('get_available_slots', { staff_yc_id: 55, service_yc_id: 7, date: '2026-07-20' }))
      .mockResolvedValueOnce(textMsg('Свободно 10:00. Записать?'));
    const out = await orchestrator.runDialog(1, 'k', { deps, ctx: { phone: '79001112233' } });
    expect(deps.registry.handlers.get_available_slots)
      .toHaveBeenCalledWith(1, { staff_yc_id: 55, service_yc_id: 7, date: '2026-07-20' }, { dialogKey: 'k', clientPhone: '79001112233' });
    expect(out.replies).toContain('Свободно 10:00. Записать?');
    expect(out.sideEffect).toBe(false);
    // второй вызов Claude получил tool_result
    const secondCallMessages = deps.claude.createMessage.mock.calls[1][0].messages;
    const toolResultTurn = secondCallMessages[secondCallMessages.length - 1];
    expect(toolResultTurn.role).toBe('user');
    expect(toolResultTurn.content[0].type).toBe('tool_result');
  });

  test('escalate_to_operator → escalated:true и цикл останавливается', async () => {
    const deps = makeDeps();
    deps.claude.createMessage.mockResolvedValueOnce(toolMsg('escalate_to_operator', { reason: 'жалоба' }));
    const out = await orchestrator.runDialog(1, 'k', { deps });
    expect(out.escalated).toBe(true);
    expect(out.sideEffect).toBe(true);
    expect(deps.claude.createMessage).toHaveBeenCalledTimes(1);
  });

  test('диалог уже escalated → ничего не делаем', async () => {
    const deps = makeDeps({ state: { getOrCreate: jest.fn(async () => ({ status: 'escalated' })) } });
    const out = await orchestrator.runDialog(1, 'k', { deps });
    expect(out.escalated).toBe(true);
    expect(deps.claude.createMessage).not.toHaveBeenCalled();
  });

  test('новое входящее во время прогона без side-effect → черновик выброшен, перегенерация', async () => {
    let calls = 0;
    const deps = makeDeps({ history: { hasIncomingAfter: jest.fn(async () => (++calls === 1)) } });
    deps.claude.createMessage
      .mockResolvedValueOnce(textMsg('ответ про маникюр'))   // 1-й прогон — выбрасывается
      .mockResolvedValueOnce(textMsg('ответ про педикюр'));  // 2-й прогон — отдаётся
    const out = await orchestrator.runDialog(1, 'k', { deps });
    expect(out.replies).toEqual(['ответ про педикюр']);
    expect(deps.history.loadTranscript).toHaveBeenCalledTimes(2);
  });

  test('защитный лимит итераций: бесконечный tool_use не зацикливается', async () => {
    const deps = makeDeps();
    deps.claude.createMessage.mockResolvedValue(
      toolMsg('get_available_slots', { staff_yc_id: 1, service_yc_id: 1, date: '2026-07-20' }));
    await orchestrator.runDialog(1, 'k', { deps });
    expect(deps.claude.createMessage).toHaveBeenCalledTimes(orchestrator.MAX_ITERS);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && npx jest agent-orchestrator.test.js`
Expected: FAIL — "Cannot find module './services/agent/orchestrator'".

- [ ] **Step 3: Write minimal implementation**

Create `backend/services/agent/orchestrator.js`:

```javascript
'use strict';

const claudeDefault = require('./claude');
const registryDefault = require('./tools');
const historyDefault = require('./history');
const stateDefault = require('./dialog-state');
const { buildSystemPrompt } = require('./system-prompt');
const { createLogger } = require('../../logger');
const logger = createLogger('AgentOrchestrator');

const MAX_ITERS = 6;   // защитный лимит tool-use итераций на один ход
const MAX_REGEN = 2;   // сколько раз перегенерировать при новом входящем во время прогона

// Пишущие инструменты: их результат нельзя «выбросить» перегенерацией.
const SIDE_EFFECT_TOOLS = new Set(['create_booking', 'escalate_to_operator']);

// YYYY-MM-DD по Москве (для системного промпта «сегодня …»).
function todayMoscow() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Moscow' }).format(new Date());
}

// Прогнать один ход диалога. Возвращает { replies, escalated, sideEffect }.
async function runDialog(salonId, dialogKey, opts = {}) {
  const d = opts.deps || {};
  const claude = d.claude || claudeDefault;
  const registry = d.registry || registryDefault;
  const history = d.history || historyDefault;
  const state = d.state || stateDefault;
  const ctx = opts.ctx || {};

  const dialog = await state.getOrCreate(salonId, dialogKey);
  if (dialog.status === 'escalated') {
    return { replies: [], escalated: true, sideEffect: false };
  }

  const system = buildSystemPrompt({
    salonName: opts.salonName,
    workingHours: opts.workingHours,
    today: opts.today || todayMoscow(),
  });
  const toolCtx = { dialogKey, clientPhone: ctx.phone };

  for (let attempt = 0; attempt <= MAX_REGEN; attempt++) {
    const { messages, watermark } = await history.loadTranscript(salonId, dialogKey, { limit: 20 });
    if (!messages.length) return { replies: [], escalated: false, sideEffect: false };

    const convo = messages.slice();
    const replies = [];
    let escalated = false;
    let sideEffect = false;

    for (let i = 0; i < MAX_ITERS; i++) {
      const message = await claude.createMessage(
        { system, messages: convo, tools: registry.schemas },
        { client: opts.client });
      const { text, toolUses, stopReason } = claude.splitContent(message);

      convo.push({ role: 'assistant', content: message.content });
      if (text) replies.push(text);

      if (stopReason !== 'tool_use' || !toolUses.length) break;

      const resultBlocks = [];
      for (const tu of toolUses) {
        const handler = registry.handlers[tu.name];
        let result;
        try {
          result = handler
            ? await handler(salonId, tu.input, toolCtx)
            : { error: `Неизвестный инструмент: ${tu.name}` };
        } catch (e) {
          logger.error(`tool ${tu.name} failed: ${e.message}`);
          result = { error: e.message };
        }
        const isError = !!(result && result.error);
        if (!isError && SIDE_EFFECT_TOOLS.has(tu.name)) sideEffect = true;
        if (tu.name === 'escalate_to_operator' && result && result.escalated) escalated = true;
        resultBlocks.push(claude.toolResultBlock(tu.id, result, isError));
      }
      convo.push({ role: 'user', content: resultBlocks });
      if (escalated) break;
    }

    // Пришло ли новое входящее, пока мы думали?
    const stale = await history.hasIncomingAfter(salonId, dialogKey, watermark);
    if (stale && !sideEffect && attempt < MAX_REGEN) {
      logger.info(`dialog ${dialogKey}: новое сообщение во время прогона — выбрасываю черновик, перегенерация (${attempt + 1})`);
      continue;   // выбрасываем текстовый черновик, крутим заново с полным контекстом
    }

    await state.setWatermark(salonId, dialogKey, watermark);
    return { replies, escalated, sideEffect };
  }

  return { replies: [], escalated: false, sideEffect: false };
}

module.exports = { runDialog, todayMoscow, MAX_ITERS, MAX_REGEN };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && npx jest agent-orchestrator.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/services/agent/orchestrator.js backend/agent-orchestrator.test.js
git commit -m "feat(agent): оркестратор ReAct (tool-loop + watermark discard-and-regenerate)"
```

---

### Task 5: Dispatcher / debouncer (`services/agent/dispatcher.js`)

One PM2 process → in-memory debounce map keyed by `salon:dialog_key`. `enqueue` is called from the webhook on every incoming; after `AGENT_DEBOUNCE_MS` of silence it runs `process`, which checks the admin allow-gate, serializes runs per dialog (a message arriving mid-run sets a `rerun` flag so the run repeats), runs the orchestrator, and sends replies through chatpush.

**Files:**
- Create: `backend/services/agent/dispatcher.js`
- Test: `backend/agent-dispatcher.test.js`

- [ ] **Step 1: Write the failing test**

Create `backend/agent-dispatcher.test.js`:

```javascript
'use strict';

jest.useFakeTimers();

const dispatcher = require('./services/agent/dispatcher');

const meta = { phone: '79001112233', channel: 'whatsapp', messageId: 'm1' };

function deps(overrides = {}) {
  return {
    debounceMs: 1000,
    settings: { isAllowed: jest.fn(async () => ({ allow: true, reason: 'ok' })) },
    orchestrator: { runDialog: jest.fn(async () => ({ replies: ['Здравствуйте!'], escalated: false })) },
    send: jest.fn(async () => {}),
    ...overrides,
  };
}

beforeEach(() => { dispatcher._reset(); jest.clearAllTimers(); });

test('серия из двух сообщений в окне дебаунса → один прогон', async () => {
  const d = deps();
  dispatcher.enqueue(1, 'k', meta, d);
  dispatcher.enqueue(1, 'k', meta, d);
  await jest.advanceTimersByTimeAsync(1000);
  expect(d.orchestrator.runDialog).toHaveBeenCalledTimes(1);
  expect(d.send).toHaveBeenCalledWith(meta, 'Здравствуйте!');
});

test('гейт запретил → прогон не запускается', async () => {
  const d = deps({ settings: { isAllowed: jest.fn(async () => ({ allow: false, reason: 'whitelist' })) } });
  dispatcher.enqueue(1, 'k', meta, d);
  await jest.advanceTimersByTimeAsync(1000);
  expect(d.orchestrator.runDialog).not.toHaveBeenCalled();
  expect(d.send).not.toHaveBeenCalled();
});

test('несколько реплик отправляются по очереди', async () => {
  const d = deps({ orchestrator: { runDialog: jest.fn(async () => ({ replies: ['раз', 'два'] })) } });
  dispatcher.enqueue(1, 'k', meta, d);
  await jest.advanceTimersByTimeAsync(1000);
  expect(d.send).toHaveBeenCalledTimes(2);
  expect(d.send).toHaveBeenNthCalledWith(1, meta, 'раз');
  expect(d.send).toHaveBeenNthCalledWith(2, meta, 'два');
});

test('гейт проверяется по телефону из meta', async () => {
  const d = deps();
  dispatcher.enqueue(1, 'k', meta, d);
  await jest.advanceTimersByTimeAsync(1000);
  expect(d.settings.isAllowed).toHaveBeenCalledWith(1, '79001112233');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && npx jest agent-dispatcher.test.js`
Expected: FAIL — "Cannot find module './services/agent/dispatcher'".

- [ ] **Step 3: Write minimal implementation**

Create `backend/services/agent/dispatcher.js`:

```javascript
'use strict';

const config = require('../../config');
const agentSettings = require('../agent-settings');
const chatpush = require('../chatpush');
const orchestratorDefault = require('./orchestrator');
const { createLogger } = require('../../logger');
const logger = createLogger('AgentDispatcher');

// Один PM2-процесс → in-memory состояние (спека [2]: дебаунс на один процесс).
const timers = new Map();   // key → { timer, meta }  (дебаунс серии)
const running = new Set();   // key диалогов в обработке (сериализация в процессе)
const rerun = new Set();     // пришло входящее, пока диалог обрабатывался

function keyOf(salonId, dialogKey) { return `${salonId}:${dialogKey}`; }

// Вызывается из вебхука на каждое ВХОДЯЩЕЕ. Копит серию, запускает после тишины.
// opts (для тестов): { debounceMs, settings, orchestrator, send }.
function enqueue(salonId, dialogKey, meta, opts = {}) {
  const k = keyOf(salonId, dialogKey);
  const debounceMs = opts.debounceMs || config.AGENT_DEBOUNCE_MS;
  if (running.has(k)) rerun.add(k);   // прогон уже идёт — перезапустим после него

  const existing = timers.get(k);
  if (existing) clearTimeout(existing.timer);
  const timer = setTimeout(() => {
    timers.delete(k);
    void process(salonId, dialogKey, meta, opts);
  }, debounceMs);
  timers.set(k, { timer, meta });
}

async function process(salonId, dialogKey, meta, opts = {}) {
  const k = keyOf(salonId, dialogKey);
  const settings = opts.settings || agentSettings;
  const orchestrator = opts.orchestrator || orchestratorDefault;
  const send = opts.send || defaultSend;

  const gate = await settings.isAllowed(salonId, meta.phone);
  if (!gate.allow) { logger.info(`gate skip ${dialogKey} (${gate.reason})`); return; }

  if (running.has(k)) { rerun.add(k); return; }
  running.add(k);
  try {
    const res = await orchestrator.runDialog(salonId, dialogKey, { ctx: { phone: meta.phone } });
    for (const text of (res.replies || [])) {
      if (text && text.trim()) await send(meta, text);
    }
  } catch (e) {
    logger.error(`dialog ${dialogKey} failed: ${e.message}`);
  } finally {
    running.delete(k);
  }
  if (rerun.delete(k)) {
    logger.info(`dialog ${dialogKey}: отложенный прогон (сообщение пришло во время обработки)`);
    return process(salonId, dialogKey, meta, opts);
  }
}

// Отправка одной реплики обратно клиенту через chatpush.
async function defaultSend(meta, text) {
  const token = config.CHATPUSH.instanceToken;
  if (!token) { logger.error('CHATPUSH_INSTANCE_TOKEN not set — cannot reply'); return; }
  return chatpush.sendMessage(token, {
    text,
    phone: meta.phone,
    dispatchRouting: [chatpush.replyRoutingFor(meta.channel)],
    replyToMessageId: meta.messageId,
  });
}

// Сброс in-memory состояния — только для тестов.
function _reset() {
  for (const { timer } of timers.values()) clearTimeout(timer);
  timers.clear(); running.clear(); rerun.clear();
}

module.exports = { enqueue, process, defaultSend, _reset };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && npx jest agent-dispatcher.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/services/agent/dispatcher.js backend/agent-dispatcher.test.js
git commit -m "feat(agent): диспетчер-дебаунсер (серия→один прогон, гейт, сериализация, отправка)"
```

---

### Task 6: Wire the webhook to the dispatcher

Replace the echo-stub path in `routes/chatpush-webhook.js` with a `dispatcher.enqueue`. The admin gate now lives in the dispatcher, so drop the inline `agentSettings.isAllowed` call and the `chatpush-agent` require. Keep the env kill-switch (`config.CHATPUSH.agentEnabled`) and the immediate `200` ACK untouched.

**Files:**
- Modify: `backend/routes/chatpush-webhook.js`
- Delete: `backend/services/chatpush-agent.js`

- [ ] **Step 1: Swap the require lines**

In `backend/routes/chatpush-webhook.js`, replace:

```javascript
const { generateReply } = require('../services/chatpush-agent');
const agentSettings = require('../services/agent-settings');
```

with:

```javascript
const dispatcher = require('../services/agent/dispatcher');

// Текстовые типы разных каналов: WhatsApp/MAX → 'text', tdlib/Telegram → 'formattedText'.
const AGENT_TEXT_TYPES = new Set(['text', 'formattedText']);
```

- [ ] **Step 2: Replace the auto-reply block**

In `backend/routes/chatpush-webhook.js`, replace the entire block that currently starts at `// 3) Авто-ответ …` and ends at the closing brace of that `if` (the block that calls `agentSettings.isAllowed`, `generateReply`, and `chatpush.sendMessage`) with:

```javascript
    // 3) Авто-ответ агента — при глобальном флаге (env kill-switch) И только на
    //    ВХОДЯЩЕЕ текстовое сообщение. Гейт допуска (per-salon вкл/выкл + бело/чёрный
    //    список), дебаунс серии, ReAct-цикл и отправка — внутри диспетчера.
    if (
      config.CHATPUSH.agentEnabled &&
      msg && msg.direction === 'incoming' &&
      AGENT_TEXT_TYPES.has(msg.type) && (msg.text || '').trim()
    ) {
      const dialogKey = (msg.phone && msg.phone.trim()) || msg.chatId;
      if (dialogKey) {
        dispatcher.enqueue(salonId, dialogKey, {
          phone: msg.phone,
          channel: msg.channel,
          messageId: msg.messageId,
        });
      }
    }
```

- [ ] **Step 3: Delete the stub**

Run: `git rm backend/services/chatpush-agent.js`
Expected: file removed. (Verified there are no other requires of `chatpush-agent` — grep before deleting: `grep -rn "chatpush-agent" backend --include=*.js` should return nothing after the edits above.)

- [ ] **Step 4: Verify the server still boots and routes load**

Run: `cd backend && node -e "require('./routes/chatpush-webhook'); require('./services/agent/dispatcher'); require('./services/agent/orchestrator'); console.log('OK')"`
Expected: prints `OK` (no missing-module or syntax error).

- [ ] **Step 5: Verify no dangling references**

Run: `cd backend && grep -rn "chatpush-agent\|generateReply" --include=*.js . | grep -v node_modules`
Expected: no output.

- [ ] **Step 6: Commit**

```bash
git add backend/routes/chatpush-webhook.js
git rm backend/services/chatpush-agent.js
git commit -m "feat(agent): вебхук отдаёт входящее диспетчеру агента (вместо эхо-заглушки)"
```

---

### Task 7: Escalation operator-toggle (backend + Chat page banner)

When a dialog is `escalated` the bot is silent; an operator answers by hand on the Chat page and can hand control back to the bot. Add two endpoints on the existing `/api/chat` router and a banner + toggle on the Chat page.

**Files:**
- Modify: `backend/routes/chat.js`
- Modify: `frontend/js/pages/chat.js`

- [ ] **Step 1: Add the agent-status endpoints**

In `backend/routes/chat.js`, immediately before the final `module.exports = router;`, add:

```javascript
// GET /api/chat/dialogs/:key/agent — статус агента по диалогу (для баннера).
router.get('/dialogs/:key/agent', adminOnly, async (req, res) => {
  try {
    const salonId = req.user.salonId;
    const key = String(req.params.key || '');
    if (!key) return res.status(400).json({ error: 'Пустой ключ диалога' });
    const row = await db.oneOrNone(
      `SELECT status, escalated_reason FROM agent_dialogs
        WHERE salon_id = $1 AND dialog_key = $2`,
      [salonId, key]);
    // Нет строки → агент этим диалогом ещё не занимался: считаем 'bot'.
    res.json({ status: row ? row.status : 'bot', escalatedReason: row ? row.escalated_reason : null });
  } catch (e) {
    logger.error(`agent status failed: ${e.message}`);
    res.status(500).json({ error: 'Не удалось загрузить статус агента' });
  }
});

// POST /api/chat/dialogs/:key/agent — переключить бот ↔ оператор.
// body: { status: 'bot' | 'escalated' }. 'bot' = вернуть управление боту.
router.post('/dialogs/:key/agent', adminOnly, async (req, res) => {
  try {
    const salonId = req.user.salonId;
    const key = String(req.params.key || '');
    const status = req.body && req.body.status === 'escalated' ? 'escalated' : 'bot';
    if (!key) return res.status(400).json({ error: 'Пустой ключ диалога' });
    // Upsert: диалога может ещё не быть в agent_dialogs, если бот не отвечал.
    await db.query(
      `INSERT INTO agent_dialogs (salon_id, dialog_key, status)
       VALUES ($1, $2, $3)
       ON CONFLICT (salon_id, dialog_key)
         DO UPDATE SET status = $3, updated_at = now()`,
      [salonId, key, status]);
    res.json({ status });
  } catch (e) {
    logger.error(`agent toggle failed: ${e.message}`);
    res.status(500).json({ error: 'Не удалось переключить режим' });
  }
});
```

- [ ] **Step 2: Verify the route file loads**

Run: `cd backend && node -e "require('./routes/chat'); console.log('OK')"`
Expected: prints `OK`.

- [ ] **Step 3: Manually exercise the endpoints (server running)**

With the dev server up (`pm2 restart loyalpro` or `npm run dev`) and a valid owner/admin JWT in `$TOKEN`:

```bash
# hand a dialog to the operator
curl -s -X POST localhost:3001/api/chat/dialogs/79001112233/agent \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"status":"escalated"}'
# → {"status":"escalated"}
curl -s localhost:3001/api/chat/dialogs/79001112233/agent -H "Authorization: Bearer $TOKEN"
# → {"status":"escalated","escalatedReason":null}
# return control to the bot
curl -s -X POST localhost:3001/api/chat/dialogs/79001112233/agent \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{"status":"bot"}'
# → {"status":"bot"}
```

Expected: the three responses above.

- [ ] **Step 4: Add the banner + toggle to the Chat page**

In `frontend/js/pages/chat.js`, add these two functions immediately above the `window.loadChat = loadChat;` line:

```javascript
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
```

- [ ] **Step 5: Call the banner when a dialog opens**

In `frontend/js/pages/chat.js`, inside `openChatDialog`, right after `renderChatMessages(data.messages || []);`, add:

```javascript
    await renderAgentBanner(key);
```

- [ ] **Step 6: Verify in the browser (MCP Playwright)**

Use the MCP Playwright server: log in as owner/admin, open the «Чат» page, select a dialog, confirm the «🤖 Отвечает бот» banner renders above the messages, click «Передать оператору», confirm it flips to «👤 Отвечает оператор (бот молчит)» and back. (No CSS is required for correctness; if the banner looks unstyled, a follow-up styling pass can add `.chat-agent-banner` rules — out of scope for behavior.)

- [ ] **Step 7: Commit**

```bash
git add backend/routes/chat.js frontend/js/pages/chat.js
git commit -m "feat(agent): эскалация — тумблер бот↔оператор на странице «Чат» + API статуса"
```

---

### Task 8: Full agent suite + manual E2E + enable checklist

- [ ] **Step 1: Run the whole agent test suite**

Run: `cd backend && npx jest agent-`
Expected: PASS across all agent test files (2a + 2b): `agent-gate`, `agent-rag`, `agent-rag-io`, `agent-claude`, `agent-tools`, `agent-booking`, `agent-system-prompt`, `agent-history`, `agent-dialog-state`, `agent-orchestrator`, `agent-dispatcher`.

- [ ] **Step 2: Run migrations against dev (idempotent — tables already exist from 2a)**

Run: `cd backend && node -e "const {pool}=require('./db'); const {runMigrations}=require('./migrations'); pool.connect().then(async c=>{await runMigrations(c); c.release(); console.log('OK'); process.exit(0)}).catch(e=>{console.error(e);process.exit(1)})"`
Expected: prints `OK`.

- [ ] **Step 3: Confirm required env is present**

Run: `cd backend && node -e "const c=require('./config'); console.log('key?', !!c.ANTHROPIC_API_KEY, 'token?', !!c.CHATPUSH.instanceToken, 'kill?', c.CHATPUSH.agentEnabled, 'salon', c.CHATPUSH.salonId)"`
Expected: `key? true token? true kill? … salon <n>`. If `ANTHROPIC_API_KEY` or `CHATPUSH_INSTANCE_TOKEN` is missing, set it in the dev environment before enabling the agent. `CHATPUSH_AGENT_ENABLED` stays `false` until Step 5.

- [ ] **Step 4: Configure the whitelist pilot in the admin UI**

In the «Чат» → «⚙️ Агент» modal (owner/admin): toggle the agent **on**, set mode **whitelist**, and add **only the owner's own number** to the allow-list. This makes the bot answer just that number on live traffic. (Per spec §"Основной сценарий на старте".)

- [ ] **Step 5: End-to-end smoke on the dev server**

Set `CHATPUSH_AGENT_ENABLED=true` for the dev process and restart:

```bash
pm2 restart loyalpro --update-env
```

⚠️ Per memory `ref_chatpush_dev_api` and the design spec, PERI CLINIC prod traffic (customer_id 46594) currently flows into the **dev** server/DB — the whitelist in Step 4 is what keeps the bot from answering real clients during the pilot. Double-check the allow-list before this step.

From the whitelisted phone, send a real WhatsApp/Telegram message ("Здравствуйте, сколько стоит ботокс?") and verify, watching `pm2 logs loyalpro`:
- the incoming is stored (`stored incoming …`),
- `AgentDispatcher` runs after the debounce (no `gate skip`),
- `AgentOrchestrator` calls `search_knowledge_base`/`list_services`,
- a grounded reply is sent back on the same channel,
- `agent_dialogs` has a row with the correct `dialog_key` and `watermark_ts`, and `agent_events` logged the tool calls.

Then walk a booking: ask for a service → master → date, confirm the slot, say "да, записывайте", and verify a YClients record is created **once** (check `agent_events` for `booking_created` and no duplicate on a webhook retry). Finally send "позовите человека" and confirm the dialog flips to `escalated`, the bot goes silent, and the Chat-page banner shows the operator mode.

- [ ] **Step 6: Verify the YClients booking field names against a real test company**

Open item flagged in 2a self-review: confirm `/book_times`, `/book_dates`, `POST /records` field names (`seance_length`, `datetime`, `services:[{id}]`, `client:{phone,name}`) against a real test company before trusting live booking. If a field differs, fix `services/yclients-booking.js` and re-run `npx jest yclients-booking.test.js`. Record the outcome; do not enable `mode = all` until a real booking round-trips.

- [ ] **Step 7: Commit any fixes from E2E**

```bash
git add -A
git commit -m "fix(agent): правки по итогам сквозного прогона 2b (E2E)"
```

(If nothing changed, skip this commit.)

---

## Self-Review Notes

- **Spec coverage (2b):**
  - [2] Dispatcher/debouncer + admin allow-gate → Task 5 (`dispatcher.js`), gate delegated to `agent-settings.isAllowed`, wired in Task 6.
  - [3] Orchestrator ReAct loop (composes `claude.createMessage` + `registry.handlers`, threads `dialogKey` into tool `ctx`, iteration limit, filters via history's incoming/outgoing role mapping) → Task 4 (`orchestrator.js`) + Task 2 (`history.js`).
  - [6] Reply pipeline (`chatpush.sendMessage` + `replyRoutingFor`, 1–2 messages/turn) → `dispatcher.defaultSend` in Task 5.
  - Consent half of the `create_booking` gate (echo details → explicit yes) → Task 1 system prompt rule #2 (behavioral; the executor's advisory-lock + idempotency half is already in 2a).
  - Escalation notification + operator toggle UI → Task 7.
  - Concurrency (watermark + discard-and-regenerate; write-side-effect keeps the booking) → Task 4 (`hasIncomingAfter` + `SIDE_EFFECT_TOOLS`) and per-process serialization/`rerun` in Task 5.
  - Webhook wiring (`chatpush-webhook` → dispatcher instead of `generateReply`) → Task 6.
  - System prompt (role, hours, tone, «не выдумывай») → Task 1.
- **Deliberately out of scope (YAGNI, per spec §"Что явно вне scope"):** vector/semantic KB search (stays FTS/RRF), multi-process debounce, `AbortController` mid-flight cancel, payment/refund/medical escalation triggers, voice/media replies.
- **Type consistency:** `history.loadTranscript → { messages: [{role,content}], watermark:number }`; `history.hasIncomingAfter → boolean`; `dialog-state.{getOrCreate,get,setWatermark,setStatus}`; `orchestrator.runDialog(salonId, dialogKey, {deps?, ctx?, client?, salonName?, workingHours?, today?}) → { replies:string[], escalated:boolean, sideEffect:boolean }`; `dispatcher.enqueue(salonId, dialogKey, meta{phone,channel,messageId}, opts?)`. Tool `ctx` shape `{ dialogKey, clientPhone }` matches what 2a's `create_booking`/`escalate_to_operator` read (`ctx.dialogKey`). `claude.splitContent`/`toolResultBlock` names/return shapes match 2a exactly.
- **Placeholder scan:** every code step contains complete code; every command lists expected output; no "TODO"/"handle edge cases"/"similar to Task N" left in.
- **Open verification items carried from 2a:** (a) YClients booking field names — Task 8 Step 6 gates `mode = all` on a real round-trip. (b) The `dirty` column on `agent_dialogs` exists but 2b uses the authoritative `hasIncomingAfter(watermark)` recheck rather than the flag for the discard-and-regenerate decision — the flag remains available for future observability. (c) Single-process assumption: the in-memory debounce/serialization is correct only under one PM2 instance (matches spec §"Что вне scope"); a second instance would need the advisory-lock path — not enabled here.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-07-18-ai-booking-agent-runtime.md`. Two execution options:

1. **Subagent-Driven (recommended)** — dispatch a fresh subagent per task, review between tasks, fast iteration.
2. **Inline Execution** — execute tasks in this session using `superpowers:executing-plans`, batch execution with checkpoints.

Which approach?
