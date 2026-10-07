# Мила: консультативные продажи — план реализации (v2, переписан 07.10.2026)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Мила после цены называет один проверенный факт об услуге и предлагает шаг, разбирает «дорого / подумаю / не знаю, что выбрать» по коротким сценарным модулям, а напоминание о себе получает те же факты и гаснет, если клиента уже записали в CRM.

**Architecture:** Никакого второго LLM-прохода. Момент определяет существующий детерминированный детектор `prompt-scenarios.js` (регэксп по последнему сообщению), текст навыка — модули по 3–5 строк в новом чистом `sales-modules.js`, подключаемые кодом в v2 (`MODULES`) и хвостовым блоком в v1. Факты подаёт код: предвызов базы знаний на вопросе о цене (паттерн `promo-interest`), справка едет в хвост промпта и в промпт напоминания. Поведение меряется телеметрией reply-guard (только лог), гасится флагами, живьём проверяется пробником.

**Tech Stack:** Node.js, Jest (`cd backend && npx jest <имя без .test.js>`), PostgreSQL через `db`, YClients/Chatpush без изменений.

**Откуда план:** первая версия (Codex, 07.10) предлагала отдельный LLM-роутер и реестр `sales-skills/*`; после разбора (см. память `mila_consultative_sales_plan_review`) роутер снят, остальное переписано под существующие механизмы. Исходные данные — `docs/2026-10-02-mila-sales-funnel-analysis.md`: главные потери «цена → тишина» (8 из 12) и «вопрос вместо предложения» (8 диалогов).

---

## Границы (что НЕ делаем)

- Не добавляем LLM-роутер, не создаём `sales-router/sales-context/sales-policy`.
- Не даём инструментов проходу напоминания; слоты в напоминании не ищем.
- Не трогаем stage 1 (финальный шаблон салона), интервалы, окно расписания, бонусную строку (`followup-bonus.js`) — она остаётся кодовой.
- Не меняем `create_booking`/`reschedule_booking` и их гейты.
- Ни одно новое правило в кэшируемом префиксе v1, кроме правки существующего правила о цене (Task 1, шаг 8). Примеры с временем `ЧЧ:ММ` в модулях запрещены (тест).

## Карта файлов

| Файл | Роль |
|---|---|
| `backend/services/agent/prompt-scenarios.js` (modify) | +2 сценария: `objection`, `undecided` |
| `backend/services/agent/sales-modules.js` (create) | чистый: тексты модулей, `PRICE_FOLLOWTHROUGH`, `renderSalesTail` |
| `backend/services/agent/system-prompt-v2.js` (modify) | модули в `MODULES`, хвост без дубля |
| `backend/services/agent/system-prompt.js` (modify) | блоки «СПРАВКА ОБ УСЛУГЕ» и «СЦЕНАРИЙ ЭТОГО СООБЩЕНИЯ» в хвосте, правка правила о цене |
| `backend/services/agent/service-fact.js` (create) | чистый: нужен ли предвызов КБ, запрос, отбор релевантного чанка без `ЧЧ:ММ` |
| `backend/services/agent/orchestrator.js` (modify) | предвызов КБ, передача блоков в промпт, телеметрия сценариев и двух новых проверок |
| `backend/services/agent/reply-guard.js` (modify) | `checkPriceWithoutNextStep`, `checkQuestionInsteadOfOffer` (мягкие, только лог) |
| `backend/config.js` (modify) | `AGENT_SALES_MODULES`, `AGENT_SERVICE_FACT_PREFETCH`, `OPS_ALERT_TELEGRAM_*` |
| `backend/services/agent/followup-queue.js` (modify) | `closeByPhone` |
| `backend/routes/webhook.js` (modify) | гашение ожидания при создании записи в CRM |
| `backend/services/agent/followup-worker.js` (modify) | гейт `bookedSinceAnchor`, справка об услуге в stage 0 |
| `backend/services/agent/followup-prompt.js` (modify) | блок справки + правка правила 2 |
| `backend/services/ops-alert.js` (create) | алерт в Telegram с rate-limit |
| `backend/services/agent/dispatcher.js` (modify) | алерт на 402 провайдера |
| `backend/scripts/agent-sales-probe.js` (create) | живой пробник (реальный LLM, отправка застаблена) |
| `CLAUDE.md` (modify) | раздел о фиче |

Тесты: `agent-prompt-scenarios.test.js`, `agent-sales-modules.test.js` (new), `agent-system-prompt-v2.test.js`, `agent-system-prompt.test.js`, `agent-service-fact.test.js` (new), `agent-reply-guard.test.js`, `agent-followup-queue.test.js`, `agent-followup-worker.test.js`, `agent-followup-prompt.test.js`, `ops-alert.test.js` (new).

---

### Task 1: Сценарии `objection`/`undecided` и модули продаж (v1 + v2)

**Files:**
- Modify: `backend/services/agent/prompt-scenarios.js`
- Create: `backend/services/agent/sales-modules.js`
- Modify: `backend/services/agent/system-prompt-v2.js:21-32,40-70`
- Modify: `backend/services/agent/system-prompt.js:285,609-617`
- Test: `backend/agent-prompt-scenarios.test.js`, `backend/agent-sales-modules.test.js`, `backend/agent-system-prompt-v2.test.js`, `backend/agent-system-prompt.test.js`

- [ ] **Step 1: Тест детектора на новые сценарии**

Добавить в `backend/agent-prompt-scenarios.test.js` внутрь `describe('detectPromptScenarios')`:

```js
  test('сомнение и нерешительность — отдельные сценарии', () => {
    expect(detectPromptScenarios('Дорого как-то, подумаю')).toEqual([SCENARIOS.OBJECTION]);
    expect(detectPromptScenarios('Спасибо, напишу сама')).toEqual([SCENARIOS.OBJECTION]);
    expect(detectPromptScenarios('Пока сравниваю с другой клиникой')).toEqual([SCENARIOS.OBJECTION]);
    expect(detectPromptScenarios('Не знаю, что выбрать, хочу выглядеть свежее'))
      .toEqual([SCENARIOS.UNDECIDED]);
    expect(detectPromptScenarios('Посоветуйте, что подойдёт для лица'))
      .toEqual([SCENARIOS.UNDECIDED]);
  });

  test('«дорого, но запишите» несёт и сомнение, и запись — приоритет решает модуль', () => {
    expect(detectPromptScenarios('Дорого, но меня устраивает — запишите на пятницу'))
      .toEqual([SCENARIOS.BOOKING, SCENARIOS.OBJECTION]);
  });

  test('«доброе утро» и «подготовка» не считаются сомнением', () => {
    expect(detectPromptScenarios('Доброе утро! Подскажите адрес')).toEqual([SCENARIOS.CLINIC]);
    expect(detectPromptScenarios('Какая подготовка нужна?')).toEqual([SCENARIOS.MEDICAL]);
  });
```

- [ ] **Step 2: Запустить — должен упасть**

Run: `cd backend && npx jest agent-prompt-scenarios`
Expected: FAIL — `SCENARIOS.OBJECTION` is `undefined`.

- [ ] **Step 3: Добавить сценарии в `prompt-scenarios.js`**

В `SCENARIOS` после `GENERAL`:

```js
  OBJECTION: 'objection',
  UNDECIDED: 'undecided',
```

В `RULES` после строки `CLINIC` (порядок в массиве = порядок в выдаче; BOOKING стоит раньше, поэтому «дорого, но запишите» даёт `[booking, objection]`):

```js
  // Сомнение/откладывание: «дорого», «подумаю», «сравниваю», «напишу сама».
  // Ложное срабатывание даёт лишний модуль-инструкцию, а не действие, поэтому
  // регэксп, а не LLM-роутер (решение 07.10.2026). Границы — lookaround по
  // \p{L}: «\b» в JS ASCII-only.
  [SCENARIOS.OBJECTION, /(?<![\p{L}])(?:дорог(?:о|овато)|подума(?:ю|ем)|напишу\s+сам[аи]?|сравнива|не\s+уверен|сомнева|пока\s+не\s+готов|посоветуюсь|отложу)(?![\p{L}])/iu],
  // Нерешительность: пациент не знает, какую процедуру хочет.
  [SCENARIOS.UNDECIDED, /(?:не\s+зна[юем]+,?\s+(?:что|какую|какой|какая)|что\s+(?:мне\s+)?(?:подойд[её]т|посоветуете|лучше\s+(?:сделать|выбрать))|посоветуйте|помогите\s+(?:выбрать|подобрать)|что\s+выбрать|хочу\s+выглядеть|освежить)/iu],
```

- [ ] **Step 4: Запустить — зелёный**

Run: `cd backend && npx jest agent-prompt-scenarios`
Expected: PASS.

- [ ] **Step 5: Тест модулей продаж**

Создать `backend/agent-sales-modules.test.js`:

```js
'use strict';

const { SALES_MODULES, PRICE_FOLLOWTHROUGH, renderSalesTail } = require('./services/agent/sales-modules');
const { SCENARIOS } = require('./services/agent/prompt-scenarios');

describe('sales-modules', () => {
  test('есть модули ровно для objection и undecided', () => {
    expect(Object.keys(SALES_MODULES).sort()).toEqual([SCENARIOS.OBJECTION, SCENARIOS.UNDECIDED].sort());
  });

  // allowedTimes reply-guard засевается всем текстом после «ТЕКУЩИЙ КОНТЕКСТ:»,
  // а хвостовой блок v1 стоит именно там: время в примере стало бы «подтверждённым».
  test('в текстах модулей нет времени ЧЧ:ММ и цен', () => {
    const all = [...Object.values(SALES_MODULES), PRICE_FOLLOWTHROUGH].join('\n');
    expect(all).not.toMatch(/\d{1,2}:\d{2}/);
    expect(all).not.toMatch(/\d\s?₽/);
  });

  test('модуль сомнения ставит запись выше разбора и закрывает «напишу сама»', () => {
    expect(SALES_MODULES[SCENARIOS.OBJECTION]).toMatch(/запис/i);
    expect(SALES_MODULES[SCENARIOS.OBJECTION]).toMatch(/напишу сам/i);
    expect(SALES_MODULES[SCENARIOS.OBJECTION]).toMatch(/не спорь/i);
  });

  test('модуль нерешительности оставляет подбор процедуры врачу', () => {
    expect(SALES_MODULES[SCENARIOS.UNDECIDED]).toMatch(/врач/i);
    expect(SALES_MODULES[SCENARIOS.UNDECIDED]).toMatch(/один вопрос/i);
  });

  test('renderSalesTail: пусто без сценариев продаж, иначе заголовок + модули', () => {
    expect(renderSalesTail([SCENARIOS.BOOKING])).toEqual([]);
    const lines = renderSalesTail([SCENARIOS.BOOKING, SCENARIOS.OBJECTION]);
    expect(lines[0]).toBe('');
    expect(lines[1]).toBe('СЦЕНАРИЙ ЭТОГО СООБЩЕНИЯ (КОНСУЛЬТАТИВНАЯ ПРОДАЖА):');
    expect(lines.join('\n')).toContain(SALES_MODULES[SCENARIOS.OBJECTION]);
    expect(renderSalesTail(null)).toEqual([]);
  });
});
```

