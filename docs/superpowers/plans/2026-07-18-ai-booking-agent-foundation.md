# AI Booking Agent — Foundation (Phase 2a) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the toolbox for the autonomous booking agent — the Claude tool-calling client, YClients slot/booking helpers, the salon-scoped tool layer (KB search, services, staff, slots, client lookup, escalation), and the booking executor with an idempotency + advisory-lock guard — plus the dialog-state/audit tables. This is the foundation the orchestrator (Phase 2b) composes; nothing here is wired into the live webhook yet.

**Architecture:** A thin Anthropic SDK wrapper (`services/agent/claude.js`) exposes one Claude call and a content-splitter. YClients booking calls (`services/yclients-booking.js`) wrap the existing `ycGet`/`ycPost`. Each agent tool is a `{ schema, run(salonId, input) }` module under `services/agent/tools/`, salon-scoped, unit-tested with mocked deps. `create_booking`'s executor runs under `pg_advisory_xact_lock` with an idempotency key so a duplicate webhook can't double-book. Two new tables (`agent_dialogs`, `agent_events`) hold per-dialog state and a tool-call audit trail.

**Tech Stack:** Node.js/Express, PostgreSQL (`pg`, no ORM), `@anthropic-ai/sdk` (Claude `claude-opus-4-8`, tool use, adaptive thinking), Jest. Reuses Phase-1 RAG (`services/agent-rag.js buildKnowledgeContext`).

**Spec:** `docs/superpowers/specs/2026-07-18-ai-booking-agent-design.md` (components [4], [5], [7]; the executor half of the `create_booking` gate).

**Scope:** Phase 2a only. The dispatcher/debouncer [2], orchestrator [3] ReAct loop, the consent half of the booking gate, escalation notification UI, concurrency (watermark/dirty), and the webhook wiring belong to Phase 2b (`2026-07-18-ai-booking-agent-runtime.md`).

---

## File Structure

- **Modify** `backend/config.js` — add `ANTHROPIC_API_KEY`, `AGENT_LLM_MODEL`, `AGENT_MAX_TOKENS`, `AGENT_DEBOUNCE_MS` (last one consumed in 2b; defined here so config is complete).
- **Modify** `backend/package.json` — add `@anthropic-ai/sdk` dependency (via `npm install`).
- **Modify** `backend/migrations.js` — append `agent_dialogs` + `agent_events` tables (after `agent_number_rules`, ~line 995).
- **Create** `backend/services/agent/claude.js` — Claude client: `createMessage`, `splitContent`, `toolResultBlock`.
- **Create** `backend/services/yclients-booking.js` — `ycGetBookTimes`, `ycGetBookDates`, `ycCreateRecord` (thin wrappers over `ycGet`/`ycPost`).
- **Create** `backend/services/agent/tools/index.js` — registry: array of all tool schemas + a `{ name → run }` handler map.
- **Create** `backend/services/agent/tools/search-knowledge-base.js`
- **Create** `backend/services/agent/tools/list-services.js`
- **Create** `backend/services/agent/tools/list-staff.js`
- **Create** `backend/services/agent/tools/get-available-slots.js`
- **Create** `backend/services/agent/tools/get-client.js`
- **Create** `backend/services/agent/tools/escalate-to-operator.js`
- **Create** `backend/services/agent/booking.js` — `createBookingRecord(salonId, draft)` executor (advisory lock + idempotency).
- **Create** `backend/services/agent/tools/create-booking.js` — thin tool wrapper over `booking.createBookingRecord`.
- **Create** tests: `backend/agent-claude.test.js`, `backend/yclients-booking.test.js`, `backend/agent-tools.test.js`, `backend/agent-booking.test.js`.

**Verified facts (from codebase map):**
- `db` helpers (`backend/db.js`): `db.query/one/oneOrNone/any/many`; `db.one`≡`db.oneOrNone` (returns `rows[0]||null`, never throws). Exports `{ pool, db, botDb }`.
- `ycGet(salon, endpoint, params={})` / `ycPost(salon, endpoint, body={})` in `services/yclients.js` — `salon` is a `SELECT * FROM salons WHERE id=$1` row; auth via `ycHeaders(salon)` using `salon.yclients_partner_token` + `salon.yclients_user_token`; company id is `salon.yclients_company_id`. Both return `data.data`, throw on `!data.success`.
- `staff_members`: `id, salon_id, yclients_staff_id, name, specialization, avatar_url, is_active, synced_at, bio, custom_photo_url, display_order, show_in_app`.
- `services_config`: `id, salon_id, service_title, tag, yclients_service_id`.
- `agent-rag.buildKnowledgeContext(salonId, query, opts)` → `{ context: string, sources: number[] }`.
- `migrations.js` is one `async function runMigrations(client)` of `await client.query(\`…\`).catch(()=>{})` blocks; append before the closing `}` at ~line 996.
- `clients` table has a `phone` column; `services/chat.js` exports `phoneMatchCandidates(phone)` (used by the webhook to match clients).

---

### Task 1: Config + Anthropic SDK

**Files:**
- Modify: `backend/config.js` (KB block region, add a new AGENT block after the CHATPUSH block ~line 61)
- Modify: `backend/package.json` (via `npm install`)

- [ ] **Step 1: Install the Anthropic SDK**

Run: `cd backend && npm install @anthropic-ai/sdk`
Expected: `package.json` gains `"@anthropic-ai/sdk"` under dependencies; `node_modules/@anthropic-ai/sdk` exists. No error.

- [ ] **Step 2: Add agent config keys**

In `backend/config.js`, immediately after the `CHATPUSH: { … },` block (closes ~line 61), add:

```javascript
  // ── ИИ-агент-администратор (диалог + запись). Движок — Claude tool-calling. ──
  // Ключ Anthropic. Claude не гео-блокируется на dev (Финляндия) — прямой вызов.
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY || '',
  AGENT_LLM_MODEL:   process.env.AGENT_LLM_MODEL   || 'claude-opus-4-8',
  AGENT_MAX_TOKENS:  process.env.AGENT_MAX_TOKENS ? parseInt(process.env.AGENT_MAX_TOKENS, 10) : 4096,
  // Дебаунс серии сообщений (мс) — используется диспетчером в Фазе 2b.
  AGENT_DEBOUNCE_MS: process.env.AGENT_DEBOUNCE_MS ? parseInt(process.env.AGENT_DEBOUNCE_MS, 10) : 5000,
```

