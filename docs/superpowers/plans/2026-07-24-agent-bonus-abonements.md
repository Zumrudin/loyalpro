# Мила: бонусный баланс (карта samosale) и абонементы из YClients — план внедрения

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Два новых инструмента агента — `get_bonus_balance` (баланс бонусной карты клиента напрямую из YClients) и `get_client_abonements` (активные абонементы с остатком посещений), плюс сценарий в системном промпте.

**Architecture:** Инструменты по образцу `get_client_visit_history`: без аргументов, телефон берётся только из `ctx.clientPhone` (подтверждённый каналом номер) — PII-гейт «по построению»: чужой номер продиктовать нельзя. Для бонусов используется существующая обёртка `ycGetClientCards`, для абонементов добавляется новая `ycGetClientAbonements`.

**Tech Stack:** Node.js/Express, jest (юнит-тесты в `backend/*.test.js`), YClients REST API.

---

## Проверенные факты (live-probe 2026-07-24, салон PERI CLINIC, тестовый клиент Зумрудин 79200255591)

**Бонусы.** `GET /loyalty/client_cards/{yc_client_id}` (заголовок `Authorization: Bearer <partner>, User <user>`) возвращает карты клиента:

```json
{"success":true,"data":[{"id":112435557,"balance":22750,"number":"8844205",
  "type":{"id":59301,"title":"samosale"},"salon_group":{"id":652414,"title":"Сеть Peri Clinic"}}]}
```

«samosale» — это название типа карты лояльности (`type.title`), баланс — в `balance`. Обёртка уже есть: `ycGetClientCards(salon, ycClientId)` в `services/yclients.js:96` (при ошибке возвращает `[]`, не бросает).

**Абонементы.** `GET /loyalty/abonements/?company_id={company_id}&phone={phone}` (телефон в формате `79XXXXXXXXX`, параметр называется именно `phone` — `client_phone`/`client_id` дают 400 «Не указан номер телефона»). Возвращает массив:

```json
{"id":17442662,"number":"611197","is_frozen":false,"expiration_date":null,
 "status":{"id":1,"slug":"created","title":"Выпущен"},
 "is_united_balance":true,"is_united_balance_unlimited":false,
 "united_balance_services_count":10,
 "balance_container":{"links":[{"count":0,"service":{"title":"BEAUTYLISER RSL скульптурирование"}}]},
 "type":{"title":"BEAUTYLISER/ RSL Скульптурирование 10","expiration_type_title":"При первом посещении"}}
```

Остаток посещений: при `is_united_balance:true` — `united_balance_services_count` (в `links[].count` при этом нули!); при `is_united_balance:false` — сумма `links[].count`; при `is_united_balance_unlimited:true` — безлимит. `expiration_date:null` у неактивированных («Выпущен», активация при первом визите). Обёртки в коде нет — добавляем.

**`yclients_client_id`** есть прямо в таблице `clients` (заполняется loyalty-синком; комментарий в `identity.js:27` «в таблице clients его нет» устарел). Основной lookup — из `clients`, fallback — `identity.resolveYclientsClientId` (по `records`).

---

### Task 1: Обёртка `ycGetClientAbonements` в services/yclients.js

**Files:**
- Modify: `backend/services/yclients.js` (после `ycGetClientCards`, ~строка 113; экспорт ~строка 355)
- Test: `backend/yclients-loyalty.test.js` (новый)

- [x] **Step 1: Написать падающий тест**

Создать `backend/yclients-loyalty.test.js`:

```js
'use strict';

jest.mock('axios', () => ({ get: jest.fn(), post: jest.fn() }));
jest.mock('./logger', () => ({
  createLogger: () => ({ info: jest.fn(), error: jest.fn(), warn: jest.fn() }),
}));
const axios = require('axios');
const { ycGetClientAbonements } = require('./services/yclients');

describe('ycGetClientAbonements', () => {
  beforeEach(() => jest.clearAllMocks());
  const salon = { yclients_company_id: '668791',
    yclients_partner_token: 'pt', yclients_user_token: 'ut' };

  test('зовёт /loyalty/abonements/ с company_id и phone', async () => {
    axios.get.mockResolvedValue({ data: { success: true, data: [{ id: 1 }] } });
    const out = await ycGetClientAbonements(salon, '79200255591');
    expect(out).toEqual([{ id: 1 }]);
    const url = axios.get.mock.calls[0][0];
    expect(url).toContain('/loyalty/abonements/');
    expect(url).toContain('company_id=668791');
    expect(url).toContain('phone=79200255591');
  });

  test('ошибка YClients разворачивается в message (ycError)', async () => {
    axios.get.mockRejectedValue({ response: { status: 400,
      data: { meta: { message: 'Не указан номер телефона' } } } });
    await expect(ycGetClientAbonements(salon, ''))
      .rejects.toThrow('Не указан номер телефона');
  });
});
```

- [x] **Step 2: Убедиться, что тест падает**

Run: `cd /root/loyalpro/backend && npx jest yclients-loyalty -t abonements`
Expected: FAIL — `ycGetClientAbonements is not a function`.

- [x] **Step 3: Реализация**

В `backend/services/yclients.js` после функции `ycGetClientCards` (после строки 113) добавить:

```js
// Абонементы клиента по номеру телефона (формат «79XXXXXXXXX», как в вебхуке).
// ВАЖНО: параметр называется именно phone — client_phone/client_id дают 400.
// Остаток посещений: is_united_balance → united_balance_services_count
// (links[].count при этом нули), иначе — сумма balance_container.links[].count.
async function ycGetClientAbonements(salon, phone) {
  return ycGet(salon, '/loyalty/abonements/', {
    company_id: salon.yclients_company_id,
    phone,
  });
}
```

В `module.exports` (~строка 355) добавить `ycGetClientAbonements`.

- [x] **Step 4: Тест зелёный**

Run: `npx jest yclients-loyalty`
Expected: PASS (2 теста).

- [x] **Step 5: Commit**

```bash
cd /root/loyalpro
git add backend/services/yclients.js backend/yclients-loyalty.test.js
git commit -m "feat(yclients): ycGetClientAbonements — абонементы клиента по телефону"
```

---

### Task 2: Инструмент `get_bonus_balance`

**Files:**
- Create: `backend/services/agent/tools/get-bonus-balance.js`
- Test: `backend/agent-tools.test.js`

- [x] **Step 1: Подготовить моки в agent-tools.test.js**

Строка 5, заменить:

```js
jest.mock('./services/yclients', () => ({ ycGet: jest.fn(), ycGetServiceCatalog: jest.fn(), ycGetServiceMeta: jest.fn() }));
```

на:

```js
jest.mock('./services/yclients', () => ({
  ycGet: jest.fn(), ycGetServiceCatalog: jest.fn(), ycGetServiceMeta: jest.fn(),
  ycGetClientCards: jest.fn(), ycGetClientAbonements: jest.fn(),
}));
```

Строка 22, заменить:

```js
const { ycGet, ycGetServiceCatalog, ycGetServiceMeta } = require('./services/yclients');
```

на:

```js
const { ycGet, ycGetServiceCatalog, ycGetServiceMeta,
  ycGetClientCards, ycGetClientAbonements } = require('./services/yclients');
```

После строки 53 (`const rescheduleBooking = …`) добавить:

```js
const bonusBalance = require('./services/agent/tools/get-bonus-balance');
const clientAbonements = require('./services/agent/tools/get-client-abonements');
```

(Второй require упадёт до Task 3 — при прогоне только этого таска временно закомментировать его либо сразу создать пустой файл-заглушку `module.exports = { schema: { name: 'get_client_abonements', input_schema: { type: 'object', properties: {} } }, run: async () => ({}) };` — Task 3 её заменит.)

- [x] **Step 2: Написать падающие тесты**

Перед `describe('реестр инструментов', …)` (строка 651) добавить:

```js
describe('get_bonus_balance', () => {
  const CTX = { clientPhone: '79200255591' };

  test('schema без аргументов', () => {
    expect(bonusBalance.schema.name).toBe('get_bonus_balance');
    expect(Object.keys(bonusBalance.schema.input_schema.properties)).toHaveLength(0);
  });

  test('счастливый путь: карта samosale с балансом', async () => {
    db.oneOrNone.mockResolvedValue({ yclients_client_id: '134014107' });
    db.one.mockResolvedValue({ id: 1, yclients_company_id: '668791',
      yclients_partner_token: 'pt', yclients_user_token: 'ut' });
    ycGetClientCards.mockResolvedValue([{ id: 112435557, balance: 22750,
      number: '8844205', type: { title: 'samosale' } }]);
    const out = await bonusBalance.run(1, {}, CTX);
    expect(ycGetClientCards).toHaveBeenCalledWith(
      expect.objectContaining({ id: 1 }), 134014107);
    expect(out.found).toBe(true);
    expect(out.cards).toEqual([{ program: 'samosale', number: '8844205', balance: 22750 }]);
  });

  test('PII-гейт по построению: телефон ТОЛЬКО из ctx, аргументы игнорируются', async () => {
    const out = await bonusBalance.run(1, { phone: '79991234567' }, {});
    expect(out.found).toBe(false);
    expect(out.reason).toBe('no_phone');
    expect(db.oneOrNone).not.toHaveBeenCalled();
  });

  test('нет yclients_client_id в clients → fallback на identity', async () => {
    db.oneOrNone.mockResolvedValue(null);
    identity.resolveYclientsClientId.mockResolvedValue(555);
    db.one.mockResolvedValue({ id: 1, yclients_company_id: '668791' });
    ycGetClientCards.mockResolvedValue([{ balance: 100, number: '1',
      type: { title: 'samosale' } }]);
    const out = await bonusBalance.run(1, {}, CTX);
    expect(identity.resolveYclientsClientId).toHaveBeenCalledWith(1, '79200255591');
    expect(out.found).toBe(true);
  });

  test('клиент не найден нигде → client_not_found', async () => {
    db.oneOrNone.mockResolvedValue(null);
    identity.resolveYclientsClientId.mockResolvedValue(null);
    const out = await bonusBalance.run(1, {}, CTX);
    expect(out.found).toBe(false);
    expect(out.reason).toBe('client_not_found');
  });

  test('карт нет (или YClients упал → пустой массив) → no_card', async () => {
    db.oneOrNone.mockResolvedValue({ yclients_client_id: '134014107' });
    db.one.mockResolvedValue({ id: 1, yclients_company_id: '668791' });
    ycGetClientCards.mockResolvedValue([]);
    const out = await bonusBalance.run(1, {}, CTX);
    expect(out.found).toBe(false);
    expect(out.reason).toBe('no_card');
  });
});
```

- [x] **Step 3: Убедиться, что тесты падают**

Run: `npx jest agent-tools -t get_bonus_balance`
Expected: FAIL — `Cannot find module './services/agent/tools/get-bonus-balance'`.

- [x] **Step 4: Реализация**

Создать `backend/services/agent/tools/get-bonus-balance.js`:

```js
'use strict';

const { db } = require('../../../db');
const identity = require('../identity');
const { normalizePhoneKey } = require('../../agent-gate');
const { ycGetClientCards } = require('../../yclients');

const schema = {
  name: 'get_bonus_balance',
  description: 'Текущий баланс бонусной карты пациента (карта лояльности в YClients). ' +
    'Телефон берётся из системы автоматически — данные ТОЛЬКО самого собеседника, ' +
    'аргументы не нужны. Возвращает карты: программа, номер, баланс в бонусах. ' +
    'Зови, когда пациент спрашивает свой баланс/бонусы. Данные живые — не отвечай по памяти.',
  input_schema: { type: 'object', properties: {}, additionalProperties: false },
};

async function run(salonId, _input, ctx = {}) {
  // Телефон — только подтверждённый каналом номер собеседника (ctx.clientPhone).
  // Аргументов у инструмента нет намеренно: «пробить» чужой номер невозможно.
  const phone = normalizePhoneKey(String((ctx && ctx.clientPhone) || ''));
  if (!phone || phone.length < 10) {
    return { found: false, reason: 'no_phone',
      note: 'Номер пациента системе неизвестен — баланс сообщить нельзя.' };
  }
  // yclients_client_id уже лежит в карточке клиента (loyalty-синк);
  // резолв по records — запасной путь.
  const row = await db.oneOrNone(
    `SELECT yclients_client_id FROM clients
      WHERE salon_id = $1 AND phone LIKE '%' || $2
      LIMIT 1`, [salonId, phone]);
  let ycClientId = row && row.yclients_client_id ? Number(row.yclients_client_id) : null;
  if (!ycClientId) ycClientId = await identity.resolveYclientsClientId(salonId, phone);
  if (!ycClientId) {
    return { found: false, reason: 'client_not_found',
      note: 'Карта пациента в системе не найдена.' };
  }
  const salon = await db.one(
    `SELECT id, yclients_company_id, yclients_partner_token, yclients_user_token
       FROM salons WHERE id=$1`, [salonId]);
  if (!salon.yclients_company_id) return { found: false, reason: 'no_yclients' };

  const cards = await ycGetClientCards(salon, ycClientId); // при ошибке YClients → []
  if (!Array.isArray(cards) || cards.length === 0) {
    return { found: false, reason: 'no_card',
      note: 'Бонусная карта не найдена — предложи уточнить у администратора.' };
  }
  return { found: true, cards: cards.map(c => ({
    program: (c.type && c.type.title) || null,
    number: c.number || null,
    balance: Number(c.balance) || 0,
  })) };
}

module.exports = { schema, run };
```

- [x] **Step 5: Тесты зелёные**

Run: `npx jest agent-tools -t get_bonus_balance`
Expected: PASS (6 тестов).

- [x] **Step 6: Commit**

```bash
git add backend/services/agent/tools/get-bonus-balance.js backend/agent-tools.test.js
git commit -m "feat(agent): get_bonus_balance — баланс бонусной карты из YClients (карта samosale)"
```

---

### Task 3: Инструмент `get_client_abonements`

**Files:**
- Create: `backend/services/agent/tools/get-client-abonements.js` (замена заглушки из Task 2, если делалась)
- Test: `backend/agent-tools.test.js`

- [x] **Step 1: Написать падающие тесты**

В `agent-tools.test.js` после describe `get_bonus_balance` добавить:

```js
describe('get_client_abonements', () => {
  const CTX = { clientPhone: '79200255591',
    nowMs: Date.parse('2026-07-24T12:00:00+03:00') };
  const salonRow = { id: 1, yclients_company_id: '668791',
    yclients_partner_token: 'pt', yclients_user_token: 'ut' };

  test('schema без аргументов', () => {
    expect(clientAbonements.schema.name).toBe('get_client_abonements');
    expect(Object.keys(clientAbonements.schema.input_schema.properties)).toHaveLength(0);
  });

  test('единый баланс: остаток из united_balance_services_count (links.count нулевые)', async () => {
    db.one.mockResolvedValue(salonRow);
    ycGetClientAbonements.mockResolvedValue([{
      is_united_balance: true, united_balance_services_count: 7,
      is_frozen: false, expiration_date: null,
      status: { title: 'Выпущен', extended_title: 'Выпущен' },
      type: { title: 'RSL Скульптурирование 10' },
      balance_container: { links: [{ count: 0, service: { title: 'BEAUTYLISER RSL' } }] },
    }]);
    const out = await clientAbonements.run(1, {}, CTX);
    expect(ycGetClientAbonements).toHaveBeenCalledWith(
      expect.objectContaining({ id: 1 }), '79200255591');
    expect(out.abonements).toHaveLength(1);
    expect(out.abonements[0].visits_left).toBe(7);
    expect(out.abonements[0].title).toBe('RSL Скульптурирование 10');
    expect(out.abonements[0].status).toBe('Выпущен');
  });

  test('раздельный баланс: остаток — сумма links[].count', async () => {
    db.one.mockResolvedValue(salonRow);
    ycGetClientAbonements.mockResolvedValue([{
      is_united_balance: false,
      status: { title: 'Активен' }, type: { title: 'Массаж 5+3' },
      balance_container: { links: [
        { count: 2, service: { title: 'Массаж спины' } },
        { count: 3, service: { title: 'Массаж лица' } },
      ] },
    }]);
    const out = await clientAbonements.run(1, {}, CTX);
    expect(out.abonements[0].visits_left).toBe(5);
    expect(out.abonements[0].services).toEqual(['Массаж спины', 'Массаж лица']);
  });

  test('исхоженные (остаток 0) и истёкшие скрываются', async () => {
    db.one.mockResolvedValue(salonRow);
    ycGetClientAbonements.mockResolvedValue([
      { is_united_balance: true, united_balance_services_count: 0,
        status: {}, type: { title: 'Пустой' }, balance_container: { links: [] } },
      { is_united_balance: true, united_balance_services_count: 4,
        expiration_date: '2026-01-01T00:00:00+03:00',
        status: {}, type: { title: 'Истёкший' }, balance_container: { links: [] } },
    ]);
    const out = await clientAbonements.run(1, {}, CTX);
    expect(out.abonements).toEqual([]);
    expect(out.note).toContain('не найдено');
  });

  test('безлимитный не скрывается, visits_left = «безлимит»', async () => {
    db.one.mockResolvedValue(salonRow);
    ycGetClientAbonements.mockResolvedValue([{
      is_united_balance: true, is_united_balance_unlimited: true,
      status: {}, type: { title: 'Безлимит' }, balance_container: { links: [] } }]);
    const out = await clientAbonements.run(1, {}, CTX);
    expect(out.abonements[0].visits_left).toBe('безлимит');
  });

  test('телефон неизвестен → no_phone, YClients не зовём (аргументы игнорируются)', async () => {
    const out = await clientAbonements.run(1, { phone: '79991234567' }, {});
    expect(out.reason).toBe('no_phone');
    expect(ycGetClientAbonements).not.toHaveBeenCalled();
  });

  test('ошибка YClients → мягкий error без исключения', async () => {
    db.one.mockResolvedValue(salonRow);
    ycGetClientAbonements.mockRejectedValue(new Error('boom'));
    const out = await clientAbonements.run(1, {}, CTX);
    expect(out.abonements).toEqual([]);
    expect(out.error).toContain('boom');
  });
});
```

- [x] **Step 2: Убедиться, что тесты падают**

Run: `npx jest agent-tools -t get_client_abonements`
Expected: FAIL (модуль-заглушка/отсутствует).

- [x] **Step 3: Реализация**

Создать `backend/services/agent/tools/get-client-abonements.js`:

```js
'use strict';

const { db } = require('../../../db');
const { normalizePhoneKey } = require('../../agent-gate');
const { ycGetClientAbonements } = require('../../yclients');

const MAX_ABONEMENTS = 10;

const schema = {
  name: 'get_client_abonements',
  description: 'Активные абонементы пациента из YClients: название, остаток посещений, ' +
    'срок действия, статус (заморожен/не активирован). Телефон берётся из системы ' +
    'автоматически — данные ТОЛЬКО самого собеседника, аргументы не нужны. Зови, когда ' +
    'пациент спрашивает про свой абонемент или сколько посещений осталось. ' +
    'Данные живые — не отвечай по памяти.',
  input_schema: { type: 'object', properties: {}, additionalProperties: false },
};

async function run(salonId, _input, ctx = {}) {
  // Телефон — только подтверждённый каналом номер собеседника (см. get-bonus-balance).
  const phone = normalizePhoneKey(String((ctx && ctx.clientPhone) || ''));
  if (!phone || phone.length < 10) {
    return { abonements: [], reason: 'no_phone',
      note: 'Номер пациента системе неизвестен — абонементы посмотреть нельзя.' };
  }
  const salon = await db.one(
    `SELECT id, yclients_company_id, yclients_partner_token, yclients_user_token
       FROM salons WHERE id=$1`, [salonId]);
  if (!salon.yclients_company_id) return { abonements: [], reason: 'no_yclients' };

  let list;
  try { list = await ycGetClientAbonements(salon, phone); }
  catch (e) { return { abonements: [], error: `Не удалось получить абонементы: ${e.message}` }; }

  const nowMs = (ctx && ctx.nowMs) || Date.now();
  const abonements = (Array.isArray(list) ? list : [])
    .map(a => {
      const links = (a.balance_container && Array.isArray(a.balance_container.links))
        ? a.balance_container.links : [];
      const unlimited = !!a.is_united_balance_unlimited;
      // Единый баланс: остаток в united_balance_services_count (links[].count — нули).
      // Раздельный: остаток — сумма links[].count.
      const visitsLeft = a.is_united_balance
        ? (unlimited ? null : Number(a.united_balance_services_count) || 0)
        : links.reduce((s, l) => s + (Number(l.count) || 0), 0);
      return {
        title: (a.type && a.type.title) || a.balance_string || 'Абонемент',
        status: (a.status && (a.status.extended_title || a.status.title)) || null,
        is_frozen: !!a.is_frozen,
        expires: a.expiration_date || null, // null у неактивированных («Выпущен»)
        visits_left: unlimited ? 'безлимит' : visitsLeft,
        services: links.map(l =>
          (l.service && l.service.title) || (l.category && l.category.title)).filter(Boolean),
      };
    })
    .filter(x => x.visits_left === 'безлимит' || x.visits_left > 0)
    .filter(x => !x.expires || Date.parse(x.expires) >= nowMs)
    .slice(0, MAX_ABONEMENTS);

  if (!abonements.length) {
    return { abonements: [], note: 'Активных абонементов не найдено.' };
  }
  return { abonements };
}

module.exports = { schema, run };
```

- [x] **Step 4: Тесты зелёные**

Run: `npx jest agent-tools -t get_client_abonements`
Expected: PASS (7 тестов).

- [x] **Step 5: Commit**

```bash
git add backend/services/agent/tools/get-client-abonements.js backend/agent-tools.test.js
git commit -m "feat(agent): get_client_abonements — абонементы с остатком посещений из YClients"
```

---

### Task 4: Регистрация в реестре инструментов

**Files:**
- Modify: `backend/services/agent/tools/index.js`
- Test: `backend/agent-tools.test.js` (describe «реестр инструментов», строки 651–664)

- [x] **Step 1: Дополнить тест реестра**

В `describe('реестр инструментов')` добавить в существующий тест:

```js
    expect(names).toContain('get_bonus_balance');
    expect(names).toContain('get_client_abonements');
    expect(typeof registry.handlers.get_bonus_balance).toBe('function');
    expect(typeof registry.handlers.get_client_abonements).toBe('function');
```

- [x] **Step 2: Убедиться, что тест падает**

Run: `npx jest agent-tools -t "реестр"`
Expected: FAIL — `names` не содержит `get_bonus_balance`.

- [x] **Step 3: Зарегистрировать**

В `backend/services/agent/tools/index.js`: после строки 17 (`const modifySvc = …`) добавить:

```js
const bonusBal  = require('./get-bonus-balance');
const abonement = require('./get-client-abonements');
```

Массив `tools` (строки 19–20) заменить на:

```js
const tools = [searchKb, listSvc, listStaff, getSlots, getParSlot, getDates, getClient,
  createBk, listBookings, visitHistory, cancelBk, reschedBk, modifySvc,
  bonusBal, abonement, escalate];
```

