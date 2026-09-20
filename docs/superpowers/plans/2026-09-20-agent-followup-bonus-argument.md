# Бонусный довод в напоминании Милы о себе — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Напоминание Милы о себе (stage 0 очереди `agent_followups`) получает вторую фразу-довод: держателю бонусной карты — баланс, пациенту без карты — приглашение в программу лояльности; уместность и факты определяет код.

**Architecture:** Три чистых модуля (`card-balance` — чтение карты, `followup-situation` — класс ситуации по журналу инструментов и тексту Милы, `followup-bonus` — выбор фразы из шаблонов салона) + интеграция в `followup-worker.processOne` после LLM-прохода и до захвата строки. Шаблоны и порог — новые колонки `agent_settings`; журнал ушедшей фразы — новые колонки `agent_followups`. Спека: `docs/superpowers/specs/2026-09-20-agent-followup-bonus-argument-design.md`.

**Tech Stack:** Node.js/Express, PostgreSQL через `pg` без ORM, jest 30 (`npx jest <файл>` из `backend/`), vanilla JS фронт. Все тесты и скрипты запускаются из `/root/loyalpro/backend`.

---

## Карта файлов

| Файл | Роль |
|---|---|
| Create `backend/services/card-balance.js` | `pickSalonCard` (чистая), `readCardBalance` (DB + YClients через DI) |
| Modify `backend/services/yclients.js` | `ycGetClientCardsStrict`, `ycSearchClientIdByPhone` |
| Modify `backend/services/reminders/bonus.js` | выбор карты через общий `pickSalonCard` |
| Modify `backend/migrations.js` | 3 колонки `agent_settings`, 3 колонки `agent_followups` |
| Modify `backend/services/agent-settings.js` | новые поля настроек, щадящий контракт |
| Modify `backend/services/agent/tool-events.js` | `loadTurn(turnId)` |
| Create `backend/services/agent/followup-situation.js` | класс ситуации хода |
| Create `backend/services/agent/followup-bonus.js` | выбор бонусной фразы |
| Modify `backend/services/agent/followup-queue.js` | `anchor_turn_id` |
| Modify `backend/services/agent/dispatcher.js` | передача `turnId` в `schedule` |
| Modify `backend/services/agent/followup-worker.js` | `tryBonusLine`, LEASE_SQL, захват |
| Modify `frontend/index.html`, `frontend/js/pages/agent-settings.js` | три поля в модалке «Агент» |
| Modify `backend/scripts/agent-followup-e2e.js` | флаг `--bonus` |
| Modify `CLAUDE.md` | пункт в разделе «AI-агент» |
| Tests | `card-balance.test.js`, `agent-followup-situation.test.js`, `agent-followup-bonus.test.js`, дополнения в `reminders-bonus.test.js`, `agent-followup-settings.test.js`, `agent-tool-events.test.js`, `agent-followup-queue.test.js`, `agent-followup-worker.test.js`, `agent-dispatcher.test.js` |

Коммиты — по одной задаче. Перед каждым коммитом: `git add` только перечисленных файлов (в рабочем дереве есть чужие незакоммиченные файлы — `AGENTS.md`, `.agents/`, `backend/routes/chat.js` и др., их НЕ трогать).

---

### Task 1: `services/card-balance.js` — выбор карты и чтение баланса

**Files:**
- Create: `backend/services/card-balance.js`
- Modify: `backend/services/yclients.js` (экспорт двух новых функций, рядом с `ycGetClientCards`)
- Test: `backend/card-balance.test.js`

- [ ] **Step 1: Написать падающий тест**

```js
'use strict';
// Чтение бонусной карты для напоминания Милы о себе. Инвариант тот же, что у
// напоминаний о повторном визите: пациент не должен прочитать про бонусы,
// которых у него нет — любой сбой даёт status:'unavailable', а НЕ «карты нет».
jest.mock('./db', () => ({ db: { oneOrNone: jest.fn() } }));
const cb = require('./services/card-balance');

const SALON = { id: 1, yclients_company_id: 100, yclients_card_type_id: 7 };
const PHONE = '79200255591';

const deps = (over = {}) => ({
  findClientId: jest.fn(async () => 555),
  searchClientId: jest.fn(async () => null),
  getCards: jest.fn(async () => [{ id: 900, balance: 3024.6, type: { id: 7 } }]),
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
  ...over,
});

describe('pickSalonCard', () => {
  test('карта строго типа салона, тай-брейк по балансу', () => {
    const cards = [
      { id: 1, balance: 900, type: { id: 8 } },
      { id: 2, balance: 100, type: { id: '7' } },
      { id: 3, balance: 250, type: { id: 7 } },
    ];
    expect(cb.pickSalonCard(cards, 7)).toEqual({ id: 3, balance: 250 });
  });
  test('нет карты нужного типа → null; мусор → null', () => {
    expect(cb.pickSalonCard([{ id: 1, balance: 5, type: { id: 8 } }], 7)).toBe(null);
    expect(cb.pickSalonCard(null, 7)).toBe(null);
    expect(cb.pickSalonCard([{ balance: 5, type: { id: 7 } }], 7)).toBe(null); // без id
  });
});

describe('readCardBalance', () => {
  test('карта есть → ok с целым балансом', async () => {
    const d = deps();
    await expect(cb.readCardBalance(SALON, PHONE, d)).resolves.toEqual({ status: 'ok', balance: 3024, cardId: 900 });
    expect(d.searchClientId).not.toHaveBeenCalled();
  });
  test('тип карты салона не задан → unavailable без единого вызова', async () => {
    const d = deps();
    await expect(cb.readCardBalance({ ...SALON, yclients_card_type_id: null }, PHONE, d))
      .resolves.toEqual({ status: 'unavailable', reason: 'no_card_type' });
    expect(d.findClientId).not.toHaveBeenCalled();
  });
  test('короткий/пустой номер → unavailable', async () => {
    await expect(cb.readCardBalance(SALON, '1234', deps())).resolves.toEqual({ status: 'unavailable', reason: 'no_phone' });
  });
  test('в БД нет → живой поиск нашёл → карты читаются по найденному id', async () => {
    const d = deps({ findClientId: jest.fn(async () => null), searchClientId: jest.fn(async () => 777) });
    await expect(cb.readCardBalance(SALON, PHONE, d)).resolves.toMatchObject({ status: 'ok', balance: 3024 });
    expect(d.getCards).toHaveBeenCalledWith(SALON, 777);
  });
  test('живой поиск не нашёл клиента → no_client', async () => {
    const d = deps({ findClientId: jest.fn(async () => null) });
    await expect(cb.readCardBalance(SALON, PHONE, d)).resolves.toEqual({ status: 'no_client' });
    expect(d.getCards).not.toHaveBeenCalled();
  });
  test('живой поиск упал → unavailable', async () => {
    const d = deps({ findClientId: jest.fn(async () => null), searchClientId: jest.fn(async () => { throw new Error('429'); }) });
    await expect(cb.readCardBalance(SALON, PHONE, d)).resolves.toEqual({ status: 'unavailable', reason: 'search_failed' });
  });
  test('клиент есть, карт типа салона нет → no_card', async () => {
    const d = deps({ getCards: jest.fn(async () => [{ id: 1, balance: 500, type: { id: 8 } }]) });
    await expect(cb.readCardBalance(SALON, PHONE, d)).resolves.toEqual({ status: 'no_card' });
  });
  test('чтение карт БРОСИЛО → unavailable, а не no_card', async () => {
    const d = deps({ getCards: jest.fn(async () => { throw new Error('timeout'); }) });
    await expect(cb.readCardBalance(SALON, PHONE, d)).resolves.toEqual({ status: 'unavailable', reason: 'cards_failed' });
  });
  test('поиск в БД упал → unavailable', async () => {
    const d = deps({ findClientId: jest.fn(async () => { throw new Error('db down'); }) });
    await expect(cb.readCardBalance(SALON, PHONE, d)).resolves.toEqual({ status: 'unavailable', reason: 'db_failed' });
  });
});
```

- [ ] **Step 2: Запустить, убедиться, что падает**

Run: `cd /root/loyalpro/backend && npx jest card-balance.test.js`
Expected: FAIL — `Cannot find module './services/card-balance'`

- [ ] **Step 3: Добавить строгие вызовы в `services/yclients.js`**

Сразу после функции `ycGetClientCards` (после её закрывающей `}` на ~строке 113) вставить:

```js
// Тот же запрос, что ycGetClientCards, но БРОСАЕТ при сбое. ycGetClientCards
// глотает исключения и возвращает [] — потребителю, который по пустому списку
// делает вывод «карты у клиента нет» (напоминание Милы о себе: приглашение
// зарегистрироваться), это подложило бы приглашение держателю карты в момент
// сетевого сбоя. Существующие потребители не переведены: им «[] при сбое»
// подходит (баланс просто не называется).
async function ycGetClientCardsStrict(salon, yclClientsId) {
  const data = await ycGet(salon, `/loyalty/client_cards/${yclClientsId}`);
  return Array.isArray(data) ? data : [];
}

// Живой поиск клиента по телефону (POST /clients/search — тот же вызов, что
// в services/loyalty.js, только с quick_search-фильтром). Возвращает id или
// null («в YClients такого клиента нет»); при сбое БРОСАЕТ. Нужен там, где
// нашей БД верить нельзя: новый пациент появляется в clients только после
// 3-часового синка. Совпадение сверяется по ХВОСТУ номера — quick_search
// ищет и по имени/почте, и первая строка выдачи не обязана быть нашим номером.
async function ycSearchClientIdByPhone(salon, phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  if (digits.length < 10) return null;
  const rows = await ycPost(salon, `/company/${salon.yclients_company_id}/clients/search`, {
    page: 1, count: 20, fields: ['id', 'phone'],
    filters: [{ type: 'quick_search', state: { value: digits } }],
  });
  const hit = (Array.isArray(rows) ? rows : []).find((r) => {
    const p = String((r && r.phone) || '').replace(/\D/g, '');
    return p && (p.endsWith(digits.slice(-10)));
  });
  return hit && hit.id != null ? Number(hit.id) : null;
}
```

В `module.exports` (строка ~390) добавить `ycGetClientCardsStrict, ycSearchClientIdByPhone,` после `ycGetClientCards,`.

- [ ] **Step 4: Создать `services/card-balance.js`**