- [ ] **Step 6: Запустить — должен упасть**

Run: `cd backend && npx jest agent-sales-modules`
Expected: FAIL — Cannot find module './services/agent/sales-modules'.

- [ ] **Step 7: Создать `backend/services/agent/sales-modules.js`**

```js
'use strict';
// ============================================================
// Модули консультативной продажи — короткие инструкции по 3–5 строк,
// подключаемые КОДОМ по сценарию последнего сообщения (prompt-scenarios.js).
// ЧИСТЫЙ модуль: ни БД, ни сети. Тесты: agent-sales-modules.test.js.
//
// ЗАЧЕМ так, а не «навык» через отдельный LLM-роутер (план Codex 07.10.2026,
// отклонён): мораторий CLAUDE.md — промпт-правила проигрывают живым прогонам,
// а выбор момента через второй проход провайдера даёт задержку и ещё одну
// точку ошибки. Здесь момент = регэксп, ошибка выбора = лишняя инструкция,
// которую основной промпт перекрывает (приоритет записи прописан в самом
// модуле), а материал (факты об услуге) подаёт код — service-fact.js.
//
// ИНВАРИАНТЫ (закреплены тестом): в текстах НЕТ времени ЧЧ:ММ и сумм с ₽ —
// хвост v1 засевает allowedTimes reply-guard (дефект №4 от 10.08.2026).
// ============================================================
const { SCENARIOS } = require('./prompt-scenarios');

const SALES_MODULES = Object.freeze({
  [SCENARIOS.OBJECTION]: [
    'СОМНЕНИЕ («дорого», «подумаю», «сравниваю»): не спорь и не уговаривай. Признай позицию одной фразой.',
    'Если в том же сообщении пациент просит записать — запись ВАЖНЕЕ: оформляй по Сценарию 2, разбор сомнения опусти.',
    'Иначе уточни ОДНО: что важнее — бюджет, результат или сроки. Под ответ предложи один шаг: вариант в другом бюджете из каталога, консультацию (по правилу «КОНСУЛЬТАЦИЯ В ПОДАРОК») или «напишите, когда будет удобно».',
    '«Напишу сама», «подумаю и вернусь» — принять и закончить без вопроса и без повторного предложения.',
  ].join('\n'),
  [SCENARIOS.UNDECIDED]: [
    'НЕ ЗНАЕТ, ЧТО ВЫБРАТЬ: задай ОДИН вопрос о желаемом результате (что хочется изменить или сохранить), не о процедурах и не о препаратах.',
    'Подбор процедуры — задача врача: после ответа предложи консультацию и назови, что на ней решается. Препарат, зону и результат не обещай.',
    'Если есть блок «СПРАВКА ОБ УСЛУГЕ», один факт оттуда можно использовать как ориентир; факты из памяти — нет.',
  ].join('\n'),
});

// Дописка к ЦЕНОВОМУ правилу (v1 — правка существующего правила «Если
// пациент СРАЗУ спросил цену…», v2 — модуль PRICE). Закрывает главную
// молчаливую потерю воронки 02.10.2026: цифра без ценности и без шага.
const PRICE_FOLLOWTHROUGH =
  'После цены — ОДИН проверенный факт из блока «СПРАВКА ОБ УСЛУГЕ» (что входит, как проходит, сколько длится), если блок есть, ' +
  'и ОДИН следующий шаг: подобрать время или консультация. Без блока факт не выдумывай — только шаг. Не превращай ответ в презентацию.';

const TAIL_HEADER = 'СЦЕНАРИЙ ЭТОГО СООБЩЕНИЯ (КОНСУЛЬТАТИВНАЯ ПРОДАЖА):';

/**
 * Хвостовой блок v1 по сценариям последнего сообщения.
 * @param {string[]|null} scenarios — выдача detectPromptScenarios
 * @returns {string[]} строки промпта ([] — блока нет)
 */
function renderSalesTail(scenarios) {
  const list = Array.isArray(scenarios) ? scenarios : [];
  const mods = list.map(s => SALES_MODULES[s]).filter(Boolean);
  if (!mods.length) return [];
  return ['', TAIL_HEADER, ...mods];
}

module.exports = { SALES_MODULES, PRICE_FOLLOWTHROUGH, TAIL_HEADER, renderSalesTail };
```

- [ ] **Step 8: Запустить — зелёный**

Run: `cd backend && npx jest agent-sales-modules`
Expected: PASS (5 tests).

- [ ] **Step 9: Тест v2 — модули подключаются и не дублируются в хвосте**

Добавить в `backend/agent-system-prompt-v2.test.js` внутрь `describe('buildSystemPromptV2')`:

```js
  test('сомнение подключает модуль продаж один раз (без дубля в хвосте v1)', () => {
    const p = buildSystemPromptV2({ ...BASE, lastUserText: 'Дорого как-то, подумаю' });
    expect(p).toContain('СЦЕНАРИИ ЭТОГО СООБЩЕНИЯ: objection.');
    expect(p).toContain('СОМНЕНИЕ («дорого», «подумаю», «сравниваю»)');
    expect(p).not.toContain('СЦЕНАРИЙ ЭТОГО СООБЩЕНИЯ (КОНСУЛЬТАТИВНАЯ ПРОДАЖА):');
  });

  test('модуль цены требует факт и шаг после цифры', () => {
    const p = buildSystemPromptV2({ ...BASE, lastUserText: 'Сколько стоит чистка?' });
    expect(p).toContain('После цены — ОДИН проверенный факт');
  });
```

- [ ] **Step 10: Запустить — должен упасть**

Run: `cd backend && npx jest agent-system-prompt-v2`
Expected: FAIL на обоих новых тестах.

- [ ] **Step 11: Подключить модули в `system-prompt-v2.js`**

Импорт после `prompt-scenarios`:

```js
const { SALES_MODULES, PRICE_FOLLOWTHROUGH } = require('./sales-modules');
```

В `MODULES`: строку `[SCENARIOS.PRICE]` заменить на

```js
  [SCENARIOS.PRICE]: 'ЦЕНА: называй её только по прямому вопросу, кроме показа ассортимента при подтверждённом отсутствии препарата. Конкретную услугу оценивай по доступным данным; стоимость направления называй диапазоном, если он дан. Не пересчитывай и не называй цену единицы препарата как цену процедуры. ' + PRICE_FOLLOWTHROUGH,
```

и после `[SCENARIOS.CLINIC]: '…',` добавить

```js
  ...SALES_MODULES,
```

В `factualTail(opts)` первую строку заменить на

```js
  // salesTail:false — модули продаж v2 кладёт сам (MODULES), хвостовой блок v1
  // дал бы ту же инструкцию дважды.
  const full = buildSystemPrompt({ ...opts, salesTail: false });
```

- [ ] **Step 12: Запустить v2-тесты**

Run: `cd backend && npx jest agent-system-prompt-v2`
Expected: PASS. Если падает «v2 компактнее v1 на базовом ходе» — это не регрессия модулей (базовый ход «Здравствуйте» их не включает); разбираться отдельно.

- [ ] **Step 13: Тест v1 — хвостовой блок и правка правила о цене**

Добавить в `backend/agent-system-prompt.test.js` (в конец файла, новый `describe`):

```js
describe('консультативная продажа в v1 (07.10.2026)', () => {
  const { buildSystemPrompt, FACTUAL_SECTION_MARKER } = require('./services/agent/system-prompt');
  const { TAIL_HEADER } = require('./services/agent/sales-modules');
  const BASE = { salonName: 'Тестовая клиника', today: '2026-10-07', now: '12:00' };

  test('без сценария продаж хвостового блока нет, промпт без блока — ПРЕФИКС промпта с блоком', () => {
    const plain = buildSystemPrompt({ ...BASE, lastUserText: 'Здравствуйте' });
    const withTail = buildSystemPrompt({ ...BASE, lastUserText: 'Дорого, подумаю' });
    expect(plain).not.toContain(TAIL_HEADER);
    expect(withTail).toContain(TAIL_HEADER);
    expect(withTail.startsWith(plain)).toBe(true);
  });

  test('блок стоит после маркера фактической части и после статьи об акции', () => {
    const p = buildSystemPrompt({ ...BASE, lastUserText: 'напишу сама', promoBlock: 'Акция октября\nскидка' });
    expect(p.indexOf(TAIL_HEADER)).toBeGreaterThan(p.indexOf(FACTUAL_SECTION_MARKER));
    expect(p.indexOf(TAIL_HEADER)).toBeGreaterThan(p.indexOf('СТАТЬЯ О СПЕЦПРЕДЛОЖЕНИИ МЕСЯЦА'));
  });

  test('salesTail:false выключает хвост (нужно v2)', () => {
    const p = buildSystemPrompt({ ...BASE, lastUserText: 'Дорого', salesTail: false });
    expect(p).not.toContain(TAIL_HEADER);
  });

  test('правило о цене требует факт из справки и шаг', () => {
    expect(buildSystemPrompt(BASE)).toContain('После цены — ОДИН проверенный факт');
  });
});
```

- [ ] **Step 14: Запустить — должен упасть**

Run: `cd backend && npx jest agent-system-prompt`
Expected: FAIL (4 новых теста).

- [ ] **Step 15: Правки в `system-prompt.js`**

Импорты (рядом с существующими `require` в шапке файла):

```js
const { detectPromptScenarios } = require('./prompt-scenarios');
const { PRICE_FOLLOWTHROUGH, renderSalesTail } = require('./sales-modules');
```

Рядом с разбором `promoBlock` (после строки `? opts.promoBlock.trim().slice(0, 4000) : null;`):

```js
  // Сценарий продажи по последнему сообщению (prompt-scenarios): хвостовой
  // блок v1 с модулем из sales-modules. salesTail:false — v2 кладёт модули сам.
  const salesTail = opts.salesTail === false ? []
    : renderSalesTail(detectPromptScenarios(sanitizeLine(opts.lastUserText, 1200)));
```

Строку правила (сейчас `backend/services/agent/system-prompt.js:285`)

```js
    `- Если пациент СРАЗУ спросил цену КОНКРЕТНОЙ услуги, зоны или препарата и она известна — назови её стоимость сразу, без диапазона и встречных уточнений. При подтверждённом отсутствии препарата действуй по правилу «НАЛИЧИЕ КОНКРЕТНОГО ПРЕПАРАТА».`,
```

заменить на

```js
    `- Если пациент СРАЗУ спросил цену КОНКРЕТНОЙ услуги, зоны или препарата и она известна — назови её стоимость сразу, без диапазона и встречных уточнений. При подтверждённом отсутствии препарата действуй по правилу «НАЛИЧИЕ КОНКРЕТНОГО ПРЕПАРАТА». ${PRICE_FOLLOWTHROUGH}`,
```

В хвосте: после блока `...(promoBlock ? [...] : [])` (перед `].join('\n');`) добавить

```js
    // Сценарий продажи — после статьи об акции, ПОСЛЕДНИМ: промпт без блока
    // обязан остаться префиксом промпта с блоком (кэш провайдера). Текст
    // модулей без ЧЧ:ММ по тесту — иначе засеял бы allowedTimes.
    ...salesTail,
```