- [x] **Step 4: Тест зелёный**

Run: `npx jest agent-tools -t "реестр"`
Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add backend/services/agent/tools/index.js backend/agent-tools.test.js
git commit -m "feat(agent): регистрация get_bonus_balance и get_client_abonements в реестре"
```

---

### Task 5: Системный промпт — Сценарий 5 «Бонусы и абонементы»

ВАЖНО (память `feedback_agent_prompt_test_guarded`): промпт защищён тестами — не срезать существующие блоки, номера «Сценарий 1–4» не менять (на них есть перекрёстные ссылки). Новый блок — СЦЕНАРИЙ 5, после Сценария 4.

**Files:**
- Modify: `backend/services/agent/system-prompt.js`
- Test: `backend/agent-system-prompt.test.js`

- [x] **Step 1: Написать падающие тесты**

В конец `backend/agent-system-prompt.test.js` (внутрь `describe('buildSystemPrompt')`) добавить:

```js
  test('сценарий 5: бонусы и абонементы только через инструменты', () => {
    const p = buildSystemPrompt();
    expect(p).toContain('СЦЕНАРИЙ 5');
    expect(p).toContain('get_bonus_balance');
    expect(p).toContain('get_client_abonements');
  });

  test('сценарий 5: по продиктованному номеру личные данные не выдаются', () => {
    const p = buildSystemPrompt();
    expect(p).toContain('по продиктованному номеру');
  });

  test('правило 8: личный баланс — исключение из KB-only', () => {
    const p = buildSystemPrompt();
    expect(p).toMatch(/Исключение — ЛИЧНЫЙ баланс/);
  });
```

- [x] **Step 2: Убедиться, что тесты падают**

Run: `npx jest agent-system-prompt`
Expected: FAIL (3 новых теста).

- [x] **Step 3: Правки промпта**

В `backend/services/agent/system-prompt.js` правило 8 (строка 84) — заменить строку:

```js
    `8. О программе лояльности, акциях, скидках, оплате, документах и любых фактах о клинике НЕ утверждай по памяти. Сначала вызови search_knowledge_base; если ответа в базе нет (found:false) — не выдумывай, а предложи соединить с администратором.`,
```

на:

```js
    `8. О программе лояльности, акциях, скидках, оплате, документах и любых фактах о клинике НЕ утверждай по памяти. Сначала вызови search_knowledge_base; если ответа в базе нет (found:false) — не выдумывай, а предложи соединить с администратором. Исключение — ЛИЧНЫЙ баланс бонусов и абонементы пациента: это живые данные, бери их инструментами get_bonus_balance и get_client_abonements (СЦЕНАРИЙ 5); условия самой программы (курс списания, сгорание) — по-прежнему только из базы знаний.`,
```

После блока Сценария 4 — то есть после строки

```js
    `Тогда вызови escalate_to_operator и явно объяви о переводе: «Передаю ваш диалог администратору клиники — он подключится с минуты на минуту и поможет вам лично 🤍». Больше ничего не пиши.`,