```js
'use strict';
// ============================================================
// Бонусная карта пациента: выбор карты типа салона и чтение баланса.
//
// Общий модуль для двух потребителей: напоминания о повторном визите
// (services/reminders/bonus.js — там дальше идёт начисление) и бонусный довод
// в напоминании Милы о себе (services/agent/followup-bonus.js — только чтение).
//
// ГЛАВНЫЙ ИНВАРИАНТ readCardBalance: наружу НИКОГДА не бросает, и результат
// ТРЁХЗНАЧЕН — 'ok' / нет карты ('no_card', 'no_client') / 'unavailable'.
// Разница между «карты нет» и «не смогли проверить» принципиальна: по «карты
// нет» пациенту уходит приглашение зарегистрироваться в программе лояльности,
// и получить его держатель карты в момент сбоя сети не должен. Поэтому карты
// читаются СТРОГИМ вызовом (ycGetClientCardsStrict бросает), а не
// ycGetClientCards, который при сбое молча отдаёт [].
//
// Карта — СТРОГО типа, настроенного в салоне (salons.yclients_card_type_id),
// как в services/loyalty.js и routes/clients.js: у клиента бывают карты других
// программ, и их баланс называть нельзя. Тип не задан → 'unavailable'.
//
// Юнит-тесты: card-balance.test.js
// ============================================================

const { db: realDb } = require('../db');
const { ycGetClientCardsStrict, ycSearchClientIdByPhone } = require('./yclients');
const { normalizePhoneKey } = require('./agent-gate');
const { createLogger } = require('../logger');

/**
 * Карта типа салона с максимальным балансом. Чистая.
 * @returns {{id:number, balance:number}|null}
 */
function pickSalonCard(cards, cardTypeId) {
  if (!Array.isArray(cards) || cardTypeId == null) return null;
  const want = String(cardTypeId);
  return cards
    .filter((c) => c && c.type && String(c.type.id) === want && c.id != null)
    .map((c) => ({ id: c.id, balance: Number(c.balance) || 0 }))
    .sort((a, b) => b.balance - a.balance)[0] || null;
}

const defaultDeps = {
  // Быстрый путь: id клиента YClients из нашей карточки (loyalty-синк).
  // Суффиксный LIKE, как в get_bonus_balance: в clients номера лежат в разных
  // формах ('+7…'), точное сравнение с каноничным ключом промахивается.
  findClientId: async (salon, phone) => {
    const row = await realDb.oneOrNone(
      `SELECT yclients_client_id FROM clients
        WHERE salon_id = $1 AND phone LIKE '%' || $2 AND yclients_client_id IS NOT NULL
        LIMIT 1`, [salon.id, phone]);
    return row && row.yclients_client_id ? Number(row.yclients_client_id) : null;
  },
  searchClientId: (salon, phone) => ycSearchClientIdByPhone(salon, phone),
  getCards: (salon, ycClientId) => ycGetClientCardsStrict(salon, ycClientId),
  log: createLogger('CardBalance'),
};

/**
 * @param {object} salon строка salons: id, yclients_company_id, токены, yclients_card_type_id
 * @param {string} rawPhone номер собеседника
 * @returns {Promise<
 *   {status:'ok', balance:number, cardId:number} |
 *   {status:'no_card'} | {status:'no_client'} |
 *   {status:'unavailable', reason:string}>}
 */
async function readCardBalance(salon, rawPhone, deps = {}) {
  const d = { ...defaultDeps, ...deps };
  if (!salon || !salon.yclients_card_type_id) {
    d.log.warn('тип карты лояльности не выбран в настройках салона — баланс не читаем');
    return { status: 'unavailable', reason: 'no_card_type' };
  }
  const phone = normalizePhoneKey(String(rawPhone || ''));
  if (!phone || phone.length < 10) return { status: 'unavailable', reason: 'no_phone' };

  let ycClientId = null;
  try { ycClientId = await d.findClientId(salon, phone); }
  catch (e) { d.log.warn(`clients по ${phone}: ${e.message}`); return { status: 'unavailable', reason: 'db_failed' }; }

  if (!ycClientId) {
    try { ycClientId = await d.searchClientId(salon, phone); }
    catch (e) { d.log.warn(`clients/search по ${phone}: ${e.message}`); return { status: 'unavailable', reason: 'search_failed' }; }
    if (!ycClientId) return { status: 'no_client' };
  }

  let cards;
  try { cards = await d.getCards(salon, ycClientId); }
  catch (e) { d.log.warn(`карты клиента ${ycClientId}: ${e.message}`); return { status: 'unavailable', reason: 'cards_failed' }; }

  const card = pickSalonCard(cards, salon.yclients_card_type_id);
  if (!card) return { status: 'no_card' };
  return { status: 'ok', balance: Math.floor(card.balance), cardId: card.id };
}

module.exports = { pickSalonCard, readCardBalance, defaultDeps };
```

- [ ] **Step 5: Запустить тест**

Run: `cd /root/loyalpro/backend && npx jest card-balance.test.js`
Expected: PASS, 11 тестов.

- [ ] **Step 6: Коммит**

```bash
cd /root/loyalpro && git add backend/services/card-balance.js backend/card-balance.test.js backend/services/yclients.js
git commit -m "feat(loyalty): card-balance — чтение бонусной карты типа салона с трёхзначным результатом

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: Проверить формат `clients/search` живьём

Формат quick_search-фильтра взят из документации YClients, а не из кода проекта — обязательно подтвердить на дев-салоне до того, как на него ляжет ветка «клиента нет → приглашение».

**Files:** ничего не меняется (разовая проверка).

- [ ] **Step 1: Выполнить пробный поиск по тестовому номеру**

Run (из `backend/`):
```bash
node -e "
const { db, pool } = require('./db');
const yc = require('./services/yclients');
(async () => {
  const salon = await db.one('SELECT id, yclients_company_id, yclients_partner_token, yclients_user_token FROM salons WHERE id=1');
  console.log('found id:', await yc.ycSearchClientIdByPhone(salon, '79200255591'));
  console.log('missing id:', await yc.ycSearchClientIdByPhone(salon, '79990000001'));
  await pool.end();
})().catch(e => { console.error(e); process.exit(1); });
"
```
Expected: `found id: <число>` для тестового клиента и `missing id: null` для несуществующего. Если пришла ошибка формата фильтра (`meta.errors` в тексте) — открыть `services/loyalty.js:245` и документацию YClients `POST /company/{id}/clients/search`, поправить тело запроса в `ycSearchClientIdByPhone` (ожидаемые варианты: `filters:[{type:'quick_search', state:{value}}]` либо `filters:[{type:'phone', state:{value}}]`), повторить.

- [ ] **Step 2: Зафиксировать результат**

Если формат пришлось менять — коммит правки `services/yclients.js` с сообщением `fix(yclients): формат quick_search в clients/search подтверждён живым запросом`. Иначе коммита нет.

---

### Task 3: Перевести `reminders/bonus.js` на общий `pickSalonCard`

**Files:**
- Modify: `backend/services/reminders/bonus.js:45-64`
- Test: `backend/reminders-bonus.test.js` (без изменений — обязан остаться зелёным)

- [ ] **Step 1: Запустить существующий сьют, зафиксировать зелёный статус**

Run: `cd /root/loyalpro/backend && npx jest reminders-bonus.test.js`
Expected: PASS.

- [ ] **Step 2: Заменить выбор карты**

В `services/reminders/bonus.js` добавить импорт после `const { pickTier } = require('./tiers');`:

```js
const { pickSalonCard } = require('../card-balance');
```

Заменить блок от комментария `// Карта — СТРОГО типа, настроенного в салоне` до `if (!card) return { ...NO_BONUS_RESULT };` включительно на:

```js
  // Карта — СТРОГО типа, настроенного в салоне; выбор вынесен в общий
  // services/card-balance.pickSalonCard (второй потребитель — бонусный довод в
  // напоминании Милы о себе). Разъехавшиеся копии означали бы, что одна часть
  // системы считает клиента держателем карты, а другая — нет.
  const card = pickSalonCard(cards, salon.yclients_card_type_id);
  if (!card) return { ...NO_BONUS_RESULT };
```

- [ ] **Step 3: Запустить сьют**

Run: `cd /root/loyalpro/backend && npx jest reminders-bonus.test.js card-balance.test.js`
Expected: PASS оба.

- [ ] **Step 4: Коммит**