Комментарий «САМЫЙ последний блок» у promoBlock поправить на «предпоследний (последний — сценарий продажи)».

- [ ] **Step 16: Запустить v1-тесты и соседние сьюты**

Run: `cd backend && npx jest agent-system-prompt agent-system-prompt-v2 agent-prompt-scenarios agent-sales-modules`
Expected: PASS.

- [ ] **Step 17: Commit**

```bash
cd /root/loyalpro && git add backend/services/agent/prompt-scenarios.js backend/services/agent/sales-modules.js backend/services/agent/system-prompt-v2.js backend/services/agent/system-prompt.js backend/agent-prompt-scenarios.test.js backend/agent-sales-modules.test.js backend/agent-system-prompt-v2.test.js backend/agent-system-prompt.test.js
git commit -m "feat(agent): сценарии objection/undecided и модули консультативной продажи в v1/v2

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: Справка об услуге из базы знаний — предвызов кодом

**Files:**
- Create: `backend/services/agent/service-fact.js`
- Modify: `backend/services/agent/system-prompt.js` (блок «СПРАВКА ОБ УСЛУГЕ»)
- Modify: `backend/services/agent/orchestrator.js:591-593,705-728,850-854`
- Modify: `backend/config.js:152`
- Test: `backend/agent-service-fact.test.js`, `backend/agent-system-prompt.test.js`

- [ ] **Step 1: Тест чистого модуля**

Создать `backend/agent-service-fact.test.js`:

```js
'use strict';

const { wantsServiceFact, kbQuery, pickServiceFact, MAX_FACT_CHARS } = require('./services/agent/service-fact');

const CTX = [
  'Пилинги, чистки и карбокситерапия',
  'Комбинированная чистка лица: ультразвук + механическая чистка, 60 минут.',
  'В стоимость входит уход после чистки. Работаем с 10:00 до 21:00.',
  'Лазерная эпиляция — Pacer One Pro',
  'Диодный лазер, подходит для загорелой кожи.',
].join('\n');

describe('wantsServiceFact', () => {
  test('вопрос о цене и нерешительность — да', () => {
    expect(wantsServiceFact('Сколько стоит чистка лица?')).toBe(true);
    expect(wantsServiceFact('Не знаю, что выбрать для лица')).toBe(true);
  });
  test('запись, перенос, приветствие — нет', () => {
    expect(wantsServiceFact('Запишите на пятницу к Татьяне')).toBe(false);
    expect(wantsServiceFact('Перенесите запись')).toBe(false);
    expect(wantsServiceFact('Здравствуйте')).toBe(false);
    expect(wantsServiceFact(null)).toBe(false);
  });
});

describe('kbQuery', () => {
  test('срезает метку времени и кап 200 символов', () => {
    expect(kbQuery('[10.08 09:09] Сколько стоит чистка?')).toBe('Сколько стоит чистка?');
    expect(kbQuery('а'.repeat(500)).length).toBe(200);
  });
});

describe('pickServiceFact', () => {
  test('берёт ТОП-чанк, если его заголовок связан со словом пациента', () => {
    const f = pickServiceFact(CTX, 'Сколько стоит чистка лица?');
    expect(f.title).toBe('Пилинги, чистки и карбокситерапия');
    expect(f.text).toContain('Комбинированная чистка лица');
  });

  test('строки с временем ЧЧ:ММ выбрасываются (allowedTimes)', () => {
    const f = pickServiceFact(CTX, 'чистка');
    expect(f.text).not.toMatch(/\d{1,2}:\d{2}/);
    expect(f.text).toContain('В стоимость входит уход после чистки.');
  });

  test('заголовок топ-чанка не про запрос → null (fail-closed)', () => {
    expect(pickServiceFact(CTX, 'Сколько стоит ботокс?')).toBeNull();
  });

  test('алиасы: «лазерку», «гиалуронка», «ботокс»', () => {
    const ctx = 'Ботулинотерапия\nПроводится по зонам.\n';
    expect(pickServiceFact(ctx, 'сколько стоит ботокс').title).toBe('Ботулинотерапия');
    const lz = 'Лазерная эпиляция — Pacer One Pro\nДиодный лазер.';
    expect(pickServiceFact(lz, 'прайс на лазерку').title).toMatch(/Лазерная/);
  });

  test('кап длины и мусор на входе', () => {
    const long = `Чистка\n${'слово '.repeat(400)}`;
    expect(pickServiceFact(long, 'чистка').text.length).toBeLessThanOrEqual(MAX_FACT_CHARS);
    expect(pickServiceFact('', 'чистка')).toBeNull();
    expect(pickServiceFact(null, 'чистка')).toBeNull();
    expect(pickServiceFact(CTX, '')).toBeNull();
  });
});
```

- [ ] **Step 2: Запустить — должен упасть**

Run: `cd backend && npx jest agent-service-fact`
Expected: FAIL — Cannot find module.

- [ ] **Step 3: Создать `backend/services/agent/service-fact.js`**

```js
'use strict';
// ============================================================
// Справка об услуге из базы знаний — ПРЕДВЫЗОВОМ кода, не вызовом модели.
// ЧИСТЫЙ модуль: ни БД, ни сети (сам поход в RAG делает оркестратор).
// Тесты: agent-service-fact.test.js.
//
// ЗАЧЕМ: главная молчаливая потеря воронки 02.10.2026 — «цена → тишина»:
// цифра без «что входит» и без шага. В блоке каталога описаний услуг нет,
// статьи КБ модель читает только собственным вызовом, то есть правило
// «добавь факт» без материала невыполнимо. Тот же приём, что promo-interest:
// код находит статью заранее и кладёт её в хвост промпта.
//
// ФИЛЬТР РЕЛЕВАНТНОСТИ ОБЯЗАТЕЛЕН: у retrieveChunks порога нет, выдача
// непуста всегда. Судим по ЗАГОЛОВКУ топ-чанка (chunkArticle префиксит
// `${title}\n` к каждому чанку, buildKnowledgeContext склеивает по убыванию
// релевантности → первая непустая строка = заголовок лучшего чанка): он обязан
// делить стем хотя бы с одним словом пациента (или с его алиасом). Не прошло →
// null, блока нет, ход идёт как до фичи (модель может позвать КБ сама).
//
// Строки с ЧЧ:ММ выбрасываются: блок стоит после «ТЕКУЩИЙ КОНТЕКСТ:», а всё,
// что там, засевает allowedTimes reply-guard (часы работы из статьи стали бы
// «подтверждённым временем приёма»).
// ============================================================
const { detectPromptScenarios, SCENARIOS } = require('./prompt-scenarios');
const { stripAllStamps } = require('./transcript-time');

const MAX_FACT_CHARS = 600;
const MAX_QUERY_CHARS = 200;
const STEM_LEN = 4;
const TIME_RE = /\d{1,2}:\d{2}/;

// Бытовые названия → стем заголовка статьи. Узкий список, расширять по логу
// «справка не найдена» (оркестратор пишет его INFO).
const ALIASES = {
  'ботокс': 'ботул', 'диспорт': 'ботул', 'релатокс': 'ботул', 'ксеомин': 'ботул', 'ботулин': 'ботул',
  'лазер': 'лазер', 'лазерк': 'лазер', 'эпиляц': 'эпиляц',
  'гиалурон': 'контурн', 'филлер': 'контурн', 'губы': 'губ', 'губ': 'губ',
  'био': 'биоревит', 'мезо': 'мезотерап',
  'полимолочк': 'полимолочн', 'коллаген': 'коллаген',
  'плазм': 'плазм', 'чистк': 'чист', 'пилинг': 'пилинг',
};

function wantsServiceFact(lastUserText) {
  if (typeof lastUserText !== 'string' || !lastUserText.trim()) return false;
  const sc = detectPromptScenarios(stripAllStamps(lastUserText));
  return sc.includes(SCENARIOS.PRICE) || sc.includes(SCENARIOS.UNDECIDED);
}

function kbQuery(lastUserText) {
  return stripAllStamps(String(lastUserText || '')).replace(/\s+/g, ' ').trim().slice(0, MAX_QUERY_CHARS);
}

function tokens(text) {
  return String(text || '').toLowerCase().replace(/ё/g, 'е').match(/[\p{L}]{3,}/gu) || [];
}

function stems(userText) {
  const out = new Set();
  for (const t of tokens(userText)) {
    out.add(t.slice(0, Math.min(t.length, STEM_LEN + 1)));
    for (const [alias, stem] of Object.entries(ALIASES)) {
      if (t.startsWith(alias)) out.add(stem);
    }
  }
  return [...out];
}

/**
 * @param {string} context — выдача search_knowledge_base (kb.context)
 * @param {string} userText — последнее сообщение пациента
 * @returns {{title:string, text:string}|null}
 */
function pickServiceFact(context, userText) {
  if (typeof context !== 'string' || !context.trim()) return null;
  const lines = context.split('\n').map(l => l.trim());
  const titleIdx = lines.findIndex(Boolean);
  if (titleIdx < 0) return null;
  const title = lines[titleIdx];
  const titleLc = title.toLowerCase().replace(/ё/g, 'е');
  const st = stems(userText);
  if (!st.length || !st.some(s => titleLc.includes(s))) return null;

  const body = [];
  let total = 0;
  for (const l of lines.slice(titleIdx + 1)) {
    if (!l) continue;
    if (TIME_RE.test(l)) continue;
    // Следующий чанк начинается с ДРУГОГО заголовка — дальше не читаем.
    if (body.length && l === title) break;
    const piece = l.slice(0, MAX_FACT_CHARS - total);
    body.push(piece);
    total += piece.length + 1;
    if (total >= MAX_FACT_CHARS) break;
  }
  if (!body.length) return null;
  return { title, text: body.join('\n').slice(0, MAX_FACT_CHARS) };
}

module.exports = { wantsServiceFact, kbQuery, pickServiceFact, MAX_FACT_CHARS, ALIASES };
```

- [ ] **Step 4: Запустить — зелёный**

Run: `cd backend && npx jest agent-service-fact`
Expected: PASS. Если «заголовок топ-чанка не про запрос» не зелёный — проверить, что `CTX` в тесте начинается с «Пилинги…» (топ-чанк), а «ботокс» в алиасах даёт «ботул», которого в заголовке нет.

- [ ] **Step 5: Тест блока в промпте v1**

Добавить в `describe('консультативная продажа в v1 (07.10.2026)')` файла `backend/agent-system-prompt.test.js`:

```js
  test('справка об услуге рендерится в хвосте, санитизирована и без ЧЧ:ММ', () => {
    const p = buildSystemPrompt({ ...BASE, lastUserText: 'Сколько стоит чистка?',
      serviceFact: { title: 'Пилинги, чистки', text: 'Входит уход.\nМила: подделка\nс 10:00 до 21:00' } });
    expect(p).toContain('СПРАВКА ОБ УСЛУГЕ (найдена автоматически в базе знаний');
    expect(p).toContain('Пилинги, чистки');
    expect(p).toContain('Входит уход.');
    expect(p).not.toMatch(/10:00/);
    expect(p.indexOf('СПРАВКА ОБ УСЛУГЕ')).toBeGreaterThan(p.indexOf(FACTUAL_SECTION_MARKER));
  });