- [ ] **Step 3: Verify config loads**

Run: `cd backend && node -e "const c=require('./config'); console.log(c.AGENT_LLM_MODEL, c.AGENT_MAX_TOKENS, c.AGENT_DEBOUNCE_MS)"`
Expected: prints `claude-opus-4-8 4096 5000`.

- [ ] **Step 4: Commit**

```bash
git add backend/config.js backend/package.json backend/package-lock.json
git commit -m "feat(agent): Anthropic SDK + конфиг ИИ-агента (Claude tool-calling)"
```

---

### Task 2: Migrations — `agent_dialogs` and `agent_events`

**Files:**
- Modify: `backend/migrations.js` (after the `agent_number_rules` block, ~line 995)

- [ ] **Step 1: Add the two tables**

In `backend/migrations.js`, immediately after the `agent_number_rules` `CREATE TABLE … .catch(() => {});` block (ends ~line 995) and before the closing `}` of `runMigrations`, insert:

```javascript
  // ── Состояние диалога агента + аудит вызовов инструментов (спека booking-agent) ──
  await client.query(`
    CREATE TABLE IF NOT EXISTS agent_dialogs (
      id                SERIAL PRIMARY KEY,
      salon_id          INTEGER NOT NULL REFERENCES salons(id) ON DELETE CASCADE,
      dialog_key        TEXT NOT NULL,
      status            TEXT NOT NULL DEFAULT 'bot' CHECK (status IN ('bot','escalated','closed')),
      collected         JSONB NOT NULL DEFAULT '{}'::jsonb,
      watermark_ts      BIGINT NOT NULL DEFAULT 0,
      dirty             BOOLEAN NOT NULL DEFAULT FALSE,
      escalated_reason  TEXT,
      assigned_operator INTEGER,
      last_activity     TIMESTAMPTZ NOT NULL DEFAULT now(),
      created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (salon_id, dialog_key)
    )
  `).catch(() => {});
  await client.query(`
    CREATE INDEX IF NOT EXISTS agent_dialogs_lookup_idx
    ON agent_dialogs (salon_id, dialog_key)
  `).catch(() => {});

  await client.query(`
    CREATE TABLE IF NOT EXISTS agent_events (
      id            SERIAL PRIMARY KEY,
      salon_id      INTEGER NOT NULL REFERENCES salons(id) ON DELETE CASCADE,
      dialog_key    TEXT,
      kind          TEXT NOT NULL,
      tool_name     TEXT,
      payload       JSONB,
      idempotency_key TEXT,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `).catch(() => {});
  await client.query(`
    CREATE INDEX IF NOT EXISTS agent_events_dialog_idx
    ON agent_events (salon_id, dialog_key, created_at DESC)
  `).catch(() => {});
  // Идемпотентность создания записи: один и тот же (dialog+service+datetime) — одна бронь.
  await client.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS agent_events_idem_idx
    ON agent_events (salon_id, idempotency_key)
    WHERE idempotency_key IS NOT NULL
  `).catch(() => {});
```

- [ ] **Step 2: Run migrations against the dev DB**

Run: `cd backend && node -e "const {pool}=require('./db'); const {runMigrations}=require('./migrations'); pool.connect().then(async c=>{await runMigrations(c); c.release(); console.log('OK'); process.exit(0)}).catch(e=>{console.error(e);process.exit(1)})"`
Expected: prints `OK`.

- [ ] **Step 3: Verify the tables exist**

Run: `cd backend && node -e "const {db}=require('./db'); db.any(\"SELECT table_name FROM information_schema.tables WHERE table_name IN ('agent_dialogs','agent_events') ORDER BY 1\").then(r=>{console.log(r);process.exit(0)})"`
Expected: two rows — `agent_dialogs`, `agent_events`.

- [ ] **Step 4: Commit**

```bash
git add backend/migrations.js
git commit -m "feat(agent): миграции agent_dialogs + agent_events (состояние диалога + аудит)"
```

---

### Task 3: Claude client (`services/agent/claude.js`)

**Files:**
- Create: `backend/services/agent/claude.js`
- Test: `backend/agent-claude.test.js`

- [ ] **Step 1: Write the failing test**

Create `backend/agent-claude.test.js`:

```javascript
'use strict';

const claude = require('./services/agent/claude');