```bash
cd /root/loyalpro && git add backend/services/reminders/bonus.js
git commit -m "refactor(reminders): выбор карты через общий card-balance.pickSalonCard

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: Миграции

**Files:**
- Modify: `backend/migrations.js` (после блока `followup_latest_time`, ~строка 1593, и после `ALTER TABLE agent_followups ADD COLUMN IF NOT EXISTS error TEXT`, ~строка 1687)

- [ ] **Step 1: Колонки настроек**

Сразу после `await client.query(\`ALTER TABLE agent_settings ADD COLUMN IF NOT EXISTS followup_delay1_min … \`).catch(() => {});` добавить:

```js
  // Бонусный довод в напоминании Милы о себе (спека
  // docs/superpowers/specs/2026-09-20-agent-followup-bonus-argument-design.md).
  // Пустой шаблон = ветка выключена; дефолт NULL — выкат сам не начинает
  // говорить пациентам про бонусы. Порог — ниже него баланс не упоминаем.
  await client.query(`
    ALTER TABLE agent_settings
      ADD COLUMN IF NOT EXISTS followup_bonus_text TEXT,
      ADD COLUMN IF NOT EXISTS followup_welcome_text TEXT,
      ADD COLUMN IF NOT EXISTS followup_bonus_min_balance INTEGER NOT NULL DEFAULT 100
  `).catch(() => {});
```

- [ ] **Step 2: Колонки очереди**

Сразу после `ALTER TABLE agent_followups ADD COLUMN IF NOT EXISTS error TEXT` добавить:

```js
  // anchor_turn_id — turn_id хода-якоря: по нему классификатор ситуации читает
  // журнал agent_tool_events. bonus_kind/bonus_balance — журнал УШЕДШЕЙ
  // бонусной фразы (пишутся в момент захвата строки); по ним же правило
  // «не чаще раза в 7 дней на номер».
  await client.query(`
    ALTER TABLE agent_followups
      ADD COLUMN IF NOT EXISTS anchor_turn_id TEXT,
      ADD COLUMN IF NOT EXISTS bonus_kind TEXT,
      ADD COLUMN IF NOT EXISTS bonus_balance INTEGER
  `).catch(() => {});
```

- [ ] **Step 3: Прогнать миграции на дев-БД**

`runMigrations(client)` принимает клиента пула (так его зовёт `server.js:266`).

Run:
```bash
cd /root/loyalpro/backend && node -e "
const { pool } = require('./db');
const { runMigrations } = require('./migrations');
(async () => { const c = await pool.connect(); try { await runMigrations(c); console.log('ok'); } finally { c.release(); await pool.end(); } })()
  .catch(e => { console.error(e); process.exit(1); });
"
```
Expected: `ok`. Затем проверка через MCP postgres: `SELECT column_name FROM information_schema.columns WHERE table_name IN ('agent_settings','agent_followups') AND column_name LIKE '%bonus%' OR column_name='anchor_turn_id'` → 6 строк.

- [ ] **Step 4: Коммит**

```bash
cd /root/loyalpro && git add backend/migrations.js
git commit -m "feat(agent): колонки под бонусный довод напоминания (agent_settings, agent_followups)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: Настройки салона (`services/agent-settings.js`)

**Files:**
- Modify: `backend/services/agent-settings.js`
- Test: `backend/agent-followup-settings.test.js`

- [ ] **Step 1: Падающие тесты**

Добавить в конец `describe('pickFollowup', …)` в `agent-followup-settings.test.js`:

```js
  // Бонусный довод: тот же щадящий контракт, что у followupFinalText.
  test('бонусные шаблоны не переданы → остаются текущими', () => {
    const c = { ...cur, followupBonusText: 'б', followupWelcomeText: 'в', followupBonusMinBalance: 250 };
    const out = pickFollowup({}, c);
    expect(out.followupBonusText).toBe('б');
    expect(out.followupWelcomeText).toBe('в');
    expect(out.followupBonusMinBalance).toBe(250);
  });
  test('пустая строка в бонусном шаблоне — очистка (ветка выключена)', () => {
    const c = { ...cur, followupBonusText: 'б', followupWelcomeText: 'в' };
    expect(pickFollowup({ followupBonusText: '' }, c).followupBonusText).toBe(null);
    expect(pickFollowup({ followupWelcomeText: '   ' }, c).followupWelcomeText).toBe(null);
  });
  test('шаблон режется капом 1200', () => {
    expect(pickFollowup({ followupBonusText: 'x'.repeat(1300) }, cur).followupBonusText).toHaveLength(1200);
  });
  test('порог: число и числовая строка проходят, пустое → текущее, дефолт 100', () => {
    expect(pickFollowup({ followupBonusMinBalance: 0 }, cur).followupBonusMinBalance).toBe(0);
    expect(pickFollowup({ followupBonusMinBalance: '300' }, cur).followupBonusMinBalance).toBe(300);
    expect(pickFollowup({ followupBonusMinBalance: '' }, { ...cur, followupBonusMinBalance: 42 }).followupBonusMinBalance).toBe(42);
    expect(pickFollowup({}, cur).followupBonusMinBalance).toBe(100);
  });
  test('порог: bool/массив/дробь/отрицательное/выше потолка → BAD_FOLLOWUP', () => {
    for (const bad of [true, [100], 1.5, -1, 100001]) {
      expect(() => pickFollowup({ followupBonusMinBalance: bad }, cur))
        .toThrow(expect.objectContaining({ code: 'BAD_FOLLOWUP' }));
    }
  });
```

- [ ] **Step 2: Запустить, убедиться, что падает**

Run: `cd /root/loyalpro/backend && npx jest agent-followup-settings.test.js`
Expected: FAIL — `followupBonusMinBalance` undefined / не бросает.

- [ ] **Step 3: Реализация**

В `services/agent-settings.js`:

1. В `DEFAULTS` после `followupFinalText: null, followupLatestTime: null,` добавить:
```js
  followupBonusText: null, followupWelcomeText: null, followupBonusMinBalance: 100,
```

2. В `rowToSettings` после `followupLatestTime: …` добавить:
```js
    followupBonusText: row.followup_bonus_text || null,
    followupWelcomeText: row.followup_welcome_text || null,
    followupBonusMinBalance: row.followup_bonus_min_balance == null
      ? DEFAULTS.followupBonusMinBalance : Number(row.followup_bonus_min_balance),
```

3. Рядом с `FOLLOWUP_DELAY_MAX` добавить:
```js
const FOLLOWUP_MIN_BALANCE_MAX = 100000;

// Текст шаблона: undefined/null — «не передано», пустая строка — очистка.
function pickText(raw, current) {
  if (raw === undefined || raw === null) return current || null;
  return String(raw).trim().slice(0, FOLLOWUP_TEXT_MAX) || null;
}

// Порог баланса: та же строгость, что pickDelay (bool/массив/объект
// отвергаются — Number(true)===1 иначе проезжал бы как порог).
function pickMinBalance(raw, current) {
  if (raw === undefined || raw === null || raw === '') return current;
  if (typeof raw !== 'number' && typeof raw !== 'string') throw badFollowup('bad bonus min balance');
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0 || n > FOLLOWUP_MIN_BALANCE_MAX) throw badFollowup('bad bonus min balance');
  return n;
}
```

4. В `pickFollowup` заменить вычисление `finalText` на `const finalText = pickText(body.followupFinalText, cur.followupFinalText);` (поведение то же), а в возвращаемый объект добавить:
```js
    followupBonusText: pickText(body.followupBonusText, cur.followupBonusText),
    followupWelcomeText: pickText(body.followupWelcomeText, cur.followupWelcomeText),
    followupBonusMinBalance: pickMinBalance(body.followupBonusMinBalance,
      cur.followupBonusMinBalance ?? DEFAULTS.followupBonusMinBalance),
```

5. В `getSettings` в SELECT после `followup_latest_time` добавить `, followup_bonus_text, followup_welcome_text, followup_bonus_min_balance`.

6. В `updateSettings`: в INSERT-список колонок после `followup_latest_time` добавить `followup_bonus_text, followup_welcome_text, followup_bonus_min_balance`; в VALUES `$12,$13,$14` перед `NOW()`; в `DO UPDATE SET` добавить `followup_bonus_text=$12, followup_welcome_text=$13, followup_bonus_min_balance=$14`; в оба RETURNING добавить те же три колонки; в массив параметров после `fu.followupLatestTime` добавить `fu.followupBonusText, fu.followupWelcomeText, fu.followupBonusMinBalance`.

- [ ] **Step 4: Запустить тесты настроек**

Run: `cd /root/loyalpro/backend && npx jest agent-followup-settings.test.js agent-settings-allowed.test.js`
Expected: PASS.

- [ ] **Step 5: Коммит**

```bash
cd /root/loyalpro && git add backend/services/agent-settings.js backend/agent-followup-settings.test.js
git commit -m "feat(agent): настройки бонусного довода напоминания — два шаблона и порог баланса

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: `tool-events.loadTurn(turnId)`

**Files:**
- Modify: `backend/services/agent/tool-events.js` (перед `cleanup`)
- Test: `backend/agent-tool-events.test.js`

- [ ] **Step 1: Падающий тест**

В конец `agent-tool-events.test.js` добавить:

```js
describe('loadTurn', () => {
  test('читает события хода по turn_id в порядке id', async () => {
    db.any.mockResolvedValueOnce([{ tool: 'get_available_slots', input: {}, result: { slots: [1] }, is_error: false }]);
    const rows = await toolEvents.loadTurn('t-1');
    expect(rows).toHaveLength(1);
    const [sql, params] = db.any.mock.calls.at(-1);
    expect(sql).toMatch(/WHERE turn_id = \$1/);
    expect(sql).toMatch(/ORDER BY id/);
    expect(params).toEqual(['t-1']);
  });
  test('без turnId — пусто без запроса; сбой БД — пусто с WARN', async () => {
    const before = db.any.mock.calls.length;
    expect(await toolEvents.loadTurn(null)).toEqual([]);
    expect(db.any.mock.calls.length).toBe(before);
    db.any.mockRejectedValueOnce(new Error('down'));
    expect(await toolEvents.loadTurn('t-2')).toEqual([]);
    expect(mockLogger.warn).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Запустить, убедиться, что падает**

Run: `cd /root/loyalpro/backend && npx jest agent-tool-events.test.js`
Expected: FAIL — `toolEvents.loadTurn is not a function`.

- [ ] **Step 3: Реализация**

Перед `/** Удалить строки старше KEEP_DAYS …` вставить:

```js
/**
 * События ОДНОГО хода по turn_id — для классификатора ситуации напоминания
 * Милы о себе (followup-situation.js). В отличие от loadRecent — best-effort:
 * пустой журнал даёт класс по тексту реплики, а падение напоминания из-за БД
 * стоило бы дороже.
 */
async function loadTurn(turnId) {
  if (!turnId) return [];
  try {
    return await db.any(
      `SELECT tool, input, result, is_error
         FROM agent_tool_events
        WHERE turn_id = $1
        ORDER BY id`, [String(turnId)]);
  } catch (e) {
    logger.warn(`loadTurn ${turnId}: ${e.message}`);
    return [];
  }
}
```

В `module.exports` добавить `loadTurn`.

- [ ] **Step 4: Запустить тест**

Run: `cd /root/loyalpro/backend && npx jest agent-tool-events.test.js`
Expected: PASS.

- [ ] **Step 5: Коммит**

```bash
cd /root/loyalpro && git add backend/services/agent/tool-events.js backend/agent-tool-events.test.js
git commit -m "feat(agent): tool-events.loadTurn — события одного хода по turn_id

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 7: `followup-situation.js` — класс ситуации

**Files:**
- Create: `backend/services/agent/followup-situation.js`
- Test: `backend/agent-followup-situation.test.js`

- [ ] **Step 1: Падающий тест**