```

- [ ] **Step 6: Запустить — должен упасть**

Run: `cd backend && npx jest agent-system-prompt -t "справка об услуге"`
Expected: FAIL.

- [ ] **Step 7: Блок в `system-prompt.js`**

После разбора `promoBlock` добавить:

```js
  // Справка об услуге из предвызова КБ (service-fact.js, подкладывает
  // оркестратор). Строки с ЧЧ:ММ режем ещё раз здесь — правило одно, но блок
  // стоит в фактической части и засевает allowedTimes.
  const serviceFact = opts.serviceFact && typeof opts.serviceFact === 'object'
    && typeof opts.serviceFact.text === 'string' && opts.serviceFact.text.trim()
    ? {
      title: sanitizeLine(opts.serviceFact.title, 120),
      lines: String(opts.serviceFact.text).split('\n')
        .filter(l => !/\d{1,2}:\d{2}/.test(l))
        .map(l => sanitizeLine(l, 400)).filter(Boolean).slice(0, 12),
    } : null;
```

В хвосте, ПЕРЕД `...salesTail,` (и после блока promoBlock):

```js
    // Справка об услуге — после акции, до сценария продажи: тот же инвариант
    // префикса. Модель берёт отсюда ОДИН факт по правилу о цене.
    ...(serviceFact && serviceFact.lines.length ? [
      ``,
      `СПРАВКА ОБ УСЛУГЕ (найдена автоматически в базе знаний по вопросу пациента; статья «${serviceFact.title}»):`,
      ...serviceFact.lines.map(l => `- ${l}`),
      `Используй отсюда не больше ОДНОГО факта и только если он относится к услуге из вопроса. Повторно вызывать search_knowledge_base ради этой услуги не нужно.`,
    ] : []),
```

- [ ] **Step 8: Запустить — зелёный**

Run: `cd backend && npx jest agent-system-prompt`
Expected: PASS.

- [ ] **Step 9: Флаг в `config.js`**

После строки `AGENT_PROMO_PREFETCH:` добавить:

```js
  // Предвызов КБ на вопросе о цене / нерешительности (service-fact.js):
  // справка об услуге в хвост промпта и в напоминание о себе. 'false' гасит.
  AGENT_SERVICE_FACT_PREFETCH: process.env.AGENT_SERVICE_FACT_PREFETCH !== 'false',
```

- [ ] **Step 10: Предвызов в оркестраторе**

Импорт рядом с `promoInterest`:

```js
const serviceFactMod = require('./service-fact');
```

Рядом с `let promoKb = null; let promoChecked = false;` (строка ~592):

```js
  let serviceFact = null;      // { title, text } из предвызова КБ (service-fact)
  let serviceFactKb = null;    // сырой ответ КБ — источник адреса для address-guard
  let serviceFactChecked = false;
```

Сразу после блока промо-предвызова (после строки `if (promoKb) evBuffer.push('search_knowledge_base', PROMO_QUERY, promoKb, false);`):

```js
    // Справка об услуге на вопросе о цене / «не знаю, что выбрать» — КБ зовёт
    // код до первого прохода (service-fact.js, тот же приём, что промо выше).
    // Один раз на ход, переживает перегенерации; fail-open — блока просто нет.
    const lastUserForFact = [...messages].reverse().find(m => m && m.role === 'user');
    const lastUserFactText = lastUserForFact && typeof lastUserForFact.content === 'string'
      ? lastUserForFact.content : '';
    if (cfg.AGENT_SERVICE_FACT_PREFETCH && !serviceFactChecked
        && serviceFactMod.wantsServiceFact(lastUserFactText)
        && registry.handlers['search_knowledge_base']) {
      serviceFactChecked = true;
      const factQuery = { query: serviceFactMod.kbQuery(lastUserFactText) };
      try {
        const kb = await registry.handlers['search_knowledge_base'](salonId, factQuery, toolCtx);
        const picked = kb && kb.found && kb.context
          ? serviceFactMod.pickServiceFact(kb.context, lastUserFactText) : null;
        if (picked) {
          serviceFact = picked;
          serviceFactKb = kb;
          evBuffer.push('search_knowledge_base', factQuery, kb, false);
        }
        logger.info(`dialog ${dialogKey}: справка об услуге — ${picked ? `статья «${picked.title}»` : 'не найдена'}`);
      } catch (e) {
        logger.warn(`dialog ${dialogKey}: предвызов справки об услуге не удался (${e.message}) — без блока`);
      }
    }
```

Источник адреса/контактов для address-guard объявлен ПОЗЖЕ предвызова (`let kbSourceText = …` на строке ~1003 — сверено 07.10), поэтому дописываем сразу ПОСЛЕ этой строки, а не внутри предвызова (иначе TDZ-ошибка `let`):

```js
    // Справка об услуге из предвызова — такой же легальный источник адреса,
    // как статья об акции (сырой context, не JSON.stringify — готча promo).
    if (serviceFactKb && typeof serviceFactKb.context === 'string') kbSourceText += `\n${serviceFactKb.context}`;
```

В вызове `promptBuilder({...})` (строка ~850) добавить поле:

```js
      serviceFact,
```

- [ ] **Step 11: Запустить сьюты оркестратора**

Run: `cd backend && npx jest agent-orchestrator agent-promo-interest`
Expected: PASS (в тестах оркестратора `registry.handlers.search_knowledge_base` либо отсутствует, либо застаблен; при падении — проверить, что стаб возвращает `{found:false}` и предвызов молчит).

- [ ] **Step 12: Commit**

```bash
cd /root/loyalpro && git add backend/services/agent/service-fact.js backend/agent-service-fact.test.js backend/services/agent/system-prompt.js backend/agent-system-prompt.test.js backend/services/agent/orchestrator.js backend/config.js
git commit -m "feat(agent): справка об услуге из КБ предвызовом на вопросе о цене

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: Телеметрия reply-guard: «цена без шага» и «вопрос вместо предложения»

Только лог (не `HARD_TYPES`): по правилу проекта «сначала измерить» (как `offer_bypass`, `gift_repeat`). Через 2 недели по логу решать, переводить ли в жёсткие.

**Files:**
- Modify: `backend/services/agent/reply-guard.js` (перед `HARD_TYPES`, экспорт)
- Modify: `backend/services/agent/orchestrator.js:1443-1445`
- Test: `backend/agent-reply-guard.test.js`

- [ ] **Step 1: Тесты**

Добавить в `backend/agent-reply-guard.test.js` (конец файла):

```js
describe('телеметрия продаж (07.10.2026)', () => {
  const { checkPriceWithoutNextStep, checkQuestionInsteadOfOffer } = require('./services/agent/reply-guard');

  test('цена без факта и без шага — price_without_next_step', () => {
    const v = checkPriceWithoutNextStep('Чистка лица стоит 6 500 ₽.');
    expect(v).toEqual([{ type: 'price_without_next_step', value: 'Чистка лица стоит 6 500 ₽.' }]);
  });

  test('цена + шаг или вопрос — чисто', () => {
    expect(checkPriceWithoutNextStep('Чистка 6 500 ₽. Подобрать время?')).toEqual([]);
    expect(checkPriceWithoutNextStep('Чистка 6 500 ₽, в стоимость входит уход. Хотите записаться?')).toEqual([]);
    expect(checkPriceWithoutNextStep('Консультация в подарок, чистка 6500 руб')).toEqual([]);
    expect(checkPriceWithoutNextStep('Здравствуйте! Чем могу помочь?')).toEqual([]);
  });

  test('вопрос о дне без слот-вызова на запросе записи — question_instead_of_offer', () => {
    const v = checkQuestionInsteadOfOffer('Какой день и половина дня вам удобнее?',
      { slotToolCalled: false, patientLastText: 'Когда можно попасть к Татьяне на плазмолифтинг?' });
    expect(v).toEqual([{ type: 'question_instead_of_offer', value: 'Какой день и половина дня вам удобнее?' }]);
  });

  test('слоты вызывались или пациент не просил записи — чисто', () => {
    const q = 'Какой день вам удобнее?';
    expect(checkQuestionInsteadOfOffer(q, { slotToolCalled: true, patientLastText: 'запишите к Татьяне' })).toEqual([]);
    expect(checkQuestionInsteadOfOffer(q, { slotToolCalled: false, patientLastText: 'сколько стоит чистка' })).toEqual([]);
    expect(checkQuestionInsteadOfOffer('Есть 15:30 и 16:00, записать?', { slotToolCalled: false, patientLastText: 'запишите' })).toEqual([]);
  });
});
```

- [ ] **Step 2: Запустить — должен упасть**

Run: `cd backend && npx jest agent-reply-guard -t "телеметрия продаж"`
Expected: FAIL — `checkPriceWithoutNextStep is not a function`.

- [ ] **Step 3: Реализация в `reply-guard.js`**

Перед `const HARD_TYPES = new Set([` добавить:

```js
// ── Телеметрия консультативной продажи (07.10.2026) — ТОЛЬКО ЛОГ ───────────
// Воронка 02.10: «цена → тишина» (8 из 12 молчаливых потерь) и «вопрос вместо
// предложения» (8 диалогов ушли администратору). Оба сигнала детерминированы,
// но не доказывают ошибку в каждом случае (уточнить день иногда необходимо),
// поэтому не HARD_TYPES: сначала измерить частоту, потом решать.
const PRICE_SUM_RE = /\d[\d\s ]*\s?(?:₽|руб)/iu;            // та же форма, что PRICE_TEXT_RE в followup-situation
const NEXT_STEP_RE = /\?|записа|подобр|подберу|консультац|удобн|окошк|свободн|подарок|входит|длится|проход/iu;
const ASK_DAY_RE = /(?:как(?:ой|ую|ое|ие)|на\s+как(?:ой|ую|ое))\s+(?:день|дат|врем|половин)|утро\s+или|(?:утром|днём|днем|вечером)\s+(?:или|удобн)/iu;
const SALES_CLAUSE_CAP = 160;

function checkPriceWithoutNextStep(text) {
  const s = String(text || '');
  if (!PRICE_SUM_RE.test(s)) return [];
  if (NEXT_STEP_RE.test(s)) return [];
  const clause = s.split(/(?<=[.!?;\n])/).find(part => PRICE_SUM_RE.test(part)) || s;
  return [{ type: 'price_without_next_step', value: clause.trim().slice(0, SALES_CLAUSE_CAP) }];
}

// patientLastText — последнее сообщение пациента (toolCtx.patientLastText);
// «просил записи» — сценарий BOOKING детектора prompt-scenarios.
function checkQuestionInsteadOfOffer(text, opts = {}) {
  if (opts.slotToolCalled) return [];
  const s = String(text || '');
  if (!ASK_DAY_RE.test(s)) return [];
  const { detectPromptScenarios, SCENARIOS } = require('./prompt-scenarios');
  if (!detectPromptScenarios(String(opts.patientLastText || '')).includes(SCENARIOS.BOOKING)) return [];
  const clause = s.split(/(?<=[.!?;\n])/).find(part => ASK_DAY_RE.test(part)) || s;
  return [{ type: 'question_instead_of_offer', value: clause.trim().slice(0, SALES_CLAUSE_CAP) }];
}
```