```

и перед `...(resumed ? [` — вставить:

```js
    ``,
    `СЦЕНАРИЙ 5 — Бонусы и абонементы (личные данные пациента):`,
    `Баланс бонусов и абонементы — ЖИВЫЕ данные. НИКОГДА не называй баланс или остаток посещений по памяти или из прошлых сообщений диалога — только из свежего вызова инструмента.`,
    `«Сколько у меня бонусов / какой баланс на карте?» — вызови get_bonus_balance и назови текущий баланс (например: «На вашей бонусной карте 22 750 бонусов 🤍»). Про курс списания, сгорание и правила программы не рассуждай — это только из search_knowledge_base (правило 8).`,
    `«Какие у меня абонементы / сколько посещений осталось?» — вызови get_client_abonements и назови по каждому: название, остаток посещений (visits_left; «безлимит» так и называй) и срок действия (expires), если он задан. Если is_frozen:true — скажи, что абонемент заморожен. Если статус «Выпущен» и expires пуст — мягко поясни, что абонемент начнёт действовать с первого визита.`,
    `Эти данные доступны ТОЛЬКО самому пациенту, чей номер подтверждён системой (см. «ИДЕНТИФИКАЦИЯ ПАЦИЕНТА»). Если номер пациента системе НЕИЗВЕСТЕН — НЕ проси продиктовать номер ради баланса: по продиктованному номеру личные данные не выдаются (защита пациентов). Мягко предложи посмотреть баланс в мобильном приложении клиники или соединить с администратором. По чужому номеру баланс и абонементы НЕ сообщай никогда.`,
    `Если инструмент вернул found:false, пустой список или error — не выдумывай цифры: скажи, что не видишь карту/абонементы, и предложи уточнить у администратора.`,
```

- [x] **Step 4: Все промпт-тесты зелёные (включая старые!)**

Run: `npx jest agent-system-prompt`
Expected: PASS, ноль упавших старых тестов.

- [x] **Step 5: Commit**

```bash
git add backend/services/agent/system-prompt.js backend/agent-system-prompt.test.js
git commit -m "feat(agent): сценарий 5 — бонусы и абонементы, carve-out из KB-only правила 8"
```

---

### Task 6: Полный прогон и живой smoke

- [x] **Step 1: Все агентские тесты**

Run: `cd /root/loyalpro/backend && npx jest agent-tools agent-system-prompt agent-gate agent-identity yclients-loyalty`
Expected: PASS все сьюты.

- [x] **Step 2: Перезапустить dev-сервер**

Run: `pm2 restart loyalpro --update-env && sleep 2 && pm2 logs loyalpro --lines 15 --nostream`
Expected: старт без ошибок.

- [x] **Step 3: Живой smoke с тестового номера**

Очистить историю тестового диалога — skill `clear-history` (номер 79200255591). Затем с тестового WhatsApp-номера отправить: «Сколько у меня бонусов на карте?» и «Сколько посещений осталось на моём абонементе?».
Expected: Мила зовёт `get_bonus_balance` → называет 22 750 бонусов (сверить с YClients); зовёт `get_client_abonements` → называет «BEAUTYLISER/ RSL Скульптурирование 10», остаток 10 посещений, поясняет активацию с первого визита. Проверить в логах `pm2 logs loyalpro`, что инструменты вызвались и не было 4xx.

- [x] **Step 4: Финальный commit (если были правки по итогам smoke)**

```bash
git add -A && git commit -m "fix(agent): правки по итогам живого smoke бонусов/абонементов"
```

---

## Ограничения и осознанные решения

- **PII-гейт по построению:** оба инструмента без аргументов — телефон только из `ctx.clientPhone` (подтверждён каналом). «Пробить» чужой номер через аргумент невозможно; промпт дополнительно запрещает выдавать данные по продиктованному номеру (каналы без телефона: Telegram Bot/MAX).
- **`ycGetClientCards` глотает ошибки** (возвращает `[]`) — инструмент не отличает «нет карты» от «YClients упал»; в обоих случаях мягкий `no_card` с предложением администратора. Приемлемо; при желании — follow-up на проброс ошибки.
- **Фильтрация абонементов:** скрываем остаток 0 и истёкшие по `expiration_date`; замороженные и неактивированные («Выпущен», `expiration_date:null`) показываем со статусом — Мила поясняет словами.
- **`united_balance_services_count` считаем текущим остатком** (не стартовым номиналом типа): проверено на живом абонементе, где значение совпадает с номиналом при нуле визитов; после первого списания перепроверить на smoke (Task 6) — если YClients держит там номинал, остаток придётся считать иначе (номинал минус визиты) — это единственный неподтверждённый край.
- **Комментарий в `identity.js:27`** («в таблице clients его нет») устарел — колонка `clients.yclients_client_id` существует и заполнена; можно поправить комментарий попутно в Task 2.