```js
'use strict';
// Класс ситуации хода-якоря для бонусного довода. Первое совпадение сверху
// побеждает: modify > clarify > choice > price > unknown.
const { classifySituation, lastOwnReply, BONUS_OK } = require('./services/agent/followup-situation');
const { OPERATOR_MARK } = require('./services/agent/history');

const ev = (tool, result = {}, is_error = false) => ({ tool, input: {}, result, is_error });

describe('classifySituation', () => {
  test('пустой журнал и нейтральный текст → unknown, без довода', () => {
    expect(classifySituation({ events: [], ownText: 'Уточню у врача и вернусь.' }))
      .toEqual({ kind: 'unknown', bonusOk: false });
  });
  test('слоты в выдаче → choice', () => {
    expect(classifySituation({ events: [ev('get_available_slots', { slots: [{ time: '12:00' }] })] }))
      .toEqual({ kind: 'choice', bonusOk: true });
  });
  test.each([
    ['offer_slots', { offer_slots: [{}] }], ['staff_options', { staff_options: [{}] }],
    ['alternative_staff', { alternative_staff: [{}] }], ['free_day', { free_day: true, slots: [] }],
    ['variants (sequential)', { variants: [{}] }], ['starts (parallel)', { starts: [{}] }],
    ['schedule (dates)', { schedule: [{}] }],
  ])('непустая выдача по ключу %s → choice', (_n, result) => {
    expect(classifySituation({ events: [ev('get_sequential_slots', result)] }).kind).toBe('choice');
  });
  test('пустая выдача слотов и is_error — не choice', () => {
    expect(classifySituation({ events: [ev('get_available_slots', { slots: [] })] }).kind).toBe('unknown');
    expect(classifySituation({ events: [ev('get_available_slots', { slots: [{}] }, true)] }).kind).toBe('unknown');
  });
  test('get_service_masters / send_price_list → price', () => {
    expect(classifySituation({ events: [ev('get_service_masters', { price_min: 1 })] })).toEqual({ kind: 'price', bonusOk: true });
    expect(classifySituation({ events: [ev('send_price_list', { attached: true })] }).kind).toBe('price');
  });
  test('сумма с валютой в реплике Милы → price даже без инструментов', () => {
    expect(classifySituation({ events: [], ownText: 'Чистка у Юлии стоит от 4500 ₽.' }).kind).toBe('price');
    expect(classifySituation({ events: [], ownText: 'Это 12 000 руб.' }).kind).toBe('price');
  });
  test('hint-флаг create_booking → clarify, перекрывает choice', () => {
    const events = [ev('get_available_slots', { slots: [{}] }), ev('create_booking', { needs_phone: true, invalid_args: true })];
    expect(classifySituation({ events })).toEqual({ kind: 'clarify', bonusOk: false });
    expect(classifySituation({ events: [ev('book_chain', { generic_service_hint: true })] }).kind).toBe('clarify');
  });
  test('перенос/отмена инструментом или словом → modify, перекрывает всё', () => {
    const events = [ev('get_available_slots', { slots: [{}] }), ev('reschedule_booking', { needs_confirmation: true })];
    expect(classifySituation({ events })).toEqual({ kind: 'modify', bonusOk: false });
    expect(classifySituation({ events: [ev('get_service_masters', {})], ownText: 'Перенесла бы вас на 15:00, подтверждаете?' }).kind).toBe('modify');
    expect(classifySituation({ events: [], ownText: 'Отменить запись?' }).kind).toBe('modify');
  });
  test('«переносица» словом переноса не считается', () => {
    expect(classifySituation({ events: [], ownText: 'Зона переносицы стоит 3000 ₽.' }).kind).toBe('price');
  });
  test('результат-заглушка truncated не роняет', () => {
    expect(classifySituation({ events: [ev('get_available_slots', { truncated: true, preview: '…' })] }).kind).toBe('unknown');
  });
  test('BONUS_OK перечисляет ровно choice и price', () => {
    expect([...BONUS_OK].sort()).toEqual(['choice', 'price']);
  });
});

describe('lastOwnReply', () => {
  test('последний assistant-блок без строк администратора', () => {
    const messages = [
      { role: 'user', content: 'Сколько стоит?' },
      { role: 'assistant', content: `От 4500 ₽.\n${OPERATOR_MARK} Перенесла вашу запись.` },
    ];
    expect(lastOwnReply(messages)).toBe('От 4500 ₽.');
  });
  test('транскрипт кончается клиентом или пуст → пустая строка', () => {
    expect(lastOwnReply([{ role: 'assistant', content: 'a' }, { role: 'user', content: 'b' }])).toBe('');
    expect(lastOwnReply([])).toBe('');
    expect(lastOwnReply(null)).toBe('');
  });
});
```

- [ ] **Step 2: Запустить, убедиться, что падает**

Run: `cd /root/loyalpro/backend && npx jest agent-followup-situation.test.js`
Expected: FAIL — модуль не найден.

- [ ] **Step 3: Реализация**

```js
'use strict';
// ============================================================
// Класс ситуации хода-якоря — уместен ли бонусный довод в напоминании Милы о
// себе. ЧИСТЫЙ модуль: ни БД, ни сети. Спека —
// docs/superpowers/specs/2026-09-20-agent-followup-bonus-argument-design.md.
//
// Два источника: журнал инструментов хода (agent_tool_events по turn_id,
// читает tool-events.loadTurn) и СОБСТВЕННАЯ последняя реплика Милы. Цены в
// боевом catalogMode лежат прямо в промпте, и ответ о стоимости не оставляет
// в журнале ни одного вызова — поэтому текст реплики сверяется тоже.
//
// Приоритет классов (первое совпадение сверху):
//   modify  — перенос/отмена/правка услуг: продажа поверх отмены бестактна;
//   clarify — hint-ответ create_booking/book_chain: пациент завис на вопросе
//             (препарат, номер, время), а не на мотивации;
//   choice  — показаны времена/специалисты: довод «записаться сейчас»;
//   price   — названа цена или отправлен прайс: самый сильный случай;
//   unknown — всё остальное (справка из КБ, консультация врача). Без довода
//             СОЗНАТЕЛЬНО: медицинский маршрут признака в коде не имеет.
//
// Юнит-тесты: agent-followup-situation.test.js
// ============================================================

const { OPERATOR_MARK } = require('./history');

const MODIFY_TOOLS = new Set(['reschedule_booking', 'cancel_booking', 'modify_booking_services']);
const BOOKING_TOOLS = new Set(['create_booking', 'book_chain']);
const SLOT_TOOLS = new Set(['get_available_slots', 'get_available_dates', 'get_sequential_slots', 'get_parallel_slots']);
const PRICE_TOOLS = new Set(['get_service_masters', 'send_price_list']);
// Hint-ответы write-инструментов (см. isHintResult в tools/reschedule-booking.js
// и ветки create-booking.js): YClients не звался, ход предрешён вопросом.
const HINT_FLAGS = ['needs_phone', 'generic_service_hint', 'too_soon', 'unverified_slot', 'needs_confirmation', 'wrong_service'];
// Ключи непустой выдачи по всем четырём слот-инструментам: slots/offer_slots/
// staff_options/alternative_staff (get_available_slots), variants (sequential),
// starts (parallel), schedule (dates); free_day:true — тоже выбор (половина дня).
const SLOT_KEYS = ['slots', 'offer_slots', 'staff_options', 'alternative_staff', 'variants', 'starts', 'schedule'];

// Закрытый список форм, а не открытый суффикс: `перенос\w*` ловил бы
// «переносицу» (та же готча, что RESCHEDULE_INTENT_RE в reply-guard).
const MODIFY_TEXT_RE = /(?<![\p{L}])(перенес(у|ла|ти|ите|ём|ем)?|перенос(а|е|у|ом)?|отмен(а|у|ю|ить|ила|им|ите|ена|ены|ено)?)(?![\p{L}])/iu;
const PRICE_TEXT_RE = /\d[\d\s ]*\s?(?:₽|руб)/iu;

const BONUS_OK = new Set(['choice', 'price']);

function obj(v) { return v && typeof v === 'object' && !Array.isArray(v) ? v : null; }
function nonEmpty(v) { return Array.isArray(v) && v.length > 0; }

function hasHint(result) {
  const r = obj(result);
  return !!r && HINT_FLAGS.some((k) => r[k] === true);
}
function hasSlots(result) {
  const r = obj(result);
  if (!r) return false;
  if (r.free_day === true) return true;
  return SLOT_KEYS.some((k) => nonEmpty(r[k]));
}

/**
 * @param {object} o
 * @param {Array<{tool:string, result:any, is_error:boolean}>} [o.events]
 * @param {string} [o.ownText] последняя реплика Милы (lastOwnReply)
 * @returns {{kind:'modify'|'clarify'|'choice'|'price'|'unknown', bonusOk:boolean}}
 */
function classifySituation({ events = [], ownText = '' } = {}) {
  const evs = Array.isArray(events) ? events.filter(Boolean) : [];
  const text = String(ownText || '');
  const called = (set) => evs.some((e) => set.has(e.tool));
  const calledOk = (set) => evs.some((e) => set.has(e.tool) && !e.is_error);

  let kind = 'unknown';
  if (called(MODIFY_TOOLS) || MODIFY_TEXT_RE.test(text)) kind = 'modify';
  else if (evs.some((e) => BOOKING_TOOLS.has(e.tool) && hasHint(e.result))) kind = 'clarify';
  else if (evs.some((e) => SLOT_TOOLS.has(e.tool) && !e.is_error && hasSlots(e.result))) kind = 'choice';
  else if (calledOk(PRICE_TOOLS) || PRICE_TEXT_RE.test(text)) kind = 'price';
  return { kind, bonusOk: BONUS_OK.has(kind) };
}

/**
 * Последний assistant-блок транскрипта без строк администратора. Транскрипт
 * воркер грузит с keepTrailingAssistant, поэтому реплика Милы стоит последней;
 * если последним оказался клиент — реплики нет (пустая строка).
 */
function lastOwnReply(messages) {
  const arr = Array.isArray(messages) ? messages : [];
  const last = arr[arr.length - 1];
  if (!last || last.role !== 'assistant') return '';
  return String(last.content || '').split('\n')
    .filter((line) => !line.includes(OPERATOR_MARK)).join('\n').trim();
}

module.exports = { classifySituation, lastOwnReply, BONUS_OK, MODIFY_TEXT_RE, PRICE_TEXT_RE };
```

- [ ] **Step 4: Запустить тест**

Run: `cd /root/loyalpro/backend && npx jest agent-followup-situation.test.js`
Expected: PASS.

- [ ] **Step 5: Коммит**