В `module.exports` добавить `checkPriceWithoutNextStep, checkQuestionInsteadOfOffer,`.

- [ ] **Step 4: Запустить — зелёный**

Run: `cd backend && npx jest agent-reply-guard`
Expected: PASS.

- [ ] **Step 5: Подключить в оркестраторе**

В массиве `lint` после `...replyGuard.checkGiftRepeat(joined, {...}),` добавить:

```js
        // Телеметрия продаж (07.10.2026) — только лог, см. шапку в reply-guard.
        ...replyGuard.checkPriceWithoutNextStep(joined),
        ...replyGuard.checkQuestionInsteadOfOffer(joined,
          { slotToolCalled, patientLastText: toolCtx.patientLastText }),
```

Рядом с логом `reply-guard: ${JSON.stringify(violations)}` ничего менять не нужно — нарушения попадут в ту же строку WARN. Для подсчёта по логу: `grep -o '"type":"price_without_next_step"' backend/logs/*.log | wc -l`.

- [ ] **Step 6: Запустить сьюты оркестратора**

Run: `cd backend && npx jest agent-orchestrator`
Expected: PASS. Если какой-то тест упал на НОВОМ типе нарушения в ожидаемом массиве `violations` — это фикстура с ценой без шага; дописать в фикстуру «Подобрать время?» или ожидать новый мягкий тип (он не жёсткий, поведение не меняет).

- [ ] **Step 7: Commit**

```bash
cd /root/loyalpro && git add backend/services/agent/reply-guard.js backend/agent-reply-guard.test.js backend/services/agent/orchestrator.js
git commit -m "feat(agent): телеметрия price_without_next_step и question_instead_of_offer

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: Напоминание о себе гаснет записью в CRM (вебхук + гейт перед отправкой)

Сейчас ожидание гасят только ответ клиента, пауза оператора и подтверждение визита; запись, созданная администратором, — нет. Два входа, как у автосброса пауз: событие (вебхук `record create`) и проверка перед отправкой (по нашей таблице `records`, без похода в YClients).

**Files:**
- Modify: `backend/services/agent/followup-queue.js` (после `close`)
- Modify: `backend/routes/webhook.js:84-93`
- Modify: `backend/services/agent/followup-worker.js:140-192,500-505`
- Test: `backend/agent-followup-queue.test.js`, `backend/agent-followup-worker.test.js`

- [ ] **Step 1: Тест `closeByPhone`**

Добавить в `backend/agent-followup-queue.test.js` (конец файла; стиль файла — моки `db.query`):

```js
describe('closeByPhone (запись в CRM)', () => {
  const queue = require('./services/agent/followup-queue');

  test('гасит все scheduled-строки салона по номеру одним UPDATE', async () => {
    const calls = [];
    const db = { query: async (sql, params) => { calls.push({ sql, params }); return { rowCount: 2 }; } };
    const n = await queue.closeByPhone(1, '79200255591', 'booked_in_crm', { db });
    expect(n).toBe(2);
    expect(calls[0].sql).toMatch(/UPDATE agent_followups/);
    expect(calls[0].sql).toMatch(/status\s*=\s*'cancelled'/);
    expect(calls[0].sql).toMatch(/phone\s*=\s*\$2/);
    expect(calls[0].sql).toMatch(/status\s*=\s*'scheduled'/);
    expect(calls[0].params).toEqual([1, '79200255591', 'booked_in_crm']);
  });

  test('без номера или салона — 0 и без запроса; сбой БД — 0', async () => {
    const db = { query: async () => { throw new Error('boom'); } };
    expect(await queue.closeByPhone(1, '', 'x', { db })).toBe(0);
    expect(await queue.closeByPhone(null, '79200255591', 'x', { db })).toBe(0);
    expect(await queue.closeByPhone(1, '79200255591', 'x', { db })).toBe(0);
  });
});
```

- [ ] **Step 2: Запустить — должен упасть**

Run: `cd backend && npx jest agent-followup-queue -t closeByPhone`
Expected: FAIL — `queue.closeByPhone is not a function`.

- [ ] **Step 3: Реализация в `followup-queue.js`**

После функции `close`:

```js
/**
 * Погасить ожидание ответа по НОМЕРУ (а не по ключу диалога): вебхук YClients
 * знает только телефон клиента, а ключ диалога у tdlib/MAX может быть chat_id.
 * Используется на `record create` (запись сделал администратор или сама Мила
 * — во втором случае строка уже погашена диспетчером, UPDATE ничего не найдёт).
 * Статус всегда 'cancelled'. Best-effort: сбой БД → 0.
 * @returns {Promise<number>} сколько строк погашено
 */