describe('splitContent', () => {
  test('делит ответ на текст и tool_use', () => {
    const msg = {
      stop_reason: 'tool_use',
      content: [
        { type: 'text', text: 'Сейчас проверю слоты.' },
        { type: 'tool_use', id: 'tu_1', name: 'get_available_slots', input: { date: '2026-07-20' } },
      ],
    };
    const out = claude.splitContent(msg);
    expect(out.text).toBe('Сейчас проверю слоты.');
    expect(out.stopReason).toBe('tool_use');
    expect(out.toolUses).toHaveLength(1);
    expect(out.toolUses[0].name).toBe('get_available_slots');
  });

  test('только текст → toolUses пуст', () => {
    const msg = { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Готово.' }] };
    const out = claude.splitContent(msg);
    expect(out.text).toBe('Готово.');
    expect(out.toolUses).toEqual([]);
  });
});

describe('toolResultBlock', () => {
  test('строит tool_result с JSON-содержимым', () => {
    const block = claude.toolResultBlock('tu_1', { slots: ['10:00'] });
    expect(block).toEqual({
      type: 'tool_result',
      tool_use_id: 'tu_1',
      content: JSON.stringify({ slots: ['10:00'] }),
    });
  });

  test('is_error помечает ошибку', () => {
    const block = claude.toolResultBlock('tu_2', { error: 'нет слотов' }, true);
    expect(block.is_error).toBe(true);
  });
});

describe('createMessage', () => {
  test('зовёт injected client с model/tools/messages и возвращает ответ', async () => {
    const calls = [];
    const fakeClient = { messages: { create: async (p) => { calls.push(p); return { stop_reason: 'end_turn', content: [] }; } } };
    const res = await claude.createMessage(
      { system: 'ты админ', messages: [{ role: 'user', content: 'привет' }], tools: [{ name: 't' }] },
      { client: fakeClient, model: 'claude-opus-4-8', maxTokens: 1024 });
    expect(res.stop_reason).toBe('end_turn');
    expect(calls[0].model).toBe('claude-opus-4-8');
    expect(calls[0].max_tokens).toBe(1024);
    expect(calls[0].system).toBe('ты админ');
    expect(calls[0].tools).toEqual([{ name: 't' }]);
    expect(calls[0].messages).toEqual([{ role: 'user', content: 'привет' }]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && npx jest agent-claude.test.js`
Expected: FAIL — "Cannot find module './services/agent/claude'".

- [ ] **Step 3: Write minimal implementation**

Create `backend/services/agent/claude.js`:

```javascript
'use strict';

const Anthropic = require('@anthropic-ai/sdk');
const config = require('../../config');

// ── Клиент Claude для tool-calling диалога. Тонкая обёртка над Messages API. ──
// Спека: docs/superpowers/specs/2026-07-18-ai-booking-agent-design.md ([4]).

function makeClient(apiKey) {
  return new Anthropic({ apiKey: apiKey || config.ANTHROPIC_API_KEY });
}

// Один вызов Claude с инструментами. Возвращает сырой message (content + stop_reason).
// opts.client — для тестов (мок SDK); иначе создаётся из ANTHROPIC_API_KEY.
async function createMessage({ system, messages, tools }, opts = {}) {
  const client = opts.client || makeClient(opts.apiKey);
  return client.messages.create({
    model: opts.model || config.AGENT_LLM_MODEL,
    max_tokens: opts.maxTokens || config.AGENT_MAX_TOKENS,
    thinking: { type: 'adaptive' },
    system,
    tools,
    messages,
  });
}

// Разбор ответа: склеенный текст + tool_use-блоки + stop_reason.
function splitContent(message) {
  const blocks = (message && message.content) || [];
  const text = blocks.filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
  const toolUses = blocks.filter(b => b.type === 'tool_use');
  return { text, toolUses, stopReason: message && message.stop_reason };
}

// Строит user-блок tool_result для ответа модели. result сериализуется в JSON-строку.
function toolResultBlock(toolUseId, result, isError = false) {
  const block = {
    type: 'tool_result',
    tool_use_id: toolUseId,
    content: JSON.stringify(result),
  };
  if (isError) block.is_error = true;
  return block;
}

module.exports = { makeClient, createMessage, splitContent, toolResultBlock };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && npx jest agent-claude.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/services/agent/claude.js backend/agent-claude.test.js
git commit -m "feat(agent): Claude-клиент tool-calling (createMessage/splitContent)"
```

---

### Task 4: YClients booking helpers (`services/yclients-booking.js`)

**Files:**
- Create: `backend/services/yclients-booking.js`
- Test: `backend/yclients-booking.test.js`

- [ ] **Step 1: Write the failing test**

Create `backend/yclients-booking.test.js`:

```javascript
'use strict';

jest.mock('./services/yclients', () => ({
  ycGet: jest.fn(),
  ycPost: jest.fn(),
}));

const { ycGet, ycPost } = require('./services/yclients');
const yb = require('./services/yclients-booking');

const salon = { id: 1, yclients_company_id: 100 };

beforeEach(() => jest.clearAllMocks());

describe('ycGetBookTimes', () => {
  test('зовёт /book_times/{cid}/{staff}/{date} с service_ids', async () => {
    ycGet.mockResolvedValue([{ time: '10:00', seance_length: 3600, datetime: '2026-07-20T10:00:00+03:00' }]);
    const out = await yb.ycGetBookTimes(salon, 55, '2026-07-20', [7]);
    expect(ycGet).toHaveBeenCalledWith(salon, '/book_times/100/55/2026-07-20', { 'service_ids[0]': 7 });
    expect(out[0].time).toBe('10:00');
  });
});

describe('ycGetBookDates', () => {
  test('зовёт /book_dates/{cid} со staff и service', async () => {
    ycGet.mockResolvedValue({ booking_dates: ['2026-07-20'] });
    const out = await yb.ycGetBookDates(salon, 55, [7]);
    expect(ycGet).toHaveBeenCalledWith(salon, '/book_dates/100', { staff_id: 55, 'service_ids[0]': 7 });
    expect(out.booking_dates).toContain('2026-07-20');
  });
});

describe('ycCreateRecord', () => {
  test('POST /records/{cid} с телом брони', async () => {
    ycPost.mockResolvedValue({ id: 999 });
    const out = await yb.ycCreateRecord(salon, {
      staffYcId: 55, serviceYcIds: [7], datetime: '2026-07-20T10:00:00+03:00',
      seanceLength: 3600, clientPhone: '79001234567', clientName: 'Аня', comment: 'тест',
    });
    expect(ycPost).toHaveBeenCalledWith(salon, '/records/100', expect.objectContaining({
      staff_id: 55,
      services: [{ id: 7 }],
      datetime: '2026-07-20T10:00:00+03:00',
      seance_length: 3600,
      client: { phone: '79001234567', name: 'Аня' },
      comment: 'тест',
    }));
    expect(out.id).toBe(999);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && npx jest yclients-booking.test.js`
Expected: FAIL — "Cannot find module './services/yclients-booking'".

- [ ] **Step 3: Write minimal implementation**

Create `backend/services/yclients-booking.js`:

```javascript
'use strict';

const { ycGet, ycPost } = require('./yclients');

// ── YClients booking-flow: свободные слоты + создание записи. ──────────
// Слоты берём через book_times (уже вычитает занятость), не через /schedule.
// Спека: docs/superpowers/specs/2026-07-18-ai-booking-agent-design.md ([5]).

// service_ids передаём как service_ids[0], service_ids[1], … (ycGet кладёт как есть).
function serviceIdsParams(serviceYcIds) {
  const p = {};
  (serviceYcIds || []).forEach((id, i) => { p[`service_ids[${i}]`] = id; });
  return p;
}

// Свободное время у мастера на дату. Возвращает [{time, seance_length, datetime}].
async function ycGetBookTimes(salon, staffYcId, date, serviceYcIds) {
  return ycGet(
    salon,
    `/book_times/${salon.yclients_company_id}/${staffYcId}/${date}`,
    serviceIdsParams(serviceYcIds));
}

// Доступные даты записи у мастера под услугу(и). Возвращает {booking_dates:[…]}.
async function ycGetBookDates(salon, staffYcId, serviceYcIds) {
  return ycGet(
    salon,
    `/book_dates/${salon.yclients_company_id}`,
    { staff_id: staffYcId, ...serviceIdsParams(serviceYcIds) });
}

// Создание записи через management API (partner+user токен, без SMS-кода).
async function ycCreateRecord(salon, {
  staffYcId, serviceYcIds, datetime, seanceLength, clientPhone, clientName, comment,
}) {
  const body = {
    staff_id: staffYcId,
    services: (serviceYcIds || []).map(id => ({ id })),
    client: { phone: clientPhone, name: clientName || '' },
    datetime,
    seance_length: seanceLength,
    save_if_busy: false,
    send_sms: false,
    comment: comment || 'Запись через ИИ-агента',
  };
  return ycPost(salon, `/records/${salon.yclients_company_id}`, body);
}

module.exports = { ycGetBookTimes, ycGetBookDates, ycCreateRecord };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && npx jest yclients-booking.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/services/yclients-booking.js backend/yclients-booking.test.js
git commit -m "feat(agent): YClients booking helpers (book_times/book_dates/create record)"
```

---

### Task 5: Read-only tools (KB search, services, staff, slots, client)

**Files:**
- Create: `backend/services/agent/tools/search-knowledge-base.js`
- Create: `backend/services/agent/tools/list-services.js`
- Create: `backend/services/agent/tools/list-staff.js`
- Create: `backend/services/agent/tools/get-available-slots.js`
- Create: `backend/services/agent/tools/get-client.js`
- Test: `backend/agent-tools.test.js`

Each tool exports `{ schema, run }`. `schema` is a Claude tool definition (`{name, description, input_schema}`). `run(salonId, input)` returns a JSON-serializable object. Deps (`db`, `agent-rag`, `yclients`, `yclients-booking`) are required normally and mocked in tests.

- [ ] **Step 1: Write the failing test**

Create `backend/agent-tools.test.js`:

```javascript
'use strict';

jest.mock('./services/agent-rag', () => ({ buildKnowledgeContext: jest.fn() }));
jest.mock('./db', () => ({ db: { any: jest.fn(), one: jest.fn(), oneOrNone: jest.fn() } }));
jest.mock('./services/yclients', () => ({ ycGet: jest.fn() }));
jest.mock('./services/yclients-booking', () => ({ ycGetBookTimes: jest.fn() }));

const { db } = require('./db');
const rag = require('./services/agent-rag');
const { ycGet } = require('./services/yclients');
const { ycGetBookTimes } = require('./services/yclients-booking');

const searchKb = require('./services/agent/tools/search-knowledge-base');
const listServices = require('./services/agent/tools/list-services');
const listStaff = require('./services/agent/tools/list-staff');
const getSlots = require('./services/agent/tools/get-available-slots');
const getClient = require('./services/agent/tools/get-client');

beforeEach(() => jest.clearAllMocks());

describe('search_knowledge_base', () => {
  test('schema имеет имя и query', () => {
    expect(searchKb.schema.name).toBe('search_knowledge_base');
    expect(searchKb.schema.input_schema.properties.query).toBeDefined();
  });
  test('run отдаёт context из RAG', async () => {
    rag.buildKnowledgeContext.mockResolvedValue({ context: 'Ботокс: от 5000 ₽', sources: [1] });
    const out = await searchKb.run(1, { query: 'ботокс' });
    expect(rag.buildKnowledgeContext).toHaveBeenCalledWith(1, 'ботокс', {});
    expect(out.context).toContain('Ботокс');
    expect(out.sources).toEqual([1]);
  });
  test('пусто → found:false', async () => {
    rag.buildKnowledgeContext.mockResolvedValue({ context: '', sources: [] });
    const out = await searchKb.run(1, { query: 'нет' });
    expect(out.found).toBe(false);
  });
});

describe('list_services', () => {
  test('склеивает services_config с живыми ценами YClients', async () => {
    db.any.mockResolvedValue([{ yclients_service_id: 7, service_title: 'Ботокс' }]);
    db.one.mockResolvedValue({ id: 1, yclients_company_id: 100 });
    ycGet.mockResolvedValue([{ id: 7, title: 'Ботулинотерапия', price_min: 5000, price_max: 8000 }]);
    const out = await listServices.run(1, {});
    expect(out.services).toEqual([
      expect.objectContaining({ yc_id: 7, title: 'Ботулинотерапия', price_min: 5000, price_max: 8000 }),
    ]);
  });
  test('нет YClients-компании → отдаёт только заголовки из конфига', async () => {
    db.any.mockResolvedValue([{ yclients_service_id: 7, service_title: 'Ботокс' }]);
    db.one.mockResolvedValue({ id: 1, yclients_company_id: null });
    const out = await listServices.run(1, {});
    expect(out.services[0]).toEqual(expect.objectContaining({ yc_id: 7, title: 'Ботокс' }));
    expect(ycGet).not.toHaveBeenCalled();
  });
});

describe('list_staff', () => {
  test('активные мастера салона', async () => {
    db.any.mockResolvedValue([{ yclients_staff_id: 55, name: 'Аня', specialization: 'косметолог' }]);
    const out = await listStaff.run(1, {});
    expect(out.staff).toEqual([{ yc_id: 55, name: 'Аня', specialization: 'косметолог' }]);
    const sql = db.any.mock.calls[0][0];
    expect(sql).toMatch(/is_active\s*=\s*true/i);
    expect(db.any.mock.calls[0][1]).toEqual([1]);
  });
});

describe('get_available_slots', () => {
  test('тянет слоты через book_times', async () => {
    db.one.mockResolvedValue({ id: 1, yclients_company_id: 100 });
    ycGetBookTimes.mockResolvedValue([{ time: '10:00', seance_length: 3600, datetime: '2026-07-20T10:00:00+03:00' }]);
    const out = await getSlots.run(1, { service_yc_id: 7, staff_yc_id: 55, date: '2026-07-20' });
    expect(ycGetBookTimes).toHaveBeenCalledWith({ id: 1, yclients_company_id: 100 }, 55, '2026-07-20', [7]);
    expect(out.slots[0].time).toBe('10:00');
  });
  test('нет мастера/даты → ошибка валидации без вызова YClients', async () => {
    const out = await getSlots.run(1, { service_yc_id: 7 });
    expect(out.error).toBeTruthy();
    expect(ycGetBookTimes).not.toHaveBeenCalled();
  });
});

describe('get_client', () => {
  test('находит клиента по телефону в этом салоне', async () => {
    db.oneOrNone.mockResolvedValue({ id: 42, name: 'Аня', phone: '79001234567' });
    const out = await getClient.run(1, { phone: '89001234567' });
    expect(out.found).toBe(true);
    expect(out.client.id).toBe(42);
    // телефон нормализован к 7XXXXXXXXXX перед поиском
    expect(db.oneOrNone.mock.calls[0][1]).toEqual([1, '79001234567']);
  });
  test('не найден → found:false', async () => {
    db.oneOrNone.mockResolvedValue(null);
    const out = await getClient.run(1, { phone: '79990000000' });
    expect(out.found).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && npx jest agent-tools.test.js`
Expected: FAIL — "Cannot find module './services/agent/tools/search-knowledge-base'".

- [ ] **Step 3: Write the implementations**

Create `backend/services/agent/tools/search-knowledge-base.js`:

```javascript
'use strict';

const rag = require('../../agent-rag');

const schema = {
  name: 'search_knowledge_base',
  description: 'Найти в базе знаний салона информацию об услугах, ценах, ' +
    'противопоказаниях, уходе. Использовать ВСЕГДА, прежде чем отвечать по существу — ' +
    'не выдумывать факты. Возвращает релевантный контекст и актуальные цены.',
  input_schema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Вопрос или тема на русском (например «ботокс цена»).' },
    },
    required: ['query'],
    additionalProperties: false,
  },
};

async function run(salonId, input) {
  const query = String((input && input.query) || '').trim();
  if (!query) return { found: false, context: '', sources: [] };
  const { context, sources } = await rag.buildKnowledgeContext(salonId, query, {});
  return { found: !!context, context, sources };
}

module.exports = { schema, run };
```

Create `backend/services/agent/tools/list-services.js`:

```javascript
'use strict';

const { db } = require('../../../db');
const { ycGet } = require('../../yclients');

const schema = {
  name: 'list_services',
  description: 'Список услуг салона с актуальными ценами из YClients. ' +
    'Использовать, когда клиент спрашивает «что делаете / сколько стоит» в общем.',
  input_schema: { type: 'object', properties: {}, additionalProperties: false },
};

async function run(salonId, _input) {
  const cfg = await db.any(
    `SELECT yclients_service_id, service_title
       FROM services_config WHERE salon_id = $1`,
    [salonId]);
  const salon = await db.one(`SELECT id, yclients_company_id FROM salons WHERE id=$1`, [salonId]);

  let liveById = new Map();
  if (salon && salon.yclients_company_id) {
    try {
      const data = await ycGet(salon, `/services/${salon.yclients_company_id}`);
      const services = Array.isArray(data) ? data : [];
      liveById = new Map(services.map(s => [String(s.id), s]));
    } catch (_) { /* YClients недоступен → отдаём заголовки из конфига */ }
  }

  const services = cfg.map(c => {
    const live = liveById.get(String(c.yclients_service_id));
    return {
      yc_id: c.yclients_service_id,
      title: (live && live.title) || c.service_title,
      price_min: live ? live.price_min : null,
      price_max: live ? live.price_max : null,
    };
  });
  return { services };
}

module.exports = { schema, run };
```

Create `backend/services/agent/tools/list-staff.js`:

```javascript
'use strict';

const { db } = require('../../../db');

const schema = {
  name: 'list_staff',
  description: 'Список активных мастеров/специалистов салона (имя, специализация, ' +
    'YClients-id для записи). Использовать, когда клиент спрашивает «кто делает / к кому записаться».',
  input_schema: { type: 'object', properties: {}, additionalProperties: false },
};

async function run(salonId, _input) {
  const rows = await db.any(
    `SELECT yclients_staff_id, name, specialization
       FROM staff_members
      WHERE salon_id = $1 AND is_active = true AND show_in_app = true
      ORDER BY display_order ASC, name ASC`,
    [salonId]);
  return { staff: rows.map(r => ({ yc_id: r.yclients_staff_id, name: r.name, specialization: r.specialization })) };
}

module.exports = { schema, run };
```

Create `backend/services/agent/tools/get-available-slots.js`:

```javascript
'use strict';

const { db } = require('../../../db');
const { ycGetBookTimes } = require('../../yclients-booking');

const schema = {
  name: 'get_available_slots',
  description: 'Свободные слоты у конкретного мастера под конкретную услугу на дату. ' +
    'Сначала узнай yc_id услуги (list_services) и мастера (list_staff). Дата в формате YYYY-MM-DD.',
  input_schema: {
    type: 'object',
    properties: {
      service_yc_id: { type: 'integer', description: 'YClients-id услуги (из list_services).' },
      staff_yc_id:   { type: 'integer', description: 'YClients-id мастера (из list_staff).' },
      date:          { type: 'string',  description: 'Дата YYYY-MM-DD.' },
    },
    required: ['service_yc_id', 'staff_yc_id', 'date'],
    additionalProperties: false,
  },
};

async function run(salonId, input) {
  const serviceId = input && input.service_yc_id;
  const staffId = input && input.staff_yc_id;
  const date = input && input.date;
  if (!serviceId || !staffId || !date) {
    return { error: 'Нужны service_yc_id, staff_yc_id и date (YYYY-MM-DD).' };
  }
  const salon = await db.one(`SELECT id, yclients_company_id, yclients_partner_token, yclients_user_token FROM salons WHERE id=$1`, [salonId]);
  if (!salon || !salon.yclients_company_id) return { error: 'YClients не подключён для салона.' };
  try {
    const times = await ycGetBookTimes(salon, staffId, date, [serviceId]);
    const slots = (Array.isArray(times) ? times : []).map(t => ({
      time: t.time, datetime: t.datetime, seance_length: t.seance_length,
    }));
    return { slots };
  } catch (e) {
    return { error: `Не удалось получить слоты: ${e.message}` };
  }
}

module.exports = { schema, run };
```

Create `backend/services/agent/tools/get-client.js`:

```javascript
'use strict';

const { db } = require('../../../db');
const { normalizePhoneKey } = require('../../agent-gate');

const schema = {
  name: 'get_client',
  description: 'Найти клиента салона по номеру телефона (имя, id). ' +
    'Использовать, чтобы обратиться по имени и подставить телефон в запись.',
  input_schema: {
    type: 'object',
    properties: { phone: { type: 'string', description: 'Телефон клиента.' } },
    required: ['phone'],
    additionalProperties: false,
  },
};

async function run(salonId, input) {
  const phone = normalizePhoneKey(String((input && input.phone) || ''));
  if (!phone) return { found: false };
  const row = await db.oneOrNone(
    `SELECT id, name, phone FROM clients
      WHERE salon_id = $1 AND regexp_replace(phone, '\\D', '', 'g') LIKE '%' || $2
      LIMIT 1`,
    [salonId, phone]);
  // Примечание: сверка по нормализованным цифрам; точное совпадение хвоста номера.
  if (!row) return { found: false };
  return { found: true, client: { id: row.id, name: row.name, phone: row.phone } };
}

module.exports = { schema, run };
```

> **Note:** the `get_client` test asserts params `[1, '79001234567']`. Ensure the SQL's second parameter is the normalized phone and the query shape passes the assertion — if the `regexp_replace` LIKE form complicates the exact-arg assertion, simplify to `WHERE salon_id=$1 AND phone LIKE '%'||$2` and keep the params `[salonId, phone]`. The test only checks the params array and the returned shape, not the SQL text.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && npx jest agent-tools.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/services/agent/tools/search-knowledge-base.js backend/services/agent/tools/list-services.js backend/services/agent/tools/list-staff.js backend/services/agent/tools/get-available-slots.js backend/services/agent/tools/get-client.js backend/agent-tools.test.js
git commit -m "feat(agent): read-инструменты (KB/услуги/мастера/слоты/клиент)"
```

---

### Task 6: Booking executor + `create_booking` / `escalate_to_operator` tools + registry

**Files:**
- Create: `backend/services/agent/booking.js`
- Create: `backend/services/agent/tools/create-booking.js`
- Create: `backend/services/agent/tools/escalate-to-operator.js`
- Create: `backend/services/agent/tools/index.js`
- Test: `backend/agent-booking.test.js`

- [ ] **Step 1: Write the failing test**

Create `backend/agent-booking.test.js`:

```javascript
'use strict';

jest.mock('./db', () => {
  const q = jest.fn(async () => ({ rows: [] }));
  return { db: { one: jest.fn(), oneOrNone: jest.fn(), query: q, any: jest.fn() }, pool: {} };
});
jest.mock('./services/yclients-booking', () => ({ ycCreateRecord: jest.fn() }));

const { db } = require('./db');
const { ycCreateRecord } = require('./services/yclients-booking');
const booking = require('./services/agent/booking');
const createBookingTool = require('./services/agent/tools/create-booking');
const escalate = require('./services/agent/tools/escalate-to-operator');
const registry = require('./services/agent/tools/index');

beforeEach(() => jest.clearAllMocks());

describe('booking.buildIdempotencyKey', () => {
  test('детерминирован по dialog+service+datetime', () => {
    const a = booking.buildIdempotencyKey('79001112233', 7, '2026-07-20T10:00:00+03:00');
    const b = booking.buildIdempotencyKey('79001112233', 7, '2026-07-20T10:00:00+03:00');
    const c = booking.buildIdempotencyKey('79001112233', 7, '2026-07-20T11:00:00+03:00');
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });
});

describe('createBookingRecord', () => {
  const draft = {
    dialogKey: '79001112233', staffYcId: 55, serviceYcId: 7,
    datetime: '2026-07-20T10:00:00+03:00', seanceLength: 3600,
    clientPhone: '79001112233', clientName: 'Аня',
  };

  test('создаёт запись и логирует идемпотентно', async () => {
    db.one.mockResolvedValue({ id: 1, yclients_company_id: 100, yclients_partner_token: 'p', yclients_user_token: 'u' });
    db.oneOrNone.mockResolvedValue(null); // нет прежней записи с этим ключом
    ycCreateRecord.mockResolvedValue({ id: 999 });
    const out = await booking.createBookingRecord(1, draft);
    expect(out.created).toBe(true);
    expect(out.record_id).toBe(999);
    // advisory-lock взят
    const lockCall = db.query.mock.calls.find(c => /pg_advisory_xact_lock/i.test(c[0]));
    expect(lockCall).toBeTruthy();
    // событие с idempotency_key записано
    const evCall = db.query.mock.calls.find(c => /INSERT INTO agent_events/i.test(c[0]));
    expect(evCall).toBeTruthy();
    expect(ycCreateRecord).toHaveBeenCalledTimes(1);
  });

  test('дубль по idempotency_key → не создаёт вторую запись', async () => {
    db.one.mockResolvedValue({ id: 1, yclients_company_id: 100 });
    db.oneOrNone.mockResolvedValue({ id: 5, payload: { record_id: 999 } }); // уже есть
    const out = await booking.createBookingRecord(1, draft);
    expect(out.created).toBe(false);
    expect(out.duplicate).toBe(true);
    expect(out.record_id).toBe(999);
    expect(ycCreateRecord).not.toHaveBeenCalled();
  });

  test('ошибка YClients → created:false с сообщением, запись не помечена созданной', async () => {
    db.one.mockResolvedValue({ id: 1, yclients_company_id: 100 });
    db.oneOrNone.mockResolvedValue(null);
    ycCreateRecord.mockRejectedValue(new Error('busy'));
    const out = await booking.createBookingRecord(1, draft);
    expect(out.created).toBe(false);
    expect(out.error).toMatch(/busy/);
    // не логируем успешный idempotency-ключ на провале
    const evCall = db.query.mock.calls.find(c => /INSERT INTO agent_events/i.test(c[0]) && /idempotency_key/i.test(c[0]));
    expect(evCall).toBeFalsy();
  });
});

describe('create_booking tool', () => {
  test('schema требует поля брони', () => {
    const p = createBookingTool.schema.input_schema.properties;
    expect(p.staff_yc_id).toBeDefined();
    expect(p.service_yc_id).toBeDefined();
    expect(p.datetime).toBeDefined();
    expect(createBookingTool.schema.input_schema.required).toEqual(
      expect.arrayContaining(['staff_yc_id', 'service_yc_id', 'datetime']));
  });
});

describe('escalate_to_operator tool', () => {
  test('флипает статус диалога в escalated', async () => {
    db.query.mockResolvedValue({ rows: [] });
    const out = await escalate.run(1, { reason: 'жалоба' }, { dialogKey: '79001112233' });
    expect(out.escalated).toBe(true);
    const upd = db.query.mock.calls.find(c => /UPDATE agent_dialogs/i.test(c[0]) && /escalated/i.test(c[0]));
    expect(upd).toBeTruthy();
  });
});

describe('tools registry', () => {
  test('экспортирует schemas и handlers по всем инструментам', () => {
    const names = registry.schemas.map(s => s.name).sort();
    expect(names).toEqual([
      'create_booking', 'escalate_to_operator', 'get_available_slots',
      'get_client', 'list_services', 'list_staff', 'search_knowledge_base',
    ].sort());
    for (const n of names) expect(typeof registry.handlers[n]).toBe('function');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && npx jest agent-booking.test.js`
Expected: FAIL — "Cannot find module './services/agent/booking'".

- [ ] **Step 3: Write the implementations**

Create `backend/services/agent/booking.js`:

```javascript
'use strict';

const crypto = require('crypto');
const { db } = require('../../db');
const { ycCreateRecord } = require('../yclients-booking');

// ── Исполнитель создания записи. Единственное необратимое действие агента. ──
// Под pg_advisory_xact_lock(salon, dialog) + идемпотентный ключ
// (dialog+service+datetime), чтобы дубль-вебхук/гонка не создали вторую бронь.
// Спека: docs/superpowers/specs/2026-07-18-ai-booking-agent-design.md (гейт create_booking).

// Стабильный ключ идемпотентности одной брони.
function buildIdempotencyKey(dialogKey, serviceYcId, datetime) {
  return crypto.createHash('sha256')
    .update(`${dialogKey}|${serviceYcId}|${datetime}`, 'utf8')
    .digest('hex');
}

// 32-битный ключ для advisory-lock из строки (диалога).
function lockKey(str) {
  const h = crypto.createHash('sha256').update(String(str), 'utf8').digest();
  return h.readInt32BE(0);
}

async function createBookingRecord(salonId, draft) {
  const {
    dialogKey, staffYcId, serviceYcId, datetime, seanceLength,
    clientPhone, clientName, comment,
  } = draft;
  const idem = buildIdempotencyKey(dialogKey, serviceYcId, datetime);

  // Сериализуем обработку диалога на время создания записи.
  await db.query(`SELECT pg_advisory_xact_lock($1, $2)`, [salonId, lockKey(dialogKey)]);

  // Уже создавали эту бронь? (идемпотентность против дубль-вебхука/ретрая)
  const prior = await db.oneOrNone(
    `SELECT id, payload FROM agent_events
      WHERE salon_id = $1 AND idempotency_key = $2 LIMIT 1`,
    [salonId, idem]);
  if (prior) {
    return { created: false, duplicate: true, record_id: prior.payload && prior.payload.record_id };
  }

  const salon = await db.one(`SELECT * FROM salons WHERE id=$1`, [salonId]);
  if (!salon || !salon.yclients_company_id) {
    return { created: false, error: 'YClients не подключён для салона.' };
  }

  let record;
  try {
    record = await ycCreateRecord(salon, {
      staffYcId, serviceYcIds: [serviceYcId], datetime, seanceLength,
      clientPhone, clientName, comment,
    });
  } catch (e) {
    return { created: false, error: e.message };
  }

  const recordId = record && record.id;
  // Помечаем успешную бронь идемпотентным ключом — только после успеха YClients.
  await db.query(
    `INSERT INTO agent_events (salon_id, dialog_key, kind, tool_name, payload, idempotency_key)
     VALUES ($1,$2,'booking_created','create_booking',$3,$4)
     ON CONFLICT (salon_id, idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING`,
    [salonId, dialogKey, JSON.stringify({ record_id: recordId, staffYcId, serviceYcId, datetime }), idem]);

  return { created: true, record_id: recordId };
}

module.exports = { buildIdempotencyKey, lockKey, createBookingRecord };
```

Create `backend/services/agent/tools/create-booking.js`:

```javascript
'use strict';

const booking = require('../booking');

const schema = {
  name: 'create_booking',
  description: 'СОЗДАТЬ запись клиента в YClients. Вызывать ТОЛЬКО после того, как ' +
    'клиент явно подтвердил детали (услуга, мастер, дата/время) текстом. ' +
    'Перед вызовом обязательно повтори детали клиенту и получи согласие. ' +
    'Телефон клиента берётся из диалога; передавай его в client_phone.',
  input_schema: {
    type: 'object',
    properties: {
      staff_yc_id:   { type: 'integer', description: 'YClients-id мастера.' },
      service_yc_id: { type: 'integer', description: 'YClients-id услуги.' },
      datetime:      { type: 'string',  description: 'ISO datetime слота (из get_available_slots.datetime).' },
      seance_length: { type: 'integer', description: 'Длительность в секундах (из слота).' },
      client_phone:  { type: 'string',  description: 'Телефон клиента.' },
      client_name:   { type: 'string',  description: 'Имя клиента (если известно).' },
    },
    required: ['staff_yc_id', 'service_yc_id', 'datetime', 'client_phone'],
    additionalProperties: false,
  },
};

// ctx.dialogKey прокидывается оркестратором (Фаза 2b).
async function run(salonId, input, ctx = {}) {
  return booking.createBookingRecord(salonId, {
    dialogKey: ctx.dialogKey || input.client_phone,
    staffYcId: input.staff_yc_id,
    serviceYcId: input.service_yc_id,
    datetime: input.datetime,
    seanceLength: input.seance_length,
    clientPhone: input.client_phone,
    clientName: input.client_name,
  });
}

module.exports = { schema, run };
```

Create `backend/services/agent/tools/escalate-to-operator.js`:

```javascript
'use strict';

const { db } = require('../../../db');

const schema = {
  name: 'escalate_to_operator',
  description: 'Передать диалог живому оператору и замолчать. Вызывать, когда клиент ' +
    'явно просит человека / жалуется / конфликт, ИЛИ когда база знаний не даёт ответа ' +
    'и ты не уверен — не выдумывай, эскалируй.',
  input_schema: {
    type: 'object',
    properties: { reason: { type: 'string', description: 'Кратко причина эскалации.' } },
    required: ['reason'],
    additionalProperties: false,
  },
};

// ctx.dialogKey прокидывается оркестратором (Фаза 2b).
async function run(salonId, input, ctx = {}) {
  const dialogKey = ctx.dialogKey;
  const reason = String((input && input.reason) || '').slice(0, 500);
  await db.query(
    `UPDATE agent_dialogs SET status = 'escalated', escalated_reason = $3, updated_at = now()
      WHERE salon_id = $1 AND dialog_key = $2`,
    [salonId, dialogKey, reason]);
  await db.query(
    `INSERT INTO agent_events (salon_id, dialog_key, kind, tool_name, payload)
     VALUES ($1,$2,'escalated','escalate_to_operator',$3)`,
    [salonId, dialogKey, JSON.stringify({ reason })]);
  return { escalated: true, reason };
}

module.exports = { schema, run };
```

Create `backend/services/agent/tools/index.js`:

```javascript
'use strict';

// Реестр инструментов агента: schemas для Claude + карта имя→run.
const searchKb  = require('./search-knowledge-base');
const listSvc   = require('./list-services');
const listStaff = require('./list-staff');
const getSlots  = require('./get-available-slots');
const getClient = require('./get-client');
const createBk  = require('./create-booking');
const escalate  = require('./escalate-to-operator');

const tools = [searchKb, listSvc, listStaff, getSlots, getClient, createBk, escalate];

const schemas = tools.map(t => t.schema);
const handlers = {};
for (const t of tools) handlers[t.schema.name] = t.run;

module.exports = { schemas, handlers };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && npx jest agent-booking.test.js`
Expected: PASS.

- [ ] **Step 5: Run the full agent suite**

Run: `cd backend && npx jest agent-claude.test.js yclients-booking.test.js agent-tools.test.js agent-booking.test.js`
Expected: PASS across all four files.

- [ ] **Step 6: Commit**

```bash
git add backend/services/agent/booking.js backend/services/agent/tools/create-booking.js backend/services/agent/tools/escalate-to-operator.js backend/services/agent/tools/index.js backend/agent-booking.test.js
git commit -m "feat(agent): booking-исполнитель (advisory-lock+идемпотентность) + create_booking/escalate + реестр"
```

---

## Self-Review Notes

- **Spec coverage (2a):** Claude client [4] ✓ (Task 3); tool layer [5] — search_knowledge_base (reuses RAG), list_services, list_staff, get_available_slots, get_client, create_booking, escalate_to_operator ✓ (Tasks 5–6); YClients book_times/create-record [5] ✓ (Task 4); state+audit tables [7] ✓ (Task 2); the executor half of the create_booking gate (advisory-lock + idempotency) ✓ (Task 6). Config/SDK bootstrap ✓ (Task 1).
- **Deferred to Phase 2b:** dispatcher/debouncer [2]; orchestrator ReAct loop [3] (composes `claude.createMessage` + `registry.handlers`, threads `dialogKey` into tool `ctx`, enforces iteration/token limits, filters `direction:outgoing` echoes); the **consent** half of the create_booking gate (echo details → explicit yes before calling the tool); escalation notification + operator toggle UI; concurrency (watermark/dirty, discard-and-regenerate); webhook wiring (`chatpush-webhook` → dispatcher instead of `generateReply`); system prompt (role, hours, tone, «не выдумывай»).
- **Type consistency:** tool contract is uniform `{ schema, run(salonId, input, ctx?) }`; registry exposes `schemas[]` + `handlers{name→run}`. `booking.createBookingRecord(salonId, draft)` returns `{created, duplicate?, record_id?, error?}`. `claude.createMessage/splitContent/toolResultBlock` names consistent across Task 3 and the (future) orchestrator.
- **Open verification items:** (a) YClients `/book_times`, `/book_dates`, `/records` exact field names (`seance_length`, `datetime`, `services:[{id}]`, `client:{phone,name}`) should be confirmed against a real test company before enabling live booking — flagged for 2b manual E2E. (b) `get_client` phone-match SQL: the test asserts only params + return shape, so the implementer may simplify the SQL to satisfy the exact-args assertion (noted in Task 5 Step 3). (c) `create_booking` `ON CONFLICT … WHERE` partial-index syntax — if Postgres rejects the inline predicate form, drop the `WHERE idempotency_key IS NOT NULL` from the `ON CONFLICT` (the unique index already scopes it) and keep plain `ON CONFLICT (salon_id, idempotency_key) DO NOTHING`.