```bash
cd /root/loyalpro && git add backend/services/agent/followup-situation.js backend/agent-followup-situation.test.js
git commit -m "feat(agent): followup-situation — класс ситуации хода для бонусного довода

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 8: `followup-bonus.js` — выбор фразы

**Files:**
- Create: `backend/services/agent/followup-bonus.js`
- Test: `backend/agent-followup-bonus.test.js`

- [ ] **Step 1: Падающий тест**

```js
'use strict';
// Выбор бонусной фразы для напоминания Милы о себе. Чистый модуль.
const { chooseBonusLine, formatBalance, BONUS_MENTION_RE } = require('./services/agent/followup-bonus');

const settings = (over = {}) => ({
  followupBonusText: 'На вашей карте {balance} бонусов 🤍',
  followupWelcomeText: 'При регистрации дарим 500 баллов.',
  followupBonusMinBalance: 100,
  ...over,
});
const base = (over = {}) => ({
  situation: { kind: 'price', bonusOk: true },
  card: { status: 'ok', balance: 3024, cardId: 1 },
  settings: settings(),
  alreadyMentioned: false,
  recentlySent: false,
  nudgeText: 'Подскажите, записать вас?',
  ...over,
});

test('formatBalance: разряды через неразрывный пробел, целое', () => {
  expect(formatBalance(3024)).toBe('3 024');
  expect(formatBalance(950)).toBe('950');
  expect(formatBalance(1234567.9)).toBe('1 234 567');
});

test('держатель карты выше порога → balance с подстановкой', () => {
  expect(chooseBonusLine(base())).toEqual({ kind: 'balance', balance: 3024, text: 'На вашей карте 3 024 бонусов 🤍' });
});
test('баланс ниже порога → ничего (ни баланса, ни приглашения)', () => {
  expect(chooseBonusLine(base({ card: { status: 'ok', balance: 99 } }))).toBe(null);
  expect(chooseBonusLine(base({ card: { status: 'ok', balance: 100 } })).kind).toBe('balance'); // порог включающий
});
test.each(['no_card', 'no_client'])('%s → welcome', (status) => {
  expect(chooseBonusLine(base({ card: { status } }))).toEqual({ kind: 'welcome', text: 'При регистрации дарим 500 баллов.' });
});
test('unavailable → ничего', () => {
  expect(chooseBonusLine(base({ card: { status: 'unavailable', reason: 'x' } }))).toBe(null);
});
test('пустой шаблон ветки выключает только её', () => {
  expect(chooseBonusLine(base({ settings: settings({ followupBonusText: null }) }))).toBe(null);
  expect(chooseBonusLine(base({ card: { status: 'no_card' }, settings: settings({ followupBonusText: null }) })).kind).toBe('welcome');
  expect(chooseBonusLine(base({ card: { status: 'no_card' }, settings: settings({ followupWelcomeText: '' }) }))).toBe(null);
});
test('неуместная ситуация, уже звучало, недавно слали → ничего', () => {
  expect(chooseBonusLine(base({ situation: { kind: 'clarify', bonusOk: false } }))).toBe(null);
  expect(chooseBonusLine(base({ alreadyMentioned: true }))).toBe(null);
  expect(chooseBonusLine(base({ recentlySent: true }))).toBe(null);
});
test('модель сама упомянула бонусы/лояльность → не дублируем', () => {
  expect(chooseBonusLine(base({ nudgeText: 'Напомню, у вас есть бонусы — записать?' }))).toBe(null);
  expect(chooseBonusLine(base({ nudgeText: 'Про программу лояльности расскажу при визите.' }))).toBe(null);
});
test('render применяется ПОСЛЕ подстановки {balance}', () => {
  const render = (t) => t.replace('{first_name}', 'Мария');
  const out = chooseBonusLine(base({ settings: settings({ followupBonusText: '{first_name}, на карте {balance} б.' }), render }));
  expect(out.text).toBe('Мария, на карте 3 024 б.');
});
test('BONUS_MENTION_RE ловит словоформы', () => {
  expect(BONUS_MENTION_RE.test('бонусами')).toBe(true);
  expect(BONUS_MENTION_RE.test('программе лояльности')).toBe(true);
  expect(BONUS_MENTION_RE.test('баланс чека')).toBe(false);
});
```

- [ ] **Step 2: Запустить, убедиться, что падает**

Run: `cd /root/loyalpro/backend && npx jest agent-followup-bonus.test.js`
Expected: FAIL — модуль не найден.

- [ ] **Step 3: Реализация**

```js
'use strict';
// ============================================================
// Бонусная фраза для напоминания Милы о себе — ЧИСТЫЙ выбор по фактам.
// Спека: docs/superpowers/specs/2026-09-20-agent-followup-bonus-argument-design.md
//
// Все факты приходят снаружи (класс ситуации, результат чтения карты,
// шаблоны салона, признаки «уже звучало»); модуль только решает, какая ветка
// применима, и рендерит шаблон. Текст пишет САЛОН, а не модель: баланс —
// живые данные, называть их по памяти Миле запрещено, а дописка кодом не
// может ни выдумать число, ни оказаться «не к месту» вопреки гейтам.
//
// Порядок проверок: гейты уместности → статус карты → шаблон ветки. Пустой
// шаблон выключает ТОЛЬКО свою ветку.
//
// Юнит-тесты: agent-followup-bonus.test.js
// ============================================================

// Слово о бонусах/лояльности в транскрипте или в тексте модели: второй раз
// звучать не должно. «балл» намеренно не в списке — в клинике так говорят и о
// другом (см. visit-rating.js).
const BONUS_MENTION_RE = /бонус|лояльност/iu;

/** 3024 → «3 024» (неразрывный пробел), целая часть. */
function formatBalance(n) {
  const v = Math.floor(Number(n) || 0);
  return String(v).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
}

/**
 * @param {object} o
 * @param {{kind:string, bonusOk:boolean}} o.situation
 * @param {{status:string, balance?:number}} o.card   результат card-balance.readCardBalance
 * @param {object} o.settings   followupBonusText / followupWelcomeText / followupBonusMinBalance
 * @param {boolean} o.alreadyMentioned  бонусы уже звучали в окне транскрипта
 * @param {boolean} o.recentlySent      по номеру за 7 дней уже уходила бонусная фраза
 * @param {string}  o.nudgeText         текст напоминания от модели
 * @param {(t:string)=>string} [o.render]  общий рендер шаблонов ({first_name}, {salon})
 * @returns {{kind:'balance', text:string, balance:number}|{kind:'welcome', text:string}|null}
 */
function chooseBonusLine({ situation, card, settings = {}, alreadyMentioned, recentlySent, nudgeText, render } = {}) {
  if (!situation || !situation.bonusOk) return null;
  if (alreadyMentioned || recentlySent) return null;
  if (BONUS_MENTION_RE.test(String(nudgeText || ''))) return null;
  if (!card) return null;
  const rnd = typeof render === 'function' ? render : (t) => t;

  if (card.status === 'ok') {
    const tpl = String(settings.followupBonusText || '').trim();
    if (!tpl) return null;
    const min = Number.isFinite(Number(settings.followupBonusMinBalance)) ? Number(settings.followupBonusMinBalance) : 100;
    const balance = Math.floor(Number(card.balance) || 0);
    if (balance < min) return null;
    const text = rnd(tpl.replace(/\{balance\}/g, formatBalance(balance))).trim();
    return text ? { kind: 'balance', text, balance } : null;
  }
  if (card.status === 'no_card' || card.status === 'no_client') {
    const tpl = String(settings.followupWelcomeText || '').trim();
    if (!tpl) return null;
    const text = rnd(tpl).trim();
    return text ? { kind: 'welcome', text } : null;
  }
  return null;
}

module.exports = { chooseBonusLine, formatBalance, BONUS_MENTION_RE };
```

- [ ] **Step 4: Запустить тест**

Run: `cd /root/loyalpro/backend && npx jest agent-followup-bonus.test.js`
Expected: PASS.

- [ ] **Step 5: Коммит**

```bash
cd /root/loyalpro && git add backend/services/agent/followup-bonus.js backend/agent-followup-bonus.test.js
git commit -m "feat(agent): followup-bonus — выбор бонусной фразы из шаблонов салона

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 9: `anchor_turn_id` в очереди и диспетчере

**Files:**
- Modify: `backend/services/agent/followup-queue.js:29-66`
- Modify: `backend/services/agent/dispatcher.js:347`
- Test: `backend/agent-followup-queue.test.js`, `backend/agent-dispatcher.test.js`

- [ ] **Step 1: Падающий тест очереди**

В `describe('schedule', …)` файла `agent-followup-queue.test.js` добавить:

```js
  test('turnId хода-якоря пишется в anchor_turn_id и обновляется при перезаводе', async () => {
    const db = mockDb();
    await queue.schedule(1, '79200255591', META, SETTINGS, { db, turnId: 'turn-abc' });
    const { sql, params } = db.calls[0];
    expect(sql).toMatch(/anchor_turn_id/);
    expect(sql).toMatch(/DO UPDATE SET[\s\S]*anchor_turn_id\s*=\s*\$8/);
    // Новый цикл — журнал бонусной фразы прошлого цикла сбрасывается.
    expect(sql).toMatch(/bonus_kind\s*=\s*NULL/);
    expect(sql).toMatch(/bonus_balance\s*=\s*NULL/);
    expect(params[7]).toBe('turn-abc');
  });
  test('без turnId — NULL', async () => {
    const db = mockDb();
    await queue.schedule(1, '79200255591', META, SETTINGS, { db });
    expect(db.calls[0].params[7]).toBe(null);
  });
```

- [ ] **Step 2: Запустить, убедиться, что падает**

Run: `cd /root/loyalpro/backend && npx jest agent-followup-queue.test.js`
Expected: FAIL.

- [ ] **Step 3: Правка `followup-queue.js`**

В `schedule` заменить SQL и параметры:

```js
    await db.query(
      `INSERT INTO agent_followups
         (salon_id, dialog_key, phone, channel, chat_id, anchor_at, next_at,
          anchor_turn_id, stage, status, close_reason, attempts, last_attempt_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,0,'scheduled',NULL,0,NULL,now())
       ON CONFLICT (salon_id, dialog_key) WHERE status='scheduled'
       DO UPDATE SET phone=$3, channel=$4, chat_id=$5, anchor_at=$6, next_at=$7,
                     anchor_turn_id=$8,
                     stage=0, close_reason=NULL, attempts=0, last_attempt_at=NULL,
                     -- Перезавод — НОВЫЙ цикл ожидания, а не продолжение старого.
                     -- (см. историю комментария в git: журнал незавершённого
                     -- цикла дешевле потерять, чем оставить противоречивым.)
                     nudge1_at=NULL, final_at=NULL, rendered_text=NULL, error=NULL,
                     bonus_kind=NULL, bonus_balance=NULL,
                     updated_at=now()`,
      [salonId, dialogKey, meta.phone || null, meta.channel || null, meta.chatId || null,
       anchor, next, opts.turnId ? String(opts.turnId) : null]);
```

(Существующий длинный комментарий про `nudge1_at` оставить как есть, просто дописать две новые колонки.) В JSDoc `schedule` добавить `@param {string} [opts.turnId] turn_id хода-якоря (журнал инструментов)`.

- [ ] **Step 4: Правка диспетчера**

В `services/agent/dispatcher.js` строку
```js
          .then(s => followupQueue.schedule(salonId, dialogKey, meta, s, { now: anchorAt }))
```
заменить на
```js
          .then(s => followupQueue.schedule(salonId, dialogKey, meta, s, { now: anchorAt, turnId }))
```
(`turnId` объявлен выше в `process()` и заполнен из `res.turnId`.)

- [ ] **Step 5: Тест диспетчера**

В `agent-dispatcher.test.js` внутри `describe('ожидание ответа клиента (followup)', …)` (строка ~855; там уже есть `followupDeps()`, `flushMicrotasks()`, общий `deps()` и `meta`) после первого теста «обычный доставленный ход → …» добавить:

```js
  test('turnId хода-якоря уходит в schedule (по нему воркер читает журнал инструментов)', async () => {
    const followupSettings = { followupDelay1Min: 15, followupDelay2Min: 60 };
    const d = deps({
      ...followupDeps(),
      orchestrator: { runDialog: jest.fn(async () => ({ replies: ['Записать вас?'], escalated: false, turnId: 't-9' })) },
      settings: {
        isAllowed: jest.fn(async () => ({ allow: true, reason: 'ok' })),
        getSettings: jest.fn(async () => followupSettings),
      },
    });
    dispatcher.enqueue(1, 'k', meta, d);
    await jest.advanceTimersByTimeAsync(1000);
    await flushMicrotasks();
    expect(d.followupQueue.schedule).toHaveBeenCalledWith(
      1, 'k', meta, followupSettings, expect.objectContaining({ turnId: 't-9' }));
  });
```

- [ ] **Step 6: Запустить тесты**

Run: `cd /root/loyalpro/backend && npx jest agent-followup-queue.test.js agent-dispatcher.test.js`
Expected: PASS.

- [ ] **Step 7: Коммит**

```bash
cd /root/loyalpro && git add backend/services/agent/followup-queue.js backend/services/agent/dispatcher.js backend/agent-followup-queue.test.js backend/agent-dispatcher.test.js
git commit -m "feat(agent): anchor_turn_id у строки ожидания ответа — журнал хода для классификатора

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 10: Интеграция в воркер

**Files:**
- Modify: `backend/services/agent/followup-worker.js`
- Test: `backend/agent-followup-worker.test.js`

- [ ] **Step 1: Падающие тесты**

В фикстуру `deps()` файла `agent-followup-worker.test.js` (объект `d`, перед `...over`) добавить три зависимости:

```js
    readCardBalance: async () => ({ status: 'unavailable', reason: 'test' }),
    loadTurnEvents: async () => [],
    recentBonusSent: async () => false,
```

Добавить новый `describe` перед `describe('followup worker: финал (stage 1)', …)`:

```js
describe('followup worker: бонусный довод (stage 0)', () => {
  const BONUS_ROW = {
    followup_bonus_text: 'На карте {balance} бонусов.',
    followup_welcome_text: 'Дарим 500 баллов при регистрации.',
    followup_bonus_min_balance: 100,
    anchor_turn_id: 'turn-1',
  };
  // Транскрипт с ценой в реплике Милы — класс price без единого инструмента.
  const priceTranscript = async () => ({ messages: [
    { role: 'user', content: 'Сколько стоит биоревитализация?' },
    { role: 'assistant', content: 'Мария, от 12 000 ₽. Записать вас?' },
  ] });

  test('держатель карты: фраза дописана отдельным абзацем, журнал в захвате', async () => {
    const d = deps({ loadTranscript: priceTranscript, readCardBalance: async () => ({ status: 'ok', balance: 3024, cardId: 1 }) });
    await worker.processOne(row(BONUS_ROW), d);
    expect(d.calls.sent).toHaveLength(1);
    expect(d.calls.sent[0].text).toBe('Мария, подскажите, записать вас?\n\nНа карте 3 024 бонусов.');
    const mark = d.calls.marks.find((m) => /stage\s*=\s*1/.test(m.sql));
    expect(mark.sql).toMatch(/bonus_kind\s*=\s*\$4/);
    expect(mark.sql).toMatch(/bonus_balance\s*=\s*\$5/);
    expect(mark.params[3]).toBe('balance');
    expect(mark.params[4]).toBe(3024);
    expect(mark.params[2]).toBe(d.calls.sent[0].text); // rendered_text = весь текст
  });

  test('без карты → welcome; шаблоны пустые → без фразы и без похода за картой', async () => {
    const d = deps({ loadTranscript: priceTranscript, readCardBalance: async () => ({ status: 'no_card' }) });
    await worker.processOne(row(BONUS_ROW), d);
    expect(d.calls.sent[0].text).toMatch(/\n\nДарим 500 баллов при регистрации\.$/);
    const mark = d.calls.marks.find((m) => /stage\s*=\s*1/.test(m.sql));
    expect(mark.params[3]).toBe('welcome');
    expect(mark.params[4]).toBe(null);

    const calls = [];
    const d2 = deps({ loadTranscript: priceTranscript, readCardBalance: async () => { calls.push(1); return { status: 'ok', balance: 999 }; } });
    await worker.processOne(row(), d2); // в row() шаблонов нет
    expect(calls).toHaveLength(0);
    expect(d2.calls.sent[0].text).toBe('Мария, подскажите, записать вас?');
    const mark2 = d2.calls.marks.find((m) => /stage\s*=\s*1/.test(m.sql));
    expect(mark2.params[3]).toBe(null);
  });

  test('ситуация clarify по журналу хода → без фразы, карта не читается', async () => {
    const calls = [];
    const d = deps({
      loadTranscript: priceTranscript,
      loadTurnEvents: async (turnId) => { calls.push(turnId); return [{ tool: 'create_booking', result: { needs_phone: true }, is_error: true }]; },
      readCardBalance: async () => { throw new Error('не должен зваться'); },
    });
    await worker.processOne(row(BONUS_ROW), d);
    expect(calls).toEqual(['turn-1']);
    expect(d.calls.sent[0].text).toBe('Мария, подскажите, записать вас?');
  });

  test('бонусы уже звучали в переписке / недавно слали → без фразы', async () => {
    const d = deps({
      loadTranscript: async () => ({ messages: [
        { role: 'user', content: 'А бонусы у меня есть?' },
        { role: 'assistant', content: 'Да, 3 024 бонуса. Чистка от 4500 ₽. Записать?' },
      ] }),
      readCardBalance: async () => ({ status: 'ok', balance: 3024 }),
    });
    await worker.processOne(row(BONUS_ROW), d);
    expect(d.calls.sent[0].text).not.toMatch(/На карте/);

    const d2 = deps({ loadTranscript: priceTranscript, recentBonusSent: async () => true,
      readCardBalance: async () => ({ status: 'ok', balance: 3024 }) });
    await worker.processOne(row(BONUS_ROW), d2);
    expect(d2.calls.sent[0].text).not.toMatch(/На карте/);
  });

  test('нет номера → без фразы; исключение в бонусной ветке не ломает отправку', async () => {
    // Канал без номера — tdlib со скрытым номером: адресат по chat_id
    // (recipientParams), карту читать не по чему.
    const calls = [];
    const d = deps({ loadTranscript: priceTranscript,
      readCardBalance: async () => { calls.push(1); return { status: 'ok', balance: 3024 }; } });
    await worker.processOne(row({ ...BONUS_ROW, phone: null, channel: 'tdlib', chat_id: '5245186003' }), d);
    expect(d.calls.sent).toHaveLength(1);
    expect(d.calls.sent[0].tdlib_user_id).toBe('5245186003');
    expect(d.calls.sent[0].text).not.toMatch(/На карте/);
    expect(calls).toHaveLength(0);

    const d2 = deps({ loadTranscript: priceTranscript, loadTurnEvents: async () => { throw new Error('boom'); } });
    await worker.processOne(row(BONUS_ROW), d2);
    expect(d2.calls.sent).toHaveLength(1);
    expect(d2.calls.sent[0].text).toBe('Мария, подскажите, записать вас?');
  });

  test('skip модели не стоит похода за картой; финал (stage 1) фразу не получает', async () => {
    const calls = [];
    const d = deps({ loadTranscript: priceTranscript,
      createMessage: async () => ({ text: '{"action":"skip","reason":"попрощались"}' }),
      readCardBalance: async () => { calls.push(1); return { status: 'ok', balance: 3024 }; } });
    await worker.processOne(row(BONUS_ROW), d);
    expect(calls).toHaveLength(0);

    const d2 = deps({ readCardBalance: async () => { calls.push(2); return { status: 'ok', balance: 3024 }; } });
    await worker.processOne(row({ ...BONUS_ROW, stage: 1 }), d2);
    expect(calls).toHaveLength(0);
    expect(d2.calls.sent[0].text).not.toMatch(/На карте/);
  });

  test('reply-guard и guard времени проверяют текст МОДЕЛИ, а не шаблон салона', async () => {
    const seen = [];
    const d = deps({ loadTranscript: priceTranscript, readCardBalance: async () => ({ status: 'ok', balance: 3024 }),
      lintReply: (text) => { seen.push(text); return []; } });
    await worker.processOne(row(BONUS_ROW), d);
    expect(seen).toEqual(['Мария, подскажите, записать вас?']);
  });
});
```

Также в `describe('инварианты', …)` добавить:

```js
  test('LEASE_SQL отдаёт шаблоны бонусного довода и порог', () => {
    expect(worker.LEASE_SQL).toMatch(/followup_bonus_text/);
    expect(worker.LEASE_SQL).toMatch(/followup_welcome_text/);
    expect(worker.LEASE_SQL).toMatch(/followup_bonus_min_balance/);
  });