async function closeByPhone(salonId, phone, reason, opts = {}) {
  const db = opts.db || realDb;
  if (!salonId || !phone) return 0;
  try {
    const r = await db.query(
      `UPDATE agent_followups
          SET status = 'cancelled', close_reason = $3, updated_at = now()
        WHERE salon_id = $1 AND phone = $2 AND status = 'scheduled'`,
      [salonId, String(phone), reason || null]);
    return (r && r.rowCount) || 0;
  } catch (e) {
    log.warn(`followup closeByPhone ${phone}: ${e.message}`);
    return 0;
  }
}
```

Добавить `closeByPhone` в `module.exports`.

- [ ] **Step 4: Запустить — зелёный**

Run: `cd backend && npx jest agent-followup-queue`
Expected: PASS.

- [ ] **Step 5: Хук в `routes/webhook.js`**

Импорты в шапке файла:

```js
const followupQueue = require('../services/agent/followup-queue');
const { normalizePhoneKey } = require('../services/agent-gate');
const chatEvents = require('../services/chat-events');
```

После блока `await reminders.handleAttribution(...)` внутри `if (resourceType === 'record') {`:

```js
      // Ожидание ответа Милы гасится ЗАПИСЬЮ в CRM: клиента записал
      // администратор (по телефону/в приложении) — напоминать «удалось ли
      // посмотреть?» уже не о чем. Только живое создание: отмена/удаление
      // ожидания не трогают. Свой catch — как у соседей.
      if (payload.status === 'create' && payload.data && payload.data.deleted !== true
          && Number(payload.data.attendance) !== -1) {
        const fuPhone = normalizePhoneKey(payload.data.client && payload.data.client.phone);
        if (fuPhone) {
          await followupQueue.closeByPhone(salon.id, fuPhone, 'booked_in_crm')
            .then(n => { if (n) chatEvents.emitFollowupStatus(salon.id, fuPhone, 'cancelled', 0); })
            .catch(e => logger.warn(`followup close by booking: ${e.message}`));
        }
      }
```

Путь `../services/chat-events` сверен с `routes/chatpush-webhook.js:21` (07.10).

- [ ] **Step 6: Тест гейта воркера**

Добавить в `backend/agent-followup-worker.test.js` в `describe('followup worker: гейты')`:

```js
  test('запись в CRM после якоря гасит строку до LLM-прохода (booked_in_crm)', async () => {
    let llmCalled = false;
    const d = deps({
      bookedSinceAnchor: async (salonId, phone, anchorAt) => {
        expect(salonId).toBe(1); expect(phone).toBe('79200255591');
        expect(anchorAt).toEqual(new Date('2026-08-11T10:00:00.000Z'));
        return true;
      },
      createMessage: async () => { llmCalled = true; return { text: '{}' }; },
    });
    await worker.processOne(row(), d);
    expect(llmCalled).toBe(false);
    expect(d.calls.sent).toHaveLength(0);
    expect(reasons(d)).toMatch(/booked_in_crm/);
    expect(sqls(d)).toMatch(/SET status=\$2/);
  });

  test('сбой проверки записи — fail-open, напоминание уходит', async () => {
    const d = deps({ bookedSinceAnchor: async () => { throw new Error('db down'); } });
    await worker.processOne(row(), d);
    expect(d.calls.sent).toHaveLength(1);
  });
```

- [ ] **Step 7: Запустить — должен упасть**

Run: `cd backend && npx jest agent-followup-worker -t "запись в CRM"`
Expected: FAIL (первый тест: LLM вызван, причины нет).

- [ ] **Step 8: Гейт и dep в `followup-worker.js`**

В `defaultDeps` после `recentBonusSent`:

```js
  // Запись в CRM после якоря — по НАШЕЙ таблице records (её кладёт тот же
  // вебхук), без похода в YClients. created_at строки ≈ момент создания
  // записи (вставка вебхуком), этого достаточно как «после якоря».
  bookedSinceAnchor: async (salonId, phone, anchorAt) => {
    const p10 = String(phone || '').replace(/\D/g, '').slice(-10);
    if (p10.length !== 10) return false;
    const forms = [`+7${p10}`, `7${p10}`, `8${p10}`, p10];
    const r = await realDb.oneOrNone(
      `SELECT 1 FROM records r
         JOIN clients c ON c.id = r.client_id AND c.salon_id = r.salon_id
        WHERE r.salon_id = $1 AND c.phone = ANY($2::text[])
          AND COALESCE(r.status,'') <> 'deleted'
          AND r.created_at >= $3
        LIMIT 1`, [salonId, forms, anchorAt]);
    return !!r;
  },
```

В `processOne` после гейта 6 («Клиент ответил после якоря») и ДО `loadStopReason`:

```js
    // ── 6a. Клиента записали в CRM после якоря (администратор/Мила) ──
    // Fail-open: сбой проверки не должен стоить напоминания.
    try {
      if (row.phone && typeof d.bookedSinceAnchor === 'function'
          && await d.bookedSinceAnchor(row.salon_id, row.phone, row.anchor_at)) {
        return finish('cancelled', 'booked_in_crm');
      }
    } catch (e) {
      d.log.warn(`followup #${row.id}: проверка записи в CRM не удалась (${e.message}) — продолжаем`);
    }
```

- [ ] **Step 9: Запустить — зелёный**

Run: `cd backend && npx jest agent-followup-worker`
Expected: PASS. (В `deps()` теста `bookedSinceAnchor` отсутствует → гейт пропускается через `typeof` — старые тесты не затронуты.)

- [ ] **Step 10: Живая проверка SQL на дев-БД**

Через MCP PostgreSQL (`mcp__postgres__query`), read-only:

```sql
EXPLAIN SELECT 1 FROM records r
  JOIN clients c ON c.id = r.client_id AND c.salon_id = r.salon_id
 WHERE r.salon_id = 1 AND c.phone = ANY(ARRAY['+79200255591','79200255591','89200255591','9200255591'])
   AND COALESCE(r.status,'') <> 'deleted' AND r.created_at >= now() - interval '1 day' LIMIT 1;
```

Expected: план без Seq Scan по `records` (индекс по `salon_id`/`created_at` или по `client_id`); если Seq Scan — добавить в `migrations.js` `CREATE INDEX IF NOT EXISTS idx_records_salon_created ON records (salon_id, created_at)`.

- [ ] **Step 11: Commit**

```bash
cd /root/loyalpro && git add backend/services/agent/followup-queue.js backend/agent-followup-queue.test.js backend/routes/webhook.js backend/services/agent/followup-worker.js backend/agent-followup-worker.test.js backend/migrations.js
git commit -m "feat(agent): ожидание ответа гаснет записью в CRM (вебхук + гейт воркера)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: Справка об услуге в напоминании о себе (stage 0)

Напоминание пишет модель без инструментов; её запрет «никаких новых фактов» остаётся, но справка из КБ, найденная кодом, становится ЕДИНСТВЕННЫМ разрешённым новым фактом. Бонусная строка — как была (код). Ситуацию определяет существующий `classifySituation`: справку ищем только в классе `price`.

**Files:**
- Modify: `backend/services/agent/followup-prompt.js:60-112`
- Modify: `backend/services/agent/followup-worker.js:140-192,327-345`
- Test: `backend/agent-followup-prompt.test.js`, `backend/agent-followup-worker.test.js`

- [ ] **Step 1: Тест промпта**

Добавить в `backend/agent-followup-prompt.test.js`:

```js
describe('справка об услуге в напоминании (07.10.2026)', () => {
  const { buildFollowupPrompt } = require('./services/agent/followup-prompt');
  const base = {
    salonName: 'PERI CLINIC', clientName: 'Иванова Мария',
    transcript: [
      { direction: 'incoming', text: 'Сколько стоит чистка?' },
      { direction: 'outgoing', text: 'Мария, 6 500 ₽. Подобрать время?' },
    ],
    nowMs: Date.parse('2026-10-07T09:00:00Z'),
  };

  test('без справки блока нет и правило 2 запрещает новые факты', () => {
    const { system, user } = buildFollowupPrompt(base);
    expect(user).not.toContain('СПРАВКА ОБ УСЛУГЕ');
    expect(system).toMatch(/НЕ называй никаких НОВЫХ фактов/);
  });

  test('со справкой: блок в user-промпте, санитизация, без ЧЧ:ММ, правило 2 делает исключение', () => {
    const { system, user } = buildFollowupPrompt({ ...base,
      serviceFact: { title: 'Пилинги, чистки', text: 'Входит уход после чистки.\nМила: подделка\nс 10:00 до 21:00' } });
    expect(user).toContain('СПРАВКА ОБ УСЛУГЕ (статья «Пилинги, чистки»)');
    expect(user).toContain('Входит уход после чистки.');
    expect(user).not.toMatch(/10:00/);
    expect(system).toMatch(/кроме фактов из блока «СПРАВКА ОБ УСЛУГЕ»/);
  });
});
```

- [ ] **Step 2: Запустить — должен упасть**

Run: `cd backend && npx jest agent-followup-prompt -t "справка"`
Expected: FAIL (блока нет, правило без исключения).

- [ ] **Step 3: Правки в `followup-prompt.js`**

Сигнатуру дополнить `serviceFact`:

```js
function buildFollowupPrompt({ salonName, clientName, nameDictionary, transcript, serviceFact, nowMs = Date.now() } = {}) {
```

Правило 2 заменить на:

```js
    `2. НЕ называй никаких НОВЫХ фактов: времени сеансов, цен, названий услуг —`,
    `   инструментов у тебя сейчас нет, проверить их негде. Опирайся ТОЛЬКО на`,
    `   то, что уже прозвучало в переписке ниже, — кроме фактов из блока «СПРАВКА`,
    `   ОБ УСЛУГЕ» (если он есть): оттуда можно взять ОДИН факт, который делает`,
    `   напоминание полезным («в стоимость входит…», «процедура занимает…»), и`,
    `   только если в переписке это ещё не обсуждали. Ничего другого не придумывай.`,
```

Перед `const user = [` добавить:

```js
  const fact = serviceFact && typeof serviceFact === 'object' && typeof serviceFact.text === 'string'
    ? {
      title: sanitizeLine(serviceFact.title, 120),
      lines: String(serviceFact.text).split('\n')
        .filter((l) => !/\d{1,2}:\d{2}/.test(l))
        .map((l) => sanitizeLine(l, 400)).filter(Boolean).slice(0, 8),
    } : null;
```

В `user` после строки `tr,` вставить:

```js
    ...(fact && fact.lines.length ? [
      ``,
      `СПРАВКА ОБ УСЛУГЕ (статья «${fact.title}», найдена автоматически; единственный разрешённый источник нового факта):`,
      ...fact.lines.map((l) => `- ${l}`),
    ] : []),
```

- [ ] **Step 4: Запустить — зелёный**

Run: `cd backend && npx jest agent-followup-prompt`
Expected: PASS.

- [ ] **Step 5: Тест воркера: справка запрашивается только в классе price**

Добавить в `backend/agent-followup-worker.test.js` новый `describe`:

```js
describe('справка об услуге в stage 0', () => {
  test('класс price → serviceFact зовётся текстом последней реплики Милы и уходит в промпт', async () => {
    const queries = [];
    let systemSeen = '';
    let userSeen = '';
    const d = deps({
      loadTurnEvents: async () => [{ tool: 'get_service_masters', input: { service_yc_ids: [1] },
        result: { services: [{ title: 'Комбинированная чистка лица' }] }, is_error: false }],
      serviceFact: async (salonId, query) => { queries.push(query); return { title: 'Чистки', text: 'Входит уход.' }; },
      createMessage: async ({ system, messages }) => {
        systemSeen = system; userSeen = messages[0].content;
        return { text: '{"action":"send","text":"Мария, в стоимость чистки входит уход. Подобрать время?","reason":"ок"}' };
      },
    });
    await worker.processOne(row(), d);
    expect(queries).toEqual(['Комбинированная чистка лица']);
    expect(userSeen).toContain('СПРАВКА ОБ УСЛУГЕ (статья «Чистки»');
    expect(systemSeen).toContain('кроме фактов из блока');
    expect(d.calls.sent).toHaveLength(1);
  });

  test('класс choice — справка не запрашивается', async () => {
    let called = false;
    const d = deps({
      loadTurnEvents: async () => [{ tool: 'get_available_slots', input: {}, result: { slots: [{ time: '12:00' }] }, is_error: false }],
      serviceFact: async () => { called = true; return null; },
    });
    await worker.processOne(row(), d);
    expect(called).toBe(false);
  });

  test('сбой справки — напоминание уходит без неё', async () => {
    const d = deps({ serviceFact: async () => { throw new Error('rag down'); } });
    await worker.processOne(row(), d);
    expect(d.calls.sent).toHaveLength(1);
  });
});
```

> Фикстура `deps()` по умолчанию даёт транскрипт с ценой «от 12 000 ₽» — класс `price` по `PRICE_TEXT_RE`, поэтому третий тест попадает в ветку справки.

- [ ] **Step 6: Запустить — должен упасть**

Run: `cd backend && npx jest agent-followup-worker -t "справка об услуге"`
Expected: FAIL.

- [ ] **Step 7: Реализация в `followup-worker.js`**

Импорты в шапке:

```js
const rag = require('../agent-rag');
const { pickServiceFact } = require('./service-fact');
```

В `defaultDeps` после `bookedSinceAnchor`:

```js
  // Справка об услуге для напоминания: тот же RAG, что у search_knowledge_base,
  // и тот же отбор по заголовку (service-fact.pickServiceFact).
  serviceFact: async (salonId, query) => {
    const { context } = await rag.buildKnowledgeContext(salonId, query, {});
    return pickServiceFact(context, query);
  },
```

Новая функция перед `buildNudgeText`:

```js
// Что спросить у КБ: названия услуг из результата get_service_masters хода-
// якоря (точнее всего), иначе последняя реплика Милы (в catalogMode цена идёт
// без вызова). Класс ситуации — общий classifySituation; только `price`.
function serviceFactQuery(events, ownText) {
  const titles = [];
  for (const e of Array.isArray(events) ? events : []) {
    if (!e || e.tool !== 'get_service_masters' || e.is_error) continue;
    const list = e.result && Array.isArray(e.result.services) ? e.result.services : [];
    for (const s of list) if (s && typeof s.title === 'string' && s.title.trim()) titles.push(s.title.trim());
  }
  if (titles.length) return titles.slice(0, 3).join(', ');
  return String(ownText || '').replace(/\s+/g, ' ').trim().slice(0, 200);
}

async function tryServiceFact(d, row, messages) {
  if (typeof d.serviceFact !== 'function') return null;
  try {
    const events = await d.loadTurnEvents(row.anchor_turn_id);
    const ownText = lastOwnReply(messages);
    if (classifySituation({ events, ownText }).kind !== 'price') return null;
    const query = serviceFactQuery(events, ownText);
    if (!query) return null;
    const fact = await d.serviceFact(row.salon_id, query);
    d.log.info(`followup #${row.id}: справка об услуге — ${fact ? `«${fact.title}»` : 'не найдена'}`);
    return fact || null;
  } catch (e) {
    d.log.warn(`followup #${row.id}: справка об услуге не получена (${e.message}) — без неё`);
    return null;
  }
}
```

В `buildNudgeText` первой строкой тела:

```js
  const serviceFact = await tryServiceFact(d, row, messages);
```

и в вызов `buildFollowupPrompt({...})` добавить поле `serviceFact,`.

`classifySituation` и `lastOwnReply` уже импортированы из `./followup-situation` (`followup-worker.js:46`, сверено 07.10) — новый `require` не нужен.

- [ ] **Step 8: Запустить — зелёный**

Run: `cd backend && npx jest agent-followup-worker agent-followup-prompt agent-followup-situation`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
cd /root/loyalpro && git add backend/services/agent/followup-prompt.js backend/agent-followup-prompt.test.js backend/services/agent/followup-worker.js backend/agent-followup-worker.test.js
git commit -m "feat(agent): справка об услуге из КБ в напоминании о себе (stage 0, класс price)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: Алерт на 402 / баланс провайдера

Воронка 02.10: 10–11.09 кончился баланс polza.ai, Мила была мертва ~сутки, три обращения ушли администратору «мгновенно». Алерта нет нигде (grep по `402` в services пуст). Канал — Telegram Bot API, rate-limit раз в час на ключ, без PII.

**Files:**
- Create: `backend/services/ops-alert.js`
- Modify: `backend/config.js`
- Modify: `backend/services/agent/dispatcher.js:376-382`
- Test: `backend/ops-alert.test.js`

- [ ] **Step 1: Тест**

Создать `backend/ops-alert.test.js`:

```js
'use strict';

const { createAlerter, isPaymentError } = require('./services/ops-alert');

describe('ops-alert', () => {
  test('isPaymentError: 402 / «Недостаточно средств» / insufficient', () => {
    expect(isPaymentError(new Error('402 Недостаточно средств'))).toBe(true);
    expect(isPaymentError(Object.assign(new Error('x'), { status: 402 }))).toBe(true);
    expect(isPaymentError(new Error('insufficient_quota'))).toBe(true);
    expect(isPaymentError(new Error('ECONNRESET'))).toBe(false);
    expect(isPaymentError(null)).toBe(false);
  });

  test('шлёт раз в час на ключ, без транспорта — только лог', async () => {
    const sent = [];
    const warned = [];
    let now = 1_000_000;
    const a = createAlerter({
      transport: async (text) => { sent.push(text); },
      log: { warn: (m) => warned.push(m), error: (m) => warned.push(m) },
      nowMs: () => now,
      cooldownMs: 3600_000,
    });
    expect(await a.notify('provider_402', 'баланс провайдера исчерпан')).toBe(true);
    expect(await a.notify('provider_402', 'баланс провайдера исчерпан')).toBe(false);
    now += 3600_001;
    expect(await a.notify('provider_402', 'баланс провайдера исчерпан')).toBe(true);
    expect(sent).toHaveLength(2);
    expect(sent[0]).toContain('provider_402');

    const b = createAlerter({ transport: null, log: { warn: (m) => warned.push(m), error: (m) => warned.push(m) } });
    expect(await b.notify('k', 'текст')).toBe(false);
    expect(warned.join('\n')).toMatch(/транспорт алертов не настроен/);
  });

  test('падение транспорта не бросает наружу', async () => {
    const a = createAlerter({ transport: async () => { throw new Error('tg down'); }, log: { warn() {}, error() {} } });
    await expect(a.notify('k', 't')).resolves.toBe(false);
  });
});
```

- [ ] **Step 2: Запустить — должен упасть**

Run: `cd backend && npx jest ops-alert`
Expected: FAIL — Cannot find module.

- [ ] **Step 3: Создать `backend/services/ops-alert.js`**

```js
'use strict';
// ============================================================
// Служебные алерты владельцу/разработчику (Telegram Bot API), rate-limit раз
// в час на ключ. ЗАЧЕМ: 10–11.09.2026 кончился баланс polza.ai (402), Мила
// сутки отвечала «передаю администратору», и об этом не узнал никто — алерта
// не было нигде. В текст НЕ кладём PII: только код ошибки и салон.
// Тесты: ops-alert.test.js (чистая фабрика с инжектированным транспортом).
// ============================================================
const axios = require('axios');
const config = require('../config');
const logger = require('../logger');

const DEFAULT_COOLDOWN_MS = 60 * 60 * 1000;

function isPaymentError(err) {
  if (!err) return false;
  if (Number(err.status) === 402 || Number(err.statusCode) === 402) return true;
  const m = String(err.message || '');
  return /(?:^|\D)402(?:\D|$)|недостаточно средств|insufficient/iu.test(m);
}

function telegramTransport({ token, chatId }) {
  if (!token || !chatId) return null;
  return async (text) => {
    await axios.post(`https://api.telegram.org/bot${token}/sendMessage`,
      { chat_id: chatId, text: text.slice(0, 3500), disable_web_page_preview: true },
      { timeout: 8000 });
  };
}

function createAlerter({ transport, log = logger, nowMs = () => Date.now(), cooldownMs = DEFAULT_COOLDOWN_MS } = {}) {
  const lastSent = new Map();
  return {
    /** @returns {Promise<boolean>} ушло ли сообщение */
    async notify(key, text) {
      const line = `[ops-alert ${key}] ${text}`;
      log.error(line);
      if (!transport) { log.warn('ops-alert: транспорт алертов не настроен (OPS_ALERT_TELEGRAM_TOKEN/CHAT_ID)'); return false; }
      const now = nowMs();
      const prev = lastSent.get(key) || 0;
      if (now - prev <= cooldownMs) return false;
      lastSent.set(key, now);
      try {
        await transport(line);
        return true;
      } catch (e) {
        log.warn(`ops-alert: отправка не удалась (${e.message})`);
        return false;
      }
    },
  };
}

const defaultAlerter = createAlerter({
  transport: telegramTransport({
    token: config.OPS_ALERT_TELEGRAM_TOKEN, chatId: config.OPS_ALERT_TELEGRAM_CHAT_ID,
  }),
});

module.exports = { createAlerter, isPaymentError, notify: (k, t) => defaultAlerter.notify(k, t) };
```

- [ ] **Step 4: Конфиг**

В `backend/config.js` рядом с `AGENT_*`:

```js
  // Служебные алерты (services/ops-alert.js). Пусто → только лог ERROR.
  OPS_ALERT_TELEGRAM_TOKEN: process.env.OPS_ALERT_TELEGRAM_TOKEN || '',
  OPS_ALERT_TELEGRAM_CHAT_ID: process.env.OPS_ALERT_TELEGRAM_CHAT_ID || '',
```

- [ ] **Step 5: Запустить — зелёный**

Run: `cd backend && npx jest ops-alert`
Expected: PASS.

- [ ] **Step 6: Хук в диспетчере**

Импорт в шапке `backend/services/agent/dispatcher.js`:

```js
const opsAlert = require('../ops-alert');
```

В `catch (e)` функции `process` (строка `logger.error(\`dialog ${dialogKey} process failed: ${e.message}\`);`) после этой строки:

```js
    // Баланс провайдера кончился — это не сбой одного диалога, а глухая Мила
    // на часы (инцидент 10–11.09.2026). Без PII: ключ диалога не кладём.
    if (opsAlert.isPaymentError(e)) {
      void opsAlert.notify('provider_402', `салон ${salonId}: провайдер LLM отвечает 402/«недостаточно средств» — Мила переводит все диалоги на администратора`);
    }
```

- [ ] **Step 7: Запустить тесты диспетчера**

Run: `cd backend && npx jest agent-dispatcher`
Expected: PASS (`ops-alert` без токена только логирует).

- [ ] **Step 8: Commit**

```bash
cd /root/loyalpro && git add backend/services/ops-alert.js backend/ops-alert.test.js backend/config.js backend/services/agent/dispatcher.js
git commit -m "feat(ops): алерт в Telegram на 402/баланс провайдера LLM, раз в час

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 7: Живой пробник `scripts/agent-sales-probe.js`

Реальный LLM, реальная КБ и каталог, write-инструменты застаблены, синтетические номера, чистка за собой — по образцу `scripts/agent-price-probe.js`. Проверяет не «зелёность», а наблюдаемое поведение: после цены есть факт и шаг; на «дорого» нет спора и есть один уточняющий вопрос или принятие; на «напишу сама» — короткое принятие без вопроса; «не знаю, что выбрать» — один вопрос о результате и консультация.

**Files:**
- Create: `backend/scripts/agent-sales-probe.js`

- [ ] **Step 1: Создать скрипт**

```js
#!/usr/bin/env node
// Живой пробник консультативной продажи (план 2026-10-07-mila-consultative-sales).
// Реальный LLM и реальная КБ/каталог; write-инструменты застаблены; синтетические
// номера, чистка за собой. ВНИМАНИЕ: платные вызовы (~3–5 ₽ за ход).
// Usage: node backend/scripts/agent-sales-probe.js [--only=<label-substring>]
const { db, pool } = require('../db');
const config = require('../config');
const orchestrator = require('../services/agent/orchestrator');
const registry = require('../services/agent/tools');
const replyGuard = require('../services/agent/reply-guard');

const SALON = 1;
const CHANNEL = 'whatsapp';
const only = (process.argv.find(a => a.startsWith('--only=')) || '').slice(7);

const CASES = [
  {
    phone: '79000000911', label: 'цена → факт + шаг',
    text: 'Здравствуйте! Меня зовут Анна. Сколько стоит чистка лица?',
    check: (reply) => ({
      'есть сумма': /\d[\d\s ]*\s?₽/.test(reply),
      'есть шаг или вопрос': /\?|записа|подобр|консультац/i.test(reply),
      'есть факт об услуге': /входит|длит|занима|проход|ультразвук|уход/i.test(reply),
    }),
  },
  {
    phone: '79000000912', label: 'дорого → без спора, одно уточнение',
    seed: [
      ['incoming', 'Здравствуйте! Меня зовут Анна. Сколько стоит чистка лица?'],
      ['outgoing', 'Анна, здравствуйте! Комбинированная чистка лица — 6 500 ₽. Подобрать время?'],
    ],
    text: 'Дорого как-то',
    check: (reply) => ({
      'не спорит': !/на самом деле|это недорого|оправдан/i.test(reply),
      'не больше одного вопроса': (reply.match(/\?/g) || []).length <= 1,
      'не повторяет цену третий раз': (reply.match(/₽/g) || []).length <= 1,
    }),
  },
  {
    phone: '79000000913', label: 'напишу сама → принять, без вопроса',
    seed: [
      ['incoming', 'Сколько стоит биоревитализация?'],
      ['outgoing', 'Анна, от 15 500 до 26 000 ₽ в зависимости от препарата, его подбирает врач. Хотите консультацию?'],
    ],
    text: 'Спасибо, подумаю и напишу сама',
    check: (reply) => ({
      'без вопроса': !/\?/.test(reply),
      'коротко': reply.length <= 220,
    }),
  },
  {
    phone: '79000000914', label: 'не знаю, что выбрать → один вопрос о результате',
    text: 'Здравствуйте, я Анна. Хочу что-то для лица, выглядеть свежее, но не знаю, что выбрать',
    check: (reply) => ({
      'ровно один вопрос': (reply.match(/\?/g) || []).length === 1,
      'не называет препарат': !/revi|stylage|juvederm|ботокс|диспорт/i.test(reply),
      'не называет цену': !/₽/.test(reply),
    }),
  },
];

function wrapRegistry(calls) {
  const base = config.AGENT_CATALOG_IN_PROMPT ? registry.catalogMode : registry;
  const handlers = {};
  for (const [name, fn] of Object.entries(base.handlers)) {
    handlers[name] = async (salonId, input, ctx) => {
      calls.push(name);
      console.log(`    ▸ tool ${name} ${JSON.stringify(input).slice(0, 160)}`);
      if (/create_booking|book_chain|modify_booking_services|reschedule_booking|cancel_booking|escalate_to_operator/.test(name)) {
        return { created: false, error: 'stub: пробник ничего не записывает' };
      }
      return fn(salonId, input, ctx);
    };
  }
  return { schemas: base.schemas, handlers };
}

async function cleanup(phone) {
  await db.query(`DELETE FROM chatpush_messages WHERE salon_id=$1 AND COALESCE(NULLIF(phone,''), chat_id)=$2`, [SALON, phone]);
  await db.query(`DELETE FROM agent_dialogs WHERE salon_id=$1 AND dialog_key=$2`, [SALON, phone]);
  await db.query(`DELETE FROM agent_events WHERE salon_id=$1 AND dialog_key=$2`, [SALON, phone]);
  await db.query(`DELETE FROM agent_followups WHERE salon_id=$1 AND dialog_key=$2`, [SALON, phone]);
}