```

- [ ] **Step 2: Запустить, убедиться, что падает**

Run: `cd /root/loyalpro/backend && npx jest agent-followup-worker.test.js`
Expected: FAIL новые тесты (текст без фразы, `bonus_kind` отсутствует в SQL).

- [ ] **Step 3: Реализация в `followup-worker.js`**

1. Импорты (после `const { resolveSalonName } = require('./system-prompt');`):
```js
const toolEvents = require('./tool-events');
const cardBalance = require('../card-balance');
const { classifySituation, lastOwnReply } = require('./followup-situation');
const { chooseBonusLine, BONUS_MENTION_RE } = require('./followup-bonus');
```

2. В `defaultDeps` (после `emitStatus`) добавить:
```js
  // ── Бонусный довод (спека 2026-09-20) ─────────────────────────────────
  // Салон читается тут, а не в LEASE_SQL: карте нужны токены YClients и тип
  // карты, а тащить их в RETURNING каждой аренды незачем.
  readCardBalance: async (salonId, phone) => {
    const salon = await realDb.oneOrNone(
      `SELECT id, yclients_company_id, yclients_partner_token, yclients_user_token, yclients_card_type_id
         FROM salons WHERE id=$1`, [salonId]);
    if (!salon) return { status: 'unavailable', reason: 'no_salon' };
    return cardBalance.readCardBalance(salon, phone);
  },
  loadTurnEvents: (turnId) => toolEvents.loadTurn(turnId),
  // Правило «не чаще раза в 7 дней на номер» — по журналу ушедших фраз
  // (bonus_kind пишется только в захвате, то есть только у реально ушедших).
  recentBonusSent: async (salonId, phone) => {
    const r = await realDb.oneOrNone(
      `SELECT 1 FROM agent_followups
        WHERE salon_id=$1 AND phone=$2 AND bonus_kind IS NOT NULL
          AND nudge1_at > now() - interval '7 days'
        LIMIT 1`, [salonId, phone]);
    return !!r;
  },
```

3. Перед `async function resolveRecipient` добавить:

```js
// ── Бонусный довод к напоминанию ─────────────────────────────────────────────
// Считается ПОСЛЕ LLM-прохода (skip модели не должен стоить похода в YClients)
// и ДО захвата строки (bonus_kind/bonus_balance пишутся в том же условном
// UPDATE — журнал отражает только реально ушедшие фразы). Строго best-effort:
// любое исключение → напоминание уходит без фразы, с WARN в логе.
//
// Гейты от дешёвых к дорогим: шаблоны → номер → ситуация (журнал хода + текст
// Милы) → «уже звучало» → 7 дней → карта (YClients).
async function tryBonusLine(d, row, messages, nudgeText) {
  const settings = {
    followupBonusText: row.followup_bonus_text,
    followupWelcomeText: row.followup_welcome_text,
    followupBonusMinBalance: row.followup_bonus_min_balance,
  };
  const none = (why) => ({ line: null, why });
  try {
    if (!String(settings.followupBonusText || '').trim() && !String(settings.followupWelcomeText || '').trim())
      return none('шаблоны пусты');
    if (!row.phone) return none('номер неизвестен');
    const events = await d.loadTurnEvents(row.anchor_turn_id);
    const situation = classifySituation({ events, ownText: lastOwnReply(messages) });
    if (!situation.bonusOk) return none(`ситуация ${situation.kind}`);
    const alreadyMentioned = (messages || []).some((m) => BONUS_MENTION_RE.test(String((m && m.content) || '')));
    if (alreadyMentioned) return none('бонусы уже звучали в переписке');
    if (await d.recentBonusSent(row.salon_id, row.phone)) return none('фраза уходила за последние 7 дней');
    const card = await d.readCardBalance(row.salon_id, row.phone);
    const line = chooseBonusLine({
      situation, card, settings, alreadyMentioned, recentlySent: false, nudgeText,
      render: (t) => notifications.renderTemplate(t, {
        name: row.client_name, salon: row.salon_name,
        nameDictionary: null,
      }),
    });
    return line ? { line, why: `${line.kind} (ситуация ${situation.kind}, карта ${card.status})` }
      : none(`ситуация ${situation.kind}, карта ${card.status}${card.balance != null ? ` баланс ${card.balance}` : ''}`);
  } catch (e) {
    d.log.warn(`followup #${row.id}: бонусный довод не посчитан (${e.message}) — шлём без него`);
    return none(`ошибка: ${e.message}`);
  }
}
```

4. В `processOne`, ветка `else` (stage 0), после `if (built.skip) return finish('cancelled', built.reason);` заменить `text = built.text;` на:

```js
      const bonus = await tryBonusLine(d, row, (transcript && transcript.messages) || [], built.text);
      bonusLine = bonus.line;
      d.log.info(`followup #${row.id}: бонусный довод — ${bonus.why}`);
      text = bonusLine ? `${built.text}\n\n${bonusLine.text}` : built.text;
```

и объявить `let bonusLine = null;` рядом с `let text;` (перед `if (isFinal)`).

5. Захват stage 0 — заменить SQL и параметры:

```js
      marked = await d.db.query(
        `UPDATE agent_followups
            SET stage=1, nudge1_at=NOW(), next_at=$2, rendered_text=$3,
                bonus_kind=$4, bonus_balance=$5,
                close_reason=NULL, error=NULL, attempts=0, last_attempt_at=NULL,
                updated_at=now()
          WHERE id=$1 AND status='scheduled' AND stage=0`,
        [row.id, finalAt, text,
         bonusLine ? bonusLine.kind : null,
         bonusLine && bonusLine.kind === 'balance' ? bonusLine.balance : null]);