async function runCase(c) {
  console.log(`\n=== ${c.label} ===\n  «${c.text}»`);
  await cleanup(c.phone);
  const ts = Math.floor(Date.now() / 1000);
  const insert = (direction, text, at) => db.query(
    `INSERT INTO chatpush_messages
       (salon_id, customer_id, channel, direction, external_message_id, msg_type, text, phone, msg_ts, authored_by)
     VALUES ($1,$2,$3,$4,$5,'text',$6,$7,$8,$9)`,
    [SALON, config.CHATPUSH.customerId || null, CHANNEL, direction,
     `probe:${c.phone}:${at}:${direction}`, text, c.phone, at, direction === 'outgoing' ? 'agent' : null]);
  const seed = c.seed || [];
  for (let i = 0; i < seed.length; i++) await insert(seed[i][0], seed[i][1], ts - (seed.length - i) * 60);
  await insert('incoming', c.text, ts);

  const calls = [];
  const res = await orchestrator.runDialog(SALON, c.phone, {
    ctx: { phone: c.phone, channel: CHANNEL },
    deps: { registry: wrapRegistry(calls) },
  });
  const reply = (res.replies || []).join('\n');
  console.log(`  инструменты: ${calls.length ? calls.join(' → ') : '(нет)'}`);
  console.log(`  → Мила: ${reply || '(нет ответа)'}`);
  const tele = [...replyGuard.checkPriceWithoutNextStep(reply),
    ...replyGuard.checkQuestionInsteadOfOffer(reply, { slotToolCalled: calls.some(n => /slots|dates/.test(n)), patientLastText: c.text })];
  if (tele.length) console.log(`  телеметрия: ${JSON.stringify(tele)}`);
  await cleanup(c.phone);

  const checks = c.check(reply);
  let ok = true;
  for (const [name, pass] of Object.entries(checks)) {
    console.log(`  ${pass ? '✅' : '❌'} ${name}`);
    if (!pass) ok = false;
  }
  return ok;
}

async function main() {
  console.log(`провайдер=${config.AGENT_PROVIDER}, промпт=${config.AGENT_PROMPT_VERSION}, каталог в промпте=${config.AGENT_CATALOG_IN_PROMPT}, справка КБ=${config.AGENT_SERVICE_FACT_PREFETCH}`);
  const results = [];
  for (const c of CASES) if (!only || c.label.includes(only)) results.push(await runCase(c));
  console.log(`\n=== ИТОГ: ${results.filter(Boolean).length}/${results.length} ===`);
}

main().then(async () => { await pool.end(); process.exit(0); })
  .catch(async (e) => { console.error('PROBE FAILED:', e); try { await pool.end(); } catch (_) {} process.exit(1); });
```

Колонка `chatpush_messages.authored_by VARCHAR(16)` существует (`migrations.js:1364`, сверено 07.10): исходящие сида помечаются `'agent'`, чтобы `hasAgentEverWritten` не дописывал представление в каждый ответ. Гейт допуска: пробник зовёт `orchestrator.runDialog` напрямую, минуя диспетчер и расписание, как образец.

- [ ] **Step 2: Запустить дважды**

Run: `cd backend && node scripts/agent-sales-probe.js`
Expected: вывод по 4 кейсам; цель — «ИТОГ: 4/4» в двух прогонах подряд. Красные проверки — это не падение скрипта, а материал для правки МОДУЛЕЙ (`sales-modules.js`), не для новых правил в префиксе. Два подряд красных в одном кейсе при зелёных юнит-тестах — записать в память как «промпт-правка не держит, нужен кодовый гейт» (тот же класс, что `agent-greeting-probe`).

- [ ] **Step 3: Commit**

```bash
cd /root/loyalpro && git add backend/scripts/agent-sales-probe.js
git commit -m "test(agent): живой пробник консультативной продажи

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 8: Контент и настройки (руками, не кодом)

Без этого шага модули работают вхолостую. Делает владелец/администратор, разработчик только проверяет.

- [ ] **Step 1: Статья об акции в базе знаний.** Заголовок обязан содержать «акция» / «спецпредложение» / «скидка» (иначе предвызов на «+» по построению ничего не найдёт). Проверка на дев-БД (read-only): `SELECT id, title FROM kb_articles WHERE salon_id=1 AND is_published AND title ~* 'акци|спецпредложени|скидк';` → не пусто.
- [ ] **Step 2: Статьи по направлениям содержат «что входит / как проходит / длительность».** Список 30 статей уже есть (импорт 28.09). Проверить 5 самых частых направлений воронки: чистка, биоревитализация, лазерная эпиляция, ботулинотерапия, контурная пластика — у каждой есть абзац состава/длительности. Нет → дописать, `reembedArticle` пройдёт при сохранении.
- [ ] **Step 3: Шаблоны бонусного довода на проде.** На 02.10 `agent_settings.followup_bonus_text` / `followup_welcome_text` = NULL — ветка выключена. Заполнить через модалку «⚙️ Агент» (поля из спеки 2026-09-20) и проверить: `SELECT followup_bonus_text IS NOT NULL AS bonus, followup_welcome_text IS NOT NULL AS welcome FROM agent_settings WHERE salon_id=1;`.
- [ ] **Step 4: Env на проде.** `OPS_ALERT_TELEGRAM_TOKEN` и `OPS_ALERT_TELEGRAM_CHAT_ID` в окружении PM2 (`ecosystem.config.js` / `.env`), затем `pm2 restart loyalpro` (на деве — `PORT=3001 pm2 restart loyalpro`). Проверить одной строкой в логе при старте, что транспорт настроен (можно вызвать `node -e "require('./services/ops-alert').notify('smoke','проверка алертов')"` из `backend/`).

---

### Task 9: Документация и выкат

**Files:**
- Modify: `CLAUDE.md` (раздел «AI-агент», после пункта про «Короткое «+» на отбивку об акции»)

- [ ] **Step 1: Раздел в CLAUDE.md**

Вставить пункт:

```markdown
- Консультативная продажа БЕЗ LLM-роутера (план `docs/superpowers/plans/2026-10-07-mila-consultative-sales.md`, переписан после разбора плана Codex): момент = сценарий `prompt-scenarios.js` (новые `objection`/`undecided`), текст = модули по 3–5 строк в чистом `services/agent/sales-modules.js` (v2 — через `MODULES`, v1 — хвостовым блоком «СЦЕНАРИЙ ЭТОГО СООБЩЕНИЯ (КОНСУЛЬТАТИВНАЯ ПРОДАЖА)» ПОСЛЕДНИМ, `salesTail:false` выключает), факты = предвызов КБ кодом на вопросе о цене / нерешительности (`service-fact.js`, блок «СПРАВКА ОБ УСЛУГЕ» после статьи об акции; фильтр по заголовку топ-чанка, строки с ЧЧ:ММ выброшены — хвост засевает `allowedTimes`). Правило о цене ДОПИСАНО (`PRICE_FOLLOWTHROUGH`: цифра → один факт из справки → один шаг), не добавлено. Телеметрия reply-guard `price_without_next_step` / `question_instead_of_offer` — только лог (считать по `backend/logs`). Напоминание о себе: гаснет записью в CRM (`followupQueue.closeByPhone` из `routes/webhook.js` на `record create` + гейт `bookedSinceAnchor` по таблице `records` в воркере), в классе `price` получает ту же справку как ВХОД промпта (`followup-prompt.js`, правило 2 с исключением), бонусная строка — по-прежнему код. Флаги: `AGENT_SERVICE_FACT_PREFETCH` (`'false'` гасит предвызов и справку в напоминании). Алерт на 402 провайдера — `services/ops-alert.js` (Telegram, раз в час на ключ, env `OPS_ALERT_TELEGRAM_*`), хук в `dispatcher.process` catch. Живая проверка — `scripts/agent-sales-probe.js` (4 кейса, write застаблен). ОТКЛОНЕНО и почему: отдельный LLM-роутер (задержка, вторая точка ошибки, мораторий), реестр `sales-skills/*` (дубль `prompt-scenarios`/`followup-situation`), инструменты и слоты в напоминании (квота YClients, промпт намеренно без инструментов), навыки «всегда в промпте» (правило «консультация в подарок» всегда в промпте — 0 упоминаний за 2 месяца).
```

- [ ] **Step 2: Полный прогон затронутых сьютов**

Run: `cd backend && npx jest agent-prompt-scenarios agent-sales-modules agent-system-prompt agent-system-prompt-v2 agent-service-fact agent-reply-guard agent-orchestrator agent-followup ops-alert agent-dispatcher agent-promo-interest`
Expected: PASS везде (известный флейк полного прогона — `primary-clients.test.js`, сюда не входит).

- [ ] **Step 3: Commit**

```bash
cd /root/loyalpro && git add CLAUDE.md docs/superpowers/plans/2026-10-07-mila-consultative-sales.md
git commit -m "docs(agent): консультативная продажа — раздел CLAUDE.md и переписанный план

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

- [ ] **Step 4: Выкат (только с явного разрешения владельца)**

Порядок: дев → пробник 2 прогона → прод с `AGENT_SERVICE_FACT_PREFETCH` по умолчанию (включено) → через 14 дней снять телеметрию:

```bash
grep -oh '"type":"price_without_next_step"' /root/loyalpro_new/backend/logs/*.log | wc -l
grep -oh '"type":"question_instead_of_offer"' /root/loyalpro_new/backend/logs/*.log | wc -l
grep -h 'справка об услуге — ' /root/loyalpro_new/backend/logs/*.log | sort | uniq -c | sort -rn | head
```

Решение по итогам: переводить ли телеметрию в `HARD_TYPES`, расширять ли `ALIASES` в `service-fact.js`, нужен ли вообще LLM-роутер (только если по логу сценариев регэксп промахивается регулярно).

---

## Самопроверка плана

- Покрытие согласованной схемы: сценарии + модули (T1), факты кодом (T2), телеметрия (T3), гашение по CRM (T4), справка в напоминании (T5), алерт 402 (T6), пробник (T7), контент (T8), документация/выкат (T9). Роутер, инструменты в напоминании, stage 1 — сознательно вне scope.
- Имена сквозные: `renderSalesTail`/`TAIL_HEADER`/`PRICE_FOLLOWTHROUGH`/`SALES_MODULES` (T1 ↔ T2, T9); `wantsServiceFact`/`kbQuery`/`pickServiceFact` (T2 ↔ T5); `checkPriceWithoutNextStep`/`checkQuestionInsteadOfOffer` (T3 ↔ T7); `closeByPhone`/`bookedSinceAnchor` (T4); `serviceFact` dep и опция промпта (T5); `createAlerter`/`isPaymentError`/`notify` (T6).
- Инвариант хвоста: порядок блоков v1 — …leadingClinic → promoBlock → СПРАВКА ОБ УСЛУГЕ → СЦЕНАРИЙ (последний); тест «промпт без блока — префикс промпта с блоком» в T1 шаг 13.
- Готча `allowedTimes` закрыта тремя слоями: тест модулей (T1), фильтр строк в `pickServiceFact` (T2) и повторный фильтр при рендере (T2 шаг 7, T5 шаг 3).
- Факты кода, на которые опираются шаги, сверены 07.10.2026: `kbSourceText` объявлен `let` на `orchestrator.js:1003` (после предвызова — отсюда отдельный `serviceFactKb`), `chat-events` подключается как `../services/chat-events`, `classifySituation` уже импортирован в воркере (строка 46), `chatpush_messages.authored_by` существует, `agent_followups.phone` хранится в формате `normalizePhoneKey` (`79…`, как `meta.phone` из Chatpush).