```

6. Строку лога отправки дополнить: в `d.log.info(\`followup #${row.id} ${isFinal ? 'final' : 'nudge'} принято в доставку …` добавить перед `: ${String(text)…}` фрагмент `` bonus=${bonusLine ? bonusLine.kind : 'none'} ``.

7. `LEASE_SQL`: после строки `(SELECT s.followup_latest_time …) AS followup_latest_time,` добавить:
```sql
    (SELECT s.followup_bonus_text  FROM agent_settings s WHERE s.salon_id = f.salon_id) AS followup_bonus_text,
    (SELECT s.followup_welcome_text FROM agent_settings s WHERE s.salon_id = f.salon_id) AS followup_welcome_text,
    (SELECT s.followup_bonus_min_balance FROM agent_settings s WHERE s.salon_id = f.salon_id) AS followup_bonus_min_balance,
```

ПРИМЕЧАНИЕ к `nameDictionary: null` в рендере: словарь имён салона уже грузится в `buildNudgeText` через `d.loadNameDictionary`; чтобы не ходить дважды, допустимо поднять результат `loadNameDictionary` в `processOne` и передать его в `tryBonusLine` третьим аргументом — сделать это, если правка укладывается в 5 строк; иначе оставить `null` (без словаря `{first_name}` резолвится базовым словарём имён, как и `{first_name}` в финале до этой правки).

- [ ] **Step 4: Запустить весь сьют воркера**

Run: `cd /root/loyalpro/backend && npx jest agent-followup-worker.test.js`
Expected: PASS все, включая старые.

- [ ] **Step 5: Коммит**

```bash
cd /root/loyalpro && git add backend/services/agent/followup-worker.js backend/agent-followup-worker.test.js
git commit -m "feat(agent): бонусный довод в напоминании Милы о себе — интеграция в followup-worker

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 11: Живой EXPLAIN аренды на дев-БД

**Files:** ничего не меняется.

- [ ] **Step 1: Прогнать EXPLAIN**

Run (из `backend/`):
```bash
node -e "
const { db, pool } = require('./db');
const { LEASE_SQL } = require('./services/agent/followup-worker');
(async () => {
  const rows = await db.any('EXPLAIN ' + LEASE_SQL, [180]);
  rows.forEach(r => console.log(r['QUERY PLAN']));
  await pool.end();
})().catch(e => { console.error('EXPLAIN FAILED:', e.message); process.exit(1); });
"
```
Expected: план без ошибок (три новых SubPlan на `agent_settings`). Ошибка «column … does not exist» означает, что миграции Task 4 не прогнаны на этой БД.

---

### Task 12: Фронт — три поля в модалке «Агент»

**Files:**
- Modify: `frontend/index.html:1663-1667` (блок «Напоминания о себе») и строка `<script src="js/pages/agent-settings.js?v=…">` (~2458)
- Modify: `frontend/js/pages/agent-settings.js:19-22, 107-140`

- [ ] **Step 1: Разметка**

В `frontend/index.html` после `</div>` блока с `<textarea id="agent-followup-text" …>` (строка ~1665) и ПЕРЕД `<div class="fl" style="opacity:.7">0 в первом поле …` вставить:

```html
            <div class="fg">
              <label class="fl">Довод про бонусы держателю карты (в первом напоминании)</label>
              <textarea id="agent-followup-bonus-text" rows="2" placeholder="Например: Кстати, на вашей бонусной карте {balance} бонусов — ими можно оплатить часть визита 🤍 (пусто — не упоминать)"></textarea>
              <div class="fl" style="opacity:.7;margin-top:4px;font-weight:400">{balance} — баланс карты, {first_name} — имя. Дописывается к напоминанию, только если Мила предлагала время или называла цену, а бонусы в переписке ещё не звучали.</div>
            </div>
            <div class="fg">
              <label class="fl">Приглашение в программу лояльности (пациенту без карты)</label>
              <textarea id="agent-followup-welcome-text" rows="2" placeholder="Например: Кстати, при регистрации в нашей программе лояльности дарим 500 приветственных баллов — регистрация в Telegram-боте или по QR на сайте. (пусто — не упоминать)"></textarea>
            </div>
            <div class="fg" style="max-width:260px">
              <label class="fl">Минимальный баланс для упоминания</label>
              <input type="number" id="agent-followup-bonus-min" min="0" max="100000" placeholder="100">
            </div>
```

Бамп кэш-бастера: `js/pages/agent-settings.js?v=2026-09-20`.

- [ ] **Step 2: Загрузка и сохранение**

В `openAgentSettings` после `document.getElementById('agent-followup-text').value = s.followupFinalText || '';` добавить:
```js
    document.getElementById('agent-followup-bonus-text').value = s.followupBonusText || '';
    document.getElementById('agent-followup-welcome-text').value = s.followupWelcomeText || '';
    document.getElementById('agent-followup-bonus-min').value = s.followupBonusMinBalance ?? 100;
```

В `saveAgentSettings` после `const followupFinalText = …` добавить:
```js
  const followupBonusText = document.getElementById('agent-followup-bonus-text').value;
  const followupWelcomeText = document.getElementById('agent-followup-welcome-text').value;
  // Пустое поле уходит пустой строкой = «оставить текущее» (pickMinBalance на сервере).
  const rawMin = document.getElementById('agent-followup-bonus-min').value.trim();
  const followupBonusMinBalance = rawMin === '' ? '' : Number(rawMin);
  if (followupBonusMinBalance !== '' && (!Number.isInteger(followupBonusMinBalance) || followupBonusMinBalance < 0 || followupBonusMinBalance > 100000)) {
    notify('«Минимальный баланс»: введите целое число от 0 до 100000', 'err');
    return;
  }
```
и в объект `api('PUT', '/api/agent/settings', {…})` добавить `followupBonusText, followupWelcomeText, followupBonusMinBalance,`.

- [ ] **Step 3: Проверить в браузере через MCP Playwright**

Открыть дев-сервер (`http://localhost:3001`, логин владельца), страница «Чат» → «⚙️ Агент»: три новых поля видны, ввести шаблон с `{balance}` и порог 150, сохранить, переоткрыть модалку — значения на месте. Проверить в БД: `SELECT followup_bonus_text, followup_welcome_text, followup_bonus_min_balance FROM agent_settings WHERE salon_id=1`. Затем очистить поля (пустые строки) и сохранить — колонки NULL, порог остался 150 (пустое поле = оставить).

- [ ] **Step 4: Коммит**

```bash
cd /root/loyalpro && git add frontend/index.html frontend/js/pages/agent-settings.js
git commit -m "feat(agent-ui): поля бонусного довода напоминания в модалке «Агент»

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 13: Живой прогон `scripts/agent-followup-e2e.js --bonus`

**Files:**
- Modify: `backend/scripts/agent-followup-e2e.js`

- [ ] **Step 1: Флаг и настройки**

1. Рядом с `const REAL_SEND = flag('--send');` добавить `const BONUS = flag('--bonus');`.
2. В шапке файла (комментарий использования) дописать `[--bonus]` и абзац: «`--bonus` на время прогона выставляет оба бонусных шаблона (и восстанавливает их в finally); транскрипт скрипта содержит цену в реплике Милы, так что класс ситуации — price; результат зависит от карты тестового номера: держатель → фраза с балансом, без карты → приглашение».
3. В `main()` SELECT «настройки ДО прогона» расширить полями `followup_bonus_text, followup_welcome_text` (и в `cleanup()` UPDATE восстанавливать их: `followup_bonus_text=$6, followup_welcome_text=$7`, параметры `b.followup_bonus_text, b.followup_welcome_text`).
4. После INSERT/UPDATE настроек добавить:
```js
  if (BONUS) {
    await db.query(
      `UPDATE agent_settings SET followup_bonus_text=$2, followup_welcome_text=$3, updated_at=now() WHERE salon_id=$1`,
      [SALON_ID,
       'Кстати, на вашей бонусной карте {balance} бонусов — ими можно оплатить часть визита 🤍',
       'Кстати, при регистрации в нашей программе лояльности дарим 500 приветственных баллов.']);
    console.log('настройки салона временно: бонусные шаблоны заданы (--bonus)');
  }
```
5. В «итог строки» SELECT добавить `bonus_kind, bonus_balance`.

- [ ] **Step 2: Прогнать (pm2 остановить по инструкции скрипта)**

Run: `cd /root/loyalpro/backend && pm2 stop loyalpro && node scripts/agent-followup-e2e.js --bonus; PORT=3001 pm2 start loyalpro`
Expected: в консоли `=== ТЕКСТ (не отправлен) ===` — реплика модели, пустая строка, бонусная фраза; в «итог строки» `bonus_kind: 'balance'` с `bonus_balance` (тестовый номер 79200255591 держит карту) либо `'welcome'`. Второй прогон с номером без карты в YClients (`--phone <номер>`, подобрать через MCP postgres: `SELECT phone FROM clients WHERE salon_id=1 AND yclients_card_id IS NULL LIMIT 3`) — ожидать `welcome`. Третий прогон без `--bonus` — прежнее поведение, `bonus_kind: null`. НЕ пайпить вывод скрипта (см. шапку файла).

- [ ] **Step 3: Коммит**

```bash
cd /root/loyalpro && git add backend/scripts/agent-followup-e2e.js
git commit -m "test(agent): agent-followup-e2e --bonus — живая проверка бонусного довода

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 14: Полный прогон тестов, документация, память

**Files:**
- Modify: `CLAUDE.md` (раздел «AI-агент», рядом с пунктом «Ожидание ответа клиента и напоминания Милы о себе»)
- Create: `/root/.claude/projects/-root-loyalpro/memory/agent_followup_bonus_argument.md` + строка в `MEMORY.md`

- [ ] **Step 1: Полный jest**

Run: `cd /root/loyalpro/backend && npx jest --testPathIgnorePatterns primary-clients 2>&1 | tail -15`
Expected: все сьюты PASS (известный флейк `primary-clients.test.js` исключён — память проекта).

- [ ] **Step 2: Пункт в CLAUDE.md**

Добавить подпункт (тире второго уровня) внутрь пункта «Ожидание ответа клиента и напоминания Милы о себе»:

```
  - Бонусный довод в напоминании stage 0 (спека `docs/superpowers/specs/2026-09-20-agent-followup-bonus-argument-design.md`): к тексту модели КОД дописывает вторую фразу из шаблона салона — держателю карты с `{balance}` (`agent_settings.followup_bonus_text`, порог `followup_bonus_min_balance`, дефолт 100), пациенту без карты типа салона — приглашение в программу (`followup_welcome_text`); пустой шаблон = ветка выключена, дефолт NULL. Уместность решает чистый `followup-situation.js` по журналу хода-якоря (`agent_followups.anchor_turn_id` → `tool-events.loadTurn`) и последней реплике Милы: довод только в классах `choice` (непустая слот-выдача) и `price` (`get_service_masters`/`send_price_list` или сумма с ₽ в тексте — в catalogMode цена не оставляет вызовов); `modify` (перенос/отмена, закрытый список словоформ — «переносица»), `clarify` (hint-флаги create_booking) и `unknown` (справка, консультация врача) — без довода. Чтение карты — общий `services/card-balance.js` с ТРЁХЗНАЧНЫМ результатом: `ok`/`no_card`+`no_client`/`unavailable`; карты читаются СТРОГИМ `ycGetClientCardsStrict` (обычный `ycGetClientCards` глотает сбой в `[]`, и держатель карты получал бы приглашение зарегистрироваться в момент таймаута); клиент вне нашей БД ищется живым `clients/search` (новый пациент появляется в `clients` только после 3-часового синка — иначе ветка welcome не срабатывала бы именно у новых). Считается ПОСЛЕ LLM-прохода (skip модели не стоит похода в YClients), `reply-guard`/`hasInventedTime` линтуют текст МОДЕЛИ, шаблон салона — нет (как финальный текст). Гейты: оба шаблона пусты → нет; номер неизвестен → нет; `бонус|лояльност` в окне транскрипта или в тексте модели → нет; фраза уходила по номеру за 7 дней (`bonus_kind IS NOT NULL AND nudge1_at > now()-7d`, пишется ТОЛЬКО в захвате — журнал отражает реально ушедшее) → нет. `reminders/bonus.js` выбирает карту тем же `pickSalonCard`. Перед включением сверить `salons.yclients_card_type_id` с типом карты Telegram-бота (samosale). Живая проверка — `scripts/agent-followup-e2e.js --bonus`.
```

- [ ] **Step 3: Память**

Файл `/root/.claude/projects/-root-loyalpro/memory/agent_followup_bonus_argument.md` с frontmatter (`type: project`), кратко: что сделано, дата, статус выката (дев / прод), что фича спит вместе с родительской (`followup_delay1_min=0`), ссылка на спеку, `[[agent-followup-waiting-status]]`. Строка в `MEMORY.md` сверху.

- [ ] **Step 4: Коммит**

```bash
cd /root/loyalpro && git add CLAUDE.md
git commit -m "docs(agent): CLAUDE.md — бонусный довод в напоминании Милы о себе

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

## Самопроверка плана по спеке

- Решения 1–6: ступень только stage 0 (Task 10, тест «финал фразу не получает»); «первичный» = нет карты типа салона (Task 1 `pickSalonCard`); порог 100 в настройках (Task 4/5/12); фразы пишет салон (Task 8 — шаблоны, промпт не тронут); 7 дней + раз за переписку (Task 10 `recentBonusSent`, `alreadyMentioned`); классы choice/price (Task 7).
- Чтение баланса с трёхзначным результатом, строгие карты, живой поиск — Task 1–2.
- Рефакторинг `reminders/bonus.js` — Task 3.
- Схема — Task 4; настройки — Task 5; `loadTurn` — Task 6; `anchor_turn_id` в очереди и диспетчере — Task 9; воркер, LEASE_SQL, захват, лог — Task 10; EXPLAIN — Task 11; фронт с бампом `?v=` — Task 12; e2e — Task 13; документация — Task 14.
- Имена согласованы: `readCardBalance(salon, phone, deps)` → `{status, balance, cardId}`; `classifySituation({events, ownText})` → `{kind, bonusOk}`; `lastOwnReply(messages)`; `chooseBonusLine({situation, card, settings, alreadyMentioned, recentlySent, nudgeText, render})` → `{kind, text, balance?}`; deps воркера `readCardBalance(salonId, phone)`, `loadTurnEvents(turnId)`, `recentBonusSent(salonId, phone)`; настройки `followupBonusText`/`followupWelcomeText`/`followupBonusMinBalance`; колонки `followup_bonus_text`/`followup_welcome_text`/`followup_bonus_min_balance`, `anchor_turn_id`/`bonus_kind`/`bonus_balance`.
